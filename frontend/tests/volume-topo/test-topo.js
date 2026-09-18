// Prüft die Rechenteile des topografischen Aufmaßes ohne Szene und ohne
// Cesium: Einsortieren der Punkte, Lückenfüllung, Flächenanteil am Rand,
// Prismensumme, Bezugsebene (auch geneigt), runde Schrittweiten, Farbverlauf
// und der `.pnts`-Leser.
//
// Nicht abgedeckt ist alles, was einen laufenden Viewer braucht — das Lesen
// der Splatpuffer, das Laden der Kacheln, das Zeichnen der Karte und die
// Oberfläche in der Szene. Das muss im Browser geprüft werden.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = path.join(__dirname, '..', '..', 'volume-topo.js');

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  document: { getElementById: () => null },
  TextDecoder,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'volume-topo.js' });

const I = sandbox.TopoVolume._internals;

let failed = 0;
function check(name, actual, expected, tolerance = 1e-9) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failed++;
  console.log(`${name.padEnd(42)}: ${ok ? '✓' : `✗  ${actual} statt ${expected}`}`);
}
function checkTrue(name, value) {
  if (!value) failed++;
  console.log(`${name.padEnd(42)}: ${value ? '✓' : '✗'}`);
}

const bounds = { minX: 0, maxX: 2, minY: 0, maxY: 2 };
const square = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];

// ── Punkte einsortieren ─────────────────────────────────────────────────────
// Vier Maschen à 1 m². In die Masche unten links fallen drei Punkte mit
// 10 / 12 / 14 m, in die übrigen je einer.
const cloud = {
  n: 6,
  xs: [0.2, 0.5, 0.8, 1.5, 0.5, 1.5],
  ys: [0.2, 0.5, 0.8, 0.5, 1.5, 1.5],
  hs: [10, 12, 14, 20, 30, 40],
};

const mittel = I.binPoints(cloud, bounds, 1, 'mittel');
check('Masche 0 — Mittel dreier Punkte', mittel.h[0], 12);
check('Masche 0 — Punktzahl', mittel.cnt[0], 3);
check('Masche 1 — einzelner Punkt', mittel.h[1], 20);
check('Masche 3 — einzelner Punkt', mittel.h[3], 40);

const hoch = I.binPoints(cloud, bounds, 1, 'hoch');
check('Masche 0 — höchster Punkt', hoch.h[0], 14);
const tief = I.binPoints(cloud, bounds, 1, 'tief');
check('Masche 0 — tiefster Punkt', tief.h[0], 10);

// Punkte außerhalb des Rechtecks fallen heraus, statt den Rand zu verbiegen.
const outside = I.binPoints(
  { n: 2, xs: [-5, 7], ys: [0.5, 0.5], hs: [1, 1] }, bounds, 1, 'mittel');
checkTrue('Punkte außerhalb zählen nicht', outside.cnt.every((c) => c === 0));

// ── Lücken füllen ───────────────────────────────────────────────────────────
// Ein Loch mitten in einem 3×3-Feld wird aus acht Nachbarn ergänzt …
const grid3 = {
  nx: 3, ny: 3, cell: 1, x0: 0, y0: 0,
  h: Float64Array.from([1, 1, 1, 1, NaN, 1, 1, 1, 1]),
  interpolated: new Uint8Array(9),
};
check('Loch aus der Nachbarschaft', I.fillGaps(grid3, 4), 1);
check('gefüllter Wert', grid3.h[4], 1);
check('als ergänzt vermerkt', grid3.interpolated[4], 1);

// … eine Masche mit nur einem gefüllten Nachbarn dagegen nicht: sonst zöge
// sich ein Randwert Masche für Masche über das ganze Feld.
const lonely = {
  nx: 3, ny: 1, cell: 1, x0: 0, y0: 0,
  h: Float64Array.from([5, NaN, NaN]),
  interpolated: new Uint8Array(3),
};
check('einzelner Nachbar füllt nicht', I.fillGaps(lonely, 4), 0);
checkTrue('Loch bleibt Loch', Number.isNaN(lonely.h[1]));

// ── Flächenanteil ───────────────────────────────────────────────────────────
const cov = I.coverageGrid({ nx: 2, ny: 2, cell: 1, x0: 0, y0: 0 }, square, 5);
checkTrue('innen liegende Maschen ganz', Array.from(cov).every((c) => c === 1));

