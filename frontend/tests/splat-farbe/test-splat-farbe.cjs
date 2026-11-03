// Prüfstein: splat-farbe.js ersetzt genau die Ausgabezeile des Splat-Shaders.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
let fehler = 0;
const ok = (b, t) => { console.log((b ? '  ok  ' : 'FEHLT ') + t); if (!b) fehler++; };

const gesehen = [];
function ShaderBuilder() {}
ShaderBuilder.prototype.addFragmentLines = function (l) { gesehen.push(l); };
const ctx = { Cesium: { ShaderBuilder }, window: {} };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../splat-farbe.js'), 'utf8'), ctx);

const fs_src = fs.readFileSync(path.join(__dirname,
  '../../node_modules/@cesium/engine/Source/Shaders/PrimitiveGaussianSplatFS.glsl'), 'utf8');
const sb = new ShaderBuilder();
sb.addFragmentLines(fs_src);
ok(/#ifdef HDR/.test(gesehen[0]) && /czm_srgbToLinear\(v_splatColor\.rgb\)/.test(gesehen[0]), 'Splat-Shader (String): HDR-Zweig linearisiert');
ok(/splatRgb \* B , B/.test(gesehen[0]) && !/v_splatColor\.rgb \* B/.test(gesehen[0]), 'alte Ausgabezeile ist weg');
sb.addFragmentLines([fs_src, 'void x(){}']);
ok(/czm_srgbToLinear/.test(gesehen[1][0]) && gesehen[1][1] === 'void x(){}', 'Zeilenfeld: nur die Splat-Zeile umgeschrieben');
sb.addFragmentLines('void main(){ out_FragColor = vec4(1.0); }');
ok(gesehen[2] === 'void main(){ out_FragColor = vec4(1.0); }', 'fremde Shader bleiben unverändert');
new ShaderBuilder().addFragmentLines(fs_src);
ok((gesehen[3].match(/czm_srgbToLinear/g) || []).length === 1, 'genau eine Ersetzung');
console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
