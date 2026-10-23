/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
/**
 * FARBEN — Weißabgleich, neutrale Bauteilfarben, Glas
 *
 * Das Bild hat einen Stich ins Warme: eine Fassade, die grau sein soll, kommt
 * beige an, und die Szene sieht bei Mittagssonne aus wie in der Dämmerung.
 * Dahinter stecken ZWEI Ursachen, und sie brauchen zwei verschiedene Griffe.
 * Wer nur einen zieht, dreht am falschen Ende.
 *
 * ## 1 · Die Bauteile sind wirklich beige
 *
 * Nachgemessen am HSM-Campus, Fassade unbeleuchtet dargestellt (`UNLIT`, also
 * reine Eigenfarbe ohne jedes Licht):
 *
 *     Fassade   RGB 139 · 120 ·  91     — ein Braunbeige, kein Grau
 *     Glas      RGB  68 ·  90 · 100     — ein entsättigtes Blau
 *
 * Das steht so im IFC. Kein Weißabgleich der Welt macht daraus Grau, ohne
 * zugleich den Himmel grün und das Luftbild blau zu färben — ein Weißabgleich
 * dreht das GANZE Bild. Wer graue Wände und anthrazitfarbene Fenster will,
 * muss an die Materialfarbe, und zwar im Materialshader, wo Himmel, Gelände
 * und Luftbild nicht mitbetroffen sind.
 *
 * ## 2 · Cesium legt zusätzlich Wärme obendrauf
 *
 * Gemessen an derselben Fassade, beleuchtet gegen unbeleuchtet: Blau bleibt um
 * etwa 8 % hinter Grün zurück, Rot liegt etwa 1 % darüber. In der BESONNTEN
 * Fläche ist das wenig — im Schatten ist es viel, und der Grund steht in
 * Cesiums Voreinstellung:
 *
 * Seit 1.122 baut Cesium für jedes Modell aus dem Atmosphärenmodell eine
 * Umgebungskarte (`DynamicEnvironmentMapManager`). Was darin von unten kommt,
 * ist kein Himmel, sondern gedachter Erdboden — voreingestellt
 * `AVERAGE_EARTH_GROUND_COLOR` = **#717145**, ein Oliv, mit `groundAlbedo`
 * 0.31 und `atmosphereScatteringIntensity` 2.0. Jede verschattete Fläche
 * bekommt diesen Ton als Grundlicht. Dazu kommt die Streuung am Himmel, die
 * das Sonnenlicht mit sinkendem Stand ins Orange zieht, und die
 * Tonwertabbildung (`scene.highDynamicRange`), die einen Stich in den Lichtern
 * stehen lässt.
 *
 * ## Drei Griffe, an drei verschiedenen Stellen der Kette
 *
 * **Vor der Beleuchtung** — das Umgebungslicht neutral stellen (`groundColor`,
 * `saturation`, `brightness` je Träger). Ursachenbehandlung: wo kein olives
 * Licht hinfällt, muss hinterher keines herausgerechnet werden. Gilt auch für
 * die Weltkulisse, denn ein neutrales Haus vor olivbrauner Umgebung ist nur
 * halb korrigiert.
 *
 * **Im Material** — die Eigenfarbe der Bauteile entsättigen und die Verglasung
 * auf Anthrazit ziehen. Ein Baustein im Shader-Verbund, `ordnung: 45` (vor dem
 * Kunstlicht auf 50, damit die Taschenlampe die korrigierte Farbe anleuchtet).
 * Nur auf den eigenen Modellen — Luftbild, OSM-Gebäude und die
 * Google-Photogrammetrie sollen ihre Farben behalten.
 *
 * **Nach dem Bild** — ein Weißabgleich als Nachbearbeitungsstufe. Deckungs-
 * prüfung: was aus Himmel und Tonwertabbildung noch an Stich übrig ist, wird
 * hier neutralisiert. Gerechnet wird als Kanalverstärkung im linearen Licht,
 * nicht auf den Anzeigewerten — sonst kippen die Lichter, statt sich zu
 * drehen. Die Stufe läuft nach der Tonwertabbildung
 * (`PostProcessStageCollection` führt erst AO, Bloom und Tonemapping aus, dann
 * die angemeldeten Stufen, dann FXAA) und linearisiert deshalb selbst.
 *
 * ## Der Graupunkt
 *
 * Regler sind Raten. Der ehrliche Weg ist der aus der Fotografie: auf eine
 * Fläche zeigen, die grau sein SOLL, und das Bild darauf abgleichen. Die
 * Pipette liest den Bildpunkt aus der Zeichenfläche (möglich, weil core.js den
 * Zeichenpuffer erhält), rechnet die nötige Korrektur und schreibt sie in die
 * beiden Regler zurück — **nicht** in einen versteckten Zahlensatz. Wer danach
 * nachjustiert, sieht, wovon er ausgeht.
 *
 * Gemessen wird das bereits korrigierte Bild; die neue Verstärkung ist deshalb
 * die alte mal dem Rest, und ein zweiter Klick auf dieselbe Fläche ändert
 * nichts mehr. Kontrast und Sättigung stören dabei nicht: beide lassen
 * neutrale Töne neutral, der Fixpunkt liegt fest.
 *
 * ## Glas
 *
 * Verglasung bleibt auch nach allem anderen bunt: was man sieht, ist zum
 * größten Teil der gespiegelte Himmel, nicht die Scheibe. Anthrazit wird sie
 * erst, wenn die Spiegelung gedämpft UND die Grundfarbe gesetzt wird. Erkannt
 * wird Glas an seiner Durchsichtigkeit (`material.alpha`), nicht am Namen: die
 * Namen kommen aus dem Exporter und sind je Werkzeug anders, die
 * Durchsichtigkeit steht im Material. Wo eine Verglasung undurchsichtig
 * exportiert wurde, greift der Baustein nicht — dort hilft nur glb-glas.js,
 * das die Datei vor dem Laden umschreibt.
 */