// Ein Dreieck über demselben Feld: die Masche unten links liegt ganz drin,
// die diagonal gegenüber ganz draußen.
const triangle = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }];
const covT = I.coverageGrid({ nx: 2, ny: 2, cell: 1, x0: 0, y0: 0 }, triangle, 20);
check('Dreieck — Masche ganz innen', covT[0], 1);
check('Dreieck — Masche ganz außen', covT[3], 0);
check('Dreieck — Randmasche halb', covT[1], 0.5, 0.06);

// ── Prismensumme ────────────────────────────────────────────────────────────
// Vier Maschen à 1 m², Bezugshöhe 10 m, Höhen 12 / 11 / 10 / 8 m.
// Über Bezug: 2 + 1 + 0 = 3 m³   Unter Bezug: 2 m³   Netto: 1 m³
const flat = {
  nx: 2, ny: 2, cell: 1, x0: 0, y0: 0,
  h: Float64Array.from([12, 11, 10, 8]),
  coverage: Float32Array.from([1, 1, 1, 1]),
};
const sums = I.integrate(flat, { a: 10, b: 0, c: 0 });
check('Auftrag über Bezugsebene', sums.cut, 3);
check('Abtrag unter Bezugsebene', sums.fill, 2);
check('Netto', sums.cut - sums.fill, 1);
check('belegte Maschen', sums.cells, 4);
check('kleinste Höhe', sums.hmin, 8);
check('größte Höhe', sums.hmax, 12);
check('mittlere Höhe', sums.hmean, 10.25);
check('belegte Fläche', sums.area, 4);

// Der Flächenanteil geht linear ein — eine halb im Polygon liegende Masche
// zählt halb.
const half = { ...flat, coverage: Float32Array.from([0.5, 1, 1, 1]) };
check('halbe Masche zählt halb', I.integrate(half, { a: 10, b: 0, c: 0 }).cut, 2);

// Löcher zählen nicht mit — sie mit der Bezugshöhe anzusetzen hieße zu
// behaupten, dort läge das Gelände genau auf Null. Die verlorene Fläche wird
// stattdessen ausgewiesen.
const holed = {
  ...flat,
  h: Float64Array.from([12, NaN, 10, 8]),
};
const holedSums = I.integrate(holed, { a: 10, b: 0, c: 0 });
check('Loch ohne Volumen', holedSums.cut, 2);
check('Loch nicht in der Fläche', holedSums.area, 3);
check('Lochfläche ausgewiesen', holedSums.holeArea, 1);

// Die Maschenweite geht quadratisch ein: 0,5 m Masche → 0,25 m² Fläche.
const fine = { ...flat, cell: 0.5 };
check('Maschenfläche skaliert', I.integrate(fine, { a: 10, b: 0, c: 0 }).cut, 3 * 0.25);

// ── Bezugsebene ─────────────────────────────────────────────────────────────
const ctx = { ring: square, cornerHeights: [10, 12, 14, 12], center: { x: 1, y: 1 } };
check('tiefste Ecke', I.referencePlane(ctx, { reference: 'tiefste' }).a, 10);
check('Mittel der Ecken', I.referencePlane(ctx, { reference: 'mittel' }).a, 12);
check('feste Höhe', I.referencePlane(ctx, { reference: 'fest', fixedHeight: 7.5 }).a, 7.5);

// Die geneigte Ebene: die vier Ecken liegen exakt auf h = 10 + x + y, also
// muss die Ausgleichsebene genau diese Ebene sein.
const tilted = I.referencePlane(ctx, { reference: 'geneigt' });
check('geneigt — Steigung Ost', tilted.b, 1, 1e-9);
check('geneigt — Steigung Nord', tilted.c, 1, 1e-9);
check('geneigt — Höhe im Ursprung', tilted.a, 10, 1e-9);
check('geneigt — Höhe in der Mitte', I.planeAt(tilted, 1, 1), 12, 1e-9);

// Liegen alle Ecken auf einer Geraden, ist das Gleichungssystem entartet —
// dann bleibt es beim Mittel, statt eine Ebene zu erfinden.
const collinear = I.fitPlane(
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], [10, 11, 12], { x: 1, y: 0 });
check('entartet → Mittel', collinear.a, 11);
check('entartet → waagerecht', collinear.b, 0);

