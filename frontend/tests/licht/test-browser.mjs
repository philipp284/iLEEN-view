// Kunstlicht (licht.js) im echten Browser: Chrome headless über
// puppeteer-core (kein Projekt-Dependency — `npm i --no-save puppeteer-core`),
// gegen den laufenden Dev-Server.
//
// Was hier und NUR hier geprüft werden kann:
//   · dass sich der Licht-Baustein im Shader-Verbund ÜBERSETZEN lässt.
//     `fsInput.attributes.positionEC` und `material.normalEC` stehen in einem
//     Struct, das Cesium je Modell neu erzeugt — ob die Felder wirklich da
//     sind, sagt erst der GLSL-Übersetzer.
//   · dass die Grundaufhellung ein Modell messbar heller macht
//   · dass die Taschenlampe in der Bildmitte mehr Licht macht als am Rand.
//     Das ist der eigentliche Beweis für den Kegel: eine gleichmäßige
//     Aufhellung bestünde die Helligkeitsprüfung auch.
//   · dass „aus" den Ausgangszustand wiederherstellt (Baustein abgemeldet)
//
// Aufruf:  npx vite --port 5181 &   node tests/licht/test-browser.mjs
//          VIEWER_URL=http://localhost:5182/ überschreiben

import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5181/';

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${zusatz ? ' — ' + zusatz : ''}`);
  if (!ok) fehler++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600 });
const seitenfehler = [];
const konsole = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') konsole.push(m.text()); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !!(window.BimViewer?.viewer && window.BimViewer.Licht &&
                                    window.ShaderVerbund), { timeout: 90000 });

console.log('Cesium', await page.evaluate(() => Cesium.VERSION));

// ── Ein Modell in die Szene, an dem sich Licht messen lässt ──────────────
const aufbau = await page.evaluate(async () => {
  const v = BimViewer.viewer, szene = v.scene;
  window.__renderFehler = [];
  szene.renderError.addEventListener((s, e) => window.__renderFehler.push(String((e && e.message) || e)));
  v.camera.cancelFlight();
  BimViewer.ILeenLogo?.verbergen?.();

  window.__warten = async (bilder) => {
    for (let i = 0; i < bilder; i++) {
      szene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  // Nachts und ohne Gelände: die Sonne soll nicht mitleuchten, sonst misst
  // die Prüfung Sonne statt Kunstlicht.
  const nacht = new Date(); nacht.setHours(1, 0, 0, 0);
  v.clock.currentTime = Cesium.JulianDate.fromDate(nacht);
  szene.globe.show = false;
  szene.skyBox.show = false;
  szene.skyAtmosphere.show = false;
  szene.backgroundColor = Cesium.Color.BLACK;

  // Irgendein GLB, das wirklich ausgeliefert wird. iLEEN und iLEEN-view führen
  // nicht dieselben Beispieldaten — der Zuschnitt lässt `PSFS.glb` draußen —,
  // und Vite antwortet auf eine fehlende Datei mit der index.html statt mit
  // 404. Deshalb wird auf die glTF-Kennung geprüft, nicht auf den Status.
  const glb = async (pfad) => {
    try {
      const a = await (await fetch(pfad)).arrayBuffer();
      return new TextDecoder().decode(new Uint8Array(a, 0, 4)) === 'glTF';
    } catch (e) { return false; }
  };
  let quelle = null;
  for (const k of ['Assets/PSFS.glb', 'Assets/ileen-logo.glb']) {
    if (await glb(k)) { quelle = k; break; }
  }
  if (!quelle) return { ready: false, radius: 0, quelle: 'kein GLB gefunden' };

  const mitte = Cesium.Cartesian3.fromDegrees(8.27, 50.0, 0);
  const modell = await Cesium.Model.fromGltfAsync({
    url: quelle,
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(mitte),
  });
  szene.primitives.add(modell);
  for (let i = 0; i < 200 && !modell.ready; i++) await window.__warten(4);

  // Kamera so, dass das Modell das Bild füllt.
  const kugel = modell.boundingSphere;
  v.camera.viewBoundingSphere(kugel, new Cesium.HeadingPitchRange(0, -0.2, kugel.radius * 2.6));
  v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  await window.__warten(20);

  BimViewer.loadedAssets.set('__lichttest', { id: '__lichttest', name: 'Lichttest',
                                              isGLB: true, model: modell, visible: true });

  // Mittlere Helligkeit in einem Fenster um einen Bildanteil (0–1).
  window.__hell = (mx, my, w) => {
    szene.render();
    const q = szene.canvas;
    const c = document.createElement('canvas');
    c.width = q.width; c.height = q.height;
    c.getContext('2d').drawImage(q, 0, 0);
    const x0 = Math.round((mx - w / 2) * c.width), y0 = Math.round((my - w / 2) * c.height);
    const bw = Math.round(w * c.width), bh = Math.round(w * c.height);
    const d = c.getContext('2d').getImageData(x0, y0, bw, bh).data;
    let summe = 0;
    for (let i = 0; i < d.length; i += 4) summe += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return summe / (d.length / 4);
  };

  return { ready: modell.ready, radius: kugel.radius, quelle };
});
pruefe('Prüfmodell geladen', aufbau.ready,
       aufbau.quelle + (aufbau.ready ? ', r = ' + aufbau.radius.toFixed(1) + ' m' : ''));
if (!aufbau.ready) { await browser.close(); console.log('\nohne Prüfmodell keine Messung'); process.exit(1); }

// ── 1 · Grundaufhellung ──────────────────────────────────────────────────
const aufhellung = await page.evaluate(async () => {
  BimViewer.Licht.taschenlampe(false);
  BimViewer.Licht.aufhellungSetzen(0);
  await window.__warten(12);
  const dunkel = window.__hell(0.5, 0.5, 0.5);
  BimViewer.Licht.aufhellungSetzen(0.5);
  await window.__warten(12);
  const hell = window.__hell(0.5, 0.5, 0.5);
  return { dunkel, hell, baustein: ShaderVerbund.bausteine(BimViewer.loadedAssets.get('__lichttest').model) };
});
pruefe('Baustein angemeldet', aufhellung.baustein.includes('licht'), aufhellung.baustein.join(', '));
// Verhältnis, nicht Differenz: der Hintergrund ist schwarz und zählt in beiden
// Messungen 0, der Zuwachs liegt also ganz auf den Modellbildpunkten. Wie viel
// vom Bild das Modell füllt, ist je Prüfmodell verschieden (PSFS füllt es, das
// Logo nicht) — ein absoluter Schwellwert prüfte die Modellgröße mit.
pruefe('Grundaufhellung hellt auf',
       aufhellung.hell > aufhellung.dunkel * 1.1 && aufhellung.hell > aufhellung.dunkel + 0.5,
       aufhellung.dunkel.toFixed(1) + ' → ' + aufhellung.hell.toFixed(1) +
       ' (×' + (aufhellung.hell / Math.max(0.01, aufhellung.dunkel)).toFixed(2) + ')');

// ── 2 · Taschenlampe: Mitte heller als Rand ──────────────────────────────
const lampe = await page.evaluate(async () => {
  BimViewer.Licht.aufhellungSetzen(0);
  BimViewer.Licht.staerkeSetzen(3.0);
  BimViewer.Licht.weiteSetzen(12);       // enger Kegel, damit der Rand außen liegt
  BimViewer.Licht.reichweiteSetzen(500); // Modellgröße ist unbekannt — nicht die Reichweite prüfen
  BimViewer.Licht.taschenlampe(false);
  await window.__warten(12);
  const ausMitte = window.__hell(0.5, 0.5, 0.16);
  BimViewer.Licht.taschenlampe(true);
  await window.__warten(12);
  const anMitte = window.__hell(0.5, 0.5, 0.16);
  const anRand = window.__hell(0.12, 0.5, 0.16);
  const ausRand = (BimViewer.Licht.taschenlampe(false), await window.__warten(12),
                   window.__hell(0.12, 0.5, 0.16));
  return { ausMitte, anMitte, anRand, ausRand };
});
pruefe('Taschenlampe leuchtet die Mitte an',
       lampe.anMitte > lampe.ausMitte * 1.1 && lampe.anMitte > lampe.ausMitte + 0.5,
       lampe.ausMitte.toFixed(1) + ' → ' + lampe.anMitte.toFixed(1) +
       ' (×' + (lampe.anMitte / Math.max(0.01, lampe.ausMitte)).toFixed(2) + ')');
pruefe('Kegel begrenzt: Rand bleibt fast unberührt',
       (lampe.anMitte - lampe.ausMitte) > 3 * Math.max(0.5, lampe.anRand - lampe.ausRand),
       'Mitte +' + (lampe.anMitte - lampe.ausMitte).toFixed(1) +
       ', Rand +' + (lampe.anRand - lampe.ausRand).toFixed(1));

// ── 3 · Aus heißt aus ────────────────────────────────────────────────────
const zurueck = await page.evaluate(async () => {
  BimViewer.Licht.taschenlampe(false);
  BimViewer.Licht.aufhellungSetzen(0);
  await window.__warten(12);
  return ShaderVerbund.bausteine(BimViewer.loadedAssets.get('__lichttest').model);
});
pruefe('Baustein wieder abgemeldet', !zurueck.includes('licht'), zurueck.join(', ') || '(keine)');

// ── 4 · Nichts hat sich beschwert ────────────────────────────────────────
const renderFehler = await page.evaluate(() => window.__renderFehler);
const glsl = [...seitenfehler, ...konsole, ...renderFehler]
  .filter((t) => /shader|glsl|compile|u_licht/i.test(t));
pruefe('kein Shader-Fehler', glsl.length === 0, glsl.slice(0, 2).join(' | '));

// ── 5 · Wassermaske ──────────────────────────────────────────────────────
const wasser = await page.evaluate(() => ({
  effekt: BimViewer.viewer.scene.globe.showWaterEffect,
  maske: !!BimViewer.viewer.terrainProvider.hasWaterMask,
  gelaende: BimViewer.viewer.terrainProvider.constructor.name,
}));
pruefe('Wassereffekt an', wasser.effekt === true);
pruefe('Gelände liefert Wassermaske', wasser.maske || wasser.gelaende === 'EllipsoidTerrainProvider',
       wasser.gelaende + (wasser.maske ? ' mit Maske' : ' ohne Maske (kein ion-Token?)'));

await browser.close();
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nalle Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
