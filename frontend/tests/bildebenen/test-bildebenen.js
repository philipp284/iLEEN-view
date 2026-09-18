// Die Bildebenen ohne Browser.
//
// Aufruf:  node tests/bildebenen/test-bildebenen.js
//
// Was hier NICHT geprüft werden kann, ist das Bild: ob Cesium die Textur so
// auf das Einheitsquadrat legt, wie der Kopf von bildebenen.js es herleitet,
// zeigt erst der Blick auf ein gesetztes Bild. Prüfbar — und geprüft — ist
// alles, was davor entscheidet, WO und WIE HERUM die Fläche im Raum steht.
// Genau dort sitzen die Fehler, die nachher als „das Bild steht auf dem Kopf"
// oder „das Bild klebt in der Wand" ankommen:
//
//   1. Die Achsen (`basis`). An einer senkrechten Wand muss die Rechtsachse
//      waagerecht liegen — sonst hängt der Aushang schief. Auf einer
//      waagerechten Fläche gibt es keine solche Achse; dann MUSS Osten die
//      Rechtsachse sein, damit Norden oben liegt.
//   2. Die Spaltenbelegung der Matrix. Die vier Ecken des Einheitsquadrats
//      müssen durch sie auf die vier Ecken des Bildes im Raum fallen, mit den
//      richtigen Maßen — und die Ecke mit st (1,1) MUSS oben rechts landen.
//      Sind Spalte 0 und 1 vertauscht, steht jedes Bild um 90° gekippt.
//   3. Die Drehung um die Normale. Sie darf die Ebene nicht verlassen: nach
//      der Drehung muss die Rechtsachse weiter senkrecht auf der Normalen
//      stehen, sonst wird das Rechteck zum Parallelogramm.
//   4. Die Abhebung. Sie MUSS entlang der Normalen laufen und nicht entlang
//      der Hochachse — an einer senkrechten Wand hübe das Bild sonst an,
//      statt von der Wand wegzurücken, und flimmerte weiter.
//   5. Der Anker. Rückt das Modell, MUSS die Ebene mitwandern; ist es nicht
//      geladen, darf sie GAR NICHT gebaut werden (ihre Koordinaten stehen im
//      Kachelrahmen — als Weltkoordinaten gelesen landet sie in Erdnähe).
//   6. Die Maßstabseingabe. „1:100" und „100" sind dasselbe, alles andere ist
//      kein Maßstab.
//   7. Die Ablage. Kein Primitive, kein Bild, keine Matrix in localStorage —
//      ein mitgeschriebenes Primitive wäre ein Zyklus und damit eine Ausnahme
//      statt eines gesicherten Zustands.
//   8. Das Aufziehen. Das Rechteck MUSS von der gedrückten Ecke weg wachsen,
//      in die gezogene Richtung, und bei gesperrtem Seitenverhältnis MUSS die
//      LÄNGERE gezogene Kante den Ausschlag geben — sonst schrumpft ein
//      Hochformat auf nichts, sobald jemand vorwiegend nach unten zieht, und
//      genau so zieht man ein Hochformat auf.
//   9. Das Schieben. Es MUSS in der Ebene des Bildes bleiben: die Mitte darf
//      sich um keinen Millimeter entlang der Normalen bewegen, sonst wandert
//      ein Bild an einer schrägen Wand bei jedem Zug von der Wand weg.

const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ── Cesium-Ersatz ─────────────────────────────────────────────────────────
//
// Anders als beim Prüfstein der Geschossgrundrisse sind Matrizen hier echt:
// geprüft wird ja gerade die Spaltenbelegung. Cesium führt sie spaltenweise,
// also Index = Spalte * n + Zeile — die Umrechnung falsch zu stubben hieße,
// den Fehler in den Prüfstein zu verlegen statt ihn zu finden.

class C3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static clone(a, r) { if (!r) return new C3(a.x, a.y, a.z); r.x = a.x; r.y = a.y; r.z = a.z; return r; }
  static add(a, b, r) { const x = a.x + b.x, y = a.y + b.y, z = a.z + b.z; r.x = x; r.y = y; r.z = z; return r; }
  static subtract(a, b, r) { const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z; r.x = x; r.y = y; r.z = z; return r; }
  static multiplyByScalar(a, s, r) { const x = a.x * s, y = a.y * s, z = a.z * s; r.x = x; r.y = y; r.z = z; return r; }
  static negate(a, r) { const x = -a.x, y = -a.y, z = -a.z; r.x = x; r.y = y; r.z = z; return r; }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static magnitude(a) { return Math.hypot(a.x, a.y, a.z); }
  static distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  static cross(a, b, r) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    r.x = x; r.y = y; r.z = z; return r;
  }
  static divideByScalar(a, s, r) { const x = a.x / s, y = a.y / s, z = a.z / s; r.x = x; r.y = y; r.z = z; return r; }
  static normalize(a, r) {
    const l = Math.hypot(a.x, a.y, a.z) || 1;
    const x = a.x / l, y = a.y / l, z = a.z / l;
    r.x = x; r.y = y; r.z = z; return r;
  }
}
C3.UNIT_X = new C3(1, 0, 0);
C3.UNIT_Y = new C3(0, 1, 0);
C3.UNIT_Z = new C3(0, 0, 1);

class C2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }

/**
 * Spaltenweise, wie Cesium: Index = Spalte * 3 + Zeile.
 *
 * Eine Funktion und kein Literal, weil das Modul `new Cesium.Matrix3()`
 * schreibt — `new` gibt das zurückgegebene Objekt heraus.
 */
function M3() { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
Object.assign(M3, {
  IDENTITY: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  clone: (m, r) => { const z = r || []; for (let i = 0; i < 9; i++) z[i] = m[i]; return z; },
  setColumn: (m, i, c, r) => { const z = M3.clone(m, r); z[i * 3] = c.x; z[i * 3 + 1] = c.y; z[i * 3 + 2] = c.z; return z; },
  getColumn: (m, i, r) => { r.x = m[i * 3]; r.y = m[i * 3 + 1]; r.z = m[i * 3 + 2]; return r; },
  multiplyByVector: (m, v, r) => {
    const x = m[0] * v.x + m[3] * v.y + m[6] * v.z;
    const y = m[1] * v.x + m[4] * v.y + m[7] * v.z;
    const z = m[2] * v.x + m[5] * v.y + m[8] * v.z;
    r.x = x; r.y = y; r.z = z; return r;
  },
  fromQuaternion: (q) => {
    const { x, y, z, w } = q;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
      2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
      2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)
    ];
  }
});

