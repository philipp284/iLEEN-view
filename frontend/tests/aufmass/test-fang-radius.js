// Prüft die Reichweite des Fangs — `aufmass-fang.js`, ohne Browser, mit echtem
// Cesium für die Matrizen.
//
// Aufruf:  node tests/aufmass/test-fang-radius.js
//
// Worum es geht
// =============
// Der Fang fing früher nur ±6 px um den Zeiger. Wer eine Ecke treffen wollte,
// musste sie auf wenige Pixel genau treffen. Jetzt fängt er im Umkreis von
// `Fang.radius` (36 px, am Schirm rund ein Zentimeter): eine Kante oder Ecke
// im Umkreis zieht den Punkt an sich.
//
// Die Szene ist eine Box mit bekannten Maßen, gesehen von einer Lochkamera:
// jede Erwartung hier ist von Hand nachprüfbar. Der Tiefenpuffer ist ein
// Strahlschnitt mit der Box — ohne Rauschen, dann mit 3 mm Rauschen entlang
// des Strahls, weil ein echter Tiefenpuffer rauscht.
//
// Was hier NICHT geprüft wird: ob `scene.pickPosition` an einer echten
// Kachel die richtige Tiefe liefert. Das braucht einen Renderer.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');
const Cesium = require(path.join(WURZEL, 'node_modules', 'cesium'));

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}

const { Cartesian3: C3, Cartesian2: C2, Matrix4: M4 } = Cesium;

// ── Das örtliche System ────────────────────────────────────────────────────
// Ost-Nord-Hoch an einem Punkt in Mainz. Alles in der Szene ist in Metern in
// diesem System gegeben und wird nur an den Rändern nach ECEF gewandelt.

const URSPRUNG = C3.fromDegrees(8.26, 49.99, 120);
const NACH_WELT = Cesium.Transforms.eastNorthUpToFixedFrame(URSPRUNG);
const NACH_ORT = M4.inverse(NACH_WELT, new M4());
const enu = (x, y, z) => M4.multiplyByPoint(NACH_WELT, new C3(x, y, z), new C3());
const ort = (p) => M4.multiplyByPoint(NACH_ORT, p, new C3());
const ortVektor = (v) => M4.multiplyByPointAsVector(NACH_ORT, v, new C3());

// ── Die Kamera ─────────────────────────────────────────────────────────────

const B = 1200, H = 800;
const FOVY = Cesium.Math.toRadians(60);
const BRENNWEITE = (H / 2) / Math.tan(FOVY / 2);

function kamera(pos, ziel) {
  const f = C3.normalize(C3.subtract(ziel, pos, new C3()), new C3());
  const r = C3.normalize(C3.cross(f, new C3(0, 0, 1), new C3()), new C3());
  const u = C3.cross(r, f, new C3());
  return { pos, f, r, u };
}

const K = kamera(new C3(8, -10, 10), new C3(2, 1.5, 1.5));

function strahl(c2) {
  const x = (c2.x - B / 2) / BRENNWEITE, y = -(c2.y - H / 2) / BRENNWEITE;
  const d = new C3(
    K.r.x * x + K.u.x * y + K.f.x,
    K.r.y * x + K.u.y * y + K.f.y,
    K.r.z * x + K.u.z * y + K.f.z);
  return C3.normalize(d, d);
}

function bildpunkt(p) {                       // Ort → Bild; undefined hinter der Kamera
  const v = C3.subtract(ort(p), K.pos, new C3());
  const z = C3.dot(v, K.f);
  if (z <= 0) return undefined;
  return new C2(B / 2 + BRENNWEITE * C3.dot(v, K.r) / z, H / 2 - BRENNWEITE * C3.dot(v, K.u) / z);
}

// ── Die Welt: Quader ───────────────────────────────────────────────────────

let KISTEN = [];

function schnitt(o, d, k) {                    // Strahl gegen Quader (Schnittebenen-Verfahren)
  let t0 = 0, t1 = Infinity;
  for (const a of ['x', 'y', 'z']) {
    if (Math.abs(d[a]) < 1e-12) { if (o[a] < k.min[a] || o[a] > k.max[a]) return null; continue; }
    let a0 = (k.min[a] - o[a]) / d[a], a1 = (k.max[a] - o[a]) / d[a];
    if (a0 > a1) [a0, a1] = [a1, a0];
    t0 = Math.max(t0, a0); t1 = Math.min(t1, a1);
    if (t0 > t1) return null;
  }
  return t0 > 0 ? t0 : null;
}

