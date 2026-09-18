// Die Explosionsansicht ohne Browser.
//
// Aufruf:  node tests/explosion/test-explosion.js
//
// Was hier NICHT geprüft werden kann, ist der Shader selbst — er läuft auf der
// GPU, und ob `czm_modelView` das liefert, was explosion.js von ihm erwartet,
// zeigt erst das Bild. Prüfbar ist alles davor, und dort sitzen die Fehler,
// die im Browser als „das Modell steht einfach still" ankommen:
//
//   1. Aus welchen Höhen die Trennebenen entstehen — Geschossverzeichnis des
//      Backends, Hilfsebenen ohne Bauteile, doppelt geführte Geschosse.
//   2. Dass die Fuge auf der richtigen Seite der Geschosshöhe liegt.
//   3. Dass der Rückseitenschnitt eines Tilesets die Explosion überlebt —
//      sowohl neben ihr als auch nach ihr. Bliebe er beim Ausschalten weg,
//      stünde jedes IFC-Modell fortan mit Z-Fighting da, und niemand brächte
//      das mit der Explosion in Verbindung, die er längst wieder ausgeschaltet
//      hat. Seit shader-verbund.js ist das keine Frage des Zurücklegens mehr,
//      sondern eine des Nebeneinanders: beide sind Bausteine an EINEM
//      `customShader`, und die Explosion meldet nur den ihren ab.
//   4. Dass Entities immer von ihrer Ausgangslage aus versetzt werden, nie um
//      den letzten Schritt weiter. Sonst summiert sich jeder Reglerzug auf.
//   5. Dass die Geschossreihenfolge aus der Höhe kommt und nicht aus dem
//      Namen: „1.OG" steht alphabetisch vor „EG", liegt aber darüber.

const path = require('path');

// ── Cesium-Ersatz ─────────────────────────────────────────────────────────
//
// Nur so viel, wie explosion.js anfasst. Die Tile-Matrix ist in den Prüfungen
// die Einheitsmatrix — dann ist „Tile-System" gleich „Weltsystem" und z ist
// unmittelbar die Höhe. Geprüft wird die Logik, nicht die Geodäsie.

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
C3.UNIT_Z = new C3(0, 0, 1);

const Einheit = { einheit: true };

const Cesium = {
  Cartesian3: C3,
  // Die Attrappe kennt nur die Einheitsmatrix — mehr braucht es nicht, um die
  // Rechenwege zu prüfen, und mehr wäre eine zweite Cesium-Implementierung.
  // `Matrix4` muss trotzdem aufrufbar sein: explosion.js legt sich Ergebnis-
  // matrizen mit `new Cesium.Matrix4()` an.
  // Die Attrappe führt von einer Matrix nur ihre Verschiebung (`t`) mit — das
  // genügt, um zu prüfen, wie hoch ein Geschossklon gehängt wird, und ist
  // keine zweite Cesium-Implementierung.
  Matrix4: Object.assign(function Matrix4() { return { t: new C3() }; }, {
    multiplyByPoint: (m, p, r) => C3.clone(p, r || new C3()),
    multiplyByPointAsVector: (m, p, r) => C3.clone(p, r || new C3()),
    inverseTransformation: () => Einheit,
    fromTranslation: (v, r) => { const z = r || { t: new C3() }; z.t = C3.clone(v, new C3()); return z; },
    multiply: (a, b, r) => {
      const z = r || { t: new C3() };
      const at = a.t || C3.ZERO, bt = b.t || C3.ZERO;
      z.t = new C3(at.x + bt.x, at.y + bt.y, at.z + bt.z);
      return z;
    },
    clone: (a, r) => { const z = r || {}; z.t = C3.clone(a.t || C3.ZERO, new C3()); return z; },
    equals: (a, b) => {
      if (!a || !b) return a === b;
      const at = a.t || C3.ZERO, bt = b.t || C3.ZERO;
      return at.x === bt.x && at.y === bt.y && at.z === bt.z;
    },
  }),
  Matrix3: { getColumn: (m, i, r) => C3.clone(m[i], r) },
  CustomShader: class {
    constructor(opt) {
      this.uniforms = opt.uniforms || {};
      this.vertexShaderText = opt.vertexShaderText || '';
      this.fragmentShaderText = opt.fragmentShaderText || '';
      this.mode = opt.mode;
    }
    setUniform(name, wert) {
      if (!this.uniforms[name]) this.uniforms[name] = { value: null };
      this.uniforms[name].value = wert && wert.clone ? wert.clone() : wert;
    }
  },
  UniformType: { FLOAT: 'float', VEC3: 'vec3' },
  CustomShaderMode: { MODIFY_MATERIAL: 'MODIFY_MATERIAL' },
  SceneMode: { SCENE3D: 3, COLUMBUS_VIEW: 1 },
  // Ein Klon ist ein zweites Tileset derselben Adresse; die Attrappe zählt nur
  // mit, wie oft geladen wurde — daran hängt die Prüfung, dass der Regler
  // verschiebt statt neu zu laden.
  Cesium3DTileset: {
    ladungen: 0,
    fromUrl: async (url, optionen) => {
      Cesium.Cesium3DTileset.ladungen++;
      return {
        url: url, optionen: optionen, show: true, style: undefined,
        customShader: undefined, modelMatrix: { t: new C3() },
        root: { computedTransform: Einheit },
      };
    },
  },
  Cesium3DTileStyle: class { constructor(json) { this.style = json; } },
  defined: (x) => x !== undefined && x !== null,
};

