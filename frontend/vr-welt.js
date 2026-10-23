// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Die Welt um das Modell — Gelände, Luftbild oder Karte, Nachbargebäude.
//
// Gestreamt wird wie beim Modell: Daten, keine Bilder. Die Brille holt sich
// Höhen- und Bildkacheln selbst, so fein, wie ihr Blickfeld es verlangt.
// Nichts davon läuft über das Backend; die Quellen sind dieselben wie im
// Viewer (kartenquellen.js, gelaende.js), nur ohne Cesium:
//
//   Gelände   Mapterhorn (DGM der Länder) über Re:Earth, sonst Terrain Tiles
//   Bild      Sentinel-2 + DOP20 der Länder · basemap.de + OSM · OSM
//   Gebäude   basemap.de 3D LoD2
//
// Das Gelände rechnet `3d-tiles-renderer` (TerrainRGBMeshPlugin) auf der GPU:
// Jede Höhenkachel verschiebt ein Gitter, das Bild kommt als Overlay darauf.
// Ein Overlay ist hier ein **Mosaik**: Für jede Kachel werden die Schichten
// der gewählten Karte (vr-rechnen.js → KARTEN) übereinander in eine Leinwand
// gezeichnet — Sentinel-2 unten, darüber die DOP der Länder, die dort etwas
// zeigen. Das ImageOverlayPlugin der Bibliothek kann mehrere Overlays mischen,
// zerreißt aber das GPU-verschobene Gelände, sobald es Kacheln teilt; ohne
// Teilen endet es bei Ebene 15 (~800 m je Kachel) und bleibt unscharf. Das
// Mosaik als einziges Overlay des Gelände-Plugins verfeinert bis Ebene 19,
// also bis zum 20-cm-Raster der DOP.
//
// Höhen: Alle Quellen liefern Meter über dem Meer, die Modelle stehen auf dem
// Ellipsoid. Die Gruppen werden deshalb um die Geoidundulation N (geoid.js,
// EGM96) angehoben — wie gelaende.js es je Stützstelle tut. Auf ein paar
// Kilometer ändert sich N um Zentimeter; eine Verschiebung reicht.
//
// Am Modell: Wo das Gebäude steht, liegt das Gelände oft über seiner Sohle
// (Keller, grobes Raster, Platzierung). Im Grundriss wird es deshalb im
// Vertex-Shader unter die Sohle gesenkt, und LoD2-Gebäude dort (das eigene
// Gebäude im amtlichen Bestand) fallen weg. Im Tischmodell endet die Welt an
// einem Kreis um das Modell.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';
import {
  TilesRenderer, LRUCache, PriorityQueue, DownloadPriorityQueue,
  DEFAULT_LRU_CACHE, DEFAULT_DOWNLOAD_QUEUE, DEFAULT_PARSE_QUEUE,
} from 'https://cdn.jsdelivr.net/npm/3d-tiles-renderer@0.5.3/build/index.js';
import {
  TerrainRGBMeshPlugin, TerrariumMeshPlugin, XYZTilesOverlay,
} from 'https://cdn.jsdelivr.net/npm/3d-tiles-renderer@0.5.3/build/index.plugins.js';
import {
  KARTEN, GELAENDE, LOD2, schichtPasst, schichtQuelle, kartenVermerke, inDeutschland, imFuss,
} from './vr-rechnen.js';

// Zulässiger Bildschirmfehler in Pixeln. Gelände und Nachbarn dürfen gröber
// sein als das Modell: man schaut auf das Gebäude, nicht auf den Acker.
const FEHLER = {
  gelaende: { vorschau: 8, brille: 16 },
  gebaeude: { vorschau: 12, brille: 20 },
};
// Eigene Warteschlangen und eigener Speicher für die Welt. `3d-tiles-renderer`
// 0.5 gibt sonst jedem TilesRenderer dieselben: einen Speicher, fünf Plätze
// zum Parsen. Eine Geländekachel hält ihren Parse-Platz, bis ihr Luftbild da
// ist — und die WMS der Länder brauchen dafür Sekunden. Geteilt verhungerte
// so das Modell (Buddha-Splat: 13 Kacheln 20 s lang „parsing“), und die
// kleine Welt-Grenze am gemeinsamen Speicher wies Modellkacheln ab.
// Gezählt wird geschätzt: das Höhenraster jeder Geländekachel zählt mehrfach,
// liegt auf der Grafikkarte aber nur einmal je Quellkachel.
const speicher = new LRUCache();
speicher.unloadPriorityCallback = DEFAULT_LRU_CACHE.unloadPriorityCallback;
speicher.minBytesSize = 100 * 2 ** 20;
speicher.maxBytesSize = 280 * 2 ** 20;
const laden = new DownloadPriorityQueue();
laden.maxJobsPerOrigin = 10;
laden.priorityCallback = DEFAULT_DOWNLOAD_QUEUE.priorityCallback;
const parsen = new PriorityQueue();
parsen.maxJobs = 8;
parsen.priorityCallback = DEFAULT_PARSE_QUEUE.priorityCallback;
const bilder = new DownloadPriorityQueue();
bilder.maxJobsPerOrigin = 8;
bilder.priorityCallback = DEFAULT_DOWNLOAD_QUEUE.priorityCallback;