function treffer(c2) {
  if (c2.x < 0 || c2.y < 0 || c2.x >= B || c2.y >= H) return null;
  const d = strahl(c2);
  let best = null;
  for (const k of KISTEN) {
    const t = schnitt(K.pos, d, k);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best === null ? null : { t: best, d };
}

// Ein Rauschen entlang des Strahls — fest gewürfelt, damit der Prüfstein
// jedes Mal dasselbe sagt.
let samen = 12345;
function zufall() {
  samen = (samen + 0x6D2B79F5) | 0;
  let t = Math.imul(samen ^ (samen >>> 15), 1 | samen);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = () => (zufall() + zufall() + zufall() + zufall() - 2) * 1.7;

const Szene = {
  rauschen: 0,
  proben: 0,
  pickPositionSupported: true,
  canvas: { clientWidth: B, clientHeight: H },
  camera: {
    positionWC: enu(K.pos.x, K.pos.y, K.pos.z),
    getPickRay(c2) {
      const d = strahl(c2);
      return { origin: this.positionWC, direction: M4.multiplyByPointAsVector(NACH_WELT, d, new C3()) };
    },
  },
  pickPosition(c2) {
    this.proben++;
    const h = treffer(c2);
    if (!h) return undefined;
    const t = h.t + (this.rauschen ? gauss() * this.rauschen : 0);
    return enu(K.pos.x + h.d.x * t, K.pos.y + h.d.y * t, K.pos.z + h.d.z * t);
  },
  pick(c2) {
    return treffer(c2) ? Object.create(Cesium.Cesium3DTileFeature.prototype) : undefined;
  },
  cartesianToCanvasCoordinates: bildpunkt,
};

globalThis.Cesium = Cesium;
globalThis.window = globalThis;
globalThis.BimViewer = { viewer: { scene: Szene } };

vm.runInThisContext(fs.readFileSync(path.join(WURZEL, 'aufmass-fang.js'), 'utf8'),
                    { filename: 'aufmass-fang.js' });

const F = globalThis.AufmassFang;

// ── Hilfen ─────────────────────────────────────────────────────────────────

/** Abstand eines Orts von der Geraden durch a und b (beide im Ortssystem). */
function abstandGerade(p, a, b) {
  const u = C3.normalize(C3.subtract(b, a, new C3()), new C3());
  const w = C3.subtract(p, a, new C3());
  const l = C3.dot(w, u);
  return C3.magnitude(C3.subtract(w, C3.multiplyByScalar(u, l, new C3()), new C3()));
}

function fange(px, py) {
  Szene.proben = 0;
  const t = F.fang(new C2(px, py), {});
  return { t, proben: Szene.proben };
}

/** Zeigerpunkt: Projektion des Ortes plus Versatz in Bildpunkten. */
function zeiger(x, y, z, dx, dy) {
  const b = bildpunkt(enu(x, y, z));
  return [b.x + dx, b.y + dy];
}

// Das Haus: 4 × 3 × 3 m, Südwand bei y = 0, Ostwand bei x = 4, Dach bei z = 3.
// Aus (8, −10, 10) sieht man Süd-, Ost- und Dachfläche; die Westwand dreht sich
// weg, ihre Kante gegen den Himmel ist eine Silhouette.
KISTEN = [{ min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 3 } }];

const O = (p) => ort(p);
const KANTE_OST = [new C3(4, 0, 0), new C3(4, 0, 3)];       // Südost-Kante, senkrecht
const KANTE_WEST = [new C3(0, 0, 0), new C3(0, 0, 3)];      // Südwest-Kante, Silhouette
const ECKE_OBEN = new C3(4, 0, 3);                           // Südost, oben

// ══ 1 · Eine Kante zieht den Punkt an ════════════════════════════════════

F.radiusSetzen(36);
F.ecken = F.kanten = true;

{
  const [px, py] = zeiger(4, 0, 1.5, -20, 0);      // 20 px links der Südostkante, auf der Südwand
  const { t } = fange(px, py);
  pruefe('20 px neben einer Kante: es wird gefangen', t && t.art === 'kante',
    t ? `art=${t.art}` : 'kein Treffer');
  if (t && t.art === 'kante') {
    const d = abstandGerade(O(t.position), KANTE_OST[0], KANTE_OST[1]);
    pruefe('… und der Punkt liegt auf der Kante (< 2 cm)', d < 0.02, `Abstand ${(d * 100).toFixed(2)} cm`);
    // Nicht nur AUF der Kante, sondern an der richtigen Stelle auf ihr: dort,
    // wo sie am Schirm dem Zeiger am nächsten liegt. Ein Vorzeichenfehler im
    // Lotverfahren spiegelte den Punkt um den Aufpunkt der Geraden und blieb
    // lange unbemerkt, weil er immer noch auf der Kante lag.
    const a = bildpunkt(enu(4, 0, 0)), b = bildpunkt(enu(4, 0, 3));
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const tt = ((px - a.x) * dx + (py - a.y) * dy) / l2;
    const fussX = a.x + tt * dx, fussY = a.y + tt * dy;
    const bs = bildpunkt(t.position);
    const fehl = Math.hypot(bs.x - fussX, bs.y - fussY);
    pruefe('… und an der Stelle, die dem Zeiger am Schirm am nächsten liegt (< 1 px)', fehl < 1,
      `${fehl.toFixed(2)} px daneben`);
    pruefe('… trägt den Träger „Modell"', t.traeger === 'modell');
    pruefe('… trägt die Richtung der Kante (senkrecht)',
      t.richtung && Math.abs(ortVektor(t.richtung).z) > 0.99,
      t.richtung ? `z=${ortVektor(t.richtung).z.toFixed(3)}` : 'keine Richtung');
    pruefe('… sagt, wie weit sie vom Zeiger lag (ca. 20 px)',
      t.abstandPx > 10 && t.abstandPx < 30, `${t.abstandPx}`);
    pruefe('… nennt einen Bildpunkt auf der Geometrie, nicht auf dem Zeiger',
      t.pickPixel && Szene.pick(t.pickPixel) !== undefined);
  }
}

// ══ 2 · Eine Ecke zieht den Punkt an — und schlägt die Kanten daneben ════

{
  const [px, py] = zeiger(4, 0, 3, -14, 14);       // 14 px links und 14 px unter der Ecke
  const { t } = fange(px, py);
  pruefe('diagonal neben einer Ecke: es wird die Ecke gefangen', t && t.art === 'ecke',
    t ? `art=${t.art}` : 'kein Treffer');
  if (t && t.art === 'ecke') {
    const d = C3.distance(O(t.position), ECKE_OBEN);
    pruefe('… und sie liegt auf der Ecke (< 2 cm)', d < 0.02, `Abstand ${(d * 100).toFixed(2)} cm`);
  }
}

{
  // Die Gegenprobe: die Ecke liegt am Rand der Reichweite, die Kante direkt
  // unter dem Zeiger. Die Kante gewinnt — sonst klebte jeder Punkt in der Nähe
  // einer Ecke an der Ecke.
  const [px, py] = zeiger(4, 0, 2.1, -3, 0);       // 3 px neben der Kante, Ecke ca. 0,9 m darüber
  const e = bildpunkt(enu(4, 0, 3));
  const abstandEcke = Math.hypot(e.x - px, e.y - py);
  const { t } = fange(px, py);
  pruefe(`Kante unter dem Zeiger schlägt Ecke am Rand (${abstandEcke.toFixed(0)} px entfernt)`,
    t && t.art === 'kante', t ? `art=${t.art}` : 'kein Treffer');
}

// ══ 3 · Eine Fläche fängt nichts ═════════════════════════════════════════

{
  const [px, py] = zeiger(2, 0, 1.5, 0, 0);        // Mitte der Südwand
  const r = fange(px, py);
  pruefe('mitten auf einer Fläche: nichts wird gefangen', r.t && r.t.art === 'flaeche',
    r.t ? `art=${r.t.art}` : 'kein Treffer');
  if (r.t) {
    const o = O(r.t.position);
    pruefe('… der Punkt liegt auf der Wand (y = 0)', Math.abs(o.y) < 1e-6, `y=${o.y}`);
  }
  pruefe('… und kostet höchstens 25 + 81 Tiefenabfragen (ein Feld je Größe)', r.proben <= 106,
    `${r.proben} Abfragen`);
}

// ══ 4 · Eine Silhouette gegen den Himmel ═════════════════════════════════

{
  const [px, py] = zeiger(0, 0, 1.5, -18, 0);      // 18 px im Himmel neben der Südwestkante
  const { t } = fange(px, py);
  pruefe('18 px im freien neben einer Silhouette: es wird gefangen',
    t && t.art === 'silhouette', t ? `art=${t.art}` : 'kein Treffer');
  if (t && t.art === 'silhouette') {
    const d = abstandGerade(O(t.position), KANTE_WEST[0], KANTE_WEST[1]);
    pruefe('… der Punkt liegt auf der Kante (< 4 cm)', d < 0.04, `Abstand ${(d * 100).toFixed(2)} cm`);
    pruefe('… trägt den Träger „Modell"', t.traeger === 'modell', `traeger=${t.traeger}`);
    pruefe('… trägt die Richtung der Kante (senkrecht, auf 4° genau)',
      t.richtung && Math.abs(ortVektor(t.richtung).z) > Math.cos(4 * Math.PI / 180),
      t.richtung ? `z=${ortVektor(t.richtung).z.toFixed(3)}` : '');
  }
}

{
  const [px, py] = zeiger(0, 0, 1.5, -90, 0);      // weit im Himmel
  const { t } = fange(px, py);
  pruefe('weit im Himmel: nichts', t === null, t ? `art=${t.art}` : '');
}

// ══ 5 · Die Reichweite ist einstellbar ═══════════════════════════════════

{
  const [px, py] = zeiger(4, 0, 1.5, -25, 0);
  F.radiusSetzen(36);
  pruefe('25 px neben der Kante, Reichweite 36: gefangen', (fange(px, py).t || {}).art === 'kante');
  F.radiusSetzen(18);
  pruefe('… Reichweite 18 (der alte Fang): nicht gefangen', (fange(px, py).t || {}).art === 'flaeche');
  F.radiusSetzen(36);

  pruefe('die Reichweite ist nach unten auf 18 begrenzt', F.radiusSetzen(3) === 18);
  pruefe('… und nach oben auf 48', F.radiusSetzen(500) === 48);
  pruefe('… ein Unsinn fällt auf den Vorgabewert zurück', F.radiusSetzen('quatsch') === 36);
  F.radiusSetzen(36);
}

// ══ 6 · Jede Regel ist einzeln abschaltbar ═══════════════════════════════

{
  const [px, py] = zeiger(4, 0, 1.5, -20, 0);
  F.kanten = false;
  pruefe('Kanten aus: keine Kante', (fange(px, py).t || {}).art === 'flaeche');
  F.kanten = true;

  const [ex, ey] = zeiger(4, 0, 3, -14, 14);
  F.ecken = false;
  const t = fange(ex, ey).t;
  pruefe('Ecken aus: keine Ecke', t && t.art !== 'ecke', t ? `art=${t.art}` : '');
  F.ecken = true;

  F.ecken = F.kanten = false;
  pruefe('beides aus: nur noch die Fläche', (fange(px, py).t || {}).art === 'flaeche');
  F.ecken = F.kanten = true;
}

// ══ 7 · Ein gesetzter Messpunkt schlägt weiterhin alles ══════════════════

{
  const [px, py] = zeiger(4, 0, 1.5, -20, 0);
  const gesetzt = enu(2, 0, 1.5);
  const b = bildpunkt(gesetzt);
  const t = F.fang(new C2(b.x + 3, b.y), { punkte: [gesetzt] });
  pruefe('ein Messpunkt in 3 px Entfernung gewinnt', t && t.art === 'messpunkt');
  const fern = F.fang(new C2(px, py), { punkte: [gesetzt] });
  pruefe('ein Messpunkt außerhalb von 18 px fängt nicht (die Reichweite gilt nur für Geometrie)',
    fern && fern.art === 'kante', fern ? `art=${fern.art}` : '');
}

// ══ 8 · Ein rauschender Tiefenpuffer ═════════════════════════════════════

Szene.rauschen = 0.003;                                 // 3 mm entlang des Strahls

{
  let kante = 0, ecke = 0, flaeche = 0;
  const N = 25;
  for (let i = 0; i < N; i++) {
    const [kx, ky] = zeiger(4, 0, 1.0 + 0.04 * i, -(14 + (i % 5) * 3), 0);
    const k = fange(kx, ky).t;
    if (k && k.art === 'kante' && abstandGerade(O(k.position), KANTE_OST[0], KANTE_OST[1]) < 0.04) kante++;
    const [ex, ey] = zeiger(4, 0, 3, -14 + (i % 3), 14 - (i % 4));
    const e = fange(ex, ey).t;
    if (e && e.art === 'ecke' && C3.distance(O(e.position), ECKE_OBEN) < 0.04) ecke++;
    const [fx, fy] = zeiger(2, 0, 1.5, (i % 7) - 3, (i % 5) - 2);
    const f = fange(fx, fy).t;
    if (f && f.art === 'flaeche') flaeche++;
  }
  pruefe(`3 mm Rauschen: Kante in ${kante} von ${N} Läufen auf 4 cm genau`, kante >= N * 0.9);
  pruefe(`3 mm Rauschen: Ecke in ${ecke} von ${N} Läufen auf 4 cm genau`, ecke >= N * 0.9);
  pruefe(`3 mm Rauschen: mitten auf der Wand kein Phantom (${flaeche} von ${N})`, flaeche >= N * 0.95);
}

Szene.rauschen = 0;

// ══ 9 · Keine Kante aus Flächen, die sich nicht berühren ═════════════════
//
// Zwei Wände, von denen die eine mit Abstand vor der anderen steht. Ihre
// Ebenen schneiden sich in Gedanken — dort ist aber nichts, und ein Fang auf
// diese Gerade wäre ein Punkt in der Luft.

KISTEN = [
  { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 3 } },          // das Haus
  { min: { x: 2.2, y: -3.2, z: 0 }, max: { x: 2.4, y: -3.0, z: 3 } } // eine Stütze davor
];

