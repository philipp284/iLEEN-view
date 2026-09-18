/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Licensed under BSL 1.1 (siehe clipping-planes.js).
 */

// ===============================
// SHADER-VERBUND v1.0 — mehrere Werkzeuge an EINEM `customShader`
//
// `Cesium3DTileset.customShader` ist ein einzelner Steckplatz. Wer ihn
// belegt, wirft den vorherigen Inhalt heraus. Vier Werkzeuge im Viewer
// wollen ihn gleichzeitig:
//
//   core.js        Rückseitenschnitt (`czm_backFacing()` → discard) — bei
//                  IFC-Modellen dauerhaft, gegen das Z-Fighting doppel-
//                  seitiger Wände
//   explosion.js   Geschosse anheben und flachdrücken (Vertex)
//   section-box.js schaltet den Rückseitenschnitt ab und wieder an
//   bildprojektion.js  Bild auf die Flächen projizieren (Fragment)
//
// Bisher lief das über „merk dir den vorherigen und leg ihn nachher
// zurück". Das trägt für zwei Werkzeuge, die sich abwechseln, und bricht,
// sobald zwei gleichzeitig etwas wollen: wer zuletzt schreibt, gewinnt, der
// andere ist still weg. Der Kommentar in `explosion.js:_kloneAufbauen()`
// hält genau diesen Fehler fest — der Stauchregler zeigte 98 %, und das
// Gebäude stand unverändert da, weil `applyBackFaceCulling()` danach kam.
//
// ## Bausteine statt ganzer Shader
//
// Hier meldet kein Werkzeug mehr einen fertigen `CustomShader` an, sondern
// einen BAUSTEIN: seine Uniforms, seine Varyings und je einen GLSL-Rumpf
// für `vertexMain` und `fragmentMain`. Der Verbund setzt daraus einen
// einzigen Shader zusammen und schreibt ihn in den Steckplatz. Meldet sich
// ein Werkzeug ab, wird ohne es neu gesetzt.
//
//     Verbund.setzen(tileset, 'explosion', { ordnung: 20, uniforms: …,
//                                            vertex: '…', fragment: '…' })
//     Verbund.uniform(tileset, 'u_abstand', 3.0)
//     Verbund.entfernen(tileset, 'explosion')
//
// **Jeder Rumpf läuft in eigenen geschweiften Klammern.** Zwei Bausteine
// dürfen dieselbe lokale Variable `h` benennen, ohne voneinander zu wissen
// — der Verbund setzt sie nicht nebeneinander, sondern in getrennte Blöcke.
// Was zwischen Bausteinen fließt, fließt ausschließlich über die von Cesium
// vorgegebenen Wege: `vsOutput.positionMC` im Vertex, `material` im
// Fragment. Beides sind `inout`-Parameter und damit auch im Block sichtbar.
//
// **Uniform-Namen sind global.** Der Verbund kann sie nicht umbenennen,
// ohne den GLSL-Text zu zerschneiden — das wäre Textersetzung an Quelltext,
// den er nicht versteht. Stattdessen gilt eine Namenskonvention (jeder
// Baustein präfixt, `u_bp_…` für die Bildprojektion), und eine Kollision
// wird gemeldet statt stillschweigend überschrieben.
//
// **`ordnung` entscheidet die Reihenfolge.** Sie ist selten wichtig, aber
// wenn, dann entscheidend: der Rückseitenschnitt (`ordnung: 0`) verwirft
// das Fragment, und alles, was danach rechnete, wäre verlorene Arbeit.
//
// ## Was der Verbund NICHT tut
//
// Er kennt keinen `REPLACE_MATERIAL`-Modus. Alle Bausteine laufen in
// `MODIFY_MATERIAL`: sie verändern ein Material, das Cesium schon gebaut
// hat. Ein Baustein, der das Material vollständig ersetzen wollte, müsste
// alle anderen kennen — das ist kein Verbund mehr, sondern ein Shader.
//
// `lightingModel` ist dagegen eine Eigenschaft des Ganzen, kein Rumpf.
// Meldet ein Baustein eines an (der Beton-Shader aus core.js tut es), gilt
// es für den gesamten Verbund; melden zwei verschiedene an, gewinnt der mit
// der kleineren `ordnung` und der Fall wird gemeldet.
//
// ## Träger
//
// „Träger" ist alles mit einer `customShader`-Eigenschaft — ein
// `Cesium3DTileset` ebenso wie ein `Cesium.Model` (die GLB-Modelle aus
// core.js). Der Verbund unterscheidet sie nicht.
// ===============================
'use strict';

