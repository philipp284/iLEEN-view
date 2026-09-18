// Die Bildprojektion und der Shader-Verbund ohne Browser.
//
// Aufruf:  node tests/bildprojektion/test-bildprojektion.js
//
// Was hier NICHT geprüft werden kann, ist das Bild selbst: ob die Grafikkarte
// den erzeugten GLSL-Text übersetzt und ob die Textur richtig herum darin
// landet, zeigt erst der Blick auf ein projiziertes Bild. Prüfbar — und
// geprüft — ist alles, was DAVOR entscheidet, ob die Rechnung stimmt. Genau
// dort sitzen die Fehler, die nachher als „das Bild klebt schief", „das Bild
// leuchtet durch die Wand" oder „die Explosion tut nichts mehr" ankommen:
//
//   1. Der Verbund. Zwei Werkzeuge an einem `customShader` müssen NEBEN-
//      einander stehen, nicht nacheinander — und wer sich abmeldet, darf die
//      übrigen nicht mitnehmen. Das ist der Fehler, an dem der Stauchregler
//      einmal 98 % zeigte und das Gebäude unverändert dastand.
//   2. Getrennte Blöcke. Zwei Bausteine dürfen dieselbe lokale Variable
//      benennen, ohne voneinander zu wissen.
//   3. Uniform-Werte über einen Neubau hinweg. Wird ein Baustein angemeldet,
//      während die Explosion läuft, ist der Shader ein anderer — die je Bild
//      nachgeführten Werte müssen mitkommen, sonst zuckt das Bauwerk.
//   4. Die Bildkoordinate. Die Ecken der Bildebene MÜSSEN auf die Ecken der
//      Textur fallen, auch bei ungleicher Breite und Höhe. Sind rechts und
//      oben vertauscht oder fehlt die Division durch die Maße, steht jedes
//      Bild gekippt oder gedehnt.
//   5. Das Tiefenband. Eine Fläche außerhalb DARF das Bild nicht bekommen —
//      sonst steht das Fassadenfoto auf der Rückwand des Zimmers dahinter.
//   6. Der Neigungsfilter. Er MUSS über den BETRAG gehen: aus IFC kommen
//      Wandflächen in beiden Wicklungen, und eine falsch herum modellierte
//      Wand ist keine andere Wand.
//   7. Die Perspektive. Bei eingetragener Aufnahmeentfernung MUSS ein Punkt
//      auf dem Sehstrahl dieselbe Bildkoordinate bekommen wie sein Fußpunkt
//      in der Ebene — sonst ist es keine Projektion, sondern eine Verschiebung.
//   8. Die Augen-Koordinaten. Die ganze Rechnung läuft dort, weil ECEF für
//      einen `float` zu groß ist. Also muss sie unter einer gedrehten und
//      verschobenen Sichtmatrix DIESELBEN Bildkoordinaten liefern wie ohne.
//   9. Die Höchstzahl. Mehr Bilder als Textureinheiten müssen abgewiesen
//      werden, statt dass der Shader stillschweigend nicht mehr übersetzt.

const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ── Cesium-Ersatz ─────────────────────────────────────────────────────────
//
// Matrizen sind echt und spaltenweise geführt wie bei Cesium (Index =
// Spalte * 4 + Zeile): geprüft wird ja gerade die Umrechnung in
// Augen-Koordinaten, und sie falsch zu stubben hieße, den Fehler in den
// Prüfstein zu verlegen statt ihn zu finden.

class C3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static clone(a, r) { if (!r) return new C3(a.x, a.y, a.z); r.x = a.x; r.y = a.y; r.z = a.z; return r; }
  static add(a, b, r) { const x = a.x + b.x, y = a.y + b.y, z = a.z + b.z; r.x = x; r.y = y; r.z = z; return r; }
  static subtract(a, b, r) { const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z; r.x = x; r.y = y; r.z = z; return r; }
  static multiplyByScalar(a, s, r) { const x = a.x * s, y = a.y * s, z = a.z * s; r.x = x; r.y = y; r.z = z; return r; }
  static dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  static magnitude(a) { return Math.hypot(a.x, a.y, a.z); }
  static cross(a, b, r) {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    r.x = x; r.y = y; r.z = z; return r;
  }
  static normalize(a, r) {
    const l = Math.hypot(a.x, a.y, a.z) || 1;
    const x = a.x / l, y = a.y / l, z = a.z / l;
    r.x = x; r.y = y; r.z = z; return r;
  }
}
C3.ZERO = new C3(0, 0, 0);

