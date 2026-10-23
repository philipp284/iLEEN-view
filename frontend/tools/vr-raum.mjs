// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Das Relais für „Gemeinsam in der Brille" (vr-gemeinsam.js).
//
// Gestartet von tools/quest-wlan.sh neben der Weiche. Es hört nur auf
// 127.0.0.1 (Vorgabe 5446). Die Brillen kommen über den Quest-Vite
// (wss://<Mac>:5443/vr-raum, durchgereicht, siehe vite-quest.config.js) — so
// gilt dasselbe Zertifikat, das sie schon bestätigt haben. iLEEN am Mac
// (http://localhost:5181) verbindet sich direkt mit ws://127.0.0.1:5446.
//
// Was es tut — und was nicht:
//   · Räume mit Teilnehmern; jeder bekommt Nummer und Farbe (beim Wieder-
//     kommen dieselben)
//   · Posen gehen an die anderen weiter, gespeichert wird keine
//   · gemeinsamer Zustand (Modell, Gruppenlage, Ansicht) mit laufender Nummer:
//     auch der Sender bekommt ihn zurück, daran erkennt er, wer zuletzt schrieb
//   · Teilnehmerangaben (Modus, kalibriert, Auswahl, Messung) bleiben am
//     Teilnehmer und kommen bei jedem Neuen mit
// Gerechnet wird hier nichts: Rahmen und Kalibrierung kennen nur die Brillen.
//
// WebSocket von Hand (RFC 6455, nur Text): wie die Weiche ohne Abhängigkeit.
// `ws` liegt zwar in node_modules, aber nur als Unterpaket von puppeteer-core,
// das selbst keine Projektabhängigkeit ist.
//
//   node tools/vr-raum.mjs                 → 127.0.0.1:5446
//   ILEEN_VR_RAUM_PORT=5466 node tools/vr-raum.mjs
//   GET http://127.0.0.1:5446/vr-raum/stand  → wer ist in welchem Raum

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  PROTOKOLL, RAUM_PORT, FARBEN, raumName, kennungGueltig, nameSauber, nummerWaehlen, farbeWaehlen, anzeigeName,
} from '../vr-gemeinsam-rechnen.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_NACHRICHT = 64 * 1024;      // Bytes je Nachricht
const MAX_INFO = 8 * 1024;            // Bytes Teilnehmerangaben
const MAX_ZUSTAND = 32 * 1024;        // Bytes je Zustandseintrag
const MAX_TEILNEHMER = 16;            // je Raum
const MAX_RAEUME = 32;
const MAX_JE_SEKUNDE = 150;           // Nachrichten je Verbindung; darüber wird verworfen
const STAU = 512 * 1024;              // Bytes im Sendepuffer, ab denen Posen entfallen
const HERZ = 10_000;                  // ms zwischen zwei Pings
const RAUM_HALTEN = 10 * 60_000;      // ms, die ein leerer Raum seinen Zustand behält

// ─────────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────────

class Verbindung extends EventEmitter {
  constructor(socket, rest) {
    super();
    this.socket = socket;
    this.puffer = Buffer.alloc(0);
    this.fragmente = null;
    this.offen = true;
    this.lebt = true;
    this.zaehler = { sekunde: 0, n: 0 };
    socket.setNoDelay(true);
    socket.on('data', d => this.lesen(d));
    socket.on('close', () => this.ende());
    socket.on('error', () => this.ende());
    if (rest && rest.length) this.lesen(rest);
  }

  lesen(daten) {
    this.puffer = this.puffer.length ? Buffer.concat([this.puffer, daten]) : daten;
    while (this.offen && this.puffer.length >= 2) {
      const b0 = this.puffer[0];
      const b1 = this.puffer[1];
      let laenge = b1 & 0x7f;
      let pos = 2;
      if (laenge === 126) {
        if (this.puffer.length < 4) return;
        laenge = this.puffer.readUInt16BE(2);
        pos = 4;
      } else if (laenge === 127) {
        if (this.puffer.length < 10) return;
        laenge = this.puffer.readUInt32BE(2) * 2 ** 32 + this.puffer.readUInt32BE(6);
        pos = 10;
      }
      if (laenge > MAX_NACHRICHT) { this.schliessen(1009, 'zu groß'); return; }
      // Rahmen vom Browser sind immer maskiert (RFC 6455, 5.1)
      if (!(b1 & 0x80)) { this.schliessen(1002, 'unmaskiert'); return; }
      if (this.puffer.length < pos + 4 + laenge) return;
      const maske = this.puffer.subarray(pos, pos + 4);
      const nutz = Buffer.from(this.puffer.subarray(pos + 4, pos + 4 + laenge));
      for (let i = 0; i < nutz.length; i++) nutz[i] ^= maske[i & 3];
      this.puffer = this.puffer.subarray(pos + 4 + laenge);
      this.rahmen((b0 & 0x80) !== 0, b0 & 0x0f, nutz);
    }
  }