/** Spaltenweise, Index = Spalte * 4 + Zeile. Funktion wie M3, siehe dort. */
function M4() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
Object.assign(M4, {
  IDENTITY: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  clone: (m, r) => { const z = r || []; for (let i = 0; i < 16; i++) z[i] = m[i]; return z; },
  equals: (a, b) => { if (!a || !b) return a === b; for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false; return true; },
  fromRotationTranslation: (m3, t, r) => {
    const z = r || [];
    z[0] = m3[0]; z[1] = m3[1]; z[2] = m3[2]; z[3] = 0;
    z[4] = m3[3]; z[5] = m3[4]; z[6] = m3[5]; z[7] = 0;
    z[8] = m3[6]; z[9] = m3[7]; z[10] = m3[8]; z[11] = 0;
    z[12] = t.x; z[13] = t.y; z[14] = t.z; z[15] = 1;
    return z;
  },
  fromTranslation: (t, r) => M4.fromRotationTranslation(M3.IDENTITY, t, r),
  getTranslation: (m, r) => { r.x = m[12]; r.y = m[13]; r.z = m[14]; return r; },
  getMatrix3: (m, r) => {
    const z = r || [];
    z[0] = m[0]; z[1] = m[1]; z[2] = m[2];
    z[3] = m[4]; z[4] = m[5]; z[5] = m[6];
    z[6] = m[8]; z[7] = m[9]; z[8] = m[10];
    return z;
  },
  multiplyByPoint: (m, v, r) => {
    const x = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12];
    const y = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13];
    const z = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
    r.x = x; r.y = y; r.z = z; return r;
  },
  multiplyByPointAsVector: (m, v, r) => {
    const x = m[0] * v.x + m[4] * v.y + m[8] * v.z;
    const y = m[1] * v.x + m[5] * v.y + m[9] * v.z;
    const z = m[2] * v.x + m[6] * v.y + m[10] * v.z;
    r.x = x; r.y = y; r.z = z; return r;
  },
  // Reicht für drehstarre Rahmen — und nur solche kommen als Anker vor
  // (siehe `_verankern()`): R⁻¹ = Rᵀ, t⁻¹ = −Rᵀ·t.
  inverse: (m, r) => {
    const z = r || [];
    z[0] = m[0]; z[1] = m[4]; z[2] = m[8]; z[3] = 0;
    z[4] = m[1]; z[5] = m[5]; z[6] = m[9]; z[7] = 0;
    z[8] = m[2]; z[9] = m[6]; z[10] = m[10]; z[11] = 0;
    z[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
    z[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
    z[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
    z[15] = 1;
    return z;
  }
});

const R_ERDE = 6378137;

const Cesium = {
  Cartesian2: C2,
  Cartesian3: C3,
  Matrix3: M3,
  Matrix4: M4,
  Math: { toRadians: (g) => g * Math.PI / 180 },
  defined: (v) => v !== undefined && v !== null,
  Color: class { constructor(r, g, b, a) { this.red = r; this.green = g; this.blue = b; this.alpha = a; } },
  Quaternion: {
    fromAxisAngle: (achse, winkel) => {
      const h = winkel / 2, s = Math.sin(h);
      return { x: achse.x * s, y: achse.y * s, z: achse.z * s, w: Math.cos(h) };
    }
  },
  Ellipsoid: {
    WGS84: {
      // Kugelnäherung: für die Frage „welche Achse ist oben" ist die
      // Abplattung ohne Belang, und eine echte Ellipsoidnormale hier
      // nachzubauen hieße Cesium ein zweites Mal zu schreiben.
      geodeticSurfaceNormal: (p, r) => C3.normalize(p, r || new C3())
    }
  },
  Transforms: {
    eastNorthUpToFixedFrame: (p) => {
      const oben = C3.normalize(p, new C3());
      const ost = C3.normalize(C3.cross(C3.UNIT_Z, oben, new C3()), new C3());
      const nord = C3.cross(oben, ost, new C3());
      let m = M4.clone(M4.IDENTITY);
      m = [ost.x, ost.y, ost.z, 0, nord.x, nord.y, nord.z, 0,
           oben.x, oben.y, oben.z, 0, p.x, p.y, p.z, 1];
      return m;
    }
  },
  BoundingSphere: class { constructor(c, r) { this.center = c; this.radius = r; } },
  Geometry: class { constructor(o) { Object.assign(this, o); } },
  GeometryAttribute: class { constructor(o) { Object.assign(this, o); } },
  GeometryInstance: class { constructor(o) { Object.assign(this, o); } },
  ComponentDatatype: { DOUBLE: 'double', FLOAT: 'float' },
  PrimitiveType: { TRIANGLES: 'tri' },
  Material: { fromType: (typ, u) => ({ type: typ, uniforms: Object.assign({}, u) }) },
  MaterialAppearance: class { constructor(o) { Object.assign(this, o); } },
  Primitive: class { constructor(o) { Object.assign(this, o); this.modelMatrix = M4.clone(M4.IDENTITY); } },
  ScreenSpaceEventHandler: class { setInputAction() {} destroy() {} },
  ScreenSpaceEventType: { LEFT_CLICK: 'klick', LEFT_DOWN: 'ab', LEFT_UP: 'auf', MOUSE_MOVE: 'zug' },
  ContextLimits: { maximumTextureSize: 16384 }
};

// ── Umgebung ──────────────────────────────────────────────────────────────

const ablage = {};
const dom = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, querySelectorAll: () => [] }),
  addEventListener: () => {}
};

const primitive = [];
const szene = {
  primitives: {
    add: (p) => { primitive.push(p); return p; },
    remove: (p) => { const i = primitive.indexOf(p); if (i >= 0) primitive.splice(i, 1); return true; }
  },
  preUpdate: { addEventListener: () => {} },
  camera: {
    frustum: { fovy: 1.0 },
    positionWC: new C3(0, 0, 0),
    directionWC: new C3(0, 0, -1),
    // Der Prüfstein setzt `_strahl` von Hand: welcher Bildschirmpunkt zu
    // welchem Strahl führt, ist Sache von Cesiums Projektion und hier ohne
    // Belang — geprüft wird, was das Modul aus dem Strahl macht.
    _strahl: null,
    getPickRay: function () { return this._strahl; }
  },
  screenSpaceCameraController: { enableInputs: true },
  drawingBufferHeight: 800,
  pickPosition: () => undefined
};

const meldungen = [];
const BimViewer = {
  viewer: { scene: szene, camera: szene.camera },
  loadedAssets: new Map(),
  updateStatus: (text, art) => { meldungen.push((art || '') + ': ' + text); },
  getBackendUrl: () => 'http://backend'
};

const kontext = {
  window: { BimViewer, addEventListener: () => {}, removeEventListener: () => {}, prompt: () => '' },
  BimViewer,
  Cesium,
  document: dom,
  console: { log: () => {}, warn: () => {}, error: () => {} },
  localStorage: {
    getItem: (k) => (k in ablage ? ablage[k] : null),
    setItem: (k, v) => { ablage[k] = String(v); },
    removeItem: (k) => { delete ablage[k]; }
  },
  // Die beiden Einhängeschleifen sollen nicht laufen: geprüft wird das Modul,
  // nicht das Panel.
  setInterval: () => 0,
  clearInterval: () => {},
  // Die Freigabe der Klicksperre läuft über einen Rückruf auf die nächste
  // Warteschlange. Hier ist er sofortig, sonst müsste jede Prüfung darauf
  // warten — geprüft wird ohnehin nur, DASS er die Sperre löst.
  setTimeout: (f) => { queueMicrotask(f); return 0; },
  queueMicrotask: queueMicrotask,
  Image: class { set src(_) { if (this.onerror) this.onerror(); } },
  FormData: class { append() {} },
  fetch: () => Promise.reject(new Error('kein Backend im Prüfstein')),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  unescape: (s) => s,
  encodeURIComponent: encodeURIComponent,
  FileReader: class {},
  CustomEvent: class {}
};
kontext.window.window = kontext.window;
kontext.globalThis = kontext;
vm.createContext(kontext);

const quelle = fs.readFileSync(path.join(__dirname, '..', '..', 'bildebenen.js'), 'utf8');
vm.runInContext(quelle, kontext, { filename: 'bildebenen.js' });

const BE = BimViewer.Bildebenen;
const I = BE._internals;

// ── Prüfgerüst ────────────────────────────────────────────────────────────

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};
const nah = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const nahV = (a, b, eps = 1e-9) =>
  nah(a.x, b.x, eps) && nah(a.y, b.y, eps) && nah(a.z, b.z, eps);
