// Prüfsteine der Präsentation (praesentation-text.js, praesentation.js) — ohne Browser.
//
// Geprüft wird, was man einer Vorführung nicht ansieht, solange sie „irgendwie
// läuft":
//
//   · Der Text: Der Dialekt schaltet nur dort um, wo ein Gegenstück folgt
//     (ein einzelnes `*` kippt nicht den Rest des Labels), snake_case bleibt
//     heil, und FREMDER TEXT kommt maskiert ins DOM — ein Label ist ein
//     Textfeld, dessen Inhalt als HTML ausgegeben wird.
//   · Die Fahrt geht um die Erde herum, nicht durch sie hindurch: zwischen zwei
//     Punkten auf dem Äquator liegt die Mitte auf der Kugel und nicht auf der
//     Sehne. Der Kurs nimmt den kurzen Weg über die 360°-Marke.
//   · Die Zeitachse: Pose, Text und Deckkraft zu jedem Zeitpunkt. Video und
//     Vorschau fragen dieselbe Funktion, deshalb hängt an ihr alles.
//   · Der Zustand überlebt einen Neustart (localStorage) und eine Datei; ein
//     Deck aus splides wird mit Begründung abgewiesen statt stillschweigend
//     falsch gelesen.
//
// Nicht abgedeckt und nur im Browser prüfbar: das Label im DOM, die Leiste,
// das Canvas-Video. Siehe tests/praesentation/test-browser.mjs.
//
// Aufruf:  node tests/praesentation/test-praesentation.js

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const wurzel = join(hier, '..', '..');

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};
const nahe = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const GRAD = Math.PI / 180;

// ── Eine Umgebung mit Kamera-Attrappe ────────────────────────────────────────
class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
}


// Ein Element, das nur aufschreibt, was man damit tut — genug, um das Label
// und die Körperklassen zu prüfen, ohne einen Browser.
function fakeKnoten() {
  const klassen = new Set();
  const k = {
    children: [], className: '', innerHTML: '', textContent: '',
    style: { setProperty(n, v) { this[n] = v; } },
    classList: {
      add: (...c) => c.forEach((x) => klassen.add(x)),
      remove: (...c) => c.forEach((x) => klassen.delete(x)),
      contains: (c) => klassen.has(c),
      toggle: (c, an) => { if (an === undefined ? !klassen.has(c) : an) klassen.add(c); else klassen.delete(c); },
    },
    appendChild(x) { this.children.push(x); return x; },
    addEventListener() {}, remove() {},
    hasPointerCapture: () => false,
  };
  Object.defineProperty(k, 'className', {
    get: () => [...klassen].join(' '),
    set: (v) => { klassen.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => klassen.add(c)); },
  });
  return k;
}

function umgebung(lager = new Map()) {
  const kamera = {
    positionWC: { x: 6378137, y: 0, z: 0 },
    heading: 0.3, pitch: -0.4, roll: 0,
    frustum: { fov: 60 * GRAD },
    gesetzt: [],
    cancelFlight() {},
    setView(o) {
      this.gesetzt.push(o);
      this.positionWC = { x: o.destination.x, y: o.destination.y, z: o.destination.z };
      this.heading = o.orientation.heading;
      this.pitch = o.orientation.pitch;
      this.roll = o.orientation.roll;
    },
  };
  const meldungen = [];
  const welt = {
    Cesium: {
      Cartesian3,
      Math: { toDegrees: (r) => r / GRAD, toRadians: (g) => g * GRAD },
    },
    BimViewer: {
      viewer: { camera: kamera, scene: { screenSpaceCameraController: { enableInputs: true } } },
      updateStatus: (t, a) => meldungen.push([t, a]),
    },
    console: { log() {}, warn() {}, error: console.error },
    performance,
    innerWidth: 1280, innerHeight: 720,
    document: { createElement: fakeKnoten, body: fakeKnoten() },
    localStorage: {
      getItem: (k) => (lager.has(k) ? lager.get(k) : null),
      setItem: (k, v) => lager.set(k, v),
    },
  };
  welt.window = welt;
  createContext(welt);
  runInContext(readFileSync(join(wurzel, 'praesentation-text.js'), 'utf8'), welt);
  runInContext(readFileSync(join(wurzel, 'praesentation.js'), 'utf8'), welt);
  return { welt, kamera, lager, meldungen };
}

