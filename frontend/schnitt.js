/**
 * iLEEN — Schnitt: Box, Scheiben und Schnittkarte in einem Werkzeug
 *
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Löst zwei Werkzeuge ab: die drei Achsschnitte (`schnitte-xyz.js`) und die
 * Schnittbox (`section-box.js`), beide nur noch in der Git-Geschichte. Sie waren
 * zwei Antworten auf dieselbe Frage — was vom Bauwerk stehen bleibt — und
 * konnten sich gegenseitig nicht leiden: wer mit der Box an einem Modell
 * arbeitete, dem ließen die Achsschnitte es aus („fremde Ebenen").
 *
 * Jetzt gibt es **eine** Box über alle Modelle, die an sechs Seiten
 * aufgeschnitten wird, und beliebig viele **Scheiben** — senkrechte Streifen
 * mit einer Dicke, wie die Transekte in 3Dtrees.earth. Bedient wird beides auf
 * der **Schnittkarte** (`schnitt-karte.js`): eine Draufsicht der Szene, an
 * deren Rändern man die Box von unten, oben, links und rechts einschiebt,
 * dazu eine Höhenleiste für unten und oben. Im Bild stehen dieselben sechs
 * Griffe wie zuvor an der Schnittbox.
 *
 * ── Warum ein Shader und keine Clipping-Ebenen ───────────────────────────
 *
 * Cesiums `ClippingPlaneCollection` kennt genau zwei Verknüpfungen: „eine
 * Ebene genügt" und „alle Ebenen müssen". Mehrere Scheiben brauchen aber
 * „in der Box UND in irgendeiner Scheibe" — eine Vereinigung von
 * Durchschnitten, die sich mit einer Sammlung nicht ausdrücken lässt. Der
 * Baustein im Shader-Verbund rechnet sie direkt (`SchnittRechnen.innen()`
 * ist dieselbe Rechnung in JavaScript) und bringt drei Dinge mit, die die
 * Ebenen nicht konnten:
 *
 *   · **Schnittflächen.** Eine geschnittene Wand ist innen hohl — Cesium
 *     schließt Schnitte nicht. Durch das Loch sieht man ihre Rückseiten; die
 *     färbt der Baustein dunkel mit einer Schraffur ein, und die Wand wirkt
 *     massiv geschnitten wie im Plan.
 *   · **Kein Streit um `clippingPlanes`.** Aufmaß-Box und Google-Freistellung
 *     behalten ihre Eigenschaft; nichts wird mehr „ausgelassen".
 *   · **Auch Punktwolken und GLB-Kacheln**, sie laufen über denselben
 *     Modell-Renderer.
 *
 * ── Genauigkeit: Augenkoordinaten, auch für fremde Kameras ──────────────
 *
 * Gerechnet wird im Rahmen (ENU im Szenenschwerpunkt, um die Hochachse
 * gedreht). Die Weltlage im Shader in float32 ist auf einen halben Meter
 * genau — wie in `pointcloud.js` geht der Weg deshalb über `positionEC`: die
 * Matrix Auge → Rahmen wird auf der CPU in doppelter Genauigkeit gebildet,
 * ihr Verschiebungsanteil ist nur der Abstand der Kamera zum Rahmen.
 *
 * Anders als dort wird sie nicht je Bild in `preRender` nachgeführt, sondern
 * **beim Zeichnen** gelesen: das Uniform ist ein Getter auf
 * `uniformState.inverseView`. Der Unterschied zählt bei jedem Strahlenpick
 * (`sampleHeight`, `clampToHeight`, das Höhenbild der Karte) — Cesium zeichnet
 * dafür mit einer eigenen, winzigen Kamera, und ein je Bild gesetztes Uniform
 * stünde dort auf der Hauptkamera: der Schnitt säße an der falschen Stelle.
 *
 * ── Rückseiten ───────────────────────────────────────────────────────────
 *
 * IFC-Modelle tragen dauerhaft den Rückseitenschnitt aus core.js (gegen das
 * Z-Fighting doppelseitiger Wände). Solange der Schnitt läuft, übernimmt
 * dieser Baustein dessen Aufgabe: ohne wirksamen Schnitt verwirft er
 * Rückseiten genauso, mit Schnitt färbt er sie als Schnittfläche. Der
 * Rückseitenbaustein wird dafür ab- und beim Beenden wieder angemeldet —
 * nur dort, wo er vorher lief.
 */
'use strict';

