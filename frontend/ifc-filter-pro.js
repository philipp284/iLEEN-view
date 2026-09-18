/**
 * iLEEN — IFC Filter Pro
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * BSL 1.1 — non-commercial use permitted
 *
 * Features:
 *  • Stichwortsuche (fuzzy token-match, DE + EN)
 *  • Rollenbasierte Kategorie-Ansicht
 *  • Ausgewählte Elemente sammeln
 *  • LM Studio API → plain-text Zusammenfassung je Rolle
 *
 * Ladereihenfolge: nach core.js, features.js, ui.js, ui-helpers-modern.js
 */

'use strict';

// =====================================================
// ROLLEN-DEFINITIONEN
// =====================================================
const IFC_ROLE_CATEGORIES = {
  architect:    { label: 'Architekt',    icon: '🏛️', primary: ['structure','interior','building'], secondary: ['other'],              hidden: [] },
  engineer:     { label: 'Ingenieur',    icon: '⚙️', primary: ['structure'],                       secondary: ['building'],            hidden: ['interior','mep','other'] },
  fm:           { label: 'FM',           icon: '🔧', primary: ['mep','interior'],                  secondary: ['building','structure'], hidden: [] },
  structural:   { label: 'Tragwerk',     icon: '🏗️', primary: ['structure'],                       secondary: [],                      hidden: ['interior','mep','other','building'] },
  sitemanager:  { label: 'Bauleiter',    icon: '🦺', primary: ['structure','building'],             secondary: ['interior'],            hidden: ['mep'] },
  surveyor:     { label: 'Vermesser',    icon: '📐', primary: ['building'],                        secondary: ['structure'],           hidden: ['interior','mep','other'] },
  monument:     { label: 'Denkmal',      icon: '🏰', primary: ['structure','interior','building'], secondary: ['other'],              hidden: ['mep'] },
  manufacturer: { label: 'Hersteller',   icon: '🏭', primary: ['other','structure'],               secondary: ['interior','mep'],     hidden: [] },
  taskforce:    { label: 'Taskforce',    icon: '🚨', primary: ['structure','interior','mep'],       secondary: ['building','other'],    hidden: [] },
  construction: { label: 'Ausführung',   icon: '🏚️', primary: ['structure','building'],             secondary: ['interior','other'],    hidden: [] }
};

