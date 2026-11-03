/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// NUTZUNG — was geladen und getan wird, fürs Protokoll im Backend
//
// Philipp will auswerten können, welche Modelle er lädt und wie er mit iLEEN
// umgeht (2026-10-19), damit sich daraus lernen lässt, was oft gebraucht
// wird und was im Weg steht. Dafür ein schmales Ereignisprotokoll:
//
//   sitzung_start · sitzung_ende   Fenstergröße, Dauer
//   modell_geladen · modell_entfernt   jobId/assetId, Name, Typ, Ladezeit, ok
//   bereich · gruppe               welches Menü links aufgeschlagen wurde
//   taste                          Tastenkürzel (tastenkuerzel.js), an/aus
//   werkzeug                       Explosion, Messen, Räume an/aus
//   auswahl                        IFC-Typ eines angeklickten Bauteils
//   vorlage_*                      gespeichert, geladen, gelöscht (vorlagen.js)
//   fehler                         unbehandelte Fehler im Viewer (höchstens 20)
//
// **Kein Inhalt:** keine Koordinaten, keine Texte aus Feldern, keine Notizen,
// keine Eigenschaften von Bauteilen — Namen von Modellen, Menüs, Werkzeugen
// und Tasten genügen für die Frage, wie gearbeitet wird.
//
// Gesammelt im Browser, alle 15 s oder ab 25 Ereignissen in einem Rutsch an
// `POST /nutzung/ereignisse`; beim Verlassen der Seite per `sendBeacon` als
// `text/plain` (siehe backend/api/routes/nutzung.py, warum). Ohne Backend
// bleibt das Protokoll in der Schlange und geht beim Schließen verloren —
// was es nicht verlieren darf, die zuletzt geladenen Modelle, steht
// zusätzlich im localStorage.
//
// Dieselbe Datei in beiden Fassungen: sie meldet nur, was es gibt.
// ===============================
'use strict';

