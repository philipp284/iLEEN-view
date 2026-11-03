/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// TASTENKÜRZEL — ein Buchstabe öffnet das Menü und schaltet das Werkzeug
//
//   X Explosion · P Punktwolken · I IFC-Modelle · G Gaussian Splats · M Messen
//   V Vorlagen · ⇧1…⇧9 Vorlage laden · ? diese Übersicht
//   (R Räume meldet die Vollfassung aus room-concept-panel.js an)
//
// Ein Druck tut zweierlei: das zugehörige Menü links geht auf — Bereich,
// Untergruppe oder Reiter — und das Werkzeug schaltet um. Beides zusammen,
// weil man nach dem Einschalten fast immer nachstellen will (Abstand der
// Explosion, Punktgröße, Messart) und das Menü dann schon offen ist. Ein
// Schild unten in der Mitte sagt, was geschehen ist; ohne es wüsste man bei
// einer ausgeblendeten Punktwolke hinter dem Modell nicht, ob die Taste
// überhaupt gegriffen hat.
//
// Gebaut wie die Panelgerüste: ein Steckplatz. Jedes Werkzeug kann sich mit
// `BimViewer.Tasten.anmelden()` eintragen; diese Datei kennt nur die
// Werkzeuge des Viewers. So bleibt sie in Vollfassung und iLEEN-view gleich.
//
// **Vorher belegt und deshalb verlegt:** M fuhr die Seitenleiste ein (jetzt
// B), I isolierte die Auswahl (jetzt ⇧I). Philipps Ansage vom 2026-10-19:
// M ist Messen, I ist IFC.
//
// **Wem die Taste gerade gehört.** Gehört wird auf `window` in der
// Bubbling-Phase — nach allem, was am Dokument hängt. Wer eine Taste schon
// für sich behandelt hat (`preventDefault`), behält sie. Zusätzlich hat jeder
// Eintrag eine `sperre`: Messen braucht G für das Fangraster, der Bauplaner R
// zum Drehen der Auswahl, und beide hängen ihre Hörer erst später an
// `window` — ohne Sperre käme dieser Hörer ihnen zuvor. Im Flug- und
// Gehmodus und im Zeichenmodus bleibt alles stumm: dort sind die Buchstaben
// Steuerung.
// ===============================
'use strict';

