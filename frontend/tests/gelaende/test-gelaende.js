// Prüft das Gelände ohne Cesium ion (gelaende.js) — ohne Browser, mit echtem
// Cesium für Kachelschema, Quantized Mesh und sampleTerrainMostDetailed.
// Nachgebaut sind nur die Abrufe: basemap.de und Terrain Tiles kommen aus
// Attrappen, damit der Prüfstein ohne Netz läuft und genau weiß, welche Höhe
// herauskommen muss.
//
// Aufruf:  node tests/gelaende/test-gelaende.js
//
// Der Fehler, der hier vor allem festgehalten wird: basemap.de liefert
// Normalhöhen (NHN). Unverändert als Ellipsoidhöhen gelesen läge das Gelände
// in Mainz 48 m unter jedem richtig platzierten Modell.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WURZEL = path.resolve(__dirname, '..', '..');
const Cesium = require(path.join(WURZEL, 'node_modules', 'cesium'));
globalThis.Cesium = Cesium;
globalThis.window = globalThis;

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}
const nahe = (a, b, eps) => Math.abs(a - b) <= eps;

require(path.join(WURZEL, 'gelaende.js'));
const G = globalThis.ILeenGelaende;
pruefe('gelaende.js meldet sich als ILeenGelaende', !!G && typeof G.erzeugen === 'function');

// ── Attrappen ───────────────────────────────────────────────────────────────
//
// „Deutschland" ist hier das Rechteck 7,8°–15° Ost, 47°–55° Nord. Das DGM5
// liefert darin überall 100,0 m NHN, westlich davon den Füllwert 0,0 m wie
// basemap.de bei Straßburg. Terrain Tiles liefern 140 m an Land und −50 m
// südlich von 45° („Meer").

const UNDULATION = 48;
const schema = new Cesium.GeographicTilingScheme();
const DE = { west: 5.5, ost: 15.5, sued: 47, nord: 55.5 };   // Bestandsrechteck wie layer.json
const DGM_LAND_AB_OST = 7.8;

function bestand() {
  const verfuegbar = [];
  for (let l = 0; l <= 16; l++) {
    const nx = schema.getNumberOfXTilesAtLevel(l);
    const ny = schema.getNumberOfYTilesAtLevel(l);
    const sx = Math.floor((DE.west + 180) / 360 * nx);
    const ex = Math.floor((DE.ost + 180) / 360 * nx);
    const sy = Math.floor((DE.sued + 90) / 180 * ny);
    const ey = Math.floor((DE.nord + 90) / 180 * ny);
    verfuegbar.push([{ startX: sx, startY: sy, endX: ex, endY: ey }]);
  }
  return { tilejson: '2.1.0', format: 'heightmap-1.0', schema: 'tms', version: '1.1.0', available: verfuegbar };
}

function dgmKachel(level, x, tmsY, gzip) {
  const y = schema.getNumberOfYTilesAtLevel(level) - 1 - tmsY;
  const r = schema.tileXYToRectangle(x, y, level);
  const werte = new Uint16Array(65 * 65);
  for (let zeile = 0; zeile < 65; zeile++) {
    for (let i = 0; i < 65; i++) {
      const lon = Cesium.Math.toDegrees(r.west + i * r.width / 64);
      werte[zeile * 65 + i] = lon < DGM_LAND_AB_OST ? 5000 : (100 + 1000) * 5;
    }
  }
  const roh = Buffer.concat([Buffer.from(werte.buffer), Buffer.from([15, 0])]);
  const ergebnis = gzip ? zlib.gzipSync(roh) : roh;
  return ergebnis.buffer.slice(ergebnis.byteOffset, ergebnis.byteOffset + ergebnis.byteLength);
}

