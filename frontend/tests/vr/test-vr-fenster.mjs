// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Der Schalter 🥽 VR in iLEEN: öffnet er die Ebene und beginnt die Sitzung im
// iframe, ohne dass man dort noch einmal drücken muss?
//
// Voraussetzung: puppeteer-core, iLEEN unter VIEWER_URL (Vite auf 5181 oder der
// Dienst auf https://<Mac>:5443/), Backend auf 8100, Internet für den CDN.
// Den Emulator liefert IWER: IWER_DATEI zeigt auf iwer.min.js (UMD) aus dem
// npm-Paket `iwer`; ohne Angabe wird es einmal per `npm pack` geholt.
//
// Aufruf:  VIEWER_URL=https://192.168.0.9:5443/ node tests/vr/test-vr-fenster.mjs
//
// Grenze: Eine echte Brille prüft das nicht. Ob Chromium die Geste vom
// Elternfenster an den iframe weitergibt, zeigt nur die Brille; IWER verlangt
// keine Geste.

import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEITE = process.env.VIEWER_URL || 'http://localhost:5181/';
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8100';

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
}

function iwerQuelle() {
  if (process.env.IWER_DATEI && existsSync(process.env.IWER_DATEI)) return readFileSync(process.env.IWER_DATEI, 'utf8');
  const ordner = mkdtempSync(join(tmpdir(), 'iwer-'));
  execFileSync('npm', ['pack', 'iwer@2.6.0'], { cwd: ordner, stdio: 'ignore' });
  execFileSync('tar', ['xzf', 'iwer-2.6.0.tgz'], { cwd: ordner });
  return readFileSync(join(ordner, 'package/build/iwer.min.js'), 'utf8');
}

