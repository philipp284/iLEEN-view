// Die Geschossgrundrisse ohne Browser.
//
// Aufruf:  node tests/geschossplaene/test-geschossplaene.js
//
// Was hier NICHT geprüft werden kann, ist das Bild: ob Cesium die Textur so
// auf die Ebene legt, wie der Kopf von geschossplaene.js es herleitet, zeigt
// erst der Blick auf den Nordpfeil. Prüfbar ist alles davor — und dort sitzen
// die Fehler, die im Bild als „der Grundriss liegt woanders" ankommen:
//
//   1. Der Ausschnitt je Geschoss: die Box-Unterkante MUSS auf dem Fußboden
//      liegen, sonst zählt `cut_height` von einer beliebigen Kastenkante und
//      der Schnitt trifft die Brüstungen statt der Türen.
//   2. Der Nullpunkt-Versatz. `/storeys` zählt ab der Modellunterkante, das
//      Tile-System ab dem Tile-Ursprung — ohne die Umrechnung schwebt der
//      ganze Stapel um eine halbe Gebäudehöhe zu hoch.
//   3. Die Y-Umkehr beim Malen. Sie ist es, die den Grundriss unter der
//      Textur richtig herum liegen lässt; ohne sie steht er spiegelverkehrt
//      über dem Bauwerk, und das sieht man an einem symmetrischen Grundriss
//      erst, wenn jemand eine Tür sucht.
//   4. Dass die Ringe einer Figur in EINEM Pfad gefüllt werden. Getrennt
//      gefüllt wird aus jedem Raum eine Betonfläche.
//   5. Dass das Blatt unter demselben Schlüssel ins Archiv geht, den
//      `Plan2D.open()` bildet — sonst findet der Planbrowser es nicht.

const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ── Cesium-Ersatz ─────────────────────────────────────────────────────────
//
// Die Tile-Matrix ist eine reine Verschiebung: dann ist „Tile-System" bis auf
// den Ursprung gleich „Weltsystem", und die Prüfungen rechnen in Metern statt
// in Geodäsie. Mehr wäre eine zweite Cesium-Implementierung.

class C3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone(r) { return C3.clone(this, r); }
  static clone(a, r) { if (!r) return new C3(a.x, a.y, a.z); r.x = a.x; r.y = a.y; r.z = a.z; return r; }
  static add(a, b, r) { r.x = a.x + b.x; r.y = a.y + b.y; r.z = a.z + b.z; return r; }
  static subtract(a, b, r) { r.x = a.x - b.x; r.y = a.y - b.y; r.z = a.z - b.z; return r; }
  static multiplyByScalar(a, s, r) { r.x = a.x * s; r.y = a.y * s; r.z = a.z * s; return r; }
  static normalize(a, r) {
    const l = Math.hypot(a.x, a.y, a.z) || 1;
    r.x = a.x / l; r.y = a.y / l; r.z = a.z / l; return r;
  }
}
C3.ZERO = new C3(0, 0, 0);
C3.UNIT_X = new C3(1, 0, 0);
C3.UNIT_Y = new C3(0, 1, 0);
C3.UNIT_Z = new C3(0, 0, 1);

/** Eine Matrix ist hier nur ihre Verschiebung — die Drehung ist die Identität. */
const M = (t) => ({ t: t || new C3() });

class Ereignis {
  constructor() { this.horcher = []; }
  addEventListener(f) { this.horcher.push(f); return () => { this.horcher = this.horcher.filter((h) => h !== f); }; }
  raiseEvent(...a) { this.horcher.slice().forEach((f) => f(...a)); }
}

