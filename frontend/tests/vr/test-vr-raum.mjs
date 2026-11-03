// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Das Relais für „Gemeinsam in der Brille" (tools/vr-raum.mjs), ohne Browser.
//
// Aufruf:  node tests/vr/test-vr-raum.mjs
//
// Gegen den WebSocket-Client, den Node selbst mitbringt (undici) — ein
// fremder Client prüft das handgeschriebene Protokoll ehrlicher als einer aus
// derselben Feder. Geprüft wird, worauf sich vr-gemeinsam.js verlässt:
//   · Willkommen mit Nummer, Farbe und den schon Anwesenden
//   · Posen gehen an die anderen, nicht zurück, und werden nicht gespeichert
//   · Zustand mit laufender Nummer, auch an den Sender, und für Neue im Willkommen
//   · Teilnehmerangaben werden zusammengeführt und kommen bei Neuen mit
//   · Gehen meldet „weg"; Wiederkommen mit derselben Kennung behält die Farbe
//     und verdrängt die alte Verbindung (Code 4000)
//   · Räume sind getrennt; lange Nachrichten (> 125 und > 65535 Byte) kommen an
//   · zu große Nachrichten schließen die Verbindung; der Stand per GET

import { raumServer } from '../../tools/vr-raum.mjs';
import { FARBEN } from '../../vr-gemeinsam-rechnen.js';

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
}

const relais = raumServer({ port: 0, protokoll: () => {} });
const { port } = await relais.bereit;
const ADRESSE = `ws://127.0.0.1:${port}/vr-raum`;

/** Ein Teilnehmer: sammelt alles, was ankommt, und wartet gezielt darauf. */
function teilnehmer({ raum = 'pruef', kennung, geraet = 'brille', name = '' } = {}) {
  const ws = new WebSocket(ADRESSE);
  const post = [];
  const wartende = [];
  let zuCode = null;
  ws.addEventListener('message', e => {
    const n = JSON.parse(e.data);
    post.push(n);
    for (const w of [...wartende]) if (w.passt(n)) { wartende.splice(wartende.indexOf(w), 1); w.fertig(n); }
  });
  ws.addEventListener('close', e => { zuCode = e.code; });
  const offen = new Promise((fertig, fehl) => {
    ws.addEventListener('open', fertig);
    ws.addEventListener('error', () => fehl(new Error('keine Verbindung')));
  });
  return {
    ws, post,
    get zuCode() { return zuCode; },
    async hallo() {
      await offen;
      ws.send(JSON.stringify({ t: 'hallo', v: 1, raum, kennung, geraet, name }));
      return this.warte(n => n.t === 'willkommen');
    },
    senden(n) { ws.send(JSON.stringify(n)); },
    warte(passt, ms = 2000) {
      const schon = post.find(passt);
      if (schon) { post.splice(post.indexOf(schon), 1); return Promise.resolve(schon); }
      return new Promise((fertig, fehl) => {
        const w = { passt, fertig: n => { post.splice(post.indexOf(n), 1); clearTimeout(uhr); fertig(n); } };
        const uhr = setTimeout(() => { wartende.splice(wartende.indexOf(w), 1); fehl(new Error('nichts gekommen')); }, ms);
        wartende.push(w);
      });
    },
    zu() { ws.close(); return new Promise(r => setTimeout(r, 80)); },
  };
}

const ruhe = ms => new Promise(r => setTimeout(r, ms));

