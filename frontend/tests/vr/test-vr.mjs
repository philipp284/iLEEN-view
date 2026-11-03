// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Der VR-Prüfstein: vr.html im echten Browser, mit einer nachgebildeten Quest 3.
//
// Voraussetzung: puppeteer-core (`npm i --no-save puppeteer-core`), ein
// laufender Dev-Server auf Port 5181 (`npx vite`) und das Backend auf 8100.
// Internet: three.js, 3d-tiles-renderer und der Emulator kommen vom CDN.
//
// Aufruf:  node tests/vr/test-vr.mjs
//          VR_JOB=<job-id> node tests/vr/test-vr.mjs     (sonst die Kranhalle
//                                                          bzw. das erste IFC)
//
// Die Brille kommt von IWER (Immersive Web Emulation Runtime, Meta, MIT): es
// ersetzt `navigator.xr` durch eine Quest 3 mit Touch-Controllern, deren Lage,
// Knöpfe und Sticks sich setzen lassen. Damit wird hier nicht nur „lädt die
// Seite" geprüft, sondern was in der Brille passiert:
//   · das Modell steht richtig: Grundriss mittig, Unterkante auf y = 0
//   · ein Klick am Bildschirm liest ein Bauteil aus der Batch Table (Tablet → Info)
//   · 1:1 betreten: Start vor der Südseite, Kacheln rechnen mit der XR-Kamera
//   · Abzug auf den Boden springt, linker Stick geht, rechter Stick dreht 30°
//   · Tischmodell: verkleinert, vor dem Kopf auf Tischhöhe
//   · keine Fehler in der Konsole

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEITE = process.env.VIEWER_URL || 'http://localhost:5181/';
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8100';
const IWER = 'https://cdn.jsdelivr.net/npm/iwer@2.6.0/build/iwer.module.js';

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
}

async function jobWaehlen() {
  if (process.env.VR_JOB) return process.env.VR_JOB;
  const assets = await (await fetch(`${BACKEND}/assets/`)).json();
  const ifc = assets.filter(a => a.content_type === 'ifc');
  const halle = ifc.find(a => /^Kranhalle Fertigteilwerk/.test(a.name));
  return (halle || ifc[0]).job_id;
}

