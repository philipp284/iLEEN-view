/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// SORTIERT-PANEL — Untergruppe „Bauteile sortiert" im Bereich 📷 Ansicht
//
// Wie die Explosion eine Art, das Haus anzusehen: nichts am Modell ändert sich,
// es kommt eine zweite Ansicht daneben. Deshalb steht die Gruppe bei der
// Ansicht, hinter „Explosion", und nicht bei den Werkzeugen.
//
// Die Leiste baut sich bei jeder Anmeldung eines anderen Werkzeugs neu auf
// (siehe praesentation-panel.js). Das Gerüst aus `markup()` ist deshalb leer;
// alles, was zu sehen ist, füllt `aktualisieren()` aus dem Zustand dieses
// Objekts. Auswahl und Einstellungen leben hier, nicht im DOM.
// ===============================
'use strict';

(function () {

  var ID = 'sortiert';

  var GRUPPEN = [['typname', 'Typ und Typname'], ['typ', 'nur Typ'], ['geschoss', 'Geschoss']];
  var SORTIERUNGEN = [['breite', 'Breite'], ['hoehe', 'Höhe'], ['name', 'Name'], ['geschoss', 'Geschoss']];

  function S() { return BimViewer.Sortiert; }
  function $(id) { return document.getElementById(id); }
  function esc(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var P = window.SortiertPanel = {

    modell: null,            // jobId des gewählten Hauses
    typen: [],               // [{ifc_type, bezeichnung, anzahl}] des gewählten Hauses
    gewaehlt: {},            // ifc_type → true
    gruppe: 'typname',
    sortierung: 'breite',
    abstand: 0.8,
    status: '',
    statusArt: '',
    laeuft: false,
    _typenJob: null,
    _geholt: {},             // jobId → Typenliste

    // ── Gerüst ──────────────────────────────────────────────────────────

    markup: function () {
      return '' +
        '<div class="so" id="soPanel">' +
          '<div class="plan-hint">Bauteile eines Typs freigestellt nebeneinander, nach Typ und Größe geordnet — ' +
            'wie die Asset-Ansicht in Autodesk Tandem. Es entsteht ein eigenes Modell neben dem Haus; ' +
            'das Haus selbst bleibt, wie es ist.</div>' +

          '<div class="section">' +
            '<div class="section__label">Haus</div>' +
            '<select class="select" id="soModell" onchange="SortiertPanel.modellWaehlen(this.value)"></select>' +
          '</div>' +

          '<div class="section">' +
            '<div class="section__label">Welche Bauteile</div>' +
            '<div class="so-schnell" id="soSchnell"></div>' +
            '<div class="so-typen" id="soTypen"></div>' +
          '</div>' +

          '<div class="section">' +
            '<div class="section__label">Ordnung</div>' +
            '<div class="row"><span class="row__label">Gruppieren nach</span>' +
              '<select class="select so-kurz" id="soGruppe" onchange="SortiertPanel.setzen(\'gruppe\', this.value)"></select></div>' +
            '<div class="row"><span class="row__label">Sortieren nach</span>' +
              '<select class="select so-kurz" id="soSort" onchange="SortiertPanel.setzen(\'sortierung\', this.value)"></select></div>' +
            '<div class="row"><span class="row__label">Abstand</span>' +
              '<input type="number" class="input input--num" id="soAbstand" min="0.1" max="5" step="0.1" ' +
                     'onchange="SortiertPanel.setzen(\'abstand\', this.value)"><span class="unit">m</span></div>' +
          '</div>' +

          '<div class="section">' +
            '<button class="btn btn--primary btn--sm" type="button" id="soStart" onclick="SortiertPanel.anzeigen()">Sortiert anzeigen</button>' +
            '<div class="so-status" id="soStatus" role="status"></div>' +
          '</div>' +

          '<div class="section" id="soErgebnis" hidden>' +
            '<div class="section__label">Ansicht</div>' +
            '<div class="so-zahlen" id="soZahlen"></div>' +
            '<div class="so-knoepfe">' +
              '<button class="btn btn--sm" type="button" onclick="SortiertPanel.hin()">Zur Ansicht</button>' +
              '<button class="btn btn--sm" type="button" onclick="SortiertPanel.zumHaus()">Zum Haus</button>' +
              '<button class="btn btn--sm btn--ghost" type="button" onclick="SortiertPanel.weg()">Entfernen</button>' +
            '</div>' +
            '<div class="row"><span class="row__label">Gruppen beschriften</span>' +
              '<label class="switch"><input type="checkbox" id="soBeschriften" onchange="SortiertPanel.beschriftung(this.checked)">' +
              '<span class="switch__track"></span></label></div>' +
            '<div class="plan-hint">Ein Klick auf ein Bauteil zeigt dieselben Eigenschaften wie im Haus. ' +
              'Das sortierte Modell steht auch in der Modellliste und lässt sich dort ausblenden.</div>' +
          '</div>' +
        '</div>';
    },

    // ── Zustand → Oberfläche ────────────────────────────────────────────

    aktualisieren: function () {
      if (!$('soPanel') || !S()) return;
      var modelle = S().modelle();

      var sel = $('soModell');
      if (!modelle.some(function (m) { return m.jobId === P.modell; })) P.modell = modelle.length ? modelle[modelle.length - 1].jobId : null;
      sel.innerHTML = modelle.length
        ? modelle.map(function (m) {
            return '<option value="' + esc(m.jobId) + '"' + (m.jobId === P.modell ? ' selected' : '') + '>' + esc(m.name) + '</option>';
          }).join('')
        : '<option value="">— kein Modell aus dem Backend geladen —</option>';

      if (P.modell && P._typenJob !== P.modell) P._typenHolen(P.modell);

      $('soSchnell').innerHTML = S().SCHNELLWAHL.map(function (w, i) {
        var da = w[1].some(function (t) { return P.typen.some(function (x) { return x.ifc_type === t; }); });
        return '<button type="button" class="so-chip" ' + (da ? '' : 'disabled ') +
               'onclick="SortiertPanel.schnell(' + i + ')">' + esc(w[0]) + '</button>';
      }).join('');

      $('soTypen').innerHTML = P.typen.length
        ? P.typen.map(function (t) {
            return '<label class="so-typ"><input type="checkbox" ' + (P.gewaehlt[t.ifc_type] ? 'checked ' : '') +
                   'onchange="SortiertPanel.typ(\'' + esc(t.ifc_type) + '\', this.checked)">' +
                   '<span>' + esc(t.bezeichnung) + '</span><b>' + t.anzahl + '</b></label>';
          }).join('')
        : '<div class="so-leer">' + (P.modell ? 'Typen werden gelesen …' : 'Erst ein Modell laden.') + '</div>';

      $('soGruppe').innerHTML = GRUPPEN.map(function (g) {
        return '<option value="' + g[0] + '"' + (g[0] === P.gruppe ? ' selected' : '') + '>' + g[1] + '</option>';
      }).join('');
      $('soSort').innerHTML = SORTIERUNGEN.map(function (g) {
        return '<option value="' + g[0] + '"' + (g[0] === P.sortierung ? ' selected' : '') + '>' + g[1] + '</option>';
      }).join('');
      $('soAbstand').value = P.abstand;

      var gewaehlt = Object.keys(P.gewaehlt).filter(function (k) { return P.gewaehlt[k]; });
      $('soStart').disabled = P.laeuft || !P.modell || !gewaehlt.length;
      var st = $('soStatus');
      st.textContent = P.status;
      st.className = 'so-status' + (P.statusArt ? ' so-status--' + P.statusArt : '');

      var a = S().ansicht;
      $('soErgebnis').hidden = !a;
      if (a) {
        var b = a.bericht;
        $('soZahlen').innerHTML =
          '<b>' + b.elemente + '</b> Bauteile in <b>' + (b.gruppen || []).length + '</b> Gruppen' +
          (b.abgeschnitten ? '<div class="so-warn">Es gibt ' + b.gefunden + ' — gezeigt werden die ersten ' + b.elemente + '.</div>' : '');
        $('soBeschriften').checked = S().beschriften;
      }
    },

    _typenHolen: function (jobId) {
      P._typenJob = jobId;
      var fertig = function (liste) {
        if (P.modell !== jobId) return;
        P.typen = liste;
        // Vorwahl: Türen, sonst der häufigste Typ — ein leeres Panel lädt zu nichts ein.
        var gewaehlt = Object.keys(P.gewaehlt).some(function (k) { return P.gewaehlt[k] && liste.some(function (t) { return t.ifc_type === k; }); });
        if (!gewaehlt) {
          P.gewaehlt = {};
          var tuer = liste.filter(function (t) { return t.ifc_type === 'IfcDoor'; })[0] || liste[0];
          if (tuer) P.gewaehlt[tuer.ifc_type] = true;
        }
        P.aktualisieren();
      };
      if (P._geholt[jobId]) { fertig(P._geholt[jobId]); return; }
      P.typen = [];
      S().typen(jobId).then(function (liste) { P._geholt[jobId] = liste; fertig(liste); })
        .catch(function (e) {
          if (P.modell !== jobId) return;
          P.status = 'Die Typen ließen sich nicht lesen: ' + e.message; P.statusArt = 'error';
          P._typenJob = null; P.aktualisieren();
        });
    },

    // ── Bedienung ───────────────────────────────────────────────────────

    modellWaehlen: function (jobId) { P.modell = jobId || null; P.gewaehlt = {}; P.status = ''; P.statusArt = ''; P.aktualisieren(); },

    typ: function (ifcTyp, an) { P.gewaehlt[ifcTyp] = !!an; P.aktualisieren(); },

    schnell: function (i) {
      var typen = S().SCHNELLWAHL[i][1];
      P.gewaehlt = {};
      typen.forEach(function (t) { if (P.typen.some(function (x) { return x.ifc_type === t; })) P.gewaehlt[t] = true; });
      P.aktualisieren();
    },

    setzen: function (was, wert) {
      if (was === 'abstand') wert = Math.max(0.1, Math.min(5, parseFloat(wert) || 0.8));
      P[was] = wert;
      P.aktualisieren();
    },

    anzeigen: function () {
      var quelle = S().modelle().filter(function (m) { return m.jobId === P.modell; })[0];
      var typen = Object.keys(P.gewaehlt).filter(function (k) { return P.gewaehlt[k]; });
      if (!quelle || !typen.length || P.laeuft) return;
      P.laeuft = true; P.statusArt = 'busy'; P.status = 'Wird angefragt …'; P.aktualisieren();
      S().anzeigen(quelle, {
        typen: typen, gruppe: P.gruppe, sortierung: P.sortierung, abstand_m: P.abstand
      }, function (text) { P.status = text; P.statusArt = 'busy'; P.aktualisieren(); })
        .then(function () { P.status = ''; P.statusArt = ''; })
        .catch(function (e) { console.warn('[Sortiert]', e); P.status = e.message; P.statusArt = 'error'; })
        .then(function () { P.laeuft = false; P.aktualisieren(); });
    },

    hin: function () { S().zurAnsicht(); },
    zumHaus: function () { S().zumModell(); },
    weg: function () { S().entfernen(); P.status = ''; P.statusArt = ''; P.aktualisieren(); },
    beschriftung: function (an) { S().beschriftungSetzen(an); }
  };

  function anmelden() {
    if (typeof BimViewerUI === 'undefined' || typeof BimViewerUI.gruppeAnmelden !== 'function' || !S()) {
      setTimeout(anmelden, 150);
      return;
    }
    BimViewerUI.gruppeAnmelden('view', {
      key: ID, ordnung: 25,
      label: 'Bauteile sortiert',
      inhalt: P.markup,
      beimOeffnen: P.aktualisieren
    });
    // Die Modellliste ändert sich, ohne dass die Gruppe geöffnet wird.
    document.addEventListener('ileen:modelle', P.aktualisieren);
    document.addEventListener('ileen:sortiert', P.aktualisieren);
  }
  anmelden();
})();
