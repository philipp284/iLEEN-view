// Tastenkürzel, Vorlagen, Nutzungsprotokoll — und die Raumkörper, die mit dem
// Modell und der Explosion mitgehen. Im laufenden Viewer (Chrome headless).
//
//   VIEWER_URL=http://localhost:5190/ MODELL=bf9da2a7-bf46-4add-ae3a-426cbe9153c4 \
//     node tests/tasten/browser.mjs [ordner]
//
// Anfragen an /nutzung/* werden abgefangen: weder Testvorlagen noch
// Testereignisse landen im echten Protokoll.
//
// Die Lage der Räume wird nicht gegen die eigene Rechnung geprüft, sondern
// gegen das Modell: ein Strahl aus der Raummitte senkrecht nach unten muss
// den Fußboden des Modells nach etwa einer halben Raumhöhe treffen. Vor dem
// 2026-10-19 schwebten die Räume beim HSM-Campus 16,28 m über dem Bau — der
// Strahl lief dann durch die Luft bis aufs Dach eines tieferen Geschosses.
import puppeteer from 'puppeteer-core';
import path from 'path';
import { fileURLToPath } from 'url';

const hier = path.dirname(fileURLToPath(import.meta.url));
const ORDNER = process.argv[2] || hier;
const URL = process.env.VIEWER_URL || 'http://localhost:5190/';
const MODELL = process.env.MODELL || 'bf9da2a7-bf46-4add-ae3a-426cbe9153c4';
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 900 });
const seitenfehler = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|404|Failed to load resource|ion|token|net::/i.test(m.text())) seitenfehler.push(m.text());
});

// ── /nutzung/* abfangen ──────────────────────────────────────────────────
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
               'Access-Control-Allow-Headers': 'Content-Type' };
const abgefangen = { ereignisse: [], vorlagenPut: [] };
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (!u.includes('/nutzung/')) return req.continue();
  if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
  const antwort = (body) => req.respond({ status: 200, contentType: 'application/json', headers: CORS, body });
  if (u.includes('/nutzung/ereignisse')) {
    try { abgefangen.ereignisse.push(...JSON.parse(req.postData()).ereignisse); } catch (_) { /* leer */ }
    return antwort('{"geschrieben":0}');
  }
  if (u.includes('/nutzung/vorlagen')) {
    if (req.method() === 'PUT') { try { abgefangen.vorlagenPut.push(JSON.parse(req.postData())); } catch (_) { /* leer */ } }
    return antwort('{"stand":null,"vorlagen":[]}');
  }
  if (u.includes('/nutzung/zuletzt')) return antwort('{"modelle":[]}');
  return antwort('{}');
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
// Port 5181 kann auch einem anderen Projekt gehören (strictPort) — erst prüfen, wer antwortet.
pruefe('iLEEN antwortet', /ileen/i.test(await page.title()), await page.title());
await page.waitForFunction(() => !!(window.BimViewer?.viewer && BimViewer.Tasten && BimViewer.Vorlagen &&
                                    BimViewer.Nutzung && window.RoomConcept && window.BimViewerUI),
                           { timeout: 60000 });
await warte(2500);

const taste = async (k, shift = false) => {
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(k);
  if (shift) await page.keyboard.up('Shift');
  await warte(250);
};
const schild = () => page.evaluate(() => document.getElementById('tastenSchild')?.textContent || '');
const bild = async (name) => page.screenshot({ path: path.join(ORDNER, name) });
const bilder = async (n = 3) => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) {
    BimViewer.viewer.scene.requestRender();
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
}, n);

// ── Modell laden ────────────────────────────────────────────────────────
console.log('\n── Modell ──');
await page.evaluate((jobId) => BimViewer.loadBackendAsset(jobId, 'HSMAINZ_CAMPUS_IFC_Raeume_TGA.ifc'), MODELL);
await page.waitForFunction(() => [...BimViewer.loadedAssets.values()].some((a) => a.jobId && a.tileset && a.tileset.root),
                           { timeout: 120000 });