const Cesium = {
  Cartesian3: C3,
  Cartesian2: class { constructor(x, y) { this.x = x; this.y = y; } },
  Color: class { constructor(r, g, b, a) { this.red = r; this.green = g; this.blue = b; this.alpha = a; } },
  Plane: class { constructor(normal, distance) { this.normal = normal; this.distance = distance; } },
  ShadowMode: { DISABLED: 0 },
  Matrix4: Object.assign(function Matrix4() { return M(); }, {
    multiplyByPoint: (m, p, r) => { const z = r || new C3(); const t = m.t || C3.ZERO;
      z.x = p.x + t.x; z.y = p.y + t.y; z.z = p.z + t.z; return z; },
    // Reine Drehung, und die ist hier die Identität: ein Vektor bleibt er selbst.
    multiplyByPointAsVector: (m, p, r) => C3.clone(p, r || new C3()),
    inverseTransformation: (m) => M(new C3(-(m.t || C3.ZERO).x, -(m.t || C3.ZERO).y, -(m.t || C3.ZERO).z)),
    getMatrix3: () => [new C3(1, 0, 0), new C3(0, 1, 0), new C3(0, 0, 1)],
  }),
  Matrix3: Object.assign(function Matrix3() { return [new C3(1, 0, 0), new C3(0, 1, 0), new C3(0, 0, 1)]; }, {
    getColumn: (m, i, r) => C3.clone(m[i], r),
    setColumn: (m, i, v, r) => { const z = r || m.slice(); z[i] = C3.clone(v, new C3()); return z; },
  }),
  Quaternion: Object.assign(function Quaternion() { return { q: true }; }, {
    IDENTITY: { identitaet: true },
    fromRotationMatrix: (m) => ({ ausMatrix: m }),
  }),
  Material: { fromType: (typ, opt) => ({ typ, uniforms: Object.assign({}, opt) }) },
  Geometry: class { constructor(opt) { Object.assign(this, opt); } },
  GeometryAttribute: class { constructor(opt) { Object.assign(this, opt); } },
  GeometryInstance: class { constructor(opt) { Object.assign(this, opt); } },
  MaterialAppearance: class { constructor(opt) { Object.assign(this, opt); } },
  Primitive: class { constructor(opt) { Object.assign(this, opt); this.modelMatrix = M(); } },
  ComponentDatatype: { DOUBLE: 'double', FLOAT: 'float' },
  PrimitiveType: { TRIANGLES: 'triangles' },
  BoundingSphere: { fromPoints: (p) => ({ punkte: p.length }) },
  defined: (x) => x !== undefined && x !== null,
};
Cesium.Matrix4.IDENTITY = M();
Cesium.Matrix4.clone = (a, r) => { const z = r || M(); z.t = C3.clone(a.t || C3.ZERO, new C3()); return z; };
Cesium.Matrix4.equals = (a, b) => {
  if (!a || !b) return a === b;
  const at = a.t || C3.ZERO, bt = b.t || C3.ZERO;
  return at.x === bt.x && at.y === bt.y && at.z === bt.z;
};
Cesium.Matrix4.fromTranslation = (v, r) => { const z = r || M(); z.t = C3.clone(v, new C3()); return z; };

// ── Canvas-Ersatz ─────────────────────────────────────────────────────────
//
// Schreibt jeden Zeichenbefehl mit. Daran hängen die Prüfungen auf die
// Y-Umkehr, die Füllregel und die Reihenfolge Ansicht-vor-Schnitt.

class Ctx2D {
  constructor() { this.befehle = []; this.pfad = []; }
  _log(name, ...a) { this.befehle.push({ name, args: a, fill: this.fillStyle, stroke: this.strokeStyle }); }
  fillRect(...a) { this._log('fillRect', ...a); }
  beginPath() { this.pfad = []; this._log('beginPath'); }
  moveTo(x, y) { this.pfad.push(['M', x, y]); this._log('moveTo', x, y); }
  lineTo(x, y) { this.pfad.push(['L', x, y]); this._log('lineTo', x, y); }
  closePath() { this._log('closePath'); }
  fill(regel) { this._log('fill', regel); }
  stroke() { this._log('stroke'); }
  fillText(t, x, y) { this._log('fillText', t, x, y); }
  measureText(t) {
    const px = /(\d+(?:\.\d+)?)px/.exec(this.font || '');
    return { width: String(t).length * (px ? parseFloat(px[1]) : 10) * 0.55 };
  }
}

class Canvas {
  constructor() { this.width = 0; this.height = 0; this._ctx = new Ctx2D(); }
  getContext() { return this._ctx; }
  toDataURL() { return 'data:image/png;base64,GEMALT'; }
}

let letztesCanvas = null;

// ── Browser-Ersatz ────────────────────────────────────────────────────────

const elemente = {};
function element(id) {
  if (!elemente[id]) {
    elemente[id] = { id, value: '', checked: false, disabled: false, textContent: '',
                     innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} } };
  }
  return elemente[id];
}

// Die Kennungen des Panels vorab anlegen. Im Browser stehen sie im Dokument,
// sobald das Panel eingehängt ist; entstünden sie hier erst beim ersten Lesen,
// liefe jede Meldung davor ins Leere und der Test prüfte ein leeres Feld.
['geschossplaeneAn', 'geschossplaeneKoppeln', 'geschossplaeneAbstand',
 'geschossplaeneAbstandWert', 'geschossplaeneDeckung', 'geschossplaeneSchnitthoehe',
 'geschossplaeneRaeume', 'geschossplaeneListe', 'geschossplaeneStatus'].forEach(element);

const sandkasten = {
  console,
  setInterval: () => 0,
  clearInterval: () => {},
  document: {
    getElementById: (id) => (id in elemente ? elemente[id] : null),
    querySelector: () => null,
    createElement: (tag) => {
      if (tag === 'canvas') { letztesCanvas = new Canvas(); return letztesCanvas; }
      return { style: {}, classList: { add() {} }, innerHTML: '', appendChild() {} };
    },
  },
};
sandkasten.window = sandkasten;
sandkasten.globalThis = sandkasten;
sandkasten.Cesium = Cesium;