// ── Browser-Ersatz ────────────────────────────────────────────────────────

globalThis.window = globalThis;
globalThis.Cesium = Cesium;
globalThis.document = { getElementById: () => null, querySelector: () => null,
                        createElement: () => ({ style: {}, classList: { add() {} } }) };
globalThis.setInterval = () => 0;      // das Panel hängt sich im Test nirgends ein
globalThis.clearInterval = () => {};

let fetchAufrufe = 0;
let geschossAntwort = [];
globalThis.fetch = async (url) => {
  fetchAufrufe++;
  if (!/\/storeys$/.test(url)) throw new Error('unerwartete Adresse: ' + url);
  return { ok: true, json: async () => geschossAntwort };
};

// ── Szene-Attrappe ────────────────────────────────────────────────────────

/**
 * Eine Entity, die sich wie bei Cesium verhält: ein zugewiesener Rohwert wird
 * zur Property mit `getValue`. Das ist keine Spitzfindigkeit der Attrappe —
 * explosion.js liest die Ausgangslage über `getValue` zurück, nachdem es sie
 * vorher als Zahl bzw. Cartesian3 geschrieben hat. Wandelte die Attrappe nur
 * beim Anlegen, ginge dieser Weg im Test durch, im Browser aber nicht.
 */
function eigenschaft(wert) {
  return { _wert: wert, getValue() { return this._wert; } };
}
function alsProperty(ziel, feld, wert) {
  ziel[feld] = wert && (wert.getValue || typeof wert === 'object' && !(wert instanceof C3))
    ? wert : eigenschaft(wert);
  return true;
}
function propertyProxy(objekt) {
  Object.keys(objekt).forEach((feld) => {
    if (!objekt[feld] || !objekt[feld].getValue) objekt[feld] = eigenschaft(objekt[feld]);
  });
  return new Proxy(objekt, {
    set: (ziel, feld, wert) => alsProperty(ziel, feld, wert)
  });
}
class Entity {
  constructor(felder) {
    Object.assign(this, felder);
    if (this.position && !this.position.getValue) this.position = eigenschaft(this.position);
    if (this.polygon) this.polygon = propertyProxy(this.polygon);
    return new Proxy(this, {
      set(ziel, feld, wert) {
        if (feld === 'position' && wert && !wert.getValue) { ziel.position = eigenschaft(wert); return true; }
        ziel[feld] = wert;
        return true;
      }
    });
  }
}
function polygonWert(e, feld) {
  const p = e.polygon[feld];
  return p && p.getValue ? p.getValue() : p;
}

const preRenderHorcher = [];
// Der Rückseitenschnitt wird nicht mehr als Zeichenkette vorbelegt, sondern
// weiter unten über die `applyBackFaceCulling()`-Attrappe angemeldet — so wie
// core.js es am echten Modell tut.
const tilesetA = { name: 'A', root: { computedTransform: Einheit, boundingVolume: null },
                   boundingSphere: { center: new C3(0, 0, 10), radius: 12 },
                   customShader: undefined };
const tilesetB = { name: 'B', root: { computedTransform: Einheit, boundingVolume: null },
                   boundingSphere: { center: new C3(0, 0, 8), radius: 9 },
                   customShader: undefined };
const tilesetC = { name: 'C', root: { computedTransform: Einheit, boundingVolume: null },
                   boundingSphere: { center: new C3(0, 0, 10), radius: 12 },
                   customShader: undefined, show: true, style: undefined,
                   modelMatrix: { t: new C3() } };

const konzeptQuelle = { entities: { values: [] } };
const primitiveListe = [];

