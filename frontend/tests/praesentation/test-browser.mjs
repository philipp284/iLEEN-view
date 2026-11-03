// Die Präsentation im echten Browser: Chrome headless über puppeteer-core
// (kein Projekt-Dependency — `npm i --no-save puppeteer-core`), gegen einen
// laufenden Dev-Server.
//
// Was hier und NUR hier zu beantworten ist — der Prüfstein ohne Browser
// (test-praesentation.js) rechnet, dieser sieht hin:
//
//   · Das Panel hängt als Untergruppe im Bereich „Ansicht", füllt sich aus dem
//     Zustand und überlebt den Neuaufbau der Leiste.
//   · Die Kamera fährt wirklich: Auto-Play liest die Zeitachse Bild für Bild
//     in die Cesium-Kamera, und am Ende steht sie auf der letzten Folie.
//   · Während der Vorführung treten die Panels zurück; danach sind sie und die
//     Kameraeingaben wieder da. Ein Escape mitten in der Show stellt die
//     Ansicht von vorher wieder her.
//   · Von Hand weiterklicken: → springt zur nächsten Folie.
//   · DAS VIDEO TRÄGT DEN TEXT. Aufgenommen wird der Canvas der Szene, und ein
//     DOM-Label darüber käme nie hinein — der Text muss in den Bildern stehen,
//     die der MediaRecorder bekommt. Gemessen wird der Unterschied zwischen
//     dem aufgenommenen Bild und der nackten Szene im Bereich des Labels.
//
// Aufruf:  npx vite --port 5190 &   VIEWER_URL=http://localhost:5190/ node tests/praesentation/test-browser.mjs
//
// Endung .mjs, weil Prüfsteine mit Browser als Modul laufen. Ein Backend
// braucht der Prüfstein nicht. Nicht Port 5181: dort läuft Philipps Instanz.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5190/';
const BILDER = process.env.BILDER || '/tmp/praesentation-test';
mkdirSync(BILDER, { recursive: true });

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 720 });
const seitenfehler = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => { window._splashDismissed = true; });
await warte(14000);

// ── 1. Modul und Panel ────────────────────────────────────────────────────

console.log('\n1. Modul und Panel');
const geruest = await page.evaluate(() => {
  BimViewerUI.activateSection('view');
  const gruppe = document.getElementById('group-praesentation');
  if (gruppe) gruppe.open = true;
  return {
    modul: !!(window.Praesentation && window.PraesentationText && window.PraesentationPanel),
    viewer: !!(window.BimViewer && window.BimViewer.viewer),
    gruppe: !!gruppe,
    imAnsichtPanel: !!document.querySelector('#section-view #group-praesentation'),
    panel: !!document.getElementById('praesPanel'),
    leerHinweis: document.getElementById('praesLeer') && !document.getElementById('praesLeer').hidden,
    inspektorZu: document.getElementById('praesInspektor') && document.getElementById('praesInspektor').hidden,
    themen: Array.from(document.querySelectorAll('#praesTheme option')).map((o) => o.value).join(),
  };
});
pruefe('Kern, Text und Panel melden sich an', geruest.modul);
pruefe('der Viewer steht', geruest.viewer);
pruefe('die Gruppe hängt im Bereich „Ansicht"', geruest.gruppe && geruest.imAnsichtPanel);
pruefe('ohne Folie steht der Leerhinweis da, der Inspektor ist zu', geruest.leerHinweis && geruest.inspektorZu);
pruefe('alle fünf Boxthemen stehen zur Wahl', geruest.themen === 'glass,solid,outline,bar,plain', geruest.themen);

// ── 2. Drei Folien ────────────────────────────────────────────────────────

console.log('\n2. Folien anlegen und beschriften');
const folien = await page.evaluate(() => {
  const Cesium = window.Cesium, v = BimViewer.viewer, P = window.Praesentation;
  P.leeren();
  v.camera.cancelFlight();
  const stand = (lon, lat, h, heading) => v.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
    orientation: { heading: Cesium.Math.toRadians(heading), pitch: Cesium.Math.toRadians(-35), roll: 0 },
  });
  P.einstellungSetzen('uebergang', 0.6);
  P.einstellungSetzen('halt', 0.6);
  stand(8.2650, 49.9900, 150, 350);
  const a = P.hinzufuegen();
  stand(8.2660, 49.9910, 120, 20);
  const b = P.hinzufuegen();
  stand(8.2670, 49.9920, 90, 80);
  const c = P.hinzufuegen();
  return { ids: [a.id, b.id, c.id], anzahl: P.folien().length,
           karten: document.querySelectorAll('#praesListe .praes-folie').length,
           leerWeg: document.getElementById('praesLeer').hidden,
           inspektorOffen: !document.getElementById('praesInspektor').hidden };
});
pruefe('drei Folien im Zustand', folien.anzahl === 3);
pruefe('drei Karten in der Liste', folien.karten === 3, String(folien.karten));
pruefe('der Leerhinweis ist weg, der Inspektor offen', folien.leerWeg && folien.inspektorOffen);

