'use strict';

/**
 * right-panel.js — Panelgerüst der rechten Seite
 *
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Diese Datei ist ein Gerüst und sonst nichts. Sie kennt kein einziges
 * Werkzeug — sie weiß nur, wie ein Reiter aussieht, wann er gebaut wird und
 * was beim Umschalten geschieht. Deshalb ist sie in der Vollfassung (GitLab)
 * und in iLEEN-view Zeile für Zeile dieselbe Datei; verschieden ist allein,
 * welche Werkzeuge sich anmelden.
 *
 * Struktur:
 *  - Rechte Activity-Bar (roleBar): oben die Rollen (Explore · Visualize ·
 *    Measure), darunter je ein Knopf für die Werkzeuge dieser Seite.
 *  - Der Werkzeugknopf öffnet ein Sliding-Panel links der roleBar und schaltet
 *    dabei auf seinen Reiter.
 *
 * ## Reiter sind angemeldet, nicht eingebaut
 *
 * Früher standen die beiden Reiter (Solar, BIM-LP) als fester HTML-String in
 * `_buildPanel()`. Mit StaLite, GEG und dem Berichtstool wären daraus fünf
 * Zweige durch dieselbe Funktion geworden — und jeder neue Reiter hätte diese
 * Datei anfassen müssen, obwohl er inhaltlich nichts mit ihr zu tun hat.
 *
 * Stattdessen meldet sich ein Reiter an:
 *
 *     RightPanel.reiterAnmelden({
 *       id: 'geg', kuerzel: 'GEG', symbol: '🌡', titel: 'Gebäudeenergie',
 *       breite: 420,
 *       aufbauen: function (behaelter) { … },   // einmal, baut das Markup
 *       oeffnen:  function () { … },            // bei jedem Anzeigen
 *       schliessen: function () { … }           // beim Wegschalten
 *     });
 *
 * Die Reihenfolge der Anmeldung ist die Reihenfolge im Reiterband. `breite`
 * ist je Reiter verschieden, weil eine Bauteiltabelle mehr Platz braucht als
 * eine Filterliste — das Panel wächst beim Umschalten mit.
 *
 * ## Warum Solar und BIM-LP hier nicht mehr stehen
 *
 * Sie waren die letzten beiden eingebauten Reiter: 60 Zeilen Phasendaten und
 * fünf `solar*`-Methoden im Namensraum des Gerüsts. Das kostete zweierlei.
 * Erstens kannte das Gerüst damit den Informationsbedarf der
 * BIM-Leistungsphasen — zwei Dinge ohne jeden Zusammenhang. Zweitens blieb in
 * der Viewer-Fassung, wo es `SolarAnalysis` nicht gibt, ein Reiter übrig, der
 * auf Klick nichts tat. Beide wohnen jetzt in `solar-panel.js` und
 * `bimlp-panel.js` und melden sich an wie alle anderen.
 *
 * ## Die Brücke
 *
 * Manche Werkzeuge werden von außen über `RightPanel.<name>()` angesprochen —
 * `solar.js` ruft `RightPanel.solarShowLoading()`, das BIM-LP-Markup ruft
 * `RightPanel._selectLp()` als `onclick`-Attribut, also aus dem globalen
 * Sichtbarkeitsbereich heraus. Damit solche Namen erreichbar bleiben, ohne
 * dass das Gerüst sie kennt, hängt ein Werkzeug sie selbst an:
 *
 *     RightPanel.brueckeAnmelden({ solarShowLoading, solarShowError });
 *
 * Fehlt das Werkzeug, fehlt der Name — ein Aufruf läuft dann in einen klaren
 * `TypeError` statt in ein stilles Nichts.
 */