await warte(3000);
const geladen = await page.evaluate((jobId) => ({
  zuletzt: BimViewer.Nutzung.zuletztGeladen(jobId),
  ereignis: BimViewer.Nutzung._schlange().find((e) => e.art === 'modell_geladen'),
}), MODELL);
pruefe('Laden protokolliert, mit Ladezeit und ok', !!geladen.ereignis && geladen.ereignis.daten.ok === true &&
       geladen.ereignis.daten.jobId === MODELL && geladen.ereignis.daten.ms > 0, JSON.stringify(geladen.ereignis));
pruefe('als zuletzt geladen gemerkt', geladen.zuletzt > 0);

// ── R: Räume ────────────────────────────────────────────────────────────
console.log('\n── R: Räume ──');
await taste('r');
await page.waitForFunction(() => RoomConcept.sichtbar && RoomConcept._intern.KOERPER.bereit(), { timeout: 180000 });
await warte(1500);
const r1 = await page.evaluate(() => ({
  raeume: RoomConcept.raeume.length,
  ebenen: [...RoomConcept._intern.KOERPER.ebenen.keys()],
  bereich: document.querySelector('.activity-btn.active')?.dataset.section,
  gruppeOffen: !!document.getElementById('group-rooms')?.open,
}));
pruefe('R liest ein und zeigt die Räume', r1.raeume > 0, JSON.stringify(r1));
pruefe('je Geschoss ein Primitive', r1.ebenen.length > 1, r1.ebenen.join(', '));
pruefe('R öffnet Bauteile › Räume', r1.bereich === 'ifc' && r1.gruppeOffen, JSON.stringify(r1));

// Gesamtbild schräg von oben
await page.evaluate(() => {
  const ts = RoomConcept._intern.aktivesTileset();
  const k = ts.boundingSphere;
  BimViewer.viewer.camera.flyToBoundingSphere(k, { duration: 0,
    offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(35), Cesium.Math.toRadians(-28), k.radius * 1.9) });
});
await warte(4000);