// Tippen in das Textfeld: es muss den Fokus halten und der Text muss ankommen.
await page.evaluate((id) => Praesentation.waehlen(id, false), folien.ids[0]);
await page.focus('#praesText');
await page.keyboard.type('# Eingang\n- **Nordfassade** prüfen\n- ==Risse== im Putz');
const nachTippen = await page.evaluate(() => ({
  tag: Praesentation.folien()[0].tag,
  fokus: document.activeElement && document.activeElement.id,
  titel: document.querySelector('.praes-folie.is-selected .praes-folie__titel').textContent,
}));
pruefe('der Text kommt in der Folie an', nachTippen.tag.startsWith('# Eingang') && nachTippen.tag.includes('==Risse=='));
pruefe('das Textfeld behält beim Tippen den Fokus', nachTippen.fokus === 'praesText', nachTippen.fokus);
pruefe('die Karte trägt den Titel aus der ersten Zeile', nachTippen.titel === 'Eingang', nachTippen.titel);

await page.evaluate((ids) => {
  Praesentation.textSetzen(ids[1], '## Hof\nSüdseite, *Stützmauer*');
  Praesentation.textSetzen(ids[2], '# Dach\n> Zustand gut');
  ['solid'].forEach((t) => Praesentation.folien().forEach((f) => Praesentation.stilSetzen(f.id, 'theme', t)));
}, folien.ids);

// ── 3. Das Label im Bild ─────────────────────────────────────────────────

console.log('\n3. Das Label über der Szene');
const vorher = await page.evaluate((id) => {
  const v = BimViewer.viewer, Cesium = window.Cesium;
  v.camera.cancelFlight();
  v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(8.3, 50, 4000) });
  Praesentation.waehlen(id);          // fliegt zur Folie und zeigt ihr Label
  const l = document.querySelector('.praes-label');
  const p = Praesentation.folien()[0].pose;
  const c = v.camera.positionWC;
  return {
    da: !!l, bearbeiten: l && l.classList.contains('is-editing'),
    sichtbar: l && getComputedStyle(l).opacity === '1',
    hatText: l && l.innerHTML.includes('Nordfassade') && l.innerHTML.includes('<strong>'),
    markiert: l && l.innerHTML.includes('pmd-mark'),
    theme: l && l.classList.contains('is-theme-solid'),
    abstand: Math.hypot(c.x - p.pos[0], c.y - p.pos[1], c.z - p.pos[2]),
    heading: Cesium.Math.toDegrees(v.camera.heading),
    solldeg: Cesium.Math.toDegrees(p.hpr[0]),
  };
}, folien.ids[0]);
pruefe('das Label liegt im Bild und ist zum Ziehen umrandet', vorher.da && vorher.bearbeiten && vorher.sichtbar);
pruefe('es zeigt den gesetzten Markdown (fett, markiert)', vorher.hatText && vorher.markiert);
pruefe('es trägt das gewählte Boxthema', vorher.theme);
pruefe('Wählen hat die Kamera zur Folie gestellt (< 1 m)', vorher.abstand < 1, `${vorher.abstand.toFixed(2)} m`);
pruefe('mit dem Kurs der Folie', Math.abs(((vorher.heading - vorher.solldeg + 540) % 360) - 180) < 0.05,
  `${vorher.heading} vs ${vorher.solldeg}`);
await warte(1500);
await page.screenshot({ path: join(BILDER, '1-label.png') });

