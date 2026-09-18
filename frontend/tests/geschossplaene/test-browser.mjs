// Die Geschossgrundrisse im echten Browser: Chrome headless über
// puppeteer-core (kein Projekt-Dependency — `npm i --no-save puppeteer-core`),
// gegen den laufenden Dev-Server auf Port 5183.
//
// Was hier und NUR hier geprüft werden kann, ist die **Texturzuordnung**.
// Der Kopf von geschossplaene.js leitet her, dass Cesium einer PlaneGraphics
// mit der Normalen +Z die Belegung
//
//     st (0,0) → lokale Ecke (−dx/2, −dy/2) → Bild UNTEN links
//     st (1,1) → lokale Ecke (+dx/2, +dy/2) → Bild OBEN rechts
//
// gibt, und das Canvas wird passend dazu gemalt. Stimmt die Herleitung nicht,
// liegt jeder Grundriss spiegelverkehrt über seinem Geschoss — und das sieht
// man einem symmetrischen Bürogrundriss erst an, wenn jemand eine Tür sucht,
// die auf der falschen Seite ist. Kein Prüfstein ohne GPU beantwortet das:
// die Zuordnung entsteht in Cesiums Geometrie und im Texturlader.
//
// Der Prüfstein legt deshalb ein Bild aus vier verschieden gefärbten
// Quadranten über den vom Modul selbst gebauten Weg (`_flaecheAnlegen`) in die
// Szene, schaut senkrecht von oben mit Norden nach oben und liest nach, welche
// Farbe wo ankommt. Ein Backend braucht er nicht — geprüft wird die Lage der
// Fläche, nicht der Inhalt des Schnitts.
//
// Aufruf:  npx vite --port 5183 &   node tests/geschossplaene/test-browser.mjs
//
// Endung .mjs, weil das package.json daneben CommonJS führt (der Prüfstein
// ohne Browser lädt die Module über require) — dieser hier ist ein Modul.

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
  () => !!(window.BimViewer?.viewer && window.BimViewer.Geschossplaene),
  { timeout: 60000 });

console.log('\n── Aufbau ────────────────────────────────────────────────');

const aufbau = await page.evaluate(async () => {
  const V = BimViewer.viewer;
  const S = V.scene;

  // Alles aus dem Bild, was die Farbprobe verfälschen könnte.
  try { BimViewer.ILeenLogo && BimViewer.ILeenLogo.verbergen(); } catch (e) { /* nicht geladen */ }
  S.skyBox.show = false;
  S.skyAtmosphere.show = false;
  S.backgroundColor = Cesium.Color.BLACK;
  V.entities.removeAll();
  // Der Globus lässt sich nicht dauerhaft abschalten — die App zeichnet ihn
  // wieder ein. Der Prüfkörper liegt deshalb in 3000 m Höhe: darüber ist
  // sicher nichts, und in 100 m steckte er im Gelände (dort kamen die Farben
  // der Landschaft zurück statt der des Testbildes).
  S.globe.show = false;

  // Vier Quadranten. Die Zuordnung ist die Frage des Prüfsteins:
  //   Bild oben links  → soll NORD-WEST werden
  //   Bild unten links → soll SÜD-WEST werden
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 128, 128);      // oben links
  ctx.fillStyle = '#00ff00'; ctx.fillRect(128, 0, 128, 128);    // oben rechts
  ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 128, 128, 128);    // unten links
  ctx.fillStyle = '#ffff00'; ctx.fillRect(128, 128, 128, 128);  // unten rechts

  // Ein Kunst-Modell an einer bekannten Stelle: die Tile-Matrix ist der
  // ENU-Frame dort, also X = Ost, Y = Nord, Z = oben — dieselbe Lage, die ein
  // getiltes IFC-Modell aus dem Backend mitbringt.
  const ursprung = Cesium.Cartesian3.fromDegrees(8.25, 50.0, 3000);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(ursprung);
  const asset = { name: 'Prüfkörper', jobId: 'test',
                  tileset: { root: { computedTransform: enu } } };
  const blatt = {
    name: 'EG', hoehe: 0, hoeheTile: 0, rang: 0,
    bild: { url: c.toDataURL('image/png'), breite: 40, hoehe: 40,
            mitteX: 0, mitteY: 0, bounds: [-20, -20, 20, 20] },
    plan: { figures: [] }, asset, flaeche: null, matrixVorher: null, schluessel: null,
  };

  // Über den Weg des Moduls, nicht über eine nachgebaute Fläche: geprüft
  // werden soll `_flaecheAnlegen()`, nicht meine Vorstellung davon.
  const G = BimViewer.Geschossplaene;
  G.deckung = 1.0;
  G.abstand = 0;
  G.gekoppelt = false;
  blatt.flaeche = G._flaecheAnlegen(asset, blatt);
  G.blaetter = [blatt];
  window.__pruefblatt = blatt;

  return { flaeche: !!blatt.flaeche };
});

pruefe('Die Fläche entsteht', aufbau.flaeche);

// Ein paar Bilder Zeit: die Textur wird asynchron geladen.
await new Promise((r) => setTimeout(r, 2500));

console.log('\n── Texturzuordnung ───────────────────────────────────────');