// Deutsche Anzeigenamen für IFC-Entitäten
const IFC_ENTITY_DE = {
  IfcWall:                       'Wand',
  IfcWallStandardCase:           'Wand (Standard)',
  IfcColumn:                     'Stütze',
  IfcBeam:                       'Unterzug / Träger',
  IfcSlab:                       'Decke / Platte',
  IfcRoof:                       'Dach',
  IfcFooting:                    'Fundament',
  IfcPile:                       'Pfahl',
  IfcDoor:                       'Tür',
  IfcWindow:                     'Fenster',
  IfcStair:                      'Treppe',
  IfcRailing:                    'Geländer',
  IfcRamp:                       'Rampe',
  IfcCurtainWall:                'Vorhangfassade',
  IfcPlate:                      'Platte',
  IfcCovering:                   'Bekleidung',
  IfcPipeSegment:                'Rohr',
  IfcPipeFitting:                'Rohrformstück',
  IfcDuctSegment:                'Lüftungskanal',
  IfcDuctFitting:                'Kanalformstück',
  IfcFlowTerminal:               'Endgerät',
  IfcCableSegment:               'Kabel',
  IfcCableCarrierSegment:        'Kabelträger',
  IfcLightFixture:               'Leuchte',
  IfcFlowSegment:                'Strömungsabschnitt',
  IfcFlowFitting:                'Strömungsformstück',
  IfcFlowController:             'Strömungsregler',
  IfcFlowMovingDevice:           'Strömungsfördergerät',
  IfcFlowStorageDevice:          'Strömungsspeicher',
  IfcDistributionControlElement: 'Steuerungselement',
  IfcSpace:                      'Raum',
  IfcBuildingStorey:             'Geschoss',
  IfcBuilding:                   'Gebäude',
  IfcSite:                       'Grundstück',
  IfcFurnishingElement:          'Möbel',
  IfcBuildingElementProxy:       'Proxy-Element',
  IfcMember:                     'Stabwerk-Element',
  IfcOpeningElement:             'Öffnung',
  IfcDiscreteAccessory:          'Zubehör',
  IfcFastener:                   'Verbindungsmittel',
  IfcMechanicalFastener:         'Mechanisches Verbindungsmittel',

  // Teile & Schichten
  IfcBuildingElementPart:        'Bauteilschicht',
  IfcElementAssembly:            'Baugruppe',
  IfcElementComponent:           'Bauteilkomponente',
  IfcReinforcingBar:             'Bewehrungsstab',
  IfcReinforcingMesh:            'Bewehrungsmatte',
  IfcReinforcingElement:         'Bewehrung',
  IfcTendon:                     'Spannglied',
  IfcTendonAnchor:               'Spanngliedverankerung',

  // *StandardCase
  IfcSlabStandardCase:           'Decke (Standard)',
  IfcColumnStandardCase:         'Stütze (Standard)',
  IfcBeamStandardCase:           'Träger (Standard)',
  IfcMemberStandardCase:         'Stabwerk (Standard)',
  IfcPlateStandardCase:          'Platte (Standard)',
  IfcDoorStandardCase:           'Tür (Standard)',
  IfcWindowStandardCase:         'Fenster (Standard)',
  IfcWallElementedCase:          'Wand (elementiert)',
  IfcSlabElementedCase:          'Decke (elementiert)',

  IfcStairFlight:                'Treppenlauf',
  IfcRampFlight:                 'Rampenlauf',
  IfcChimney:                    'Schornstein',
  IfcShadingDevice:              'Sonnenschutz',
  IfcSanitaryTerminal:           'Sanitärobjekt',
  IfcAirTerminal:                'Luftauslass',
  IfcSpaceHeater:                'Heizkörper',
  IfcTransportElement:           'Aufzug / Förderanlage',
  IfcSystemFurnitureElement:     'Systemmöbel',
  IfcAnnotation:                 'Beschriftung',
  IfcVirtualElement:             'Virtuelles Element',
  IfcGrid:                       'Achsraster',
  IfcZone:                       'Zone',
  IfcExternalSpatialElement:     'Außenraum'
};

const IFC_CATEGORY_META = {
  structure: { label: 'Tragwerk',        icon: '🏗️' },
  interior:  { label: 'Innenausbau',     icon: '🚪' },
  mep:       { label: 'TGA / MEP',       icon: '⚡' },
  building:  { label: 'Gebäudestruktur', icon: '🏢' },
  // Schichten mehrschichtiger Bauteile, Bewehrung, Verbindungsmittel: alles,
  // was zu einem anderen Bauteil gehoert statt selbst eines zu sein.
  parts:     { label: 'Teile & Schichten', icon: '🧱' },
  other:     { label: 'Sonstiges',       icon: '📦' }
};

// =====================================================
// STATE of the art
// =====================================================
window.IFCFilterPro = {
  searchQuery:  '',
  // Die Typenliste zaehlt ueber 60 Eintraege, ein Modell fuehrt selten mehr
  // als ein Dutzend. Standardmaessig zeigt die Liste deshalb nur, was der
  // Typ-Scan im geladenen Modell tatsaechlich gefunden hat.
  nurVorhandene: true,
  selectedElements: [],
  lmEndpoint:   'http://localhost:1234',
  lmModel:      '',
  lmLoading:    false,
  lmResult:     ''
};

