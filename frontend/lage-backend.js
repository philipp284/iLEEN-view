/**
 * iLEEN — die im Viewer gesetzte Lage eines Modells ins Backend schreiben
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Verschieben, Höhe und Drehung im Flyout (translation.js, z-offset.js,
 * rotation.js) wirken nur auf `tileset.modelMatrix` — in dieser Sitzung, in
 * diesem Browser. Beim nächsten Laden steht das Modell wieder am alten Ort.
 * `BimViewer.lageInsBackend()` schreibt die gerade sichtbare Lage als neue
 * Platzierung (`PUT /assets/{job}/placement`); danach steht das Modell für
 * jeden, der es lädt, genau dort.
 *
 * Was übertragen wird:
 *
 *   Referenzpunkt   der ENU-Ursprung der Platzierung, durch die aktuelle
 *                   modelMatrix geschickt → neue lon/lat und Höhe
 *   heading         alte Drehung + Drehung aus dem Flyout (beide im
 *                   Uhrzeigersinn, von oben gesehen)
 *   pitch, roll,    unverändert — das Flyout kennt weder Kippen noch Maßstab
 *   scale
 *   Höhenbezug      bleibt, wie er im Backend gewählt war
 *
 * Die Höhe wird im Bezug der Platzierung geschrieben:
 *
 *   ellipsoid, msl  alte Höhe + Höhenänderung des Referenzpunkts
 *   terrain         sichtbare Ellipsoidhöhe − Cesium-Gelände an der NEUEN
 *                   Stelle. Der Viewer richtet beim Laden gegen genau dieses
 *                   Gelände aus (terrain-align.js); wer ein Modell am Hang
 *                   seitlich schiebt, findet es danach dort, wo er es
 *                   losgelassen hat, und nicht um den Hang versetzt.
 *
 * Neu geladen wird danach nichts. Die frische tileset.json liefert den neuen
 * `root.transform`, der wird in das geladene Tileset gesetzt, und die Versätze
 * der Sitzung werden geleert — sonst stünde das Modell doppelt verschoben da.
 * Die Tileset-Instanz bleibt dieselbe; Notizen, Schnitte und Auswahl hängen
 * weiter daran.
 *
 * Zum Schluss wird nachgemessen: die Ecken der Wurzel-Hüllbox, vorher mit dem
 * Versatz der Sitzung, nachher allein aus der Platzierung des Backends. Die
 * größte Abweichung steht in der Meldung — sie ist die Probe, dass das Backend
 * dieselbe Lage verstanden hat, die man im Bild sieht.
 */
'use strict';