class C4 { constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; } }

function M4() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
Object.assign(M4, {
  IDENTITY: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
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
  }
});

/** Ein `CustomShader`, der seine Bauteile herausgibt — mehr braucht es nicht. */
class CustomShaderStub {
  constructor(o) {
    Object.assign(this, o);
    this.uniforms = o.uniforms || {};
    this.gesetzt = [];
  }
  setUniform(feld, wert) {
    if (!this.uniforms[feld]) throw new Error('unbekanntes Uniform: ' + feld);
    this.uniforms[feld].value = wert;
    this.gesetzt.push(feld);
  }
}

const warnungen = [];
const Cesium = {
  Cartesian3: C3,
  Cartesian4: C4,
  Matrix4: M4,
  Math: { toRadians: (g) => g * Math.PI / 180 },
  CustomShader: CustomShaderStub,
  CustomShaderMode: { MODIFY_MATERIAL: 'modify' },
  LightingModel: { PBR: 'pbr', UNLIT: 'unlit' },
  UniformType: {
    FLOAT: 'float', VEC2: 'vec2', VEC3: 'vec3', VEC4: 'vec4',
    MAT4: 'mat4', SAMPLER_2D: 'sampler2D'
  },
  VaryingType: { VEC3: 'vec3' },
  TextureUniform: class { constructor(o) { Object.assign(this, o); } }
};

// ── Umgebung ──────────────────────────────────────────────────────────────

const szene = {
  camera: { viewMatrix: M4() },
  preRender: {
    _hoerer: [],
    addEventListener(f) {
      this._hoerer.push(f);
      const self = this;
      return () => { self._hoerer = self._hoerer.filter((g) => g !== f); };
    }
  },
  requestRender: () => {},
  primitives: { add: () => {}, remove: () => {} }
};

const BimViewer = {
  viewer: { scene: szene },
  loadedAssets: new Map()
};

const kontext = {
  window: { BimViewer },
  BimViewer,
  Cesium,
  document: { querySelector: () => null, querySelectorAll: () => [] },
  console: {
    log: () => {},
    warn: (...a) => { warnungen.push(a.join(' ')); },
    error: () => {}
  },
  setInterval: () => 0,
  clearInterval: () => {}
};
kontext.window.window = kontext.window;
kontext.globalThis = kontext;
vm.createContext(kontext);

const wurzel = path.join(__dirname, '..', '..');
for (const datei of ['shader-verbund.js', 'bildprojektion.js']) {
  vm.runInContext(fs.readFileSync(path.join(wurzel, datei), 'utf8'), kontext, { filename: datei });
}

const Verbund = BimViewer.ShaderVerbund;
const BP = BimViewer.Bildprojektion;

// ── Prüfgerüst ────────────────────────────────────────────────────────────

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};
const nah = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ══ 1. Der Shader-Verbund ═════════════════════════════════════════════════

