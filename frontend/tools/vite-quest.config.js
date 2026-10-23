// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Ein zweiter Dev-Server, nur für die Brille übers WLAN — gestartet von
// tools/quest-wlan.sh, nicht von Hand.
//
// Warum: WebXR läuft nur in einem sicheren Kontext. Ohne Entwicklermodus gibt
// es kein `adb reverse` und damit kein `localhost` in der Brille; bleibt
// HTTPS. Das Zertifikat ist selbst ausgestellt — die Brille warnt einmal,
// danach gilt die Seite als sicher.
//
// Zwei Dinge anders als vite.config.js:
//   · https mit dem Zertifikat aus $ILEEN_QUEST_TLS; nur intern (127.0.0.1:5444),
//     von außen erreicht man ihn über die Weiche, die auch http auf https umleitet
//   · /backend → localhost:8100: eine HTTPS-Seite darf kein http nachladen,
//     also geht das Backend über denselben Ursprung (vr-rechnen.js → backendBasis)
//   · / ist iLEEN, /vr.html die Brillenansicht allein
//   · /vr-raum (WebSocket) → das Relais für mehrere Brillen (tools/vr-raum.mjs)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { sessionApiPlugin } from '../server/session-api.js';

const TLS = process.env.ILEEN_QUEST_TLS;
// Vite hört nur intern; davor steht tools/quest-weiche.mjs auf dem Port, den man eintippt.
const PORT = Number(process.env.ILEEN_QUEST_INNEN || 5444);
const BACKEND = process.env.ILEEN_BACKEND || 'http://localhost:8100';
// Das Relais für „Gemeinsam" (tools/vr-raum.mjs): die Brillen kommen über
// denselben Ursprung (wss://…:5443/vr-raum) — kein zweites Zertifikat, keine Warnung.
const RAUM = process.env.ILEEN_VR_RAUM || `http://127.0.0.1:${process.env.ILEEN_VR_RAUM_PORT || 5446}`;

if (!TLS) throw new Error('ILEEN_QUEST_TLS fehlt — bitte über tools/quest-wlan.sh starten.');

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  // Ein Prüfstein mit eigenem Vite (tests/vr/test-vr-gemeinsam.mjs) bekommt einen
  // eigenen Zwischenspeicher: optimierte er die Abhängigkeiten im gemeinsamen
  // node_modules/.vite neu, träfe das die Seiten des laufenden Quest-Dienstes.
  cacheDir: process.env.ILEEN_VITE_CACHE || undefined,
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    https: {
      key: readFileSync(`${TLS}/schluessel.pem`),
      cert: readFileSync(`${TLS}/zertifikat.pem`),
    },
    // Über den Namen im lokalen Netz (Bonjour) statt der IP
    allowedHosts: ['.local'],
    proxy: {
      '/vr-raum': { target: RAUM, ws: true },
      '/backend': {
        target: BACKEND,
        changeOrigin: true,
        rewrite: pfad => pfad.replace(/^\/backend/, ''),
      },
    },
  },
  // iLEEN selbst und die VR-Seite: der Quest-Browser öffnet iLEEN, der Schalter
  // 🥽 startet VR in einer Ebene darüber (vr-fenster.js). Dieselben Plugins wie
  // vite.config.js.
  plugins: [cesium(), sessionApiPlugin()],
});