// Ziehen des Labels
const vor = await page.evaluate(() => {
  const r = document.querySelector('.praes-label').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, lage: { ...Praesentation.folien()[0].caption } };
});
await page.mouse.move(vor.x, vor.y);
await page.mouse.down();
await page.mouse.move(vor.x - 160, vor.y - 140, { steps: 6 });
await page.mouse.up();
const nach = await page.evaluate(() => ({ ...Praesentation.folien()[0].caption }));
pruefe('das Label lässt sich an eine andere Stelle ziehen',
  nach.x < vor.lage.x - 0.05 && nach.y < vor.lage.y - 0.05, `${JSON.stringify(vor.lage)} → ${JSON.stringify(nach)}`);
await page.evaluate((id) => Praesentation.lageSetzen(id, 0.5, 0.8), folien.ids[0]);

// 3×3-Raster
await page.click('.praes-raster__zelle[data-rx="0"][data-ry="0"]');
const raster = await page.evaluate(() => ({ ...Praesentation.folien()[0].caption,
  aktiv: document.querySelectorAll('.praes-raster__zelle.is-aktiv').length }));
pruefe('das 3×3-Raster verankert das Label oben links', raster.x === 0.16 && raster.y === 0.17 && raster.aktiv === 1);
await page.evaluate((id) => Praesentation.lageSetzen(id, 0.5, 0.8), folien.ids[0]);

// ── 4. Das Panel überlebt den Neuaufbau der Leiste ──────────────────────────

console.log('\n4. Neuaufbau der Leiste');
const umbau = await page.evaluate(async () => {
  BimViewerUI.gruppeAnmelden('view', { key: 'umbau-probe', ordnung: 99, label: 'Probe', inhalt: '<p>x</p>' });
  await new Promise((r) => setTimeout(r, 400));
  BimViewerUI.activateSection('view');
  const g = document.getElementById('group-praesentation');
  if (g) g.open = true;
  return {
    gruppe: !!g,
    karten: document.querySelectorAll('#praesListe .praes-folie').length,
    gewaehlt: !!document.querySelector('#praesListe .praes-folie.is-selected'),
    text: document.getElementById('praesText') && document.getElementById('praesText').value.startsWith('# Eingang'),
  };
});
pruefe('nach dem Neuaufbau ist die Gruppe wieder da', umbau.gruppe);
pruefe('… die Liste ist aus dem Zustand gefüllt', umbau.karten === 3, String(umbau.karten));
pruefe('… die Auswahl und der Text stehen wieder im Inspektor', umbau.gewaehlt && umbau.text);

// ── 5. Zeitgesteuert ─────────────────────────────────────────────────────

console.log('\n5. Auto-Play');
await page.evaluate(() => {
  const v = BimViewer.viewer;
  window.__probe = [];
  window.__start = v.camera.positionWC.clone();
  Praesentation.waehlen(null, false);
  Praesentation.auto();
  const Cesium = window.Cesium;
  window.__takt = setInterval(() => {
    const l = document.querySelector('.praes-label');
    const tb = document.getElementById('toolbar');
    window.__probe.push({
      modus: Praesentation.zustand().modus,
      ort: v.camera.positionWC.clone(),
      kurs: Cesium.Math.toDegrees(v.camera.heading),
      deckkraft: l ? parseFloat(getComputedStyle(l).opacity) : 0,
      tb: tb ? getComputedStyle(tb).display : 'fehlt',
      klasse: document.body.classList.contains('praes-laeuft'),
      eingaben: v.scene.screenSpaceCameraController.enableInputs,
      leiste: !!document.querySelector('.praes-leiste') && getComputedStyle(document.querySelector('.praes-leiste')).display,
    });
  }, 100);
});
await warte(2500);
await page.screenshot({ path: join(BILDER, '2-auto-mitte.png') });
await page.waitForFunction(() => Praesentation.zustand().modus === 'ruhe', { timeout: 60000 });
const auto = await page.evaluate(() => {
  clearInterval(window.__takt);
  const p = window.__probe;
  const laufend = p.filter((x) => x.modus === 'auto');
  const orte = laufend.map((x) => x.ort);
  const ende = BimViewer.viewer.camera.positionWC;
  const f3 = Praesentation.folien()[2].pose.pos;
  const weg = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return {
    laeuft: laufend.length,
    toolbarWeg: laufend.every((x) => x.tb === 'none'),
    klasse: laufend.every((x) => x.klasse),
    eingabenAus: laufend.every((x) => x.eingaben === false),
    leiste: laufend.some((x) => x.leiste === 'flex'),
    maxDeckkraft: Math.max(...laufend.map((x) => x.deckkraft)),
    bewegt: orte.length > 2 && weg(orte[0], orte[orte.length - 1]) > 20,
    kurse: new Set(laufend.map((x) => Math.round(x.kurs))).size,
    endeAbstand: weg(ende, { x: f3[0], y: f3[1], z: f3[2] }),
    nachherKlasse: document.body.classList.contains('praes-laeuft'),
    nachherToolbar: getComputedStyle(document.getElementById('toolbar')).display,
    nachherEingaben: BimViewer.viewer.scene.screenSpaceCameraController.enableInputs,
    nachherLeiste: getComputedStyle(document.querySelector('.praes-leiste')).display,
  };
});
pruefe('die Vorführung lief (mehrere Bilder gemessen)', auto.laeuft > 5, String(auto.laeuft));
pruefe('die Panels traten zurück (#toolbar ausgeblendet)', auto.toolbarWeg);
pruefe('der body trägt praes-laeuft und die Leiste steht', auto.klasse && auto.leiste);
pruefe('die Kameraeingaben waren gesperrt', auto.eingabenAus);
pruefe('die Kamera ist gefahren (> 20 m)', auto.bewegt);
pruefe('der Kurs hat sich über die Fahrt verändert', auto.kurse > 3, String(auto.kurse));
pruefe('der Text war zeitweise voll eingeblendet', auto.maxDeckkraft > 0.9, String(auto.maxDeckkraft));
pruefe('am Ende steht die Kamera auf der letzten Folie (< 1 m)', auto.endeAbstand < 1, `${auto.endeAbstand.toFixed(2)} m`);
pruefe('danach: Panels, Eingaben und Leiste wie vorher',
  !auto.nachherKlasse && auto.nachherToolbar !== 'none' && auto.nachherEingaben === true && auto.nachherLeiste === 'none');

