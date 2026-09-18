// Die Karte im echten Browser: Chrome headless über puppeteer-core.
//
// Was hier und NUR hier zu beantworten ist: ob aus dem Geländemodell wirklich
// eine Karte wird. `renderMap` rechnet je Bildpunkt auf einer Leinwand —
// Maske, Verlauf, Schummerung und die Höhenlinien, die aus dem Gefälle
// entstehen statt aus verfolgten Linienzügen. Ohne Leinwand gibt es davon
// nichts zu sehen und nichts zu messen.
//
// Geprüft wird an einem gebauten Gelände (Kegel, Mulde, Loch, achteckiger
// Rand) mit bekannten Antworten:
//
//   · außerhalb des Polygons ist die Karte durchsichtig
//   · das Loch im Modell ist auch in der Karte ein Loch
//   · die Kuppe ist heller als der Fuß (der Verlauf läuft in die richtige
//     Richtung)
//   · die Nordwestflanke des Kegels ist heller als die Südostflanke
//     (Licht aus Nordwesten — die kartografische Übereinkunft)
//   · über der Bezugsebene ist die zweipolige Karte warm, darunter kalt
//
// Aufruf:  node tests/volume-topo/test-browser.mjs
// Das Blatt wird zusätzlich als PNG abgelegt, um es ansehen zu können.

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${name.padEnd(48)}: ${ok ? '✓' : `✗  ${extra}`}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--allow-file-access-from-files', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
page.on('pageerror', (e) => { console.error('Seitenfehler:', e.message); failed++; });

await page.goto('file://' + path.join(HIER, 'smoke.html'), { waitUntil: 'load' });
await page.waitForFunction('window.PRUEFUNG && window.PRUEFUNG.fertig', { timeout: 15000 });

const info = await page.evaluate(() => window.PRUEFUNG);
console.log(`Gelände: ${info.maschen} belegte Maschen, ${info.loch_m2.toFixed(0)} m² Loch, `
  + `Höhen ${info.hmin.toFixed(2)}–${info.hmax.toFixed(2)} m, netto ${info.netto.toFixed(1)} m³\n`);

check('Loch im Modell wird ausgewiesen', info.loch_m2 > 100, `${info.loch_m2}`);
check('Höhenlinienabstand automatisch gewählt',
  info.karten[0].interval > 0 && info.karten[0].interval <= 5, `${info.karten[0].interval}`);
check('zweipolige Skala symmetrisch',
  Math.abs(info.karten[2].from + info.karten[2].to) < 1e-6,
  `${info.karten[2].from} / ${info.karten[2].to}`);

/** Farbe eines Bildpunktes der reinen Karte (nicht des Blattes). */
const probe = (fall, x, y) => page.evaluate((fall, x, y) => {
  const optionen = [
    { ramp: 'hoehe', contours: true, hillshade: true, steps: false, interval: 0 },
    { ramp: 'hoehe', contours: true, hillshade: true, steps: true, interval: 1 },
    { ramp: 'auftrag', contours: true, hillshade: true, steps: false, interval: 0 },
    { ramp: 'hoehe', contours: false, hillshade: false, steps: false, interval: 0 },
  ][fall];
  const karte = TopoVolume._internals.renderMap(
    window.__grid, window.__plane, window.__ctx, optionen, window.__ergebnis);
  const d = karte.canvas.getContext('2d').getImageData(
    Math.round(x * karte.W), Math.round(y * karte.H), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}, fall, x, y);

// Die Bausteine für den Nachbau der Karte im Prüfstein bereitstellen.
await page.evaluate(() => {
  window.__grid = grid; window.__plane = plane; window.__ctx = ctx;
  window.__ergebnis = ergebnis;
});

// Bildpunkte in Anteilen der Karte (0…1), Zeile 0 ist Norden.
// Das Gelände ist 160 × 120 Maschen; y muss deshalb gespiegelt gelesen werden.
const P = (x, y) => [x / 160, 1 - y / 120];

const ecke = await probe(0, ...P(2, 2));            // außerhalb des Achtecks
check('außerhalb des Polygons durchsichtig', ecke[3] === 0, `Alpha ${ecke[3]}`);

const loch = await probe(3, ...P(26, 25));          // mitten im Loch
check('Loch bleibt ungezeichnet', loch[3] === 0, `Alpha ${loch[3]}`);

// Ohne Schummerung und ohne Linien ist die Farbe allein die Höhe.
const kuppe = await probe(3, ...P(55, 60));
const fuss = await probe(3, ...P(90, 100));
const hell = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
check('Kuppe heller als Fuß', hell(kuppe) > hell(fuss) + 30,
  `${hell(kuppe).toFixed(0)} gegen ${hell(fuss).toFixed(0)}`);

// Licht aus Nordwesten: die dem Licht zugewandte Flanke muss heller sein.
const nw = await probe(0, ...P(47, 68));
const so = await probe(0, ...P(63, 52));
check('Nordwestflanke heller als Südostflanke', hell(nw) > hell(so),
  `${hell(nw).toFixed(0)} gegen ${hell(so).toFixed(0)}`);

// Zweipolig: die Kegelkuppe liegt über der Bezugsebene (warm), die Mulde
// darunter (kalt).
const oben = await probe(2, ...P(55, 60));
const unten = await probe(2, ...P(115, 55));
check('über der Bezugsebene warm', oben[0] > oben[2], `r${oben[0]} b${oben[2]}`);
check('unter der Bezugsebene kalt', unten[2] > unten[0], `r${unten[0]} b${unten[2]}`);

const png = path.join(HIER, 'karte.png');
await page.screenshot({ path: png, fullPage: true });
console.log(`\nBlatt abgelegt: ${png}`);

await browser.close();
console.log(failed === 0 ? '\n✅ alles grün' : `\n❌ ${failed} Prüfung(en) fehlgeschlagen`);
process.exit(failed === 0 ? 0 : 1);
