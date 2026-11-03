/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// PRAESENTATION-PANEL — Folienliste, Inspektor und die Leiste der Vorführung
//
// Untergruppe „Präsentation" im Bereich 📷 Ansicht, angemeldet über
// `BimViewerUI.gruppeAnmelden('view', …)`. Eine Präsentation ist eine Art,
// die Szene anzusehen — kein eigenes Symbol in der Aktivitätsleiste, sondern
// neben „Kamera & Ansichten" (siehe die Regel „sieben Panels statt vierzehn
// Symbole" im CLAUDE.md).
//
// Was wo wohnt: die Rechnung und die Vorführung in praesentation.js, der Text
// in praesentation-text.js — hier nur, was die Oberfläche daraus macht.
//
// ## Wie das Panel mit dem Neuaufbau der Leiste umgeht
//
// `inhalt` liefert das Gerüst als Zeichenkette, und die Leiste baut sich bei
// jeder Anmeldung eines anderen Werkzeugs und beim Sprachwechsel neu auf. Was
// in der Zeichenkette steht, ist deshalb nur das leere Gerüst; Liste und
// Inspektor werden aus dem Zustand gefüllt (`aktualisieren()`), bei jedem
// Öffnen der Gruppe (`beimOeffnen`) und bei jeder Änderung (`horchen`). Das
// Panel hat damit keinen eigenen Zustand, der einen Neuaufbau nicht überlebte.
//
// Das Textfeld wird dabei nicht angefasst, solange es den Fokus hat: sonst
// sprängen Cursor und Auswahl bei jedem Anschlag, und genau dafür tippt man.
// ===============================
'use strict';