globalThis.BimViewer = {
  getBackendUrl: () => 'http://backend.test',
  loadedAssets: new Map(),
  // `applyBackFaceCulling()` meldet in core.js einen eigenen Baustein am
  // Shader-Verbund an. Die Attrappe muss das nachstellen, sonst geht der
  // Fehler durch, der am echten Modell zuschlug: der Stauchshader wurde vom
  // Angleichen überschrieben, die Uniforms ließen sich weiter setzen — sie
  // hingen nur an einem Shader, den niemand mehr zeichnet. Der Regler zeigte
  // 98 %, und das Gebäude stand unverändert da. Genau dagegen ist der Verbund
  // gebaut, und genau das prüfen die Klon-Abschnitte unten.
  applyBackFaceCulling(tileset) {
    BimViewer.ShaderVerbund.setzen(tileset, 'rueckseite', {
      ordnung: 0,
      fragment: 'if (czm_backFacing()) { discard; }'
    });
  },
  enableTilesetLighting() {},
  viewer: {
    clock: { currentTime: 'jetzt' },
    dataSources: { getByName: (n) => (n === 'konzept-4d' ? [konzeptQuelle] : []) },
    scene: {
      mode: Cesium.SceneMode.SCENE3D,
      camera: { viewMatrix: Einheit },
      requestRender() {},
      primitives: {
        add(p) { primitiveListe.push(p); return p; },
        remove(p) {
          const i = primitiveListe.indexOf(p);
          if (i >= 0) primitiveListe.splice(i, 1);
          return i >= 0;
        }
      },
      preRender: {
        addEventListener(f) { preRenderHorcher.push(f); return () => {
          const i = preRenderHorcher.indexOf(f);
          if (i >= 0) preRenderHorcher.splice(i, 1);
        }; }
      }
    }
  }
};

// Der Verbund zuerst: explosion.js meldet seinen Baustein bei ihm an.
require(path.join(path.resolve(__dirname, '../..'), 'shader-verbund.js'));
require(path.join(path.resolve(__dirname, '../..'), 'explosion.js'));
const X = BimViewer.Explosion;
const Verbund = BimViewer.ShaderVerbund;

// Wie am echten Modell: core.js meldet den Rückseitenschnitt an, sobald ein
// IFC-Tileset geladen ist. Ohne diesen Schritt prüfte der Abschnitt „Ein- und
// Ausschalten" ein Modell, das nie einen hatte — und die Frage, ob die
// Explosion ihn überlebt, wäre gar nicht gestellt.
[tilesetA, tilesetB, tilesetC].forEach((ts) => BimViewer.applyBackFaceCulling(ts));

// ── Prüfhilfen ────────────────────────────────────────────────────────────

let fehler = 0;
function pruefe(name, bedingung, zusatz) {
  const ok = !!bedingung;
  if (!ok) fehler++;
  console.log((ok ? '✓ ' : '✗ ') + name + (zusatz ? '   ' + zusatz : ''));
}
function nahe(a, b, tol = 1e-6) { return Math.abs(a - b) < tol; }
function abschnitt(titel) {
  console.log(`\n── ${titel} ${'─'.repeat(Math.max(2, 58 - titel.length))}`);
}

// ── 1 · Geschosse aus dem Backend ─────────────────────────────────────────

