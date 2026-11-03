/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// SORTIERT — Bauteile eines Typs freigestellt nebeneinander
//
// Wie die Asset-Ansicht in Autodesk Tandem: alle Türen des Hauses stehen in
// Reihen nebeneinander, nach Typ und Größe geordnet. Man sieht, wie viele es
// sind, welche Typen es gibt und welche aus der Reihe fallen.
//
// ## Warum das Backend die Reihen baut
//
// Die Kacheln liegen gebatcht auf der GPU; ein einzelnes Bauteil lässt sich im
// Browser weder greifen noch verschieben (siehe explosion.js — dort reicht ein
// Geschoss je Klon). Das Backend (`POST /assets/{job}/sortiert`) liest die
// gewünschten Typen aus dem IFC, dreht jedes Bauteil auf sein kleinstes
// Grundrissrechteck, stellt es auf eine gemeinsame Ebene und kachelt das
// Ergebnis als eigenes Asset: dieselbe Geometrie, dieselben GlobalIds, dieselben
// Eigenschaften. Ein Klick auf eine Tür zeigt das, was er im Haus zeigt.
//
// ## Wohin die Reihen kommen
//
// Neben das Haus, nicht darauf: das neue Tileset trägt dieselbe Platzierung wie
// das Modell (Backend: `_apply(kennung, load_placement(job))`) und liegt damit
// zunächst übereinander. Hier wird es entlang der **Ostachse des Modells** um
// seine eigene Breite plus einen Rand verschoben und mit der Unterkante auf die
// des Hauses gestellt. Gerechnet wird aus den Hüllboxen beider Tilesets in
// Weltkoordinaten (`_huelle()`), nicht aus nachgerechneten Tiling-Versätzen —
// der Tiler verliert die Wurzelverschiebung, und die Hüllbox ist die eine
// Angabe, die immer zum Bild passt, das Cesium zeichnet.
//
// Die Beschriftung der Gruppen ist ein Satz Cesium-Entities am Kopf jeder
// Gruppe. Ihre Lage kommt aus `layout.json` des Tilesets (lokales System der
// Hülle) und wird über dieselbe Hüllbox in die Welt gebracht.
// ===============================
'use strict';

