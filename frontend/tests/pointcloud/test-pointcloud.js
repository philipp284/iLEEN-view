// Prüft die Punktwolken-Darstellung (`pointcloud.js`) ohne Browser.
//
// Aufruf:  node tests/pointcloud/test-pointcloud.js
//
// Warum das einen eigenen Prüfstein verdient
// ==========================================
// Zwei der drei hier geprüften Dinge sind Fehler, die man einem Bild nicht
// ansieht:
//
//   · Der Farbmodus „Höhe" lief ins Leere. Er fragte `${Height}` ab, und diese
//     Eigenschaft schreibt py3dtiles nicht in seine PNTS — die Bedingungen
//     waren allesamt `typeof … !== 'undefined'`, also allesamt falsch, und
//     übrig blieb der `true`-Zweig: die ganze Wolke in EINER Farbe. Sie sah
//     eingefärbt aus. Sie war es nur nicht nach der Höhe.
//   · Die Detailstufe stand im Panel als „Geo. Error" und stellte
//     `pointCloudShading.geometricErrorScale` — eine Größe, die nur in die
//     Abschwächung eingeht. Der Regler, der aussah wie der Leistungshebel,
//     war keiner; der echte (`maximumScreenSpaceError`) stand hart im Lader.
//
// Beide Male war die Rückmeldung an den Nutzer plausibel und die Wirkung
// keine. Geprüft wird deshalb nicht „läuft durch", sondern was konkret im Stil
// und an den Tilesets ankommt.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}
const nahe = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ── Cesium-Ersatz ─────────────────────────────────────────────────────────
//
// Die Höhenrechnung läuft über echte Vektor- und Matrixoperationen; sie hier
// zu vereinfachen hieße, den Prüfstein auf die eigene Rechnung zu eichen.
// `Cartographic` bildet eine Kugel ab — für die Frage „liegt die Spanne
// richtig" reicht das, und die Abweichung zum Ellipsoid ist über ein Gebäude
// hinweg kleiner als jede Zahl, die hier geprüft wird.

const R = 6378137.0;

class C3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static clone(v, z) { z = z || new C3(); z.x = v.x; z.y = v.y; z.z = v.z; return z; }
  static add(a, b, z) { z.x = a.x + b.x; z.y = a.y + b.y; z.z = a.z + b.z; return z; }
  static multiplyByScalar(v, s, z) { z.x = v.x * s; z.y = v.y * s; z.z = v.z * s; return z; }
  static magnitude(v) { return Math.hypot(v.x, v.y, v.z); }
  static normalize(v, z) {
    const m = C3.magnitude(v); z.x = v.x / m; z.y = v.y / m; z.z = v.z / m; return z;
  }
}

class M3 {
  constructor(werte) { this.w = werte; }   // spaltenweise: [u, v, w]
  static getColumn(m, i, z) {
    const s = m.w[i]; z.x = s.x; z.y = s.y; z.z = s.z; return z;
  }
}

const Ellipsoid = {
  WGS84: {
    cartesianToCartographic(p) {
      const r = C3.magnitude(p);
      if (!(r > 0)) return undefined;
      return { height: r - R, longitude: Math.atan2(p.y, p.x), latitude: Math.asin(p.z / r) };
    },
    geodeticSurfaceNormal(p, z) { return C3.normalize(p, z || new C3()); },
  },
};

// Der Stil wird nicht ausgewertet, nur festgehalten: geprüft wird der
// Ausdruck, den pointcloud.js erzeugt, denn er ist das Ergebnis.
class Stil {
  constructor(def) { this.definition = def; }
}

globalThis.Cesium = {
  Cartesian3: C3, Matrix3: M3, Ellipsoid,
  Cesium3DTileStyle: Stil,
  PointCloudShading: { isSupported: () => true },
};

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// ── BimViewer-Ersatz ──────────────────────────────────────────────────────

const meldungen = [];
globalThis.BimViewer = {
  loadedAssets: new Map(),
  viewer: { scene: { postRender: { addEventListener() {} }, requestRender() {} } },
  updateStatus(text, art) { meldungen.push({ text, art }); },
};

// pointcloud.js ist ein klassisches Script; require() kann es nicht lesen.
vm.runInThisContext(fs.readFileSync(path.join(WURZEL, 'pointcloud.js'), 'utf8'),
                    { filename: 'pointcloud.js' });

const BV = globalThis.BimViewer;
const I = BV._pointCloudIntern;

/**
 * Eine Wolke mit orientierter Hüllbox. `mitte` ist die Höhe ihres
 * Mittelpunkts über der Kugel, `halb` die halbe Höhe — die Box steht
 * lotrecht über dem Nordpol, dort ist das Lot die z-Achse und die Rechnung
 * von Hand nachprüfbar.
 */