// =====================================================
// PANEL HTML
// =====================================================
IFCFilterPro.getPanelHTML = function () {
  return `
    <div class="ifcp-search-wrap">
      <span class="ifcp-search-icon">⌕</span>
      <input id="ifcp-search" class="ifcp-search" type="search"
             placeholder="Suche: Wand, Beam, TGA, Stütze…"
             autocomplete="off"
             oninput="IFCFilterPro.onSearch(this.value)">
      <button class="ifcp-search-clear"
              onclick="document.getElementById('ifcp-search').value='';IFCFilterPro.onSearch('')"
              title="Löschen">×</button>
    </div>

    <div class="ifcp-role-hint">
      Ansicht: <span id="ifcp-role-label">—</span>
    </div>

    <div class="ifcp-catbar-wrap">
      <div class="ifcp-catbar-title">Kategorien</div>
      <div id="ifcp-catbar" class="ifcp-catbar"></div>
    </div>

    <div class="ifcp-actions-row">
      <button class="ifcp-btn ifcp-btn-sm"
              onclick="BimViewer.selectAllIFCTypes();BimViewer.updateIFCFilterUI();">Alle</button>
      <button class="ifcp-btn ifcp-btn-sm ifcp-btn-ghost"
              onclick="BimViewer.deselectAllIFCTypes();BimViewer.updateIFCFilterUI();">Keine</button>
      <label class="ifcp-only-toggle" title="Nur Typen zeigen, die im geladenen Modell vorkommen">
        <input type="checkbox" id="ifcp-only-present" checked
               onchange="IFCFilterPro.setNurVorhandene(this.checked)">
        <span>nur im Modell</span>
      </label>
      <div style="flex:1"></div>
      <span id="activeEntityCount" class="ifcp-count-badge">0</span>
      <span style="font-size:10px;color:var(--text-muted,#6b7084)">/</span>
      <span id="totalEntityCount" class="ifcp-count-badge ifcp-count-total">0</span>
    </div>

    <div id="ifcFiltersList" class="ifcp-list"></div>

    <div class="ifcp-section-divider"></div>

    <div class="ifcp-section-header">
      <span>Ausgewählte Elemente</span>
      <button class="ifcp-btn ifcp-btn-xs ifcp-btn-ghost"
              onclick="IFCFilterPro.clearSelected()">Leeren</button>
    </div>
    <div id="ifcp-selected-list" class="ifcp-selected-list">
      <span class="ifcp-empty-small">Noch kein Element angeklickt</span>
    </div>

    <div class="ifcp-section-divider"></div>

    <div class="ifcp-section-header">
      <span>KI-Zusammenfassung</span>
      <span class="ifcp-lm-badge">LM Studio</span>
    </div>

    <div class="ifcp-lm-endpoint-row">
      <input id="ifcp-lm-endpoint" class="ifcp-lm-endpoint" type="url"
             value="${this.lmEndpoint}"
             placeholder="http://localhost:1234"
             title="LM Studio API Endpoint">
    </div>

    <button id="ifcp-lm-btn" class="ifcp-btn ifcp-btn-lm" onclick="IFCFilterPro.generate()">
      <span id="ifcp-lm-spinner" class="ifcp-lm-spinner" style="display:none"></span>
      Zusammenfassung erstellen
    </button>

    <div id="ifcp-lm-output" class="ifcp-lm-output"></div>

    <div class="ifcp-lm-copy-row">
      <button id="ifcp-lm-copy" class="ifcp-btn ifcp-btn-xs"
              onclick="IFCFilterPro.copyResult()">Kopieren</button>
    </div>
  `;
};

