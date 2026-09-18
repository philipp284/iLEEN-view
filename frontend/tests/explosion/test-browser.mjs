// Die Explosionsansicht im echten Browser: Chrome headless über puppeteer-core
// (kein Projekt-Dependency — `npm i --no-save puppeteer-core`), gegen den
// laufenden Dev-Server auf Port 5182.
//
// Was hier und NUR hier geprüft werden kann:
//   · dass der erzeugte GLSL-Code sich übersetzen lässt. `czm_modelView` und
//     `czm_inverseModelView` sind automatische Uniforms, die Cesium erst beim
//     Übersetzen einsetzt — ob sie im Model-Shader überhaupt zur Verfügung
//     stehen, sagt kein Prüfstein ohne GPU. Ein Fehler darin bliebe im
//     Testlauf ohne Browser unsichtbar und wäre im Bild ein schwarzes Modell.
//   · dass die Verschiebung wirklich an den Entities ankommt, mit echten
//     Cesium-Positionen statt einer Attrappe
//   · dass die Ansicht beim Ausschalten spurlos zurückgeht
//
// Aufruf:  npx vite --port 5182 &   node tests/explosion/test-browser.mjs
//
// Endung .mjs, weil das package.json daneben CommonJS führt (test-explosion.js
// lädt explosion.js über require) — dieser Prüfstein dagegen ist ein Modul.

import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5182/';

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
await page.setViewport({ width: 1600, height: 1000 });
const seitenfehler = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => !!(window.BimViewer?.viewer && window.BimViewer.Explosion &&
           window.KonzeptStore && window.Konzept4D && window.Bauplaner),
  { timeout: 60000 });

pruefe('Das Modul ist geladen', true);

// ── 1 · Der Shader muss sich übersetzen lassen ────────────────────────────
//
// Geprüft an einem eigens geladenen glTF: es läuft über denselben
// Model-Renderer wie jedes 3D Tile, ist aber unabhängig davon, was der Viewer
// beim Start gerade in die Szene stellt. Ein GLSL-Fehler meldet sich in Cesium
// über `scene.renderError` — ohne diesen Horcher schluckt der Viewer ihn und
// zeigt nur ein leeres Bild.
const shader = await page.evaluate(async () => {
  const szene = BimViewer.viewer.scene;
  const fehler = [];
  const ab = szene.renderError.addEventListener((s, e) => fehler.push(String((e && e.message) || e)));

  const modell = await Cesium.Model.fromGltfAsync({
    url: 'Assets/ileen-logo.glb',
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(8.27, 50.0, 30)),
    scale: 20,
  });
  szene.primitives.add(modell);

  const baustein = BimViewer.Explosion._bausteinBauen([3.15, 6.15, 9.15]);
  let shader = null;
  let gesetzt = false;
  for (let i = 0; i < 90 && !fehler.length; i++) {
    szene.render();
    // Der Shader darf erst dran, wenn das Modell steht — vorher hat Cesium
    // noch keinen Zeichenbefehl, den er verändern könnte. Über den Verbund,
    // weil explosion.js selbst diesen Weg nimmt: geprüft werden soll der
    // Shader, der am echten Modell hängt, nicht ein danebengebauter.
    if (modell.ready && !gesetzt) {
      shader = BimViewer.ShaderVerbund.setzen(modell, 'explosion', baustein);
      gesetzt = true;
    }
    if (gesetzt && i > 60) break;
    await new Promise((r) => requestAnimationFrame(r));
  }
  // Noch ein paar Bilder MIT dem Shader — übersetzt wird er erst beim ersten
  // Zeichnen, und genau dabei fiele ein GLSL-Fehler an.
  for (let i = 0; i < 12; i++) {
    szene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  szene.primitives.remove(modell);
  ab();
  return { fehler, gesetzt, quelle: (shader && shader.vertexShaderText) || '' };
});

pruefe('Ein Modell zum Prüfen steht in der Szene', shader.gesetzt);
pruefe('Der Shader übersetzt ohne Fehler', shader.gesetzt && shader.fehler.length === 0,
  shader.fehler.join(' | '));
pruefe('Er benutzt die automatischen Uniforms',
  /czm_modelView/.test(shader.quelle) && /czm_inverseModelView/.test(shader.quelle));

