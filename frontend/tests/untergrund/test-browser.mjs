// Untergrund-Modus und Vektorkarte im echten Browser: Chrome headless über
// puppeteer-core (kein Projekt-Dependency — `npm i --no-save puppeteer-core`),
// gegen den laufenden Dev-Server.
//
// Was hier und NUR hier geprüft werden kann:
//   · dass das Globus-Material der Nullebene sich übersetzen lässt
//     (`fwidth`, `gl_FrontFacing` im Globus-Shader)
//   · dass das Gelände von unten DECKEND ist — gezählt an den Bildpunkten in
//     Erdfarbe. Der Fehler bis v0.5 war genau das Gegenteil: ein Bild, durch
//     das man hindurchsah.
//   · dass ein Körper unter dem Gelände von oben sichtbar ist (Durchblick),
//     das Gelände daneben aber deckend bleibt
//   · dass die Rasterlinien auf der Oberfläche wirklich ankommen
//   · dass basemap.de-Vektorkacheln über Cesium 1.145 laden und zeichnen
//
// Aufruf:  npx vite --port 5181 &   node tests/untergrund/test-browser.mjs
//          VIEWER_URL=http://localhost:5182/  BILDER=/pfad  überschreiben

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5181/';
const BILDER = process.env.BILDER || path.dirname(fileURLToPath(import.meta.url));

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
page.on('pageerror', (e) => seitenfehler.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(
  () => !!(window.BimViewer?.viewer && window.BimViewer.Untergrund && window.Vektorkacheln),
  { timeout: 90000 });

console.log('Cesium', await page.evaluate(() => Cesium.VERSION));

// Hilfen im Seitenkontext: rendern bis das Gelände steht, Bildpunkte zählen.
await page.evaluate(() => {
  const szene = BimViewer.viewer.scene;
  window.__renderFehler = [];
  szene.renderError.addEventListener((s, e) => window.__renderFehler.push(String((e && e.message) || e)));
  // Die Startkamerafahrt und das Logo stören die Messung.
  BimViewer.viewer.camera.cancelFlight();
  BimViewer.ILeenLogo?.verbergen?.();

  window.__warten = async (bilder, bis) => {
    for (let i = 0; i < bilder; i++) {
      szene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (bis && i > 20 && bis()) break;
    }
  };

  // Liest das Bild direkt nach einem render() — ohne preserveDrawingBuffer
  // ist der Puffer sonst schon wieder leer. In VOLLER Auflösung: die
  // Rasterlinien sind ein bis zwei Bildpunkte breit, und ein verkleinertes
  // Bild mittelt sie in den Untergrund hinein. Genau daran ist die erste
  // Fassung dieser Zählung gescheitert.
  window.__zaehlen = () => {
    szene.render();
    const quelle = szene.canvas;
    const c = document.createElement('canvas');
    c.width = quelle.width; c.height = quelle.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(quelle, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let erde = 0, cyan = 0, magenta = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      n++;
      // Erdfarbe #4a3a2c (74,58,44), Beleuchtung und Mischung lassen Spiel
      if (r > g && g > b && r - b > 12 && r < 140 && b < 90) erde++;
      // Linienfarbe #30b4e7: Blau und Grün deutlich über Rot
      if (b > r + 60 && g > r + 30) cyan++;
      // Prüfkörper unter dem Gelände
      if (r > 150 && b > 150 && g < 90) magenta++;
    }
    return { erde: erde / n, cyan: cyan / n, magenta: magenta / n };
  };

  // Die App setzt ihre Startansicht (core.js initCamera, 10 000 km über
  // Europa) irgendwann NACH dem Anlegen des Viewers — ein zu früh gesetztes
  // setView wird still überschrieben. In der ersten Fassung wurde deshalb
  // „von oben über Mainz" aus dem Orbit gemessen. Also: setzen, nachmessen,
  // wiederholen, bis die Kamera steht.
  window.__kamera = async (lon, lat, hoehe, pitch) => {
    const kamera = BimViewer.viewer.camera;
    for (let versuch = 0; versuch < 40; versuch++) {
      kamera.cancelFlight();
      kamera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, hoehe),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitch), roll: 0 },
      });
      await window.__warten(8);
      if (Math.abs(kamera.positionCartographic.height - hoehe) < 2) return kamera.positionCartographic.height;
      await new Promise((r) => setTimeout(r, 400));
    }
    return kamera.positionCartographic.height;
  };

  // Geländehöhe aus dem Geländemodell selbst, nicht aus geladenen Kacheln:
  // globe.getHeight() kennt nur, was schon gezeichnet wurde.
  window.__gelaende = async (lon, lat) => {
    try {
      const [p] = await Cesium.sampleTerrainMostDetailed(
        BimViewer.viewer.terrainProvider, [Cesium.Cartographic.fromDegrees(lon, lat)]);
      if (Number.isFinite(p.height)) return p.height;
    } catch (e) { /* Rückfall unten */ }
    return BimViewer.viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)) ?? 0;
  };
});