function wolke(mitteHoehe, halbHoehe, halbBreite = 20) {
  const c = new C3(0, 0, R + mitteHoehe);
  return {
    _isGaussianSplat: false,
    maximumScreenSpaceError: 16,
    dynamicScreenSpaceError: false,
    cacheBytes: 0,
    style: null,
    pointCloudShading: {},
    boundingSphere: { center: c, radius: Math.hypot(halbBreite, halbHoehe) },
    root: {
      boundingVolume: {
        boundingVolume: {
          center: c,
          halfAxes: new M3([new C3(halbBreite, 0, 0), new C3(0, halbBreite, 0), new C3(0, 0, halbHoehe)]),
        },
      },
    },
  };
}

function alsAsset(tileset, id = 'w1') {
  BV.loadedAssets.set(id, { id, name: id, tileset, visible: true, isPointCloud: true });
  return tileset;
}

// ══ 1 · Höhenspanne aus der Hüllbox ═══════════════════════════════════════

{
  const ts = wolke(100, 15);
  const b = I.hoehenBezug(ts);
  pruefe('die Spanne kommt aus der Box, nicht aus der Hüllkugel',
    nahe(b.hMin, 85, 0.5) && nahe(b.hMax, 115, 0.5),
    `hMin=${b.hMin.toFixed(2)} hMax=${b.hMax.toFixed(2)}`);
  pruefe('der Bezugspunkt liegt in der Boxmitte', nahe(b.hMitte, 100, 0.5));
  pruefe('das Lot zeigt nach außen', nahe(b.lot.z, 1, 1e-9));
}

{
  // Eine breite, flache Wolke: die Hüllkugel wäre 200 m hoch, die Box 4 m.
  // Genau dafür wird die Box gelesen — mit der Kugel läge die Farbrampe über
  // eine Spanne, die es nicht gibt, und die ganze Wolke wäre einfarbig.
  const flach = wolke(50, 2, 200);
  const b = I.hoehenBezug(flach);
  pruefe('eine flache, breite Wolke bekommt eine flache Spanne',
    (b.hMax - b.hMin) < 10, `Spanne=${(b.hMax - b.hMin).toFixed(1)} m`);
}

{
  const ohneBox = wolke(100, 15);
  ohneBox.root.boundingVolume = null;
  const b = I.hoehenBezug(ohneBox);
  pruefe('ohne Box trägt die Hüllkugel', b && isFinite(b.hMin) && b.hMax > b.hMin);
  pruefe('ohne Wurzel gibt es keine Spanne', I.hoehenBezug({ root: null }) === null);
}

// ══ 2 · Der Höhenausdruck ═════════════════════════════════════════════════

{
  const b = I.hoehenBezug(wolke(100, 15));
  const a = I.hoehenAusdruck(b);
  pruefe('der Ausdruck liest die Weltlage des Punktes', a.includes('${POSITION_ABSOLUTE}'));
  pruefe('der Bezugspunkt wird VOR dem Skalarprodukt abgezogen',
    /\$\{POSITION_ABSOLUTE\}\.x - \d/.test(a),
    'sonst bleibt in float32 von der Höhe nichts übrig — siehe Kopf von pointcloud.js');
  pruefe('keine Exponentialschreibweise im Ausdruck', !/e[+-]\d/i.test(a),
    'die Stilsprache liest sie nicht');
  pruefe('alle drei Achsen kommen vor',
    a.includes('.x') && a.includes('.y') && a.includes('.z'));
}

// ══ 3 · Der Farbmodus „Höhe" färbt wirklich nach der Höhe ════════════════

{
  const ts = alsAsset(wolke(100, 15));
  BV.setColorMode('height');
  const def = ts.style.definition;
  pruefe('der Höhenmodus setzt einen Stil', !!def && !!def.color);
  pruefe('er fragt NICHT mehr nach ${Height}', !/\$\{Height\}/.test(def.color),
    'py3dtiles schreibt diese Eigenschaft nicht — das war der ganze Fehler');
  pruefe('er rechnet mit der Weltlage', def.color.includes('${POSITION_ABSOLUTE}'));
  pruefe('er klemmt auf die Spanne', def.color.includes('clamp('));
  pruefe('er ist ein Verlauf und keine Stufenleiter', def.color.includes('hsl('));
  pruefe('die Spanne wird am Tileset vermerkt',
    !!ts._ileenHoehenBezug && nahe(ts._ileenHoehenBezug.autoMin, 85, 0.5));
}

