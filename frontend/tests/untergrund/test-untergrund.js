// Prüft den Untergrund-Modus ohne Browser — mit echtem Cesium für die
// Matrizen, nachgebaut sind nur Viewer und Szene.
//
// Aufruf:  node tests/untergrund/test-untergrund.js
//
// Der Fehler, der hier festgehalten wird, war kein Absturz, sondern ein
// falsches Bild: v0.4 und v0.5 schalteten `globe.translucency` ein, und die
// ganze Welt wurde durchsichtig. Die Modelle sollen vom Gelände nicht verdeckt
// werden — dafür reicht `depthTestAgainstTerrain = false`, das Gelände bleibt
// deckend. Geprüft wird deshalb vor allem, dass die Transparenz unberührt bleibt.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');
const Cesium = require(path.join(WURZEL, 'node_modules', 'cesium'));

// `new Material()` prüft Uniform-Werte mit instanceof gegen Browser-Klassen,
// die es unter Node nicht gibt. Leere Klassen genügen: unsere Werte sind
// Zahlen, Farben und Cartesian3 und treffen keine davon.
for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'HTMLVideoElement', 'ImageBitmap', 'OffscreenCanvas']) {
  if (typeof globalThis[name] === 'undefined') globalThis[name] = class {};
}

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}

// ── Viewer-Attrappe ─────────────────────────────────────────────────────────

function neuerViewer() {
  const hoerer = [];
  const kamera = {
    positionWC: Cesium.Cartesian3.fromDegrees(8.2599, 49.9929, 120),
    positionCartographic: Cesium.Cartographic.fromDegrees(8.2599, 49.9929, 120),
    viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    getPickRay: () => undefined,
  };
  const altesUnterfarbe = Cesium.Color.BLACK;
  return {
    camera: kamera,
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      cameraUnderground: false,
      requestRender() {},
      preRender: {
        addEventListener(f) { hoerer.push(f); return () => { hoerer.splice(hoerer.indexOf(f), 1); }; },
      },
      _hoerer: hoerer,
      screenSpaceCameraController: { enableCollisionDetection: true, minimumZoomDistance: 1.0 },
      globe: {
        show: true,
        depthTestAgainstTerrain: true,
        material: undefined,
        undergroundColor: altesUnterfarbe,
        pick: () => undefined,
        translucency: {
          enabled: false, frontFaceAlpha: 1, backFaceAlpha: 1,
          frontFaceAlphaByDistance: undefined, backFaceAlphaByDistance: undefined,
          rectangle: Cesium.Rectangle.clone(Cesium.Rectangle.MAX_VALUE),
        },
      },
    },
  };
}

function lade(viewer, assets) {
  const speicher = {};
  const kontext = {
    Cesium,
    console,
    setInterval: () => 0,
    clearInterval() {},
    localStorage: {
      getItem: (k) => (k in speicher ? speicher[k] : null),
      setItem: (k, v) => { speicher[k] = String(v); },
    },
  };
  kontext.window = kontext;
  kontext.window.BimViewer = { viewer, loadedAssets: assets || new Map(), undergroundMode: { enabled: false }, updateStatus() {} };
  vm.createContext(kontext);
  vm.runInContext(fs.readFileSync(path.join(WURZEL, 'untergrund.js'), 'utf8'), kontext);
  return { api: kontext.window.BimViewer.Untergrund, bim: kontext.window.BimViewer, speicher };
}

// ── 1 · Einschalten: durchlässig für die Kamera, nicht für das Auge ─────────

{
  const v = neuerViewer();
  const { api, bim } = lade(v);
  const globus = v.scene.globe;
  const vorherUnterfarbe = globus.undergroundColor;

  pruefe('Modul hängt sich an BimViewer.Untergrund', !!api);
  api.an();

  pruefe('Durchblick: Tiefentest gegen das Gelände aus (Modelle nicht verdeckt)', globus.depthTestAgainstTerrain === false);
  pruefe('Gelände bleibt deckend: Globus-Transparenz unberührt', globus.translucency.enabled === false);
  pruefe('Kamera darf unter das Gelände', v.scene.screenSpaceCameraController.enableCollisionDetection === false);
  pruefe('Mindestabstand erlaubt das Heranfahren', v.scene.screenSpaceCameraController.minimumZoomDistance < 1);
  pruefe('Nullebene liegt als Material auf dem Globus', globus.material instanceof Cesium.Material);
  pruefe('Materialtyp ist die Nullebene', globus.material && globus.material.type === 'IleenNullebene');
  pruefe('undergroundColor ist für die Dauer abgeschaltet', globus.undergroundColor === undefined);
  pruefe('BimViewer.undergroundMode spiegelt den Zustand', bim.undergroundMode.enabled === true);
  pruefe('eine Wache auf preRender (Raster)', v.scene._hoerer.length === 1);

  api.aus();
  pruefe('Ausschalten: Tiefentest wieder an', globus.depthTestAgainstTerrain === true);
  pruefe('Ausschalten: Kollision wieder an', v.scene.screenSpaceCameraController.enableCollisionDetection === true);
  pruefe('Ausschalten: Mindestabstand zurück', v.scene.screenSpaceCameraController.minimumZoomDistance === 1.0);
  pruefe('Ausschalten: Material zurück (undefined)', globus.material === undefined);
  pruefe('Ausschalten: undergroundColor zurück', globus.undergroundColor === vorherUnterfarbe);
  pruefe('Ausschalten: Wache entfernt', v.scene._hoerer.length === 0);
  pruefe('Ausschalten: undergroundMode false', bim.undergroundMode.enabled === false);
}

