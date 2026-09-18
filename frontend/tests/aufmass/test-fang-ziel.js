// Prüft, worauf der Messmodus fängt — `aufmass-fang.js`, ohne Browser.
//
// Aufruf:  node tests/aufmass/test-fang-ziel.js
//
// Der Fehler, um den es geht
// ==========================
// `SplatPick` wurde nur gefragt, wenn der Tiefenpuffer unter dem Zeiger GAR
// NICHTS hergab — also nur bei einer Splatwolke vor freiem Himmel. Im
// Regelfall liegt hinter der Wolke das Gelände; `pickPosition` lieferte dann
// brav einen Punkt, nämlich den auf dem Boden DAHINTER, und der Splat kam nie
// zur Sprache. Man maß die Baugrube und traf die Wiese.
//
// Das ist keine Vermutung über den Code, sondern sein früherer Wortlaut:
// „Kein Tiefenwert unter dem Zeiger heißt fast immer: dort steht eine
// Splatwolke." Fast immer stimmt das nicht.
//
// Geprüft wird deshalb der Fall, der vorher falsch ausging: **Splat vor
// Gelände.** Und die Gegenprobe, die eine naive Umkehrung („immer der Splat")
// nicht bestünde: Splat hinter dem Gelände.
//
// Was hier NICHT geprüft wird: ob `scene.pickPosition` die richtige Tiefe
// liefert und ob `SplatPick` den Strahlmarsch richtig rechnet. Beides braucht
// einen Renderer und hat eigene Prüfsteine.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}

// ── Cesium-Ersatz ─────────────────────────────────────────────────────────
//
// Die Szene ist eine Gerade: die Kamera steht im Ursprung und sieht nach +x.
// Ein „Treffer bei 10" liegt also zehn Meter vor der Kamera. Damit ist jede
// Erwartung hier von Hand nachprüfbar, und der Abstandsvergleich, um den es
// geht, wird nicht von einer Geometrie verdeckt, die selbst erst stimmen muss.

class C3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
  static clone(v, z) { z = z || new C3(); z.x = v.x; z.y = v.y; z.z = v.z; return z; }
  static subtract(a, b, z) { z.x = a.x - b.x; z.y = a.y - b.y; z.z = a.z - b.z; return z; }
  static magnitude(v) { return Math.hypot(v.x, v.y, v.z); }
  static normalize(v, z) { const m = C3.magnitude(v); z.x = v.x / m; z.y = v.y / m; z.z = v.z / m; return z; }
  static cross(a, b, z) {
    z.x = a.y * b.z - a.z * b.y; z.y = a.z * b.x - a.x * b.z; z.z = a.x * b.y - a.y * b.x; return z;
  }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static multiplyByScalar(v, s, z) { z.x = v.x * s; z.y = v.y * s; z.z = v.z * s; return z; }
  static add(a, b, z) { z.x = a.x + b.x; z.y = a.y + b.y; z.z = a.z + b.z; return z; }
  static negate(v, z) { z.x = -v.x; z.y = -v.y; z.z = -v.z; return z; }
  static equalsEpsilon(a, b, rel, abs) {
    const e = abs !== undefined ? abs : (rel || 0);
    return Math.abs(a.x - b.x) <= e && Math.abs(a.y - b.y) <= e && Math.abs(a.z - b.z) <= e;
  }
  static ZERO = new C3(0, 0, 0);
}
class C2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }

// Einheitsabbildung: örtliches System und Weltsystem fallen zusammen, genau
// wie in tests/aufmass/test-rechnen.js. Sonst prüfte man hier die
// Koordinatenumrechnung mit, um die es gar nicht geht.
class M4 {}
M4.inverse = (m) => m;
M4.multiplyByPoint = (m, p, z) => { z.x = p.x; z.y = p.y; z.z = p.z; return z; };
M4.multiplyByPointAsVector = M4.multiplyByPoint;

class TileFeature {}
class Tileset {}

globalThis.Cesium = {
  Cartesian3: C3, Cartesian2: C2, Matrix4: M4,
  Cesium3DTileFeature: TileFeature, Cesium3DTileset: Tileset,
  Transforms: { eastNorthUpToFixedFrame: () => ({}) },
  defined: (v) => v !== undefined && v !== null,
};

