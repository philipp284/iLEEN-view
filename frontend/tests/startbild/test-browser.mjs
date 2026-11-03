// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Startbild und Bewegung weich im echten Viewer (ohne Backend, Gelände aus Terrain Tiles/DGM5 wie sonst).
//   VIEWER_URL=http://localhost:5190/ node tests/startbild/test-browser.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASIS = process.env.VIEWER_URL || 'http://localhost:5190/';
let fehler = 0;
const pruefe = (n, ok, h) => { if (ok) console.log('✓ ' + n); else { fehler++; console.log('✗ ' + n + (h !== undefined ? '\n    ' + h : '')); } };
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const profil = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-'));
const OHNE_HMR = () => {
  const WS = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'))) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 };
    return new WS(u, p);
  };
  window.WebSocket.prototype = WS.prototype;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, defaultViewport: null, userDataDir: profil(),
  args: ['--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows'] });
try {
  // ── A · Startbild ──────────────────────────────────────────────────────
  {
    const s = await browser.newPage();
    const meldungen = [];
    s.on('pageerror', (e) => meldungen.push(String(e).slice(0, 200)));
    await s.evaluateOnNewDocument(OHNE_HMR);
    await s.evaluateOnNewDocument(() => {
      window.__logoZu = null; window.__t0 = performance.now();
      const takt = setInterval(() => {
        const el = document.getElementById('ileenStart');
        if (window.BimViewer && BimViewer.Startbild && BimViewer.Startbild.stand().geht && window.__logoZu === null) window.__logoZu = Math.round(performance.now() - window.__t0);
        if (window.__logoZu !== null && !el) clearInterval(takt);
      }, 16);
    });
    await s.goto(BASIS + '?startbild=an', { waitUntil: 'domcontentloaded' });
    const da = await s.evaluate(() => { const e = document.getElementById('ileenStart'); return !!e && getComputedStyle(e).opacity === '1' && e.querySelectorAll('rect,path').length >= 9; });
    pruefe('Startbild: Logo steht gleich nach dem Laden des Dokuments, voll sichtbar, aus 9+ Formen', da);
    const sub0 = await s.evaluate(() => { const t = document.querySelector('#ileenStart .sb-sub'); return t ? { text: t.textContent.replace(/\s+/g, ' ').trim(), cyan: t.querySelectorAll('.sb-c2').length, breite: Math.round(t.getBoundingClientRect().width), wort: Math.round(document.querySelector('#ileenStart .sb-wort').getBoundingClientRect().width) } : null; });
    pruefe('Untertitel: „IMMERSIVE LEARNING ENVIRONMENT", Cyan an I · L · E, so breit wie der Schriftzug', !!sub0 && sub0.text === 'IMMERSIVE LEARNING ENVIRONMENT' && sub0.cyan === 3 && Math.abs(sub0.breite - sub0.wort) <= 1, JSON.stringify(sub0));
    await s.waitForFunction(() => window.BimViewer && BimViewer.viewer && BimViewer.Startbild, { timeout: 60000 });
    await s.waitForFunction(() => BimViewer.Startbild.stand().geht, { timeout: 30000, polling: 16 });
    const imAbgang = await s.evaluate(() => {
      const sc = BimViewer.viewer.scene, st = BimViewer.Startbild.stand(), L = BimViewer.ILeenLogo;
      return { glueht: st.glueht, el: !!document.getElementById('ileenStart'), tiles: sc.globe.tilesLoaded, seit: st.seitErstemBildMs,
               logo: !L || !L.sichtbar || !!(L.modell && L.modell.ready) };
    });
    pruefe('Startbild: geht erst, wenn der Viewer steht (und das Glühen beginnt gleichzeitig)', imAbgang.glueht && imAbgang.el);
    pruefe('Puffern: beim Abgang sind die Globuskacheln da und der Orbit-Schriftzug ist geladen (oder die Frist lief ab)',
      (imAbgang.tiles && imAbgang.logo) || imAbgang.seit >= 2900, JSON.stringify(imAbgang));
    const zu = await s.evaluate(() => Math.round(performance.now()));   // wenige ms nach dem Abgang
    pruefe('Startbild: Aufbau zu Ende, bevor das Überblenden einsetzt (mindestens 3,1 s ab Navigation)', zu >= 3100, zu + ' ms');

    await warte(1400);
    const mitte = await s.evaluate(() => {
      const sc = BimViewer.viewer.scene;
      return { sky: sc.skyAtmosphere.atmosphereLightIntensity, bloom: sc.postProcessStages.bloom.enabled };
    });
    const basis = await s.evaluate(() => BimViewer.Startbild.stand().basis);
    pruefe('Glühen: Himmelsatmosphäre heller; Bloom bleibt aus (er erzeugte farbige Flecken)', mitte.sky > basis.skyLicht * 1.3 && mitte.bloom === false, JSON.stringify(mitte) + ' Basis ' + basis.skyLicht);
    const t0Abgang = Date.now();
    await s.waitForFunction(() => !document.getElementById('ileenStart'), { timeout: 10000, polling: 50 });
    const abgangDauer = Date.now() - t0Abgang + 1400;
    pruefe('Startbild: nach dem Überblenden (2 s) aus dem Dokument genommen', abgangDauer >= 1900 && abgangDauer <= 3300, abgangDauer + ' ms');
    await s.waitForFunction(() => !BimViewer.Startbild.stand().glueht, { timeout: 15000 });
    const danach = await s.evaluate(() => {
      const sc = BimViewer.viewer.scene;
      return { skyLicht: sc.skyAtmosphere.atmosphereLightIntensity, skyHell: sc.skyAtmosphere.brightnessShift,
               bodenLicht: sc.globe.atmosphereLightIntensity, bodenHell: sc.globe.atmosphereBrightnessShift };
    });
    const bloomDanach = await s.evaluate(() => BimViewer.viewer.scene.postProcessStages.bloom.enabled);
    pruefe('Glühen: danach steht jeder Wert wieder genau auf dem Anfangswert', JSON.stringify(danach) === JSON.stringify(basis),
      JSON.stringify(danach) + '\n    vs ' + JSON.stringify(basis));
    pruefe('Glühen: Cesiums Standardwerte der Atmosphäre unverändert (50 / 0 / 10 / 0), Bloom aus', danach.skyLicht === 50 && danach.skyHell === 0 && danach.bodenLicht === 10 && danach.bodenHell === 0 && bloomDanach === false, JSON.stringify(danach));
    pruefe('Startbild: keine Fehler in der Seite', meldungen.length === 0, meldungen.join(' | '));
    await s.close();
  }

  // ── B · Automatisierung: kein Startbild, kein Glühen ───────────────────
  {
    const s = await browser.newPage();
    await s.evaluateOnNewDocument(OHNE_HMR);
    await s.goto(BASIS, { waitUntil: 'domcontentloaded' });
    pruefe('Automatisierung: kein Logo im Dokument', await s.evaluate(() => !document.getElementById('ileenStart')));
    await s.waitForFunction(() => window.BimViewer && BimViewer.Bewegungsweich && BimViewer.Bewegungsweich.stand().an && BimViewer.viewer.scene.globe.tilesLoaded, { timeout: 60000 });
    pruefe('Automatisierung: kein Glühen (Bloom bleibt aus)', await s.evaluate(() => !BimViewer.viewer.scene.postProcessStages.bloom.enabled && !BimViewer.Startbild.stand().glueht));
    await warte(1500);

    // ── C · Bewegung weich (nur der Detailverzicht; der Schleier ist draußen) ──
    const v0 = await s.evaluate(() => ({ g: BimViewer.viewer.scene.globe.maximumScreenSpaceError, eigen: Object.prototype.hasOwnProperty.call(BimViewer.viewer.camera, 'flyTo'),
                                         stufen: BimViewer.viewer.scene.postProcessStages.length }));
    pruefe('Bewegung weich: im Stand Faktor 1, Globus auf Cesiums Wert', await s.evaluate(() => {
      const st = BimViewer.Bewegungsweich.stand();
      return st.faktorGlobus === 1 && st.faktorModell === 1 && st.phase === 'ruhe';
    }));
    pruefe('Bewegung weich: flyTo der Kamera angehängt', v0.eigen);

    const flug = await s.evaluate(async () => {
      const v = BimViewer.viewer, c = v.camera, sc = v.scene;
      const bw = BimViewer.Bewegungsweich;
      const ziel = Cesium.Cartesian3.fromDegrees(8.2616, 49.9957, 400);
      const stufenVorher = sc.postProcessStages.length;
      const fertig = new Promise((ok) => c.flyTo({ destination: ziel, orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 }, duration: 2.5, complete: ok, cancel: ok }));
      await new Promise((r) => setTimeout(r, 900));
      const mitten = Object.assign(bw.stand(), { globeSSE: sc.globe.maximumScreenSpaceError, stufenWaehrend: sc.postProcessStages.length });
      await fertig;
      await new Promise((r) => setTimeout(r, 400));
      return { mitten, stufenVorher, gelandet: bw.stand(), globeSSE: sc.globe.maximumScreenSpaceError };
    });
    pruefe('Flug: Phase fahrt, Detailverzicht voll', flug.mitten.phase === 'fahrt' && flug.mitten.detailverzicht > 0.9, JSON.stringify(flug.mitten));
    pruefe('Flug: Globus verlangt gröberes Gelände (Bildschirmfehler ×3)', flug.mitten.globeSSE >= v0.g * 2.5, flug.mitten.globeSSE + ' vs ' + v0.g);
    pruefe('Flug: kein Schleier — keine Nachbearbeitungsstufe kommt dazu', flug.mitten.stufenWaehrend === flug.stufenVorher, JSON.stringify({ vorher: flug.stufenVorher, waehrend: flug.mitten.stufenWaehrend }));
    pruefe('Landung: der Verzicht geht schrittweise zurück (Nachlauf, nicht auf einen Schlag)', ['nachlauf', 'ruhe'].includes(flug.gelandet.phase) && flug.gelandet.detailverzicht < 1, JSON.stringify(flug.gelandet));

    await s.waitForFunction(() => { const st = BimViewer.Bewegungsweich.stand(); return st.phase === 'ruhe' && st.detailverzicht === 0; }, { timeout: 30000 });
    const ruhe = await s.evaluate(() => ({ st: BimViewer.Bewegungsweich.stand(), g: BimViewer.viewer.scene.globe.maximumScreenSpaceError }));
    pruefe('Danach: Bildschirmfehler wieder genau auf dem Anfangswert', ruhe.g === v0.g && ruhe.st.faktorGlobus === 1, JSON.stringify(ruhe));

    // Schnappschüsse sind unberührt (kein Eingriff in canvas.toDataURL mehr)
    const url = await s.evaluate(() => ({ eigen: Object.prototype.hasOwnProperty.call(BimViewer.viewer.canvas, 'toDataURL'), ok: BimViewer.viewer.canvas.toDataURL('image/png').length > 1000 }));
    pruefe('toDataURL ist nicht mehr überlagert und liefert Daten', !url.eigen && url.ok, JSON.stringify(url));

    // Präsentation: kein Verzicht
    const praes = await s.evaluate(async () => {
      document.body.classList.add('praes-laeuft');
      const c = BimViewer.viewer.camera;
      c.flyTo({ destination: Cesium.Cartesian3.fromDegrees(8.64, 50.11, 700), duration: 1.5 });
      await new Promise((r) => setTimeout(r, 700));
      const st = BimViewer.Bewegungsweich.stand();
      c.cancelFlight();
      document.body.classList.remove('praes-laeuft');
      return st;
    });
    pruefe('Präsentationsvorführung: kein Detailverzicht', praes.detailverzicht === 0 && praes.faktorGlobus === 1, JSON.stringify(praes));

    // Fremde Änderung des Globus-Fehlers während der Fahrt wird Ausgangswert
    const fremd = await s.evaluate(async () => {
      const g = BimViewer.viewer.scene.globe;
      const c = BimViewer.viewer.camera;
      await new Promise((r) => setTimeout(r, 1500));
      c.flyTo({ destination: Cesium.Cartesian3.fromDegrees(8.2616, 49.9957, 450), duration: 1.5 });
      await new Promise((r) => setTimeout(r, 600));
      g.maximumScreenSpaceError = 4;             // jemand stellt um
      await new Promise((r) => setTimeout(r, 1300));   // das Modul sieht im Sekundentakt nach
      const waehrend = g.maximumScreenSpaceError;
      c.cancelFlight();
      await new Promise((r) => setTimeout(r, 6000));
      return { waehrend, danach: g.maximumScreenSpaceError };
    });
    pruefe('Fremde Änderung gilt als neuer Ausgangswert und wird zurückgegeben', fremd.waehrend >= 4 * 2 && fremd.danach === 4, JSON.stringify(fremd));
    await s.evaluate(() => { BimViewer.viewer.scene.globe.maximumScreenSpaceError = 2; });

    // Ausschalten räumt alles weg
    const weg = await s.evaluate(() => {
      const bw = BimViewer.Bewegungsweich; bw.aus();
      const v = BimViewer.viewer;
      const c = v.scene.postProcessStages; let stufe = false;
      for (let i = 0; i < c.length; i++) { const e = c.get(i); if (e && e.name === 'ileen_bewegungsweich') stufe = true; }
      return { an: bw.stand().an, eigen: Object.prototype.hasOwnProperty.call(v.camera, 'flyTo'), stufe };
    });
    pruefe('aus(): flyTo nicht mehr überlagert, Bildschirmfehler zurück', !weg.an && !weg.eigen, JSON.stringify(weg));
    await s.close();
  }
} finally {
  await browser.close();
}
console.log(fehler ? '\n' + fehler + ' Prüfung(en) fehlgeschlagen' : '\nAlle Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
