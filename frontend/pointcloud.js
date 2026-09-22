/**
 * iLEEN — Darstellung von Punktwolken
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Detailstufe, Punktgröße, Eye-Dome-Lighting, Abschwächung und Farbmodus für
 * alle PNTS-Tilesets in der Szene. Das Panel dazu steht in ui.js
 * (`getPointCloudContent`, Ansicht-Panel).
 *
 * Wo die Bildrate wirklich herkommt
 * =================================
 * Das Panel hatte einen Regler „Geo. Error", der `pointCloudShading
 * .geometricErrorScale` stellte — und damit **nicht** die Kachelmenge,
 * sondern nur die Rechnung hinter der Abschwächung. Der eigentliche Hebel ist
 * `tileset.maximumScreenSpaceError`; der stand im Lader von core.js hart auf
 * 8 und war von außen unerreichbar. Acht Pixel zulässiger Bildschirmfehler
 * heißt bei einer Gebäudewolke: praktisch jede Kachel bis zur feinsten Stufe.
 * Daher die zwei Bilder je Sekunde.
 *
 * Deshalb führt diese Datei jetzt drei Größen statt einer:
 *
 *   maximumScreenSpaceError   wie viele Kacheln überhaupt geladen werden
 *   dynamicError              entfernte Kacheln zusätzlich vergröbern
 *   attenuationEnabled        die gröbere Stufe optisch schließen
 *
 * Die drei gehören zusammen. Wer nur den ersten hochdreht, bekommt eine
 * löchrige Wolke; wer die Abschwächung dazunimmt, bekommt dieselbe Wolke mit
 * größeren Punkten — dichter im Bild, ein Bruchteil der Geometrie. Die
 * Vorgabe ist deshalb 16 / an / an und nicht mehr 8 / aus / aus.
 *
 * Bildratenautomatik
 * ==================
 * `autoLeistung` regelt `maximumScreenSpaceError` zwischen dem eingestellten
 * Wert und `AUTO_MAX` nach, wenn die Szene unter die Zielrate fällt. Sie
 * misst am `postRender` der Szene — dieselbe Stelle wie fps.js, also die
 * Bildrate der Szene und nicht die des Fensters — und bewegt sich langsam,
 * mit Totband: eine Regelung, die bei jedem Ruckler zurückschlägt, pumpt.
 *
 * Der Höhenmodus misst
 * ====================
 * Er war eine Ansicht: blau unten, rot oben, über die ganze Wolke. Für eine
 * Ebenheitsmessung muss er ein Messgerät sein — Ober- und Untergrenze
 * wenige Millimeter auseinander, und was dazwischen liegt, über den ganzen
 * Farbraum gespreizt.
 *
 * Das ging über die Stilsprache nicht. `${POSITION_ABSOLUTE}` ist eine
 * Erdkoordinate in float32; bei 6 400 km Betrag sind das rund 0,5 m
 * Quantisierung, und eine Rampe über 5 mm hätte darin genau zwei Stufen.
 * Deshalb rechnet der Höhenmodus jetzt im AUGENSYSTEM (siehe
 * `hoehenBausteinBauen`): dort ist die Zahl so groß wie der Abstand zur
 * Kamera, und aus einem halben Meter Auflösung werden ein paar Mikrometer.
 */
'use strict';

