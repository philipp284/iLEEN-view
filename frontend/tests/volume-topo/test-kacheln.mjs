// Die Kachelauswahl an einer echten py3dtiles-Punktwolke.
//
// Was hier und NUR hier zu beantworten ist: ob unter dem Polygon **überall**
// Punkte ankommen. Die Auswahl liest den Kachelbaum aus der `tileset.json`,
// löst eingebettete Tilesets auf und steigt so tief ab, wie das Budget
// zulässt — drei Schritte, die alle drei still danebengehen können, ohne dass
// ein Fehler entsteht. Was herauskommt, ist dann keine falsche Zahl, sondern
// eine Karte mit Löchern.
//
// Zwei Fehler standen hier einmal und werden jetzt festgehalten:
//
//   1. Eine Kachel, deren Kinder alle außerhalb des Polygons liegen, fiel aus
//      der Auswahl — weder Blatt noch weitergereicht. Der Ast endete am
//      Polygonrand, und mit ihm verschwanden seine Punkte. Das riss die
//      zusammenhängenden Löcher.
//   2. Eingebettete Tilesets (`content.uri` endet auf `.json`) wurden
//      übersprungen. py3dtiles lagert dort gerade die dichten Bereiche aus —
//      an dieser Wolke lagen vier von sechs Blättern in solchen Dateien.
//
// Zusammen ergaben sie: 0 von 720 Kacheln, 0 Punkte, 0 % Belegung.
//
// Aufruf:  npx vite --port 5193 &   node tests/volume-topo/test-kacheln.mjs
//
// Braucht das Backend mit der Punktwolke. Ist es nicht da, überspringt der
// Prüfstein sich selbst, statt rot zu werden — er prüft fremde Daten, und
// deren Fehlen ist kein Mangel am Code.

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5193';
const TILESET = process.env.TILESET
  || 'http://localhost:8100/tiles/95a481dd-513d-4a77-b931-c5d55e264ea5/tileset.json';

// Mit einem Bytebereich statt `HEAD`: nicht jeder Kachelserver beantwortet
// HEAD, und die Tileset-JSON ganz zu laden, nur um ihre Erreichbarkeit zu
// prüfen, kostet bei großen Bäumen ein Megabyte.
const erreichbar = await fetch(TILESET, { headers: { Range: 'bytes=0-63' } })
  .then((r) => r.ok || r.status === 206).catch(() => false);
if (!erreichbar) {
  console.log(`⚠️  übersprungen — ${TILESET} nicht erreichbar.`);
  console.log('   Backend starten oder TILESET= auf eine andere Punktwolke setzen.');
  process.exit(0);
}

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${name.padEnd(46)}: ${ok ? '✓' : `✗  ${extra}`}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('Seitenfehler:', e.message); failed++; });

/** Eine Messung über einem quadratischen Feld der gegebenen Kantenlänge. */
async function messen(seite) {
  await page.goto(
    `${VIEWER}/tests/volume-topo/echt.html?seite=${seite}&tileset=${encodeURIComponent(TILESET)}`,
    { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.ERGEBNIS && window.ERGEBNIS.fertig', { timeout: 180000 });
  return page.evaluate(() => window.ERGEBNIS);
}

// 70 m liegt ganz in der Wolke — dort muss die Belegung vollständig sein.
// Genau diese Größe stand im Fehlerbild bei 31 %.
const nah = await messen(70);
console.log(`70 × 70 m: ${nah.kacheln} Kacheln, ${nah.punkte.toLocaleString('de-DE')} Punkte, `
  + `${nah.belegtProzent} % belegt\n`);

check('Kacheln werden ausgewählt', nah.kacheln > 20, `${nah.kacheln}`);
check('Punkte kommen an', nah.punkte > 100000, `${nah.punkte}`);
check('Fläche vollständig belegt', nah.belegtProzent >= 95, `${nah.belegtProzent} %`);

// Der Baum muss tiefer gehen als die Stufen, die ohne Auflösung der
// eingebetteten Tilesets sichtbar sind — sonst wurden sie nicht aufgelöst.
const sichtbar = nah.ueberlappend.reduce((a, b) => a + (b || 0), 0);
check('eingebettete Kachelbäume aufgelöst', nah.kacheln > sichtbar,
  `${nah.kacheln} Kacheln gegen ${sichtbar} ohne Auflösung`);

// Ein Feld über die ganze Wolke hinaus: die Auswahl darf nicht mehr Punkte
// verlieren, nur weil das Polygon größer ist. Weniger Belegung ist hier
// richtig — dort sind schlicht keine Daten mehr —, aber die Punktzahl muss
// stehen bleiben.
const weit = await messen(250);
console.log(`\n250 × 250 m: ${weit.kacheln} Kacheln, ${weit.punkte.toLocaleString('de-DE')} Punkte, `
  + `${weit.belegtProzent} % belegt\n`);
check('große Fläche verliert keine Punkte', weit.punkte >= nah.punkte * 0.9,
  `${weit.punkte} gegen ${nah.punkte}`);
check('große Fläche bleibt im Budget', weit.kacheln <= 400, `${weit.kacheln}`);

await browser.close();
console.log(failed === 0 ? '\n✅ alles grün' : `\n❌ ${failed} Prüfung(en) fehlgeschlagen`);
process.exit(failed === 0 ? 0 : 1);