function attrappen(opt) {
  opt = opt || {};
  const urls = [];
  const holen = (url, request) => {
    urls.push(url);
    if (opt.drosseln && request) return undefined;
    if (url.endsWith('layer.json')) {
      if (opt.ohneBasemap) return Promise.reject(new Error('Netz weg'));
      return Promise.resolve(new TextEncoder().encode(JSON.stringify(bestand())).buffer);
    }
    let m = url.match(/dgm5_4326_mesh\/(\d+)\/(\d+)\/(\d+)\.terrain/);
    if (m) return Promise.resolve(dgmKachel(+m[1], +m[2], +m[3], opt.gzip));
    m = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (m) return Promise.resolve({ z: +m[1], x: +m[2], y: +m[3] });
    return Promise.reject(new Error('unbekannte URL ' + url));
  };
  // Statt PNG-Dekodierung: RGBA mit der gewünschten Terrarium-Höhe je Pixel
  const bild = (k) => {
    const daten = new Uint8ClampedArray(256 * 256 * 4);
    const n = 1 << k.z;
    for (let py = 0; py < 256; py++) {
      const merc = Math.PI * (1 - 2 * (k.y * 256 + py + 0.5) / (n * 256));
      const lat = Cesium.Math.toDegrees(Math.atan(Math.sinh(merc)));
      const hoehe = lat < 45 ? -50 : 140;
      const w = hoehe + 32768;
      for (let px = 0; px < 256; px++) {
        const o = 4 * (py * 256 + px);
        daten[o] = Math.floor(w / 256); daten[o + 1] = Math.floor(w) % 256; daten[o + 2] = 0; daten[o + 3] = 255;
      }
    }
    return Promise.resolve({ width: 256, height: 256, data: daten });
  };
  return { urls, holen, bild, undulation: opt.undulation || (() => UNDULATION) };
}

function kachelBei(lon, lat, level) {
  const xy = schema.positionToTileXY(Cesium.Cartographic.fromDegrees(lon, lat), level);
  return { x: xy.x, y: xy.y, level, rechteck: schema.tileXYToRectangle(xy.x, xy.y, level) };
}

function hoeheIn(daten, k, lon, lat) {
  return daten.interpolateHeight(k.rechteck, Cesium.Math.toRadians(lon), Cesium.Math.toRadians(lat));
}