// =====================================================
// FILTER-LISTE RENDERN
// =====================================================
IFCFilterPro.renderFilterList = function () {
  const container = document.getElementById('ifcFiltersList');
  if (!container || typeof IFC_ENTITIES === 'undefined') return;

  const role     = (typeof BimViewerUI !== 'undefined') ? BimViewerUI.currentRole : 'architect';
  const roleConf = IFC_ROLE_CATEGORIES[role] || IFC_ROLE_CATEGORIES.architect;
  const query    = this.searchQuery.trim().toLowerCase();

  // Rollenanzeige aktualisieren
  const roleLabel = document.getElementById('ifcp-role-label');
  if (roleLabel && roleConf) {
    roleLabel.textContent = `${roleConf.icon} ${roleConf.label}`;
  }

  // Kategorien nach Priorität
  const allCats   = Object.keys(IFC_CATEGORY_META);
  const orderedCats = [
    ...roleConf.primary,
    ...roleConf.secondary,
    ...allCats.filter(c =>
      !roleConf.primary.includes(c) &&
      !roleConf.secondary.includes(c) &&
      !roleConf.hidden.includes(c)
    )
  ];

  // Gruppieren — die Liste zeigt wahlweise alles oder nur, was der Typ-Scan
  // im Modell gefunden hat.
  const byCategory = {};
  this.sichtbareTypen().forEach(entity => {
    const cat = entity.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(entity);
  });

  // Token-Suche
  const tokenMatch = (entity, q) => {
    if (!q) return true;
    const haystack = [
      entity.entity.toLowerCase(),
      entity.displayName.toLowerCase(),
      (IFC_ENTITY_DE[entity.entity] || '').toLowerCase()
    ].join(' ');
    return q.split(/\s+/).every(token => haystack.includes(token));
  };

  let html = '';

  orderedCats.forEach(catKey => {
    const meta = IFC_CATEGORY_META[catKey];
    if (!meta) return;

    const entities = (byCategory[catKey] || []).filter(e => tokenMatch(e, query));
    if (entities.length === 0) return;

    const isPrimary   = roleConf.primary.includes(catKey);
    const isSecondary = roleConf.secondary.includes(catKey);

    // Kategoriezustand: der Kopf ist selbst ein Schalter
    const alleZeigen = !this.nurVorhandene;
    const zustand = BimViewer.ifcKategorieZustand
      ? BimViewer.ifcKategorieZustand(catKey, alleZeigen) : 'alle';
    const anZahl = entities.filter(e =>
      BimViewer.ifcFilter && BimViewer.ifcFilter.enabledEntities.has(e.entity)).length;
    const augeKat = zustand === 'alle' ? '●' : (zustand === 'keine' ? '○' : '◐');

    html += `
      <div class="ifcp-category ${isPrimary ? 'ifcp-cat-primary' : 'ifcp-cat-secondary'} ifcp-cat-${zustand}">
        <div class="ifcp-cat-header ifcp-cat-clickable"
             onclick="BimViewer.toggleIFCCategory('${catKey}', ${alleZeigen})"
             title="Kategorie ${meta.label} ein-/ausblenden">
          <span class="ifcp-cat-eye">${augeKat}</span>
          <span class="ifcp-cat-icon">${meta.icon}</span>
          <span class="ifcp-cat-label">${meta.label}</span>
          <span class="ifcp-cat-count">${anZahl}/${entities.length}</span>
          ${isSecondary ? '<span class="ifcp-cat-badge">Nebenbereich</span>' : ''}
          <button class="ifcp-cat-solo"
                  onclick="event.stopPropagation();BimViewer.isolateIFCCategory('${catKey}', ${alleZeigen})"
                  title="Nur diese Kategorie zeigen">solo</button>
        </div>
        <div class="ifcp-items">
          ${entities.map(entity => {
            const isOn   = BimViewer.ifcFilter && BimViewer.ifcFilter.enabledEntities.has(entity.entity);
            const deName = IFC_ENTITY_DE[entity.entity] || entity.displayName;
            const anzahl = (BimViewer.ifcFilter && BimViewer.ifcFilter.gefundeneTypen)
              ? BimViewer.ifcFilter.gefundeneTypen.get(entity.entity) : 0;
            const zaehler = anzahl ? `<span class="ifcp-item-count">${anzahl}</span>` : '';
            return `
              <div class="ifcp-item${isOn ? ' ifcp-item-active' : ''}${entity.entdeckt ? ' ifcp-item-entdeckt' : ''}"
                   onclick="IFCFilterPro.toggleClick('${entity.entity}', this)"
                   title="${entity.entity}${entity.entdeckt ? ' — im Modell gefunden, nicht in der Typenliste' : ''}">
                <span class="ifcp-dot" style="background:${entity.color};"></span>
                <span class="ifcp-name">${deName}</span>
                ${zaehler}
                <span class="ifcp-sub">${entity.entity}</span>
                <span class="ifcp-eye">${isOn ? '●' : '○'}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  });

  if (!html) {
    html = this.searchQuery
      ? `<div class="ifcp-empty">Kein Bauteiltyp gefunden für <em>"${this.searchQuery}"</em></div>`
      : `<div class="ifcp-empty">Noch keine Bauteiltypen im geladenen Modell erkannt.<br>
           <a href="#" onclick="IFCFilterPro.setNurVorhandene(false);return false;">Ganze Typenliste zeigen</a></div>`;
  }

  // Beim Umschalten wird die ganze Liste neu gebaut — ohne das hier spraenge
  // sie bei jedem Klick an den Anfang zurueck.
  const scroll = container.scrollTop;
  container.innerHTML = html;
  container.scrollTop = scroll;
  this.renderCategoryBar();
};

