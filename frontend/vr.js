// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// iLEEN in der Brille — Meta Quest 3 und jede andere WebXR-Brille.
//
// Warum eine eigene Seite
// =======================
// Cesium kann kein WebXR. Sein VR-Knopf setzt `scene.useWebVR` und zeichnet zwei
// Bildhälften nebeneinander auf den Bildschirm, für Pappbrillen; in der Quest
// ergibt das ein flaches Fenster mit Doppelbild. Diese Seite liest deshalb
// dasselbe Tileset (`<backend>/tiles/<job>/tileset.json`) mit `3d-tiles-renderer`
// in three.js und übergibt es an WebXR.
//
// Gestreamt werden Daten, nicht Bilder: Die Brille rechnet selbst und lädt nur
// die Kacheln, die ihr Blickfeld in der nötigen Feinheit braucht. Deshalb
// gehen auch große Modelle, und es braucht keinen Export. Dasselbe gilt für die
// Welt drumherum — Gelände, Luftbild, Nachbargebäude (vr-welt.js).
//
// Zwei Arten, ein Modell zu betreten
// ==================================
//   1:1    immersive-vr — gehen, springen, drehen; Boden und Himmel kommen
//          von hier, die Unterkante des Modells steht auf dem Boden
//   Tisch  immersive-ar — verkleinert auf Tischhöhe, der Raum ringsum bleibt
//          über die Kameras der Quest 3 sichtbar; greifen, drehen, skalieren
//
// Das Tablet
// ==========
// An der linken Hand hängt ein Tablet (vr-tablet.js, Seiten in vr-seiten.js):
// Info zum gewählten Bauteil samt Property-Sets aus dem Backend, Ebenen
// (Klassen und Geschosse ein-/ausblenden, vr-ebenen.js), Welt, Minikarte,
// Werkzeuge (Messen, Höhenschnitt) und Hilfe. Der Strahl der rechten Hand
// tippt darauf. Am Bildschirm steht dieselbe Leinwand rechts neben der Szene.
//
// Die Rechnungen (Startabstand, Landeplätze, Sticks, Kacheln, Filter, Texte)
// stehen in vr-rechnen.js und sind dort ohne Brille geprüft.

// Volle Adressen statt nackter Namen: Vite schreibt `import … from 'three'`
// um und sucht es in node_modules, wo es nicht liegt. Die Bibliotheken selbst
// importieren `three` nackt — das löst die Import-Map in vr.html auf. Beide
// Stellen müssen dieselbe Version nennen, sonst gibt es three.js zweimal.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/webxr/XRControllerModelFactory.js';
import { RoomEnvironment } from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/environments/RoomEnvironment.js';
import { DRACOLoader } from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/meshopt_decoder.module.js';
import { TilesRenderer, Scheduler, PriorityQueue, unifiedPriorityCallback } from 'https://cdn.jsdelivr.net/npm/3d-tiles-renderer@0.5.3/build/index.js';
import { GLTFExtensionsPlugin } from 'https://cdn.jsdelivr.net/npm/3d-tiles-renderer@0.5.3/build/index.plugins.js';
import { splatErweiterungen, splatEntsorgen, sichtbareSplats, fehlerNachfuehren } from './vr-splat.js';
import { weltAnlegen, kartenKachel, SOHLE } from './vr-welt.js';
import { ebenenAnlegen, bauteilNachzeichnen } from './vr-ebenen.js';
import { TabletUI, TABLET_PX } from './vr-tablet.js';
import { tabletZeichnen } from './vr-seiten.js';
import { gemeinsamAnlegen } from './vr-gemeinsam.js';
import { filterAusDaten, filterAlsDaten } from './vr-gemeinsam-rechnen.js';
import {
  VR_FAEHIG, backendBasis, startAbstand, tischMassstab, begehbar, punktBegehbar,
  totzone, schrittDrehung, schwebeFolgen, bauteilZeilen, filterLeer, eigenschaftsGruppen, wertText,
  messung, meterText, STUFE, bodenNachfuehren, flugSchritt, fussRechteck, imFuss, inDeutschland, meterProPixel,
} from './vr-rechnen.js';
import {
  Messung, budgetMs, leistungZeilen, xrTakt, TexturRegister, kachelStand,
  GueteRegler, DruckRegler, PufferRegler, ParseTor, Einblender, aktualisierenSoll,
} from './vr-leistung.js';
import { texturErweiterung, geteiltPlugin } from './vr-texturen.js';

// ─────────────────────────────────────────────────────────────────
// EINSTELLUNGEN
// ─────────────────────────────────────────────────────────────────

const AKZENT = 0x97bf0d;
const HORIZONT = 0xdbe5ec;

// Zulässiger Bildschirmfehler je Kachel in Pixeln. In der Brille gröber: die
// Quest rechnet zwei Bilder mit 72–90 Hz auf einem Handy-Grafikchip.
const FEHLER_ZIEL = { vorschau: 8, brille: 18 };

// Splats, die gleichzeitig gezeichnet werden. Die Quest sortiert und blendet sie
// für zwei Augen in jedem Bild; um 1 Mio. hält sie 72 Hz, mehr wird zäh. Über
// dem Haushalt wächst der zulässige Fehler (vr-splat.js → fehlerNachfuehren).
const SPLAT_HAUSHALT = { vorschau: 4_000_000, brille: 1_500_000 };
// So fein darf der Fehlerwert bei Splats werden, solange der Haushalt reicht.
const SPLAT_FEHLER_MIN = 0.25;

// Speicher für geladene Kacheln. Der Browser der Quest 3 bekommt von den 8 GB
// nur einen Teil; darüber hinaus wirft er den Tab weg. Das ist der Speicher
// des Modells (DEFAULT_LRU_CACHE der Bibliothek); die Welt hat einen eigenen
// mit eigenen Warteschlangen (vr-welt.js), zusammen unter 900 MB.
// Die untere Grenze führt der PufferRegler: nahe an der oberen, damit Gesehenes
// (hinter dem Kopf, Punktwolken, Bauteile) stehen bleibt; bei Bildratenlag sinkt
// sie, dann geht das am längsten Ungesehene, also Entfernteste, zuerst.
// `?cache=<MB>` stellt die obere Grenze zum Ausprobieren auf der Quest um.
const CACHE_MAX = (() => {
  const mb = Number(new URLSearchParams(location.search).get('cache'));
  return (mb >= 150 && mb <= 2000 ? mb : 600) * 2 ** 20;
})();
const CACHE_MIN = Math.round(CACHE_MAX * 0.9);

// Längste Kante eingebetteter JPEG-Texturen. Die Kacheln der IFC-Modelle bringen
// 512²-Bilder mit, die sich teilen lassen (vr-texturen.js) und darunter bleiben;
// die Grenze greift bei Fotos eines Netzes, wo jede Kachel ein eigenes 4096²-Bild
// trägt (64 MB dekodiert, je Bild).
const TEXTUR_KANTE = { vorschau: 2048, brille: 1024 };
const texturRegister = new TexturRegister();
// `?texturen=0` schaltet das Teilen aus (Vergleich mit dem Weg der Bibliothek)
const TEXTUREN_TEILEN = new URLSearchParams(location.search).get('texturen') !== '0';

// Leistung (vr-leistung.js). Jeder Teil lässt sich in der Adresse abschalten
// (`?guete=0&druck=0&takt=0&parse=0&einblenden=0`), um Vorher und Nachher zu messen.
const SCHALTER = Object.fromEntries(['guete', 'druck', 'takt', 'parse', 'einblenden']
  .map(n => [n, new URLSearchParams(location.search).get(n) !== '0']));

// Entpacken: höchstens so viele Kacheln zugleich, und eine neue je Bild (ParseTor)
const PARSE_PARALLEL = 3;

// Die Regler geben Detail schneller zurück als ihre Vorgaben: sonst blieb das Modell
// minutenlang gröber, nachdem der Engpass längst vorbei war.
const guete = new GueteRegler({ ruhig: 2 });  // Fehlerfaktor nach der Bildzeit (nur in der Brille)
const druck = new DruckRegler({ entspannMs: 4000, rueckfallMs: 15000, maxEntspannMs: 20000 });  // nach dem Speicher (überall)
const puffer = new PufferRegler();     // untere Grenze des Kachelspeichers
const parseTor = new ParseTor({ reserveMs: 3, hungerMs: 100 });
const einblender = new Einblender({ proBild: 1, hungerMs: 50 });
let fehlerFaktor = 1;                  // Faktor, der gerade im Fehlerziel des Modells steckt
let weltFaktoren = new WeakMap();      // dasselbe je Baum der Welt
let bildNr = 0;
let letzterAbstand = null;             // ms zum vorigen Bild
let letzteSchleife = 0;                // ms Rechenzeit der Schleife im vorigen Bild
let druckPruefung = 0;

const SPRINT = 4;           // Faktor bei gedrücktem linken Stick
const HEBEN = 1.5;          // m/s, rechter Stick hoch/runter
const PUNKTGROESSE = 0.02;  // m, Punktwolken in der Welt
const ROLLEN = 900;         // px/s, rechter Stick auf dem Tablet

// Mit Welt reicht die Sicht bis zum Horizont; Dunst ab einigen Kilometern
// verdeckt, wo die Kacheln grob werden.
const SICHT = { nah: 0.05, fern: 20000, fernWelt: 80000, dunstVon: 2500, dunstBis: 45000 };

// Das Tablet: 26 cm breit, über der Hand, zum Gesicht gekippt. Lage im
// Griff-Raum der Quest (−z nach vorn, +y aus dem Griff nach oben).
const TABLET_BREITE = 0.26;
const TABLET_LAGE = { x: 0.03, y: 0.11, z: -0.04, kippen: -0.85 };

// Ohne Controller (Vision Pro, Hände der Quest) schwebt das Tablet links unten
// vor dir und folgt erst, wenn man sich weiter als `folgeAb` wegdreht. Größer
// als in der Hand: mit dem Blick wird gezielt, und Apple rät zu Zielen ab
// etwa 60 pt — ein 60-px-Knopf steht so bei gut 2,3°.
const TABLET_SCHWEBE = { abstand: 0.75, seite: -0.30, tiefer: 0.38, groesse: 2.4, folgeAb: 0.8 };

// Blick + Kneifen (Vision Pro): Kneifen kommt als `transient-pointer`, mit
// Handtracking HINTER den beiden Händen (Index 2, 3) — die Hände selbst liefern
// nur ihre Lage. three.js verwirft Eingaben ohne freien Controller („If all
// controllers do currently receive input we ignore new ones"), also vier.
const STEUERUNGEN = 4;
const LANG_KNEIFEN = 550;     // ms: so lange gekniffen zeigt die Info statt zu springen
const ZUG_SCHWELLE = 14;      // Tablet-Pixel: ab hier ist Kneifen auf dem Tablet Rollen statt Tippen

// xr-standard-Belegung der Touch-Controller
const KNOPF = { stick: 3, unten: 4, oben: 5 };   // unten = A/X, oben = B/Y

const PARAMETER = new URLSearchParams(location.search);

// In iLEEN eingebettet (vr-fenster.js): Marke ohne Link — er führte im iframe
// wieder auf iLEEN —, Platz für den ✕ der Ebene.
if (PARAMETER.has('eingebettet')) document.body.classList.add('eingebettet');

const $ = id => document.getElementById(id);
const el = {
  szene: $('vrSzene'),
  liste: $('vrListe'),
  suche: $('vrSuche'),
  status: $('vrStatus'),
  titel: $('vrTitel'),
  fortschritt: $('vrFortschritt'),
  knopfVR: $('vrKnopfVR'),
  knopfTisch: $('vrKnopfTisch'),
  hinweis: $('vrHinweis'),
  boden: $('vrBoden'),
  tablet: $('vrTablet'),
  verbinden: $('vrVerbinden'),
};

// ─────────────────────────────────────────────────────────────────
// ZUSTAND
// ─────────────────────────────────────────────────────────────────

const backend = backendBasis(
  (() => { try { return localStorage.getItem('ileen_backend_url'); } catch { return null; } })(),
  window.ILEEN_CONFIG && window.ILEEN_CONFIG.backendUrl,
  { host: location.hostname, protokoll: location.protocol, ursprung: location.origin },
);

const SPEICHER = 'ileen_vr_einstellungen';
const gespeichert = (() => {
  try { return JSON.parse(localStorage.getItem(SPEICHER) || '{}') || {}; } catch { return {}; }
})();

const zustand = {
  modus: 'vorschau',          // 'vorschau' | 'vr' | 'tisch'
  job: null,
  name: '',
  art: '',                    // content_type des Modells
  ausgerichtet: false,
  kasten: new THREE.Box3(),   // Modell im lokalen Rahmen: Mitte x/z = 0, Unterkante y = 0
  fuss: null,                 // gedrehtes Grundrissrechteck (vr-rechnen.js → fussRechteck)
  ort: null,                  // { lat, lon } Bogenmaß, Grundrissmitte — null: nicht verortet
  rahmen: new THREE.Matrix4(),        // Erdsystem → Modellrahmen
  rahmenInvers: new THREE.Matrix4(),
  ellipsoid: null,
  xr: { vr: false, ar: false },
  tischPlatzieren: 0,         // Bilder bis zum Platzieren des Tischmodells
  vorschauPose: null,
  assets: [],
  modellSichtbar: true,
  raster: gespeichert.raster ?? true,
  // Ohne eigene Wahl tritt das Raster zurück, sobald Gelände trägt
  rasterAuto: gespeichert.raster === undefined,
};

const werkzeug = {
  messen: false,
  punkte: [],                 // Messpunkte im Modellrahmen
  messung: null,
  schnitt: { an: false, hoehe: 3 },
  bodenFolgen: gespeichert.bodenFolgen ?? true,
  tempo: gespeichert.tempo ?? 1.4,          // m/s
  drehschritt: gespeichert.drehschritt ?? 30,
  flugweite: [2, 6, 15].includes(gespeichert.flugweite) ? gespeichert.flugweite : 6,   // Weg je Handweg beim Ziehen in der Luft
  tabletHand: ['left', 'right', 'schweben'].includes(gespeichert.tabletHand) ? gespeichert.tabletHand : 'left',
};

// Das schwebende Tablet: Gierwinkel und Höhe im Rahmen des Nutzers
const schwebe = { an: false, neu: 0, gier: 0, hoehe: 1.5, folgt: false };

const tablet = {
  seite: gespeichert.seite || 'hilfe',
  ebenenArt: 'klassen',
  offen: new Set(),
  sichtbar: true,             // in der Brille
  karteZoom: gespeichert.karteZoom ?? 18,
  karteArt: gespeichert.karteArt || 'karte',
  karteMitte: 'ich',
};

let auswahl = null;           // { titel, name, quelle, guid, kopf, eigenschaften }