  rahmen(fin, op, nutz) {
    if (op === 0x8) { this.schliessen(1000); return; }
    if (op === 0x9) { this.senden(nutz, 0xA); return; }
    if (op === 0xA) { this.lebt = true; return; }
    if (op === 0x1 || op === 0x2) {
      if (fin) this.nachricht(op, nutz);
      else this.fragmente = { op, teile: [nutz], n: nutz.length };
      return;
    }
    if (op === 0x0 && this.fragmente) {
      const f = this.fragmente;
      f.teile.push(nutz);
      f.n += nutz.length;
      if (f.n > MAX_NACHRICHT) { this.schliessen(1009, 'zu groß'); return; }
      if (fin) { this.fragmente = null; this.nachricht(f.op, Buffer.concat(f.teile)); }
      return;
    }
    this.schliessen(1002, 'unbekannter Rahmen');
  }

  nachricht(op, nutz) {
    this.lebt = true;
    if (op !== 0x1) return;
    const s = Math.floor(Date.now() / 1000);
    if (s !== this.zaehler.sekunde) this.zaehler = { sekunde: s, n: 0 };
    if (++this.zaehler.n > MAX_JE_SEKUNDE) return;
    let n;
    try { n = JSON.parse(nutz.toString('utf8')); } catch { return; }
    if (n && typeof n === 'object' && typeof n.t === 'string') this.emit('nachricht', n, nutz.length);
  }

  senden(daten, op = 0x1) {
    if (!this.offen || this.socket.destroyed) return;
    const nutz = Buffer.isBuffer(daten) ? daten : Buffer.from(daten);
    let kopf;
    if (nutz.length < 126) {
      kopf = Buffer.from([0x80 | op, nutz.length]);
    } else if (nutz.length < 65536) {
      kopf = Buffer.alloc(4);
      kopf[0] = 0x80 | op;
      kopf[1] = 126;
      kopf.writeUInt16BE(nutz.length, 2);
    } else {
      kopf = Buffer.alloc(10);
      kopf[0] = 0x80 | op;
      kopf[1] = 127;
      kopf.writeUInt32BE(Math.floor(nutz.length / 2 ** 32), 2);
      kopf.writeUInt32BE(nutz.length >>> 0, 6);
    }
    this.socket.write(Buffer.concat([kopf, nutz]));
  }

  /** `verzichtbar`: Posen. Wer nicht hinterherkommt, bekommt die nächste. */
  json(n, verzichtbar = false) {
    if (verzichtbar && this.socket.writableLength > STAU) return;
    this.senden(JSON.stringify(n));
  }

  schliessen(code = 1000, grund = '') {
    if (!this.offen) return;
    const g = Buffer.from(String(grund).slice(0, 100));
    const nutz = Buffer.alloc(2 + g.length);
    nutz.writeUInt16BE(code, 0);
    g.copy(nutz, 2);
    this.senden(nutz, 0x8);
    this.offen = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.ende();
  }

  ende() {
    if (this.beendet) return;
    this.beendet = true;
    this.offen = false;
    this.emit('zu');
  }
}

