// Die Bildprojektion im echten Browser: Chrome headless über puppeteer-core
// (kein Projekt-Dependency — `npm i --no-save puppeteer-core`), gegen den
// laufenden Dev-Server auf Port 5183.
//
// Was hier und NUR hier geprüft werden kann:
//
//   · **Dass der erzeugte GLSL-Code sich übersetzen lässt.** Der Prüfstein
//     ohne Browser rechnet die Uniforms nach, aber ob `texture()`, ein
//     `sampler2D` als Funktionsparameter und der zusammengesetzte Verbund auf
//     der GPU durchgehen, sagt keine Attrappe. Ein Fehler darin wäre im Bild
//     ein schwarzes oder unverändertes Modell — und ohne Browser unsichtbar.
//   · **Dass die Farbe am Bauteil ankommt.** Dass ein Shader übersetzt, heißt
//     nicht, dass er etwas tut: stünde das Tiefenband falsch herum oder fiele
//     uv aus dem Bereich, bliebe alles beim Alten und kein Fehler fiele an.
//   · **Dass das Tiefenband im Bild wirklich begrenzt** — die Zusage, ohne
//     die eine Projektion durch jede Wand des Modells leuchtete.
//   · **Dass Rückseitenschnitt und Projektion gemeinsam übersetzen.** Der
//     Fall, für den shader-verbund.js überhaupt gebaut ist.
//
// ## Der Prüfkörper
//
// Ein eigenes glTF, im Quelltext erzeugt: eine Platte von 100 × 100 m, blau,
// `KHR_materials_unlit`. Jedes davon hat seinen Grund.
//
//   · **Eigenes glTF statt eines Modells aus `Assets/`.** Es läuft über
//     denselben Model-Renderer wie jedes 3D Tile, bringt aber weder fremde
//     Beleuchtung noch ein anderes Modul mit, das es im Bild bewegt. Mit dem
//     iLEEN-Logo begann dieser Prüfstein — sein Modul (ileen-logo.js) hält es
//     im Orbit, und gemessen wurde am Ende der Himmel dahinter.
//   · **Unlit.** Dann IST die gezeichnete Farbe `material.diffuse`, und die
//     Messung beantwortet die Frage, die sie stellt. Unter einem PBR-Material
//     hinge das Ergebnis am Sonnenstand.
//   · **Die Kamera über `viewBoundingSphere`.** Der Viewer fliegt beim Start
//     noch seine eigene Ansicht an; eine von Hand gesetzte Kamera wird dabei
//     weggezogen, und gemessen wird ein leeres Bild.
//
// Aufruf:  npx vite --port 5183 &   node tests/bildprojektion/test-browser.mjs
//
// Endung .mjs, weil das package.json daneben CommonJS führt (der Prüfstein
// ohne Browser lädt die Module über vm/require).

import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5183/';

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });
const seitenfehler = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => !!(window.BimViewer?.viewer && window.BimViewer.Bildprojektion &&
           window.BimViewer.Bildebenen && window.BimViewer.ShaderVerbund),
  { timeout: 60000 });

pruefe('Die Module sind geladen', true);