// =====================================================
// KATEGORIELEISTE
// =====================================================
//
// Die Chips oben sind derselbe Schalter wie der Kategoriekopf, nur immer
// sichtbar — man muss nicht erst zur Gruppe scrollen, um "TGA weg" zu sagen.
IFCFilterPro.renderCategoryBar = function () {
  const bar = document.getElementById('ifcp-catbar');
  if (!bar || typeof BimViewer === 'undefined') return;

  const vorhanden = {};
  this.sichtbareTypen().forEach(e => {
    const cat = e.category || 'other';
    vorhanden[cat] = (vorhanden[cat] || 0) + 1;
  });

  const chips = Object.keys(IFC_CATEGORY_META).filter(k => vorhanden[k]);
  if (!chips.length) { bar.innerHTML = '<span class="ifcp-empty-small">—</span>'; return; }

  bar.innerHTML = chips.map(catKey => {
    const meta       = IFC_CATEGORY_META[catKey];
    const alleZeigen = !this.nurVorhandene;
    const zustand = BimViewer.ifcKategorieZustand
      ? BimViewer.ifcKategorieZustand(catKey, alleZeigen) : 'alle';
    return `
      <button class="ifcp-chip ifcp-chip-${zustand}"
              onclick="BimViewer.toggleIFCCategory('${catKey}', ${alleZeigen})"
              title="${meta.label} ein-/ausblenden — Doppelklick: nur diese Kategorie"
              ondblclick="event.preventDefault();BimViewer.isolateIFCCategory('${catKey}', ${alleZeigen})">
        <span class="ifcp-chip-icon">${meta.icon}</span>
        <span class="ifcp-chip-label">${meta.label}</span>
        <span class="ifcp-chip-count">${vorhanden[catKey]}</span>
      </button>`;
  }).join('');
};

// Welche Typen die Liste zeigt: alle bekannten oder nur die im Modell
// gefundenen. Solange nichts gescannt wurde, immer alle — sonst stuende die
// Liste vor dem ersten geladenen Modell leer da.
IFCFilterPro.sichtbareTypen = function () {
  if (typeof IFC_ENTITIES === 'undefined') return [];
  const gefunden = (typeof BimViewer !== 'undefined' && BimViewer.ifcFilter)
    ? BimViewer.ifcFilter.gefundeneTypen : null;
  if (!this.nurVorhandene || !gefunden || gefunden.size === 0) return IFC_ENTITIES.slice();
  return IFC_ENTITIES.filter(e => gefunden.has(e.entity));
};