// Gegen eine geneigte Bezugsebene ist ein gleichmäßig geneigtes Gelände
// ausgeglichen — genau der Fall, den eine waagerechte Ebene falsch bilanziert.
const slope = {
  nx: 2, ny: 2, cell: 1, x0: 0, y0: 0,
  h: Float64Array.from([11, 12, 12, 13]),   // h = 10 + x + y in den Maschenmitten
  coverage: Float32Array.from([1, 1, 1, 1]),
};
const onSlope = I.integrate(slope, { a: 10, b: 1, c: 1 });
check('geneigte Bezugsebene — Auftrag', onSlope.cut, 0, 1e-9);
check('geneigte Bezugsebene — Abtrag', onSlope.fill, 0, 1e-9);
check('waagerecht gerechnet — Auftrag', I.integrate(slope, { a: 10, b: 0, c: 0 }).cut, 8);

// ── Maschenweite und runde Schritte ─────────────────────────────────────────
check('runder Schritt 0,3 → 0,5', I.niceStep(0.3), 0.5);
check('runder Schritt 1,0 → 1,0', I.niceStep(1), 1);
check('runder Schritt 3,0 → 5,0', I.niceStep(3), 5);
check('runder Schritt 0 → 0', I.niceStep(0), 0);
check('runder Schritt über der Liste', I.niceStep(230), 300);

// 10 000 Punkte auf 100 m²: mittlerer Abstand 0,1 m, mal √6 ≈ 0,245 → 0,25 m.
check('Maschenweite aus der Dichte', I.autoCell(100, 10000), 0.25);
// Dünne Wolke: 100 Punkte auf 10 000 m² → 10 m Abstand, mal √6 ≈ 24,5 → 25 m.
check('Maschenweite bei dünner Wolke', I.autoCell(10000, 100), 25);
// Die Obergrenze für die Maschenzahl vergröbert selbsttätig — und sagt es.
const gedeckelt = I.chooseCell(1e8, 1e6, 0.02, { minX: 0, maxX: 10000, minY: 0, maxY: 10000 });
checkTrue('Maschenzahl gedeckelt', gedeckelt.cell > 0.02);
checkTrue('Vergröberung wird gemeldet', gedeckelt.forced === true);
check('gewünschte Weite bleibt bekannt', gedeckelt.asked, 0.02);

// Passt die Wunschweite, wird nichts verändert und nichts gemeldet.
const frei = I.chooseCell(100, 10000, 0.5, { minX: 0, maxX: 10, minY: 0, maxY: 10 });
check('freie Weite unverändert', frei.cell, 0.5);
checkTrue('freie Weite ohne Meldung', frei.forced === false);

// ── Bikubische Abtastung ────────────────────────────────────────────────────
// An den Maschenmitten muss exakt der gemessene Wert herauskommen — sonst
// verschiebt die Glättung die Höhen, statt nur die Linien zu runden.
const feld = {
  nx: 4, ny: 4, cell: 1, x0: 0, y0: 0,
  h: Float64Array.from([
    10, 11, 13, 16,
    11, 12, 14, 17,
    13, 14, 16, 19,
    16, 17, 19, 22,
  ]),
};
for (const [gx, gy] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
  check(`bikubisch trifft Masche ${gx},${gy}`,
    I.sample(feld, gx + 0.5, gy + 0.5), feld.h[gy * 4 + gx], 1e-9);
}

// Zwischen zwei Maschen darf nichts über die vier Nachbarn hinausschießen.
// Ein Überschwinger wäre keine Unschönheit, sondern eine Höhenlinie, die es
// nicht gibt.
const kante = {
  nx: 4, ny: 1, cell: 1, x0: 0, y0: 0,
  h: Float64Array.from([0, 0, 10, 10]),
};
const zwischen = I.sample(kante, 2.0, 0.5);   // genau zwischen h[1]=0 und h[2]=10
checkTrue('kein Überschwingen nach oben', zwischen <= 10 + 1e-9);
checkTrue('kein Überschwingen nach unten', zwischen >= 0 - 1e-9);

// Catmull-Rom selbst: bei t = 0 die zweite, bei t = 1 die dritte Stützstelle.
check('Catmull-Rom bei t=0', I.catmullRom(1, 2, 3, 4, 0), 2);
check('Catmull-Rom bei t=1', I.catmullRom(1, 2, 3, 4, 1), 3);