// ── Szene- und Backend-Attrappen ──────────────────────────────────────────

const geschossListe = [
  { name: 'EG', hoehe: 0.0, bauteile: 120 },
  { name: '1.OG', hoehe: 3.0, bauteile: 118 },
  { name: '2.OG', hoehe: 6.0, bauteile: 95 },
];

/** Ein Grundriss von 20 × 10 m mit einer umlaufenden Wand und einem Raum. */
function planAntwort(job = 'job-1') {
  return {
    job_id: job,
    mode: 'grundriss',
    bounds: [0, 0, 20, 10],
    plane_origin: [0, 0, 1.2],
    figures: [
      { global_id: 'w1', ifc_type: 'IfcWall', kind: 'schnitt', signature: 'beton',
        rings: [[[0, 0], [20, 0], [20, 10], [0, 10]],
                [[0.3, 0.3], [19.7, 0.3], [19.7, 9.7], [0.3, 9.7]]] },
      { global_id: 's1', ifc_type: 'IfcSlab', kind: 'ansicht', signature: null,
        rings: [[[2, 2], [8, 2], [8, 6], [2, 6]]] },
    ],
    rooms: [
      { global_id: 'r1', name: '0.01', long_name: 'Büro', area: 60.0, anchor: [10, 5] },
      // Ein Besenschrank: die Beschriftung ist breiter als der Raum und muss
      // deshalb wegbleiben, statt in die Nachbarräume zu ragen.
      { global_id: 'r2', name: '0.02', long_name: 'Hauswirtschaftsraum', area: 0.6, anchor: [1, 1] },
    ],
    signaturen: { linien: {}, muster: {} },
  };
}

let sectionAufrufe = [];
let sectionAntwort = planAntwort;

sandkasten.fetch = async (url, opt) => {
  if (/\/storeys$/.test(url)) return { ok: true, json: async () => geschossListe };
  if (/\/section$/.test(url)) {
    sectionAufrufe.push(JSON.parse(opt.body));
    const plan = sectionAntwort(url.match(/assets\/([^/]+)\//)[1]);
    if (!plan) return { ok: false, status: 422 };
    return { ok: true, json: async () => plan };
  }
  throw new Error('unerwartete Adresse: ' + url);
};

const entitaeten = [];
const preRenderHorcher = [];

// Hüllkugel Mitte 10, Radius 12 → Modellunterkante bei −2. Genau dieser
// Versatz ist das, woran der Stapel als Ganzes hängt.
const tileset = {
  root: { computedTransform: M(new C3(1000, 2000, 3000)) },
  // In Weltkoordinaten, wie bei Cesium: der Tile-Ursprung liegt bei
  // (1000, 2000, 3000), die Kugelmitte also 10 m darüber. Im Tile-System
  // ist das (0, 0, 10) mit Radius 12 — Modellunterkante bei −2.
  boundingSphere: { center: new C3(1000, 2000, 3010), radius: 12 },
};

const archiv = [];

sandkasten.BimViewer = {
  viewer: {
    scene: {
      preRender: { addEventListener: (f) => { preRenderHorcher.push(f);
        return () => { const i = preRenderHorcher.indexOf(f); if (i >= 0) preRenderHorcher.splice(i, 1); }; } },
      primitives: {
        add: (p) => { entitaeten.push(p); return p; },
        remove: (p) => { const i = entitaeten.indexOf(p); if (i >= 0) entitaeten.splice(i, 1); return i >= 0; },
      },
    },
  },
  loadedAssets: new Map([
    ['a', { id: 'a', jobId: 'job-1', name: 'Bürohaus.ifc', tileset, visible: true }],
  ]),
  getBackendUrl: () => 'http://backend',
  updateStatus: () => {},
  PlanStore: {
    verfuegbar: () => true,
    speichern: async (satz) => { archiv.push(satz); return satz; },
    laden: async (s) => archiv.find((a) => a.schluessel === s) || null,
  },
};

// ── Module laden ──────────────────────────────────────────────────────────
//
// explosion.js MIT, nicht als Attrappe: die Geschossaufbereitung samt
// Zwischenspeicher wird von geschossplaene.js über `Explosion.geschosse()`
// mitbenutzt, und genau diese Kopplung soll geprüft sein.

const wurzel = path.resolve(__dirname, '..', '..');
const kontext = vm.createContext(sandkasten);
for (const datei of ['explosion.js', 'geschossplaene.js']) {
  vm.runInContext(fs.readFileSync(path.join(wurzel, datei), 'utf8'), kontext, { filename: datei });
}

const BimViewer = sandkasten.BimViewer;
const G = BimViewer.Geschossplaene;

// ── Prüfgerüst ────────────────────────────────────────────────────────────

let ok = 0, schlecht = 0;
const nahe = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
function abschnitt(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 58 - t.length))); }
function pruefe(name, bedingung, zusatz) {
  if (bedingung) { ok++; console.log('✓ ' + name + (zusatz ? '   ' + zusatz : '')); }
  else { schlecht++; console.log('✗ ' + name + (zusatz ? '   ' + zusatz : '')); }
}