IFCFilterPro.setNurVorhandene = function (an) {
  this.nurVorhandene = !!an;
  const box = document.getElementById('ifcp-only-present');
  if (box) box.checked = this.nurVorhandene;
  this.renderFilterList();
};

// =====================================================
// TOGGLE
// =====================================================
IFCFilterPro.toggleClick = function (entityName, el) {
  const isOn = BimViewer.ifcFilter.enabledEntities.has(entityName);
  const eye = el.querySelector('.ifcp-eye');
  if (isOn) {
    BimViewer.ifcFilter.enabledEntities.delete(entityName);
    el.classList.remove('ifcp-item-active');
    if (eye) eye.textContent = '○';
  } else {
    BimViewer.ifcFilter.enabledEntities.add(entityName);
    el.classList.add('ifcp-item-active');
    if (eye) eye.textContent = '●';
  }
  BimViewer.applyIFCFilter();
  BimViewer.updateEntityCounts();
  // Der Eintrag ist am Zeichen schon umgeschaltet; Kopf und Chip der
  // Kategorie muessen den neuen Zaehlerstand nachziehen.
  this.renderFilterList();
};

// =====================================================
// SUCHE
// =====================================================
IFCFilterPro.onSearch = function (value) {
  this.searchQuery = value;
  this.renderFilterList();
};

// =====================================================
// AUSGEWÄHLTE ELEMENTE
// =====================================================
IFCFilterPro.addElement = function (properties) {
  const type   = properties.className || properties.IfcEntity || properties.element_type || 'Unknown';
  const name   = properties.Name || properties.name || '';
  const mat    = properties.Material || properties.MaterialName || '';
  const exists = this.selectedElements.findIndex(e =>
    e.type === type && e.name === name && e.mat === mat
  );
  if (exists === -1) {
    this.selectedElements.push({ type, name, mat, props: properties });
    this.refreshSelectedList();
  }
};

IFCFilterPro.refreshSelectedList = function () {
  const list = document.getElementById('ifcp-selected-list');
  if (!list) return;
  if (this.selectedElements.length === 0) {
    list.innerHTML = '<span class="ifcp-empty-small">Noch kein Element angeklickt</span>';
    return;
  }
  list.innerHTML = this.selectedElements.map((el, i) => `
    <div class="ifcp-sel-item">
      <span class="ifcp-sel-type">${el.type.replace('Ifc', '')}</span>
      <span class="ifcp-sel-name">${el.name || '—'}</span>
      <button class="ifcp-sel-remove" onclick="IFCFilterPro.removeSelected(${i})" title="Entfernen">×</button>
    </div>
  `).join('');
};

IFCFilterPro.removeSelected = function (i) {
  this.selectedElements.splice(i, 1);
  this.refreshSelectedList();
};

IFCFilterPro.clearSelected = function () {
  this.selectedElements = [];
  this.refreshSelectedList();
  this.lmResult = '';
  const output = document.getElementById('ifcp-lm-output');
  if (output) output.textContent = '';
};

// =====================================================
// LM STUDIO API
// =====================================================
IFCFilterPro.buildPrompt = function () {
  const role      = (typeof BimViewerUI !== 'undefined') ? BimViewerUI.currentRole : 'architect';
  const roleConf  = IFC_ROLE_CATEGORIES[role] || {};
  const roleLabel = roleConf.label || role;

  const elementsSummary = this.selectedElements.length > 0
    ? this.selectedElements.map(el => {
        const parts = [`Typ: ${el.type}`];
        if (el.name) parts.push(`Name: ${el.name}`);
        if (el.mat)  parts.push(`Material: ${el.mat}`);
        const extra = Object.entries(el.props)
          .filter(([k]) => !['className','IfcEntity','Name','Material','MaterialName'].includes(k))
          .slice(0, 6)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        if (extra) parts.push(extra);
        return '• ' + parts.join(' | ');
      }).join('\n')
    : '(keine Elemente ausgewählt)';

  const activeTypes = [...BimViewer.ifcFilter.enabledEntities].slice(0, 20).join(', ') || 'alle';

  return `Du bist ein BIM-Fachexperte. Erstelle eine kurze, sachliche Zusammenfassung (3–8 Sätze, plain text, keine Markdown-Formatierung) für die Rolle "${roleLabel}".

Aktive IFC-Filter: ${activeTypes}

Ausgewählte / angeklickte Bauteile:
${elementsSummary}

Fokus für "${roleLabel}": Nur das Relevante — technische Kennwerte, Materialien, Mengen oder Systemzugehörigkeit je nach Rolle. Kein Jargon, klare Sprache.`;
};