(async function () {
  // ── 1 · Dekodierung ───────────────────────────────────────────────────────

  const t = G._intern.terrariumLesen({ width: 1, height: 1,
    data: new Uint8ClampedArray([Math.floor(32868.5 / 256), 32868 % 256, 128, 255]) });
  pruefe('Terrarium: R·256 + G + B/256 − 32768', nahe(t.hoehen[0], 100.5, 1e-6), String(t.hoehen[0]));

  const roh = await G._intern.dgmLesen(dgmKachel(16, 68549, 50972, false));
  const gz = await G._intern.dgmLesen(dgmKachel(16, 68549, 50972, true));
  pruefe('heightmap-1.0 wird gelesen (65 × 65)', roh && roh.length === 65 * 65);
  pruefe('gzip ohne Content-Encoding wird ausgepackt', gz && gz.length === 65 * 65 && gz[100] === roh[100]);

  pruefe('Terrain-Tiles-Zoom: Ebene 16 → z15, Ebene 0 → z0',
         G._intern.terrariumZoom(180 / 65536 / 64) === 15 && G._intern.terrariumZoom(180 / 64) === 0);

  // ── 2 · Höhenbezug ────────────────────────────────────────────────────────

  const a = attrappen();
  const provider = await G.erzeugen(a);
  pruefe('basemap.de-Bestand angebunden', provider.quellen.dgm5 === true);
  pruefe('Provider hat Vertexnormalen, keine Wassermaske', provider.hasVertexNormals === true && provider.hasWaterMask === false);

  const mainz = kachelBei(8.2765, 50.0005, 16);
  const dMainz = await provider.requestTileGeometry(mainz.x, mainz.y, mainz.level);
  const hMainz = hoeheIn(dMainz, mainz, 8.2765, 50.0005);
  pruefe('Mainz: DGM5 100 m NHN + 48 m Undulation = 148 m über dem Ellipsoid', nahe(hMainz, 148, 0.05), hMainz.toFixed(3));
  pruefe('Mainz: Kachel nennt das BKG mit Veränderungshinweis',
         dMainz.credits.length === 1 && /GeoBasis-DE\/BKG \d{4}/.test(dMainz.credits[0].html) && /verändert/.test(dMainz.credits[0].html));

  const tmsY = schema.getNumberOfYTilesAtLevel(16) - 1 - mainz.y;
  pruefe('basemap.de wird in TMS-Zählung abgefragt (y von Süden)',
         a.urls.some((u) => u.includes(`dgm5_4326_mesh/16/${mainz.x}/${tmsY}.terrain`)));
  pruefe('Mainz: kein Terrain-Tiles-Abruf, wo das DGM5 Daten hat', !a.urls.some((u) => u.includes('terrarium')));

  // Undulation je Stützstelle, nicht je Kachel: auf Ebene 6 spannt eine
  // Kachel 2,8° — N ändert sich darüber um Meter.
  const b = attrappen({ undulation: (lat) => lat });
  const pSchief = await G.erzeugen(b);
  const k6 = kachelBei(10, 51, 6);
  const d6 = await pSchief.requestTileGeometry(k6.x, k6.y, k6.level);
  const nord = Cesium.Math.toDegrees(k6.rechteck.north) - 0.01;
  const sued = Cesium.Math.toDegrees(k6.rechteck.south) + 0.01;
  pruefe('Undulation je Stützstelle (Nord- und Südrand verschieden)',
         nahe(hoeheIn(d6, k6, 10, nord), 100 + nord, 0.3) && nahe(hoeheIn(d6, k6, 10, sued), 100 + sued, 0.3),
         hoeheIn(d6, k6, 10, nord).toFixed(2) + ' / ' + hoeheIn(d6, k6, 10, sued).toFixed(2));

  // ── 3 · Grenze, Ausland, Meer ─────────────────────────────────────────────

  const grenze = kachelBei(DGM_LAND_AB_OST, 50, 10);
  const dGrenze = await provider.requestTileGeometry(grenze.x, grenze.y, grenze.level);
  const hWest = hoeheIn(dGrenze, grenze, Cesium.Math.toDegrees(grenze.rechteck.west) + 0.001, 50);
  const hOst = hoeheIn(dGrenze, grenze, Cesium.Math.toDegrees(grenze.rechteck.east) - 0.001, 50);
  pruefe('Grenzkachel: Füllwert 0,0 m wird durch Terrain Tiles ersetzt (140 + 48)', nahe(hWest, 188, 0.5), hWest.toFixed(2));
  pruefe('Grenzkachel: deutsche Seite bleibt DGM5 (100 + 48)', nahe(hOst, 148, 0.5), hOst.toFixed(2));
  pruefe('Grenzkachel: beide Quellen im Vermerk', dGrenze.credits.length === 2);

  const strassburg = kachelBei(7.75, 48.58, 16);
  const dStr = await provider.requestTileGeometry(strassburg.x, strassburg.y, strassburg.level);
  const hStr = hoeheIn(dStr, strassburg, 7.75, 48.58);
  pruefe('Straßburg (im Bestandsrechteck, aber Füllwert): Terrain Tiles statt 0 m', nahe(hStr, 188, 0.5), hStr.toFixed(2));

  const lissabon = kachelBei(-9.14, 38.72, 12);
  const dLis = await provider.requestTileGeometry(lissabon.x, lissabon.y, lissabon.level);
  const hLis = hoeheIn(dLis, lissabon, -9.14, 38.72);
  pruefe('Außerhalb des Bestands: nur Terrain Tiles, kein basemap.de-Abruf',
         !a.urls.some((u) => u.includes(`dgm5_4326_mesh/12/${lissabon.x}/`)));
  pruefe('Meer: Bathymetrie wird auf den Meeresspiegel begrenzt (0 + 48)', nahe(hLis, 48, 0.05), hLis.toFixed(3));

  // ── 4 · Normalen ──────────────────────────────────────────────────────────

  const normale = Cesium.AttributeCompression.octDecode(dMainz._encodedNormals[2 * 2112], dMainz._encodedNormals[2 * 2112 + 1], new Cesium.Cartesian3());
  const lot = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(
    Cesium.Cartographic.fromRadians(mainz.rechteck.west + 32 * mainz.rechteck.width / 64,
                                    mainz.rechteck.south + 32 * mainz.rechteck.height / 64));
  pruefe('Ebene Fläche: Normale steht senkrecht (zeigt nach oben)', Cesium.Cartesian3.dot(normale, lot) > 0.999,
         Cesium.Cartesian3.dot(normale, lot).toFixed(5));

  // ── 5 · Verfügbarkeit, Drosselung, Abtastung ──────────────────────────────

  pruefe('Verfügbarkeit: überall Ebene 16',
         provider.availability.computeMaximumLevelAtPosition(Cesium.Cartographic.fromDegrees(8.27, 50)) === 16 &&
         provider.availability.computeMaximumLevelAtPosition(Cesium.Cartographic.fromDegrees(-70, -30)) === 16);
  pruefe('Ebene 17 nicht verfügbar (Cesium teilt selbst)', provider.getTileDataAvailable(0, 0, 17) === false);

  const [probe] = await Cesium.sampleTerrainMostDetailed(provider, [Cesium.Cartographic.fromDegrees(8.2765, 50.0005)]);
  pruefe('sampleTerrainMostDetailed (terrain-align.js) liefert 148 m', probe && nahe(probe.height, 148, 0.05),
         probe && probe.height.toFixed(3));

  const pDrossel = await G.erzeugen(attrappen());
  pDrossel._holen = attrappen({ drosseln: true }).holen;
  const gedrosselt = pDrossel.requestTileGeometry(mainz.x, mainz.y, mainz.level, new Cesium.Request({ throttle: true }));
  const gedrosseltWelt = pDrossel.requestTileGeometry(lissabon.x, lissabon.y, lissabon.level, new Cesium.Request({ throttle: true }));
  pruefe('Gedrosselt: undefined zurück, Cesium fragt später erneut', gedrosselt === undefined && gedrosseltWelt === undefined);

  const k0 = await provider.requestTileGeometry(0, 0, 0);
  pruefe('Ebene 0 (halbe Erde) baut ein Netz mit Horizontpunkt', !!k0 && !!k0._horizonOcclusionPoint);

  // ── 5b · basemap.de hängt (2026-10-31: Server nahm keine Verbindung an) ──
  // Ein hängender Abruf wirft nicht — ohne Frist blieb die Kachel ewig offen
  // und der Globus unter ~500 m auf Ebene 10 stehen.

  const h = attrappen();
  const pHaengt = await G.erzeugen(Object.assign({}, h, { frist: 40 }));
  let dgmAbrufe = 0;
  pHaengt._holen = (url, request) => {
    if (url.includes('dgm5_4326_mesh')) { dgmAbrufe++; return new Promise(() => {}); }
    return h.holen(url, request);
  };
  const anfrage = new Cesium.Request({ throttle: false });
  let abgebrochen = false;
  anfrage.cancel = () => { abgebrochen = true; };
  const t0 = Date.now();
  const dHaengt = await pHaengt.requestTileGeometry(mainz.x, mainz.y, mainz.level, anfrage);
  pruefe('Hängende DGM5-Kachel: nach der Frist kommt Terrain Tiles (140 + 48)',
         !!dHaengt && nahe(hoeheIn(dHaengt, mainz, 8.2765, 50.0005), 188, 0.5) && Date.now() - t0 < 1000,
         dHaengt && hoeheIn(dHaengt, mainz, 8.2765, 50.0005).toFixed(2));
  pruefe('Hängende DGM5-Kachel: Cesiums Abrufplatz wird freigegeben (request.cancel)', abgebrochen);
  for (let i = 0; i < 2; i++) await pHaengt.requestTileGeometry(mainz.x + 1 + i, mainz.y, mainz.level);
  pruefe('Drei Fehlschläge am Stück: basemap.de gilt als ausgefallen', pHaengt.dgmStand().aus === true);
  const vorher = dgmAbrufe;
  const dAus = await pHaengt.requestTileGeometry(mainz.x + 5, mainz.y, mainz.level);
  pruefe('Ausgefallen: kein weiterer basemap.de-Abruf, sofort Terrain Tiles', !!dAus && dgmAbrufe === vorher);
  pHaengt._ausBis = Date.now() - 1;
  pHaengt._holen = h.holen;
  const dWieder = await pHaengt.requestTileGeometry(mainz.x, mainz.y, mainz.level);
  pruefe('Nach der Pause: basemap.de wird wieder gefragt', nahe(hoeheIn(dWieder, mainz, 8.2765, 50.0005), 148, 0.05));

  // ── 5c · DGM1 RLP aus dem eigenen Backend ─────────────────────────────────
  // Zuerst DGM1, Lücken (NaN) aus DGM5 bzw. Terrain Tiles; in RLP bis Ebene 18.

  const q = attrappen();
  const dgm1Urls = [];
  const holenMitDgm1 = (url, request) => {
    if (url.startsWith('http://backend/gelaende/dgm1/')) {
      dgm1Urls.push(url);
      const h = new Float32Array(65 * 65).fill(120);
      for (let i = 0; i < 65; i++) h[i] = NaN;          // Südrand ohne DGM1
      return Promise.resolve(h.buffer);
    }
    return q.holen(url, request);
  };
  const pDgm1 = await G.erzeugen(Object.assign({}, q, { holen: holenMitDgm1,
    dgm1: { basis: 'http://backend/gelaende/dgm1', grenzen: [6.1, 48.9, 8.6, 50.95] } }));
  pruefe('DGM1: als Quelle gemeldet', pDgm1.quellen.dgm1 === true);
  const dMitDgm1 = await pDgm1.requestTileGeometry(mainz.x, mainz.y, mainz.level);
  const nordDgm1 = Cesium.Math.toDegrees(mainz.rechteck.north) - 1e-6;
  const suedDgm1 = Cesium.Math.toDegrees(mainz.rechteck.south) + 1e-7;
  const westDgm1 = Cesium.Math.toDegrees(mainz.rechteck.west) + 1e-6;
  pruefe('DGM1: 120 m NHN + 48 m Undulation = 168 m', nahe(hoeheIn(dMitDgm1, mainz, westDgm1, nordDgm1), 168, 0.05),
         hoeheIn(dMitDgm1, mainz, westDgm1, nordDgm1).toFixed(2));
  pruefe('DGM1: Lücke am Südrand aus DGM5 (100 + 48)', nahe(hoeheIn(dMitDgm1, mainz, westDgm1, suedDgm1), 148, 0.5),
         hoeheIn(dMitDgm1, mainz, westDgm1, suedDgm1).toFixed(2));
  pruefe('DGM1: Abruf in Cesiums Kachelzählung (y von Norden)',
         dgm1Urls.includes(`http://backend/gelaende/dgm1/16/${mainz.x}/${mainz.y}`));
  pruefe('DGM1: beide Vermerke an der Kachel', dMitDgm1.credits.some((c) => /LVermGeoRP/.test(c.html)) &&
         dMitDgm1.credits.some((c) => /BKG/.test(c.html)));
  const k18 = kachelBei(8.2765, 50.0005, 18);
  const k18aussen = kachelBei(13.4, 52.5, 18);
  pruefe('DGM1: Ebene 18 in RLP verfügbar, in Berlin nicht',
         pDgm1.getTileDataAvailable(k18.x, k18.y, 18) === true && pDgm1.getTileDataAvailable(k18aussen.x, k18aussen.y, 18) === false);
  pruefe('DGM1: Verfügbarkeit reicht in RLP bis 18',
         pDgm1.availability.computeMaximumLevelAtPosition(Cesium.Cartographic.fromDegrees(8.27, 50)) === 18 &&
         pDgm1.availability.computeMaximumLevelAtPosition(Cesium.Cartographic.fromDegrees(13.4, 52.5)) === 16);
  const pDgm1Leer = await G.erzeugen(Object.assign({}, q, {
    holen: (url, r) => url.includes('/gelaende/dgm1/') ? Promise.resolve(undefined) : q.holen(url, r),
    dgm1: { basis: 'http://backend/gelaende/dgm1', grenzen: [6.1, 48.9, 8.6, 50.95] } }));
  const dLeer = await pDgm1Leer.requestTileGeometry(mainz.x, mainz.y, mainz.level);
  pruefe('DGM1: leere Antwort (204) → DGM5 wie bisher', nahe(hoeheIn(dLeer, mainz, 8.2765, 50.0005), 148, 0.05));

  // ── 6 · Ohne basemap.de, ohne Geoid ───────────────────────────────────────

  const d = attrappen({ ohneBasemap: true });
  const pOhne = await G.erzeugen(d);
  const dOhne = await pOhne.requestTileGeometry(mainz.x, mainz.y, mainz.level);
  pruefe('basemap.de weg: Terrain Tiles übernehmen auch in Deutschland',
         pOhne.quellen.dgm5 === false && nahe(hoeheIn(dOhne, mainz, 8.2765, 50.0005), 188, 0.05));

  const e = attrappen({ undulation: () => null });
  const pOhneGeoid = await G.erzeugen(e);
  let abgelehnt = false;
  try { await pOhneGeoid.requestTileGeometry(mainz.x, mainz.y, mainz.level); } catch (f) { abgelehnt = /Geoid/.test(f.message); }
  pruefe('Ohne Undulation lieber keine Kachel als eine 48 m zu tiefe', abgelehnt);

  globalThis.ILEEN_GEOID = { load: async () => null, getUndulation: () => null };
  let erzeugenAbgelehnt = false;
  try { await G.erzeugen({ holen: attrappen().holen, bild: attrappen().bild }); } catch (f) { erzeugenAbgelehnt = /EGM96/.test(f.message); }
  pruefe('erzeugen() wirft, wenn das EGM96-Gitter nicht lädt', erzeugenAbgelehnt);

  // ── 7 · Quelltexte: kein Weg zurück zu ion für Karte, Gelände, Kulisse ────

  // Kommentare dürfen die alten Wege nennen; gezählt wird nur Code.
  const ohneKommentare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const lesen = (datei) => ohneKommentare(fs.readFileSync(path.join(WURZEL, datei), 'utf8'));
  const core = lesen('core.js');
  const index = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf8');
  for (const datei of ['core.js', 'layerManager.js', 'kartenquellen.js', 'gelaende.js']) {
    const quelle = lesen(datei);
    for (const verboten of ['IonImageryProvider', 'createWorldTerrainAsync', 'createOsmBuildingsAsync',
                            'createWorldImageryAsync', 'IonGeocoderService', 'Ion.defaultAccessToken']) {
      if (datei === 'core.js' && verboten === 'Ion.defaultAccessToken') continue;   // eigene ion-Modelle
      pruefe(`${datei} ohne ${verboten}`, !new RegExp('\\b' + verboten.replace('.', '\\.') + '\\b').test(quelle));
    }
  }
  // Google verweigert Projekten im EWR Satellit und 3D Tiles; nur das darf
  // über ion kommen, und nur nach dem direkten Versuch mit eigenem Schlüssel.
  const karten = lesen('kartenquellen.js');
  pruefe('Google 3D Tiles zuerst direkt mit eigenem Schlüssel (ohne key nähme Cesium ion)',
         /createGooglePhotorealistic3DTileset\(\{\s*key: schluessel/.test(karten) &&
         !/createGooglePhotorealistic3DTileset/.test(core));
  pruefe('ion in kartenquellen.js nur als Google-Rückfall (Assets 2275207, 3830184)',
         (karten.match(/IonResource\.|fromIonAssetId/g) || []).length === 2 &&
         /fromAssetId\(ION_GOOGLE_3D,/.test(karten) && /assetId: ION_GOOGLE_2D/.test(karten) &&
         /ION_GOOGLE_3D = 2275207/.test(karten) && /ION_GOOGLE_2D = 3830184/.test(karten) &&
         /async function googleHolen[\s\S]*?return \{ ergebnis: await direkt\([\s\S]*?ueberIon\(token\)/.test(karten));
  pruefe('ion nur noch für eigene ion-Modelle (IonResource nur in loadSelectedAsset)',
         (core.match(/IonResource\.|fromIonAssetId/g) || []).length <= 2 &&
         /async loadSelectedAsset[\s\S]*fromIonAssetId[\s\S]*IonResource\.fromAssetId/.test(core));
  pruefe('ion-Kontoliste wird nicht mehr beim Start geholt', !/autoLoadIonAssets\(\)/.test(index));
  pruefe('gelaende.js und kartenquellen.js sind eingebunden',
         index.includes('src="gelaende.js"') && index.includes('src="kartenquellen.js"'));

  console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  process.exit(fehler ? 1 : 0);
})().catch((f) => { console.error(f); process.exit(1); });
