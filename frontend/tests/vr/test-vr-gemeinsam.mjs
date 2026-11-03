// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Gemeinsam in der Brille: zwei nachgebildete Quests im selben Raum, dazu ein
// Bildschirm, der zuschaut.
//
// Aufruf:  node tests/vr/test-vr-gemeinsam.mjs
//          VR_JOB=<job-id> node tests/vr/test-vr-gemeinsam.mjs   (sonst das Ifc4-SampleHouse)
//          VIEWER_URL=https://127.0.0.1:5443/ node tests/vr/test-vr-gemeinsam.mjs
//              gegen den laufenden Quest-Dienst und sein Relais (5446) — in einem
//              eigenen Raum pruef-…, die Brillen im Raum „labor" merken nichts davon
//
// Voraussetzung: puppeteer-core, Backend auf 8100, Internet (three.js, IWER).
// Der Prüfstein startet selbst, was er braucht, auf eigenen Ports — der
// laufende Quest-Dienst bleibt unberührt:
//   · das Relais (tools/vr-raum.mjs) auf 5466
//   · einen HTTPS-Vite mit der Quest-Konfiguration (tools/vite-quest.config.js)
//     auf 5467, mit eigenem Zertifikat im Temp-Ordner. Die Seiten verbinden sich
//     also wie in der Brille über wss://…/vr-raum und den Proxy von Vite.
//
// Die Brillen kommen von IWER. IWER legt `local-floor` auf seinen globalen Raum,
// die Controllerposition ist die Strahlspitze. Brille A sieht den Raum, wie er
// ist; Brille B ist um 70° gedreht und um 2,1 m verschoben gestartet — jede
// Pose, die B bekommt, ist dieselbe physische Pose, in B's Rahmen umgerechnet.
// Geprüft wird darum physisch, nicht an der eigenen Rechnung: Hält B ihren
// Controller an dieselbe Stelle wie A, muss A's Avatarhand in B genau dort
// stehen, wo B's eigene Hand ist. Am Tisch: Sitzen beide Köpfe an derselben
// Stelle, muss ein Modellpunkt für beide an derselben Stelle vor dem Kopf liegen.

import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { raumServer } from '../../tools/vr-raum.mjs';
import { lage, lagePunkt, lageInvers, gierQuat, quatMal } from '../../vr-gemeinsam-rechnen.js';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BACKEND = process.env.BACKEND_URL || 'http://localhost:8100';
const IWER = 'https://cdn.jsdelivr.net/npm/iwer@2.6.0/build/iwer.module.js';
const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Gegen einen laufenden Dienst (VIEWER_URL) prüft der Stein dessen Relais auf 5446
const FREMD = process.env.VIEWER_URL || null;
const RAUM_PORT = Number(process.env.RAUM_PORT || (FREMD ? 5446 : 5466));
const VITE_PORT = Number(process.env.VITE_PORT || 5467);
const RAUM = `pruef-${Date.now().toString(36)}`;
const GRAD = Math.PI / 180;

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
}
const ruhe = ms => new Promise(r => setTimeout(r, ms));
const cm = d => `${(d * 100).toFixed(1)} cm`;

// ── B's Rahmen: um 70° gedreht, 2,1 m daneben gestartet ───────────
const TB = lage(2.0, 0, -0.7, 70 * GRAD);
const physB = p => lagePunkt(lageInvers(TB), p);
const quatB = q => quatMal(gierQuat(-TB.gier), q);
const gleich = p => p;
const MARKE = [[0.5, 0.05, 0.3], [3.3, 0.05, 1.6]];

async function jobWaehlen() {
  if (process.env.VR_JOB) return process.env.VR_JOB;
  const assets = await (await fetch(`${BACKEND}/assets/`)).json();
  const ifc = assets.filter(a => a.content_type === 'ifc');
  return (ifc.find(a => /SampleHouse/i.test(a.name)) || ifc[0]).job_id;
}

function bereit(url, ms = 90000) {
  const ende = Date.now() + ms;
  return new Promise((fertig, fehl) => {
    const versuch = () => {
      https.get(url, { rejectUnauthorized: false }, r => { r.resume(); if (r.statusCode === 200) fertig(); else weiter(); })
        .on('error', weiter);
    };
    const weiter = () => (Date.now() > ende ? fehl(new Error(`${url} antwortet nicht`)) : setTimeout(versuch, 500));
    versuch();
  });
}