IFCFilterPro.generate = async function () {
  if (this.lmLoading) return;

  const btn        = document.getElementById('ifcp-lm-btn');
  const spinner    = document.getElementById('ifcp-lm-spinner');
  const output     = document.getElementById('ifcp-lm-output');
  const endpointEl = document.getElementById('ifcp-lm-endpoint');

  const base    = (endpointEl && endpointEl.value.trim()) || this.lmEndpoint;
  this.lmEndpoint = base;
  const apiUrl  = base.replace(/\/$/, '') + '/v1/chat/completions';

  this.lmLoading = true;
  if (btn)     btn.disabled = true;
  if (spinner) spinner.style.display = 'inline-block';
  if (output)  output.textContent = 'Generiere…';

  try {
    const payload = {
      messages: [{ role: 'user', content: this.buildPrompt() }],
      temperature: 0.3,
      max_tokens: 512,
      stream: false
    };
    if (this.lmModel) payload.model = this.lmModel;

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);

    const data  = await res.json();
    const text  = data?.choices?.[0]?.message?.content?.trim() || '(keine Antwort)';
    this.lmResult = text;
    if (output) output.textContent = text;

  } catch (err) {
    if (output) output.textContent = `Fehler: ${err.message}\n\nLM Studio läuft? Endpoint korrekt?`;
  } finally {
    this.lmLoading = false;
    if (btn)     btn.disabled = false;
    if (spinner) spinner.style.display = 'none';
  }
};

IFCFilterPro.copyResult = function () {
  if (!this.lmResult) return;
  navigator.clipboard.writeText(this.lmResult).then(() => {
    const btn = document.getElementById('ifcp-lm-copy');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Kopiert ✓';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  });
};

// =====================================================
// PATCHES (nach allen anderen Modulen per DOMContentLoaded)
// =====================================================
function ifcpInstallPatches() {
  if (typeof BimViewer === 'undefined') {
    setTimeout(ifcpInstallPatches, 100);
    return;
  }

  // updateIFCFilterUI delegieren
  BimViewer.updateIFCFilterUI = function () {
    IFCFilterPro.renderFilterList();
  };

  // BimViewerUI.switchRole patchen (Rollenansicht im Panel)
  if (typeof BimViewerUI !== 'undefined') {
    const _origSwitch = BimViewerUI.switchRole.bind(BimViewerUI);
    BimViewerUI.switchRole = function (roleId) {
      _origSwitch(roleId);
      IFCFilterPro.renderFilterList();
    };
  }

  // displayIFCProperties patchen (Elemente sammeln)
  if (typeof BimViewer.displayIFCProperties === 'function') {
    const _origDisplay = BimViewer.displayIFCProperties.bind(BimViewer);
    BimViewer.displayIFCProperties = function (properties) {
      _origDisplay(properties);
      IFCFilterPro.addElement(properties);
    };
  }

  console.log('✅ IFC Filter Pro patches installed');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(ifcpInstallPatches, 200));
} else {
  setTimeout(ifcpInstallPatches, 200);
}

console.log('✅ IFC Filter Pro loaded (v1.0)');