// ── 2 · Nullebene getrennt schaltbar, fremdes Material bleibt ───────────────

{
  const v = neuerViewer();
  const { api, speicher } = lade(v);
  const globus = v.scene.globe;
  api.an();
  api.nullebeneSetzen(false);
  pruefe('Nullebene aus: Material weg, Modus bleibt an', globus.material === undefined && api.istAn());
  pruefe('Nullebene aus: Durchblick bleibt', globus.depthTestAgainstTerrain === false);
  pruefe('Wahl wird gemerkt', JSON.parse(speicher.ileen_untergrund_v1).nullebene === false);
  api.nullebeneSetzen(true);
  pruefe('Nullebene wieder an', globus.material && globus.material.type === 'IleenNullebene');

  const fremd = Cesium.Material.fromType('Color');
  globus.material = fremd;
  api.aus();
  pruefe('Fremdes Material, das inzwischen gesetzt wurde, bleibt stehen', globus.material === fremd);
}

{
  const v = neuerViewer();
  v.scene.globe.depthTestAgainstTerrain = false;
  const { api } = lade(v);
  api.durchblickSetzen(false);
  api.an();
  pruefe('Durchblick aus: Tiefentest im Modus an, auch wenn er vorher aus war', v.scene.globe.depthTestAgainstTerrain === true);
  api.aus();
  pruefe('… und danach zurückgegeben', v.scene.globe.depthTestAgainstTerrain === false);
}

// ── 3 · Raster: Augenkoordinaten und Nachrücken ─────────────────────────────

{
  const v = neuerViewer();
  // Kamera irgendwo, eine echte Sichtmatrix mit Drehung und Versatz
  const ort = Cesium.Cartesian3.fromDegrees(8.26, 49.99, 150);
  const enuKamera = Cesium.Transforms.eastNorthUpToFixedFrame(ort);
  v.camera.viewMatrix = Cesium.Matrix4.inverseTransformation(enuKamera, new Cesium.Matrix4());
  v.camera.positionWC = ort;
  const { api } = lade(v);
  api.an();
  const S = api._pruefsteine.zustand;
  v.scene._hoerer.forEach((f) => f());

  const u = v.scene.globe.material.uniforms;
  const erwartet = Cesium.Matrix4.multiplyByPoint(v.camera.viewMatrix, S.ursprung, new Cesium.Cartesian3());
  pruefe('ursprungEC = Sichtmatrix · Ursprung',
    Cesium.Cartesian3.equalsEpsilon(u.ursprungEC, erwartet, 1e-6));
  pruefe('ostEC und nordEC sind Einheitsvektoren',
    Math.abs(Cesium.Cartesian3.magnitude(u.ostEC) - 1) < 1e-9 && Math.abs(Cesium.Cartesian3.magnitude(u.nordEC) - 1) < 1e-9);
  pruefe('ostEC ⟂ nordEC', Math.abs(Cesium.Cartesian3.dot(u.ostEC, u.nordEC)) < 1e-9);
  pruefe('ursprungEC ist klein (Augenkoordinaten, nicht ECEF)', Cesium.Cartesian3.magnitude(u.ursprungEC) < 1e4);

  // Nachrücken: eine feste Weltstelle behält ihre Rasterlage modulo 10 m
  const S2 = api._pruefsteine;
  const enuAlt = Cesium.Matrix4.clone(S.enu);
  const punktLokal = new Cesium.Cartesian3(1234.0, -567.0, 0);
  const punktWelt = Cesium.Matrix4.multiplyByPoint(enuAlt, punktLokal, new Cesium.Cartesian3());
  const weit = Cesium.Matrix4.multiplyByPoint(enuAlt, new Cesium.Cartesian3(4870, 3120, 200), new Cesium.Cartesian3());
  const rueckte = S2.nachruecken(weit);
  pruefe('ab 3 km rückt der Ursprung nach', rueckte === true);
  const inv = Cesium.Matrix4.inverseTransformation(S.enu, new Cesium.Matrix4());
  const neuLokal = Cesium.Matrix4.multiplyByPoint(inv, punktWelt, new Cesium.Cartesian3());
  const mod = (a) => ((a % S2.WEITE) + S2.WEITE) % S2.WEITE;
  const nah = (a, b) => Math.min(Math.abs(a - b), S2.WEITE - Math.abs(a - b)) < 0.05;
  pruefe('Linien bleiben beim Nachrücken an ihrer Stelle (Ost, < 5 cm)', nah(mod(neuLokal.x), mod(punktLokal.x)),
    `${mod(neuLokal.x).toFixed(3)} gegen ${mod(punktLokal.x).toFixed(3)}`);
  pruefe('Linien bleiben beim Nachrücken an ihrer Stelle (Nord, < 5 cm)', nah(mod(neuLokal.y), mod(punktLokal.y)),
    `${mod(neuLokal.y).toFixed(3)} gegen ${mod(punktLokal.y).toFixed(3)}`);
  pruefe('in der Nähe rückt nichts nach', S2.nachruecken(S.ursprung) === false);
  api.aus();
}

