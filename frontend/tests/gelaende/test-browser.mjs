// Prüft im echten Viewer, dass Karte, Gelände, Gebäude und Suche ohne Cesium
// ion auskommen — und dass sie in der richtigen Höhe stehen.
//
// Aufruf:  npx vite --port 5197 &
//          VIEWER_URL=http://localhost:5197/ node tests/gelaende/test-browser.mjs
//
// Braucht Netz: basemap.de, die Länder-WMS, Terrain Tiles, Nominatim. Legt
// Bilder unter tests/gelaende/bilder/ ab.
//
// Was nur hier zu prüfen ist:
//   · keine Anfrage an ion.cesium.com / api.cesium.com, bis jemand Google wählt —
//     danach nur Googles Satellit und 3D Tiles über ion (EWR-Sperre seit Juli 2025)
//   · Geländehöhe am Mainzer Rheinufer = DGM5 + EGM96 (≈ 134 m), nicht 86 m
//   · LoD2 steht auf dem Gelände: Dachhöhe des Doms über dem Gelände plausibel
//   · Google-Karte direkt; ohne Schlüssel und Token bleibt Google aus und sagt warum

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5197/';
const BILDER = process.env.BILDER || path.join(path.dirname(fileURLToPath(import.meta.url)), 'bilder');
fs.mkdirSync(BILDER, { recursive: true });

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${zusatz ? ' — ' + zusatz : ''}`);
  if (!ok) fehler++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const seitenfehler = [];
const anfragen = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));
page.on('request', (r) => anfragen.push(r.url()));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
const titel = await page.title();
pruefe('richtige Anwendung auf dem Port', /iLEEN/.test(titel), titel);
await page.waitForFunction(() => !!(window.BimViewer?.viewer && window.LayerManager?.aktiveKarte), { timeout: 120000 });

await page.evaluate(() => {
  const szene = BimViewer.viewer.scene;
  window.__renderFehler = [];
  szene.renderError.addEventListener((s, e) => window.__renderFehler.push(String((e && e.message) || e)));
  BimViewer.viewer.camera.cancelFlight();
  BimViewer.ILeenLogo?.verbergen?.();
  window.__laden = async (max, tilesets) => {
    let bilder = 0;
    for (; bilder < max; bilder++) {
      szene.render();
      await new Promise((r) => requestAnimationFrame(r));
      const fertig = szene.globe.tilesLoaded && (tilesets || []).every((t) => t.tilesLoaded);
      if (bilder > 30 && fertig) break;
    }
    return bilder;
  };
  window.__blick = (lon, lat, h, kurs, neigung) => BimViewer.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
    orientation: { heading: Cesium.Math.toRadians(kurs), pitch: Cesium.Math.toRadians(neigung), roll: 0 }
  });
});

const bild = async (name) => {
  const datei = path.join(BILDER, name);
  await page.screenshot({ path: datei });
  return datei;
};

// ── 1 · Was beim Start geladen wurde ─────────────────────────────────────────

const start = await page.evaluate(() => ({
  gelaende: BimViewer.viewer.terrainProvider instanceof ILeenGelaende.Provider,
  quellen: BimViewer.viewer.terrainProvider.quellen,
  normalen: BimViewer.viewer.terrainProvider.hasVertexNormals,
  karte: LayerManager.aktiveKarte,
  ebenen: BimViewer.viewer.imageryLayers.length,
  grundkarte: Array.from({ length: BimViewer.viewer.imageryLayers.length }, (_, i) => !!BimViewer.viewer.imageryLayers.get(i)._ileenGrundkarte),
  suche: !!BimViewer.viewer.geocoder,
  lod2: LayerManager.tilesetLayers.some((t) => t.id === 'lod2-de')
}));
pruefe('Gelände ohne ion: DGM5 + Terrain Tiles mit Normalen', start.gelaende && start.quellen.dgm5 && start.normalen, JSON.stringify(start.quellen));
pruefe('Grundkarte: Luftbild amtlich (Sentinel-2 + 5 Länder)', start.karte === 'luftbild' && start.ebenen === 6 && start.grundkarte.every(Boolean), start.ebenen + ' Ebenen');
pruefe('Suchfeld da (vorher nur mit ion-Token)', start.suche);
pruefe('LoD2 Deutschland in der Ebenenliste', start.lod2);
const vermerk = await page.evaluate(() => document.querySelector('.cesium-credit-logoContainer img')?.getAttribute('src') || '');
pruefe('Vermerk unten links: CesiumJS, nicht „Cesium ion"', /cesium_credit\.png/.test(vermerk) && !/ion-credit/.test(vermerk), vermerk);

// ── 2 · Mainz: Gelände in der richtigen Höhe ─────────────────────────────────

await page.evaluate(() => window.__blick(8.262, 49.985, 900, 40, -30));
const geladen = await page.evaluate(() => window.__laden(900));
const hoehe = await page.evaluate(async () => {
  const p = BimViewer.viewer.terrainProvider;
  const [rhein, campus] = await Cesium.sampleTerrainMostDetailed(p, [
    Cesium.Cartographic.fromDegrees(8.2765, 50.0005),
    Cesium.Cartographic.fromDegrees(8.2129, 49.9852)]);
  return { rhein: rhein.height, campus: campus.height, n: ILEEN_GEOID.getUndulation(50.0005, 8.2765) };
});
pruefe('Rheinufer Mainz: 85,8 m NHN + Undulation', Math.abs(hoehe.rhein - (85.8 + hoehe.n)) < 0.6,
       `${hoehe.rhein.toFixed(2)} m ell., N = ${hoehe.n.toFixed(2)} m`);
pruefe('Campus HS Mainz: 130 m NHN + Undulation', Math.abs(hoehe.campus - (130.0 + hoehe.n)) < 0.6, hoehe.campus.toFixed(2) + ' m');
pruefe('Globus fertig geladen', geladen < 900, geladen + ' Bilder');

const dop = anfragen.filter((u) => /service24\.rlp\.de|gds-srv\.hessen\.de/.test(u));
pruefe('Luftbild kommt von den Länderdiensten (RLP/Hessen)', dop.length > 0, dop.length + ' Kacheln');
pruefe('Gelände kommt von basemap.de', anfragen.some((u) => u.includes('gdz_basemapde_3d_gelaende/dgm5_4326_mesh/')));
await bild('1-mainz-gelaende.png');

// ── 3 · LoD2 Deutschland auf dem Gelände ─────────────────────────────────────

await page.evaluate(() => LayerManager.enableTileset('lod2-de'));
await page.evaluate(() => window.__blick(8.2690, 49.9930, 450, 35, -32));
await page.evaluate(async () => {
  const e = LayerManager.tilesetLayers.find((t) => t.id === 'lod2-de');
  BimViewer.viewer.camera.moveEnd.raiseEvent();   // Nachführen wie nach einer Kamerafahrt
  await window.__laden(1200, [e.tileset]);
});
const lod2 = await page.evaluate(async () => {
  const e = LayerManager.tilesetLayers.find((t) => t.id === 'lod2-de');
  const m = e.tileset.modelMatrix;
  const versatz = Math.hypot(m[12], m[13], m[14]);
  const dom = Cesium.Cartographic.fromDegrees(8.27407, 49.99896);
  const [dach] = await BimViewer.viewer.scene.sampleHeightMostDetailed([dom.clone()]);
  const [boden] = await Cesium.sampleTerrainMostDetailed(BimViewer.viewer.terrainProvider, [dom.clone()]);
  return { aktiv: e.active, sichtbar: e.tileset.show, versatz, dach: dach.height, boden: boden.height,
           n: ILEEN_GEOID.getUndulation(49.99896, 8.27407), stil: !!e.tileset.style };
});
pruefe('LoD2 geladen, sichtbar, mit Stil', lod2.aktiv && lod2.sichtbar && lod2.stil);
pruefe('LoD2 um die Undulation angehoben', Math.abs(lod2.versatz - lod2.n) < 0.3, `${lod2.versatz.toFixed(2)} m, N = ${lod2.n.toFixed(2)} m`);
const ueber = lod2.dach - lod2.boden;
pruefe('Mainzer Dom steht auf dem Gelände (Dach 10–90 m über Grund)', ueber > 10 && ueber < 90,
       `Dach ${lod2.dach?.toFixed(1)} m, Gelände ${lod2.boden.toFixed(1)} m, Δ ${ueber.toFixed(1)} m`);
pruefe('LoD2 kommt von basemap.de', anfragen.some((u) => u.includes('gdz_basemapde_3d_gebaeude')));
await bild('2-mainz-lod2.png');

// ── 4 · Rheintal bei Braubach (Marksburg): Hänge mit Licht und Schatten ─────

await page.evaluate(() => window.__blick(7.6300, 50.2560, 900, 60, -22));
await page.evaluate(() => window.__laden(900));
await bild('3-rheintal-marksburg.png');

// ── 5 · Grenze Kehl/Straßburg und Ausland ───────────────────────────────────

await page.evaluate(() => window.__blick(7.7300, 48.5500, 2500, 70, -25));
await page.evaluate(() => window.__laden(900));
const grenze = await page.evaluate(async () => {
  const [str, kehl] = await Cesium.sampleTerrainMostDetailed(BimViewer.viewer.terrainProvider, [
    Cesium.Cartographic.fromDegrees(7.75, 48.58), Cesium.Cartographic.fromDegrees(7.815, 48.575)]);
  return { str: str.height, kehl: kehl.height };
});
pruefe('Straßburg nicht auf 0 m NHN (keine Klippe an der Grenze)', Math.abs(grenze.str - grenze.kehl) < 25,
       `Straßburg ${grenze.str.toFixed(1)} m, Kehl ${grenze.kehl.toFixed(1)} m`);
pruefe('Terrain Tiles für das Ausland abgerufen', anfragen.some((u) => u.includes('elevation-tiles-prod/terrarium/')));
await bild('4-grenze-kehl-strassburg.png');

await page.evaluate(() => window.__blick(11.30, 47.20, 6000, 20, -18));
await page.evaluate(() => window.__laden(900));
await bild('5-ausland-innsbruck.png');

// ── 6 · Ortssuche, Kartenwechsel, alte Kennungen ─────────────────────────────

const suche = await page.evaluate(async () => {
  const s = ILeenKarten.ortssuche();
  const vorher = performance.getEntriesByType('resource').filter((e) => e.name.includes('nominatim')).length;
  const auto = await s.geocode('Mainz', Cesium.GeocodeType.AUTOCOMPLETE);
  const nachAuto = performance.getEntriesByType('resource').filter((e) => e.name.includes('nominatim')).length;
  const treffer = await s.geocode('Rathaus Mainz', Cesium.GeocodeType.SEARCH);
  const ziel = treffer[0] && treffer[0].destination;
  const mitte = ziel instanceof Cesium.Rectangle ? Cesium.Rectangle.center(ziel) : Cesium.Cartographic.fromCartesian(ziel);
  return { auto: auto.length, ohneAbruf: vorher === nachAuto, treffer: treffer.length, name: treffer[0]?.displayName,
           lon: Cesium.Math.toDegrees(mitte.longitude), lat: Cesium.Math.toDegrees(mitte.latitude) };
});
pruefe('Suche: keine Abfrage je Tastendruck (Nominatim-Regeln)', suche.auto === 0 && suche.ohneAbruf);
pruefe('Suche: „Rathaus Mainz" landet in Mainz', suche.treffer > 0 && Math.abs(suche.lon - 8.27) < 0.05 && Math.abs(suche.lat - 50.0) < 0.05,
       suche.name);

const karten = await page.evaluate(async () => {
  const r = {};
  await LayerManager.switchBasemap('bing-aerial');
  r.alt = LayerManager.aktiveKarte;
  await LayerManager.switchBasemap('basemapde');
  r.basemapde = LayerManager.aktiveKarte + ':' + BimViewer.viewer.imageryLayers.length;
  await LayerManager.switchBasemap('luftbild');
  const vorher = BimViewer.viewer.terrainProvider;
  await LayerManager.switchTerrain('ellipsoid');
  r.flach = BimViewer.viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider;
  await LayerManager.switchTerrain('world');   // Kennung aus der ion-Zeit
  r.gelaendeWieder = LayerManager.aktivesGelaende === 'gelaende' && BimViewer.viewer.terrainProvider === vorher;
  return r;
});
pruefe('alte Kennung „bing-aerial" → amtliches Luftbild', karten.alt === 'luftbild');
pruefe('basemap.de-Karte: OSM darunter + basemap.de', karten.basemapde === 'basemapde:2', karten.basemapde);
pruefe('Gelände aus/an, alte Kennung „world", derselbe Provider', karten.flach && karten.gelaendeWieder);

// ── 7 · Google: direkt, was Google dem EWR verweigert über ion ───────────────

// Bis hierher darf keine einzige Anfrage an ion gegangen sein.
const ION = /(^https?:\/\/)([^/]*\.)?(ion\.cesium\.com|api\.cesium\.com|assets\.cesium\.com)/;
const ionVorGoogle = anfragen.filter((u) => ION.test(u));
const meldung = () => page.evaluate(() => document.getElementById('statusIndicator')?.textContent || '');
const zugang = await page.evaluate(() => ({ schluessel: !!ILeenKarten.googleKey(), ion: !!BimViewer.getIonToken() }));

let ab = anfragen.length;
await page.evaluate(() => LayerManager.switchBasemap('google-karte'));
const strasse = { karte: await page.evaluate(() => LayerManager.aktiveKarte), meldung: await meldung(),
                  ion: anfragen.slice(ab).filter((u) => ION.test(u)) };
ab = anfragen.length;
await page.evaluate(() => LayerManager.switchBasemap('google-luftbild'));
const satellit = { karte: await page.evaluate(() => LayerManager.aktiveKarte), meldung: await meldung() };
await page.evaluate(() => BimViewer.toggleGoogle3DTiles());
const kacheln = { an: await page.evaluate(() => BimViewer.googleTiles.enabled), meldung: await meldung() };

if (zugang.schluessel) {
  pruefe('Google-Karte (Straße) direkt, ohne ion', strasse.karte === 'google-karte' && strasse.ion.length === 0,
         strasse.ion[0] || strasse.meldung);
}
if (zugang.schluessel || zugang.ion) {
  pruefe('Google-Luftbild ist die Karte (direkt oder über ion, dann mit Hinweis)',
         satellit.karte === 'google-luftbild' &&
         (!anfragen.slice(ab).some((u) => /3830184/.test(u)) || /über Cesium ion/.test(satellit.meldung)), satellit.meldung);
  pruefe('Google 3D Tiles an', kacheln.an, kacheln.meldung);
  if (kacheln.an) {
    await page.evaluate(() => window.__blick(8.2745, 49.9978, 450, 20, -35));   // Rheinufer am Rathaus
    await page.evaluate(() => window.__laden(900, [BimViewer.googleTiles.tileset]));
    const inhalt = await page.evaluate(() => BimViewer.googleTiles.tileset.statistics.numberOfTilesWithContentReady);
    pruefe('Google 3D Tiles: Kacheln mit Inhalt geladen', inhalt > 0, inhalt + ' Kacheln');
    await bild('6-mainz-google-3d.png');
  }
} else {
  pruefe('Ohne Google-Schlüssel und ion-Token: Google bleibt aus und sagt es',
         satellit.karte === 'luftbild' && !kacheln.an, kacheln.meldung);
}

// ── 8 · ion nur für Googles Rückfall ─────────────────────────────────────────

pruefe('vor dem Einschalten von Google keine einzige Anfrage an Cesium ion', ionVorGoogle.length === 0,
       ionVorGoogle.slice(0, 3).join(' · '));
// Endpunkt, Vermerke, und die 2D-Kacheln laufen bei ion über dessen Proxy.
const ERLAUBT = /^https:\/\/(api\.cesium\.com\/v1\/assets\/(2275207|3830184)\/endpoint|assets\.ion\.cesium\.com\/((ion|google)-credit\.png|proxy\/(2275207|3830184)\/))/;
const fremd = anfragen.filter((u) => ION.test(u) && !ERLAUBT.test(u)).map((u) => u.split('?')[0]);   // ohne Sitzungsschlüssel
pruefe('ion danach nur für Google (Assets 2275207, 3830184, Proxy und Vermerke)', fremd.length === 0,
       fremd.slice(0, 3).join(' · '));
const renderFehler = await page.evaluate(() => window.__renderFehler);
pruefe('keine Renderfehler', renderFehler.length === 0, renderFehler.join(' · '));
pruefe('keine Seitenfehler', seitenfehler.length === 0, seitenfehler.slice(0, 3).join(' · '));

await browser.close();
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