const ergebnis = await page.evaluate(async () => {
  const szene = BimViewer.viewer.scene;
  const glsl = [];
  const ab = szene.renderError.addEventListener((s, e) => glsl.push(String((e && e.message) || e)));
  const bilder = async (n) => {
    for (let i = 0; i < n; i++) {
      szene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  // ── Die Platte ──────────────────────────────────────────────────────────
  const pos = new Float32Array([-50, -50, 0,  50, -50, 0,  50, 50, 0,  -50, 50, 0]);
  const nrm = new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1]);
  const idx = new Uint16Array([0, 1, 2,  0, 2, 3]);
  const roh = new Uint8Array(108);
  roh.set(new Uint8Array(pos.buffer), 0);
  roh.set(new Uint8Array(nrm.buffer), 48);
  roh.set(new Uint8Array(idx.buffer), 96);
  let bin = '';
  roh.forEach((v) => { bin += String.fromCharCode(v); });

  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{
      pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      doubleSided: true, extensions: { KHR_materials_unlit: {} }
    }],
    extensionsUsed: ['KHR_materials_unlit'],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-50, -50, 0], max: [50, 50, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 12 }],
    buffers: [{ byteLength: 108, uri: 'data:application/octet-stream;base64,' + btoa(bin) }]
  };

  // Lage im ENU-Rahmen des Ortes, an keiner Kamera hängend: die Platte liegt
  // WAAGERECHT, ihre Normale zeigt nach oben. Dazu die Kamera senkrecht von
  // oben — dann stehen Platte, Bildebene und Blickrichtung achsparallel, und
  // eine gemessene Abweichung ist ein Fehler und keine Schrägsicht. Es ist
  // zugleich der häufigste Fall in der Anwendung: ein Bestandsplan, der von
  // oben auf ein Geschoss projiziert wird.
  const ort = Cesium.Cartesian3.fromDegrees(8.27, 50.0, 500);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(ort);
  const spalte = (i) => {
    const c = Cesium.Matrix4.getColumn(enu, i, new Cesium.Cartesian4());
    return new Cesium.Cartesian3(c.x, c.y, c.z);
  };
  const rechts = spalte(0), oben = spalte(1), n = spalte(2);

  // Die ENU-Matrix IST die Lage der waagerechten Platte: ihre Spalten sind
  // Ost, Nord, Hoch, und das Quad liegt in der lokalen xy-Ebene.
  //
  // `upAxis: Z` ist der entscheidende Teil, und an ihm hing dieser Prüfstein
  // eine ganze Weile. glTF ist y-up; Cesium dreht jedes Modell deshalb beim
  // Laden um die x-Achse, damit es in seinem z-up-Rahmen aufrecht steht. Ein
  // Quad, das in der glTF-xy-Ebene angelegt ist, steht danach SENKRECHT. Von
  // oben gesehen war es eine Linie, und die Projektion fand auf ihm eine
  // Flächennormale, die quer zur Bildebene lag — der Neigungsfilter verwarf
  // es, völlig zu Recht. Mit `upAxis: Z` und `forwardAxis: X` bleibt die
  // Geometrie, wie sie im Puffer steht.
  const modell = await Cesium.Model.fromGltfAsync({
    gltf, modelMatrix: enu, upAxis: Cesium.Axis.Z, forwardAxis: Cesium.Axis.X
  });
  szene.primitives.add(modell);
  await bilder(40);

  const q = szene.canvas;
  const mitte = new Cesium.Cartesian2(q.clientWidth / 2, q.clientHeight / 2);
  // Die Kamera über Richtungsvektoren statt über Heading/Pitch: sie steht
  // 400 m auf der Plattennormalen und blickt frontal darauf. `viewBounding-
  // Sphere` und `lookAt` legen ihre Winkel im lokalen Ostnordoben-Rahmen aus,
  // und welche Seite man dabei zu sehen bekommt, ist eine Konvention, über die
  // man sich irren kann — hier gibt es nichts auszulegen.
  const auge = Cesium.Cartesian3.add(
    ort, Cesium.Cartesian3.multiplyByScalar(n, 400, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());
  const hinsehen = () => {
    szene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    szene.camera.setView({
      destination: auge,
      orientation: {
        direction: Cesium.Cartesian3.negate(n, new Cesium.Cartesian3()),
        up: rechts
      }
    });
  };

  // Gemessen wird die Bildmitte, unmittelbar nach dem Zeichnen: ohne
  // `preserveDrawingBuffer` ist der Puffer nur innerhalb desselben Bildes
  // gültig. Der Pick daneben sagt, ob überhaupt die Platte gemessen wurde —
  // ohne ihn misst man irgendwann den Himmel und hält ihn für ein Ergebnis.
  const messen = () => {
    hinsehen();
    szene.render();
    const px = szene.context.readPixels({
      x: Math.round(q.width / 2) - 20, y: Math.round(q.height / 2) - 20,
      width: 40, height: 40
    });
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
    const c = px.length / 4;
    const t = szene.pick(mitte);
    return { r: Math.round(r / c), g: Math.round(g / c), b: Math.round(b / c),
             trifft: !!(t && t.primitive === modell) };
  };

  hinsehen();
  await bilder(10);
  const aus = { blau: messen() };

  // ── Die Bildebene: rot, deckt die Platte, liegt in ihrer Ebene ──────────
  const leinwand = document.createElement('canvas');
  leinwand.width = 64; leinwand.height = 64;
  const ctx = leinwand.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 64, 64);

  const alsFeld = (v) => [v.x, v.y, v.z];
  const ebene = {
    id: 'pruef', titel: 'Prüfbild', quelle: { schluessel: 'pruef', index: 0 }, anker: null,
    mitte: alsFeld(ort), normale: alsFeld(n), rechts: alsFeld(rechts),
    breite_m: 200, hoehe_m: 200, drehung: 0, versatz: 0, deckkraft: 1, sichtbar: true,
    projektion: true, proj_tiefe: 5, proj_winkel: 30, proj_abstand: 0
  };
  BimViewer.Bildebenen._cache['pruef:0'] = leinwand.toDataURL('image/png');
  BimViewer.Bildebenen.ebenen.push(ebene);

  // Das Prüfmodell steht nicht in `loadedAssets`, ist aber genau der Träger,
  // um den es geht.
  const sammelnVorher = BimViewer.Bildprojektion._zieleSammeln;
  BimViewer.Bildprojektion._zieleSammeln = function () {
    const z = sammelnVorher.call(this);
    if (z.indexOf(modell) === -1) z.push(modell);
    return z;
  };

  BimViewer.Bildprojektion.nachziehen();
  await bilder(16);
  aus.rot = messen();
  aus.bausteine = BimViewer.ShaderVerbund.bausteine(modell).slice();
  aus.glslText = (modell.customShader && modell.customShader.fragmentShaderText) || '';

  // ── Das Tiefenband hält an ──────────────────────────────────────────────
  // Die Bildebene rückt 100 m nach oben, das Band bleibt bei 5 m: die Platte
  // liegt dann weit außerhalb und muss ihre eigene Farbe zurückbekommen.
  const weit = Cesium.Cartesian3.add(
    ort, Cesium.Cartesian3.multiplyByScalar(n, 100, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());
  ebene.mitte = alsFeld(weit);
  await bilder(10);
  aus.ausserhalb = messen();

  ebene.mitte = alsFeld(ort);
  await bilder(10);
  aus.wieder = messen();

  // ── Mit dem Rückseitenschnitt daneben ──────────────────────────────────
  BimViewer.ShaderVerbund.setzen(modell, 'rueckseite', {
    ordnung: 0, fragment: 'if (czm_backFacing()) { discard; }'
  });
  await bilder(12);
  aus.mitBeiden = messen();
  aus.bausteineBeide = BimViewer.ShaderVerbund.bausteine(modell).slice();

  // ── Ausschalten ────────────────────────────────────────────────────────
  BimViewer.Bildebenen.ebenen = BimViewer.Bildebenen.ebenen.filter((e) => e.id !== 'pruef');
  BimViewer.Bildprojektion.nachziehen();
  BimViewer.ShaderVerbund.entfernen(modell, 'rueckseite');
  await bilder(12);
  aus.danach = messen();
  aus.bausteineDanach = BimViewer.ShaderVerbund.bausteine(modell).slice();

  BimViewer.Bildprojektion._zieleSammeln = sammelnVorher;
  szene.primitives.remove(modell);
  szene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  ab();
  aus.glsl = glsl;
  return aus;
});