/** Je Raum ein Strahl aus der Mitte nach unten: wie weit bis zum Modell? */
const lot = () => page.evaluate(() => {
  const K = RoomConcept._intern.KOERPER;
  const szene = BimViewer.viewer.scene;
  const ausnahmen = [];
  for (const e of K.ebenen.values()) ausnahmen.push(e.flaechen, e.kanten);
  const grosse = RoomConcept.raeume.filter((r) => K.daten.has(String(r.guid)) && r.box)
    .sort((a, b) => (b.flaeche || 0) - (a.flaeche || 0)).slice(0, 14);
  const aus = [];
  for (const r of grosse) {
    const d = K.daten.get(String(r.guid));
    const mitte = K.weltpunkt(r.guid, d.mitte);
    const unten = Cesium.Cartesian3.negate(Cesium.Cartesian3.normalize(mitte, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    let treffer = null;
    try { treffer = szene.pickFromRay(new Cesium.Ray(mitte, unten), ausnahmen); } catch (_) { treffer = null; }
    if (!treffer || !treffer.position) continue;
    const abstand = Cesium.Cartesian3.distance(mitte, treffer.position);
    const halbeHoehe = (r.box.hi[2] - r.box.lo[2]) / 2;
    // In der Explosion: Liegt der getroffene Fußboden im IFC beim Geschoss
    // darunter (die Decke über dem EG gehört oft zum EG), fliegt er mit
    // diesem — genau wie die Wände. Synchron heißt dann: die Lücke ist der
    // Rangunterschied mal Abstand, nicht null.
    const E = BimViewer.Explosion;
    const ts = treffer.object && (treffer.object.tileset || treffer.object.primitive);
    const rangTreffer = ts && Number.isFinite(ts._explosionRang) ? ts._explosionRang : 0;
    const lage = E.aktiv ? E.lageFuer(K.tileset, r.geschoss, K.ebenen.get(K.daten.get(String(r.guid)).ebene).hoehe) : null;
    const rangRaum = lage ? lage.rang : 0;
    const soll = E.aktiv ? (rangRaum - rangTreffer) * E.abstand : 0;
    aus.push({ name: r.nr + ' ' + r.name, geschoss: r.geschoss, luecke: +(abstand - halbeHoehe).toFixed(2),
               rest: +(abstand - halbeHoehe - soll).toFixed(2), rangRaum, rangTreffer });
  }
  return aus;
});

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const lot1 = await lot();
const l1 = median(lot1.map((x) => x.luecke));
console.log('  Lücke Raumboden → Modell (m):', lot1.map((x) => x.luecke).join(' '));
pruefe('Räume sitzen auf dem Modell (Median Lücke < 0,5 m)', lot1.length >= 5 && Math.abs(l1) < 0.5,
       `${lot1.length} Strahlen, Median ${l1}`);
await bild('tasten-1-raeume.png');

// ── X: Explosion — die Räume fliegen mit ────────────────────────────────
console.log('\n── X: Explosion ──');
await taste('x');
await page.waitForFunction(() => BimViewer.Explosion.aktiv &&
  (BimViewer.Explosion.klonZiele.length || BimViewer.Explosion.ziele.length), { timeout: 180000 });
await warte(8000);
await bilder();
const x1 = await page.evaluate(() => {
  const E = BimViewer.Explosion;
  const K = RoomConcept._intern.KOERPER;
  const ts = K.tileset;
  const aus = [];
  for (const eb of K.ebenen.values()) {
    const lage = E.lageFuer(ts, eb.name, eb.hoehe);
    const guid = [...K.daten.entries()].find(([, d]) => d.ebene === eb.name)?.[0];
    const d = K.daten.get(guid);
    const hub = Cesium.Cartesian3.distance(K.weltpunkt(guid, d.mitte), d.mitte);
    aus.push({ name: eb.name, rang: lage && lage.rang, soll: lage ? lage.hub : 0, ist: +hub.toFixed(3) });
  }
  return { weg: E.klonZiele.length ? 'Klone' : 'Shader', abstand: E.abstand, ebenen: aus,
           bereich: document.querySelector('.activity-btn.active')?.dataset.section,
           gruppe: !!document.getElementById('group-explosion')?.open };
});
console.log('  ' + x1.weg + ':', x1.ebenen.map((e) => `${e.name}→${e.rang}:${e.ist}`).join('  '));
pruefe('X öffnet Ansicht › Explosion', x1.bereich === 'view' && x1.gruppe, JSON.stringify({ b: x1.bereich, g: x1.gruppe }));
pruefe('jedes Geschoss der Räume um seinen Hub gehoben', x1.ebenen.every((e) => Math.abs(e.ist - e.soll) < 0.01),
       JSON.stringify(x1.ebenen));
pruefe('mindestens zwei Ränge', new Set(x1.ebenen.map((e) => e.rang)).size > 1);
pruefe('Schild: Explosion an', /Explosion/.test(await schild()) && /an/.test(await schild()), await schild());
const lot2 = await lot();
console.log('  explodiert, Lücke (m) [Rang Raum/Treffer]:',
            lot2.map((x) => `${x.luecke}[${x.rangRaum}/${x.rangTreffer}]`).join(' '));
// Die Klone laden ihre Kacheln aus der Ferne gröber; fehlt eine, läuft der
// Strahl bis zum nächsten Geschoss durch. Am 2026-10-19 nachgesehen (h1.01,
// Kamera nah, 20 s): getroffen werden dann Linoleum, Estrich, Rohdecke des
// eigenen Geschosses bei 0,00 m. Deshalb: vier Fünftel exakt, der Rest benannt.
const r2 = lot2.map((x) => x.rest);
const daneben = lot2.filter((x) => Math.abs(x.rest) >= 1.0);
if (daneben.length) console.log('  (Kachel vermutlich noch nicht geladen:', daneben.map((x) => x.name).join(', ') + ')');
pruefe('explodiert: Lücke = Rangunterschied × Abstand (± 1 m Fußbodenaufbau)',
       lot2.length >= 5 && daneben.length <= lot2.length / 5 && Math.abs(median(r2)) < 0.3,
       JSON.stringify(daneben));
await bild('tasten-2-explodiert.png');

// Regler ziehen: die Räume folgen ohne Neubau
await page.evaluate(() => { window.__ersteEbene = RoomConcept._intern.KOERPER.ebenen.values().next().value.flaechen; });
await page.evaluate(() => { BimViewer.Explosion.abstandSetzen(6); BimViewer.Explosion.flachSetzen(0.5); });
await bilder();
const x2 = await page.evaluate(() => {
  const E = BimViewer.Explosion, K = RoomConcept._intern.KOERPER;
  const aus = [];
  for (const eb of K.ebenen.values()) {
    const lage = E.lageFuer(K.tileset, eb.name, eb.hoehe);
    aus.push({ name: eb.name, soll: lage.hub, matrixHub: eb.matrix ? +Cesium.Matrix4.getTranslation(
      Cesium.Matrix4.multiply(Cesium.Matrix4.inverseTransformation(K.tileset.root.computedTransform, new Cesium.Matrix4()),
        Cesium.Matrix4.multiply(eb.matrix, K.tileset.root.computedTransform, new Cesium.Matrix4()), new Cesium.Matrix4()),
      new Cesium.Cartesian3()).z.toFixed(3) : null, flach: lage.flach, basis: lage.basis });
  }
  return { gleich: K.ebenen.values().next().value.flaechen === window.__ersteEbene, aus };
});
pruefe('Regler: kein Neubau der Raumkörper', x2.gleich);
pruefe('Regler 6 m, halb gestaucht: z\' = z·0,51 + basis·0,49 + hub',
       x2.aus.every((e) => e.matrixHub !== null && Math.abs(e.matrixHub - (e.basis * e.flach + e.soll)) < 0.01),
       JSON.stringify(x2.aus));
await page.evaluate(() => { BimViewer.Explosion.flachSetzen(0); BimViewer.Explosion.abstandSetzen(3); });

await taste('x');
await bilder();
const x3 = await page.evaluate(() => {
  const K = RoomConcept._intern.KOERPER;
  let max = 0;
  for (const [guid, d] of K.daten) max = Math.max(max, Cesium.Cartesian3.distance(K.weltpunkt(guid, d.mitte), d.mitte));
  return { aktiv: BimViewer.Explosion.aktiv, max };
});
pruefe('X aus: alle Räume zurück an ihrer Stelle', !x3.aktiv && x3.max < 0.01, JSON.stringify(x3));

// ── I, P, G, M, ?, B ────────────────────────────────────────────────────
console.log('\n── Weitere Kürzel ──');
const sichtbar = () => page.evaluate((jobId) => [...BimViewer.loadedAssets.values()].find((a) => a.jobId === jobId).visible, MODELL);
await taste('i');
pruefe('I blendet das IFC aus', (await sichtbar()) === false, await schild());
const iBereich = await page.evaluate(() => document.querySelector('.activity-btn.active')?.dataset.section);
await taste('i');
pruefe('I holt es zurück', (await sichtbar()) === true, await schild());
pruefe('I öffnet Bauteile', iBereich === 'ifc', iBereich);

await taste('p');
const p1 = await page.evaluate(() => ({ b: document.querySelector('.activity-btn.active')?.dataset.section,
                                        g: !!document.getElementById('group-pointcloud')?.open }));
pruefe('P öffnet Ansicht › Punktwolken', p1.b === 'view' && p1.g, JSON.stringify(p1));
pruefe('P ohne Punktwolke: sagt es', /keine Punktwolke/.test(await schild()), await schild());
await taste('g');
pruefe('G ohne Splat: sagt es', /kein Splat/.test(await schild()), await schild());

await taste('m');
const m1 = await page.evaluate(() => ({ laeuft: BimViewer.Aufmass.laeuft,
  b: document.querySelector('.activity-btn.active')?.dataset.section,
  reiter: document.querySelector('#section-tools .tab.is-active')?.dataset.tab,
  raster: window.AufmassFang ? AufmassFang.raster : null }));
pruefe('M startet das Aufmaß und öffnet Werkzeuge › Messen', m1.laeuft && m1.b === 'tools' && m1.reiter === 'measure',
       JSON.stringify(m1));
await taste('g');
const m2 = await page.evaluate(() => ({ raster: window.AufmassFang ? AufmassFang.raster : null }));
pruefe('G beim Messen bleibt das Fangraster', m2.raster !== m1.raster && !/Splat/.test(await schild()),
       `${m1.raster} → ${m2.raster}`);
await taste('m');
pruefe('M beendet das Aufmaß', !(await page.evaluate(() => BimViewer.Aufmass.laeuft)));

await taste('?');
pruefe('? zeigt die Übersicht', await page.evaluate(() => !!document.getElementById('tastenUebersicht') &&
       /Explosion/.test(document.getElementById('tastenUebersicht').textContent) &&
       /Räume/.test(document.getElementById('tastenUebersicht').textContent)));
await page.keyboard.press('Escape');
await warte(200);
pruefe('Esc schließt sie', await page.evaluate(() => !document.getElementById('tastenUebersicht')));

await taste('b');
const b1 = await page.evaluate(() => document.getElementById('toolbar').classList.contains('collapsed'));
await taste('b');
const b2 = await page.evaluate(() => document.getElementById('toolbar').classList.contains('collapsed'));
pruefe('B fährt die Seitenleiste ein und aus', b1 === true && b2 === false);

// ── Vorlagen ────────────────────────────────────────────────────────────
console.log('\n── Vorlagen ──');
await page.evaluate(() => RoomConcept.setzeGeschoss(RoomConcept._intern.geschossFolge().find((g) => /^EG$/i.test(g)) ||
                                                     RoomConcept._intern.geschossFolge()[1]));
await taste('x');
await page.waitForFunction(() => BimViewer.Explosion.aktiv, { timeout: 60000 });
await warte(3000);
const kameraVorher = await page.evaluate(() => { const p = BimViewer.viewer.camera.positionWC; return [p.x, p.y, p.z]; });
const geschoss = await page.evaluate(() => [...RoomConcept.geschossWahl]);
await taste('v');
pruefe('V öffnet die Liste über der Szene', await page.evaluate(() => !!document.getElementById('vorlagenPalette')));
await page.type('#vorlagenPaletteFeld', 'Campus EG explodiert');
await page.keyboard.press('Enter');
await warte(800);
const v1 = await page.evaluate(() => BimViewer.Vorlagen.liste().map((v) => ({ name: v.name, taste: v.taste,
  bereiche: Object.keys(v.szene || {}), raeume: v.szene.raeume, explosion: v.szene.explosion })));
pruefe('Vorlage angelegt, Taste 1', v1.length === 1 && v1[0].taste === 1 && v1[0].name === 'Campus EG explodiert',
       JSON.stringify(v1));
pruefe('Szene trägt Modelle, Explosion und Räume',
       ['modelle', 'explosion', 'raeume'].every((b) => v1[0].bereiche.includes(b)) && v1[0].explosion.an &&
       v1[0].raeume.an && JSON.stringify(v1[0].raeume.geschosse) === JSON.stringify(geschoss),
       JSON.stringify(v1[0]));
await warte(600);
pruefe('ins Backend geschrieben (abgefangen)', abgefangen.vorlagenPut.some((p) => p.vorlagen.length === 1));

// Alles verstellen
await taste('x');
await taste('r');
await taste('i');
await page.evaluate(() => BimViewer.viewer.camera.moveBackward(400));
const verstellt = await page.evaluate((jobId) => ({ e: BimViewer.Explosion.aktiv, r: RoomConcept.sichtbar,
  v: [...BimViewer.loadedAssets.values()].find((a) => a.jobId === jobId).visible }), MODELL);
pruefe('verstellt: Explosion aus, Räume aus, IFC aus', !verstellt.e && !verstellt.r && verstellt.v === false,
       JSON.stringify(verstellt));

await page.evaluate(() => BimViewer.Vorlagen.speichern('Ganz leer'));
await taste('Digit1', true);   // ⇧1
await page.waitForFunction(() => BimViewer.Explosion.aktiv && RoomConcept.sichtbar &&
  !document.querySelector('.vorlage-zeile.is-laedt'), { timeout: 180000 });
await warte(2500);
const zurueck = await page.evaluate((args) => {
  const [jobId, k] = args;
  const p = BimViewer.viewer.camera.positionWC;
  return { e: BimViewer.Explosion.aktiv, r: RoomConcept.sichtbar, g: [...RoomConcept.geschossWahl],
           v: [...BimViewer.loadedAssets.values()].find((a) => a.jobId === jobId).visible,
           kamera: Cesium.Cartesian3.distance(p, new Cesium.Cartesian3(k[0], k[1], k[2])),
           oben: BimViewer.Vorlagen.liste()[0].name, anzahl: BimViewer.Vorlagen.liste()[0].anzahl };
}, [MODELL, kameraVorher]);
pruefe('⇧1 stellt alles wieder her', zurueck.e && zurueck.r && zurueck.v === true &&
       JSON.stringify(zurueck.g) === JSON.stringify(geschoss), JSON.stringify(zurueck));
pruefe('Kamera zurück (< 2 m)', zurueck.kamera < 2, zurueck.kamera.toFixed(2));
pruefe('zuletzt geladene steht oben', zurueck.oben === 'Campus EG explodiert' && zurueck.anzahl === 1, JSON.stringify(zurueck));
await bild('tasten-3-vorlage.png');

// Gruppe im Bereich Ansicht
await page.evaluate(() => BimViewer.Tasten.menueOeffnen('view', { gruppe: 'vorlagen' }));
await warte(400);
const gruppe = await page.evaluate(() => [...document.querySelectorAll('#vorlagenListe .vorlage-zeile__name')].map((e) => e.textContent));
pruefe('Gruppe „Vorlagen" listet beide, zuletzt geladene oben', gruppe.length === 2 && gruppe[0] === 'Campus EG explodiert',
       JSON.stringify(gruppe));

// ── Modellliste: zuletzt geladen oben ───────────────────────────────────
await page.evaluate(async () => { BimViewerUI.activateSection('backend'); await BimViewerUI.refreshBackendAssets(); });
await warte(500);
const liste = await page.evaluate(() => {
  const el = document.getElementById('backendAssetsList');
  return { trenner: [...el.querySelectorAll('.asset-liste__trenner')].map((t) => t.textContent),
           erstes: el.querySelector('.asset-row')?.title };
});
pruefe('Modellliste: „Zuletzt geladen" oben, Campus zuerst',
       liste.trenner[0] === 'Zuletzt geladen' && liste.erstes === MODELL, JSON.stringify(liste));

// ── Protokoll ───────────────────────────────────────────────────────────
await page.evaluate(() => BimViewer.Nutzung.senden());
await warte(1200);
const arten = new Set(abgefangen.ereignisse.map((e) => e.art));
console.log('  Ereignisse:', [...arten].join(', '));
for (const art of ['sitzung_start', 'modell_geladen', 'taste', 'bereich', 'gruppe', 'werkzeug',
                   'vorlage_gespeichert', 'vorlage_geladen']) {
  pruefe(`protokolliert: ${art}`, arten.has(art));
}
const tastenLog = abgefangen.ereignisse.filter((e) => e.art === 'taste').map((e) => e.daten.taste).join('');
pruefe('Tasten in Reihenfolge', /^rx/.test(tastenLog), tastenLog);
pruefe('keine Koordinaten im Protokoll', !JSON.stringify(abgefangen.ereignisse).match(/"pos"|"kamera"|"szene"/));

pruefe('keine Seitenfehler', seitenfehler.length === 0, seitenfehler.slice(0, 5).join(' | '));
await browser.close();
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden.');
process.exit(fehler ? 1 : 0);