// ── 3b · Durchblick über Modellen ───────────────────────────────────────────
//
// Der Fall: eine Punktwolke, deren Baugrube unter dem Gelände liegt. Sie soll
// sichtbar bleiben, ohne dass die Karte durchsichtig wird.

{
  const v = neuerViewer();
  const { api, speicher } = lade(v);
  const globus = v.scene.globe;
  const tr = globus.translucency;

  api.an();
  pruefe('Durchblick an: Modelle vor dem Gelände', globus.depthTestAgainstTerrain === false);
  pruefe('Durchblick an: keine Globus-Transparenz', tr.enabled === false && tr.frontFaceAlpha === 1 && tr.backFaceAlpha === 1);
  pruefe('Durchblick an: Rechteck unberührt', Cesium.Rectangle.equals(tr.rectangle, Cesium.Rectangle.MAX_VALUE));

  api.durchblickSetzen(false);
  pruefe('Durchblick aus: Gelände verdeckt wieder', globus.depthTestAgainstTerrain === true);
  pruefe('Wahl wird gemerkt', JSON.parse(speicher.ileen_untergrund_v1).durchblick === false);
  api.durchblickSetzen(true);
  pruefe('Durchblick wieder an', globus.depthTestAgainstTerrain === false);
  pruefe('stand() meldet Transparenz aus', api.stand().transparenz === false);

  // Eine vom Nutzer eingestellte Globus-Transparenz (Regler) bleibt stehen.
  tr.enabled = true; tr.frontFaceAlpha = 0.5;
  api.aus();
  pruefe('Ausschalten: fremde Transparenz bleibt unangetastet', tr.enabled === true && tr.frontFaceAlpha === 0.5);
}

// ── 4 · Shader und core.js ──────────────────────────────────────────────────

{
  const { api } = lade(neuerViewer());
  const glsl = api._pruefsteine.GLSL;
  pruefe('Shader unterscheidet Ober- und Unterseite', /gl_FrontFacing/.test(glsl));
  pruefe('Unterseite deckend in Erdfarbe', /erdfarbe\.a/.test(glsl));
  pruefe('Erddecke nur bei Kamera unter Gelände (sonst braun über der Landschaft)',
    /\*\s*kameraUnten/.test(glsl));

  const v4 = neuerViewer();
  const { api: api4 } = lade(v4);
  api4.an();
  const u4 = v4.scene.globe.material.uniforms;
  v4.scene.cameraUnderground = true;
  v4.scene._hoerer.forEach((f) => f());
  pruefe('kameraUnten folgt scene.cameraUnderground (unten → 1)', u4.kameraUnten === 1);
  v4.scene.cameraUnderground = false;
  v4.scene._hoerer.forEach((f) => f());
  pruefe('kameraUnten folgt scene.cameraUnderground (oben → 0)', u4.kameraUnten === 0);
  api4.aus();
  pruefe('Linienbreite in Bildpunkten (fwidth), mit Derivaten-Wache', /fwidth/.test(glsl) && /GL_OES_standard_derivatives/.test(glsl));

  // Der Block von der Methode bis zur nächsten Methode im Objekt — die
  // Grenze ist die nächste Zeile mit zwei Leerzeichen Einzug und `name(`.
  const core = fs.readFileSync(path.join(WURZEL, 'core.js'), 'utf8');
  const start = core.search(/\n  toggleUndergroundView\(/);
  const rest = core.slice(start + 1);
  const ende = rest.slice(1).search(/\n  (async )?[A-Za-z_]+\(.*\)\s*\{/);
  const umschalter = ende > 0 ? rest.slice(0, ende + 1) : rest;
  pruefe('core.js: Umschalter gefunden', start > 0 && umschalter.length > 50);
  pruefe('core.js: Umschalter delegiert an Untergrund',
    /this\.Untergrund\.an\(\)/.test(umschalter) && /this\.Untergrund\.aus\(\)/.test(umschalter));
  pruefe('core.js: Umschalter macht das Gelände nicht mehr durchsichtig', !/translucency/.test(umschalter));
  pruefe('core.js: Umschalter schaltet den Tiefentest nicht ab', !/depthTestAgainstTerrain\s*=/.test(umschalter));

  const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf8');
  pruefe('index.html lädt untergrund.js nach core.js',
    html.indexOf('src="untergrund.js"') > html.indexOf('src="core.js"') && html.indexOf('src="untergrund.js"') > 0);
}

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