console.log('\n1. Der Shader-Verbund');
{
  const traeger = { name: 'Prüfmodell', customShader: undefined };

  const rueck = { ordnung: 0, fragment: 'if (czm_backFacing()) { discard; }' };
  const farbe = {
    ordnung: 40,
    uniforms: { u_t: { type: Cesium.UniformType.FLOAT, value: 1 } },
    fragment: 'float h = 2.0; material.diffuse *= u_t * h;'
  };
  const hoch = {
    ordnung: 10,
    uniforms: { u_h: { type: Cesium.UniformType.VEC3, value: new C3() } },
    vertex: 'float h = 1.0; vsOutput.positionMC += u_h * h;'
  };

  Verbund.setzen(traeger, 'rueckseite', rueck);
  pruefe('ein Baustein setzt einen Shader', !!traeger.customShader);
  pruefe('ohne Vertex-Rumpf entsteht kein vertexShaderText',
    traeger.customShader.vertexShaderText === undefined);

  Verbund.setzen(traeger, 'farbe', farbe);
  Verbund.setzen(traeger, 'explosion', hoch);

  const s = traeger.customShader;
  pruefe('alle drei Bausteine stehen im selben Shader',
    s.fragmentShaderText.includes('czm_backFacing') &&
    s.fragmentShaderText.includes('u_t') &&
    s.vertexShaderText.includes('u_h'));

  pruefe('die Uniforms aller Bausteine sind beisammen',
    !!s.uniforms.u_t && !!s.uniforms.u_h);

  // Die Reihenfolge ist keine Geschmacksfrage: was nach einem `discard`
  // stünde, wäre Arbeit für ein Fragment, das es nicht mehr gibt.
  pruefe('der Verwurf steht vor dem Färbenden (ordnung)',
    s.fragmentShaderText.indexOf('czm_backFacing') < s.fragmentShaderText.indexOf('u_t'));

  // Beide Rümpfe deklarieren ein `float h` — nebeneinander wäre das ein
  // Übersetzungsfehler, den man erst im Browser sähe.
  const bloecke = (s.fragmentShaderText.match(/\{/g) || []).length;
  pruefe('jeder Rumpf steht in eigenen Klammern', bloecke >= 3,
    `nur ${bloecke} öffnende Klammern`);

  pruefe('jeder Block trägt den Namen seines Bausteins als Kommentar',
    s.fragmentShaderText.includes('── farbe') && s.vertexShaderText.includes('── explosion'));

  // ── Uniform-Werte über einen Neubau hinweg ──────────────────────────────
  Verbund.uniform(traeger, 'u_t', 0.5);
  pruefe('uniform() schreibt in den laufenden Shader',
    traeger.customShader.uniforms.u_t.value === 0.5);

  Verbund.setzen(traeger, 'nochwas', { ordnung: 50, fragment: 'material.alpha = 1.0;' });
  pruefe('nach einem Neubau steht der zuletzt gesetzte Wert noch',
    traeger.customShader.uniforms.u_t.value === 0.5,
    'Wert = ' + traeger.customShader.uniforms.u_t.value);
  pruefe('der Neubau ist wirklich ein neuer Shader', traeger.customShader !== s);

  // ── Abmelden ────────────────────────────────────────────────────────────
  Verbund.entfernen(traeger, 'farbe');
  pruefe('ein abgemeldeter Baustein ist fort',
    !traeger.customShader.fragmentShaderText.includes('u_t'));
  pruefe('die übrigen bleiben stehen',
    traeger.customShader.fragmentShaderText.includes('czm_backFacing') &&
    traeger.customShader.vertexShaderText.includes('u_h'));
  pruefe('sein Uniform ist mit ihm fort', !traeger.customShader.uniforms.u_t);

  pruefe('hat() sagt, wer noch steht',
    Verbund.hat(traeger, 'rueckseite') && !Verbund.hat(traeger, 'farbe'));

  Verbund.entfernen(traeger, 'rueckseite');
  Verbund.entfernen(traeger, 'explosion');
  Verbund.entfernen(traeger, 'nochwas');
  pruefe('ist der letzte fort, ist der Steckplatz leer',
    traeger.customShader === undefined);

  // ── Kollision ───────────────────────────────────────────────────────────
  warnungen.length = 0;
  const t2 = { name: 'zwei', customShader: undefined };
  Verbund.setzen(t2, 'a', { ordnung: 1, uniforms: { u_x: { type: 'float', value: 1 } }, fragment: ';' });
  Verbund.setzen(t2, 'b', { ordnung: 2, uniforms: { u_x: { type: 'float', value: 2 } }, fragment: ';' });
  pruefe('ein doppelt vergebenes Uniform wird gemeldet',
    warnungen.some((w) => w.includes('u_x') && w.includes('doppelt')));
}

// ══ 2. Die Bildkoordinate ═════════════════════════════════════════════════
//
// Nachbildung von `bpLegen()` aus dem Fragment-Shader, Zeile für Zeile. Sie
// ist die eine Stelle, an der dieser Prüfstein den GLSL-Text NICHT lesen
// kann — dafür prüft Abschnitt 4, dass der Shader dieselben Uniforms in
// derselben Ordnung aufruft.

function bpLegen(p, nrm, mitte, rechts, oben, norm, auge, par) {
  if (Math.abs(C3.dot(nrm, norm)) < par.z) return null;

  let q = p;
  if (par.w > 0.5) {
    const s = C3.subtract(p, auge, new C3());
    const nenner = C3.dot(s, norm);
    if (Math.abs(nenner) < 1e-6) return null;
    const t = C3.dot(C3.subtract(mitte, auge, new C3()), norm) / nenner;
    if (t <= 0) return null;
    q = C3.add(auge, C3.multiplyByScalar(s, t, new C3()), new C3());
  }

  const d = C3.subtract(q, mitte, new C3());
  const uv = { x: C3.dot(d, rechts) + 0.5, y: C3.dot(d, oben) + 0.5 };
  if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null;

  const tief = Math.abs(C3.dot(C3.subtract(p, mitte, new C3()), norm));
  if (tief > par.y) return null;

  return uv;
}

/**
 * Eine Sichtmatrix, die dreht UND verschiebt.
 *
 * Der Sinn des ganzen Umwegs über Augen-Koordinaten ist, dass die Rechnung
 * unter JEDER Kameralage dasselbe liefert — eine Einheitsmatrix hier würde
 * genau das nicht prüfen.
 */
function sichtmatrix(winkelGrad, verschiebung) {
  const a = winkelGrad * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // Drehung um die Z-Achse, spaltenweise, plus Translation in Spalte 3.
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0,
          verschiebung.x, verschiebung.y, verschiebung.z, 1];
}

