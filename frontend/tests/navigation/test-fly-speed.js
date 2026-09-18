// Prüft die Geschwindigkeitsstufen des Flugmodus ohne Browser — vor allem
// Stufe 0, die Rampe: aus dem Stand heraus beschleunigen, bis nach fünf
// Sekunden die Höchstgeschwindigkeit von Stufe 6 erreicht ist.
//
// Aufruf:  node tests/navigation/test-fly-speed.js
//
// Warum gerade diese Stellen: Eine Rampe, die um den Faktor zehn danebenliegt,
// sieht im Browser genauso aus wie eine richtige — man ist entweder zu früh im
// Nichts oder nach fünf Sekunden immer noch über dem Dach. Und ein fehlender
// Deckel fällt erst auf, wenn jemand die Taste zehn Sekunden hält.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');
const R = 6371000;              // Kugelerde — für die Rampe genau genug
const DT = 1 / 60;

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}

// ── Cesium-Ersatz, gerade groß genug für walkMode.js ──────────────────────

class C3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static magnitude(v) { return Math.sqrt(C3.dot(v, v)); }
  static add(a, b, z) { z.x = a.x + b.x; z.y = a.y + b.y; z.z = a.z + b.z; return z; }
  static subtract(a, b, z) { z.x = a.x - b.x; z.y = a.y - b.y; z.z = a.z - b.z; return z; }
  static multiplyByScalar(v, s, z) { z.x = v.x * s; z.y = v.y * s; z.z = v.z * s; return z; }
  static negate(v, z) { z.x = -v.x; z.y = -v.y; z.z = -v.z; return z; }
  static normalize(v, z) {
    const l = C3.magnitude(v) || 1;
    z.x = v.x / l; z.y = v.y / l; z.z = v.z / l; return z;
  }
  static cross(a, b, z) {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const w = a.x * b.y - a.y * b.x;
    z.x = x; z.y = y; z.z = w; return z;
  }
  // Nur der Nordpol-Meridian wird gebraucht: lon = 0.
  static fromRadians(lon, lat, hoehe) {
    const r = R + hoehe;
    return new C3(r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat));
  }
}

const ellipsoid = {
  geodeticSurfaceNormal: (p, z) => C3.normalize(p, z || new C3()),
  cartesianToCartographic: (p) => {
    const r = C3.magnitude(p);
    return { longitude: Math.atan2(p.y, p.x), latitude: Math.asin(p.z / r), height: r - R };
  },
};

const Cesium = { Cartesian3: C3, Ray: function (o, d) { this.origin = o; this.direction = d; } };

// ── Gestellter Browser + Viewer ───────────────────────────────────────────

function stelleAuf(hoehe) {
  const zeit = { jetzt: 0 };
  const handler = {};
  const stubEl = () => ({
    style: {}, textContent: '', setAttribute() {}, focus() {},
    addEventListener() {}, appendChild() {},
  });

  const kontext = {
    Cesium,
    console: { log() {}, warn() {}, error(...a) { fehler++; console.log('  ! Fehler im Loop:', ...a); } },
    performance: { now: () => zeit.jetzt },
    window: { addEventListener: (t, f) => { (handler[t] ||= []).push(f); } },
    document: {
      addEventListener: (t, f) => { (handler[t] ||= []).push(f); },
      createElement: stubEl, getElementById: () => null,
      body: { appendChild() {} }, head: { appendChild() {} },
      activeElement: null, pointerLockElement: null,
    },
  };
  kontext.window.window = kontext.window;
  vm.createContext(kontext);
  vm.runInContext(fs.readFileSync(path.join(WURZEL, 'walkMode.js'), 'utf8'), kontext, { filename: 'walkMode.js' });

  const camera = {
    position: new C3(0, 0, R + hoehe),   // Nordpol, Höhe über Kugel
    heading: 0, pitch: -Math.PI / 2, setView() {},
  };
  let update = null;
  const viewer = {
    canvas: stubEl(),
    camera,
    scene: {
      screenSpaceCameraController: {},
      preRender: { addEventListener: (f) => { update = f; return () => { update = null; }; } },
      globe: { ellipsoid, pick: () => null, getHeight: () => 0 },
      pickFromRay: () => null,
    },
  };

  const WalkMode = kontext.window.WalkMode;
  WalkMode.init(viewer);

  return {
    WalkMode, camera, kontext,
    taste: (code, runter = true) => (handler[runter ? 'keydown' : 'keyup'] || [])
      .forEach(f => f({ code, preventDefault() {} })),
    frames: (sekunden) => {
      const n = Math.round(sekunden / DT);
      for (let i = 0; i < n; i++) { zeit.jetzt += DT * 1000; update && update(); }
    },
    hoehe: () => C3.magnitude(camera.position) - R,
  };
}

// ── 1 · Die Rampe trifft ihr Ziel ─────────────────────────────────────────

