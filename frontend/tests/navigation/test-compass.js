// Prüft Kompass und Höhenanzeige des Navigations-HUD ohne Browser.
//
// Aufruf:  node tests/navigation/test-compass.js
//
// Warum gerade diese Stellen: Eine Rose, die sich falsch herum dreht, sieht im
// Bild aus wie eine richtige — man merkt es erst, wenn man nach Norden läuft
// und das N nach hinten wandert. Und eine Höhe ohne Bezug ist keine Höhe: über
// Rheinland-Pfalz liegen rund 47 m zwischen Ellipsoid und NHN, das ist mehr als
// ein Vollgeschoss mal fünfzehn.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}

// ── nav-hud.js laden ──────────────────────────────────────────────────────
// setTimeout bleibt ein Stummel: dann baut das Modul kein HUD auf und wir
// bekommen genau die Rechenfunktionen, um die es hier geht.

function ladeNavHud(zusatz = {}) {
  const kontext = Object.assign({
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    MutationObserver: function () { this.observe = () => {}; },
    document: {
      readyState: 'complete',
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { toggle() {}, contains: () => false },
        addEventListener() {}, appendChild() {}, querySelectorAll: () => [] }),
      getElementById: () => null,
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
  }, zusatz);
  kontext.window = kontext.window || {};
  kontext.window.window = kontext.window;
  vm.createContext(kontext);
  vm.runInContext(fs.readFileSync(path.join(WURZEL, 'nav-hud.js'), 'utf8'),
    kontext, { filename: 'nav-hud.js' });
  return kontext;
}

const NavHud = ladeNavHud().window.NavHud;
pruefe('nav-hud.js reicht seine Rechenfunktionen heraus', !!NavHud);

// ── 1 · Kurs ──────────────────────────────────────────────────────────────

{
  const g = NavHud.kursGrad;
  pruefe('Norden ist 0°', g(0) === 0);
  pruefe('Ost ist 90°', Math.abs(g(Math.PI / 2) - 90) < 1e-9);
  pruefe('negativer Kurs kommt positiv zurück', Math.abs(g(-Math.PI / 2) - 270) < 1e-9,
    `ist ${g(-Math.PI / 2)}`);
  pruefe('mehr als eine Umdrehung wird gefaltet', Math.abs(g(3 * Math.PI) - 180) < 1e-9,
    `ist ${g(3 * Math.PI)}`);
  pruefe('unbrauchbarer Wert wird zu 0', g(NaN) === 0 && g(undefined) === 0);

  // Die Rose dreht gegen den Kurs — sonst zeigt ihr N mit der Kamera mit
  // statt nach Norden.
  pruefe('Rose dreht gegen den Kurs', Math.abs(NavHud.roseDrehung(Math.PI / 2) + 90) < 1e-9,
    `ist ${NavHud.roseDrehung(Math.PI / 2)}`);
}

// ── 2 · Himmelsrichtungen ─────────────────────────────────────────────────

{
  const h = NavHud.himmelsrichtung;
  pruefe('0° ist Nord', h(0, 'de') === 'N');
  pruefe('22° ist noch Nord', h(22, 'de') === 'N', `ist ${h(22, 'de')}`);
  pruefe('23° ist Nordost', h(23, 'de') === 'NO', `ist ${h(23, 'de')}`);
  pruefe('90° heißt auf Deutsch O', h(90, 'de') === 'O');
  pruefe('90° heißt auf Englisch E', h(90, 'en') === 'E');
  pruefe('180° ist Süd', h(180, 'de') === 'S');
  pruefe('315° ist Nordwest', h(315, 'de') === 'NW');
  pruefe('350° ist wieder Nord', h(350, 'de') === 'N', `ist ${h(350, 'de')}`);
  pruefe('unbekannte Sprache fällt auf Deutsch zurück', h(90, 'fr') === 'O');
}

// ── 3 · Höhenformat ───────────────────────────────────────────────────────

{
  const f = NavHud.formatHoehe;
  pruefe('Augenhöhe mit Nachkommastelle', f(1.8, 'de') === '1,8 m', `ist ${f(1.8, 'de')}`);
  pruefe('knapp unter 100 m bleibt genau', f(99.94, 'de') === '99,9 m', `ist ${f(99.94, 'de')}`);
  pruefe('ab 100 m ohne Nachkomma', f(100, 'de') === '100 m', `ist ${f(100, 'de')}`);
  pruefe('Tausender werden gruppiert', f(1234.6, 'de') === '1.235 m', `ist ${f(1234.6, 'de')}`);
  pruefe('ab 10 km in Kilometern', f(10000, 'de') === '10,0 km', `ist ${f(10000, 'de')}`);
  pruefe('Erdblick bleibt lesbar', f(12345678, 'de') === '12.346 km', `ist ${f(12345678, 'de')}`);
  pruefe('unter Gelände behält das Vorzeichen', f(-3.2, 'de') === '-3,2 m', `ist ${f(-3.2, 'de')}`);
  pruefe('Englisch trennt mit Punkt', f(1234.6, 'en') === '1,235 m' && f(1.8, 'en') === '1.8 m',
    `ist ${f(1234.6, 'en')} / ${f(1.8, 'en')}`);
  pruefe('ohne Wert steht ein Strich', f(null, 'de') === '–' && f(NaN, 'de') === '–' &&
    f(Infinity, 'de') === '–');
}