(function () {
  if (typeof BimViewer === 'undefined') {
    console.error('pointcloud.js: core.js muss vorher geladen sein');
    return;
  }

  const VORGABE = {
    edlEnabled: true,
    edlStrength: 1.0,
    edlRadius: 1.0,
    pointSize: 2.0,
    // Abschwächung an: sie ist die Gegenleistung für die gröbere Stufe.
    // `maximumAttenuation: null` heißt „automatisch" — Cesium nimmt dann
    // `maximumScreenSpaceError` als Obergrenze, die Punktgröße folgt also
    // der Detailstufe von selbst.
    attenuationEnabled: true,
    maximumAttenuation: null,
    colorMode: 'rgb',
    geometricErrorScale: 1.0,
    backFaceCulling: false,
    // Der eigentliche LOD-Hebel.
    maximumScreenSpaceError: 16,
    dynamicError: true,
    cacheMB: 1024,
    autoLeistung: true,
    zielFps: 30,
    // Höhenmodus: null = Spanne aus dem Bounding-Volume der Wolke.
    heightWindow: null,
    // Was außerhalb des Höhenfensters liegt: 'klemmen' (Randfarbe halten),
    // 'aus' (verwerfen) oder 'grau'. Zum Messen taugt nur, was das Band
    // sichtbar begrenzt — geklemmt sieht eine 5-mm-Rampe aus wie eine Wolke,
    // die zur Hälfte blau und zur Hälfte rot ist.
    heightOutside: 'klemmen'
  };

  // Grenzen des Höhenfensters. Die Untergrenze ist nicht das, was eine Wolke
  // auflöst — ein Laserscan liegt bei ein bis zwei Millimetern Rauschen —,
  // sondern das, was float32 im Augensystem noch sicher trägt. Wer 0,2 mm
  // einstellt, sieht Rauschen; er sieht es aber richtig.
  const FENSTER_MIN = 0.0002;    // 0,2 mm
  const FENSTER_MAX = 2000;      // m, darüber ist es keine Wolke mehr

  // Grenzen der Bildratenautomatik.
  const AUTO_MIN_FAKTOR = 1.0;   // nie feiner als eingestellt
  const AUTO_MAX = 64;           // gröber lohnt nicht, da sieht man nur Klötze
  const AUTO_SCHRITT = 1.25;     // je Eingriff, multiplikativ
  const AUTO_PERIODE = 1000;     // ms zwischen zwei Eingriffen
  const AUTO_TOTBAND = 1.35;     // erst ab Ziel * Totband wieder verfeinern

  BimViewer.pointCloudSettings = Object.assign({}, VORGABE);

  function punktwolken(callback) {
    let anzahl = 0;
    BimViewer.loadedAssets.forEach((asset) => {
      if (!asset.tileset) return;
      if (asset.isPointCloud || BimViewer.isPointCloudTileset(asset.tileset)) {
        callback(asset.tileset, asset);
        anzahl++;
      }
    });
    return anzahl;
  }

  BimViewer.initPointCloudSettings = function () {
    this.applyPointCloudSettingsToAllTilesets();
    this.updatePointCloudUI();
    autoStarten();
  };

  BimViewer.applyPointCloudSettingsToAllTilesets = function () {
    return punktwolken((tileset) => this.applyPointCloudSettings(tileset));
  };

  /**
   * Die Ladeoptionen für ein frisches Punktwolken-Tileset. core.js holt sie
   * hier ab, statt eigene Zahlen zu führen — sonst stehen im Lader andere
   * Werte als im Panel, und der erste Regler-Zug springt.
   */
  BimViewer.pointCloudLoadOptions = function () {
    const s = this.pointCloudSettings || VORGABE;
    return {
      maximumScreenSpaceError: s.maximumScreenSpaceError,
      dynamicScreenSpaceError: !!s.dynamicError,
      dynamicScreenSpaceErrorDensity: 2.0e-4,
      dynamicScreenSpaceErrorFactor: 24.0,
      dynamicScreenSpaceErrorHeightFalloff: 0.25,
      cacheBytes: (s.cacheMB || 1024) * 1024 * 1024,
      maximumCacheOverflowBytes: 256 * 1024 * 1024,
      // Punktwolken vertragen die LOD-Sprünge der Mesh-Tilesets nicht (siehe
      // core.js), wohl aber das Nachladen der Geschwister: ohne das reißen
      // beim Schwenken Löcher auf, die erst eine Sekunde später zulaufen.
      preloadWhenHidden: false,
      loadSiblings: false
    };
  };

  /**
   * Ist das eine Punktwolke? Mehrere Signale, das spezifischste zuerst.
   */
  BimViewer.isPointCloudTileset = function (tileset) {
    if (!tileset) return false;

    // Gaussian Splats sind KEINE Punktwolken — sie haben einen eigenen
    // Renderweg, und Punktwolken-Einstellungen erzeugen dort Artefakte.
    if (tileset._isGaussianSplat) return false;
    try {
      const exts = tileset.extensionsUsed || [];
      if (Array.isArray(exts) && exts.some((e) => /gaussian_splatting/i.test(e))) {
        tileset._isGaussianSplat = true;
        return false;
      }
      if (Array.isArray(exts) && exts.some((e) => /draco_point_compression/i.test(e))) {
        return true;
      }
    } catch (e) { /* Tileset noch nicht bereit */ }

    // Cesium ion trägt den Asset-Typ in den Extras.
    try {
      const extras = tileset.extras || (tileset.asset && tileset.asset.extras);
      if (extras) {
        const typ = String((extras.ion && extras.ion.assetType) || '').toUpperCase();
        if (typ === 'POINTCLOUD' || typ === 'POINT_CLOUD') return true;
      }
    } catch (e) { /* ohne Extras */ }

    // `tileset.pointCloudShading` ist KEIN Signal: Cesium legt das Objekt im
    // Konstruktor jedes Tilesets an, auch bei B3DM-Meshes.
    //
    // Inhalt prüfen. B3DM und PNTS laufen beide über Model3DTileContent,
    // `content.pointsLength` unterscheidet sie (0 bei Meshes). Solange der
    // Inhalt noch nicht geladen ist, hilft die deklarierte URI aus der
    // Tileset-JSON, die synchron beim Aufbau des Baums gesetzt wird.
    const pruefe = (tile, tiefe) => {
      if (!tile || tiefe > 3) return false;
      const content = tile.content;
      if (content && typeof content.pointsLength === 'number' && content.pointsLength > 0) {
        return true;
      }
      const kopf = tile._contentHeader || {};
      const uri = String(kopf.uri || kopf.url || (content && content.url) || '').toLowerCase();
      if (uri.includes('.pnts') || uri.includes('pointcloud') || uri.includes('point_cloud')) {
        return true;
      }
      if (tile.children && tile.children.length) {
        for (let i = 0; i < Math.min(tile.children.length, 5); i++) {
          if (pruefe(tile.children[i], tiefe + 1)) return true;
        }
      }
      return false;
    };
    return pruefe(tileset.root, 0);
  };

  BimViewer.markAsPointCloud = function (assetId) {
    const asset = this.loadedAssets.get(assetId);
    if (!asset || !asset.tileset) return;
    asset.isPointCloud = true;
    this.applyPointCloudSettings(asset.tileset);
  };

  BimViewer.applyPointCloudSettings = function (tileset) {
    if (!tileset || tileset._isGaussianSplat) return;
    const s = this.pointCloudSettings;
    try {
      // ── Detailstufe: der Hebel für die Bildrate ──────────────────────
      // `_autoSse` ist der von der Automatik nachgeführte Wert; ohne
      // Automatik ist er gleich dem eingestellten.
      tileset.maximumScreenSpaceError = this._autoSse || s.maximumScreenSpaceError;
      if ('dynamicScreenSpaceError' in tileset) {
        tileset.dynamicScreenSpaceError = !!s.dynamicError;
      }
      if ('cacheBytes' in tileset) {
        tileset.cacheBytes = (s.cacheMB || 1024) * 1024 * 1024;
      }

      const schattierung = tileset.pointCloudShading;
      if (schattierung) {
        const szene = this.viewer && this.viewer.scene;
        const edlMoeglich = !szene || !Cesium.PointCloudShading.isSupported ||
                            Cesium.PointCloudShading.isSupported(szene);
        schattierung.eyeDomeLighting = !!(s.edlEnabled && edlMoeglich);
        schattierung.eyeDomeLightingStrength = s.edlStrength;
        schattierung.eyeDomeLightingRadius = s.edlRadius;
        schattierung.attenuation = !!s.attenuationEnabled;
        schattierung.geometricErrorScale = s.geometricErrorScale;
        schattierung.backFaceCulling = !!s.backFaceCulling;
        if (s.attenuationEnabled && s.maximumAttenuation) {
          schattierung.maximumAttenuation = s.maximumAttenuation;
        } else {
          // undefined heißt bei Cesium „nimm maximumScreenSpaceError" — die
          // Punktgröße folgt dann der Detailstufe, und eine gröber geladene
          // Wolke schließt sich von selbst.
          schattierung.maximumAttenuation = undefined;
        }
      }
      this.applyColorMode(tileset, s.colorMode);
    } catch (fehler) {
      console.warn('Punktwolken-Einstellungen nicht anwendbar:', fehler.message);
    }
  };

  // ── Höhenspanne einer Wolke ──────────────────────────────────────────────

  /**
   * Tiefste und höchste Stelle einer Wolke, samt Bezugspunkt und Lotrichtung.
   *
   * Gelesen wird das Bounding-Volume der Wurzel: py3dtiles schreibt dort eine
   * orientierte Box, deren acht Ecken die Wolke sicher einschließen. Nur wenn
   * keine Box da ist, muss die Hüllkugel herhalten — die ist zu großzügig,
   * weil ihr Radius die waagerechte Ausdehnung mitträgt.
   *
   * Gemessen wird gegen die WAAGERECHTE DURCH DEN BEZUGSPUNKT, nicht gegen
   * das Ellipsoid — also genau so, wie der Shader später rechnet. Der
   * Unterschied ist die Erdkrümmung, `d²/2R`: über einen Raum hinweg ein
   * Hundertstel Millimeter, über einen Kilometer acht Zentimeter. Solange
   * beide Seiten dieselbe Bezugsfläche benutzen, steht ein eingetipptes
   * Millimeterband überall dort, wo es stehen soll; mischte man die
   * Konventionen, wanderte es am Rand einer großen Wolke aus dem Bild.
   */
  function hoehenBezug(tileset) {
    if (!tileset || !tileset.root) return null;
    const ellipsoid = Cesium.Ellipsoid.WGS84;
    let ecken = null;
    let mitte = null;

    try {
      const obb = tileset.root.boundingVolume && tileset.root.boundingVolume.boundingVolume;
      if (obb && obb.halfAxes && obb.center) {
        mitte = Cesium.Cartesian3.clone(obb.center, new Cesium.Cartesian3());
        const u = Cesium.Matrix3.getColumn(obb.halfAxes, 0, new Cesium.Cartesian3());
        const v = Cesium.Matrix3.getColumn(obb.halfAxes, 1, new Cesium.Cartesian3());
        const w = Cesium.Matrix3.getColumn(obb.halfAxes, 2, new Cesium.Cartesian3());
        ecken = [];
        for (let a = -1; a <= 1; a += 2) {
          for (let b = -1; b <= 1; b += 2) {
            for (let c = -1; c <= 1; c += 2) {
              const p = Cesium.Cartesian3.clone(mitte, new Cesium.Cartesian3());
              Cesium.Cartesian3.add(p, Cesium.Cartesian3.multiplyByScalar(u, a, new Cesium.Cartesian3()), p);
              Cesium.Cartesian3.add(p, Cesium.Cartesian3.multiplyByScalar(v, b, new Cesium.Cartesian3()), p);
              Cesium.Cartesian3.add(p, Cesium.Cartesian3.multiplyByScalar(w, c, new Cesium.Cartesian3()), p);
              ecken.push(p);
            }
          }
        }
      }
    } catch (e) { ecken = null; }

    if (!ecken) {
      const kugel = tileset.boundingSphere;
      if (!kugel) return null;
      mitte = Cesium.Cartesian3.clone(kugel.center, new Cesium.Cartesian3());
      const hm = ellipsoid.cartesianToCartographic(mitte);
      if (!hm) return null;
      const lot = ellipsoid.geodeticSurfaceNormal(mitte, new Cesium.Cartesian3());
      return {
        mitte: mitte, lot: lot,
        hMitte: hm.height,
        hMin: hm.height - kugel.radius * 0.5,
        hMax: hm.height + kugel.radius * 0.5
      };
    }

    const hm = ellipsoid.cartesianToCartographic(mitte);
    const lot = ellipsoid.geodeticSurfaceNormal(mitte, new Cesium.Cartesian3());
    const hMitte = hm ? hm.height : 0;

    let dMin = Infinity, dMax = -Infinity;
    const ab = new Cesium.Cartesian3();
    ecken.forEach((p) => {
      Cesium.Cartesian3.subtract(p, mitte, ab);
      const d = Cesium.Cartesian3.dot(ab, lot);
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    });
    if (!isFinite(dMin) || !isFinite(dMax)) return null;

    return {
      mitte: mitte, lot: lot, hMitte: hMitte,
      hMin: hMitte + dMin, hMax: hMitte + dMax
    };
  }

  BimViewer.pointCloudHeightRange = hoehenBezug;

  /**
   * Der Stilausdruck für die Höhe eines Punktes, in Metern über dem
   * Ellipsoid, als Zeichenkette für `Cesium3DTileStyle`.
   *
   * `${POSITION_ABSOLUTE}` ist die Lage des Punktes in Erdkoordinaten. Der
   * Bezugspunkt wird abgezogen, BEVOR mit dem Lot multipliziert wird: der
   * Ausdruck wird zu GLSL, dort rechnet die Karte in einfacher Genauigkeit,
   * und ein Skalarprodukt über Werte um 6 400 000 hätte davon nichts mehr
   * übrig. Was bleibt, ist die Quantisierung der Erdkoordinate selbst — rund
   * einen halben Meter. Für eine Höhenrampe über ein Gebäude oder ein
   * Gelände reicht das; auf einen Zentimeter einfärben kann sie nicht.
   */
  function hoehenAusdruck(bezug) {
    const c = bezug.mitte, u = bezug.lot;
    const f = (x) => x.toFixed(4);
    return '((${POSITION_ABSOLUTE}.x - ' + f(c.x) + ') * ' + f(u.x) +
           ' + (${POSITION_ABSOLUTE}.y - ' + f(c.y) + ') * ' + f(u.y) +
           ' + (${POSITION_ABSOLUTE}.z - ' + f(c.z) + ') * ' + f(u.z) +
           ' + ' + f(bezug.hMitte) + ')';
  }

  // ── Höhe im Augensystem: der feine Weg ───────────────────────────────────
  //
  // Die Stilsprache hört bei einem halben Meter auf (siehe `hoehenAusdruck`).
  // Für eine Ebenheitsmessung ist das nutzlos — dort liegen Ober- und
  // Untergrenze wenige Millimeter auseinander.
  //
  // Der Ausweg führt an der Stilsprache vorbei. Punktwolken laufen über
  // denselben Modell-Renderer wie die IFC-Kacheln
  // (`Cesium3DTileContentFactory.pnts → Model3DTileContent.fromPnts`), und
  // damit greift `customShader` auch auf ihnen. Dort steht
  // `fsInput.attributes.positionEC` bereit: die Lage des Punktes im
  // AUGENSYSTEM. Die ist nicht 6 400 km groß, sondern so groß wie der
  // Abstand zur Kamera — bei zwanzig Metern bleiben in float32 rund zwei
  // Mikrometer Auflösung. Genau deshalb rechnet Cesium selbst alles dort.
  //
  // Bezugspunkt und Lot wandern je Bild auf der CPU ins Augensystem
  // (`hoehenNachfuehren`): dort in doppelter Genauigkeit, und erst das
  // Ergebnis — eine kleine Zahl — geht als Uniform in den Shader.

  const HOEHE_BLOCK = 'punktwolken-hoehe';

  /** Was außerhalb des Bandes passiert, als Zahl für den Shader. */
  const AUSSEN = { klemmen: 0, aus: 1, grau: 2 };

  /** Trägt diese Cesium-Fassung den feinen Weg? Sonst bleibt es beim Stil. */
  function hoehenShaderMoeglich() {
    return !!(typeof Cesium !== 'undefined' &&
              Cesium.CustomShader && Cesium.UniformType && Cesium.LightingModel &&
              Cesium.Cartesian4 && Cesium.Matrix4 &&
              Cesium.Matrix4.multiplyByPointAsVector &&
              BimViewer.ShaderVerbund);
  }

  /**
   * Der Baustein für den Shader-Verbund.
   *
   * `fenster` ist ein `Cartesian4`: x/y sind Unter- und Obergrenze in Metern
   * ÜBER DEM BEZUGSPUNKT (nicht über dem Ellipsoid — kleine Zahlen bleiben
   * in float32 klein), z ist der Umgang mit allem außerhalb.
   */
  function hoehenBausteinBauen(fenster) {
    return {
      ordnung: 30,
      // Eine Höhenrampe ist eine Messgröße, kein Werkstoff: ein
      // Beleuchtungsmodell würde denselben Millimeter je nach Blickwinkel
      // anders einfärben. Die Plastik der Wolke kommt vom Eye-Dome-Lighting,
      // und das ist ein Nachbearbeitungsschritt, kein Materialmodell.
      lightingModel: Cesium.LightingModel.UNLIT,
      uniforms: {
        u_pcHoeheRef: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(0, 0, 0) },
        u_pcHoeheLot: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(0, 0, 1) },
        u_pcHoeheFenster: { type: Cesium.UniformType.VEC4, value: fenster }
      },
      fragment: [
        '    float h = dot(fsInput.attributes.positionEC - u_pcHoeheRef, u_pcHoeheLot);',
        '    float unten = u_pcHoeheFenster.x;',
        '    float spanne = max(u_pcHoeheFenster.y - unten, 1.0e-7);',
        '    float t = (h - unten) / spanne;',
        '    float aussen = u_pcHoeheFenster.z;',
        '    bool draussen = (t < 0.0 || t > 1.0);',
        '    if (draussen && aussen > 0.5 && aussen < 1.5) discard;',
        '    if (draussen && aussen > 1.5) {',
        '      material.diffuse = vec3(0.26, 0.28, 0.31);',
        '    } else {',
        // Blau unten über Cyan, Grün und Gelb nach Rot oben — dieselbe Rampe
        // wie im Stilweg. 0.6667 ist Blau im Farbkreis.
        '      material.diffuse = czm_HSLToRGB(vec3((1.0 - clamp(t, 0.0, 1.0)) * 0.6667, 0.9, 0.5));',
        '    }'
      ].join('\n')
    };
  }

  /** Den Baustein von einer Wolke abmelden. */
  function hoehenShaderAus(tileset) {
    const V = BimViewer.ShaderVerbund;
    if (!V || !tileset) return;
    try { if (V.hat(tileset, HOEHE_BLOCK)) V.entfernen(tileset, HOEHE_BLOCK); }
    catch (e) { /* Tileset schon entladen */ }
  }

  let hoehenWacheAn = false;

  /**
   * Bezugspunkt und Lot je Bild ins Augensystem drehen.
   *
   * `camera.viewMatrix` rechnet in doppelter Genauigkeit; ihr
   * Verschiebungsanteil hebt die Erdkoordinate des Bezugspunkts fast
   * vollständig auf, und was übrig bleibt, ist der Abstand zur Kamera. Erst
   * DIESE kleine Zahl wird float32 — dieselbe Reihenfolge, in der auch
   * `czm_modelView` entsteht, mit der der Shader `positionEC` bildet.
   *
   * Für jede Wolke ein frisches `Cartesian3`: `ShaderVerbund.uniform()`
   * schreibt den Wert nicht nur in den Shader, sondern auch in die
   * Baustein-Definition zurück. Ein geteiltes Objekt wäre damit ein stiller
   * Kanal zwischen zwei Wolken (derselbe Grund wie in licht.js).
   */
  function hoehenNachfuehren() {
    const V = BimViewer.ShaderVerbund;
    const szene = BimViewer.viewer && BimViewer.viewer.scene;
    if (!V || !szene) { hoehenWacheStoppen(); return; }
    const sicht = szene.camera && szene.camera.viewMatrix;
    if (!sicht) return;

    let laufen = 0;
    punktwolken((tileset) => {
      if (!V.hat(tileset, HOEHE_BLOCK)) return;
      const b = tileset._ileenHoehenBezug;
      if (!b || !b.mitte || !b.lot) return;
      laufen++;
      const ref = Cesium.Matrix4.multiplyByPoint(sicht, b.mitte, new Cesium.Cartesian3());
      const lot = Cesium.Matrix4.multiplyByPointAsVector(sicht, b.lot, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(lot, lot);
      V.uniform(tileset, 'u_pcHoeheRef', ref);
      V.uniform(tileset, 'u_pcHoeheLot', lot);
    });

    // Niemand mehr da, der den Baustein trägt — die Wache hat nichts mehr zu
    // tun und soll nicht je Bild über alle Assets laufen.
    if (!laufen) hoehenWacheStoppen();
  }

  function hoehenWacheStarten() {
    if (hoehenWacheAn) return;
    const szene = BimViewer.viewer && BimViewer.viewer.scene;
    if (!szene || !szene.preRender || !szene.preRender.addEventListener) return;
    szene.preRender.addEventListener(hoehenNachfuehren);
    hoehenWacheAn = true;
    // Einmal sofort: ohne das stünde das erste Bild auf den Anfangswerten.
    hoehenNachfuehren();
  }

  function hoehenWacheStoppen() {
    if (!hoehenWacheAn) return;
    const szene = BimViewer.viewer && BimViewer.viewer.scene;
    try {
      if (szene && szene.preRender) szene.preRender.removeEventListener(hoehenNachfuehren);
    } catch (e) { /* Szene weg */ }
    hoehenWacheAn = false;
  }

  /** Farbmodus als Tileset-Stil; die Punktgröße reist im selben Stil mit. */
  BimViewer.applyColorMode = function (tileset, modus) {
    if (!tileset) return;
    if (modus !== 'height') hoehenShaderAus(tileset);
    try {
      const s = this.pointCloudSettings || {};
      // Mit aktiver Abschwächung keine Punktgröße im Stil: Cesium ignoriert
      // die Abschwächung, sobald der Stil eine Größe vorgibt.
      const groesse = s.attenuationEnabled ? undefined : (s.pointSize || 2.0);
      // Jeder neue `Cesium3DTileStyle` lässt Cesium den Shader jedes
      // Kachelinhalts neu übersetzen. Beim Ziehen eines Reglers wäre das
      // sechzigmal in der Sekunde — also nur setzen, wenn sich am Stil
      // wirklich etwas geändert hat.
      const stil = (definition) => {
        if (groesse !== undefined) definition.pointSize = groesse;
        const signatur = modus + '|' + JSON.stringify(definition);
        if (tileset._ileenStilSignatur === signatur) return;
        tileset._ileenStilSignatur = signatur;
        tileset.style = new Cesium.Cesium3DTileStyle(definition);
      };

      switch (modus) {
        case 'height': {
          const bezug = hoehenBezug(tileset);
          if (!bezug) { stil({}); break; }
          const fenster = s.heightWindow;
          let hMin = fenster && isFinite(fenster.min) ? fenster.min : bezug.hMin;
          let hMax = fenster && isFinite(fenster.max) ? fenster.max : bezug.hMax;
          if (!(hMax > hMin)) hMax = hMin + FENSTER_MIN;
          tileset._ileenHoehenBezug = {
            min: hMin, max: hMax, autoMin: bezug.hMin, autoMax: bezug.hMax,
            mitte: bezug.mitte, lot: bezug.lot, hMitte: bezug.hMitte
          };

          if (hoehenShaderMoeglich()) {
            // Der Stil trägt nur noch die Punktgröße — die Farbe kommt aus
            // dem Shader, und beides zu rechnen brächte nichts als das
            // gröbere Ergebnis obendrauf.
            stil({});
            const V = BimViewer.ShaderVerbund;
            const w = new Cesium.Cartesian4(hMin - bezug.hMitte, hMax - bezug.hMitte,
                                            AUSSEN[s.heightOutside] || 0, 0);
            // Läuft der Baustein schon, reicht das Uniform: ein neuer
            // Baustein hieße neuer Shader, und der Dickenregler baute ihn
            // bei jedem Pixel Reglerweg neu.
            if (V.hat(tileset, HOEHE_BLOCK)) V.uniform(tileset, 'u_pcHoeheFenster', w);
            else V.setzen(tileset, HOEHE_BLOCK, hoehenBausteinBauen(w));
            tileset._ileenHoehenFein = true;
            hoehenWacheStarten();
            break;
          }

          // Rückfallweg: grob, aber besser als gar keine Höhe.
          tileset._ileenHoehenFein = false;
          const t = '(clamp((' + hoehenAusdruck(bezug) + ' - ' + hMin.toFixed(4) +
                    ') / ' + (hMax - hMin).toFixed(4) + ', 0.0, 1.0))';
          // Blau unten über Cyan, Grün und Gelb nach Rot oben — die Rampe,
          // die jede Höhenkarte benutzt. 0.6667 ist Blau im Farbkreis.
          stil({ color: 'hsl((1.0 - ' + t + ') * 0.6667, 0.9, 0.5)' });
          break;
        }
        case 'intensity':
          stil({
            color: "color() * (typeof ${Intensity} !== 'undefined' ? ${Intensity} : 1.0)"
          });
          break;
        case 'classification':
          // ASPRS-Klassen: 2 Boden, 3–5 Vegetation, 6 Gebäude, 9 Wasser
          stil({
            color: {
              conditions: [
                ["typeof ${Classification} !== 'undefined' && ${Classification} === 0", "color('#808080')"],
                ["typeof ${Classification} !== 'undefined' && ${Classification} === 1", "color('#808080')"],
                ["typeof ${Classification} !== 'undefined' && ${Classification} === 2", "color('#8B4513')"],
                ["typeof ${Classification} !== 'undefined' && ${Classification} === 3", "color('#00FF00')"],
                ["typeof ${Classification} !== 'undefined' && ${Classification} === 4", "color('#228B22')"],
                ["typeof ${Classification} !== 'undefined' && ${Classification} === 5", "color('#006400')"],
                ["typeof ${Classification} !== 'undefined' && ${Classification} === 6", "color('#FF0000')"],
                ["typeof ${Classification} !== 'undefined' && ${Classification} === 9", "color('#0000FF')"],
                ['true', "color('#ffffff')"]
              ]
            }
          });
          break;
        default:
          stil({});
      }
    } catch (fehler) {
      console.warn('Farbmodus nicht anwendbar:', fehler.message);
    }
  };

  // ── Bildratenautomatik ───────────────────────────────────────────────────
  //
  // Sie greift nur, solange eine Punktwolke in der Szene liegt, und nur an
  // `maximumScreenSpaceError`. Alles andere — Punktgröße, EDL, Farbe — bleibt
  // so, wie der Nutzer es gestellt hat: eine Automatik, die dem Nutzer die
  // Darstellung umschreibt, verliert man nicht wieder.

  let autoHaengt = false;
  let autoLetzterEingriff = 0;
  let autoBilder = 0;
  let autoZeit = 0;
  let autoLetztesBild = 0;

  BimViewer._autoSse = 0;

  function autoStarten() {
    if (autoHaengt) return;
    const szene = BimViewer.viewer && BimViewer.viewer.scene;
    if (!szene) return;
    szene.postRender.addEventListener(autoBild);
    autoHaengt = true;
  }

  function autoBild() {
    const jetzt = performance.now();
    if (autoLetztesBild) {
      autoZeit += jetzt - autoLetztesBild;
      autoBilder++;
    }
    autoLetztesBild = jetzt;

    if (jetzt - autoLetzterEingriff < AUTO_PERIODE) return;
    autoLetzterEingriff = jetzt;

    const bilder = autoBilder, dauer = autoZeit;
    autoBilder = 0; autoZeit = 0;
    if (bilder < 4 || dauer <= 0) return;

    const s = BimViewer.pointCloudSettings;
    const basis = s.maximumScreenSpaceError;
    if (!s.autoLeistung) {
      if (BimViewer._autoSse !== basis) {
        BimViewer._autoSse = basis;
        BimViewer.applyPointCloudSettingsToAllTilesets();
      }
      return;
    }

    // Nur regeln, wenn überhaupt eine Punktwolke in der Szene liegt.
    let wolken = 0;
    BimViewer.loadedAssets.forEach((a) => {
      if (a.tileset && a.visible !== false &&
          (a.isPointCloud || BimViewer.isPointCloudTileset(a.tileset))) wolken++;
    });
    if (!wolken) return;

    const fps = (bilder * 1000) / dauer;
    const ziel = s.zielFps || 30;
    const alt = BimViewer._autoSse || basis;
    let neu = alt;

    if (fps < ziel && alt < AUTO_MAX) {
      neu = Math.min(AUTO_MAX, alt * AUTO_SCHRITT);
    } else if (fps > ziel * AUTO_TOTBAND && alt > basis * AUTO_MIN_FAKTOR) {
      neu = Math.max(basis * AUTO_MIN_FAKTOR, alt / AUTO_SCHRITT);
    }

    if (Math.abs(neu - alt) < 0.01) return;
    BimViewer._autoSse = neu;
    punktwolken((tileset) => {
      try { tileset.maximumScreenSpaceError = neu; } catch (e) { /* Tileset weg */ }
    });
    const anzeige = document.getElementById('pcAutoWert');
    if (anzeige) anzeige.textContent = neu.toFixed(0) + ' px · ' + fps.toFixed(0) + ' fps';
  }

  // ── Einzelne Stellschrauben ──────────────────────────────────────────────

  function setzen(schluessel, wert, meldung) {
    BimViewer.pointCloudSettings[schluessel] = wert;
    const n = BimViewer.applyPointCloudSettingsToAllTilesets();
    BimViewer.updatePointCloudUI();
    if (meldung && n) BimViewer.updateStatus(meldung, 'success');
  }

  BimViewer.setColorMode = function (modus) {
    const namen = { rgb: 'Originalfarbe', height: 'Höhe', intensity: 'Intensität', classification: 'Klassen' };
    setzen('colorMode', modus, 'Farbmodus: ' + (namen[modus] || modus));
  };
  BimViewer.setEyeDomeLighting = function (an) { setzen('edlEnabled', !!an); };
  BimViewer.setEDLStrength = function (wert) { setzen('edlStrength', parseFloat(wert) || 0); };
  BimViewer.setEDLRadius = function (wert) { setzen('edlRadius', parseFloat(wert) || 1); };
  BimViewer.setPointSize = function (wert) { setzen('pointSize', parseFloat(wert) || 1); };
  BimViewer.setAttenuation = function (an) { setzen('attenuationEnabled', !!an); };
  BimViewer.setMaximumAttenuation = function (wert) {
    const v = parseFloat(wert);
    setzen('maximumAttenuation', v > 1 ? v : null);
  };
  BimViewer.setGeometricErrorScale = function (wert) { setzen('geometricErrorScale', parseFloat(wert) || 1); };
  BimViewer.setBackFaceCulling = function (an) { setzen('backFaceCulling', !!an); };

  /** Detailstufe in Pixeln zulässigen Bildschirmfehlers. Groß = wenig Kacheln. */
  BimViewer.setPointCloudDetail = function (wert) {
    const v = Math.max(1, Math.min(AUTO_MAX, parseFloat(wert) || 16));
    BimViewer._autoSse = v;   // Automatik neu einhängen lassen
    setzen('maximumScreenSpaceError', v);
  };
  BimViewer.setPointCloudDynamicError = function (an) { setzen('dynamicError', !!an); };
  BimViewer.setPointCloudAuto = function (an) {
    BimViewer.pointCloudSettings.autoLeistung = !!an;
    if (!an) {
      BimViewer._autoSse = BimViewer.pointCloudSettings.maximumScreenSpaceError;
      BimViewer.applyPointCloudSettingsToAllTilesets();
    }
    BimViewer.updatePointCloudUI();
  };

  /**
   * Höhenfenster der Farbrampe. Ohne Argumente zurück auf die Spanne der
   * Wolke. Sinnvoll, wenn eine Wolke vom Keller bis zum Nachbardach reicht
   * und die interessanten fünf Meter sonst in einer Farbe verschwinden.
   */
  BimViewer.setHeightWindow = function (min, max) {
    const a = parseFloat(min), b = parseFloat(max);
    BimViewer.pointCloudSettings.heightWindow =
      (isFinite(a) && isFinite(b) && b > a) ? { min: a, max: b } : null;
    BimViewer.applyPointCloudSettingsToAllTilesets();
    BimViewer.updatePointCloudUI();
  };

  // ── Das Band führen ──────────────────────────────────────────────────────
  //
  // Zum Messen greift niemand nach zwei absoluten Höhen. Er sagt „fünf
  // Millimeter dick" und schiebt das Band durch die Platte. Dicke und Mitte
  // sind deshalb die Handgriffe; `heightWindow` bleibt der Zustand, aus dem
  // sich beides ergibt — zwei nebeneinander geführte Darstellungen desselben
  // laufen früher oder später auseinander.

  /** Das geltende Fenster: das gesetzte, sonst die Spanne der Wolke. */
  function hoehenSpanne() {
    const s = BimViewer.pointCloudSettings;
    if (s.heightWindow) return { min: s.heightWindow.min, max: s.heightWindow.max, auto: false };
    let auto = null;
    punktwolken((ts) => { if (!auto && ts._ileenHoehenBezug) auto = ts._ileenHoehenBezug; });
    if (auto) return { min: auto.autoMin, max: auto.autoMax, auto: true };
    return null;
  }

  BimViewer.getHeightWindow = function () { return hoehenSpanne(); };

  function fensterSetzen(mitte, dicke) {
    const d = Math.min(FENSTER_MAX, Math.max(FENSTER_MIN, dicke));
    BimViewer.setHeightWindow(mitte - d / 2, mitte + d / 2);
  }

  /** Banddicke in Metern; die Bandmitte bleibt stehen. */
  BimViewer.setHeightThickness = function (meter) {
    const sp = hoehenSpanne();
    const d = parseFloat(meter);
    if (!sp || !isFinite(d)) return;
    fensterSetzen((sp.min + sp.max) / 2, d);
  };

  /** Bandmitte in Metern über dem Ellipsoid; die Dicke bleibt stehen. */
  BimViewer.setHeightCenter = function (meter) {
    const sp = hoehenSpanne();
    const m = parseFloat(meter);
    if (!sp || !isFinite(m)) return;
    fensterSetzen(m, sp.max - sp.min);
  };

  /**
   * Das Band um `n` ganze Banddicken verschieben.
   *
   * Der Handgriff, mit dem man eine Platte abtastet: Dicke einmal einstellen,
   * dann Schritt für Schritt durch. Lückenlos und ohne Überlappung — genau
   * das kann ein Regler nicht, dessen Rasterung an der Wolkenhöhe hängt.
   */
  BimViewer.stepHeightWindow = function (n) {
    const sp = hoehenSpanne();
    const k = parseFloat(n);
    if (!sp || !isFinite(k)) return;
    const d = Math.max(FENSTER_MIN, sp.max - sp.min);
    BimViewer.setHeightWindow(sp.min + k * d, sp.max + k * d);
  };

  /** Was außerhalb des Bandes liegt: 'klemmen' | 'aus' | 'grau'. */
  BimViewer.setHeightOutside = function (art) {
    setzen('heightOutside', AUSSEN[art] === undefined ? 'klemmen' : art);
  };

  // ── Zahlen, die man noch lesen kann ──────────────────────────────────────

  /** Ein Höhenmaß in der Einheit, in der es nicht zur Ziffernkolonne wird. */
  function hoeheText(m) {
    if (!isFinite(m)) return '–';
    const a = Math.abs(m);
    if (a < 0.01) return (m * 1000).toFixed(2) + ' mm';
    if (a < 0.1)  return (m * 1000).toFixed(1) + ' mm';
    if (a < 1)    return (m * 100).toFixed(1) + ' cm';
    return m.toFixed(3) + ' m';
  }

  // Der Dickenregler läuft logarithmisch: zwischen einem halben Millimeter
  // und fünfzig Metern liegen fünf Zehnerpotenzen. Linear verteilt läge der
  // ganze Messbereich auf dem ersten Promille des Reglerwegs.
  const DICKE_REGLER_MIN = 0.0005;
  const DICKE_REGLER_MAX = 50;
  const DICKE_REGLER_SCHRITTE = 1000;

  function dickeAusRegler(v) {
    const f = Math.min(1, Math.max(0, (parseFloat(v) || 0) / DICKE_REGLER_SCHRITTE));
    return DICKE_REGLER_MIN * Math.pow(DICKE_REGLER_MAX / DICKE_REGLER_MIN, f);
  }

  function reglerAusDicke(d) {
    const g = Math.min(DICKE_REGLER_MAX, Math.max(DICKE_REGLER_MIN, d || DICKE_REGLER_MIN));
    const f = Math.log(g / DICKE_REGLER_MIN) / Math.log(DICKE_REGLER_MAX / DICKE_REGLER_MIN);
    return Math.round(f * DICKE_REGLER_SCHRITTE);
  }

  /** Der Dickenregler im Panel — die Umrechnung bleibt hier, nicht im Markup. */
  BimViewer.setHeightThicknessSlider = function (v) {
    BimViewer.setHeightThickness(dickeAusRegler(v));
  };

  BimViewer.resetPointCloudSettings = function () {
    this.pointCloudSettings = Object.assign({}, VORGABE);
    this._autoSse = VORGABE.maximumScreenSpaceError;
    this.applyPointCloudSettingsToAllTilesets();
    this.updatePointCloudUI();
    this.updateStatus('Punktwolken-Darstellung zurückgesetzt', 'success');
  };

  /** Regler und Schalter im Panel an den Zustand angleichen. */
  BimViewer.updatePointCloudUI = function () {
    const s = this.pointCloudSettings;

    const sync = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const syncText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const syncCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const syncDisabled = (id, disabled) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('disabled', disabled);
      const input = el.querySelector('input[type="range"]');
      if (input) input.disabled = disabled;
    };

    sync('colorModeSelect', s.colorMode || 'rgb');

    syncCheck('toggleEDL', s.edlEnabled);
    sync('edlStrengthSlider', s.edlStrength);
    syncText('edlStrengthValue', s.edlStrength.toFixed(1));
    syncDisabled('edlStrengthGroup', !s.edlEnabled);
    sync('edlRadiusSlider', s.edlRadius);
    syncText('edlRadiusValue', s.edlRadius.toFixed(1));
    syncDisabled('edlRadiusGroup', !s.edlEnabled);

    sync('pointSizeSlider', s.pointSize);
    syncText('pointSizeValue', s.pointSize.toFixed(1));
    // Mit Abschwächung bestimmt Cesium die Größe — der Regler zeigt das an,
    // statt eine Wirkung vorzugeben, die er gerade nicht hat.
    syncDisabled('pointSizeGroup', !!s.attenuationEnabled);

    syncCheck('toggleAttenuation', s.attenuationEnabled);
    const maxAtt = s.maximumAttenuation || 1;
    sync('maxAttenuationSlider', maxAtt);
    syncText('maxAttenuationValue', maxAtt === 1 ? 'auto' : maxAtt.toFixed(1));
    syncDisabled('maxAttenuationGroup', !s.attenuationEnabled);

    sync('pcDetailSlider', s.maximumScreenSpaceError);
    syncText('pcDetailValue', s.maximumScreenSpaceError.toFixed(0) + ' px');
    syncCheck('togglePcDynamic', s.dynamicError);
    syncCheck('togglePcAuto', s.autoLeistung);

    sync('geometricErrorSlider', s.geometricErrorScale);
    syncText('geometricErrorValue', s.geometricErrorScale.toFixed(1));

    syncCheck('toggleBackFaceCulling', s.backFaceCulling);

    // Höhenfenster: nur im Höhenmodus sichtbar, und die leeren Felder zeigen
    // die automatisch ermittelte Spanne als Platzhalter.
    const fensterZeile = document.getElementById('pcHeightWindow');
    if (fensterZeile) fensterZeile.hidden = s.colorMode !== 'height';
    if (s.colorMode !== 'height') return;

    let auto = null;
    punktwolken((ts) => { if (!auto && ts._ileenHoehenBezug) auto = ts._ileenHoehenBezug; });
    const spanne = hoehenSpanne();
    const dicke = spanne ? Math.max(0, spanne.max - spanne.min) : 0;
    const mitte = spanne ? (spanne.min + spanne.max) / 2 : 0;

    // Vier Nachkommastellen — ein Zehntelmillimeter. Weniger, und das
    // Zurückschreiben des gerundeten Werts würde ein eingestelltes Band bei
    // jedem Handgriff ein Stück verschieben.
    const min = document.getElementById('pcHeightMin');
    const max = document.getElementById('pcHeightMax');
    if (min && auto) min.placeholder = auto.autoMin.toFixed(4);
    if (max && auto) max.placeholder = auto.autoMax.toFixed(4);
    if (min) min.value = s.heightWindow ? s.heightWindow.min.toFixed(4) : '';
    if (max) max.value = s.heightWindow ? s.heightWindow.max.toFixed(4) : '';

    sync('pcHeightDicke', reglerAusDicke(dicke));
    syncText('pcHeightDickeValue', spanne ? hoeheText(dicke) : '–');

    // Der Mittenregler läuft in Metern über die Spanne der Wolke, mit
    // Millimeterrasterung. Ein Regler mit fester Skala hätte bei einer
    // dreißig Meter hohen Wolke drei Zentimeter je Pixel — mehr als das
    // ganze Band, das er verschieben soll.
    const mReg = document.getElementById('pcHeightMitte');
    if (mReg) {
      if (auto) {
        mReg.min = auto.autoMin.toFixed(4);
        mReg.max = auto.autoMax.toFixed(4);
      }
      // `step="any"`, nicht `0.001`: ein Raster liegt auf `min + n · step`,
      // und eine Bandmitte, die dort nicht genau hineinfällt, würde beim
      // Zurückschreiben um bis zu einen halben Rasterschritt wandern. Bei
      // einem Zweimillimeterband ist das ein Fünftel des Bandes, jedes Mal.
      // Fein eingestellt wird ohnehin mit dem Zahlenfeld und den Pfeilen.
      mReg.step = 'any';
      if (spanne) mReg.value = mitte;
    }
    syncText('pcHeightMitteValue', spanne ? mitte.toFixed(3) + ' m' : '–');

    sync('pcHeightAussen', s.heightOutside || 'klemmen');

    syncText('pcHeightVon', spanne ? hoeheText(-dicke / 2) : '–');
    syncText('pcHeightBand', spanne ? hoeheText(dicke) : '–');
    syncText('pcHeightBis', spanne ? '+' + hoeheText(dicke / 2) : '–');

    // Der Rückfallweg ist grob (siehe Kopf der Datei). Ein Band, das feiner
    // ist, als er auflöst, sähe dort schlicht falsch aus — also sagen wir es.
    const hinweis = document.getElementById('pcHeightGrob');
    if (hinweis) {
      let fein = true;
      punktwolken((ts) => { if (ts._ileenHoehenFein === false) fein = false; });
      hinweis.hidden = fein || dicke > 0.5;
    }
  };

  BimViewer.getPointCloudInfo = function () {
    const info = [];
    punktwolken((tileset, asset) => {
      info.push({
        id: asset.id,
        name: asset.name,
        punkte: tileset.statistics ? tileset.statistics.numberOfPointsSelected : undefined,
        sse: tileset.maximumScreenSpaceError
      });
    });
    return {
      anzahl: info.length,
      einstellungen: Object.assign({}, this.pointCloudSettings),
      geregelt: this._autoSse,
      tilesets: info
    };
  };

  BimViewer.applyPointCloudPreset = function (name) {
    const presets = {
      quality: {
        edlEnabled: true, edlStrength: 1.5, edlRadius: 2.0, pointSize: 3.0,
        attenuationEnabled: true, maximumAttenuation: null, geometricErrorScale: 1.0,
        maximumScreenSpaceError: 8, dynamicError: false, autoLeistung: false,
        colorMode: 'rgb'
      },
      performance: {
        edlEnabled: false, edlStrength: 0.5, edlRadius: 1.0, pointSize: 1.5,
        attenuationEnabled: true, maximumAttenuation: null, geometricErrorScale: 1.0,
        maximumScreenSpaceError: 32, dynamicError: true, autoLeistung: true,
        colorMode: 'rgb'
      },
      detailed: {
        edlEnabled: true, edlStrength: 2.0, edlRadius: 1.5, pointSize: 4.0,
        attenuationEnabled: true, maximumAttenuation: 6, geometricErrorScale: 1.0,
        maximumScreenSpaceError: 4, dynamicError: false, autoLeistung: false,
        colorMode: 'rgb'
      }
    };
    const preset = presets[name];
    if (!preset) {
      console.warn('Unbekannte Punktwolken-Voreinstellung:', name);
      return;
    }
    Object.assign(this.pointCloudSettings, preset);
    this._autoSse = preset.maximumScreenSpaceError;
    const n = this.applyPointCloudSettingsToAllTilesets();
    this.updatePointCloudUI();
    this.updateStatus('Punktwolken: ' + name + (n ? '' : ' (keine Punktwolke geladen)'), n ? 'success' : 'info');
  };

  // Prüfsteine hängen an der reinen Rechnerei.
  BimViewer._pointCloudIntern = {
    hoehenBezug: hoehenBezug, hoehenAusdruck: hoehenAusdruck, VORGABE: VORGABE,
    hoehenBausteinBauen: hoehenBausteinBauen, hoehenNachfuehren: hoehenNachfuehren,
    hoehenSpanne: hoehenSpanne, hoeheText: hoeheText,
    dickeAusRegler: dickeAusRegler, reglerAusDicke: reglerAusDicke,
    HOEHE_BLOCK: HOEHE_BLOCK, AUSSEN: AUSSEN, FENSTER_MIN: FENSTER_MIN
  };
})();