(async function () {

  abschnitt('Geschossverzeichnis');

  geschossAntwort = [
    { name: 'EG',       hoehe: 0.0,  bauteile: 120 },
    { name: '1.OG',     hoehe: 3.0,  bauteile: 118 },
    { name: '2.OG',     hoehe: 6.0,  bauteile: 95 },
    { name: 'Attika',   hoehe: 9.0,  bauteile: 0 },    // Hilfsebene ohne Bauteile
    { name: '2.OG (B)', hoehe: 6.02, bauteile: 40 },   // zweites Bauwerk, gleiche Höhe
  ];
  fetchAufrufe = 0;

  const gruppen = await X._geschosseHolen('job-1');
  const zeig = '[' + gruppen.map((g) => g.namen.join('+') + '@' + g.hoehe).join(', ') + ']';
  pruefe('Hilfsebene ohne Bauteile fällt heraus',
         !gruppen.some((g) => g.hoehe === 9.0), zeig);
  pruefe('Doppelt geführte Geschosshöhe zählt einmal', gruppen.length === 3, zeig);
  pruefe('… behält aber beide Namen', gruppen[2].namen.join('+') === '2.OG+2.OG (B)', zeig);
  pruefe('Aufsteigend sortiert',
         gruppen[0].hoehe === 0 && gruppen[1].hoehe === 3 && gruppen[2].hoehe === 6, zeig);

  await X._geschosseHolen('job-1');
  pruefe('Zweiter Aufruf kommt aus dem Zwischenspeicher', fetchAufrufe === 1,
         fetchAufrufe + ' Abfragen');

  abschnitt('Trennebenen');

  X.fuge = 0.15;
  const mehr = await X._grenzenFuer({ jobId: 'job-1', name: 'Haus', tileset: tilesetA });
  pruefe('Eine Trennebene weniger als Geschosse', mehr.grenzen.length === 2,
         '[' + mehr.grenzen.join(', ') + ']');
  pruefe('Das unterste Geschoss bleibt ungeteilt', mehr.grenzen[0] > -2);
  // Geschosse [0, 3, 6] ab Modellunterkante, tilesetA-Unterkante bei −2:
  // die Trennebenen liegen bei 3−2+0.15 und 6−2+0.15.
  pruefe('Die Fuge liegt ÜBER der Geschosshöhe', nahe(mehr.grenzen[0], 1.15) &&
                                                  nahe(mehr.grenzen[1], 4.15),
         '[' + mehr.grenzen.join(', ') + ']');
  pruefe('Herkunft wird benannt', mehr.quelle === 'Geschosse aus dem Modell', mehr.quelle);

  // Der Nullpunkt-Versatz ist das, woran die Ansicht am echten Modell scheiterte:
  // das Backend zählt ab der Modellunterkante, der Shader ab dem Tile-Ursprung.
  // Ein zweites Modell mit anderer Unterkante (−1) muss deshalb andere
  // Trennebenen bekommen, obwohl die Geschosshöhen dieselben sind.
  const anderes = await X._grenzenFuer({ jobId: 'job-1', name: 'Haus B', tileset: tilesetB });
  pruefe('Die Geschosshöhen werden auf den Tile-Ursprung umgerechnet',
         nahe(anderes.grenzen[0], 2.15) && nahe(anderes.grenzen[1], 5.15),
         '[' + anderes.grenzen.join(', ') + ']');

  geschossAntwort = [{ name: 'EG', hoehe: 0, bauteile: 300 }];
  const eins = await X._grenzenFuer({ jobId: 'job-flach', name: 'Halle', tileset: tilesetA });
  pruefe('Ein einziges Geschoss wird NICHT hilfsweise gerastert', eins.grenzen.length === 0);
  pruefe('… und sagt warum', eins.quelle === 'nur ein Geschoss', eins.quelle);

  abschnitt('Ersatzraster ohne Geschossverzeichnis');

  X.regelhoehe = 3.0;
  const ion = await X._grenzenFuer({ name: 'Ion-Asset', tileset: tilesetA });
  // Hüllkugel: Mitte 10, Radius 12 → Unterkante −2, Oberkante 22.
  pruefe('Raster beginnt an der Modellunterkante', nahe(ion.grenzen[0], 1.0),
         '[' + ion.grenzen.map((g) => g.toFixed(1)).join(', ') + ']');
  pruefe('Gleichmäßige Teilung', nahe(ion.grenzen[1] - ion.grenzen[0], 3.0));
  pruefe('Keine Ebene über der Oberkante', ion.grenzen[ion.grenzen.length - 1] < 22);
  pruefe('Herkunft wird benannt', ion.quelle === 'gleichmäßig geteilt');

  abschnitt('Shader');

  const baustein = X._bausteinBauen([3.15, 6.15, 9.15]);
  const stufen = (baustein.vertex.match(/if \(h >= /g) || []).length;
  pruefe('Je Trennebene eine Stufe', stufen === 3, stufen + ' Stufen');
  pruefe('Die höchste Stufe ist die oberste Etage',
         /etage = 3\.0;/.test(baustein.vertex));
  pruefe('Der Abstand bleibt ein Uniform (Regler baut nichts neu)',
         !!baustein.uniforms.u_abstand && !/u_abstand *=/.test(baustein.vertex));
  pruefe('Basis und Hochachse sind Uniforms',
         !!baustein.uniforms.u_basisEC && !!baustein.uniforms.u_obenEC);
  // Der Rückseitenschnitt gehört nicht mehr in diesen Baustein — er ist ein
  // eigener und steht neben ihm. Hier ihn mitzuführen hieße, ihn auf jedem
  // Modell zu erzwingen, auch auf denen, für die core.js sich bewusst dagegen
  // entschieden hat.
  pruefe('Der Baustein trägt keinen eigenen Rückseitenschnitt mehr',
         !baustein.fragment || !/czm_backFacing/.test(baustein.fragment));
  pruefe('Er steht früh genug, um vor dem Färbenden zu verformen',
         baustein.ordnung === 10, 'ordnung = ' + baustein.ordnung);
  pruefe('Die Hochachse wird NICHT normiert (sonst stimmt die Längeneinheit nicht)',
         /czm_inverseModelView \* vec4\(u_obenEC, 0\.0\)/.test(baustein.vertex) &&
         !/normalize\(\(czm_inverseModelView/.test(baustein.vertex));

  abschnitt('Stauchen (Shader-Weg)');

  // Gestaucht wird auf den FUSSBODEN, nicht auf die Trennebene: die liegt um
  // das Fugenmaß höher, und ein Geschoss, das auf die Kante über seiner Decke
  // gedrückt wird, steckt danach im Nachbargeschoss.
  const mitBasen = await X._grenzenFuer({ jobId: 'job-1', name: 'Haus', tileset: tilesetA });
  pruefe('Eine Stauchebene je Etage, also eine mehr als Trennebenen',
         mitBasen.basen.length === mitBasen.grenzen.length + 1,
         mitBasen.basen.length + ' Basen zu ' + mitBasen.grenzen.length + ' Grenzen');
  pruefe('Die unterste Stauchebene ist die Modellunterkante',
         nahe(mitBasen.basen[0], -2.0), '[' + mitBasen.basen.join(', ') + ']');
  pruefe('Gestaucht wird auf den Fußboden, nicht auf die Trennebene darüber',
         nahe(mitBasen.basen[1], 1.0) && nahe(mitBasen.grenzen[0], 1.15),
         'Basis ' + mitBasen.basen[1] + ' gegen Grenze ' + mitBasen.grenzen[0]);

  const ionBasen = await X._grenzenFuer({ name: 'Ion-Asset', tileset: tilesetA });
  pruefe('Auch das Ersatzraster liefert Stauchebenen',
         ionBasen.basen.length === ionBasen.grenzen.length + 1 &&
         nahe(ionBasen.basen[0], -2.0) && nahe(ionBasen.basen[1], 1.0),
         '[' + ionBasen.basen.map((b) => b.toFixed(1)).join(', ') + ']');

  const flachBaustein = X._bausteinBauen([3.15, 6.15, 9.15], [0, 3, 6, 9]);
  pruefe('Der Stauchfaktor ist ein Uniform (Regler baut nichts neu)',
         !!flachBaustein.uniforms.u_flach &&
         !/u_flach *=/.test(flachBaustein.vertex));
  pruefe('Gestaucht wird um die Höhe über der eigenen Basis',
         /\(h - basis\) \* u_flach/.test(flachBaustein.vertex),
         flachBaustein.vertex.match(/vsOutput\.positionMC[^;]*/));
  pruefe('Dieselbe Kette setzt Etage UND Basis',
         /if \(h >= 3\.150\) \{ etage = 1\.0; basis = 3\.000; \}/
           .test(flachBaustein.vertex),
         flachBaustein.vertex.match(/if \(h >= 3[^\n]*/));
  pruefe('Unterhalb der ersten Trennebene gilt die unterste Basis',
         /float basis = 0\.000;/.test(flachBaustein.vertex));

  // Ohne Basen — der Aufruf aus einer älteren Fassung — darf der Shader nicht
  // zerbrechen, sondern fällt auf die Trennebene selbst zurück.
  const ohneBasen = X._bausteinBauen([3.15, 6.15]);
  pruefe('Ohne Stauchebenen bleibt der Shader baubar',
         /basis = 3\.150;/.test(ohneBasen.vertex) &&
         /float basis = 0\.000;/.test(ohneBasen.vertex));

  abschnitt('Ein- und Ausschalten (Shader-Weg)');

  // Ohne Geschossverzeichnis — also ein Ion-Asset — bleibt es beim Shader mit
  // seinem Ersatzraster. Modelle MIT Verzeichnis nehmen den Klon-Weg, der
  // gleich danach geprüft wird.
  geschossAntwort = [
    { name: 'EG',   hoehe: 0, bauteile: 100 },
    { name: '1.OG', hoehe: 3, bauteile: 100 },
    { name: '2.OG', hoehe: 6, bauteile: 100 },
  ];
  X._geschossCache = {};
  BimViewer.loadedAssets.set('a', { id: 'a', name: 'Ion-Haus', tileset: tilesetA });
  BimViewer.loadedAssets.set('b', { id: 'b', name: 'Wolke', tileset: tilesetB, isPointCloud: true });

  X.abstand = 4;
  await X.an();

  pruefe('Punktwolken bleiben außen vor', X.ziele.length === 1, X.ziele.length + ' Ziele');
  pruefe('Das Modell bekommt den Explosionsshader',
         tilesetA.customShader === X.ziele[0].shader);
  // Nicht „der vorherige Shader ist festgehalten": beide stehen NEBEN-
  // einander im selben Verbund. Das ist der Unterschied, um den es geht.
  pruefe('Der Rückseitenschnitt steht neben der Explosion',
         Verbund.hat(tilesetA, 'rueckseite') && Verbund.hat(tilesetA, 'explosion') &&
         /czm_backFacing/.test(tilesetA.customShader.fragmentShaderText),
         Verbund.bausteine(tilesetA).join(', '));
  pruefe('Die Punktwolke ist unangetastet',
         !Verbund.hat(tilesetB, 'explosion'), Verbund.bausteine(tilesetB).join(', '));
  pruefe('Eine Wache hängt am Bild', preRenderHorcher.length === 1);

  preRenderHorcher.forEach((f) => f());
  pruefe('Die Wache setzt Basis und Hochachse',
         X.ziele[0].shader.uniforms.u_obenEC.value.z === 1);

  X.abstandSetzen(6);
  pruefe('Der Regler schreibt nur ins Uniform',
         X.ziele[0].shader.uniforms.u_abstand.value === 6 &&
         tilesetA.customShader === X.ziele[0].shader);

  X.aus();
  pruefe('Ausschalten nimmt NUR den Explosionsbaustein fort',
         !Verbund.hat(tilesetA, 'explosion') && Verbund.hat(tilesetA, 'rueckseite') &&
         /czm_backFacing/.test(tilesetA.customShader.fragmentShaderText),
         Verbund.bausteine(tilesetA).join(', '));
  pruefe('… und die Verformung ist aus dem Shader heraus',
         !/u_abstand/.test((tilesetA.customShader || {}).vertexShaderText || ''));
  pruefe('Die Wache ist abgemeldet', preRenderHorcher.length === 0);

  abschnitt('Geschossklone');

  // Der Weg für Modelle mit Geschossverzeichnis: statt die Geometrie im Shader
  // zu verbiegen, wird je Geschoss ein Tileset geladen und als Ganzes gehoben.
  // Geprüft wird, was dabei schiefgehen kann, ohne dass man es im Bild gleich
  // sieht: ein verlorener Geschossname (das Bauteil wäre unsichtbar), ein
  // angetastetes Original (es käme verändert zurück), ein Regler, der neu lädt.
  BimViewer.loadedAssets.clear();
  BimViewer.loadedAssets.set('c', {
    id: 'c', name: 'Haus C', jobId: 'job-klon',
    url: 'http://backend.test/tiles/job-klon/tileset.json', tileset: tilesetC
  });
  geschossAntwort = [
    { name: 'Gründung', hoehe: 0.0, bauteile: 40 },    // dieselbe Ebene wie UG
    { name: 'UG',       hoehe: 0.2, bauteile: 200 },
    { name: 'EG',       hoehe: 3.0, bauteile: 300 },
    { name: 'OG',       hoehe: 6.0, bauteile: 280 },
    { name: 'Attika',   hoehe: 9.0, bauteile: 0 },     // Hilfsebene
  ];
  X._geschossCache = {};
  Cesium.Cesium3DTileset.ladungen = 0;
  X.abstand = 4;
  await X.an();

  const klonZiel = X.klonZiele[0];
  const klone = klonZiel ? klonZiel.klone : [];
  pruefe('Ein Modell mit Geschossverzeichnis nimmt den Klon-Weg',
         X.klonZiele.length === 1 && X.ziele.length === 0,
         X.klonZiele.length + ' Klon-Ziele, ' + X.ziele.length + ' Shader-Ziele');
  pruefe('Je Geschoss ein Tileset', klone.length === 3, klone.length + ' Klone');
  pruefe('Zwei Fachebenen auf einer Höhe werden EINE Ebene mit beiden Namen',
         klonZiel && klonZiel.gruppen[0].namen.length === 2,
         JSON.stringify(klonZiel && klonZiel.gruppen.map((g) => g.namen)));
  pruefe('Das unterste Geschoss zeigt alles, was zu keinem höheren gehört',
         /^!\(/.test(klone[0].tileset.style.style.show) &&
         !/Gründung/.test(klone[0].tileset.style.style.show),
         klone[0] && klone[0].tileset.style.style.show);
  pruefe('Ein höheres Geschoss filtert auf seinen Namen',
         klone[2].tileset.style.style.show === "${Geschoss} === 'OG'",
         klone[2] && klone[2].tileset.style.style.show);
  pruefe('Der Rang bestimmt die Höhe', klone[2].tileset.modelMatrix.t.z === 8,
         'z = ' + klone[2].tileset.modelMatrix.t.z);
  pruefe('Das unterste Geschoss bleibt stehen', klone[0].tileset.modelMatrix.t.z === 0);
  // Der Klon bekommt seit dem Stauchen einen EIGENEN Shader statt den des
  // Originals. Der Rückseitenschnitt darf dabei nicht verlorengehen: ohne ihn
  // stünde jedes Geschoss mit dem Z-Fighting doppelseitiger Wände im Bild.
  pruefe('Der Klon-Shader führt den Rückseitenschnitt mit',
         /czm_backFacing/.test(klone[0].tileset.customShader.fragmentShaderText));
  pruefe('Das Original wird nur unsichtbar, nicht verändert',
         tilesetC.show === false && !Verbund.hat(tilesetC, 'explosion') &&
         tilesetC.style === undefined,
         Verbund.bausteine(tilesetC).join(', '));

  const ladungenVorher = Cesium.Cesium3DTileset.ladungen;
  X.abstandSetzen(6);
  pruefe('Der Regler verschiebt, ohne neu zu laden',
         klone[2].tileset.modelMatrix.t.z === 12 &&
         Cesium.Cesium3DTileset.ladungen === ladungenVorher,
         'z = ' + klone[2].tileset.modelMatrix.t.z);

  // Das Auge in der Modellliste schaltet `asset.visible` und `tileset.show` des
  // ORIGINALS — sichtbar sind während der Explosion aber die Klone.
  const assetC = BimViewer.loadedAssets.get('c');
  assetC.visible = false;
  tilesetC.show = true;                       // genau das tut toggleAssetVisibility()
  for (let i = 0; i < 20; i++) preRenderHorcher.forEach((f) => f());
  pruefe('Ausblenden wirkt auch während der Explosion',
         klone.every((k) => k.tileset.show === false) && tilesetC.show === false);

  assetC.visible = true;
  for (let i = 0; i < 20; i++) preRenderHorcher.forEach((f) => f());
  pruefe('… und Einblenden ebenso', klone.every((k) => k.tileset.show === true));

  // Stauchen auf dem Klon-Weg: ein Klon enthält per Style genau EIN Geschoss
  // und braucht deshalb keine if-Kette, sondern eine Konstante.
  const klonShader = klone[2].tileset.customShader;
  pruefe('Der Klon-Shader kommt ohne Trennebenen-Kette aus',
         !/if \(h >= /.test(klonShader.vertexShaderText));
  // Geschosse [0, 3, 6] ab Modellunterkante, tilesetC-Unterkante bei −2:
  // die Stauchebene des dritten Klons liegt bei 6 − 2 = 4.
  pruefe('Die Stauchebene des Klons ist sein eigener Fußboden',
         /\(h - 4\.000\)/.test(klonShader.vertexShaderText),
         klonShader.vertexShaderText.match(/vsOutput\.positionMC[^;]*/));
  pruefe('Der Klon hebt NICHT im Shader — das macht die modelMatrix',
         !/u_abstand/.test(klonShader.vertexShaderText));

  // Der Shader, dessen Uniforms `flachSetzen()` schreibt, MUSS der sein, der
  // am Tileset hängt. Sonst gehen die Werte ins Leere: der Regler zeigt 98 %,
  // und das Gebäude steht unverändert da.
  pruefe('Der gehaltene Shader ist der, der am Tileset hängt',
         klone.every((k) => k.tileset.customShader === k.shader));

  const ladungenVorStauchen = Cesium.Cesium3DTileset.ladungen;
  X.flachSetzen(1);
  // Nicht 1.0: koplanare Flächen haben keine eindeutige Tiefensortierung, und
  // Fußboden, Wandfuß und Deckenunterseite lägen exakt aufeinander.
  pruefe('Voll gestaucht bleibt eine Resthöhe stehen',
         nahe(klonShader.uniforms.u_flach.value, 0.98),
         String(klonShader.uniforms.u_flach.value));
  pruefe('Der Stauchregler lädt nichts neu',
         Cesium.Cesium3DTileset.ladungen === ladungenVorStauchen);
  pruefe('Alle Klone werden gemeinsam gestaucht',
         klone.every((k) => nahe(k.tileset.customShader.uniforms.u_flach.value, 0.98)));

  X.flachSetzen(0);
  pruefe('Zurück auf null gibt die Bauhöhe zurück',
         klonShader.uniforms.u_flach.value === 0);
  pruefe('… und schaltet die Explosion NICHT ab', X.aktiv === true);

  // Die Uniforms der Klone müssen je Bild nachgeführt werden, seit sie
  // stauchen — sonst bliebe `h` bei der Kameralage des ersten Bildes stehen.
  klonShader.uniforms.u_obenEC.value = new C3(0, 0, 0);
  X._uniformsNachfuehren();
  pruefe('Die Wache führt auch die Klon-Uniforms nach',
         klonShader.uniforms.u_obenEC.value.z === 1,
         JSON.stringify(klonShader.uniforms.u_obenEC.value));

  X.aus();
  pruefe('Ausschalten entfernt die Klone aus der Szene', primitiveListe.length === 0,
         primitiveListe.length + ' Primitive übrig');
  pruefe('… und gibt dem Original seine Sichtbarkeit zurück', tilesetC.show === true);
  pruefe('… und lässt nichts stehen', X.klonZiele.length === 0);

  abschnitt('Geschossrang');

  const rang = X._raengeAus({ '1.OG': 3000, 'EG': 0, 'UG': -3000, '2.OG': 6000 });
  pruefe('Die Reihenfolge kommt aus der Höhe, nicht aus dem Namen',
         rang.UG === 0 && rang.EG === 1 && rang['1.OG'] === 2 && rang['2.OG'] === 3,
         JSON.stringify(rang));

  abschnitt('Entities: Konzept-Baukörper');

  const wand = new Entity({ _konzept4d: 'EG/wand', position: new C3(0, 0, 100) });
  const decke = new Entity({ _konzept4d: '1.OG/decke', position: new C3(0, 0, 103) });
  const kran = new Entity({ _konzept4d: 'baustelle/kranmast', position: new C3(0, 0, 100) });
  konzeptQuelle.entities.values = [wand, decke, kran];

  globalThis.Konzept4D = {
    zustand: {
      koerper: [
        { id: 'EG/wand',            geschoss: 'EG',   z: 0 },
        { id: '1.OG/decke',         geschoss: '1.OG', z: 3000 },
        { id: 'baustelle/kranmast', geschoss: null,   z: 0 },
      ]
    }
  };
  // Bauplaner liefert die Hochachse des Rastersystems: 1 m entspricht +1 in z.
  globalThis.Bauplaner = {
    hatUrsprung: () => true,
    weltPunkt: (x, y, zMm) => new C3(0, 0, zMm / 1000),
    zustand: { bauteile: [], geschosse: [] },
  };

  X.abstand = 5;
  X._entitiesAnwenden();
  pruefe('Das Erdgeschoss bleibt stehen', nahe(wand.position.getValue().z, 100));
  pruefe('Das 1. OG steigt um einen Abstand', nahe(decke.position.getValue().z, 108));
  pruefe('Der Kran bleibt am Boden', nahe(kran.position.getValue().z, 100));

  X._entitiesAnwenden();
  pruefe('Zweimal anwenden verschiebt nicht doppelt',
         nahe(decke.position.getValue().z, 108), String(decke.position.getValue().z));

  X.abstand = 2;
  X._entitiesAnwenden();
  pruefe('Ein kleinerer Abstand rückt zurück, nicht weiter',
         nahe(decke.position.getValue().z, 105));

  X._entitiesZuruecksetzen();
  pruefe('Zurücksetzen trifft die Ausgangslage genau',
         nahe(decke.position.getValue().z, 103) && !decke._explosionBasis);

  abschnitt('Entities: Bauplaner-Bauteile');

  const stuetze = new Entity({ _bauteilId: 's1', position: new C3(0, 0, 50) });
  const platte = new Entity({ _bauteilId: 'p1', polygon: { height: 53, extrudedHeight: 53.2 } });
  Bauplaner.zustand = {
    geschosse: [{ name: 'EG', z: 0 }, { name: 'E1', z: 3000 }, { name: 'E2', z: 6000 }],
    bauteile: [
      { id: 's1', geschoss: 0, entity: stuetze },
      { id: 'p1', geschoss: 2, entity: platte },
    ],
  };
  konzeptQuelle.entities.values = [];

  X.abstand = 4;
  X._entitiesAnwenden();
  pruefe('Bauteil im Erdgeschoss bleibt', nahe(stuetze.position.getValue().z, 50));
  pruefe('Ausgezogenes Polygon steigt über die Höhe, nicht die Position',
         nahe(polygonWert(platte, 'height'), 61) &&
         nahe(polygonWert(platte, 'extrudedHeight'), 61.2),
         polygonWert(platte, 'height') + ' / ' + polygonWert(platte, 'extrudedHeight'));
  pruefe('Die Dicke der Platte bleibt erhalten',
         nahe(polygonWert(platte, 'extrudedHeight') - polygonWert(platte, 'height'), 0.2));

  X._entitiesZuruecksetzen();
  pruefe('Auch das Polygon findet zurück',
         nahe(polygonWert(platte, 'height'), 53) &&
         nahe(polygonWert(platte, 'extrudedHeight'), 53.2));

  abschnitt('Nachzügler');

  X.abstand = 4;
  X.aktiv = true;
  X._entitiesAnwenden();
  const spaet = new Entity({ _bauteilId: 'p2', polygon: { height: 53, extrudedHeight: 53.2 } });
  Bauplaner.zustand.bauteile.push({ id: 'p2', geschoss: 2, entity: spaet });

  X._wacheStarten();
  X._bild = 19;                       // der nächste Durchlauf ist der zwanzigste
  preRenderHorcher.forEach((f) => f());
  pruefe('Ein neu gezeichnetes Bauteil holt die Wache nach',
         nahe(polygonWert(spaet, 'height'), 61), String(polygonWert(spaet, 'height')));
  X._wacheStoppen();
  X.aktiv = false;

  abschnitt('Ergebnis');
  console.log(fehler === 0 ? '\nAlles in Ordnung.\n' : `\n${fehler} Prüfung(en) fehlgeschlagen.\n`);
  process.exit(fehler === 0 ? 0 : 1);
})();
