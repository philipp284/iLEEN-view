// Prüfsteine der Zustands-Registry (zustand.js) und ihrer Anmelder (zustand-anmelder.js)
// — ohne Browser, die Werkzeuge sind Attrappen.
//
// Geprüft wird, woran eine Folie mit Szene scheitern würde, ohne dass man es
// sofort sieht:
//
//   · MISCHEN. Was eine Zahl ist, fährt zwischen zwei Folien mit; was nicht,
//     bleibt wie in B. Winkel gehen den kurzen Weg. Ein Pfad, der nur in einem
//     der beiden Zustände vorkommt, springt.
//   · ÜBERGANGSSTART. Zu Beginn eines Übergangs steht der AUFBAU von B, aber mit
//     den Zahlen von A — sonst sprängen die weichen Größen schon im ersten Bild.
//   · RUNDLAUF. Je Anmelder: lesen → verstellen → anwenden → lesen gibt den
//     ersten Stand zurück. Ohne das ist `setzen` nicht idempotent, und jede
//     Folie lädt Modelle neu oder baut Scheiben doppelt.
//   · REIHENFOLGE. Modelle vor Schnitt: der Schnitt braucht das Modell.
//   · ROBUSTHEIT. Ein Anmelder, der wirft, stoppt die übrigen nicht.
//
// Aufruf:  node tests/zustand/test-zustand.js

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const wurzel = join(hier, '..', '..');

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};
const nahe = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const json = (x) => JSON.stringify(x);

// ═══════════════════════════════════════════════════════════════════════════
// Die Attrappen der Werkzeuge
// ═══════════════════════════════════════════════════════════════════════════

