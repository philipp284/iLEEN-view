// Wie weit ein Zug die Kamera versetzt — im echten Browser gemessen.
//
// Voraussetzung: puppeteer-core und ein Dev-Server (Vorgabe: Port 5190,
// `npx vite`).
//
// Aufruf:  node tests/navigation/test-ziehen.mjs
//
// Warum im Browser
// ================
// Der Rechenkern von greifweite.js ist in test-trackpad.js ohne Browser
// geprüft: Wegmarke, Anteil, Mischung. Was dort grundsätzlich NICHT geprüft
// werden kann, ist die eine Frage, um die es geht — ob Cesium überhaupt an
// der Stelle vorbeikommt, an der wir bremsen. Die Bremse hängt an
// `scene.preUpdate`, und der Kamera-Controller läuft in `initializeFrame`,
// also ein Stück davor. Stimmt diese Reihenfolge nicht, misst das Modul
// seinen eigenen Eingriff und die Begrenzung tut nichts.
//
// Gemessen wird deshalb der gefahrene Weg selbst, zweimal dasselbe Ziehen:
// einmal mit Begrenzung, einmal ohne. Der Unterschied ist der Befund.
//
// Der Aufbau ist der gemeldete Fall: gut hundert Meter über Grund, flacher
// Blick Richtung Horizont, Zeiger nach oben gezogen. Genau dort liegt der
// Griffpunkt kilometerweit weg, und genau dort sprang die Kamera davon.

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5190/';

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '\n      ' + hinweis : ''}`); }
}
const m = (x) => (x >= 1000 ? (x / 1000).toFixed(2) + ' km' : x.toFixed(1) + ' m');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--window-size=1280,900'],
});

try {
  const seite = await browser.newPage();
  await seite.setViewport({ width: 1280, height: 900 });
  await seite.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Zuerst: messen wir überhaupt die richtige Anwendung? Ein belegter Port
  // und `strictPort` haben hier schon einmal dazu geführt, dass ein Prüfstein
  // eine fremde Anwendung vermessen und alles für gut befunden hat.
  const titel = await seite.title();
  pruefe('es ist iLEEN, das hier läuft', titel === 'iLEEN', `Titel: ${titel}`);
  if (titel !== 'iLEEN') throw new Error('falsche Anwendung — Messung abgebrochen');

  await seite.waitForFunction(
    () => window.BimViewer && window.BimViewer.viewer && window.BimViewer.viewer.scene,
    { timeout: 60000 });
  pruefe('Greifweite hat sich angemeldet',
    await seite.evaluate(() => !!(window.Greifweite && window.Greifweite.werte)));

  // ── Standort einrichten: gut 120 m über Grund, flacher Blick ────────────
  const AUFBAU = { lon: 8.2473, lat: 49.9929, ueberGrund: 120, pitch: -12 };

  async function aufstellen() {
    await seite.evaluate(async (a) => {
      const v = window.BimViewer.viewer, C = window.Cesium;
      const carto = C.Cartographic.fromDegrees(a.lon, a.lat);
      let grund = 0;
      try {
        const [hoehe] = await C.sampleTerrainMostDetailed(v.terrainProvider, [carto]);
        if (hoehe && isFinite(hoehe.height)) grund = hoehe.height;
      } catch (e) { /* ohne Gelände zählt das Ellipsoid */ }
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(a.lon, a.lat, grund + a.ueberGrund),
        orientation: { heading: 0, pitch: C.Math.toRadians(a.pitch), roll: 0 }
      });
      v.scene.requestRender();
    }, AUFBAU);
    // Kacheln nachladen lassen — ohne Tiefe im Puffer greift der Zug ins Leere.
    await seite.waitForFunction(
      () => window.BimViewer.viewer.scene.globe.tilesLoaded, { timeout: 60000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
  }

  const stand = () => seite.evaluate(() => {
    const c = window.BimViewer.viewer.camera;
    return { x: c.positionWC.x, y: c.positionWC.y, z: c.positionWC.z,
             hoehe: c.positionCartographic.height };
  });
  const abstand = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  /** Ein Zug: drücken, in Schritten ziehen, loslassen, ausrollen lassen. */
  async function ziehen(dx, dy, schritte = 25) {
    const x0 = 640, y0 = 520;
    await seite.mouse.move(x0, y0);
    await seite.mouse.down({ button: 'left' });
    for (let i = 1; i <= schritte; i++) {
      await seite.mouse.move(x0 + (dx * i) / schritte, y0 + (dy * i) / schritte);
      await new Promise(r => setTimeout(r, 16));
    }
    await seite.mouse.up({ button: 'left' });
    await new Promise(r => setTimeout(r, 1800));   // Trägheit ausrollen lassen
  }

  const schalten = (an) => seite.evaluate((a) => {
    if (a) window.Greifweite.an(); else window.Greifweite.aus();
  }, an);

  // ── 1 · Ohne Begrenzung: der gemeldete Sprung ──────────────────────────
  await schalten(false);
  await aufstellen();
  const vorherOhne = await stand();
  await ziehen(0, -260);
  const nachherOhne = await stand();
  const wegOhne = abstand(vorherOhne, nachherOhne);
  console.log(`  ohne Begrenzung: ${m(wegOhne)} bei einem Zug von 260 px`);

  // ── 2 · Mit Begrenzung: derselbe Zug ───────────────────────────────────
  await schalten(true);
  await aufstellen();
  const marke = await seite.evaluate(() => {
    const w = window.Greifweite.werte();
    const v = window.BimViewer.viewer;
    const carto = v.camera.positionCartographic;
    const grund = v.scene.globe.getHeight(carto);
    const h = Math.abs(carto.height - (isFinite(grund) ? grund : 0));
    return { weite: Math.max(w.zugMinimum, w.zugFaktor * h), hoehe: h, werte: w };
  });
  const vorherMit = await stand();
  await ziehen(0, -260);
  const nachherMit = await stand();
  const wegMit = abstand(vorherMit, nachherMit);
  console.log(`  mit Begrenzung:  ${m(wegMit)} — Wegmarke ${m(marke.weite)}`
            + ` (${marke.hoehe.toFixed(0)} m über Grund)`);

  // Die Marke gilt für den Kameraweg. Die Mischung eines Bildes darf sie um
  // den Rest eines Schrittes überziehen, mehr nicht — 10 % Luft.
  pruefe('der Zug bleibt innerhalb der Wegmarke',
    wegMit <= marke.weite * 1.1,
    `gefahren ${m(wegMit)}, erlaubt ${m(marke.weite)}`);

  pruefe('und die Begrenzung tut damit wirklich etwas',
    wegOhne > wegMit * 1.5,
    `ohne ${m(wegOhne)} / mit ${m(wegMit)} — wenn beide gleich sind, hat der`
    + ` Aufbau den Sprung nicht ausgelöst und die Messung sagt nichts`);

  // ── 3 · Gegenprobe: das Ziehen darf nicht tot sein ─────────────────────
  //
  // Eine Bremse, die alles anhält, ist keine Bremse. Ein kurzer Zug muss die
  // Kamera bewegen — und zwar spürbar, nicht um Zentimeter.
  await aufstellen();
  const vorherKurz = await stand();
  await ziehen(0, -60);
  const wegKurz = abstand(vorherKurz, await stand());
  console.log(`  kurzer Zug (60 px): ${m(wegKurz)}`);
  pruefe('ein kurzer Zug bewegt die Kamera noch', wegKurz > 1.0, `nur ${m(wegKurz)}`);
  pruefe('und bleibt dabei unter der Marke', wegKurz <= marke.weite * 1.1);

  // ── 4 · Die Marke gilt je Zug, nicht je Sitzung ────────────────────────
  const vorherZwei = await stand();
  await ziehen(0, -260);
  const wegZwei = abstand(vorherZwei, await stand());
  console.log(`  zweiter Zug: ${m(wegZwei)}`);
  pruefe('der nächste Zug hat wieder sein volles Maß', wegZwei > 1.0);

  // ── 5 · Seitwärts zählt genauso ────────────────────────────────────────
  await aufstellen();
  const vorherQuer = await stand();
  await ziehen(420, 0);
  const wegQuer = abstand(vorherQuer, await stand());
  console.log(`  quer (420 px): ${m(wegQuer)}`);
  pruefe('auch quer bleibt der Zug innerhalb der Marke',
    wegQuer <= marke.weite * 1.1, `gefahren ${m(wegQuer)}`);
  pruefe('und bewegt die Kamera dabei', wegQuer > 1.0);

  // ── 6 · Der Blick bleibt gerade ────────────────────────────────────────
  //
  // Gemischt wird zwischen zwei Kamerastände. Läuft dabei `up` aus dem
  // rechten Winkel oder der Betrag der Position weg, kippt über viele Bilder
  // der Horizont oder die Kamera sackt ab — beides sieht man erst spät.
  const gerade = await seite.evaluate(() => {
    const c = window.BimViewer.viewer.camera;
    const d = c.directionWC, u = c.upWC;
    return {
      lotrecht: Math.abs(d.x * u.x + d.y * u.y + d.z * u.z),
      dirLaenge: Math.hypot(d.x, d.y, d.z),
      upLaenge: Math.hypot(u.x, u.y, u.z),
      roll: window.Cesium.Math.toDegrees(c.roll)
    };
  });
  pruefe('Blick und Oben stehen weiter rechtwinklig', gerade.lotrecht < 1e-6);
  pruefe('beide haben Länge 1',
    Math.abs(gerade.dirLaenge - 1) < 1e-6 && Math.abs(gerade.upLaenge - 1) < 1e-6);
  pruefe('der Horizont ist nicht gekippt',
    Math.abs(gerade.roll) < 0.5 || Math.abs(Math.abs(gerade.roll) - 360) < 0.5,
    `Roll ${gerade.roll.toFixed(3)}°`);

  const hoeheNachher = (await stand()).hoehe;
  pruefe('die Kamera ist nicht abgesackt',
    Math.abs(hoeheNachher - vorherQuer.hoehe) < marke.weite,
    `${vorherQuer.hoehe.toFixed(1)} m → ${hoeheNachher.toFixed(1)} m`);

} finally {
  await browser.close();
}

console.log(fehler === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