{
  // Die Gerade, in der die Südwand (y = 0) die Ostfläche der Stütze (x = 2,4)
  // schneidet, liegt drei Meter hinter der Stütze. Zeiger genau auf ihrer
  // Projektion.
  const [px, py] = zeiger(2.4, 0, 1.5, 0, 0);
  const { t } = fange(px, py);
  if (t && t.art === 'kante') {
    const d = abstandGerade(O(t.position), new C3(2.4, 0, 0), new C3(2.4, 0, 3));
    pruefe('Phantomkante hinter der Stütze wird nicht gefangen', d > 0.5,
      `gefangen, ${(d * 100).toFixed(0)} cm von der Phantomgeraden`);
  } else {
    pruefe('Phantomkante hinter der Stütze wird nicht gefangen', true);
  }
}

KISTEN = [{ min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 3 } }];

// ══ 10 · Ein Boden: die Fuge zwischen Wand und Boden ═════════════════════
//
// Hier gibt es hinter dem Haus keinen Himmel mehr. Die Kante zwischen Wand und
// Boden ist eine echte Kante (zwei Flächen stoßen zusammen), die Oberkante der
// Wand gegen den Boden dahinter ist ein reiner Tiefensprung — und den fängt
// der Fang nicht (siehe Kopf von aufmass-fang.js).