{
  // Das Höhenfenster überschreibt die automatische Spanne — der Fall, für den
  // es da ist: eine Wolke vom Keller bis zum Nachbardach, und die
  // interessanten fünf Meter sollen den ganzen Farbraum bekommen.
  const ts = alsAsset(wolke(100, 15));
  BV.setHeightWindow(95, 100);
  pruefe('das Fenster wird übernommen',
    ts._ileenHoehenBezug.min === 95 && ts._ileenHoehenBezug.max === 100);
  pruefe('die automatische Spanne bleibt daneben stehen',
    nahe(ts._ileenHoehenBezug.autoMax, 115, 0.5),
    'sonst weiß niemand mehr, was das Fenster ausblendet');
  BV.setHeightWindow();
  pruefe('ohne Argumente zurück auf die Wolkenspanne',
    nahe(ts._ileenHoehenBezug.min, 85, 0.5));
  BV.setHeightWindow(50, 10);
  pruefe('ein verdrehtes Fenster wird verworfen statt angewandt',
    BV.pointCloudSettings.heightWindow === null);
  BV.setColorMode('rgb');
}

// ══ 4 · Die Detailstufe ist der Hebel, den sie zu sein vorgibt ═══════════

{
  const ts = alsAsset(wolke(100, 15));
  BV.setPointCloudDetail(32);
  pruefe('die Detailstufe landet auf dem Tileset',
    ts.maximumScreenSpaceError === 32,
    'genau das tat der frühere „Geo. Error"-Regler NICHT');
  pruefe('sie steht auch in den Einstellungen',
    BV.pointCloudSettings.maximumScreenSpaceError === 32);

  BV.setGeometricErrorScale(2.5);
  pruefe('der Abschwächungsfaktor rührt die Detailstufe nicht an',
    ts.maximumScreenSpaceError === 32 && ts.pointCloudShading.geometricErrorScale === 2.5);

  BV.setPointCloudDetail(0.001);
  pruefe('zu fein wird auf den unteren Anschlag gelegt',
    BV.pointCloudSettings.maximumScreenSpaceError >= 1);
  BV.setPointCloudDetail(9999);
  pruefe('zu grob wird gedeckelt', BV.pointCloudSettings.maximumScreenSpaceError <= 64);
  BV.setPointCloudDetail(16);
}

{
  const ts = alsAsset(wolke(100, 15));
  BV.setPointCloudDynamicError(true);
  pruefe('die Fernvergröberung landet am Tileset', ts.dynamicScreenSpaceError === true);
  BV.setPointCloudDynamicError(false);
  pruefe('und lässt sich wieder abschalten', ts.dynamicScreenSpaceError === false);
  BV.setPointCloudDynamicError(true);
}

// ══ 5 · Die Ladeoptionen sagen dasselbe wie das Panel ════════════════════

{
  const o = BV.pointCloudLoadOptions();
  pruefe('der Lader nimmt die eingestellte Detailstufe',
    o.maximumScreenSpaceError === BV.pointCloudSettings.maximumScreenSpaceError,
    'sonst springt das Bild beim ersten Reglerzug');
  pruefe('der Lader bringt einen Kachelspeicher mit', o.cacheBytes > 0);
  pruefe('und einen Überlauf dazu', o.maximumCacheOverflowBytes > 0);
  pruefe('die Fernvergröberung reist mit', o.dynamicScreenSpaceError === true);
}

// ══ 6 · Die Vorgabe ist die, die Bilder liefert ══════════════════════════

{
  const V = I.VORGABE;
  pruefe('die Vorgabe ist nicht mehr die feinste Stufe',
    V.maximumScreenSpaceError >= 16,
    'mit 8 lud die Sparkasse jede Kachel bis zur untersten Ebene — zwei Bilder je Sekunde');
  pruefe('die Abschwächung ist an',
    V.attenuationEnabled === true,
    'sie ist die Gegenleistung für die gröbere Stufe: größere Punkte schließen die Wolke wieder');
  pruefe('die Abschwächung folgt automatisch der Detailstufe',
    V.maximumAttenuation === null,
    'ein fester Wert entkoppelt Punktgröße und Ladestufe');
  pruefe('die Fernvergröberung ist an', V.dynamicError === true);
}

// ══ 7 · Splats bleiben außen vor ════════════════════════════════════════

{
  const splat = wolke(100, 15);
  splat._isGaussianSplat = true;
  splat.maximumScreenSpaceError = 16;
  BV.applyPointCloudSettings(splat);
  pruefe('ein Splat-Tileset wird nicht angefasst',
    splat.style === null && splat.maximumScreenSpaceError === 16,
    'Punktwolken-Einstellungen erzeugen dort Artefakte');
  pruefe('und gilt auch nicht als Punktwolke', BV.isPointCloudTileset(splat) === false);
}

// ══ Ergebnis ═════════════════════════════════════════════════════════════

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(fehler ? 1 : 0);