const LON = 8.2599, LAT = 49.9929;   // Hochschule Mainz

// ── 1 · Von oben: Modus an, Durchblick an, Shader übersetzt ─────────────────

const oben = await page.evaluate(async (lon, lat) => {
  const szene = BimViewer.viewer.scene;
  const gelaende = await window.__gelaende(lon, lat);
  await window.__kamera(lon, lat, gelaende + 250, -50);
  await window.__warten(600, () => szene.globe.tilesLoaded);
  BimViewer.toggleUndergroundView();       // derselbe Weg wie der Schalter
  // Während des Wartens hat die App die Kamera noch einmal auf ihre
  // Startansicht gesetzt (so geschehen im zweiten Lauf) — deshalb UNMITTELBAR
  // vor der Messung erneut setzen und die Höhe zur Messzeit mitgeben.
  await window.__kamera(lon, lat, gelaende + 250, -50);
  await window.__warten(90, () => szene.globe.tilesLoaded);
  const zahl = window.__zaehlen();
  const kamera = BimViewer.viewer.camera.positionCartographic.height;
  return { stand: BimViewer.Untergrund.stand(), fehler: window.__renderFehler.slice(), zahl, gelaende, kamera };
}, LON, LAT);
await page.screenshot({ path: path.join(BILDER, '1-oben-nullebene.png') });

console.log(`  Gelände ${oben.gelaende.toFixed(1)} m, Kamera ${oben.kamera.toFixed(1)} m (Ellipsoid)`);
pruefe('Kamera steht wirklich 250 m über Mainz', Math.abs(oben.kamera - oben.gelaende - 250) < 5);
pruefe('Umschalter schaltet den Modus ein', oben.stand.an === true);
pruefe('Durchblick: Tiefentest gegen Gelände aus', oben.stand.tiefentest === false);
pruefe('Gelände nicht transparent', oben.stand.transparenz === false);
pruefe('Kamera-Kollision aus', oben.stand.kollision === false);
pruefe('Material der Nullebene übersetzt ohne Renderfehler', oben.fehler.length === 0, oben.fehler.join(' | '));
pruefe('Rasterlinien sind von oben zu sehen', oben.zahl.cyan > 0.002, `${(oben.zahl.cyan * 100).toFixed(2)} % cyan`);

// ── 1b · Körper unter dem Gelände: sichtbar mit Durchblick, verdeckt ohne ───

const koerper = await page.evaluate(async (lon, lat, h) => {
  const v = BimViewer.viewer, szene = v.scene;
  const box = v.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, h - 20),
    box: { dimensions: new Cesium.Cartesian3(40, 40, 8), material: Cesium.Color.MAGENTA },
  });
  await window.__kamera(lon, lat, h + 200, -89);
  await window.__warten(300, () => szene.globe.tilesLoaded);
  const mit = window.__zaehlen();
  BimViewer.Untergrund.durchblickSetzen(false);
  await window.__warten(10);
  const ohne = window.__zaehlen();
  BimViewer.Untergrund.durchblickSetzen(true);
  await window.__warten(10);
  const wieder = window.__zaehlen();
  return { mit, ohne, wieder, box: box.id };
}, LON, LAT, oben.gelaende);
await page.screenshot({ path: path.join(BILDER, '1b-koerper-unter-gelaende.png') });

pruefe('Durchblick an: Körper 20 m unter Gelände von oben sichtbar', koerper.mit.magenta > 0.005,
  `${(koerper.mit.magenta * 100).toFixed(2)} % magenta`);
pruefe('Durchblick aus: Gelände verdeckt den Körper', koerper.ohne.magenta < 0.0005,
  `${(koerper.ohne.magenta * 100).toFixed(3)} % magenta`);