(function () {

  if (!window.BimViewer) {
    console.warn('sortiert.js: BimViewer nicht gefunden');
    return;
  }

  // Rand zwischen Haus und Reihen in Metern.
  var RAND_M = 8;

  // Tastenkürzel-Schnellwahl im Panel: Anzeigename → IFC-Typen.
  var SCHNELLWAHL = [
    ['Türen', ['IfcDoor']],
    ['Fenster', ['IfcWindow']],
    ['Türen + Fenster', ['IfcDoor', 'IfcWindow']],
    ['Stützen', ['IfcColumn']],
    ['Träger', ['IfcBeam']],
    ['Möbel', ['IfcFurniture', 'IfcFurnishingElement']],
    ['Leuchten', ['IfcLightFixture']]
  ];

  function C() { return Cesium; }

  function basis() { return BimViewer.getBackendUrl(); }

  function holen(url, optionen) {
    return fetch(url, optionen).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error((d && d.detail) || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function schlafen(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

  function betrag(v) { return C().Cartesian3.magnitude(v); }

  function einheit(v) { return C().Cartesian3.normalize(v, new (C().Cartesian3)()); }

  function skalar(v, s) { return C().Cartesian3.multiplyByScalar(v, s, new (C().Cartesian3)()); }

  function summe() {
    var r = new (C().Cartesian3)(0, 0, 0);
    for (var i = 0; i < arguments.length; i++) C().Cartesian3.add(r, arguments[i], r);
    return r;
  }

  var S = BimViewer.Sortiert = {

    SCHNELLWAHL: SCHNELLWAHL,

    /** { kennung, quelleJob, assetKey, bericht } der gerade gezeigten Ansicht. */
    ansicht: null,

    beschriften: true,

    _labels: [],

    // ── Backend ─────────────────────────────────────────────────────────

    /** Die geladenen Backend-Modelle, aus denen sich eine Ansicht bauen lässt. */
    modelle: function () {
      var liste = [];
      if (!BimViewer.loadedAssets) return liste;
      BimViewer.loadedAssets.forEach(function (a, schluessel) {
        if (a && a.type === 'BACKEND' && a.jobId && !a.sortiertAus && a.tileset) {
          liste.push({ schluessel: String(schluessel), jobId: a.jobId, name: a.name, asset: a });
        }
      });
      return liste;
    },

    /** Welche Bauteiltypen das Modell führt: [{ifc_type, bezeichnung, anzahl}]. */
    typen: function (jobId) {
      return holen(basis() + '/assets/' + jobId + '/sortiert/typen');
    },

    /**
     * Ansicht bauen lassen und auf das Ergebnis warten.
     * `beiStand(text)` bekommt die Statuszeilen. Dieselbe Anfrage liefert dasselbe
     * Asset — ist es schon da, kommt die Antwort sofort.
     */
    bauen: async function (jobId, opt, beiStand) {
      var melde = beiStand || function () {};
      var antwort = await holen(basis() + '/assets/' + jobId + '/sortiert', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opt)
      });
      var kennung = antwort.kennung;
      var t0 = Date.now();
      while (antwort.zustand !== 'fertig') {
        if (antwort.zustand === 'fehler') throw new Error(antwort.meldung || 'Die Ansicht ließ sich nicht bauen.');
        melde((antwort.meldung || 'Wird gebaut …') + ' (' + Math.round((Date.now() - t0) / 1000) + ' s)');
        await schlafen(1500);
        antwort = await holen(basis() + '/assets/' + jobId + '/sortiert/' + kennung);
      }
      return { kennung: kennung, bericht: antwort.bericht };
    },

    // ── Anzeigen ────────────────────────────────────────────────────────

    /**
     * Bauen, laden, neben das Haus stellen, beschriften, hinfliegen.
     * `quelle` ist ein Eintrag aus `modelle()`; `opt` die Anfrage ans Backend
     * (`typen`, `gruppe`, `sortierung`, `abstand_m`, `zeilenbreite_m`, `neu`).
     */
    anzeigen: async function (quelle, opt, beiStand) {
      var melde = beiStand || function () {};
      this.entfernen();

      var erg = await this.bauen(quelle.jobId, opt, melde);
      melde('Wird geladen …');

      var schluessel = 'backend_' + erg.kennung;
      // War die Ansicht schon geladen (anderes Panel, frühere Sitzung), nehmen
      // wir sie weg: sie steht sonst an der falschen Stelle oder mit altem Stand.
      if (BimViewer.loadedAssets.has(schluessel)) BimViewer.unloadAsset(schluessel);

      // loadBackendAsset fängt Fehler selbst ab und meldet sie nur in der Statuszeile;
      // ein Fehler beim Platzieren wird deshalb hier gemerkt und danach geworfen.
      var self = this, platzFehler = null;
      await BimViewer.loadBackendAsset(erg.kennung, self._name(quelle, opt), {
        ohneFlug: true,
        vorFlug: async function (asset) {
          asset.sortiertAus = quelle.jobId;
          try { self.platzieren(quelle.asset, asset, erg.bericht); } catch (e) { platzFehler = e; }
        }
      });
      var asset = BimViewer.loadedAssets.get(schluessel);
      if (!asset) throw new Error('Das Modell der Ansicht ließ sich nicht laden.');
      if (platzFehler) {
        BimViewer.unloadAsset(schluessel);
        throw new Error('Die Reihen ließen sich nicht neben das Haus stellen: ' + platzFehler.message);
      }

      this.ansicht = { kennung: erg.kennung, quelleJob: quelle.jobId, quelleKey: quelle.schluessel,
                       assetKey: schluessel, bericht: erg.bericht };
      if (this.beschriften) this._beschriften();
      this.zurAnsicht();
      this._melden();
      return erg.bericht;
    },

    _name: function (quelle, opt) {
      return quelle.name + ' — sortiert (' + opt.typen.map(function (t) { return t.replace(/^Ifc/, ''); }).join(', ') + ')';
    },

    /** Die Ansicht samt Beschriftung wieder wegnehmen. */
    entfernen: function () {
      this._labelsLoeschen();
      var a = this.ansicht;
      this.ansicht = null;
      if (a && BimViewer.loadedAssets && BimViewer.loadedAssets.has(a.assetKey)) {
        BimViewer.unloadAsset(a.assetKey);
      }
      this._melden();
    },

    beschriftungSetzen: function (an) {
      this.beschriften = !!an;
      if (!this.ansicht) return;
      if (an) this._beschriften(); else this._labelsLoeschen();
    },

    // ── Lage ────────────────────────────────────────────────────────────

    /**
     * Hüllbox eines Tilesets in Welt-Koordinaten: Mitte, drei Halbachsen
     * (Vektoren) und ihre Längen.
     *
     * Aus dem Kopf der `tileset.json` und `modelMatrix · root.transform` statt
     * aus `root.boundingVolume`: letzteres wird erst im nächsten Bild
     * nachgeführt, und `ILeenTerrainAlign` hat die `modelMatrix` des frisch
     * geladenen Tilesets gerade erst gesetzt.
     */
    _huelle: function (tileset) {
      var Cs = C();
      var wurzel = tileset.root;
      var kopf = wurzel && wurzel._header && wurzel._header.boundingVolume;
      if (!kopf || !kopf.box) throw new Error('Das Tileset hat keine Hüllbox.');
      var b = kopf.box;
      var M = Cs.Matrix4.multiply(tileset.modelMatrix, wurzel.transform || Cs.Matrix4.IDENTITY, new Cs.Matrix4());
      var mitte = Cs.Matrix4.multiplyByPoint(M, new Cs.Cartesian3(b[0], b[1], b[2]), new Cs.Cartesian3());
      var ax = Cs.Matrix4.multiplyByPointAsVector(M, new Cs.Cartesian3(b[3], b[4], b[5]), new Cs.Cartesian3());
      var ay = Cs.Matrix4.multiplyByPointAsVector(M, new Cs.Cartesian3(b[6], b[7], b[8]), new Cs.Cartesian3());
      var az = Cs.Matrix4.multiplyByPointAsVector(M, new Cs.Cartesian3(b[9], b[10], b[11]), new Cs.Cartesian3());
      return { mitte: mitte, ax: ax, ay: ay, az: az, hx: betrag(ax), hy: betrag(ay), hz: betrag(az) };
    },

    /**
     * Die Reihen neben das Haus rücken: entlang der Ostachse des Modells um
     * Hausbreite/2 + Rand + Reihenbreite/2, quer dazu mittig, mit der
     * Unterkante auf der des Hauses.
     */
    platzieren: function (quellAsset, asset, bericht) {
      var Cs = C();
      var q = this._huelle(quellAsset.tileset);
      var d = this._huelle(asset.tileset);
      var u = einheit(q.ax), v = einheit(q.ay), w = einheit(q.az);

      var rel = Cs.Cartesian3.subtract(d.mitte, q.mitte, new Cs.Cartesian3());
      var jetzt = [Cs.Cartesian3.dot(rel, u), Cs.Cartesian3.dot(rel, v), Cs.Cartesian3.dot(rel, w)];
      var soll = [q.hx + RAND_M + d.hx, 0, -q.hz + d.hz];
      var versatz = summe(skalar(u, soll[0] - jetzt[0]), skalar(v, soll[1] - jetzt[1]), skalar(w, soll[2] - jetzt[2]));

      asset.tileset.modelMatrix = Cs.Matrix4.multiply(
        Cs.Matrix4.fromTranslation(versatz), asset.tileset.modelMatrix, new Cs.Matrix4());
      return versatz;
    },

    // ── Beschriftung ────────────────────────────────────────────────────

    /** Lokale Koordinate der Ansicht (aus `layout.json`) → Welt. */
    _weltPunkt: function (asset, bericht, p) {
      var Cs = C();
      var h = this._huelle(asset.tileset);
      var lo = bericht.huelle.lo, hi = bericht.huelle.hi;
      var mx = (lo[0] + hi[0]) / 2, my = (lo[1] + hi[1]) / 2, mz = (lo[2] + hi[2]) / 2;
      var hx = Math.max((hi[0] - lo[0]) / 2, 1e-6), hy = Math.max((hi[1] - lo[1]) / 2, 1e-6),
          hz = Math.max((hi[2] - lo[2]) / 2, 1e-6);
      return summe(h.mitte,
        skalar(h.ax, (p[0] - mx) / hx),
        skalar(h.ay, (p[1] - my) / hy),
        skalar(h.az, (p[2] - mz) / hz));
    },

    _beschriften: function () {
      this._labelsLoeschen();
      var a = this.ansicht;
      if (!a) return;
      var asset = BimViewer.loadedAssets.get(a.assetKey);
      if (!asset) return;
      var Cs = C(), self = this;
      (a.bericht.gruppen || []).forEach(function (g) {
        var pos = self._weltPunkt(asset, a.bericht, [g.x0, g.y_erste, g.hmax + 0.4]);
        self._labels.push(BimViewer.viewer.entities.add({
          position: pos,
          label: {
            text: g.titel + '   ·   ' + g.anzahl,
            font: '600 15px sans-serif',
            style: Cs.LabelStyle.FILL_AND_OUTLINE,
            fillColor: Cs.Color.WHITE,
            outlineColor: Cs.Color.fromCssColorString('#10130f'),
            outlineWidth: 4,
            horizontalOrigin: Cs.HorizontalOrigin.LEFT,
            verticalOrigin: Cs.VerticalOrigin.BOTTOM,
            pixelOffset: new Cs.Cartesian2(0, -4),
            distanceDisplayCondition: new Cs.DistanceDisplayCondition(0, 800),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        }));
      });
    },

    _labelsLoeschen: function () {
      var v = BimViewer.viewer;
      this._labels.forEach(function (e) { try { if (v) v.entities.remove(e); } catch (x) { /* weg */ } });
      this._labels = [];
    },

    // ── Kamera ──────────────────────────────────────────────────────────

    /**
     * Von vorn auf die Reihen: Blick entlang der Nordachse des Modells (die
     * Reihen laufen in +y hintereinander, die erste steht vorn), leicht von
     * oben, so weit weg, dass die Breite ins Bild passt.
     */
    zurAnsicht: function () {
      var a = this.ansicht;
      var asset = a && BimViewer.loadedAssets.get(a.assetKey);
      if (!asset) return;
      var Cs = C(), cam = BimViewer.viewer.camera;
      var h = this._huelle(asset.tileset);

      // Blickrichtung = lokale +y-Achse, ausgedrückt als Heading im Ost-Nord-System der Mitte.
      var enu = Cs.Transforms.eastNorthUpToFixedFrame(h.mitte);
      var inv = Cs.Matrix4.inverseTransformation(enu, new Cs.Matrix4());
      var r = Cs.Matrix4.multiplyByPointAsVector(inv, einheit(h.ay), new Cs.Cartesian3());
      var heading = Math.atan2(r.x, r.y);

      var f = cam.frustum;
      var vert = (f && f.fov) || Cs.Math.toRadians(60);
      var aspekt = (f && f.aspectRatio) || 1.6;
      var horiz = 2 * Math.atan(Math.tan(vert / 2) * aspekt);
      var pitch = Cs.Math.toRadians(-28);
      var range = Math.max(h.hx * 1.15 / Math.tan(horiz / 2), h.hz * 2.4 / Math.tan(vert / 2)) + h.hy * 0.6;

      cam.flyToBoundingSphere(new Cs.BoundingSphere(h.mitte, Math.max(h.hx, h.hz)), {
        duration: 2.2,
        offset: new Cs.HeadingPitchRange(heading, pitch, Math.max(range, 6))
      });
    },

    /** Zurück zum Haus, aus dem die Ansicht stammt. */
    zumModell: function () {
      var a = this.ansicht;
      var q = a && BimViewer.loadedAssets.get(a.quelleKey);
      if (q && q.tileset) BimViewer.cinematicFlyToTileset(q.tileset, 2.5);
    },

    // ── Ereignis ────────────────────────────────────────────────────────

    _melden: function () {
      try {
        document.dispatchEvent(new CustomEvent('ileen:sortiert', {
          detail: { aktiv: !!this.ansicht, bericht: this.ansicht ? this.ansicht.bericht : null }
        }));
      } catch (e) { /* ohne DOM */ }
    }
  };

  // Wird das Modell der Ansicht in der Liste entfernt, bleibt sonst die
  // Beschriftung als Geisterschrift stehen.
  document.addEventListener('ileen:modelle', function () {
    var a = S.ansicht;
    if (a && BimViewer.loadedAssets && !BimViewer.loadedAssets.has(a.assetKey)) {
      S._labelsLoeschen();
      S.ansicht = null;
      S._melden();
    }
  });
})();
