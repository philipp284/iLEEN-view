// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Die Weiche vor dem HTTPS-Server der Brille (tools/quest-wlan.sh).
//
// Warum: Tippt man in der Brille nur „192.168.0.9:5443", setzt der Browser
// `http://` davor. Ein HTTPS-Server antwortet darauf mit nichts, und Chrome
// zeigt „Diese Seite funktioniert nicht". Die Weiche hört auf dem Port, den
// man eintippt, und sieht am ersten Byte, was kommt:
//   0x16 (TLS-Beginn)  → unverändert an den Vite-Server weiterreichen
//   sonst (Klartext)   → mit „301 → https://…" antworten
// Das Zertifikat bleibt das von Vite; die Weiche entschlüsselt nichts.
//
// Außerdem der Stand für die VR-Ebene in iLEEN am Mac: Klartext-GET auf
// /ileen-quest.json gibt die Adressen im aktuellen Netz (vom Aufseher in
// $ILEEN_QUEST_TLS/stand.json geschrieben) und die Geräte, die zuletzt von
// außen angeklopft haben — so sieht man am Mac, ob die Brille überhaupt
// ankommt, und unter welcher Adresse sie selbst steht.
//
// Und für Apple-Geräte (Vision Pro, iPad, iPhone) die Einrichtung: Safari
// nimmt keine Zertifikatswarnung hin, es braucht die Zertifizierungsstelle des
// Macs als Profil (tools/quest-zertifikat.sh). Klartext auf
//   /einrichten               Anleitung, Profil, Fingerabdruck
//   /ileen-ca.mobileconfig    das Profil (Safari bietet es zur Installation an)
//   /ileen-ca.cer             die Zertifizierungsstelle allein (DER)
// Ein Apple-Gerät, das `/` über http aufruft, bekommt statt der Umleitung
// dieselbe Seite; vertraut es dem Mac schon, leitet sie selbst auf https weiter.
// Die Quest bekommt weiter die 301.

import net from 'node:net';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const AUSSEN = Number(process.env.ILEEN_QUEST_PORT || 5443);
const INNEN = Number(process.env.ILEEN_QUEST_INNEN || 5444);
const TLS = process.env.ILEEN_QUEST_TLS || `${os.homedir()}/.ileen/quest-tls`;

// Wer von außen kam: Adresse → { t, geraet }. Die eigenen Adressen zählen nicht.
// Das Gerät steht nur im Klartext (User-Agent); über TLS bleibt das bekannte.
const besucher = new Map();
function merken(socket, geraet) {
  const ip = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ip || ip.startsWith('127.') || ip === '::1') return;
  const eigene = Object.values(os.networkInterfaces()).flat().map(a => a && a.address);
  if (eigene.includes(ip)) return;
  const vorher = besucher.get(ip);
  besucher.delete(ip);
  besucher.set(ip, { t: Date.now(), geraet: geraet || (vorher && vorher.geraet) || null });
  if (besucher.size > 20) besucher.delete(besucher.keys().next().value);
}

/** Aus dem User-Agent: 'quest' | 'apple' | 'anderes'. Safari auf der Vision Pro meldet sich als Macintosh. */
export function geraetAus(ua) {
  if (!ua) return null;
  if (/OculusBrowser|Quest/i.test(ua)) return 'quest';
  if (/iPhone|iPad|Macintosh|Mac OS X/.test(ua)) return 'apple';
  return 'anderes';
}

function stand() {
  let s = {};
  try { s = JSON.parse(readFileSync(`${TLS}/stand.json`, 'utf8')); } catch { s = { port: AUSSEN }; }
  const jetzt = Date.now();
  s.besucher = [...besucher].sort((a, b) => b[1].t - a[1].t).slice(0, 5)
    .map(([ip, b]) => ({ ip, vorSekunden: Math.round((jetzt - b.t) / 1000), geraet: b.geraet }));
  return JSON.stringify(s);
}

function antwort(client, status, typ, inhalt, kopf = '') {
  const daten = Buffer.isBuffer(inhalt) ? inhalt : Buffer.from(inhalt, 'utf8');
  client.write(
    `HTTP/1.1 ${status}\r\nContent-Type: ${typ}\r\nCache-Control: no-store\r\n${kopf}` +
    `Content-Length: ${daten.length}\r\nConnection: close\r\n\r\n`,
  );
  client.end(daten);
}