(function () {

  var B = window.BimViewer = window.BimViewer || {};

  /** Die angemeldeten Kürzel: { taste, titel, ordnung, menue, aktion, sperre, hinweis }. */
  var eintraege = [];

  function anmelden(e) {
    if (!e || !e.taste || typeof e.aktion !== 'function') {
      console.warn('[Tasten] anmelden braucht taste und aktion');
      return;
    }
    var eintrag = Object.assign({ ordnung: 500, titel: e.taste }, e, { taste: String(e.taste).toLowerCase() });
    var i = eintraege.findIndex(function (x) { return x.taste === eintrag.taste; });
    if (i >= 0) eintraege[i] = eintrag; else eintraege.push(eintrag);
    eintraege.sort(function (a, b) { return a.ordnung - b.ordnung; });
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function imSchriftfeld(z) {
    return !!(z && (z.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(z.tagName || '')));
  }

  /** Wo die Buchstaben gerade etwas anderes bedeuten. */
  function stumm() {
    if (window.WalkMode && typeof WalkMode.isEnabled === 'function' && WalkMode.isEnabled()) return true;
    if (document.getElementById('plan2dOverlay')) return true;     // Zeichenmodus
    if (document.querySelector('.ileen-hilfe.is-offen')) return true;            // Handbuch
    return false;
  }

  // ── Menü öffnen ──────────────────────────────────────────────────────────

  /**
   * Den Bereich links aufschlagen und darin die Gruppe oder den Reiter.
   *
   * `activateSection()` auf einen schon offenen Bereich klappt die Leiste
   * ZU — deshalb erst nachsehen. Eine eingefahrene Leiste wird vorher
   * ausgefahren, sonst hielte `activateSection` den Bereich für offen.
   */
  function menueOeffnen(bereich, ziel) {
    var UI = window.BimViewerUI;
    if (!UI || typeof UI.activateSection !== 'function') return;
    ziel = ziel || {};
    var toolbar = document.getElementById('toolbar');
    if (toolbar && toolbar.classList.contains('collapsed')) UI.toggleSidebar(false);
    var knopf = document.querySelector('.activity-btn[data-section="' + bereich + '"]');
    var seite = document.getElementById('sidebarPanel');
    var offen = knopf && knopf.classList.contains('active') && seite && seite.classList.contains('is-open');
    if (!offen) UI.activateSection(bereich);
    if (ziel.gruppe) UI.openGroup(ziel.gruppe);
    if (ziel.reiter) UI.showToolsTab(ziel.reiter);
    if (ziel.element) {
      // Nach dem Aufklappen: vorher hat die Gruppe noch ihre zugeklappte Höhe.
      requestAnimationFrame(function () {
        var el = document.getElementById(ziel.element);
        if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  // ── Schild ───────────────────────────────────────────────────────────────

  var schildTimer = null;

  /** Unten in der Mitte: welche Taste, was, an oder aus. */
  function schild(taste, titel, ergebnis) {
    var el = document.getElementById('tastenSchild');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tastenSchild';
      el.className = 'tasten-schild';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    var r = ergebnis || {};
    var zustand = typeof r.an === 'boolean' ? (r.an ? 'an' : 'aus') : '';
    el.innerHTML =
      '<kbd>' + esc(taste) + '</kbd>' +
      '<span class="tasten-schild__titel">' + esc(titel) + '</span>' +
      (zustand ? '<b class="tasten-schild__' + zustand + '">' + zustand + '</b>' : '') +
      (r.text ? '<span class="tasten-schild__text">' + esc(r.text) + '</span>' : '');
    el.classList.add('is-sichtbar');
    clearTimeout(schildTimer);
    schildTimer = setTimeout(function () { el.classList.remove('is-sichtbar'); }, 1800);
  }

  // ── Auslösen ─────────────────────────────────────────────────────────────

  function ausloesen(e, quelle) {
    if (typeof e === 'string') {
      var k = e.toLowerCase();
      e = eintraege.filter(function (x) { return x.taste === k; })[0];
      if (!e) return Promise.resolve(null);
    }
    try { if (typeof e.menue === 'function') e.menue(); }
    catch (f) { console.error('[Tasten] Menü "' + e.taste + '":', f); }

    return Promise.resolve()
      .then(function () { return e.aktion(); })
      .catch(function (f) {
        console.error('[Tasten] Aktion "' + e.taste + '":', f);
        return { text: 'ging nicht — siehe Konsole' };
      })
      .then(function (ergebnis) {
        schild(e.taste.toUpperCase(), e.titel, ergebnis);
        if (B.Nutzung) {
          B.Nutzung.melden('taste', {
            taste: e.taste, titel: e.titel, quelle: quelle || 'tastatur',
            an: ergebnis && typeof ergebnis.an === 'boolean' ? ergebnis.an : null
          });
        }
        if (window.BimViewerUI && typeof BimViewerUI.aktionenAktualisieren === 'function') {
          BimViewerUI.aktionenAktualisieren();
        }
        return ergebnis || null;
      });
  }

  window.addEventListener('keydown', function (ev) {
    if (ev.defaultPrevented || ev.repeat) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (imSchriftfeld(ev.target) || stumm()) return;

    if (ev.key === '?') { ev.preventDefault(); uebersicht(); return; }

    // ⇧1 … ⇧9: Vorlage mit dieser Nummer. Über `code`, weil ⇧1 auf der
    // deutschen Tastatur „!" ergibt und `key` die Ziffer nicht mehr kennt.
    var ziffer = /^Digit([1-9])$/.exec(ev.code || '');
    if (ziffer && ev.shiftKey) {
      if (B.Vorlagen && typeof B.Vorlagen.ladenNachTaste === 'function') {
        ev.preventDefault();
        B.Vorlagen.ladenNachTaste(Number(ziffer[1]));
      }
      return;
    }
    if (ev.shiftKey) return;

    var taste = String(ev.key || '').toLowerCase();
    var e = eintraege.filter(function (x) { return x.taste === taste; })[0];
    if (!e) return;
    if (typeof e.sperre === 'function') {
      try { if (e.sperre()) return; } catch (f) { /* im Zweifel nicht sperren */ }
    }
    ev.preventDefault();
    ausloesen(e, 'tastatur');
  });

  // ── Übersicht (?) ────────────────────────────────────────────────────────

  /** Was schon vorher belegt war — hier nur aufgeführt, behandelt wird es woanders. */
  var BESTAND = [
    ['B', 'Seitenleiste ein- und ausfahren'],
    ['H · ⇧H', 'Bauteil ausblenden · alle zurückholen'],
    ['⇧I', 'Auswahl isolieren'],
    ['C', 'Notizmodus'],
    ['L', 'Kunstlicht und Taschenlampe'],
    ['F · ⇧F', 'Fliegen · Gehen'],
    ['N', 'Nach Norden ausrichten'],
    ['Esc', 'Laufenden Vorgang abbrechen'],
  ];

  function uebersicht() {
    var alt = document.getElementById('tastenUebersicht');
    if (alt) { alt.remove(); return; }
    var el = document.createElement('div');
    el.id = 'tastenUebersicht';
    el.className = 'tasten-uebersicht';
    var zeile = function (k, t, h) {
      return '<tr><td><kbd>' + esc(k) + '</kbd></td><td>' + esc(t) +
             (h ? '<div class="tasten-uebersicht__hinweis">' + esc(h) + '</div>' : '') + '</td></tr>';
    };
    var vorlagen = B.Vorlagen && typeof B.Vorlagen.liste === 'function' ? B.Vorlagen.liste() : [];
    el.innerHTML =
      '<div class="tasten-uebersicht__karte">' +
        '<div class="tasten-uebersicht__kopf"><span>Tastenkürzel</span>' +
          '<button class="btn btn--ghost btn--sm" data-zu>✕</button></div>' +
        '<div class="tasten-uebersicht__spalten">' +
          '<table><caption>Menü öffnen und schalten</caption>' +
            eintraege.map(function (e) { return zeile(e.taste.toUpperCase(), e.titel, e.hinweis); }).join('') +
            zeile('?', 'Diese Übersicht') +
          '</table>' +
          '<table><caption>Vorlagen</caption>' +
            (vorlagen.length
              ? vorlagen.filter(function (v) { return v.taste; })
                  .sort(function (a, b) { return a.taste - b.taste; })
                  .map(function (v) { return zeile('⇧' + v.taste, v.name); }).join('')
              : '<tr><td colspan="2" class="tasten-uebersicht__hinweis">Noch keine — mit V anlegen.</td></tr>') +
          '</table>' +
          '<table><caption>Außerdem</caption>' +
            BESTAND.map(function (b) { return zeile(b[0], b[1]); }).join('') +
          '</table>' +
        '</div>' +
      '</div>';
    el.addEventListener('click', function (ev) {
      if (ev.target === el || ev.target.closest('[data-zu]')) el.remove();
    });
    document.body.appendChild(el);
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var el = document.getElementById('tastenUebersicht');
    if (el) { el.remove(); ev.stopPropagation(); }
  }, true);

  // ── Die Kürzel des Viewers ───────────────────────────────────────────────

  function modelle(passt) {
    var aus = [];
    if (!B.loadedAssets) return aus;
    B.loadedAssets.forEach(function (a) { if (a && a.tileset && passt(a)) aus.push(a); });
    return aus;
  }

  function istSplat(a) { return !!(a.tileset && a.tileset._isGaussianSplat); }
  function istWolke(a) { return !!a.isPointCloud && !istSplat(a); }

  /** Der Inhaltstyp eines Backend-Modells, wie die Modellliste ihn kennt. */
  function backendTyp(a) {
    var liste = (window.BimViewerUI && BimViewerUI.backendAssets) || [];
    if (!a.jobId) return null;
    for (var i = 0; i < liste.length; i++) if (liste[i].job_id === a.jobId) return liste[i].content_type || null;
    return null;
  }

  /**
   * Ein IFC-Modell — kein Splat, keine Punktwolke, und entweder hat
   * features.js ein IFC-Merkmal gefunden, oder das Backend führt es als IFC.
   * Der Dateiname ist der letzte Ausweg: ion-Assets sagen sonst nichts.
   */
  function istIfc(a) {
    if (istSplat(a) || a.isPointCloud) return false;
    if (a.ifcPropertyName) return true;
    var typ = backendTyp(a);
    if (typ) return typ === 'ifc';
    return /\.ifc(\b|$)/i.test(a.name || '');
  }

  /**
   * Alle Modelle einer Art ein- oder ausblenden: ist eines sichtbar, gehen
   * alle aus; sonst kommen alle. Über `toggleAssetVisibility`, damit das Auge
   * in der Modellliste und die Klone der Explosion mitziehen.
   */
  function sichtbarkeitUmschalten(liste, einzahl, mehrzahl) {
    if (!liste.length) return { text: 'kein' + (einzahl === 'Punktwolke' ? 'e ' : ' ') + einzahl + ' geladen' };
    var an = !liste.some(function (a) { return a.visible !== false; });
    liste.forEach(function (a) {
      if ((a.visible !== false) !== an) B.toggleAssetVisibility(a.id);
    });
    if (B.viewer && B.viewer.scene) B.viewer.scene.requestRender();
    return { an: an, text: liste.length === 1 ? (liste[0].name || einzahl) : liste.length + ' ' + mehrzahl };
  }

  anmelden({
    taste: 'x', titel: 'Explosion', ordnung: 10,
    hinweis: 'Geschosse auseinanderziehen; Räume fliegen mit',
    menue: function () { menueOeffnen('view', { gruppe: 'explosion' }); },
    aktion: function () {
      var E = B.Explosion;
      if (!E) return { text: 'nicht geladen' };
      if (E.aktiv) { E.aus(); return { an: false }; }
      // Mit Abstand null schaltete X ein, und nichts bewegte sich.
      if (!(E.abstand > 0)) E.abstand = 3;
      var laeuft = E.an();
      if (laeuft && typeof laeuft.catch === 'function') {
        laeuft.catch(function (f) { console.error('[Tasten] Explosion:', f); });
      }
      return { an: !!E.aktiv, text: E.abstand.toFixed(1) + ' m je Geschoss' };
    }
  });

  anmelden({
    taste: 'p', titel: 'Punktwolken', ordnung: 20,
    hinweis: 'alle Punktwolken ein- oder ausblenden',
    menue: function () { menueOeffnen('view', { gruppe: 'pointcloud' }); },
    aktion: function () { return sichtbarkeitUmschalten(modelle(istWolke), 'Punktwolke', 'Punktwolken'); }
  });

  anmelden({
    taste: 'i', titel: 'IFC-Modelle', ordnung: 30,
    hinweis: 'alle IFC-Modelle ein- oder ausblenden',
    menue: function () { menueOeffnen('ifc', { gruppe: 'filter' }); },
    aktion: function () { return sichtbarkeitUmschalten(modelle(istIfc), 'IFC-Modell', 'IFC-Modelle'); }
  });

  anmelden({
    taste: 'g', titel: 'Gaussian Splats', ordnung: 40,
    hinweis: 'alle Splats ein- oder ausblenden',
    menue: function () { menueOeffnen('view', { gruppe: 'pointcloud', element: 'splatDetailSlider' }); },
    aktion: function () { return sichtbarkeitUmschalten(modelle(istSplat), 'Splat', 'Splats'); },
    // Im Messmodus ist G das Fangraster (aufmass.js).
    sperre: function () { return !!(B.Aufmass && B.Aufmass.laeuft); }
  });

  anmelden({
    taste: 'm', titel: 'Messen', ordnung: 50,
    hinweis: 'Aufmaß: Punkt, Strecke, Fläche, Volumen',
    menue: function () { menueOeffnen('tools', { reiter: 'measure' }); },
    aktion: function () {
      var A = B.Aufmass;
      if (!A || typeof A.umschalten !== 'function') return { text: 'nicht geladen' };
      A.umschalten();
      return { an: !!A.laeuft };
    }
  });

  anmelden({
    taste: 'v', titel: 'Vorlagen', ordnung: 90,
    hinweis: 'gespeicherte Ansichten, zuletzt geladene oben',
    aktion: function () {
      if (!B.Vorlagen) return { text: 'nicht geladen' };
      B.Vorlagen.palette();
      return { text: B.Vorlagen.liste().length + ' gespeichert' };
    }
  });

  B.Tasten = {
    anmelden: anmelden,
    ausloesen: ausloesen,
    menueOeffnen: menueOeffnen,
    schild: schild,
    uebersicht: uebersicht,
    liste: function () {
      return eintraege.map(function (e) { return { taste: e.taste, titel: e.titel, hinweis: e.hinweis || '' }; });
    },
    _intern: { istIfc: istIfc, istSplat: istSplat, istWolke: istWolke, modelle: modelle, stumm: stumm }
  };

  console.log('⌨️ Tastenkürzel: ' + eintraege.map(function (e) { return e.taste.toUpperCase(); }).join(' ') + ' · ? zeigt alle');
})();