try {
  // ── Beitreten ──────────────────────────────────────────────────
  const a = teilnehmer({ kennung: 'brilleAAAA01' });
  const wa = await a.hallo();
  pruefe('Willkommen mit Kennung, Nummer und Farbe', /^t/.test(wa.id) && wa.nummer === 1 && wa.farbe >= 0 && wa.farbe < FARBEN.length, JSON.stringify(wa));
  pruefe('erster im Raum: niemand sonst da', wa.teilnehmer.length === 0 && wa.raum === 'pruef');

  const b = teilnehmer({ kennung: 'brilleBBBB02' });
  const wb = await b.hallo();
  pruefe('zweite Brille: Nummer 2, andere Farbe', wb.nummer === 2 && wb.farbe !== wa.farbe, JSON.stringify(wb));
  pruefe('zweite Brille sieht die erste', wb.teilnehmer.length === 1 && wb.teilnehmer[0].id === wa.id);
  const wer = await a.warte(n => n.t === 'wer');
  pruefe('die erste erfährt von der zweiten', wer.teilnehmer.id === wb.id && wer.teilnehmer.geraet === 'brille');

  const m = teilnehmer({ kennung: 'macCCCCCC03', geraet: 'bildschirm', name: 'Philipp\u0007 am Mac' });
  const wm = await m.hallo();
  pruefe('Bildschirm zählt eigene Nummern, Name ohne Steuerzeichen', wm.nummer === 1 && wm.name === 'Philipp am Mac', JSON.stringify(wm));
  await a.warte(n => n.t === 'wer' && n.teilnehmer.id === wm.id);
  await b.warte(n => n.t === 'wer' && n.teilnehmer.id === wm.id);

  // ── Posen ──────────────────────────────────────────────────────
  a.senden({ t: 'pose', k: [1, 1.6, 2, 0, 0, 0, 1], m: 'vr' });
  const pb = await b.warte(n => n.t === 'pose');
  const pm = await m.warte(n => n.t === 'pose');
  pruefe('Pose kommt bei den anderen an, mit Absender', pb.von === wa.id && pm.von === wa.id && pb.k[1] === 1.6);
  await ruhe(60);
  pruefe('Pose kommt nicht zum Sender zurück', !a.post.some(n => n.t === 'pose'));

  // ── Zustand ────────────────────────────────────────────────────
  b.senden({ t: 'zustand', k: 'gruppe:vr', w: { job: 'x', x: 1, y: 0, z: 2, gier: 0.5, s: 1 } });
  const za = await a.warte(n => n.t === 'zustand');
  const zb = await b.warte(n => n.t === 'zustand');
  pruefe('Zustand an alle, auch zurück an den Sender', za.seq === zb.seq && za.von === wb.id && zb.von === wb.id);
  b.senden({ t: 'zustand', k: 'gruppe:vr', w: { job: 'x', x: 2, y: 0, z: 2, gier: 0.5, s: 1 } });
  const za2 = await a.warte(n => n.t === 'zustand');
  pruefe('laufende Nummer steigt', za2.seq === za.seq + 1, `${za.seq} → ${za2.seq}`);
  b.senden({ t: 'zustand', k: 'böser schlüssel', w: 1 });
  await ruhe(60);
  pruefe('Zustand mit ungültigem Schlüssel wird verworfen', !a.post.some(n => n.t === 'zustand'));

  // ── Teilnehmerangaben ──────────────────────────────────────────
  a.senden({ t: 'ich', info: { modus: 'vr', job: 'x' } });
  a.senden({ t: 'ich', info: { kalibriert: true, abstand: 2.4 } });
  await b.warte(n => n.t === 'wer' && n.teilnehmer.info.modus === 'vr');
  const wer2 = await b.warte(n => n.t === 'wer' && n.teilnehmer.info.kalibriert);
  pruefe('Angaben werden zusammengeführt', wer2.teilnehmer.info.modus === 'vr' && wer2.teilnehmer.info.abstand === 2.4, JSON.stringify(wer2.teilnehmer.info));

  // ── Neuer sieht Zustand und Angaben ────────────────────────────
  const c = teilnehmer({ kennung: 'brilleDDDD04' });
  const wc = await c.hallo();
  const ac = wc.teilnehmer.find(t => t.id === wa.id);
  pruefe('Neuer bekommt den Zustand im Willkommen', wc.zustand['gruppe:vr'] && wc.zustand['gruppe:vr'].w.x === 2 && wc.zustand['gruppe:vr'].seq === za2.seq);
  pruefe('Neuer bekommt die Angaben der anderen', ac && ac.info.kalibriert === true && ac.info.job === 'x');
  pruefe('drei Brillen, drei Nummern, keine Farbe doppelt',
    new Set([wa.farbe, wb.farbe, wc.farbe, wm.farbe]).size === 4 && wc.nummer === 3);

  // ── Lange Nachrichten ──────────────────────────────────────────
  const mittel = 'x'.repeat(3000);
  a.senden({ t: 'ereignis', art: 'probe', text: mittel });
  const em = await b.warte(n => n.t === 'ereignis');
  pruefe('Nachricht mit 16-Bit-Länge kommt an', em.text.length === 3000 && em.von === wa.id);
  const gross = 'y'.repeat(30000);
  a.senden({ t: 'zustand', k: 'ansicht', w: { gross } });
  const zg = await c.warte(n => n.t === 'zustand' && n.k === 'ansicht');
  pruefe('Zustand mit 30 kB kommt an', zg.w.gross.length === 30000);
  // > 65535 Byte: bricht ab (64 kB Grenze), und zwar nur diese Verbindung
  const d = teilnehmer({ kennung: 'brilleEEEE05' });
  await d.hallo();
  d.senden({ t: 'ereignis', text: 'z'.repeat(70000) });
  await ruhe(200);
  pruefe('zu große Nachricht schließt die Verbindung (1009)', d.zuCode === 1009, d.zuCode);
  await a.warte(n => n.t === 'weg');

  // ── Gehen und Wiederkommen ─────────────────────────────────────
  await b.zu();
  const weg = await a.warte(n => n.t === 'weg');
  pruefe('Gehen meldet „weg"', weg.id === wb.id);
  const b2 = teilnehmer({ kennung: 'brilleBBBB02' });
  const wb2 = await b2.hallo();
  pruefe('Wiederkommen: dieselbe Nummer und Farbe', wb2.nummer === wb.nummer && wb2.farbe === wb.farbe, JSON.stringify([wb.nummer, wb.farbe, wb2.nummer, wb2.farbe]));
  // Dieselbe Kennung ein zweites Mal: die erste Verbindung räumt
  const b3 = teilnehmer({ kennung: 'brilleBBBB02' });
  const wb3 = await b3.hallo();
  await ruhe(150);
  pruefe('doppelte Kennung verdrängt die alte (4000)', b2.zuCode === 4000 && wb3.nummer === wb.nummer, `${b2.zuCode}`);
  const weg2 = await a.warte(n => n.t === 'weg' && n.id === wb2.id);
  pruefe('die verdrängte meldet sich ab', !!weg2);

  // ── Räume getrennt ─────────────────────────────────────────────
  const fremd = teilnehmer({ raum: 'anderer', kennung: 'brilleFFFF06' });
  const wf = await fremd.hallo();
  pruefe('anderer Raum: allein, Nummer 1', wf.teilnehmer.length === 0 && wf.nummer === 1 && !wf.zustand['gruppe:vr']);
  fremd.senden({ t: 'pose', k: [0, 0, 0, 0, 0, 0, 1] });
  await ruhe(80);
  pruefe('Posen bleiben im eigenen Raum', !a.post.some(n => n.t === 'pose') && !c.post.some(n => n.t === 'pose' && n.von === wf.id));

  // ── Stand ──────────────────────────────────────────────────────
  const stand = await (await fetch(`http://127.0.0.1:${port}/vr-raum/stand`)).json();
  const pruef = stand.raeume.find(r => r.name === 'pruef');
  pruefe('Stand per GET: Räume, Teilnehmer, Zustand', pruef && pruef.teilnehmer.length === 4 && pruef.zustand['gruppe:vr'] && stand.raeume.length === 2,
    JSON.stringify(stand).slice(0, 300));
  pruefe('Stand nennt Namen und Kalibrierung', pruef.teilnehmer.some(t => t.name === 'Brille 1' && t.kalibriert));

  // ── Ohne hallo passiert nichts ─────────────────────────────────
  const stumm = new WebSocket(ADRESSE);
  await new Promise(r => stumm.addEventListener('open', r));
  stumm.send(JSON.stringify({ t: 'pose', k: [0, 0, 0, 0, 0, 0, 1] }));
  await ruhe(80);
  pruefe('ohne hallo wird nichts weitergereicht', !a.post.some(n => n.t === 'pose'));
  stumm.close();

  for (const x of [a, m, c, b3, fremd]) await x.zu();
} finally {
  await relais.schliessen();
}

console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
