/**
 * iLEEN — Sensorfarben: die Messwerte am Modell sichtbar machen.
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `sensor-store.js` hält die Werte, dieses Modul gibt ihnen eine Farbe.
 *
 * Ein Tileset hat genau einen Stil
 * ================================
 * Das ist die ganze Schwierigkeit dieses Pakets. `features.js` baut den Stil
 * aus Bauteil-Hervorhebung und Typfilter **gemeinsam** zusammen, weil beides
 * sonst einander überschriebe. Wer daneben ein zweites `tileset.style` setzt,
 * löscht den Filter — und der nächste Filterlauf löscht die Sensorfarben.
 *
 * Deshalb setzt dieses Modul **keinen Stil**. Es *liefert Bedingungen*, nach
 * dem Muster von `_ifcHighlightConditions()`, und `features.js` reiht sie in
 * dieselbe Liste ein:
 *
 *     1. Hervorhebung      ein ausgewähltes Bauteil bleibt erkennbar
 *     2. Sensorfarben      ← hier
 *     3. Typfarben
 *     4. ['true', weiß]
 *
 * Cesium nimmt die erste zutreffende Bedingung. Die Reihenfolge ist damit die
 * Aussage: Wer etwas ausgewählt hat, will es sehen — auch in einem eingefärbten
 * Geschoss.
 *
 * Gefärbt wird je Geschoss, nicht je Bauteil
 * ==========================================
 * Das Campusmodell hat keine `IfcSpace` (siehe #2). Die Zonen aus dem Register
 * sind deshalb Geschosse, und die Batch Table jedes B3DM führt `Geschoss` als
 * Textfeld mit. `ZONE_GESCHOSS` unten ist der **einzige** Ort, an dem
 * Zonenkennung und Geschossname aufeinandertreffen. Sobald ein Modell echte
 * Räume mitbringt, fällt diese Tabelle weg: dann hängt der Sensor unmittelbar
 * an der GlobalId seines Raums, und aus `${Geschoss} === 'EG'` wird
 * `${GlobalId} === '…'`.
 *
 * Grau heißt nicht kaputt
 * =======================
 * Ein Rückblick endet an der letzten Mitternacht. Wenige Stunden später ist
 * jeder Wert älter als das Dreifache seines Messtakts und gilt zu Recht als
 * `veraltet` — dann ist das ganze Modell entsättigt. Das sieht aus wie ein
 * Fehler und ist keiner, sondern die Altersregel bei der Arbeit. Deshalb sind
 * veraltete Werte **entsättigt, nicht farblos**: man sieht noch, welcher Wert
 * gemeint war, und zugleich, dass er alt ist.
 */
'use strict';

