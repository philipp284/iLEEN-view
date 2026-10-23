// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Prüfstein für Splats in vr.html: lädt ein Splat-Modell, wartet auf Kacheln,
// prüft Haushalt und Lage und schreibt Bilder (Vorschau + Quest-3-Emulator).
//
// Aufruf:  VR_JOB=<job-id> node tests/vr/test-vr-splat.mjs
//          Bilder landen in $VR_BILDER (Vorgabe: /tmp)
// Voraussetzung wie test-vr.mjs (puppeteer-core, Dev-Server :5181, Backend :8100).

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEITE = process.env.VIEWER_URL || 'http://localhost:5181/';
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8100';
const BILDER = process.env.VR_BILDER || '/tmp';
const IWER = 'https://cdn.jsdelivr.net/npm/iwer@2.6.0/build/iwer.module.js';

let fehler = 0;
const pruefe = (name, ok, hinweis) => {
  if (ok) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
};

const assets = await (await fetch(`${BACKEND}/assets/`)).json();
// Ein Splat mit Kachelbaum: ein einzelnes Tile (kleine Fotoserien) kann nicht verfeinern
async function splatWaehlen() {
  if (process.env.VR_JOB) return process.env.VR_JOB;
  const zaehlen = k => 1 + (k.children || []).reduce((s, c) => s + zaehlen(c), 0);
  const splats = assets.filter(a => a.content_type === 'splat');
  for (const a of splats) {
    try {
      const t = await (await fetch(`${BACKEND}/tiles/${a.job_id}/tileset.json`)).json();
      if (zaehlen(t.root) > 4) return a.job_id;
    } catch { /* nächster */ }
  }
  return splats[0].job_id;
}
const job = await splatWaehlen();
console.log(`Splat-Modell: ${job}\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', acceptInsecureCerts: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1280,900'],
});
const konsole = [];
try {
  const seite = await browser.newPage();
  await seite.setViewport({ width: 1280, height: 900 });
  // Fehlende Kacheln externer Weltquellen (Gelände, Luftbild, LoD2) sind kein Fehler der Seite
  const WELTQUELLEN = /geodatenzentrum\.de|reearth\.land|elevation-tiles-prod|maps\.eox\.at|openstreetmap\.org|rlp\.de|hessen\.de|nrw\.de|bayern\.de|saarland\.de|lod2_4326|ileen-quest\.json/;
  seite.on('console', m => {
    if (m.type() !== 'error') return;
    const wo = (m.location() && m.location().url) || '';
    if (WELTQUELLEN.test(wo) || WELTQUELLEN.test(m.text()) || /error code 404/.test(m.text())) return;
    konsole.push(m.text());
  });
  seite.on('pageerror', e => konsole.push(`pageerror: ${(e.stack || e.message).split('\n').slice(0, 4).join(' ← ')}`));
  await seite.goto(`${SEITE}vr.html?job=${encodeURIComponent(job)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await seite.waitForFunction(() => !!window.ILeenVR, { timeout: 30000 });

  const zaehle = () => seite.evaluate(() => {
    let meshes = 0, splats = 0;
    ILeenVR.tiles.group.traverse(o => { if (o.splatAnzahl !== undefined) { meshes++; splats += o.splatAnzahl; } });
    return { meshes, splats, sichtbar: ILeenVR.tiles.visibleTiles.size, fehler: ILeenVR.tiles.errorTarget };
  });
  await seite.waitForFunction(() => {
    let n = 0; ILeenVR.tiles && ILeenVR.tiles.group.traverse(o => { if (o.splatAnzahl !== undefined) n++; });
    return n > 0;
  }, { timeout: 90000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 6000));
  const z = await zaehle();
  console.log('      ', JSON.stringify(z));
  pruefe('Splat-Kacheln wurden zu SplatMesh', z.meshes > 0, JSON.stringify(z));
  const k = await seite.evaluate(() => ({ a: ILeenVR.zustand.ausgerichtet, k: ILeenVR.zustand.kasten }));
  pruefe('ausgerichtet', k.a);
  await seite.screenshot({ path: `${BILDER}/vr-splat-vorschau.png` });

  await seite.addScriptTag({ type: 'module', content: `
    import { XRDevice, metaQuest3 } from '${IWER}';
    const brille = new XRDevice(metaQuest3); brille.installRuntime({ forceInstall: true }); window.__brille = brille;` });
  await seite.waitForFunction(() => !!window.__brille, { timeout: 30000 });
  await seite.evaluate(() => ILeenVR.pruefeXR());
  await seite.waitForFunction(() => !document.getElementById('vrKnopfVR').disabled, { timeout: 10000 }).catch(() => {});
  await seite.evaluate(() => ILeenVR.betreten('vr'));
  await new Promise(r => setTimeout(r, 8000));
  const zx = await zaehle();
  console.log('      in der Brille', JSON.stringify(zx));
  pruefe('in der Brille: Sitzung läuft', await seite.evaluate(() => ILeenVR.renderer.xr.isPresenting));
  pruefe('in der Brille: Splats unter dem Haushalt (1,0 Mio. + Puffer)', (await seite.evaluate(() => {
    let s = 0; for (const t of ILeenVR.tiles.visibleTiles) { const sc = t.engineData && t.engineData.scene; sc && sc.traverse(o => { if (o.splatAnzahl !== undefined) s += o.splatAnzahl; }); }
    return s;
  })) < 3_000_000);
  await seite.screenshot({ path: `${BILDER}/vr-splat-brille.png` });

  // Mitten ins Modell: die Kacheln müssen verfeinern, der Haushalt muss halten.
  await seite.evaluate(() => { const k = ILeenVR.zustand.kasten; ILeenVR.nutzer.position.set(0, (k.min.y + k.max.y) / 2, k.max.z * 0.5); });
  let nah;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 2500));
    nah = await seite.evaluate(() => {
      let s = 0, m = 0;
      for (const t of ILeenVR.tiles.visibleTiles) { const sc = t.engineData && t.engineData.scene; sc && sc.traverse(o => { if (o.splatAnzahl !== undefined) { s += o.splatAnzahl; m++; } }); }
      return { sichtbarSplats: s, kacheln: m, fehler: Math.round(ILeenVR.tiles.errorTarget * 10) / 10 };
    });
  }
  console.log('      mitten im Modell', JSON.stringify(nah));
  pruefe('mitten im Modell: feinere Kacheln als aus der Ferne', nah.sichtbarSplats > zx.splats, JSON.stringify(nah));
  pruefe('mitten im Modell: Haushalt hält (< 1,5 Mio.)', nah.sichtbarSplats < 1_500_000, JSON.stringify(nah));
  await seite.screenshot({ path: `${BILDER}/vr-splat-nah.png` });
} catch (e) {
  fehler++; console.log(`✗ Abbruch: ${e.message}`);
} finally {
  await browser.close();
}
const echt = konsole.filter(t => !/favicon|net::ERR_ABORTED/.test(t));
pruefe('keine Fehler in der Konsole', echt.length === 0, echt.slice(0, 5).join('\n      '));
console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