/** Die Bildebene, die der Prüfstein durchweg benutzt: 4 m × 2 m, hochkant im Raum. */
const LAGE = {
  mitte: new C3(100, 200, 300),
  rechts: new C3(1, 0, 0),
  oben: new C3(0, 0, 1),
  n: new C3(0, -1, 0)
};

function ebeneAnlegen(zusatz) {
  return Object.assign({
    id: 'e1',
    titel: 'Fassade Nord',
    quelle: { schluessel: 's1', index: 0 },
    breite_m: 4,
    hoehe_m: 2,
    deckkraft: 1,
    sichtbar: true,
    projektion: true,
    proj_tiefe: 0.25,
    proj_winkel: 60,
    proj_abstand: 0
  }, zusatz || {});
}

// Der Bildebenen-Stub: `weltlage()` ist alles, was die Projektion von ihm
// braucht. Die Messung der Ebene hat ihren eigenen Prüfstein.
const ebenen = [];
BimViewer.Bildebenen = {
  ebenen: ebenen,
  _cache: { 's1:0': 'data:image/png;base64,AAAA' },
  finden: (id) => ebenen.find((e) => e.id === id) || null,
  weltlage: () => ({
    mitte: C3.clone(LAGE.mitte), rechts: C3.clone(LAGE.rechts),
    oben: C3.clone(LAGE.oben), n: C3.clone(LAGE.n)
  }),
  sichern: () => {},
  _nachziehen: () => {},
  _nachladen: () => {},
  _listeZeichnen: () => {}
};

/** Ein Punkt in Weltkoordinaten → derselbe in Augen-Koordinaten. */
function nachEC(p) { return M4.multiplyByPoint(szene.camera.viewMatrix, p, new C3()); }

/** Ein Punkt auf der Bildebene, in Metern von der Mitte aus. */
function aufEbene(rechtsM, obenM, tiefeM) {
  const p = C3.clone(LAGE.mitte);
  C3.add(p, C3.multiplyByScalar(LAGE.rechts, rechtsM, new C3()), p);
  C3.add(p, C3.multiplyByScalar(LAGE.oben, obenM, new C3()), p);
  if (tiefeM) C3.add(p, C3.multiplyByScalar(LAGE.n, tiefeM, new C3()), p);
  return p;
}

/** Die Uniforms des ersten Projektors, nachdem die Wache einmal gelaufen ist. */
function projektor() { return BP._projektoren[0]; }