const zeig = (f) => `r${f.r} g${f.g} b${f.b}${f.trifft ? '' : ' (NICHT auf der Platte)'}`;
const istRot = (f) => f.trifft && f.r > 180 && f.b < 80;
const istBlau = (f) => f.trifft && f.b > 180 && f.r < 80;

pruefe('Die Platte steht blau im Bild', istBlau(ergebnis.blau), zeig(ergebnis.blau));
pruefe('Der Baustein steht am Modell',
  ergebnis.bausteine.includes('bildprojektion'), ergebnis.bausteine.join(', '));
pruefe('Der Shader übersetzt ohne Fehler',
  ergebnis.glsl.length === 0, ergebnis.glsl.join(' | '));
pruefe('Er sampelt die Textur des ersten Bildes',
  /texture\(bild, uv\)/.test(ergebnis.glslText) && /u_bp_bild0/.test(ergebnis.glslText));

pruefe('Die Projektion kommt im Bild an — die Platte wird rot',
  istRot(ergebnis.rot), `${zeig(ergebnis.blau)} → ${zeig(ergebnis.rot)}`);

pruefe('Außerhalb des Tiefenbands bleibt die Platte blau',
  istBlau(ergebnis.ausserhalb), zeig(ergebnis.ausserhalb));
pruefe('… und innerhalb wieder rot', istRot(ergebnis.wieder), zeig(ergebnis.wieder));

pruefe('Rückseitenschnitt und Projektion übersetzen gemeinsam',
  ergebnis.bausteineBeide.includes('rueckseite') &&
  ergebnis.bausteineBeide.includes('bildprojektion') && ergebnis.glsl.length === 0,
  ergebnis.bausteineBeide.join(', '));
pruefe('… und das Bild bleibt dabei rot', istRot(ergebnis.mitBeiden), zeig(ergebnis.mitBeiden));

pruefe('Ausgeschaltet ist die Platte wieder blau',
  istBlau(ergebnis.danach), zeig(ergebnis.danach));
pruefe('… und kein Baustein bleibt stehen',
  ergebnis.bausteineDanach.length === 0, ergebnis.bausteineDanach.join(', '));

pruefe('Keine Ausnahme auf der Seite', seitenfehler.length === 0, seitenfehler.join(' | '));

await browser.close();
console.log(`\n${fehler === 0 ? '✓ alles in Ordnung' : '✗ ' + fehler + ' Prüfung(en) fehlgeschlagen'}\n`);
process.exit(fehler === 0 ? 0 : 1);
