// Prüft das Sensor-Panel (`sensor-panel.js`) ohne Browser und ohne Netz.
//
// Aufruf:  node tests/sensor-panel/test-sensor-panel.js
//
// Das Aussehen ist der leichte Teil dieses Pakets. Geprüft werden deshalb vor
// allem die drei Regeln, an denen die Vorlage scheiterte — und alle drei
// scheitern still, nämlich mit einem Panel, das plausibel aussieht und das
// Falsche sagt:
//
//   a · „Läuft der Strom?" darf nicht bei einem einzigen eingefrorenen Fühler
//       stehen. Ein Hinweis, der immer dasteht, wird überlesen — auch dann,
//       wenn er einmal stimmt.
//   b · Die Geschossfarbe ist das Mittel der gesunden Fühler. Ein Ausreißer an
//       einem von zweien verschwindet darin, wenn ihn das Panel nicht nennt.
//   c · Ein Zeitstempel aus der Zukunft ist kein „gerade eben".
//
// Dazu: dass die Farbfelder die Modellfarben sind (keine eigene Rechnung), dass
// Öffnen und Schließen die Einfärbung mitnehmen, und dass jeder Schlüssel in
// beiden Sprachen steht.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.resolve(__dirname, '..', '..');

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  const ok = !!bedingung;
  if (!ok) fehler++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !hinweis ? '' : '   ' + hinweis}`);
}

// ── Umgebung: ein Mini-DOM, ein Store zum Füttern, das echte Farbmodul ─────

function element() {
  return {
    innerHTML: '', className: '', id: '', dataset: {}, entfernt: false,
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, appendChild() {},
    remove() { this.entfernt = true; },
  };
}

const zuhoerer = {};
const angemeldet = [];
let aktualisiert = 0;
let speicher = {};
let speicherWirft = false;
let backend = 'http://example.invalid';
let stand = [];

const sandbox = {
  console: { log() {}, info() {}, warn() {}, error() {} },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  Math, JSON, Number, Array, Object, String, Date, Set, Map, Error, Intl,
  CustomEvent: class { constructor(typ, o) { Object.assign(this, { type: typ }, o); } },
  navigator: { language: 'de' },
  localStorage: {
    getItem(k) { if (speicherWirft) throw new Error('privates Fenster'); return speicher[k] ?? null; },
    setItem(k, v) { if (speicherWirft) throw new Error('privates Fenster'); speicher[k] = String(v); },
    removeItem(k) { delete speicher[k]; },
  },
  document: {
    readyState: 'complete',
    documentElement: { lang: 'de' },
    body: element(),
    createElement: element,
    addEventListener(typ, f) { (zuhoerer[typ] || (zuhoerer[typ] = [])).push(f); },
    dispatchEvent(e) { (zuhoerer[e.type] || []).forEach((f) => f(e)); return true; },
    querySelector: () => null, querySelectorAll: () => [],
  },
  BimViewer: { getBackendUrl: () => backend, applyIFCFilter() {} },
  BimViewerUI: {
    bereichAnmelden(b) { angemeldet.push(b); },
    aktionenAktualisieren() { aktualisiert++; },
  },
  SensorStore: {
    laeuft: true, EREIGNIS: 'ileen:sensor-geaendert',
    stand: () => stand, starten() {},
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const datei of ['i18n.js', 'sensor-farben.js', 'sensor-panel.js']) {
  vm.runInContext(fs.readFileSync(path.join(FRONTEND, datei), 'utf8'), sandbox, { filename: datei });
}

const P = sandbox.SensorPanel;
const F = sandbox.SensorFarben;

const JETZT = Date.parse('2026-09-21T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

function sensor(id, zone, wert, status, messgroesse, zeit) {
  return {
    sensor_id: id, iri: 'iri-' + id, zone, wert, status: status || 'ok',
    messgroesse: messgroesse || 'raumtemperatur',
    einheit: messgroesse === 'wirkleistung' ? 'kW' : '°C',
    zeit: zeit || iso(Date.now()), intervall_s: 60,
    bezeichnung: id, bereich_min: 5, bereich_max: 40,
  };
}

// Ein Stand wie aus #2: zwei Fühler je Geschoss, dazu Zähler und Wetter.
function vollerStand() {
  const zonen = ['Z-UG', 'Z-EG', 'Z-OG1', 'Z-OG2', 'Z-OG3', 'Z-DACH'];
  const s = [];
  zonen.forEach((z, i) => {
    s.push(sensor(`TMP-${z}-N`, z, 19 + i * 0.5));
    s.push(sensor(`TMP-${z}-S`, z, 19.5 + i * 0.5));
    s.push(sensor(`PWR-${z}`, z, 8 + i, 'ok', 'wirkleistung'));
  });
  s.push(sensor('ELT-GESAMT', 'Z-SITE', 1250000, 'ok', 'arbeit'));
  s.push(sensor('MET-TA', 'Z-SITE', 14.2, 'ok', 'aussentemperatur'));
  s.push(sensor('MET-GHI', 'Z-SITE', 410, 'ok', 'globalstrahlung'));
  s.push(sensor('PV-P', 'Z-DACH', 38, 'ok', 'pv_leistung'));
  s.push(sensor('PV-E', 'Z-DACH', 210, 'ok', 'pv_ertrag_tag'));
  s.push(sensor('PV-TMOD', 'Z-DACH', 31, 'ok', 'modultemperatur'));
  return s;   // 24 Sensoren
}

// ── 1. Die Anmeldung in der linken Leiste ─────────────────────────────────

console.log('\nEin Knopf in der linken Leiste');

const knopf = angemeldet.find((b) => b.id === 'sensoren');
pruefe('das Panel meldet sich als Bereich an', !!knopf);
pruefe('und zwar als Aktion, nicht als Seitenpanel',
  knopf && typeof knopf.aktion === 'function' && knopf.inhalt === undefined && knopf.gruppen === undefined);
pruefe('mit einem Zustand für „gedrückt"', knopf && typeof knopf.an === 'function');
pruefe('beim Laden ist es zu', P.offen === false && knopf.an() === false);

// ── 2. Öffnen und Schließen nehmen die Einfärbung mit ─────────────────────

console.log('\nÖffnen färbt, Schließen entfärbt');

stand = vollerStand();
pruefe('vor dem Öffnen ist die Einfärbung aus', F.aktiv === false);
aktualisiert = 0;
knopf.aktion();
pruefe('ein Klick öffnet das Panel', P.offen === true);
pruefe('und schaltet die Einfärbung an', F.aktiv === true);
pruefe('der Leistenknopf wird nachgeführt', aktualisiert >= 1 && knopf.an() === true);
pruefe('der Zustand wird gemerkt', speicher.ileen_sensor_panel_offen === '1');

knopf.aktion();
pruefe('ein zweiter Klick schließt es', P.offen === false);
pruefe('und schaltet die Einfärbung aus', F.aktiv === false);
pruefe('auch das wird gemerkt', speicher.ileen_sensor_panel_offen === '0');

P.oeffnen();
P.schliessen();
pruefe('das ✕ (schliessen) nimmt die Einfärbung ebenso mit', F.aktiv === false && P.offen === false);

// ── 3. Die Farbfelder sind die Modellfarben ───────────────────────────────

console.log('\nDie Farbfelder sind die Farben des Modells');

let kasten = null;
sandbox.document.createElement = () => (kasten = element());
P.oeffnen();
const html = () => kasten.innerHTML;

const zonen = F.zonenwerte();
const fehlend = Object.keys(F.ZONE_GESCHOSS)
  .filter((z) => !html().includes(`background:${F.zonenfarbe(zonen[z], 'raumtemperatur')}`));
pruefe('jedes Geschoss trägt genau die Farbe aus SensorFarben.zonenfarbe()',
  fehlend.length === 0, 'fehlt für ' + fehlend.join(', '));

const quelltext = fs.readFileSync(path.join(FRONTEND, 'sensor-panel.js'), 'utf8');
const code = quelltext.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
pruefe('das Panel rechnet keine Farbe selbst (keine Skala, keine Kanäle, kein Mischen)',
  !/parseInt\([^)]*16\)|mischen|\.toString\(16\)|rgb\(/.test(code));
pruefe('kein eigener Netzabruf', !/\bfetch\s*\(/.test(code));
pruefe('kein eigener Tileset-Stil', !/\.style\s*=|Cesium3DTileStyle/.test(code));

// ── 4. Legende und Umschalter ─────────────────────────────────────────────

console.log('\nDie Legende liest die Skala, der Umschalter wechselt beides');

const sk = F.SKALEN.raumtemperatur;
pruefe('die Legende nennt die Grenzen der Skala',
  html().includes(`${sk.von} °C`) && html().includes(`${sk.bis} °C`));

// Nicht hart eingetragen: wird die Skala geändert, folgt die Beschriftung.
const vorher = { von: sk.von, bis: sk.bis };
sk.von = 10; sk.bis = 30;
P.zeichnen();
pruefe('ändert sich die Skala, ändert sich die Legende mit',
  html().includes('10 °C') && html().includes('20 °C') && html().includes('30 °C'));
sk.von = vorher.von; sk.bis = vorher.bis;
P.zeichnen();

P.messgroesseSetzen('wirkleistung');
pruefe('der Umschalter stellt das Panel um', P.messgroesse === 'wirkleistung');
pruefe('und das Modell', F.messgroesse === 'wirkleistung');
pruefe('die Legende steht dann in kW', html().includes(' kW'));
P.messgroesseSetzen('raumtemperatur');

// ── 5. (a) Ein eingefrorener Fühler ist kein Stillstand ───────────────────

console.log('\n(a) Stillstand erst, wenn die Mehrheit steht');

const alle = vollerStand();
pruefe('24 Sensoren im Teststand', alle.length === 24, String(alle.length));

const einer = alle.map((s, i) => (i === 0 ? { ...s, status: 'veraltet' } : s));
pruefe('ein veralteter von 24 → kein Hinweis', P.stromSteht(einer) === false);

const zwoelf = alle.map((s, i) => (i < 12 ? { ...s, status: 'veraltet' } : s));
pruefe('zwölf von 24 (genau die Hälfte) → noch kein Hinweis', P.stromSteht(zwoelf) === false);

const dreizehn = alle.map((s, i) => (i < 13 ? { ...s, status: 'veraltet' } : s));
pruefe('dreizehn von 24 → Hinweis', P.stromSteht(dreizehn) === true);
pruefe('ein leerer Stand ist kein Stillstand', P.stromSteht([]) === false);

stand = einer; P.zeichnen();
pruefe('im Panel steht bei einem Einzelnen nichts von „läuft der Strom"',
  !html().includes(sandbox.t('sensoren.stromSteht')));
stand = dreizehn; P.zeichnen();
pruefe('bei der Mehrheit schon', html().includes(sandbox.t('sensoren.stromSteht')));

// ── 6. (b) Die Farbe verschluckt einzelne Fühler ──────────────────────────

console.log('\n(b) Auffällige Fühler werden beim Namen genannt');

stand = vollerStand().map((s) => {
  if (s.sensor_id === 'TMP-Z-UG-N') return { ...s, status: 'ausreisser', wert: 85 };
  if (s.sensor_id === 'TMP-Z-OG2-N') return { ...s, status: 'veraltet' };
  return s;
});
P.zeichnen();
const zw = F.zonenwerte();
pruefe('das UG sieht in der Farbe gesund aus (Mittel der gesunden)', zw['Z-UG'].status === 'ok');
pruefe('— und trotzdem nennt das Panel den Ausreißer', html().includes('⚠ TMP-Z-UG-N'));
pruefe('OG-2 sieht ebenfalls gesund aus', zw['Z-OG2'].status === 'ok');
pruefe('— und das Panel nennt den eingefrorenen Fühler', html().includes('◷ TMP-Z-OG2-N'));

const auff = P.auffaellige(stand, 'raumtemperatur');
pruefe('auffaellige() ordnet sie der richtigen Zone zu',
  auff['Z-UG'].ausreisser[0] === 'TMP-Z-UG-N' && auff['Z-OG2'].veraltet[0] === 'TMP-Z-OG2-N');
pruefe('und nur der gewählten Messgröße',
  Object.keys(P.auffaellige(stand, 'wirkleistung')).length === 0);

// Ist das ganze Geschoss veraltet, steht es nicht doppelt da.
stand = vollerStand().map((s) =>
  (s.zone === 'Z-EG' && s.messgroesse === 'raumtemperatur' ? { ...s, status: 'veraltet' } : s));
P.zeichnen();
pruefe('ein insgesamt veraltetes Geschoss wiederholt seine Fühler nicht',
  !html().includes('◷ TMP-Z-EG'));

// ── 7. (c) Die Zukunft ist kein „gerade eben" ─────────────────────────────

console.log('\n(c) Zeitstempel aus der Zukunft — mit gestellter Uhr');

const t = sandbox.t;
const a = (sek) => P.alterText(iso(JETZT + sek * 1000), JETZT);
pruefe('jetzt → „gerade eben"', a(0).text === t('sensoren.alter.jetzt') && !a(0).zukunft);
pruefe('30 s voraus (Uhrenversatz) → noch „gerade eben"', a(30).text === t('sensoren.alter.jetzt'));
pruefe('5 min alt → „vor 5 min"', a(-300).text === t('sensoren.alter.min', { n: 5 }));
pruefe('3 h voraus → Zukunft, nicht „gerade eben"',
  a(3 * 3600).zukunft && a(3 * 3600).text === t('sensoren.zukunft.h', { n: 3 }), a(3 * 3600).text);
pruefe('13 Tage voraus → „in der Zukunft (+13 Tage)"',
  a(13 * 86400).text === t('sensoren.zukunft.tage', { n: 13 }), a(13 * 86400).text);
pruefe('ohne Zeitstempel → Strich statt Wurf', P.alterText(null, JETZT).text === '—');

// ── 8. Ohne Backend, ohne Werte, ohne Gedächtnis ──────────────────────────

console.log('\nOhne Backend, ohne Werte, im privaten Fenster');

backend = '';
P.zeichnen();
pruefe('ohne Backend steht ein erklärender Satz', html().includes(t('sensoren.ohneBackend')));
backend = 'http://example.invalid';

stand = vollerStand().map((s) => ({ ...s, zeit: null, wert: null, status: 'ohne' }));
P.zeichnen();
pruefe('ohne Werte ebenso', html().includes(t('sensoren.ohneWerte')));

P.schliessen();
speicherWirft = true;
let geworfen = null;
try { P.oeffnen(); P.schliessen(); } catch (e) { geworfen = e; }
pruefe('wirft localStorage (privates Fenster), geht Öffnen und Schließen trotzdem',
  geworfen === null, geworfen && geworfen.message);
speicherWirft = false;

// ── 9. Zweisprachig ───────────────────────────────────────────────────────

console.log('\nJeder Schlüssel steht in beiden Sprachen');

const schluessel = [...new Set(
  [...quelltext.matchAll(/\bt\('([a-zA-Z.]+)'/g)].map((m) => m[1])
    .filter((k) => !k.endsWith('.'))                                    // t('sensoren.' + wert)
    .concat(['sensoren.raumtemperatur', 'sensoren.wirkleistung']))];   // dynamisch: 'sensoren.' + wert
for (const sprache of ['de', 'en']) {
  sandbox.ILeenI18n.setLanguage(sprache);
  const offen = schluessel.filter((k) => sandbox.t(k) === k);
  pruefe(`${sprache}: alle ${schluessel.length} Schlüssel aufgelöst`, offen.length === 0,
    'fehlt: ' + offen.join(', '));
}
sandbox.ILeenI18n.setLanguage('de');

P.oeffnen();
stand = vollerStand();
sandbox.ILeenI18n.setLanguage('en');
pruefe('ein offenes Panel folgt dem Sprachwechsel',
  html().includes(sandbox.t('sensoren.raumtemperatur')) && html().includes('Room temperature'));
sandbox.ILeenI18n.setLanguage('de');
P.schliessen();

// ── Ergebnis ──────────────────────────────────────────────────────────────

console.log('');
if (fehler) { console.log(`${fehler} Prüfung(en) fehlgeschlagen.`); process.exit(1); }
console.log('Alle Prüfungen bestanden.');
