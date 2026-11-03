/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// SPLAT-FARBE — Gaussian Splats nicht doppelt aufhellen
//
// Cesiums Splat-Shader (PrimitiveGaussianSplatFS) schreibt die Farben aus dem
// Splat unverändert in den Bildpuffer. Das sind sRGB-Werte (f_dc → rgb).
//
//   · ohne HDR (Darstellungsstufe „Performance"): der Puffer wird so
//     angezeigt, wie er ist — die Farben stimmen.
//   · mit HDR (Balanced, Quality, Ultra): der Puffer gilt als LINEAR, danach
//     folgen Tonwertabbildung und Gammakodierung. Eine sRGB-Farbe, die dort
//     als linear durchgeht, wird ein zweites Mal aufgehellt — die Splats sind
//     überbelichtet und flau.
//
// Alle anderen Modelle linearisieren ihre Farbe im eigenen Shader; nur der
// Splat-Shader tut es nicht. Cesium leitet für HDR einen eigenen Befehl mit
// `#define HDR` ab, also genügt ein `#ifdef HDR` im Fragment-Shader: die
// Splat-Farbe wird nach linear gewandelt, bevor sie gemischt wird.
//
// Der Shader steht in Cesium als Modul und lässt sich nicht austauschen. Wir
// greifen an der einen Stelle ein, an der er in den ShaderBuilder wandert,
// und ersetzen genau die eine Ausgabezeile. Erkennt das Muster nichts (neue
// Cesium-Fassung), bleibt der Shader unverändert — Splats sehen dann aus wie
// vorher, nichts bricht.
// ===============================
'use strict';

(function () {
  if (typeof Cesium === 'undefined' || !Cesium.ShaderBuilder) return;
  var proto = Cesium.ShaderBuilder.prototype;
  if (proto._ileenSplatFarbe) return;

  var ALT = 'out_FragColor = vec4(v_splatColor.rgb * B , B);';
  var NEU = [
    '#ifdef HDR',
    '    vec3 splatRgb = czm_srgbToLinear(v_splatColor.rgb);',
    '#else',
    '    vec3 splatRgb = v_splatColor.rgb;',
    '#endif',
    '    out_FragColor = vec4(splatRgb * B , B);'
  ].join('\n');

  function umschreiben(text) {
    return (typeof text === 'string' && text.indexOf(ALT) >= 0) ? text.replace(ALT, NEU) : text;
  }

  var original = proto.addFragmentLines;
  proto.addFragmentLines = function (lines) {
    if (typeof lines === 'string') {
      lines = umschreiben(lines);
    } else if (Array.isArray(lines)) {
      lines = lines.map(umschreiben);
    }
    return original.call(this, lines);
  };
  proto._ileenSplatFarbe = true;

  window.SplatFarbe = { umschreiben: umschreiben, ALT: ALT, NEU: NEU };
})();