(function () {
  if (typeof BimViewer === 'undefined') {
    console.error('lage-backend.js: core.js muss vorher geladen sein');
    return;
  }

  /** Kleinere Versätze gelten als „nicht verschoben" (Regler-Rauschen). */
  const SCHWELLE_M = 0.005;
  const SCHWELLE_GRAD = 0.05;

  /** Winkel in Grad auf (−180, 180]. */
  function winkel(grad) {
    let w = ((grad % 360) + 360) % 360;
    if (w > 180) w -= 360;
    return w;
  }

  /**
   * Job-ID eines Modells aus dem eigenen Backend, sonst null. Ion-Assets und
   * Ergebniswolken (/tragwerk/…/tileset.json) haben keine Platzierung.
   */
  function jobVon(asset) {
    if (!asset || asset.type !== 'BACKEND') return null;
    if (asset.jobId) return asset.jobId;
    const treffer = /\/tiles\/([^/]+)\/tileset\.json/.exec(asset.url || '');
    return treffer ? treffer[1] : null;
  }

  /** Versatz der Sitzung, so wie ihn das Flyout zeigt. */
  function sitzungsversatz(tileset) {
    const bv = BimViewer;
    const verschiebung = (bv.translation && bv.translation.individualOffsets.get(tileset)) || {};
    return {
      east: verschiebung.east || 0,
      north: verschiebung.north || 0,
      up: (bv.zOffset && bv.zOffset.individualOffsets.get(tileset)) || 0,
      heading: winkel((bv.rotation && bv.rotation.individualHeadings.get(tileset)) || 0),
    };
  }

  function istVerschoben(v) {
    return Math.abs(v.east) >= SCHWELLE_M || Math.abs(v.north) >= SCHWELLE_M ||
      Math.abs(v.up) >= SCHWELLE_M || Math.abs(v.heading) >= SCHWELLE_GRAD;
  }

  async function jsonHolen(url, optionen) {
    const antwort = await fetch(url, optionen);
    if (!antwort.ok) {
      let grund = `HTTP ${antwort.status}`;
      try {
        const koerper = await antwort.json();
        if (koerper && koerper.detail) grund = typeof koerper.detail === 'string' ? koerper.detail : JSON.stringify(koerper.detail);
      } catch (e) { /* kein JSON — bei HTTP-Status bleiben */ }
      throw new Error(grund);
    }
    return antwort.json();
  }

  /**
   * Punkte im lokalen System der Wurzelkachel, an denen nachgemessen wird:
   * die acht Ecken ihrer Hüllbox, bei einer Hüllkugel sechs Punkte auf der
   * Oberfläche, sonst nur der Ursprung.
   */
  function messpunkte(hueller) {
    const C = Cesium;
    const box = hueller && hueller.box;
    if (Array.isArray(box) && box.length === 12) {
      const mitte = new C.Cartesian3(box[0], box[1], box[2]);
      const achsen = [0, 1, 2].map((i) => new C.Cartesian3(box[3 + 3 * i], box[4 + 3 * i], box[5 + 3 * i]));
      const punkte = [];
      for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) {
        const p = C.Cartesian3.clone(mitte);
        C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(achsen[0], a, new C.Cartesian3()), p);
        C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(achsen[1], b, new C.Cartesian3()), p);
        C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(achsen[2], c, new C.Cartesian3()), p);
        punkte.push(p);
      }
      return punkte;
    }
    const kugel = hueller && hueller.sphere;
    if (Array.isArray(kugel) && kugel.length === 4) {
      const [x, y, z, r] = kugel;
      return [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]]
        .map(([dx, dy, dz]) => new C.Cartesian3(x + dx, y + dy, z + dz));
    }
    return [new C.Cartesian3(0, 0, 0)];
  }

  /** Weltlage der Messpunkte unter modelMatrix · root.transform. */
  function weltpunkte(modelMatrix, wurzel, punkte) {
    const gesamt = Cesium.Matrix4.multiply(modelMatrix, wurzel, new Cesium.Matrix4());
    return punkte.map((p) => Cesium.Matrix4.multiplyByPoint(gesamt, p, new Cesium.Cartesian3()));
  }

  /** Ob ein geladenes Modell eine Backend-Platzierung hat, die man schreiben kann. */
  BimViewer.lageBackendMoeglich = function (assetId) {
    const asset = this._asset(assetId);
    return !!(asset && asset.tileset && jobVon(asset) && this.getBackendUrl && this.getBackendUrl());
  };

  /**
   * Rechnet die sichtbare Lage in eine Platzierung um — ohne etwas zu
   * schreiben. `alt` ist die Antwort von GET /assets/{job}/placement.
   */
  BimViewer._platzierungAusSitzung = async function (tileset, alt, versatz) {
    const C = Cesium;
    const hoeheAlt = typeof alt.height_ellipsoid === 'number'
      ? alt.height_ellipsoid
      : tileset.root.extras && tileset.root.extras.ileen && tileset.root.extras.ileen.heightEllipsoid;
    if (typeof hoeheAlt !== 'number' || !isFinite(hoeheAlt)) {
      throw new Error('Platzierung ohne aufgelöste Ellipsoidhöhe');
    }

    // Der Referenzpunkt der Platzierung — vor dem Versatz der Sitzung (nur
    // mit der Geländeausrichtung) und jetzt, so wie er im Bild steht.
    const bezug = C.Cartesian3.fromDegrees(alt.lon, alt.lat, hoeheAlt);
    const ausgang = (this.zOffset && this.zOffset.originalPositions.get(tileset)) || tileset.modelMatrix;
    const vorher = C.Cartographic.fromCartesian(C.Matrix4.multiplyByPoint(ausgang, bezug, new C.Cartesian3()));
    const jetzt = C.Cartographic.fromCartesian(C.Matrix4.multiplyByPoint(tileset.modelMatrix, bezug, new C.Cartesian3()));
    const lon = C.Math.toDegrees(jetzt.longitude);
    const lat = C.Math.toDegrees(jetzt.latitude);

    let height = alt.height + (jetzt.height - vorher.height);
    let hoehenweg = 'versatz';
    const ausgerichtet = window.ILeenTerrainAlign && ILeenTerrainAlign.info(tileset);
    if (alt.height_reference === 'terrain' && ausgerichtet) {
      const gelaende = await ILeenTerrainAlign.sampleTerrain(lon, lat);
      if (gelaende !== null) {
        height = jetzt.height - gelaende;
        hoehenweg = 'gelaende';
      }
    }

    return {
      platzierung: {
        lon,
        lat,
        height,
        height_reference: alt.height_reference,
        heading: winkel((alt.heading || 0) + versatz.heading),
        pitch: alt.pitch || 0,
        roll: alt.roll || 0,
        scale: alt.scale || 1,
      },
      hoehenweg,
    };
  };

  /**
   * Schreibt die sichtbare Lage eines Modells als Platzierung ins Backend.
   *
   * `bestaetigen(vorschlag)` wird vor dem Schreiben gefragt und kann mit
   * `false` abbrechen — das Flyout zeigt dort einen Dialog, Konsole und MCP
   * lassen ihn weg. Liefert `{ platzierung, abweichung, hoehenweg }` oder null,
   * wenn nichts geschrieben wurde.
   */
  BimViewer.lageInsBackend = async function (assetId, { bestaetigen = null } = {}) {
    const asset = this._asset(assetId);
    const job = jobVon(asset);
    const basis = this.getBackendUrl && this.getBackendUrl();
    if (!asset || !asset.tileset || !job || !basis) {
      this.updateStatus(t('asset.syncOnlyBackend'), 'warning');
      return null;
    }
    const tileset = asset.tileset;
    const versatz = sitzungsversatz(tileset);
    if (!istVerschoben(versatz)) {
      this.updateStatus(t('asset.syncNothing', { name: asset.name }), 'info');
      return null;
    }

    try {
      const alt = await jsonHolen(`${basis}/assets/${job}/placement`, { cache: 'no-store' });
      if (alt.adjustable === false) {
        this.updateStatus(t('asset.syncLocked', { name: asset.name }), 'warning');
        return null;
      }

      const { platzierung, hoehenweg } = await this._platzierungAusSitzung(tileset, alt, versatz);
      if (bestaetigen && !(await bestaetigen({ asset, alt, platzierung, versatz }))) return null;

      // Für die Probe am Ende: die Lage, wie sie jetzt im Bild steht.
      const matrixVorher = Cesium.Matrix4.clone(tileset.modelMatrix);
      const wurzelVorher = Cesium.Matrix4.clone(tileset.root.transform);

      this.updateStatus(t('asset.syncRunning', { name: asset.name }), 'loading');
      const gespeichert = await jsonHolen(`${basis}/assets/${job}/placement`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(platzierung),
      });

      // Den neuen Stand so übernehmen, wie ihn jeder andere laden würde: aus
      // der tileset.json, die das Backend eben geschrieben hat.
      const neu = await jsonHolen(asset.url, { cache: 'no-store' });
      if (!neu.root || !Array.isArray(neu.root.transform)) {
        throw new Error('tileset.json ohne root.transform');
      }
      Cesium.Matrix4.clone(Cesium.Matrix4.unpack(neu.root.transform), tileset.root.transform);
      const extras = tileset.root.extras;
      if (extras && neu.root.extras && neu.root.extras.ileen) extras.ileen = neu.root.extras.ileen;

      // Versätze der Sitzung leeren — sie stecken jetzt in der Platzierung.
      const ausgang = this.zOffset && this.zOffset.originalPositions.get(tileset);
      this.translation && this.translation.individualOffsets.delete(tileset);
      this.rotation && this.rotation.individualHeadings.delete(tileset);
      if (this.zOffset) {
        this.zOffset.individualOffsets.delete(tileset);
        this.zOffset.originalPositions.delete(tileset);
        this.zOffset.originalCartographics.delete(tileset);
      }

      // Geländebezug: an der neuen Stelle neu auflösen, von der Nullmatrix aus
      // (alignAsset lässt die modelMatrix stehen, wenn fast nichts zu tun ist).
      // Absolute Bezüge behalten die Ausgangsmatrix von vor dem Verschieben.
      if (gespeichert.height_reference === 'terrain' && window.ILeenTerrainAlign) {
        tileset.modelMatrix = Cesium.Matrix4.IDENTITY.clone();
        await ILeenTerrainAlign.alignAsset(asset, { force: true });
      } else {
        tileset.modelMatrix = ausgang ? Cesium.Matrix4.clone(ausgang) : Cesium.Matrix4.IDENTITY.clone();
      }
      if (this.viewer) this.viewer.scene.requestRender();

      // Die Hüllbox der Wurzel ist lokal — verschoben hat sich nur ihr Transform.
      const punkte = messpunkte(neu.root.boundingVolume);
      const vorher = weltpunkte(matrixVorher, wurzelVorher, punkte);
      const nachher = weltpunkte(tileset.modelMatrix, tileset.root.transform, punkte);
      const abweichung = Math.max(...vorher.map((p, i) => Cesium.Cartesian3.distance(p, nachher[i])));

      console.log(
        `📍 ${asset.name}: Lage ins Backend geschrieben — ${gespeichert.lat.toFixed(7)}, ` +
        `${gespeichert.lon.toFixed(7)}, ${gespeichert.height.toFixed(2)} m (${gespeichert.height_reference}), ` +
        `Heading ${gespeichert.heading.toFixed(2)}°, Abweichung ${(abweichung * 1000).toFixed(1)} mm`,
        { alt, gespeichert, versatz, hoehenweg }
      );
      const art = abweichung < 0.01 ? 'success' : 'warning';
      this.updateStatus(t('asset.syncDone', {
        name: asset.name,
        abweichung: abweichung < 1 ? `${(abweichung * 1000).toFixed(0)} mm` : `${abweichung.toFixed(2)} m`,
      }), art);
      return { platzierung: gespeichert, abweichung, hoehenweg };
    } catch (fehler) {
      console.error('Lage ins Backend fehlgeschlagen:', fehler);
      this.updateStatus(t('asset.syncFailed', { name: asset.name, grund: fehler.message }), 'error');
      return null;
    }
  };
})();
