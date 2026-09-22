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
  static subtract(a, b, z) { z.x = a.x - b.x; z.y = a.y - b.y; z.z = a.z - b.z; return z; }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static magnitude(v) { return Math.hypot(v.x, v.y, v.z); }
  static normalize(v, z) {
    const m = C3.magnitude(v); z.x = v.x / m; z.y = v.y / m; z.z = v.z / m; return z;
  }
}

class C4 {
  constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; }
  clone(z) { z = z || new C4(); z.x = this.x; z.y = this.y; z.z = this.z; z.w = this.w; return z; }
}

/**
 * Eine Sichtmatrix, so weit sie hier gebraucht wird: Drehung Eins,
 * Verschiebung „minus Kameralage". Genau das ist der Punkt der Prüfung —
 * `multiplyByPoint` muss aus einer Erdkoordinate eine kleine Zahl machen.
 */
class M4 {
  constructor(kamera) { this.kamera = kamera; }
  static multiplyByPoint(m, p, z) { return C3.subtract(p, m.kamera, z); }
  static multiplyByPointAsVector(m, v, z) { return C3.clone(v, z); }
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

// ══ 8 · Der feine Weg: Millimeterbänder im Augensystem ══════════════════
//
// Der Höhenmodus über die Stilsprache löst rund einen halben Meter auf
// (`${POSITION_ABSOLUTE}` ist eine Erdkoordinate in float32). Für eine
// Ebenheitsmessung ist das nutzlos. Sobald Cesium `CustomShader` und der
// Shader-Verbund da sind, rechnet pointcloud.js deshalb im AUGENSYSTEM.
//
// Alles ab hier prüft diesen zweiten Weg — und dass der erste weiterhin
// einspringt, wenn er fehlt (das haben Abschnitt 2 und 3 oben getan, mit
// genau demselben Code, nur ohne Verbund).

// Der Verbund als Attrappe: er merkt sich, was angemeldet und welches
// Uniform gesetzt wurde. Beides ist das Ergebnis, das geprüft wird.
const verbund = {
  bausteine: new Map(),
  setzenRufe: 0,
  setzen(t, name, b) {
    this.setzenRufe++;
    const m = this.bausteine.get(t) || {};
    m[name] = b;
    this.bausteine.set(t, m);
    return b;
  },
  entfernen(t, name) { const m = this.bausteine.get(t); if (m) delete m[name]; },
  hat(t, name) { const m = this.bausteine.get(t); return !!(m && m[name]); },
  baustein(t, name) { const m = this.bausteine.get(t); return m && m[name]; },
  uniform(t, feld, wert) {
    const m = this.bausteine.get(t);
    if (!m) return false;
    Object.keys(m).forEach((k) => {
      const u = m[k].uniforms;
      if (u && u[feld]) u[feld].value = wert;
    });
    return true;
  },
};

// Die Kamera steht 20 m über der Wolkenmitte. Die Sichtmatrix macht daraus
// eine Zahl, die float32 trägt — darum geht es.
const kamera = new C3(0, 0, R + 120);
const preRenderHaken = [];
BV.viewer.scene.camera = { viewMatrix: new M4(kamera) };
BV.viewer.scene.preRender = {
  addEventListener(f) { preRenderHaken.push(f); },
  removeEventListener(f) {
    const i = preRenderHaken.indexOf(f);
    if (i >= 0) preRenderHaken.splice(i, 1);
  },
};

Object.assign(globalThis.Cesium, {
  Cartesian4: C4,
  Matrix4: M4,
  CustomShader: class { constructor(o) { Object.assign(this, o); } },
  CustomShaderMode: { MODIFY_MATERIAL: 'MODIFY_MATERIAL' },
  UniformType: { VEC3: 'vec3', VEC4: 'vec4', FLOAT: 'float' },
  LightingModel: { UNLIT: 'UNLIT', PBR: 'PBR' },
});
BV.ShaderVerbund = verbund;

{
  const ts = alsAsset(wolke(100, 15), 'fein');
  BV.loadedAssets.delete('w1');
  BV.setColorMode('height');

  const b = verbund.baustein(ts, I.HOEHE_BLOCK);
  pruefe('der Höhenmodus meldet einen Shader-Baustein an', !!b,
    'ohne ihn bliebe es beim halben Meter der Stilsprache');
  pruefe('er liest die Lage im Augensystem',
    !!b && b.fragment.includes('fsInput.attributes.positionEC'),
    'positionWC wäre wieder eine Erdkoordinate in float32');
  pruefe('er rechnet NICHT mit ${POSITION_ABSOLUTE}',
    !!b && !b.fragment.includes('POSITION_ABSOLUTE'));
  pruefe('er färbt ohne Beleuchtungsmodell',
    !!b && b.lightingModel === 'UNLIT',
    'eine Messgröße darf nicht vom Blickwinkel abhängen');
  pruefe('der Stil trägt keine Farbe mehr',
    !ts.style.definition.color,
    'sonst rechnete das Grobe daneben mit und gewänne nichts');
}

{
  // Der eigentliche Anlass: ein Band unter einem Zentimeter.
  const ts = BV.loadedAssets.get('fein').tileset;
  BV.setHeightWindow(99.9975, 100.0025);
  const u = verbund.baustein(ts, I.HOEHE_BLOCK).uniforms.u_pcHoeheFenster.value;
  pruefe('ein 5-mm-Band kommt als 5-mm-Band im Shader an',
    nahe(u.y - u.x, 0.005, 1e-9),
    `Spanne=${(u.y - u.x)} m`);
  pruefe('das Fenster steht relativ zum Bezugspunkt, nicht über dem Ellipsoid',
    Math.abs(u.x) < 1 && Math.abs(u.y) < 1,
    'Zahlen um 100 verlören in float32 genau die Millimeter, um die es geht');

  // Ein halber Millimeter — unterhalb dessen, was ein Scan auflöst, aber
  // die Darstellung darf ihn nicht verschlucken.
  BV.setHeightWindow(99.99975, 100.00025);
  const u2 = verbund.baustein(ts, I.HOEHE_BLOCK).uniforms.u_pcHoeheFenster.value;
  pruefe('auch ein halber Millimeter überlebt den Weg', nahe(u2.y - u2.x, 0.0005, 1e-10));
}

{
  // Ein Reglerzug darf keinen neuen Shader bauen: Cesium übersetzt bei jedem
  // `customShader` und bei jedem `style` den Shader jedes Kachelinhalts neu.
  const ts = BV.loadedAssets.get('fein').tileset;
  const vorher = verbund.setzenRufe;
  const stilVorher = ts.style;
  for (let i = 0; i < 20; i++) BV.setHeightCenter(100 + i * 0.001);
  pruefe('zwanzig Reglerzüge bauen keinen neuen Shader',
    verbund.setzenRufe === vorher,
    `${verbund.setzenRufe - vorher} Neubauten — der Dickenregler würde ruckeln`);
  pruefe('und auch keinen neuen Stil', ts.style === stilVorher,
    'ein neuer Cesium3DTileStyle stößt dieselbe Übersetzung an');
}

{
  // Bezugspunkt und Lot werden je Bild ins Augensystem gedreht. Das ist der
  // ganze Trick: aus 6 400 km wird der Abstand zur Kamera.
  const ts = BV.loadedAssets.get('fein').tileset;
  preRenderHaken.forEach((f) => f());
  const u = verbund.baustein(ts, I.HOEHE_BLOCK).uniforms;
  const ref = u.u_pcHoeheRef.value;
  pruefe('der Bezugspunkt liegt im Augensystem und ist klein',
    C3.magnitude(ref) < 1000,
    `|ref| = ${C3.magnitude(ref).toFixed(1)} m — als Erdkoordinate wären es 6 400 000`);
  pruefe('er zeigt den echten Abstand zur Kamera', nahe(Math.abs(ref.z), 20, 1e-6));
  pruefe('das Lot ist ein Einheitsvektor', nahe(C3.magnitude(u.u_pcHoeheLot.value), 1, 1e-9));
}

{
  const ts = BV.loadedAssets.get('fein').tileset;
  BV.setColorMode('rgb');
  pruefe('ein anderer Farbmodus meldet den Baustein wieder ab',
    !verbund.hat(ts, I.HOEHE_BLOCK),
    'sonst färbte der Shader weiter, während der Stil längst Originalfarbe sagt');
  BV.setColorMode('height');
}

// ══ 9 · Das Band führen: Dicke, Mitte, Schritt ══════════════════════════

{
  BV.setHeightWindow(100, 100.1);

  BV.setHeightThickness(0.005);
  let w = BV.pointCloudSettings.heightWindow;
  pruefe('die Dicke ändert sich, die Mitte bleibt',
    nahe(w.max - w.min, 0.005, 1e-12) && nahe((w.min + w.max) / 2, 100.05, 1e-9));

  BV.setHeightCenter(102);
  w = BV.pointCloudSettings.heightWindow;
  pruefe('die Mitte ändert sich, die Dicke bleibt',
    nahe(w.max - w.min, 0.005, 1e-12) && nahe((w.min + w.max) / 2, 102, 1e-9));

  BV.stepHeightWindow(1);
  w = BV.pointCloudSettings.heightWindow;
  pruefe('ein Schritt versetzt um genau eine Banddicke — lückenlos, ohne Überlappung',
    nahe((w.min + w.max) / 2, 102.005, 1e-9) && nahe(w.max - w.min, 0.005, 1e-12));

  BV.stepHeightWindow(-3);
  w = BV.pointCloudSettings.heightWindow;
  pruefe('und zurück', nahe((w.min + w.max) / 2, 101.99, 1e-9));

  BV.setHeightThickness(0);
  w = BV.pointCloudSettings.heightWindow;
  pruefe('eine Dicke von Null wird auf den unteren Anschlag gelegt',
    nahe(w.max - w.min, I.FENSTER_MIN, 1e-12),
    'ein Band der Dicke Null ließe den Shader durch Null teilen');
}

{
  pruefe('„außerhalb" kennt drei Zustände',
    I.AUSSEN.klemmen === 0 && I.AUSSEN.aus === 1 && I.AUSSEN.grau === 2);
  BV.setHeightOutside('aus');
  pruefe('„ausblenden" kommt am Tileset an',
    BV.loadedAssets.get('fein').tileset._ileenHoehenBezug &&
    verbund.baustein(BV.loadedAssets.get('fein').tileset, I.HOEHE_BLOCK)
      .uniforms.u_pcHoeheFenster.value.z === 1);
  BV.setHeightOutside('quatsch');
  pruefe('ein unbekannter Zustand fällt auf „klemmen" zurück',
    BV.pointCloudSettings.heightOutside === 'klemmen');
}

{
  // Der Dickenregler läuft logarithmisch, sonst läge der Messbereich auf dem
  // ersten Promille des Weges.
  const hin = I.reglerAusDicke(0.005);
  pruefe('Reglerstellung und Dicke sind umkehrbar',
    nahe(I.dickeAusRegler(hin), 0.005, 1e-4),
    `5 mm → ${hin} → ${I.dickeAusRegler(hin)}`);
  pruefe('der Regler erreicht den Millimeterbereich in seiner unteren Hälfte',
    I.reglerAusDicke(0.005) < 500,
    'linear verteilt läge er auf dem ersten Promille');
  pruefe('ein Millimeter wird als Millimeter geschrieben',
    I.hoeheText(0.005) === '5.00 mm', I.hoeheText(0.005));
  pruefe('ein Meter bleibt ein Meter', I.hoeheText(2.5) === '2.500 m', I.hoeheText(2.5));
}

// ══ Ergebnis ═════════════════════════════════════════════════════════════

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(fehler ? 1 : 0);