(function () {

  var ID = 'praesentation';
  var P = null;      // window.Praesentation
  var T = null;      // window.PraesentationText

  var THEMEN = [['glass', 'Glas'], ['solid', 'Dunkel'], ['outline', 'Kontur'], ['bar', 'Balken'], ['plain', 'Schlicht']];
  var ANIMATIONEN = [['fade', 'Einblenden'], ['up', 'Von unten'], ['down', 'Von oben'],
                     ['left', 'Von rechts'], ['right', 'Von links'], ['zoom', 'Zoom']];
  var AUSRICHTUNGEN = [['left', 'Links'], ['center', 'Mitte'], ['right', 'Rechts']];

  // Die 3×3-Raster-Voreinstellungen für die Lage des Labels.
  var RASTER_X = [0.16, 0.5, 0.84];
  var RASTER_Y = [0.17, 0.5, 0.83];

  // Werkzeugleiste über dem Textfeld: [Beschriftung, Hinweis, davor, danach]
  var WERKZEUGE = [
    ['B', 'Fett (**)', '**', '**'],
    ['I', 'Kursiv (*)', '*', '*'],
    ['U', 'Unterstrichen (++)', '++', '++'],
    ['S', 'Durchgestrichen (~~)', '~~', '~~'],
    ['M', 'Markiert (==)', '==', '=='],
    ['‹›', 'Code (`)', '`', '`'],
    ['( )', 'Plakette (( ))', '((', '))'],
    ['H1', 'Überschrift 1', '# ', null],
    ['H2', 'Überschrift 2', '## ', null],
    ['•', 'Aufzählung', '- ', null],
    ['1.', 'Nummerierung', '1. ', null],
    ['❝', 'Zitat', '> ', null],
    ['—', 'Trennlinie', '---', null],
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function el(id) { return document.getElementById(id); }

  function optionen(liste, aktuell) {
    return liste.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === aktuell ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');
  }

  // ── Gerüst ─────────────────────────────────────────────────────────────────

  function markup() {
    var werkzeuge = WERKZEUGE.map(function (w, i) {
      return '<button class="btn btn--sm btn--ghost praes-wz" type="button" title="' + esc(w[1]) + '" ' +
             'onclick="PraesentationPanel.umschliessen(' + i + ')">' + esc(w[0]) + '</button>';
    }).join('');

    var raster = '';
    for (var z = 0; z < 3; z++) {
      for (var s = 0; s < 3; s++) {
        raster += '<button class="praes-raster__zelle" type="button" data-rx="' + s + '" data-ry="' + z + '" ' +
                  'title="Label hier verankern" onclick="PraesentationPanel.rasterSetzen(' + s + ',' + z + ')"></button>';
      }
    }

    return '' +
      '<div class="praes" id="praesPanel">' +
        '<div class="praes__kopf">' +
          '<button class="btn btn--primary btn--sm" type="button" onclick="PraesentationPanel.hinzufuegen()" ' +
                  'title="Die aktuelle Ansicht als Folie hinter der gewählten anlegen">＋ Folie aus Ansicht</button>' +
          '<span class="praes__zahl" id="praesZahl"></span>' +
        '</div>' +

        '<div class="praes__liste" id="praesListe"></div>' +
        '<div class="plan-hint" id="praesLeer">Noch keine Folie. Kamera auf einen Standpunkt stellen und ' +
          '<b>＋ Folie aus Ansicht</b> drücken — jede Folie merkt sich Standpunkt, Blickrichtung ' +
          'und Öffnungswinkel und trägt einen Text.</div>' +

        '<div class="praes__inspektor" id="praesInspektor" hidden>' +
          '<div class="section__label">Folientext</div>' +
          '<div class="praes__werkzeuge">' + werkzeuge +
            '<label class="praes-farbe" title="Auswahl einfärben"><input type="color" id="praesTextFarbe" value="#38bdf8" ' +
              'onchange="PraesentationPanel.einfaerben(this.value)"></label>' +
          '</div>' +
          '<textarea class="input praes__text" id="praesText" rows="5" spellcheck="false" ' +
            'placeholder="# Titel&#10;- Stichpunkt&#10;**fett**, *kursiv*, ==markiert==" ' +
            'oninput="PraesentationPanel.textAenderung(this.value)"></textarea>' +

          '<div class="praes__gitter">' +
            '<div class="field"><div class="section__label">Box</div>' +
              '<select class="select" id="praesTheme" onchange="PraesentationPanel.stil(\'theme\', this.value)">' +
                optionen(THEMEN) + '</select></div>' +
            '<div class="field"><div class="section__label">Einblendung</div>' +
              '<select class="select" id="praesAnim" onchange="PraesentationPanel.stil(\'anim\', this.value)">' +
                optionen(ANIMATIONEN) + '</select></div>' +
            '<div class="field"><div class="section__label">Ausrichtung</div>' +
              '<select class="select" id="praesAlign" onchange="PraesentationPanel.stil(\'align\', this.value)">' +
                optionen(AUSRICHTUNGEN) + '</select></div>' +
            '<div class="field"><div class="section__label">Akzent</div>' +
              '<input type="color" class="praes-akzent" id="praesAccent" ' +
                'onchange="PraesentationPanel.stil(\'accent\', this.value)"></div>' +
          '</div>' +

          '<div class="slider-row"><span class="slider-row__label">Größe</span>' +
            '<input type="range" class="slider" id="praesScale" min="0.5" max="2.5" step="0.05" ' +
              'oninput="PraesentationPanel.stil(\'scale\', parseFloat(this.value))">' +
            '<span class="slider-row__value" id="praesScaleWert"></span></div>' +
          '<div class="slider-row"><span class="slider-row__label">Breite</span>' +
            '<input type="range" class="slider" id="praesWidth" min="0.2" max="0.96" step="0.02" ' +
              'oninput="PraesentationPanel.stil(\'width\', parseFloat(this.value))">' +
            '<span class="slider-row__value" id="praesWidthWert"></span></div>' +

          '<div class="praes__zeile">' +
            '<div><div class="section__label">Lage im Bild</div><div class="praes-raster">' + raster + '</div></div>' +
            '<div class="field"><div class="section__label">Halt (s)</div>' +
              '<input class="input" type="number" min="0" step="0.5" id="praesHalt" ' +
                'onchange="PraesentationPanel.halt(this.value)"></div>' +
          '</div>' +

          '<div class="praes__szene">' +
            '<div class="section__label">Szene dieser Folie</div>' +
            '<div class="plan-hint" id="praesSzeneInfo"></div>' +
            '<div class="btn-row">' +
              '<button class="btn btn--sm" type="button" onclick="Praesentation.szeneAufnehmen()" ' +
                'title="Geladene Modelle, Filter, Schnitt, Explosion, Notizen, Farben, Licht, Sonne … so, wie sie jetzt sind">⟳ Szene aufnehmen</button>' +
              '<button class="btn btn--sm" type="button" onclick="Praesentation.szeneZeigen()" ' +
                'title="Die gespeicherte Szene herstellen (die Kamera bleibt)">◉ Zeigen</button>' +
              '<button class="btn btn--sm btn--ghost" type="button" onclick="Praesentation.szeneEntfernen()" ' +
                'title="Die Folie lässt die Szene, wie sie ist (sie erbt die der vorigen)">✕ Entfernen</button>' +
            '</div>' +
          '</div>' +

          '<div class="btn-row">' +
            '<button class="btn btn--sm" type="button" onclick="Praesentation.kameraSetzen()" ' +
              'title="Standpunkt dieser Folie auf die aktuelle Ansicht setzen">⟳ Kamera setzen</button>' +
            '<button class="btn btn--sm" type="button" onclick="Praesentation.duplizieren()">⧉ Duplizieren</button>' +
            '<button class="btn btn--sm" type="button" onclick="Praesentation.stilAufAlle()" ' +
              'title="Box, Einblendung, Größe und Akzent auf alle Folien übertragen">⇉ Stil auf alle</button>' +
            '<button class="btn btn--sm btn--danger" type="button" onclick="Praesentation.loeschen()">✕ Löschen</button>' +
          '</div>' +
        '</div>' +

        '<div class="praes__einstellung">' +
          '<div class="field"><div class="section__label">Flugzeit (s)</div>' +
            '<input class="input" type="number" min="0.2" step="0.5" id="praesUebergang" ' +
              'onchange="Praesentation.einstellungSetzen(\'uebergang\', this.value)"></div>' +
          '<div class="field"><div class="section__label">Standard-Halt (s)</div>' +
            '<input class="input" type="number" min="0" step="0.5" id="praesStandardHalt" ' +
              'onchange="Praesentation.einstellungSetzen(\'halt\', this.value)"></div>' +
        '</div>' +

        '<div class="btn-group praes__fuss">' +
          '<button class="btn btn--primary btn--sm" type="button" onclick="Praesentation.praesentieren()" ' +
            'title="Von Hand weiterklicken: → Leertaste, ← zurück, Esc beendet">▶ Präsentieren</button>' +
          '<button class="btn btn--sm" type="button" onclick="Praesentation.auto()" ' +
            'title="Zeitgesteuert abspielen (Halt und Flugzeit)">⏱ Auto</button>' +
          '<button class="btn btn--sm" type="button" onclick="Praesentation.video()" ' +
            'title="Die Fahrt samt Text als Video aufnehmen">⤓ Video</button>' +
        '</div>' +

        '<div class="praes__werkzeugzeile">' +
          '<button class="btn btn--sm btn--ghost" type="button" onclick="PraesentationPanel.speichern()">Sichern (.json)</button>' +
          '<button class="btn btn--sm btn--ghost" type="button" ' +
            'onclick="document.getElementById(\'praesDatei\').click()">Laden (.json)</button>' +
          '<button class="btn btn--sm btn--ghost btn--danger" type="button" onclick="PraesentationPanel.leeren()">Leeren</button>' +
          '<input type="file" id="praesDatei" accept="application/json,.json" hidden ' +
            'onchange="PraesentationPanel.laden(this)">' +
        '</div>' +

        '<details class="praes__syntax"><summary>Schreibweise</summary>' +
          '<div class="plan-hint"><code>**fett**</code> <code>*kursiv*</code> <code>~~durch~~</code> ' +
            '<code>++unter++</code> <code>==markiert==</code> <code>^hoch^</code> <code>~tief~</code> ' +
            '<code>((Plakette))</code> <code>`Code`</code><br>' +
            '<code>[Text]{sky}</code> <code>[Text]{#ff8800}</code> für Farbe · <code># Titel</code> · ' +
            '<code>- Liste</code> · <code>1. Liste</code> · <code>- [x] Aufgabe</code> · <code>&gt; Zitat</code> · ' +
            '<code>---</code> Linie · <code>-# klein</code> · <code>::: center</code> / <code>left</code> / <code>right</code> ' +
            'schaltet die Ausrichtung ab dieser Zeile um.</div>' +
        '</details>' +
      '</div>';
  }

  // ── Füllen ─────────────────────────────────────────────────────────────────

  function listeZeichnen() {
    var liste = el('praesListe');
    if (!liste) return;
    var folien = P.folien();
    var gewaehlt = P.gewaehlt();
    liste.innerHTML = folien.map(function (f, i) {
      var titel = T.titel(f.tag) || 'Folie ohne Text';
      return '<div class="praes-folie' + (f.id === gewaehlt ? ' is-selected' : '') + '" draggable="true" ' +
        'data-i="' + i + '" onclick="PraesentationPanel.klick(\'' + f.id + '\')" ' +
        'ondragstart="PraesentationPanel.ziehStart(event,' + i + ')" ' +
        'ondragover="PraesentationPanel.ziehUeber(event)" ' +
        'ondragleave="this.classList.remove(\'is-ziel\')" ' +
        'ondrop="PraesentationPanel.ziehAblegen(event,' + i + ')" ' +
        'ondragend="PraesentationPanel.ziehEnde()">' +
        '<span class="praes-folie__nr">' + (i + 1) + '</span>' +
        '<span class="praes-folie__text"><span class="praes-folie__titel">' + esc(titel) + '</span>' +
          '<span class="praes-folie__meta">' + f.hold + ' s · ' + esc(f.style.theme) +
            (f.szene ? ' · <span title="Diese Folie trägt eine Szene">🎛</span>' : '') + '</span></span>' +
        '<span class="praes-folie__griff" title="Ziehen zum Umsortieren">⠿</span></div>';
    }).join('');

    var zahl = el('praesZahl');
    if (zahl) zahl.textContent = folien.length ? (folien.length + (folien.length === 1 ? ' Folie' : ' Folien')) : '';
    var leer = el('praesLeer');
    if (leer) leer.hidden = folien.length > 0;
  }

  function setze(id, wert) {
    var e = el(id);
    if (e && document.activeElement !== e) e.value = wert;
  }

  function inspektorSync() {
    var box = el('praesInspektor');
    if (!box) return;
    var f = P.folieGewaehlt();
    box.hidden = !f;
    setze('praesUebergang', P.einstellungen().uebergang);
    setze('praesStandardHalt', P.einstellungen().halt);
    if (!f) return;

    // Das Textfeld gehört dem, der gerade tippt.
    var text = el('praesText');
    if (text && document.activeElement !== text && text.value !== f.tag) text.value = f.tag;

    setze('praesTheme', f.style.theme);
    setze('praesAnim', f.style.anim);
    setze('praesAlign', f.style.align);
    setze('praesAccent', f.style.accent);
    setze('praesScale', f.style.scale);
    setze('praesWidth', f.style.width);
    setze('praesHalt', f.hold);
    var info = el('praesSzeneInfo');
    if (info) {
      var namen = f.szene ? Object.keys(f.szene) : [];
      info.textContent = namen.length
        ? namen.length + ' Bereiche: ' + namen.join(', ')
        : 'Keine — die Szene bleibt, wie sie ist (oder wie die Folie davor sie gesetzt hat).';
    }
    var sw = el('praesScaleWert'); if (sw) sw.textContent = f.style.scale.toFixed(2) + '×';
    var bw = el('praesWidthWert'); if (bw) bw.textContent = Math.round(f.style.width * 100) + ' %';

    document.querySelectorAll('.praes-raster__zelle').forEach(function (z) {
      var x = RASTER_X[+z.dataset.rx], y = RASTER_Y[+z.dataset.ry];
      z.classList.toggle('is-aktiv', Math.abs(f.caption.x - x) < 0.02 && Math.abs(f.caption.y - y) < 0.02);
    });
  }

  function aktualisieren() {
    if (!P) return;
    // Während der Vorführung meldet der Kern bei jedem Bild (Fortschritt).
    // Liste und Inspektor stehen dann hinter ausgeblendeten Panels — sie je Bild
    // neu zu schreiben wäre Arbeit für nichts.
    if (P.zustand().modus !== 'ruhe') { leisteZeichnen(); return; }
    listeZeichnen();
    inspektorSync();
  }

  // ── Die Leiste der Vorführung ──────────────────────────────────────────────
  //
  // Sie hängt am body und nicht im Panel: während der Vorführung sind alle
  // Panels ausgeblendet, und die Leiste ist das Einzige, was stehen bleibt.

  var leiste = null;

  function leisteBauen() {
    if (leiste) return;
    leiste = document.createElement('div');
    leiste.className = 'praes-leiste';
    leiste.innerHTML =
      '<span class="praes-leiste__text" id="praesLeisteText"></span>' +
      '<div class="praes-leiste__fortschritt" id="praesFortschritt"><div></div></div>' +
      '<div class="praes-leiste__manuell" id="praesManuell">' +
        '<button type="button" class="praes-nav" title="Vorherige Folie (←)" onclick="Praesentation.zu(Praesentation.zustand().index - 1)">‹</button>' +
        '<div class="praes-punkte" id="praesPunkte"></div>' +
        '<button type="button" class="praes-nav" title="Nächste Folie (→)" onclick="Praesentation.zu(Praesentation.zustand().index + 1)">›</button>' +
      '</div>' +
      '<button type="button" class="btn btn--sm" onclick="Praesentation.beenden()">⏹ Ende</button>';
    document.body.appendChild(leiste);
  }

  function leisteZeichnen() {
    var z = P.zustand();
    if (z.modus === 'ruhe') return;
    leisteBauen();
    var text = el('praesLeisteText');
    if (z.modus === 'manuell') {
      text.textContent = (z.index + 1) + ' / ' + z.anzahl;
      var punkte = el('praesPunkte');
      if (punkte.childElementCount !== z.anzahl) {
        punkte.innerHTML = P.folien().map(function (f, i) {
          return '<button type="button" class="praes-punkt" title="' + esc(T.titel(f.tag) || ('Folie ' + (i + 1))) +
                 '" onclick="Praesentation.zu(' + i + ')"></button>';
        }).join('');
      }
      Array.prototype.forEach.call(punkte.children, function (p, i) { p.classList.toggle('is-aktiv', i === z.index); });
    } else {
      text.textContent = z.modus === 'aufnahme' ? '● Aufnahme' : 'Wiedergabe';
      var fuell = leiste.querySelector('#praesFortschritt > div');
      if (fuell) fuell.style.transform = 'scaleX(' + Math.max(0, Math.min(1, z.fortschritt)) + ')';
    }
  }

  // ── Bedienung ──────────────────────────────────────────────────────────────

  var ziehQuelle = -1;

  function textfeld() { return el('praesText'); }

  var PraesentationPanel = {
    aktualisieren: aktualisieren,

    hinzufuegen: function () {
      try { P.hinzufuegen(); }
      catch (e) { BimViewer.updateStatus(e.message, 'warning'); }
      var t = textfeld();
      if (t) t.focus();
    },

    /** Klick auf eine Karte wählt sie und fliegt hin; erneuter Klick hebt die Auswahl auf. */
    klick: function (id) {
      P.waehlen(id === P.gewaehlt() ? null : id);
      var t = textfeld();
      if (t && P.gewaehlt()) t.focus();
    },

    textAenderung: function (wert) {
      var f = P.folieGewaehlt();
      if (!f) return;
      P.textSetzen(f.id, wert);
      // Nur den Titel der Karte nachführen — die Liste neu zu schreiben risse
      // das Textfeld aus dem Fokus.
      var karte = document.querySelector('.praes-folie.is-selected .praes-folie__titel');
      if (karte) karte.textContent = T.titel(wert) || 'Folie ohne Text';
    },

    stil: function (feld, wert) {
      var f = P.folieGewaehlt();
      if (f) P.stilSetzen(f.id, feld, wert);
    },

    halt: function (wert) {
      var f = P.folieGewaehlt();
      if (f) P.haltSetzen(f.id, wert);
    },

    rasterSetzen: function (s, z) {
      var f = P.folieGewaehlt();
      if (f) P.lageSetzen(f.id, RASTER_X[s], RASTER_Y[z]);
    },

    /**
     * Die Auswahl im Textfeld mit Zeichen umschließen (Fett, Kursiv …) oder
     * eine Zeile mit einem Präfix versehen (Überschrift, Liste …).
     */
    umschliessen: function (i) {
      var t = textfeld();
      var w = WERKZEUGE[i];
      if (!t || !w) return;
      this._einfuegen(t, w[2], w[3]);
    },

    einfaerben: function (hex) {
      var t = textfeld();
      if (t) this._einfuegen(t, '[', ']{' + hex + '}');
    },

    _einfuegen: function (t, davor, danach) {
      var von = t.selectionStart, bis = t.selectionEnd;
      var wert = t.value;
      var neu, cursorVon, cursorBis;
      if (danach === null) {
        // Zeilenpräfix: an den Anfang der Zeile, in der die Auswahl beginnt.
        var zeilenStart = wert.lastIndexOf('\n', von - 1) + 1;
        neu = wert.slice(0, zeilenStart) + davor + wert.slice(zeilenStart);
        cursorVon = cursorBis = von + davor.length;
      } else {
        var auswahl = wert.slice(von, bis) || 'Text';
        neu = wert.slice(0, von) + davor + auswahl + danach + wert.slice(bis);
        cursorVon = von + davor.length;
        cursorBis = cursorVon + auswahl.length;
      }
      t.value = neu;
      t.focus();
      t.setSelectionRange(cursorVon, cursorBis);
      this.textAenderung(neu);
    },

    // Umsortieren per Ziehen
    ziehStart: function (e, i) {
      ziehQuelle = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    },
    ziehUeber: function (e) {
      if (ziehQuelle < 0) return;
      e.preventDefault();
      e.currentTarget.classList.add('is-ziel');
    },
    ziehAblegen: function (e, i) {
      e.preventDefault();
      if (ziehQuelle >= 0) P.verschieben(ziehQuelle, i);
      ziehQuelle = -1;
    },
    ziehEnde: function () {
      ziehQuelle = -1;
      document.querySelectorAll('.praes-folie.is-ziel').forEach(function (k) { k.classList.remove('is-ziel'); });
    },

    speichern: function () {
      var blob = new Blob([P.jsonAusgeben()], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'praesentation.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    },

    laden: function (eingabe) {
      var datei = eingabe.files && eingabe.files[0];
      eingabe.value = '';
      if (!datei) return;
      var leser = new FileReader();
      leser.onload = function () {
        try {
          var d = P.jsonEinlesen(String(leser.result));
          BimViewer.updateStatus(d.folien.length + ' Folien geladen' +
            (d.verworfen ? ' (' + d.verworfen + ' ohne brauchbare Pose verworfen)' : ''), 'success');
        } catch (e) {
          BimViewer.updateStatus('Datei nicht lesbar: ' + e.message, 'error');
        }
      };
      leser.readAsText(datei);
    },

    leeren: function () {
      if (!P.folien().length) return;
      if (!confirm('Alle ' + P.folien().length + ' Folien löschen?')) return;
      P.leeren();
    },
  };

  window.PraesentationPanel = PraesentationPanel;

  // ── Anmelden ───────────────────────────────────────────────────────────────

  function start() {
    P = window.Praesentation;
    T = window.PraesentationText;
    if (!P || !T || typeof BimViewerUI === 'undefined') return;

    P.horchen(aktualisieren);

    // Die Gruppe steht hinter „Kamera & Ansichten" und den Punktwolken: eine
    // Präsentation ist eine Art, die Szene anzusehen, und braucht die Kamera
    // bereits eingestellt.
    BimViewerUI.gruppeAnmelden('view', {
      key: ID, ordnung: 30,
      label: 'Präsentation',
      inhalt: markup,
      beimOeffnen: aktualisieren,
    });
  }

  start();
})();
