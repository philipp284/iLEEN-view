/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
/**
 * Untergrund-Modus — unter das Gelände, und die Modelle bleiben sichtbar.
 *
 * Geändert werden drei Dinge:
 *
 * 1 · **Die Kamera darf durch.** `enableCollisionDetection = false`, dazu eine
 *     kleine Mindestentfernung, damit man an eine Bodenplatte heranfahren kann.
 *
 * 2 · **Die Oberfläche zeichnet sich ab — die Nullebene.** Ein Globus-Material
 *     legt ein metrisches Raster auf das Gelände (10 m fein, 50 m kräftig) und
 *     färbt die *Unterseite* erdbraun. Von oben sieht man die Karte mit
 *     Rasterlinien, von unten eine deckende Erddecke mit denselben Linien.
 *
 * 3 · **Das Gelände verdeckt die Modelle nicht.** Keller, Gründung, die
 *     Baugrube im Scan liegen unter der Oberfläche. Der Schalter „Durchblick
 *     über Modellen" (Voreinstellung an) setzt `globe.depthTestAgainstTerrain`
 *     auf false. Cesium zeichnet das Gelände dann ganz normal und deckend,
 *     löscht danach aber dessen Tiefe (`clearGlobeDepth` in Scene), bevor
 *     3D Tiles und Modelle kommen — die liegen damit immer über dem Gelände.
 *     Die Karte selbst wird nicht durchsichtig.
 *
 *     v0.5 versuchte das mit `globe.translucency` und einem Rechteck über den
 *     Modellen. Das Rechteck begrenzt aber nur die Alpha-Stufe im Shader;
 *     sobald `translucency.enabled` an ist, geht der GANZE Globus in Cesiums
 *     Transparenz-Renderpfad — im Bild wurde die ganze Welt durchsichtig.
 *     Der Modus fasst `globe.translucency` deshalb nicht mehr an.
 *
 * Warum die Erdfarbe im Material steht und nicht in `globe.undergroundColor`:
 * GlobeFS wendet das Material VOR der Untergrundfarbe an (GlobeFS.glsl,
 * APPLY_MATERIAL vor UNDERGROUND_COLOR). Eine deckende Untergrundfarbe
 * überdeckte also genau das Raster, um das es geht. Im Material entscheidet
 * `gl_FrontFacing`, welche Seite man sieht, und beides entsteht in einem Schritt.
 * `undergroundColor` wird für die Dauer des Modus abgeschaltet und danach
 * zurückgegeben.
 *
 * Warum das Raster in Augenkoordinaten gerechnet wird: `positionToEyeEC` ist
 * die einzige Lage, die das Globus-Material bekommt, und Weltkoordinaten
 * (6,4 Mio. m) hätten in `float` keine Stelle für die Linienbreite. Ursprung
 * und Ost/Nord-Achse werden je Bild in `preRender` in Augenkoordinaten
 * umgerechnet — dieselbe Technik wie in explosion.js. Entfernt sich die Kamera
 * mehr als 3 km vom Ursprung, rückt er in ganzen 50-m-Schritten nach; die
 * Linien bleiben dabei an ihrer Stelle.
 *
 * Grenze: Mit Google Photorealistic 3D Tiles ist der Globus ausgeblendet
 * (core.js) — dann gibt es keine Geländefläche, auf der die Nullebene liegen
 * könnte. Der Modus lässt die Kamera trotzdem durch und sagt das.
 */
