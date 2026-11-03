// Prüft die Sensorfarben (`sensor-farben.js`) ohne Browser und ohne Netz.
//
// Aufruf:  node tests/sensor-farben/test-sensor-farben.js
//
// Vier Dinge entscheiden, ob dieses Paket trägt:
//
// 1. **Der Steckplatz.** Ein Tileset hat genau einen Stil. Dieses Modul darf
//    deshalb keinen setzen, sondern nur Bedingungen liefern — und der Haken in
//    `features.js` muss auch dann laufen, wenn es die Datei gar nicht gibt.
//    Beides wird hier am Quelltext und an einer Sandbox nachgewiesen.
// 2. **Die Farbskala ist eine reine Funktion.** Derselbe Wert, dieselbe Farbe,
//    an den Rändern begrenzt. Eine Skala, die sich am Bestand streckt, ließe
//    zwei Bildschirmfotos unvergleichbar werden.
// 3. **Grau heißt nicht kaputt.** Ein Rückblick ist nach Stunden vollständig
//    veraltet. Veraltete und ausreißende Werte müssen anders aussehen als
//    gesunde — sonst ist ein stilles Datenproblem von einem gesunden Modell
//    nicht zu unterscheiden.
// 4. **Ein Neuaufbau je Ereignis.** Der Store bündelt bereits; hier noch einmal
//    je Sensor zu zeichnen hieße, den Stil vierundzwanzigmal zu bauen.

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

// ── Umgebung ──────────────────────────────────────────────────────────────

const JETZT = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
let stand = [];
let filterlaeufe = 0;
const zuhoerer = {};

const sandbox = {
  console: { log() {}, info() {}, warn() {}, error() {} },
  setTimeout: (f) => { f(); return 0; }, clearTimeout() {},
  Math, JSON, Number, Array, Object, String, Date, Set, Map, Error,
  document: {
    readyState: 'complete',
    addEventListener(typ, f) { (zuhoerer[typ] || (zuhoerer[typ] = [])).push(f); },
    dispatchEvent() {},
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
// Ein Store, der nur das kann, was das Farbmodul von ihm braucht.
sandbox.SensorStore = { stand: () => stand, starten() { sandbox.SensorStore.gestartet = true; } };
sandbox.BimViewer = {
  getBackendUrl: () => 'http://example.invalid',
  applyIFCFilter() { filterlaeufe++; },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'sensor-farben.js'), 'utf8'), sandbox);

const F = sandbox.SensorFarben;

function sensor(zone, wert, status, messgroesse) {
  return {
    sensor_id: 'TMP-' + zone, iri: 'iri-' + zone + '-' + (status || 'ok'),
    zone, wert, status: status || 'ok',
    messgroesse: messgroesse || 'raumtemperatur',
    einheit: '°C', zeit: JETZT(), intervall_s: 60,
    bereich_min: 5, bereich_max: 40,
  };
}

// ── 1. Der Store wird von selbst gestartet ────────────────────────────────

console.log('\nDer Store läuft ohne Zutun in der Konsole');

pruefe('das Modul hat SensorStore.starten() gerufen', sandbox.SensorStore.gestartet === true);
pruefe('es hört auf ileen:sensor-geaendert',
  Array.isArray(zuhoerer['ileen:sensor-geaendert']) && zuhoerer['ileen:sensor-geaendert'].length === 1);

// ── 2. Die Farbskala ist eine reine Funktion ──────────────────────────────

console.log('\nDie Farbskala ist eine reine Funktion');