// Ein Loch in der 4×4-Nachbarschaft lässt auf bilinear zurückfallen — die
// Löcher bleiben damit genau so groß, wie sie gemessen wurden.
const mitLoch = {
  nx: 4, ny: 4, cell: 1, x0: 0, y0: 0,
  h: Float64Array.from(feld.h),
};
mitLoch.h[0] = NaN;                                   // Ecke der 4×4-Umgebung
check('Rückfall auf bilinear bei Loch',
  I.sample(mitLoch, 1.5, 1.5), I.bilinear(mitLoch, 1.5, 1.5), 1e-9);
// Fehlt eine der vier inneren Maschen, ist die Stelle selbst ein Loch.
mitLoch.h[5] = NaN;
checkTrue('inneres Loch bleibt Loch', Number.isNaN(I.sample(mitLoch, 1.5, 1.5)));

// ── Kartenauflösung ─────────────────────────────────────────────────────────
// Kleines Feld: drei Bildpunkte je Masche, wie angestrebt.
check('drei Bildpunkte je Masche', I.mapScale(100, 100), 3);
// Lange Kante: der Kantendeckel greift, nicht der Flächendeckel.
checkTrue('lange Kante gedeckelt', I.mapScale(4000, 50) * 4000 <= 4096 + 1);
// Großes quadratisches Feld: der Flächendeckel greift.
checkTrue('Fläche gedeckelt',
  I.mapScale(2000, 2000) ** 2 * 2000 * 2000 <= 4000000 + 1000);
// Und nie so weit herunter, dass gar nichts mehr übrig bleibt.
checkTrue('Auflösung mit Untergrenze', I.mapScale(100000, 100000) >= 0.25);

// ── Geometrie ───────────────────────────────────────────────────────────────
check('Fläche Quadrat 2×2', I.areaOf(square), 4);
check('Fläche gegen den Uhrzeigersinn', I.areaOf([...square].reverse()), 4);
// Eine doppelt gesetzte Ecke (Doppelklick) darf die Fläche nicht verändern.
check('Fläche mit doppelter Ecke',
  I.areaOf([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]), 4);
checkTrue('Punkt innen', I.isInside(1, 1, square));
checkTrue('Punkt außen', !I.isInside(3, 1, square));

// ── Farbverlauf ─────────────────────────────────────────────────────────────
const rgb = [0, 0, 0];
I.rampColor(I.RAMPS.hoehe, 0, rgb);
check('Verlauf unten — Rot', rgb[0], 47);
I.rampColor(I.RAMPS.hoehe, 1, rgb);
check('Verlauf oben — Rot', rgb[0], 244);
I.rampColor(I.RAMPS.hoehe, 0.125, rgb);
check('Verlauf zwischen zwei Stützstellen', rgb[0], 63);
// Über die Enden hinaus wird geklemmt, nicht extrapoliert.
I.rampColor(I.RAMPS.hoehe, 5, rgb);
check('Verlauf über 1 geklemmt', rgb[0], 244);
I.rampColor(I.RAMPS.hoehe, -5, rgb);
check('Verlauf unter 0 geklemmt', rgb[0], 47);

// Der zweipolige Verlauf hat in der Mitte ein neutrales Grau — kein dritter
// Farbton, sonst behauptet die Karte an der Bezugsebene eine Aussage.
I.rampColor(I.RAMPS.auftrag, 0.5, rgb);
checkTrue('zweipolig — neutrale Mitte', rgb[0] === rgb[1] && rgb[1] === rgb[2]);

// Die Stufenkarte legt jeden Wert auf die Mitte seiner Höhenstufe.
// Bereich 0…10 m, Stufe 2 m: 3,0 m liegt in [2,4) → Mitte 3,0 → t = 0,3.
check('Stufe — Mitte des Bandes', I.quantize(0.3, 0, 10, 2), 0.3);
check('Stufe — 4,5 m rastet auf 5,0', I.quantize(0.45, 0, 10, 2), 0.5);

