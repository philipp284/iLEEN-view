// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Misst, wann beim Öffnen was steht: Viewer, erstes Bild, Globus-Kacheln, Abgang des Logos.
//   VIEWER_URL=http://localhost:5190/ node tests/startbild/zeiten.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEITE = (process.env.VIEWER_URL || 'http://localhost:5190/') + '?startbild=an';
const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, defaultViewport: null, userDataDir: profil,
  args: ['--window-size=1400,900', '--no-first-run', '--no-default-browser-check'] });
try {
  const s = await browser.newPage();
  await s.evaluateOnNewDocument(() => {
    const WS = window.WebSocket;
    window.WebSocket = function (u, p) {
      if (p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'))) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 };
      return new WS(u, p);
    };
    window.WebSocket.prototype = WS.prototype;
    window.__zeiten = {};
    const t0 = performance.now();
    const marke = (n) => { if (!(n in window.__zeiten)) window.__zeiten[n] = Math.round(performance.now() - t0); };
    window.__marke = marke;
    const takt = setInterval(() => {
      const v = window.BimViewer && BimViewer.viewer;
      if (v) {
        marke('viewer');
        if (v.imageryLayers.length) marke('grundkarte');
        if (v.imageryLayers.length && v.scene.globe.tilesLoaded) marke('globeFertig');
      }
      const sb = window.BimViewer && BimViewer.Startbild;
      if (sb) { const st = sb.stand(); if (st.geht) marke('logoGeht'); }
      if (!document.getElementById('ileenStart') && 'logoGeht' in window.__zeiten) { marke('logoWeg'); clearInterval(takt); }
    }, 20);
    document.addEventListener('DOMContentLoaded', () => marke('dom'));
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (e.name === 'first-paint') window.__zeiten.ersterAnstrich = Math.round(e.startTime); })).observe({ type: 'paint', buffered: true });
    window.addEventListener('load', () => marke('load'));
  });
  await s.goto(SEITE, { waitUntil: 'domcontentloaded' });
  await s.waitForFunction(() => window.__zeiten && 'logoWeg' in window.__zeiten, { timeout: 40000 }).catch(() => {});
  console.log(JSON.stringify(await s.evaluate(() => window.__zeiten)));
} finally {
  await browser.close();
}