const a = F.farbe(20, 'raumtemperatur');
const b = F.farbe(20, 'raumtemperatur');
pruefe('derselbe Wert ergibt dieselbe Farbe', a === b, `${a} vs ${b}`);
pruefe('sie ist eine Hexfarbe', /^#[0-9a-f]{6}$/.test(a), a);

const kalt = F.farbe(15, 'raumtemperatur');
const warm = F.farbe(25, 'raumtemperatur');
pruefe('kalt und warm unterscheiden sich', kalt !== warm, `${kalt} / ${warm}`);
pruefe('unterhalb des Bereichs wird begrenzt', F.farbe(-40, 'raumtemperatur') === kalt,
  F.farbe(-40, 'raumtemperatur'));
pruefe('oberhalb des Bereichs wird begrenzt', F.farbe(99, 'raumtemperatur') === warm,
  F.farbe(99, 'raumtemperatur'));
pruefe('kalt ist blaustichig', parseInt(kalt.slice(5, 7), 16) > parseInt(kalt.slice(1, 3), 16),
  kalt);
pruefe('warm ist rotstichig', parseInt(warm.slice(1, 3), 16) > parseInt(warm.slice(5, 7), 16),
  warm);

pruefe('null ergibt eine Farbe, keinen Wurf', /^#[0-9a-f]{6}$/.test(F.farbe(null)), F.farbe(null));
pruefe('undefined ebenso', /^#[0-9a-f]{6}$/.test(F.farbe(undefined)));
pruefe('NaN ebenso', /^#[0-9a-f]{6}$/.test(F.farbe(Number.NaN)));
pruefe('die Farbe für „kein Wert" ist keine Skalenfarbe',
  F.farbe(null) !== kalt && F.farbe(null) !== warm);

pruefe('eine zweite Messgröße hat eine eigene Skala',
  F.farbe(0, 'wirkleistung') === kalt && F.farbe(30, 'wirkleistung') === warm);

// ── 3. Bedingungen statt Stil ─────────────────────────────────────────────

console.log('\nDas Modul liefert Bedingungen und setzt keinen Stil');

const quelltext = fs.readFileSync(path.join(FRONTEND, 'sensor-farben.js'), 'utf8');
// Ohne Kommentare geprüft: der Dateikopf erklärt ausdrücklich, warum hier
// *kein* `tileset.style` gesetzt wird, und darf die Prüfung nicht auslösen.
const codeOhneKommentar = quelltext
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
pruefe('nirgends wird ein Stil zugewiesen', !/\.style\s*=/.test(codeOhneKommentar));
pruefe('kein Cesium3DTileStyle', !/Cesium3DTileStyle/.test(codeOhneKommentar));
pruefe('überhaupt kein Cesium', !/\bCesium\b/.test(codeOhneKommentar));

stand = [
  sensor('Z-UG', 16), sensor('Z-EG', 21), sensor('Z-OG1', 22),
  sensor('Z-OG2', 23), sensor('Z-OG3', 24), sensor('Z-DACH', 25),
  { ...sensor('Z-SITE', 999), messgroesse: 'arbeit' },
];

pruefe('ausgeschaltet liefert es nichts', F.bedingungen({}).length === 0);

F.an();
const bed = F.bedingungen({});
pruefe('eingeschaltet liefert es sechs Bedingungen', bed.length === 6, String(bed.length));
pruefe('jede ist ein Paar aus Bedingung und Farbe',
  bed.every((p) => Array.isArray(p) && p.length === 2 && /^color\('#[0-9a-f]{6}'\)$/.test(p[1])),
  JSON.stringify(bed[0]));
pruefe('sie fragen das Geschoss ab',
  bed.every((p) => /^\$\{Geschoss\} === '/.test(p[0])), bed[0] && bed[0][0]);

const geschosse = bed.map((p) => p[0].match(/'([^']+)'/)[1]).sort();
pruefe('alle sechs Geschosse kommen vor',
  JSON.stringify(geschosse) === JSON.stringify(['Dach', 'EG', 'OG-1', 'OG-2', 'OG-3', 'UG']),
  JSON.stringify(geschosse));
pruefe('Z-SITE färbt nichts — es hat kein Geschoss',
  !bed.some((p) => /SITE/i.test(p[0])));

const ug = bed.find((p) => /'UG'/.test(p[0]));
const dach = bed.find((p) => /'Dach'/.test(p[0]));
pruefe('das kühle UG und das warme Dach haben verschiedene Farben', ug[1] !== dach[1],
  `${ug[1]} / ${dach[1]}`);

// ── 4. Zustände sehen verschieden aus ─────────────────────────────────────

console.log('\nVeraltet und Ausreißer sehen anders aus als gesund');

const gesund = F.bedingungen({}).find((p) => /'EG'/.test(p[0]))[1];

stand = [sensor('Z-EG', 21, 'veraltet')];
const alt = F.bedingungen({}).find((p) => /'EG'/.test(p[0]))[1];
pruefe('veraltet ist nicht dieselbe Farbe wie gesund', alt !== gesund, `${alt} vs ${gesund}`);

const kanal = (s) => [1, 3, 5].map((i) => parseInt(s.match(/#([0-9a-f]{6})/)[1].slice(i - 1, i + 1), 16));
const spanne = (s) => { const k = kanal(s); return Math.max(...k) - Math.min(...k); };
pruefe('und zwar entsättigt — nicht bloß eine andere Buntheit',
  spanne(alt) < spanne(gesund), `Spanne ${spanne(alt)} < ${spanne(gesund)}`);

stand = [sensor('Z-EG', 99, 'ausreisser')];
const aus = F.bedingungen({}).find((p) => /'EG'/.test(p[0]))[1];
pruefe('ein Ausreißer ist auffällig und eigen', aus !== gesund && aus !== alt, aus);

stand = [sensor('Z-EG', null, 'ohne')];
const ohne = F.bedingungen({}).find((p) => /'EG'/.test(p[0]))[1];
pruefe('ohne Wert gibt es die neutrale Farbe', ohne.includes(F.farbe(null)), ohne);

stand = [sensor('Z-EG', 18, 'ok'), sensor('Z-EG', 22, 'ok')];
const gemittelt = F.bedingungen({}).find((p) => /'EG'/.test(p[0]))[1];
pruefe('zwei Fühler ergeben das Mittel', gemittelt === `color('${F.farbe(20)}')`, gemittelt);

stand = [sensor('Z-EG', 18, 'ok'), sensor('Z-EG', 22, 'veraltet')];
pruefe('ein gesunder Fühler zählt mehr als ein veralteter',
  F.bedingungen({}).find((p) => /'EG'/.test(p[0]))[1] === `color('${F.farbe(18)}')`);

// ── 5. Was nicht eingefärbt werden darf ───────────────────────────────────

console.log('\nPunktwolken, Splats und Tilesets ohne Geschoss');

stand = [sensor('Z-EG', 21)];
pruefe('eine Punktwolke bekommt keine Bedingung',
  F.bedingungen({ isPointCloud: true }).length === 0);
pruefe('ein Splat ebenso',
  F.bedingungen({ tileset: { _isGaussianSplat: true } }).length === 0);
let geworfen = null;
try { F.bedingungen(undefined); } catch (e) { geworfen = e; }
pruefe('bedingungen() ohne Argument wirft nicht', geworfen === null, geworfen && geworfen.message);
pruefe('ein Tileset ohne Geschoss bleibt ungefärbt, weil die Bedingung nie zutrifft',
  F.bedingungen({}).every((p) => p[0].includes('${Geschoss}')));

// ── 6. Ein Neuaufbau je Ereignis ──────────────────────────────────────────

console.log('\nEin Neuaufbau je Ereignis, nicht einer je Sensor');

filterlaeufe = 0;
zuhoerer['ileen:sensor-geaendert'][0]({ detail: { iris: ['a', 'b', 'c', 'd', 'e'] } });
pruefe('fünf geänderte Sensoren ergeben genau einen Filterlauf', filterlaeufe === 1,
  String(filterlaeufe));

filterlaeufe = 0;
zuhoerer['ileen:sensor-geaendert'][0]({ detail: { iris: ['a'] } });
zuhoerer['ileen:sensor-geaendert'][0]({ detail: { iris: ['b'] } });
pruefe('zwei Ereignisse ergeben zwei Läufe', filterlaeufe === 2, String(filterlaeufe));

F.aus();
filterlaeufe = 0;
zuhoerer['ileen:sensor-geaendert'][0]({ detail: { iris: ['a'] } });
pruefe('ausgeschaltet zeichnet ein Ereignis nichts neu', filterlaeufe === 0,
  String(filterlaeufe));

// ── 7. An und aus ─────────────────────────────────────────────────────────

console.log('\nAn und aus');

pruefe('nach aus() ist es aus', F.aktiv === false);
pruefe('und es liefert keine Bedingungen mehr — der Filter bekommt seinen Stil zurück',
  F.bedingungen({}).length === 0);
filterlaeufe = 0;
F.an();
pruefe('an() stößt einen Neuaufbau an', filterlaeufe === 1);
pruefe('und es ist an', F.aktiv === true);
F.an('wirkleistung');
pruefe('die Messgröße lässt sich umschalten', F.messgroesse === 'wirkleistung');
F.an('raumtemperatur');

// ── 8. Der Haken in features.js ───────────────────────────────────────────

console.log('\nDer Haken in features.js hält auch ohne dieses Modul');

const featuresQuelle = fs.readFileSync(path.join(FRONTEND, 'features.js'), 'utf8');
const stelle = featuresQuelle.match(
  /const sensorBedingungen = ([\s\S]*?);\n\s*const colorConditions = ([^\n]+)/);
pruefe('der Haken steht in features.js', !!stelle);
pruefe('er ist über window abgesichert',
  stelle && /window\.SensorFarben/.test(stelle[1]), stelle && stelle[1]);
pruefe('die Sensorbedingungen werden angehängt, nicht ersetzt',
  stelle && /hlBedingungen\.concat\(sensorBedingungen\)/.test(stelle[2]), stelle && stelle[2]);

// Derselbe Ausdruck in einer Welt ohne SensorFarben: er muss [] ergeben.
const ohneModul = { window: {} };
ohneModul.globalThis = ohneModul;
vm.createContext(ohneModul);
let ergebnis = null; geworfen = null;
try {
  ergebnis = vm.runInContext('(' + stelle[1] + ')', ohneModul);
} catch (e) { geworfen = e; }
pruefe('ohne sensor-farben.js wirft der Ausdruck nicht', geworfen === null,
  geworfen && geworfen.message);
pruefe('und liefert eine leere Liste — der Filter läuft unverändert',
  Array.isArray(ergebnis) && ergebnis.length === 0, JSON.stringify(ergebnis));

// ── Ergebnis ──────────────────────────────────────────────────────────────

console.log('');
if (fehler) { console.log(`${fehler} Prüfung(en) fehlgeschlagen.`); process.exit(1); }
console.log('Alle Prüfungen bestanden.');
