// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Legt Bilder vom Start ab: Logo, Abgang, Globus mit Glühen, Globus abgekühlt.
//   BILDER=/pfad/ VIEWER_URL=http://localhost:5190/ node tests/startbild/bilder.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEITE = (process.env.VIEWER_URL || 'http://localhost:5190/') + '?startbild=an';
const AUS = process.env.BILDER || path.join(os.tmpdir(), 'startbild-bilder');
fs.mkdirSync(AUS, { recursive: true });
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, defaultViewport: null,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sbb-')), args: ['--window-size=1400,900', '--no-first-run'] });
try {
  const s = await browser.newPage();
  await s.evaluateOnNewDocument(() => {
    const WS = window.WebSocket;
    window.WebSocket = function (u, p) {
      if (p === 'vite-hmr' || (Array.isArray(p) && p.includes('vite-hmr'))) return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 1 };
      return new WS(u, p);
    };
    window.WebSocket.prototype = WS.prototype;
  });
  await s.goto(SEITE, { waitUntil: 'domcontentloaded' });
  const tStart = Date.now();
  for (const [name, bei] of [['1a-aufbau-1,2s', 1200], ['1b-aufbau-2,0s', 2000], ['1c-aufbau-2,8s', 2800], ['1d-fertig-3,4s', 3400]]) {
    const rest = bei - (Date.now() - tStart);
    if (rest > 0) await warte(rest);
    await s.screenshot({ path: path.join(AUS, name + '.png') });
  }
  await s.waitForFunction(() => window.BimViewer && BimViewer.Startbild && BimViewer.Startbild.stand().geht, { timeout: 40000, polling: 16 });
  const bei = await s.evaluate(() => ({ tilesLoaded: BimViewer.viewer.scene.globe.tilesLoaded, seit: BimViewer.Startbild.stand().seitErstemBildMs, logo: !!(BimViewer.ILeenLogo && BimViewer.ILeenLogo.modell && BimViewer.ILeenLogo.modell.ready) }));
  console.log('beim Abgang', JSON.stringify(bei));
  const t0 = Date.now();
  const stufen = [['2-licht-0,4s', 400], ['3-abklingen-1,0s', 1000], ['4-abklingen-1,6s', 1600], ['5-frei-2,4s', 2400], ['6-ruhe-5s', 5000]];
  for (const [name, bei] of stufen) {
    const rest = bei - (Date.now() - t0);
    if (rest > 0) await warte(rest);
    await s.screenshot({ path: path.join(AUS, name + '.png') });
    const st = await s.evaluate(() => {
      const sc = BimViewer.viewer.scene, sky = sc.skyAtmosphere;
      return { glueht: BimViewer.Startbild.stand().glueht, sky: sky.atmosphereLightIntensity, bloom: sc.postProcessStages.bloom.enabled };
    });
    console.log(name, JSON.stringify(st));
  }
  console.log('Bilder in', AUS);
} finally { await browser.close(); }