KISTEN = [
  { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 3 } },
  { min: { x: -40, y: -40, z: -1 }, max: { x: 40, y: 40, z: 0 } },    // der Boden
];
const SOCKEL = [new C3(0, 0, 0), new C3(4, 0, 0)];

{
  const [px, py] = zeiger(2, 0, 0, 0, -20);          // 20 px über dem Sockel, auf der Wand
  const { t } = fange(px, py);
  pruefe('Sockelfuge von der Wand aus: gefangen', t && t.art === 'kante', t ? `art=${t.art}` : '');
  if (t && t.art === 'kante') {
    const d = abstandGerade(O(t.position), SOCKEL[0], SOCKEL[1]);
    pruefe('… liegt auf der Fuge (< 2 cm)', d < 0.02, `${(d * 100).toFixed(1)} cm`);
  }
}

{
  const [px, py] = zeiger(2, 0, 0, 0, 20);           // 20 px unter dem Sockel, auf dem Boden
  const { t } = fange(px, py);
  pruefe('Sockelfuge vom Boden aus: gefangen', t && t.art === 'kante', t ? `art=${t.art}` : '');
  if (t && t.art === 'kante') {
    const d = abstandGerade(O(t.position), SOCKEL[0], SOCKEL[1]);
    pruefe('… liegt auf der Fuge (< 2 cm)', d < 0.02, `${(d * 100).toFixed(1)} cm`);
  }
}