const esc = t => String(t).replace(/[&<>"']/g, z => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[z]);
// Für <script>: JSON, in dem kein „</script>" stehen bleiben kann
const js = w => JSON.stringify(w).replace(/</g, '\\u003c');
// Was aus der Anfrage kommt, gelangt nur gezähmt in Seite und Umleitung
const zahmerHost = h => (/^[A-Za-z0-9.-]+$/.test(h || '') ? h : 'localhost');
const zahmerPfad = p => (/^\/[^\s<>"'`\\]*$/.test(p || '') ? p : '/');

/** Die Einrichtungsseite. `weiter` (Pfad): vertraut das Gerät schon, sofort dorthin auf https. */
export function einrichtenSeite({ host: roh, port, fingerabdruck, macName, weiter }) {
  const host = zahmerHost(roh);
  const https = `https://${host}:${port}/`;
  const weiterZu = weiter ? `https://${host}:${port}${zahmerPfad(weiter)}` : null;
  const fp = fingerabdruck ? esc(fingerabdruck) : 'unbekannt — läuft der Dienst?';
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iLEEN VR einrichten</title>
<style>
:root { --grund: #f6f6f4; --text: #1d1d1b; --text2: #5c5c58; --karte: #fff; --rand: #dcdcd6; --akzent: #5f7a00; --auf-akzent: #fff; --gut: #2f7d32; }
@media (prefers-color-scheme: dark) { :root { --grund: #121212; --text: #f2f2ee; --text2: #a9a9a3; --karte: #1d1d1c; --rand: #333331; --akzent: #97bf0d; --auf-akzent: #121212; --gut: #7cc47f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--grund); color: var(--text); font: 17px/1.5 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 28px 16px 48px; }
h1 { font-size: 26px; margin: 0 0 6px; }
p.unter { color: var(--text2); margin: 0 0 22px; }
ol { padding: 0; list-style: none; counter-reset: s; margin: 0; }
li { counter-increment: s; background: var(--karte); border: 1px solid var(--rand); border-radius: 14px; padding: 16px 18px 16px 58px; margin: 0 0 12px; position: relative; }
li::before { content: counter(s); position: absolute; left: 16px; top: 14px; width: 28px; height: 28px; border-radius: 50%; background: var(--akzent); color: var(--auf-akzent); font-weight: 700; text-align: center; line-height: 28px; }
b.pfad { font-weight: 600; }
a.knopf { display: inline-block; margin-top: 8px; padding: 12px 20px; border-radius: 12px; background: var(--akzent); color: var(--auf-akzent); font-weight: 600; text-decoration: none; }
a.knopf.zweit { background: transparent; color: var(--akzent); border: 1.5px solid var(--akzent); }
#pruefung { background: var(--karte); border: 1px solid var(--rand); border-radius: 14px; padding: 12px 16px; margin: 0 0 18px; color: var(--text2); }
#pruefung.gut { color: var(--gut); border-color: var(--gut); }
code { font: 13px/1.4 ui-monospace, Menlo, monospace; word-break: break-all; }
small { color: var(--text2); display: block; margin-top: 18px; }
</style></head><body><main>
<h1>iLEEN VR auf Vision Pro, iPad, iPhone</h1>
<p class="unter">Einmal je Gerät. Danach öffnet Safari <b>${esc(https)}</b> ohne Warnung, und VR geht.</p>
<p id="pruefung">Prüfe, ob dieses Gerät dem Mac schon vertraut …</p>
<ol>
<li><b>Profil laden.</b> Safari fragt, ob es ein Konfigurationsprofil laden darf → <b>Erlauben</b>.<br>
<a class="knopf" href="/ileen-ca.mobileconfig">Profil laden</a></li>
<li><b>Installieren.</b> <b class="pfad">Einstellungen → Allgemein → VPN &amp; Geräteverwaltung</b> → „iLEEN VR (${esc(macName)})“ → Installieren.
Auf iPhone und iPad steht oben in den Einstellungen auch „Profil geladen“.</li>
<li><b>Vertrauen.</b> <b class="pfad">Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen</b> →
„iLEEN VR lokale CA (${esc(macName)})“ einschalten.</li>
<li><b>Öffnen.</b> Zurück in Safari: <br><a class="knopf" href="${esc(https)}">Weiter zu iLEEN</a>
<a class="knopf zweit" href="${esc(https)}vr.html">Nur VR-Ansicht</a><br>
In iLEEN der Schalter 🥽. Die Frage nach dem Handtracking erlauben.</li>
</ol>
<small>Vision Pro: hinsehen und kneifen springt dorthin oder zeigt das Bauteil, lange kneifen zeigt immer die Info,
auf dem Tablet kneifen tippt, kneifen und ziehen rollt. Das Tischmodell (Durchsicht) bietet Safari auf der Vision Pro nicht an.</small>
<small>Fingerabdruck der Zertifizierungsstelle (SHA-256), zum Vergleich mit dem Mac:<br><code>${fp}</code></small>
<small>Sie bestätigt nur Adressen im lokalen Netz und .local-Namen — für andere Seiten gilt sie nicht.
Entfernen: Einstellungen → Allgemein → VPN &amp; Geräteverwaltung → Profil löschen.</small>
</main>
<script>
(function () {
  var el = document.getElementById('pruefung');
  var ziel = ${js(https)};
  var fertig = false;
  var uhr = setTimeout(function () { if (!fertig) { fertig = true; el.textContent = 'Noch nicht eingerichtet — die Schritte unten.'; } }, 5000);
  fetch(ziel + 'vr.html', { mode: 'no-cors', cache: 'no-store' }).then(function () {
    if (fertig) return;
    fertig = true; clearTimeout(uhr);
    el.className = 'gut';
    el.textContent = '✓ Dieses Gerät vertraut dem Mac.';
    ${weiterZu ? `location.replace(${js(weiterZu)});` : ''}
  }, function () {
    if (fertig) return;
    fertig = true; clearTimeout(uhr);
    el.textContent = 'Noch nicht eingerichtet — die Schritte unten.';
  });
})();
</script>
</body></html>`;
}

function datei(name) {
  try { return readFileSync(`${TLS}/${name}`); } catch { return null; }
}

// Allein gestartet (nicht beim Einbinden in einen Prüfstein): die Weiche selbst
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) net.createServer(client => {
  client.on('error', () => {});
  client.once('data', erste => {
    if (erste[0] === 0x16) {
      merken(client);
      // Nichts verlieren, solange die Verbindung zu Vite noch aufgebaut wird
      client.pause();
      const vite = net.connect(INNEN, '127.0.0.1', () => {
        vite.write(erste);
        client.pipe(vite);
        client.resume();
        vite.pipe(client);
      });
      vite.on('error', () => client.destroy());
      client.on('close', () => vite.destroy());
      return;
    }
    const kopf = erste.toString('latin1');
    const pfad = (kopf.match(/^[A-Z]+ (\S+) HTTP/) || [])[1] || '/';
    const nurPfad = pfad.split('?')[0];
    const geraet = geraetAus((kopf.match(/^user-agent:\s*(.+?)\r?$/im) || [])[1]);
    // Die Stand-Abfrage kommt vom Mac selbst; sie soll keinen Besucher überschreiben
    if (nurPfad !== '/ileen-quest.json') merken(client, geraet);
    if (nurPfad === '/ileen-quest.json') {
      antwort(client, '200 OK', 'application/json; charset=utf-8', stand(), 'Access-Control-Allow-Origin: *\r\n');
      return;
    }
    const host = zahmerHost((kopf.match(/^host:\s*([^\s:]+)/im) || [])[1]);
    if (nurPfad === '/ileen-ca.mobileconfig' || nurPfad === '/ileen-ca.cer') {
      const profil = nurPfad.endsWith('.mobileconfig');
      const inhalt = datei(profil ? 'ileen-ca.mobileconfig' : 'ileen-ca.cer');
      if (!inhalt) { antwort(client, '404 Not Found', 'text/plain; charset=utf-8', 'Noch keine Zertifizierungsstelle — läuft tools/quest-wlan.sh?'); return; }
      antwort(client, '200 OK', profil ? 'application/x-apple-aspen-config' : 'application/x-x509-ca-cert', inhalt);
      return;
    }
    const einrichten = nurPfad === '/einrichten' || nurPfad === '/zertifikat';
    if (einrichten || geraet === 'apple') {
      let s = {};
      try { s = JSON.parse(readFileSync(`${TLS}/stand.json`, 'utf8')); } catch { /* Aufseher schreibt ihn gleich */ }
      antwort(client, '200 OK', 'text/html; charset=utf-8', einrichtenSeite({
        host, port: AUSSEN, fingerabdruck: s.ca, macName: String(s.name || os.hostname()).replace(/\.local$/, ''),
        weiter: einrichten ? null : pfad,
      }));
      return;
    }
    const ziel = `https://${host}:${AUSSEN}${zahmerPfad(pfad)}`;
    client.end(
      `HTTP/1.1 301 Moved Permanently\r\nLocation: ${ziel}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
  });
}).listen(AUSSEN, '0.0.0.0', () => console.log(`Weiche auf :${AUSSEN} → Vite auf 127.0.0.1:${INNEN}`));
