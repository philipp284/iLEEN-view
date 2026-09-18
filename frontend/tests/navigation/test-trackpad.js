// Prüft die Rechenkerne der Trackpad-Steuerung im Flugmodus und die
// Greifweite auf dem Globus — ohne Browser.
//
// Aufruf:  node tests/navigation/test-trackpad.js
//
// Warum gerade diese Stellen: Ein Vorzeichenfehler beim Aufziehen sieht im
// Bild aus wie ein umgedrehtes Trackpad, und eine Drehung, die nicht linear im
// Mausweg ist, wie eine hakelige Maus — beides diskutiert man lange, bevor man
// es misst. Und die Greifweite ist eine einzige Ungleichung: liegt sie
// daneben, ist entweder das Ziehen tot oder der Sprung über die Landschaft
// wieder da.
//
// Was hier NICHT mehr steht: Randlenkung und Heimlauf des Fadenkreuzes. Beide
// sind mit dem Umstieg auf Pointer Lock entfallen (siehe Kopf von
// flug-trackpad.js) — das Kreuz steht fest in der Bildmitte, es gibt keinen
// Rand mehr, an dem etwas anderes passieren könnte, und nichts, das heimlaufen
// müsste. Ob der Zeiger sich wirklich einfangen lässt, sagt erst der Browser.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');   // frontend/

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}
const nahe = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ── Browser- und Cesium-Ersatz, gerade groß genug ─────────────────────────

class C3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  static clone(v, z) { z = z || new C3(); z.x = v.x; z.y = v.y; z.z = v.z; return z; }
}

const kontext = {
  window: {}, document: null, console: { log() {} }, performance: { now: () => 0 },
  setTimeout: () => 0, Cesium: { Cartesian3: C3, Math: { toDegrees: r => r * 180 / Math.PI, toRadians: g => g * Math.PI / 180 } },
};
kontext.window.window = kontext.window;
kontext.document = {
  readyState: 'complete',
  addEventListener() {}, getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  body: { appendChild() {} },
  activeElement: null,
};
kontext.window.document = kontext.document;
kontext.window.addEventListener = () => {};
kontext.window.setTimeout = kontext.setTimeout;
vm.createContext(kontext);

function laden(datei) {
  vm.runInContext(fs.readFileSync(path.join(WURZEL, datei), 'utf8'), kontext, { filename: datei });
}
laden('flug-trackpad.js');
laden('greifweite.js');

const T = kontext.window.FlugTrackpad._pruefsteine;
const G = kontext.window.Greifweite._pruefsteine;

// ── Öffnungswinkel aus dem Aufziehen ──────────────────────────────────────

pruefe('Aufziehen verkleinert den Öffnungswinkel (Tele)', T.pinchFov(60, -20) < 60);
pruefe('Zusammenziehen vergrößert ihn (Weitwinkel)', T.pinchFov(60, 20) > 60);
pruefe('ohne Weg bleibt der Winkel stehen', nahe(T.pinchFov(60, 0), 60));
pruefe('unterer Anschlag hält', T.pinchFov(60, -10000) === T.FOV_MIN);
pruefe('oberer Anschlag hält', T.pinchFov(60, 10000) === T.FOV_MAX);
pruefe('Anschläge sind 20° und 120°', T.FOV_MIN === 20 && T.FOV_MAX === 120);
// Multiplikativ: derselbe Wisch ändert bei 30° und 90° denselben Anteil.
{
  const a = T.pinchFov(30, -12) / 30;
  const b = T.pinchFov(90, -12) / 90;
  pruefe('gleicher Wisch = gleicher Anteil, egal bei welchem Winkel', nahe(a, b, 1e-9));
}
{
  const einmal = T.pinchFov(T.pinchFov(60, -8), -8);
  const doppelt = T.pinchFov(60, -16);
  pruefe('zwei kleine Schritte sind ein großer', nahe(einmal, doppelt, 1e-9));
}