const { welt, kamera, lager } = umgebung();
const T = welt.PraesentationText;
const P = welt.Praesentation;
const I = P._intern;

pruefe('beide Module melden sich an', !!T && !!P);

// ═══════════════════════════════════════════════════════════════════════════
// 1 · Der Text
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nText');

const laeufe = (s) => T.markdownParsen(s)[0].runs;

{
  const r = laeufe('a **fett** b *schief* c');
  pruefe('fett und kursiv schalten um',
    r.some((x) => x.text === 'fett' && x.bold) && r.some((x) => x.text === 'schief' && x.italic));
  pruefe('der Rest bleibt unausgezeichnet',
    r.filter((x) => x.bold || x.italic).length === 2);
}
{
  const r = laeufe('ein * allein und snake_case_name');
  pruefe('ein einzelnes * kippt nicht den Rest', r.every((x) => !x.italic));
  pruefe('snake_case bleibt heil', r.map((x) => x.text).join('') === 'ein * allein und snake_case_name');
}
{
  const r = laeufe('\\*kein kursiv\\*');
  pruefe('Backslash maskiert', r.map((x) => x.text).join('') === '*kein kursiv*' && r.every((x) => !x.italic));
}
{
  const r = laeufe('ein [Wort]{sky} und [X]{javascript:1}');
  pruefe('Palettenfarbe wird aufgelöst', r.some((x) => x.text === 'Wort' && x.color === '#38bdf8'));
  pruefe('eine Nicht-Farbe bleibt wörtlicher Text',
    r.map((x) => x.text).join('').includes('[X]{javascript:1}') && r.every((x) => x.color !== 'javascript:1'));
}
{
  const r = laeufe('[Link](javascript:alert(1)) und [ok](https://a.de)');
  pruefe('javascript: wird kein Link', r.every((x) => !x.href || x.href.startsWith('https:')));
  pruefe('https: wird Schmuck-Link', r.some((x) => x.href === 'https://a.de'));
}
{
  const z = T.markdownParsen('# Titel\n- a\n  - b\n1. eins\n- [x] fertig\n> Zitat\n---\n-# klein');
  pruefe('Überschrift', z[0].level === 1);
  pruefe('Aufzählung und Einzug', z[1].kind === 'bullet' && z[2].kind === 'bullet' && z[2].indent === 1);
  pruefe('Nummerierung', z[3].kind === 'ordered' && z[3].marker === '1.');
  pruefe('Aufgabe mit Haken', z[4].kind === 'todo' && z[4].checked === true);
  pruefe('Zitat, Linie, Kleingedrucktes', z[5].kind === 'quote' && z[6].kind === 'rule' && z[7].small === true);
  const a = T.markdownParsen('::: right\nlinks oder rechts?\n::: left\nlinks');
  pruefe('::: schaltet die Ausrichtung ab der Zeile um', a[0].align === 'right' && a[1].align === 'left');
}
{
  const h = T.html('<script>alert(1)</script> & "x"');
  pruefe('Fremdtext wird maskiert', !h.includes('<script>') && h.includes('&lt;script&gt;') && h.includes('&amp;'));
  pruefe('ein Anführungszeichen landet nicht roh im Attribut', !/title="[^"]*"[^>]*"x"/.test(h));
  const f = T.html('**fett**');
  pruefe('HTML trägt <strong>', f.includes('<strong>fett</strong>') && f.includes('pmd-line'));
  const farbe = T.html('[rot]{#f00}');
  pruefe('Hex-Farbe geht ins style-Attribut', farbe.includes('style="color:#f00"'));
}
pruefe('Titel = erste nichtleere Zeile als Klartext', T.titel('\n\n## Der **Eingang**\nText') === 'Der Eingang');
pruefe('leerer Text ist leer', T.istLeer('  \n ') && !T.istLeer('x'));