// ── 6. Von Hand weiterklicken ───────────────────────────────────────────────

console.log('\n6. Präsentieren (von Hand)');
const vorShow = await page.evaluate(async () => {
  const v = BimViewer.viewer, Cesium = window.Cesium;
  v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(8.30, 50.0, 3000) });
  const c = v.camera.positionWC;
  window.__vorShow = { x: c.x, y: c.y, z: c.z };
  await Praesentation.praesentieren(0);   // asynchron: erst die Szene vorbereiten, dann los
  return Praesentation.zustand();
});
pruefe('die Show startet auf der ersten Folie', vorShow.modus === 'manuell' && vorShow.index === 0);
await warte(2500);
await page.keyboard.press('ArrowRight');
await warte(300);
const weiter = await page.evaluate(() => Praesentation.zustand());
pruefe('→ geht zur zweiten Folie', weiter.index === 1, JSON.stringify(weiter));
await page.keyboard.press('ArrowLeft');
await warte(300);
pruefe('← geht zurück', (await page.evaluate(() => Praesentation.zustand().index)) === 0);
await page.keyboard.press('End');
await warte(300);
pruefe('Ende springt auf die letzte Folie', (await page.evaluate(() => Praesentation.zustand().index)) === 2);
const punkte = await page.evaluate(() => document.querySelectorAll('.praes-punkt').length);
pruefe('die Leiste zeigt einen Punkt je Folie', punkte === 3, String(punkte));
await page.screenshot({ path: join(BILDER, '3-show.png') });
await page.keyboard.press('Escape');
await warte(400);
const danach = await page.evaluate(() => {
  const c = BimViewer.viewer.camera.positionWC, v = window.__vorShow;
  return { modus: Praesentation.zustand().modus,
           abstand: Math.hypot(c.x - v.x, c.y - v.y, c.z - v.z),
           klasse: document.body.classList.contains('praes-laeuft'),
           eingaben: BimViewer.viewer.scene.screenSpaceCameraController.enableInputs };
});
pruefe('Escape beendet die Show', danach.modus === 'ruhe' && !danach.klasse && danach.eingaben === true);
pruefe('… und stellt die Ansicht von vorher wieder her (< 1 m)', danach.abstand < 1, `${danach.abstand.toFixed(2)} m`);

// ── 7. Das Video ──────────────────────────────────────────────────────────

