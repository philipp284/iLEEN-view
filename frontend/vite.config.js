// iLEEN — Entwicklungsserver
// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Port 5190 ist fest, weil die Browser-Prüfsteine unter tests/ ihn erwarten.
// **Nicht 5181** — das ist der Port der Vollfassung (~/Projekte/iLEEN), und
// 5182/5184 gehören anderen Projekten in derselben Werkstatt. Alle
// führen `strictPort`, also startet der zweite gar nicht erst; was dabei
// passiert, ist schlimmer als ein Fehler: der Browser-Prüfstein bekommt eine
// Antwort, nur eben von der anderen Anwendung, und meldet Module als
// vorhanden, die es hier nicht gibt.
// Die Sitzungs-API (server/session-api.js) schreibt Messprotokolle nach issues/.

import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { sessionApiPlugin } from './server/session-api.js';

export default defineConfig({
  server: { port: 5190, strictPort: true },
  plugins: [cesium(), sessionApiPlugin()],
});