globalThis.window = globalThis;
globalThis.console = console;

// ── Szene ─────────────────────────────────────────────────────────────────

const Szene = {
  tiefe: null,        // Abstand des Tiefenpuffertreffers, oder null
  getroffen: null,    // was scene.pick liefert
  pickPositionSupported: true,
  camera: { positionWC: new C3(0, 0, 0) },
  pickPosition(c2) {
    if (this.tiefe === null) return undefined;
    // Eine ebene Fläche quer zur Blickrichtung: alle Proben in derselben
    // Tiefe. Damit gibt es genau eine Ebene und der Fang landet auf 'flaeche'
    // — die Fallunterscheidung Ecke/Kante hat ihren eigenen Prüfstein.
    return new C3(this.tiefe, (c2.x - 100) * 0.01, (c2.y - 100) * 0.01);
  },
  pick() { return this.getroffen; },
  cartesianToCanvasCoordinates(p) { return new C2(100 + p.y * 100, 100 + p.z * 100); },
};

const Splat = {
  abstand: null,
  available() { return this.abstand !== null; },
  pickScreen() {
    if (this.abstand === null) return null;
    return { position: new C3(this.abstand, 0, 0), coverage: 0.8 };
  },
};

globalThis.BimViewer = { viewer: { scene: Szene } };
globalThis.SplatPick = Splat;

vm.runInThisContext(fs.readFileSync(path.join(WURZEL, 'aufmass-fang.js'), 'utf8'),
                    { filename: 'aufmass-fang.js' });

const F = globalThis.AufmassFang;
const ZEIGER = new C2(100, 100);

function szene({ tiefe = null, splat = null, getroffen = null }) {
  Szene.tiefe = tiefe;
  Szene.getroffen = getroffen;
  Splat.abstand = splat;
}

// ══ 1 · Der Fehler von damals ════════════════════════════════════════════

F.zielSetzen('auto');

{
  // Die Lage, in der die alte Fassung falsch lag: eine Splatwolke bei 10 m,
  // dahinter das Gelände bei 40 m. Der Tiefenpuffer trifft — also wurde der
  // Splat nie gefragt.
  szene({ tiefe: 40, splat: 10, getroffen: null });
  const t = F.fang(ZEIGER, {});
  pruefe('Splat vor Gelände: der Splat gewinnt',
    t && t.traeger === 'splat',
    t ? `traeger=${t.traeger}, x=${t.position.x}` : 'kein Treffer');
  pruefe('und der Punkt liegt wirklich auf der Wolke', t && t.position.x === 10);
}

{
  // Die Gegenprobe. Eine Umkehrung „immer der Splat" bestünde die erste
  // Prüfung und diese nicht — und wäre genauso falsch, nur andersherum.
  szene({ tiefe: 10, splat: 40, getroffen: null });
  const t = F.fang(ZEIGER, {});
  pruefe('Splat hinter dem Gelände: das Gelände gewinnt',
    t && t.traeger === 'gelaende' && t.position.x === 10,
    t ? `traeger=${t.traeger}, x=${t.position.x}` : 'kein Treffer');
}

{
  szene({ tiefe: null, splat: 10, getroffen: null });
  const t = F.fang(ZEIGER, {});
  pruefe('Splat vor freiem Himmel: weiterhin der Splat', t && t.traeger === 'splat');
}

{
  szene({ tiefe: null, splat: null, getroffen: null });
  pruefe('nichts unter dem Zeiger bleibt nichts', F.fang(ZEIGER, {}) === null);
}

// ══ 2 · Der Träger steht am Treffer ═════════════════════════════════════

{
  szene({ tiefe: 10, splat: null, getroffen: new TileFeature() });
  const t = F.fang(ZEIGER, {});
  pruefe('ein Bauteil wird als Modell ausgewiesen', t && t.traeger === 'modell');
}

{
  szene({ tiefe: 10, splat: null, getroffen: null });
  const t = F.fang(ZEIGER, {});
  pruefe('der Globus wird als Gelände ausgewiesen', t && t.traeger === 'gelaende');
}