{
  let phantome = 0, gezaehlt = 0;
  for (let i = 0; i < 30; i++) {                     // frei auf dem Boden, weit weg vom Haus
    const px = 80 + (i % 6) * 40, py = 640 + Math.floor(i / 6) * 28;
    if (!Szene.pick(new C2(px, py))) continue;
    gezaehlt++;
    const { t } = fange(px, py);
    if (!t || t.art !== 'flaeche') phantome++;
  }
  pruefe(`freier Boden: kein einziges Phantom (${phantome} von ${gezaehlt})`, gezaehlt >= 20 && phantome === 0);
}

KISTEN = [{ min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 3 } }];

// ══ 11 · Ein Gang über die Wand: eine saubere Grenze, kein Flackern ═══════
//
// Der Zeiger wandert in 1-px-Schritten von der Wandmitte auf die Kante zu. Die
// Antwort muss einmal von „Fläche" auf „Kante" kippen, und zwar dort, wo die
// Reichweite endet — nicht davor, nicht dahinter, nicht hin und her.

// Eine hohe Wand, damit weder Ober- noch Unterkante ins Bild fallen: sonst
// kippt die Antwort an einer zweiten Kante, die es wirklich gibt.
KISTEN = [{ min: { x: 0, y: 0, z: -30 }, max: { x: 4, y: 3, z: 30 } }];