function eigeneWarteschlangen(t) {
  t.lruCache = speicher;
  t.downloadQueue = laden;
  t.parseQueue = parsen;
}

// Wo kein Bild kommt (Netz weg, Meer ohne Kachel): ein ruhiges Graugrün.
const GRUND = '#a3a996';
// Unter diese Höhe (Modellrahmen) wird das Gelände im Grundriss gesenkt.
export const SOHLE = -0.05;
// So weit um den Grundriss herum fallen LoD2-Gebäude weg (m).
const GEBAEUDE_RAND = 1.5;

// ─────────────────────────────────────────────────────────────────
// KACHELBILDER — ein Mosaik je Kachel, für Gelände und Minikarte
// ─────────────────────────────────────────────────────────────────

function leinwand(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

async function bildLaden(url, holen, signal) {
  const antwort = await holen(url, { signal, mode: 'cors', credentials: 'omit' });
  if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
  return createImageBitmap(await antwort.blob());
}

// Vorfahrenkacheln (Sentinel-2 unter Ebene 14) brauchen viele Kinder — einmal
// holen. Ohne Abbruchsignal: ein abgebrochenes Kind darf seinen Geschwistern
// das Bild nicht wegnehmen. Nicht schließen: ein laufendes Zusammensetzen
// könnte es noch zeichnen; den Speicher gibt der Sammler frei.
const vorfahren = new Map();
function vorfahr(url) {
  let p = vorfahren.get(url);
  if (p) {
    vorfahren.delete(url);
    vorfahren.set(url, p);
    return p;
  }
  p = bildLaden(url, (u, o) => fetch(u, o)).catch(() => null);
  vorfahren.set(url, p);
  if (vorfahren.size > 64) vorfahren.delete(vorfahren.keys().next().value);
  return p;
}

/**
 * Die Schichten der Karte `art` für Kachel (x, y, z) übereinander — eine
 * 256er-Leinwand. Eine Schicht, die nicht antwortet, fehlt einfach; nur ein
 * Abbruch (die Kachel wird nicht mehr gebraucht) geht weiter.
 */
export async function kachelZusammensetzen(art, x, y, z, { holen = (u, o) => fetch(u, o), signal } = {}) {
  const karte = KARTEN[art];
  const c = leinwand(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = GRUND;
  g.fillRect(0, 0, 256, 256);
  if (!karte) return c;
  const teile = karte.schichten.filter(s => schichtPasst(s, x, y, z)).map(s => {
    const q = schichtQuelle(s, x, y, z);
    const bild = q.ausschnitt
      ? vorfahr(q.url)
      : bildLaden(q.url, holen, signal).catch(e => { if (e && e.name === 'AbortError') throw e; return null; });
    return bild.then(b => ({ b, q }));
  });
  const bilder = await Promise.all(teile);
  if (signal) signal.throwIfAborted();
  g.imageSmoothingQuality = 'high';
  for (const { b, q } of bilder) {
    if (!b) continue;
    if (q.ausschnitt) {
      const [sx, sy, s] = q.ausschnitt;
      const f = b.width / 256;
      g.drawImage(b, sx * f, sy * f, s * f, s * f, 0, 0, 256, 256);
    } else {
      g.drawImage(b, 0, 0, 256, 256);
    }
  }
  return c;
}

/** Ein Overlay für das Gelände-Plugin, dessen Kacheln Mosaike sind. */
function mosaikOverlay(art) {
  const overlay = new XYZTilesOverlay({ url: `ileen-mosaik/${art}/{z}/{x}/{y}`, levels: 20 });
  overlay.downloadQueue = bilder;
  const quelle = overlay.imageSource;
  quelle.fetchItem = async ([x, y, z], signal) => {
    const c = await kachelZusammensetzen(art, x, y, z, { holen: (u, o) => quelle.fetchData(u, o), signal });
    const bild = await createImageBitmap(c, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const t = new THREE.Texture(bild);
    // Mit Mipmaps: Gelände sieht man in der Brille fast immer flach von der
    // Seite, ohne sie flimmert es in der Ferne.
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = 4;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return overlay;
}

// Minikarte: zusammengesetzte Kacheln im Speicher, die zuletzt benutzten zuletzt.
const kartenVorrat = new Map();

/** Bild der Kachel für die Minikarte, oder null, solange es lädt. `fertig` meldet das Eintreffen. */
export function kartenKachel(art, x, y, z, fertig) {
  const schluessel = `${art}/${z}/${x}/${y}`;
  const da = kartenVorrat.get(schluessel);
  if (da) {
    kartenVorrat.delete(schluessel);
    kartenVorrat.set(schluessel, da);
    return da.bild;
  }
  const eintrag = { bild: null };
  kartenVorrat.set(schluessel, eintrag);
  if (kartenVorrat.size > 160) kartenVorrat.delete(kartenVorrat.keys().next().value);
  kachelZusammensetzen(art, x, y, z)
    .then(c => { eintrag.bild = c; if (fertig) fertig(); })
    .catch(() => { kartenVorrat.delete(schluessel); });
  return null;
}

// ─────────────────────────────────────────────────────────────────
// AUSSCHNITT AM MODELL — Shader-Ergänzung für Gelände und LoD2
// ─────────────────────────────────────────────────────────────────

/** Gemeinsame Uniforms: geändert wird `.value`, alle Materialien sehen es sofort. */
const schnitt = {
  uIleenZuLokal: { value: new THREE.Matrix4() },     // Welt → Modellrahmen
  uIleenFuss: { value: new THREE.Vector4(0, 0, 1, 0) },     // Mitte x, z · Richtung u
  uIleenFussMass: { value: new THREE.Vector3(0, 0, 0) },    // halbe Seiten a, b · an (1) / aus (0)
  uIleenSohle: { value: SOHLE },
  uIleenRadius: { value: 1e9 },
  uIleenRand: { value: GEBAEUDE_RAND },
};

const GLSL_KOPF = /* glsl */`
  uniform mat4 uIleenZuLokal;
  uniform vec4 uIleenFuss;
  uniform vec3 uIleenFussMass;
  uniform float uIleenSohle;
  uniform float uIleenRadius;
  uniform float uIleenRand;
  varying vec3 vIleenLokal;
  bool ileenImFuss( vec3 l, float rand ) {
    if ( uIleenFussMass.z < 0.5 ) return false;
    vec2 d = l.xz - uIleenFuss.xy;
    vec2 u = uIleenFuss.zw;
    return abs( dot( d, u ) ) <= uIleenFussMass.x + rand && abs( - d.x * u.y + d.y * u.x ) <= uIleenFussMass.y + rand;
  }
`;

function ergaenzen(material, art) {
  const vorher = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (vorher) vorher.call(material, shader, renderer);
    Object.assign(shader.uniforms, schnitt);
    shader.vertexShader = GLSL_KOPF + shader.vertexShader;
    if (art === 'gelaende') {
      shader.vertexShader = shader.vertexShader.replace('#include <displacementmap_vertex>', /* glsl */`
        #include <displacementmap_vertex>
        {
          mat4 ileenM = uIleenZuLokal * modelMatrix;
          vec4 ileenL = ileenM * vec4( transformed, 1.0 );
          if ( ileenImFuss( ileenL.xyz, 0.0 ) && ileenL.y > uIleenSohle ) {
            ileenL.y = uIleenSohle;
            transformed = ( inverse( ileenM ) * ileenL ).xyz;
          }
        }
      `);
    }
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', /* glsl */`
      #include <project_vertex>
      vIleenLokal = ( uIleenZuLokal * modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    `);
    shader.fragmentShader = GLSL_KOPF + shader.fragmentShader.replace('#include <clipping_planes_fragment>', /* glsl */`
      #include <clipping_planes_fragment>
      if ( length( vIleenLokal.xz ) > uIleenRadius ) discard;
      ${art === 'gebaeude' ? 'if ( ileenImFuss( vIleenLokal, uIleenRand ) ) discard;' : ''}
    `);
    if (art === 'gebaeude') {
      // Dach rot, Wand hell — wie der Standardstil von basemap.de. Die
      // Richtung kommt aus der Fläche selbst; LoD2-Kacheln haben nicht immer Normalen.
      shader.fragmentShader = shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );', /* glsl */`
        vec3 ileenN = normalize( cross( dFdx( vIleenLokal ), dFdy( vIleenLokal ) ) );
        vec4 diffuseColor = vec4( abs( ileenN.y ) > 0.35 ? vec3( 0.29, 0.12, 0.09 ) : vec3( 0.34, 0.335, 0.32 ), opacity );
      `);
    }
  };
  material.customProgramCacheKey = () => `ileen-welt-${art}`;
  material.fog = true;
  material.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────────
// DIE WELT
// ─────────────────────────────────────────────────────────────────

/**
 * Legt die Welt an. Sie hängt unter `modell` (verkleinert sich also im
 * Tischmodus mit) und bleibt beim Modellwechsel bestehen: Die Kacheln liegen
 * im Erdsystem, nur der Rahmen wird neu gesetzt.
 */
export function weltAnlegen({ modell, meldung = () => {} }) {
  const gruppe = new THREE.Group();
  gruppe.name = 'welt';
  modell.add(gruppe);

  const gebaeudeStoff = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  ergaenzen(gebaeudeStoff, 'gebaeude');

  const welt = {
    gruppe,
    an: true,
    karte: 'luftbild',          // KARTEN-Schlüssel oder 'keine'
    relief: true,
    gebaeudeAn: true,
    quelle: 'mapterhorn',
    versatz: 0,                 // m, von Hand
    modus: 'vorschau',
    ort: null,                  // { lat, lon } in Bogenmaß, Mitte des Grundrisses
    N: null,                    // Geoidundulation am Ort
    rahmen: null,
    ellipsoid: null,
    fuss: null,
    gelaende: null,
    plugin: null,
    gebaeude: null,
    fehler: 0,
    geladenZahl: 0,
  };

  function gelaendeAnlegen() {
    gelaendeEntsorgen();
    const q = GELAENDE[welt.quelle];
    const Plugin = q.kodierung === 'terrarium' ? TerrariumMeshPlugin : TerrainRGBMeshPlugin;
    const mitBild = welt.karte !== 'keine' && KARTEN[welt.karte];
    welt.plugin = new Plugin({
      url: q.url, tileDimension: q.kachel, maxZoom: q.maxZoom, useRecommendedSettings: false,
      overlay: mitBild ? mosaikOverlay(welt.karte) : null, applyOverlayTexture: !!mitBild,
    });
    welt.plugin.heightScale = welt.relief ? 1 : 0;
    const t = new TilesRenderer();
    eigeneWarteschlangen(t);
    t.registerPlugin(welt.plugin);
    t.errorTarget = FEHLER.gelaende[welt.modus === 'vorschau' ? 'vorschau' : 'brille'];
    welt.fehler = 0;
    welt.geladenZahl = 0;
    t.addEventListener('load-model', ({ scene }) => {
      welt.geladenZahl++;
      scene.traverse(o => {
        if (!o.isMesh) return;
        if (!mitBild) o.material.color.set(0xb4b9a8);
        ergaenzen(o.material, 'gelaende');
      });
    });
    t.addEventListener('load-error', ({ error }) => {
      welt.fehler++;
      // Re:Earth nicht erreichbar: auf Terrain Tiles (AWS) ausweichen
      if (welt.quelle === 'mapterhorn' && welt.geladenZahl === 0 && welt.fehler >= 4) {
        console.warn('VR-Welt: Mapterhorn nicht erreichbar, weiter mit Terrain Tiles', error);
        welt.quelle = 'terrarium';
        meldung('Gelände: Mapterhorn nicht erreichbar, Terrain Tiles springen ein');
        setTimeout(gelaendeAnlegen, 0);
      }
    });
    welt.gelaende = t;
    gruppe.add(t.group);
    rahmenSetzen();
  }

  function gelaendeEntsorgen() {
    if (!welt.gelaende) return;
    welt.gelaende.group.removeFromParent();
    welt.gelaende.dispose();
    welt.gelaende = null;
    welt.plugin = null;
  }

  function gebaeudeAnlegen() {
    if (welt.gebaeude) return;
    const t = new TilesRenderer(LOD2.url);
    eigeneWarteschlangen(t);
    t.errorTarget = FEHLER.gebaeude[welt.modus === 'vorschau' ? 'vorschau' : 'brille'];
    t.addEventListener('load-model', ({ scene }) => {
      scene.traverse(o => { if (o.isMesh) o.material = gebaeudeStoff; });
    });
    // Einzelne Unterkacheln fehlen beim BKG (404) — kein Grund zur Meldung.
    t.addEventListener('load-error', () => {});
    welt.gebaeude = t;
    gruppe.add(t.group);
    rahmenSetzen();
  }

  function gebaeudeEntsorgen() {
    if (!welt.gebaeude) return;
    welt.gebaeude.group.removeFromParent();
    welt.gebaeude.dispose();
    welt.gebaeude = null;
  }

  function gruppeSetzen(ziel, dy) {
    if (!ziel || !welt.rahmen) return;
    const m = new THREE.Matrix4().makeTranslation(0, dy, 0).multiply(welt.rahmen);
    m.decompose(ziel.position, ziel.quaternion, ziel.scale);
    ziel.updateMatrixWorld(true);
  }

  /** Lokale Höhe eines Punkts auf dem Ellipsoid (h in m) unter der Grundrissmitte, ohne Versatz. */
  function lokalY(h) {
    const p = welt.ellipsoid.getCartographicToPosition(welt.ort.lat, welt.ort.lon, h, new THREE.Vector3());
    return p.applyMatrix4(welt.rahmen).y;
  }

  function rahmenSetzen() {
    if (!welt.rahmen || !welt.ort) return;
    const N = welt.N ?? 0;
    // Ohne Relief liegt die Karte flach auf Höhe der Sohle, mit Relief kommt die Undulation dazu.
    const dy = welt.relief ? N + welt.versatz : SOHLE * 0.6 - lokalY(0) + welt.versatz;
    if (welt.gelaende) gruppeSetzen(welt.gelaende.group, dy);
    if (welt.gebaeude) gruppeSetzen(welt.gebaeude.group, N + welt.versatz);
  }

  function sichtbarkeit() {
    const verortet = !!welt.ort;
    gruppe.visible = welt.an && verortet;
    if (welt.gelaende) welt.gelaende.group.visible = gruppe.visible;
    const lod2 = gruppe.visible && welt.gebaeudeAn && inDeutschland(grad(welt.ort?.lat), grad(welt.ort?.lon));
    if (lod2) gebaeudeAnlegen();
    if (welt.gebaeude) welt.gebaeude.group.visible = lod2;
  }

  const api = {
    get gruppe() { return gruppe; },
    get zustand() { return welt; },

    /**
     * Für ein neu ausgerichtetes Modell. `rahmen` = Erdsystem → Modellrahmen
     * (dieselbe Matrix wie tiles.group), `ort` in Bogenmaß, `fuss` aus
     * vr-rechnen.js → fussRechteck, oder null für ein unverortetes Modell.
     */
    async einrichten({ rahmen, ellipsoid, ort, fuss }) {
      welt.ellipsoid = ellipsoid;
      welt.rahmen = ort ? rahmen.clone() : null;
      welt.ort = ort || null;
      welt.fuss = fuss || null;
      const mf = schnitt.uIleenFussMass.value;
      if (fuss) {
        schnitt.uIleenFuss.value.set(fuss.cx, fuss.cz, fuss.ux, fuss.uz);
        mf.set(fuss.a, fuss.b, 1);
      } else {
        mf.set(0, 0, 0);
      }
      if (!ort) { sichtbarkeit(); return; }
      welt.N = null;
      if (window.ILEEN_GEOID) {
        await window.ILEEN_GEOID.load();
        welt.N = window.ILEEN_GEOID.getUndulation(grad(ort.lat), grad(ort.lon));
      }
      if (welt.N === null) meldung('Geoid nicht geladen — Gelände ohne Undulation');
      if (!welt.gelaende && welt.an) gelaendeAnlegen();
      rahmenSetzen();
      sichtbarkeit();
    },

    setzen(neu) {
      const vorher = { ...welt };
      Object.assign(welt, neu);
      if (!welt.ort) { sichtbarkeit(); return; }
      // Ausgeschaltet wird entsorgt: ein verstecktes TilesRenderer behielte
      // seinen ganzen Kachelspeicher, und die Quest wirft Tabs über ~1 GB weg.
      if (!welt.an) gelaendeEntsorgen();
      else if (!welt.gelaende || welt.karte !== vorher.karte || welt.quelle !== vorher.quelle) gelaendeAnlegen();
      if (welt.plugin && welt.relief !== vorher.relief) welt.plugin.heightScale = welt.relief ? 1 : 0;
      if (!welt.gebaeudeAn || !welt.an) gebaeudeEntsorgen();
      rahmenSetzen();
      sichtbarkeit();
    },

    /** 'vorschau' | 'vr' | 'tisch'; im Tisch endet die Welt bei `radius` (Modellrahmen, m). */
    modus(modus, radius = 1e9) {
      welt.modus = modus;
      schnitt.uIleenRadius.value = modus === 'tisch' ? radius : 1e9;
      const art = modus === 'vorschau' ? 'vorschau' : 'brille';
      if (welt.gelaende) welt.gelaende.errorTarget = FEHLER.gelaende[art];
      if (welt.gebaeude) welt.gebaeude.errorTarget = FEHLER.gebaeude[art];
    },

    /** Je Bild, vor dem Kachel-Update: Welt → Modellrahmen für die Shader. */
    bild() {
      gruppe.parent.updateMatrixWorld();
      schnitt.uIleenZuLokal.value.copy(gruppe.parent.matrixWorld).invert();
    },

    /** Die TilesRenderer, die gerade etwas zu tun haben. */
    renderer() {
      if (!gruppe.visible) return [];
      const r = [];
      if (welt.gelaende && welt.gelaende.group.visible) r.push(welt.gelaende);
      if (welt.gebaeude && welt.gebaeude.group.visible) r.push(welt.gebaeude);
      return r;
    },

    /** Ziele für Strahlen. `nurGelaende`: ohne Nachbargebäude (zum Absetzen). */
    ziele(nurGelaende = false) {
      return api.renderer().filter(t => !nurGelaende || t === welt.gelaende).map(t => t.group);
    },

    /**
     * Gehört ein Treffer zur Welt und liegt er dort, wo sie am Modell
     * beschnitten ist? 'gelaende': Gelände im Grundriss über der Sohle — im
     * Shader abgesenkt, die CPU-Kopie zum Zielen kennt das nicht; der Aufrufer
     * setzt den Schnitt mit der Sohlfläche an seine Stelle. 'gebaeude': ein
     * LoD2-Gebäude, das im Grundriss wegfällt. Sonst false.
     */
    unsichtbarerTreffer(treffer, lokal) {
      if (!welt.fuss) return false;
      let o = treffer.object;
      const g = welt.gelaende && welt.gelaende.group;
      const b = welt.gebaeude && welt.gebaeude.group;
      while (o && o !== g && o !== b) o = o.parent;
      if (!o) return false;
      if (o === g) return imFuss(welt.fuss, lokal.x, lokal.z) && lokal.y > SOHLE + 1e-3 ? 'gelaende' : false;
      return imFuss(welt.fuss, lokal.x, lokal.z, GEBAEUDE_RAND) ? 'gebaeude' : false;
    },

    gehoertDazu(objekt) {
      let o = objekt;
      while (o && o !== gruppe) o = o.parent;
      return !!o;
    },

    /** Höhe des Geländes unter der Grundrissmitte im Modellrahmen (m) oder null. */
    gelaendeMitte() {
      if (!welt.plugin || !welt.ort || !welt.rahmen) return null;
      const h = welt.plugin.sampleCartographicElevation(welt.ort.lat, welt.ort.lon);
      if (h === null || h === undefined) return null;
      if (!welt.relief) return SOHLE * 0.6 + welt.versatz;
      return lokalY(h) + (welt.N ?? 0) + welt.versatz;
    },

    /** Versatz so, dass das Gelände in der Grundrissmitte knapp unter der Sohle liegt. */
    anlegen() {
      const y = api.gelaendeMitte();
      if (y === null) return false;
      welt.versatz += SOHLE * 0.6 - y;
      rahmenSetzen();
      return true;
    },

    vermerke() {
      if (!welt.ort || !gruppe.visible) return [];
      const lat = grad(welt.ort.lat);
      const lon = grad(welt.ort.lon);
      const v = [GELAENDE[welt.quelle].credit, ...kartenVermerke(welt.karte, lat, lon)];
      if (welt.gebaeude && welt.gebaeude.group.visible) v.push(LOD2.credit);
      return v;
    },

    /** Ladestand 0…1 über Gelände und Gebäude. */
    fortschritt() {
      const r = api.renderer();
      if (!r.length) return 1;
      return Math.min(...r.map(t => (Number.isFinite(t.loadProgress) ? t.loadProgress : 1)));
    },
  };
  return api;
}

function grad(rad) {
  return rad * 180 / Math.PI;
}