const probe = await page.evaluate(() => {
  const V = BimViewer.viewer;
  const S = V.scene;

  // Erst hier, nicht im Aufbau: die App fliegt beim Öffnen eine Kamerafahrt,
  // und die überschrieb ein früher gesetztes `setView` — im Bild lag dann die
  // Landschaft statt des Prüfkörpers, mit Farben, die zufällig plausibel
  // aussahen (grünliche Dunkelwerte um 30).
  V.camera.cancelFlight();
  S.globe.show = false;
  V.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(8.25, 50.0, 3045),
    orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
  });
  for (let i = 0; i < 8; i++) S.render();

  // `preserveDrawingBuffer: true` steht in core.js — der Puffer ist nach dem
  // Zeichnen also noch lesbar.
  const q = document.createElement('canvas');
  q.width = S.canvas.width; q.height = S.canvas.height;
  const ctx = q.getContext('2d');
  ctx.drawImage(S.canvas, 0, 0);

  const lies = (fx, fy) => {
    const d = ctx.getImageData(Math.round(q.width * fx), Math.round(q.height * fy), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  // Nahe der Mitte, damit die Probe sicher auf der Fläche liegt und nicht auf
  // ihrer Kante.
  const k = V.camera.positionCartographic;
  return {
    obenLinks: lies(0.42, 0.42),
    obenRechts: lies(0.58, 0.42),
    untenLinks: lies(0.42, 0.58),
    untenRechts: lies(0.58, 0.58),
    kamera: [Cesium.Math.toDegrees(k.longitude).toFixed(3),
             Cesium.Math.toDegrees(k.latitude).toFixed(3), Math.round(k.height)],
    globus: S.globe.show,
  };
});

/** Welcher Quadrant des Testbildes ist das? Beleuchtung dimmt, verfärbt aber nicht. */
function farbe([r, g, b]) {
  if (r < 25 && g < 25 && b < 25) return 'nichts';
  if (r > g * 2 && r > b * 2) return 'rot';
  if (g > r * 2 && g > b * 2) return 'grün';
  if (b > r * 2 && b > g * 2) return 'blau';
  if (r > b * 2 && g > b * 2) return 'gelb';
  return 'unklar(' + [r, g, b].join(',') + ')';
}

const nw = farbe(probe.obenLinks);
const no = farbe(probe.obenRechts);
const sw = farbe(probe.untenLinks);
const so = farbe(probe.untenRechts);

console.log(`     Bildschirm:  NW=${nw}  NO=${no}  SW=${sw}  SO=${so}`);
console.log(`     Rohwerte:    NW=${probe.obenLinks} NO=${probe.obenRechts} ` +
            `SW=${probe.untenLinks} SO=${probe.untenRechts}`);
console.log(`     Kamera:      ${probe.kamera.join(' / ')}  ·  Globus ${probe.globus ? 'an' : 'aus'}`);

pruefe('Die Kamera steht über dem Prüfkörper',
       probe.kamera[0] === '8.250' && probe.kamera[1] === '50.000',
       'steht bei ' + probe.kamera.join(' / ') + ' — der Startflug der App hat sie weggezogen');

pruefe('Die Fläche ist überhaupt im Bild',
       [nw, no, sw, so].every((f) => f !== 'nichts'),
       'Kamera oder Textur fehlen');

// Die eigentliche Frage. „oben links im Bild" muss „Nord-West in der Welt"
// werden — sonst liegt jeder Grundriss spiegelverkehrt über seinem Geschoss.
pruefe('Die Bildoberkante liegt im Norden (nicht gespiegelt)',
       nw === 'rot' && no === 'grün',
       `oben steht ${nw}/${no}, erwartet rot/grün — das Bild liegt vertikal verkehrt`);
pruefe('Die Bildunterkante liegt im Süden',
       sw === 'blau' && so === 'gelb',
       `unten steht ${sw}/${so}, erwartet blau/gelb`);
pruefe('Links im Bild ist Westen (nicht seitenverkehrt)',
       nw === 'rot' && no === 'grün' && sw === 'blau',
       `NW=${nw}, NO=${no} — das Bild liegt horizontal verkehrt`);

console.log('\n── Stapel ────────────────────────────────────────────────');

const stapel = await page.evaluate(() => {
  const G = BimViewer.Geschossplaene;
  const blatt = window.__pruefblatt;
  blatt.rang = 2;
  G.abstandSetzen(5);
  return { hub: Cesium.Cartesian3.magnitude(
    Cesium.Matrix4.getTranslation(blatt.flaeche.modelMatrix, new Cesium.Cartesian3())) };
});

pruefe('Der Abstand hebt den Grundriss um Rang × Abstand',
       Math.abs(stapel.hub - 10) < 0.01, stapel.hub.toFixed(3) + ' m statt 10');

await page.screenshot({ path: 'tests/geschossplaene/1-texturlage.png' });

console.log('\n── Seitenfehler ──────────────────────────────────────────');
pruefe('Keine Ausnahme auf der Seite', seitenfehler.length === 0,
       seitenfehler.join(' | '));

await browser.close();

console.log('\n' + (fehler === 0 ? 'Alles in Ordnung.' : fehler + ' Prüfung(en) fehlgeschlagen.'));
process.exit(fehler === 0 ? 0 : 1);
