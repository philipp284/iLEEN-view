/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Licensed under BSL 1.1 (siehe clipping-planes.js).
 */

// ===============================
// SKIZZEN-ARCHIV v1.0 — abgelegte Rechnungen, Pläne und Medien
//
// Eine **Skizze** ist ein festgehaltenes Zwischenergebnis: eine GEG-Bilanz,
// ein StaLite-Stabwerk, eine Deckenrechnung, ein Planauszug, ein Foto. Sie ist
// das Zwischenformat zwischen „gerechnet" und „im Bericht" — und der Grund,
// warum es sie gibt: eine Rechnung, die nur im Werkzeug steht, ist beim
// Zusammenstellen des Bauantrags nicht mehr auffindbar.
//
// **Warum eine eigene Datenbank neben `plan-store.js`.** Das Planarchiv ist an
// eine Zeichnung gebunden: sein Kurzindex zählt `drawing.figures` und
// `annot.items`, das Panel zeigt Maßstab und Ansicht. Ein StaLite-Screenshot
// hat davon nichts. Man könnte den Datensatz um ein `typ`-Feld erweitern und
// überall Fallunterscheidungen einziehen — dann läge in einem Store zweierlei,
// und jede Auswertung müsste beides auseinanderhalten. Zwei Datenbanken sind
// hier die kleinere Änderung *und* die klarere Trennung: Zeichnungen bleiben
// Zeichnungen, Skizzen sind alles, was in einen Bericht kann.
//
// **Vier Bestandteile, die jede Skizze haben kann:**
//
//   vorschau    ein Bild als data:-URI — was man in der Liste sieht
//   kennwerte   Name/Wert/Einheit — was im Bericht als Tabelle steht
//   medien      Bilder als data:-URI — was sich auf den Plan ziehen lässt
//   daten       die Nutzlast des jeweiligen Typs (Bericht, Modell, …)
//
// Alles davon ist freiwillig. Eine Skizze ohne Medien lässt sich nicht auf den
// Plan ziehen, eine ohne Kennwerte trägt keine Tabelle bei — sie bleibt aber
// eine gültige Skizze.
//
// **Alles liegt als data:-URI, nie als Backend-Adresse.** Ein Bericht, der auf
// `http://localhost:8100/...` zeigt, ist auf dem Rechner des Prüfers leer.
// `medienHolen()` lädt deshalb beim Ablegen einmal herunter und bettet ein;
// danach ist die Skizze unabhängig davon, ob das Backend noch läuft.
// ===============================
'use strict';