(function () {

  var B = window.BimViewer = window.BimViewer || {};

  var SITZUNG = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var FASSUNG = /view/i.test(document.title || '') ? 'iLEEN-view' : 'iLEEN';
  var ZULETZT_SCHLUESSEL = 'ileen_zuletzt_geladen';
  var AUS_SCHLUESSEL = 'ileen_nutzung_aus';

  var schlange = [];
  var timer = null;
  var fehlerZahl = 0;
  var beginn = Date.now();

  /** Abschaltbar: `BimViewer.Nutzung.aus(true)` — bleibt im Browser gemerkt. */
  function abgeschaltet() {
    try { return localStorage.getItem(AUS_SCHLUESSEL) === '1'; } catch (e) { return false; }
  }

  function basis() {
    try { return (B.getBackendUrl && B.getBackendUrl()) || ''; } catch (e) { return ''; }
  }

  function melden(art, daten) {
    if (!art || abgeschaltet()) return;
    schlange.push({ art: String(art), zeit: new Date().toISOString(), daten: daten || {} });
    if (schlange.length >= 25) senden();
    else if (!timer) timer = setTimeout(senden, 15000);
  }

  function paket(ereignisse) {
    return JSON.stringify({ sitzung: SITZUNG, fassung: FASSUNG, ereignisse: ereignisse });
  }

  function senden() {
    clearTimeout(timer);
    timer = null;
    var url = basis();
    if (!url || !schlange.length) return;
    var teil = schlange.splice(0, 400);
    fetch(url + '/nutzung/ereignisse', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: paket(teil), keepalive: true
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
    }).catch(function () {
      // Zurück in die Schlange, aber nicht endlos: ein Backend, das nie
      // antwortet, soll den Speicher nicht volllaufen lassen.
      schlange = teil.concat(schlange).slice(-1000);
    });
  }

  function beimVerlassen() {
    melden('sitzung_ende', { sekunden: Math.round((Date.now() - beginn) / 1000) });
    var url = basis();
    if (!url || !schlange.length) return;
    var teil = schlange.splice(0, 400);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url + '/nutzung/ereignisse', paket(teil))) return;
    } catch (e) { /* unten weiter */ }
    try {
      fetch(url + '/nutzung/ereignisse', { method: 'POST', headers: { 'Content-Type': 'text/plain' },
                                            body: paket(teil), keepalive: true });
    } catch (e) { /* verloren */ }
  }

  // ── Zuletzt geladene Modelle ─────────────────────────────────────────────
  //
  // Für die Modellliste: wer zuletzt geladen wurde, steht oben. Lokal sofort,
  // dazu beim Start der Stand aus dem Backend — so stimmt die Reihenfolge
  // auch auf einem anderen Rechner.

  var zuletzt = {};   // Schlüssel (jobId oder ion:<id>) → Zeitpunkt in ms

  function zuletztLesen() {
    try {
      var roh = JSON.parse(localStorage.getItem(ZULETZT_SCHLUESSEL) || '{}');
      if (roh && typeof roh === 'object') zuletzt = roh;
    } catch (e) { zuletzt = {}; }
  }

  function zuletztMerken(schluessel, zeit) {
    if (!schluessel) return;
    var t = zeit || Date.now();
    if ((zuletzt[schluessel] || 0) >= t) return;
    zuletzt[schluessel] = t;
    // Nur die letzten hundert — älter interessiert in keiner Liste mehr.
    var liste = Object.keys(zuletzt).sort(function (a, b) { return zuletzt[b] - zuletzt[a]; });
    liste.slice(100).forEach(function (k) { delete zuletzt[k]; });
    try { localStorage.setItem(ZULETZT_SCHLUESSEL, JSON.stringify(zuletzt)); } catch (e) { /* privat */ }
  }

  function listeNeuZeichnen() {
    var UI = window.BimViewerUI;
    if (UI && typeof UI.renderBackendAssets === 'function' && UI.backendAssets) {
      try { UI.renderBackendAssets(); } catch (e) { /* Panel nicht offen */ }
    }
  }

  function zuletztAusBackend() {
    var url = basis();
    if (!url) return;
    fetch(url + '/nutzung/zuletzt?n=100').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (antwort) {
        if (!antwort || !Array.isArray(antwort.modelle)) return;
        antwort.modelle.forEach(function (m) {
          var k = m.jobId || (m.assetId ? 'ion:' + m.assetId : null);
          var t = Date.parse(m.zuletzt);
          if (k && isFinite(t)) zuletztMerken(k, t);
        });
        listeNeuZeichnen();
      }).catch(function () { /* ohne Backend bleibt die lokale Liste */ });
  }

  // ── Modelle laden und entfernen ──────────────────────────────────────────

  function backendTyp(jobId) {
    var liste = (window.BimViewerUI && BimViewerUI.backendAssets) || [];
    for (var i = 0; i < liste.length; i++) if (liste[i].job_id === jobId) return liste[i];
    return null;
  }

  function hatModell(passt) {
    var ja = false;
    if (B.loadedAssets) B.loadedAssets.forEach(function (a) { if (!ja && passt(a)) ja = true; });
    return ja;
  }

  /**
   * Eine Ladefunktion aus core.js umhüllen. Die Ladefunktionen fangen ihre
   * Fehler selbst und melden sie nur in der Statuszeile — ob geladen wurde,
   * zeigt deshalb erst die Zahl der Modelle danach.
   */
  function umhuellen(name, beschreiben) {
    var alt = B[name];
    if (typeof alt !== 'function' || alt._nutzung) return;
    var neu = function () {
      var args = arguments;
      var info = beschreiben.apply(null, args);
      if (info.schonDa) return alt.apply(this, args);
      var vorher = B.loadedAssets ? B.loadedAssets.size : 0;
      var t0 = performance.now();
      var ende = function (ok) {
        var nachher = B.loadedAssets ? B.loadedAssets.size : 0;
        var geladen = ok && nachher > vorher;
        melden('modell_geladen', Object.assign({}, info.daten, {
          ms: Math.round(performance.now() - t0), ok: geladen
        }));
        if (geladen) { zuletztMerken(info.schluessel); listeNeuZeichnen(); }
      };
      var r;
      try { r = alt.apply(this, args); }
      catch (e) { ende(false); throw e; }
      if (r && typeof r.then === 'function') {
        return r.then(function (w) { ende(true); return w; }, function (e) { ende(false); throw e; });
      }
      ende(true);
      return r;
    };
    neu._nutzung = true;
    B[name] = neu;
  }

  function ladenBeobachten() {
    umhuellen('loadBackendAsset', function (jobId, name) {
      var eintrag = backendTyp(jobId);
      return {
        schonDa: hatModell(function (a) { return a.jobId === jobId; }),
        schluessel: jobId,
        daten: { quelle: 'backend', jobId: jobId, name: name || (eintrag && eintrag.name) || null,
                 typ: eintrag ? eintrag.content_type : null }
      };
    });
    umhuellen('loadSelectedAsset', function (assetId, name) {
      return {
        schonDa: B.loadedAssets && B.loadedAssets.has(String(assetId)),
        schluessel: 'ion:' + assetId,
        daten: { quelle: 'ion', assetId: String(assetId), name: name || null }
      };
    });
    umhuellen('loadBackendAssetByUrl', function (url, name) {
      // Nur die Kennung aus dem Pfad, keine fremde Adresse ins Protokoll.
      var job = /\/tiles\/([^/]+)\/tileset\.json/.exec(String(url || ''));
      return {
        schonDa: hatModell(function (a) { return a.url === url; }),
        schluessel: job ? job[1] : null,
        daten: { quelle: 'url', jobId: job ? job[1] : null, name: name || null }
      };
    });

    var entladen = B.unloadAsset;
    if (typeof entladen === 'function' && !entladen._nutzung) {
      B.unloadAsset = function (assetId) {
        var a = B._asset ? B._asset(assetId) : null;
        if (a) melden('modell_entfernt', { jobId: a.jobId || null, name: a.name || null });
        return entladen.apply(this, arguments);
      };
      B.unloadAsset._nutzung = true;
    }
  }

  // ── Menüs, Werkzeuge, Auswahl ────────────────────────────────────────────

  function menuesBeobachten() {
    var UI = window.BimViewerUI;
    if (UI && typeof UI.activateSection === 'function' && !UI.activateSection._nutzung) {
      var alt = UI.activateSection;
      UI.activateSection = function (id) {
        var r = alt.apply(this, arguments);
        // Nur das Öffnen zählt; ein zweiter Klick klappt zu.
        var ziel = (this.SECTION_ALIASES && this.SECTION_ALIASES[id]) ? this.SECTION_ALIASES[id].section : id;
        var knopf = document.querySelector('.activity-btn[data-section="' + ziel + '"]');
        if (knopf && knopf.classList.contains('active')) melden('bereich', { id: String(ziel) });
        return r;
      };
      UI.activateSection._nutzung = true;
    }

    // Untergruppen: `toggle` steigt nicht auf — deshalb die Erfassungsphase.
    document.addEventListener('toggle', function (ev) {
      var el = ev.target;
      if (!(el instanceof HTMLDetailsElement) || !el.open) return;
      if (!el.matches('details.panel-group') || !el.id) return;
      melden('gruppe', { key: el.id.replace(/^group-/, '') });
    }, true);

    var explosionAn = null;
    document.addEventListener('ileen:explosion', function (ev) {
      var an = !!(ev.detail && ev.detail.aktiv);
      if (explosionAn !== null && an !== explosionAn) melden('werkzeug', { name: 'explosion', an: an });
      explosionAn = an;
    });

    document.addEventListener('ileen:auswahl', function (ev) {
      var d = ev.detail;
      if (d && d.ifcType) melden('auswahl', { ifcType: d.ifcType, jobId: d.modell ? d.modell.jobId : null });
    });

    // Messen und Räume schalten nicht über ein Ereignis — beide haben einen
    // eigenen Ein-/Ausschalter, der hier umhüllt wird.
    werkzeugUmhuellen(B.Aufmass, 'umschalten', 'messen', function () { return !!(B.Aufmass && B.Aufmass.laeuft); });
    if (window.RoomConcept) {
      werkzeugUmhuellen(RoomConcept, 'anzeigen', 'raeume', function () { return !!RoomConcept.sichtbar; });
      werkzeugUmhuellen(RoomConcept, 'ausblenden', 'raeume', function () { return !!RoomConcept.sichtbar; });
    }
  }

  function werkzeugUmhuellen(objekt, methode, name, istAn) {
    if (!objekt || typeof objekt[methode] !== 'function' || objekt[methode]._nutzung) return;
    var alt = objekt[methode];
    objekt[methode] = function () {
      var vorher = istAn();
      var r = alt.apply(this, arguments);
      var melde = function () { var an = istAn(); if (an !== vorher) melden('werkzeug', { name: name, an: an }); };
      if (r && typeof r.then === 'function') r.then(melde, function () {});
      else melde();
      return r;
    };
    objekt[methode]._nutzung = true;
  }

  function fehlerBeobachten() {
    window.addEventListener('error', function (ev) {
      if (++fehlerZahl > 20) return;
      melden('fehler', {
        meldung: String(ev.message || '').slice(0, 200),
        datei: String(ev.filename || '').split('/').pop().slice(0, 60),
        zeile: ev.lineno || null
      });
    });
  }

  // ── Start ────────────────────────────────────────────────────────────────

  function start() {
    zuletztLesen();
    ladenBeobachten();
    fehlerBeobachten();
    window.addEventListener('pagehide', beimVerlassen);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') senden();
    });
    // Menüs und Werkzeuge erst, wenn die Oberfläche steht.
    window.addEventListener('load', function () {
      setTimeout(function () {
        menuesBeobachten();
        zuletztAusBackend();
        melden('sitzung_start', {
          breite: window.innerWidth, hoehe: window.innerHeight,
          sprache: document.documentElement.lang || navigator.language || null
        });
      }, 1500);
    });
  }

  B.Nutzung = {
    melden: melden,
    senden: senden,
    sitzung: SITZUNG,
    /** Zeitpunkt (ms), zu dem ein Modell zuletzt geladen wurde, oder 0. */
    zuletztGeladen: function (schluessel) { return zuletzt[schluessel] || 0; },
    /** Das Protokoll in diesem Browser ab- (true) oder wieder einschalten. */
    aus: function (an) {
      try { localStorage.setItem(AUS_SCHLUESSEL, an === false ? '0' : '1'); } catch (e) { /* privat */ }
      if (an !== false) schlange = [];
      return abgeschaltet();
    },
    /** Die Auswertung des Backends (dieselbe wie GET /nutzung/auswertung). */
    auswertung: function (tage) {
      var url = basis();
      if (!url) return Promise.resolve(null);
      return fetch(url + '/nutzung/auswertung?tage=' + (tage || 30)).then(function (r) { return r.ok ? r.json() : null; });
    },
    _schlange: function () { return schlange.slice(); }
  };

  start();
})();