const RightPanel = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let panelOpen = false;
  let activeTab = null;
  let panel = null;
  let bereit = false;            // Panel im DOM? Vor init() nur vormerken.

  /** Die angemeldeten Reiter in der Reihenfolge ihrer Anmeldung. */
  const reiter = [];

  // ── Anmeldung ──────────────────────────────────────────────────────────────

  /**
   * Meldet einen Reiter an.
   *
   * Vor `init()` wird nur vorgemerkt; danach wird das Panel neu aufgebaut. So
   * ist die Ladereihenfolge der Module gleichgültig — ein Werkzeug, das sich
   * spät anmeldet, erscheint trotzdem.
   */
  function reiterAnmelden(beschreibung) {
    if (!beschreibung || !beschreibung.id) return;
    if (reiter.some(r => r.id === beschreibung.id)) return;
    reiter.push(Object.assign({
      kuerzel: beschreibung.id,
      symbol: '•',
      titel: beschreibung.id,
      breite: 320,
      knopf: true,          // eigener Eintrag in der Aktivitätsleiste
      aufbauen: null,
      oeffnen: null,
      schliessen: null,
      _gebaut: false
    }, beschreibung));
    if (bereit) { _buildRoleBar(); _buildPanel(); }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    bereit = true;
    _buildRoleBar();
    _buildPanel();
    console.log('[RightPanel] bereit — ' + reiter.length + ' Reiter');
  }

  // ── roleBar neu bauen ──────────────────────────────────────────────────────
  function _buildRoleBar() {
    const bar = document.getElementById('roleBar');
    if (!bar) return;
    bar.innerHTML = '';

    // ── Abschnitt 1: Explore / Visualize / Measure ─────────────────────────
    const EXPLORE_ROLES = [
      { id: 'architect',    icon: '📐', title: 'Architect · Explore' },
      { id: 'engineer',     icon: '🏗️', title: 'Engineer · Visualize' },
      { id: 'sitemanager',  icon: '👷', title: 'Site Manager' },
      { id: 'fm',           icon: '🔧', title: 'Facility Manager' },
      { id: 'surveyor',     icon: '📍', title: 'Surveyor · Measure' },
    ];

    EXPLORE_ROLES.forEach(r => {
      const btn = _roleBtn(r.icon, r.title, () => {
        _deactivateAnalysis();
        BimViewerUI.switchRole(r.id);
        _setActiveRoleBtn(btn);
      });
      btn.dataset.roleBtn = r.id;
      bar.appendChild(btn);
    });

    // ── Trennlinie ──────────────────────────────────────────────────────────
    const sep = document.createElement('div');
    sep.style.cssText = 'width:24px;height:1px;background:rgba(255,255,255,0.12);margin:6px 0;';
    bar.appendChild(sep);

    // ── Abschnitt 2: die Werkzeuge dieser Seite ────────────────────────────
    // Ein Knopf je Reiter: er öffnet das Panel *und* schaltet auf den Reiter.
    // Ein einziger Sammelknopf hätte bedeutet, dass man nach dem Öffnen noch
    // einmal zielen muss — bei fünf Reitern ist das ein Klick zu viel.
    reiter.filter(r => r.knopf).forEach(r => {
      const btn = _roleBtn(r.symbol, r.titel, () => {
        if (panelOpen && activeTab === r.id) { closePanel(); return; }
        openPanel(r.id);
        _setActiveRoleBtn(btn);
      });
      btn.dataset.reiterBtn = r.id;
      bar.appendChild(btn);
    });

    // Default: architect aktiv
    const first = bar.querySelector('[data-role-btn="architect"]');
    if (first) first.classList.add('active');
  }

  function _roleBtn(icon, title, onClick) {
    const btn = document.createElement('div');
    btn.className = 'role-btn';
    btn.title = title;
    btn.innerHTML = `<span class="role-btn-icon">${icon}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function _setActiveRoleBtn(btn) {
    document.querySelectorAll('#roleBar .role-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  function _deactivateAnalysis() {
    if (panelOpen) closePanel();
  }

  // ── Panel aufbauen ─────────────────────────────────────────────────────────
  function _buildPanel() {
    const vorher = activeTab;
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'rightAnalysisPanel';
    panel.className = 'rp-panel';
    panel.style.display = 'none';

    const band = reiter.map(r =>
      `<button class="rp-tab" data-rp-tab="${r.id}" title="${r.titel}">` +
        `<span class="rp-tab__symbol">${r.symbol}</span>` +
        `<span class="rp-tab__text">${r.kuerzel}</span>` +
      `</button>`).join('');

    const flaechen = reiter.map(r =>
      `<div class="rp-pane" id="rpPane-${r.id}" data-rp-pane="${r.id}"></div>`).join('');

    panel.innerHTML =
      `<div class="rp-tabbar" id="rpTabBar">${band}</div>` +
      `<div class="rp-body">${flaechen}</div>`;

    document.body.appendChild(panel);

    panel.querySelectorAll('[data-rp-tab]').forEach(knopf => {
      knopf.addEventListener('click', () => _switchTab(knopf.dataset.rpTab));
    });

    reiter.forEach(r => { r._gebaut = false; });
    _switchTab(vorher && reiter.some(r => r.id === vorher) ? vorher
                                                           : (reiter[0] || {}).id);
  }

  // ── Reiterwechsel ───────────────────────────────────────────────────────────
  function _switchTab(id) {
    if (!id || !panel) return;
    const ziel = reiter.find(r => r.id === id);
    if (!ziel) return;

    // Den bisherigen Reiter ordentlich verabschieden: Solar etwa hängt an der
    // Szene und muss seine Werkzeuge abräumen, sonst bleibt der Klickfänger
    // aktiv, während man längst die Bauteilliste bearbeitet.
    const vorher = reiter.find(r => r.id === activeTab);
    if (vorher && vorher.id !== id && typeof vorher.schliessen === 'function') {
      try { vorher.schliessen(); } catch (e) { console.warn('[RightPanel]', e); }
    }

    activeTab = id;
    panel.style.width = (ziel.breite || 320) + 'px';

    panel.querySelectorAll('[data-rp-tab]').forEach(knopf => {
      knopf.classList.toggle('is-aktiv', knopf.dataset.rpTab === id);
    });
    panel.querySelectorAll('[data-rp-pane]').forEach(flaeche => {
      flaeche.classList.toggle('is-aktiv', flaeche.dataset.rpPane === id);
    });

    const behaelter = document.getElementById('rpPane-' + id);
    if (behaelter && !ziel._gebaut && typeof ziel.aufbauen === 'function') {
      try {
        ziel.aufbauen(behaelter);
        ziel._gebaut = true;
      } catch (e) {
        console.error('[RightPanel] Reiter "' + id + '" nicht aufbaubar', e);
        behaelter.innerHTML = '<div class="rp-hinweis">Dieser Reiter ließ sich nicht ' +
                              'aufbauen: ' + (e && e.message ? e.message : e) + '</div>';
        ziel._gebaut = true;
      }
    }
    if (panelOpen && typeof ziel.oeffnen === 'function') {
      try { ziel.oeffnen(); } catch (e) { console.warn('[RightPanel]', e); }
    }

    // Die Aktivitätsleiste zeigt mit, welcher Reiter offen ist.
    const knopf = document.querySelector('#roleBar [data-reiter-btn="' + id + '"]');
    if (knopf && panelOpen) _setActiveRoleBtn(knopf);
  }

  // ── Panel öffnen / schließen ───────────────────────────────────────────────
  function togglePanel(id) {
    panelOpen ? closePanel() : openPanel(id);
  }

  function openPanel(id) {
    if (!panel) return;
    panelOpen = true;
    panel.style.display = 'flex';
    // infoBoxPanel weicht nach links
    const breite = (reiter.find(r => r.id === (id || activeTab)) || {}).breite || 320;
    const ibp = document.getElementById('infoBoxPanel');
    if (ibp) ibp.style.right = (44 + breite + 8) + 'px';

    if (id && id !== activeTab) {
      _switchTab(id);
    } else {
      const jetzt = reiter.find(r => r.id === activeTab);
      if (jetzt && typeof jetzt.oeffnen === 'function') {
        try { jetzt.oeffnen(); } catch (e) { console.warn('[RightPanel]', e); }
      }
    }
  }

  function closePanel() {
    panelOpen = false;
    if (panel) panel.style.display = 'none';
    const ibp = document.getElementById('infoBoxPanel');
    if (ibp) ibp.style.right = '56px';

    const jetzt = reiter.find(r => r.id === activeTab);
    if (jetzt && typeof jetzt.schliessen === 'function') {
      try { jetzt.schliessen(); } catch (e) { console.warn('[RightPanel]', e); }
    }
  }
  // ── Brücke: Namen, die ein Werkzeug am Gerüst aufhängt ─────────────────────
  //
  // Siehe Kopf der Datei. Bewusst ohne Namensprüfung: wer zwei Werkzeuge mit
  // gleichem Methodennamen anmeldet, hat ein Namensproblem im Werkzeug, und
  // das soll hier nicht stillschweigend geglättet werden. Gewarnt wird
  // trotzdem, damit es beim Suchen nicht Stunden kostet.
  function brueckeAnmelden(namen) {
    if (!namen || typeof namen !== 'object') return;
    Object.keys(namen).forEach((name) => {
      if (name in api) {
        console.warn('[RightPanel] Brückenname "' + name + '" war schon vergeben — wird überschrieben');
      }
      api[name] = namen[name];
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  //
  // `api` ist eine benannte Konstante und kein Objektliteral im `return`,
  // weil `brueckeAnmelden()` weitere Namen hineinhängt.
  const api = {
    init,
    reiterAnmelden,
    brueckeAnmelden,
    togglePanel,
    openPanel,
    closePanel,
    _switchTab,
    get isOpen() { return panelOpen; },
    get aktiverReiter() { return activeTab; },
    /** Nur für Prüfsteine: die Kennungen der angemeldeten Reiter. */
    get reiterListe() { return reiter.map(r => r.id); },
  };

  return api;

})();

document.addEventListener('DOMContentLoaded', () => {
  // Kurz warten bis roleBar im DOM ist — und bis die Werkzeugmodule ihre
  // Reiter angemeldet haben. Eine spätere Anmeldung baut das Panel ohnehin neu.
  setTimeout(() => RightPanel.init(), 200);
});
