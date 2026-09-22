/**
 * iLEEN — Schnitte X · Y · Z
 *
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Drei Ebenen durch **alle** geladenen Modelle, eine je Achse. Das ist der
 * schnelle Schnitt: Dach weg, Fassade weg, ein Blick ins Bauwerk — ohne vorher
 * ein Bauteil anklicken zu müssen. Wer einen Ausschnitt um ein *einzelnes*
 * Bauteil braucht, nimmt die Schnittbox (`section-box.js`) im Reiter daneben.
 *
 * ── Das Bezugssystem ─────────────────────────────────────────────────────
 *
 * „X, Y, Z" meint hier nicht das Tileset-System — das steht bei jedem Modell
 * anders und ist für den Bedienenden unsichtbar. Gemeint ist ein ENU-Rahmen
 * (Ost / Nord / Höhe) im Schwerpunkt aller geladenen Modelle: X zeigt nach
 * Osten, Y nach Norden, Z nach oben. Ein Regler in Metern ist damit etwas,
 * das man am Bild nachvollziehen kann, und derselbe Reglerwert bedeutet für
 * jedes Modell in der Szene dasselbe.
 *
 * Der Rahmen wird beim ersten Einschalten einmal gesetzt und danach nur noch
 * auf Verlangen („Neu einpassen"). Sonst spränge der Nullpunkt unter der Hand,
 * sobald ein weiteres Modell dazukommt — und mit ihm der ganze Schnitt.
 *
 * ── Warum die Ebenen so belegt sind ──────────────────────────────────────
 *
 * Cesium verwirft, wo `dot(normal, p) + distance < 0` wird. Bei
 * `unionClippingRegions = true` reicht **eine** Ebene dafür; das Ergebnis ist
 * der Durchschnitt der drei stehengelassenen Halbräume, also die Ecke, die
 * man erwartet. Eine ausgeschaltete Achse bekommt keine entfernte Ebene,
 * sondern eine mit sehr großem Abstand — sie liegt damit außerhalb jeder
 * Szene und schneidet nie. Die Zahl der Ebenen bleibt so konstant, und die
 * Sammlung muss ihre Textur nicht bei jedem Klick neu aufbauen.
 *
 * ── Warum Sammlungen hängen bleiben ──────────────────────────────────────
 *
 * `tileset.clippingPlanes = undefined` zerstört die Sammlung samt Textur,
 * während bereits gebaute Zeichenbefehle diese Textur noch als Uniform
 * führen — der nächste Bildaufbau stirbt mit „Cannot read properties of
 * undefined (reading '_target')". Aufgehoben wird deshalb über
 * `sammlung.enabled = false`, genau wie in `aufmass.js` und `section-box.js`.
 *
 * Ein Tileset, das bereits **fremde** Schnittebenen trägt (Schnittbox oder
 * Aufmaß-Box), wird ausgelassen statt übernommen: zwei Werkzeuge an derselben
 * einen Eigenschaft können nur nacheinander gewinnen, und ein Schnitt, der
 * stillschweigend verschwindet, ist schlimmer als einer, der nicht kommt.
 * Wie viele Modelle ausgelassen wurden, sagt die Statuszeile.
 */
'use strict';