console.log('\n7. Video');
await page.evaluate(() => {
  // Den Download abfangen statt auszulösen; die Mischfläche des Rekorders merken.
  window.__blob = null;
  const alt = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { if (b && b.type && b.type.startsWith('video/')) window.__blob = { groesse: b.size, typ: b.type }; return alt(b); };
  const klick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (!this.download) klick.call(this); };
  const cs = HTMLCanvasElement.prototype.captureStream;
  HTMLCanvasElement.prototype.captureStream = function (...a) { window.__mischung = this; return cs.apply(this, a); };
  window.__diff = 0;
  window.__aufnahmeModus = [];

  // Zwei Folien mit Text, damit die Aufnahme eine volle Sekunde Text trägt.
  Praesentation.folien().forEach((f) => Praesentation.haltSetzen(f.id, 1.2));
  Praesentation.einstellungSetzen('uebergang', 0.6);
  Praesentation.video();

  window.__messen = setInterval(() => {
    window.__aufnahmeModus.push(Praesentation.zustand().modus);
    const comp = window.__mischung, quelle = BimViewer.viewer.canvas;
    if (!comp || Praesentation.zustand().modus !== 'aufnahme') return;
    const w = comp.width, h = comp.height;
    // Bereich um die Labellage (0,5 / 0,8): Breite 40 %, Höhe 14 %
    const x = Math.round(w * 0.3), y = Math.round(h * 0.73), bw = Math.round(w * 0.4), bh = Math.round(h * 0.14);
    const a = comp.getContext('2d').getImageData(x, y, bw, bh).data;
    const t = document.createElement('canvas'); t.width = w; t.height = h;
    const tc = t.getContext('2d'); tc.drawImage(quelle, 0, 0, w, h);
    const b = tc.getImageData(x, y, bw, bh).data;
    let summe = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) { summe += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
    window.__diff = Math.max(window.__diff, summe / n);
  }, 80);
});
await warte(1500);
const mitten = await page.evaluate(() => ({
  modus: Praesentation.zustand().modus,
  klasse: document.body.classList.contains('praes-laeuft'),
  domLabel: (() => { const l = document.querySelector('.praes-label'); return l ? parseFloat(getComputedStyle(l).opacity) : 0; })(),
}));
pruefe('während der Aufnahme: Modus „aufnahme", Panels weg', mitten.modus === 'aufnahme' && mitten.klasse);
pruefe('das DOM-Label bleibt dabei aus (das Video trägt sein eigenes)', mitten.domLabel === 0, String(mitten.domLabel));
await page.waitForFunction(() => window.__blob !== null, { timeout: 90000 });
const video = await page.evaluate(() => {
  clearInterval(window.__messen);
  return { blob: window.__blob, diff: window.__diff, modus: Praesentation.zustand().modus,
           klasse: document.body.classList.contains('praes-laeuft') };
});
pruefe('ein Video ist entstanden', video.blob && video.blob.groesse > 1000, JSON.stringify(video.blob));
pruefe('es ist WebM oder MP4', video.blob && /^video\/(webm|mp4)/.test(video.blob.typ), video.blob && video.blob.typ);
pruefe('DER TEXT STEHT IM AUFGENOMMENEN BILD (Unterschied zur nackten Szene)', video.diff > 6, `mittlerer Unterschied ${video.diff.toFixed(1)}`);
pruefe('danach ist die Oberfläche wieder da', video.modus === 'ruhe' && !video.klasse);

// ── 8. Datei und Fehlerfälle ────────────────────────────────────────────────

console.log('\n8. Datei');
const datei = await page.evaluate(() => {
  const text = Praesentation.jsonAusgeben();
  const n = Praesentation.folien().length;
  let abgewiesen = '';
  try { Praesentation.jsonEinlesen(JSON.stringify({ slides: [{ pose: { yaw: 1, pitch: 0, distance: 3, target: [0, 0, 0] } }] })); }
  catch (e) { abgewiesen = e.message; }
  Praesentation.leeren();
  const leer = Praesentation.folien().length;
  Praesentation.jsonEinlesen(text);
  return { n, leer, zurueck: Praesentation.folien().length, abgewiesen,
           karten: document.querySelectorAll('#praesListe .praes-folie').length };
});
pruefe('Sichern → Leeren → Laden bringt das Deck zurück', datei.leer === 0 && datei.zurueck === datei.n);
pruefe('die Liste folgt', datei.karten === datei.n);
pruefe('ein splides-Deck wird mit Begründung abgewiesen', /splides/.test(datei.abgewiesen), datei.abgewiesen);

pruefe('keine Seitenfehler', seitenfehler.length === 0, seitenfehler.join(' | '));

await browser.close();
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
console.log('Bilder:', BILDER);
process.exit(fehler ? 1 : 0);
