/**
 * iLEEN — Brücke zu gaeco: der Viewer als Modul im gaeco Plugin Host
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Läuft iLEEN in einem <iframe> des gaeco-Moduls (iLEEN/gaeco/modul/), spricht
 * diese Datei mit dem Rahmen darum. Allein geöffnet tut sie nichts.
 *
 *   iLEEN (dieses Fenster)                 gaeco-Modul (window.parent)
 *   ──────────────────────                 ───────────────────────────
 *   bereit         ───────────────────▶    (sieht: der Viewer steht)
 *                  ◀───────────────────    hallo        {gastgeber, useCase}
 *   bereit         ───────────────────▶    (jetzt mit geprüftem Origin)
 *   auswahl        ───────────────────▶    Instanz in gaeco nachschlagen
 *   modelle        ───────────────────▶    Liste neben dem Export-Knopf
 *                  ◀───────────────────    hervorheben / anfliegen / zeigen
 *                  ◀───────────────────    modell-laden / *-abfragen
 *   antwort        ───────────────────▶    (zu jeder Anfrage mit `id`)
 *
 * Jede Nachricht ist ein Umschlag
 *   { protokoll: 'ileen-gaeco', version: 1, art, id?, daten }
 * Die vollständige Beschreibung steht in GAECO-INTEGRATION.md, Abschnitt
 * „Das Nachrichtenprotokoll".
 *
 * Wem wird geglaubt
 * =================
 * Eine Nachricht zählt nur, wenn sie **vom eigenen Elternfenster** kommt
 * (`event.source === window.parent`) **und** dessen Origin in
 * `ILEEN_CONFIG.gaecoOrigins` steht (Vorgabe: der lokale Plugin Host,
 * http://localhost:5000). Ohne die zweite Prüfung könnte jede Seite, die
 * iLEEN in einen Rahmen lädt, den Viewer fernsteuern und die Auswahl
 * mitlesen.
 *
 * Deshalb geht vor dem Handschlag nur `bereit` hinaus, und zwar ohne Inhalt
 * und an `'*'` — der Viewer weiß zu diesem Zeitpunkt nicht, wer ihn einbettet.
 * Alles danach geht ausschließlich an den geprüften Origin.
 *
 * Wovon sie lebt
 * ==============
 * Sie überschreibt nichts. Die Auswahl kommt als `ileen:auswahl` aus
 * features.js, die Modellliste als `ileen:modelle` aus core.js; geflogen wird
 * über BimViewer.bauteilAnfliegen(), hervorgehoben über
 * BimViewer.highlightIFCElements(). Damit gehört die Datei zum Viewer und
 * geht unverändert nach iLEEN-view.
 */
'use strict';