const assets = await (await fetch(`${BACKEND}/assets/`)).json();
const halle = assets.filter(a => a.content_type === 'ifc').find(a => /^Kranhalle Fertigteilwerk/.test(a.name));
const job = process.env.VR_JOB || halle.job_id;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', acceptInsecureCerts: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1280,900'],
});
const konsole = [];
// Einzelne gescheiterte Anfragen im Headless-Chrome sind kein Fehler des Servers:
// 2400 parallele Anfragen gegen Weiche und Vite liefen ohne Ausfall. Sie werden
// gemeldet, lassen den Test aber nicht scheitern.
const hinweise = [];
const T0 = Date.now();
try {
  const seite = await browser.newPage();
  await seite.setViewport({ width: 1280, height: 900 });
  seite.on('pageerror', e => konsole.push(`pageerror: ${e.message}`));
  seite.on('requestfailed', r => hinweise.push(`Anfrage gescheitert: ${r.url().slice(0, 100)} (${r.failure() && r.failure().errorText}) in ${r.frame() && r.frame().url().slice(-30)} bei ${((Date.now() - T0) / 1000).toFixed(1)} s`));
  // Fehlende Kacheln externer Weltquellen und der Quest-Dienst am Mac sind kein Fehler der Seite
  const WELTQUELLEN = /geodatenzentrum\.de|reearth\.land|elevation-tiles-prod|maps\.eox\.at|openstreetmap\.org|rlp\.de|hessen\.de|nrw\.de|bayern\.de|saarland\.de|lod2_4326|ileen-quest\.json/;
  seite.on('console', m => {
    if (m.type() !== 'error') return;
    const wo = (m.location() && m.location().url) || '';
    if (WELTQUELLEN.test(wo) || WELTQUELLEN.test(m.text()) || /error code 404/.test(m.text())) return;
    konsole.push(m.text());
  });

  // Die Quest 3 in jedes Fenster, auch in den iframe
  await seite.evaluateOnNewDocument(`${iwerQuelle()}
    ;(function () {
      if (window.__brille) return;
      const b = new IWER.XRDevice(IWER.metaQuest3);
      b.installRuntime({ forceInstall: true });
      window.__brille = b;
    })();`);

  await seite.goto(SEITE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await seite.waitForFunction(() => window.BimViewer && BimViewer.viewer && window.ILeenVRFenster, { timeout: 90000 });
  pruefe('iLEEN steht, vr-fenster.js da', true);

  // Der iframe wird 4 s nach dem Laden unsichtbar vorbereitet
  await seite.waitForFunction(() => ILeenVRFenster.moeglich, { timeout: 30000 }).catch(() => {});
  pruefe('mit Brille: Ebene wird vorbereitet', await seite.evaluate(() => ILeenVRFenster.moeglich));
  await seite.waitForFunction(() => {
    const f = document.querySelector('#vrEbene iframe');
    return f && f.contentWindow && f.contentWindow.ILeenVR;
  }, { timeout: 60000 }).catch(() => {});
  pruefe('iframe geladen (vr.js läuft darin)', await seite.evaluate(() => {
    const f = document.querySelector('#vrEbene iframe');
    return !!(f && f.contentWindow && f.contentWindow.ILeenVR);
  }));
  pruefe('Ebene zunächst unsichtbar', await seite.evaluate(() => document.getElementById('vrEbene').style.display === 'none'));

  // Ein Modell in iLEEN laden, dann Schalter
  await seite.evaluate(j => BimViewer.loadBackendAsset(j, 'Kranhalle'), job);
  await seite.waitForFunction(() => [...BimViewer.loadedAssets.values()].some(a => a.jobId), { timeout: 60000 });
  await seite.evaluate(() => document.getElementById('nhud-cb-vr').click());

  const ergebnis = await seite.waitForFunction(() => {
    const f = document.querySelector('#vrEbene iframe');
    const w = f && f.contentWindow && f.contentWindow.ILeenVR;
    return w && w.renderer.xr.isPresenting && w.zustand.modus === 'vr';
  }, { timeout: 30000 }).then(() => true).catch(() => false);
  pruefe('Schalter beginnt die Sitzung im iframe', ergebnis);
  pruefe('Ebene liegt über iLEEN', await seite.evaluate(() => document.getElementById('vrEbene').style.display === 'block'));

  // Das Modell kommt erst nach dem Betreten an — Lage wird nachgesetzt
  await seite.waitForFunction(() => {
    const w = document.querySelector('#vrEbene iframe').contentWindow.ILeenVR;
    return w.zustand.ausgerichtet && w.tiles.visibleTiles.size > 0;
  }, { timeout: 90000 }).catch(() => {});
  const lage = await seite.evaluate(() => {
    const w = document.querySelector('#vrEbene iframe').contentWindow.ILeenVR;
    const k = w.zustand.kasten;
    return { job: w.zustand.job, ausgerichtet: w.zustand.ausgerichtet, z: w.nutzer.position.z, zMax: k.max.z,
             nan: [w.nutzer.position.x, w.nutzer.position.y, w.nutzer.position.z].some(Number.isNaN) };
  });
  pruefe('das geladene Modell aus iLEEN ist das in der Brille', lage.job === job, JSON.stringify(lage));
  pruefe('Start vor der Südseite, nachdem das Modell eintraf', lage.ausgerichtet && lage.z > lage.zMax && !lage.nan, JSON.stringify(lage));

  // Schließen beendet die Sitzung
  await seite.click('#vrEbene button');
  await new Promise(r => setTimeout(r, 800));
  const zu = await seite.evaluate(() => ({
    sichtbar: document.getElementById('vrEbene').style.display !== 'none',
    sitzung: document.querySelector('#vrEbene iframe').contentWindow.ILeenVR.renderer.xr.isPresenting,
  }));
  pruefe('✕ beendet die Sitzung und schließt die Ebene', !zu.sichtbar && !zu.sitzung, JSON.stringify(zu));

  // Zweites Mal: Sitzung ohne neuen Ladevorgang
  await seite.evaluate(() => document.getElementById('nhud-cb-vr').click());
  pruefe('zweiter Schalterdruck beginnt wieder', await seite.waitForFunction(() =>
    document.querySelector('#vrEbene iframe').contentWindow.ILeenVR.renderer.xr.isPresenting, { timeout: 15000 })
    .then(() => true).catch(() => false));

  const echte = konsole.filter(t => !/iwer|IWER|GL Driver|menu_pressed|Failed to load resource/.test(t));
  for (const h of hinweise) console.log(`  Hinweis: ${h}`);
  pruefe('keine Fehler in der Konsole', echte.length === 0, echte.slice(0, 5).join('\n      '));
} finally {
  await browser.close();
}
console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
