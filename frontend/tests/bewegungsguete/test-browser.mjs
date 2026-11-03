// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// bewegungsguete.js im echten Viewer, ohne Backend: das Ziel wird so tief gelegt, dass jede
// Szene „schwer" ist, dann wird die Kamera bewegt und angehalten. Geprüft wird die Anbindung
// (Auflösung, Schatten, Rückgabe, fremde Eingriffe), nicht die Bildrate.
//
//   npx vite --port 5231 --strictPort &
//   VIEWER_URL=http://localhost:5231/ node tests/bewegungsguete/test-browser.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEITE = process.env.VIEWER_URL || 'http://localhost:5231/';
let fehler = 0;
const pruefe = (n, ok, h) => { if (ok) console.log('✓ ' + n); else { fehler++; console.log('✗ ' + n + (h !== undefined ? '\n    ' + h : '')); } };
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, defaultViewport: null, userDataDir: profil,
  args: ['--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows'] });
try {
  const s = await browser.newPage();
  const meldungen = [];
  s.on('pageerror', (e) => meldungen.push(String(e).slice(0, 200)));
  await s.evaluateOnNewDocument(() => {
    const WS = window.WebSocket;
    window.WebSocket = function (u, p) {
      if (p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'))) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 };
      return new WS(u, p);
    };
    window.WebSocket.prototype = WS.prototype;
  });
  await s.goto(SEITE, { waitUntil: 'domcontentloaded' });
  await s.waitForFunction(() => window.BimViewer && BimViewer.Bewegungsguete && BimViewer.Bewegungsguete.stand().an, { timeout: 60000 });
  await warte(3000);

  const v0 = await s.evaluate(() => {
    const v = BimViewer.viewer;
    return { rs: v.resolutionScale, schatten: v.shadowMap.enabled, preset: BimViewer._currentPerformanceSettings.resolutionScale };
  });
  pruefe('Regler läuft, Stufe 0, Auflösung wie die Darstellungsstufe', v0.rs === v0.preset, JSON.stringify(v0));

  // Ziel so tief, dass jede Szene schwer ist; kurze Sperre, damit der Lauf nicht lange dauert
  await s.evaluate(() => BimViewer.Bewegungsguete.einstellen({ zielMs: 2, sperreMs: 150, fensterBilder: 3 }));
  await warte(1200);                                      // Ruhe: die Kosten im Stand werden gelernt
  const ruhe = await s.evaluate(() => BimViewer.Bewegungsguete.stand());
  pruefe('im Stand: Stufe 0, volle Güte', ruhe.stufe === 0 && ruhe.resolutionScale === v0.rs, JSON.stringify(ruhe));

  // Kamera drehen (stetig)
  const lauf = await s.evaluate(async () => {
    const v = BimViewer.viewer;
    const weg = v.scene.preRender.addEventListener(() => v.camera.rotateRight(0.004));
    const spur = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      await new Promise((r) => setTimeout(r, 100));
      const st = BimViewer.Bewegungsguete.stand();
      spur.push({ stufe: st.stufe, rs: v.resolutionScale, sh: v.shadowMap.enabled });
    }
    weg();
    return spur;
  });
  const letzte = lauf[lauf.length - 1];
  pruefe('Bewegung: schon früh nicht mehr Stufe 0', lauf.slice(0, 5).some((e) => e.stufe >= 1), JSON.stringify(lauf.slice(0, 5)));
  pruefe('Bewegung: Auflösung gesenkt', letzte.rs < v0.rs, JSON.stringify(letzte));
  pruefe('Bewegung: Stufe 2 schaltet die Schatten ab (wenn sie an waren)',
    letzte.stufe < 2 || letzte.sh === false || v0.schatten === false, JSON.stringify(letzte));

  await warte(1000);
  const danach = await s.evaluate(() => {
    const v = BimViewer.viewer;
    return { st: BimViewer.Bewegungsguete.stand(), rs: v.resolutionScale, sh: v.shadowMap.enabled };
  });
  pruefe('Stillstand: Stufe 0, Auflösung zurück', danach.st.stufe === 0 && danach.rs === v0.rs, JSON.stringify(danach));
  pruefe('Stillstand: Schatten wie vorher', danach.sh === v0.schatten, JSON.stringify(danach));

  // Darstellungsstufe wechseln, während der Regler gesenkt hat: deren Wert gilt
  const fremd = await s.evaluate(async () => {
    const v = BimViewer.viewer;
    const weg = v.scene.preRender.addEventListener(() => v.camera.rotateRight(0.004));
    await new Promise((r) => setTimeout(r, 900));
    const gesenkt = v.resolutionScale;
    BimViewer.applyPerformanceSettings(CONFIG.performance.presets.PERFORMANCE);   // setzt 0,85
    await new Promise((r) => setTimeout(r, 300));
    weg();
    await new Promise((r) => setTimeout(r, 1000));
    return { gesenkt, jetzt: v.resolutionScale, st: BimViewer.Bewegungsguete.stand() };
  });
  pruefe('fremde Änderung (Stufe PERFORMANCE) wird nicht überschrieben', Math.abs(fremd.jetzt - 0.85) < 0.01, JSON.stringify(fremd));

  // Abschalten gibt zurück
  const aus = await s.evaluate(async () => {
    const v = BimViewer.viewer;
    const weg = v.scene.preRender.addEventListener(() => v.camera.rotateRight(0.004));
    await new Promise((r) => setTimeout(r, 700));
    BimViewer.Bewegungsguete.aus();
    weg();
    return { rs: v.resolutionScale, base: BimViewer._currentPerformanceSettings.resolutionScale, sh: v.shadowMap.enabled };
  });
  pruefe('aus() gibt die Güte der Darstellungsstufe zurück', Math.abs(aus.rs - aus.base) < 0.01, JSON.stringify(aus));
  pruefe('keine Seitenfehler', meldungen.length === 0, meldungen.join(' | '));
} finally {
  await browser.close();
  fs.rmSync(profil, { recursive: true, force: true });
}
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nalles bestanden');
process.exit(fehler ? 1 : 0);
