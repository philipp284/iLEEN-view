// Prüft die Sensorablage (`sensor-store.js`) ohne Browser und ohne Netz.
//
// Aufruf:  node tests/sensor-store/test-sensor-store.js
//
// Vier Eigenschaften entscheiden, ob dieser Store trägt — und drei davon
// brechen still:
//
// 1. **Die Quelle ist austauschbar.** Das ist der Zweck des Pakets: in Paket 4
//    tritt ein WebSocket an die Stelle der HTTP-Abfrage. Käme `fetch`
//    irgendwo außerhalb der mitgelieferten Quelle vor, wäre das Vorziehen der
//    Darstellung ein Umbau statt eines Einsteckens. Die Sandbox hier hat
//    deshalb **kein** `fetch` — ein versehentlicher Aufruf wirft sofort.
// 2. **Ein Ereignis je Schub, keines ohne Änderung.** Ein Ereignis je Sensor
//    wären vierundzwanzig Zeichendurchläufe statt einem; ein Ereignis ohne
//    Änderung lässt den Viewer im Abfragetakt neu zeichnen, ohne dass sich
//    etwas geändert hätte.
// 3. **Veraltete Werte.** Ein eingefrorener Sensor meldet weiter `ok`. Ohne
//    die Altersprüfung zeigte der Viewer den Wert unbegrenzt weiter, und
//    niemand sähe den Unterschied zu einem lebenden.
// 4. **Ausfall ist ein Zustand, kein Fehler.** Der Store muss die letzten
//    Werte behalten und darf die Konsole nicht im Sekundentakt füllen.

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

// ── Umgebung: so wenig Browser wie möglich, und ausdrücklich kein Netz ─────

const ereignisse = [];
const warnungen = [];

const sandbox = {
  console: {
    log() {}, info() {},
    warn(...a) { warnungen.push(a.join(' ')); },
    error(...a) { warnungen.push(a.join(' ')); },
  },
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  Date, Math, JSON, Number, Array, Object, Set, Map, Error,
  document: {
    dispatchEvent(e) { ereignisse.push(e); return true; },
    addEventListener() {},
  },
  CustomEvent: class { constructor(t, o) { Object.assign(this, { type: t }, o); } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'sensor-store.js'), 'utf8'), sandbox);

const Store = sandbox.SensorStore;

// ── Testdaten: ein Ausschnitt des echten Registers aus #2 ─────────────────

const JETZT = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// Ein fester Zeitstempel für alle Schübe, die „dasselbe" sein sollen. Mit
// JETZT() je Aufruf unterschieden sich zwei solche Schübe, sobald zwischen
// ihnen eine Sekundengrenze lag — der Store meldete dann zu Recht eine
// Änderung, und die Prüfung „keine Änderung, kein Ereignis" schlug in etwa
// einem von vierzig Läufen fehl. Der Fehler lag im Prüfstein, nicht im Store.
const T0 = JETZT();
// Mit Millisekunden: auf die Sekunde abgeschnitten wäre VOR(179) bis zu einer
// Sekunde älter — genau an der Grenze von 180 s, die die Prüfung abtastet.
const VOR = (sekunden) => new Date(Date.now() - sekunden * 1000).toISOString();

const SITE = '20FpTZCqJy2vhVJYtjuIce';
const DACH = '0xGtk$Xo5FKhcFT3k0GTWG';

function eintrag(sensor_id, iri, anker_guid, wert, zeit, status) {
  return {
    sensor_id, iri, anker_guid, zeit, wert,
    status: status || 'ok',
    einheit: '°C', intervall_s: 60, zone: 'Z-SITE',
    anker_iri: 'egal-' + anker_guid, brick_klasse: 'brick:Air_Temperature_Sensor',
    bereich_min: 5.0, bereich_max: 40.0,
  };
}

function schub(werte) {
  return [
    eintrag('ELT-GESAMT', 'iri-elt', SITE, werte.elt, werte.zeit || JETZT()),
    eintrag('MET-GHI', 'iri-ghi', SITE, 500, werte.zeit || JETZT()),
    eintrag('MET-TA', 'iri-ta', SITE, 15, werte.zeit || JETZT()),
    eintrag('TMP-DACH-N', 'iri-dn', DACH, 21, werte.zeit || JETZT()),
    eintrag('TMP-DACH-S', 'iri-ds', DACH, 22, werte.zeit || JETZT()),
    eintrag('PWR-DACH', 'iri-pd', DACH, 2, werte.zeit || JETZT()),
    eintrag('PV-P', 'iri-pvp', DACH, 40, werte.zeit || JETZT()),
    eintrag('PV-E', 'iri-pve', DACH, 300, werte.zeit || JETZT()),
    eintrag('PV-TMOD', 'iri-pvt', DACH, 30, werte.zeit || JETZT()),
  ];
}