function speichern() {
  try {
    localStorage.setItem(SPEICHER, JSON.stringify({
      raster: zustand.rasterAuto ? undefined : zustand.raster, bodenFolgen: werkzeug.bodenFolgen, tempo: werkzeug.tempo,
      drehschritt: werkzeug.drehschritt, flugweite: werkzeug.flugweite, tabletHand: werkzeug.tabletHand, seite: tablet.seite,
      karteZoom: tablet.karteZoom, karteArt: tablet.karteArt,
      welt: (({ an, karte, relief, gebaeudeAn }) => ({ an, karte, relief, gebaeudeAn }))(welt.zustand),
    }));
  } catch { /* privates Fenster */ }
}

// ─────────────────────────────────────────────────────────────────
// SZENE
// ─────────────────────────────────────────────────────────────────

// Safari auf der Vision Pro verliert Kontexte, die 'high-performance' verlangen
// (getShaderPrecisionFormat liefert dann null). Erst probieren, sonst Vorgabe.
function gpuWahl() {
  try {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2', { powerPreference: 'high-performance' });
    const ok = !!g && !g.isContextLost() && !!g.getShaderPrecisionFormat(g.VERTEX_SHADER, g.HIGH_FLOAT);
    if (g) { const x = g.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); }
    return ok ? 'high-performance' : 'default';
  } catch (e) { return 'default'; }
}
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: gpuWahl() });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.localClippingEnabled = true;   // Höhenschnitt, nur an Modellmaterialien
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
el.szene.appendChild(renderer.domElement);

const szene = new THREE.Scene();
const himmel = himmelTextur();
szene.background = himmel;
const dunst = new THREE.Fog(HORIZONT, SICHT.dunstVon, SICHT.dunstBis);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  szene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  szene.environmentIntensity = 0.6;
  pmrem.dispose();
}
szene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f80, 1.2));
const sonne = new THREE.DirectionalLight(0xffffff, 1.6);
sonne.position.set(0.4, 1, 0.7);   // aus Südost, x = Ost, z = Süd
szene.add(sonne);

/** Himmel als Verlauf (Zenit blau, Horizont hell, darunter dunstig) — als
 *  Rundumbild, damit er in beiden Augen und jeder Blickrichtung stimmt. */
function himmelTextur() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const g = c.getContext('2d');
  const v = g.createLinearGradient(0, 0, 0, 512);
  v.addColorStop(0, '#7fa6cf');
  v.addColorStop(0.42, '#c3d6e6');
  v.addColorStop(0.5, '#dbe5ec');
  v.addColorStop(0.56, '#cfd6cc');
  v.addColorStop(1, '#9aa28f');
  g.fillStyle = v;
  g.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Boden auf Höhe der Unterkante des Modells — knapp darunter, damit eine
// Bodenplatte auf y = 0 nicht mit ihm flimmert. Das Raster (1 m fein, 10 m
// kräftig) ist eine Textur statt Linien: die Mipmaps lassen die feinen Linien
// in der Ferne von selbst verblassen, Linien gäben dort ein Moiré-Band.
// Mit Gelände tritt es zurück: dann trägt die Welt.
const RASTER_M = 10;
const boden = new THREE.Mesh(
  new THREE.CircleGeometry(1, 96),
  new THREE.MeshStandardMaterial({ map: rasterTextur(), roughness: 1 }),
);
boden.rotation.x = -Math.PI / 2;
boden.position.y = -0.01;
szene.add(boden);
bodenRadius(300);

function rasterTextur() {
  const n = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.fillStyle = '#9aa28f';
  g.fillRect(0, 0, n, n);
  g.strokeStyle = 'rgba(70, 80, 62, 0.35)';
  g.lineWidth = 2;
  for (let i = 1; i < RASTER_M; i++) {
    const p = Math.round(i * n / RASTER_M) + 0.5;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, n); g.moveTo(0, p); g.lineTo(n, p); g.stroke();
  }
  g.strokeStyle = 'rgba(60, 70, 52, 0.6)';
  g.lineWidth = 6;
  g.strokeRect(0, 0, n, n);   // halb auf jeder Kachel: zusammen eine kräftige Linie
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

/** Radius in ganzen 10-m-Schritten, damit eine kräftige Linie durch den
 *  Ursprung läuft (die Kreis-UVs haben ihre Mitte bei 0,5). */
function bodenRadius(r) {
  const radius = Math.ceil(r / RASTER_M) * RASTER_M;
  boden.scale.setScalar(radius);
  boden.material.map.repeat.setScalar(2 * radius / RASTER_M);
}

// Der Nutzer: Kamera und Hände hängen daran. Springen und Drehen bewegen ihn,
// nicht die Welt — so bleibt das Modell, wo es ist, und die Kachelauswahl
// rechnet im selben Rahmen weiter.
const nutzer = new THREE.Group();
szene.add(nutzer);
const kamera = new THREE.PerspectiveCamera(60, 1, SICHT.nah, SICHT.fern);
nutzer.add(kamera);

// Das Modell: im 1:1-Modus unverändert, im Tischmodus verkleinert und
// verschoben. Darin `tiles.group` mit dem Rahmen ECEF → lokal, und die Welt.
const modell = new THREE.Group();
szene.add(modell);

const orbit = new OrbitControls(kamera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
kamera.position.set(30, 25, 40);

// ─────────────────────────────────────────────────────────────────
// WELT UND EBENEN
// ─────────────────────────────────────────────────────────────────

const welt = weltAnlegen({ modell, meldung: text => status(text) });
{
  const w = gespeichert.welt || {};
  const aus = PARAMETER.get('welt') === '0';
  welt.setzen({
    an: aus ? false : (w.an ?? true),
    karte: w.karte || 'luftbild',
    relief: w.relief ?? true,
    gebaeudeAn: w.gebaeudeAn ?? true,
  });
}
const ebenen = ebenenAnlegen();

function bodenSichtbarkeit() {
  boden.visible = zustand.modus !== 'tisch' && zustand.raster;
}

/** Himmel, Dunst und Sichtweite je nach Modus und Welt. */
function sichtSetzen() {
  const tisch = zustand.modus === 'tisch';
  const mitWelt = welt.renderer().length > 0;
  szene.background = tisch ? null : himmel;
  szene.fog = !tisch && mitWelt ? dunst : null;
  kamera.far = mitWelt ? SICHT.fernWelt : SICHT.fern;
  kamera.updateProjectionMatrix();
}

// ─────────────────────────────────────────────────────────────────
// KACHELN
// ─────────────────────────────────────────────────────────────────

function addonUrl(pfad) {
  return `https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/${pfad}`;
}
// Für alle Modelle dieselben Decoder; `autoDispose: false` unten, sonst wären
// sie nach dem ersten Modellwechsel beendet.
const draco = new DRACOLoader().setDecoderPath(addonUrl('libs/draco/gltf/'));
const ktx2 = new KTX2Loader().setTranscoderPath(addonUrl('libs/basis/')).detectSupport(renderer);

let tiles = null;
const punktStoffe = new Set();

// Höhenschnitt: eine Ebene, an allen Materialien des Modells dasselbe Feld.
// Leer heißt aus; three.js baut die Shader um, wenn sich die Zahl ändert.
const schnittEbene = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
const schnittEbenen = [];

function entladen() {
  markierungWeg();
  if (!tiles) return;
  modell.remove(tiles.group);
  tiles.dispose();
  tiles = null;
  punktStoffe.clear();
  zustand.ausgerichtet = false;
}

/**
 * In der Brille wird nicht umgeschaltet — außer die Gruppe sieht ein anderes
 * Modell und man wechselt im Tablet dorthin (`inSitzung`). `vonGruppe`: das
 * Modell kommt von den anderen und wird nicht als neues gemeldet.
 */
function ladeModell(job, name, { inSitzung = false, vonGruppe = false } = {}) {
  if (renderer.xr.isPresenting && !inSitzung) return;
  entladen();
  zustand.job = job;
  zustand.name = name || job;
  const asset = zustand.assets.find(a => a.job_id === job);
  zustand.art = asset ? asset.content_type : '';
  el.titel.textContent = zustand.name;
  auswahlSetzen(null);
  ebenen.leeren();
  werkzeug.punkte = [];
  werkzeug.messung = null;
  messungZeichnen();
  zustand.modellSichtbar = true;
  status(`Lade ${zustand.name} …`);
  listeZeichnen();

  const url = new URL(location.href);
  url.searchParams.set('job', job);
  history.replaceState(null, '', url);

  tiles = new TilesRenderer(`${backend}/tiles/${encodeURIComponent(job)}/tileset.json`);
  tiles.registerPlugin(new GLTFExtensionsPlugin({
    dracoLoader: draco, ktxLoader: ktx2, meshoptDecoder: MeshoptDecoder, autoDispose: false,
    plugins: [
      ...splatErweiterungen({ renderer, szene }),
      ...(TEXTUREN_TEILEN ? [texturErweiterung({
        THREE, register: texturRegister,
        kante: () => (renderer.xr.isPresenting ? TEXTUR_KANTE.brille : TEXTUR_KANTE.vorschau),
      })] : []),
    ],
  }));
  if (TEXTUREN_TEILEN) tiles.registerPlugin(geteiltPlugin());
  // Auch mitten in einer Sitzung (Modellwechsel der Gruppe): dort gilt das Ziel der Brille
  tiles.errorTarget = renderer.xr.isPresenting ? FEHLER_ZIEL.brille : FEHLER_ZIEL.vorschau;
  tiles.lruCache.minBytesSize = CACHE_MIN;
  tiles.lruCache.maxBytesSize = CACHE_MAX;
  puffer.zuruecksetzen();
  faktorenZuruecksetzen();
  einblender.alleFreigeben();
  if (SCHALTER.parse) {
    // Eigene Warteschlange zum Entpacken, die die Schleife selbst antreibt
    // (parseTreiben): eine neue Kachel je Bild und nur mit Budget. Die der
    // Bibliothek startet bis zu fünf zugleich, und die kommen auch zugleich an.
    const q = new PriorityQueue();
    q.maxJobs = PARSE_PARALLEL;
    q.autoUpdate = false;
    q.priorityCallback = unifiedPriorityCallback;
    tiles.parseQueue = q;
  }
  tiles.addEventListener('load-root-tileset', ausrichten);
  tiles.addEventListener('load-model', ({ scene, tile }) => {
    vorbereiten(scene);
    ebenen.kachelGeladen(scene);
    gemeinsam.kachelGeladen(scene);
    // In der Brille nacheinander zum ersten Mal zeichnen (Einblender). Nur additive
    // Verfeinerung: eine Kachel, die ihre Eltern ersetzt, hinterließe ein Loch.
    if (SCHALTER.einblenden && renderer.xr.isPresenting && tile && tile.refine === 'ADD') einblender.ankunft(scene);
    ui.schmutzig = true;
  });
  tiles.addEventListener('dispose-model', ({ scene }) => {
    einblender.entfernen(scene);
    splatEntsorgen(scene);
    ebenen.kachelEntladen(scene);
    scene.traverse(o => { if (o.isPoints) punktStoffe.delete(o.material); });
  });
  tiles.addEventListener('load-error', ({ error, url: kachel }) => {
    console.warn('VR: Kachel nicht ladbar', kachel, error);
    if (!zustand.ausgerichtet) status(`Modell nicht ladbar: ${error && error.message || error}`, 'fehler');
  });
  tiles.addEventListener('tiles-load-end', () => {
    if (zustand.ausgerichtet && zustand.modus === 'vorschau') status('Bereit');
  });
  modell.add(tiles.group);
  gemeinsam.modellGeladen(job, zustand.name, vonGruppe);
}

function vorbereiten(kachel) {
  kachel.traverse(o => {
    // PNTS kommt mit `new PointsMaterial()`: 1 m große Punkte.
    if (o.isPoints) {
      o.material.sizeAttenuation = true;
      o.material.size = PUNKTGROESSE * modell.scale.x;
      punktStoffe.add(o.material);
    }
    // Spark zeichnet Splats mit eigenem Shader, der keine Schnittebenen kennt.
    const stoffe = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of stoffe) if (!m.isShaderMaterial) m.clippingPlanes = schnittEbenen;
  });
}

/**
 * Den Rahmen setzen, sobald die Wurzel des Tilesets da ist.
 *
 * Die Kacheln liegen georeferenziert im Erdmittelpunkt-System (ECEF). Für die
 * Brille braucht es ein lokales: x = Ost, y = oben, z = Süd (also −z Nord, wie
 * three.js nach vorn schaut). Ursprung ist die Mitte des Grundrisses auf der
 * Unterkante — dann steht man im 1:1-Modus auf y = 0 neben dem Gebäude und
 * das Tischmodell steht mit derselben Stelle auf dem Tisch.
 */
function ausrichten() {
  const gruppe = tiles.group;
  gruppe.position.set(0, 0, 0);
  gruppe.quaternion.identity();
  gruppe.scale.set(1, 1, 1);

  const kugel = new THREE.Sphere();
  if (!tiles.getBoundingSphere(kugel)) return;

  const yOben = new THREE.Matrix4().makeRotationX(-Math.PI / 2);   // z-oben → y-oben
  const rahmen = new THREE.Matrix4();
  const minRadius = Math.min(...tiles.ellipsoid.radius);
  const verortet = kugel.center.length() > minRadius * 0.5;
  if (verortet) {
    const geo = {};
    tiles.ellipsoid.getPositionToCartographic(kugel.center, geo);
    const enu = tiles.ellipsoid.getEastNorthUpFrame(geo.lat, geo.lon, geo.height, new THREE.Matrix4());
    rahmen.copy(enu).invert().premultiply(yOben);
  } else {
    // Nicht verortet (z. B. ein GLB ohne Platzierung): z ist oben.
    rahmen.makeTranslation(-kugel.center.x, -kugel.center.y, -kugel.center.z).premultiply(yOben);
  }

  // Kasten der Wurzel im neuen Rahmen — dazu die Ecken und Achsen für den Grundriss
  const obb = new THREE.Box3();
  const obbMatrix = new THREE.Matrix4();
  const kasten = new THREE.Box3();
  const ecken = [];
  let achsen = null;
  if (tiles.getOrientedBoundingBox(obb, obbMatrix)) {
    const m = rahmen.clone().multiply(obbMatrix);
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? obb.max.x : obb.min.x, i & 2 ? obb.max.y : obb.min.y, i & 4 ? obb.max.z : obb.min.z);
      p.applyMatrix4(m);
      kasten.expandByPoint(p);
      ecken.push(p.toArray());
    }
    const ax = new THREE.Vector3();
    const ay = new THREE.Vector3();
    const az = new THREE.Vector3();
    m.extractBasis(ax, ay, az);
    achsen = [ax, ay, az].map(a => a.normalize().toArray());
  } else {
    kasten.setFromCenterAndSize(kugel.center.clone().applyMatrix4(rahmen), new THREE.Vector3().setScalar(kugel.radius * 2));
    for (let i = 0; i < 8; i++) {
      ecken.push([i & 1 ? kasten.max.x : kasten.min.x, i & 2 ? kasten.max.y : kasten.min.y, i & 4 ? kasten.max.z : kasten.min.z]);
    }
  }

  const verschub = new THREE.Vector3(
    -(kasten.min.x + kasten.max.x) / 2, -kasten.min.y, -(kasten.min.z + kasten.max.z) / 2,
  );
  rahmen.premultiply(new THREE.Matrix4().makeTranslation(verschub.x, verschub.y, verschub.z));
  kasten.translate(verschub);
  for (const e of ecken) { e[0] += verschub.x; e[1] += verschub.y; e[2] += verschub.z; }
  rahmen.decompose(gruppe.position, gruppe.quaternion, gruppe.scale);
  gruppe.updateMatrixWorld(true);

  zustand.kasten.copy(kasten);
  zustand.rahmen.copy(rahmen);
  zustand.rahmenInvers.copy(rahmen).invert();
  zustand.ellipsoid = tiles.ellipsoid;
  zustand.fuss = fussRechteck(ecken, achsen);
  zustand.ort = null;
  if (verortet) {
    const mitte = new THREE.Vector3(zustand.fuss.cx, 0, zustand.fuss.cz).applyMatrix4(zustand.rahmenInvers);
    const geo = {};
    tiles.ellipsoid.getPositionToCartographic(mitte, geo);
    zustand.ort = { lat: geo.lat, lon: geo.lon };
  }
  zustand.ausgerichtet = true;

  const groesse = kasten.getSize(new THREE.Vector3());
  bodenRadius(Math.max(300, 3 * Math.max(groesse.x, groesse.z)));
  welt.einrichten({ rahmen, ellipsoid: tiles.ellipsoid, ort: zustand.ort, fuss: zustand.fuss })
    .then(() => { rasterAutomatisch(); sichtSetzen(); ui.schmutzig = true; });
  vorschauEinrichten(groesse);
  // Kam das Modell erst nach dem Betreten der Brille (Start aus iLEEN): jetzt
  // Start und Tischmaßstab setzen.
  if (renderer.xr.isPresenting) modusEinrichten();
  gemeinsam.modellBereit();
  knoepfeAktualisieren();
  status('Lädt Kacheln …');
  ui.schmutzig = true;
}