const zeig = (v) => `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
const alsFeld3 = (v) => [v.x, v.y, v.z];
const ausFeld = (f) => new C3(f[0], f[1], f[2]);

// Ein Ort auf dem Äquator: dort ist oben = +X, Osten = +Y, Norden = +Z.
// Damit sind alle Erwartungen unten von Hand nachrechenbar.
const ORT = new C3(R_ERDE, 0, 0);
const OBEN = new C3(1, 0, 0);
const OST = new C3(0, 1, 0);
const NORD = new C3(0, 0, 1);

// ── 1. Achsen ─────────────────────────────────────────────────────────────

console.log('\n1. Die Achsen einer Ebene');
{
  // Eine senkrechte Wand, deren Normale nach Norden zeigt.
  const r = I.basis(NORD, ORT);
  pruefe('senkrechte Fläche: Rechtsachse steht senkrecht auf der Normalen',
    nah(C3.dot(r, NORD), 0, 1e-12), `dot = ${C3.dot(r, NORD)}`);
  pruefe('senkrechte Fläche: Rechtsachse liegt waagerecht',
    nah(C3.dot(r, OBEN), 0, 1e-12), `dot mit oben = ${C3.dot(r, OBEN)}`);

  // Daraus muss ein „oben" folgen, das wirklich nach oben zeigt — sonst
  // hängt jeder Aushang auf dem Kopf.
  const o = C3.normalize(C3.cross(NORD, r, new C3()), new C3());
  pruefe('senkrechte Fläche: „oben" zeigt nach oben',
    C3.dot(o, OBEN) > 0.999, `dot mit oben = ${C3.dot(o, OBEN)}`);

  // Die Frage, die man einem symmetrischen Plan nicht ansieht: liest sich das
  // Bild richtig herum? Rechts × Oben MUSS die Normale ergeben, also zum
  // Betrachter zeigen. Ergibt es ihre Gegenrichtung, ist das Dreibein
  // linkshändig — dann steht jede Schrift spiegelverkehrt an der Wand, und
  // auffallen würde das erst an einem Text.
  const dreibein = C3.cross(r, o, new C3());
  pruefe('senkrechte Fläche: das Bild ist NICHT gespiegelt',
    nahV(dreibein, NORD, 1e-9), zeig(dreibein));

  // Ausgeschrieben für den nächsten Leser: an einer Wand mit Normale nach
  // Norden zeigt die Bildrechte nach Westen. Wer von Norden auf die Wand
  // schaut, hat Westen rechts — die Bildrechte liegt also auch für ihn
  // rechts.
  pruefe('senkrechte Fläche: die Bildrechte liegt für den Betrachter rechts',
    nahV(r, new C3(0, -1, 0), 1e-9), zeig(r));
}
{
  // Eine waagerechte Fläche: Normale = Hochachse.
  const r = I.basis(OBEN, ORT);
  pruefe('waagerechte Fläche: Rechtsachse zeigt nach Osten', nahV(r, OST, 1e-9), zeig(r));
  const o = C3.normalize(C3.cross(OBEN, r, new C3()), new C3());
  pruefe('waagerechte Fläche: „oben" im Bild zeigt nach Norden', nahV(o, NORD, 1e-9), zeig(o));
  const dreibein = C3.cross(r, o, new C3());
  pruefe('waagerechte Fläche: das Bild ist NICHT gespiegelt',
    nahV(dreibein, OBEN, 1e-9), zeig(dreibein));
}
{
  // Fast waagerecht, aber unterhalb der Schwelle: dann gilt die Regel für
  // geneigte Flächen und die Rechtsachse folgt der Falllinie, nicht Osten.
  const geneigt = C3.normalize(new C3(1, 0, 0.4), new C3());
  const kipp = Math.abs(C3.dot(geneigt, OBEN));
  pruefe('Schwelle greift erst wirklich waagerecht', kipp < I.WAAGERECHT_AB,
    `Kippmaß ${kipp.toFixed(4)} gegen Schwelle ${I.WAAGERECHT_AB}`);
  const r = I.basis(geneigt, ORT);
  pruefe('geneigte Fläche: Rechtsachse waagerecht und quer zur Normalen',
    nah(C3.dot(r, OBEN), 0, 1e-12) && nah(C3.dot(r, geneigt), 0, 1e-12));
}

// ── 2. Die Spalten der Matrix ─────────────────────────────────────────────

console.log('\n2. Die Matrix bildet das Einheitsquadrat auf das Bild ab');
{
  const BREITE = 8, HOEHE = 3;
  // Dasselbe Dreibein, das `_verankern()` bildet — nicht eines von Hand:
  // sonst prüfte der Abschnitt eine Lage, die im Betrieb nie vorkommt.
  const n = NORD;
  const r = I.basis(n, ORT);
  const o = C3.normalize(C3.cross(n, r, new C3()), new C3());
  const m = I.matrixAus(ORT, r, o, n, BREITE, HOEHE);

  const ecken = I.einheitsquadrat().attributes.position.values;
  const welt = [];
  for (let i = 0; i < 4; i++) {
    welt.push(M4.multiplyByPoint(m, new C3(ecken[i * 3], ecken[i * 3 + 1], ecken[i * 3 + 2]), new C3()));
  }
  const st = I.einheitsquadrat().attributes.st.values;

  // st (0,0) ist Ecke 0 und muss unten links liegen, st (1,1) ist Ecke 2 und
  // muss oben rechts liegen — das ist die Belegung, auf die sich der Kopf von
  // bildebenen.js beruft.
  pruefe('Ecke 0 trägt st (0,0)', st[0] === 0 && st[1] === 0);
  pruefe('Ecke 2 trägt st (1,1)', st[4] === 1 && st[5] === 1);

  const untenLinks = C3.add(ORT,
    C3.add(C3.multiplyByScalar(r, -BREITE / 2, new C3()),
           C3.multiplyByScalar(o, -HOEHE / 2, new C3()), new C3()), new C3());
  const obenRechts = C3.add(ORT,
    C3.add(C3.multiplyByScalar(r, BREITE / 2, new C3()),
           C3.multiplyByScalar(o, HOEHE / 2, new C3()), new C3()), new C3());

  pruefe('st (0,0) landet unten links', nahV(welt[0], untenLinks, 1e-6), zeig(welt[0]));
  pruefe('st (1,1) landet oben rechts', nahV(welt[2], obenRechts, 1e-6), zeig(welt[2]));

  pruefe('Breite stimmt', nah(C3.distance(welt[0], welt[1]), BREITE, 1e-6),
    `${C3.distance(welt[0], welt[1])}`);
  pruefe('Höhe stimmt', nah(C3.distance(welt[1], welt[2]), HOEHE, 1e-6),
    `${C3.distance(welt[1], welt[2])}`);
  pruefe('Breite und Höhe sind NICHT vertauscht',
    C3.distance(welt[0], welt[1]) > C3.distance(welt[1], welt[2]));
  pruefe('Spalte 2 trägt die Normale', nahV(M3.getColumn(M4.getMatrix3(m, []), 2, new C3()), n));
}

// ── 3. Drehung, Abhebung, Maße über BE.matrix() ───────────────────────────

console.log('\n3. Drehung, Abhebung und Maße einer gesetzten Ebene');

/** Eine Ebene ohne Anker, senkrecht mit Normale nach Norden. */
const RECHTS = I.basis(NORD, ORT);          // = Westen, siehe Abschnitt 1
const ebeneBauen = (mehr) => Object.assign({
  id: 'x', titel: 'T', quelle: { schluessel: 's', index: 0 },
  anker: null, mitte: [ORT.x, ORT.y, ORT.z],
  normale: [NORD.x, NORD.y, NORD.z], rechts: [RECHTS.x, RECHTS.y, RECHTS.z],
  breite_m: 4, hoehe_m: 2, drehung: 0, versatz: 0, deckkraft: 1, sichtbar: true
}, mehr || {});

{
  const m = I.matrixAus ? BE.matrix(ebeneBauen()) : null;
  const m3 = M4.getMatrix3(m, []);
  pruefe('ohne Drehung: Spalte 0 ist die Rechtsachse mal Breite',
    nahV(M3.getColumn(m3, 0, new C3()), C3.multiplyByScalar(RECHTS, 4, new C3()), 1e-9));
  pruefe('ohne Versatz: die Mitte bleibt der Trefferpunkt',
    nahV(M4.getTranslation(m, new C3()), ORT, 1e-6));
}
{
  // Rechte-Hand-Regel um die Normale (+Norden): aus Westen wird Oben. Für
  // den Betrachter, der von Norden auf die Wand schaut, wandert die
  // Bildrechte damit von rechts nach oben — ein positiver Wert dreht das
  // Bild also GEGEN den Uhrzeigersinn. Das steht hier, weil es die einzige
  // Stelle ist, an der die Drehrichtung überhaupt festgelegt wird.
  const m = BE.matrix(ebeneBauen({ drehung: 90 }));
  const m3 = M4.getMatrix3(m, []);
  const r = C3.normalize(M3.getColumn(m3, 0, new C3()), new C3());
  pruefe('90°-Drehung dreht die Rechtsachse in der Ebene',
    nah(C3.dot(r, NORD), 0, 1e-9), `dot mit Normale = ${C3.dot(r, NORD)}`);
  pruefe('90°-Drehung dreht gegen den Uhrzeigersinn (Rechte wandert nach oben)',
    nahV(r, OBEN, 1e-9), zeig(r));

  const o = C3.normalize(M3.getColumn(m3, 1, new C3()), new C3());
  pruefe('gedreht bleibt das Rechteck rechtwinklig',
    nah(C3.dot(r, o), 0, 1e-9), `dot = ${C3.dot(r, o)}`);
  pruefe('gedreht bleibt das Bild ungespiegelt',
    nahV(C3.cross(r, o, new C3()), NORD, 1e-9));
  pruefe('die Maße überleben die Drehung',
    nah(C3.magnitude(M3.getColumn(m3, 0, new C3())), 4, 1e-9) &&
    nah(C3.magnitude(M3.getColumn(m3, 1, new C3())), 2, 1e-9));
}
{
  // Die Abhebung MUSS entlang der Normalen laufen. An einer senkrechten Wand
  // ist das waagerecht — hübe sie das Bild an, flimmerte es weiter.
  const m = BE.matrix(ebeneBauen({ versatz: 0.05 }));
  const mitte = M4.getTranslation(m, new C3());
  const weg = C3.subtract(mitte, ORT, new C3());
  pruefe('Abhebung läuft entlang der Normalen', nahV(weg,
    C3.multiplyByScalar(NORD, 0.05, new C3()), 1e-9), zeig(weg));
  pruefe('Abhebung hebt an einer Wand NICHT an', nah(C3.dot(weg, OBEN), 0, 1e-12));
}

// ── 4. Der Anker ──────────────────────────────────────────────────────────

console.log('\n4. Die Ebene hängt am Modell');
{
  // Ein Modell, dessen Kachelrahmen um 10 m nach Osten verschoben ist.
  const rahmen = M4.fromTranslation(new C3(0, 10, 0), []);
  BimViewer.loadedAssets.set('42', { tileset: { root: { computedTransform: rahmen } } });

  const ebene = ebeneBauen({ anker: '42', mitte: [0, 0, 0] });
  const mitte = M4.getTranslation(BE.matrix(ebene), new C3());
  pruefe('verankerte Ebene folgt dem Kachelrahmen',
    nahV(mitte, new C3(0, 10, 0), 1e-9), zeig(mitte));

  // Modell rückt weiter — die Ebene muss mit.
  M4.fromTranslation(new C3(0, 25, 0), rahmen);
  const mitte2 = M4.getTranslation(BE.matrix(ebene), new C3());
  pruefe('rückt das Modell, wandert die Ebene mit',
    nahV(mitte2, new C3(0, 25, 0), 1e-9), zeig(mitte2));

  // Und ohne Modell darf gar nichts entstehen.
  BE.ebenen = [ebeneBauen({ id: 'verwaist', anker: '999', mitte: [0, 0, 0] })];
  BE._cache['s:0'] = 'data:image/png;base64,AAAA';
  const vorher = primitive.length;
  BE._nachziehen(BE.ebenen[0]);
  pruefe('ohne geladenes Modell entsteht keine Fläche', primitive.length === vorher,
    `${primitive.length - vorher} zusätzliche Primitive`);

  // Mit Modell dagegen schon.
  BE.ebenen = [ebeneBauen({ id: 'da', anker: '42', mitte: [0, 0, 0] })];
  BE._nachziehen(BE.ebenen[0]);
  pruefe('mit geladenem Modell entsteht eine Fläche', primitive.length === vorher + 1);
  pruefe('die Fläche fängt keine Klicks ab',
    primitive[primitive.length - 1].allowPicking === false);
  pruefe('die Fläche wird nicht beleuchtet',
    primitive[primitive.length - 1].appearance.flat === true);
}

// ── 4b. Aufziehen ─────────────────────────────────────────────────────────

console.log('\n4b. Ein Rechteck aufziehen');

// Der Prüfstein steuert den Zeiger über den Strahl: Ursprung fest vor der
// Wand, Richtung auf den gewünschten Punkt IN der Wandebene. Damit sind alle
// Erwartungen unten in Metern nachrechenbar, ohne Cesiums Projektion.
const wandMitte = ORT;
const wandN = NORD;                       // die Wand schaut nach Norden
const wandR = I.basis(wandN, ORT);        // = Westen
const wandO = C3.normalize(C3.cross(wandN, wandR, new C3()), new C3());  // = oben

/**
 * Hängt einen `Tags`-Ersatz in den vm-Kontext.
 *
 * Auf BEIDE Namen: das Modul prüft `window.Tags` und liest dann `Tags.pick`
 * als freien Bezeichner — im vm-Kontext sind das zwei verschiedene Objekte.
 */
const tagsStellen = (punkt) => {
  const ersatz = {
    pick: () => ({ position: { worldCart: punkt },
                   target: { kind: 'free', assetId: null } })
  };
  kontext.Tags = ersatz;
  kontext.window.Tags = ersatz;
};

/** Setzt den Strahl so, dass er die Wandebene bei ecke + du·rechts + dv·oben trifft. */
const zeigeAuf = (ecke, du, dv) => {
  const ziel = C3.add(ecke,
    C3.add(C3.multiplyByScalar(wandR, du, new C3()),
           C3.multiplyByScalar(wandO, dv, new C3()), new C3()), new C3());
  // Der Ursprung liegt 50 m vor der Wand, in Richtung ihrer Normalen.
  const ursprung = C3.add(ziel, C3.multiplyByScalar(wandN, 50, new C3()), new C3());
  szene.camera._strahl = {
    origin: ursprung,
    direction: C3.normalize(C3.subtract(ziel, ursprung, new C3()), new C3())
  };
  return ziel;
};

/** Ein Zug von der Ecke aus, mit oder ohne Seitensperre. */
const aufziehen = (du, dv, sperre, verhaeltnis) => {
  BE.ebenen = [];
  BE._cache['s:0'] = 'data:image/png;base64,AAAA';
  BE.vorlage = { schluessel: 's', index: 0, titel: 'Zug', verhaeltnis: verhaeltnis };
  BE.seitenSperre = sperre;
  BE.setzmodus = 'neu';

  // Das Drücken: `treffer()` wird über Tags.pick gespeist.
  tagsStellen(wandMitte);
  szene.pickPosition = () => undefined;      // keine Normale aus der Tiefe → Hochachse
  // ... aber die Ausrichtung soll die Wand treffen, nicht die Waagerechte:
  BE._normaleAn = () => C3.clone(wandN, new C3());

  zeigeAuf(wandMitte, 0, 0);
  BE._druck(new C2(0, 0));
  zeigeAuf(wandMitte, du, dv);
  BE._zug(new C2(0, 0));
  BE._aufziehenEnde();
  return BE.ebenen[0];
};

{
  // Ohne Sperre: beide Kanten folgen dem Zug einzeln.
  const e = aufziehen(-6, 3, false, 0.5);
  pruefe('ohne Sperre: Breite ist der gezogene Weg quer',
    nah(e.breite_m, 6, 1e-6), `${e.breite_m}`);
  pruefe('ohne Sperre: Höhe ist der gezogene Weg hoch',
    nah(e.hoehe_m, 3, 1e-6), `${e.hoehe_m}`);

  // Und die Mitte MUSS die halbe Strecke zwischen Ecke und Zeiger sein —
  // das Rechteck wächst von der gedrückten Ecke weg, nicht um sie herum.
  const mitte = ausFeld(e.mitte);
  const soll = C3.add(wandMitte,
    C3.add(C3.multiplyByScalar(wandR, -3, new C3()),
           C3.multiplyByScalar(wandO, 1.5, new C3()), new C3()), new C3());
  pruefe('das Rechteck wächst von der gedrückten Ecke weg',
    nahV(mitte, soll, 1e-6), zeig(mitte));
}
{
  // Mit Sperre und einem Zug, der vorwiegend quer läuft.
  const e = aufziehen(-8, 1, true, 0.5);
  pruefe('mit Sperre: die längere Kante gibt den Ausschlag (quer)',
    nah(e.breite_m, 8, 1e-6) && nah(e.hoehe_m, 4, 1e-6),
    `${e.breite_m} × ${e.hoehe_m}`);
}
{
  // Und einem Zug, der vorwiegend hoch läuft — DAS ist der Fall, an dem eine
  // naive Umsetzung („Höhe folgt aus der Breite") ein Hochformat zerdrückt.
  const e = aufziehen(1, 6, true, 2.0);
  pruefe('mit Sperre: die längere Kante gibt den Ausschlag (hoch)',
    nah(e.breite_m, 3, 1e-6) && nah(e.hoehe_m, 6, 1e-6),
    `${e.breite_m} × ${e.hoehe_m}`);
  pruefe('mit Sperre bleibt das Seitenverhältnis erhalten',
    nah(e.hoehe_m / e.breite_m, 2.0, 1e-9));
}
{
  // Ein Zug unter der Schwelle ist ein Klick: dann gilt die Vorlage.
  BE.ebenen = [];
  BE._cache['s:0'] = 'data:image/png;base64,AAAA';
  BE.vorlage = { schluessel: 's', index: 0, titel: 'Klick', verhaeltnis: 0.5, breite_m: 7 };
  BE.seitenSperre = true;
  BE.setzmodus = 'neu';
  tagsStellen(wandMitte);
  BE._normaleAn = () => C3.clone(wandN, new C3());
  zeigeAuf(wandMitte, 0, 0);
  BE._druck(new C2(0, 0));
  zeigeAuf(wandMitte, 0.02, 0.02);          // unter MINDEST_ZIEHEN
  BE._zug(new C2(0, 0));
  BE._aufziehenEnde();
  const e = BE.ebenen[0];
  pruefe('ein Zug unter der Schwelle gilt als Klick und nimmt den Vorlagenmaßstab',
    nah(e.breite_m, 7, 1e-9) && nah(e.hoehe_m, 3.5, 1e-9),
    `${e.breite_m} × ${e.hoehe_m}`);
  pruefe('nach dem Aufziehen ist der Schiebemodus scharf',
    BE.schiebemodus === e.id);
  pruefe('nach dem Aufziehen ist der Setzmodus aus', BE.setzmodus === null);
}
{
  // Die Kamera MUSS während des Zuges stillstehen und danach wieder frei sein.
  BE.ebenen = [];
  BE._cache['s:0'] = 'data:image/png;base64,AAAA';
  BE.vorlage = { schluessel: 's', index: 0, titel: 'K', verhaeltnis: 1 };
  BE.setzmodus = 'neu';
  tagsStellen(wandMitte);
  BE._normaleAn = () => C3.clone(wandN, new C3());
  zeigeAuf(wandMitte, 0, 0);
  BE._druck(new C2(0, 0));
  pruefe('während des Aufziehens steht die Kamera still',
    szene.screenSpaceCameraController.enableInputs === false);
  BE._aufziehenEnde();
  pruefe('danach ist die Kamera wieder frei',
    szene.screenSpaceCameraController.enableInputs === true);
}

// ── 4c. Schieben in der Ebene ─────────────────────────────────────────────

console.log('\n4c. Ein Bild in seiner Ebene schieben');
{
  const ebene = {
    id: 'sch', titel: 'S', quelle: { schluessel: 's', index: 0 }, anker: null,
    mitte: alsFeld3(wandMitte), normale: alsFeld3(wandN), rechts: alsFeld3(wandR),
    breite_m: 4, hoehe_m: 2, drehung: 0, versatz: 0.02, deckkraft: 1, sichtbar: true
  };
  BE.ebenen = [ebene];
  BE.schiebemodus = 'sch';
  BE._schieben = null;

  // Ein Druck AUSSERHALB des Bildes darf nicht greifen — sonst wäre die
  // Kamera unbedienbar, solange ein Bild scharf ist.
  const abgehoben = C3.add(wandMitte, C3.multiplyByScalar(wandN, 0.02, new C3()), new C3());
  zeigeAuf(abgehoben, 5, 0);                 // 5 m quer, das Bild ist 4 m breit
  BE._druck(new C2(0, 0));
  pruefe('ein Druck außerhalb des Bildes greift nicht', BE._schieben === null);
  pruefe('und lässt die Kamera in Ruhe',
    szene.screenSpaceCameraController.enableInputs === true);

  // Ein Druck IM Bild greift.
  zeigeAuf(abgehoben, 1, 0.5);
  BE._druck(new C2(0, 0));
  pruefe('ein Druck im Bild greift', BE._schieben !== null);
  pruefe('und hält die Kamera an',
    szene.screenSpaceCameraController.enableInputs === false);

  // Ziehen um (+2 quer, −0,7 hoch) — das Bild MUSS genau um diese Strecke
  // wandern, und um keinen Millimeter entlang der Normalen.
  zeigeAuf(abgehoben, 3, -0.2);
  BE._zug(new C2(0, 0));
  const neu = ausFeld(ebene.mitte);
  const soll = C3.add(wandMitte,
    C3.add(C3.multiplyByScalar(wandR, 2, new C3()),
           C3.multiplyByScalar(wandO, -0.7, new C3()), new C3()), new C3());
  pruefe('das Bild folgt dem Zeiger auf den Millimeter', nahV(neu, soll, 1e-6), zeig(neu));

  const weg = C3.subtract(neu, wandMitte, new C3());
  pruefe('es bleibt dabei EXAKT in seiner Ebene',
    nah(C3.dot(weg, wandN), 0, 1e-9), `Weg entlang der Normalen: ${C3.dot(weg, wandN)}`);

  pruefe('während des Schiebens fängt das Modul den Klick ab', BE.faengtKlick() === true);
  BE._schiebenEnde();
  pruefe('danach ist die Kamera wieder frei',
    szene.screenSpaceCameraController.enableInputs === true);
  pruefe('und der Klick bleibt bis nach dem LEFT_CLICK gesperrt',
    BE.faengtKlick() === true);
}

// ── 4d. Kachelung ─────────────────────────────────────────────────────────
//
// Ein A0-Plan auf 118 m Modellbreite ist mit einer einzigen 4096er-Textur
// beim Hineinzoomen unlesbar. Mehr als eine Texturgröße geht aber nicht in
// EINE Textur — also ein Raster. Geprüft wird das Raster selbst und, was
// daran hängt: dass die Kacheln lückenlos und in der richtigen Reihenfolge
// über der Bildfläche liegen. Eine Kachel an der falschen Stelle ist ein
// Plan, dessen Zeilen vertauscht sind.

console.log('\n4d. Kachelung eines hoch aufgelösten Plans');
{
  const r = I.raster(12288, 8688);
  pruefe('12288 × 8688 zerfällt in 3 × 3 Kacheln',
    r.spalten === 3 && r.zeilen === 3, `${r.spalten} × ${r.zeilen}`);
  const klein = I.raster(2000, 1000);
  pruefe('ein kleines Bild bleibt eine einzige Kachel',
    klein.spalten === 1 && klein.zeilen === 1);

  pruefe('die Stufen sind nach Auflösung geordnet',
    I.AUFLOESUNGEN.normal.px < I.AUFLOESUNGEN.hoch.px &&
    I.AUFLOESUNGEN.hoch.px < I.AUFLOESUNGEN.fein.px);
  pruefe('die Standardstufe ist die mittlere', BE.aufloesung === 'hoch');

  // Der Speicher, den die Stufen kosten — die Zahl steht im Panel und muss
  // stimmen, sonst ist der Hinweis schlimmer als keiner.
  pruefe('ein A0 in der Standardstufe kostet rund 190 MB',
    Math.abs(I.speicherMb(8192, 5793) - 181) < 5,
    I.speicherMb(8192, 5793).toFixed(0) + ' MB');
}
{
  // Die Matrizen der Kacheln: lückenlos, in der Reihenfolge links-oben
  // zeilenweise, und zusammen genau die Fläche des ganzen Bildes.
  const ebene = {
    id: 'k', titel: 'K', quelle: { schluessel: 's', index: 0 }, anker: null,
    mitte: alsFeld3(ORT), normale: alsFeld3(NORD), rechts: alsFeld3(I.basis(NORD, ORT)),
    breite_m: 12, hoehe_m: 6, drehung: 0, versatz: 0, deckkraft: 1, sichtbar: true
  };
  const m = BE.kachelMatrizen(ebene, 3, 2);
  pruefe('3 × 2 ergibt sechs Matrizen', m.length === 6);

  const kb = (mat) => C3.magnitude(M3.getColumn(M4.getMatrix3(mat, []), 0, new C3()));
  const kh = (mat) => C3.magnitude(M3.getColumn(M4.getMatrix3(mat, []), 1, new C3()));
  pruefe('jede Kachel ist 4 × 3 m groß',
    m.every((mat) => nah(kb(mat), 4, 1e-9) && nah(kh(mat), 3, 1e-9)),
    `${kb(m[0])} × ${kh(m[0])}`);

  const rechts = I.basis(NORD, ORT);
  const oben = C3.normalize(C3.cross(NORD, rechts, new C3()), new C3());
  const lage = (mat) => {
    const p = M4.getTranslation(mat, new C3());
    const d = C3.subtract(p, ORT, new C3());
    return { u: C3.dot(d, rechts), v: C3.dot(d, oben) };
  };

  // Kachel 0 ist links OBEN: −4 quer (linke Spalte von dreien) und +1,5 hoch
  // (obere Zeile von zweien). Läge sie unten, stünde der Plan zeilenweise auf
  // dem Kopf — und das sieht man einer symmetrischen Zeichnung nicht an.
  const k0 = lage(m[0]);
  pruefe('Kachel 0 liegt links oben',
    nah(k0.u, -4, 1e-6) && nah(k0.v, 1.5, 1e-6),
    `quer ${k0.u.toFixed(3)}, hoch ${k0.v.toFixed(3)}`);

  const k5 = lage(m[5]);
  pruefe('die letzte Kachel liegt rechts unten',
    nah(k5.u, 4, 1e-6) && nah(k5.v, -1.5, 1e-6),
    `quer ${k5.u.toFixed(3)}, hoch ${k5.v.toFixed(3)}`);

  // Lückenlos: die Kacheln einer Zeile müssen sich genau um ihre Breite
  // unterscheiden, die einer Spalte genau um ihre Höhe.
  pruefe('die Kacheln einer Zeile stoßen lückenlos aneinander',
    nah(lage(m[1]).u - lage(m[0]).u, 4, 1e-6) &&
    nah(lage(m[2]).u - lage(m[1]).u, 4, 1e-6));
  pruefe('die Zeilen stoßen lückenlos aneinander',
    nah(lage(m[0]).v - lage(m[3]).v, 3, 1e-6));

  // Und alles liegt in EINER Ebene — eine Kachel, die aus der Wand ragt,
  // wäre am Modell ein Knick im Plan.
  pruefe('alle Kacheln liegen in derselben Ebene',
    m.every((mat) => {
      const d = C3.subtract(M4.getTranslation(mat, new C3()), ORT, new C3());
      return nah(C3.dot(d, NORD), 0, 1e-9);
    }));
}
{
  // Die Abhebung MUSS für alle Kacheln gleich gelten — sonst flimmert ein
  // Teil des Plans und der Rest nicht.
  const ebene = {
    id: 'k2', titel: 'K', quelle: { schluessel: 's', index: 0 }, anker: null,
    mitte: alsFeld3(ORT), normale: alsFeld3(NORD), rechts: alsFeld3(I.basis(NORD, ORT)),
    breite_m: 8, hoehe_m: 4, drehung: 0, versatz: 0.05, deckkraft: 1, sichtbar: true
  };
  const m = BE.kachelMatrizen(ebene, 2, 2);
  pruefe('die Abhebung gilt für jede Kachel gleich',
    m.every((mat) => {
      const d = C3.subtract(M4.getTranslation(mat, new C3()), ORT, new C3());
      return nah(C3.dot(d, NORD), 0.05, 1e-9);
    }));
}

// ── 5. Maßstabseingabe ────────────────────────────────────────────────────

console.log('\n5. Der Maßstab einer PDF-Vorlage');
{
  const f = I.massstabAusEingabe;
  pruefe('„1:100" → 100', f('1:100') === 100);
  pruefe('„100" → 100', f('100') === 100);
  pruefe('„1 : 50" → 50', f('1 : 50') === 50);
  pruefe('„1:12,5" → 12.5', f('1:12,5') === 12.5);
  pruefe('leer → kein Maßstab', f('') === null && f(null) === null);
  pruefe('Text → kein Maßstab', f('groß') === null);
  pruefe('„1:0" → kein Maßstab', f('1:0') === null);
}

// ── 6. Die Ablage ─────────────────────────────────────────────────────────

console.log('\n6. Was in localStorage geht');
{
  BE.ebenen = [ebeneBauen({ id: 'a' })];
  BE._nachziehen(BE.ebenen[0]);       // legt ein Primitive an
  BE.sichern();

  const roh = ablage['ileen-bildebenen'];
  pruefe('gesichert wird überhaupt etwas', !!roh);
  const gelesen = JSON.parse(roh);
  pruefe('genau eine Ebene', gelesen.length === 1);
  const felder = Object.keys(gelesen[0]).sort().join(',');
  pruefe('kein Primitive, kein Bild, keine Matrix in der Ablage',
    felder === 'anker,breite_m,deckkraft,drehung,hoehe_m,id,mitte,normale,quelle,rechts,sichtbar,titel,versatz',
    felder);

  // Und zurücklesen muss dasselbe ergeben.
  BE.ebenen = [];
  BE._geladen = false;
  BE.laden();
  pruefe('gelesen wird, was geschrieben wurde',
    BE.ebenen.length === 1 && BE.ebenen[0].id === 'a' && BE.ebenen[0].breite_m === 4);

  // Ein kaputter Eintrag darf das Modul nicht mitreißen.
  ablage['ileen-bildebenen'] = '{kein json';
  BE.ebenen = [];
  BE._geladen = false;
  BE.laden();
  pruefe('kaputte Ablage wird verworfen, nicht geworfen', BE.ebenen.length === 0);
}

// ── 7. Klick-Vorrang ──────────────────────────────────────────────────────

console.log('\n7. Der Klick-Vorrang gegen features.js');
{
  // Abschnitt 4c hat die Klicksperre absichtlich stehen lassen (sie wird erst
  // nach dem folgenden LEFT_CLICK gelöst, und der kommt hier nie). Für diesen
  // Abschnitt wird von Hand aufgeräumt.
  BE._klicksperre = false;
  BE._schieben = null;
  BE.setzmodus = null;
  pruefe('ohne Setzmodus fängt das Modul keine Klicks', BE.faengtKlick() === false);
  BE.setzmodus = 'neu';
  pruefe('im Setzmodus gehört der Klick der Bildebene', BE.faengtKlick() === true);
  BE.abbrechen();
  pruefe('Abbrechen gibt den Klick zurück', BE.faengtKlick() === false);

  const inFeatures = fs.readFileSync(
    path.join(__dirname, '..', '..', 'features.js'), 'utf8');
  pruefe('features.js kennt die Sperre',
    /Bildebenen\s*&&\s*this\.Bildebenen\.faengtKlick\(\)/.test(inFeatures));
}

// ── 8. Wenn ein PDF nicht ankommt ─────────────────────────────────────────
//
// Ein PDF ist die einzige Vorlage, die NICHT im Browser entsteht — die
// Umwandlung macht `pdf2svg` im Backend. Steht das nicht, muss dastehen,
// WARUM. Genau hier lag ein Fehler: die genaue Ursache wurde eine Zeile
// später von einem allgemeinen „keine verwertbare Datei" übermalt, und damit
// war aus „das Backend kennt /plan/pdf nicht" ein ratloses Achselzucken
// geworden.

// ── 7b. Flächenerkennung: Ausgleichsebene und Einrasten ───────────────────
//
// Der Fehler, um den es hier geht: Bilder hingen schief im Raum. Ursache war
// eine Normale aus drei Tastpunkten über fünf Pixel — der Tiefenpuffer ist
// quantisiert, und über eine so kurze Basis werden daraus mehrere Grad. Ein
// Bild, das um 4° gegen die Wand verdreht hängt, sieht schief aus.
//
// Zwei Gegenmittel, beide hier geprüft:
//   1. Die Ausgleichsebene über siebzehn Punkte mittelt das Rauschen heraus.
//   2. Das Einrasten zieht eine fast lotrechte Fläche exakt ins Lot und, wenn
//      sie nah an einer Achse des Bauwerks steht, auch darauf.

console.log('\n7b. Wie die Fläche unter dem Zeiger bestimmt wird');
{
  // Eine Wand mit Normale nach Norden, verrauscht abgetastet.
  const wandR = I.basis(NORD, ORT);
  const wandO = C3.normalize(C3.cross(NORD, wandR, new C3()), new C3());
  const aufWand = (u, v, stoerung) => C3.add(ORT,
    C3.add(C3.multiplyByScalar(wandR, u, new C3()),
      C3.add(C3.multiplyByScalar(wandO, v, new C3()),
             C3.multiplyByScalar(NORD, stoerung || 0, new C3()), new C3()), new C3()),
    new C3());

  // Ohne Rauschen: die Normale MUSS exakt herauskommen.
  const sauber = [];
  for (let i = 0; i < 16; i++) {
    const w = 2 * Math.PI * i / 16;
    sauber.push(aufWand(Math.cos(w) * 0.3, Math.sin(w) * 0.3, 0));
  }
  const nSauber = I.ausgleichsnormale(sauber);
  pruefe('die Ausgleichsebene findet eine saubere Wand exakt',
    Math.abs(Math.abs(C3.dot(nSauber, NORD)) - 1) < 1e-9,
    `${C3.dot(nSauber, NORD)}`);

  // Mit Rauschen: der Punkt der ganzen Änderung. Verglichen wird über VIELE
  // Ziehungen, nicht über eine — bei einer einzigen entscheidet der Zufall,
  // welches Verfahren gerade besser aussieht, und genau daran ist der erste
  // Anlauf dieser Prüfung gescheitert. Die Behauptung ist eine über den
  // Erwartungswert, also muss sie auch so geprüft werden.
  let saat = 12345;
  const zufall = () => { saat = (saat * 1103515245 + 12345) & 0x7fffffff; return saat / 0x7fffffff - 0.5; };
  const winkelZu = (n, soll) =>
    Math.acos(Math.min(1, Math.abs(C3.dot(n, soll)))) * 180 / Math.PI;

  const VERSUCHE = 300;
  const RAUSCHEN = 0.01;                 // ±5 mm, wie ein Tiefenpuffer sie gibt
  let summeEbene = 0, summeDrei = 0, schlimmsteEbene = 0, schlimmsteDrei = 0;

  for (let v = 0; v < VERSUCHE; v++) {
    const punkte = [];
    for (let i = 0; i < 16; i++) {
      const w = 2 * Math.PI * i / 16;
      punkte.push(aufWand(Math.cos(w) * 0.3, Math.sin(w) * 0.3, zufall() * RAUSCHEN));
    }
    const nEbene = I.ausgleichsnormale(punkte);

    // Dieselben Daten, aber nur drei Punkte — der alte Weg. Bewusst gut
    // verteilt (jeder dritte Ringpunkt), also die GÜNSTIGSTE Variante des
    // alten Verfahrens; der Vergleich soll nicht durch eine schlechte
    // Punktwahl geschönt sein.
    const a = C3.subtract(punkte[5], punkte[0], new C3());
    const b = C3.subtract(punkte[11], punkte[0], new C3());
    const nDrei = C3.normalize(C3.cross(a, b, new C3()), new C3());

    const fe = winkelZu(nEbene, NORD), fd = winkelZu(nDrei, NORD);
    summeEbene += fe; summeDrei += fd;
    schlimmsteEbene = Math.max(schlimmsteEbene, fe);
    schlimmsteDrei = Math.max(schlimmsteDrei, fd);
  }
  const mittelEbene = summeEbene / VERSUCHE, mittelDrei = summeDrei / VERSUCHE;

  pruefe('die Ausgleichsebene bleibt im Mittel unter 0,5° Fehler',
    mittelEbene < 0.5, `${mittelEbene.toFixed(3)}°`);
  pruefe('sie ist im Mittel mindestens doppelt so genau wie drei Punkte',
    mittelEbene * 2 < mittelDrei,
    `Ebene ${mittelEbene.toFixed(3)}° gegen drei Punkte ${mittelDrei.toFixed(3)}°`);
  pruefe('und ihr schlimmster Fall ist besser als der schlimmste der drei Punkte',
    schlimmsteEbene < schlimmsteDrei,
    `${schlimmsteEbene.toFixed(2)}° gegen ${schlimmsteDrei.toFixed(2)}°`);
  console.log(`       über ${VERSUCHE} Ziehungen mit ±5 mm Rauschen — ` +
    `Ausgleichsebene ${mittelEbene.toFixed(3)}° (max ${schlimmsteEbene.toFixed(2)}°), ` +
    `drei Punkte ${mittelDrei.toFixed(3)}° (max ${schlimmsteDrei.toFixed(2)}°)`);

  // Und das ist der Grund, warum das Einrasten TROTZDEM nötig bleibt: selbst
  // ein halbes Grad Restfehler ist an einer 4 m breiten Bildebene ein
  // Versatz von 3,5 cm über die Breite — sichtbar, sobald zwei Bilder
  // nebeneinander an derselben Wand hängen.
  pruefe('auch der Restfehler rechtfertigt das Einrasten noch',
    mittelEbene > 0, `${(Math.tan(mittelEbene * Math.PI / 180) * 4 * 100).toFixed(1)} cm auf 4 m`);

  pruefe('kollineare Punkte ergeben keine Ebene',
    I.ausgleichsnormale([ORT, aufWand(1, 0, 0), aufWand(2, 0, 0)]) === null);
  pruefe('zu wenige Punkte ergeben keine Ebene', I.ausgleichsnormale([ORT]) === null);
}
{
  // Das Einrasten. OBEN ist die Hochachse am Prüfort.
  const schief = (grad) => {          // Wand, um `grad` aus dem Lot gekippt
    const w = grad * Math.PI / 180;
    return C3.normalize(C3.add(
      C3.multiplyByScalar(NORD, Math.cos(w), new C3()),
      C3.multiplyByScalar(OBEN, Math.sin(w), new C3()), new C3()), new C3());
  };

  const e3 = I.einrasten(schief(3), OBEN, [], I.RAST_GRAD);
  pruefe('eine um 3° verkantete Wand wird exakt ins Lot gezogen',
    e3.art === 'senkrecht' && Math.abs(C3.dot(e3.normale, OBEN)) < 1e-12,
    `Höhenanteil ${C3.dot(e3.normale, OBEN)}`);
  pruefe('und behält dabei ihre Himmelsrichtung',
    C3.dot(e3.normale, NORD) > 0.999);

  const e30 = I.einrasten(schief(30), OBEN, [], I.RAST_GRAD);
  pruefe('ein wirklich geneigtes Dach (30°) bleibt unberührt',
    e30.art === 'frei' && Math.abs(C3.dot(e30.normale, OBEN) - Math.sin(Math.PI / 6)) < 1e-9);

  // Fast waagerecht → exakt waagerecht.
  const fastFlach = C3.normalize(C3.add(
    C3.multiplyByScalar(OBEN, Math.cos(0.05), new C3()),
    C3.multiplyByScalar(NORD, Math.sin(0.05), new C3()), new C3()), new C3());
  const eFlach = I.einrasten(fastFlach, OBEN, [], I.RAST_GRAD);
  pruefe('eine fast waagerechte Decke wird exakt waagerecht',
    eFlach.art === 'waagerecht' && nahV(eFlach.normale, OBEN, 1e-12), zeig(eFlach.normale));

  // Eine nach unten zeigende Fläche (Deckenuntersicht) behält ihre Richtung.
  const eUnten = I.einrasten(C3.negate(fastFlach, new C3()), OBEN, [], I.RAST_GRAD);
  pruefe('eine Deckenuntersicht zeigt weiter nach unten',
    nahV(eUnten.normale, C3.negate(OBEN, new C3()), 1e-12), zeig(eUnten.normale));
}
{
  // Achsen des Bauwerks: eine Wand 4° neben der Achse rastet ein, eine
  // 30° daneben (ein abgewinkelter Flügel) nicht.
  const achse = NORD;
  const gegen = C3.negate(NORD, new C3());
  const quer = C3.normalize(C3.cross(OBEN, NORD, new C3()), new C3());
  const achsen = [achse, gegen, quer, C3.negate(quer, new C3())];

  const dreh = (grad) => {
    const w = grad * Math.PI / 180;
    return C3.normalize(C3.add(
      C3.multiplyByScalar(NORD, Math.cos(w), new C3()),
      C3.multiplyByScalar(quer, Math.sin(w), new C3()), new C3()), new C3());
  };

  const e4 = I.einrasten(dreh(4), OBEN, achsen, I.RAST_GRAD);
  pruefe('eine Wand 4° neben der Modellachse rastet darauf ein',
    e4.achse === true && nahV(e4.normale, NORD, 1e-12), zeig(e4.normale));

  const e30 = I.einrasten(dreh(30), OBEN, achsen, I.RAST_GRAD);
  pruefe('ein um 30° abgewinkelter Flügel rastet NICHT ein',
    e30.achse === false && Math.abs(C3.dot(e30.normale, NORD) - Math.cos(Math.PI / 6)) < 1e-9);
  pruefe('bleibt dabei aber im Lot', Math.abs(C3.dot(e30.normale, OBEN)) < 1e-12);

  const ohne = I.einrasten(dreh(4), OBEN, [], I.RAST_GRAD);
  pruefe('ohne Modell gibt es kein Raster zum Einrasten',
    ohne.achse === false && Math.abs(C3.dot(ohne.normale, OBEN)) < 1e-12);
}
{
  // Die Modellachsen kommen aus dem Kachelrahmen — auch aus einem gedrehten.
  const dreh45 = Math.SQRT1_2;
  // Ein Rahmen, dessen x-Achse in der Waagerechten liegt (Ost/Nord-Mischung).
  const rahmen = [0, dreh45, dreh45, 0,   0, -dreh45, dreh45, 0,   1, 0, 0, 0,   ORT.x, ORT.y, ORT.z, 1];
  BimViewer.loadedAssets.set('ax', { tileset: { root: { computedTransform: rahmen } } });

  const achsen = BE._modellAchsen('ax', OBEN);
  pruefe('aus einem Kachelrahmen kommen vier Richtungen', achsen.length === 4,
    String(achsen.length));
  pruefe('alle liegen exakt in der Waagerechten',
    achsen.every((a) => Math.abs(C3.dot(a, OBEN)) < 1e-9));
  pruefe('sie stehen paarweise entgegengesetzt',
    nahV(achsen[1], C3.negate(achsen[0], new C3()), 1e-12));
  pruefe('ohne Modell bleibt die Liste leer', BE._modellAchsen(null, OBEN).length === 0);
}

// Als async-Hülle, weil dieses Skript CommonJS ist (siehe package.json
// daneben) und `await` dort nicht auf oberster Ebene stehen darf. Der
// Abschluss steht mit darin — sonst liefe er, bevor Abschnitt 8 fertig ist,
// und meldete „alles in Ordnung", ohne es geprüft zu haben.
(async () => {

console.log('\n8. Wenn ein PDF nicht ankommt');

/** Ein Antwort-Ersatz mit Status und Körper. */
const antwort = (status, koerper) => ({
  status: status,
  ok: status >= 200 && status < 300,
  text: async () => koerper
});

{
  const adresse = 'http://backend/plan/pdf';
  const f = I.fehlertext;

  const t404 = await f(antwort(404, 'Not Found'), adresse);
  pruefe('404 nennt die Adresse', t404.includes(adresse), t404);
  pruefe('404 nennt den Ort, an dem man sie ändert',
    /Eigenes Backend/.test(t404), t404);

  const t500 = await f(antwort(500, JSON.stringify({ detail: 'pdf2svg fehlt' })), adresse);
  pruefe('500 gibt den Grund des Backends wieder',
    t500.includes('pdf2svg fehlt'), t500);

  const t422 = await f(antwort(422, JSON.stringify({ detail: 'Nur PDF-Dateien.' })), adresse);
  pruefe('422 gibt den Grund des Backends wieder',
    t422.includes('Nur PDF-Dateien.'), t422);

  // Kein JSON im Körper — etwa eine HTML-Fehlerseite eines Proxys davor.
  const tHtml = await f(antwort(502, '<html>Bad Gateway</html>'), adresse);
  pruefe('eine HTML-Fehlerseite wirft nicht, sondern wird zitiert',
    tHtml.includes('502') && tHtml.includes('Bad Gateway'), tHtml);
}
{
  // Und der Fehler, um den es geht: die genaue Meldung MUSS stehen bleiben.
  const archiv = {
    verfuegbar: () => true,
    dateiLesen: async () => 'data:image/png;base64,AAAA',
    vorschauBauen: async () => null,
    speichern: async () => ({ schluessel: 'x' })
  };
  BimViewer.SkizzenStore = archiv;
  kontext.fetch = () => Promise.reject(new Error('Failed to fetch'));

  meldungen.length = 0;
  const ergebnis = await BE.dateienAufnehmen([{ name: 'plan.pdf', type: 'application/pdf' }]);
  pruefe('ein gescheitertes PDF gibt nichts zurück', ergebnis === null);

  const letzte = meldungen[meldungen.length - 1] || '';
  pruefe('die letzte Meldung nennt das Backend, nicht „keine verwertbare Datei"',
    letzte.includes('nicht erreichbar') && !letzte.includes('Keine verwertbare'),
    letzte);
  pruefe('sie nennt die Adresse', letzte.includes('http://backend/plan/pdf'), letzte);

  // Umgekehrt: eine wirklich unbrauchbare Datei bekommt weiter die
  // allgemeine Meldung — die Unterscheidung ist der ganze Zweck.
  meldungen.length = 0;
  await BE.dateienAufnehmen([{ name: 'notizen.txt', type: 'text/plain' }]);
  pruefe('eine unbrauchbare Datei bekommt weiter die allgemeine Meldung',
    (meldungen[meldungen.length - 1] || '').includes('Keine verwertbare'),
    meldungen[meldungen.length - 1]);

  // Und die Merkstelle darf nicht über den nächsten Versuch hinaus gelten.
  pruefe('die gemerkte Ursache wird je Versuch zurückgesetzt',
    BE._letzterFehler === null);
}

console.log(`\n${fehler === 0 ? '✓ alles in Ordnung' : '✗ ' + fehler + ' Prüfung(en) fehlgeschlagen'}\n`);
process.exit(fehler === 0 ? 0 : 1);

})();
