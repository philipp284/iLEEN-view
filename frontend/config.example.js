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
  // Cesium-ion-Zugriffsschlüssel — nur noch für Modelle im eigenen ion-Konto.
  // Karte, Gelände, Gebäude und Suche kommen ohne ion (kartenquellen.js,
  // gelaende.js); ohne Token fehlt nur das Feld „Cesium Ion" im Modell-Panel.
  // Zur Laufzeit überschreibbar: localStorage 'ileen_ion_token'.
  ionToken: '',

  // Google Maps Platform für Luftbild/Karte (2D Tiles), Photorealistic 3D
  // Tiles und die Google-Suche. Im Cloud-Projekt des Schlüssels müssen
  // „Map Tiles API" und „Geocoding API" freigeschaltet sein. Leer → iLEEN-view
  // läuft mit amtlichen und freien Quellen, die Google-Einträge melden das.
  // Zur Laufzeit überschreibbar: localStorage 'ileen_google_key'.
  googleMapsKey: '',

  // Eigenes Backend (backend/). Zur Laufzeit im Modelle-Panel überschreibbar
  // (localStorage 'ileen_backend_url'). Leer → Backend-Teil inaktiv.
  backendUrl: 'http://localhost:8100',

  // Wer iLEEN-view als Modul einbetten und fernsteuern darf (gaeco-bruecke.js):
  // die Origins des gaeco Plugin Host. Zur Laufzeit ergänzbar über
  // localStorage 'ileen_gaeco_origins' (kommagetrennt).
  gaecoOrigins: ['http://localhost:5000']
};