(function () {

  if (!window.BimViewer) {
    console.warn('skizzen-store.js: BimViewer nicht gefunden');
    return;
  }

  var DB_NAME = 'ileen-skizzen';
  var DB_VERSION = 1;
  var STORE_VOLL = 'skizzen';
  var STORE_INDEX = 'index';

  /** Die Typen, die es gibt — Reihenfolge bestimmt die Sortierung im Bericht. */
  var TYPEN = {
    plan:    { name: 'Plan',            symbol: '▤', farbe: '#3B82F6' },
    fem:     { name: 'Statik (Platte)', symbol: '▦', farbe: '#EF4444' },
    stalite: { name: 'Statik (Stabwerk)', symbol: '⌇', farbe: '#F59E0B' },
    geg:     { name: 'Energie (GEG)',   symbol: '🌡', farbe: '#10B981' },
    medien:  { name: 'Medien',          symbol: '🖼', farbe: '#8B5CF6' },
    notiz:   { name: 'Notiz',           symbol: '✎', farbe: '#6B7280' }
  };

  var _db = null;

  function oeffnen() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (erfuellen, ablehnen) {
      if (!window.indexedDB) { ablehnen(new Error('IndexedDB steht nicht zur Verfügung')); return; }
      var anfrage = indexedDB.open(DB_NAME, DB_VERSION);
      anfrage.onupgradeneeded = function () {
        var db = anfrage.result;
        if (!db.objectStoreNames.contains(STORE_VOLL)) {
          db.createObjectStore(STORE_VOLL, { keyPath: 'schluessel' });
        }
        if (!db.objectStoreNames.contains(STORE_INDEX)) {
          db.createObjectStore(STORE_INDEX, { keyPath: 'schluessel' });
        }
      };
      anfrage.onsuccess = function () { _db = anfrage.result; erfuellen(_db); };
      anfrage.onerror = function () { ablehnen(anfrage.error); };
    });
  }

  function warten(anfrage) {
    return new Promise(function (erfuellen, ablehnen) {
      anfrage.onsuccess = function () { erfuellen(anfrage.result); };
      anfrage.onerror = function () { ablehnen(anfrage.error); };
    });
  }

  function schluesselBauen(typ) {
    return 'skizze-' + typ + '-' + Date.now().toString(36) + '-' +
           Math.random().toString(36).slice(2, 7);
  }

  BimViewer.SkizzenStore = {

    TYPEN: TYPEN,

    verfuegbar: function () { return !!window.indexedDB; },

    /**
     * Legt eine Skizze ab und gibt ihre Kurzfassung zurück.
     *
     * Ein vorhandener `schluessel` überschreibt — so wird aus „speichern" von
     * selbst „aktualisieren", ohne dass die Aufrufer zwei Wege kennen müssen.
     */
    speichern: async function (skizze) {
      if (!skizze || !skizze.typ) throw new Error('Skizze ohne Typ');
      var db = await oeffnen();

      var datensatz = Object.assign({}, skizze);
      datensatz.schluessel = datensatz.schluessel || schluesselBauen(datensatz.typ);
      datensatz.stand = Date.now();
      datensatz.titel = datensatz.titel || (TYPEN[datensatz.typ] || {}).name || 'Skizze';
      datensatz.kennwerte = datensatz.kennwerte || [];
      datensatz.medien = datensatz.medien || [];
      datensatz.anhaenge = datensatz.anhaenge || [];

      var kurz = {
        schluessel: datensatz.schluessel,
        typ: datensatz.typ,
        titel: datensatz.titel,
        jobId: datensatz.jobId || null,
        modell: datensatz.modell || '',
        stand: datensatz.stand,
        notiz: datensatz.notiz || '',
        vorschau: datensatz.vorschau || null,
        // Steht im Kurzindex und nicht nur im vollen Datensatz: Listen und das
        // Berichtstool müssen eine Vorbemessung von einem geführten Nachweis
        // unterscheiden können, ohne jede Skizze zu laden. Beides gleich
        // aussehen zu lassen wäre der Fehler, den die Trennung verhindern soll.
        nachweis: !!datensatz.nachweis,
        anhaenge: datensatz.anhaenge.length,
        // Die drei Zahlen beantworten in der Liste, was die Skizze beitragen
        // kann: ein Bild zum Ziehen, eine Tabelle, ein Bericht.
        medien: datensatz.medien.length,
        kennwerte: datensatz.kennwerte.length,
        // Die ersten drei Kennwerte stehen mit im Index — die Liste zeigt damit
        // „Qp = 24,8 kWh/(m²a)" ohne den ganzen Bericht zu laden.
        spitzenwerte: datensatz.kennwerte.slice(0, 3)
      };

      var tx = db.transaction([STORE_VOLL, STORE_INDEX], 'readwrite');
      tx.objectStore(STORE_VOLL).put(datensatz);
      tx.objectStore(STORE_INDEX).put(kurz);
      return new Promise(function (erfuellen, ablehnen) {
        tx.oncomplete = function () {
          document.dispatchEvent(new CustomEvent('ileen:skizzen-geaendert',
            { detail: { schluessel: kurz.schluessel, typ: kurz.typ } }));
          erfuellen(kurz);
        };
        tx.onerror = function () { ablehnen(tx.error); };
        tx.onabort = function () { ablehnen(tx.error); };
      });
    },

    laden: async function (schluessel) {
      try {
        var db = await oeffnen();
        return await warten(db.transaction(STORE_VOLL).objectStore(STORE_VOLL).get(schluessel));
      } catch (e) {
        console.warn('skizzen-store: nicht lesbar', e);
        return null;
      }
    },

    /**
     * Die Kurzfassungen, jüngste zuerst.
     *
     * `filter` nimmt `{typ, jobId}`. Nach dem Bauwerk zu filtern ist der
     * Regelfall: das Archiv sammelt über alle Projekte, und wer einen Bauantrag
     * für *ein* Gebäude zusammenstellt, will die Skizzen des Nachbarhauses
     * nicht sehen. Skizzen ohne Bauwerksbezug bleiben immer sichtbar — sonst
     * wären sie unerreichbar.
     */
    liste: async function (filter) {
      try {
        var db = await oeffnen();
        var alle = await warten(db.transaction(STORE_INDEX).objectStore(STORE_INDEX).getAll());
        alle = alle || [];
        if (filter && filter.typ) {
          alle = alle.filter(function (e) { return e.typ === filter.typ; });
        }
        if (filter && filter.jobId) {
          alle = alle.filter(function (e) { return !e.jobId || e.jobId === filter.jobId; });
        }
        return alle.sort(function (a, b) { return b.stand - a.stand; });
      } catch (e) {
        console.warn('skizzen-store: Liste nicht lesbar', e);
        return [];
      }
    },

    /** Mehrere Skizzen vollständig — für das Berichtstool. */
    ladenMehrere: async function (schluessel) {
      var ergebnis = [];
      for (var i = 0; i < (schluessel || []).length; i++) {
        var eine = await this.laden(schluessel[i]);
        if (eine) ergebnis.push(eine);
      }
      return ergebnis;
    },

    loeschen: async function (schluessel) {
      var db = await oeffnen();
      var tx = db.transaction([STORE_VOLL, STORE_INDEX], 'readwrite');
      tx.objectStore(STORE_VOLL).delete(schluessel);
      tx.objectStore(STORE_INDEX).delete(schluessel);
      return new Promise(function (erfuellen, ablehnen) {
        tx.oncomplete = function () {
          document.dispatchEvent(new CustomEvent('ileen:skizzen-geaendert',
            { detail: { schluessel: schluessel, geloescht: true } }));
          erfuellen();
        };
        tx.onerror = function () { ablehnen(tx.error); };
      });
    },

    leeren: async function () {
      var db = await oeffnen();
      var tx = db.transaction([STORE_VOLL, STORE_INDEX], 'readwrite');
      tx.objectStore(STORE_VOLL).clear();
      tx.objectStore(STORE_INDEX).clear();
      return new Promise(function (erfuellen) {
        tx.oncomplete = function () {
          document.dispatchEvent(new CustomEvent('ileen:skizzen-geaendert', { detail: {} }));
          erfuellen();
        };
      });
    },

    /** Was das Archiv insgesamt enthält — für die Kopfzeile des Berichtstools. */
    uebersicht: async function (jobId) {
      var alle = await this.liste(jobId ? { jobId: jobId } : null);
      var nach = {};
      alle.forEach(function (e) { nach[e.typ] = (nach[e.typ] || 0) + 1; });
      return { gesamt: alle.length, nach_typ: nach, eintraege: alle };
    },

    // ── Hilfen zum Einbetten ─────────────────────────────────────────────

    /**
     * Lädt eine Adresse und gibt sie als data:-URI zurück.
     *
     * Der Grund steht im Modulkopf: eine Skizze muss ihre Bilder selbst
     * tragen. Schlägt das Laden fehl, kommt `null` zurück und der Aufrufer
     * entscheidet — eine Skizze ohne Vorschau ist brauchbar, eine mit totem
     * Verweis nicht.
     */
    alsDatenUri: async function (adresse) {
      try {
        var antwort = await fetch(adresse);
        if (!antwort.ok) return null;
        var blob = await antwort.blob();
        return await new Promise(function (erfuellen) {
          var leser = new FileReader();
          leser.onloadend = function () { erfuellen(leser.result); };
          leser.onerror = function () { erfuellen(null); };
          leser.readAsDataURL(blob);
        });
      } catch (e) {
        console.warn('skizzen-store: ' + adresse + ' nicht ladbar', e);
        return null;
      }
    },

    /**
     * Verkleinert ein Bild auf Vorschaugröße.
     *
     * Die Vorschau steht im Kurzindex, und der wird bei jedem Öffnen einer
     * Liste vollständig gelesen. Ein Ergebnisbild in Originalgröße sind einige
     * hundert Kilobyte je Skizze — bei dreißig Skizzen läge das Archiv im
     * zweistelligen Megabytebereich, nur damit eine Liste Bilder zeigt.
     */
    vorschauBauen: function (datenUri, breite) {
      breite = breite || 320;
      return new Promise(function (erfuellen) {
        if (!datenUri) { erfuellen(null); return; }
        var bild = new Image();
        bild.onload = function () {
          try {
            var faktor = Math.min(1, breite / (bild.naturalWidth || breite));
            var leinwand = document.createElement('canvas');
            leinwand.width = Math.max(1, Math.round((bild.naturalWidth || breite) * faktor));
            leinwand.height = Math.max(1, Math.round((bild.naturalHeight || breite) * faktor));
            var stift = leinwand.getContext('2d');
            // Weiß hinterlegen: PNGs aus matplotlib sind teils transparent, und
            // auf dem dunklen Panelhintergrund wäre eine Achsenbeschriftung in
            // Schwarz sonst unsichtbar.
            stift.fillStyle = '#ffffff';
            stift.fillRect(0, 0, leinwand.width, leinwand.height);
            stift.drawImage(bild, 0, 0, leinwand.width, leinwand.height);
            erfuellen(leinwand.toDataURL('image/jpeg', 0.82));
          } catch (e) {
            erfuellen(datenUri);   // lieber groß als gar nicht
          }
        };
        bild.onerror = function () { erfuellen(null); };
        bild.src = datenUri;
      });
    },

    /** Eine Datei vom Rechner als data:-URI — für „Skizze zurückholen". */
    dateiLesen: function (datei) {
      return new Promise(function (erfuellen, ablehnen) {
        var leser = new FileReader();
        leser.onloadend = function () { erfuellen(leser.result); };
        leser.onerror = function () { ablehnen(leser.error); };
        leser.readAsDataURL(datei);
      });
    },

    dateiText: function (datei) {
      return new Promise(function (erfuellen, ablehnen) {
        var leser = new FileReader();
        leser.onloadend = function () { erfuellen(leser.result); };
        leser.onerror = function () { ablehnen(leser.error); };
        leser.readAsText(datei);
      });
    },

    /** Wie groß eine Skizze ungefähr ist — für die Anzeige im Archiv. */
    umfang: function (skizze) {
      var bytes = 0;
      (skizze.medien || []).forEach(function (m) { bytes += (m.daten || '').length; });
      (skizze.anhaenge || []).forEach(function (m) { bytes += (m.daten || '').length; });
      bytes += (skizze.vorschau || '').length;
      try { bytes += JSON.stringify(skizze.daten || {}).length; } catch (e) { /* egal */ }
      return bytes;
    },

    lesbareGroesse: function (bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' kB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }
  };

  console.log('🗂 Skizzen-Archiv geladen');
})();