// ── 1b · … und die Geometrie im Bild wirklich anheben ─────────────────────
//
// Dass der Shader übersetzt, heißt noch nicht, dass er misst. Diese Prüfung
// fragt das Bild selbst: Cesium zeichnet den Pick-Durchgang mit demselben
// Vertex-Shader, ein Treffer in der Bildmitte sagt also, wo die Geometrie
// nach der Verschiebung wirklich liegt.
//
//   · Trennebene ÜBER dem Modell  → Etage 0 → es steht still, Treffer.
//   · Trennebene UNTER dem Modell → Etage 1 → es fliegt 1000 m hoch, kein Treffer.
//
// Bliebe der zweite Fall ein Treffer, wäre `h` konstant null — der Fehler, den
// man ohne Bild nicht sieht.
const versatz = await page.evaluate(async () => {
  const szene = BimViewer.viewer.scene;
  const mitte = new Cesium.Cartesian2(szene.canvas.clientWidth / 2, szene.canvas.clientHeight / 2);

  const ort = Cesium.Cartesian3.fromDegrees(8.27, 50.0, 0);
  const modell = await Cesium.Model.fromGltfAsync({
    url: 'Assets/ileen-logo.glb',
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(ort),
    scale: 20,
  });
  szene.primitives.add(modell);

  const bilder = async (n) => {
    for (let i = 0; i < n; i++) {
      szene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  await bilder(60);

  szene.camera.lookAt(ort, new Cesium.HeadingPitchRange(0, -0.25, 400));
  await bilder(6);

  const trifft = () => {
    const treffer = szene.pick(mitte);
    return !!(treffer && treffer.primitive === modell);
  };

  /** Setzt Basis und Hochachse so, wie es die Wache im Betrieb tut. */
  const uniforms = (shader) => {
    const m = modell.modelMatrix;
    const basisWC = Cesium.Matrix4.multiplyByPoint(m, Cesium.Cartesian3.ZERO, new Cesium.Cartesian3());
    const obenWC = Cesium.Cartesian3.normalize(
      Cesium.Matrix4.multiplyByPointAsVector(m, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3()),
      new Cesium.Cartesian3());
    const sicht = szene.camera.viewMatrix;
    shader.setUniform('u_basisEC', Cesium.Matrix4.multiplyByPoint(sicht, basisWC, new Cesium.Cartesian3()));
    shader.setUniform('u_obenEC', Cesium.Matrix4.multiplyByPointAsVector(sicht, obenWC, new Cesium.Cartesian3()));
  };

  const ohne = trifft();

  // Trennebene über allem — Etage 0, das Modell bleibt stehen.
  const hoch = BimViewer.ShaderVerbund.setzen(
    modell, 'explosion', BimViewer.Explosion._bausteinBauen([1000]));
  hoch.setUniform('u_abstand', 1000);
  await bilder(10);
  uniforms(hoch);
  await bilder(4);
  const ruhig = trifft();

  // Trennebene unter allem — Etage 1, das Modell fliegt aus dem Bild.
  const tief = BimViewer.ShaderVerbund.setzen(
    modell, 'explosion', BimViewer.Explosion._bausteinBauen([-1000]));
  tief.setUniform('u_abstand', 1000);
  await bilder(10);
  uniforms(tief);
  await bilder(4);
  const geflogen = !trifft();

  BimViewer.ShaderVerbund.entfernen(modell, 'explosion');
  szene.primitives.remove(modell);
  szene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  return { ohne, ruhig, geflogen };
});

pruefe('Das Prüfmodell ist ohne Shader zu treffen', versatz.ohne);
pruefe('Unter der Trennebene bleibt es stehen', versatz.ruhig);
pruefe('Über der Trennebene hebt der Shader es aus dem Bild', versatz.geflogen);

// ── 2 · Baukörper aus dem Konzept, sechs Geschosse ────────────────────────

const aufbau = await page.evaluate(async () => {
  KonzeptStore.vorlageWaehlen('buerohaus');
  KonzeptStore.terminBerechnen();
  KonzeptPanel.simulationAufbauen();
  await new Promise((r) => setTimeout(r, 60));
  Konzept4D.setzeTag(Konzept4D.zustand.dauer);   // fertiges Haus, alles sichtbar
  const q = BimViewer.viewer.dataSources.getByName('konzept-4d')[0];
  return {
    koerper: Konzept4D.zustand.koerper.length,
    geschosse: [...new Set(Konzept4D.zustand.koerper.map((k) => k.geschoss).filter(Boolean))].length,
    entities: q ? q.entities.values.filter((e) => e._konzept4d).length : 0,
  };
});
pruefe('Die Simulation steht', aufbau.entities > 500 && aufbau.geschosse >= 5,
  JSON.stringify(aufbau));

/** Höhe einer Körper-Entity über dem Ellipsoid. */
const hoehen = () => page.evaluate(() => {
  const q = BimViewer.viewer.dataSources.getByName('konzept-4d')[0];
  const zeit = BimViewer.viewer.clock.currentTime;
  const nachGeschoss = {};
  Konzept4D.zustand.koerper.forEach((k) => { nachGeschoss[k.id] = k.geschoss; });
  const proGeschoss = {};
  q.entities.values.forEach((e) => {
    const g = nachGeschoss[e._konzept4d];
    if (!g || !e.position) return;
    const p = e.position.getValue(zeit);
    if (!p) return;
    const h = Cesium.Cartographic.fromCartesian(p).height;
    if (proGeschoss[g] === undefined || h < proGeschoss[g]) proGeschoss[g] = h;
  });
  return proGeschoss;
});

const vorher = await hoehen();
/**
 * Kamera auf alles, was in der Szene steht. Nicht `Konzept4D.hinfliegen()`:
 * das fliegt mit Dauer, und ein Bild kurz danach zeigt die halbe Strecke.
 */
const blickAufsHaus = (reserve) => page.evaluate(async (reserve) => {
  const q = BimViewer.viewer.dataSources.getByName('konzept-4d')[0];
  const zeit = BimViewer.viewer.clock.currentTime;
  const punkte = q.entities.values
    .filter((e) => e._konzept4d && e.show && e.position)
    .map((e) => e.position.getValue(zeit))
    .filter(Boolean);
  const kugel = Cesium.BoundingSphere.fromPoints(punkte);
  BimViewer.viewer.camera.flyToBoundingSphere(kugel, {
    duration: 0,
    offset: new Cesium.HeadingPitchRange(0.9, -0.35, kugel.radius * reserve),
  });
  for (let i = 0; i < 20; i++) {
    BimViewer.viewer.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
}, reserve);

await blickAufsHaus(2.6);
await page.screenshot({ path: 'tests/explosion/1-geschlossen.png' });

await page.evaluate(() => BimViewer.Explosion.abstandSetzen(6));
await blickAufsHaus(2.2);
await page.screenshot({ path: 'tests/explosion/2-explodiert.png' });
const nachher = await hoehen();

const keys = Object.keys(vorher).sort((a, b) => vorher[a] - vorher[b]);
const zuwachs = keys.map((k) => nachher[k] - vorher[k]);

pruefe('Die Ansicht schaltete sich mit dem Regler ein',
  await page.evaluate(() => BimViewer.Explosion.aktiv));
pruefe('Das unterste Geschoss bleibt liegen', Math.abs(zuwachs[0]) < 0.01,
  keys[0] + ': ' + zuwachs[0]?.toFixed(2) + ' m');
pruefe('Jedes Geschoss steigt um genau einen Abstand mehr',
  zuwachs.every((z, i) => Math.abs(z - i * 6) < 0.01),
  keys.map((k, i) => `${k} +${zuwachs[i].toFixed(1)}`).join(', '));

await page.evaluate(() => BimViewer.Explosion.aus());
await new Promise((r) => setTimeout(r, 300));
const zurueck = await hoehen();
pruefe('Ausschalten stellt jede Höhe genau wieder her',
  keys.every((k) => Math.abs(zurueck[k] - vorher[k]) < 1e-6),
  keys.map((k) => (zurueck[k] - vorher[k]).toExponential(1)).join(', '));

// ── 3 · Keine Seitenfehler ────────────────────────────────────────────────

pruefe('Keine unbehandelten Fehler auf der Seite',
  seitenfehler.filter((m) => /explosion/i.test(m)).length === 0,
  seitenfehler.join(' | '));

await page.screenshot({ path: 'tests/explosion/3-zurueck.png' });
console.log('\n  Bilder: tests/explosion/1-geschlossen.png · 2-explodiert.png · 3-zurueck.png');

await browser.close();
console.log(fehler === 0 ? '\nAlles in Ordnung.\n' : `\n${fehler} Prüfung(en) fehlgeschlagen.\n`);
process.exit(fehler === 0 ? 0 : 1);