(function () {
  'use strict';

  var SPEICHER = 'ileen_farben_v1';

  // 6500 K — Tageslicht D65, der Bezugspunkt jedes Weißabgleichs.
  var BEZUG_KELVIN = 6500;

  var S = {
    // Weißabgleich über das fertige Bild
    an: true,
    kelvin: 6050,             // Lichtfarbe IM Bild; gerechnet wird auf 6500 K
    tint: 0.0,                // −1 grün … +1 magenta
    belichtung: 1.0,
    kontrast: 1.0,
    saettigung: 1.0,
    staerke: 1.0,             // Überblendung Original ↔ Korrektur

    // Umgebungslicht (Ursache)
    umgebung: true,
    umgebungSaettigung: 0.4,
    umgebungHelligkeit: 2.2,
    bodenfarbe: '#8e8e8a',    // neutrales Grau statt Cesiums Oliv #717145

    // Farbschema der IFC-Typen (core.js: IFC_FARBEN_NEUTRAL)
    schema: 'neutral',          // 'neutral' = Bauwerksfarben, 'ifc' = Typfarben

    // Bauteilfarben im Material
    neutralAn: true,
    neutral: 0.9,             // wie weit die Eigenfarbe dem Grundton weicht
    grundton: 0.62,           // Albedo, auf die sie gezogen wird (0–1, linear)
    zeichnung: 0.55,          // wie viel Hell-Dunkel der Textur erhalten bleibt
    glas: true,
    glasFarbe: '#3b4044',     // Anthrazit
    glasAnteil: 0.75,
    glasSchwelle: 0.75        // ab welcher Durchsichtigkeit ein Material Glas ist
  };

  var ZAHLEN = ['kelvin', 'tint', 'belichtung', 'kontrast', 'saettigung', 'staerke',
                'umgebungSaettigung', 'umgebungHelligkeit',
                'neutral', 'grundton', 'zeichnung', 'glasAnteil', 'glasSchwelle'];
  var SCHALTER = ['an', 'umgebung', 'neutralAn', 'glas'];
  var TEXTE = ['bodenfarbe', 'glasFarbe', 'schema'];

  var VORGABE = JSON.parse(JSON.stringify(S));

  try {
    var g = JSON.parse(localStorage.getItem(SPEICHER) || '{}');
    ZAHLEN.forEach(function (k) { if (typeof g[k] === 'number' && isFinite(g[k])) S[k] = g[k]; });
    SCHALTER.forEach(function (k) { if (typeof g[k] === 'boolean') S[k] = g[k]; });
    TEXTE.forEach(function (k) { if (typeof g[k] === 'string') S[k] = g[k]; });
  } catch (e) { /* privates Fenster o. ä. — Voreinstellung gilt */ }

  function sichern() {
    try { localStorage.setItem(SPEICHER, JSON.stringify(S)); } catch (e) { /* egal */ }
  }

  function klemm(v, u, o) { return Math.max(u, Math.min(o, v)); }

  // ── Farbtemperatur ──────────────────────────────────────────────────────

  /**
   * Schwarzkörperfarbe in sRGB, Näherung nach Tanner Helland.
   *
   * Nicht exakt planckisch (das wäre der Umweg über CIE-XYZ und die
   * Planck-Ortskurve), aber zwischen 2000 und 12000 K auf wenige Prozent
   * genau — und damit genau genug für einen Regler, an dem man das Ergebnis
   * sieht.
   */
  function kelvinZuRgb(kelvin) {
    var t = klemm(kelvin, 1000, 20000) / 100;
    var r, gr, b;

    if (t <= 66) r = 255;
    else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);

    if (t <= 66) gr = 99.4708025861 * Math.log(t) - 161.1195681661;
    else gr = 288.1221695283 * Math.pow(t - 60, -0.0755148492);

    if (t >= 66) b = 255;
    else if (t <= 19) b = 0;
    else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

    return [klemm(r, 0, 255) / 255, klemm(gr, 0, 255) / 255, klemm(b, 0, 255) / 255];
  }

  var BEZUG_RGB = kelvinZuRgb(BEZUG_KELVIN);

  /** Kanalfaktoren, die Licht der Temperatur `kelvin` auf D65 abbilden. */
  function rohVerstaerkung(kelvin) {
    var q = kelvinZuRgb(kelvin);
    return [
      BEZUG_RGB[0] / Math.max(q[0], 1e-4),
      BEZUG_RGB[1] / Math.max(q[1], 1e-4),
      BEZUG_RGB[2] / Math.max(q[2], 1e-4)
    ];
  }

  // Die Grün-Magenta-Achse. Getrennte Faktoren, damit sie senkrecht auf der
  // Temperaturachse steht: Grün allein herunter, Rot und Blau zu gleichen
  // Teilen herauf.
  var TINT_G = 0.35, TINT_RB = 0.18;

  function tintFaktoren(tint) {
    var t = klemm(tint, -1, 1);
    return [1 + TINT_RB * t, 1 - TINT_G * t, 1 + TINT_RB * t];
  }

  /**
   * Die Verstärkung, die in den Shader geht — helligkeitserhaltend normiert.
   *
   * Ohne die Normierung wäre jeder Griff an der Temperatur zugleich einer an
   * der Belichtung, und man drehte zwei Regler, um einen zu bedienen.
   */
  function verstaerkung() {
    var v = rohVerstaerkung(S.kelvin);
    var f = tintFaktoren(S.tint);
    var g = [v[0] * f[0], v[1] * f[1], v[2] * f[2]];
    var y = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
    if (!(y > 1e-6)) return [1, 1, 1];
    return [g[0] / y, g[1] / y, g[2] / y];
  }

  /**
   * Der Rückweg: aus fertigen Kanalfaktoren wieder Temperatur und Tint machen.
   *
   * Die Temperatur trägt die Rot-Blau-Achse — sie wird gesucht, indem das
   * Verhältnis Rot zu Blau getroffen wird. Was an Grün übrig bleibt, ist der
   * Tint. Beides zusammen bildet die gemessene Verstärkung ab, solange sie in
   * der Ebene liegt, die die zwei Achsen aufspannen; sonst wird geklemmt — ein
   * Stich, der dort nicht hineinpasst, ist kein Weißabgleichsfall mehr.
   */
  function zurueckrechnen(gesamt) {
    var ziel = Math.log(Math.max(gesamt[0], 1e-6) / Math.max(gesamt[2], 1e-6));
    var bestK = BEZUG_KELVIN, bestAbstand = Infinity;
    for (var k = 2000; k <= 14000; k += 25) {
      var v = rohVerstaerkung(k);
      var d = Math.abs(Math.log(v[0] / v[2]) - ziel);
      if (d < bestAbstand) { bestAbstand = d; bestK = k; }
    }

    var roh = rohVerstaerkung(bestK);
    var vr = gesamt[0] / roh[0], vg = gesamt[1] / roh[1], vb = gesamt[2] / roh[2];
    var rel = vg / Math.sqrt(Math.max(vr * vb, 1e-9));
    // (1 − TINT_G·t) / (1 + TINT_RB·t) = rel, nach t aufgelöst
    var t = (1 - rel) / (TINT_G + TINT_RB * rel);

    S.kelvin = Math.round(klemm(bestK, 2000, 14000));
    S.tint = klemm(t, -1, 1);
  }

  // ── Die Nachbearbeitungsstufe ───────────────────────────────────────────

  var FRAGMENT = [
    'uniform sampler2D colorTexture;',
    'uniform vec3 u_farb_gain;',
    'uniform vec4 u_farb_ton;   // x Belichtung, y Kontrast, z Sättigung, w Stärke',
    'in vec2 v_textureCoordinates;',
    '',
    'void main() {',
    '  vec4 quelle = texture(colorTexture, v_textureCoordinates);',
    '',
    '  // Die Stufe sieht Anzeigewerte — die Tonwertabbildung lief davor. Die',
    '  // Kanalverstärkung gehört ins lineare Licht: dort ist sie ein Faktor auf',
    '  // die Lichtmenge, auf den Anzeigewerten wäre sie eine Verbiegung.',
    '  vec3 lin = pow(max(quelle.rgb, 0.0), vec3(2.2));',
    '  lin *= u_farb_gain * u_farb_ton.x;',
    '  vec3 c = pow(max(lin, 0.0), vec3(1.0 / 2.2));',
    '',
    '  c = (c - 0.5) * u_farb_ton.y + 0.5;',
    '  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = mix(vec3(y), c, u_farb_ton.z);',
    '',
    '  out_FragColor = vec4(clamp(mix(quelle.rgb, c, u_farb_ton.w), 0.0, 1.0), quelle.a);',
    '}'
  ].join('\n');

  var stufe = null;

  function stufeHolen() {
    var v = window.BimViewer && BimViewer.viewer;
    if (!v) return null;
    if (stufe && !stufe.isDestroyed()) return stufe;
    try {
      stufe = v.scene.postProcessStages.add(new Cesium.PostProcessStage({
        name: 'ileen_weissabgleich',
        fragmentShader: FRAGMENT,
        uniforms: {
          u_farb_gain: new Cesium.Cartesian3(1, 1, 1),
          u_farb_ton: new Cesium.Cartesian4(1, 1, 1, 1)
        }
      }));
    } catch (e) {
      console.warn('farben.js: Weißabgleichsstufe nicht anlegbar:', e.message);
      stufe = null;
    }
    return stufe;
  }

  /** Wirkt die Korrektur überhaupt, oder steht alles auf neutral? */
  function wirkt() {
    return S.an && S.staerke > 0.001 && (
      Math.abs(S.kelvin - BEZUG_KELVIN) > 1 ||
      Math.abs(S.tint) > 0.001 ||
      Math.abs(S.belichtung - 1) > 0.001 ||
      Math.abs(S.kontrast - 1) > 0.001 ||
      Math.abs(S.saettigung - 1) > 0.001);
  }

  function stufeNachziehen() {
    var st = stufeHolen();
    if (!st) return;
    st.enabled = wirkt();
    if (!st.enabled) return;
    var g = verstaerkung();
    st.uniforms.u_farb_gain = new Cesium.Cartesian3(g[0], g[1], g[2]);
    st.uniforms.u_farb_ton = new Cesium.Cartesian4(
      S.belichtung, S.kontrast, S.saettigung, klemm(S.staerke, 0, 1));
  }

  // ── Träger ──────────────────────────────────────────────────────────────

  /**
   * Die eigenen Modelle. Nur sie bekommen den Materialbaustein: ein Luftbild
   * oder eine Photogrammetrie zu entsättigen hieße, gemessene Farben zu
   * fälschen — bei einem IFC-Material ist es eine Darstellungsentscheidung.
   */
  function traegerModelle() {
    var ziele = [];
    var B = window.BimViewer;
    if (!B || !B.loadedAssets) return ziele;

    B.loadedAssets.forEach(function (asset) {
      var ts = asset.tileset;
      if (ts && !ts._isGaussianSplat && !asset.isPointCloud) ziele.push(ts);
      else if (asset.isGLB && asset.model) ziele.push(asset.model);
    });
    return ziele;
  }

  /** Alles, was eine Umgebungskarte hat — einschließlich der Weltkulisse. */
  function traegerAlle() {
    var ziele = traegerModelle();
    var B = window.BimViewer;
    if (!B) return ziele;
    var LM = window.LayerManager;
    (LM && LM.tilesetLayers || []).forEach(function (e) { if (e.tileset) ziele.push(e.tileset); });
    if (B.googleTiles && B.googleTiles.tileset) ziele.push(B.googleTiles.tileset);
    return ziele;
  }

  // ── Umgebungslicht ──────────────────────────────────────────────────────

  var CESIUM_BODEN = '#717145';

  function umgebungAnwenden() {
    // Jede Zuweisung an den Umgebungskarten-Verwalter wirft die Karte weg und
    // lässt sie neu rechnen. Die Marke verhindert, dass die halbsekündliche
    // Wache das in jedem Durchlauf erneut tut.
    var marke = S.umgebung
      ? ['an', S.umgebungSaettigung, S.umgebungHelligkeit, S.bodenfarbe].join('|')
      : 'aus';

    traegerAlle().forEach(function (t) {
      var m = t.environmentMapManager;
      if (!m || t._ileenFarbmarke === marke) return;
      try {
        if (S.umgebung) {
          m.saturation = S.umgebungSaettigung;
          m.brightness = S.umgebungHelligkeit;
          m.groundColor = Cesium.Color.fromCssColorString(S.bodenfarbe);
        } else {
          m.saturation = 1.0;
          m.brightness = 1.0;
          m.groundColor = (Cesium.DynamicEnvironmentMapManager &&
                           Cesium.DynamicEnvironmentMapManager.AVERAGE_EARTH_GROUND_COLOR) ||
                          Cesium.Color.fromCssColorString(CESIUM_BODEN);
        }
        // Ohne das hier bleibt die Änderung wirkungslos: `groundColor`,
        // `saturation` und `brightness` sind einfache Felder ohne Setzer. Sie
        // werden nur gelesen, wenn die Karte neu gerechnet wird, und das
        // geschieht von selbst erst bei Orts- oder Zeitsprung (Voreinstellung
        // 1000 m bzw. eine Stunde). `reset()` stößt es an.
        if (typeof m.reset === 'function') m.reset();
        else m._shouldReset = true;
        t._ileenFarbmarke = marke;
      } catch (e) { /* Träger ohne Umgebungskarte — nichts zu tun */ }
    });
  }

  // ── Bauteilfarben und Glas ──────────────────────────────────────────────

  var MATERIAL_FRAGMENT = [
    '  // Eigenfarbe neutralisieren. NICHT bloß entsättigen: die Wandmaterialien',
    '  // kommen aus dem IFC als dunkles Braun, und ein entsättigtes Dunkelbraun',
    '  // ist ein dunkles Grau — die Fassade bliebe finster. Stattdessen wird die',
    '  // Eigenfarbe durch einen neutralen Grundton ersetzt und die Textur nur',
    '  // noch als Zeichnung darübergelegt: das Bauteil bekommt seine Helligkeit',
    '  // aus der Typfarbe (Cesium3DTileStyle, features.js), seine Struktur',
    '  // weiterhin aus dem Material.',
    '  if (u_farb_par.z > 0.0) {',
    '    float grau = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));',
    '    float ton = clamp(u_farb_par.w + (grau - u_farb_par.w) * u_farb_zeichnung, 0.0, 1.0);',
    '    material.diffuse = mix(material.diffuse, vec3(ton), u_farb_par.z);',
    '  }',
    '',
    '  // Durchsichtig = Verglasung. Der Materialname taugt nicht als Merkmal',
    '  // (jeder Exporter benennt anders), die Durchsichtigkeit schon.',
    '  if (u_farb_par.y > 0.0 && material.alpha < u_farb_par.x) {',
    '    float hell = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));',
    '    // Die Scheibe behält ihre Hell-Dunkel-Zeichnung und bekommt den',
    '    // vorgegebenen Ton: eine verschattete Scheibe bleibt dunkler als eine',
    '    // besonnte.',
    '    vec3 ziel = u_farb_glas * (0.55 + 0.9 * hell);',
    '    material.diffuse = mix(material.diffuse, ziel, u_farb_par.y);',
    '    // Anthrazit wird die Scheibe erst, wenn der gespiegelte Himmel leiser',
    '    // wird — er ist das eigentlich Blaue am Fenster.',
    '    material.specular = mix(material.specular, material.specular * 0.3, u_farb_par.y);',
    '    material.roughness = mix(material.roughness, max(material.roughness, 0.3), u_farb_par.y);',
    '  }'
  ].join('\n');

  function materialWerte() {
    return new Cesium.Cartesian4(
      klemm(S.glasSchwelle, 0, 1),
      S.glas ? klemm(S.glasAnteil, 0, 1) : 0,
      S.neutralAn ? klemm(S.neutral, 0, 1) : 0,
      klemm(S.grundton, 0, 1));
  }

  function materialBaustein() {
    var c = Cesium.Color.fromCssColorString(S.glasFarbe) ||
            Cesium.Color.fromCssColorString('#3b4044');
    return {
      ordnung: 45,
      uniforms: {
        u_farb_par: { type: Cesium.UniformType.VEC4, value: materialWerte() },
        u_farb_zeichnung: {
          type: Cesium.UniformType.FLOAT,
          value: klemm(S.zeichnung, 0, 1)
        },
        u_farb_glas: {
          type: Cesium.UniformType.VEC3,
          value: new Cesium.Cartesian3(c.red, c.green, c.blue)
        }
      },
      fragment: MATERIAL_FRAGMENT
    };
  }

  function materialGebraucht() {
    var w = materialWerte();
    return w.y > 0.001 || w.z > 0.001;
  }

  function materialAnwenden(nurNeue) {
    var V = window.ShaderVerbund;
    if (!V) return;
    var an = materialGebraucht();

    traegerModelle().forEach(function (t) {
      var laeuft = V.hat(t, 'farben');
      if (!an) { if (laeuft) V.entfernen(t, 'farben'); return; }
      if (nurNeue && laeuft) return;
      // Je Träger ein eigener Baustein — `CustomShader.setUniform()` schreibt
      // in das übergebene Uniform-Objekt zurück, und ein geteiltes Objekt wäre
      // ein stiller Kanal zwischen zwei Modellen (siehe licht.js).
      V.setzen(t, 'farben', materialBaustein());
    });
  }

  function materialNachziehen() {
    var V = window.ShaderVerbund;
    if (!V) return;
    if (!materialGebraucht()) { materialAnwenden(false); return; }

    var b = materialBaustein();
    var fehlt = false;
    traegerModelle().forEach(function (t) {
      if (!V.hat(t, 'farben')) { fehlt = true; return; }
      V.uniform(t, 'u_farb_par', b.uniforms.u_farb_par.value);
      V.uniform(t, 'u_farb_zeichnung', b.uniforms.u_farb_zeichnung.value);
      V.uniform(t, 'u_farb_glas', b.uniforms.u_farb_glas.value);
    });
    if (fehlt) materialAnwenden(true);
  }

  // ── Alles zusammen ──────────────────────────────────────────────────────

  function anwenden(nurNeue) {
    stufeNachziehen();
    umgebungAnwenden();
    materialAnwenden(!!nurNeue);
    var v = window.BimViewer && BimViewer.viewer;
    if (v) v.scene.requestRender();
  }

  function nachziehen() {
    stufeNachziehen();
    umgebungAnwenden();
    materialNachziehen();
    var v = window.BimViewer && BimViewer.viewer;
    if (v) v.scene.requestRender();
  }

  // Nachzüglerwache, wie in licht.js: Modelle kommen nach, die Korrektur soll
  // sie einholen, ohne dass dafür in jedem Bild alle Träger durchgesehen
  // werden. Halbsekündlich reicht — schneller muss ein frisch geladenes Modell
  // seine Farbe nicht bekommen.
  var wache = null, letzte = 0;

  function wacheStarten() {
    var v = window.BimViewer && BimViewer.viewer;
    if (!v || wache) return;
    wache = v.scene.preRender.addEventListener(function () {
      var jetzt = performance.now();
      if (jetzt - letzte < 500) return;
      letzte = jetzt;
      umgebungAnwenden();
      materialAnwenden(true);
    });
  }

  // ── Graupunkt ───────────────────────────────────────────────────────────

  var pipetteLaeuft = false;

  /** Mittelwert eines kleinen Fensters um (x, y) in CSS-Punkten der Leinwand. */
  function bildpunktLesen(x, y) {
    var v = window.BimViewer && BimViewer.viewer;
    if (!v) return null;
    var leinwand = v.canvas;
    var kante = 9;

    // Die Zeichenfläche ist auf HiDPI-Schirmen größer als ihre CSS-Größe.
    var sx = leinwand.width / Math.max(leinwand.clientWidth, 1);
    var sy = leinwand.height / Math.max(leinwand.clientHeight, 1);
    var px = klemm(Math.round(x * sx) - (kante >> 1), 0, Math.max(leinwand.width - kante, 0));
    var py = klemm(Math.round(y * sy) - (kante >> 1), 0, Math.max(leinwand.height - kante, 0));

    try {
      var hilfs = document.createElement('canvas');
      hilfs.width = kante; hilfs.height = kante;
      var ctx = hilfs.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(leinwand, px, py, kante, kante, 0, 0, kante, kante);
      var d = ctx.getImageData(0, 0, kante, kante).data;
      var r = 0, gr = 0, b = 0, n = 0;
      for (var i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; n++; }
      if (!n) return null;
      return [r / n / 255, gr / n / 255, b / n / 255];
    } catch (e) {
      console.warn('farben.js: Bildpunkt nicht lesbar:', e.message);
      return null;
    }
  }

  /**
   * Die gemessene Fläche auf neutral rechnen.
   *
   * Gemessen wird das Bild, wie es dasteht — also mitsamt der Korrektur, die
   * schon läuft. Die neue Verstärkung ist deshalb die alte mal dem, was noch
   * fehlt.
   */
  function graupunktSetzen(mittel) {
    if (!mittel) return false;
    var lin = mittel.map(function (w) { return Math.pow(Math.max(w, 1 / 255), 2.2); });
    var y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    if (!(y > 1e-6)) return false;

    var alt = verstaerkung();
    zurueckrechnen([
      alt[0] * (y / lin[0]),
      alt[1] * (y / lin[1]),
      alt[2] * (y / lin[2])
    ]);
    S.an = true;
    sichern();
    nachziehen();
    return true;
  }

  function pipetteStarten() {
    var v = window.BimViewer && BimViewer.viewer;
    if (!v || pipetteLaeuft) return false;
    pipetteLaeuft = true;
    v.canvas.style.cursor = 'crosshair';
    if (BimViewer.updateStatus) {
      BimViewer.updateStatus('Graupunkt: auf eine Fläche klicken, die neutralgrau sein soll', 'info');
    }

    var abbrechen = function () {
      pipetteLaeuft = false;
      v.canvas.style.cursor = '';
      v.canvas.removeEventListener('click', klick, true);
      document.removeEventListener('keydown', taste, true);
    };

    var klick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      var kasten = v.canvas.getBoundingClientRect();
      var punkt = bildpunktLesen(e.clientX - kasten.left, e.clientY - kasten.top);
      abbrechen();
      var ok = graupunktSetzen(punkt);
      if (BimViewer.updateStatus) {
        BimViewer.updateStatus(ok
          ? 'Weißabgleich gesetzt — ' + Math.round(S.kelvin) + ' K, Tint ' + S.tint.toFixed(2)
          : 'Graupunkt nicht lesbar', ok ? 'success' : 'warning');
      }
      if (window.BimViewerUI && BimViewerUI.farbenAnzeigeAuffrischen) {
        BimViewerUI.farbenAnzeigeAuffrischen();
      }
    };

    var taste = function (e) {
      if (e.key !== 'Escape') return;
      abbrechen();
      if (BimViewer.updateStatus) BimViewer.updateStatus('Graupunkt abgebrochen', 'info');
    };

    // In der Erfassungsphase: die Messwerkzeuge hängen ebenfalls am Klick, und
    // ein Graupunkt soll keine Strecke anfangen.
    v.canvas.addEventListener('click', klick, true);
    document.addEventListener('keydown', taste, true);
    return true;
  }

  // ── Öffentlich ──────────────────────────────────────────────────────────

  var Farben = {

    /** Weißabgleich an/aus. Ohne Argument: umschalten. */
    schalten: function (an) {
      S.an = (an === undefined) ? !S.an : !!an;
      sichern(); nachziehen(); return S.an;
    },

    /** Lichtfarbe im Bild in Kelvin — kleiner Wert = wärmeres Bild = kühlere Korrektur. */
    kelvinSetzen: function (wert) {
      S.kelvin = klemm(parseFloat(wert) || BEZUG_KELVIN, 2000, 14000);
      sichern(); nachziehen(); return S.kelvin;
    },

    /** Grün-Magenta-Ausgleich, −1 … +1. */
    tintSetzen: function (wert) {
      S.tint = klemm(parseFloat(wert) || 0, -1, 1);
      sichern(); nachziehen(); return S.tint;
    },

    belichtungSetzen: function (wert) {
      S.belichtung = klemm(parseFloat(wert) || 1, 0.25, 3);
      sichern(); nachziehen(); return S.belichtung;
    },

    kontrastSetzen: function (wert) {
      S.kontrast = klemm(parseFloat(wert) || 1, 0.5, 2);
      sichern(); nachziehen(); return S.kontrast;
    },

    saettigungSetzen: function (wert) {
      S.saettigung = klemm(parseFloat(wert) || 0, 0, 2);
      sichern(); nachziehen(); return S.saettigung;
    },

    staerkeSetzen: function (wert) {
      S.staerke = klemm(parseFloat(wert) || 0, 0, 1);
      sichern(); nachziehen(); return S.staerke;
    },

    /** Korrektur aus gemessenen Kanalfaktoren setzen (Prüfsteine, MCP). */
    faktorenSetzen: function (rgb) {
      if (!rgb || rgb.length !== 3) return null;
      var y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      if (!(y > 1e-6)) return null;
      zurueckrechnen([rgb[0] / y, rgb[1] / y, rgb[2] / y]);
      sichern(); nachziehen();
      return { kelvin: S.kelvin, tint: S.tint };
    },

    /** Umgebungslicht neutral stellen (Cesiums olive Bodenfarbe ersetzen). */
    umgebungSetzen: function (an) {
      S.umgebung = (an === undefined) ? !S.umgebung : !!an;
      sichern(); nachziehen(); return S.umgebung;
    },

    umgebungSaettigungSetzen: function (wert) {
      S.umgebungSaettigung = klemm(parseFloat(wert) || 0, 0, 1.5);
      sichern(); nachziehen(); return S.umgebungSaettigung;
    },

    bodenfarbeSetzen: function (css) {
      if (typeof css === 'string' && Cesium.Color.fromCssColorString(css)) S.bodenfarbe = css;
      sichern(); nachziehen(); return S.bodenfarbe;
    },

    /**
     * Welches Farbschema die IFC-Typen tragen: 'neutral' oder 'ifc'.
     *
     * Ohne Argument nur abgefragt — core.js `ifcFarbe()` ruft das bei jedem
     * Stilaufbau, es muss also billig und nebenwirkungsfrei sein.
     */
    schema: function (wert) {
      if (wert === undefined) return S.schema;
      S.schema = (wert === 'ifc') ? 'ifc' : 'neutral';
      sichern();
      // Der Stil trägt die Farbe — er muss neu gebaut werden, und die
      // Filterliste zeigt dieselben Farben als Legende.
      try { window.BimViewer && BimViewer.applyIFCFilter && BimViewer.applyIFCFilter(); }
      catch (e) { console.warn('farben.js: Stil nicht neu aufbaubar:', e.message); }
      try { window.IFCFilterPro && IFCFilterPro.renderFilterList && IFCFilterPro.renderFilterList(); }
      catch (e) { /* Panel nicht offen */ }
      nachziehen();
      return S.schema;
    },

    /** Bauteilfarben entsättigen — die beige Fassade wird grau. */
    neutralAnSetzen: function (an) {
      S.neutralAn = (an === undefined) ? !S.neutralAn : !!an;
      sichern(); nachziehen(); return S.neutralAn;
    },

    neutralSetzen: function (wert) {
      S.neutral = klemm(parseFloat(wert) || 0, 0, 1);
      sichern(); nachziehen(); return S.neutral;
    },

    /** Grundton, auf den die Eigenfarbe gezogen wird (Albedo 0–1). */
    grundtonSetzen: function (wert) {
      S.grundton = klemm(parseFloat(wert) || 0, 0, 1);
      sichern(); nachziehen(); return S.grundton;
    },

    /** Wie viel Hell-Dunkel der Textur erhalten bleibt (0–1). */
    zeichnungSetzen: function (wert) {
      S.zeichnung = klemm(parseFloat(wert) || 0, 0, 1);
      sichern(); nachziehen(); return S.zeichnung;
    },

    /** Helligkeit des Umgebungslichts — der Griff gegen dunkle Schattenseiten. */
    umgebungHelligkeitSetzen: function (wert) {
      S.umgebungHelligkeit = klemm(parseFloat(wert) || 0, 0.2, 5);
      sichern(); nachziehen(); return S.umgebungHelligkeit;
    },

    /** Verglasung auf Anthrazit ziehen. */
    glasSetzen: function (an) {
      S.glas = (an === undefined) ? !S.glas : !!an;
      sichern(); nachziehen(); return S.glas;
    },

    glasFarbeSetzen: function (css) {
      if (typeof css === 'string' && Cesium.Color.fromCssColorString(css)) S.glasFarbe = css;
      sichern(); nachziehen(); return S.glasFarbe;
    },

    glasAnteilSetzen: function (wert) {
      S.glasAnteil = klemm(parseFloat(wert) || 0, 0, 1);
      sichern(); nachziehen(); return S.glasAnteil;
    },

    /** Pipette scharf machen — der nächste Klick im Bild setzt den Graupunkt. */
    graupunkt: function () { return pipetteStarten(); },

    /** Graupunkt ohne Klick, in CSS-Punkten der Leinwand (Prüfsteine, MCP). */
    graupunktAn: function (x, y) { return graupunktSetzen(bildpunktLesen(x, y)); },

    /** Zurück auf die Werte, mit denen das Modul ausgeliefert wird. */
    zuruecksetzen: function () {
      Object.keys(VORGABE).forEach(function (k) { S[k] = VORGABE[k]; });
      sichern();
      // Marken löschen, sonst hält die Wache die alten Umgebungswerte fest.
      traegerAlle().forEach(function (t) { t._ileenFarbmarke = null; });
      this.schema(S.schema);
      nachziehen();
      return this.stand();
    },

    /** Alles aus — das unkorrigierte Bild, zum Vergleichen. */
    neutralAus: function () {
      S.an = false; S.umgebung = false; S.neutralAn = false; S.glas = false;
      sichern();
      traegerAlle().forEach(function (t) { t._ileenFarbmarke = null; });
      this.schema('ifc');
      nachziehen();
      return this.stand();
    },

    stand: function () {
      var z = {};
      ZAHLEN.concat(SCHALTER, TEXTE).forEach(function (k) { z[k] = S[k]; });
      z.modelle = traegerModelle().length;
      z.traeger = traegerAlle().length;
      z.wirkt = wirkt();
      return z;
    },

    /** Träger neu einsammeln — nach dem Laden eines Modells. */
    auffrischen: function () { anwenden(true); }
  };

  // ── Anmeldung ───────────────────────────────────────────────────────────

  function start() {
    if (!window.BimViewer || !window.BimViewer.viewer) { setTimeout(start, 300); return; }
    anwenden(false);
    wacheStarten();
  }

  window.BimViewer = window.BimViewer || {};
  BimViewer.Farben = Farben;
  window.Farben = Farben;

  start();

  console.log('✅ Farben bereit — Weißabgleich, Bauteilfarben, Glas');

})();