const job = await jobWaehlen();
console.log(`Modell: ${job} · Raum: ${RAUM}\n`);

// ── Relais und HTTPS-Vite ─────────────────────────────────────────
// Ein frischer Vite bündelt beim ersten Start Cesium vor — unter Last dauert das
// Minuten. Mit VIEWER_URL entfällt beides, der laufende Dienst ist warm.
const relais = FREMD ? null : raumServer({ port: RAUM_PORT, protokoll: () => {} });
if (relais) await relais.bereit;
const tls = mkdtempSync(path.join(os.tmpdir(), 'ileen-gemeinsam-'));
if (!FREMD) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=iLEEN Prüfstein',
  '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', `${tls}/schluessel.pem`, '-out', `${tls}/zertifikat.pem`], { stdio: 'ignore' });
const vite = FREMD ? null : spawn('npx', ['vite', '--config', 'tools/vite-quest.config.js', '--clearScreen', 'false'], {
  cwd: FRONTEND, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  // Eigener Zwischenspeicher: der laufende Quest-Dienst teilt sonst node_modules/.vite
  env: {
    ...process.env, ILEEN_QUEST_TLS: tls, ILEEN_QUEST_INNEN: String(VITE_PORT), ILEEN_VR_RAUM: `http://127.0.0.1:${RAUM_PORT}`,
    ILEEN_VITE_CACHE: path.join(os.tmpdir(), 'ileen-gemeinsam-vite'),
  },
});
let viteFehler = '';
if (vite) vite.stderr.on('data', d => { viteFehler += d; });
const SEITE = FREMD || `https://127.0.0.1:${VITE_PORT}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  acceptInsecureCerts: true,
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=960,640',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

const konsole = [];
async function seiteOeffnen(name) {
  const kontext = await browser.createBrowserContext();
  const seite = await kontext.newPage();
  await seite.setViewport({ width: 960, height: 640 });
  seite.on('console', m => {
    if (m.type() !== 'error' || /iwer|IWER|ileen-quest\.json|error code 404/.test(m.text())) return;
    konsole.push(`${name}: ${m.text()}`);
  });
  seite.on('pageerror', e => konsole.push(`${name} pageerror: ${(e.stack || e.message).split('\n').slice(0, 3).join(' ← ')}`));
  seite.on('error', e => console.log(`      ${name}: Seite abgestürzt — ${e.message}`));
  // Vites HMR lüde die Seiten neu, sobald jemand an einer Datei arbeitet — mitten
  // in der Kalibrierung. Sein Socket (Protokoll vite-hmr/vite-ping) bekommt eine
  // stumme Attrappe: ohne open und close weiß der Client nichts, lädt also nie neu.
  // Nicht über abgefangene Anfragen: damit hingen unter Last Seiten beim Laden.
  await seite.evaluateOnNewDocument(() => {
    const Echt = window.WebSocket;
    function Stumm(url, protokolle) {
      const p = [].concat(protokolle || []);
      if (p.includes('vite-hmr') || p.includes('vite-ping')) {
        return { readyState: 0, url: String(url), addEventListener() {}, removeEventListener() {}, send() {}, close() {} };
      }
      return new Echt(url, protokolle);
    }
    Stumm.prototype = Echt.prototype;
    Object.assign(Stumm, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Stumm;
  });
  seite.on('close', () => console.log(`      ${name}: Seite geschlossen`));
  await seite.goto(`${SEITE}vr.html?job=${encodeURIComponent(job)}&welt=0&raum=${RAUM}`, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await seite.waitForFunction(() => window.ILeenVR && ILeenVR.zustand.ausgerichtet, { timeout: 240000 });
  // Drei Seiten im Software-Renderer: mit einem Drittel der Pixel bleibt der
  // Hauptfaden für die Prüfung frei. Strahlen und Klicks rechnen in CSS-Pixeln.
  await seite.evaluate(() => ILeenVR.renderer.setPixelRatio(0.33));
  return { kontext, seite, name };
}

async function brilleAnstecken(seite) {
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
}

/** Eine physische Pose setzen, im Rahmen der jeweiligen Brille. */
function stellen(seite, rahmen, quat, wer, p, q = [0, 0, 0, 1]) {
  const pp = rahmen(p);
  const qq = quat(q);
  return seite.evaluate((wer, pp, qq) => {
    const d = wer === 'kopf' ? __brille : __brille.controllers[wer];
    d.position.set(...pp);
    d.quaternion.set(...qq);
  }, wer, pp, qq);
}

const bilder = (seite, n) => seite.evaluate(n => new Promise(fertig => {
  const s = ILeenVR.renderer.xr.getSession();
  const raf = s ? cb => s.requestAnimationFrame(cb) : cb => requestAnimationFrame(cb);
  let rest = n;
  const weiter = () => (--rest <= 0 ? fertig() : raf(weiter));
  raf(weiter);
}), n);

async function betreten(seite, knopf) {
  try {
    await seite.waitForFunction(k => !document.getElementById(k).disabled, { timeout: 30000 }, knopf);
  } catch {
    throw new Error(`${knopf} bleibt gesperrt: ${await seite.evaluate(() => JSON.stringify({
      xr: ILeenVR.zustand.xr, ausgerichtet: ILeenVR.zustand.ausgerichtet, tiles: !!ILeenVR.tiles, job: ILeenVR.zustand.job,
      presenting: ILeenVR.renderer.xr.isPresenting, status: document.getElementById('vrStatus').textContent,
    }))}`);
  }
  // Der Software-Renderer zeichnet zwei Quest-3-Augen in voller Auflösung mit
  // 1 Bild/s; ein Fünftel davon reicht für die Prüfung und kostet nichts an der Logik.
  await seite.evaluate(() => ILeenVR.renderer.xr.setFramebufferScaleFactor(0.2));
  await seite.evaluate(k => document.getElementById(k).click(), knopf);
  await seite.waitForFunction(() => ILeenVR.renderer.xr.isPresenting, { timeout: 20000 });
  await bilder(seite, 6);
}

async function verlassen(seite) {
  await seite.evaluate(() => ILeenVR.renderer.xr.getSession().end());
  await seite.waitForFunction(() => !ILeenVR.renderer.xr.isPresenting, { timeout: 10000 });
}

/** Mit der Spitze des rechten Controllers beide Marken messen, wie in der Brille. */
async function kalibrieren(seite, rahmen, quat) {
  // Linke Hand mit dem Tablet zur Seite, der rechte Strahl zeigt nach vorn
  await stellen(seite, rahmen, quat, 'left', [-0.8, 0.8, 0.6], [Math.sin(-Math.PI / 4), 0, 0, Math.cos(-Math.PI / 4)]);
  await seite.evaluate(() => { ILeenVR.tabletDruecken('reiter:gemeinsam'); });
  const gedrueckt = await seite.evaluate(() => ILeenVR.tabletDruecken('gm:kalibrieren'));
  if (!gedrueckt) return 'Knopf Kalibrieren nicht da';
  for (let i = 0; i < 2; i++) {
    await stellen(seite, rahmen, quat, 'right', MARKE[i]);
    await bilder(seite, 3);
    await seite.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 1));
    try {
      await seite.waitForFunction(i => {
        const g = ILeenVR.gemeinsam.zustand;
        return i === 0 ? !!g.messen && g.messen.punkte.length === 1 && !g.messen.probe : !!g.kalib;
      }, { timeout: 20000 }, i);
    } catch {
      return seite.evaluate(() => JSON.stringify(ILeenVR.gemeinsam.zustand.messen && { ...ILeenVR.gemeinsam.zustand.messen, probe: null }));
    }
    await seite.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 0));
    await bilder(seite, 3);
  }
  return null;
}

/**
 * Stellen auf der Leinwand, an denen ein Klick ein Bauteil trifft — und nicht
 * die Box „Brille verbinden", die am Mac über der Bildmitte liegt.
 */
const freieStellen = seite => seite.evaluate(() => {
  const V = ILeenVR;
  const el = V.renderer.domElement;
  const r = el.getBoundingClientRect();
  const rc = new V.THREE.Raycaster();
  const out = [];
  // Grob und von der Mitte nach außen: jeder Strahl läuft durch alle Dreiecke der Kacheln
  const reihen = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
  for (const fy of reihen) {
    for (const fx of reihen) {
      if (out.length >= 10) return out;
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      if (document.elementFromPoint(x, y) !== el) continue;
      rc.setFromCamera(new V.THREE.Vector2(fx * 2 - 1, 1 - fy * 2), V.kamera);
      const t = rc.intersectObject(V.tiles.group, true)[0];
      if (t && t.object.geometry.getAttribute('_batchid')) out.push([x, y]);
    }
  }
  return out;
});

async function aufsModell(seite, fertig) {
  for (const [x, y] of (await freieStellen(seite)).slice(0, 10)) {
    await seite.mouse.click(x, y);
    await new Promise(z => setTimeout(z, 150));
    if (await fertig()) return true;
  }
  return false;
}

/** In B: Abstand von A's Avatarhand (rechts) zu B's eigener rechter Hand — und der Geist. */
const handVergleich = (seite, id) => seite.evaluate(id => {
  const V = ILeenVR;
  const t = V.gemeinsam.zustand.teilnehmer.get(id);
  const rechts = V.haende.find(h => h.quelle && h.quelle.handedness === 'right' && h.quelle.targetRayMode === 'tracked-pointer');
  const eigen = rechts.griff.getWorldPosition(new V.THREE.Vector3());
  const figur = t && t.figur && t.figur.gruppe.visible ? t.figur.haende[1].position.distanceTo(eigen) : null;
  const geist = t && t.geist && t.geist.gruppe.visible ? t.geist.haende[1].position.distanceTo(eigen) : null;
  return { figur, geist, nutzer: V.nutzer.position.toArray() };
}, id);

const brillen = [];
try {
  await bereit(`${SEITE}vr.html`);
  const A = await seiteOeffnen('A');
  const B = await seiteOeffnen('B');
  const C = await seiteOeffnen('Bildschirm');
  brillen.push(A, B, C);
  const a = A.seite;
  const b = B.seite;
  const c = C.seite;

  // ── Verbinden ──────────────────────────────────────────────────
  await brilleAnstecken(a);
  await brilleAnstecken(b);
  for (const s of [a, b, c]) {
    await s.waitForFunction(() => ILeenVR.gemeinsam.zustand.verbindung === 'offen' && ILeenVR.gemeinsam.zustand.teilnehmer.size === 2, { timeout: 30000 }).catch(() => {});
  }
  const kennungen = await Promise.all([a, b, c].map(s => s.evaluate(() => ({
    id: ILeenVR.gemeinsam.ich.id, geraet: ILeenVR.gemeinsam.ich.geraet, verbindung: ILeenVR.gemeinsam.zustand.verbindung,
    anzahl: ILeenVR.gemeinsam.zustand.teilnehmer.size, name: ILeenVR.app.gemeinsam.ich.name,
  }))));
  const [ka, kb, kc] = kennungen;
  pruefe('alle drei über wss und den Proxy von Vite verbunden', kennungen.every(k => k.verbindung === 'offen'), JSON.stringify(kennungen));
  pruefe('jeder sieht die beiden anderen', kennungen.every(k => k.anzahl === 2), kennungen.map(k => k.anzahl).join(','));
  pruefe('zwei Brillen und ein Bildschirm', ka.geraet === 'brille' && kb.geraet === 'brille' && kc.geraet === 'bildschirm', JSON.stringify(kennungen));
  // (A und B waren vor IWER kurz Bildschirme — darum hat der echte Bildschirm hier eine höhere Nummer)
  pruefe('Namen: zwei Brillen mit Nummer, ein Bildschirm', new Set([ka.name, kb.name]).size === 2 && /^Brille \d$/.test(ka.name) && /^Brille \d$/.test(kb.name) && /^Bildschirm \d$/.test(kc.name),
    kennungen.map(k => k.name).join(', '));
  const stand = await (await fetch(`http://127.0.0.1:${RAUM_PORT}/vr-raum/stand`)).json();
  const imRaum = stand.raeume.find(r => r.name === RAUM);
  pruefe('Relais: drei im Prüfraum, Modell gemeldet', imRaum && imRaum.teilnehmer.length === 3 && imRaum.zustand.modell, JSON.stringify(imRaum));

  // ── Der Bildschirm zeigt den Brillen ein Bauteil ───────────────
  await c.waitForFunction(() => ILeenVR.tiles.loadProgress >= 1, { timeout: 90000 }).catch(() => {});
  // Am Mac liegt die Box „Brille verbinden" über der Szene; geprüft wird hier das
  // Teilen der Auswahl, nicht die Anordnung — für den Klick weg damit.
  await c.evaluate(() => { document.querySelector('.vr-start').style.visibility = 'hidden'; });
  await aufsModell(c, () => c.evaluate(() => !!(ILeenVR.auswahl && ILeenVR.auswahl.guid)));
  await c.evaluate(() => { document.querySelector('.vr-start').style.visibility = ''; });
  const guid = await c.evaluate(() => ILeenVR.auswahl && ILeenVR.auswahl.guid);
  pruefe('Bildschirm wählt ein Bauteil', !!guid);
  await a.waitForFunction(id => {
    const t = ILeenVR.gemeinsam.zustand.teilnehmer.get(id);
    return t && t.auswahlNetze.length > 0 && !!t.auswahlSchild;
  }, { timeout: 20000 }, kc.id).catch(() => {});
  const markA = await a.evaluate(id => {
    const t = ILeenVR.gemeinsam.zustand.teilnehmer.get(id);
    return { netze: t.auswahlNetze.length, schild: !!t.auswahlSchild, farbe: t.auswahlStoff && '#' + t.auswahlStoff.color.getHexString(), guid: t.info.auswahl && t.info.auswahl.guid };
  }, kc.id);
  const farbeC = await c.evaluate(() => ILeenVR.app.gemeinsam.ich.farbe);
  pruefe('Brille sieht das Bauteil des Bildschirms hervorgehoben, in dessen Farbe, mit Schild',
    markA.netze > 0 && markA.schild && markA.farbe === farbeC && markA.guid === guid, JSON.stringify({ ...markA, farbeC }));

  // ── Messung von A sieht B ──────────────────────────────────────
  await a.evaluate(() => { ILeenVR.tabletDruecken('reiter:werkzeuge'); ILeenVR.tabletDruecken('wz:messen'); });
  const stellenA = await freieStellen(a);
  for (const [x, y] of [stellenA[0], stellenA[stellenA.length - 1]].filter(Boolean)) {
    await a.mouse.click(x, y);
    await ruhe(150);
  }
  const punkteA = await a.evaluate(() => ILeenVR.werkzeug.punkte.length);
  await b.waitForFunction(id => {
    const t = ILeenVR.gemeinsam.zustand.teilnehmer.get(id);
    return t && t.messung && t.messung.kugeln.length === 2;
  }, { timeout: 15000 }, ka.id).catch(() => {});
  const messB = await b.evaluate(id => {
    const t = ILeenVR.gemeinsam.zustand.teilnehmer.get(id);
    return t && t.messung ? { kugeln: t.messung.kugeln.length, schild: !!t.messung.schild, text: t.messung.schild && t.messung.schild.text } : null;
  }, ka.id);
  pruefe('Messung mit zwei Punkten erscheint bei B, mit Strecke', punkteA === 2 && messB && messB.kugeln === 2 && messB.schild, JSON.stringify({ punkteA, messB }));
  await a.evaluate(() => ILeenVR.tabletDruecken('wz:messen'));
  await b.waitForFunction(id => !ILeenVR.gemeinsam.zustand.teilnehmer.get(id).messung, { timeout: 10000 }, ka.id).catch(() => {});
  pruefe('Messen aus: bei B wieder weg', await b.evaluate(id => !ILeenVR.gemeinsam.zustand.teilnehmer.get(id).messung, ka.id));

  // ── Ansicht: A blendet eine Klasse aus ─────────────────────────
  const typ = await a.evaluate(() => {
    ILeenVR.tabletDruecken('reiter:ebenen');
    const k = ILeenVR.ebenen.klassen().map(x => x.schluessel).find(Boolean);
    ILeenVR.tabletDruecken(`ebene:klassen:${k}`);
    return k;
  });
  await b.waitForFunction(t => ILeenVR.ebenen.filter.klassen.has(t), { timeout: 10000 }, typ).catch(() => {});
  pruefe(`Ansicht geteilt: ${typ} ist auch bei B und am Bildschirm aus`,
    await b.evaluate(t => ILeenVR.ebenen.filter.klassen.has(t), typ) && await c.evaluate(t => ILeenVR.ebenen.filter.klassen.has(t), typ));
  await a.evaluate(() => ILeenVR.tabletDruecken('ebenen:an'));
  await b.waitForFunction(() => ILeenVR.ebenen.filter.klassen.size === 0, { timeout: 10000 }).catch(() => {});
  pruefe('Alle an: bei B wieder alles da', await b.evaluate(() => ILeenVR.ebenen.filter.klassen.size === 0));

  // Die Kamera des Bildschirms steht schon in der Vorschau bei den Brillen
  await a.waitForFunction(id => {
    const t = ILeenVR.gemeinsam.zustand.teilnehmer.get(id);
    return !!(t && t.figur && t.figur.gruppe.visible);
  }, { timeout: 15000 }, kc.id).catch(() => {});
  pruefe('A sieht die Kamera des Bildschirms (Pyramide, kein Rumpf)', await a.evaluate(id => {
    const t = ILeenVR.gemeinsam.zustand.teilnehmer.get(id);
    return !!(t && t.figur && t.figur.gruppe.visible && !t.figur.rumpf);
  }, kc.id));

  // Der Bildschirm hat seine Rolle gespielt: drei Software-Renderer trügen die
  // XR-Phase nicht. Er geht — die Brillen müssen ihn aus der Liste nehmen.
  await C.kontext.close();
  brillen.pop();
  await a.waitForFunction(id => !ILeenVR.gemeinsam.zustand.teilnehmer.has(id), { timeout: 30000 }, kc.id).catch(() => {});
  pruefe('Bildschirm geht: bei A aus der Liste, seine Kamera ist weg', await a.evaluate(id => {
    const g = ILeenVR.gemeinsam;
    const teile = [...g.zustand.teilnehmer.values()].reduce((n, t) => n + (t.figur ? 1 : 0) + (t.geist ? 1 : 0), 0);
    return !g.zustand.teilnehmer.has(id) && g.weltGruppe.children.length === teile;
  }, kc.id));

  // ── 1:1, beide kalibrieren ─────────────────────────────────────
  await betreten(a, 'vrKnopfVR');
  await betreten(b, 'vrKnopfVR');
  const fa = await kalibrieren(a, gleich, q => q);
  pruefe('A kalibriert', fa === null, fa);
  const fb = await kalibrieren(b, physB, quatB);
  pruefe('B kalibriert (anderer Rahmen, dieselben Marken)', fb === null, fb);
  const kal = await Promise.all([a, b].map(s => s.evaluate(() => {
    const g = ILeenVR.gemeinsam.zustand;
    return g.kalib && { abstand: g.kalib.abstand, vergleich: ILeenVR.app.gemeinsam.kalib.vergleich };
  })));
  pruefe('beide messen denselben Abstand der Marken (2,94 m)', kal.every(k => k && Math.abs(k.abstand - Math.hypot(2.8, 1.3)) < 0.01), JSON.stringify(kal));
  pruefe('Vergleich: passt', kal[1] && kal[1].vergleich && kal[1].vergleich.passt, JSON.stringify(kal[1]));
  pruefe('B geht mit der Gruppe', await b.evaluate(() => ILeenVR.app.gemeinsam.gekoppelt));

  // Beide Controller und beide Köpfe an dieselben Stellen des Raumes
  const HAND = [1.2, 1.1, 0.9];
  const QHAND = gierQuat(30 * GRAD);
  const KOPF = [0.8, 1.65, 1.6];
  const QKOPF = gierQuat(-20 * GRAD);
  const physischStellen = async () => {
    await stellen(a, gleich, q => q, 'right', HAND, QHAND);
    await stellen(b, physB, quatB, 'right', HAND, QHAND);
    await stellen(a, gleich, q => q, 'kopf', KOPF, QKOPF);
    await stellen(b, physB, quatB, 'kopf', KOPF, QKOPF);
  };
  await physischStellen();
  await ruhe(900);
  const v1 = await handVergleich(b, ka.id);
  pruefe(`A's Hand steht bei B, wo B's eigene Hand an derselben Raumstelle ist (${v1.figur === null ? '–' : cm(v1.figur)})`,
    v1.figur !== null && v1.figur < 0.01, JSON.stringify(v1));
  const kopf = await b.evaluate(id => {
    const V = ILeenVR;
    const t = V.gemeinsam.zustand.teilnehmer.get(id);
    return t.figur.kopf.position.distanceTo(V.kamera.getWorldPosition(new V.THREE.Vector3()));
  }, ka.id);
  pruefe(`A's Kopf steht bei B, wo B's Kopf an derselben Raumstelle ist (${cm(kopf)})`, kopf < 0.01, kopf);
  pruefe('mitgehen: kein Geist neben dem Avatar', v1.geist === null, JSON.stringify(v1));

  // A geht mit dem Stick: B geht mit, die Hände bleiben deckungsgleich
  await a.evaluate(() => __brille.controllers.left.updateAxes('thumbstick', 0, -1));
  await bilder(a, 25);
  await a.evaluate(() => __brille.controllers.left.updateAxes('thumbstick', 0, 0));
  await ruhe(1200);
  const v2 = await handVergleich(b, ka.id);
  const weg = Math.hypot(v2.nutzer[0] - v1.nutzer[0], v2.nutzer[2] - v1.nutzer[2]);
  pruefe(`A geht 'vor' — B geht mit (${weg.toFixed(2)} m)`, weg > 0.3, JSON.stringify([v1.nutzer, v2.nutzer]));
  pruefe(`danach noch deckungsgleich (${v2.figur === null ? '–' : cm(v2.figur)})`, v2.figur !== null && v2.figur < 0.015, JSON.stringify(v2));

  // A dreht in einem Schritt: auch das nimmt B mit
  await a.evaluate(() => __brille.controllers.right.updateAxes('thumbstick', 1, 0));
  await bilder(a, 10);
  await a.evaluate(() => __brille.controllers.right.updateAxes('thumbstick', 0, 0));
  await stellen(a, gleich, q => q, 'right', HAND, QHAND);
  await ruhe(1200);
  const v3 = await handVergleich(b, ka.id);
  pruefe(`nach A's Drehschritt noch deckungsgleich (${v3.figur === null ? '–' : cm(v3.figur)})`, v3.figur !== null && v3.figur < 0.015, JSON.stringify(v3));

  // Zeigen: Abzug gehalten (Strahl nach oben, kein Sprung) — B sieht den Strahl
  await stellen(a, gleich, q => q, 'right', HAND, [Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)]);
  await a.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 1));
  await ruhe(600);
  const strahl = await b.evaluate(id => {
    const t = ILeenVR.gemeinsam.zustand.teilnehmer.get(id);
    return t.figur.strahlen[1].gruppe.visible;
  }, ka.id);
  pruefe('A hält den Abzug: B sieht A\'s Zeigestrahl', strahl);
  await a.evaluate(() => __brille.controllers.right.updateButtonValue('trigger', 0));
  await stellen(a, gleich, q => q, 'right', HAND, QHAND);
  await ruhe(500);

  // Mitgehen aus: B bleibt stehen, A geht — A's Avatar wandert, der Geist bleibt bei B's Hand
  await b.evaluate(() => { ILeenVR.tabletDruecken('reiter:gemeinsam'); ILeenVR.tabletDruecken('gm:mitgehen'); });
  await a.evaluate(() => __brille.controllers.left.updateAxes('thumbstick', 0, -1));
  await bilder(a, 25);
  await a.evaluate(() => __brille.controllers.left.updateAxes('thumbstick', 0, 0));
  await ruhe(1200);
  const v4 = await handVergleich(b, ka.id);
  pruefe(`Mitgehen aus: A's Avatar ist woanders (${v4.figur === null ? '–' : cm(v4.figur)})`, v4.figur !== null && v4.figur > 0.3, JSON.stringify(v4));
  pruefe(`… und der Geist zeigt, wo A wirklich steht (${v4.geist === null ? '–' : cm(v4.geist)})`, v4.geist !== null && v4.geist < 0.01, JSON.stringify(v4));
  await b.evaluate(() => ILeenVR.tabletDruecken('gm:mitgehen'));
  await ruhe(1000);
  const v5 = await handVergleich(b, ka.id);
  pruefe(`Mitgehen wieder an: B springt zur Gruppe, deckungsgleich (${v5.figur === null ? '–' : cm(v5.figur)})`, v5.figur !== null && v5.figur < 0.015, JSON.stringify(v5));

  // Neu ausrichten (Oculus-Taste): die Kalibrierung gilt nicht mehr
  await b.evaluate(() => __brille.recenter());
  await bilder(b, 4);
  pruefe('B neu ausgerichtet: Kalibrierung verworfen', await b.evaluate(() => !ILeenVR.gemeinsam.zustand.kalib));

  await verlassen(a);
  await verlassen(b);
  pruefe('Sitzung zu Ende: A nicht mehr kalibriert', await a.evaluate(() => !ILeenVR.gemeinsam.zustand.kalib));

  // ── Tischmodell ────────────────────────────────────────────────
  await stellen(a, gleich, q => q, 'kopf', [0, 1.6, 0]);
  await stellen(b, physB, quatB, 'kopf', [0, 1.6, 0]);
  await betreten(a, 'vrKnopfTisch');
  await betreten(b, 'vrKnopfTisch');
  await bilder(a, 4);
  await bilder(b, 4);
  const ta = await kalibrieren(a, gleich, q => q);
  const tb = await kalibrieren(b, physB, quatB);
  pruefe('am Tisch: beide kalibriert', ta === null && tb === null, `${ta} ${tb}`);
  await physischStellen();
  await ruhe(800);
  /** Ein Punkt des Modells, gesehen vom Kopf aus — für beide gleich, wenn der Tisch für beide am selben Fleck steht. */
  const vomKopf = s => s.evaluate(() => {
    const V = ILeenVR;
    const k = V.zustand.kasten;
    const q = new V.THREE.Vector3((k.max.x) * 0.6, k.max.y, (k.min.z) * 0.6);
    V.modell.updateMatrixWorld();
    V.kamera.updateWorldMatrix(true, false);
    return V.kamera.worldToLocal(V.modell.localToWorld(q)).toArray();
  });
  const abstandP = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const t1 = [await vomKopf(a), await vomKopf(b)];
  pruefe(`Tisch steht für beide am selben Fleck (${cm(abstandP(...t1))})`, abstandP(...t1) < 0.01, JSON.stringify(t1));

  // A greift das Modell und zieht es 30 cm zur Seite
  await a.evaluate(() => __brille.controllers.right.updateButtonValue('squeeze', 1));
  await bilder(a, 3);
  for (let i = 1; i <= 6; i++) {
    await stellen(a, gleich, q => q, 'right', [HAND[0] + 0.05 * i, HAND[1], HAND[2]], QHAND);
    await bilder(a, 2);
  }
  await a.evaluate(() => __brille.controllers.right.updateButtonValue('squeeze', 0));
  await stellen(a, gleich, q => q, 'right', HAND, QHAND);
  await ruhe(1000);
  const t2 = [await vomKopf(a), await vomKopf(b)];
  pruefe(`A hat den Tisch verschoben (${cm(abstandP(t1[0], t2[0]))})`, abstandP(t1[0], t2[0]) > 0.2, JSON.stringify([t1[0], t2[0]]));
  pruefe(`B sieht ihn am neuen Fleck (${cm(abstandP(...t2))})`, abstandP(...t2) < 0.01, JSON.stringify(t2));
  const v6 = await handVergleich(b, ka.id);
  pruefe(`am Tisch: A's Hand bei B's Hand (${v6.figur === null ? '–' : cm(v6.figur)})`, v6.figur !== null && v6.figur < 0.01, JSON.stringify(v6));

  // ── A geht ─────────────────────────────────────────────────────
  await verlassen(a);
  await A.kontext.close();
  brillen.shift();
  await b.waitForFunction(id => !ILeenVR.gemeinsam.zustand.teilnehmer.has(id), { timeout: 15000 }, ka.id).catch(() => {});
  const nachher = await b.evaluate(() => ({
    anzahl: ILeenVR.gemeinsam.zustand.teilnehmer.size,
    figuren: ILeenVR.gemeinsam.weltGruppe.children.filter(o => o.visible).length,
  }));
  pruefe('A schließt: B ist allein, A\'s Avatar ist weg', nachher.anzahl === 0 && nachher.figuren === 0, JSON.stringify(nachher));

  const echte = konsole.filter(t => !/WebSocket connection to .*vr-raum.* failed/.test(t));
  pruefe('keine Fehler in der Konsole', echte.length === 0, echte.slice(0, 6).join('\n      '));
} catch (e) {
  fehler++;
  console.log(`✗ abgebrochen: ${e.stack || e.message}`);
  if (viteFehler) console.log(`      Vite: ${viteFehler.slice(-600)}`);
  if (konsole.length) console.log(`      Konsole:\n      ${konsole.slice(0, 8).join('\n      ')}`);
} finally {
  await browser.close();
  if (vite) try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* schon weg */ }
  if (relais) await relais.schliessen();
  rmSync(tls, { recursive: true, force: true });
}

console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