function vorschauEinrichten(groesse) {
  const d = Math.max(groesse.x, groesse.y, groesse.z, 5);
  orbit.target.set(0, groesse.y * 0.4, 0);
  kamera.position.set(d * 0.8, groesse.y * 0.6 + d * 0.5, d * 1.1);
  kamera.near = Math.max(SICHT.nah, d / 5000);
  kamera.updateProjectionMatrix();
  orbit.update();
}

/** Alle TilesRenderer der Szene: Modell und Welt. */
function alleKacheln() {
  return tiles ? [tiles, ...welt.renderer()] : welt.renderer();
}

/**
 * Das Fehlerziel eines Baums um den Faktor `soll` gegenüber dem zuletzt
 * angewandten verschieben. Verhältnis statt Zuweisung: das Ziel hat noch andere
 * Schreiber (Splat-Haushalt, Welt), und die dürfen ihren Stand behalten.
 */
function faktorAnwenden(t, soll, alt) {
  if (soll !== alt) t.errorTarget *= soll / alt;
  return soll;
}

function faktorenZuruecksetzen() {
  guete.zuruecksetzen();
  druck.zuruecksetzen();
  fehlerFaktor = 1;
  weltFaktoren = new WeakMap();
}

function fehlerFaktorenAnwenden() {
  const bildzeit = renderer.xr.isPresenting && SCHALTER.guete ? guete.faktor : 1;
  if (tiles) fehlerFaktor = faktorAnwenden(tiles, Math.max(bildzeit, SCHALTER.druck ? druck.faktor : 1), fehlerFaktor);
  for (const t of welt.renderer()) weltFaktoren.set(t, faktorAnwenden(t, bildzeit, weltFaktoren.get(t) || 1));
}

function kachelnAktualisieren() {
  const xr = renderer.xr;
  const xrKamera = xr.getCamera();
  welt.bild();
  fehlerFaktorenAnwenden();
  const baeume = alleKacheln();
  let durchlauf = 0;         // ms für die Durchläufe der Kachelbäume in diesem Bild (ohne Kamera, Rahmen …)
  for (let i = 0; i < baeume.length; i++) {
    const t = baeume[i];
    if (xr.isPresenting) {
      const auge = xrKamera.cameras[0];
      // Im ersten Bild hat die XR-Kamera noch keine Projektion.
      if (!auge || !(auge.viewport.w > 0)) return;
      if (t.hasCamera(kamera)) t.deleteCamera(kamera);
      t.setCamera(xrKamera);
      t.setResolution(xrKamera, auge.viewport.z, auge.viewport.w);
    } else {
      if (t.hasCamera(xrKamera)) t.deleteCamera(xrKamera);
      t.setCamera(kamera);
      t.setResolutionFromRenderer(kamera, renderer);
      kamera.updateMatrixWorld();
    }
    // In der Brille wechseln sich die Bäume ab (aktualisierenSoll); was zu sehen war, bleibt stehen
    if (!SCHALTER.takt || aktualisierenSoll(bildNr, i, baeume.length, xr.isPresenting)) {
      const t0 = performance.now();
      t.update();
      durchlauf += performance.now() - t0;
    }
  }
  leistungsMessung.durchlaufZeit(durchlauf);
  if (tiles) splatHaushalt();
}

/** Alle halbe Sekunde: Fehlerwert an die Zahl sichtbarer Splats anpassen. */
let splatPruefung = 0;
function splatHaushalt() {
  const jetzt = performance.now();
  if (jetzt - splatPruefung < 500) return;
  splatPruefung = jetzt;
  const haushalt = renderer.xr.isPresenting ? SPLAT_HAUSHALT.brille : SPLAT_HAUSHALT.vorschau;
  const sichtbar = sichtbareSplats(tiles);
  tiles.errorTarget = sichtbar
    ? fehlerNachfuehren(tiles.errorTarget, SPLAT_FEHLER_MIN, sichtbar, haushalt, !(tiles.loadProgress < 1))
    : (renderer.xr.isPresenting ? FEHLER_ZIEL.brille : FEHLER_ZIEL.vorschau) * fehlerFaktor;
}

function ladestand() {
  const p = tiles ? tiles.loadProgress : 1;
  return Math.min(Number.isFinite(p) ? p : 1, welt.fortschritt());
}

// ─────────────────────────────────────────────────────────────────
// TAFELN — Text im Raum (Messwert)
// ─────────────────────────────────────────────────────────────────

function baueTafel(breitePx, hoehePx, breiteM) {
  const canvas = document.createElement('canvas');
  canvas.width = breitePx;
  canvas.height = hoehePx;
  const textur = new THREE.CanvasTexture(canvas);
  textur.colorSpace = THREE.SRGBColorSpace;
  textur.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(breiteM, breiteM * hoehePx / breitePx),
    // Ohne Tiefentest: eine Tafel, die in der Wand steckt, ist unlesbar.
    new THREE.MeshBasicMaterial({ map: textur, transparent: true, depthTest: false, toneMapped: false, fog: false }),
  );
  mesh.renderOrder = 10;
  mesh.raycast = () => {};
  mesh.visible = false;
  return { mesh, canvas, ctx: canvas.getContext('2d'), textur };
}

// ─────────────────────────────────────────────────────────────────
// BAUTEILE — Batch Table lesen, Bauteil hervorheben, Eigenschaften holen
// ─────────────────────────────────────────────────────────────────

const markierStoff = new THREE.MeshBasicMaterial({
  color: AKZENT, transparent: true, opacity: 0.55, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  side: THREE.DoubleSide, toneMapped: false, fog: false,
});
markierStoff.clippingPlanes = schnittEbenen;
let markierungen = [];

function markierungWeg() {
  for (const m of markierungen) {
    m.removeFromParent();
    m.geometry.dispose();
  }
  markierungen = [];
}

/** Bauteil zu einem Treffer: `_BATCHID` am getroffenen Dreieck, die Zeile dazu
 *  aus der Batch Table der Kachel (siehe backend/tiling/formats/ifc.py). */
function bauteilAus(treffer) {
  const o = treffer && treffer.object;
  const ids = o && o.geometry && o.geometry.getAttribute('_batchid');
  if (!ids || !treffer.face) return null;
  let wurzel = o;
  while (wurzel && !wurzel.batchTable) wurzel = wurzel.parent;
  if (!wurzel) return null;
  const id = Math.round(ids.getX(treffer.face.a));
  const daten = wurzel.batchTable.getDataFromId(id, {});
  return { id, wurzel, daten, zeilen: bauteilZeilen(daten), welt: welt.gehoertDazu(o), punkt: treffer.point.clone() };
}

/** Das Bauteil in allen Primitives seiner Kachel nachzeichnen (vr-ebenen.js). */
function markiere({ id, wurzel }) {
  markierungWeg();
  markierungen = bauteilNachzeichnen(wurzel, id, markierStoff);
}

const eigenschaftenVorrat = new Map();   // job/guid → Promise<Gruppen | 'fehlt'>