{
  F.radiusSetzen(36);
  let kippt = 0, vorher = null, ersteKante = null, letzteFlaeche = null;
  for (let ab = 60; ab >= 0; ab--) {
    const [px, py] = zeiger(4, 0, 1.5, -ab, 0);
    const a = (fange(px, py).t || {}).art;
    if (vorher && a !== vorher) kippt++;
    if (a === 'kante' && ersteKante === null) ersteKante = ab;
    if (a === 'flaeche') letzteFlaeche = ab;
    vorher = a;
  }
  pruefe('Gang auf die Kante zu: genau ein Wechsel, kein Flackern', kippt === 1, `${kippt} Wechsel`);
  pruefe(`… die Kante fängt ab ${ersteKante} px (Reichweite 36)`,
    ersteKante !== null && ersteKante >= 34 && ersteKante <= 37);
}

KISTEN = [{ min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 3 } }];

// ══ 12 · Stärkeres Rauschen ═══════════════════════════════════════════════
//
// 5 mm entlang des Strahls ist mehr, als ein Tiefenpuffer in 15 m Entfernung
// hergibt, und ungefähr, was ein gescanntes Netz an Unebenheit mitbringt.
// Der Fang darf dann ungenauer werden, aber nicht Phantome erfinden.
//
// (Bei 1 cm Rauschen und 3 px Probenabstand zerlegt das FEINE Feld auch eine
// glatte Wand in Ebenen — das tat der Fang vor der Reichweite genauso: 44 von
// 60 Zeigerstellen. Dort hilft der Schalter „Kanten", nicht die Rechnung.)

Szene.rauschen = 0.005;

{
  let phantome = 0, ok = 0;
  const N = 30;
  for (let i = 0; i < N; i++) {
    const [fx, fy] = zeiger(2, 0, 1.5, (i % 7) - 3, (i % 5) - 2);
    const f = fange(fx, fy).t;
    if (!f || f.art !== 'flaeche') phantome++;
    const [kx, ky] = zeiger(4, 0, 1.2 + 0.03 * i, -(14 + (i % 4) * 3), 0);
    const k = fange(kx, ky).t;
    if (k && k.art === 'kante' && abstandGerade(O(k.position), KANTE_OST[0], KANTE_OST[1]) < 0.06) ok++;
  }
  pruefe(`5 mm Rauschen: mitten auf der Wand kein Phantom (${phantome} von ${N})`, phantome === 0);
  pruefe(`5 mm Rauschen: Kante in ${ok} von ${N} Läufen auf 6 cm genau`, ok >= N * 0.85);
}

Szene.rauschen = 0;

// ══ Ergebnis ═════════════════════════════════════════════════════════════

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(fehler ? 1 : 0);