const job = await jobWaehlen();
console.log(`Modell: ${job}\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // Für den WLAN-Weg (tools/quest-wlan.sh, selbst ausgestelltes Zertifikat):
  // das „Weiter zu …", das man in der Brille einmal drückt.
  acceptInsecureCerts: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--window-size=1280,900'],
});

const konsole = [];
try {
  const seite = await browser.newPage();
  await seite.setViewport({ width: 1280, height: 900 });
  // Fehlende Kacheln externer Weltquellen (das BKG listet z. B. LoD2-Unterkacheln,
  // die es nicht ausliefert) sind kein Fehler der Seite.
  const WELTQUELLEN = /geodatenzentrum\.de|reearth\.land|elevation-tiles-prod|maps\.eox\.at|openstreetmap\.org|rlp\.de|hessen\.de|nrw\.de|bayern\.de|saarland\.de|lod2_4326|ileen-quest\.json/;
  seite.on('console', m => {
    if (m.type() !== 'error') return;
    const wo = (m.location() && m.location().url) || '';
    if (WELTQUELLEN.test(wo) || WELTQUELLEN.test(m.text())) return;
    if (/Failed to load model with error code 404/.test(m.text())) return;   // dieselbe Unterkachel, aus dem Lader
    konsole.push(m.text());
  });
  // Mit Stack: der sporadische „reading '0'“ vom 2026-10-21 soll beim nächsten Mal greifbar sein
  seite.on('pageerror', e => konsole.push(`pageerror: ${(e.stack || e.message).split('\n').slice(0, 4).join(' ← ')}`));

  await seite.goto(`${SEITE}vr.html?job=${encodeURIComponent(job)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  pruefe('Seitentitel ist iLEEN VR', (await seite.title()) === 'iLEEN VR', await seite.title());
  await seite.waitForFunction(() => !!window.ILeenVR, { timeout: 30000 });
  const kontext = await seite.evaluate(() => ({ sicher: window.isSecureContext, backend: ILeenVR.backend }));
  pruefe('sicherer Kontext (sonst kein WebXR)', kontext.sicher, SEITE);
  if (SEITE.startsWith('https:')) {
    pruefe('über https: Backend durch den Dev-Server', kontext.backend === new URL(SEITE).origin + '/backend', kontext.backend);
  }

  // ── Modell ────────────────────────────────────────────────────
  await seite.waitForFunction(
    () => window.ILeenVR && ILeenVR.zustand.ausgerichtet && ILeenVR.tiles && ILeenVR.tiles.visibleTiles.size > 0,
    { timeout: 90000 },
  ).catch(() => {});
  const modell = await seite.evaluate(() => {
    const { zustand, tiles } = window.ILeenVR || {};
    if (!zustand || !zustand.ausgerichtet) return null;
    const k = zustand.kasten;
    return {
      min: [k.min.x, k.min.y, k.min.z], max: [k.max.x, k.max.y, k.max.z],
      sichtbar: tiles.visibleTiles.size,
      status: document.getElementById('vrStatus').textContent,
    };
  });
  pruefe('Modell geladen und ausgerichtet', !!modell, 'Wurzel kam nicht oder keine Kachel sichtbar');
  if (!modell) throw new Error('ohne Modell geht es nicht weiter');
  const [bx, by, bz] = modell.max.map((v, i) => v - modell.min[i]);
  console.log(`      Kasten ${bx.toFixed(1)} × ${by.toFixed(1)} × ${bz.toFixed(1)} m, ${modell.sichtbar} Kacheln sichtbar`);
  pruefe('Unterkante auf y = 0', Math.abs(modell.min[1]) < 1e-6, modell.min[1]);
  pruefe('Grundriss mittig', Math.abs(modell.min[0] + modell.max[0]) < 1e-6 && Math.abs(modell.min[2] + modell.max[2]) < 1e-6);
  pruefe('Maße plausibel (1 m … 5 km)', [bx, by, bz].every(v => v > 0.5 && v < 5000), [bx, by, bz].join(' / '));

  // Bis alles geladen ist, sonst trifft der Klick womöglich nur eine grobe Kachel
  await seite.waitForFunction(() => ILeenVR.tiles.loadProgress >= 1, { timeout: 90000 }).catch(() => {});

  // ── Bauteil am Bildschirm ─────────────────────────────────────
  const szene = await seite.$('#vrSzene canvas');
  const r = await szene.boundingBox();
  let bauteil = null;
  // Das Modell steht in der Bildmitte, etwas unterhalb — ein paar Stellen probieren
  for (const [fx, fy] of [[0.5, 0.55], [0.5, 0.65], [0.45, 0.6], [0.55, 0.5], [0.5, 0.45]]) {
    await seite.mouse.click(r.x + r.width * fx, r.y + r.height * fy);
    bauteil = await seite.evaluate(() => {
      const a = ILeenVR.auswahl;
      return a && a.quelle === 'modell' ? `${a.titel} · ${a.name} · ${a.kopf.map(z => z.join(' ')).join(' · ')}` : null;
    });
    if (bauteil) break;
  }
  pruefe('Klick liest ein Bauteil aus der Batch Table', !!bauteil);
  if (bauteil) console.log(`      ${bauteil.slice(0, 110)}`);
  pruefe('Tablet zeigt die Info-Seite', await seite.evaluate(() => ILeenVR.tablet.seite === 'info') || !bauteil);
  pruefe('Bauteil hervorgehoben', await seite.evaluate(() => {
    let n = 0;
    ILeenVR.tiles.group.traverse(o => { if (o.userData.vrMarkierung) n++; });
    return n > 0;
  }) || !bauteil);

  // ── Brille anstecken ──────────────────────────────────────────
  pruefe('ohne Brille: Knöpfe gesperrt', await seite.evaluate(() =>
    document.getElementById('vrKnopfVR').disabled && document.getElementById('vrKnopfTisch').disabled));

  await seite.addScriptTag({
    type: 'module',
    content: `
      import { XRDevice, metaQuest3 } from '${IWER}';
      const brille = new XRDevice(metaQuest3);
      brille.installRuntime({ forceInstall: true });
      window.__brille = brille;
    `,
  });
  await seite.waitForFunction(() => !!window.__brille, { timeout: 30000 });
  await seite.evaluate(() => ILeenVR.pruefeXR());
  await seite.waitForFunction(() => !document.getElementById('vrKnopfVR').disabled, { timeout: 10000 }).catch(() => {});
  pruefe('mit Quest 3: beide Knöpfe frei', await seite.evaluate(() =>
    !document.getElementById('vrKnopfVR').disabled && !document.getElementById('vrKnopfTisch').disabled));

  // ── 1:1 ──────────────────────────────────────────────────────
  await seite.click('#vrKnopfVR');
  await seite.waitForFunction(() => ILeenVR.renderer.xr.isPresenting, { timeout: 15000 }).catch(() => {});
  pruefe('1:1-Sitzung läuft', await seite.evaluate(() => ILeenVR.renderer.xr.isPresenting));

  const bilder = n => seite.evaluate(n => new Promise(fertig => {
    const s = ILeenVR.renderer.xr.getSession();
    let rest = n;
    const weiter = () => (--rest <= 0 ? fertig() : s.requestAnimationFrame(weiter));
    s.requestAnimationFrame(weiter);
  }), n);
  await bilder(10);

  const lage = () => seite.evaluate(() => {
    const n = ILeenVR.nutzer;
    const e = n.rotation;
    return { x: n.position.x, y: n.position.y, z: n.position.z, gier: e.y, modus: ILeenVR.zustand.modus };
  });
  const start = await lage();
  pruefe('Start vor der Südseite', start.modus === 'vr' && start.z > modell.max[2] && Math.abs(start.x) < 1e-6,
    JSON.stringify(start));
  pruefe('Kacheln rechnen mit der XR-Kamera', await seite.evaluate(() =>
    ILeenVR.tiles.hasCamera(ILeenVR.renderer.xr.getCamera()) && !ILeenVR.tiles.hasCamera(ILeenVR.kamera)));

  // Abzug rechts, 45° nach unten: trifft den Boden ein paar Meter voraus
  await seite.evaluate(() => {
    const c = __brille.controllers.right;
    const a = -Math.PI / 4;
    c.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2));
    c.updateButtonValue('trigger', 1);
  });
  await bilder(6);
  pruefe('Zielring sichtbar', await seite.evaluate(() =>
    ILeenVR.szene.children.some(o => o.isMesh && o.geometry.type === 'RingGeometry' && o.visible)));
  await seite.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 0));
  await bilder(4);
  const gesprungen = await lage();
  pruefe('Abzug auf den Boden springt nach vorn', gesprungen.z < start.z - 0.5,
    `z ${start.z.toFixed(2)} → ${gesprungen.z.toFixed(2)}`);

  // Linker Stick nach vorn
  await seite.evaluate(() => __brille.controllers.left.updateAxes('thumbstick', 0, -1));
  await bilder(30);
  await seite.evaluate(() => __brille.controllers.left.updateAxes('thumbstick', 0, 0));
  await bilder(2);
  const gegangen = await lage();
  pruefe('Linker Stick geht nach vorn', gegangen.z < gesprungen.z - 0.1,
    `z ${gesprungen.z.toFixed(2)} → ${gegangen.z.toFixed(2)}`);

  // Rechter Stick: ein Schritt nach rechts, gehalten bleibt es einer
  await seite.evaluate(() => __brille.controllers.right.updateAxes('thumbstick', 1, 0));
  await bilder(20);
  await seite.evaluate(() => __brille.controllers.right.updateAxes('thumbstick', 0, 0));
  await bilder(4);
  const gedreht = await lage();
  const grad = (gedreht.gier - gegangen.gier) * 180 / Math.PI;
  pruefe('Rechter Stick dreht genau einen Schritt (−30°)', Math.abs(grad + 30) < 0.5, `${grad.toFixed(2)}°`);

  await seite.evaluate(() => ILeenVR.renderer.xr.getSession().end());
  await seite.waitForFunction(() => !ILeenVR.renderer.xr.isPresenting, { timeout: 10000 }).catch(() => {});
  const zurueck = await seite.evaluate(() => ({
    modus: ILeenVR.zustand.modus, fov: ILeenVR.kamera.fov,
    vorschau: ILeenVR.tiles.hasCamera(ILeenVR.kamera),
  }));
  pruefe('nach dem Absetzen wieder Vorschau', zurueck.modus === 'vorschau' && zurueck.fov === 60, JSON.stringify(zurueck));
  await new Promise(r => setTimeout(r, 300));
  pruefe('Vorschau rechnet wieder mit ihrer Kamera', await seite.evaluate(() => ILeenVR.tiles.hasCamera(ILeenVR.kamera)));

  // ── Tischmodell ───────────────────────────────────────────────
  await seite.click('#vrKnopfTisch');
  await seite.waitForFunction(() => ILeenVR.renderer.xr.isPresenting, { timeout: 15000 }).catch(() => {});
  await bilder(8);
  const tisch = await seite.evaluate(() => {
    const m = ILeenVR.modell;
    const kopf = ILeenVR.kamera.getWorldPosition(m.position.clone());
    return {
      modus: ILeenVR.zustand.modus, massstab: m.scale.x,
      abstand: Math.hypot(m.position.x - kopf.x, m.position.z - kopf.z),
      hoehe: m.position.y, hintergrund: ILeenVR.szene.background,
    };
  });
  pruefe('Tischmodell verkleinert', tisch.modus === 'tisch' && tisch.massstab < 1, JSON.stringify(tisch));
  pruefe('Tischmodell 80 cm vor dem Kopf auf Tischhöhe',
    Math.abs(tisch.abstand - 0.8) < 0.05 && tisch.hoehe > 0.5 && tisch.hoehe < 1.3, JSON.stringify(tisch));
  pruefe('Durchsicht: kein Himmel', tisch.hintergrund === null);
  await seite.evaluate(() => ILeenVR.renderer.xr.getSession().end());
  await seite.waitForFunction(() => !ILeenVR.renderer.xr.isPresenting, { timeout: 10000 }).catch(() => {});
  pruefe('nach dem Tisch wieder 1:1', await seite.evaluate(() => ILeenVR.modell.scale.x === 1));

  // ── Konsole ───────────────────────────────────────────────────
  // Der Emulator meldet sich selbst; das ist kein Fehler der Seite.
  const echte = konsole.filter(t => !/iwer|IWER/.test(t));
  pruefe('keine Fehler in der Konsole', echte.length === 0, echte.slice(0, 5).join('\n      '));
} finally {
  await browser.close();
}

console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