// ── Wischweg ──────────────────────────────────────────────────────────────

pruefe('Wischweg wächst mit der Geschwindigkeitsstufe',
  T.schiebeWeg(100, 200) > T.schiebeWeg(100, 1));
pruefe('Wischweg ist linear im Pixelweg',
  nahe(T.schiebeWeg(200, 7), 2 * T.schiebeWeg(100, 7)));
pruefe('Vorzeichen bleibt erhalten', T.schiebeWeg(-100, 7) < 0);
pruefe('bei Stufe 3 (7 m/s) sind 300 px gut zwölf Meter',
  nahe(T.schiebeWeg(300, 7), 12.6, 1e-9));
pruefe('kein Weg ohne Wisch', T.schiebeWeg(0, 200) === 0);

// ── Umsehen: ein Betrag je Pixel, und nur einer ───────────────────────────
//
// Das war der Fehler der Vorgängerfassung: dieselbe Handbewegung drehte
// verschieden weit, je nachdem wo das Fadenkreuz gerade stand (in der Fläche
// 1:1, im Randstreifen zusätzlich bis 1,4 rad/s, während des Heimlaufs gar
// nicht). Mit gefangenem Zeiger gibt es diese Fallunterscheidung nicht mehr —
// und dass es sie nicht mehr gibt, ist genau das, was hier festgehalten wird.

T.empfindlichkeitSetzen(1);
pruefe('ohne Weg keine Drehung', T.drehWinkel(0) === 0);
pruefe('der Grundbetrag ist DREH_JE_PIXEL', nahe(T.drehWinkel(1), T.DREH_JE_PIXEL));
pruefe('doppelter Weg, doppelter Winkel', nahe(T.drehWinkel(200), 2 * T.drehWinkel(100)));
pruefe('Vorzeichen bleibt erhalten', T.drehWinkel(-50) < 0);
pruefe('hundert Pixel sind gut zwanzig Grad',
  nahe(T.drehWinkel(100) * 180 / Math.PI, 20.05, 0.01));
{
  // Zerlegt in zwei Bilder muss dasselbe herauskommen wie in einem — sonst
  // hinge die Drehgeschwindigkeit an der Bildrate.
  pruefe('in Teilschritten derselbe Winkel',
    nahe(T.drehWinkel(60) + T.drehWinkel(40), T.drehWinkel(100), 1e-12));
}

// ── Empfindlichkeit ───────────────────────────────────────────────────────

pruefe('halbe Empfindlichkeit, halber Winkel', (() => {
  const voll = T.drehWinkel(100);
  T.empfindlichkeitSetzen(0.5);
  const halb = T.drehWinkel(100);
  T.empfindlichkeitSetzen(1);
  return nahe(halb, voll / 2);
})());
pruefe('zu klein wird auf den unteren Anschlag gelegt',
  T.empfindlichkeitSetzen(0.001) === T.EMPF_MIN);
pruefe('zu groß wird auf den oberen Anschlag gelegt',
  T.empfindlichkeitSetzen(99) === T.EMPF_MAX);
pruefe('Unsinn lässt den Wert stehen',
  T.empfindlichkeitSetzen('abc') === T.EMPF_MAX);
T.empfindlichkeitSetzen(1);

// ── Schriftfeld-Sperre ────────────────────────────────────────────────────

pruefe('Eingabefeld sperrt WASD', T.istSchriftfeld({ tagName: 'input' }));
pruefe('Textbereich sperrt WASD', T.istSchriftfeld({ tagName: 'TEXTAREA' }));
pruefe('Auswahlliste sperrt WASD', T.istSchriftfeld({ tagName: 'SELECT' }));
pruefe('contentEditable sperrt WASD', T.istSchriftfeld({ tagName: 'DIV', isContentEditable: true }));
pruefe('gewöhnliches DIV sperrt nicht', !T.istSchriftfeld({ tagName: 'DIV' }));
pruefe('Canvas sperrt nicht', !T.istSchriftfeld({ tagName: 'CANVAS' }));
pruefe('nichts im Fokus sperrt nicht', !T.istSchriftfeld(null));

