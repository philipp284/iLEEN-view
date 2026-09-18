// Prüft die Maßrechnung des Aufmaßes ohne Cesium und ohne Szene: Strecken mit
// ihren Teilabständen, Fläche nach Newell, Umfang mit schließender Kante und
// die Box um einen gedrehten Umriss.
//
// Möglich wird das durch einen sehr kleinen Cesium-Ersatz: `nachOrt` und
// `nachWelt` bleiben die Einheitsabbildung, örtliches System und Weltsystem
// fallen damit zusammen und die Zahlen sind von Hand nachrechenbar. Genau
// diese Trennung ist der Grund, warum die Rechnung überhaupt in eigenen
// Funktionen steht: sie kennt keine Entities und keinen Viewer.
//
// Nicht abgedeckt: der Fang (braucht einen Tiefenpuffer), das Zeichnen und
// das Zusammenspiel mit `volume-topo.js`.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

class C3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  static clone(a) { return new C3(a.x, a.y, a.z); }
}
const Cesium = {
  Cartesian3: C3,
  Matrix4: {
    // Streng in der Prüfung des ersten Arguments — genau dort saß ein Fehler,
    // den ein nachsichtiger Ersatz durchgehen ließ: `liste.map(ort)` reicht
    // den Laufindex als zweites Argument weiter, und der landete als „Matrix"
    // im Umrechnen. Die Punkte blieben richtig, die Abstände wurden NaN.
    multiplyByPoint: (m, p, r) => {
      if (!m || typeof m !== 'object') throw new TypeError('Matrix4 erwartet, bekam ' + typeof m);
      r.x = p.x; r.y = p.y; r.z = p.z; return r;
    },
    inverse: (m) => m,
  },
  Transforms: { eastNorthUpToFixedFrame: () => ({}) },
};

const sandbox = { console: { log() {}, warn() {}, error() {} }, Cesium, performance, Intl, setInterval: () => 0 };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'aufmass.js'), 'utf8'),
  sandbox, { filename: 'aufmass.js' });

const A = sandbox.BimViewer.Aufmass;
A._Z.nachOrt = {}; A._Z.nachWelt = {};      // Einheitsabbildung, siehe oben
const { rechnen, boxAus } = A._intern;
const P = (x, y, z) => new C3(x, y, z);

let failed = 0;
function check(name, actual, expected, tol = 1e-9) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failed++;
  console.log(`${name.padEnd(46)}: ${ok ? '✓' : `✗  ${actual} statt ${expected}`}`);
}
function checkTrue(name, v) {
  if (!v) failed++;
  console.log(`${name.padEnd(46)}: ${v ? '✓' : '✗'}`);
}

// ── Strecke ─────────────────────────────────────────────────────────────────
const s = rechnen([P(0, 0, 0), P(3, 4, 0)]);
check('Strecke 3-4-5', s.laenge, 5);
check('ΔOst', s.strecken[0].dx, 3);
check('ΔNord', s.strecken[0].dy, 4);
check('ΔHöhe', s.strecken[0].dz, 0);
check('waagerechter Abstand', s.strecken[0].horizontal, 5);
check('Neigung waagerecht ist null', s.strecken[0].neigung, 0);
check('Maßzahl steht mittig', s.strecken[0].mitte.x, 1.5);
checkTrue('zwei Punkte geben keine Fläche', !s.flaeche);

// Die Neigung steht in Grad, nicht als Verhältnis dz/dh. Das Verhältnis
// sprengt an jeder steilen Kante: an einer 10 m hohen Fassadenkante mit 11 cm
// Grundrissversatz stand „90,07" da — sieht aus wie ein Gradmaß, ist keins,
// und der nächste Nachbar heißt unendlich.
const steil = rechnen([P(0, 0, 0), P(3, 0, 3)]);
check('Neigung 45°', steil.strecken[0].neigung, 45, 1e-9);
const senkrechtAb = rechnen([P(0, 0, 0), P(0.001, 0, -10)]);
checkTrue('senkrecht bleibt im Gradmaß', senkrechtAb.strecken[0].neigung > -90.001
  && senkrechtAb.strecken[0].neigung < -89.9);
check('waagerecht ist null Grad', rechnen([P(0, 0, 0), P(5, 0, 0)]).strecken[0].neigung, 0);

// ── Fläche, eben ────────────────────────────────────────────────────────────
const q = rechnen([P(0, 0, 0), P(4, 0, 0), P(4, 4, 0), P(0, 4, 0)]);
check('Quadrat 4×4', q.flaeche, 16, 1e-9);
check('Grundfläche gleich', q.flaecheHorizontal, 16, 1e-9);
check('Umfang mit schließender Kante', q.umfang, 16, 1e-9);
check('offene Kettenlänge ohne Schluss', q.laenge, 12, 1e-9);
check('Schwerpunkt in der Mitte', q.schwerpunkt.x, 2, 1e-9);

// Umgekehrter Umlaufsinn darf am Betrag nichts ändern.
const qr = rechnen([P(0, 4, 0), P(4, 4, 0), P(4, 0, 0), P(0, 0, 0)]);
check('Umlaufsinn ohne Wirkung', qr.flaeche, 16, 1e-9);

// ── Fläche, geneigt ─────────────────────────────────────────────────────────
//
// Die eine Stelle, an der eine Näherung teuer wäre: wer die Fläche im
// Grundriss rechnet, misst ein Dach als seine Aufstandsfläche.
const dach = rechnen([P(0, 0, 0), P(4, 0, 0), P(4, 4, 4), P(0, 4, 4)]);
check('geneigte Fläche in ihrer Ebene', dach.flaeche, 4 * Math.hypot(4, 4), 1e-9);
check('und ihre Grundfläche darunter', dach.flaecheHorizontal, 16, 1e-9);
checkTrue('geneigt ist größer als flach', dach.flaeche > dach.flaecheHorizontal);