// ── 4 · Rose ──────────────────────────────────────────────────────────────

{
  const de = NavHud.roseSvg('de');
  const en = NavHud.roseSvg('en');
  pruefe('die Rose hat einen drehbaren Teil', de.includes('class="nhud-rose-dial"'));
  pruefe('deutsche Rose trägt ein O', de.includes('>O</text>') && !de.includes('>E</text>'));
  pruefe('englische Rose trägt ein E', en.includes('>E</text>') && !en.includes('>O</text>'));
  pruefe('vier Himmelsrichtungen stehen darauf', (de.match(/<text /g) || []).length === 4);
  pruefe('acht Teilstriche', (de.match(/<line /g) || []).length === 8);
  pruefe('die Nordnadel trägt die Akzentfarbe', de.includes('M50 30 L55.5 50 L44.5 50 Z" fill="#97BF0D"'));
  pruefe('das Tag schließt sauber', de.trim().startsWith('<svg') && de.trim().endsWith('</svg>'));
}

// ── 5 · Nach Norden ausrichten ────────────────────────────────────────────

{
  // Frei fliegende Kamera: drehen auf der Stelle, Neigung bleibt.
  let geflogen = null;
  const kamera = {
    positionWC: { clone: () => 'STANDPUNKT' },
    pitch: -0.7,
    flyTo: (o) => { geflogen = o; },
  };
  const k = ladeNavHud({
    BimViewer: { viewer: { camera: kamera } },
    WalkMode: { isEnabled: () => false },
  });
  k.window.NavHud.nachNorden();
  pruefe('die Kamera dreht auf Nord', geflogen && geflogen.orientation.heading === 0);
  pruefe('die Neigung bleibt', geflogen && geflogen.orientation.pitch === -0.7);
  pruefe('der Standpunkt bleibt', geflogen && geflogen.destination === 'STANDPUNKT');
}

{
  // Im Walk-/Flugmodus führt walkMode.js die Kamera jedes Bild neu — ein
  // flyTo von außen wäre einen Frame später überschrieben.
  let gesetzt = null;
  let geflogen = false;
  const k = ladeNavHud({
    BimViewer: { viewer: { camera: { positionWC: { clone: () => 'P' }, pitch: 0, flyTo: () => { geflogen = true; } } } },
    WalkMode: { isEnabled: () => true, setHeading: (v) => { gesetzt = v; } },
  });
  k.window.NavHud.nachNorden();
  pruefe('im Walk-Modus geht der Kurs an WalkMode', gesetzt === 0);
  pruefe('im Walk-Modus fliegt die Kamera nicht', geflogen === false);
}

{
  // Vor dem ersten geladenen Modell gibt es noch keinen Viewer.
  const k = ladeNavHud({ BimViewer: undefined });
  let geworfen = false;
  try { k.window.NavHud.nachNorden(); } catch (e) { geworfen = true; }
  pruefe('ohne Viewer passiert nichts', !geworfen);
}

// ── 6 · Kurs von außen in walkMode.js ─────────────────────────────────────

{
  const kontext = {
    console: { log() {}, warn() {}, error() {} },
    window: {}, document: { addEventListener() {} },
  };
  kontext.window.window = kontext.window;
  vm.createContext(kontext);
  vm.runInContext(fs.readFileSync(path.join(WURZEL, 'walkMode.js'), 'utf8'),
    kontext, { filename: 'walkMode.js' });
  const WalkMode = kontext.window.WalkMode;

  pruefe('walkMode.js nimmt einen Kurs entgegen', typeof WalkMode.setHeading === 'function');
  WalkMode.setHeading(1.23);
  pruefe('der Kurs kommt zurück', WalkMode.getHeading() === 1.23);
  WalkMode.setHeading(NaN);
  pruefe('Unsinn ändert den Kurs nicht', WalkMode.getHeading() === 1.23);
  WalkMode.setHeading(0);
  pruefe('Norden ist setzbar', WalkMode.getHeading() === 0);
}

console.log(fehler === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