// Eine Attrappe, die von außen gefüttert wird — der Store soll nie selbst
// entscheiden, wann Werte kommen.
function attrappe() {
  const q = {
    gestartet: false, gestoppt: false, aufWerte: null,
    start(aufWerte) { q.gestartet = true; q.aufWerte = aufWerte; },
    stop() { q.gestoppt = true; },
  };
  return q;
}

// ── 1. Die Quelle ist austauschbar, und es fließt kein Netz ───────────────

console.log('\nDie Quelle ist austauschbar');

pruefe('die Sandbox hat gar kein fetch', typeof sandbox.fetch === 'undefined');

const q1 = attrappe();
Store.starten({ quelle: q1 });
pruefe('starten() reicht die Attrappe durch', q1.gestartet === true);
pruefe('und übergibt ihr einen Rückruf', typeof q1.aufWerte === 'function');
pruefe('der Store läuft', Store.laeuft === true);

// ── 2. Werte übernehmen ───────────────────────────────────────────────────

console.log('\nNach dem ersten Schub sind die Werte da');

q1.aufWerte(schub({ elt: 1000, zeit: T0 }));
const alle = Store.stand();
pruefe('neun Sensoren bekannt', alle.length === 9, `sind ${alle.length}`);

const elt = Store.sensor('iri-elt');
pruefe('Wert übernommen', elt && elt.wert === 1000, JSON.stringify(elt));
pruefe('Registerangaben dabei',
  elt && elt.sensor_id === 'ELT-GESAMT' && elt.einheit === '°C'
  && elt.anker_guid === SITE && elt.bereich_min === 5 && elt.bereich_max === 40);
pruefe('Zeit und Status dabei', elt && !!elt.zeit && elt.status === 'ok');

// ── 3. Die Zuordnung Bauteil → Sensoren ───────────────────────────────────

console.log('\nDie Zuordnung läuft über die GlobalId des Ankers');

const amSite = Store.amBauteil(SITE).map((s) => s.sensor_id).sort();
pruefe('IfcSite trägt genau drei Sensoren',
  JSON.stringify(amSite) === JSON.stringify(['ELT-GESAMT', 'MET-GHI', 'MET-TA']),
  JSON.stringify(amSite));

pruefe('das Dach trägt sechs', Store.amBauteil(DACH).length === 6,
  String(Store.amBauteil(DACH).length));

const leer = Store.amBauteil('GIBT-ES-NICHT');
pruefe('ein Bauteil ohne Sensoren liefert [] — kein undefined, kein Wurf',
  Array.isArray(leer) && leer.length === 0);
pruefe('amBauteil() ohne Argument wirft nicht', Array.isArray(Store.amBauteil()));
pruefe('sensor() einer unbekannten IRI liefert null', Store.sensor('nichts') === null);

// ── 4. Das Ereignis ───────────────────────────────────────────────────────

console.log('\nGenau ein Ereignis je Schub — und keines ohne Änderung');

pruefe('der erste Schub hat genau ein Ereignis ausgelöst', ereignisse.length === 1,
  String(ereignisse.length));
pruefe('es heißt ileen:sensor-geaendert', ereignisse[0].type === 'ileen:sensor-geaendert');
pruefe('und trägt alle neun geänderten IRI',
  ereignisse[0].detail && ereignisse[0].detail.iris.length === 9);

ereignisse.length = 0;
q1.aufWerte(schub({ elt: 1000, zeit: T0 }));
pruefe('derselbe Schub noch einmal löst KEIN Ereignis aus', ereignisse.length === 0,
  String(ereignisse.length));

ereignisse.length = 0;
q1.aufWerte(schub({ elt: 1001, zeit: T0 }));
pruefe('ein geänderter Wert löst genau eines aus', ereignisse.length === 1);
pruefe('und nennt nur die eine geänderte IRI',
  ereignisse[0].detail.iris.length === 1 && ereignisse[0].detail.iris[0] === 'iri-elt',
  JSON.stringify(ereignisse[0].detail.iris));
pruefe('der neue Wert steht im Stand', Store.sensor('iri-elt').wert === 1001);

// ── 5. Veraltet ───────────────────────────────────────────────────────────

console.log('\nEin zu alter Wert gilt als veraltet, auch wenn die Quelle ok sagt');

q1.aufWerte([eintrag('TMP-ALT', 'iri-alt', SITE, 21, VOR(600), 'ok')]);
const alt = Store.sensor('iri-alt');
pruefe('zehn Minuten alt bei 60-s-Takt → veraltet', alt.status === 'veraltet', alt.status);