// ── Box um einen gedrehten Umriss ───────────────────────────────────────────
//
// Ein Rechteck 6 × 2, um 30° gedreht. Achsparallel gerechnet käme eine Box
// von 6,20 × 4,73 heraus — also gut das Zweieinhalbfache der Fläche, die
// gemessen wurde. Die Hauptrichtung trifft die 6 × 2.
const g = 30 * Math.PI / 180;
const u = { x: Math.cos(g), y: Math.sin(g) }, v = { x: -Math.sin(g), y: Math.cos(g) };
const eck = (a, b, z) => P(a * u.x + b * v.x, a * u.y + b * v.y, z);
const gedreht = [eck(3, 1, 0), eck(-3, 1, 0), eck(-3, -1, 0), eck(3, -1, 1.5)];
const gb = rechnen(gedreht).box;
const seiten = [gb.laenge, gb.breite].sort((a, b) => a - b);
check('Box kurze Seite', seiten[0], 2, 1e-9);
check('Box lange Seite', seiten[1], 6, 1e-9);
check('Box hoch vom tiefsten zum höchsten', gb.hoehe, 1.5, 1e-9);
check('Boxunterkante', gb.unten, 0, 1e-9);
check('Boxoberkante', gb.oben, 1.5, 1e-9);
check('Boxmitte auf halber Höhe', gb.mitte.z, 0.75, 1e-9);
checkTrue('Drehung trifft 30° (mod 90°)',
  Math.abs(((gb.theta * 180 / Math.PI) % 90 + 90) % 90 - 30) < 1e-6);
check('Boxmitte im Ursprung (Ost)', gb.mitte.x, 0, 1e-9);
check('Boxmitte im Ursprung (Nord)', gb.mitte.y, 0, 1e-9);

// Achsparallel: die Box ist die Hüllbox selbst.
const achs = boxAus([P(0, 0, 0), P(6, 0, 0), P(6, 2, 0), P(0, 2, 0)]);
check('achsparallel: Länge', Math.max(achs.laenge, achs.breite), 6, 1e-9);
check('achsparallel: Breite', Math.min(achs.laenge, achs.breite), 2, 1e-9);

// Ein L-förmiger Umriss 6 × 6 — der Fall, an dem die Hauptachsenrechnung
// scheitert: ihre Achse liegt auf der Symmetriediagonalen und macht die Box
// 8,49 m lang. Das kleinste umschließende Rechteck findet die 6 × 6.
const L = boxAus([P(0, 0, 0), P(6, 0, 0), P(6, 2, 0), P(2, 2, 0), P(2, 6, 0), P(0, 6, 0)]);
check('L-Umriss: Box ist 6 × 6, nicht 8,49', Math.max(L.laenge, L.breite), 6, 1e-9);
check('L-Umriss: zweite Seite auch 6', Math.min(L.laenge, L.breite), 6, 1e-9);
check('L-Umriss: Mitte in Ost', L.mitte.x, 3, 1e-9);
check('L-Umriss: Mitte in Nord', L.mitte.y, 3, 1e-9);

// Ein Dreieck: das kleinste Rechteck liegt auf einer Seite und ist doppelt so
// groß wie die Fläche — die Probe darauf, dass wirklich das Minimum gesucht
// und nicht die erste Kante genommen wird.
const dreieck = boxAus([P(0, 0, 0), P(4, 0, 0), P(0, 3, 0)]);
check('Dreieck 3-4-5: Box ist 4 × 3', dreieck.laenge * dreieck.breite, 12, 1e-9);

// Eine senkrechte Kette hat im Grundriss keine Ausdehnung — sie darf nur
// keine Ausnahme werfen.
const senkrecht = boxAus([P(2, 2, 0), P(2, 2, 3)]);
check('senkrechte Kette: keine Grundfläche', senkrecht.laenge * senkrecht.breite, 0, 1e-12);
check('senkrechte Kette: volle Höhe', senkrecht.hoehe, 3, 1e-12);

// ── Kette aus vier Punkten ──────────────────────────────────────────────────
//
// Ab dem zweiten Punkt fiel die NaN-Rechnung an, deshalb wird hier über die
// ganze Kette geprüft und nicht nur an der ersten Strecke.
const vier = rechnen([P(0, 0, 0), P(3, 0, 0), P(3, 4, 1), P(0, 4, 1)]);
checkTrue('alle Strecken tragen Zahlen',
  vier.strecken.every((k) => [k.distanz, k.dx, k.dy, k.dz, k.horizontal].every(Number.isFinite)));
check('dritte Strecke stimmt', vier.strecken[2].distanz, 3, 1e-9);
checkTrue('Fläche und Box sind Zahlen',
  Number.isFinite(vier.flaeche) && Number.isFinite(vier.box.laenge));

// ── Ein einzelner Punkt ─────────────────────────────────────────────────────
const eins = rechnen([P(1, 2, 3)]);
check('ein Punkt: keine Länge', eins.laenge, 0);
checkTrue('ein Punkt: keine Fläche, keine Box', !eins.flaeche && !eins.box);
checkTrue('leere Kette gibt nichts zurück', rechnen([]) === null);

console.log(failed === 0 ? '\nAlle Prüfungen bestanden' : `\n${failed} Prüfung(en) fehlgeschlagen`);
process.exit(failed === 0 ? 0 : 1);
