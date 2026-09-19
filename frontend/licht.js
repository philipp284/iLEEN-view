/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
/**
 * Kunstlicht im Modell — Grundaufhellung und Taschenlampe.
 *
 * Cesium beleuchtet Modelle mit genau einer Lichtquelle: der Sonne. Draußen
 * trägt das. Drinnen nicht — ein Flur ohne Fenster bekommt vom Sonnenstand
 * nichts ab, und was das Bild dort noch zeigt, stammt allein aus der
 * bildbasierten Umgebungsbeleuchtung. Deshalb steht man im Walk-Modus
 * regelmäßig im Dunkeln, obwohl die Uhrzeit auf Mittag steht.
 *
 * Eine zweite echte Lichtquelle kann man nicht dazustellen: `scene.light` ist
 * ein einzelner Steckplatz, und Schattenkarten gibt es nur für ihn. Was geht,
 * ist Licht IM Materialshader — zwei Griffe, beide über den Shader-Verbund:
 *
 * 1 · **Grundaufhellung.** Ein Bruchteil der eigenen Grundfarbe wandert nach
 *     `material.emissive`. Das ist kein Licht, das von irgendwoher kommt,
 *     sondern ein Sockel, unter den kein Bauteil fällt — der dunkle Flur wird
 *     lesbar, die besonnte Fassade ändert sich kaum, weil dort das direkte
 *     Sonnenlicht ohnehin um ein Vielfaches größer ist.
 *
 * 2 · **Taschenlampe.** Ein Lichtkegel, der an der Kamera hängt. Gerechnet
 *     wird er in AUGENKOORDINATEN, und das ist der ganze Trick: dort steht
 *     die Kamera im Ursprung und blickt entlang −Z — in jedem Bild, ohne
 *     Zutun. Ein Scheinwerfer, der genau dort sitzt, braucht deshalb kein
 *     einziges je Bild nachgeführtes Uniform. Kein `preRender`-Horcher, kein
 *     Zucken beim Neuübersetzen des Shaders.
 *
 *         d          = Abstand Fragment ↔ Kamera          = length(positionEC)
 *         cos(Winkel zur Blickachse)                      = -positionEC.z / d
 *
 * Warum `material.emissive` und nicht `material.diffuse`: `diffuse` ist die
 * Albedo, also *wie viel* Licht ein Stoff zurückwirft. Sie hochzudrehen macht
 * eine unbeleuchtete Wand nicht heller — sie wirft mehr von nichts zurück.
 * `emissive` wird in `computePbrLighting()` nach der Beleuchtung addiert und
 * ist damit der einzige Weg, ohne Lichtquelle Helligkeit hinzuzufügen. Der
 * Faktor bleibt trotzdem an `material.diffuse` gekoppelt, damit die Farbe des
 * Bauteils erhalten bleibt: eine rote Wand wird im Kegel hellrot, nicht weiß.
 *
 * `ordnung: 50` — nach der Bildprojektion (40). Was die auf eine Fläche legt,
 * soll die Taschenlampe mit anleuchten, nicht darunter liegen bleiben.
 *
 * Nicht dabei sind Punktwolken und Gaussian Splats: ihr Inhalt läuft nicht
 * über den Modell-Renderer, ein `customShader` bliebe dort ohne Wirkung.
 * Splats bringen ihre Beleuchtung ohnehin in den Sphärischen Harmonischen mit.
 */