(function () {
  const PROTOKOLL = 'ileen-gaeco';
  const VERSION = 1;
  const VORGABE_ORIGINS = ['http://localhost:5000'];

  const eingebettet = (function () {
    try { return window.parent && window.parent !== window; } catch (e) { return true; }
  })();

  const Z = {
    origin: null,          // geprüfter Origin des Gastgebers, erst nach `hallo`
    gastgeber: null,       // was `hallo` mitgebracht hat
    auswahl: null,         // die zuletzt gemeldete Auswahl
    modelle: [],
  };

  function erlaubteOrigins() {
    const konfig = window.ILEEN_CONFIG && window.ILEEN_CONFIG.gaecoOrigins;
    let liste = Array.isArray(konfig) && konfig.length ? konfig : VORGABE_ORIGINS;
    // Zur Laufzeit erweiterbar, ohne config.js anzufassen — etwa wenn gaeco
    // auf einem anderen Rechner läuft als der Viewer.
    try {
      const extra = localStorage.getItem('ileen_gaeco_origins');
      if (extra) liste = liste.concat(extra.split(',').map((s) => s.trim()).filter(Boolean));
    } catch (e) { /* privates Fenster */ }
    return liste.map((o) => o.replace(/\/+$/, ''));
  }

  function umschlag(art, daten, id) {
    const n = { protokoll: PROTOKOLL, version: VERSION, art: art, daten: daten === undefined ? null : daten };
    if (id !== undefined && id !== null) n.id = id;
    return n;
  }

  function senden(art, daten, id) {
    if (!eingebettet || !Z.origin) return;
    window.parent.postMessage(umschlag(art, daten, id), Z.origin);
  }

  function bereitMelden(zielOrigin) {
    if (!eingebettet) return;
    window.parent.postMessage(umschlag('bereit', zielOrigin === '*' ? null : {
      viewer: document.title || 'iLEEN',
      faehigkeiten: Object.keys(BEFEHLE),
    }), zielOrigin);
  }

  // Strukturierte Kopie verträgt keine Funktionen und keine zyklischen
  // Objekte. Die Batch Table liefert nur Zahlen und Zeichenketten, aber ein
  // Fremdexporteur könnte etwas anderes hineinschreiben — dann lieber
  // auslassen als die ganze Nachricht verlieren.
  function flach(eigenschaften) {
    const aus = {};
    Object.keys(eigenschaften || {}).forEach((k) => {
      const v = eigenschaften[k];
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) aus[k] = v;
    });
    return aus;
  }

  function auswahlDaten(beschreibung) {
    if (!beschreibung) return null;
    return {
      globalId: beschreibung.globalId, ifcType: beschreibung.ifcType,
      name: beschreibung.name, geschoss: beschreibung.geschoss,
      modell: beschreibung.modell, eigenschaften: flach(beschreibung.eigenschaften),
    };
  }

  // ── Befehle des Gastgebers ──────────────────────────────────────────────
  //
  // Jeder Befehl gibt ein Ergebnis zurück (oder ein Promise darauf). Trägt die
  // Nachricht eine `id`, geht das Ergebnis als `antwort` mit derselben `id`
  // zurück — so kann der Gastgeber auf „geladen" oder „nicht gefunden"
  // warten, statt zu raten.
  const BEFEHLE = {
    'hervorheben': async function (d) {
      const ids = (d && d.globalIds) || [];
      const treffer = await BimViewer.highlightIFCElements(ids, d && d.farbe ? { farbe: d.farbe } : undefined);
      return { treffer: treffer, anzahl: ids.length };
    },
    'anfliegen': async function (d) {
      const modell = await BimViewer.bauteilAnfliegen(d && d.globalId);
      return { gefunden: !!modell, modell: modell };
    },
    // Hervorheben und hinfliegen in einem — der Normalfall, wenn im
    // gaeco-Panel eine Instanz angeklickt wird.
    'zeigen': async function (d) {
      const gid = d && d.globalId;
      await BimViewer.highlightIFCElements(gid ? [gid] : [], d && d.farbe ? { farbe: d.farbe } : undefined);
      const modell = await BimViewer.bauteilAnfliegen(gid);
      return { gefunden: !!modell, modell: modell };
    },
    'hervorhebung-aufheben': async function () {
      await BimViewer.clearIFCHighlight();
      return {};
    },
    'modell-laden': async function (d) {
      if (!d || !d.jobId) throw new Error('jobId fehlt');
      const schluessel = 'backend_' + d.jobId;
      if (!BimViewer.loadedAssets.has(schluessel)) {
        await BimViewer.loadBackendAsset(d.jobId, d.name || null);
      }
      if (!BimViewer.loadedAssets.has(schluessel)) throw new Error('Modell ' + d.jobId + ' ließ sich nicht laden');
      if (d.anfliegen !== false) BimViewer.zoomToAsset(schluessel);
      return { schluessel: schluessel };
    },
    'modelle-abfragen': function () { return Z.modelle; },
    'auswahl-abfragen': function () { return auswahlDaten(Z.auswahl); },
  };

  async function befehlAusfuehren(n) {
    const befehl = BEFEHLE[n.art];
    if (!befehl) {
      if (n.id) senden('antwort', { ok: false, fehler: 'Unbekannte Anfrage: ' + n.art }, n.id);
      return;
    }
    try {
      const ergebnis = await befehl(n.daten || {});
      if (n.id) senden('antwort', { ok: true, ergebnis: ergebnis === undefined ? null : ergebnis }, n.id);
    } catch (e) {
      console.warn('gaeco-Brücke: ' + n.art + ' gescheitert:', e);
      if (n.id) senden('antwort', { ok: false, fehler: String(e && e.message || e) }, n.id);
    }
  }

  // Der Viewer wird erst im `load`-Handler von index.html angelegt, und das
  // asynchron. Ein `hallo`, das vorher eintrifft, wird nicht verworfen,
  // sondern wartet — sonst liefe ein `modell-laden` des Gastgebers gegen
  // einen Viewer, den es noch nicht gibt.
  let viewerWarten = null;
  function viewerBereit() {
    if (!viewerWarten) {
      viewerWarten = new Promise((fertig) => {
        const schauen = () => {
          if (BimViewer.viewer && BimViewer.viewer.scene) fertig();
          else setTimeout(schauen, 200);
        };
        schauen();
      });
    }
    return viewerWarten;
  }

  async function empfangen(ereignis) {
    if (ereignis.source !== window.parent) return;
    const n = ereignis.data;
    if (!n || n.protokoll !== PROTOKOLL) return;
    const origin = String(ereignis.origin || '').replace(/\/+$/, '');
    if (!erlaubteOrigins().includes(origin)) {
      console.warn('gaeco-Brücke: Nachricht von nicht zugelassenem Origin verworfen:', origin,
        '— zulassen über ILEEN_CONFIG.gaecoOrigins oder localStorage.ileen_gaeco_origins');
      return;
    }
    if (n.version !== VERSION) {
      console.warn('gaeco-Brücke: Protokollversion ' + n.version + ' statt ' + VERSION + ' — verworfen');
      return;
    }
    await viewerBereit();

    if (n.art === 'hallo') {
      const neu = Z.origin !== origin;
      Z.origin = origin;
      Z.gastgeber = n.daten || {};
      document.body.classList.add('ileen-in-gaeco');
      bereitMelden(origin);
      // Den Stand gleich mitschicken: der Gastgeber kann neu geladen worden
      // sein, während hier schon Modelle lagen und ein Bauteil gewählt war.
      senden('modelle', Z.modelle);
      if (Z.auswahl) senden('auswahl', auswahlDaten(Z.auswahl));
      if (neu && typeof BimViewer.updateStatus === 'function') {
        BimViewer.updateStatus('🔗 Mit gaeco verbunden', 'success');
      }
      return;
    }
    if (!Z.origin) return;   // vor dem Handschlag wird nichts ausgeführt
    befehlAusfuehren(n);
  }

  function starten() {
    if (!eingebettet) return;
    if (typeof BimViewer === 'undefined') {
      console.error('gaeco-bruecke.js: core.js muss vorher geladen sein');
      return;
    }
    window.addEventListener('message', empfangen);
    document.addEventListener('ileen:auswahl', (e) => {
      Z.auswahl = e.detail || null;
      senden('auswahl', auswahlDaten(Z.auswahl));
    });
    document.addEventListener('ileen:modelle', (e) => {
      Z.modelle = Array.isArray(e.detail) ? e.detail : [];
      senden('modelle', Z.modelle);
    });
    viewerBereit().then(() => { if (!Z.origin) bereitMelden('*'); });
  }

  window.ILeenGaecoBruecke = {
    get eingebettet() { return eingebettet; },
    get verbunden() { return !!Z.origin; },
    get gastgeber() { return Z.gastgeber; },
    erlaubteOrigins: erlaubteOrigins,
    PROTOKOLL: PROTOKOLL,
    VERSION: VERSION,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', starten);
  else starten();
})();