{
  const t = stelleAuf(2);
  t.WalkMode.setMode('fly');
  t.WalkMode.toggle(true);
  t.WalkMode.setSpeedLevel(-1);

  pruefe('Stufe 0 ist gesetzt', t.WalkMode.getSpeedLevel() === -1);
  pruefe('Startgeschwindigkeit liegt unter Stufe 1',
    t.WalkMode.getSpeedValue() > 0 && t.WalkMode.getSpeedValue() < 1,
    `ist ${t.WalkMode.getSpeedValue()}`);

  t.taste('KeyE');                 // senkrecht hoch
  t.frames(1);
  pruefe('nach 1 s im Bereich von Stufe 2 (3 m/s)',
    t.WalkMode.getSpeedValue() > 1.5 && t.WalkMode.getSpeedValue() < 4,
    `${t.WalkMode.getSpeedValue().toFixed(1)} m/s`);

  t.frames(2);                     // zusammen 3 s
  pruefe('nach 3 s im Bereich von Stufe 4 (20 m/s)',
    t.WalkMode.getSpeedValue() > 15 && t.WalkMode.getSpeedValue() < 30,
    `${t.WalkMode.getSpeedValue().toFixed(1)} m/s`);

  t.frames(2);                     // zusammen 5 s
  const stufe6 = t.WalkMode.getSpeedLevels()[5];
  pruefe('nach 5 s steht die Höchstgeschwindigkeit von Stufe 6 an',
    Math.abs(t.WalkMode.getSpeedValue() - stufe6) < 1,
    `${t.WalkMode.getSpeedValue().toFixed(1)} statt ${stufe6} m/s`);
  const h5 = t.hoehe();
  pruefe('der Anlauf hat dabei rund 180 m gekostet', h5 > 150 && h5 < 220,
    `${h5.toFixed(0)} m`);

  t.frames(5);                     // weiter halten
  pruefe('darüber hinaus wird nicht schneller',
    t.WalkMode.getSpeedValue() === stufe6, `${t.WalkMode.getSpeedValue()} m/s`);
  pruefe('mit Höchstgeschwindigkeit geht es gleichmäßig weiter',
    Math.abs((t.hoehe() - h5) - 5 * stufe6) < 5, `${(t.hoehe() - h5).toFixed(0)} m in 5 s`);

  // Loslassen setzt die Rampe zurück
  t.taste('KeyE', false);
  t.frames(0.2);
  pruefe('Loslassen setzt auf Startgeschwindigkeit zurück',
    t.WalkMode.getSpeedValue() < 1, `ist ${t.WalkMode.getSpeedValue()}`);
}

// ── 2 · Abwärts gilt dasselbe ─────────────────────────────────────────────

{
  const t = stelleAuf(1000);
  t.WalkMode.setMode('fly');
  t.WalkMode.toggle(true);
  t.WalkMode.setSpeedLevel(-1);

  t.taste('KeyQ');                 // senkrecht runter
  t.frames(5);
  const gefallen = 1000 - t.hoehe();
  pruefe('Sinkflug läuft dieselbe Rampe', gefallen > 150 && gefallen < 220,
    `${gefallen.toFixed(0)} m`);
  // Nach 300 Bildern à 1/60 s liegt die aufsummierte Haltedauer um Haaresbreite
  // unter fünf Sekunden — der Deckel greift ein Bild später, exakt.
  t.frames(0.2);
  pruefe('auch abwärts endet es bei Stufe 6',
    t.WalkMode.getSpeedValue() === t.WalkMode.getSpeedLevels()[5],
    `${t.WalkMode.getSpeedValue()} m/s`);
}

// ── 3 · Die festen Stufen bleiben fest ────────────────────────────────────

{
  const t = stelleAuf(1000);
  t.WalkMode.setMode('fly');
  t.WalkMode.toggle(true);
  t.WalkMode.setSpeedLevel(2);     // 7 m/s

  t.taste('KeyE');
  t.frames(5);
  const zuwachs = t.hoehe() - 1000;
  pruefe('Stufe 3 fliegt 5 s lang konstant 7 m/s', Math.abs(zuwachs - 35) < 0.5,
    `${zuwachs.toFixed(2)} m`);
  pruefe('Stufe 3 meldet weiterhin 7 m/s', t.WalkMode.getSpeedValue() === 7);
}

// ── 4 · Taste 0 und Taste 1-6 ─────────────────────────────────────────────

{
  const t = stelleAuf(10);
  t.WalkMode.setMode('fly');
  t.WalkMode.toggle(true);

  t.taste('Digit0');
  pruefe('Taste 0 schaltet auf die Rampe', t.WalkMode.getSpeedLevel() === -1);
  t.taste('Digit4');
  pruefe('Taste 4 schaltet zurück auf 20 m/s',
    t.WalkMode.getSpeedLevel() === 3 && t.WalkMode.getSpeedValue() === 20);
  t.WalkMode.setSpeedLevel(-99);
  pruefe('unsinnige Stufen fallen auf die unterste', t.WalkMode.getSpeedLevel() === 0);
}

// ── 5 · Im Walk-Modus ist Stufe 0 nur die langsamste Gangart ──────────────

{
  const t = stelleAuf(1.8);
  t.WalkMode.toggle(true);         // Voreinstellung: walk
  t.WalkMode.setSpeedLevel(-1);

  t.taste('KeyW');
  t.frames(5);
  pruefe('Walk beschleunigt nicht', t.WalkMode.getSpeedValue() < 1,
    `ist ${t.WalkMode.getSpeedValue()}`);
}

// ── 6 · Anzeige ───────────────────────────────────────────────────────────

{
  const t = stelleAuf(2);
  const f = t.WalkMode.formatSpeed;
  pruefe('Anzeige unter 10 m/s mit Nachkommastelle', f(0.8) === '0.8 m/s');
  pruefe('Anzeige der Höchstgeschwindigkeit', f(200) === '200 m/s');
  pruefe('Sprint bleibt lesbar', f(500) === '500 m/s');
}

console.log(fehler === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