function uvVon(weltpunkt, normaleWelt) {
  const pr = projektor();
  const nrmEC = M4.multiplyByPointAsVector(
    szene.camera.viewMatrix, normaleWelt || LAGE.n, new C3());
  return bpLegen(nachEC(weltpunkt), C3.normalize(nrmEC, nrmEC),
                 pr.uMitte, pr.uRechts, pr.uOben, pr.uNorm, pr.uAuge, pr.uPar);
}

console.log('\n2. Die Bildkoordinate');
{
  szene.camera.viewMatrix = sichtmatrix(37, new C3(-90, 140, -260));
  ebenen.length = 0;
  ebenen.push(ebeneAnlegen());
  BimViewer.loadedAssets.set('a', { tileset: { root: {}, customShader: undefined } });
  BP.nachziehen();

  pruefe('ein Projektor ist aufgebaut', BP._projektoren.length === 1);

  const mitte = uvVon(aufEbene(0, 0));
  pruefe('die Bildmitte liegt bei (0.5, 0.5)',
    mitte && nah(mitte.x, 0.5, 1e-9) && nah(mitte.y, 0.5, 1e-9),
    mitte ? `(${mitte.x}, ${mitte.y})` : 'nichts getroffen');

  // 4 m breit, 2 m hoch: die Ecke liegt bei +2 m rechts und +1 m oben.
  const eckeOR = uvVon(aufEbene(2, 1));
  pruefe('die Ecke oben rechts liegt bei (1, 1)',
    eckeOR && nah(eckeOR.x, 1, 1e-9) && nah(eckeOR.y, 1, 1e-9),
    eckeOR ? `(${eckeOR.x}, ${eckeOR.y})` : 'nichts getroffen');

  // Einen Millimeter INNERHALB der Ecke, nicht auf ihr: genau auf der Kante
  // entscheidet die letzte Stelle der Gleitkommarechnung, ob uv noch als 0
  // durchgeht (hier schon gesehen: −0,5 + 0,5 fiel um 1e-17 ins Negative und
  // das Fragment wurde verworfen). Im Shader rechnet ein `float` mit sieben
  // Stellen und es ist erst recht Zufall. Sichtbar ist das nie — der weiche
  // Rand blendet die äußersten zwei Prozent des Bildes ohnehin aus.
  const eckeUL = uvVon(aufEbene(-1.999, -0.999));
  pruefe('die Ecke unten links liegt bei (0, 0)',
    eckeUL && nah(eckeUL.x, 0.00025, 1e-9) && nah(eckeUL.y, 0.0005, 1e-9),
    eckeUL ? `(${eckeUL.x}, ${eckeUL.y})` : 'nichts getroffen');

  pruefe('jenseits der linken Kante bekommt nichts Farbe',
    uvVon(aufEbene(-2.001, 0)) === null);

  // Der Punkt, an dem ein vertauschtes rechts/oben oder eine fehlende
  // Division durch die Maße auffliegt: 1 m rechts sind bei 4 m Breite ein
  // Viertel, 1 m oben sind bei 2 m Höhe die Hälfte.
  const schief = uvVon(aufEbene(1, 1));
  pruefe('ungleiche Breite und Höhe werden getrennt skaliert',
    schief && nah(schief.x, 0.75, 1e-9) && nah(schief.y, 1.0, 1e-9),
    schief ? `(${schief.x}, ${schief.y})` : 'nichts getroffen');

  pruefe('außerhalb der Bildbreite bekommt nichts Farbe',
    uvVon(aufEbene(2.5, 0)) === null);

  // ── Dieselbe Frage unter einer anderen Kameralage ───────────────────────
  szene.camera.viewMatrix = sichtmatrix(-113, new C3(4000, -18, 77));
  BP._uniformsNachfuehren();
  const nochmal = uvVon(aufEbene(1, 1));
  pruefe('eine andere Kameralage ändert die Bildkoordinate nicht',
    nochmal && nah(nochmal.x, 0.75, 1e-9) && nah(nochmal.y, 1.0, 1e-9),
    nochmal ? `(${nochmal.x}, ${nochmal.y})` : 'nichts getroffen');
}