function annehmen(req, socket, kopf) {
  const schluessel = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !schluessel) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const antwort = crypto.createHash('sha1').update(schluessel + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${antwort}\r\n\r\n`);
  return new Verbindung(socket, kopf);
}

// ─────────────────────────────────────────────────────────────────
// RÄUME
// ─────────────────────────────────────────────────────────────────

export function raumServer({ port = RAUM_PORT, host = '127.0.0.1', protokoll = console.log } = {}) {
  const raeume = new Map();       // Name → { name, teilnehmer: Map(id → T), zustand: Map, seq, frueher: Map, leerSeit }
  let laufend = 0;

  function raumHolen(name) {
    let r = raeume.get(name);
    if (!r) {
      if (raeume.size >= MAX_RAEUME) aufraeumen(true);
      r = { name, teilnehmer: new Map(), zustand: new Map(), seq: 0, frueher: new Map(), leerSeit: null };
      raeume.set(name, r);
    }
    r.leerSeit = null;
    return r;
  }

  function aufraeumen(dringend = false) {
    const jetzt = Date.now();
    for (const [name, r] of raeume) {
      if (r.teilnehmer.size || r.leerSeit === null) continue;
      if (dringend || jetzt - r.leerSeit > RAUM_HALTEN) raeume.delete(name);
    }
  }

  function oeffentlich(t) {
    return { id: t.id, nummer: t.nummer, farbe: t.farbe, name: t.name, geraet: t.geraet, info: t.info };
  }

  function anAlle(r, n, ausser = null, verzichtbar = false) {
    for (const t of r.teilnehmer.values()) if (t !== ausser) t.verbindung.json(n, verzichtbar);
  }

  function beitreten(v, n) {
    const geraet = n.geraet === 'brille' ? 'brille' : 'bildschirm';
    const kennung = kennungGueltig(n.kennung) ? n.kennung : crypto.randomUUID().replace(/-/g, '');
    const r = raumHolen(raumName(n.raum));

    // Dieselbe Kennung kommt wieder (Seite neu geladen, Netz kurz weg): die alte
    // Verbindung räumt den Platz. 4000 sagt ihr, dass sie nicht wiederkommen soll.
    for (const t of r.teilnehmer.values()) {
      if (t.kennung === kennung) {
        t.verbindung.removeAllListeners('zu');
        verlassen(r, t);
        t.verbindung.schliessen(4000, 'ersetzt');
      }
    }
    if (r.teilnehmer.size >= MAX_TEILNEHMER) {
      v.json({ t: 'fehler', text: `Raum ${r.name} ist voll (${MAX_TEILNEHMER})` });
      v.schliessen(4001, 'voll');
      return null;
    }
    const frueher = r.frueher.get(kennung) || {};
    const belegtNr = new Set([...r.teilnehmer.values()].filter(t => t.geraet === geraet).map(t => t.nummer));
    const belegtFarbe = new Set([...r.teilnehmer.values()].map(t => t.farbe));
    const t = {
      id: `t${(++laufend).toString(36)}`,
      kennung,
      nummer: nummerWaehlen(belegtNr, frueher.geraet === geraet ? frueher.nummer : null),
      farbe: farbeWaehlen(belegtFarbe, frueher.farbe),
      name: nameSauber(n.name),
      geraet,
      info: {},
      verbindung: v,
    };
    r.teilnehmer.set(t.id, t);
    r.frueher.set(kennung, { nummer: t.nummer, farbe: t.farbe, geraet });
    if (r.frueher.size > 200) r.frueher.delete(r.frueher.keys().next().value);

    v.json({
      t: 'willkommen', v: PROTOKOLL, id: t.id, nummer: t.nummer, farbe: t.farbe, name: t.name, raum: r.name,
      teilnehmer: [...r.teilnehmer.values()].filter(x => x !== t).map(oeffentlich),
      zustand: Object.fromEntries([...r.zustand].map(([k, z]) => [k, z])),
    });
    anAlle(r, { t: 'wer', teilnehmer: oeffentlich(t) }, t);
    protokoll(`[vr-raum] ${anzeigeName(t)} (${t.id}) betritt ${r.name} — ${r.teilnehmer.size} im Raum`);
    return { r, t };
  }

  function verlassen(r, t) {
    if (!r.teilnehmer.has(t.id)) return;
    r.teilnehmer.delete(t.id);
    anAlle(r, { t: 'weg', id: t.id });
    protokoll(`[vr-raum] ${anzeigeName(t)} (${t.id}) verlässt ${r.name} — ${r.teilnehmer.size} im Raum`);
    if (!r.teilnehmer.size) r.leerSeit = Date.now();
  }

  function verarbeiten(sitz, n, groesse) {
    const { r, t } = sitz;
    switch (n.t) {
      case 'pose':
        // Weiter, ungespeichert; wer im Stau steckt, bekommt die nächste
        n.von = t.id;
        anAlle(r, n, t, true);
        break;
      case 'ich': {
        if (!n.info || typeof n.info !== 'object' || groesse > MAX_INFO) return;
        Object.assign(t.info, n.info);
        // Aus vielen kleinen Nachrichten soll kein großer Eintrag wachsen
        if (JSON.stringify(t.info).length > 2 * MAX_INFO) t.info = { ...n.info };
        if (typeof n.name === 'string') t.name = nameSauber(n.name);
        anAlle(r, { t: 'wer', teilnehmer: oeffentlich(t) }, t);
        break;
      }
      case 'zustand': {
        if (typeof n.k !== 'string' || !/^[\w:-]{1,40}$/.test(n.k) || groesse > MAX_ZUSTAND) return;
        const z = { w: n.w ?? null, von: t.id, seq: ++r.seq };
        r.zustand.set(n.k, z);
        // An alle, auch zurück: so kennt der Sender die Nummer seines Eintrags
        anAlle(r, { t: 'zustand', k: n.k, ...z });
        break;
      }
      case 'ereignis':
        n.von = t.id;
        anAlle(r, n, t);
        break;
      default:
        break;
    }
  }

  const server = http.createServer((req, res) => {
    const pfad = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (pfad === '/vr-raum/stand' || pfad === '/stand')) {
      const stand = {
        v: PROTOKOLL,
        raeume: [...raeume.values()].map(r => ({
          name: r.name,
          teilnehmer: [...r.teilnehmer.values()].map(t => ({
            id: t.id, name: anzeigeName(t), geraet: t.geraet, farbe: FARBEN[t.farbe],
            modus: t.info.modus || null, kalibriert: !!t.info.kalibriert, job: t.info.job || null,
          })),
          zustand: Object.fromEntries([...r.zustand].map(([k, z]) => [k, { seq: z.seq, von: z.von }])),
        })),
      };
      const inhalt = JSON.stringify(stand);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(inhalt),
      });
      res.end(inhalt);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('iLEEN VR-Raum: WebSocket unter /vr-raum, Stand unter /vr-raum/stand\n');
  });

  // Hochgestufte Sockets zählt server.close() mit, beendet sie aber nicht: ohne
  // eigene Liste wartete das Schließen auf eine Verbindung, die nie „hallo" sagte.
  const sockel = new Set();
  server.on('upgrade', (req, socket, kopf) => {
    sockel.add(socket);
    socket.on('close', () => sockel.delete(socket));
    socket.on('error', () => socket.destroy());
    const pfad = (req.url || '').split('?')[0];
    if (pfad !== '/vr-raum' && pfad !== '/') { socket.destroy(); return; }
    const v = annehmen(req, socket, kopf);
    if (!v) return;
    let sitz = null;
    v.on('nachricht', (n, groesse) => {
      if (!sitz) {
        if (n.t === 'hallo') sitz = beitreten(v, n);
        return;
      }
      verarbeiten(sitz, n, groesse);
    });
    v.on('zu', () => { if (sitz) verlassen(sitz.r, sitz.t); });
  });

  // Herzschlag: wer zwei Pings nicht beantwortet, ist fort (Brille abgesetzt
  // und schlafen gelegt, WLAN weg — TCP merkt das erst nach Minuten)
  const herz = setInterval(() => {
    for (const r of raeume.values()) {
      for (const t of [...r.teilnehmer.values()]) {
        const v = t.verbindung;
        if (!v.lebt) { v.schliessen(1001, 'keine Antwort'); continue; }
        v.lebt = false;
        v.senden(Buffer.alloc(0), 0x9);
      }
    }
    aufraeumen();
  }, HERZ);
  herz.unref();

  return {
    server,
    raeume,
    bereit: new Promise((fertig, fehler) => {
      server.once('error', fehler);
      server.listen(port, host, () => fertig(server.address()));
    }),
    schliessen() {
      clearInterval(herz);
      for (const r of raeume.values()) for (const t of r.teilnehmer.values()) t.verbindung.schliessen(1001, 'Relais endet');
      const zu = new Promise(fertig => server.close(() => fertig()));
      for (const s of sockel) s.destroy();
      server.closeAllConnections();
      return zu;
    },
  };
}

// Direkt gestartet (quest-wlan.sh), nicht importiert (Prüfstein)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.ILEEN_VR_RAUM_PORT || RAUM_PORT);
  const host = process.env.ILEEN_VR_RAUM_HOST || '127.0.0.1';
  const relais = raumServer({ port, host });
  relais.bereit
    .then(a => console.log(`VR-Raum (Gemeinsam) auf ${a.address}:${a.port}`))
    .catch(e => { console.error(`VR-Raum: ${e.message}`); process.exit(1); });
  const ende = () => relais.schliessen().then(() => process.exit(0));
  process.on('SIGINT', ende);
  process.on('SIGTERM', ende);
}