function attrappe() {
  const log = [];
  const B = { log };

  // ── Modelle ──
  B.loadedAssets = new Map();
  B.zOffset = { individualOffsets: new Map() };
  B.rotation = { individualHeadings: new Map() };
  B.translation = { individualOffsets: new Map() };
  B.cinematicFlyToTileset = async () => { log.push('FLUG'); };
  const neu = (key, name, extra) => {
    B.loadedAssets.set(key, Object.assign({ id: key, name, tileset: { show: true }, visible: true, opacity: 1, type: 'BACKEND' }, extra));
  };
  B.loadBackendAsset = async function (jobId, name) {
    log.push('laden:' + jobId);
    await this.cinematicFlyToTileset();          // wie im echten core.js
    neu('backend_' + jobId, name || jobId, { jobId });
  };
  B.loadSelectedAsset = async function (assetId, name) {
    log.push('ion:' + assetId);
    neu(String(assetId), name || 'ion', { type: '3DTILES' });
  };
  B.loadBackendAssetByUrl = async function (url, name) {
    log.push('url:' + url);
    neu('backend_url_' + url.length, name || url, { url });
  };
  B.toggleAssetVisibility = function (id) { const a = this.loadedAssets.get(id); a.visible = !a.visible; a.tileset.show = a.visible; };
  B.updateAssetOpacity = function (id, w) { this.loadedAssets.get(id).opacity = w; };
  B.applyIndividualZOffset = async function (id, m) { this.zOffset.individualOffsets.set(this.loadedAssets.get(id).tileset, m); };
  B.applyIndividualRotation = async function (id, h) { this.rotation.individualHeadings.set(this.loadedAssets.get(id).tileset, h); };
  B.applyIndividualTranslation = async function (id, e, n) { this.translation.individualOffsets.set(this.loadedAssets.get(id).tileset, { east: e, north: n }); };

  // ── Filter ──
  B.ifcFilter = { allEntities: new Set(['IfcWall', 'IfcSlab', 'IfcSpace', 'IfcDoor']), enabledEntities: new Set(['IfcWall', 'IfcSlab', 'IfcSpace', 'IfcDoor']) };
  B.ifcHighlight = { ids: new Set(), color: '#ff2d95' };
  B.filterLauf = 0;
  B.applyIFCFilter = async function () { this.filterLauf++; };
  B.updateIFCFilterUI = function () {};
  B.highlightIFCElements = async function (ids, opt) { this.ifcHighlight.ids = new Set(ids); if (opt && opt.farbe) this.ifcHighlight.color = opt.farbe; };
  B.clearIFCHighlight = function () { this.ifcHighlight.ids = new Set(); };
  B.hiddenFeatures = { isHideMode: false, eintraege: [] };
  B.showAllHidden = function () { this.hiddenFeatures.eintraege = []; };
  B.reapplyHiddenFeatures = function () {};
  B._ausgeblendetZaehlen = function () {};
  B.detectGuidProperty = () => 'GlobalId';

  // ── Schnitt (vereinfacht nach schnitt.js: Namen vergibt er selbst) ──
  const Zs = { an: false, modus: 'innen', flaechen: true, kante: true, griffe: true,
               box: null, szene: { min: [-50, -50, -5], max: [50, 50, 30] }, scheiben: [], naechsteId: 1, yaw: 0 };
  B.Schnitt = {
    get an() { return Zs.an; },
    zustand: Zs,
    starten() { Zs.an = true; Zs.box = Zs.box || { min: Zs.szene.min.slice(), max: Zs.szene.max.slice() }; return true; },
    beenden() { Zs.an = false; },
    setBox(min, max) { Zs.box = { min: min.slice(), max: max.slice() }; },
    ganz() { Zs.box = { min: Zs.szene.min.slice(), max: Zs.szene.max.slice() }; },
    setModus(m) { Zs.modus = m; }, setFlaechen(a) { Zs.flaechen = a; }, setKante(a) { Zs.kante = a; }, setGriffe(a) { Zs.griffe = a; },
    setYaw(g) { Zs.yaw = g; },
    scheibeNeu(roh) {
      const s = { id: Zs.naechsteId++, name: 'S' + (Zs.scheiben.length + 1) + '-auto', winkel: roh.winkel, d: roh.d, dicke: roh.dicke, an: true };
      Zs.scheiben.push(s); return s;
    },
    scheibeSetzen(id, w) { const s = Zs.scheiben.filter((x) => x.id === id)[0]; Object.assign(s, w); },
    scheibeWeg(id) { Zs.scheiben = Zs.scheiben.filter((s) => s.id !== id); },
    stand() {
      return { an: Zs.an, modus: Zs.modus, yaw: Zs.yaw, box: Zs.box && { min: Zs.box.min.slice(), max: Zs.box.max.slice() },
               scheiben: Zs.scheiben.map((s) => Object.assign({}, s)) };
    },
  };

  // ── Explosion ──
  B.Explosion = {
    aktiv: false, abstand: 3, flach: 0, fuge: 0.15, regelhoehe: 3, maxAbstand: 15,
    async an() { this.aktiv = true; },
    aus() { this.aktiv = false; },
    abstandSetzen(m) { this.abstand = m; },
    flachSetzen(w) { this.flach = w; },
  };

  // ── Notizen ──
  let nAn = true, nOffen = false, nWeite = 1000, nIds = null;
  global.__annot = null;
  const Annotations = {
    isEnabled: () => nAn, setEnabled: (a) => { nAn = a; }, isOnlyOpen: () => nOffen, setOnlyOpen: (a) => { nOffen = a; },
    getMaxDistance: () => nWeite, setMaxDistance: (m) => { nWeite = m; },
    getVisibleSet: () => (nIds ? nIds.slice() : null), setVisibleSet: (ids) => { nIds = Array.isArray(ids) ? ids.slice() : null; },
  };

  // ── Farben / Licht ──
  const FS = { an: true, kelvin: 6050, tint: 0, belichtung: 1, kontrast: 1, saettigung: 1, staerke: 1, umgebung: true,
               umgebungSaettigung: 0.4, umgebungHelligkeit: 2.2, bodenfarbe: '#8e8e8a', schema: 'neutral',
               neutralAn: true, neutral: 0.9, grundton: 0.62, zeichnung: 0.55, glas: true, glasFarbe: '#3b4044', glasAnteil: 0.75 };
  B.Farben = { stand: () => Object.assign({ modelle: 2, traeger: 3, wirkt: true }, FS) };
  Object.entries({ kelvinSetzen: 'kelvin', tintSetzen: 'tint', belichtungSetzen: 'belichtung', kontrastSetzen: 'kontrast',
                   saettigungSetzen: 'saettigung', staerkeSetzen: 'staerke', umgebungSaettigungSetzen: 'umgebungSaettigung',
                   umgebungHelligkeitSetzen: 'umgebungHelligkeit', neutralSetzen: 'neutral', grundtonSetzen: 'grundton',
                   zeichnungSetzen: 'zeichnung', glasAnteilSetzen: 'glasAnteil', schalten: 'an', umgebungSetzen: 'umgebung',
                   neutralAnSetzen: 'neutralAn', glasSetzen: 'glas', bodenfarbeSetzen: 'bodenfarbe', glasFarbeSetzen: 'glasFarbe',
                   schema: 'schema' }).forEach(([fn, k]) => { B.Farben[fn] = (w) => { FS[k] = w; }; });

  const LS = { lampe: false, staerke: 1.8, weite: 34, kante: 8, reichweite: 30, farbe: '#fff0d6', aufhellung: 0.15 };
  B.Licht = {
    stand: () => Object.assign({ traeger: 1 }, LS),
    aufhellungSetzen: (w) => { LS.aufhellung = w; }, staerkeSetzen: (w) => { LS.staerke = w; },
    weiteSetzen: (w) => { LS.weite = w; }, reichweiteSetzen: (w) => { LS.reichweite = w; },
    farbeSetzen: (w) => { LS.farbe = w; }, taschenlampe: (w) => { LS.lampe = w; },
  };

  // ── Untergrund, Punktwolken, Welt, Sonne ──
  const US = { an: false, nullebene: true, durchblick: true };
  B.Untergrund = { stand: () => Object.assign({}, US), nullebeneSetzen: (a) => { US.nullebene = a; }, durchblickSetzen: (a) => { US.durchblick = a; } };
  B.toggleUndergroundView = (a) => { US.an = a; };

  B.pointCloudSettings = { colorMode: 'rgb', pointSize: 2, edlEnabled: true, edlStrength: 1, edlRadius: 1, attenuationEnabled: true };
  B.setColorMode = (w) => { B.pointCloudSettings.colorMode = w; };
  B.setPointSize = (w) => { B.pointCloudSettings.pointSize = w; };
  B.setEyeDomeLighting = (w) => { B.pointCloudSettings.edlEnabled = w; };
  B.setEDLStrength = (w) => { B.pointCloudSettings.edlStrength = w; };
  B.setEDLRadius = (w) => { B.pointCloudSettings.edlRadius = w; };
  B.setAttenuation = (w) => { B.pointCloudSettings.attenuationEnabled = w; };

  B.lighting = { stunde: null, schatten: true };
  B.setLightingTime = (h) => { B.lighting.stunde = h; };
  B.setShadows = (a) => { B.lighting.schatten = a; };
  B.viewer = { scene: { globe: { translucency: { enabled: false, frontFaceAlpha: 1 } } } };
  B.setGlobeTransparency = (a) => { const t = B.viewer.scene.globe.translucency; t.enabled = a < 1; t.frontFaceAlpha = a; };
  B.osmBuildings = { enabled: false }; B.googleTiles = { enabled: false };
  B.toggleOSMBuildings = async (a) => { B.osmBuildings.enabled = a; };
  B.toggleGoogle3DTiles = async () => { B.googleTiles.enabled = !B.googleTiles.enabled; };
  const LM = { aktiveKarte: 'bing-aerial', aktivesGelaende: 'ellipsoid',
    tilesetLayers: [{ id: 'rlp', active: false }, { id: 'osm3d', active: true }],
    async switchBasemap(id) { this.aktiveKarte = id; }, async switchTerrain(id) { this.aktivesGelaende = id; },
    async enableTileset(id) { this.tilesetLayers.find((t) => t.id === id).active = true; },
    disableTileset(id) { this.tilesetLayers.find((t) => t.id === id).active = false; } };

  // ── Bildebenen ──
  B.Bildebenen = { ebenen: [{ id: 'b1', titel: 'Fassade', sichtbar: true, deckkraft: 1 }, { id: 'b2', titel: 'Plan', sichtbar: false, deckkraft: 0.5 }],
    finden(id) { return this.ebenen.filter((e) => e.id === id)[0]; },
    zeigen(id, an) { this.finden(id).sichtbar = an; }, setzen(id, f, w) { this.finden(id)[f] = w; } };

  return { B, Annotations, LM, log };
}