(function () {
  'use strict';

  var SPEICHER = 'ileen_licht_v1';

  var S = {
    lampe: false,
    staerke: 1.8,        // Helligkeit im Kegelinneren, 0–4
    weite: 34,           // halber Öffnungswinkel in Grad
    kante: 10,           // weiche Kante in Grad, außen an `weite` anschließend
    reichweite: 30,      // Meter, ab denen der Kegel ausgelaufen ist
    farbe: '#fff0d6',    // leicht warm — Glühlampe, nicht Bauscheinwerfer
    aufhellung: 0.15     // Sockel der Grundaufhellung, 0–1
  };

  try {
    var g = JSON.parse(localStorage.getItem(SPEICHER) || '{}');
    ['staerke', 'weite', 'kante', 'reichweite', 'aufhellung'].forEach(function (k) {
      if (typeof g[k] === 'number' && isFinite(g[k])) S[k] = g[k];
    });
    if (typeof g.farbe === 'string') S.farbe = g.farbe;
    if (typeof g.lampe === 'boolean') S.lampe = g.lampe;
  } catch (e) { /* privates Fenster o. ä. — Voreinstellung gilt */ }

  function sichern() {
    try { localStorage.setItem(SPEICHER, JSON.stringify(S)); } catch (e) { /* egal */ }
  }

  // ── Der Baustein ────────────────────────────────────────────────────────

  var FRAGMENT = [
    '  // Sockel: ein Bruchteil der eigenen Farbe, überall, unabhängig vom Sonnenstand.',
    '  vec3 sockel = material.diffuse * u_licht_amb;',
    '',
    '  float kegellicht = 0.0;',
    '  if (u_licht_par.x > 0.0) {',
    '    vec3 p = fsInput.attributes.positionEC;',
    '    float d = max(length(p), 1.0e-4);',
    '    vec3 zumAuge = -p / d;',
    // zumAuge.z ist zugleich der Kosinus des Winkels zur Blickachse (0,0,-1).
    '    float kegel = smoothstep(u_licht_par.z, u_licht_par.y, zumAuge.z);',
    '    float weg   = 1.0 - smoothstep(u_licht_par.w * 0.4, u_licht_par.w, d);',
    // Schräg getroffene Flächen dunkler, aber nie ganz schwarz: aus IFC kommen
    // Normalen in beiden Wicklungen, und eine Wand, die im Kegel steht, soll
    // nicht davon abhängen, wie herum der Exporter sie gedreht hat.
    '    float len = length(material.normalEC);',
    '    float schraeg = (len > 1.0e-4) ? abs(dot(material.normalEC / len, zumAuge)) : 1.0;',
    '    kegellicht = u_licht_par.x * kegel * weg * mix(0.35, 1.0, schraeg);',
    '  }',
    '',
    '  material.emissive += sockel + material.diffuse * u_licht_farbe * kegellicht;'
  ].join('\n');

  function baustein() {
    var c = Cesium.Color.fromCssColorString(S.farbe) || Cesium.Color.WHITE;
    var innen = Math.cos(Cesium.Math.toRadians(Math.max(0.5, S.weite)));
    var aussen = Math.cos(Cesium.Math.toRadians(Math.min(89.5, S.weite + Math.max(0.5, S.kante))));

    return {
      ordnung: 50,
      uniforms: {
        u_licht_par: {
          type: Cesium.UniformType.VEC4,
          value: new Cesium.Cartesian4(
            S.lampe ? S.staerke : 0.0, innen, aussen, Math.max(1.0, S.reichweite))
        },
        u_licht_farbe: {
          type: Cesium.UniformType.VEC3,
          value: new Cesium.Cartesian3(c.red, c.green, c.blue)
        },
        u_licht_amb: { type: Cesium.UniformType.FLOAT, value: S.aufhellung }
      },
      fragment: FRAGMENT
    };
  }

  /** Wirkt gerade irgendetwas? Ohne das bleibt der Steckplatz frei. */
  function gebraucht() {
    return S.lampe || S.aufhellung > 0.001;
  }

  // ── Träger ──────────────────────────────────────────────────────────────

  function traegerSammeln() {
    var ziele = [];
    var B = window.BimViewer;
    if (!B) return ziele;

    if (B.loadedAssets) {
      B.loadedAssets.forEach(function (asset) {
        var ts = asset.tileset;
        if (ts && ts.root && !ts._isGaussianSplat && !asset.isPointCloud) ziele.push(ts);
        else if (asset.isGLB && asset.model) ziele.push(asset.model);
      });
    }

    // Die Geschossklone der Explosion: solange sie läuft, ist das Original
    // unsichtbar, und ohne die Klone leuchtete die Lampe ins Leere.
    var ex = B.Explosion;
    if (ex && ex.aktiv && ex.klonZiele) {
      ex.klonZiele.forEach(function (z) {
        (z.klone || []).forEach(function (k) {
          if (k.tileset && ziele.indexOf(k.tileset) === -1) ziele.push(k.tileset);
        });
      });
    }
    return ziele;
  }

  /**
   * Schreibt den Baustein auf alle Träger — oder meldet ihn ab.
   *
   * `nurNeue` setzt ihn nur dort, wo er noch nicht läuft. Das ist der Weg für
   * die Nachzüglerwache: ein Modell, das später geladen wird, soll die Lampe
   * mitbekommen, ohne dass dafür jedes Bild alle Shader neu übersetzt werden.
   */
  function anwenden(nurNeue) {
    var V = window.ShaderVerbund;
    if (!V) return;
    var an = gebraucht();

    traegerSammeln().forEach(function (t) {
      var laeuft = V.hat(t, 'licht');
      if (!an) { if (laeuft) V.entfernen(t, 'licht'); return; }
      if (nurNeue && laeuft) return;
      // Je Träger ein eigener Baustein: `CustomShader.setUniform()` schreibt in
      // das übergebene Uniform-Objekt zurück, und ein geteiltes Objekt wäre
      // damit ein stiller Kanal zwischen zwei Modellen.
      V.setzen(t, 'licht', baustein());
    });
  }

  /**
   * Nur die Zahlen ändern, ohne den Shader neu zu übersetzen.
   *
   * Beim Ziehen an einem Regler ist das der Unterschied zwischen flüssig und
   * ruckelnd: ein Uniform zu setzen kostet nichts, ein `CustomShader` neu zu
   * bauen heißt für jeden Träger eine GLSL-Übersetzung.
   */
  function nachziehen() {
    var V = window.ShaderVerbund;
    if (!V) return;
    if (!gebraucht()) { anwenden(false); return; }

    var b = baustein();
    var fehlt = false;
    traegerSammeln().forEach(function (t) {
      if (!V.hat(t, 'licht')) { fehlt = true; return; }
      V.uniform(t, 'u_licht_par', b.uniforms.u_licht_par.value);
      V.uniform(t, 'u_licht_farbe', b.uniforms.u_licht_farbe.value);
      V.uniform(t, 'u_licht_amb', b.uniforms.u_licht_amb.value);
    });
    if (fehlt) anwenden(true);

    var v = window.BimViewer && BimViewer.viewer;
    if (v) v.scene.requestRender();
  }

  // Nachzüglerwache: Modelle werden geladen, während das Licht schon läuft.
  // Halbsekündlich statt je Bild — `hat()` ist billig, aber eine Schleife über
  // alle Assets in jedem Bild ist es nicht mehr, und schneller als ein
  // halbsekündliches Aufleuchten muss ein neu geladenes Modell nicht sein.
  var wache = null, letzte = 0;

  function wacheStarten() {
    var v = window.BimViewer && BimViewer.viewer;
    if (!v || wache) return;
    wache = v.scene.preRender.addEventListener(function () {
      var jetzt = performance.now();
      if (jetzt - letzte < 500) return;
      letzte = jetzt;
      anwenden(true);
    });
  }

  function wacheBeenden() {
    if (!wache) return;
    wache();
    wache = null;
  }

  // ── Öffentlich ──────────────────────────────────────────────────────────

  var Licht = {

    /** Taschenlampe an/aus. Ohne Argument: umschalten. */
    taschenlampe: function (an) {
      S.lampe = (an === undefined) ? !S.lampe : !!an;
      sichern();
      anwenden(false);
      if (S.lampe) wacheStarten(); else if (S.aufhellung <= 0.001) wacheBeenden();
      if (window.BimViewer && BimViewer.updateStatus) {
        BimViewer.updateStatus(S.lampe ? '🔦 Taschenlampe an' : 'Taschenlampe aus', 'info');
      }
      return S.lampe;
    },

    umschalten: function () { return this.taschenlampe(); },

    /** Grundaufhellung, 0–1. 0 nimmt den Baustein wieder heraus. */
    aufhellungSetzen: function (wert) {
      S.aufhellung = Math.max(0, Math.min(1, parseFloat(wert) || 0));
      sichern();
      nachziehen();
      if (gebraucht()) wacheStarten(); else wacheBeenden();
      return S.aufhellung;
    },

    staerkeSetzen: function (wert) {
      S.staerke = Math.max(0, Math.min(4, parseFloat(wert) || 0));
      sichern(); nachziehen(); return S.staerke;
    },

    /** Halber Öffnungswinkel des Kegels in Grad. */
    weiteSetzen: function (grad) {
      S.weite = Math.max(2, Math.min(80, parseFloat(grad) || 2));
      sichern(); nachziehen(); return S.weite;
    },

    /** Entfernung in Metern, in der der Kegel ausgelaufen ist. */
    reichweiteSetzen: function (meter) {
      S.reichweite = Math.max(1, Math.min(500, parseFloat(meter) || 1));
      sichern(); nachziehen(); return S.reichweite;
    },

    farbeSetzen: function (css) {
      if (typeof css === 'string' && Cesium.Color.fromCssColorString(css)) S.farbe = css;
      sichern(); nachziehen(); return S.farbe;
    },

    /** Träger neu einsammeln — nach dem Laden eines Modells, nach der Explosion. */
    auffrischen: function () { if (gebraucht()) anwenden(true); },

    stand: function () {
      return {
        lampe: S.lampe, staerke: S.staerke, weite: S.weite, kante: S.kante,
        reichweite: S.reichweite, farbe: S.farbe, aufhellung: S.aufhellung,
        traeger: traegerSammeln().length
      };
    }
  };

  // ── Anmeldung ───────────────────────────────────────────────────────────

  function start() {
    if (!window.BimViewer || !window.BimViewer.viewer) { setTimeout(start, 300); return; }
    if (gebraucht()) { anwenden(false); wacheStarten(); }
  }

  document.addEventListener('keydown', function (e) {
    if (e.code !== 'KeyL' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    var z = e.target;
    if (z && (z.tagName === 'INPUT' || z.tagName === 'TEXTAREA' || z.tagName === 'SELECT' ||
              z.isContentEditable)) return;
    e.preventDefault();
    Licht.umschalten();
    if (window.BimViewerUI && typeof BimViewerUI.lichtAnzeigeAuffrischen === 'function') {
      BimViewerUI.lichtAnzeigeAuffrischen();
    }
  });

  window.BimViewer = window.BimViewer || {};
  BimViewer.Licht = Licht;
  window.Licht = Licht;

  start();

  console.log('✅ Licht bereit — Taschenlampe auf „L"');

})();