(function () {

  if (typeof Cesium === 'undefined' || !window.BimViewer || !window.SchnittRechnen) {
    console.error('❌ schnitt.js: Cesium, BimViewer oder SchnittRechnen fehlen — Ladereihenfolge prüfen');
    return;
  }

  var R = window.SchnittRechnen;

  var NAME = 'schnitt';
  var ZUGABE = 0.5;            // m Luft um die Szene — die Box liegt nie auf einer Modellfläche
  var KANTE = 1.0;             // Meterwürfel um eine angeklickte Stelle
  var KANTE_PX = 1.6;          // Schnittkante in Bildpunkten
  var GRIFF_PIXEL = 11;
  var GRIFF_PIXEL_AKTIV = 16;
  var AKZENT_CSS = '#97BF0D';
  var AKZENT = Cesium.Color.fromCssColorString(AKZENT_CSS);

  // Geschoss als Grundriss: von knapp unter der Rohdecke bis zur üblichen
  // Schnitthöhe. `IfcBuildingStorey.Elevation` ist die Oberkante der
  // Rohdecke; 30 cm darunter liegt die Decke ganz im Bild, die Wände des
  // Geschosses darunter nur als schmaler Rand.
  var UNTER_GESCHOSS = 0.30;
  var SCHNITTHOEHE = 1.20;

  // Höhenbild der Karte: Zellen längs der längeren Seite, Strahlen je Schub.
  var RASTER = 64;
  var SCHUB = 256;
  var STUFEN = [8, 4, 2, 1];

  var Z = {
    an: false,
    wirkt: false,        // es wird tatsächlich etwas weggeschnitten
    rahmen: null,        // { ursprung, yaw, enu, nachEcef, vonEcef, enuVon, carto }
    szene: null,         // { min, max } im Rahmen, mit Zugabe
    enuSzene: null,      // { min, max } im ungedrehten ENU — Grundlage des Höhenbilds
    box: null,           // { min, max } im Rahmen
    scheiben: [],        // [{ id, name, winkel, d, dicke, an }]
    aktiv: null,         // gewählte Scheibe
    naechsteId: 1,
    dicke: 5,            // Dicke für neue Scheiben
    modus: 'innen',      // 'innen' behalten | 'aussen' wegschneiden
    flaechen: true,      // Schnittflächen füllen
    kante: true,         // Schnittkante zeigen
    griffe: true,        // Box samt Griffen im Bild
    schnittanteil: 0.5,  // Lage der Zeichenebene in der Box (Detail)
    quelle: null,        // angeklicktes Bauteil
    waehlt: false,
    laeuft: false,
    ziele: [],           // [{ tileset, rueckseiteVorher, backFaceVorher }]
    probe: false,        // Höhenbild läuft — Strahlenpicks sehen das ganze Modell
    hoehenbild: null,
    geschosse: [],       // [{ name, z }]
    meldung: { text: '', art: '' },
  };

  var zuhoerer = [];
  var hbLauf = 0;

  function szene() { return BimViewer.viewer && BimViewer.viewer.scene; }

  function neuZeichnen() {
    var s = szene();
    if (s) s.requestRender();
  }

  function ue(schluessel, ersatz) {
    var s = (typeof t === 'function') ? t(schluessel) : schluessel;
    return (s === schluessel) ? ersatz : s;
  }

  // ── Rahmen ─────────────────────────────────────────────────────────────

  function rahmenSetzen(ursprung, yaw) {
    var enu = Cesium.Transforms.eastNorthUpToFixedFrame(ursprung);
    var dreh = Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromRotationZ(R.rad(yaw || 0)), Cesium.Cartesian3.ZERO);
    var nach = Cesium.Matrix4.multiply(enu, dreh, new Cesium.Matrix4());
    Z.rahmen = {
      ursprung: Cesium.Cartesian3.clone(ursprung),
      yaw: yaw || 0,
      enu: enu,
      enuVon: Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4()),
      nachEcef: nach,
      vonEcef: Cesium.Matrix4.inverseTransformation(nach, new Cesium.Matrix4()),
      carto: Cesium.Cartographic.fromCartesian(ursprung),
    };
  }

  function inRahmen(ecef) {
    var p = Cesium.Matrix4.multiplyByPoint(Z.rahmen.vonEcef, ecef, new Cesium.Cartesian3());
    return [p.x, p.y, p.z];
  }

  function ausRahmen(x, y, z) {
    return Cesium.Matrix4.multiplyByPoint(
      Z.rahmen.nachEcef, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
  }

  function richtungAusRahmen(x, y, z) {
    var d = Cesium.Matrix4.multiplyByPointAsVector(
      Z.rahmen.nachEcef, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
    return Cesium.Cartesian3.normalize(d, d);
  }

  // ── Szene ──────────────────────────────────────────────────────────────

  function istSplat(ts) {
    if (ts._isGaussianSplat) return true;
    return !!(window.SplatPick && SplatPick.isGaussianTileset && SplatPick.isGaussianTileset(ts));
  }

  /**
   * Alle Modelle, die geschnitten werden können. Gaussian Splats laufen
   * nicht über den Modell-Renderer, ein `customShader` bliebe dort ohne
   * Wirkung — sie aufzunehmen hieße, einen Schnitt zu versprechen, den man
   * nicht bekommt.
   */
  function kandidaten() {
    var liste = [];
    BimViewer.loadedAssets.forEach(function (a) {
      if (a.tileset && !istSplat(a.tileset)) liste.push(a);
    });
    return liste;
  }

  /** Die acht Ecken der Wurzelhülle in ECEF — der Quader, sonst ein Würfel um die Kugel. */
  function eckenEcef(ts) {
    var huelle = ts.root && ts.root.boundingVolume && ts.root.boundingVolume.boundingVolume;
    var ecken = [];
    if (huelle && huelle.halfAxes && huelle.center) {
      var achsen = [0, 1, 2].map(function (i) {
        return Cesium.Matrix3.getColumn(huelle.halfAxes, i, new Cesium.Cartesian3());
      });
      for (var i = 0; i < 8; i++) {
        var p = Cesium.Cartesian3.clone(huelle.center, new Cesium.Cartesian3());
        for (var a = 0; a < 3; a++) {
          var v = Cesium.Cartesian3.multiplyByScalar(achsen[a], (i & (1 << a)) ? 1 : -1, new Cesium.Cartesian3());
          Cesium.Cartesian3.add(p, v, p);
        }
        ecken.push(p);
      }
      return ecken;
    }
    var k = ts.boundingSphere;
    if (!k || !isFinite(k.radius)) return [];
    var enu = Cesium.Transforms.eastNorthUpToFixedFrame(k.center);
    for (var j = 0; j < 8; j++) {
      ecken.push(Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(
        (j & 1 ? 1 : -1) * k.radius, (j & 2 ? 1 : -1) * k.radius, (j & 4 ? 1 : -1) * k.radius),
        new Cesium.Cartesian3()));
    }
    return ecken;
  }

  function huelleIn(ecken, matrix) {
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    ecken.forEach(function (e) {
      var p = Cesium.Matrix4.multiplyByPoint(matrix, e, new Cesium.Cartesian3());
      var q = [p.x, p.y, p.z];
      for (var i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], q[i]);
        max[i] = Math.max(max[i], q[i]);
      }
    });
    return { min: min, max: max };
  }

  function alleEcken() {
    var ecken = [];
    kandidaten().forEach(function (a) { ecken = ecken.concat(eckenEcef(a.tileset)); });
    return ecken;
  }

  /**
   * Ausdehnung der Szene im Rahmen und im ungedrehten ENU neu bestimmen.
   * Stand die Box bisher auf der ganzen Szene, wächst sie mit — ein neu
   * geladenes Modell soll nicht halb abgeschnitten erscheinen, nur weil
   * vorher ein kleineres da war.
   */
  function szeneAktualisieren() {
    var ecken = alleEcken();
    if (!ecken.length || !Z.rahmen) return false;
    var alt = Z.szene;
    var warGanz = Z.box && alt && !R.boxSchneidet(Z.box, alt);
    var h = huelleIn(ecken, Z.rahmen.vonEcef);
    var e = huelleIn(ecken, Z.rahmen.enuVon);
    [h, e].forEach(function (b) {
      for (var i = 0; i < 3; i++) { b.min[i] -= ZUGABE; b.max[i] += ZUGABE; }
    });
    Z.szene = h;
    Z.enuSzene = e;
    if (!Z.box || warGanz) Z.box = { min: h.min.slice(), max: h.max.slice() };
    return true;
  }

  /**
   * Die Richtung der Modellachsen im ENU — Grad, mathematisch positiv.
   *
   * IFC-Modelle aus dem eigenen Backend stehen in einem aufrechten
   * tile-lokalen System, dessen x-Achse die Projektachse ist: genau die, an
   * der man schneiden will. Eine Punktwolke in ECEF-Koordinaten hat keine
   * solche Achse (ihre z-Achse ist die Erdachse); dort nimmt die längste
   * waagerechte Achse des Hüllquaders ihre Stelle ein.
   */
  function modellYaw(ts, enuVon) {
    var m = ts.root && ts.root.computedTransform;
    if (m) {
      var z = Cesium.Matrix4.multiplyByPointAsVector(enuVon,
        Cesium.Matrix4.multiplyByPointAsVector(m, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3()),
        new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(z, z);
      if (z.z > 0.99) {
        var x = Cesium.Matrix4.multiplyByPointAsVector(enuVon,
          Cesium.Matrix4.multiplyByPointAsVector(m, Cesium.Cartesian3.UNIT_X, new Cesium.Cartesian3()),
          new Cesium.Cartesian3());
        return R.grad(Math.atan2(x.y, x.x));
      }
    }
    var huelle = ts.root && ts.root.boundingVolume && ts.root.boundingVolume.boundingVolume;
    if (huelle && huelle.halfAxes) {
      var beste = null, laenge = 0;
      for (var i = 0; i < 3; i++) {
        var a = Cesium.Matrix4.multiplyByPointAsVector(enuVon,
          Cesium.Matrix3.getColumn(huelle.halfAxes, i, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        var waagerecht = Math.hypot(a.x, a.y);
        if (waagerecht > laenge && Math.abs(a.z) < waagerecht) { laenge = waagerecht; beste = a; }
      }
      if (beste) return R.grad(Math.atan2(beste.y, beste.x));
    }
    return null;
  }

  /**
   * Ein Rechteck hat vier gleichwertige Achsrichtungen. Von ihnen die, die
   * Norden am nächsten liegt — die Karte soll sich nicht auf den Kopf
   * stellen, nur weil die Projektachse zufällig nach Süden zeigt.
   */
  function nordnah(yaw) {
    var w = ((yaw % 90) + 90) % 90;
    return w > 45 ? w - 90 : w;
  }

  function groesstesModell() {
    var beste = null, r = -1;
    kandidaten().forEach(function (a) {
      var k = a.tileset.boundingSphere;
      if (k && k.radius > r) { r = k.radius; beste = a; }
    });
    return beste;
  }

  /**
   * Nullpunkt, Drehung und Ausdehnung neu aus der Szene nehmen. Die Box
   * steht danach auf der ganzen Szene, alle Scheiben sind fort — ein alter
   * Meterwert bezöge sich auf einen Nullpunkt, den es nicht mehr gibt.
   */
  function einpassen(still) {
    var ecken = alleEcken();
    if (!ecken.length) {
      if (!still) melde(ue('schnitt.keinModell', 'Kein schneidbares Modell geladen.'), 'warn');
      return false;
    }
    var kugel = Cesium.BoundingSphere.fromPoints(ecken);
    rahmenSetzen(kugel.center, 0);
    var gross = groesstesModell();
    var yaw = gross ? modellYaw(gross.tileset, Z.rahmen.enuVon) : null;
    if (yaw !== null && Math.abs(nordnah(yaw)) > 0.05) rahmenSetzen(kugel.center, nordnah(yaw));
    Z.szene = null;
    Z.box = null;
    Z.scheiben = [];
    Z.aktiv = null;
    szeneAktualisieren();
    Z.hoehenbild = null;
    if (Z.an) {
      hoehenbildAufnehmen();
      geschosseLaden();
    }
    stand('einpassen');
    return true;
  }

  /**
   * Den Rahmen drehen. Box und Scheiben drehen mit — sie sind im Rahmen
   * definiert. Die Box wird auf die gedrehte Szene zurückgesetzt, wenn sie
   * vorher ganz war; sonst bleibt sie, was sie war, nur in neuer Lage.
   */
  function setYaw(grad) {
    if (!Z.rahmen) return;
    var warGanz = Z.box && Z.szene && !R.boxSchneidet(Z.box, Z.szene);
    rahmenSetzen(Z.rahmen.ursprung, R.winkelNorm(parseFloat(grad) || 0));
    if (warGanz) Z.box = null;
    Z.szene = null;
    szeneAktualisieren();
    geschosseUmrechnen();
    stand('drehung');
  }

  function amModellAusrichten() {
    var gross = (Z.quelle && Z.quelle.tileset && { tileset: Z.quelle.tileset }) || groesstesModell();
    if (!gross || !Z.rahmen) return;
    var yaw = modellYaw(gross.tileset, Z.rahmen.enuVon);
    if (yaw === null) {
      melde(ue('schnitt.keineAchse', 'Dieses Modell hat keine erkennbare Achsrichtung.'), 'warn');
      return;
    }
    setYaw(nordnah(yaw));
  }

  // ── Der Baustein ───────────────────────────────────────────────────────

  function linear(c) {
    // Material- und Emissionsfarben rechnet Cesium im linearen Farbraum.
    return Math.pow(c, 2.2);
  }

  var U = {
    auge: new Cesium.Matrix4(),
    min: new Cesium.Cartesian3(-1e7, -1e7, -1e7),
    max: new Cesium.Cartesian3(1e7, 1e7, 1e7),
    art: new Cesium.Cartesian4(2, 1, 1, KANTE_PX),
    zahl: 0,
    s: [],
    kfarbe: new Cesium.Cartesian3(linear(AKZENT.red), linear(AKZENT.green), linear(AKZENT.blue)),
  };
  for (var si = 0; si < R.MAX_SCHEIBEN; si++) U.s.push(new Cesium.Cartesian4(1, 0, 0, 0));

  /**
   * Auge → Rahmen, zur Zeichenzeit aus der Kamera gebildet, mit der Cesium
   * gerade zeichnet — Hauptbild oder Strahlenpick.
   */
  function augeNachRahmen() {
    var s = szene();
    if (!s || !Z.rahmen) return Cesium.Matrix4.IDENTITY;
    return Cesium.Matrix4.multiply(Z.rahmen.vonEcef, s.context.uniformState.inverseView, U.auge);
  }

  /**
   * x: 0 innen behalten, 1 innen weg, 2 Ruhe (nur Rückseiten wie bisher)
   * y: Schnittflächen füllen · z: Schnittkante · w: Kantenbreite in Pixeln
   *
   * Solange das Höhenbild der Karte aufgenommen wird, sehen die Strahlenpicks
   * das ungeschnittene Modell: die Karte zeigt die Szene, nicht den Schnitt.
   * Erkannt wird der Strahlenpick an der eigenen Ansicht, mit der Cesium dafür
   * zeichnet — das Hauptbild bleibt geschnitten.
   */
  function art() {
    var s = szene();
    var probe = Z.probe && s && s.view !== s.defaultView;
    U.art.x = (!Z.wirkt || probe) ? 2 : (Z.modus === 'aussen' ? 1 : 0);
    U.art.y = Z.flaechen ? 1 : 0;
    U.art.z = Z.kante ? 1 : 0;
    return U.art;
  }

  /**
   * Uniform mit Getter. Der Verbund schreibt Werte in die Definition zurück
   * (`ShaderVerbund.uniform`); hier gibt es nichts zu merken — der Zustand
   * dieses Moduls ist die Wahrheit, gelesen wird er beim Zeichnen.
   */
  function lesend(typ, holen) {
    return {
      type: typ,
      get value() { return holen(); },
      set value(v) { /* bewusst leer */ },
    };
  }

  var UNIFORMS = (function () {
    var T = Cesium.UniformType;
    var u = {
      u_sn_auge: lesend(T.MAT4, augeNachRahmen),
      u_sn_min: lesend(T.VEC3, function () { return U.min; }),
      u_sn_max: lesend(T.VEC3, function () { return U.max; }),
      u_sn_art: lesend(T.VEC4, art),
      u_sn_zahl: lesend(T.FLOAT, function () { return U.zahl; }),
      u_sn_kfarbe: lesend(T.VEC3, function () { return U.kfarbe; }),
    };
    U.s.forEach(function (v, i) {
      u['u_sn_s' + i] = lesend(T.VEC4, function () { return U.s[i]; });
    });
    return u;
  })();

  function farbeSetzen(ausdruck) {
    // Unbeleuchtet: die Schnittfläche ist eine Markierung, kein Werkstoff.
    // Im PBR-Weg über `emissive`, sonst gäbe die Beleuchtung derselben
    // Fläche je nach Blickwinkel eine andere Helligkeit.
    return [
      '#ifdef LIGHTING_UNLIT',
      '        material.diffuse = ' + ausdruck + ';',
      '#else',
      '        material.diffuse = vec3(0.0);',
      '        material.specular = vec3(0.0);',
      '        material.emissive = ' + ausdruck + ';',
      '#endif',
    ].join('\n');
  }

  /**
   * GLSL des Bausteins. `rueckschnitt`: ob der Träger vorher den
   * Rückseitenschnitt aus core.js hatte — in Ruhe tut der Baustein dann
   * genau dasselbe. Als Konstante im Quelltext, weil es je Träger feststeht.
   */
  function fragment(rueckschnitt) {
    var scheiben = [];
    for (var i = 0; i < R.MAX_SCHEIBEN; i++) {
      scheiben.push('        if (u_sn_zahl > ' + i + '.5) s = max(s, u_sn_s' + i +
        '.w - abs(dot(u_sn_s' + i + '.xy, p.xy) - u_sn_s' + i + '.z));');
    }
    return [
      '    bool rueck = czm_backFacing();',
      '    if (u_sn_art.x > 1.5) {',
      rueckschnitt ? '      if (rueck) discard;' : '',
      '    } else {',
      '      vec3 p = (u_sn_auge * vec4(fsInput.attributes.positionEC, 1.0)).xyz;',
      '      vec3 a = p - u_sn_min;',
      '      vec3 b = u_sn_max - p;',
      '      float innen = min(min(min(a.x, a.y), a.z), min(min(b.x, b.y), b.z));',
      '      if (u_sn_zahl > 0.5) {',
      '        float s = -1.0e9;',
      scheiben.join('\n'),
      '        innen = min(innen, s);',
      '      }',
      '      float rand = innen;',
      '      if (u_sn_art.x > 0.5) {',
      '        if (innen >= 0.0) discard;',
      '        rand = -innen;',
      '      } else if (innen < 0.0) {',
      '        discard;',
      '      }',
      '      if (rueck) {',
      '        if (u_sn_art.y < 0.5) discard;',
      // Die Schnittfläche: die eigene Farbe des Bauteils, abgedunkelt, mit
      // einer Schraffur im Bildraum — Werkstoffe bleiben unterscheidbar, und
      // die Fläche liest sich als geschnitten, nicht als Wand.
      '        vec3 grund = clamp(material.baseColor.rgb, 0.0, 1.0) * 0.32;',
      '        float strich = step(mod(gl_FragCoord.x - gl_FragCoord.y, 7.0), 1.1);',
      '        vec3 flaeche = mix(grund, grund + u_sn_kfarbe * 0.35, strich);',
      farbeSetzen('flaeche'),
      '      } else if (u_sn_art.z > 0.5 && rand < fwidth(rand) * u_sn_art.w) {',
      farbeSetzen('u_sn_kfarbe'),
      '      }',
      '    }',
    ].join('\n');
  }

  var BAUSTEINE = {};
  function baustein(rueckschnitt) {
    var k = rueckschnitt ? 'mit' : 'ohne';
    if (!BAUSTEINE[k]) {
      // Vor allem anderen: was verworfen wird, braucht keine Farbe mehr.
      BAUSTEINE[k] = { ordnung: -10, uniforms: UNIFORMS, fragment: fragment(rueckschnitt) };
    }
    return BAUSTEINE[k];
  }

  /** Den Zustand in die Uniform-Werte übertragen. */
  function uniformsStand() {
    if (Z.box) {
      U.min.x = Z.box.min[0]; U.min.y = Z.box.min[1]; U.min.z = Z.box.min[2];
      U.max.x = Z.box.max[0]; U.max.y = Z.box.max[1]; U.max.z = Z.box.max[2];
    }
    var liste = R.wirksameScheiben(Z.scheiben);
    U.zahl = liste.length;
    liste.forEach(function (s, i) {
      var n = R.normale(s);
      U.s[i].x = n[0]; U.s[i].y = n[1]; U.s[i].z = s.d; U.s[i].w = s.dicke / 2;
    });
  }

  /** Grundriss jedes Modells als konvexe Hülle seiner Hüllquader-Ecken — für die Karte. */
  function umrisse() {
    if (!Z.rahmen) return [];
    return kandidaten().map(function (a) {
      var punkte = eckenEcef(a.tileset).map(function (e) { return inRahmen(e); });
      return konvexeHuelle(punkte);
    }).filter(function (p) { return p.length > 2; });
  }

  /** Andrew's monotone chain im Grundriss. */
  function konvexeHuelle(punkte) {
    var p = punkte.map(function (q) { return [q[0], q[1]]; })
      .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (p.length < 3) return p;
    function kreuz(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var unten = [], oben = [];
    p.forEach(function (q) {
      while (unten.length >= 2 && kreuz(unten[unten.length - 2], unten[unten.length - 1], q) <= 0) unten.pop();
      unten.push(q);
    });
    p.slice().reverse().forEach(function (q) {
      while (oben.length >= 2 && kreuz(oben[oben.length - 2], oben[oben.length - 1], q) <= 0) oben.pop();
      oben.push(q);
    });
    return unten.slice(0, -1).concat(oben.slice(0, -1));
  }

  // ── Ziele ──────────────────────────────────────────────────────────────

  function zielAnmelden(ts) {
    var V = BimViewer.ShaderVerbund;
    if (!V || Z.ziele.some(function (z) { return z.tileset === ts; })) return;
    var ziel = { tileset: ts, rueckseiteVorher: V.hat(ts, 'rueckseite'), backFaceVorher: ts.backFaceCulling };
    try {
      if (ziel.rueckseiteVorher) V.entfernen(ts, 'rueckseite');
      ts.backFaceCulling = false;
      V.setzen(ts, NAME, baustein(ziel.rueckseiteVorher));
    } catch (e) {
      console.warn('schnitt: Modell nicht schneidbar', e);
      return;
    }
    Z.ziele.push(ziel);
  }

  function zielAbmelden(ziel) {
    var V = BimViewer.ShaderVerbund;
    try {
      if (V) V.entfernen(ziel.tileset, NAME);
      if (ziel.rueckseiteVorher && typeof BimViewer.applyBackFaceCulling === 'function') {
        BimViewer.applyBackFaceCulling(ziel.tileset);
      }
      ziel.tileset.backFaceCulling = ziel.backFaceVorher;
    } catch (e) { /* Tileset schon entladen */ }
  }

  /** Neue Modelle aufnehmen, entladene vergessen. */
  function zieleAbgleichen() {
    var da = kandidaten().map(function (a) { return a.tileset; });
    Z.ziele = Z.ziele.filter(function (z) {
      var bleibt = da.indexOf(z.tileset) >= 0 && !z.tileset.isDestroyed();
      return bleibt;
    });
    if (Z.an) da.forEach(zielAnmelden);
  }

  // ── Zustand anwenden ───────────────────────────────────────────────────

  function stand(was) {
    uniformsStand();
    Z.wirkt = Z.an && R.wirksam(Z.box, Z.szene, Z.scheiben, Z.modus);
    griffeSichtbar();
    neuZeichnen();
    melden(was);
  }

  function melden(was) {
    zuhoerer.slice().forEach(function (fn) {
      try { fn(was, Z); } catch (e) { console.warn('schnitt: Zuhörer', e); }
    });
  }

  function melde(text, art) {
    Z.meldung = { text: text || '', art: art || '' };
    melden('meldung');
  }

  // ── Ein- und ausschalten ───────────────────────────────────────────────

  function starten() {
    if (Z.an) return true;
    if (!BimViewer.ShaderVerbund || !Cesium.CustomShader) {
      melde(ue('schnitt.keinShader', 'Diese Cesium-Fassung kann keine Schnitte im Shader.'), 'warn');
      return false;
    }
    if (!Z.rahmen) {
      if (!einpassen(false)) return false;
    } else if (!szeneAktualisieren()) {
      melde(ue('schnitt.keinModell', 'Kein schneidbares Modell geladen.'), 'warn');
      return false;
    }
    Z.an = true;
    zieleAbgleichen();
    griffeAnlegen();
    ziehenInstallieren();
    stand('an');
    melde(Z.ziele.length + ' ' + ue('schnitt.modelle', 'Modell(e) im Schnitt') +
      (kandidaten().length < BimViewer.loadedAssets.size
        ? ' · ' + ue('schnitt.splatsAussen', 'Gaussian Splats bleiben ungeschnitten') : ''), '');
    if (!Z.hoehenbild) hoehenbildAufnehmen();
    geschosseLaden();
    return true;
  }

  function beenden() {
    if (!Z.an) return;
    auswahlBeenden();
    Z.an = false;
    hbLauf++;
    Z.probe = false;
    Z.ziele.forEach(zielAbmelden);
    Z.ziele = [];
    griffeWeg();
    if (ziehHandler) { ziehHandler.destroy(); ziehHandler = null; }
    stand('aus');
    melde(ue('schnitt.aus', 'Schnitt aus — Box und Scheiben bleiben für das nächste Mal stehen.'), '');
  }

  // ── Box ────────────────────────────────────────────────────────────────

  var ACHSE = { x: 0, y: 1, z: 2 };

  /** Eine Boxseite setzen, begrenzt auf die Szene und die Gegenseite. */
  function setGrenze(achse, seite, wert) {
    var i = typeof achse === 'number' ? achse : ACHSE[achse];
    if (!Z.box || i === undefined || !isFinite(wert)) return;
    var s = Z.szene;
    if (seite === 'min') {
      Z.box.min[i] = Math.max(s ? s.min[i] : -Infinity, Math.min(wert, Z.box.max[i] - R.MINDEST));
    } else {
      Z.box.max[i] = Math.min(s ? s.max[i] : Infinity, Math.max(wert, Z.box.min[i] + R.MINDEST));
    }
    stand('box');
  }

  function setBox(min, max) {
    if (!Z.szene) return;
    Z.box = { min: min.slice(), max: max.slice() };
    for (var i = 0; i < 3; i++) {
      Z.box.min[i] = Math.max(Z.szene.min[i], Math.min(Z.box.min[i], Z.szene.max[i] - R.MINDEST));
      Z.box.max[i] = Math.min(Z.szene.max[i], Math.max(Z.box.max[i], Z.box.min[i] + R.MINDEST));
    }
    stand('box');
  }

  /** Die Box zurück auf die ganze Szene — Scheiben bleiben. */
  function ganz() {
    if (!Z.szene) return;
    Z.box = { min: Z.szene.min.slice(), max: Z.szene.max.slice() };
    stand('box');
  }

  function setModus(modus) {
    if (modus !== 'innen' && modus !== 'aussen') return;
    Z.modus = modus;
    stand('modus');
  }

  function setFlaechen(an) { Z.flaechen = !!an; stand('darstellung'); }
  function setKante(an) { Z.kante = !!an; stand('darstellung'); }
  function setGriffe(an) { Z.griffe = !!an; stand('darstellung'); }
  function setSchnittanteil(w) {
    Z.schnittanteil = Math.min(1, Math.max(0, parseFloat(w) || 0));
    melden('anteil');
  }

  // ── Scheiben ───────────────────────────────────────────────────────────

  function scheibe(id) {
    return Z.scheiben.filter(function (s) { return s.id === id; })[0] || null;
  }

  /**
   * Eine Scheibe anlegen: 'x' oder 'y' durch die Boxmitte, oder eine fertige
   * `{ winkel, d, dicke }` (von der gezogenen Linie).
   */
  function scheibeNeu(art) {
    if (!Z.box) return null;
    if (R.wirksameScheiben(Z.scheiben).length >= R.MAX_SCHEIBEN) {
      melde(ue('schnitt.zuViele', 'Mehr als acht Scheiben trägt der Shader nicht.'), 'warn');
      return null;
    }
    var roh = (art === 'x' || art === 'y') ? R.achsScheibe(art, Z.box, Z.dicke) : art;
    if (!roh) return null;
    var s = {
      id: Z.naechsteId++, name: R.freierName(Z.scheiben),
      winkel: R.winkelNorm(roh.winkel), d: roh.d, dicke: Math.max(R.MINDEST, roh.dicke), an: true,
    };
    Z.scheiben.push(s);
    Z.aktiv = s.id;
    stand('scheiben');
    return s;
  }

  function scheibeSetzen(id, werte) {
    var s = scheibe(id);
    if (!s) return;
    if (werte.winkel !== undefined) s.winkel = R.winkelNorm(werte.winkel);
    if (werte.d !== undefined && isFinite(werte.d)) s.d = werte.d;
    if (werte.dicke !== undefined) s.dicke = Math.max(R.MINDEST, werte.dicke);
    if (werte.an !== undefined) s.an = !!werte.an;
    stand('scheiben');
  }

  function scheibeWeg(id) {
    Z.scheiben = Z.scheiben.filter(function (s) { return s.id !== id; });
    if (Z.aktiv === id) Z.aktiv = Z.scheiben.length ? Z.scheiben[Z.scheiben.length - 1].id : null;
    stand('scheiben');
  }

  function scheibeWaehlen(id) {
    Z.aktiv = scheibe(id) ? id : null;
    melden('auswahl');
  }

  /** Dicke der gewählten Scheibe — und die Vorgabe für die nächste. */
  function setDicke(meter) {
    var m = parseFloat(meter);
    if (!(m > 0)) return;
    Z.dicke = m;
    var s = scheibe(Z.aktiv);
    if (s) scheibeSetzen(s.id, { dicke: m });
    else melden('dicke');
  }

  // ── Geschosse ──────────────────────────────────────────────────────────

  var geschossRoh = [];   // [{ name, ecef }] — unabhängig von der Rahmendrehung

  async function geschosseLaden() {
    var E = BimViewer.Explosion;
    if (!E || typeof E._geschosseFuer !== 'function' || typeof E._hoehenspanne !== 'function') return;
    var roh = [];
    var modelle = kandidaten().filter(function (a) { return a.jobId; });
    for (var i = 0; i < modelle.length; i++) {
      var a = modelle[i];
      var gruppen = null, spanne = null;
      try {
        gruppen = await E._geschosseFuer(a);
        spanne = E._hoehenspanne(a.tileset);
      } catch (e) { /* ohne Verzeichnis */ }
      if (!gruppen || !spanne || !a.tileset.root) continue;
      gruppen.forEach(function (g) {
        roh.push({
          name: g.namen.join(' / '),
          ecef: Cesium.Matrix4.multiplyByPoint(a.tileset.root.computedTransform,
            new Cesium.Cartesian3(0, 0, spanne.unten + g.hoehe), new Cesium.Cartesian3()),
        });
      });
    }
    geschossRoh = roh;
    geschosseUmrechnen();
  }

  function geschosseUmrechnen() {
    if (!Z.rahmen) return;
    var liste = geschossRoh
      .map(function (g) { return { name: g.name, z: inRahmen(g.ecef)[2] }; })
      .sort(function (a, b) { return a.z - b.z; });
    // Zwei Modelle mit demselben Geschoss (Architektur und Tragwerk) sollen
    // eine Marke ergeben, nicht zwei übereinander.
    var zusammen = [];
    liste.forEach(function (g) {
      var letzte = zusammen[zusammen.length - 1];
      if (letzte && g.z - letzte.z < 0.3) {
        if (letzte.name.split(' / ').indexOf(g.name) < 0) letzte.name += ' / ' + g.name;
      } else {
        zusammen.push({ name: g.name, z: g.z });
      }
    });
    Z.geschosse = zusammen;
    melden('geschosse');
  }

  /** Die Box auf ein Geschoss stellen — als Grundriss, von unter der Decke bis zur Schnitthöhe. */
  function geschoss(i) {
    var g = Z.geschosse[i];
    if (!g || !Z.box) return;
    Z.box.min[2] = Math.max(Z.szene.min[2], g.z - UNTER_GESCHOSS);
    Z.box.max[2] = Math.min(Z.szene.max[2], g.z + SCHNITTHOEHE);
    stand('box');
    melde(ue('schnitt.geschoss', 'Grundriss') + ' ' + g.name + ' — ' +
      SCHNITTHOEHE.toFixed(2).replace('.', ',') + ' m ' + ue('schnitt.ueberRohdecke', 'über Rohdecke'), '');
  }

  // ── Höhenbild der Karte ────────────────────────────────────────────────

  /** Tilesets, die nicht geschnitten werden — die Strahlen sollen durch sie hindurchsehen. */
  function fremdeTilesets() {
    var eigene = kandidaten().map(function (a) { return a.tileset; });
    var fremd = [];
    var prims = szene().primitives;
    (function sammeln(liste) {
      for (var i = 0; i < liste.length; i++) {
        var p = liste.get(i);
        if (p && p.isCesium3DTileset && eigene.indexOf(p) < 0) fremd.push(p);
        else if (p instanceof Cesium.PrimitiveCollection) sammeln(p);
      }
    })(prims);
    return fremd;
  }

  /**
   * Die Szene von oben abtasten: ein Strahl je Zelle, senkrecht nach unten,
   * vom höchsten Punkt der Szene aus. Grob nach fein (8, 4, 2, 1 Zellen
   * Abstand), damit die Karte sofort etwas zeigt und sich dann schärft.
   *
   * `pickFromRayMostDetailed` lädt die Kacheln entlang des Strahls in voller
   * Auflösung nach — unabhängig davon, wohin die Kamera gerade schaut. Das
   * einfache `sampleHeight` sähe nur, was im Bild liegt.
   *
   * Treffer ohne Objekt sind Gelände (der Globus liefert keins), Treffer auf
   * einer Entity sind Beschriftungen anderer Werkzeuge — beides zählt nicht.
   */
  async function hoehenbildAufnehmen() {
    var s = szene();
    if (!s || !Z.enuSzene || typeof s.pickFromRayMostDetailed !== 'function') return;
    var lauf = ++hbLauf;
    var e = Z.enuSzene;
    var bx = e.max[0] - e.min[0], by = e.max[1] - e.min[1];
    var zelle = Math.max(bx, by) / RASTER;
    var spalten = Math.max(1, Math.ceil(bx / zelle));
    var zeilen = Math.max(1, Math.ceil(by / zelle));
    var hb = {
      spalten: spalten, zeilen: zeilen, zelle: zelle, min: [e.min[0], e.min[1]],
      werte: new Float32Array(spalten * zeilen).fill(NaN),
      stufe: new Uint8Array(spalten * zeilen),
      fertig: false, anteil: 0, dauer: 0,
    };
    Z.hoehenbild = hb;

    var auftraege = [];
    var belegt = new Uint8Array(spalten * zeilen);
    STUFEN.forEach(function (st) {
      for (var j = 0; j < zeilen; j += st) {
        for (var i = 0; i < spalten; i += st) {
          var k = j * spalten + i;
          if (belegt[k]) continue;
          belegt[k] = 1;
          auftraege.push({ i: i, j: j, k: k, stufe: st });
        }
      }
    });

    var enu = Z.rahmen.enu;
    var runter = Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(0, 0, -1), new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(runter, runter);
    var oben = e.max[2] + 2;
    var fremd = fremdeTilesets();
    var start = performance.now();

    Z.probe = true;
    melden('hoehenbild');
    try {
      for (var n = 0; n < auftraege.length; n += SCHUB) {
        if (lauf !== hbLauf || !Z.an) return;
        var teil = auftraege.slice(n, n + SCHUB);
        var ergebnisse = await Promise.all(teil.map(function (a) {
          var x = hb.min[0] + (a.i + 0.5) * zelle;
          var y = hb.min[1] + (a.j + 0.5) * zelle;
          var von = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(x, y, oben), new Cesium.Cartesian3());
          var strahl = new Cesium.Ray(von, runter);
          return s.pickFromRayMostDetailed(strahl, fremd, Math.min(zelle, 1.0))
            .catch(function () { return undefined; });
        }));
        if (lauf !== hbLauf) return;
        ergebnisse.forEach(function (r, m) {
          var a = teil[m];
          hb.stufe[a.k] = a.stufe;
          if (r && r.object && r.position && !(r.object.id instanceof Cesium.Entity)) {
            hb.werte[a.k] = inRahmen(r.position)[2];
          }
        });
        hb.anteil = Math.min(1, (n + teil.length) / auftraege.length);
        melden('hoehenbild');
        neuZeichnen();
      }
      hb.fertig = true;
      hb.dauer = performance.now() - start;
      melden('hoehenbild');
    } finally {
      if (lauf === hbLauf) Z.probe = false;
    }
  }

  // ── Griffe im Bild ─────────────────────────────────────────────────────

  var FLAECHEN = [
    { achse: 0, seite: 'min' }, { achse: 0, seite: 'max' },
    { achse: 1, seite: 'min' }, { achse: 1, seite: 'max' },
    { achse: 2, seite: 'min' }, { achse: 2, seite: 'max' },
  ];
  var KANTEN = [
    [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  var entities = [];
  var aktiverGriff = null;
  var ziehHandler = null;
  var griffZug = false;

  function boxEcken() {
    var b = Z.box, ecken = [];
    for (var i = 0; i < 8; i++) {
      ecken.push(ausRahmen(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]));
    }
    return ecken;
  }

  function flaechenMitte(f) {
    var b = Z.box;
    var p = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    p[f.achse] = b[f.seite][f.achse];
    return ausRahmen(p[0], p[1], p[2]);
  }

  /**
   * Rahmen und sechs Flächengriffe — dieselben wie zuvor an der Schnittbox:
   * Punkte in fester Pixelgröße (eine Kugel in Weltgröße wäre an einer
   * Stütze größer als das Bauteil), eine Farbe für alle, weiß unter der Maus,
   * vor der Geometrie gezeichnet, damit auch die abgewandte Seite greifbar ist.
   */
  function griffeAnlegen() {
    var v = BimViewer.viewer;
    if (!v || entities.length) return;
    entities.push(v.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(function () {
          if (!Z.box || !Z.rahmen) return [];
          var e = boxEcken(), punkte = [];
          KANTEN.forEach(function (k) { punkte.push(e[k[0]], e[k[1]]); });
          return punkte;
        }, false),
        width: 1.5,
        material: new Cesium.PolylineDashMaterialProperty({ color: AKZENT.withAlpha(0.85), dashLength: 10 }),
        arcType: Cesium.ArcType.NONE,
      },
    }));
    FLAECHEN.forEach(function (f) {
      var entity = v.entities.add({
        position: new Cesium.CallbackProperty(function () {
          return (Z.box && Z.rahmen) ? flaechenMitte(f) : Cesium.Cartesian3.ZERO;
        }, false),
        point: {
          pixelSize: new Cesium.CallbackProperty(function () {
            return aktiverGriff === f ? GRIFF_PIXEL_AKTIV : GRIFF_PIXEL;
          }, false),
          color: new Cesium.CallbackProperty(function () {
            return aktiverGriff === f ? Cesium.Color.WHITE : AKZENT;
          }, false),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entity._schnittFlaeche = f;
      entities.push(entity);
    });
    griffeSichtbar();
  }

  function griffeSichtbar() {
    var zeigen = Z.an && Z.griffe && !!Z.box;
    entities.forEach(function (e) { e.show = zeigen; });
  }

  function griffeWeg() {
    var v = BimViewer.viewer;
    entities.forEach(function (e) { try { v.entities.remove(e); } catch (err) { /* fort */ } });
    entities = [];
    aktiverGriff = null;
  }

  /** Parameter entlang (p0, d0), an dem die Achse dem Mausstrahl am nächsten kommt. */
  function aufAchse(p0, d0, p1, d1) {
    var w = Cesium.Cartesian3.subtract(p0, p1, new Cesium.Cartesian3());
    var a = Cesium.Cartesian3.dot(d0, d0), b = Cesium.Cartesian3.dot(d0, d1);
    var c = Cesium.Cartesian3.dot(d1, d1), d = Cesium.Cartesian3.dot(d0, w);
    var e = Cesium.Cartesian3.dot(d1, w);
    var nenner = a * c - b * b;
    if (Math.abs(nenner) < 1e-9) return null;
    return (b * e - c * d) / nenner;
  }

  function ziehenInstallieren() {
    if (ziehHandler || !BimViewer.viewer) return;
    var s = szene();
    var handler = new Cesium.ScreenSpaceEventHandler(s.canvas);
    ziehHandler = handler;
    var zug = null;

    handler.setInputAction(function (e) {
      if (!Z.an || !Z.griffe || !Z.box) return;
      var getroffen = s.pick(e.position);
      var f = getroffen && getroffen.id && getroffen.id._schnittFlaeche;
      if (!f) return;
      s.screenSpaceCameraController.enableInputs = false;
      aktiverGriff = f;
      griffZug = true;
      var lokal = [0, 0, 0];
      lokal[f.achse] = 1;
      zug = {
        f: f,
        achse: richtungAusRahmen(lokal[0], lokal[1], lokal[2]),
        start: flaechenMitte(f),
        wert: Z.box[f.seite][f.achse],
      };
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction(function (e) {
      if (!Z.an || !Z.box) return;
      if (!zug) {
        if (!Z.griffe) return;
        var unter = s.pick(e.endPosition);
        var f = unter && unter.id && unter.id._schnittFlaeche;
        if ((f || null) !== aktiverGriff) { aktiverGriff = f || null; neuZeichnen(); }
        return;
      }
      var strahl = s.camera.getPickRay(e.endPosition);
      if (!strahl) return;
      var t = aufAchse(zug.start, zug.achse, strahl.origin, strahl.direction);
      if (t === null) return;
      setGrenze(zug.f.achse, zug.f.seite, zug.wert + t);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction(function () {
      if (!zug) return;
      zug = null;
      aktiverGriff = null;
      s.screenSpaceCameraController.enableInputs = true;
      // Der Klick, der auf das Loslassen folgt, gehört noch zum Zug — sonst
      // wählte features.js das Bauteil unter dem Griff aus.
      setTimeout(function () { griffZug = false; }, 0);
    }, Cesium.ScreenSpaceEventType.LEFT_UP);
  }

  // ── Bauteil anklicken ──────────────────────────────────────────────────

  var klickHandler = null;
  var escHandler = null;

  function auswahlStarten() {
    if (Z.waehlt) return;
    if (!Z.an && !starten()) return;
    Z.waehlt = true;
    var s = szene();
    klickHandler = new Cesium.ScreenSpaceEventHandler(s.canvas);
    klickHandler.setInputAction(function (e) {
      var getroffen = s.pick(e.position);
      if (!(getroffen instanceof Cesium.Cesium3DTileFeature)) {
        melde(ue('schnitt.keinBauteil', 'Kein Bauteil getroffen — auf die Fläche eines Modells klicken.'), 'warn');
        return;
      }
      var treffer = s.pickPositionSupported ? s.pickPosition(e.position) : null;
      auswahlBeenden();
      umFeature(getroffen, treffer);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    escHandler = function (e) { if (e.key === 'Escape') auswahlBeenden(); };
    window.addEventListener('keydown', escHandler);
    melde(ue('schnitt.klicken', 'Bauteil anklicken — ein Meterwürfel legt sich an die Stelle.'), 'busy');
  }

  function auswahlBeenden() {
    if (!Z.waehlt) return;
    Z.waehlt = false;
    if (klickHandler) { klickHandler.destroy(); klickHandler = null; }
    if (escHandler) { window.removeEventListener('keydown', escHandler); escHandler = null; }
    melden('auswahl');
  }

  function auswahlUmschalten() {
    if (Z.waehlt) auswahlBeenden();
    else auswahlStarten();
  }

  function assetZuTileset(ts) {
    var treffer = null;
    BimViewer.loadedAssets.forEach(function (a) { if (a.tileset === ts) treffer = a; });
    return treffer;
  }

  function eigenschaft(feature, namen) {
    for (var i = 0; i < namen.length; i++) {
      try {
        var w = feature.getProperty(namen[i]);
        if (w !== undefined && w !== null && w !== '') return String(w);
      } catch (e) { /* gibt es nicht */ }
    }
    return null;
  }

  function bauteilText(ifcType, name) {
    var typ = (ifcType || '').replace(/^Ifc/, '') || ue('schnitt.bauteil', 'Bauteil');
    return name ? typ + ' „' + name + '“' : typ;
  }

  /** Tile-lokale Hüllbox eines Bauteils aus dem Backend, oder null. */
  async function backendBox(jobId, globalId) {
    try {
      var a = await fetch(BimViewer.getBackendUrl() + '/assets/' + jobId + '/elements/' +
        encodeURIComponent(globalId) + '/box');
      if (!a.ok) return null;
      var d = await a.json();
      return { center: d.center.slice(), size: d.size.slice() };
    } catch (e) {
      return null;
    }
  }

  /** Tile-lokaler Quader → achsparallele Hülle im Rahmen. */
  function tileQuaderImRahmen(ts, quader, zugabe) {
    var m = ts.root.computedTransform;
    var z = zugabe || 0;
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < 8; i++) {
      var q = [0, 1, 2].map(function (a) {
        return quader.center[a] + ((i & (1 << a)) ? 1 : -1) * (quader.size[a] / 2 + z);
      });
      var p = inRahmen(Cesium.Matrix4.multiplyByPoint(m, Cesium.Cartesian3.fromArray(q), new Cesium.Cartesian3()));
      for (var k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    }
    return { min: min, max: max };
  }

  /**
   * Meterwürfel an die angeklickte Stelle. Der Mittelpunkt ist der
   * Trefferpunkt auf der Oberfläche, nicht der Schwerpunkt des Bauteils —
   * bei einer 14 m langen Wand liegt der irgendwo; angesehen werden soll die
   * Stelle unter dem Zeiger. Ohne Trefferpunkt (streifender Blick) die
   * Bauteilmitte aus dem Backend.
   */
  async function umFeature(feature, trefferWelt) {
    var ts = feature.tileset || (feature.content && feature.content.tileset);
    var asset = assetZuTileset(ts);
    if (!asset || !ts || !ts.root) {
      melde(ue('schnitt.keinModellZumBauteil', 'Das Modell dieses Bauteils ist nicht auffindbar.'), 'warn');
      return;
    }
    if (!Z.an && !starten()) return;
    var gid = eigenschaft(feature, ['GlobalId', 'globalId', 'global_id']);
    Z.quelle = {
      assetKey: asset.id, jobId: asset.jobId || null, tileset: ts, modell: asset.name || '',
      name: eigenschaft(feature, ['Name', 'name']) || '',
      ifcType: eigenschaft(feature, ['IfcType', 'className', 'IfcEntity']) || '',
      globalId: gid, bauteil: null,
    };
    var mitte = trefferWelt ? inRahmen(trefferWelt) : null;
    if (!mitte && asset.jobId && gid) {
      Z.quelle.bauteil = await backendBox(asset.jobId, gid);
      if (Z.quelle.bauteil) {
        var h = tileQuaderImRahmen(ts, Z.quelle.bauteil, 0);
        mitte = [0, 1, 2].map(function (i) { return (h.min[i] + h.max[i]) / 2; });
      }
    }
    if (!mitte) {
      melde(ue('schnitt.keineStelle', 'Stelle nicht bestimmbar — noch einmal klicken.'), 'warn');
      return;
    }
    setBox(mitte.map(function (c) { return c - KANTE / 2; }), mitte.map(function (c) { return c + KANTE / 2; }));
    melde(bauteilText(Z.quelle.ifcType, Z.quelle.name) + ' — ' +
      ue('schnitt.wuerfel', 'Meterwürfel gesetzt, an den Griffen oder in der Karte aufziehen.'), '');
  }

  /** Die Box genau um das angeklickte Bauteil — mit `zugabe` Metern Luft. */
  async function aufBauteil(zugabe) {
    var q = Z.quelle;
    if (!q) {
      melde(ue('schnitt.erstBauteil', 'Erst ein Bauteil anklicken.'), 'warn');
      return false;
    }
    if (!q.bauteil && q.jobId && q.globalId) {
      melde(ue('schnitt.huelleHolen', 'Hüllbox des Bauteils wird geholt …'), 'busy');
      q.bauteil = await backendBox(q.jobId, q.globalId);
    }
    if (!q.bauteil) {
      melde(ue('schnitt.keineHuelle', 'Für dieses Bauteil gibt es keine Hüllbox — das geht nur bei Modellen aus dem eigenen Backend.'), 'warn');
      return false;
    }
    var h = tileQuaderImRahmen(q.tileset, q.bauteil, zugabe || 0);
    setBox(h.min, h.max);
    melde(ue('schnitt.eingepasst', 'Box eingepasst auf') + ' ' + bauteilText(q.ifcType, q.name) + '.', '');
    return true;
  }

  function hinfliegen() {
    if (!Z.box || !Z.rahmen) return;
    var kugel = Cesium.BoundingSphere.fromPoints(boxEcken());
    BimViewer.viewer.camera.flyToBoundingSphere(kugel, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(-35), Cesium.Math.toRadians(-28), kugel.radius * 3.2),
    });
  }

  // ── Als Detail in den Plan ─────────────────────────────────────────────

  /**
   * Das Modell, aus dessen IFC gezeichnet wird: das angeklickte Bauteil,
   * sonst das Backend-Modell, in dessen Hülle die Boxmitte liegt, sonst das
   * größte Backend-Modell.
   */
  function zeichenModell() {
    if (Z.quelle && Z.quelle.jobId) {
      var a = assetZuTileset(Z.quelle.tileset);
      if (a) return a;
    }
    var mitte = Z.box ? [0, 1, 2].map(function (i) { return (Z.box.min[i] + Z.box.max[i]) / 2; }) : null;
    var mitJob = kandidaten().filter(function (a) { return a.jobId; });
    var drin = mitte && mitJob.filter(function (a) {
      var h = huelleIn(eckenEcef(a.tileset), Z.rahmen.vonEcef);
      return [0, 1, 2].every(function (i) { return mitte[i] >= h.min[i] && mitte[i] <= h.max[i]; });
    })[0];
    if (drin) return drin;
    var beste = null, r = -1;
    mitJob.forEach(function (a) {
      var k = a.tileset.boundingSphere;
      if (k && k.radius > r) { r = k.radius; beste = a; }
    });
    return beste;
  }

  /**
   * Ein Quader im Rahmen als tile-lokale Box des Backends:
   * `{ center, size, yaw }` mit Kompass-Yaw. `richtung` ist die Lage der
   * Box-x-Achse im Rahmen (Grad) — 0 für die Box selbst, quer zur Scheibe
   * für einen Scheibenschnitt.
   */
  function tileAusschnitt(ts, mitte, groesse, richtung) {
    var nachTile = Cesium.Matrix4.inverseTransformation(ts.root.computedTransform, new Cesium.Matrix4());
    var c = Cesium.Matrix4.multiplyByPoint(nachTile, ausRahmen(mitte[0], mitte[1], mitte[2]), new Cesium.Cartesian3());
    var w = R.rad(richtung || 0);
    var xWelt = richtungAusRahmen(Math.cos(w), Math.sin(w), 0);
    var xTile = Cesium.Matrix4.multiplyByPointAsVector(nachTile, xWelt, new Cesium.Cartesian3());
    return { center: [c.x, c.y, c.z], size: groesse.slice(), yaw: R.kompassYaw([xTile.x, xTile.y]) };
  }

  /** Die Box im tile-lokalen System eines Modells — für Plan und Plansatz. */
  function ausschnittTileLokal(ts) {
    if (!Z.box || !Z.rahmen || !ts || !ts.root) return null;
    var b = Z.box;
    return tileAusschnitt(ts,
      [0, 1, 2].map(function (i) { return (b.min[i] + b.max[i]) / 2; }),
      [0, 1, 2].map(function (i) { return b.max[i] - b.min[i]; }), 0);
  }

  function anfrage(ebene) {
    var m = zeichenModell();
    var b = m && ausschnittTileLokal(m.tileset);
    return b ? R.detailAnfrage(b, ebene, Z.schnittanteil) : null;
  }

  function titel(ebene) {
    var q = Z.quelle;
    var was = q ? bauteilText(q.ifcType, q.name) + (q.globalId ? ' [' + q.globalId.slice(0, 8) + ']' : '')
      : ue('schnitt.ausschnitt', 'Ausschnitt') + ' ' + boxMasse();
    return 'Detail ' + (ebene === 'xy' ? '▤' : '◫') + ' ' + ebene.toUpperCase() + ' ' + was;
  }

  function boxMasse() {
    if (!Z.box) return '';
    return [0, 1, 2].map(function (i) {
      return (Z.box.max[i] - Z.box.min[i]).toFixed(2).replace('.', ',');
    }).join(' × ') + ' m';
  }

  async function planOeffnen(modell, abfrage, blatt) {
    if (Z.laeuft) return;
    if (!modell || !modell.jobId) {
      melde(ue('schnitt.nurBackend', 'Zeichnungen entstehen aus der IFC-Quelldatei — das geht nur bei Modellen aus dem eigenen Backend.'), 'warn');
      return;
    }
    if (!BimViewer.Plan2D) {
      melde(ue('schnitt.keinPlan', 'Der Zeichenmodus ist nicht geladen.'), 'warn');
      return;
    }
    Z.laeuft = true;
    melde(blatt + ' ' + ue('schnitt.wirdGeschnitten', 'wird geschnitten …'), 'busy');
    try {
      var a = await fetch(BimViewer.getBackendUrl() + '/assets/' + modell.jobId + '/section', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(abfrage),
      });
      if (!a.ok) {
        var text = a.status + ' ' + a.statusText;
        try { text = (await a.json()).detail || text; } catch (e) { /* kein JSON */ }
        throw new Error(text);
      }
      var plan = await a.json();
      if (!plan.figures || !plan.figures.length) {
        melde(ue('schnitt.nichtsGetroffen', 'Nichts getroffen — an dieser Ebene liegt im Ausschnitt kein Bauteil.'), 'warn');
        return;
      }
      BimViewer.Plan2D.modell = modell.name || '';
      await BimViewer.Plan2D.open(plan, blatt);
      melde(plan.figures.length + ' ' + ue('schnitt.figuren', 'Figuren — im Blatt bemaßen und beschriften.'), '');
    } catch (e) {
      melde(ue('schnitt.fehlgeschlagen', 'Fehlgeschlagen:') + ' ' + e.message, 'warn');
    } finally {
      Z.laeuft = false;
      melden('laeuft');
    }
  }

  /** Detail XY · XZ · YZ aus der Box — derselbe Weg wie früher an der Schnittbox. */
  function detail(ebene) {
    var m = zeichenModell();
    var abfrage = anfrage(ebene);
    if (!abfrage) {
      melde(ue('schnitt.nurBackend', 'Zeichnungen entstehen aus der IFC-Quelldatei — das geht nur bei Modellen aus dem eigenen Backend.'), 'warn');
      return;
    }
    return planOeffnen(m, abfrage, titel(ebene));
  }

  /**
   * Eine Scheibe als Schnitt A–A zeichnen: senkrecht, längs der
   * Schnittlinie, über die Höhe der Box, mit der Scheibe als Tiefe.
   */
  function scheibeZeichnen(id) {
    var s = scheibe(id);
    var m = zeichenModell();
    if (!s || !Z.box) return;
    var aus = R.scheibenAusschnitt(s, Z.box);
    if (!aus || !m) {
      melde(ue('schnitt.nurBackend', 'Zeichnungen entstehen aus der IFC-Quelldatei — das geht nur bei Modellen aus dem eigenen Backend.'), 'warn');
      return;
    }
    var b = tileAusschnitt(m.tileset, aus.mitte, aus.groesse, aus.richtung);
    return planOeffnen(m, R.detailAnfrage(b, 'xz', 0.5),
      ue('schnitt.schnitt', 'Schnitt') + ' ◫ ' + s.name + '–' + s.name + ' · ' + (m.name || ''));
  }

  // ── Anmelden in der Szene ──────────────────────────────────────────────

  // Ein neu geladenes Modell soll denselben Schnitt bekommen. Zweimal: einmal
  // sofort, einmal wenn das Tileset seine Hülle wirklich hat — vorher stehen
  // dort Platzhalter, und die Szene wäre falsch vermessen.
  if (typeof BimViewerUI !== 'undefined' && typeof BimViewerUI.createAssetControls === 'function') {
    var vorher = BimViewerUI.createAssetControls.bind(BimViewerUI);
    BimViewerUI.createAssetControls = function (assetId) {
      vorher(assetId);
      if (!Z.rahmen) return;
      [0, 2500].forEach(function (ms) {
        setTimeout(function () {
          if (!szeneAktualisieren()) return;
          zieleAbgleichen();
          stand('modelle');
          if (Z.an && ms > 0) { hoehenbildAufnehmen(); geschosseLaden(); }
        }, ms);
      });
    };
  }

  if (typeof BimViewer.unloadAsset === 'function') {
    var vorherEntladen = BimViewer.unloadAsset.bind(BimViewer);
    BimViewer.unloadAsset = function (assetId) {
      var a = BimViewer.loadedAssets.get(String(assetId));
      if (a && a.tileset) {
        var ziel = Z.ziele.filter(function (z) { return z.tileset === a.tileset; })[0];
        if (ziel) zielAbmelden(ziel);
        Z.ziele = Z.ziele.filter(function (z) { return z.tileset !== a.tileset; });
        if (Z.quelle && Z.quelle.tileset === a.tileset) Z.quelle = null;
      }
      var ergebnis = vorherEntladen(assetId);
      setTimeout(function () {
        if (Z.rahmen && szeneAktualisieren()) {
          stand('modelle');
          if (Z.an) hoehenbildAufnehmen();
        }
      }, 0);
      return ergebnis;
    };
  }

  // ── Schnittstelle ──────────────────────────────────────────────────────

  var Schnitt = {
    get an() { return Z.an; },
    get wirkt() { return Z.wirkt; },
    starten: starten,
    beenden: beenden,
    umschalten: function () { return Z.an ? (beenden(), false) : starten(); },
    einpassen: function () { return einpassen(false); },
    ganz: ganz,
    setGrenze: setGrenze,
    setBox: setBox,
    setModus: setModus,
    setFlaechen: setFlaechen,
    setKante: setKante,
    setGriffe: setGriffe,
    setYaw: setYaw,
    amModellAusrichten: amModellAusrichten,
    nachNorden: function () { setYaw(0); },
    setSchnittanteil: setSchnittanteil,
    scheibeNeu: scheibeNeu,
    scheibeSetzen: scheibeSetzen,
    scheibeWeg: scheibeWeg,
    scheibeWaehlen: scheibeWaehlen,
    setDicke: setDicke,
    geschoss: geschoss,
    auswahlStarten: auswahlStarten,
    auswahlBeenden: auswahlBeenden,
    auswahlUmschalten: auswahlUmschalten,
    umFeature: umFeature,
    aufBauteil: aufBauteil,
    hinfliegen: hinfliegen,
    detail: detail,
    scheibeZeichnen: scheibeZeichnen,
    anfrage: anfrage,
    titel: titel,
    ausschnittTileLokal: ausschnittTileLokal,
    zeichenModell: zeichenModell,
    hoehenbildAufnehmen: hoehenbildAufnehmen,
    umrisse: umrisse,
    boxMasse: boxMasse,
    bauteilText: bauteilText,
    faengtKlick: function () { return Z.waehlt || griffZug; },
    beobachten: function (fn) {
      zuhoerer.push(fn);
      return function () { zuhoerer = zuhoerer.filter(function (f) { return f !== fn; }); };
    },
    get zustand() { return Z; },
    /** Für Prüfsteine und die Konsole: der Stand als schlichte Zahlen. */
    stand: function () {
      return {
        an: Z.an, wirkt: Z.wirkt, modus: Z.modus, yaw: Z.rahmen ? Z.rahmen.yaw : null,
        box: Z.box && { min: Z.box.min.slice(), max: Z.box.max.slice() },
        szene: Z.szene && { min: Z.szene.min.slice(), max: Z.szene.max.slice() },
        scheiben: Z.scheiben.map(function (s) { return Object.assign({}, s); }),
        ziele: Z.ziele.length, geschosse: Z.geschosse.slice(),
        hoehenbild: Z.hoehenbild && { spalten: Z.hoehenbild.spalten, zeilen: Z.hoehenbild.zeilen,
          fertig: Z.hoehenbild.fertig, anteil: Z.hoehenbild.anteil, dauer: Z.hoehenbild.dauer },
      };
    },
    _intern: { fragment: fragment, inRahmen: inRahmen, ausRahmen: ausRahmen, UNIFORMS: UNIFORMS, art: art },
  };

  BimViewer.Schnitt = Schnitt;

  // ── Die alte Schnittbox-Schnittstelle ──────────────────────────────────
  //
  // `plan-bauteil.js` (Plansatz), `features.js` und `bauplaner*.js` (wer den
  // Klick bekommt), der MCP-Server (`ileen_schnittbox`, wartet beim Start auf
  // `BimViewer.SectionBox`) sprechen die Schnittbox unter ihrem alten Namen
  // an. Die Schnittstelle bleibt als Sicht auf den Schnitt stehen: `box` ist
  // der Ausschnitt im tile-lokalen System des angeklickten Modells, genau in
  // der Form, die die Schnittbox führte.

  BimViewer.SectionBox = {
    get waehlt() { return Z.waehlt; },
    get quelle() { return Z.quelle; },
    get box() {
      var ts = Z.quelle && Z.quelle.tileset;
      return (Z.an && ts) ? ausschnittTileLokal(ts) : null;
    },
    get schnittanteil() { return Z.schnittanteil; },
    faengtKlick: Schnitt.faengtKlick,
    auswahlStarten: auswahlStarten,
    auswahlBeenden: auswahlBeenden,
    auswahlUmschalten: auswahlUmschalten,
    /**
     * Zwei Aufrufformen: `(feature, trefferWelt)` vom Klick, und
     * `(jobId, globalId, zugabe)` vom MCP-Werkzeug `ileen_schnittbox` — dort
     * gibt es kein Feature, nur die Kennung aus der IFC.
     */
    umBauteil: async function (a, b, zugabe) {
      if (typeof a !== 'string') return umFeature(a, b);
      var asset = kandidaten().filter(function (x) { return x.jobId === a; })[0];
      if (!asset) return melde(ue('schnitt.modellFehlt', 'Dieses Modell ist nicht geladen.'), 'warn');
      if (!Z.an && !starten()) return;
      Z.quelle = { assetKey: asset.id, jobId: a, tileset: asset.tileset, modell: asset.name || '',
        name: '', ifcType: '', globalId: b || null, bauteil: null };
      if (await aufBauteil(zugabe === undefined ? 0.5 : zugabe)) hinfliegen();
    },
    aufBauteil: aufBauteil,
    zuruecksetzen: ganz,
    hinfliegen: hinfliegen,
    setModus: setModus,
    setSchnittanteil: setSchnittanteil,
    detail: detail,
    anfrage: anfrage,
    titel: titel,
    aufheben: beenden,
    entfernen: beenden,
    _backendBox: backendBox,
  };

  console.log('✂️ Schnitt geladen — Box, Scheiben und Schnittkarte');
})();