{
  const s = T.stilNormalisieren({ theme: 'blink', scale: 99, width: -1, accent: 'url(evil)', anim: 'wobble', align: 'mitte' });
  pruefe('unbekannte Werte fallen auf die Vorgabe',
    s.theme === 'glass' && s.anim === 'fade' && s.align === 'center');
  pruefe('Zahlen werden geklemmt', s.scale === 2.5 && s.width >= 0.2 && s.width <= 0.96);
  pruefe('ein Akzent, der keine Farbe ist, kommt nicht ins CSS', s.accent === T.ACCENT);
  pruefe('ohne Angabe gilt die Vorgabe', T.stilNormalisieren().theme === 'glass');
}
{
  const a = T.animVersatz('up', 0), b = T.animVersatz('up', 1), z = T.animVersatz('zoom', 0);
  pruefe('Einblendung: t = 1 heißt an Ort und Stelle', b.dx === 0 && b.dy === 0 && b.scale === 1);
  pruefe('Einblendung von unten beginnt unterhalb', a.dy > 0);
  pruefe('Zoom beginnt kleiner', z.scale < 1);
}

// Der Canvas-Weg: ein Stift, der jeden Befehl mitschreibt.
{
  const befehle = [];
  const ctx = new Proxy({}, {
    get(_, name) {
      if (name === 'measureText') return (t) => ({ width: t.length * 10 });
      if (name === 'createLinearGradient') return () => ({ addColorStop() {} });
      return (...a) => { befehle.push([name, ...a]); };
    },
    set(_, name, wert) { befehle.push(['=' + String(name), wert]); return true; },
  });
  const quelle = {};
  T.zeichnen(ctx, quelle, { text: '# Titel\n- Punkt', opacity: 1, width: 1280, height: 720,
                            pos: { x: 0.5, y: 0.8 }, style: T.stilNormalisieren() });
  const texte = befehle.filter((b) => b[0] === 'fillText').map((b) => b[1]);
  pruefe('das Video-Label zeichnet seinen Text', texte.includes('Titel') && texte.includes('Punkt'));
  const vorher = befehle.length;
  T.zeichnen(ctx, quelle, { text: 'x', opacity: 0, width: 1280, height: 720, pos: { x: 0.5, y: 0.5 },
                            style: T.stilNormalisieren() });
  T.zeichnen(ctx, quelle, { text: '   ', opacity: 1, width: 1280, height: 720, pos: { x: 0.5, y: 0.5 },
                            style: T.stilNormalisieren() });
  pruefe('unsichtbar oder leer zeichnet nichts', befehle.length === vorher);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · Die Fahrt
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nFahrt');

pruefe('Kurs: von 350° auf 10° sind es +20°', nahe(I.winkelDelta(350 * GRAD, 10 * GRAD), 20 * GRAD));
pruefe('Kurs: von 10° auf 350° sind es −20°', nahe(I.winkelDelta(10 * GRAD, 350 * GRAD), -20 * GRAD));

{
  const R = 6378137;
  const a = [R, 0, 0], b = [0, R, 0];
  const mitte = I.ortMischen(a, b, 0.5);
  const betrag = Math.hypot(...mitte);
  pruefe('über 90° Erdbogen bleibt die Mitte auf der Kugel', nahe(betrag, R, 1e-3), `Betrag ${betrag}`);
  const sehne = Math.hypot(R / 2, R / 2, 0);
  pruefe('… und nicht auf der Sehne', betrag > sehne * 1.2);
  const e0 = I.ortMischen(a, b, 0), e1 = I.ortMischen(a, b, 1);
  pruefe('die Enden werden exakt getroffen', nahe(e0[0], R, 1e-6) && nahe(e1[1], R, 1e-6));
  const gegen = I.ortMischen(a, [-R, 0, 0], 0.5);
  pruefe('gegenüberliegende Punkte ergeben keine NaN', gegen.every(Number.isFinite));
  const gleich = I.ortMischen(a, a, 0.5);
  pruefe('derselbe Punkt bleibt derselbe', nahe(gleich[0], R, 1e-6) && nahe(gleich[1], 0, 1e-6));

  // Über ein Gebäude (20 m) ist die Kugelmischung von der Geraden nicht zu unterscheiden.
  const nah = [R + 10, 0, 0], fern = [R + 12, 20, 5];
  const k = I.ortMischen(nah, fern, 0.5);
  const gerade = [(nah[0] + fern[0]) / 2, (nah[1] + fern[1]) / 2, (nah[2] + fern[2]) / 2];
  const abw = Math.hypot(k[0] - gerade[0], k[1] - gerade[1], k[2] - gerade[2]);
  pruefe('über 20 m weicht sie höchstens einen Millimeter von der Geraden ab', abw < 1e-3, `${abw} m`);
}
{
  const a = { pos: [6378137, 0, 0], hpr: [350 * GRAD, -0.5, 0], fov: 40 };
  const b = { pos: [6378137, 10, 0], hpr: [10 * GRAD, -0.1, 0.2], fov: 80 };
  const m = I.poseMischen(a, b, 0.5);
  pruefe('Kurs läuft auf dem kurzen Weg (Mitte 0°/360°)',
    nahe(Math.cos(m.hpr[0]), 1, 1e-9) && nahe(Math.sin(m.hpr[0]), 0, 1e-9));
  pruefe('Neigung, Rollwinkel und Öffnungswinkel werden gemischt',
    nahe(m.hpr[1], -0.3) && nahe(m.hpr[2], 0.1) && nahe(m.fov, 60));
  const p0 = I.poseMischen(a, b, 0), p1 = I.poseMischen(a, b, 1);
  pruefe('t = 0 ist die erste Pose', nahe(p0.fov, 40) && nahe(p0.hpr[0], a.hpr[0]));
  pruefe('t = 1 ist die zweite Pose', nahe(p1.fov, 80) && nahe(Math.sin(p1.hpr[0]), Math.sin(b.hpr[0])));
}
pruefe('der Gang ist weich: Mitte bleibt die Mitte', nahe(I.weichMitte(0.5), 0.5));
pruefe('… und steht an den Enden still', I.weichMitte(0) === 0 && I.weichMitte(1) === 1);

// ═══════════════════════════════════════════════════════════════════════════
// 3 · Die Zeitachse
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nZeitachse');

const pose = (x, h) => ({ pos: [6378137 + x, 0, 0], hpr: [h, -0.3, 0], fov: 60 });
const mach = (id, x, hold, tag) => ({
  id, tag, hold, pose: pose(x, 0), caption: { x: 0.5, y: 0.8 }, style: T.stilNormalisieren(),
});
const deck = [mach('a', 0, 2, 'Eins'), mach('b', 100, 3, 'Zwei'), mach('c', 200, 1, 'Drei')];
const einst = { uebergang: 4, halt: 2.5 };
const achse = I.zeitachseBauen(deck, einst);

pruefe('Dauer = Halte + Flüge', nahe(achse.gesamt, 2 + 3 + 1 + 2 * 4));
pruefe('Phasen wechseln Halt und Flug', achse.phasen.map((p) => p.art).join() === 'halt,fahrt,halt,fahrt,halt');
pruefe('die Phasen schließen lückenlos aneinander',
  achse.phasen.every((p, i) => i === 0 || nahe(p.start, achse.phasen[i - 1].ende)));

{
  const s = I.zeitachseAbtasten(achse, deck, 1);
  pruefe('im Halt steht die Kamera exakt auf der Folie', nahe(s.pose.pos[0], 6378137) && s.tag === 'Eins');
  pruefe('im Halt ist der Text voll da', nahe(s.deckkraft, 1));
  const flug = I.zeitachseAbtasten(achse, deck, 2 + 2);   // Mitte des ersten Fluges
  pruefe('mitten im Flug liegt die Pose zwischen den Folien',
    flug.pose.pos[0] > 6378137 + 10 && flug.pose.pos[0] < 6378137 + 90);
  pruefe('mitten im Flug ist der Text ganz ausgeblendet (Überblendung)', nahe(flug.deckkraft, 0, 1e-6));
  const frueh = I.zeitachseAbtasten(achse, deck, 2 + 1);
  const spaet = I.zeitachseAbtasten(achse, deck, 2 + 3);
  pruefe('vor der Mitte gehört der Text der alten Folie, danach der neuen', frueh.tag === 'Eins' && spaet.tag === 'Zwei');
  pruefe('ganz am Anfang ist alles ausgeblendet', nahe(I.zeitachseAbtasten(achse, deck, 0).deckkraft, 0));
  const ende = I.zeitachseAbtasten(achse, deck, achse.gesamt + 5);
  pruefe('nach dem Ende: fertig, Kamera auf der letzten Folie',
    ende.fertig && nahe(ende.pose.pos[0], 6378137 + 200) && nahe(ende.deckkraft, 0));
  pruefe('mitten drin ist es nicht fertig', !I.zeitachseAbtasten(achse, deck, 3).fertig);
}
{
  // Stetigkeit: zwischen zwei Bildern springt die Kamera nicht.
  let schlimmster = 0, vorher = null;
  for (let t = 0; t <= achse.gesamt; t += 1 / 60) {
    const s = I.zeitachseAbtasten(achse, deck, t);
    if (vorher) schlimmster = Math.max(schlimmster, Math.abs(s.pose.pos[0] - vorher));
    vorher = s.pose.pos[0];
  }
  pruefe('die Fahrt ist stetig (kein Sprung zwischen zwei Bildern)', schlimmster < 5, `größter Schritt ${schlimmster.toFixed(2)} m`);
}
{
  const eine = I.zeitachseAbtasten(I.zeitachseBauen([deck[0]], einst), [deck[0]], 1);
  pruefe('eine einzelne Folie ist eine gültige Vorführung', eine.tag === 'Eins' && !eine.fertig);
  const kurz = I.zeitachseBauen([mach('x', 0, 0, 'k'), mach('y', 1, 0, 'l')], { uebergang: 0, halt: 0 });
  pruefe('Flugzeit 0 wird auf 0,2 s gehoben, die Dauer ist nie 0', kurz.gesamt >= 0.2);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · Folien und Deck: Lesen, Schreiben, Bearbeiten
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nDeck');

{
  const f = I.folieNormalisieren({ pose: { pos: [1, 2, 3], hpr: [0, 0, 0] } }, { halt: 4 });
  pruefe('eine Folie ohne Angaben bekommt Vorgaben', f && f.hold === 4 && f.tag === '' && f.pose.fov === 60
    && f.caption.x === 0.5 && f.style.theme === 'glass' && typeof f.id === 'string');
  pruefe('ohne brauchbare Pose gibt es keine Folie', I.folieNormalisieren({ pose: { pos: [1, 2] } }, { halt: 1 }) === null
    && I.folieNormalisieren({}, { halt: 1 }) === null
    && I.folieNormalisieren({ pose: { pos: [1, 2, NaN], hpr: [0, 0, 0] } }, { halt: 1 }) === null);
  const g = I.folieNormalisieren({ pose: { pos: [1, 2, 3], hpr: [0, 0, 0], fov: 500 }, hold: -3, caption: { x: 7, y: -1 } }, { halt: 4 });
  pruefe('Öffnungswinkel, Halt und Lage werden geklemmt', g.pose.fov === 120 && g.hold === 4 && g.caption.x === 1 && g.caption.y === 0);
}
{
  const text = I.deckSchreiben();
  pruefe('ein leeres Deck schreibt sich als gültiges JSON', JSON.parse(text).format === 'ileen-praesentation');
  let warf = '';
  try { I.deckLesen(JSON.stringify({ slides: [{ pose: { yaw: 10, pitch: 0, distance: 5, target: [0, 0, 0], fov: 60 } }] })); }
  catch (e) { warf = e.message; }
  pruefe('ein splides-Deck wird mit Begründung abgewiesen', /splides/.test(warf), warf);
  let kein = '';
  try { I.deckLesen('{"x":1}'); } catch (e) { kein = e.message; }
  pruefe('eine fremde Datei wird abgewiesen', /Folien/.test(kein), kein);
}

// Bearbeiten über die Schnittstelle, mit der Kamera-Attrappe
{
  kamera.positionWC = { x: 6378137, y: 0, z: 0 };
  const f1 = P.hinzufuegen();
  pruefe('„Folie aus Ansicht" liest die Kamera', nahe(f1.pose.pos[0], 6378137) && nahe(f1.pose.hpr[0], 0.3) && nahe(f1.pose.fov, 60));
  pruefe('die neue Folie ist gewählt', P.gewaehlt() === f1.id);

  P.stilSetzen(f1.id, 'theme', 'bar');
  P.textSetzen(f1.id, '# Erste');
  kamera.positionWC = { x: 6378137, y: 50, z: 0 };
  kamera.frustum.fov = 90 * GRAD;
  const f2 = P.hinzufuegen();
  pruefe('die nächste Folie erbt den Stil der gewählten', f2.style.theme === 'bar');
  pruefe('ihr Öffnungswinkel stammt aus der Kamera', nahe(f2.pose.fov, 90));

  P.waehlen(f1.id, false);
  const f3 = P.hinzufuegen();
  const reihe = P.folien().map((f) => f.id);
  pruefe('eine neue Folie steht HINTER der gewählten', reihe.join() === [f1.id, f3.id, f2.id].join());

  const dupl = P.duplizieren(f1.id);
  pruefe('Duplizieren legt eine eigene Folie mit eigener Kennung an',
    dupl.id !== f1.id && dupl.tag === '# Erste' && P.folien().indexOf(dupl) === 1);
  dupl.tag = 'geändert';
  pruefe('die Kopie ist tief (kein geteilter Stil/Pose)', f1.tag === '# Erste');

  P.verschieben(0, 3);
  pruefe('Verschieben sortiert um', P.folien()[3].id === f1.id);

  P.stilSetzen(f1.id, 'scale', 1.5);
  P.stilAufAlle(f1.id);
  pruefe('„Stil auf alle" überträgt', P.folien().every((f) => f.style.scale === 1.5 && f.style.theme === 'bar'));

  P.stilSetzen(f1.id, 'theme', 'nonsense');
  pruefe('ein unbekannter Stilwert wird abgefangen', folienStil(f1.id).theme === 'glass');
  P.stilSetzen(f1.id, 'unbekannt', 'x');
  pruefe('ein unbekanntes Stilfeld wird ignoriert', !('unbekannt' in folienStil(f1.id)));

  P.haltSetzen(f1.id, '7.5');
  P.haltSetzen(f2.id, '-2');
  P.haltSetzen(f3.id, 'abc');
  pruefe('Halt nimmt Zahlen ≥ 0 und sonst nichts',
    folie(f1.id).hold === 7.5 && folie(f2.id).hold !== -2 && folie(f3.id).hold !== 'abc');

  P.lageSetzen(f1.id, 2, -1);
  pruefe('Lage wird auf 0…1 geklemmt', folie(f1.id).caption.x === 1 && folie(f1.id).caption.y === 0);

  P.einstellungSetzen('uebergang', '0.05');
  P.einstellungSetzen('halt', '-3');
  pruefe('Flugzeit nie unter 0,2 s, Standard-Halt nie negativ',
    P.einstellungen().uebergang === 0.2 && P.einstellungen().halt === 0);
  P.einstellungSetzen('uebergang', '5');

  // Springen zur Folie stellt die Kamera
  kamera.gesetzt.length = 0;
  P.waehlen(f2.id);
  const gesetzt = kamera.gesetzt[kamera.gesetzt.length - 1];
  pruefe('Wählen fliegt zur Folie (setView mit Ort und Kurs)',
    gesetzt && nahe(gesetzt.destination.y, 50) && nahe(gesetzt.orientation.heading, 0.3));
  pruefe('… und stellt den Öffnungswinkel', nahe(kamera.frustum.fov, 90 * GRAD));

  kamera.positionWC = { x: 6378137, y: 999, z: 0 };
  P.kameraSetzen(f2.id);
  pruefe('„Kamera setzen" übernimmt die aktuelle Ansicht', nahe(folie(f2.id).pose.pos[1], 999));

  // Nach einem Neustart ist alles wieder da
  const { welt: neu } = umgebung(lager);
  const Q = neu.Praesentation;
  pruefe('das Deck überlebt einen Neustart (localStorage)',
    Q.folien().length === P.folien().length && Q.folien()[3].id === f1.id && Q.einstellungen().uebergang === 5);
  pruefe('… samt Stil und Text', Q.folien().find((f) => f.id === f1.id).style.scale === 1.5);

  // Datei: Sichern und Laden
  const datei = P.jsonAusgeben();
  const { welt: dritte } = umgebung();
  const R = dritte.Praesentation;
  const d = R.jsonEinlesen(datei);
  pruefe('Sichern → Laden gibt dasselbe Deck zurück',
    R.folien().length === P.folien().length && d.verworfen === 0 && R.gewaehlt() === R.folien()[0].id);
  let leer = '';
  try { R.jsonEinlesen(JSON.stringify({ folien: [{ pose: {} }] })); } catch (e) { leer = e.message; }
  pruefe('eine Datei ohne brauchbare Folie ersetzt das Deck nicht', /keine brauchbare Folie/.test(leer) && R.folien().length === P.folien().length, leer);
  const gemischt = JSON.parse(datei);
  gemischt.folien.push({ pose: { pos: [1, 2] } });
  const d2 = R.jsonEinlesen(JSON.stringify(gemischt));
  pruefe('unbrauchbare Folien werden gezählt und verworfen', d2.verworfen === 1);

  // Löschen rückt die Auswahl nach
  const vorLoeschen = P.folien().length;
  P.waehlen(f2.id, false);
  P.loeschen(f2.id);
  pruefe('Löschen nimmt die Folie heraus', P.folien().length === vorLoeschen - 1 && !P.folien().some((f) => f.id === f2.id));
  pruefe('die Auswahl rückt auf eine vorhandene Folie nach',
    P.gewaehlt() === null || P.folien().some((f) => f.id === P.gewaehlt()));

  P.leeren();
  pruefe('Leeren räumt das Deck, auch im Speicher',
    P.folien().length === 0 && JSON.parse(lager.get(I.SPEICHER)).folien.length === 0);
}

function folie(id) { return P.folien().find((f) => f.id === id); }
function folienStil(id) { return folie(id).style; }

// Ein kaputter Speicher lässt das Modul nicht scheitern.
{
  const lager2 = new Map([['ileen.praesentation.v1', '{kaputt']]);
  const { welt: w } = umgebung(lager2);
  pruefe('ein unlesbarer Speicher ergibt ein leeres Deck, keinen Absturz', w.Praesentation.folien().length === 0);
}

console.log(fehler ? `\n${fehler} Prüfstein(e) fehlgeschlagen` : '\nAlle Prüfsteine bestanden');
process.exit(fehler ? 1 : 0);