// ══ 3. Die Begrenzungen ═══════════════════════════════════════════════════

console.log('\n3. Tiefenband und Neigung');
{
  szene.camera.viewMatrix = sichtmatrix(12, new C3(7, -3, 900));
  BP._uniformsNachfuehren();

  pruefe('innerhalb des Tiefenbands wird projiziert',
    uvVon(aufEbene(0, 0, 0.2)) !== null);
  pruefe('ein Meter vor der Ebene bei 0,25 m Band bekommt nichts',
    uvVon(aufEbene(0, 0, 1.0)) === null);
  pruefe('und dasselbe hinter der Ebene',
    uvVon(aufEbene(0, 0, -1.0)) === null);

  // Der Regler greift ohne Shader-Neubau.
  ebenen[0].proj_tiefe = 5;
  BP._uniformsNachfuehren();
  pruefe('ein größeres Tiefenband greift sofort',
    uvVon(aufEbene(0, 0, 1.0)) !== null);
  ebenen[0].proj_tiefe = 0.25;
  BP._uniformsNachfuehren();

  // Eine Laibung steht rechtwinklig zur Fassade und soll das Bild nicht
  // bekommen.
  pruefe('eine Fläche quer zur Bildebene bekommt nichts',
    uvVon(aufEbene(0, 0), LAGE.rechts) === null);

  // Aus IFC kommen Wandflächen in beiden Wicklungen — eine umgedrehte
  // Normale ist keine andere Wand.
  const umgedreht = C3.multiplyByScalar(LAGE.n, -1, new C3());
  pruefe('eine falsch herum modellierte Fläche bekommt das Bild trotzdem',
    uvVon(aufEbene(0, 0), umgedreht) !== null);

  // 60° Grenze: 50° geneigt muss durch, 80° nicht.
  const geneigt = (grad) => {
    const a = grad * Math.PI / 180;
    return C3.normalize(C3.add(
      C3.multiplyByScalar(LAGE.n, Math.cos(a), new C3()),
      C3.multiplyByScalar(LAGE.rechts, Math.sin(a), new C3()), new C3()), new C3());
  };
  pruefe('50° Neigung liegt noch in der Grenze von 60°',
    uvVon(aufEbene(0, 0), geneigt(50)) !== null);
  pruefe('80° Neigung liegt außerhalb',
    uvVon(aufEbene(0, 0), geneigt(80)) === null);
}

console.log('\n4. Die Perspektive');
{
  szene.camera.viewMatrix = sichtmatrix(200, new C3(-12, 44, 6));

  // Ohne Aufnahmeentfernung ist die Projektion parallel: ein Punkt, der 1 m
  // vor der Ebene und 1 m rechts der Mitte liegt, fällt senkrecht herab.
  ebenen[0].proj_abstand = 0;
  ebenen[0].proj_tiefe = 5;
  BP._uniformsNachfuehren();
  const parallel = uvVon(aufEbene(1, 0, 1));
  pruefe('parallel: der Punkt fällt senkrecht auf die Ebene',
    parallel && nah(parallel.x, 0.75, 1e-9) && nah(parallel.y, 0.5, 1e-9),
    parallel ? `(${parallel.x}, ${parallel.y})` : 'nichts getroffen');
  pruefe('parallel: der Augpunkt wird nicht benutzt', projektor().uPar.w === 0);

  // Mit Aufnahmeentfernung 4 m: ein Punkt auf der Verbindungslinie vom
  // Projektor zur Bildecke MUSS auf ebendieser Ecke landen, gleich wie weit
  // vorn er liegt.
  ebenen[0].proj_abstand = 4;
  BP._uniformsNachfuehren();
  pruefe('perspektivisch: der Augpunkt ist eingeschaltet', projektor().uPar.w === 1);

  const auge = aufEbene(0, 0, 4);
  const ecke = aufEbene(2, 1);
  // Halbwegs zwischen Auge und Ecke — also 2 m vor der Ebene.
  const halb = C3.multiplyByScalar(C3.add(auge, ecke, new C3()), 0.5, new C3());
  const persp = uvVon(halb);
  pruefe('perspektivisch: ein Punkt auf dem Sehstrahl landet auf der Ecke',
    persp && nah(persp.x, 1, 1e-9) && nah(persp.y, 1, 1e-9),
    persp ? `(${persp.x}, ${persp.y})` : 'nichts getroffen');

  // Und derselbe Punkt parallel gerechnet liegt woanders — sonst prüfte das
  // Vorige nichts.
  ebenen[0].proj_abstand = 0;
  BP._uniformsNachfuehren();
  const gegenprobe = uvVon(halb);
  pruefe('parallel gerechnet liegt derselbe Punkt woanders',
    gegenprobe && !nah(gegenprobe.x, 1, 1e-6),
    gegenprobe ? `(${gegenprobe.x}, ${gegenprobe.y})` : 'nichts getroffen');

  ebenen[0].proj_tiefe = 0.25;
}

