/**
 * iLEEN — Rollenbasierte Bauteileigenschaften
 *
 * Ersetzt die frühere Anzeige, die jede Property in sechs feste Schubladen
 * sortierte und alles gleichzeitig zeigte. Zwei Probleme hatte das:
 *
 *  * **Zu wenig.** Angezeigt wurde nur die Batch Table des 3D-Tiles — bei
 *    Backend-Modellen ein Dutzend Felder. Die vollständigen IFC-Property-Sets
 *    liegen in der Bauteildatenbank und wurden nie abgerufen.
 *  * **Zu viel vom Falschen.** Ein Tragwerksplaner scrollte durch
 *    Herstellerangaben, ein Facility Manager durch Bewehrungsgrade.
 *
 * Deshalb: pro Rolle ein Profil aus thematischen Gruppen, jede mit Mustern für
 * die Feldnamen. Was zur Rolle passt, steht oben und aufgeklappt; alles andere
 * bleibt vollständig erhalten, aber unter „Weitere Eigenschaften" zugeklappt.
 * Es geht also nichts verloren — es wird nur sortiert.
 *
 * **Feldnamen sind nie einheitlich.** Revit, Allplan, ArchiCAD und Tekla
 * benennen dieselbe Angabe unterschiedlich, in zwei Sprachen, mit und ohne
 * Pset-Präfix. Der Abgleich läuft deshalb über normalisierte Teilstrings
 * (klein, ohne Umlaute, ohne Trenner) statt über exakte Namen.
 */
'use strict';