pruefe('Durchblick wieder an: Körper wieder sichtbar', koerper.wieder.magenta > 0.005);
pruefe('Karte neben dem Körper bleibt deckend (Raster weiter sichtbar)', koerper.mit.cyan > 0.002,
  `${(koerper.mit.cyan * 100).toFixed(2)} % cyan`);
await page.evaluate((id) => BimViewer.viewer.entities.removeById(id), koerper.box);

// ── 2 · Von unten: deckende Erddecke mit Linien ─────────────────────────────

const unten = await page.evaluate(async (lon, lat, h) => {
  const szene = BimViewer.viewer.scene;
  const kamera = await window.__kamera(lon, lat, h - 25, 35);     // 25 m unter Gelände, Blick schräg nach oben
  await window.__warten(300, () => szene.globe.tilesLoaded);
  const mit = window.__zaehlen();
  const unter = szene.cameraUnderground;
  return { mit, unter, kamera, fehler: window.__renderFehler.slice() };
}, LON, LAT, oben.gelaende);
await page.screenshot({ path: path.join(BILDER, '2-unten-erddecke.png') });

console.log(`  Kamera ${(unten.kamera - oben.gelaende).toFixed(1)} m relativ zum Gelände`);
pruefe('Kamera steht unter dem Gelände', unten.unter === true);
pruefe('Gelände von unten deckend in Erdfarbe', unten.mit.erde > 0.25, `${(unten.mit.erde * 100).toFixed(1)} % Erdfarbe`);
pruefe('Rasterlinien auch von unten sichtbar', unten.mit.cyan > 0.002, `${(unten.mit.cyan * 100).toFixed(2)} % cyan`);

// ── 3 · Ausschalten gibt alles zurück ───────────────────────────────────────

const aus = await page.evaluate(async () => {
  const szene = BimViewer.viewer.scene;
  BimViewer.toggleUndergroundView();
  await window.__warten(10);
  return { stand: BimViewer.Untergrund.stand(), material: szene.globe.material,
           kollision: szene.screenSpaceCameraController.enableCollisionDetection,
           ungrund: !!szene.globe.undergroundColor };
});
pruefe('Ausschalten: Modus aus', aus.stand.an === false);
pruefe('Ausschalten: kein Material mehr am Globus', aus.material === undefined || aus.material === null);
pruefe('Ausschalten: Kollision wieder an', aus.kollision === true);
pruefe('Ausschalten: undergroundColor zurückgegeben', aus.ungrund === true);

// ── 4 · Vektorkarte ─────────────────────────────────────────────────────────

const vektor = await page.evaluate(async (lon, lat, h) => {
  const szene = BimViewer.viewer.scene;
  await window.__kamera(lon, lat, h + 700, -89);
  await window.__warten(300, () => szene.globe.tilesLoaded);
  await Vektorkacheln.einschalten();
  const stand = Vektorkacheln.stand();
  let geladen = false, bilder = 0;
  // Über den Prüfzugang des Moduls — `constructor.name` ist im minifizierten
  // Cesium-Build kein „MVTDataProvider" mehr.
  const ts = () => Vektorkacheln._pruefsteine.provider()?.tileset;
  for (; bilder < 900; bilder++) {
    szene.render();
    await new Promise((r) => requestAnimationFrame(r));
    const t = ts();
    if (t && t.tilesLoaded && bilder > 60) { geladen = true; break; }
  }
  const t = ts();
  const statistik = t ? { ausgewaehlt: t._statistics?.selected, features: t._statistics?.numberOfFeaturesLoaded,
                          geometrieBytes: t._statistics?.geometryByteLength } : null;
  return { stand, geladen, bilder, statistik, fehler: window.__renderFehler.slice() };
}, LON, LAT, oben.gelaende);
await page.screenshot({ path: path.join(BILDER, '3-vektorkarte-basemapde.png') });

pruefe('Vektorkarte eingeschaltet', vektor.stand.geladen === true, JSON.stringify(vektor.stand));
pruefe('basemap.de-Kacheln geladen', vektor.geladen, `${vektor.bilder} Bilder, ${JSON.stringify(vektor.statistik)}`);
pruefe('Vektorkacheln zeichnen ohne Renderfehler', vektor.fehler.length === 0, vektor.fehler.join(' | '));

pruefe('keine Seitenfehler', seitenfehler.length === 0, seitenfehler.slice(0, 3).join(' | '));

await browser.close();
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nalles in Ordnung');
console.log('Bilder:', BILDER);
process.exit(fehler ? 1 : 0);