// ══ 5. Der Baustein ═══════════════════════════════════════════════════════

console.log('\n5. Der Baustein am Modell');
{
  const ts = BimViewer.loadedAssets.get('a').tileset;
  BP.nachziehen();

  pruefe('der Baustein steht auf dem geladenen Modell',
    Verbund.hat(ts, 'bildprojektion'));

  const s = ts.customShader;
  pruefe('er bringt seine sieben Uniforms je Bild mit',
    ['bild', 'mitte', 'rechts', 'oben', 'norm', 'auge', 'par']
      .every((k) => !!s.uniforms['u_bp_' + k + '0']));
  pruefe('die Textur hängt als Sampler daran',
    s.uniforms.u_bp_bild0.type === Cesium.UniformType.SAMPLER_2D);
  pruefe('das Bild wird geklemmt, nicht gekachelt',
    s.uniforms.u_bp_bild0.value.repeat === false);
  pruefe('der Fragment-Rumpf ruft den Projektor auf',
    s.fragmentShaderText.includes('bpLegen(bpP, bpN, u_bp_bild0'));
  pruefe('die Position kommt aus positionMC, nicht aus positionEC',
    s.vertexShaderText.includes('czm_modelView') &&
    s.vertexShaderText.includes('positionMC') &&
    !s.fragmentShaderText.includes('attributes.positionEC'));

  // Der Rückseitenschnitt und die Projektion müssen nebeneinander stehen —
  // das ist der Fall, für den der Verbund gebaut wurde.
  Verbund.setzen(ts, 'rueckseite', { ordnung: 0, fragment: 'if (czm_backFacing()) { discard; }' });
  pruefe('Rückseitenschnitt und Projektion stehen nebeneinander',
    Verbund.hat(ts, 'rueckseite') && Verbund.hat(ts, 'bildprojektion') &&
    ts.customShader.fragmentShaderText.includes('czm_backFacing') &&
    ts.customShader.fragmentShaderText.includes('bpLegen'));

  // ── Die Höchstzahl ──────────────────────────────────────────────────────
  warnungen.length = 0;
  for (let i = 1; i <= 5; i++) {
    ebenen.push(ebeneAnlegen({ id: 'e' + (i + 1), titel: 'Bild ' + i }));
  }
  BP.nachziehen();
  pruefe(`mehr als ${BP.MAX} Bilder werden abgewiesen`, BP._projektoren.length === BP.MAX,
    BP._projektoren.length + ' Projektoren');
  pruefe('und die abgewiesenen werden benannt',
    warnungen.some((w) => w.includes('mehr als') && w.includes('Bild 5')));

  // ── Ausschalten ─────────────────────────────────────────────────────────
  ebenen.forEach((e) => { e.projektion = false; });
  BP.nachziehen();
  pruefe('ohne Projektion ist der Baustein fort', !Verbund.hat(ts, 'bildprojektion'));
  pruefe('der Rückseitenschnitt bleibt', Verbund.hat(ts, 'rueckseite'));
  pruefe('und die Wache ist gestoppt', BP._wache === null);
}

console.log(`\n${fehler === 0 ? '✓ alles in Ordnung' : '✗ ' + fehler + ' Prüfung(en) fehlgeschlagen'}\n`);
process.exit(fehler === 0 ? 0 : 1);