{
  szene({ tiefe: 10, splat: null, getroffen: { primitive: new Tileset() } });
  const t = F.fang(ZEIGER, {});
  pruefe('auch ein Tileset ohne Feature zählt als Modell', t && t.traeger === 'modell',
    'Punktwolken liefern kein Cesium3DTileFeature');
}

// ══ 3 · Die Trägerwahl schränkt wirklich ein ════════════════════════════

{
  // „nur Modell" über dem Gelände: es darf NICHTS herauskommen. Vorher gab
  // es diese Wahl nicht, und ein Pixel neben dem Bauteil maß man den Boden.
  szene({ tiefe: 10, splat: null, getroffen: null });
  F.zielSetzen('modell');
  pruefe('„nur Modell" misst das Gelände nicht', F.fang(ZEIGER, {}) === null);

  szene({ tiefe: 10, splat: null, getroffen: new TileFeature() });
  pruefe('„nur Modell" misst das Bauteil', (F.fang(ZEIGER, {}) || {}).traeger === 'modell');
}

{
  szene({ tiefe: 10, splat: null, getroffen: new TileFeature() });
  F.zielSetzen('gelaende');
  pruefe('„nur Gelände" misst das Bauteil nicht', F.fang(ZEIGER, {}) === null);

  szene({ tiefe: 10, splat: null, getroffen: null });
  pruefe('„nur Gelände" misst den Globus', (F.fang(ZEIGER, {}) || {}).traeger === 'gelaende');
}

{
  // „nur Splat" nimmt den Splat auch dann, wenn die Fassade davor steht —
  // das ist der Zweck der Einschränkung und nicht ihr Fehler.
  szene({ tiefe: 5, splat: 40, getroffen: new TileFeature() });
  F.zielSetzen('splat');
  const t = F.fang(ZEIGER, {});
  pruefe('„nur Splat" nimmt den Splat auch hinter der Fassade',
    t && t.traeger === 'splat' && t.position.x === 40);

  szene({ tiefe: 5, splat: null, getroffen: new TileFeature() });
  pruefe('„nur Splat" ohne Wolke misst nichts', F.fang(ZEIGER, {}) === null);
}

{
  F.zielSetzen('quatsch');
  pruefe('ein unbekanntes Ziel fällt auf „alles" zurück', F.ziel === 'auto',
    'ein stillschweigend gemerkter Unsinn sperrte den Modus dauerhaft');
  pruefe('die Zielliste ist vollständig',
    F.ziele().join(',') === 'auto,modell,splat,gelaende');
}

// ══ 4 · Die Fangregel „Messpunkt" schlägt weiter alles ══════════════════

{
  F.zielSetzen('auto');
  szene({ tiefe: 10, splat: null, getroffen: null });
  // Ein gesetzter Punkt, der am Schirm auf dem Zeiger liegt.
  const gesetzt = new C3(30, 0, 0);
  const t = F.fang(ZEIGER, { punkte: [gesetzt] });
  pruefe('ein gesetzter Messpunkt gewinnt gegen die Fläche',
    t && t.art === 'messpunkt',
    'sonst lässt sich ein Polygon nicht schließen');
  pruefe('er trägt keinen Träger', t && t.traeger === null,
    'er ist eine Aussage über die Messung, keine über die Szene');
}

// ══ 5 · Der Abstandsvergleich selbst ════════════════════════════════════

{
  const k = new C3(0, 0, 0);
  const nah = { position: new C3(5, 0, 0) };
  const fern = { position: new C3(50, 0, 0) };
  const I = F._intern;
  pruefe('das Nähere gewinnt', I.naeheres(nah, fern, k) === nah);
  pruefe('auch andersherum', I.naeheres(fern, nah, k) === nah);
  pruefe('ein Nichts verliert immer', I.naeheres(nah, null, k) === nah);
  pruefe('und andersherum ebenso', I.naeheres(null, fern, k) === fern);
  pruefe('zwei Nichtse geben nichts', I.naeheres(null, null, k) === null);
  pruefe('bei Gleichstand gewinnt der Tiefenpuffer',
    I.naeheres(nah, { position: new C3(5, 0, 0) }, k) === nah,
    'er ist die gemessene Größe, der Splat die gerechnete');
}

// ══ Ergebnis ════════════════════════════════════════════════════════════

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(fehler ? 1 : 0);