(function () {

  // Die Zonen aus dem Register sind Geschosse — der einzige Ort, an dem beide
  // Benennungen aufeinandertreffen. `Z-SITE` fehlt bewusst: Zählerstand und
  // Wetter hängen an keinem Geschoss und gehören in den Bedienbereich.
  const ZONE_GESCHOSS = {
    'Z-UG': 'UG',
    'Z-EG': 'EG',
    'Z-OG1': 'OG-1',
    'Z-OG2': 'OG-2',
    'Z-OG3': 'OG-3',
    'Z-DACH': 'Dach',
  };

  // Die Eigenschaft, unter der das Geschoss in der Batch Table steht
  // (backend/tiling/formats/ifc.py). Fehlt sie in einem Tileset, trifft die
  // Bedingung schlicht nie zu — Cesium wirft deswegen nicht, und das Tileset
  // bleibt ungefärbt.
  const GESCHOSS_FELD = 'Geschoss';

  // Der Bereich, über den die Farbe läuft — begrenzt an den Rändern, damit ein
  // Ausreißer nicht die Skala aller übrigen Geschosse zusammenschiebt.
  //
  // Für die Raumtemperatur ist das der **Komfortbereich**, nicht der Messbereich
  // des Fühlers: von der Nachtabsenkung (18 °C) bis zum oberen Rand dessen, was
  // in einem Büro noch behaglich ist (24 °C). Eine Skala von 5 bis 40 °C wäre
  // technisch richtig und praktisch nutzlos — alle Geschosse lägen im selben
  // Farbton, und das Bild zeigte einen einfarbigen Klotz statt eines
  // Unterschieds. Wo es wirklich zu kalt oder zu warm ist, sagt der
  // Messbereich des Sensors, nicht diese Skala.
  const SKALEN = {
    raumtemperatur: { von: 18, bis: 24, einheit: '°C' },
    wirkleistung: { von: 0, bis: 30, einheit: 'kW' },
  };

  const FARBE_OHNE = '#9aa3ad';        // kein Wert bekannt
  const FARBE_AUSREISSER = '#ff00c8';  // außerhalb des Messbereichs: auffällig

  const Z = {
    aktiv: false,
    messgroesse: 'raumtemperatur',
    gestartet: false,
    neuaufbauten: 0,   // zum Nachzählen im Prüfstein
  };

  // ── Die Farbskala: eine reine Funktion ────────────────────────────────────

  function mischen(a, b, t) {
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return '#' + [r, g, bl].map((k) => k.toString(16).padStart(2, '0')).join('');
  }

  const KALT = [58, 110, 220];
  const MITTE = [235, 232, 210];
  const WARM = [214, 62, 42];

  function farbe(wert, messgroesse) {
    if (wert === null || wert === undefined || !Number.isFinite(Number(wert))) {
      return FARBE_OHNE;
    }
    const skala = SKALEN[messgroesse || Z.messgroesse] || SKALEN.raumtemperatur;
    // Begrenzen statt strecken: ein einzelner Ausreißer soll nicht die Skala
    // aller übrigen Geschosse zusammenschieben.
    const t = Math.min(1, Math.max(0, (Number(wert) - skala.von) / (skala.bis - skala.von)));
    return t < 0.5 ? mischen(KALT, MITTE, t * 2) : mischen(MITTE, WARM, (t - 0.5) * 2);
  }

  // Entsättigen, nicht ausbleichen: der Wert bleibt ablesbar, das Alter sieht
  // man trotzdem.
  function entsaettigt(hex) {
    const k = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const grau = Math.round(0.299 * k[0] + 0.587 * k[1] + 0.114 * k[2]);
    return mischen(k, [grau, grau, grau], 0.75);
  }

  // ── Was zeigt ein Geschoss? ───────────────────────────────────────────────

  function zonenwerte(messgroesse) {
    const store = (typeof window !== 'undefined' && window.SensorStore) || null;
    if (!store || typeof store.stand !== 'function') return {};
    const je = {};
    for (const s of store.stand()) {
      if (s.messgroesse !== messgroesse) continue;
      if (!ZONE_GESCHOSS[s.zone]) continue;
      (je[s.zone] || (je[s.zone] = [])).push(s);
    }
    const ergebnis = {};
    for (const zone of Object.keys(je)) {
      ergebnis[zone] = zusammenfassen(je[zone]);
    }
    return ergebnis;
  }

  // Zwei Fühler je Geschoss (Nord und Süd) ergeben einen Wert: das Mittel der
  // gesunden. Gibt es keinen gesunden, entscheidet der auffälligste Zustand —
  // ein Ausreißer ist wichtiger als ein veralteter Wert, denn er verlangt eine
  // Entscheidung.
  function zusammenfassen(sensoren) {
    const gesund = sensoren.filter((s) => s.status === 'ok' && Number.isFinite(Number(s.wert)));
    if (gesund.length) {
      const summe = gesund.reduce((a, s) => a + Number(s.wert), 0);
      return { wert: summe / gesund.length, status: 'ok', anzahl: gesund.length };
    }
    if (sensoren.some((s) => s.status === 'ausreisser')) {
      return { wert: null, status: 'ausreisser', anzahl: sensoren.length };
    }
    if (sensoren.some((s) => s.status === 'veraltet')) {
      const alt = sensoren.filter((s) => Number.isFinite(Number(s.wert)));
      const wert = alt.length ? alt.reduce((a, s) => a + Number(s.wert), 0) / alt.length : null;
      return { wert, status: 'veraltet', anzahl: sensoren.length };
    }
    return { wert: null, status: 'ohne', anzahl: sensoren.length };
  }

  // ── Der Steckplatz: Bedingungen liefern, keinen Stil setzen ───────────────

  function bedingungen(assetData) {
    if (!Z.aktiv) return [];
    // Punktwolken und Splats haben keine Batch Table: eine String-Bedingung
    // darauf wirft im Shader. `features.js` steigt ohnehin vorher aus, aber
    // dieses Modul darf sich nicht darauf verlassen.
    if (assetData && (assetData.isPointCloud
        || (assetData.tileset && assetData.tileset._isGaussianSplat))) return [];

    const werte = zonenwerte(Z.messgroesse);
    const liste = [];
    for (const zone of Object.keys(ZONE_GESCHOSS)) {
      const w = werte[zone];
      if (!w) continue;
      const geschoss = String(ZONE_GESCHOSS[zone]).replace(/'/g, "\\'");
      liste.push(['${' + GESCHOSS_FELD + "} === '" + geschoss + "'",
                  "color('" + zonenfarbe(w, Z.messgroesse) + "')"]);
    }
    return liste;
  }

  // Die Farbe, die ein Geschoss im Modell trägt — einschließlich Zustand.
  // Eigene Funktion, weil das Sensor-Panel dieselbe Farbe zeigen muss: eine
  // zweite Rechnung dort liefe früher oder später auseinander, und die Legende
  // erklärte dann eine Farbe, die das Modell nicht hat.
  function zonenfarbe(w, messgroesse) {
    if (!w) return FARBE_OHNE;
    if (w.status === 'ausreisser') return FARBE_AUSREISSER;
    if (w.status === 'ohne') return FARBE_OHNE;
    const f = farbe(w.wert, messgroesse || Z.messgroesse);
    return w.status === 'veraltet' ? entsaettigt(f) : f;
  }

  // ── Nachziehen ────────────────────────────────────────────────────────────

  function neuZeichnen() {
    Z.neuaufbauten++;
    // Ein Filterlauf baut den ganzen Stil neu — mit Hervorhebung, Sensorfarben
    // und Typfarben in einem Zug. Einen eigenen, schlankeren Weg zu gehen hieße,
    // die Zusammenführung ein zweites Mal zu schreiben.
    if (typeof window !== 'undefined' && window.BimViewer
        && typeof BimViewer.applyIFCFilter === 'function') {
      BimViewer.applyIFCFilter();
    }
  }

  function aufAenderung() {
    // Genau ein Neuaufbau je Ereignis: der Store bündelt schon, hier wird nicht
    // noch einmal je Sensor gezeichnet.
    if (Z.aktiv) neuZeichnen();
  }

  // ── Steuerung ─────────────────────────────────────────────────────────────

  function an(messgroesse) {
    if (messgroesse) Z.messgroesse = messgroesse;
    Z.aktiv = true;
    neuZeichnen();
    return API;
  }

  function aus() {
    Z.aktiv = false;
    // Derselbe Weg zurück: der Filterlauf baut den Stil ohne Sensorbedingungen
    // neu auf, und Typfarben wie Hervorhebung sind wieder zu sehen.
    neuZeichnen();
    return API;
  }

  function umschalten(messgroesse) {
    return Z.aktiv && !messgroesse ? aus() : an(messgroesse);
  }

  // ── Anlauf ────────────────────────────────────────────────────────────────

  function backendDa() {
    if (typeof window === 'undefined') return false;
    if (window.BimViewer && typeof BimViewer.getBackendUrl === 'function') {
      return !!BimViewer.getBackendUrl();
    }
    return !!(window.ILEEN_CONFIG && window.ILEEN_CONFIG.backendUrl);
  }

  function anlaufen() {
    if (Z.gestartet) return;
    // Ohne Backend passiert nichts — und zwar wortlos. Der Viewer läuft auch
    // ohne, und eine Warnung wäre hier eine Fehlmeldung.
    if (!backendDa()) return;
    if (typeof window === 'undefined' || !window.SensorStore) return;
    Z.gestartet = true;
    SensorStore.starten();
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('ileen:sensor-geaendert', aufAenderung);
    // `BimViewer.getBackendUrl` steht erst, wenn core.js gelaufen ist.
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(anlaufen, 0);
    } else {
      document.addEventListener('DOMContentLoaded', () => setTimeout(anlaufen, 0));
    }
  }

  const API = {
    an, aus, umschalten, bedingungen, farbe, zonenfarbe, anlaufen,
    ZONE_GESCHOSS, SKALEN,
    get aktiv() { return Z.aktiv; },
    get messgroesse() { return Z.messgroesse; },
    get neuaufbauten() { return Z.neuaufbauten; },
    zonenwerte: () => zonenwerte(Z.messgroesse),
  };

  if (typeof window !== 'undefined') window.SensorFarben = API;
  if (typeof globalThis !== 'undefined') globalThis.SensorFarben = API;

  console.log('🎨 Sensorfarben geladen — SensorFarben.an() färbt die Geschosse nach Messwert');
})();