const IFCRoleProperties = (() => {

  // ── Wortfelder ────────────────────────────────────────────────────────────
  // Einmal definiert und in mehreren Rollen wiederverwendet — dieselbe Gruppe
  // interessiert oft mehrere Rollen, nur an anderer Stelle in der Reihenfolge.

  const FIELDS = {
    identity: [
      'name', 'globalid', 'guid', 'ifcentity', 'classname', 'elementtype', 'objecttype',
      'typename', 'bauteiltyp', 'familie', 'family', 'typ', 'type', 'tag', 'kennzeichen',
      'geschoss', 'storey', 'level', 'ebene', 'gebaeude', 'building', 'raum', 'room',
      'beschreibung', 'description',
    ],
    dimensions: [
      'laenge', 'length', 'breite', 'width', 'hoehe', 'height', 'dicke', 'thickness',
      'flaeche', 'area', 'volumen', 'volume', 'umfang', 'perimeter', 'durchmesser',
      'diameter', 'radius', 'staerke', 'nettoflaeche', 'bruttoflaeche', 'netarea',
      'grossarea', 'netvolume', 'grossvolume',
    ],
    buildup: [
      'material', 'materialname', 'schicht', 'layer', 'aufbau', 'konstruktion',
      'construction', 'oberflaeche', 'finish', 'belag', 'anstrich', 'beschichtung',
      'farbe', 'color', 'colour', 'struktur', 'textur',
    ],
    physics: [
      'uwert', 'uvalue', 'wärmedurchgang', 'waermedurchgang', 'thermaltransmittance',
      'rwert', 'rvalue', 'thermalresistance', 'lambda', 'waermeleit', 'schallschutz',
      'schalldaemm', 'acoustic', 'sound', 'brandschutz', 'feuerwiderstand', 'fire',
      'firerating', 'feuchte', 'moisture', 'diffusion', 'luftdicht', 'airtight',
      'isexternal', 'aussenbauteil', 'tragend',
    ],
    openings: [
      'fenster', 'window', 'tuer', 'door', 'verglasung', 'glazing', 'glas', 'glass',
      'rahmen', 'frame', 'fluegel', 'sash', 'lichtmass', 'rohbaumass', 'brueckstung',
      'gvalue', 'gwert', 'lichttransmission', 'oeffnung', 'opening',
    ],
    structure: [
      'tragend', 'loadbearing', 'structural', 'tragwerk', 'statik', 'festigkeit',
      'strength', 'betonguete', 'betonfestigkeit', 'stahlguete', 'steelgrade',
      'expositionsklasse', 'exposure', 'bewehrungsgrad', 'auflager', 'support',
      'spannweite', 'span', 'systemlaenge', 'knicklaenge', 'stuetzweite',
    ],
    section: [
      'profil', 'profile', 'querschnitt', 'section', 'sectiontype', 'sectionname',
      'traegheitsmoment', 'momentofinertia', 'widerstandsmoment', 'sectionmodulus',
      'querschnittsflaeche', 'crosssection', 'steg', 'flansch', 'web', 'flange',
      'ipe', 'hea', 'heb', 'upe',
    ],
    loads: [
      'last', 'load', 'eigengewicht', 'selfweight', 'deadload', 'nutzlast', 'liveload',
      'schneelast', 'snow', 'windlast', 'wind', 'auflagerkraft', 'reaction',
      'gewicht', 'weight', 'masse', 'mass', 'dichte', 'density',
    ],
    reinforcement: [
      'bewehrung', 'reinforcement', 'rebar', 'stabstahl', 'mattenbewehrung',
      'betondeckung', 'concretecover', 'buegelbewehrung', 'stirrup', 'spannglied',
      'tendon', 'vorspannung', 'prestress',
    ],
    quantities: [
      'menge', 'quantity', 'anzahl', 'count', 'stueck', 'volumen', 'volume',
      'flaeche', 'area', 'gewicht', 'weight', 'masse', 'mass', 'laufmeter',
      'netvolume', 'grossvolume', 'netarea', 'grossarea', 'netweight', 'grossweight',
    ],
    schedule: [
      'phase', 'bauabschnitt', 'bauphase', 'termin', 'datum', 'date', 'schedule',
      'start', 'ende', 'end', 'dauer', 'duration', 'fertigstellung', 'completion',
      'los', 'lot', 'abschnitt', 'taktbereich',
    ],
    status: [
      'status', 'zustand', 'condition', 'freigabe', 'approval', 'genehmigt',
      'approved', 'geprueft', 'checked', 'revision', 'version', 'planstand',
      'ausfuehrung', 'montiert', 'installed', 'baufortschritt', 'progress',
    ],
    supplier: [
      'hersteller', 'manufacturer', 'lieferant', 'supplier', 'marke', 'brand',
      'modell', 'model', 'artikelnummer', 'articlenumber', 'produktnummer',
      'bestellnummer', 'ordernumber', 'referenz', 'reference', 'gtin', 'ean',
    ],
    asset: [
      'assetidentifier', 'anlagenkennzeichen', 'anlagennummer', 'inventarnummer',
      'seriennummer', 'serialnumber', 'barcode', 'rfid', 'equipmentid',
      'baujahr', 'yearofmanufacture', 'installationdate', 'einbaudatum',
    ],
    maintenance: [
      'wartung', 'maintenance', 'wartungsintervall', 'serviceinterval',
      'garantie', 'warranty', 'gewaehrleistung', 'lebensdauer', 'servicelife',
      'nutzungsdauer', 'inspektion', 'inspection', 'pruefung', 'wartungsvertrag',
    ],
    operation: [
      'leistung', 'power', 'nennleistung', 'spannung', 'voltage', 'strom', 'current',
      'anschlusswert', 'volumenstrom', 'flowrate', 'druck', 'pressure', 'temperatur',
      'temperature', 'medium', 'system', 'systemtype', 'nennweite', 'nominaldiameter',
      'wirkungsgrad', 'efficiency', 'energieverbrauch',
    ],
    classification: [
      'klassifikation', 'classification', 'uniclass', 'omniclass', 'ifcclass',
      'kostengruppe', 'costgroup', 'din276', 'stlb', 'gaeb', 'kosten', 'cost',
      'preis', 'price', 'einheitspreis', 'budget',
    ],
    location: [
      'koordinate', 'coordinate', 'rechtswert', 'hochwert', 'easting', 'northing',
      'elevation', 'hoehenlage', 'oberkante', 'unterkante', 'niveau', 'nn', 'nhn',
      'longitude', 'latitude', 'laengengrad', 'breitengrad', 'position', 'achse',
      'axis', 'raster', 'grid',
    ],
    tolerance: [
      'toleranz', 'tolerance', 'genauigkeit', 'accuracy', 'abweichung', 'deviation',
      'messung', 'measurement', 'aufmass', 'soll', 'ist', 'nominal', 'actual',
    ],
  };

  /**
   * Rollenprofile: welche Gruppen in welcher Reihenfolge, und welche davon
   * beim Öffnen aufgeklappt sind. `open: true` nur für die zwei bis drei
   * Gruppen, die die Rolle wirklich zuerst ansieht — sonst ist die Liste
   * wieder so lang wie vorher.
   */
  const ROLE_PROFILES = {
    architect: [
      { key: 'identity',       fields: FIELDS.identity,       open: true },
      { key: 'dimensions',     fields: FIELDS.dimensions,     open: true },
      { key: 'buildup',        fields: FIELDS.buildup,        open: true },
      { key: 'openings',       fields: FIELDS.openings,       open: false },
      { key: 'physics',        fields: FIELDS.physics,        open: false },
      { key: 'classification', fields: FIELDS.classification, open: false },
    ],
    engineer: [
      { key: 'identity',      fields: FIELDS.identity,      open: true },
      { key: 'structure',     fields: FIELDS.structure,     open: true },
      { key: 'section',       fields: FIELDS.section,       open: true },
      { key: 'dimensions',    fields: FIELDS.dimensions,    open: false },
      { key: 'loads',         fields: FIELDS.loads,         open: false },
      { key: 'reinforcement', fields: FIELDS.reinforcement, open: false },
      { key: 'buildup',       fields: FIELDS.buildup,       open: false },
    ],
    sitemanager: [
      { key: 'identity',       fields: FIELDS.identity,       open: true },
      { key: 'quantities',     fields: FIELDS.quantities,     open: true },
      { key: 'status',         fields: FIELDS.status,         open: true },
      { key: 'schedule',       fields: FIELDS.schedule,       open: false },
      { key: 'buildup',        fields: FIELDS.buildup,        open: false },
      { key: 'supplier',       fields: FIELDS.supplier,       open: false },
      { key: 'classification', fields: FIELDS.classification, open: false },
    ],
    fm: [
      { key: 'identity',       fields: FIELDS.identity,       open: true },
      { key: 'asset',          fields: FIELDS.asset,          open: true },
      { key: 'maintenance',    fields: FIELDS.maintenance,    open: true },
      { key: 'operation',      fields: FIELDS.operation,      open: false },
      { key: 'supplier',       fields: FIELDS.supplier,       open: false },
      { key: 'classification', fields: FIELDS.classification, open: false },
    ],
    surveyor: [
      { key: 'identity',   fields: FIELDS.identity,   open: true },
      { key: 'location',   fields: FIELDS.location,   open: true },
      { key: 'dimensions', fields: FIELDS.dimensions, open: true },
      { key: 'tolerance',  fields: FIELDS.tolerance,  open: false },
    ],
  };

  /**
   * Einheiten je Wortfeld. IFC führt Einheiten getrennt von den Werten, und in
   * der Batch Table kommt nur die nackte Zahl an — ohne Zusatz steht dort
   * „Höhe 2.75" ohne erkennbares Maß.
   */
  const UNITS = [
    { patterns: ['flaeche', 'area'], unit: 'm²' },
    { patterns: ['volumen', 'volume'], unit: 'm³' },
    { patterns: ['gewicht', 'weight', 'masse', 'mass'], unit: 'kg' },
    { patterns: ['dichte', 'density'], unit: 'kg/m³' },
    { patterns: ['uwert', 'uvalue', 'thermaltransmittance'], unit: 'W/(m²·K)' },
    { patterns: ['rwert', 'rvalue', 'thermalresistance'], unit: 'm²·K/W' },
    { patterns: ['lambda', 'waermeleit'], unit: 'W/(m·K)' },
    { patterns: ['temperatur', 'temperature'], unit: '°C' },
    { patterns: ['leistung', 'power'], unit: 'W' },
    { patterns: ['spannung', 'voltage'], unit: 'V' },
    { patterns: ['druck', 'pressure'], unit: 'Pa' },
    { patterns: ['schalldaemm', 'sound'], unit: 'dB' },
    { patterns: ['laenge', 'length', 'breite', 'width', 'hoehe', 'height',
                 'dicke', 'thickness', 'durchmesser', 'diameter', 'umfang',
                 'perimeter', 'spannweite', 'span'], unit: 'm' },
  ];

  const UMLAUTS = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };

  /** Klein, ohne Umlaute, ohne Trenner — „U-Wert" und „uValue" werden vergleichbar. */
  function normalize(text) {
    return String(text ?? '')
      .toLowerCase()
      .replace(/[äöüß]/g, (c) => UMLAUTS[c])
      .replace(/[\s_\-.:/\\()[\]]/g, '');
  }

  function matchesGroup(key, fields) {
    const normalized = normalize(key);
    return fields.some((field) => normalized.includes(field));
  }

  function unitFor(key) {
    const normalized = normalize(key);
    const hit = UNITS.find((u) => u.patterns.some((p) => normalized.includes(p)));
    return hit ? hit.unit : '';
  }

  // ── Werte aufbereiten ─────────────────────────────────────────────────────

  function formatValue(key, value) {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'boolean') {
      return value ? t('state.yes') : t('state.no');
    }

    // IFC-Booleans kommen je nach Exporter als Text an.
    const asText = String(value).trim();
    if (/^(true|false)$/i.test(asText)) {
      return /^true$/i.test(asText) ? t('state.yes') : t('state.no');
    }

    const asNumber = typeof value === 'number' ? value : Number(asText.replace(',', '.'));
    if (Number.isFinite(asNumber) && asText !== '') {
      const unit = unitFor(key);
      // Ganze Zahlen ohne Nachkommastellen, gemessene Werte auf drei — mehr
      // täuscht eine Genauigkeit vor, die ein IFC-Export nicht hergibt.
      const rounded = Number.isInteger(asNumber)
        ? asNumber.toLocaleString(ILeenI18n.getLanguage())
        : asNumber.toLocaleString(ILeenI18n.getLanguage(), { maximumFractionDigits: 3 });
      return unit ? `${rounded} ${unit}` : rounded;
    }

    return asText;
  }

  /** Feldname als Beschriftung: Pset-Präfix weg, CamelCase getrennt. */
  function formatLabel(key) {
    let label = String(key)
      .replace(/^(pset_?|qto_?|ifc|revit|element|parameters?)[_\s.]*/i, '')
      .replace(/^_+|_+$/g, '')
      .replace(/_/g, ' ')
      .replace(/([a-zäöü])([A-ZÄÖÜ])/g, '$1 $2')
      .trim();
    if (!label) label = String(key);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  // ── Eigenschaften einsammeln ──────────────────────────────────────────────

  /**
   * Ergänzt die Properties der Batch Table um die vollständigen Property-Sets
   * aus der Bauteildatenbank des Backends.
   *
   * Das ist die eigentliche Quelle für „deutlich mehr Informationen": im Tile
   * steckt nur, was in die Batch Table passte, in der SQLite daneben stehen
   * sämtliche Psets des IFC. Schlägt der Abruf fehl (Ion-Modell, kein Backend,
   * keine GlobalId), bleibt es bei den Tile-Properties — die Anzeige
   * funktioniert dann wie zuvor, nur eben knapper.
   */
  async function enrichFromBackend(properties) {
    const globalId = findValue(properties, ['globalid', 'guid', 'ifcguid']);
    if (!globalId) return properties;

    const jobId = currentBackendJobId();
    const baseUrl = window.BimViewer?.getBackendUrl?.();
    if (!jobId || !baseUrl) return properties;

    try {
      const res = await fetch(
        `${baseUrl}/assets/${jobId}/elements/${encodeURIComponent(globalId)}`
      );
      if (!res.ok) return properties;
      const element = await res.json();

      const merged = { ...properties };
      // Erst die Stammdaten, dann die Psets: bei gleichem Namen gewinnt der
      // Pset-Wert, weil er aus dem IFC selbst stammt und nicht aus der
      // verkürzten Batch Table.
      for (const [key, value] of Object.entries({
        Name: element.name,
        Beschreibung: element.description,
        Geschoss: element.storey,
        Objekttyp: element.object_type,
      })) {
        if (value != null && merged[key] === undefined) merged[key] = value;
      }
      for (const [psetName, entries] of Object.entries(element.psets || {})) {
        if (!entries || typeof entries !== 'object') continue;
        for (const [key, value] of Object.entries(entries)) {
          // Pset-Name im Schlüssel behalten: „Pset_WallCommon.IsExternal" und
          // „Pset_Custom.IsExternal" sind zwei verschiedene Angaben.
          merged[`${psetName}.${key}`] = value;
        }
      }
      return merged;
    } catch (e) {
      console.warn('[Eigenschaften] Bauteildatenbank nicht erreichbar:', e.message);
      return properties;
    }
  }

  function findValue(properties, candidates) {
    for (const [key, value] of Object.entries(properties)) {
      if (candidates.includes(normalize(key)) && value) return String(value);
    }
    return null;
  }

  /** job_id des zuletzt angeklickten Backend-Assets, sofern es eines war. */
  function currentBackendJobId() {
    const assets = window.BimViewer?.loadedAssets;
    if (!assets) return null;
    const selected = window.BimViewer?.selectedTileset;
    for (const data of assets.values()) {
      if (data.type !== 'BACKEND' || !data.jobId) continue;
      if (!selected || data.tileset === selected) return data.jobId;
    }
    return null;
  }

  // ── Darstellung ───────────────────────────────────────────────────────────

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function buildHtml(properties, role) {
    const profile = ROLE_PROFILES[role] || ROLE_PROFILES.architect;

    const entries = Object.entries(properties)
      .map(([key, value]) => ({ key, label: formatLabel(key), value: formatValue(key, value) }))
      .filter((entry) => entry.value !== null);

    if (!entries.length) {
      return `<div class="props-empty">${escapeHtml(t('props.noData'))}</div>`;
    }

    const used = new Set();
    const sections = [];

    for (const group of profile) {
      const hits = entries.filter(
        (entry) => !used.has(entry.key) && matchesGroup(entry.key, group.fields)
      );
      if (!hits.length) continue;
      hits.forEach((entry) => used.add(entry.key));
      sections.push(groupHtml(t(`pgroup.${group.key}`), hits, group.open));
    }

    // Was keiner Rollengruppe zugeordnet werden konnte, geht nicht verloren —
    // es steht vollständig am Ende, zugeklappt.
    const rest = entries.filter((entry) => !used.has(entry.key));
    if (rest.length) {
      sections.push(groupHtml(t('props.moreProperties'), rest, false));
    }

    const header = `
      <div class="props-role-header">
        <span class="props-role-name">${escapeHtml(t(`role.${role}`))}</span>
        <span class="props-role-hint">${escapeHtml(t(`role.hint.${role}`))}</span>
        <span class="props-count">${entries.length}</span>
      </div>`;

    return `<div class="props-container" data-role="${escapeHtml(role)}">${header}${sections.join('')}</div>`;
  }

  function groupHtml(title, entries, open) {
    return `
      <details class="props-group"${open ? ' open' : ''}>
        <summary class="props-group-header">
          <span>${escapeHtml(title)}</span>
          <span class="props-group-count">${entries.length}</span>
        </summary>
        <div class="props-group-body">
          ${entries.map((entry) => `
            <div class="props-row">
              <div class="props-key" title="${escapeHtml(entry.key)}">${escapeHtml(entry.label)}</div>
              <div class="props-value" title="${escapeHtml(entry.value)}">${escapeHtml(entry.value)}</div>
            </div>`).join('')}
        </div>
      </details>`;
  }

  // ── Einstieg ──────────────────────────────────────────────────────────────

  let renderToken = 0;

  /**
   * Zeichnet die Eigenschaften eines Bauteils in das Panel.
   *
   * Zweistufig: die Tile-Properties stehen sofort, die vollständigen Psets
   * werden nachgeladen. Ohne das würde jeder Klick auf ein Bauteil erst nach
   * dem Netzwerkzugriff etwas anzeigen.
   */
  async function display(properties, role) {
    const target = document.getElementById('infoBoxCustom');
    if (!target) return;

    const activeRole = role || window.BimViewerUI?.currentRole || 'architect';
    const token = ++renderToken;

    target.innerHTML = buildHtml(properties, activeRole);

    const enriched = await enrichFromBackend(properties);
    // Zwischenzeitlich wurde ein anderes Bauteil angeklickt — dieses Ergebnis
    // ist überholt und darf die neuere Anzeige nicht überschreiben.
    if (token !== renderToken) return;
    if (Object.keys(enriched).length === Object.keys(properties).length) return;

    if (window.BimViewer) BimViewer.lastExtractedProperties = enriched;
    target.innerHTML = buildHtml(enriched, activeRole);
  }

  /** Zeichnet mit den zuletzt gezeigten Daten neu — bei Rollen-/Sprachwechsel. */
  function refresh() {
    const properties = window.BimViewer?.lastExtractedProperties;
    if (!properties || !Object.keys(properties).length) return;
    const target = document.getElementById('infoBoxCustom');
    if (!target) return;
    target.innerHTML = buildHtml(properties, window.BimViewerUI?.currentRole || 'architect');
  }

  document.addEventListener('ileen:language-changed', refresh);

  return {
    display, refresh, ROLE_PROFILES, formatValue, formatLabel, normalize,
    // Für Tests und zum Nachschlagen, in welcher Gruppe ein Feld landet.
    FIELDS, matchesGroup,
  };
})();

window.IFCRoleProperties = IFCRoleProperties;