function eigenschaftenLaden(guid) {
  const schluessel = `${zustand.job}/${guid}`;
  if (!eigenschaftenVorrat.has(schluessel)) {
    eigenschaftenVorrat.set(schluessel, fetch(`${backend}/assets/${encodeURIComponent(zustand.job)}/elements/${encodeURIComponent(guid)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(e => {
        const g = eigenschaftsGruppen(e);
        return g.length ? g : 'fehlt';
      })
      .catch(() => 'fehlt'));
  }
  return eigenschaftenVorrat.get(schluessel);
}

/** Die Auswahl setzen (oder mit null aufheben) — vom Strahl wie von der Maus. */
function auswahlSetzen(info) {
  if (!info) {
    auswahl = null;
    markierungWeg();
    gemeinsam.auswahlMelden(null);
    ui.schmutzig = true;
    return;
  }
  markiere(info);
  const z = info.zeilen;
  if (info.welt) {
    // Ein Nachbargebäude aus LoD2: dessen Batch Table, so wie sie kommt
    const zeilen = Object.entries(info.daten || {})
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
      .map(([k, v]) => [k, wertText(v)]);
    auswahl = {
      titel: 'Nachbargebäude', name: 'amtlicher Bestand (LoD2)', quelle: 'welt', guid: '',
      kopf: [], eigenschaften: zeilen.length ? [{ titel: 'basemap.de 3D', zeilen }] : 'fehlt',
    };
    tablet.offen.add('basemap.de 3D');
  } else {
    const kopf = [];
    if (z.typ) kopf.push(['Typ', z.typ]);
    if (z.geschoss) kopf.push(['Geschoss', z.geschoss]);
    if (z.guid) kopf.push(['GlobalId', z.guid]);
    auswahl = { titel: z.titel, name: z.name, quelle: 'modell', guid: z.guid, kopf, eigenschaften: z.guid ? 'laedt' : 'fehlt' };
    if (z.guid) {
      const diese = auswahl;
      eigenschaftenLaden(z.guid).then(g => {
        if (auswahl !== diese) return;
        // Objekttyp und Beschreibung gehören zu Typ und Geschoss nach oben
        if (Array.isArray(g) && g[0] && g[0].titel === 'Bauteil') {
          diese.kopf.push(...g[0].zeilen);
          g = g.length > 1 ? g.slice(1) : 'fehlt';
        }
        diese.eigenschaften = g;
        // Das erste Set aufklappen — meist Pset_…Common
        if (Array.isArray(g) && g.length && ![...tablet.offen].some(t => g.some(x => x.titel === t))) tablet.offen.add(g[0].titel);
        ui.schmutzig = true;
      });
    }
  }
  // Die anderen sehen das Bauteil in meiner Farbe (vr-gemeinsam.js)
  gemeinsam.auswahlMelden(auswahl, info.punkt);
  tablet.seite = 'info';
  tablet.sichtbar = true;
  ui.oben('info');
  ui.schmutzig = true;
}

// ─────────────────────────────────────────────────────────────────
// DAS TABLET
// ─────────────────────────────────────────────────────────────────

const tabletLeinwand = document.createElement('canvas');
tabletLeinwand.width = TABLET_PX.breite;
tabletLeinwand.height = TABLET_PX.hoehe;
tabletLeinwand.className = 'vr-tablet__leinwand';
const ui = new TabletUI(tabletLeinwand);
const tabletTextur = new THREE.CanvasTexture(tabletLeinwand);
tabletTextur.colorSpace = THREE.SRGBColorSpace;
tabletTextur.anisotropy = 4;
const tabletMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(TABLET_BREITE, TABLET_BREITE * TABLET_PX.hoehe / TABLET_PX.breite),
  new THREE.MeshBasicMaterial({ map: tabletTextur, transparent: true, depthTest: false, toneMapped: false, fog: false }),
);
tabletMesh.name = 'tablet';
tabletMesh.renderOrder = 20;
tabletMesh.visible = false;
// Die zeigende Hand ist oft fast in der Ebene des Tablets und trifft es dann
// von hinten. Für den Strahl zählen beide Seiten, gezeichnet wird die vordere.
tabletMesh.raycast = function (rc, treffer) {
  this.material.side = THREE.DoubleSide;
  THREE.Mesh.prototype.raycast.call(this, rc, treffer);
  this.material.side = THREE.FrontSide;
};

const zeigerPunkt = new THREE.Mesh(
  new THREE.CircleGeometry(0.0035, 20),
  new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, toneMapped: false, fog: false }),
);
zeigerPunkt.renderOrder = 21;
zeigerPunkt.raycast = () => {};
zeigerPunkt.visible = false;
tabletMesh.add(zeigerPunkt);
zeigerPunkt.position.z = 0.001;

if (el.tablet) {
  el.tablet.appendChild(tabletLeinwand);
  const px = e => {
    const r = tabletLeinwand.getBoundingClientRect();
    return [(e.clientX - r.left) * tabletLeinwand.width / r.width, (e.clientY - r.top) * tabletLeinwand.height / r.height];
  };
  tabletLeinwand.addEventListener('pointermove', e => ui.zeiger(...px(e)));
  tabletLeinwand.addEventListener('pointerleave', () => ui.zeiger(null));
  tabletLeinwand.addEventListener('click', e => ui.klick(...px(e)));
  tabletLeinwand.addEventListener('wheel', e => {
    e.preventDefault();
    ui.rollen(e.deltaY, ...px(e));
  }, { passive: false });
}

/** Wer trägt das Tablet: ein Controller in der gewählten Hand. Hände ohne
 *  Controller (Vision Pro, Handtracking der Quest) und die Wahl „schwebt"
 *  lassen es vor dir schweben. */
function tabletTraeger() {
  if (werkzeug.tabletHand === 'schweben') return null;
  return haende.find(h => h.quelle && h.quelle.handedness === werkzeug.tabletHand &&
    h.quelle.targetRayMode === 'tracked-pointer' && h.quelle.gamepad) || null;
}

/** Das Tablet an die Hand hängen, die es tragen soll — oder schweben lassen. */
function tabletAnhaengen() {
  const hand = tabletTraeger();
  if (hand) {
    hand.griff.add(tabletMesh);
    const s = werkzeug.tabletHand === 'left' ? 1 : -1;
    tabletMesh.position.set(s * TABLET_LAGE.x, TABLET_LAGE.y, TABLET_LAGE.z);
    tabletMesh.rotation.set(TABLET_LAGE.kippen, 0, 0);
    tabletMesh.scale.setScalar(1);
    schwebe.an = false;
    return;
  }
  if (zustand.modus === 'vorschau' || schwebe.an) return;
  nutzer.add(tabletMesh);
  tabletMesh.scale.setScalar(TABLET_SCHWEBE.groesse);
  schwebe.an = true;
  // Die ersten Bilder vor den Kopf stellen, nicht nur das erste: dort trägt die
  // Kamera noch die Pose der Vorschau (three.js setzt die der Brille erst beim
  // Zeichnen) — gemessen 12 m hoch und 36° daneben.
  schwebe.neu = 3;
}

/** Links unten vor dem Kopf, zum Gesicht gedreht; folgt erst bei großer Drehung. */
function tabletSchweben(dt) {
  if (!schwebe.an) return;
  const kopfWelt = kopfPosition(new THREE.Vector3());
  nutzer.updateWorldMatrix(true, false);
  const kopf = nutzer.worldToLocal(kopfWelt.clone());
  const blick = blickWaagerecht(new THREE.Vector3()).applyQuaternion(nutzer.quaternion.clone().invert());
  const kopfGier = Math.atan2(-blick.x, -blick.z);
  if (schwebe.neu > 0) {
    schwebe.gier = kopfGier;
    schwebe.hoehe = kopf.y;
    schwebe.folgt = false;
    schwebe.neu--;
  }
  Object.assign(schwebe, schwebeFolgen(schwebe, kopfGier, dt, TABLET_SCHWEBE.folgeAb));
  schwebe.hoehe += (kopf.y - schwebe.hoehe) * Math.min(1, dt / 0.5);
  const { abstand, seite, tiefer } = TABLET_SCHWEBE;
  const s = Math.sin(schwebe.gier);
  const c = Math.cos(schwebe.gier);
  // vorn = (−sin g, 0, −cos g), rechts = (cos g, 0, −sin g)
  tabletMesh.position.set(kopf.x - s * abstand + c * seite, schwebe.hoehe - tiefer, kopf.z - c * abstand - s * seite);
  tabletMesh.lookAt(kopfWelt);
}

/** Wer zeigt aufs Tablet: ein Controller oder eine Hand, die schon gekniffen
 *  hat — nicht der Träger und kein Blick (der zeigt nur beim Kneifen). */
function zeigerHand() {
  const traeger = schwebe.an ? null : tabletTraeger();
  const kandidaten = haende.filter(h => h.quelle && h.zeigt && !h.transient && h !== traeger);
  return kandidaten.find(h => h.quelle.handedness !== werkzeug.tabletHand) || kandidaten[0] || null;
}

const _tabletEbene = new THREE.Plane();
/** Wo trifft der Strahl das Tablet, in Tablet-Pixeln? `ebene`: auch über den
 *  Rand hinaus — beim Rollen darf der Strahl das Tablet verlassen. */
function tabletPunkt(strahl, ebene = false) {
  if (!tabletMesh.visible || !tabletMesh.parent) return null;
  // Beim Kneifen hat three.js die Pose eben aus event.frame gesetzt, die Weltmatrix aber noch nicht
  strahl.updateWorldMatrix(true, false);
  raycaster.setFromXRController(strahl);
  let u;
  let v;
  if (!ebene) {
    const t = raycaster.intersectObject(tabletMesh, false)[0];
    if (!t || !t.uv) return null;
    ({ x: u, y: v } = t.uv);
  } else {
    tabletMesh.updateWorldMatrix(true, false);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(tabletMesh.matrixWorld);
    _tabletEbene.setFromNormalAndCoplanarPoint(n, tabletMesh.getWorldPosition(new THREE.Vector3()));
    const p = raycaster.ray.intersectPlane(_tabletEbene, new THREE.Vector3());
    if (!p) return null;
    tabletMesh.worldToLocal(p);
    u = p.x / TABLET_BREITE + 0.5;
    v = p.y / (TABLET_BREITE * TABLET_PX.hoehe / TABLET_PX.breite) + 0.5;
  }
  return [u * TABLET_PX.breite, (1 - v) * TABLET_PX.hoehe];
}

/** Kneifen und ziehen auf dem Tablet rollt — ohne Controller gibt es keinen Stick. */
function tabletZuege() {
  for (const h of haende) {
    const z = h.tabletZug;
    if (!z) continue;
    const p = tabletPunkt(h.strahl, true);
    if (!p) continue;
    if (!z.gerollt && Math.hypot(p[0] - z.start[0], p[1] - z.start[1]) > ZUG_SCHWELLE) z.gerollt = true;
    if (z.gerollt) ui.rollen(z.letzt[1] - p[1], ...z.start);
    z.letzt = p;
  }
}

/** Kneift diese Hand ohne Controller (Blick der Vision Pro oder Hand der Quest)? */
function kneift(hand) {
  // Ein transient-pointer ist immer ein Kneifen — auch wenn Safari ihm ein Gamepad mitgibt
  return !!hand.quelle && (hand.transient || !hand.quelle.gamepad);
}

function langGekniffen(hand) {
  return kneift(hand) && performance.now() - hand.seit >= LANG_KNEIFEN;
}

let tabletGezeichnet = 0;
function tabletAktualisieren(jetzt) {
  // Bewegliches nachziehen: Ladestand in der Fußzeile, Lage auf der Karte
  if (jetzt - tabletGezeichnet > 400) {
    const merk = `${Math.round(ladestand() * 100)}|${tablet.seite === 'karte' ? kartenMerkmal() : ''}|${welt.gelaendeMitte()?.toFixed(2)}` +
      `|${tablet.seite === 'gemeinsam' ? gemeinsam.merkmal() : ''}|${bodenFolge.freiflug}|${tablet.seite === 'werkzeuge' ? flugDiagText().join() : ''}`;
    if (merk !== tabletAktualisieren.merk) { tabletAktualisieren.merk = merk; ui.schmutzig = true; }
  }
  if (!ui.schmutzig || jetzt - tabletGezeichnet < 33) return;
  tabletGezeichnet = jetzt;
  ui.schmutzig = false;
  tabletZeichnen(ui, app);
  tabletTextur.needsUpdate = true;
}

/** Wo steht der Strahl der zeigenden Hand auf dem Tablet? */
function tabletZielen() {
  const hand = zeigerHand();
  for (const h of haende) h.aufTablet = null;
  if (!hand || !tabletMesh.visible || !tabletMesh.parent) {
    zeigerPunkt.visible = false;
    if (renderer.xr.isPresenting) ui.zeiger(null);
    return;
  }
  raycaster.setFromXRController(hand.strahl);
  const t = raycaster.intersectObject(tabletMesh, false)[0];
  if (!t || !t.uv) {
    zeigerPunkt.visible = false;
    ui.zeiger(null);
    return;
  }
  const px = t.uv.x * TABLET_PX.breite;
  const py = (1 - t.uv.y) * TABLET_PX.hoehe;
  hand.aufTablet = [px, py];
  hand.linie.scale.z = t.distance;
  zeigerPunkt.visible = true;
  zeigerPunkt.position.set((t.uv.x - 0.5) * TABLET_BREITE, (t.uv.y - 0.5) * TABLET_BREITE * TABLET_PX.hoehe / TABLET_PX.breite, 0.001);
  ui.zeiger(px, py);
}

// ─────────────────────────────────────────────────────────────────
// MESSEN
// ─────────────────────────────────────────────────────────────────

const messGruppe = new THREE.Group();
modell.add(messGruppe);
const messStoff = new THREE.MeshBasicMaterial({ color: AKZENT, depthTest: false, toneMapped: false, fog: false });
const messLinienStoff = new THREE.LineBasicMaterial({ color: AKZENT, depthTest: false, toneMapped: false, fog: false });
const messTafel = baueTafel(512, 128, 0.32);
szene.add(messTafel.mesh);

function messPunkt(weltPunkt) {
  if (werkzeug.punkte.length >= 2) { werkzeug.punkte = []; werkzeug.messung = null; }
  werkzeug.punkte.push(modell.worldToLocal(weltPunkt.clone()));
  const [a, b] = werkzeug.punkte;
  werkzeug.messung = b ? messung(a.toArray(), b.toArray()) : null;
  messungZeichnen();
  gemeinsam.messungMelden();
  tablet.seite = 'werkzeuge';
  ui.schmutzig = true;
}

function messungZeichnen() {
  for (const c of [...messGruppe.children]) { c.removeFromParent(); c.geometry && c.geometry.dispose(); }
  messTafel.mesh.visible = false;
  const s = 1 / (modell.scale.x || 1);
  for (const p of werkzeug.punkte) {
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.025 * s, 16, 12), messStoff);
    k.position.copy(p);
    k.renderOrder = 12;
    k.raycast = () => {};
    messGruppe.add(k);
  }
  if (werkzeug.punkte.length === 2) {
    const linie = new THREE.Line(new THREE.BufferGeometry().setFromPoints(werkzeug.punkte), messLinienStoff);
    linie.renderOrder = 12;
    linie.raycast = () => {};
    messGruppe.add(linie);
    const { ctx, canvas, textur } = messTafel;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(18, 18, 18, 0.9)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 24);
    ctx.fill();
    ctx.fillStyle = '#97bf0d';
    ctx.fillRect(0, 18, 8, canvas.height - 36);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 64px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(meterText(werkzeug.messung.abstand), canvas.width / 2, canvas.height / 2 + 2);
    textur.needsUpdate = true;
    messTafel.mesh.visible = true;
  }
}

/** Messwert über der Strecke, zum Betrachter gedreht und mit Abstand wachsend. */
function messTafelAusrichten() {
  if (!messTafel.mesh.visible || werkzeug.punkte.length < 2) return;
  const mitte = werkzeug.punkte[0].clone().add(werkzeug.punkte[1]).multiplyScalar(0.5);
  modell.localToWorld(mitte);
  const kopf = kopfPosition(new THREE.Vector3());
  const d = Math.max(0.4, mitte.distanceTo(kopf));
  messTafel.mesh.position.copy(mitte).add(new THREE.Vector3(0, 0.06 * d, 0));
  messTafel.mesh.scale.setScalar(Math.min(4, d / 1.5));
  messTafel.mesh.lookAt(kopf);
}

// ─────────────────────────────────────────────────────────────────
// HÄNDE
// ─────────────────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const bodenStrahl = new THREE.Raycaster();
const fabrik = new XRControllerModelFactory();
const haende = [];

const ziel = new THREE.Mesh(
  new THREE.RingGeometry(0.22, 0.3, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: AKZENT, transparent: true, opacity: 0.9, toneMapped: false, fog: false }),
);
ziel.visible = false;
ziel.raycast = () => {};
szene.add(ziel);

for (let i = 0; i < STEUERUNGEN; i++) {
  const strahl = renderer.xr.getController(i);
  const griff = renderer.xr.getControllerGrip(i);
  const linie = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: AKZENT, transparent: true, opacity: 0.8, toneMapped: false, fog: false }),
  );
  linie.scale.z = 3;
  linie.raycast = () => {};
  strahl.add(linie);
  griff.add(fabrik.createControllerModel(griff));
  nutzer.add(strahl, griff);

  const hand = {
    strahl, griff, linie, quelle: null, zielt: false, treffer: null, gespannt: true, knoepfe: [], haelt: null,
    aufTablet: null, tippte: false,
    transient: false,   // Blick + Kneifen (Vision Pro): nur solange gekniffen wird
    zeigt: false,       // hat einen sichtbaren Strahl und darf aufs Tablet zeigen
    seit: 0,            // Beginn des Kneifens (langes Kneifen = Info)
    tabletZug: null,    // Kneifen auf dem Tablet: { start, letzt, gerollt }
    flug: null,         // Kneifen in der Luft: { start, letzt, zug, aktiv } — Ziehen greift die Welt
  };
  haende.push(hand);

  strahl.addEventListener('connected', e => {
    const q = e.data;
    hand.quelle = q;
    hand.transient = q.targetRayMode === 'transient-pointer';
    // Ein Controller zeigt von Anfang an, eine Hand erst, wenn sie gekniffen hat:
    // auf der Vision Pro liefern die Hände nur ihre Lage (gezeigt wird mit dem
    // Blick), und ihre Strahlen ständen nur im Weg.
    hand.zeigt = q.targetRayMode === 'tracked-pointer' && !!q.gamepad;
    linie.visible = hand.zeigt;
    if (!hand.transient) {
      tabletAnhaengen();
      tabletMesh.visible = tablet.sichtbar && zustand.modus !== 'vorschau';
    }
    ui.schmutzig = true;   // die Hilfe hängt an der Steuerung
  });
  strahl.addEventListener('disconnected', () => {
    hand.quelle = null;
    hand.zielt = false;
    hand.haelt = null;
    hand.aufTablet = null;
    hand.tabletZug = null;
    hand.flug = null;
    hand.transient = false;
    hand.zeigt = false;
    linie.visible = false;
    if (tabletMesh.parent === griff) tabletAnhaengen();   // der Träger ist weg: schweben
    ui.schmutzig = true;
  });
  strahl.addEventListener('selectstart', () => {
    if (!hand.quelle) return;
    hand.seit = performance.now();
    if (!hand.transient && !hand.zeigt) { hand.zeigt = true; linie.visible = true; }   // Hand der Quest: sie kneift, also zeigt sie
    if (kneift(hand)) {
      // Ohne Controller tippt erst das Loslassen — wer dabei zieht, rollt
      const p = tabletPunkt(strahl);
      if (p) {
        hand.tabletZug = { start: p, letzt: p, gerollt: false };
        ui.zeiger(...p);
        return;
      }
    } else if (hand.aufTablet) {
      // Auf dem Tablet tippt der Abzug — sofort beim Drücken, nicht beim Loslassen
      hand.tippte = true;
      ui.klick(...hand.aufTablet);
      return;
    }
    // Beim Kalibrieren misst der Abzug eine Marke, statt zu springen (vr-gemeinsam.js)
    if (gemeinsam.abzugFangen(hand)) return;
    // Ohne Controller gibt es keinen Stick: wer kneift und die Hand bewegt, zieht sich durch die
    // Luft (fliegen). Ein Kneifen ohne Bewegung bleibt, was es war: springen oder Info.
    flugDiag.kneifen++;
    flugDiag.art = hand.quelle.targetRayMode;
    flugDiag.gamepad = hand.quelle.gamepad ? 'ja' : 'nein';
    flugDiag.zieht = false;
    flugDiag.wegG = flugDiag.wegS = 0;
    if (kneift(hand) && zustand.modus === 'vr') hand.flug = { start: null, letzt: null, zug: { h: 0, v: 0 }, aktiv: false };
    hand.zielt = true;
  });
  strahl.addEventListener('selectend', () => {
    if (hand.gefangen) { hand.gefangen = false; return; }
    if (hand.tabletZug) {
      const z = hand.tabletZug;
      hand.tabletZug = null;
      if (!z.gerollt) ui.klick(...z.start);
      ui.zeiger(null);
      return;
    }
    if (hand.flug) {
      const geflogen = hand.flug.aktiv;
      hand.flug = null;
      if (geflogen) return;   // gezogen, nicht getippt: kein Sprung, keine Info
    }
    if (hand.tippte) { hand.tippte = false; return; }
    abzugLos(hand);
  });
  strahl.addEventListener('squeezestart', () => griffAn(hand));
  strahl.addEventListener('squeezeend', () => { hand.haelt = null; });
}

/** Maße des Modells, solange es noch nicht ausgerichtet ist: null (→ Maßstab 1). */
function kastenGroesse() {
  return zustand.ausgerichtet ? zustand.kasten.getSize(new THREE.Vector3()).toArray() : [0, 0, 0];
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const OBEN = new THREE.Vector3(0, 1, 0);
const UNTEN = new THREE.Vector3(0, -1, 0);

function kopfPosition(ziel = _v1) {
  return kamera.getWorldPosition(ziel);
}

/** Blickrichtung waagerecht — fürs Gehen und Platzieren zählt nur, wohin man
 *  schaut, nicht wie weit man den Kopf neigt. */
function blickWaagerecht(ziel = _v2) {
  ziel.set(0, 0, -1).applyQuaternion(kamera.getWorldQuaternion(_q1));
  ziel.y = 0;
  if (ziel.lengthSq() < 1e-6) ziel.set(0, 0, -1);
  return ziel.normalize();
}

/** Ziele für Strahlen: das Modell (wenn sichtbar), die Welt, der Rasterboden. */
function strahlZiele({ mitBoden = true, nurGelaende = false } = {}) {
  const z = [];
  if (tiles && !nurGelaende && tiles.group.visible) z.push(tiles.group);
  z.push(...welt.ziele(nurGelaende));
  if (mitBoden && !nurGelaende && boden.visible && zustand.modus !== 'tisch') z.push(boden);
  return z;
}

/**
 * Den ersten Treffer, den man auch sieht. Die Welt ist am Modell beschnitten
 * (vr-welt.js): LoD2 im Grundriss fällt weg, Gelände dort liegt tiefer, auf
 * der Sohle. Für dieses steht der Schnitt des Strahls mit der Sohlfläche —
 * sonst liefe er ins Erdreich bis zu den Schürzen grober Kacheln.
 */
function ersterSichtbarer(treffer, strahl) {
  let ersatz = null;
  for (const t of treffer) {
    if (ersatz && t.distance > ersatz.distance) break;
    const art = welt.unsichtbarerTreffer(t, modell.worldToLocal(t.point.clone()));
    if (art === 'gelaende') { if (!ersatz) ersatz = sohlenTreffer(strahl); continue; }
    if (art) continue;
    return t;
  }
  return ersatz;
}

const _sohle = new THREE.Plane(new THREE.Vector3(0, 1, 0), -SOHLE);
function sohlenTreffer(strahl) {
  if (!strahl || !zustand.fuss) return null;
  const lokal = strahl.clone().applyMatrix4(new THREE.Matrix4().copy(modell.matrixWorld).invert());
  const p = lokal.intersectPlane(_sohle, new THREE.Vector3());
  if (!p || !imFuss(zustand.fuss, p.x, p.z)) return null;
  const punkt = modell.localToWorld(p);
  return { point: punkt, distance: punkt.distanceTo(strahl.origin), object: welt.gruppe, face: { normal: new THREE.Vector3(0, 1, 0), a: 0, b: 0, c: 0 } };
}

function treffe(hand) {
  if (!tiles) return null;
  raycaster.setFromXRController(hand.strahl);
  raycaster.params.Points.threshold = zustand.modus === 'tisch' ? 0.004 / modell.scale.x : 0.05;
  const treffer = ersterSichtbarer(raycaster.intersectObjects(strahlZiele({ mitBoden: zustand.modus === 'vr' }), true), raycaster.ray);
  if (!treffer) return null;

  let landen = false;
  if (treffer.object === boden) landen = true;
  else if (treffer.face) {
    const n = treffer.face.normal.clone().transformDirection(treffer.object.matrixWorld);
    if (n.dot(raycaster.ray.direction) > 0) n.negate();   // von unten getroffen
    landen = begehbar(n.y);
  } else {
    landen = punktBegehbar(treffer.point.y, kopfPosition().y);
  }
  return { treffer, punkt: treffer.point.clone(), landen, abstand: treffer.distance };
}

function abzugLos(hand) {
  hand.zielt = false;
  ziel.visible = false;
  hand.linie.scale.z = 3;
  // Ein kurzer Klick beginnt und endet oft im selben Bild — dann hat zielen()
  // noch nicht gerechnet.
  const t = hand.treffer || treffe(hand);
  hand.treffer = null;
  if (!t) return;
  // Ohne Controller gibt es keinen Griff: lange kneifen zeigt die Info, auch zu Decken und Böden
  if (werkzeug.messen) messPunkt(t.punkt);
  else if (zustand.modus === 'vr' && t.landen && !langGekniffen(hand)) springe(t.punkt);
  else zeigeBauteil(t);
}

function griffAn(hand) {
  if (zustand.modus === 'tisch') {
    // Greifen merkt sich nur Lage und Gierwinkel: das Modell folgt der Hand,
    // kippt aber nicht mit — ein schiefes Gebäude auf dem Tisch hilft niemandem.
    const p = hand.griff.getWorldPosition(new THREE.Vector3());
    hand.haelt = {
      hand0: p,
      gier0: gier(hand.griff),
      modell0: modell.position.clone(),
      drehung0: modell.rotation.y,
    };
    return;
  }
  if (zustand.modus === 'vr') {
    const t = treffe(hand);
    if (t) zeigeBauteil(t);
  }
}

function gier(objekt) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(objekt.getWorldQuaternion(new THREE.Quaternion()));
  return Math.atan2(-f.x, -f.z);
}

function springe(punkt) {
  const kopf = kopfPosition();
  nutzer.position.x += punkt.x - kopf.x;
  nutzer.position.z += punkt.z - kopf.z;
  nutzer.position.y = punkt.y;   // local-floor: die Füße auf dem Landeplatz
  bodenFolge.freiflug = false;
  bodenFolge.ziel = null;
}

function zeigeBauteil(t) {
  auswahlSetzen(bauteilAus(t.treffer));
}

function zielen() {
  let landeplatz = null;
  for (const hand of haende) {
    if (!hand.zielt) continue;
    const t = treffe(hand);
    hand.treffer = t;
    hand.linie.scale.z = t ? t.abstand : 30;
    // Langes Kneifen nimmt den Landeplatz weg: so sieht man, dass Loslassen jetzt die Info zeigt
    if (t && t.landen && zustand.modus === 'vr' && !werkzeug.messen && !langGekniffen(hand)) landeplatz = t.punkt;
  }
  ziel.visible = !!landeplatz;
  if (landeplatz) ziel.position.copy(landeplatz).add(_v2.set(0, 0.02, 0));
}

const FLUG_SCHWELLE = 0.06;   // m Handweg, ab dem aus einem Kneifen ein Ziehen wird
const KNEIF_ABSTAND = 0.7;    // m — Ersatzpunkt auf dem Strahl, wenn die Brille keine Fingerlage liefert
const _kl = new THREE.Vector3();

/**
 * Beide Quellen der Fingerlage nebeneinander (m, Rahmen des Nutzers): `g` = der
 * gripSpace des Kneifens, `s` = ein Punkt auf dem Strahl. Was die Brille wirklich
 * liefert, weiß man erst dort — die Vision Pro kann beides, nur eines oder bei
 * einem davon eine stehende Lage melden. Gezogen wird mit der, die sich bewegt.
 */
function kneifLagen(hand) {
  const g = hand.quelle && hand.quelle.gripSpace && hand.griff.visible ? hand.griff.position.toArray() : null;
  const s = hand.strahl.visible
    ? _kl.set(0, 0, -KNEIF_ABSTAND).applyQuaternion(hand.strahl.quaternion).add(hand.strahl.position).toArray()
    : null;
  return { g, s };
}
const wegZwischen = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0);

// Was die Brille beim Kneifen liefert — steht auf dem Tablet (Werkzeuge), damit man es ablesen kann
const flugDiag = { kneifen: 0, art: '–', gamepad: '–', grip: '–', strahl: '–', wegG: 0, wegS: 0, quelle: '–', zieht: false, bilder: 0 };
function flugDiagText() {
  const cm = m => `${Math.round(m * 100)} cm`;
  return [
    `Kneifen ${flugDiag.kneifen}× · ${flugDiag.art} · Gamepad ${flugDiag.gamepad}`,
    `Finger-Lage ${flugDiag.grip} (${cm(flugDiag.wegG)}) · Strahl ${flugDiag.strahl} (${cm(flugDiag.wegS)})`,
    flugDiag.zieht ? `zieht mit: ${flugDiag.quelle === 'g' ? 'Finger-Lage' : 'Strahl'}` : `zieht nicht (Schwelle ${cm(FLUG_SCHWELLE)})`,
  ];
}

/** Kneifen und die Hand bewegen: die Welt greifen und sich durch die Luft ziehen. */
function fliegen(hand) {
  const f = hand.flug;
  if (!f) return;
  if (!hand.quelle || zustand.modus !== 'vr') { hand.flug = null; return; }
  const { g, s } = kneifLagen(hand);
  flugDiag.bilder++;
  flugDiag.grip = g ? 'ja' : 'fehlt';
  flugDiag.strahl = s ? 'ja' : 'fehlt';
  if (!g && !s) return;
  // Die Lage steht erst im Bild nach dem Kneifen: dort beginnt der Weg
  if (!f.start) { f.start = { g, s }; f.letzt = null; return; }
  flugDiag.wegG = wegZwischen(g, f.start.g);
  flugDiag.wegS = wegZwischen(s, f.start.s);
  if (!f.aktiv) {
    // Die Finger-Lage geht vor; der Strahl braucht mehr Weg (eine Kopfdrehung bewegt ihn auch)
    const quelle = flugDiag.wegG >= FLUG_SCHWELLE ? 'g' : (flugDiag.wegS >= FLUG_SCHWELLE * 1.5 ? 's' : null);
    if (!quelle) return;
    f.quelle = quelle;
    flugDiag.quelle = quelle;
    flugDiag.zieht = true;
    f.aktiv = true;
    hand.zielt = false;        // kein Landeplatz mehr: gezogen wird, nicht gesprungen
    ziel.visible = false;
    hand.treffer = null;
    hand.linie.scale.z = 3;
    f.letzt = f.quelle === 'g' ? g : s;
    return;
  }
  const jetzt = f.quelle === 'g' ? g : s;
  if (!jetzt || !f.letzt) return;
  const r = flugSchritt(f.zug, f.letzt, jetzt, { weite: werkzeug.flugweite, frei: bodenFolge.freiflug, bodenFolgen: werkzeug.bodenFolgen });
  f.letzt = jetzt;
  f.zug = r.zug;
  nutzer.position.add(_v1.fromArray(r.schritt).applyQuaternion(nutzer.quaternion));
  if (r.schwebt) { bodenFolge.freiflug = true; bodenFolge.ziel = null; }
  else bodenFolge.bewegt = true;
}

function steuern(dt) {
  for (const hand of haende) {
    const gp = hand.quelle && hand.quelle.gamepad;
    if (hand.haelt) halten(hand);
    if (hand.flug) fliegen(hand);
    if (!gp) continue;
    const x = totzone(gp.axes[2]);
    const y = totzone(gp.axes[3]);
    const links = hand.quelle.handedness === 'left';
    const gedrueckt = i => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const flanke = i => {
      const jetzt = gedrueckt(i);
      const vorher = hand.knoepfe[i];
      hand.knoepfe[i] = jetzt;
      return jetzt && !vorher;
    };

    if (hand.aufTablet) {
      // Auf dem Tablet rollt der Stick, statt zu drehen oder zu schweben
      if (y) ui.rollen(y * ROLLEN * dt, ...hand.aufTablet);
    } else if (zustand.modus === 'vr') {
      if (links && (x || y)) {
        const vor = blickWaagerecht();
        const rechts = _v1.set(-vor.z, 0, vor.x);
        const tempo = werkzeug.tempo * (gedrueckt(KNOPF.stick) ? SPRINT : 1) * dt;
        nutzer.position.addScaledVector(vor, -y * tempo).addScaledVector(rechts, x * tempo);
        bodenFolge.bewegt = true;
      } else if (!links) {
        const d = schrittDrehung(gp.axes[2], hand.gespannt, werkzeug.drehschritt * Math.PI / 180);
        hand.gespannt = d.gespannt;
        if (d.winkel) drehe(d.winkel);
        if (y && Math.abs(gp.axes[3]) > Math.abs(gp.axes[2])) {
          nutzer.position.y -= y * HEBEN * dt;
          bodenFolge.freiflug = true;   // wer schwebt, will nicht auf den Boden gezogen werden
          bodenFolge.ziel = null;
        }
      }
    } else if (zustand.modus === 'tisch') {
      if (links && x) modell.rotateOnWorldAxis(OBEN, -x * 1.5 * dt);
      if (!links && y) {
        const grund = tischMassstab(...kastenGroesse());
        const s = THREE.MathUtils.clamp(modell.scale.x * Math.exp(-y * dt), grund / 20, Math.max(1, grund * 20));
        modell.scale.setScalar(s);
      }
    }

    if (flanke(KNOPF.unten)) zurueck();
    if (flanke(KNOPF.oben)) {
      tablet.sichtbar = !tablet.sichtbar;
      tabletMesh.visible = tablet.sichtbar;
      ui.schmutzig = true;
    }
  }
}

function halten(hand) {
  const h = hand.haelt;
  const p = hand.griff.getWorldPosition(new THREE.Vector3());
  const dGier = gier(hand.griff) - h.gier0;
  const versatz = h.modell0.clone().sub(h.hand0).applyAxisAngle(OBEN, dGier);
  modell.position.copy(p).add(versatz);
  modell.rotation.set(0, h.drehung0 + dGier, 0);
}

/** Um den Kopf drehen, nicht um den Ursprung des Nutzers — sonst wandert man
 *  bei jeder Drehung im Raum herum. */
function drehe(winkel) {
  const kopf = kopfPosition(new THREE.Vector3());
  const q = new THREE.Quaternion().setFromAxisAngle(OBEN, winkel);
  nutzer.position.sub(kopf).applyQuaternion(q).add(kopf);
  nutzer.quaternion.premultiply(q);
}

function zurueck() {
  if (zustand.modus === 'vr') startPose();
  else if (zustand.modus === 'tisch') {
    modell.scale.setScalar(tischMassstab(...kastenGroesse()));
    zustand.tischPlatzieren = 1;
  }
}

/** Vor der Südseite, Blick nach Norden: three.js schaut ohne Drehung nach −z. */
function startPose() {
  nutzer.quaternion.identity();
  bodenFolge.freiflug = false;
  bodenFolge.ziel = null;
  if (!zustand.ausgerichtet) { nutzer.position.set(0, 0, 0); return; }   // ausrichten() holt es nach
  const k = zustand.kasten;
  nutzer.position.set(0, 0, k.max.z + startAbstand(k.max.x - k.min.x, k.max.z - k.min.z));
  bodenFolge.absetzen = performance.now();
}

function tischPlatzieren() {
  const kopf = kopfPosition(new THREE.Vector3());
  const blick = blickWaagerecht(new THREE.Vector3());
  modell.position.copy(kopf).addScaledVector(blick, 0.8);
  modell.position.y = Math.max(0.6, kopf.y - 0.55);
  // Die Südseite zum Betrachter, wie im 1:1-Modus beim Start.
  modell.rotation.set(0, Math.atan2(-blick.x, -blick.z), 0);
}

// ─────────────────────────────────────────────────────────────────
// BODEN FOLGEN — Treppen, Gelände, Absetzen nach dem Start
// ─────────────────────────────────────────────────────────────────

const bodenFolge = {
  ziel: null,          // Höhe, auf die die Füße zulaufen
  bewegt: false,
  freiflug: false,
  absetzen: 0,         // Zeitpunkt, seit dem auf Gelände unter dem Start gewartet wird
  letzte: 0,
};

/**
 * Boden unter (x, z), von `vonY` abwärts. `nurGelaende`: nur die Welt — zum
 * Absetzen, damit man nicht auf einem Nachbardach oder dem Modell landet.
 */
function bodenUnter(x, z, vonY, nurGelaende = false, roh = false) {
  bodenStrahl.set(new THREE.Vector3(x, vonY, z), UNTEN);
  bodenStrahl.far = nurGelaende ? 5000 : 200;
  const ziele = strahlZiele({ nurGelaende });
  if (!ziele.length) return null;
  const alle = bodenStrahl.intersectObjects(ziele, true);
  const t = roh ? alle[0] : ersterSichtbarer(alle, bodenStrahl.ray);
  return t ? t.point.y : null;
}

function bodenPruefen(jetzt, dt) {
  if (zustand.modus !== 'vr') return;
  if (bodenFolge.ziel !== null) {
    nutzer.position.y = bodenNachfuehren(nutzer.position.y, bodenFolge.ziel, dt);
    if (Math.abs(nutzer.position.y - bodenFolge.ziel) < 1e-3) bodenFolge.ziel = null;
  }
  if (jetzt - bodenFolge.letzte < 120) return;
  bodenFolge.letzte = jetzt;
  const kopf = kopfPosition(new THREE.Vector3());
  if (bodenFolge.absetzen) {
    // Nach dem Start oder einem Sprung über die Karte: aufs Gelände stellen, sobald es da ist
    const y = welt.renderer().length ? bodenUnter(kopf.x, kopf.z, nutzer.position.y + 2000, true) : null;
    if (y !== null) {
      nutzer.position.y = y;
      bodenFolge.absetzen = 0;
    } else if (jetzt - bodenFolge.absetzen > 20000) {
      bodenFolge.absetzen = 0;
    }
    return;
  }
  if (!werkzeug.bodenFolgen || bodenFolge.freiflug || !bodenFolge.bewegt) return;
  bodenFolge.bewegt = false;
  const y = bodenUnter(kopf.x, kopf.z, nutzer.position.y + STUFE);
  if (y !== null && Math.abs(y - nutzer.position.y) > 1e-3) bodenFolge.ziel = y;
}

// ─────────────────────────────────────────────────────────────────
// ORT — Modellrahmen ↔ Länge/Breite (Minikarte)
// ─────────────────────────────────────────────────────────────────

const GRAD = 180 / Math.PI;

function lokalZuGrad(x, y, z) {
  const p = new THREE.Vector3(x, y, z).applyMatrix4(zustand.rahmenInvers);
  const c = {};
  zustand.ellipsoid.getPositionToCartographic(p, c);
  return { lat: c.lat * GRAD, lon: c.lon * GRAD };
}

function gradZuLokal(lat, lon, h = 0) {
  const p = zustand.ellipsoid.getCartographicToPosition(lat / GRAD, lon / GRAD, h, new THREE.Vector3());
  return p.applyMatrix4(zustand.rahmen);
}

/** Wo man selbst steht und wohin man schaut, auf der Karte. Im Tisch: nirgends. */
function ichAufKarte() {
  if (!zustand.ort || zustand.modus === 'tisch') return null;
  const p = modell.worldToLocal(kopfPosition(new THREE.Vector3()));
  const blick = new THREE.Vector3(0, 0, -1).applyQuaternion(kamera.getWorldQuaternion(new THREE.Quaternion()));
  const g = lokalZuGrad(p.x, 0, p.z);
  return { ...g, richtung: Math.atan2(blick.x, -blick.z) };
}

function kartenMerkmal() {
  const ich = ichAufKarte();
  return ich ? `${ich.lat.toFixed(6)},${ich.lon.toFixed(6)},${ich.richtung.toFixed(1)}` : '';
}

/** Über die Karte springen: in der Brille dorthin, am Bildschirm dorthin blicken. */
function hinspringen(lat, lon) {
  if (!zustand.ort) return;
  const p = gradZuLokal(lat, lon);
  if (zustand.modus === 'vr') {
    // Auf Straßenhöhe: die ursprüngliche Geländehöhe, im Gebäude das erste
    // Geschoss darunter — nicht die Sohle, auf die das Gelände dort gesenkt ist.
    const strasse = welt.renderer().length ? bodenUnter(p.x, p.z, 3000, true, true) : null;
    const y = strasse === null ? null : (bodenUnter(p.x, p.z, strasse + 1.2) ?? strasse);
    const kopf = kopfPosition();
    nutzer.position.x += p.x - kopf.x;
    nutzer.position.z += p.z - kopf.z;
    nutzer.position.y = y ?? 0;
    bodenFolge.freiflug = false;
    bodenFolge.ziel = null;
    bodenFolge.absetzen = y === null ? performance.now() : 0;
  } else if (zustand.modus === 'vorschau') {
    const versatz = kamera.position.clone().sub(orbit.target);
    orbit.target.set(p.x, orbit.target.y, p.z);
    kamera.position.copy(orbit.target).add(versatz);
  }
  ui.schmutzig = true;
}

// ─────────────────────────────────────────────────────────────────
// DAS, WORAUS DIE TABLETSEITEN LESEN (vr-seiten.js)
// ─────────────────────────────────────────────────────────────────

function weltSetzen(neu) {
  welt.setzen(neu);
  rasterAutomatisch();
  sichtSetzen();
  speichern();
}

/** Raster nur, wo kein Gelände trägt — es sei denn, der Nutzer hat selbst gewählt. */
function rasterAutomatisch() {
  if (zustand.rasterAuto) {
    zustand.raster = !(welt.zustand.an && welt.zustand.relief && zustand.ort);
    el.boden.checked = zustand.raster;
  }
  bodenSichtbarkeit();
}

// ─────────────────────────────────────────────────────────────────
// GEMEINSAM — mehrere Brillen in einem Modell (vr-gemeinsam.js)
// ─────────────────────────────────────────────────────────────────

/** Höhenschnitt an oder aus; `hoehe` über der Sohle, im Modellrahmen. */
function schnittSetzen(an, hoehe) {
  werkzeug.schnitt.an = an;
  if (Number.isFinite(hoehe)) werkzeug.schnitt.hoehe = hoehe;
  schnittEbenen.length = 0;
  if (an) schnittEbenen.push(schnittEbene);
}

const gemeinsam = gemeinsamAnlegen({
  renderer, szene, nutzer, modell, kamera, haende, zustand, werkzeug, ebenen, ui, tablet, schnittEbenen, status,
  modellLaden: (job, name) => ladeModell(job, name, { inSitzung: true, vonGruppe: true }),
  // Die Gruppe hat den Nutzer gestellt: nicht hinterher auf den eigenen Boden ziehen
  bodenRuhig() { bodenFolge.ziel = null; bodenFolge.absetzen = 0; bodenFolge.bewegt = false; },
  ansichtLesen: () => ({
    filter: filterAlsDaten(ebenen.filter), modell: zustand.modellSichtbar,
    schnitt: { an: werkzeug.schnitt.an, hoehe: werkzeug.schnitt.hoehe },
  }),
  ansichtAnwenden(a) {
    ebenen.filterSetzen(filterAusDaten(a.filter));
    zustand.modellSichtbar = a.modell;
    if (tiles) tiles.group.visible = a.modell;
    schnittSetzen(a.schnitt.an, a.schnitt.hoehe);
    markierungWeg();
    ui.schmutzig = true;
  },
});

const aktionen = {
  seite(s) {
    tablet.seite = s;
    speichern();
    if (s === 'gemeinsam') gemeinsam.seiteGeoeffnet();
  },
  auswahlWeg() { auswahlSetzen(null); },
  ausblenden() {
    if (!auswahl || !auswahl.guid) return;
    ebenen.ausblenden(auswahl.guid);
    markierungWeg();
  },
  isolieren() {
    if (!auswahl || !auswahl.guid) return;
    if (ebenen.filter.nur && ebenen.filter.nur.has(auswahl.guid) && ebenen.filter.nur.size === 1) ebenen.allesZeigen();
    else ebenen.isolieren([auswahl.guid]);
  },
  allesZeigen() {
    ebenen.allesZeigen();
    if (tiles) tiles.group.visible = true;
    zustand.modellSichtbar = true;
  },
  einzelneZeigen() { ebenen.einzelneZeigen(); },
  gruppeUmschalten(t) { if (tablet.offen.has(t)) tablet.offen.delete(t); else tablet.offen.add(t); },
  modellSichtbar(an) {
    zustand.modellSichtbar = an;
    if (tiles) tiles.group.visible = an;
  },
  ebenenArt(a) { tablet.ebenenArt = a; ui.oben('ebenen'); },
  alle(art, an) { if (art === 'klassen') ebenen.alleKlassen(an); else ebenen.alleGeschosse(an); markierungWeg(); },
  ebeneUmschalten(art, s) { if (art === 'klassen') ebenen.klasseUmschalten(s); else ebenen.geschossUmschalten(s); markierungWeg(); },
  nur(art, s) { if (art === 'klassen') ebenen.nurKlasse(s); else ebenen.nurGeschoss(s); markierungWeg(); },
  welt: weltSetzen,
  raster(an) { zustand.raster = an; zustand.rasterAuto = false; el.boden.checked = an; bodenSichtbarkeit(); speichern(); },
  versatz(d) { welt.setzen({ versatz: d === null ? 0 : welt.zustand.versatz + d }); },
  anlegen() { if (!welt.anlegen()) status('Gelände unter dem Modell ist noch nicht geladen'); },
  karteZoom(d) { tablet.karteZoom = THREE.MathUtils.clamp(tablet.karteZoom + d, 13, 19); speichern(); },
  karteMitte(m) { tablet.karteMitte = m; },
  karteArt(a) { tablet.karteArt = a; speichern(); },
  hinspringen,
  messenUmschalten() {
    werkzeug.messen = !werkzeug.messen;
    if (!werkzeug.messen) { werkzeug.punkte = []; werkzeug.messung = null; messungZeichnen(); }
  },
  messungWeg() { werkzeug.punkte = []; werkzeug.messung = null; messungZeichnen(); },
  schnittUmschalten() {
    const an = !werkzeug.schnitt.an;
    schnittSetzen(an, an ? (zustand.modus === 'vr' ? kopfLokalY() + 0.4 : Math.round(zustand.kasten.max.y * 2) / 4) : undefined);
  },
  schnittHoehe(d) { werkzeug.schnitt.hoehe = Math.max(0.1, werkzeug.schnitt.hoehe + d); },
  schnittKopf() { werkzeug.schnitt.hoehe = kopfLokalY() + 0.4; },
  bodenFolgen(an) { werkzeug.bodenFolgen = an; speichern(); },
  tempo(v) { werkzeug.tempo = v; speichern(); },
  drehschritt(v) { werkzeug.drehschritt = v; speichern(); },
  flugweite(v) { werkzeug.flugweite = v; speichern(); },
  /** Aus der Luft auf den Boden unter einem zurück (das Schweben endet, der Boden folgt wieder). */
  landen() {
    if (zustand.modus !== 'vr') return;
    const kopf = kopfPosition(new THREE.Vector3());
    const von = nutzer.position.y + STUFE;
    const y = bodenUnter(kopf.x, kopf.z, von) ?? bodenUnter(kopf.x, kopf.z, von, true);
    if (y === null) { status('Unter dir ist kein Boden'); return; }
    bodenFolge.freiflug = false;
    bodenFolge.ziel = y;   // bodenPruefen lässt die Füße weich dorthin sinken
    ui.schmutzig = true;
  },
  tabletHand(h) {
    werkzeug.tabletHand = h;
    tabletAnhaengen();
    speichern();
  },
  // Für Brillen ohne Sticks (Vision Pro): drehen und zum Start über das Tablet
  drehen(richtung) { drehe(richtung * werkzeug.drehschritt * Math.PI / 180); },
  zumStart() { zurueck(); },
};

// Gemeinsam: was die Ansicht ändert, sehen die anderen mit (Tablet › Gruppe
// › Ansicht teilen); eine Messung zeigt man ihnen ohnehin.
for (const name of ['ausblenden', 'isolieren', 'allesZeigen', 'einzelneZeigen', 'modellSichtbar', 'alle',
  'ebeneUmschalten', 'nur', 'schnittUmschalten', 'schnittHoehe', 'schnittKopf']) {
  const f = aktionen[name];
  aktionen[name] = (...a) => { f(...a); gemeinsam.ansichtMelden(); };
}
for (const name of ['messenUmschalten', 'messungWeg']) {
  const f = aktionen[name];
  aktionen[name] = (...a) => { f(...a); gemeinsam.messungMelden(); };
}
Object.assign(aktionen, gemeinsam.aktionen);

function kopfLokalY() {
  return modell.worldToLocal(kopfPosition(new THREE.Vector3())).y;
}

const app = {
  get zustand() { return zustand; },
  get tablet() { return tablet; },
  get auswahl() { return auswahl; },
  get werkzeug() { return werkzeug; },
  get schwebt() { return bodenFolge.freiflug; },
  get flugDiag() { return flugDiagText(); },
  get gemeinsam() { return gemeinsam.anzeige; },
  /** 'controller' (Quest mit Controllern) · 'hand' (Vision Pro, Hände) · 'maus' (Bildschirm) */
  get steuerung() {
    if (!renderer.xr.isPresenting) return 'maus';
    return haende.some(h => h.quelle && h.quelle.gamepad) ? 'controller' : 'hand';
  },
  aktionen,
  ladestand,
  leistung: () => leistungZeilen(leistung()),
  ebenen: {
    get filterLeer() { return filterLeer(ebenen.filter); },
    get isoliert() { return !!ebenen.filter.nur; },
    get isoliertZahl() { return ebenen.filter.nur ? ebenen.filter.nur.size : 0; },
    get einzelnAus() { return ebenen.filter.guids.size; },
    get hatBauteile() { return ebenen.hatBauteile; },
    get anzahlKlassen() { return ebenen.klassen().length; },
    get anzahlGeschosse() { return ebenen.geschosse().length; },
    klassen: () => ebenen.klassen(),
    geschosse: () => ebenen.geschosse(),
  },
  welt: {
    get verortet() { return !!zustand.ort; },
    get an() { return welt.zustand.an; },
    get karte() { return welt.zustand.karte; },
    get relief() { return welt.zustand.relief; },
    get gebaeudeAn() { return welt.zustand.gebaeudeAn; },
    get inDeutschland() { return !!zustand.ort && inDeutschland(zustand.ort.lat * GRAD, zustand.ort.lon * GRAD); },
    get versatz() { return welt.zustand.versatz; },
    get mitte() { return welt.gelaendeMitte(); },
    get raster() { return zustand.raster; },
    get vermerke() { return welt.vermerke(); },
  },
  karte: {
    get verfuegbar() { return !!zustand.ort; },
    get zoom() { return tablet.karteZoom; },
    get art() { return tablet.karteArt; },
    get mitteArt() { return tablet.karteMitte; },
    get antippbar() { return zustand.modus !== 'tisch'; },
    mitte() {
      const ich = tablet.karteMitte === 'ich' ? ichAufKarte() : null;
      return ich || { lat: zustand.ort.lat * GRAD, lon: zustand.ort.lon * GRAD };
    },
    ich: ichAufKarte,
    fuss() {
      const f = zustand.fuss;
      if (!f) return null;
      return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([su, sv]) => {
        const x = f.cx + su * f.a * f.ux - sv * f.b * f.uz;
        const z = f.cz + su * f.a * f.uz + sv * f.b * f.ux;
        const g = lokalZuGrad(x, 0, z);
        return [g.lat, g.lon];
      });
    },
    kachel: (x, y, z) => kartenKachel(tablet.karteArt, x, y, z, () => { ui.schmutzig = true; }),
    meterProPixel,
  },
};

// ─────────────────────────────────────────────────────────────────
// SITZUNG
// ─────────────────────────────────────────────────────────────────

async function pruefeXR() {
  zustand.xr = { vr: false, ar: false };
  if (navigator.xr) {
    try { zustand.xr.vr = await navigator.xr.isSessionSupported('immersive-vr'); } catch { /* keine Brille */ }
    try { zustand.xr.ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch { /* keine Durchsicht */ }
  }
  gemeinsam.geraetSetzen(zustand.xr.vr || zustand.xr.ar ? 'brille' : 'bildschirm');
  hinweisZeigen();
  knoepfeAktualisieren();
  verbindenZeigen();
}

function hinweisZeigen() {
  const p = el.hinweis;
  p.replaceChildren();
  let text = '';
  if (!window.isSecureContext) {
    text = `Die Brille öffnet VR nur über https oder localhost. Diese Seite kam über http://${location.host}. ` +
      'Am Mac frontend/tools/quest-wlan.sh starten und die https-Adresse öffnen, die es anzeigt.';
  } else if (!navigator.xr) {
    text = 'Dieser Browser kennt kein WebXR. In der Quest den Meta-Browser nehmen, auf der Vision Pro Safari (ab visionOS 2).';
  } else if (!zustand.xr.vr && !zustand.xr.ar) {
    text = 'Keine Brille gefunden — das hier ist die Vorschau am Bildschirm. Klick auf ein Bauteil zeigt seine Daten im Tablet rechts.';
  }
  p.textContent = text;
  p.hidden = !text;
}

// ─────────────────────────────────────────────────────────────────
// BRILLE VERBINDEN — am Mac, beim Klick auf 🥽 in iLEEN
// ─────────────────────────────────────────────────────────────────
//
// Fest ist der Port, nicht die Adresse: jedes Netz vergibt dem Mac eine andere.
// Der Quest-Dienst (tools/quest-wlan.sh) schreibt den aktuellen Stand, seine
// Weiche gibt ihn unter http://localhost:5443/ileen-quest.json heraus. Hier
// steht dann, was man in der Brille eintippt — und ob schon eine angekommen ist.

const AM_MAC = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const QUEST_PORT = Number((window.ILEEN_CONFIG && window.ILEEN_CONFIG.questPort) || 5443);

function knoten(tag, klasse, text) {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}

function netzVon(ip) {
  const t = String(ip || '').split('.');
  return t.length === 4 ? `${t[0]}.${t[1]}.${t[2]}.x` : '';
}

let questDienstDa = true;
async function verbindenZeigen() {
  const box = el.verbinden;
  if (!box) return;
  if (!AM_MAC || zustand.xr.vr || renderer.xr.isPresenting) { box.hidden = true; return; }
  let stand = null;
  try {
    const r = await fetch(`http://localhost:${QUEST_PORT}/ileen-quest.json`, { cache: 'no-store' });
    if (r.ok) stand = await r.json();
  } catch { /* Dienst aus */ }
  questDienstDa = !!stand;
  const kopf = knoten('div', 'vr-verbinden__kopf');
  kopf.append(knoten('strong', '', 'Brille verbinden'));
  const dienst = knoten('span', 'vr-verbinden__dienst', stand ? 'Quest-Dienst läuft' : 'Quest-Dienst aus');
  if (!stand) dienst.dataset.aus = '';
  kopf.append(dienst);
  const teile = [kopf];
  if (!stand || !stand.haupt) {
    const p = knoten('p');
    p.append(stand ? 'Der Mac hat gerade keine Adresse in einem Netz. ' : 'Ohne ihn kommt die Brille nicht hierher. Im Terminal: ',
      knoten('code', '', 'frontend/tools/quest-dienst.sh install'), stand ? '' : ' (braucht Docker fürs Backend).');
    teile.push(p);
  } else {
    const port = stand.port || QUEST_PORT;
    // Feste Adresse: im iPhone-WLAN (tools/quest-festip.sh) oder im eigenen WLAN des Macs
    const eigenesWlan = !!stand.freigabe;
    const wlanName = stand.festArt === 'mac-wlan' ? 'WLAN des Macs' : 'iPhone-WLAN';
    teile.push(knoten('p', '', eigenesWlan ? `Brille ins ${wlanName}, dann immer:` : 'Im Browser der Brille eintippen:'));
    teile.push(knoten('span', 'vr-verbinden__adresse', `${stand.haupt}:${port}`));
    const fest = knoten('p');
    fest.append('oder fest, in jedem Netz: ', knoten('b', '', `${stand.fest || 'ileen.local'}:${port}`),
      ' — nur, wenn die Brille .local-Namen auflöst (bei der Quest unbelegt).');
    teile.push(fest);
    // Safari nimmt keine Zertifikatswarnung hin: die Zertifizierungsstelle des Macs muss als Profil aufs Gerät
    const apple = knoten('p');
    apple.append('Vision Pro, iPad, iPhone: einmal ', knoten('b', '', `http://${stand.haupt}:${port}/einrichten`),
      ' öffnen — Profil laden, installieren, vertrauen. Danach wie oben.');
    teile.push(apple);
    const haupt = (stand.adressen || []).find(a => a.ip === stand.haupt);
    const weitere = (stand.adressen || []).filter(a => a.ip !== stand.haupt).map(a => `${a.ip} (${a.schnittstelle})`);
    if (eigenesWlan) {
      teile.push(knoten('p', '', `${stand.festArt === 'mac-wlan' ? 'Eigenes WLAN des Macs (Internetfreigabe)' : 'Im WLAN des iPhones (Persönlicher Hotspot)'} — ` +
        `diese Adresse bleibt an jedem Ort gleich.${weitere.length ? ` Weitere Adressen: ${weitere.join(', ')}.` : ''}`));
    } else {
      teile.push(knoten('p', '', `Mac im Netz ${netzVon(stand.haupt)}${haupt ? ` über ${haupt.schnittstelle}` : ''}` +
        `${weitere.length ? ` · weitere Adressen: ${weitere.join(', ')}` : ''}. Der Port bleibt 5443, die Adresse vergibt jedes Netz neu.`));
      const festIp = knoten('p');
      festIp.append(`Feste Adresse ${stand.festIp || '172.20.10.14'}:${port}: iPhone-Hotspot einschalten, Mac und Brille in sein WLAN — einmal einrichten mit `,
        knoten('code', '', 'frontend/tools/quest-festip.sh install'), '.');
      teile.push(festIp);
    }
    const da = (stand.besucher || [])[0];
    if (da) {
      const wer = da.geraet === 'apple' ? 'Ein Apple-Gerät' : da.geraet === 'quest' ? 'Eine Quest' : 'Ein Gerät';
      teile.push(knoten('p', 'vr-verbinden__da',
        `✓ ${wer} aus ${netzVon(da.ip)} ist angekommen: ${da.ip}, vor ${da.vorSekunden < 90 ? `${da.vorSekunden} s` : `${Math.round(da.vorSekunden / 60)} min`}.`));
    } else if (eigenesWlan) {
      teile.push(knoten('p', '', `Noch keine Brille angekommen — die Brille ins ${wlanName} bringen.`));
    } else {
      teile.push(knoten('p', '', `Noch keine Brille angekommen. Brille und Mac müssen im selben Netz sein (hier ${netzVon(stand.haupt)}) — ` +
        'Gast-WLAN und eduroam trennen Geräte. Steht die Brille in einem anderen (etwa 192.168.2.x): sie ins WLAN des Macs, ' +
        'den Mac zusätzlich in ihres (die Adresse erscheint dann hier) oder beide in einen Handy-Hotspot.'));
    }
  }
  box.replaceChildren(...teile);
  box.hidden = false;
  el.hinweis.hidden = true;
}
// Alle 4 s, ohne Dienst alle 20 s: Chrome meldet jeden abgewiesenen Abruf in der Konsole.
(function nachsehen() {
  setTimeout(() => {
    (document.hidden ? Promise.resolve() : verbindenZeigen()).finally(nachsehen);
  }, questDienstDa ? 4000 : 20000);
})();

function knoepfeAktualisieren() {
  const bereit = !!tiles && zustand.ausgerichtet && !renderer.xr.isPresenting;
  el.knopfVR.disabled = !(bereit && zustand.xr.vr);
  el.knopfTisch.disabled = !(bereit && zustand.xr.ar);
  el.knopfTisch.title = zustand.xr.vr && !zustand.xr.ar
    ? 'Das Tischmodell braucht die Durchsicht (immersive-ar). Diese Brille bietet sie im Browser nicht an — Safari auf der Vision Pro kann nur 1:1.'
    : '';
}

/**
 * Die Sitzung beginnen. `job` (aus iLEEN) lädt das Modell erst jetzt: Der Klick
 * auf den Schalter in iLEEN kommt aus dem Elternfenster, und `requestSession`
 * gilt nur kurz nach einer Geste — also zuerst die Sitzung anfragen, dann laden.
 * Das Modell trifft dann in der Brille ein; `ausrichten()` setzt die Lage nach.
 */
async function betreten(modus, job) {
  if (renderer.xr.isPresenting) return;
  // Sind schon andere im Raum, sieht man, was sie sehen (vr-gemeinsam.js)
  const gruppe = gemeinsam.modellFuerBeitritt();
  if (gruppe) job = gruppe.job;
  if (!tiles && !job) { status('Erst ein Modell wählen', 'fehler'); return; }
  if (!navigator.xr) { status('Dieser Browser kennt kein WebXR.', 'fehler'); return; }
  // requestSession muss in der Geste bleiben: kein await davor.
  const art = modus === 'tisch' ? 'immersive-ar' : 'immersive-vr';
  const anfrage = navigator.xr.requestSession(art, {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hand-tracking'],
  });
  if (job && job !== zustand.job) ladeModell(job, gruppe ? gruppe.name : job, { vonGruppe: !!gruppe });
  let session;
  try {
    session = await anfrage;
  } catch (e) {
    status(`Die Brille hat abgelehnt: ${e.message}`, 'fehler');
    return;
  }
  // Die Warteschlangen der Kachel-Bibliothek takten sich über requestAnimationFrame.
  // In einer immersiven Sitzung bekommt das Fenster keine Bilder mehr — ohne diese
  // Zeile blieben Download, Entpacken und Knoten-Aufbereitung stehen, und das
  // Modell bliebe unvollständig, so lange man auch wartet. Sofort nach dem
  // Anfordern, vor allem anderen: was bis hierher im Fenster angemeldet war,
  // wird dabei abgearbeitet.
  xrTakt(Scheduler, session);
  zustand.vorschauPose = { position: kamera.position.clone(), quaternion: kamera.quaternion.clone(), ziel: orbit.target.clone() };
  orbit.enabled = false;
  zustand.modus = modus;
  modusEinrichten();
  try {
    await renderer.xr.setSession(session);
  } catch (e) {
    xrTakt(Scheduler, null);
    status(`Die Brille hat abgelehnt: ${e.message}`, 'fehler');
    verlassen();
    return;
  }
  knoepfeAktualisieren();
  status(modus === 'tisch' ? 'Tischmodell in der Brille' : '1:1 in der Brille');
}

function modusEinrichten() {
  const tisch = zustand.modus === 'tisch';
  bodenSichtbarkeit();
  modell.position.set(0, 0, 0);
  modell.rotation.set(0, 0, 0);
  modell.scale.setScalar(tisch ? tischMassstab(...kastenGroesse()) : 1);
  nutzer.position.set(0, 0, 0);
  nutzer.quaternion.identity();
  // Kalibriert und mit der Gruppe: dort stehen, wo die anderen sind — statt Start und Tischplatz
  if (gemeinsam.modusBetreten()) zustand.tischPlatzieren = 0;
  else if (tisch) zustand.tischPlatzieren = 2;
  else startPose();
  if (tiles) tiles.errorTarget = FEHLER_ZIEL.brille;
  faktorenZuruecksetzen();
  const g = kastenGroesse();
  welt.modus(zustand.modus, Math.max(15, 0.75 * Math.max(g[0], g[2])));
  sichtSetzen();
  messungZeichnen();
  tabletAnhaengen();
  tabletMesh.visible = tablet.sichtbar && !!tabletMesh.parent;
  ui.schmutzig = true;
}

function verlassen() {
  xrTakt(Scheduler, null);        // zurück auf das Fenster-rAF der Bibliothek
  zustand.modus = 'vorschau';
  bodenSichtbarkeit();
  modell.position.set(0, 0, 0);
  modell.rotation.set(0, 0, 0);
  modell.scale.setScalar(1);
  nutzer.position.set(0, 0, 0);
  nutzer.quaternion.identity();
  ziel.visible = false;
  tabletMesh.visible = false;
  if (schwebe.an) { tabletMesh.removeFromParent(); schwebe.an = false; }
  zeigerPunkt.visible = false;
  for (const hand of haende) { hand.zielt = false; hand.haelt = null; hand.aufTablet = null; hand.tabletZug = null; }
  if (zustand.vorschauPose) {
    kamera.position.copy(zustand.vorschauPose.position);
    kamera.quaternion.copy(zustand.vorschauPose.quaternion);
    orbit.target.copy(zustand.vorschauPose.ziel);
  }
  // three.js hat der Kamera den Öffnungswinkel der Brille gegeben.
  kamera.fov = 60;
  kamera.zoom = 1;
  orbit.enabled = true;
  if (tiles) tiles.errorTarget = FEHLER_ZIEL.vorschau;
  faktorenZuruecksetzen();
  einblender.alleFreigeben();
  welt.modus('vorschau');
  sichtSetzen();
  messungZeichnen();
  groesseAnpassen();
  knoepfeAktualisieren();
  status('Bereit');
  gemeinsam.sitzungEnde();
  ui.schmutzig = true;
}

// ─────────────────────────────────────────────────────────────────
// BILDSCHLEIFE
// ─────────────────────────────────────────────────────────────────

// Nicht am `end` der Sitzung: das feuert, bevor three.js aufgeräumt hat, und
// `isPresenting` stünde dann noch auf true — die Knöpfe blieben gesperrt.
renderer.xr.addEventListener('sessionend', verlassen);

const uhr = new THREE.Timer();
let letzteGroesse = 1;
let letzterStatus = 0;

// ─────────────────────────────────────────────────────────────────
// MESSUNG — fps, Bildabstände, Kachelstand (vr-leistung.js)
// ─────────────────────────────────────────────────────────────────
//
// In der Brille gibt es keine Konsole und kein DOM: gezeigt wird der Stand im
// Tablet (Seite „Leistung"). Am Bildschirm hängt `?messung=1` ein Feld oben
// links ein; für Prüfsteine und die Konsole gibt `ILeenVR.leistung()` dasselbe
// als Objekt.

const leistungsMessung = new Messung();

/** Zielzeit je Bild: in der Brille die Bildrate der Sitzung (sonst 72 Hz, Quest), am Bildschirm 60 Hz. */
function bildBudget() {
  const sitzung = renderer.xr.isPresenting && renderer.xr.getSession && renderer.xr.getSession();
  if (!sitzung) return budgetMs(60);
  return budgetMs(sitzung.frameRate ? sitzung.frameRate : 72);
}

function leistung() {
  const info = renderer.info;
  return leistungsMessung.stand({
    budget: bildBudget(),
    zeichnen: {
      aufrufe: info.render.calls, dreiecke: info.render.triangles,
      geometrien: info.memory.geometries, texturen: info.memory.textures,
    },
    baeume: alleKacheln().map((t, i) => ({ name: i === 0 && t === tiles ? 'Modell' : (t === welt.gelaende ? 'Gelände' : 'Gebäude'), t })),
    extras: {
      modus: zustand.modus, xr: renderer.xr.isPresenting,
      texturen: { treffer: texturRegister.treffer, neu: texturRegister.neu, lebende: texturRegister.lebende() },
      regler: {
        guete: guete.faktor, druck: druck.faktor, angehoben: druck.angehoben,
        zurueckgehalten: einblender.warte.length, freigegeben: einblender.freigegeben,
        parseGestartet: parseTor.gestartet, parseErzwungen: parseTor.erzwungen,
        schalter: { ...SCHALTER },
      },
      extra: `Texturen geteilt: ${texturRegister.treffer} mitgenutzt · ${texturRegister.neu} neu dekodiert · ${texturRegister.lebende()} im Vorrat\n`
        + `Fehlerfaktor Bildzeit ×${guete.faktor.toFixed(2)} · Speicher ×${druck.faktor.toFixed(2)} (${druck.angehoben}× angehoben) · Puffer ab ${Math.round(puffer.anteil * 100)} % · `
        + `Einblender ${einblender.warte.length} wartet, ${einblender.freigegeben} frei · Entpacken ${parseTor.gestartet} gestartet (${parseTor.erzwungen} erzwungen)`,
    },
  });
}

// Lange Aufgaben des Browsers: was den Hauptfaden über 50 ms am Stück belegt
try {
  new PerformanceObserver(liste => { for (const e of liste.getEntries()) leistungsMessung.langeAufgabe(e.duration); })
    .observe({ type: 'longtask', buffered: false });
} catch { /* Browser ohne longtask */ }

// Feld am Bildschirm
/** Frisch geladene Kacheln nacheinander freigeben, solange die Bilder ihr Budget halten. */
function einblenden(jetzt) {
  if (!SCHALTER.einblenden || !einblender.warte.length) return;
  const budget = bildBudget();
  const erlaubt = (letzterAbstand === null || letzterAbstand <= budget * 1.2) && letzteSchleife <= budget - 3;
  einblender.bild(erlaubt, jetzt, letzterAbstand !== null && letzterAbstand <= budget * 0.85 && letzteSchleife <= budget * 0.6);
}

/**
 * Nach dem Zeichnen entscheiden, ob eine weitere Kachel anfangen darf zu
 * entpacken: höchstens eine je Bild, nur wenn vom Budget noch etwas übrig ist,
 * und nie mehr als PARSE_PARALLEL zugleich.
 */
function parseTreiben(bildStart) {
  const q = tiles && tiles.parseQueue;
  if (!SCHALTER.parse || !q || q.autoUpdate || !q.items.length || q.currJobs >= PARSE_PARALLEL) return;
  const jetzt = performance.now();
  if (!parseTor.erlaubt(bildBudget() - (jetzt - bildStart), jetzt)) return;
  q.maxJobs = q.currJobs + 1;
  q.tryRunJobs();
}

const messFeld = (() => {
  if (!PARAMETER.has('messung')) return null;
  const p = document.createElement('pre');
  p.id = 'vrMessung';
  p.style.cssText = 'position:fixed;left:8px;top:8px;z-index:50;margin:0;padding:8px 10px;max-width:70vw;' +
    'font:12px/1.4 ui-monospace,Menlo,monospace;color:#d8f0a0;background:rgba(0,0,0,.72);border-radius:6px;' +
    'pointer-events:none;white-space:pre-wrap';
  document.body.appendChild(p);
  return p;
})();

renderer.setAnimationLoop(zeit => {
  uhr.update(zeit);
  const dt = Math.min(uhr.getDelta(), 0.1);
  const jetzt = performance.now();
  letzterAbstand = leistungsMessung.bild(zeit);
  bildNr++;
  if (letzterAbstand !== null && renderer.xr.isPresenting && SCHALTER.guete) guete.bild(letzterAbstand, bildBudget(), jetzt);
  if (tiles && jetzt - druckPruefung > 250) {
    druckPruefung = jetzt;
    druck.bild(kachelStand(tiles), jetzt);
    // Lag = der GueteRegler hat gerade die Detailstufe senken müssen
    const anteil = puffer.bild(renderer.xr.isPresenting && SCHALTER.guete && guete.faktor > 1, jetzt);
    tiles.lruCache.minBytesSize = Math.round(CACHE_MAX * anteil);
  }
  if (renderer.xr.isPresenting) {
    if (zustand.tischPlatzieren > 0 && --zustand.tischPlatzieren === 0) tischPlatzieren();
    tabletSchweben(dt);
    tabletZielen();
    tabletZuege();
    steuern(dt);
    zielen();
    bodenPruefen(jetzt, dt);
    messTafelAusrichten();
  } else {
    orbit.update();
    messTafelAusrichten();
  }
  // Die anderen: Gruppe nachführen, eigene Pose senden, Avatare stellen
  gemeinsam.bild(jetzt);
  if (modell.scale.x !== letzteGroesse) {
    letzteGroesse = modell.scale.x;
    for (const m of punktStoffe) m.size = PUNKTGROESSE * letzteGroesse;
    messungZeichnen();
  }
  if (werkzeug.schnitt.an) {
    modell.updateMatrixWorld();
    schnittEbene.setFromNormalAndCoplanarPoint(UNTEN, modell.localToWorld(new THREE.Vector3(0, werkzeug.schnitt.hoehe, 0)));
  }
  const kachelStart = performance.now();
  kachelnAktualisieren();
  leistungsMessung.kachelZeit(performance.now() - kachelStart);
  tabletAktualisieren(jetzt);
  einblenden(jetzt);
  renderer.render(szene, kamera);
  parseTreiben(jetzt);
  letzteSchleife = performance.now() - jetzt;
  leistungsMessung.schleifeZeit(letzteSchleife);

  if (jetzt - letzterStatus > 400) {
    letzterStatus = jetzt;
    if (messFeld) messFeld.textContent = leistungZeilen(leistung()).join('\n');
    if (tablet.seite === 'leistung') ui.schmutzig = true;
    const p = ladestand();
    el.fortschritt.style.width = `${Math.round(p * 100)}%`;
    el.fortschritt.parentElement.classList.toggle('fertig', !(p < 1));
  }
});

function groesseAnpassen() {
  if (renderer.xr.isPresenting) return;
  const w = el.szene.clientWidth || 1;
  const h = el.szene.clientHeight || 1;
  renderer.setSize(w, h, false);
  kamera.aspect = w / h;
  kamera.updateProjectionMatrix();
}
new ResizeObserver(groesseAnpassen).observe(el.szene);
groesseAnpassen();

// Klick am Bildschirm: dasselbe Bauteil-Lesen wie in der Brille
{
  let unten = null;
  renderer.domElement.addEventListener('pointerdown', e => { unten = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!unten || renderer.xr.isPresenting || !tiles) return;
    const verschoben = Math.hypot(e.clientX - unten[0], e.clientY - unten[1]);
    unten = null;
    if (verschoben > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, kamera);
    raycaster.params.Points.threshold = 0.05;
    const treffer = ersterSichtbarer(raycaster.intersectObjects(strahlZiele({ mitBoden: false }), true), raycaster.ray);
    if (werkzeug.messen && treffer) { messPunkt(treffer.point); return; }
    auswahlSetzen(treffer ? bauteilAus(treffer) : null);
  });
}

// ─────────────────────────────────────────────────────────────────
// SEITE
// ─────────────────────────────────────────────────────────────────

function status(text, art = '') {
  el.status.textContent = text;
  el.status.dataset.art = art;
}

const SYMBOL = { ifc: '🏢', mesh: '🧊', pointcloud: '☁️', splat: '✨' };
const ART = { ifc: 'IFC', mesh: 'Mesh', pointcloud: 'Punktwolke', splat: 'Splat' };

async function listeLaden() {
  if (!backend) {
    el.liste.textContent = 'Keine Backend-Adresse — in iLEEN unter Modelle → Modell-Browser eintragen.';
    return;
  }
  try {
    const antwort = await fetch(`${backend}/assets/`);
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    zustand.assets = await antwort.json();
  } catch (e) {
    el.liste.textContent = `Backend unter ${backend} nicht erreichbar (${e.message}).`;
    return;
  }
  listeZeichnen();
  if (zustand.job) {
    const a = zustand.assets.find(x => x.job_id === zustand.job);
    if (a) {
      zustand.art = a.content_type;
      if (zustand.name === zustand.job) { zustand.name = a.name; el.titel.textContent = a.name; }
      ui.schmutzig = true;
    }
  }
}

function listeZeichnen() {
  if (!zustand.assets.length) return;
  const suche = el.suche.value.trim().toLowerCase();
  const eintraege = zustand.assets.filter(a => !suche || String(a.name).toLowerCase().includes(suche));
  el.liste.replaceChildren(...eintraege.map(a => {
    const knopf = document.createElement('button');
    knopf.type = 'button';
    knopf.className = 'vr-modell';
    const faehig = VR_FAEHIG.has(a.content_type);
    knopf.disabled = !faehig;
    knopf.classList.toggle('aktiv', a.job_id === zustand.job);
    if (!faehig) knopf.title = 'Diese Art Inhalt kann die Brille noch nicht zeigen.';
    const symbol = document.createElement('span');
    symbol.className = 'vr-modell__symbol';
    symbol.textContent = SYMBOL[a.content_type] || '📦';
    const name = document.createElement('span');
    name.className = 'vr-modell__name';
    name.textContent = a.name;
    const art = document.createElement('span');
    art.className = 'vr-modell__art';
    art.textContent = faehig ? (ART[a.content_type] || a.content_type) : `${ART[a.content_type] || a.content_type} · noch nicht in VR`;
    knopf.append(symbol, name, art);
    knopf.addEventListener('click', () => ladeModell(a.job_id, a.name));
    return knopf;
  }));
}

el.suche.addEventListener('input', listeZeichnen);
el.knopfVR.addEventListener('click', () => betreten('vr'));
el.knopfTisch.addEventListener('click', () => betreten('tisch'));
el.boden.checked = zustand.raster;
el.boden.addEventListener('change', () => aktionen.raster(el.boden.checked));
navigator.xr && navigator.xr.addEventListener && navigator.xr.addEventListener('devicechange', pruefeXR);
bodenSichtbarkeit();
sichtSetzen();

/** Für Prüfsteine: eine Trefferfläche des Tablets über ihre Kennung antippen. */
function tabletDruecken(id) {
  tabletZeichnen(ui, app);
  const r = ui.regionen.find(x => x.id === id);
  if (!r) return false;
  ui.klick(r.x + r.w / 2, r.y + r.h / 2);
  tabletZeichnen(ui, app);
  return true;
}

// Für Konsole und Prüfstein (tests/vr/test-vr*.mjs)
window.ILeenVR = {
  get zustand() { return zustand; },
  get tiles() { return tiles; },
  get auswahl() { return auswahl; },
  THREE, renderer, szene, nutzer, modell, kamera, orbit, haende, backend,
  welt, ebenen, ui, app, werkzeug, tablet, tabletMesh, schwebe, schnittEbenen,
  ladeModell, betreten, pruefeXR, tabletDruecken, hinspringen, lokalZuGrad, gradZuLokal, gemeinsam,
  leistung, leistungsMessung, texturRegister, guete, druck, puffer, einblender, parseTor,
};

const start = PARAMETER.get('job');
if (start) ladeModell(start, start);
else status('Modell wählen');
listeLaden();
pruefeXR();
