// Der Trennungs-Prüfstein: sieht ohne Browser nach, ob iLEEN-view noch der
// Viewer ist — und nichts von der Auswertungsseite mitgekommen ist.
//
// Aufruf:  node tests/trennung/test-trennung.mjs
//
// Warum ohne Browser
// ==================
// `tests/start/test-start.mjs` prüft dasselbe zur Laufzeit und gründlicher,
// braucht dafür aber Chrome und einen Dev-Server auf Port 5190. Das ist zu
// viel Aufwand für die eine Frage, die vor jedem Übernehmen aus der
// Vollfassung zählt: liegt hier eine Datei, die nicht hierhergehört?
//
// Dieser Prüfstein liest nur Dateinamen und `index.html`. Er läuft in
// Sekundenbruchteilen und eignet sich damit als letzter Griff vor dem Commit.
//
// Die Regel dahinter
// ==================
// Links ist Viewer, rechts ist Auswertung. Das Panelgerüst beider Seiten
// (`ui.js`, `right-panel.js`) ist in beiden Fassungen dieselbe Datei — es
// kennt kein einziges Werkzeug. Verschieden ist allein, welche Anmelde-Datei
// mitgeliefert wird. Genau diese Dateien stehen unten.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HIER, '..', '..');

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '\n      ' + hinweis : ''}`); }
}

// ── 1 · Dateien, die es hier nicht geben darf ──────────────────────────────
//
// Die Anmelde-Dateien der Auswertungen und ihre Rechenkerne. Wer eine davon
// hierher kopiert, hat die Trennung aufgehoben.
const VERBOTENE_DATEIEN = [
  // rechte Seite — Reiter am Panelgerüst
  'solar-panel.js', 'bimlp-panel.js', 'stalite-tool.js', 'geg-tool.js',
  'bericht.js', 'tragwerk-panel.js', 'volumen-panel.js',
  'tragwerk-ergebnisse.css', 'werkzeuge-auswertung.css',
  // linke Seite — Gruppen und eigene Bereiche
  'ifclash-panel.js', 'room-concept-panel.js', 'bauplaner-panel.js',
  'konzept-panel.js', 'ifc-4d-panel.js',
  // Rechenkerne dahinter
  'solar.js', 'ifclash.js', 'room-concept.js', 'flight-tracker.js',
  'tragwerk-ergebnisse.js', 'volumen.js', 'plan-bauteil.js',
];

const gefunden = VERBOTENE_DATEIEN.filter((d) => existsSync(join(FRONTEND, d)));
pruefe('keine Auswertungs-Datei im Viewer-Repo', gefunden.length === 0,
  'liegt hier: ' + gefunden.join(', '));

// ── 2 · Kein Verweis darauf in index.html ──────────────────────────────────
//
// Eine Datei kann fehlen und trotzdem eingebunden sein — dann holt sich der
// Browser bei jedem Start eine 404, und das Werkzeug fehlt lautlos. Umgekehrt
// ist eine mitgelieferte, aber nicht eingebundene Datei genauso falsch: sie
// läge im öffentlichen Repo.
const html = readFileSync(join(FRONTEND, 'index.html'), 'utf8');
const eingebunden = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const stylesheets = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);

const fremdEingebunden = eingebunden.filter((s) => VERBOTENE_DATEIEN.includes(s));
pruefe('index.html bindet keine Auswertung ein', fremdEingebunden.length === 0,
  'eingebunden: ' + fremdEingebunden.join(', '));

// ── 3 · Jede eingebundene Datei liegt auch hier ────────────────────────────
//
// Der Fehler, den ein Zuschnitt am häufigsten erzeugt: die `<script>`-Zeile
// bleibt stehen, die Datei geht. Das Start-Modul wirft dann beim Laden, und
// der Rest der Datei läuft nicht mehr.
const lokal = (p) => !/^https?:\/\//.test(p);
const fehlendeSkripte = eingebunden.filter(lokal).filter((s) => !existsSync(join(FRONTEND, s)));
pruefe('jedes eingebundene Skript liegt hier', fehlendeSkripte.length === 0,
  'fehlt: ' + fehlendeSkripte.join(', '));

const fehlendeStyles = stylesheets.filter(lokal).filter((s) => !existsSync(join(FRONTEND, s)));
pruefe('jedes eingebundene Stylesheet liegt hier', fehlendeStyles.length === 0,
  'fehlt: ' + fehlendeStyles.join(', '));

// ── 3b · Keine verwaisten Dateien ──────────────────────────────────────────
//
// Eine Datei, die niemand einbindet, ist beim Zuschnitt vergessen worden. Sie
// schadet nicht im Betrieb, liegt aber im öffentlichen Repo — und genau so ist
// `tragwerk-ergebnisse.css` hier liegengeblieben, nachdem ihr `<link>` schon
// entfernt war.
const AUSNAHMEN = new Set(['vite.config.js', 'config.js', 'config.example.js']);
const verwaist = readdirSync(FRONTEND)
  .filter((f) => /\.(js|css)$/.test(f))
  .filter((f) => !AUSNAHMEN.has(f))
  .filter((f) => !eingebunden.includes(f) && !stylesheets.includes(f));
pruefe('keine verwaiste Datei im Frontend', verwaist.length === 0,
  'bindet niemand ein: ' + verwaist.join(', '));

// ── 4 · Das Panelgerüst ist wirklich leer ──────────────────────────────────
//
// `right-panel.js` darf kein Werkzeug kennen. Stünde hier wieder ein
// eingebauter Reiter, wäre die Datei nicht mehr in beiden Fassungen dieselbe —
// und der nächste Abgleich mit der Vollfassung müsste den Unterschied von Hand
// überspringen.
const rp = readFileSync(join(FRONTEND, 'right-panel.js'), 'utf8');
const rpCode = rp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
pruefe('right-panel.js meldet selbst keinen Reiter an',
  !/\breiterAnmelden\s*\(\s*\{/.test(rpCode),
  'im Gerüst steht wieder ein eingebauter Reiter');

// ── 5 · ui.js kennt keine Auswertung ───────────────────────────────────────
const ui = readFileSync(join(FRONTEND, 'ui.js'), 'utf8');
const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const AUSWERTUNGS_NAMEN = ['IFClash', 'RoomConcept', 'SolarAnalysis', 'Bauplaner',
                           'KonzeptPanel', 'Sim4DHud', 'IFC4D', 'FlugTracker',
                           'getClashContent', 'getRoomConceptContent'];
const inUi = AUSWERTUNGS_NAMEN.filter((n) => new RegExp('\\b' + n + '\\b').test(uiCode));
pruefe('ui.js nennt keine Auswertung beim Namen', inUi.length === 0,
  'gefunden: ' + inUi.join(', '));

// ── 6 · Die Anmeldewege sind da ────────────────────────────────────────────
//
// Ohne sie ist die Fassung zwar sauber, aber nicht mehr erweiterbar — und
// genau die Erweiterbarkeit ist der Grund, warum die Trennung überhaupt so
// gezogen wurde.
for (const [datei, name] of [['ui.js', 'bereichAnmelden'], ['ui.js', 'gruppeAnmelden'],
                             ['right-panel.js', 'reiterAnmelden'],
                             ['right-panel.js', 'brueckeAnmelden']]) {
  const inhalt = datei === 'ui.js' ? ui : rp;
  pruefe(`${datei} bietet ${name}()`, inhalt.includes(name + '('));
}

console.log('');
if (fehler) {
  console.log(`✗ ${fehler} Befund(e) — der Zuschnitt stimmt nicht.`);
  process.exit(1);
}
console.log('Die Trennung hält: links Viewer, rechts leeres Gerüst.');