(function () {
  'use strict';

  var SPEICHER = 'ileen_untergrund_v1';
  var WEITE = 10;            // Rasterweite in Metern; jede fünfte Linie kräftig
  var NACHRUECKEN = 3000;    // Abstand Kamera–Ursprung, ab dem der Ursprung nachrückt
  var ERDE = '#4a3a2c';
  var LINIE = '#30b4e7';     // iLEEN-Cyan, dasselbe wie im Logo

  var GLSL = [
    'czm_material czm_getMaterial(czm_materialInput materialInput)',
    '{',
    '  czm_material m = czm_getDefaultMaterial(materialInput);',
    '  vec3 d = -materialInput.positionToEyeEC - ursprungEC;',
    '  vec2 p = vec2(dot(d, ostEC), dot(d, nordEC));',
    '  float linie = 0.0;',
    '#if (__VERSION__ == 300 || defined(GL_OES_standard_derivatives))',
    '  vec2 q = p / weite;',
    '  vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-6));',
    '  float fein = 1.0 - min(min(g.x, g.y), 1.0);',
    '  vec2 q5 = p / (weite * 5.0);',
    '  vec2 g5 = 0.5 * abs(fract(q5 - 0.5) - 0.5) / max(fwidth(q5), vec2(1e-6));',
    '  float grob = 1.0 - min(min(g5.x, g5.y), 1.0);',
    '  linie = max(fein * 0.45, grob * 0.95);',
    '#endif',
    // In der Ferne werden die Linien feiner als ein Bildpunkt und flimmern.
    '  float e = length(materialInput.positionToEyeEC);',
    '  linie *= 1.0 - smoothstep(weite * 40.0, weite * 150.0, e);',
    '  if (gl_FrontFacing) {',
    '    m.diffuse = linienfarbe.rgb;',
    '    m.alpha = linie * linienfarbe.a;',
    '  } else {',
    // Die Unterseite nur, wenn die Kamera wirklich unten steht. Ist die
    // Globus-Transparenz von anderer Stelle an (Regler im Einstellungs-Tab),
    // zeichnet Cesium die Rückseiten auch von oben — ohne diese Bedingung
    // läge die Erdfarbe dann über der ganzen Landschaft.
    '    m.diffuse = mix(erdfarbe.rgb, linienfarbe.rgb, linie);',
    '    m.alpha = max(erdfarbe.a, linie) * kameraUnten;',
    '  }',
    '  return m;',
    '}'
  ].join('\n');

  var S = {
    an: false,
    nullebene: true,
    gesichert: null,      // Zustand von Globus und Kamera vor dem Einschalten
    material: null,
    wache: null,
    ursprung: null,       // Cartesian3 (ECEF) — Bezugspunkt des Rasters
    enu: null,            // Matrix4, eastNorthUpToFixedFrame(ursprung)
    durchblick: true      // Modelle werden vom Gelände nicht verdeckt
  };

  try {
    var gespeichert = JSON.parse(localStorage.getItem(SPEICHER) || '{}');
    if (typeof gespeichert.nullebene === 'boolean') S.nullebene = gespeichert.nullebene;
    if (typeof gespeichert.durchblick === 'boolean') S.durchblick = gespeichert.durchblick;
  } catch (e) { /* privates Fenster o. ä. — Voreinstellung gilt */ }

  function sichern() {
    try { localStorage.setItem(SPEICHER, JSON.stringify({ nullebene: S.nullebene, durchblick: S.durchblick })); } catch (e) { /* egal */ }
  }

  function viewer() {
    return window.BimViewer && window.BimViewer.viewer;
  }

  function melden(text, art) {
    if (window.BimViewer && typeof window.BimViewer.updateStatus === 'function') {
      window.BimViewer.updateStatus(text, art || 'success');
    }
  }

  // ── Raster ──────────────────────────────────────────────────────────────

  function materialBauen() {
    return new Cesium.Material({
      translucent: true,
      fabric: {
        type: 'IleenNullebene',
        uniforms: {
          ursprungEC: new Cesium.Cartesian3(),
          ostEC: new Cesium.Cartesian3(1, 0, 0),
          nordEC: new Cesium.Cartesian3(0, 1, 0),
          weite: WEITE,
          kameraUnten: 0.0,
          linienfarbe: Cesium.Color.fromCssColorString(LINIE),
          erdfarbe: Cesium.Color.fromCssColorString(ERDE).withAlpha(0.92)
        },
        source: GLSL
      }
    });
  }

  /** Bodenpunkt unter der Bildmitte, sonst unter der Kamera. */
  function bodenpunkt(v) {
    var szene = v.scene;
    var mitte = new Cesium.Cartesian2(szene.canvas.clientWidth / 2, szene.canvas.clientHeight / 2);
    var strahl = v.camera.getPickRay(mitte);
    var treffer = strahl && szene.globe.pick(strahl, szene);
    if (treffer) return treffer;
    var c = v.camera.positionCartographic;
    return Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0);
  }

  function ursprungSetzen(punkt) {
    S.ursprung = Cesium.Cartesian3.clone(punkt);
    S.enu = Cesium.Transforms.eastNorthUpToFixedFrame(S.ursprung);
  }

  /**
   * Rückt den Ursprung in ganzen Vielfachen der Hauptlinienweite nach, damit
   * die Linien beim Nachrücken nicht springen.
   *
   * **Nur verschieben, nicht neu ausrichten.** Die erste Fassung baute am
   * neuen Ort ein frisches Ost-Nord-Hoch-System. Dessen Achsen sind gegen die
   * alten um die Erdkrümmung gedreht (rund 0,05° auf 5 km), und das Raster
   * sprang beim Nachrücken um Meter — der Prüfstein hat es gefunden, im Bild
   * wäre es als Ruck beim Fliegen aufgefallen. Mit festen Achsen hat jeder
   * Punkt vorher und nachher dieselben Rasterkoordinaten modulo der Weite. Dass
   * „Ost" nach vielen Kilometern nicht mehr genau Ost ist, sieht man in den
   * 1,5 km, über die das Raster überhaupt gezeichnet wird, nicht.
   */
  function nachruecken(kameraWC) {
    var abstand = Cesium.Cartesian3.distance(kameraWC, S.ursprung);
    if (abstand < NACHRUECKEN) return false;
    var inv = Cesium.Matrix4.inverseTransformation(S.enu, new Cesium.Matrix4());
    var lokal = Cesium.Matrix4.multiplyByPoint(inv, kameraWC, new Cesium.Cartesian3());
    var schritt = WEITE * 5;
    var versatz = new Cesium.Cartesian3(
      Math.round(lokal.x / schritt) * schritt,
      Math.round(lokal.y / schritt) * schritt,
      0
    );
    var neu = Cesium.Matrix4.multiplyByPoint(S.enu, versatz, new Cesium.Cartesian3());
    S.ursprung = neu;
    Cesium.Matrix4.setTranslation(S.enu, neu, S.enu);
    return true;
  }

  // getColumn schreibt ein Cartesian4 — die Achse daraus braucht einen
  // eigenen Cartesian3-Puffer.
  var _spalte = new Cesium.Cartesian4();
  var _achse = new Cesium.Cartesian3();

  function uniformsNachfuehren() {
    var v = viewer();
    if (!v || !S.material || !S.ursprung) return;
    nachruecken(v.camera.positionWC);
    var sicht = v.camera.viewMatrix;
    var u = S.material.uniforms;
    u.kameraUnten = v.scene.cameraUnderground ? 1.0 : 0.0;
    Cesium.Matrix4.multiplyByPoint(sicht, S.ursprung, u.ursprungEC);
    Cesium.Matrix4.getColumn(S.enu, 0, _spalte);
    Cesium.Matrix4.multiplyByPointAsVector(sicht, Cesium.Cartesian3.fromCartesian4(_spalte, _achse), u.ostEC);
    Cesium.Matrix4.getColumn(S.enu, 1, _spalte);
    Cesium.Matrix4.multiplyByPointAsVector(sicht, Cesium.Cartesian3.fromCartesian4(_spalte, _achse), u.nordEC);
  }

  function nullebeneAnlegen(v) {
    var globus = v.scene.globe;
    if (S.material) return;
    ursprungSetzen(bodenpunkt(v));
    S.material = materialBauen();
    globus.material = S.material;
    // Die Erdfarbe steckt im Material; eine zusätzliche Untergrundfarbe
    // läge darüber und deckte das Raster zu.
    globus.undergroundColor = undefined;
    S.wache = v.scene.preRender.addEventListener(uniformsNachfuehren);
    uniformsNachfuehren();
    v.scene.requestRender();
  }

  function nullebeneEntfernen(v) {
    if (!S.material) return;
    var g = S.gesichert;
    var globus = v.scene.globe;
    if (S.wache) { S.wache(); S.wache = null; }
    // Nur zurückgeben, was wir selbst gesetzt haben — hat jemand anderes das
    // Material inzwischen ersetzt, bleibt seines stehen.
    if (globus.material === S.material) globus.material = g ? g.material : undefined;
    if (g) globus.undergroundColor = g.undergroundColor;
    S.material = null;
    v.scene.requestRender();
  }

  // ── Durchblick über Modellen ────────────────────────────────────────────

  /**
   * Durchblick an: Tiefentest gegen das Gelände aus — das Gelände wird
   * deckend gezeichnet, seine Tiefe aber vor den Modellen gelöscht.
   * Durchblick aus: Tiefentest an, das Gelände verdeckt, was darunter liegt.
   */
  function durchblickAnwenden(v) {
    v.scene.globe.depthTestAgainstTerrain = !S.durchblick;
    v.scene.requestRender();
  }

  // ── Modus ───────────────────────────────────────────────────────────────

  function an() {
    var v = viewer();
    if (!v || S.an) return;
    var szene = v.scene;
    var ssc = szene.screenSpaceCameraController;
    var globus = szene.globe;

    S.gesichert = {
      kollision: ssc.enableCollisionDetection,
      mindestabstand: ssc.minimumZoomDistance,
      tiefentest: globus.depthTestAgainstTerrain,
      material: globus.material,
      undergroundColor: globus.undergroundColor
    };

    ssc.enableCollisionDetection = false;
    ssc.minimumZoomDistance = 0.1;

    S.an = true;
    if (S.nullebene) nullebeneAnlegen(v);
    durchblickAnwenden(v);
    if (window.BimViewer && window.BimViewer.undergroundMode) window.BimViewer.undergroundMode.enabled = true;

    if (!globus.show) {
      melden('Untergrund: Google 3D Tiles blenden das Gelände aus — keine Nullebene', 'warning');
    }
    szene.requestRender();
  }

  function aus() {
    var v = viewer();
    if (!v || !S.an) return;
    var szene = v.scene;
    var ssc = szene.screenSpaceCameraController;
    var g = S.gesichert || {};

    nullebeneEntfernen(v);
    ssc.enableCollisionDetection = g.kollision !== undefined ? g.kollision : true;
    ssc.minimumZoomDistance = g.mindestabstand !== undefined ? g.mindestabstand : 1.0;
    szene.globe.depthTestAgainstTerrain = g.tiefentest !== undefined ? g.tiefentest : true;

    S.an = false;
    S.gesichert = null;
    if (window.BimViewer && window.BimViewer.undergroundMode) window.BimViewer.undergroundMode.enabled = false;
    szene.requestRender();
  }

  function nullebeneSetzen(wert) {
    S.nullebene = !!wert;
    sichern();
    var v = viewer();
    if (!v || !S.an) return;
    if (S.nullebene) nullebeneAnlegen(v);
    else nullebeneEntfernen(v);
  }

  function durchblickSetzen(wert) {
    S.durchblick = !!wert;
    sichern();
    var v = viewer();
    if (!v || !S.an) return;
    durchblickAnwenden(v);
  }

  var api = {
    an: an,
    aus: aus,
    umschalten: function () { if (S.an) aus(); else an(); },
    istAn: function () { return S.an; },
    nullebeneSetzen: nullebeneSetzen,
    nullebeneAn: function () { return S.nullebene; },
    durchblickSetzen: durchblickSetzen,
    durchblickAn: function () { return S.durchblick; },
    stand: function () {
      var v = viewer();
      var globus = v && v.scene.globe;
      return {
        an: S.an,
        nullebene: S.nullebene,
        durchblick: S.durchblick,
        transparenz: globus && globus.translucency ? globus.translucency.enabled : null,
        rasterAktiv: !!S.material,
        tiefentest: globus ? globus.depthTestAgainstTerrain : null,
        kollision: v ? v.scene.screenSpaceCameraController.enableCollisionDetection : null,
        kameraUnterGelaende: v ? v.scene.cameraUnderground : null
      };
    },
    _pruefsteine: {
      GLSL: GLSL, WEITE: WEITE,
      nachruecken: nachruecken, ursprungSetzen: ursprungSetzen,
      zustand: S
    }
  };

  function anhaengen() {
    if (!window.BimViewer) return false;
    window.BimViewer.Untergrund = api;
    return true;
  }

  if (!anhaengen()) {
    var versuch = setInterval(function () { if (anhaengen()) clearInterval(versuch); }, 200);
  }
})();
