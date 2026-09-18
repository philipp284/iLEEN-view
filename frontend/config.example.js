/**
 * iLEEN-view — Konfiguration je Installation
 *
 * Kopieren nach `config.js`; diese Datei ist die Vorlage im Repo.
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Nur Werte, die sich von Rechner zu Rechner unterscheiden. Gelesen wird
 * ausschließlich über BimViewer (core.js) — dort lässt sich jeder Wert zur
 * Laufzeit überschreiben, ohne diese Datei anzufassen.
 */
window.ILEEN_CONFIG = {
  // Cesium-ion-Zugriffsschlüssel. Ohne ihn fehlen Weltgelände, Luftbild und
  // die ion-Assets; Modelle aus dem eigenen Backend laden trotzdem.
  // Zur Laufzeit überschreibbar: localStorage 'ileen_ion_token'.
  ionToken: '',

  // Eigenes Backend (backend/). Zur Laufzeit im Modelle-Panel überschreibbar
  // (localStorage 'ileen_backend_url'). Leer → Backend-Teil inaktiv.
  backendUrl: 'http://localhost:8100'
};