(function () {

  if (!window.BimViewer) {
    console.warn('shader-verbund.js: BimViewer nicht gefunden');
    return;
  }

  /** träger → { liste: [{name, baustein}], shader } */
  var register = new WeakMap();

  /**
   * Hat der Träger einen `customShader`, den nicht wir gesetzt haben?
   *
   * Dann hat ein Werkzeug am Verbund vorbei geschrieben. Der Verbund
   * überschreibt ihn (etwas anderes kann er nicht — er kennt den fremden
   * Inhalt nicht), sagt aber Bescheid: still wäre es genau der Fehler, gegen
   * den diese Datei geschrieben ist.
   */
  function fremdPruefen(traeger, eintrag, wo) {
    var jetzt = traeger.customShader;
    if (!jetzt || !eintrag || jetzt === eintrag.shader) return;
    console.warn('shader-verbund: fremder customShader auf ' +
      (traeger.name || 'Träger') + ' bei ' + wo +
      ' — er wird vom Verbund ersetzt. Das Werkzeug, das ihn gesetzt hat, ' +
      'sollte sich stattdessen als Baustein anmelden.');
  }

  var Verbund = {

    /**
     * Meldet einen Baustein an oder ersetzt ihn.
     *
     * `baustein`:
     *   ordnung        Zahl, klein = früh. 0 verwirft (Rückseiten), 10–19
     *                  verformt (Vertex), 20+ färbt (Fragment).
     *   uniforms       wie bei `Cesium.CustomShader` — Namen bitte präfixen
     *   varyings       wie bei `Cesium.CustomShader`
     *   helferVS       GLSL vor `vertexMain` (Funktionen, Konstanten)
     *   vertex         GLSL-Rumpf in `vertexMain`
     *   helferFS       GLSL vor `fragmentMain`
     *   fragment       GLSL-Rumpf in `fragmentMain`
     *   lightingModel  optional, gilt dann für den ganzen Verbund
     */
    setzen: function (traeger, name, baustein) {
      if (!traeger || !name || !baustein) return null;

      var eintrag = register.get(traeger);
      if (!eintrag) {
        eintrag = { liste: [], shader: null };
        register.set(traeger, eintrag);
      } else {
        fremdPruefen(traeger, eintrag, 'setzen(' + name + ')');
      }

      var gefunden = false;
      for (var i = 0; i < eintrag.liste.length; i++) {
        if (eintrag.liste[i].name === name) {
          eintrag.liste[i].baustein = baustein;
          gefunden = true;
          break;
        }
      }
      if (!gefunden) eintrag.liste.push({ name: name, baustein: baustein });

      return this._bauen(traeger, eintrag);
    },

    /** Meldet einen Baustein ab. Der Verbund wird ohne ihn neu gesetzt. */
    entfernen: function (traeger, name) {
      if (!traeger) return null;
      var eintrag = register.get(traeger);
      if (!eintrag) return null;

      var vorher = eintrag.liste.length;
      eintrag.liste = eintrag.liste.filter(function (s) { return s.name !== name; });
      if (eintrag.liste.length === vorher) return eintrag.shader;

      return this._bauen(traeger, eintrag);
    },

    /** Läuft dieser Baustein gerade auf diesem Träger? */
    hat: function (traeger, name) {
      var eintrag = traeger && register.get(traeger);
      if (!eintrag) return false;
      return eintrag.liste.some(function (s) { return s.name === name; });
    },

    /** Die Namen aller Bausteine auf einem Träger, in Reihenfolge. */
    bausteine: function (traeger) {
      var eintrag = traeger && register.get(traeger);
      if (!eintrag) return [];
      return eintrag.liste.map(function (s) { return s.name; });
    },

    /** Der zusammengesetzte Shader eines Trägers, oder null. */
    shader: function (traeger) {
      var eintrag = traeger && register.get(traeger);
      return (eintrag && eintrag.shader) || null;
    },

    /**
     * Setzt ein Uniform des Verbunds.
     *
     * Der Wert geht an den laufenden Shader UND in die Baustein-Definition
     * zurück. Das zweite ist der Punkt: meldet sich später ein weiterer
     * Baustein an, wird der Shader neu übersetzt, und ohne den gemerkten
     * Wert stünde ein je Bild nachgeführtes Uniform (die Explosionsbasis,
     * die Projektorlage) für ein Bild auf seinem Anfangswert. Das sieht man
     * als Zucken.
     */
    uniform: function (traeger, feld, wert) {
      var eintrag = traeger && register.get(traeger);
      if (!eintrag || !eintrag.shader) return false;

      try {
        eintrag.shader.setUniform(feld, wert);
      } catch (e) {
        return false;
      }

      for (var i = 0; i < eintrag.liste.length; i++) {
        var u = eintrag.liste[i].baustein.uniforms;
        if (u && u[feld]) { u[feld].value = wert; return true; }
      }
      return true;
    },

    /**
     * Setzt den zusammengesetzten Shader neu.
     *
     * Ohne Bausteine wird der Steckplatz geleert — nicht auf einen gemerkten
     * Vorzustand zurückgesetzt: ein Vorzustand, den der Verbund nicht selbst
     * gebaut hat, ist genau die fremde Zuweisung, vor der `fremdPruefen()`
     * warnt.
     */
    _bauen: function (traeger, eintrag) {
      if (!eintrag.liste.length) {
        eintrag.shader = null;
        try { traeger.customShader = undefined; } catch (e) { /* entladen */ }
        return null;
      }

      var liste = eintrag.liste.slice().sort(function (a, b) {
        return (a.baustein.ordnung || 0) - (b.baustein.ordnung || 0);
      });

      var uniforms = {};
      var varyings = {};
      var helferVS = [], rumpfVS = [];
      var helferFS = [], rumpfFS = [];
      var licht = null, lichtVon = null;

      liste.forEach(function (s) {
        var b = s.baustein;

        Object.keys(b.uniforms || {}).forEach(function (k) {
          if (uniforms[k]) {
            console.warn('shader-verbund: Uniform "' + k + '" doppelt vergeben (' +
              s.name + '). Bausteine müssen ihre Uniform-Namen präfixen.');
          }
          uniforms[k] = b.uniforms[k];
        });

        Object.keys(b.varyings || {}).forEach(function (k) {
          if (varyings[k] && varyings[k] !== b.varyings[k]) {
            console.warn('shader-verbund: Varying "' + k + '" doppelt und ' +
              'mit verschiedenem Typ (' + s.name + ').');
          }
          varyings[k] = b.varyings[k];
        });

        if (b.helferVS) helferVS.push(b.helferVS);
        if (b.helferFS) helferFS.push(b.helferFS);

        // Der Name steht als Kommentar im erzeugten GLSL: wer im Browser in
        // den übersetzten Shader sieht (und das tut man, wenn etwas schwarz
        // bleibt), soll die Blöcke auseinanderhalten können.
        if (b.vertex) rumpfVS.push('  // ── ' + s.name + '\n  {\n' + b.vertex + '\n  }');
        if (b.fragment) rumpfFS.push('  // ── ' + s.name + '\n  {\n' + b.fragment + '\n  }');

        if (b.lightingModel !== undefined && b.lightingModel !== null) {
          if (licht === null) { licht = b.lightingModel; lichtVon = s.name; }
          else if (licht !== b.lightingModel) {
            console.warn('shader-verbund: zwei Beleuchtungsmodelle (' + lichtVon +
              ' und ' + s.name + ') — es gilt ' + lichtVon + '.');
          }
        }
      });

      var optionen = {
        uniforms: uniforms,
        varyings: varyings,
        mode: Cesium.CustomShaderMode.MODIFY_MATERIAL
      };
      if (licht !== null) optionen.lightingModel = licht;

      // Einen leeren `vertexShaderText` gibt es nicht: Cesium übersetzt ihn
      // mit, und ein `vertexMain`, das nichts tut, kostet bei jedem Vertex
      // einen Funktionsaufruf, den der Treiber nicht immer wegoptimiert.
      if (rumpfVS.length) {
        optionen.vertexShaderText =
          helferVS.join('\n') + '\n' +
          'void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {\n' +
          rumpfVS.join('\n') + '\n}';
      }
      if (rumpfFS.length) {
        optionen.fragmentShaderText =
          helferFS.join('\n') + '\n' +
          'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {\n' +
          rumpfFS.join('\n') + '\n}';
      }

      var shader;
      try {
        shader = new Cesium.CustomShader(optionen);
      } catch (e) {
        console.warn('shader-verbund: Shader nicht baubar', e, optionen);
        return eintrag.shader;
      }

      eintrag.shader = shader;
      try {
        traeger.customShader = shader;
      } catch (e) {
        console.warn('shader-verbund: Shader nicht setzbar', e);
      }

      var szene = BimViewer.viewer && BimViewer.viewer.scene;
      if (szene) szene.requestRender();
      return shader;
    }
  };

  BimViewer.ShaderVerbund = Verbund;
  window.ShaderVerbund = Verbund;

  console.log('✅ Shader-Verbund bereit');

})();