(async () => {

  abschnitt('Modellwahl');

  pruefe('Das Backend-Modell wird gefunden', G._modell() && G._modell().jobId === 'job-1');

  // Ein Geschossklon der Explosion ist kein zweites Modell — er trägt dieselbe
  // job_id und würde sonst als eigenes Bauwerk mitgezählt.
  BimViewer.loadedAssets.set('klon', {
    id: 'klon', jobId: 'job-1', name: 'Bürohaus.ifc',
    tileset: { root: {}, _explosionKlonVon: {} }, visible: true });
  pruefe('Ein Explosionsklon wird nicht für ein Modell gehalten',
         G._modell().id === 'a');
  BimViewer.loadedAssets.delete('klon');

  BimViewer.loadedAssets.set('wolke', {
    id: 'wolke', jobId: 'job-2', name: 'Scan.las',
    tileset: { root: {} }, isPointCloud: true, visible: true });
  pruefe('Eine Punktwolke hat keine Geschosse', G._modell().id === 'a');
  BimViewer.loadedAssets.delete('wolke');

  abschnitt('Ausschnitt je Geschoss');

  const asset = G._modell();
  const gruppen = await G._geschosse(asset);
  pruefe('Die Geschosse kommen aus der Explosionsaufbereitung', gruppen.length === 3,
         gruppen.map((g) => g.namen[0] + '@' + g.hoehe).join(', '));

  // ZWEI HÖHENSYSTEME. Die Attrappe ist eigens so gewählt, dass sie
  // auseinanderfallen: Modellunterkante im Render-System bei −2, während
  // `/storeys` das EG bei 0 führt. Setzte sie beide gleich (Unterkante 0),
  // ginge der Fehler durch, der am echten Modell drei Geschosse leer und drei
  // am falschen Ort schneiden ließ.
  const boxEG = G._ausschnitt(asset, gruppen[0], 0, gruppen);
  pruefe('Die Box bleibt im Schnitt-System — die Geschosshöhe geht unverändert ein',
         nahe(boxEG.center[2] - boxEG.size[2] / 2, 0.0),
         'Unterkante ' + (boxEG.center[2] - boxEG.size[2] / 2) +
         ' — mit fälschlich addiertem Versatz wäre sie −2');
  pruefe('Die Box reicht bis zum nächsten Geschoss', nahe(boxEG.size[2], 3.0),
         'Höhe ' + boxEG.size[2]);

  const boxOG2 = G._ausschnitt(asset, gruppen[2], 2, gruppen);
  pruefe('Das oberste Geschoss bekommt eine Regelhöhe', nahe(boxOG2.size[2], 3.5));
  pruefe('… und steht auf seinem eigenen Fußboden',
         nahe(boxOG2.center[2] - boxOG2.size[2] / 2, 6.0),
         'Unterkante ' + (boxOG2.center[2] - boxOG2.size[2] / 2));

  // Derselbe Weg, den plan-panel.js seit jeher geht — die beiden dürfen nicht
  // auseinanderlaufen, sonst schneidet der eine Reiter woanders als der andere.
  gruppen.forEach(function (g, i) {
    const box = G._ausschnitt(asset, g, i, gruppen);
    const naechstes = gruppen[i + 1];
    const hoch = naechstes ? Math.max(naechstes.hoehe - g.hoehe, 0.5) : 3.5;
    pruefe('Geschoss ' + g.namen[0] + ' schneidet wie der Plan-Reiter',
           nahe(box.center[2], g.hoehe + hoch / 2),
           box.center[2] + ' gegen ' + (g.hoehe + hoch / 2));
  });

  pruefe('Waagerecht wird das ganze Modell genommen',
         nahe(boxEG.size[0], 12 * 2.2) && nahe(boxEG.size[1], 12 * 2.2));
  pruefe('Die XY-Mitte kommt aus der Render-Matrix (dort sind beide Systeme gleich)',
         nahe(boxEG.center[0], 0) && nahe(boxEG.center[1], 0),
         boxEG.center[0] + ' / ' + boxEG.center[1]);

  abschnitt('Das Bild');

  const bild = G._bildBauen(planAntwort());
  const I = G._internals;
  // 20 m lange Kante auf 2048 px minus zweimal Rand: 101,6 px je Meter.
  pruefe('Die längere Kante bestimmt die Auflösung',
         nahe(bild.pxJeMeter, (I.TEXTUR_MAX - 2 * I.RAND_PX) / 20),
         bild.pxJeMeter.toFixed(2) + ' px/m');
  pruefe('Die Textur bleibt in der Grenze',
         bild.pixel[0] <= I.TEXTUR_MAX && bild.pixel[1] <= I.TEXTUR_MAX,
         bild.pixel.join(' × '));
  pruefe('Der Randstreifen liegt außen herum',
         nahe(bild.bounds[0], -I.RAND_PX / bild.pxJeMeter) &&
         nahe(bild.bounds[2], 20 + I.RAND_PX / bild.pxJeMeter),
         '[' + bild.bounds.map((b) => b.toFixed(3)).join(', ') + ']');
  pruefe('Die Mitte ist die Mitte der Zeichnung',
         nahe(bild.mitteX, 10) && nahe(bild.mitteY, 5),
         bild.mitteX + ' / ' + bild.mitteY);
  pruefe('Breite und Höhe schließen den Rand ein',
         nahe(bild.breite, bild.bounds[2] - bild.bounds[0]) &&
         nahe(bild.hoehe, bild.bounds[3] - bild.bounds[1]));

  const befehle = letztesCanvas.getContext().befehle;

  // Die Y-Umkehr: in der Zeichnung wächst Nord nach oben, im Bild nach unten.
  // Der Punkt (0,10) — die NORDWEST-Ecke der Wand — muss deshalb OBEN links
  // landen, also bei kleinem Pixel-Y.
  const eckeNW = befehle.find((b) => b.name === 'lineTo' && nahe(b.args[0], I.RAND_PX, 0.5) &&
                                     b.args[1] < 20);
  const eckeSW = befehle.find((b) => (b.name === 'moveTo') && nahe(b.args[0], I.RAND_PX, 0.5));
  pruefe('Nord liegt oben im Bild, nicht unten',
         !!eckeNW && !!eckeSW && eckeNW.args[1] < eckeSW.args[1],
         'NW bei y=' + (eckeNW && eckeNW.args[1].toFixed(1)) +
         ', SW bei y=' + (eckeSW && eckeSW.args[1].toFixed(1)));
  pruefe('Der Zeichnungsnullpunkt liegt auf dem Randstreifen',
         !!eckeSW && nahe(eckeSW.args[0], I.RAND_PX, 0.5) &&
         nahe(eckeSW.args[1], bild.pixel[1] - I.RAND_PX, 0.5),
         eckeSW && (eckeSW.args[0].toFixed(1) + ' / ' + eckeSW.args[1].toFixed(1)));

  // Beide Ringe der Wand gehören in EINEN Pfad: `evenodd` macht aus dem inneren
  // Ring das Loch. Getrennt gefüllt stünde dort eine massive Scheibe.
  const fuellungen = befehle.filter((b) => b.name === 'fill');
  pruefe('Gefüllt wird mit der Even-Odd-Regel',
         fuellungen.length === 1 && fuellungen[0].args[0] === 'evenodd',
         fuellungen.length + ' Füllung(en), Regel ' + (fuellungen[0] || {}).args);
  const bisFuellung = befehle.slice(0, befehle.indexOf(fuellungen[0]));
  const letzterPfad = bisFuellung.slice(
    bisFuellung.map((b) => b.name).lastIndexOf('beginPath'));
  pruefe('Beide Ringe der Wand stehen in diesem einen Pfad',
         letzterPfad.filter((b) => b.name === 'moveTo').length === 2,
         letzterPfad.filter((b) => b.name === 'moveTo').length + ' Ringe');

  // Ansichtskanten liegen unter den Schnittfiguren — sonst überdeckt eine
  // dünne Umrisslinie die Fläche der Wand darüber.
  const ersterStrich = befehle.findIndex((b) => b.name === 'stroke');
  pruefe('Ansichtskanten werden vor den Schnittfiguren gemalt',
         befehle[ersterStrich].stroke !== befehle[befehle.length - 1].stroke ||
         befehle.filter((b) => b.name === 'stroke').length === 2,
         befehle.filter((b) => b.name === 'stroke').length + ' Striche');

  abschnitt('Raumbeschriftung');

  const texte = befehle.filter((b) => b.name === 'fillText').map((b) => b.args[0]);
  pruefe('Der Raumname steht am Ankerpunkt', texte.includes('Büro'), texte.join(' | '));
  pruefe('Die Fläche steht darunter', texte.some((t) => /60\.0 m²/.test(t)));
  pruefe('Ein Raum, der schmaler ist als seine Beschriftung, bleibt unbeschriftet',
         !texte.includes('Hauswirtschaftsraum'), texte.join(' | '));

  G.mitRaeumen = false;
  G._bildBauen(planAntwort());
  pruefe('Abgeschaltet wird gar nicht beschriftet',
         !letztesCanvas.getContext().befehle.some((b) => b.name === 'fillText'));
  G.mitRaeumen = true;

  abschnitt('Einschalten');

  sectionAufrufe = [];
  await G.an();

  pruefe('Der Stapel steht', G.aktiv === true);
  pruefe('Je Geschoss ein Schnitt', sectionAufrufe.length === 3,
         sectionAufrufe.length + ' Aufrufe');
  pruefe('Geschnitten wird als Grundriss',
         sectionAufrufe.every((a) => a.mode === 'grundriss'));
  pruefe('Die Schnitthöhe ist die über dem Fußboden, nicht über der Box',
         sectionAufrufe.every((a) => a.cut_height === 1.2));
  pruefe('Je Geschoss eine Fläche in der Szene', entitaeten.length === 3,
         entitaeten.length + ' Primitive');
  pruefe('Jede Fläche trägt ihr Blatt', entitaeten.every((e) => !!e._geschossplan));
  pruefe('Je Fläche ein Primitiv, nicht tausend Polygone',
         entitaeten.every((e) => e.geometryInstances));

  abschnitt('Lage im Raum');

  const eg = G.blaetter.find((b) => b.name === 'EG');
  const og2 = G.blaetter.find((b) => b.name === '2.OG');

  // /storeys zählt ab der Modellunterkante (EG = 0), das Tile-System ab dem
  // Tile-Ursprung — und der liegt hier 2 m über der Unterkante.
  // Die Gegenprobe zur Box: die FLÄCHE liegt im Render-System und bekommt den
  // Versatz sehr wohl. Beide Prüfungen zusammen halten die beiden Systeme
  // auseinander — einzeln ließe sich jede von ihnen auch falsch erfüllen.
  pruefe('Die Fläche wird auf das Render-System umgerechnet',
         nahe(eg.hoeheTile, -2.0) && nahe(og2.hoeheTile, 4.0),
         'EG ' + eg.hoeheTile + ', 2.OG ' + og2.hoeheTile);
  pruefe('Fläche und Box liegen damit in verschiedenen Systemen',
         !nahe(eg.hoeheTile, sectionAufrufe[0].center[2] - sectionAufrufe[0].size[2] / 2),
         'Fläche ' + eg.hoeheTile + ', Box-Unterkante ' +
         (sectionAufrufe[0].center[2] - sectionAufrufe[0].size[2] / 2));

  G.gekoppelt = false;
  G.abstandSetzen(0);

  /** Die vier Ecken einer Fläche als Tripel, in der Reihenfolge der Geometrie. */
  const ecken = (blatt) => {
    const v = blatt.flaeche.geometryInstances.geometry.attributes.position.values;
    return [0, 1, 2, 3].map((i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]);
  };
  const st = (blatt) =>
    Array.from(blatt.flaeche.geometryInstances.geometry.attributes.st.values);

  // Tile-Ursprung bei (1000, 2000, 3000), Zeichnung von rund 0 bis 20 × 10 m,
  // EG auf Tile-Höhe −2.
  const egEcken = ecken(eg);
  // 2998 = Tile-Ursprung 3000 + Geschosshöhe −2, dazu die 15 cm, mit denen die
  // Zeichnung über dem Fußboden schwebt — ohne sie deckt ein voll gestauchtes
  // Geschoss sie zu.
  pruefe('Die erste Ecke ist Südwest', nahe(egEcken[0][0], 1000, 0.1) &&
         nahe(egEcken[0][1], 2000, 0.1) && nahe(egEcken[0][2], 2998.15),
         egEcken[0].map((v) => v.toFixed(2)).join(' / '));
  pruefe('Die dritte Ecke ist Nordost', nahe(egEcken[2][0], 1020, 0.1) &&
         nahe(egEcken[2][1], 2010, 0.1),
         egEcken[2].map((v) => v.toFixed(2)).join(' / '));
  pruefe('Alle vier Ecken liegen auf einer Höhe',
         egEcken.every((e) => nahe(e[2], 2998.15)));
  pruefe('Die Zeichnung schwebt über dem Fußboden, nicht darauf',
         egEcken[0][2] > 2998 && egEcken[0][2] < 2998.5,
         (egEcken[0][2] - 2998).toFixed(2) + ' m über dem Fußboden');

  // Die Zuordnung, an der die Lesbarkeit hängt: `flipY` legt t = 1 an die
  // BILDOBERKANTE, und die malt `_bildBauen()` mit dem größten y. Also muss
  // die Nordkante (großes y) t = 1 bekommen.
  pruefe('Südwest bekommt st (0,0)', st(eg)[0] === 0 && st(eg)[1] === 0);
  pruefe('Nordost bekommt st (1,1)', st(eg)[4] === 1 && st(eg)[5] === 1);
  pruefe('Die Nordkante liegt an der Bildoberkante (t = 1)',
         st(eg)[5] === 1 && st(eg)[7] === 1 && st(eg)[1] === 0 && st(eg)[3] === 0,
         '[' + st(eg).join(', ') + ']');

  pruefe('Die Normale ist die Hochachse des Modells',
         eg.flaeche.geometryInstances.geometry.attributes.normal.values[2] === 1);
  pruefe('Die Fläche wird nicht beleuchtet', eg.flaeche.appearance.flat === true);
  pruefe('Die Fläche fängt keine Klicks ab', eg.flaeche.allowPicking === false);
  pruefe('Zwei Dreiecke, ein Rechteck',
         Array.from(eg.flaeche.geometryInstances.geometry.indices).join(',') === '0,1,2,0,2,3');

  pruefe('Ohne Stapelversatz steht die Fläche unverschoben',
         nahe(eg.flaeche.modelMatrix.t.z, 0) && nahe(og2.flaeche.modelMatrix.t.z, 0),
         String(og2.flaeche.modelMatrix.t.z));

  G.abstandSetzen(5);
  pruefe('Der Abstand hebt je Rang, nicht je Meter Geschosshöhe',
         nahe(eg.flaeche.modelMatrix.t.z, 0) &&
         nahe(og2.flaeche.modelMatrix.t.z, 2 * 5),
         'EG ' + eg.flaeche.modelMatrix.t.z + ', 2.OG ' + og2.flaeche.modelMatrix.t.z);
  pruefe('Der Regler baut keine Textur neu',
         nahe(ecken(og2)[0][2], 2998.15 + 6),
         'Ecke liegt weiter auf der Geschosshöhe des 2. OG');

  abschnitt('Deckkraft');

  G.deckungSetzen(0.4);
  pruefe('Die Deckkraft geht in das Uniform, nicht in ein neues Material',
         nahe(eg.flaeche.appearance.material.uniforms.color.alpha, 0.4),
         String(eg.flaeche.appearance.material.uniforms.color.alpha));
  pruefe('Die Textur bleibt dieselbe',
         eg.flaeche.appearance.material.uniforms.image === eg.bild.url);
  G.deckungSetzen(1);

  abschnitt('Nachgerückte Modelle');

  // terrain-align.js rückt ein Modell nach, sobald das Gelände geladen ist.
  // Die Ecken stecken als Weltkoordinaten in der Geometrie und müssen dann neu
  // gerechnet werden — sonst bleibt der Grundriss neben dem Bauwerk stehen.
  const vorher = eg.flaeche;
  tileset.root.computedTransform = M(new C3(1000, 2000, 3050));
  G._lagen();
  pruefe('Eine nachgerückte Tile-Matrix baut die Fläche neu',
         eg.flaeche !== vorher);
  pruefe('… und die Ecken wandern mit', nahe(ecken(eg)[0][2], 3048.15),
         String(ecken(eg)[0][2]));
  tileset.root.computedTransform = M(new C3(1000, 2000, 3000));
  G._lagen();
  pruefe('Zurückgerückt findet sie ihren Platz wieder',
         nahe(ecken(eg)[0][2], 2998.15), String(ecken(eg)[0][2]));

  abschnitt('Kopplung an die Explosion');

  G.gekoppelt = true;
  BimViewer.Explosion.aktiv = true;
  BimViewer.Explosion.abstand = 8;
  pruefe('Gekoppelt gilt der Abstand der Explosion', G._abstand() === 8);
  G._lagen();
  pruefe('… und der Stapel steht in demselben Raster',
         nahe(og2.flaeche.modelMatrix.t.z, 2 * 8),
         String(og2.flaeche.modelMatrix.t.z));

  BimViewer.Explosion.aktiv = false;
  pruefe('Ohne laufende Explosion gilt der eigene Regler', G._abstand() === 5);

  G.gekoppelt = false;
  BimViewer.Explosion.aktiv = true;
  pruefe('Entkoppelt bleibt der eigene Regler stehen', G._abstand() === 5);
  BimViewer.Explosion.aktiv = false;

  abschnitt('Planarchiv');

  pruefe('Je Geschoss ein Blatt', archiv.length === 3, archiv.length + ' Blätter');

  const blattEG = archiv.find((a) => /EG/.test(a.titel));
  pruefe('Der Schlüssel ist der von Plan2D (Job, Modus, Titel)',
         blattEG.schluessel === ['job-1', 'grundriss', blattEG.titel].join('|'),
         blattEG.schluessel);
  pruefe('Die Blattart ist gesetzt', blattEG.art === 'grundriss');
  pruefe('Das Geschoss steht im Kurzindex', blattEG.geschoss === 'EG');
  pruefe('Die Herkunft ist benannt', blattEG.herkunft === 'geschossplaene',
         blattEG.herkunft);
  pruefe('Die Geometrie geht mit', blattEG.drawing.figures.length === 2);
  pruefe('Ohne SVG-Abzug — den schreibt erst das Schließen des Zeichenmodus',
         blattEG.svg === '');
  // 20 × 10 m: in 1:25 wären das 800 × 400 mm und passt damit gerade auf A1.
  pruefe('Der Maßstab ist der feinste, der auf A1 passt', blattEG.massstab === 25,
         '1:' + blattEG.massstab);
  pruefe('Das Blatt ist am Modell festgemacht', blattEG.jobId === 'job-1' &&
         blattEG.modell === 'Bürohaus.ifc');

  abschnitt('Ausschalten');

  G.aus();
  pruefe('Die Flächen sind aus der Szene', entitaeten.length === 0,
         entitaeten.length + ' übrig');
  pruefe('Es bleibt kein Blatt stehen', G.blaetter.length === 0);
  pruefe('Die Wache ist abgemeldet', preRenderHorcher.length === 0);
  pruefe('Die Blätter bleiben im Archiv', archiv.length === 3);

  abschnitt('Randfälle');

  // Ein Modell, dessen Geschosse keine Figur treffen: kein Absturz, kein
  // leerer Stapel, sondern eine Meldung.
  sectionAntwort = () => ({ job_id: 'job-1', mode: 'grundriss', bounds: [0, 0, 0, 0],
                            figures: [], rooms: [], signaturen: {} });
  await G.an();
  pruefe('Ein Modell ohne Figuren schaltet nicht ein', G.aktiv === false);
  pruefe('… und sagt warum', /Kein Geschoss/.test(element('geschossplaeneStatus').textContent),
         element('geschossplaeneStatus').textContent);
  sectionAntwort = planAntwort;

  const ohneBackend = BimViewer.getBackendUrl;
  BimViewer.getBackendUrl = () => '';
  await G.an();
  pruefe('Ohne Backend gibt es keinen Schnitt', G.aktiv === false &&
         /Backend/.test(element('geschossplaeneStatus').textContent));
  BimViewer.getBackendUrl = ohneBackend;

  // Eine entartete Zeichnung darf kein Canvas von null Pixeln erzeugen.
  pruefe('Eine Zeichnung ohne Ausdehnung ergibt kein Bild',
         G._bildBauen({ bounds: [5, 5, 5, 5], figures: [], rooms: [] }) === null);

  abschnitt('Fremder Text');

  pruefe('Bauteilnamen werden entschärft',
         I.esc('<img src=x onerror=alert(1)>') ===
         '&lt;img src=x onerror=alert(1)&gt;');
  pruefe('… auch Anführungszeichen', I.esc('Raum "A"') === 'Raum &quot;A&quot;');

  abschnitt('Panel');

  const markup = I.panelHtml();
  const kennungen = ['geschossplaeneAn', 'geschossplaeneKoppeln', 'geschossplaeneAbstand',
                     'geschossplaeneAbstandWert', 'geschossplaeneDeckung',
                     'geschossplaeneSchnitthoehe', 'geschossplaeneRaeume',
                     'geschossplaeneListe', 'geschossplaeneStatus'];
  const fehlend = kennungen.filter((k) => markup.indexOf('id="' + k + '"') < 0);
  pruefe('Jede Kennung, an der ein Handler hängt, kommt vor',
         fehlend.length === 0, fehlend.join(', '));

  const aufrufe = markup.match(/BimViewer\.Geschossplaene\.(\w+)\(/g) || [];
  const unbekannt = aufrufe
    .map((a) => a.replace(/.*\.(\w+)\($/, '$1'))
    .filter((n, i, l) => l.indexOf(n) === i)
    .filter((n) => typeof G[n] !== 'function');
  pruefe('Jeder Handler im Markup existiert auch', unbekannt.length === 0,
         unbekannt.join(', '));
  pruefe('Es wird nur das Design-System benutzt',
         !/style="(?!display:none)/.test(markup.replace(/style="display:none;"/g, '')));

  abschnitt('Ergebnis');

  console.log('\n' + (schlecht === 0
    ? 'Alles in Ordnung.'
    : schlecht + ' Prüfung(en) fehlgeschlagen.'));
  process.exit(schlecht === 0 ? 0 : 1);

})().catch((e) => { console.error(e); process.exit(1); });