// ── .pnts lesen ─────────────────────────────────────────────────────────────
function buildPnts(json, positions) {
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (text.length % 4)) % 4;
  const ftJson = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
  const ftBin = Buffer.from(new Float32Array(positions).buffer);
  const header = Buffer.alloc(28);
  header.write('pnts', 0, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(28 + ftJson.length + ftBin.length, 8);
  header.writeUInt32LE(ftJson.length, 12);
  header.writeUInt32LE(ftBin.length, 16);
  const all = Buffer.concat([header, ftJson, ftBin]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const pnts = I.parsePnts(buildPnts(
  { POINTS_LENGTH: 2, POSITION: { byteOffset: 0 }, RTC_CENTER: [100, 200, 300] },
  [1, 2, 3, 4, 5, 6]));
check('pnts — Punktzahl', pnts.count, 2);
check('pnts — erste Koordinate', pnts.positions[0], 1);
check('pnts — letzte Koordinate', pnts.positions[5], 6);
check('pnts — RTC_CENTER', pnts.rtc[1], 200);

// Draco-gepackte Kacheln werden erkannt und übersprungen, statt beim Lesen
// stillschweigend Unsinn zu ergeben.
const draco = I.parsePnts(buildPnts(
  { POINTS_LENGTH: 4, extensions: { '3DTILES_draco_point_compression': { properties: {} } } },
  []));
checkTrue('pnts — Draco erkannt', draco.draco === true);

// Etwas, das kein pnts ist, kommt als null zurück und nicht als Ausnahme.
const notPnts = Buffer.alloc(64);
notPnts.write('b3dm', 0, 'ascii');
checkTrue('pnts — fremdes Format abgewiesen',
  I.parsePnts(notPnts.buffer.slice(0, 64)) === null);

// ── Panel und Modul passen zusammen ─────────────────────────────────────────
//
// Das Panel steht in `ui.js`, die Bedienung in `volume-topo.js`, und
// verbunden sind sie allein über Element-IDs und Übersetzungsschlüssel. Ein
// Tippfehler darin bricht nichts hörbar — er lässt eine Einstellung still auf
// ihrem Vorgabewert stehen oder schreibt den Schlüssel als Beschriftung ins
// Panel. Beides fällt beim Lesen nicht auf, deshalb steht es hier.
const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'ui.js'), 'utf8');
const modul = fs.readFileSync(file, 'utf8');
const i18n = fs.readFileSync(path.join(__dirname, '..', '..', 'i18n.js'), 'utf8');

// Der Definitionsblock, nicht die Aufrufstelle — beide stehen in `ui.js`,
// und die Aufrufe liegen unmittelbar nebeneinander.
const panelBlock = ui.slice(ui.indexOf('getTopoVolumeContent() {'),
                            ui.indexOf('getClashContent() {'));

const imPanel = new Set([...panelBlock.matchAll(/id="(tv[A-Za-z]+)"/g)].map((m) => m[1]));
const imModul = new Set([...modul.matchAll(/getElementById\('(tv[A-Za-z]+)'\)/g)].map((m) => m[1]));
imModul.delete('tvProbe');   // wird vom Modul selbst erzeugt, nicht vom Panel

for (const id of imModul) {
  checkTrue(`Panel kennt #${id}`, imPanel.has(id));
}

// Umgekehrt: ein Bedienelement, das niemand ausliest, ist eine Attrappe.
// `tvMap` und `tvTools` sind reine Behälter, `tvOpacity` hängt am Regler.
for (const id of imPanel) {
  const genutzt = imModul.has(id)
    || new RegExp(`'${id}'|"${id}"`).test(modul)
    || panelBlock.includes(`TopoVolume.setOpacity(this.value)`) && id === 'tvOpacity';
  checkTrue(`Modul liest #${id}`, genutzt);
}

// Jeder Schlüssel muss in beiden Sprachen stehen — fehlt er, zeigt das Panel
// den Schlüsselnamen an.
const schluessel = [...new Set([...panelBlock.matchAll(/t\('(topo\.[A-Za-z]+)'\)/g)].map((m) => m[1]))];
checkTrue('Panel benutzt Übersetzungsschlüssel', schluessel.length > 10);
const deTeil = i18n.slice(0, i18n.indexOf("'surfaceVolume.title': 'Volume against surface'"));
const enTeil = i18n.slice(i18n.indexOf("'topo.title': 'Topographic survey'"));
for (const key of schluessel) {
  checkTrue(`deutsch: ${key}`, deTeil.includes(`'${key}':`));
  checkTrue(`englisch: ${key}`, enTeil.includes(`'${key}':`));
}

// Die Aufrufe im Panel müssen es auch geben.
const aufrufe = new Set([...panelBlock.matchAll(/TopoVolume\.([A-Za-z]+)\(/g)].map((m) => m[1]));
for (const name of aufrufe) {
  checkTrue(`TopoVolume.${name}() vorhanden`, typeof sandbox.TopoVolume[name] === 'function');
}

console.log(`\n${failed === 0 ? '✅ alles grün' : `❌ ${failed} Prüfung(en) fehlgeschlagen`}`);
process.exit(failed === 0 ? 0 : 1);
