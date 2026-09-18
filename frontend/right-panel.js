'use strict';

/**
 * right-panel.js — Rechte Analyse-Sidebar für iLEEN
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
 * Solar und BIM-LP sind hier weiterhin eingebaut, aber über denselben Weg
 * angemeldet wie alles andere. Die Brücke, über die `solar.js` das Panel
 * befüllt (`solarShowLoading`, `solarShowError`, `#rpSolarBody`), ist
 * unverändert — sie ist der einzige Grund, warum der Solar-Reiter seinen
 * Container mit genau diesen Kennungen bauen muss.
 */

const RightPanel = (() => {

  // ── BIM Leistungsphasen-Daten (aus phases.ts, als embedded JS) ─────────────
  const BIM_GROUPS = [
    {
      id: 'lp1',
      label: 'BIM-LP1',
      name: 'Initialisierung und Grundlagen',
      color: '#3B82F6',
      phases: [
        { id: '000', name: 'Grundsätzliches', loGN: 'LoGN 1', trades: ['Architektur', 'Gebäudebetrieb 4.0'], deliverable: 'Projektstrukturmodell', fileType: 'IFC 4.3 / XML' },
        { id: '010', name: 'Bestandserfassung', loGN: 'LoGN 2', trades: ['Vermessung', 'Architektur'], deliverable: 'Bestandsmodell / Lageplanmodell', fileType: 'IFC 4.3 / E57 / DWG' },
        { id: '020', name: 'Bedarfsplanung', loGN: 'LoGN 1', trades: ['Architektur', 'Gebäudebetrieb 4.0'], deliverable: 'Bedarfsprogramm', fileType: 'PDF / XML' },
      ],
    },
    {
      id: 'lp2',
      label: 'BIM-LP2',
      name: 'Planung und Entwurf',
      color: '#10B981',
      phases: [
        { id: '030', name: 'Planungsvarianten', loGN: 'LoGN 2', trades: ['Architektur', 'Tragwerksplanung', 'TGA Planung'], deliverable: 'Vorentwurfsmodell', fileType: 'IFC 4.3 / RVT / PDF' },
        { id: '040', name: 'Visualisierung', loGN: 'LoGN 3', trades: ['Architektur'], deliverable: 'Visualisierungsmodell', fileType: 'FBX / GLB / MP4' },
        { id: '050', name: 'Koordination Fachgewerke', loGN: 'LoGN 4', trades: ['Architektur', 'Tragwerksplanung', 'TGA Planung', 'Elektro', 'Heizung/Sanitär', 'Lüftung', 'Netzwerk IT'], deliverable: 'Koordinationsmodell', fileType: 'IFC 4.3 / BCF / NWD' },
        { id: '060', name: 'Qualitätsprüfung', loGN: 'LoGN 4', trades: ['Architektur', 'Tragwerksplanung'], deliverable: 'Qualitätsbericht', fileType: 'BCF / PDF' },
        { id: '070', name: 'Bemessung & Nachweise', loGN: 'LoGN 4', trades: ['Tragwerksplanung', 'TGA Planung'], deliverable: 'Berechnungsmodell', fileType: 'IFC 4.3 / SAF / gbXML' },
        { id: '080', name: 'Planunterlagen', loGN: 'LoGN 6', trades: ['Architektur', 'Tragwerksplanung'], deliverable: 'Ausführungsmodell', fileType: 'IFC 4.3 / DWG / PDF' },
        { id: '090', name: 'Genehmigung', loGN: 'LoGN 3', trades: ['Architektur'], deliverable: 'Genehmigungsmodell', fileType: 'IFC 4.3 / XPlanGML' },
      ],
    },
    {
      id: 'lp3',
      label: 'BIM-LP3',
      name: 'Vergabe und Vorbereitung',
      color: '#F59E0B',
      phases: [
        { id: '100', name: 'Mengen- & Kosten', loGN: 'LoGN 4', trades: ['Architektur', 'Tragwerksplanung'], deliverable: 'Kostenmodell', fileType: 'IFC 4.3 / GAEB / CSV' },
        { id: '110', name: 'Ausschreibung & Vergabe', loGN: 'LoGN 5', trades: ['Architektur', 'Rohbau', 'Ausbau'], deliverable: 'Ausschreibungsmodell', fileType: 'IFC 4.3 / GAEB DA XML' },
        { id: '120', name: 'Terminplanung (4D)', loGN: 'LoGN 4', trades: ['Rohbau', 'Ausbau'], deliverable: '4D-Simulationsmodell', fileType: 'IFC 4.3 / NWD' },
        { id: '130', name: 'Logistikplanung', loGN: 'LoGN 3', trades: ['Rohbau', 'Gerüstbau'], deliverable: 'Baustelleneinrichtungsmodell', fileType: 'IFC 4.3 / DWG' },
      ],
    },
    {
      id: 'lp4',
      label: 'BIM-LP4',
      name: 'Bauausführung',
      color: '#EF4444',
      phases: [
        { id: '140', name: 'Baufortschrittskontrolle', loGN: 'LoGN 7', trades: ['Architektur', 'Rohbau', 'Vermessung'], deliverable: 'Ist-Modell (As-Built)', fileType: 'IFC 4.3 / E57 / BCF' },
        { id: '150', name: 'Änderungs- & Nachtrag', loGN: 'LoGN 6', trades: ['Architektur', 'Tragwerksplanung'], deliverable: 'Änderungsmodell', fileType: 'IFC 4.3 / BCF' },
        { id: '160', name: 'Abrechnung', loGN: 'LoGN 6', trades: ['Architektur', 'Rohbau'], deliverable: 'Abrechnungsmodell', fileType: 'IFC 4.3 / GAEB / CSV' },
        { id: '170', name: 'Abnahme & Mängel', loGN: 'LoGN 8', trades: ['Architektur', 'Rohbau', 'TGA Planung'], deliverable: 'Mängelmodell', fileType: 'IFC 4.3 / BCF' },
      ],
    },
    {
      id: 'lp5',
      label: 'BIM-LP5',
      name: 'Abschluss und Betrieb',
      color: '#8B5CF6',
      phases: [
        { id: '180', name: 'Inbetriebnahme', loGN: 'LoGN 8', trades: ['TGA Planung', 'Gebäudebetrieb 4.0', 'Netzwerk IT'], deliverable: 'Techn. Gebäudemodell', fileType: 'IFC 4.3 / COBie' },
        { id: '190', name: 'Bauwerksdokumentation', loGN: 'LoGN 9', trades: ['Architektur', 'Vermessung', 'Gebäudebetrieb 4.0'], deliverable: 'As-Built Gesamtmodell', fileType: 'IFC 4.3 / DWG / E57' },
        { id: '200', name: 'Betrieb & Erhaltung', loGN: 'LoGN 9', trades: ['Gebäudebetrieb 4.0', 'Netzwerk IT'], deliverable: 'Lebender Digitaler Zwilling', fileType: 'IFC 4.3 / COBie / REST / MQTT' },
      ],
    },
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  let panelOpen = false;
  let activeTab = null;
  let activeLp = null;           // null = Alle, 'lp1'…'lp5'
  let activePhase = null;        // phase id or null
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

  // ── Eingebauter Reiter: Solar ──────────────────────────────────────────────
  //
  // Der Container muss `rpSolarBody` heißen: `solar.js` greift ihn direkt über
  // `getElementById` ab, ebenso `rpSolarHeatmapStatus` und `rpSolarCostChart`,
  // die es selbst hineinschreibt. Das ist die gewachsene Brücke zwischen beiden
  // Modulen und wird hier nur bedient, nicht verändert.
  reiterAnmelden({
    id: 'solar', kuerzel: 'Solar', symbol: '☀', titel: 'Solaranalyse', breite: 320,
    aufbauen: function (behaelter) {
      behaelter.innerHTML =
        '<div id="rpSolarBody" style="padding:16px; color:#555; font-size:11px;">' +
        'Klicke auf ein Gebäude, um die Solar-Analyse zu starten.</div>';
    },
    oeffnen: function () {
      if (typeof SolarAnalysis !== 'undefined' && !SolarAnalysis._active) {
        SolarAnalysis.activate();
      }
    },
    schliessen: function () {
      if (typeof SolarAnalysis !== 'undefined') {
        SolarAnalysis._solarPanelClose();
        SolarAnalysis.deactivate();
      }
    }
  });

  // ── Eingebauter Reiter: BIM-Leistungsphasen ────────────────────────────────
  reiterAnmelden({
    id: 'bimlp', kuerzel: 'BIM-LP', symbol: '📋', titel: 'BIM-Leistungsphasen',
    breite: 340,
    aufbauen: function (behaelter) {
      behaelter.innerHTML = '<div id="rpBimlpBody" style="padding:0;"></div>';
      _renderBimLpPanel();
    }
  });

  // ── BIM-LP Filteransicht ───────────────────────────────────────────────────
  function _renderBimLpPanel() {
    const body = document.getElementById('rpBimlpBody');
    if (!body) return;

    // Gruppen-Header-Buttons
    const headerHtml = BIM_GROUPS.map(g => `
      <button
        onclick="RightPanel._selectLp('${g.id}')"
        id="rpLpBtn_${g.id}"
        style="
          width: 100%; text-align: left; background: transparent;
          border: none; border-bottom: 1px solid #1a1a1a;
          padding: 10px 16px; cursor: pointer;
          display: flex; align-items: center; gap: 10px;
          transition: background .15s;
        "
        onmouseenter="this.style.background='rgba(255,255,255,0.04)'"
        onmouseleave="this.style.background='transparent'"
      >
        <span style="
          width: 8px; height: 8px; border-radius: 50%;
          background: ${g.color}; flex-shrink: 0; display:inline-block;
        "></span>
        <span style="font-size:10px; font-weight:700; color:${g.color}; letter-spacing:.5px; text-transform:uppercase; flex-shrink:0; width:52px;">${g.label}</span>
        <span style="font-size:10px; color:#888; flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">${g.name}</span>
        <span style="font-size:10px; color:#444; flex-shrink:0;" id="rpLpArrow_${g.id}">▸</span>
      </button>
      <div id="rpLpPhases_${g.id}" style="display:none; border-bottom: 1px solid #1a1a1a;">
        ${_renderPhases(g)}
      </div>
    `).join('');

    body.innerHTML = `
      <!-- Filter-Header -->
      <div style="
        padding: 10px 16px; border-bottom: 1px solid #1e1e1e;
        font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: .6px;
        display: flex; justify-content: space-between; align-items: center;
      ">
        <span>BIM-Leistungsphasen · Informationsbedarf</span>
        <button onclick="RightPanel._resetLpFilter()" style="
          background: transparent; border: 1px solid #2e2e2e; border-radius: 3px;
          color: #555; font-size: 9px; padding: 2px 6px; cursor: pointer; font-family: inherit;
        ">Reset</button>
      </div>
      <!-- Aktiver Filter-Badge -->
      <div id="rpLpActiveBadge" style="display:none; padding:8px 16px; border-bottom:1px solid #1a1a1a;">
        <span id="rpLpActiveBadgeText" style="
          font-size:10px; font-weight:700; padding:3px 8px; border-radius:3px;
          background: rgba(255,255,255,0.07); color: #e8e8e8;
        "></span>
      </div>
      <!-- Gruppen-Liste -->
      <div id="rpLpGroupList">
        ${headerHtml}
      </div>
    `;
  }

  function _renderPhases(group) {
    return group.phases.map(p => `
      <div
        onclick="RightPanel._selectPhase('${group.id}','${p.id}')"
        id="rpPhase_${p.id}"
        style="
          padding: 8px 16px 8px 36px; cursor: pointer; border-bottom: 1px solid #111;
          transition: background .12s;
        "
        onmouseenter="this.style.background='rgba(255,255,255,0.03)'"
        onmouseleave="this.style.background='transparent'"
      >
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
          <span style="font-size:10px; font-weight:600; color:#d0d0d0;">${p.id} · ${p.name}</span>
          <span style="font-size:9px; color:${group.color}; background:rgba(255,255,255,0.05); padding:1px 5px; border-radius:2px; flex-shrink:0; margin-left:6px;">${p.loGN}</span>
        </div>
        <div style="font-size:9px; color:#555; margin-bottom:2px;">${p.deliverable}</div>
        <div style="font-size:9px; color:#3a3a3a;">${p.fileType}</div>
        <div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:3px;">
          ${p.trades.slice(0,4).map(t => `<span style="font-size:8px; color:#444; background:#111; border:1px solid #222; border-radius:2px; padding:1px 5px;">${t}</span>`).join('')}
          ${p.trades.length > 4 ? `<span style="font-size:8px; color:#333;">+${p.trades.length-4}</span>` : ''}
        </div>
      </div>
    `).join('');
  }

  function _selectLp(lpId) {
    const isOpen = document.getElementById(`rpLpPhases_${lpId}`).style.display !== 'none';

    // Alle einklappen
    BIM_GROUPS.forEach(g => {
      document.getElementById(`rpLpPhases_${g.id}`).style.display = 'none';
      document.getElementById(`rpLpArrow_${g.id}`).textContent = '▸';
      document.getElementById(`rpLpBtn_${g.id}`).style.borderLeft = 'none';
    });

    if (isOpen) {
      activeLp = null;
      _updateBadge();
      return;
    }

    activeLp = lpId;
    const group = BIM_GROUPS.find(g => g.id === lpId);
    document.getElementById(`rpLpPhases_${lpId}`).style.display = 'block';
    document.getElementById(`rpLpArrow_${lpId}`).textContent = '▾';
    document.getElementById(`rpLpBtn_${lpId}`).style.borderLeft = `2px solid ${group.color}`;
    _updateBadge();
  }

  function _selectPhase(lpId, phaseId) {
    activePhase = activePhase === phaseId ? null : phaseId;

    // Alle Phase-Highlights zurücksetzen
    document.querySelectorAll('[id^="rpPhase_"]').forEach(el => {
      el.style.background = 'transparent';
      el.style.borderLeft = 'none';
    });

    if (activePhase) {
      const el = document.getElementById(`rpPhase_${phaseId}`);
      const group = BIM_GROUPS.find(g => g.id === lpId);
      if (el) {
        el.style.background = 'rgba(255,255,255,0.05)';
        el.style.borderLeft = `2px solid ${group.color}`;
      }
    }
    _updateBadge();
  }

  function _updateBadge() {
    const badge = document.getElementById('rpLpActiveBadge');
    const text = document.getElementById('rpLpActiveBadgeText');
    if (!badge || !text) return;

    if (!activeLp && !activePhase) {
      badge.style.display = 'none';
      return;
    }

    const group = BIM_GROUPS.find(g => g.id === activeLp);
    let label = '';
    if (activePhase && group) {
      const phase = group.phases.find(p => p.id === activePhase);
      label = `${group.label} · ${phase ? phase.id + ' ' + phase.name : activePhase}`;
      text.style.color = group.color;
    } else if (group) {
      label = `${group.label} · ${group.name}`;
      text.style.color = group.color;
    }
    text.textContent = label;
    badge.style.display = 'block';
  }

  function _resetLpFilter() {
    activeLp = null;
    activePhase = null;
    BIM_GROUPS.forEach(g => {
      const ph = document.getElementById(`rpLpPhases_${g.id}`);
      const ar = document.getElementById(`rpLpArrow_${g.id}`);
      const bt = document.getElementById(`rpLpBtn_${g.id}`);
      if (ph) ph.style.display = 'none';
      if (ar) ar.textContent = '▸';
      if (bt) bt.style.borderLeft = 'none';
    });
    document.querySelectorAll('[id^="rpPhase_"]').forEach(el => {
      el.style.background = 'transparent';
      el.style.borderLeft = 'none';
    });
    _updateBadge();
  }

  // ── Solar-API: Panel-Inhalte befüllen ─────────────────────────────────────
  // Wird von solar.js aufgerufen statt der floating panels.

  function solarShowLoading(lat, lng) {
    openPanel('solar');
    const body = document.getElementById('rpSolarBody');
    if (!body) return;
    body.innerHTML = `
      <div style="color:#555; font-size:10px; margin-bottom:8px;">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      <div style="color:#888; text-align:center; padding:40px 0;">Lade Solar-Daten…</div>
    `;
  }

  function solarShowError(lat, lng, msg) {
    const body = document.getElementById('rpSolarBody');
    if (!body) return;
    body.innerHTML = `
      <div style="color:#555; font-size:10px; margin-bottom:8px;">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      <div style="color:#888; background:#111; border:1px solid #1e1e1e; border-radius:3px; padding:12px; font-size:11px;">${msg}</div>
    `;
  }

  function solarGetBody() {
    return document.getElementById('rpSolarBody');
  }

  function solarGetHeatmapStatusEl() {
    return document.getElementById('rpSolarHeatmapStatus');
  }

  function solarGetMonthLabelEl() {
    return document.getElementById('rpSolarHeatmapMonth');
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    init,
    reiterAnmelden,
    togglePanel,
    openPanel,
    closePanel,
    _switchTab,
    _selectLp,
    _selectPhase,
    _resetLpFilter,
    // Solar-Bridge
    solarShowLoading,
    solarShowError,
    solarGetBody,
    solarGetHeatmapStatusEl,
    solarGetMonthLabelEl,
    get isOpen() { return panelOpen; },
    get aktiverReiter() { return activeTab; },
  };

})();

document.addEventListener('DOMContentLoaded', () => {
  // Kurz warten bis roleBar im DOM ist — und bis die Werkzeugmodule ihre
  // Reiter angemeldet haben. Eine spätere Anmeldung baut das Panel ohnehin neu.
  setTimeout(() => RightPanel.init(), 200);
});