q1.aufWerte([eintrag('TMP-FRISCH', 'iri-frisch', SITE, 21, VOR(60), 'ok')]);
pruefe('eine Minute alt → bleibt ok', Store.sensor('iri-frisch').status === 'ok');

q1.aufWerte([eintrag('TMP-GRENZE', 'iri-grenze', SITE, 21, VOR(179), 'ok')]);
pruefe('knapp unter dem Dreifachen (179 s) → noch ok',
  Store.sensor('iri-grenze').status === 'ok');
q1.aufWerte([eintrag('TMP-DRUEBER', 'iri-drueber', SITE, 21, VOR(181), 'ok')]);
pruefe('knapp darüber (181 s) → veraltet',
  Store.sensor('iri-drueber').status === 'veraltet');

const eingefroren = eintrag('TMP-OG2-N', 'iri-frost', SITE, 21.48, VOR(600), 'veraltet');
q1.aufWerte([eingefroren]);
pruefe('ein Sensor, der sich selbst veraltet meldet, bleibt veraltet',
  Store.sensor('iri-frost').status === 'veraltet');

q1.aufWerte([eintrag('TMP-AUS', 'iri-aus', SITE, 99, VOR(600), 'ausreisser')]);
pruefe('ein Ausreißer wird durch die Altersregel nicht überschrieben',
  Store.sensor('iri-aus').status === 'ausreisser', Store.sensor('iri-aus').status);

// ── 6. Ausfall ist ein Zustand ────────────────────────────────────────────

console.log('\nEine Quelle, die wirft, reißt den Store nicht mit');

warnungen.length = 0;
const kaputt = {
  start() { throw new Error('Verbindung abgelehnt'); },
  stop() {},
};
const vorher = Store.sensor('iri-elt').wert;
Store.starten({ quelle: kaputt });
pruefe('starten() wirft nicht', true);
pruefe('die letzten Werte sind noch da', Store.sensor('iri-elt').wert === vorher);
pruefe('genau eine Meldung in der Konsole', warnungen.length === 1,
  `sind ${warnungen.length}`);

Store.starten({ quelle: kaputt });
Store.starten({ quelle: kaputt });
pruefe('auch nach weiteren Fehlversuchen bleibt es bei einer Meldung',
  warnungen.length === 1, `sind ${warnungen.length}`);

// ── 7. Beenden ────────────────────────────────────────────────────────────

console.log('\nNach beenden() ist Ruhe');

const q2 = attrappe();
Store.starten({ quelle: q2 });
Store.beenden();
pruefe('die Quelle wurde gestoppt', q2.gestoppt === true);
pruefe('der Store läuft nicht mehr', Store.laeuft === false);

ereignisse.length = 0;
q2.aufWerte(schub({ elt: 2222, zeit: T0 }));
pruefe('ein verspäteter Schub löst kein Ereignis mehr aus', ereignisse.length === 0);
pruefe('und ändert die Werte nicht', Store.sensor('iri-elt').wert !== 2222);

// ── 8. Ohne Backend bleibt der Store still ────────────────────────────────

console.log('\nOhne eingerichtetes Backend wirft nichts');

warnungen.length = 0;
sandbox.window.ILEEN_CONFIG = { backendUrl: '' };
let geworfen = null;
try { Store.starten(); } catch (e) { geworfen = e; }
pruefe('starten() ohne Backend wirft nicht', geworfen === null,
  geworfen && geworfen.message);
pruefe('und ruft kein fetch — sonst wäre die Sandbox darüber gestolpert', true);
pruefe('keine Warnung, denn das ist kein Fehler', warnungen.length === 0,
  warnungen.join(' | '));
Store.beenden();

// ── 9. Der Store zeichnet nichts ──────────────────────────────────────────

console.log('\nDer Store zeichnet nichts und kennt kein Netz außerhalb seiner Quelle');

const quelltext = fs.readFileSync(path.join(FRONTEND, 'sensor-store.js'), 'utf8');
pruefe('kein Cesium', !/\bCesium\b/.test(quelltext));
pruefe('kein innerHTML', !/innerHTML/.test(quelltext));
pruefe('kein querySelector', !/querySelector/.test(quelltext));

const ohneQuelle = quelltext.replace(/function httpQuelle\(\)[\s\S]*?\n  }\n/, '');
pruefe('fetch steht ausschließlich in httpQuelle()', !/\bfetch\s*\(/.test(ohneQuelle));
pruefe('setInterval steht ausschließlich in httpQuelle()',
  !/\bsetInterval\s*\(/.test(ohneQuelle));

// ── Ergebnis ──────────────────────────────────────────────────────────────

console.log('');
if (fehler) { console.log(`${fehler} Prüfung(en) fehlgeschlagen.`); process.exit(1); }
console.log('Alle Prüfungen bestanden.');