function umgebung() {
  const { B, Annotations, LM, log } = attrappe();
  const welt = { BimViewer: B, Annotations, LayerManager: LM, console: { log() {}, warn() {}, error() {} } };
  welt.window = welt;
  createContext(welt);
  runInContext(readFileSync(join(wurzel, 'zustand.js'), 'utf8'), welt);
  runInContext(readFileSync(join(wurzel, 'zustand-anmelder.js'), 'utf8'), welt);
  return { welt, B, Z: B.Zustand, log };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · Die Registry für sich
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
console.log('\nRegistry');
{
  const welt = { console: { log() {}, warn() {}, error() {} } };
  welt.window = welt;
  createContext(welt);
  runInContext(readFileSync(join(wurzel, 'zustand.js'), 'utf8'), welt);
  const Z = welt.BimViewer.Zustand;
  const I = Z._intern;

  pruefe('ein Muster mit * trifft genau einen Abschnitt',
    I.passt(I.musterLesen('modelle.*.deckkraft'), ['modelle', 'x', 'deckkraft']) &&
    !I.passt(I.musterLesen('modelle.*.deckkraft'), ['modelle', 'x', 'y', 'deckkraft']) &&
    !I.passt(I.musterLesen('modelle.*.deckkraft'), ['modelle', 'deckkraft']));
  pruefe('@winkel wird erkannt und vom Pfad getrennt', I.musterLesen('yaw@winkel').winkel === true && I.musterLesen('yaw@winkel').teile.join() === 'yaw');

  pruefe('Winkel gehen den kurzen Weg: 350° → 10° bei 0,5 = 0°', nahe(((I.winkelMischen(350, 10, 0.5) % 360) + 360) % 360, 0));
  pruefe('… und 10° → 350° bei 0,5 = 0° (nicht 180°)', nahe(((I.winkelMischen(10, 350, 0.5) % 360) + 360) % 360, 0));

  const a = { box: { min: [0, 0, 0], max: [10, 10, 10] }, an: true, name: 'a', yaw: 350, m: { x1: { d: 1 } } };
  const b = { box: { min: [10, 20, 30], max: [20, 20, 20] }, an: false, name: 'b', yaw: 10, m: { x1: { d: 3 }, x2: { d: 9 } } };
  const muster = ['box.min', 'box.max', 'yaw@winkel', 'm.*.d'].map(I.musterLesen);
  const m = I.baumMischen(a, b, 0.5, muster, []);
  pruefe('Zahlenlisten werden elementweise gemischt', json(m.box.min) === '[5,10,15]' && json(m.box.max) === '[15,15,15]');
  pruefe('alles Nichtweiche bleibt wie in B', m.an === false && m.name === 'b');
  pruefe('ein Winkel im Baum geht den kurzen Weg', nahe(((m.yaw % 360) + 360) % 360, 0));
  pruefe('Wildcards mischen jeden Schlüssel', m.m.x1.d === 2);
  pruefe('ein Schlüssel nur in B springt (kein Partner zum Mischen)', m.m.x2.d === 9);
  pruefe('die Eingaben bleiben unangetastet', a.box.min[0] === 0 && b.box.min[0] === 10);

  // Anmelden, Reihenfolge, Lesen, Anwenden
  const reihe = [];
  Z.anmelden({ id: 'spaet', ordnung: 60, lesen: () => ({ v: 1 }), setzen: async () => { reihe.push('spaet'); } });
  Z.anmelden({ id: 'frueh', ordnung: 10, lesen: () => ({ v: 2 }), setzen: async () => { await new Promise((r) => setTimeout(r, 15)); reihe.push('frueh'); } });
  Z.anmelden({ id: 'kaputt', ordnung: 30, lesen: () => { throw new Error('lesen kaputt'); }, setzen: () => { throw new Error('setzen kaputt'); } });
  pruefe('die Reihenfolge bestimmt die Ordnung, nicht die Anmeldung', Z.ids().join() === 'frueh,kaputt,spaet');
  const gelesen = Z.lesen();
  pruefe('ein Anmelder, der beim Lesen wirft, fehlt — die anderen bleiben', 'frueh' in gelesen && 'spaet' in gelesen && !('kaputt' in gelesen));
  const erg = await (Z.anwenden({ frueh: {}, kaputt: {}, spaet: {} }));
  pruefe('angewendet wird nacheinander UND mit Warten (früh vor spät)', reihe.join() === 'frueh,spaet');
  pruefe('ein werfender Anmelder stoppt die übrigen nicht und wird gemeldet',
    erg.fehler.length === 1 && erg.fehler[0].id === 'kaputt' && reihe.length === 2);
  reihe.length = 0;
  await (Z.anwenden({ frueh: {}, spaet: {} }, { nur: ['spaet'] }));
  pruefe('„nur" schränkt ein', reihe.join() === 'spaet');
  reihe.length = 0;
  await (Z.anwenden({ spaet: {} }));
  pruefe('ein Anmelder, der im Zustand fehlt, bleibt, wie er ist', reihe.join() === 'spaet');

  const z = Z.lesen(['frueh']);
  z.frueh.v = 99;
  pruefe('lesen liefert eine Kopie', Z.lesen(['frueh']).frueh.v === 2);
  pruefe('gleich() vergleicht tief', Z.gleich({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }) && !Z.gleich({ a: [1, 2] }, { a: [1, 3] }) && !Z.gleich({ a: 1 }, { a: 1, b: 2 }));

  // geaendert / uebergangStart
  Z.anmelden({ id: 'w', ordnung: 70, lesen: () => ({}), setzen: () => {}, weich: ['x', 'wahl.*.y'] });
  Z.anmelden({ id: 'h', ordnung: 71, lesen: () => ({}), setzen: () => {} });
  const A = { w: { x: 0, text: 'a', wahl: { p: { y: 1 } } }, h: { k: 1 } };
  const Bz = { w: { x: 10, text: 'b', wahl: { p: { y: 5 } } }, h: { k: 1 }, frueh: { v: 1 } };
  pruefe('geaendert nennt nur, was sich unterscheidet (und in B da ist)', Z.geaendert(A, Bz).join() === 'frueh,w');
  const start = Z.uebergangStart(A, Bz);
  pruefe('Übergangsstart: Aufbau von B …', start.w.text === 'b');
  pruefe('… aber mit den weichen Zahlen von A', start.w.x === 0 && start.w.wahl.p.y === 1);
  pruefe('ein Anmelder ohne weiche Pfade kommt ganz aus B', json(start.frueh) === '{"v":1}');
  pruefe('unveränderte Anmelder sind nicht dabei', !('h' in start));
  const halb = Z.mischen(A, Bz, 0.5);
  pruefe('mischen nennt nur Anmelder mit weichen Pfaden, die in beiden da sind', Object.keys(halb).join() === 'w');
  pruefe('… und mischt', halb.w.x === 5 && halb.w.wahl.p.y === 3 && halb.w.text === 'b');

  // vorbereiten
  let gesehen = null;
  Z.anmelden({ id: 'vor', ordnung: 5, lesen: () => ({}), setzen: () => {}, vorbereiten: async (werte) => { gesehen = werte; } });
  await (Z.vorbereiten([{ vor: { a: 1 } }, { w: {} }, { vor: { b: 2 } }]));
  pruefe('vorbereiten bekommt die Werte aller Folien, die den Anmelder führen', json(gesehen) === '[{"a":1},{"b":2}]');

  // schema
  const sch = Z.schema();
  pruefe('das Schema beschreibt jeden Anmelder samt weicher Pfade', sch.length === 6 && sch.find((x) => x.id === 'w').weich.join() === 'x,wahl.*.y');
  Z.anmelden({ id: 'ohne' });
  pruefe('eine unvollständige Anmeldung wird abgewiesen', !Z.hat('ohne'));
}

  // ═════════════════════════════════════════════════════════════════════════
  // 2 · Die Anmelder: Rundlauf
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nAnmelder');
  const { B, Z, log } = umgebung();

  pruefe('alle zwölf Anmelder sind da, in der richtigen Ordnung',
    Z.ids().join() === 'modelle,filter,bildebenen,schnitt,explosion,notizen,welt,sonne,farben,licht,untergrund,punktwolken', Z.ids().join());
  pruefe('Modelle kommen vor dem Schnitt', Z.ids().indexOf('modelle') < Z.ids().indexOf('schnitt'));

  // Modelle
  const leer = Z.lesen(['modelle']).modelle;
  pruefe('ohne Modelle ist der Zustand ein leeres Objekt', json(leer) === '{}');

  const zielSzene = {
    modelle: {
      backend_abc: { name: 'Halle', quelle: { art: 'backend', jobId: 'abc' }, sichtbar: true, deckkraft: 0.6, lage: { z: 1.5, heading: 30, ost: 2, nord: -1 } },
      '4587934': { name: 'Campus', quelle: { art: 'ion', assetId: '4587934' }, sichtbar: false, deckkraft: 1, lage: { z: 0, heading: 0, ost: 0, nord: 0 } },
    },
  };
  await Z.anwenden(zielSzene);
  pruefe('fehlende Modelle werden geladen (backend und ion)', B.loadedAssets.has('backend_abc') && B.loadedAssets.has('4587934'));
  pruefe('DAS LADEN LÖST KEINEN KAMERAFLUG AUS', !log.includes('FLUG'), log.join());
  pruefe('Deckkraft und Sichtbarkeit sind hergestellt', B.loadedAssets.get('backend_abc').opacity === 0.6 && B.loadedAssets.get('4587934').visible === false);
  pruefe('die Lage (Höhe, Drehung, Verschiebung) ist hergestellt', json(Z.lesen(['modelle']).modelle.backend_abc.lage) === json(zielSzene.modelle.backend_abc.lage));
  pruefe('Rundlauf: lesen gibt den angewendeten Stand zurück',
    json(Z.lesen(['modelle']).modelle.backend_abc) === json(zielSzene.modelle.backend_abc));
  const anzahl = log.filter((x) => x.startsWith('laden')).length;
  await Z.anwenden(zielSzene);
  pruefe('ein zweites Anwenden lädt NICHTS neu (idempotent)', log.filter((x) => x.startsWith('laden')).length === anzahl);

  await Z.anwenden({ modelle: { backend_abc: zielSzene.modelle.backend_abc } });
  pruefe('ein Modell, das der Zustand nicht kennt, wird versteckt — nicht entladen',
    B.loadedAssets.has('4587934') && B.loadedAssets.get('4587934').visible === false &&
    B.loadedAssets.get('4587934').tileset.show === false);

  // weich: nur Zahlen, keine Ladevorgänge
  log.length = 0;
  await Z.anwenden({ modelle: { backend_abc: Object.assign({}, zielSzene.modelle.backend_abc, { deckkraft: 0.3, sichtbar: false, lage: { z: 4, heading: 30, ost: 2, nord: -1 } }) } }, { weich: true });
  pruefe('weich zieht Deckkraft und Höhe nach', B.loadedAssets.get('backend_abc').opacity === 0.3 &&
    B.zOffset.individualOffsets.get(B.loadedAssets.get('backend_abc').tileset) === 4);
  pruefe('… aber schaltet die Sichtbarkeit nicht um (das ist hart)', B.loadedAssets.get('backend_abc').visible === true);

  // vorbereiten: lädt alles, versteckt es
  const B2 = umgebung();
  await B2.Z.vorbereiten([{ modelle: { backend_x: { quelle: { art: 'backend', jobId: 'x' } } } },
                          { modelle: { backend_y: { quelle: { art: 'backend', jobId: 'y' } } } }]);
  pruefe('vorbereiten lädt die Modelle ALLER Folien', B2.B.loadedAssets.has('backend_x') && B2.B.loadedAssets.has('backend_y'));
  pruefe('… und versteckt sie, bis eine Folie sie verlangt', [...B2.B.loadedAssets.values()].every((a) => a.visible === false));

  // Filter
  const F0 = Z.lesen(['filter']).filter;
  pruefe('ohne Abwahl: nichts abgewählt', F0.abgewaehlt.length === 0);
  const filterLauf0 = B.filterLauf;
  await Z.anwenden({ filter: { abgewaehlt: ['IfcSpace', 'IfcDoor', 'IfcNeuerTyp'], hervorhebung: { ids: ['g1', 'g2'], farbe: '#00ff00' }, ausgeblendet: {} } });
  pruefe('abgewählte Typen sind aus dem Filter (auch ein noch unbekannter)',
    !B.ifcFilter.enabledEntities.has('IfcSpace') && !B.ifcFilter.enabledEntities.has('IfcDoor') &&
    B.ifcFilter.enabledEntities.has('IfcWall') && B.ifcFilter.allEntities.has('IfcNeuerTyp') && !B.ifcFilter.enabledEntities.has('IfcNeuerTyp'));
  pruefe('die Hervorhebung ist gesetzt', B.ifcHighlight.ids.size === 2 && B.ifcHighlight.color === '#00ff00');
  const vorher = json(Z.lesen(['filter']));
  await Z.anwenden(JSON.parse(vorher));
  pruefe('Rundlauf des Filters', json(Z.lesen(['filter'])) === vorher);
  const lauf1 = B.filterLauf;
  await Z.anwenden(JSON.parse(vorher));
  pruefe('ein unverändertes Anwenden stößt den teuren Filterlauf nicht an', B.filterLauf === lauf1);
  await Z.anwenden({ filter: { abgewaehlt: [], hervorhebung: { ids: [], farbe: '#ff2d95' }, ausgeblendet: {} } });
  pruefe('ohne Abwahl und ohne Hervorhebung ist alles wieder da', B.ifcFilter.enabledEntities.size === B.ifcFilter.allEntities.size - 1 + 0 || B.ifcFilter.enabledEntities.has('IfcSpace'));
  pruefe('… und die Hervorhebung ist geleert', B.ifcHighlight.ids.size === 0);

  await Z.anwenden({ filter: { ausgeblendet: { backend_abc: ['x1', 'x2'] } } });
  pruefe('ausgeblendete Bauteile werden je Modell gesetzt', B.hiddenFeatures.eintraege.length === 2 &&
    B.hiddenFeatures.eintraege.every((e) => e.guidEigenschaft === 'GlobalId'));
  pruefe('… und lesen sich zurück', json(Z.lesen(['filter']).filter.ausgeblendet) === '{"backend_abc":["x1","x2"]}');

  // Schnitt
  await Z.anwenden({ schnitt: { an: true, modus: 'aussen', flaechen: false, kante: true, griffe: true, yaw: 12.5,
    box: { min: [-10, -10, 0], max: [10, 10, 12] }, scheiben: { Nord: { winkel: 90, d: 3, dicke: 2, an: true }, Ost: { winkel: 0, d: -4, dicke: 1, an: false } } } });
  const sz = Z.lesen(['schnitt']).schnitt;
  pruefe('der Schnitt läuft, Modus und Drehung sind gesetzt', sz.an && sz.modus === 'aussen' && sz.yaw === 12.5 && sz.flaechen === false);
  pruefe('die Box steht', json(sz.box) === '{"min":[-10,-10,0],"max":[10,10,12]}');
  pruefe('Scheiben kommen unter IHREM Namen an (die Kennung vergibt der Schnitt selbst)', Object.keys(sz.scheiben).sort().join() === 'Nord,Ost');
  pruefe('… mit ihren Werten und dem An/Aus', sz.scheiben.Nord.d === 3 && sz.scheiben.Ost.an === false);
  const szJson = json(sz);
  await Z.anwenden({ schnitt: JSON.parse(szJson) });
  pruefe('Rundlauf des Schnitts — keine doppelten Scheiben', json(Z.lesen(['schnitt']).schnitt) === szJson && B.Schnitt.zustand.scheiben.length === 2);
  await Z.anwenden({ schnitt: Object.assign(JSON.parse(szJson), { scheiben: { Nord: sz.scheiben.Nord } }) });
  pruefe('eine Scheibe, die der Zustand nicht kennt, wird entfernt', B.Schnitt.zustand.scheiben.length === 1);
  await Z.anwenden({ schnitt: { an: true, box: { min: [-20, -20, 0], max: [0, 0, 6] }, scheiben: { Nord: { winkel: 90, d: 9, dicke: 2, an: true } } } }, { weich: true });
  pruefe('weich verschiebt Box und Scheibe, ohne etwas neu aufzubauen',
    json(B.Schnitt.zustand.box) === '{"min":[-20,-20,0],"max":[0,0,6]}' && B.Schnitt.zustand.scheiben[0].d === 9 && B.Schnitt.zustand.scheiben.length === 1);
  await Z.anwenden({ schnitt: { an: false } });
  pruefe('„an: false" schaltet den Schnitt aus', B.Schnitt.an === false);
  pruefe('ausgeschaltet meldet der Schnitt nur „aus" und die ganze Szene als Box — nicht die Reste von vorhin',
    json(Z.lesen(['schnitt']).schnitt) === '{"an":false,"box":{"min":[-50,-50,-5],"max":[50,50,30]}}', json(Z.lesen(['schnitt']).schnitt));

  // Explosion
  await Z.anwenden({ explosion: { an: true, abstand: 6, flach: 0.25, fuge: 0.2, regelhoehe: 3.5 } });
  pruefe('die Explosion läuft mit Abstand und Stauchung',
    B.Explosion.aktiv && B.Explosion.abstand === 6 && B.Explosion.flach === 0.25 && B.Explosion.fuge === 0.2);
  await Z.anwenden({ explosion: { an: true, abstand: 9, flach: 0.5 } }, { weich: true });
  pruefe('weich fährt Abstand und Stauchung', B.Explosion.abstand === 9 && B.Explosion.flach === 0.5);
  await Z.anwenden({ explosion: { an: false, abstand: 0, flach: 0 } });
  pruefe('ausschalten räumt auf', !B.Explosion.aktiv && B.Explosion.abstand === 0);
  pruefe('ausgeschaltet meldet die Explosion Abstand 0 und Stauchung 0 (und nur das)',
    json(Z.lesen(['explosion']).explosion) === '{"an":false,"abstand":0,"flach":0}');
  await Z.anwenden({ explosion: { an: true, abstand: 99, flach: 7 } });
  pruefe('Werte außerhalb werden geklemmt', B.Explosion.abstand === 15 && B.Explosion.flach === 1);
  await Z.anwenden({ explosion: { an: false, abstand: 0, flach: 0 } });

  // Notizen
  await Z.anwenden({ notizen: { an: false, nurOffen: true, sichtweite: 250, ids: ['n1', 'n2'] } });
  const nz = Z.lesen(['notizen']).notizen;
  pruefe('Notizen: aus, nur offene, Sichtweite und die genaue Auswahl', nz.an === false && nz.nurOffen === true && nz.sichtweite === 250 && json(nz.ids) === '["n1","n2"]');
  await Z.anwenden({ notizen: { an: true, nurOffen: false, sichtweite: 1000, ids: null } });
  pruefe('ids: null hebt die Einschränkung auf (alle Notizen)', Z.lesen(['notizen']).notizen.ids === null);

  // Bildebenen
  await Z.anwenden({ bildebenen: { ebenen: { b1: { sichtbar: false, deckkraft: 0.4 }, b2: { sichtbar: true, deckkraft: 0.5 } } } });
  pruefe('Bildebenen: Sichtbarkeit und Deckkraft je Kennung', B.Bildebenen.ebenen[0].sichtbar === false && B.Bildebenen.ebenen[0].deckkraft === 0.4 && B.Bildebenen.ebenen[1].sichtbar === true);
  await Z.anwenden({ bildebenen: { ebenen: { unbekannt: { sichtbar: true } } } });
  pruefe('eine unbekannte Ebene wirft nicht', true);

  // Welt, Sonne
  await Z.anwenden({ welt: { karte: 'osm', gelaende: 'world', osm: true, google: true, globusTransparenz: 0.5, ebenen: { rlp: true, osm3d: false } } });
  const wz = Z.lesen(['welt']).welt;
  pruefe('Welt: Karte, Gelände, Kulissen, Ebenen, Globus', wz.karte === 'osm' && wz.gelaende === 'world' && wz.osm && wz.google && wz.globusTransparenz === 0.5 && wz.ebenen.rlp === true && wz.ebenen.osm3d === false);
  await Z.anwenden(JSON.parse(json({ welt: wz })));
  pruefe('Google 3D Tiles ist ein UMSCHALTER — zweimal anwenden schaltet es nicht wieder aus', Z.lesen(['welt']).welt.google === true);
  await Z.anwenden({ sonne: { stunde: 15.5, schatten: false } });
  pruefe('Sonne: Uhrzeit und Schatten', json(Z.lesen(['sonne']).sonne) === '{"stunde":15.5,"schatten":false}');
  await Z.anwenden({ sonne: { stunde: null, schatten: true } });
  pruefe('Sonne ohne Stunde lässt die Uhr stehen', Z.lesen(['sonne']).sonne.stunde === 15.5);

  // Farben, Licht, Untergrund, Punktwolken
  await Z.anwenden({ farben: { kelvin: 5200, tint: 0.2, schema: 'ifc', glas: false, glasFarbe: '#111111', an: false } });
  const fz = Z.lesen(['farben']).farben;
  pruefe('Farben: Zahlen, Schalter und Texte kommen an', fz.kelvin === 5200 && fz.tint === 0.2 && fz.schema === 'ifc' && fz.glas === false && fz.glasFarbe === '#111111' && fz.an === false);
  pruefe('… und Kenngrößen, die keine Einstellung sind (modelle, traeger, wirkt), stehen nicht im Zustand', !('modelle' in fz) && !('traeger' in fz) && !('wirkt' in fz));
  await Z.anwenden({ farben: { kelvin: 5600 } }, { weich: true });
  pruefe('weich zieht nur Zahlen', Z.lesen(['farben']).farben.kelvin === 5600 && Z.lesen(['farben']).farben.schema === 'ifc');

  await Z.anwenden({ licht: { aufhellung: 0.4, lampe: true, staerke: 2.5, weite: 40, reichweite: 60, farbe: '#ffffff' } });
  const lz = Z.lesen(['licht']).licht;
  pruefe('Licht: Aufhellung, Lampe, Stärke, Weite, Reichweite, Farbe', lz.aufhellung === 0.4 && lz.lampe && lz.staerke === 2.5 && lz.weite === 40 && lz.reichweite === 60 && lz.farbe === '#ffffff');

  await Z.anwenden({ untergrund: { an: true, nullebene: false, durchblick: false } });
  pruefe('Untergrund: an, Nullebene, Durchblick', json(Z.lesen(['untergrund']).untergrund) === '{"an":true,"nullebene":false,"durchblick":false}');

  await Z.anwenden({ punktwolken: { colorMode: 'height', pointSize: 4, edlEnabled: false, edlStrength: 0.5, edlRadius: 2, attenuationEnabled: false } });
  pruefe('Punktwolken: Farbmodus, Größe, EDL', json(Z.lesen(['punktwolken']).punktwolken) === '{"colorMode":"height","pointSize":4,"edlEnabled":false,"edlStrength":0.5,"edlRadius":2,"attenuationEnabled":false}');

  // Der ganze Zustand als Rundlauf
  const alles = Z.lesen();
  const { B: B3, Z: Z3 } = umgebung();
  const erg = await Z3.anwenden(JSON.parse(json(alles)));
  pruefe('der GANZE Zustand lässt sich in eine frische Umgebung übertragen, ohne Fehler', erg.fehler.length === 0, json(erg.fehler));
  const nach = Z3.lesen();
  const unterschiede = Object.keys(alles).filter((k) => json(alles[k]) !== json(nach[k]));
  pruefe('… und liest sich dort identisch zurück', unterschiede.length === 0,
    'Abweichung in: ' + unterschiede.map((k) => k + ' ' + json(alles[k]) + ' ≠ ' + json(nach[k])).join(' || '));

  // Fehlt ein Werkzeug (iLEEN-view hat nicht alle), melden sich die Anmelder mit undefined
  const leerWelt = { BimViewer: { loadedAssets: new Map() }, console: { log() {}, warn() {}, error() {} } };
  leerWelt.window = leerWelt;
  createContext(leerWelt);
  runInContext(readFileSync(join(wurzel, 'zustand.js'), 'utf8'), leerWelt);
  runInContext(readFileSync(join(wurzel, 'zustand-anmelder.js'), 'utf8'), leerWelt);
  const Zl = leerWelt.BimViewer.Zustand;
  const gl = Zl.lesen();
  pruefe('ohne die Werkzeuge liefert lesen nur, was es gibt (kein Absturz)', Object.keys(gl).join() === 'modelle', Object.keys(gl).join());
  const r = await Zl.anwenden({ schnitt: { an: true }, explosion: { an: true }, farben: { kelvin: 5000 } });
  pruefe('… und Anwenden auf fehlende Werkzeuge wirft nicht', r.fehler.length === 0, json(r.fehler));

  console.log(fehler ? `\n${fehler} Prüfstein(e) fehlgeschlagen` : '\nAlle Prüfsteine bestanden');
  process.exit(fehler ? 1 : 0);
})();