// ── Radweg über die drei Meldearten ───────────────────────────────────────

pruefe('Pixel bleiben Pixel', T.radWeg(120, 0) === 120);
pruefe('Zeilen werden zu Pixeln', T.radWeg(3, 1) === 48);
pruefe('Seiten werden zu Pixeln', T.radWeg(1, 2) === 400);

// ── Greifweite ────────────────────────────────────────────────────────────

G.einstellen(3, 30);
pruefe('am Boden greift man das Mindestmaß', G.grenze(0) === 30);
pruefe('unter dem Mindestmaß wird nicht enger', G.grenze(1.8) === 30);
pruefe('in 100 m Höhe reicht der Griff 300 m', G.grenze(100) === 300);
pruefe('in 2 km Höhe reicht er 6 km', G.grenze(2000) === 6000);
pruefe('unter Grund zählt der Betrag', G.grenze(-100) === 300);
pruefe('ohne Geländehöhe bleibt das Mindestmaß', G.grenze(null) === 30);

{
  const kamera = new C3(0, 0, 0);
  pruefe('der nahe Griff liegt innerhalb', !G.zuWeit(new C3(20, 0, 0), kamera, 300));
  pruefe('der ferne Griff liegt außerhalb', G.zuWeit(new C3(20000, 0, 0), kamera, 300));
  pruefe('genau auf der Grenze noch innerhalb', !G.zuWeit(new C3(300, 0, 0), kamera, 300));
  pruefe('der Himmel (kein Treffer) bleibt der Himmel', !G.zuWeit(undefined, kamera, 300));
}

// ── Kürzen statt wegwerfen ────────────────────────────────────────────────
{
  const kamera = new C3(0, 0, 0);
  const nah = G.klemmen(new C3(20, 0, 0), kamera, 300);
  pruefe('der nahe Griff bleibt unangetastet', nah.x === 20);

  const fern = G.klemmen(new C3(20000, 0, 0), kamera, 300);
  pruefe('der ferne Griff rutscht auf die Grenze heran', nahe(fern.x, 300));
  pruefe('er bleibt dabei ein Griff', fern !== undefined && fern !== null);

  // Auf demselben Sehstrahl — sonst zöge es beim Ziehen zur Seite.
  const schraeg = G.klemmen(new C3(3000, 4000, 0), kamera, 500);
  pruefe('gekürzt wird entlang des Sehstrahls',
    nahe(schraeg.x / schraeg.y, 3 / 4, 1e-9));
  pruefe('und genau auf die erlaubte Weite',
    nahe(Math.hypot(schraeg.x, schraeg.y), 500));

  pruefe('der Himmel bleibt der Himmel', G.klemmen(undefined, kamera, 300) === undefined);
  // Cesium reicht seine eigenen Zwischenspeicher durch: dasselbe Objekt zurück.
  const scratch = new C3(9000, 0, 0);
  pruefe('gekürzt wird im übergebenen Objekt', G.klemmen(scratch, kamera, 300) === scratch);
}

// ── Zusammenspiel: Zug am Horizont in Augenhöhe ───────────────────────────
{
  // Auf 1,8 m über Grund den Horizont angefasst: rund 5 km entfernt.
  const weite = G.grenze(1.8);
  const kamera = new C3(0, 0, 0);
  const gekuerzt = G.klemmen(new C3(4800, 0, 0), kamera, weite);
  pruefe('in Augenhöhe wird der Horizontgriff auf das Mindestmaß gekürzt',
    nahe(gekuerzt.x, weite));
  pruefe('das Stück Straße vor den Füßen bleibt, wo es ist',
    G.klemmen(new C3(12, 0, 0), kamera, weite).x === 12);
}

console.log(fehler === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