(function () {

  if (typeof Cesium === 'undefined' || typeof BimViewer === 'undefined') {
    console.error('❌ SchnitteXYZ: Cesium/BimViewer fehlen — Ladereihenfolge prüfen');
    return;
  }

  var ACHSEN = ['x', 'y', 'z'];

  // Abstand, bei dem eine Ebene garantiert außerhalb jeder Szene liegt.
  var FERN = 1e7;

  var KANTE = '#97BF0D';   // MIB-Grün — dieselbe Kantenfarbe wie an der Schnittbox
  var KANTENBREITE = 1.0;

  var Z = {
    achsen: {
      x: { an: false, pos: 0, richtung: 1 },
      y: { an: false, pos: 0, richtung: 1 },
      // Beim ersten Einschalten will man fast immer das Dach weg, nicht den
      // Keller — Z hält deshalb die Seite *unter* der Ebene.
      z: { an: false, pos: 0, richtung: -1 },
    },
    kante: true,      // Schnittkante hervorheben
    rahmen: null,     // Matrix4: ENU-Rahmen → ECEF
    spanne: 0,        // halbe Kantenlänge in Metern, Umfang der Regler
    eintraege: [],    // [{ tileset, sammlung }]
  };

  function ue(schluessel, ersatz) {
    var s = (typeof t === 'function') ? t(schluessel) : schluessel;
    return (s === schluessel) ? ersatz : s;
  }

  // ── Szene ────────────────────────────────────────────────────────────────

  function istSplat(ts) {
    if (ts._isGaussianSplat) return true;
    return !!(window.SplatPick && SplatPick.isGaussianTileset && SplatPick.isGaussianTileset(ts));
  }

  /** Alle Tilesets, die überhaupt geschnitten werden können. */
  function tilesets() {
    var liste = [];
    BimViewer.loadedAssets.forEach(function (a) {
      // Splats kennen kein `clippingPlanes` — sie stillschweigend aufzunehmen
      // hieße, einen Schnitt zu versprechen, den man nicht bekommt.
      if (a.tileset && !istSplat(a.tileset)) liste.push(a.tileset);
    });
    return liste;
  }

  /** Hüllkugel über alle schneidbaren Modelle — Ursprung und Umfang der Regler. */
  function huelle() {
    var kugeln = tilesets()
      .map(function (ts) { return ts.boundingSphere; })
      .filter(function (k) { return k && isFinite(k.radius) && k.radius > 0; });
    if (!kugeln.length) return null;
    return Cesium.BoundingSphere.fromBoundingSpheres(kugeln);
  }

  /** Rahmen setzen, falls noch keiner steht. Gibt zurück, ob einer da ist. */
  function rahmenSichern() {
    if (Z.rahmen) return true;
    return einpassen(true);
  }

  /**
   * Nullpunkt und Reglerumfang neu aus der Szene nehmen.
   *
   * Setzt die Ebenen zurück in die Mitte: ein alter Meterwert bezöge sich
   * sonst auf einen Nullpunkt, den es nicht mehr gibt.
   */
  function einpassen(still) {
    var k = huelle();
    if (!k) {
      if (!still) melde(ue('sxyz.none', 'Kein schneidbares Modell geladen'), 'warn');
      return false;
    }
    Z.rahmen = Cesium.Transforms.eastNorthUpToFixedFrame(k.center);
    Z.spanne = Math.max(k.radius, 1);
    ACHSEN.forEach(function (a) { Z.achsen[a].pos = 0; });
    reglerStand();
    anwenden(still);
    return true;
  }

  // ── Ebenen ───────────────────────────────────────────────────────────────

  /**
   * Sammlung zu einem Tileset holen oder anlegen.
   * `null` heißt: das Tileset trägt bereits fremde Ebenen und bleibt in Ruhe.
   */
  function eintrag(ts) {
    var vorhanden = null;
    for (var i = 0; i < Z.eintraege.length; i++) {
      if (Z.eintraege[i].tileset === ts) { vorhanden = Z.eintraege[i]; break; }
    }
    if (vorhanden) {
      // Fremdes Werkzeug hat die Sammlung inzwischen ausgetauscht.
      if (ts.clippingPlanes !== vorhanden.sammlung) return null;
      return vorhanden;
    }
    if (ts.clippingPlanes) return null;

    var sammlung = new Cesium.ClippingPlaneCollection({
      planes: ACHSEN.map(function (name, i) {
        var n = [0, 0, 0];
        n[i] = 1;
        return new Cesium.ClippingPlane(new Cesium.Cartesian3(n[0], n[1], n[2]), FERN);
      }),
      unionClippingRegions: true,
      edgeWidth: Z.kante ? KANTENBREITE : 0.0,
      edgeColor: Cesium.Color.fromCssColorString(KANTE),
    });
    ts.clippingPlanes = sammlung;
    vorhanden = { tileset: ts, sammlung: sammlung };
    Z.eintraege.push(vorhanden);
    return vorhanden;
  }

  /** Den eingestellten Schnitt auf alle Modelle schreiben. */
  function anwenden(still) {
    if (!rahmenSichern()) return;

    var aktiv = ACHSEN.some(function (a) { return Z.achsen[a].an; });
    var getroffen = 0;
    var fremd = 0;

    tilesets().forEach(function (ts) {
      var e = eintrag(ts);
      if (!e) { fremd++; return; }

      ACHSEN.forEach(function (name, i) {
        var s = Z.achsen[name];
        var ebene = e.sammlung.get(i);
        var n = [0, 0, 0];
        n[i] = s.an ? s.richtung : 1;
        ebene.normal = new Cesium.Cartesian3(n[0], n[1], n[2]);
        ebene.distance = s.an ? -s.richtung * s.pos : FERN;
      });

      // Die Ebenen stehen im ENU-Rahmen, die Sammlung rechnet im System des
      // Tilesets — dazwischen steht `clippingPlanesOriginMatrix`.
      e.sammlung.modelMatrix = Cesium.Matrix4.multiply(
        Cesium.Matrix4.inverse(ts.clippingPlanesOriginMatrix, new Cesium.Matrix4()),
        Z.rahmen, new Cesium.Matrix4());
      e.sammlung.edgeWidth = Z.kante ? KANTENBREITE : 0.0;
      e.sammlung.enabled = aktiv;
      getroffen++;
    });

    if (BimViewer.viewer) BimViewer.viewer.scene.requestRender();

    if (still) return;
    if (!getroffen) {
      melde(fremd
        ? fremd + ' ' + ue('sxyz.foreign', 'Modell(e) mit fremdem Schnitt ausgelassen')
        : ue('sxyz.none', 'Kein schneidbares Modell geladen'), 'warn');
      return;
    }
    melde(aktiv
      ? ue('sxyz.applied', 'Schnitt auf') + ' ' + getroffen + ' ' + ue('sxyz.models', 'Modell(e)') +
        (fremd ? ' · ' + fremd + ' ' + ue('sxyz.foreign', 'Modell(e) mit fremdem Schnitt ausgelassen') : '')
      : ue('sxyz.off', 'Alle Schnitte aus'));
  }

  /** Alle drei Achsen ausschalten — die Sammlungen bleiben hängen. */
  function alleAus() {
    ACHSEN.forEach(function (a) { Z.achsen[a].an = false; });
    reglerStand();
    anwenden();
  }

  /** Ein entladenes Modell darf keine Sammlung mehr tragen. */
  function vergessen(ts) {
    Z.eintraege = Z.eintraege.filter(function (e) { return e.tileset !== ts; });
  }

  // ── Bedienung ────────────────────────────────────────────────────────────

  function setAn(achse, an) {
    var s = Z.achsen[achse];
    if (!s) return;
    s.an = !!an;
    reglerStand();
    anwenden();
  }

  function setPos(achse, wert) {
    var s = Z.achsen[achse];
    if (!s) return;
    s.pos = parseFloat(wert) || 0;
    // Beim Ziehen steht der Regler schon richtig — der Wert kam ja von ihm.
    // Beim Aufruf von außen (MCP, Prüfstein) muss er nachgeführt werden,
    // sonst zeigt das Panel etwas anderes an als die Szene.
    var regler = el('sxyzPos_' + achse);
    if (regler && Math.abs(parseFloat(regler.value) - s.pos) > 1e-9) regler.value = s.pos;
    // Die Statuszeile soll beim Ziehen nicht flackern — nur die Meterzahl.
    wertStand(achse);
    anwenden(true);
  }

  /**
   * Schnittkante hervorheben oder nicht.
   *
   * Cesium färbt die Pixel nahe der Ebene ein. Das zeichnet die Schnittlinie
   * schön nach, solange die Ebene die Geometrie quer trifft — liegt sie aber
   * *in* einer flachen Platte (eine waagerechte Ebene mitten in der
   * Dachdecke), liegt die ganze Platte innerhalb der Kantenbreite und
   * leuchtet vollflächig. Dafür gibt es keinen Kniff; darum der Schalter.
   */
  function setKante(an) {
    Z.kante = !!an;
    var haken = el('sxyzKante');
    if (haken && haken.checked !== Z.kante) haken.checked = Z.kante;
    Z.eintraege.forEach(function (e) {
      try { e.sammlung.edgeWidth = Z.kante ? KANTENBREITE : 0.0; } catch (err) { /* entladen */ }
    });
    if (BimViewer.viewer) BimViewer.viewer.scene.requestRender();
  }

  /** Welche Seite stehen bleibt, umdrehen. */
  function umkehren(achse) {
    var s = Z.achsen[achse];
    if (!s) return;
    s.richtung = -s.richtung;
    if (!s.an) { s.an = true; reglerStand(); }
    else wertStand(achse);
    anwenden();
  }

  // ── Oberfläche ───────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }

  function melde(nachricht, art) {
    var k = el('sxyzStatus');
    if (!k) return;
    k.textContent = nachricht;
    k.className = 'hint' + (art === 'warn' ? ' hint--warn' : '');
  }

  function wertStand(achse) {
    var s = Z.achsen[achse];
    var w = el('sxyzWert_' + achse);
    if (w) w.textContent = (s.pos >= 0 ? '+' : '') + s.pos.toFixed(2) + ' m';
    var p = el('sxyzPfeil_' + achse);
    if (p) p.textContent = PFEIL(achse, s.richtung > 0);
  }

  // Welche Seite stehen bleibt, ist die eine Frage, die man am Knopf nicht
  // ablesen kann — der Pfeil sagt es in der Sprache der Himmelsrichtung.
  function PFEIL(achse, plus) {
    var w = {
      x: { plus: ['sxyz.east', '→ Ost'], minus: ['sxyz.west', '← West'] },
      y: { plus: ['sxyz.north', '→ Nord'], minus: ['sxyz.south', '← Süd'] },
      z: { plus: ['sxyz.up', '↑ oben'], minus: ['sxyz.down', '↓ unten'] },
    }[achse][plus ? 'plus' : 'minus'];
    return ue(w[0], w[1]);
  }

  /**
   * Regler, Haken und Anzeigen auf den Stand des Moduls bringen.
   *
   * Der Reglerumfang wird auf ein Vielfaches der Schrittweite aufgerundet.
   * Das ist kein Schönheitsmaß: Ein Schieberegler rastet auf dem Raster
   * `min + n · step` ein, und liegt die Null nicht auf diesem Raster, meldet
   * er nach jedem Einpassen einen krummen Wert zurück („0,01 m“ statt „0“) —
   * die Ebene säße um einen Zentimeter neben der Mitte, ohne dass es
   * jemand einstellt hätte.
   */
  function reglerStand() {
    var kante = el('sxyzKante');
    if (kante) kante.checked = Z.kante;
    var schritt = Math.max(0.01, Math.round(Z.spanne / 400 * 100) / 100);
    var umfang = Math.ceil(Z.spanne / schritt) * schritt;
    ACHSEN.forEach(function (a) {
      var s = Z.achsen[a];
      var haken = el('sxyzAn_' + a);
      if (haken) haken.checked = s.an;
      var regler = el('sxyzPos_' + a);
      if (regler) {
        regler.step = schritt;
        regler.min = (-umfang).toFixed(2);
        regler.max = umfang.toFixed(2);
        regler.value = s.pos;
      }
      var zeile = el('sxyzZeile_' + a);
      if (zeile) zeile.classList.toggle('is-aus', !s.an);
      wertStand(a);
    });
  }

  function zeileHtml(achse, beschriftung) {
    var q = "'" + achse + "'";
    return '' +
      '<div class="pc-slider-row sxyz-zeile is-aus" id="sxyzZeile_' + achse + '">' +
        '<label class="sxyz-an">' +
          '<input type="checkbox" id="sxyzAn_' + achse + '"' +
                ' onchange="SchnitteXYZ.setAn(' + q + ', this.checked)">' +
          '<span class="pc-row-label">' + beschriftung + '</span>' +
        '</label>' +
        '<input type="range" class="pc-slider" id="sxyzPos_' + achse + '"' +
              ' min="-1" max="1" step="0.01" value="0"' +
              ' oninput="SchnitteXYZ.setPos(' + q + ', this.value)">' +
        '<span class="pc-value" id="sxyzWert_' + achse + '">+0.00 m</span>' +
        '<button class="btn btn--sm sxyz-seite" id="sxyzPfeil_' + achse + '"' +
              ' title="' + ue('sxyz.flip', 'Seite tauschen — welche Hälfte stehen bleibt') + '"' +
              ' onclick="SchnitteXYZ.umkehren(' + q + ')">' + PFEIL(achse, true) + '</button>' +
      '</div>';
  }

  function html() {
    return '' +
      '<style>' +
        '.sxyz-zeile { gap: 6px; }' +
        '.sxyz-zeile.is-aus > :not(.sxyz-an) { opacity: 0.4; }' +
        '.sxyz-an { display: flex; align-items: center; gap: 5px; cursor: pointer; }' +
        '.sxyz-an .pc-row-label { min-width: 54px; }' +
        '.sxyz-zeile .pc-value { min-width: 54px; white-space: nowrap; }' +
        // Ohne `min-width: 0` behält ein Schieberegler in Chrome seine
        // Eigenbreite von rund 130 px und schiebt den Seitenknopf aus dem Panel.
        '.sxyz-zeile .pc-slider { min-width: 0; }' +
        '.sxyz-seite { min-width: 62px; padding: 2px 5px; white-space: nowrap; }' +
      '</style>' +
      '<div class="section">' +
        '<div class="section__label">' + ue('sxyz.title', 'Schnitte X · Y · Z') + '</div>' +
        zeileHtml('x', ue('sxyz.x', 'X · Ost')) +
        zeileHtml('y', ue('sxyz.y', 'Y · Nord')) +
        zeileHtml('z', ue('sxyz.z', 'Z · Höhe')) +
        '<label class="pc-row">' +
          '<span class="pc-row-label">' + ue('sxyz.edges', 'Schnittkante zeigen') + '</span>' +
          '<input type="checkbox" id="sxyzKante" checked' +
                ' onchange="SchnitteXYZ.setKante(this.checked)"></label>' +
        '<div class="btn-group" style="margin-top:6px;">' +
          '<button class="btn btn--sm" onclick="SchnitteXYZ.einpassen()"' +
                ' title="' + ue('sxyz.fitHint', 'Nullpunkt und Reglerumfang neu aus den geladenen Modellen nehmen') + '">' +
            ue('sxyz.fit', 'Neu einpassen') + '</button>' +
          '<button class="btn btn--sm btn--danger" onclick="SchnitteXYZ.alleAus()">' +
            ue('sxyz.allOff', 'Alle aus') + '</button>' +
        '</div>' +
        '<p class="hint" id="sxyzStatus"></p>' +
        '<p class="hint">' +
          ue('sxyz.hint', 'Drei Ebenen durch alle geladenen Modelle. Der Nullpunkt liegt in der ' +
             'Mitte der Szene, die Regler zählen in Metern: X nach Osten, Y nach Norden, ' +
             'Z in der Höhe. Der Knopf rechts dreht um, welche Hälfte stehen bleibt.') +
        '</p>' +
        '<p class="hint">' +
          ue('sxyz.cutHint', 'Eine geschnittene Wand ist innen hohl — Cesium füllt Schnittflächen ' +
             'nicht. Modelle, die bereits von der Schnittbox oder vom Aufmaß geschnitten werden, ' +
             'bleiben unberührt.') +
        '</p>' +
      '</div>';
  }

  // ── Einhängen ────────────────────────────────────────────────────────────
  //
  // Wie `ui-new-features-extension.js`: der Reiter „Schnitte" gehört ui.js,
  // sein Inhalt wird hier davorgesetzt. So bleibt ui.js unangetastet und in
  // beiden Auslieferungen identisch.

  if (typeof BimViewerUI !== 'undefined' && BimViewerUI.getDrawingContent) {
    var urspruenglich = BimViewerUI.getDrawingContent.bind(BimViewerUI);
    BimViewerUI.getDrawingContent = function () {
      // Der Panelinhalt entsteht als Zeichenkette; die Regler bekommen ihre
      // Grenzen erst, wenn sie im DOM stehen.
      setTimeout(reglerStand, 0);
      return html() + urspruenglich();
    };
  }

  // Ein Sprachwechsel baut die gesamte Aktivitätsleiste neu auf — die Panels
  // sind Zeichenketten und lassen sich nicht nachträglich übersetzen. Danach
  // stehen die Regler wieder auf ihren Vorgabewerten und müssen den Stand des
  // Moduls zurückbekommen, sonst zeigt das Panel etwas anderes an als die Szene.
  document.addEventListener('ileen:language-changed', function () {
    setTimeout(reglerStand, 0);
  });

  // Ein neu geladenes Modell soll denselben Schnitt bekommen. Einen eigenen
  // Melder dafür gibt es nicht — `createAssetControls()` ist der eine Punkt,
  // den core.js nach jedem Laden anläuft (derselbe Weg wie in section-box.js).
  if (typeof BimViewerUI !== 'undefined' && typeof BimViewerUI.createAssetControls === 'function') {
    var vorher = BimViewerUI.createAssetControls.bind(BimViewerUI);
    BimViewerUI.createAssetControls = function (assetId) {
      vorher(assetId);
      if (!ACHSEN.some(function (a) { return Z.achsen[a].an; })) return;
      // Zweimal: einmal sofort, einmal nachdem das Tileset seine
      // Hüllkugel und seine `clippingPlanesOriginMatrix` wirklich hat.
      // Vor dem ersten Kachelsatz stehen dort Platzhalter, und der Schnitt
      // säße an der falschen Stelle, ohne dass jemand es merkt.
      setTimeout(function () { anwenden(true); }, 0);
      setTimeout(function () { anwenden(true); }, 2500);
    };
  }

  if (typeof BimViewer.unloadAsset === 'function') {
    var vorherEntladen = BimViewer.unloadAsset.bind(BimViewer);
    BimViewer.unloadAsset = function (assetId) {
      var a = BimViewer.loadedAssets.get(String(assetId));
      if (a && a.tileset) vergessen(a.tileset);
      return vorherEntladen(assetId);
    };
  }

  window.SchnitteXYZ = {
    html: html,
    setAn: setAn,
    setPos: setPos,
    umkehren: umkehren,
    setKante: setKante,
    einpassen: function () { einpassen(false); },
    alleAus: alleAus,
    anwenden: anwenden,
    zustand: function () {
      return {
        achsen: JSON.parse(JSON.stringify(Z.achsen)),
        kante: Z.kante,
        spanne: Z.spanne,
        modelle: Z.eintraege.length,
      };
    },
  };

})();
