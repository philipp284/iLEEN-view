/**
 * iLEEN — Annotationen: die Notizen aus tags.js sichtbar in der Szene
 * © 2026 Tragwerkslabor / BIM-Labor HSM.
 *
 * `tags.js` hält die Notizen, konnte sie bisher aber nur auflisten — im Modell
 * war eine gesetzte Notiz unsichtbar, auffindbar nur über „Hinfliegen" in der
 * Liste. Dieses Modul zeichnet sie: ein Punkt am Anker, eine Verbindungslinie
 * und eine Beschriftung daneben.
 *
 * Die Technik ist aus **splides** übernommen (`src/annotations.ts`), dem
 * Splat-Präsentationsviewer derselben Werkstatt:
 *
 *   - Beschriftungen sind **DOM**, keine Cesium-Billboards. Nur so lassen sie
 *     sich mit dem Design-System gestalten (Markdown, Statusfarbe, Schalter)
 *     und bleiben unabhängig von der Perspektive scharf und lesbar.
 *   - Pro Bild wird der Anker projiziert und die Beschriftung per `left/top`
 *     gesetzt; Punkt und Linie hängen daran. Schreibzugriffe aufs DOM sind
 *     über `renderedText`/`renderedState` zwischengespeichert, weil diese
 *     Schleife bei **jedem** Bild läuft.
 *   - Der Versatz zwischen Anker und Beschriftung ist ziehbar und wird in
 *     *Anteilen des Viewports* gespeichert — so überlebt das Layout einen
 *     Fenstergrößenwechsel.
 *   - Überdeckung: liegen zwei Beschriftungen übereinander, gewinnt die
 *     kamera-nähere; die andere fällt auf ihren Punkt zusammen und klappt
 *     beim Überfahren wieder auf.
 *
 * Unterschied zu splides: der Anker ist kein splat-lokaler Punkt, sondern die
 * ECEF-Position, die `tags.js` beim Setzen ohnehin speichert
 * (`tag.position.worldCart`). Gepickt wird hier also nichts — das bleibt in
 * `tags.js`.
 *
 * Persistenz: die Notizen selbst gehören `tags.js`. Hier liegt nur ihr
 * Erscheinungsbild (Versatz, eingeklappt) unter `ileen_annotation_labels_v1`.
 * Dadurch bleibt das Tag-Schema unangetastet und der BCF-Export unberührt.
 */
'use strict';

(function () {

  // ============================================================
  // KONSTANTEN
  // ============================================================

  const LAYOUT_KEY = 'ileen_annotation_labels_v1';
  const STATE_KEY  = 'ileen_annotations_state_v1';

  const DEFAULT_OFFSET = { x: 0, y: -0.09 };   // knapp über dem Ankerpunkt
  const MIN_LABEL_GAP  = 4;                    // px Luft bei der Entzerrung
  const FADE_BAND      = 0.2;                  // letzte 20 % der Sichtweite blenden aus

  // Sichtweiten für das Panel — „alles" ist bewusst endlich, sonst kleben
  // Beschriftungen aus einem Nachbarmodell am Horizont.
  const DISTANCES = [
    { value: 250,     label: '250 m' },
    { value: 1000,    label: '1 km' },
    { value: 5000,    label: '5 km' },
    { value: 1e9,     label: '∞' }
  ];

  const STATUS_CLASS = {
    open:        'is-open',
    in_progress: 'is-progress',
    closed:      'is-closed'
  };

  const TYPE_ICON = {
    note:                 '📝',
    issue:                '⚠️',
    inspection:           '🔍',
    'measurement-anchor': '📐',
    custom:               '📌'
  };

  // ============================================================
  // ZUSTAND
  // ============================================================

  let viewer  = null;
  let scene   = null;
  let canvas  = null;
  let layer   = null;          // Container aller Beschriftungen
  let removeRenderListener = null;

  let enabled = true;
  let onlyOpen = false;
  let maxDistance = 1000;

  const views  = new Map();    // tagId → LabelView
  const layout = loadLayout(); // tagId → { x, y, collapsed }

  let selectedId = null;
  let draggingId = null;

  // Wiederverwendete Rechenobjekte — pro Bild und Notiz sonst neuer Müll
  const scratchEye = new Cesium.Cartesian3();
  const scratchPos = new Cesium.Cartesian3();
  let occluder = null;   // Verdeckung durch die Erdkugel, Kameraposition je Bild

  // ============================================================
  // HILFSMITTEL
  // ============================================================

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  /**
   * Der Markdown-Dialekt von splides, auf das reduziert, was in einer
   * Bauteilnotiz vorkommt: Fettung, Kursive, Code, Aufzählung, Häkchen.
   * Bewusst ohne Links — der Text kommt aus einem Textfeld und landet
   * ungeprüft im DOM, deshalb wird vorher alles maskiert.
   */
  function markdownLite(text) {
    const inline = escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    let html = '';
    let inList = false;

    for (const raw of inline.split(/\r?\n/)) {
      const line = raw.trim();
      const item = line.match(/^[-*]\s+(?:\[([ xX])\]\s+)?(.*)$/);

      if (item) {
        if (!inList) { html += '<ul>'; inList = true; }
        const box = item[1] === undefined ? ''
          : `<span class="anno-check">${item[1].toLowerCase() === 'x' ? '☑' : '☐'}</span> `;
        html += `<li>${box}${item[2]}</li>`;
        continue;
      }
      if (inList) { html += '</ul>'; inList = false; }
      if (line) html += `<p>${line}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
  }

  function loadLayout() {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; }
    catch { return {}; }
  }

  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }
    catch (e) { console.warn('[Annotations] Layout nicht speicherbar', e); }
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STATE_KEY)) || {};
      if (typeof raw.enabled === 'boolean') enabled = raw.enabled;
      if (typeof raw.onlyOpen === 'boolean') onlyOpen = raw.onlyOpen;
      if (Number.isFinite(raw.maxDistance)) maxDistance = raw.maxDistance;
    } catch { /* Voreinstellung behalten */ }
  }

  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify({ enabled, onlyOpen, maxDistance })); }
    catch { /* nicht schlimm */ }
  }

  function offsetOf(tagId) {
    const entry = layout[tagId];
    return {
      x: Number.isFinite(entry?.x) ? entry.x : DEFAULT_OFFSET.x,
      y: Number.isFinite(entry?.y) ? entry.y : DEFAULT_OFFSET.y
    };
  }

  const isCollapsed = (tagId) => layout[tagId]?.collapsed === true;

  function setLayout(tagId, patch) {
    layout[tagId] = { ...offsetOf(tagId), collapsed: isCollapsed(tagId), ...patch };
    saveLayout();
  }

  /** Notizen, die gezeichnet werden sollen — Filter des Panels inbegriffen. */
  function activeTags() {
    const items = (window.Tags && Array.isArray(Tags.items)) ? Tags.items : [];
    return items.filter((tag) => {
      if (!tag?.position?.worldCart) return false;
      if (onlyOpen && tag.payload?.status === 'closed') return false;
      return true;
    });
  }

  // ============================================================
  // DOM — eine Beschriftung
  // ============================================================

  function ensureLayer() {
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'anno-layer';
    document.body.appendChild(layer);
    return layer;
  }

  function createView(tag) {
    const root   = document.createElement('div');
    const leader = document.createElement('div');
    const dot    = document.createElement('div');
    const label  = document.createElement('div');

    root.className   = 'anno-item';
    leader.className = 'anno-leader';
    dot.className    = 'anno-dot';
    label.className  = 'anno-label';

    label.innerHTML = `
      <div class="anno-head">
        <span class="anno-icon"></span>
        <span class="anno-title"></span>
        <button class="anno-btn anno-fold" type="button" title="Ein-/ausklappen">–</button>
      </div>
      <div class="anno-body"></div>
      <div class="anno-meta"></div>
      <div class="anno-actions">
        <button class="anno-btn anno-status" type="button" title="Status weiterschalten"></button>
        <button class="anno-btn anno-fly"    type="button" title="Kamera hinfliegen">⌖</button>
        <button class="anno-btn anno-del"    type="button" title="Notiz löschen">✕</button>
      </div>`;

    root.append(leader, dot, label);
    ensureLayer().appendChild(root);

    const view = {
      root, leader, dot, label,
      icon:    label.querySelector('.anno-icon'),
      title:   label.querySelector('.anno-title'),
      body:    label.querySelector('.anno-body'),
      meta:    label.querySelector('.anno-meta'),
      status:  label.querySelector('.anno-status'),
      renderedText: null,   // zuletzt gezeichneter Inhalt
      renderedState: null,  // zuletzt gesetzte Zustandsklassen
      size: null            // gemessene Größe, nur nach Inhaltsänderung neu
    };

    dot.addEventListener('pointerdown', (e) => { e.stopPropagation(); select(tag.id); });
    dot.addEventListener('dblclick', (e) => { e.stopPropagation(); flyTo(tag.id); });
    label.addEventListener('pointerdown', (e) => beginDrag(tag, view, e));

    label.querySelector('.anno-fold').addEventListener('click', (e) => {
      e.stopPropagation();
      setLayout(tag.id, { collapsed: !isCollapsed(tag.id) });
    });
    label.querySelector('.anno-fly').addEventListener('click', (e) => {
      e.stopPropagation();
      flyTo(tag.id);
    });
    view.status.addEventListener('click', (e) => { e.stopPropagation(); cycleStatus(tag.id); });
    label.querySelector('.anno-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeTag(tag.id);
    });

    return view;
  }

  /** Views mit dem Bestand aus tags.js abgleichen (neue anlegen, alte entfernen). */
  function syncViews(tags) {
    const alive = new Set(tags.map((t) => t.id));
    for (const [id, view] of views) {
      if (!alive.has(id)) { view.root.remove(); views.delete(id); }
    }
    for (const tag of tags) {
      if (!views.has(tag.id)) views.set(tag.id, createView(tag));
    }
  }

  // ============================================================
  // INHALT
  // ============================================================

  function fillContent(tag, view) {
    const p = tag.payload || {};
    const key = JSON.stringify([p.title, p.body, p.status, p.assignedTo, tag.type,
                                p.attachments?.length || 0]);
    if (view.renderedText === key) return;
    view.renderedText = key;
    view.size = null;   // Größe stimmt nicht mehr — bei der Entzerrung neu messen

    view.icon.textContent = TYPE_ICON[tag.type] || '📌';
    view.title.textContent = p.title || t('anno.untitled');
    view.body.innerHTML = p.body ? markdownLite(p.body) : '';
    view.status.textContent = t('anno.status.' + (p.status || 'open'));

    const parts = [];
    if (tag.author) parts.push(tag.author);
    if (tag.createdAt) parts.push(new Date(tag.createdAt).toLocaleDateString());
    if (p.assignedTo) parts.push('→ ' + p.assignedTo);
    if (p.attachments?.length) parts.push('📎 ' + p.attachments.length);
    if (tag.target?.kind) parts.push(tag.target.kind.toUpperCase());
    view.meta.textContent = parts.join(' · ');
  }

  function applyState(tag, view, collapsed) {
    const status = tag.payload?.status || 'open';
    const key = `${status}|${tag.id === selectedId}|${collapsed}|${draggingId === tag.id}`;
    if (view.renderedState === key) return;
    view.renderedState = key;

    view.root.className = 'anno-item ' + (STATUS_CLASS[status] || 'is-open')
      + (tag.id === selectedId ? ' is-selected' : '')
      + (collapsed ? ' is-collapsed' : '')
      + (draggingId === tag.id ? ' is-dragging' : '');
  }

  // ============================================================
  // PRO BILD — projizieren, platzieren, entzerren
  // ============================================================

  function update() {
    if (!enabled || !layer) return;

    const tags = activeTags();
    syncViews(tags);
    if (!tags.length) return;

    const rect   = canvas.getBoundingClientRect();
    const camera = scene.camera;
    // Verdeckung durch die Erdkugel: eine Notiz auf der anderen Seite des
    // Globus darf nicht durchscheinen. Geometrie verdeckt hier nichts — dafür
    // bräuchte es einen Tiefen-Pass pro Beschriftung.
    if (!occluder) occluder = new Cesium.EllipsoidalOccluder(scene.globe.ellipsoid, camera.positionWC);
    else occluder.cameraPosition = camera.positionWC;

    const toWindow = Cesium.SceneTransforms.worldToWindowCoordinates
                  || Cesium.SceneTransforms.wgs84ToWindowCoordinates;

    // Nach Entfernung sortiert platzieren: bei Überdeckung gewinnt die
    // kamera-nähere Beschriftung den Platz.
    const candidates = [];

    for (const tag of tags) {
      const view = views.get(tag.id);
      if (!view) continue;

      const c = tag.position.worldCart;
      const position = Cesium.Cartesian3.fromElements(c.x, c.y, c.z, scratchPos);

      // Hinter der Kamera: die Fensterkoordinate wäre gespiegelt gültig.
      Cesium.Cartesian3.subtract(position, camera.positionWC, scratchEye);
      if (Cesium.Cartesian3.dot(scratchEye, camera.directionWC) <= 0) { view.root.style.display = 'none'; continue; }

      const distance = Cesium.Cartesian3.magnitude(scratchEye);
      if (distance > maxDistance) { view.root.style.display = 'none'; continue; }
      if (!occluder.isPointVisible(position)) { view.root.style.display = 'none'; continue; }

      const win = toWindow(scene, position);
      if (!win) { view.root.style.display = 'none'; continue; }

      const ax = win.x + rect.left;
      const ay = win.y + rect.top;
      if (ax < -200 || ay < -200 || ax > window.innerWidth + 200 || ay > window.innerHeight + 200) {
        view.root.style.display = 'none';
        continue;
      }

      candidates.push({ tag, view, ax, ay, distance });
    }

    candidates.sort((a, b) => a.distance - b.distance);

    const placed = [];   // schon belegte Rechtecke

    for (const spot of candidates) {
      const { tag, view, ax, ay, distance } = spot;
      view.root.style.display = '';

      fillContent(tag, view);

      const offset = offsetOf(tag.id);
      const lx = ax + offset.x * window.innerWidth;
      const ly = ay + offset.y * window.innerHeight;

      // Größe nur nach Inhaltswechsel messen — offsetWidth erzwingt ein
      // Layout, und diese Schleife läuft bei jedem Bild.
      if (!view.size) {
        view.size = { w: view.label.offsetWidth || 180, h: view.label.offsetHeight || 60 };
      }

      const box = {
        left: lx - view.size.w / 2 - MIN_LABEL_GAP,
        top: ly - view.size.h / 2 - MIN_LABEL_GAP,
        right: lx + view.size.w / 2 + MIN_LABEL_GAP,
        bottom: ly + view.size.h / 2 + MIN_LABEL_GAP
      };
      const overlaps = placed.some((q) =>
        box.left < q.right && box.right > q.left && box.top < q.bottom && box.bottom > q.top);

      const collapsed = isCollapsed(tag.id) || (overlaps && tag.id !== selectedId);
      if (!collapsed) placed.push(box);

      applyState(tag, view, collapsed);

      view.dot.style.transform = `translate(${ax}px, ${ay}px) translate(-50%, -50%)`;
      view.label.style.left = `${lx}px`;
      view.label.style.top  = `${ly}px`;

      const dx = lx - ax;
      const dy = ly - ay;
      view.leader.style.transform = `translate(${ax}px, ${ay}px) rotate(${Math.atan2(dy, dx)}rad)`;
      view.leader.style.width = `${Math.hypot(dx, dy)}px`;

      // Weiche Kante statt hartem Verschwinden an der Sichtweitengrenze
      const fadeStart = maxDistance * (1 - FADE_BAND);
      view.root.style.opacity = distance <= fadeStart
        ? '1'
        : String(clamp(1 - (distance - fadeStart) / (maxDistance - fadeStart), 0, 1));
    }
  }

  // ============================================================
  // ZIEHEN DER BESCHRIFTUNG
  // ============================================================

  function beginDrag(tag, view, event) {
    if (event.target.closest('.anno-btn')) return;   // Schaltflächen ziehen nicht
    event.preventDefault();
    event.stopPropagation();
    select(tag.id);

    const startX = event.clientX;
    const startY = event.clientY;
    const origin = offsetOf(tag.id);
    draggingId = tag.id;
    view.label.setPointerCapture(event.pointerId);

    const onMove = (move) => {
      setLayout(tag.id, {
        x: clamp(origin.x + (move.clientX - startX) / window.innerWidth, -1, 1),
        y: clamp(origin.y + (move.clientY - startY) / window.innerHeight, -1, 1)
      });
    };
    const onUp = (up) => {
      view.label.removeEventListener('pointermove', onMove);
      view.label.removeEventListener('pointerup', onUp);
      view.label.removeEventListener('pointercancel', onUp);
      if (view.label.hasPointerCapture(up.pointerId)) view.label.releasePointerCapture(up.pointerId);
      draggingId = null;
    };

    view.label.addEventListener('pointermove', onMove);
    view.label.addEventListener('pointerup', onUp);
    view.label.addEventListener('pointercancel', onUp);
  }

  // ============================================================
  // AKTIONEN
  // ============================================================

  function select(id) {
    selectedId = (selectedId === id) ? null : id;
    if (window.Tags) Tags.selectedId = selectedId;
    document.dispatchEvent(new CustomEvent('annotations:selected', { detail: { id: selectedId } }));
  }

  function flyTo(id) {
    if (window.Tags?.flyTo) Tags.flyTo(id);
  }

  async function cycleStatus(id) {
    const tag = window.Tags?.items.find((item) => item.id === id);
    if (!tag) return;
    const order = ['open', 'in_progress', 'closed'];
    const next = order[(order.indexOf(tag.payload?.status || 'open') + 1) % order.length];
    tag.payload = { ...tag.payload, status: next };
    try {
      await Tags.save(tag);
      document.dispatchEvent(new CustomEvent('tags:changed', { detail: { tag } }));
      if (window.BimViewerUI?.refreshTagsPanel) BimViewerUI.refreshTagsPanel();
    } catch (e) {
      console.warn('[Annotations] Status nicht gespeichert', e);
    }
  }

  async function removeTag(id) {
    const tag = window.Tags?.items.find((item) => item.id === id);
    if (!tag) return;
    if (!confirm(t('anno.confirmDelete').replace('{title}', tag.payload?.title || ''))) return;
    await Tags.remove(id);
    delete layout[id];
    saveLayout();
    if (selectedId === id) selectedId = null;
    if (window.BimViewerUI?.refreshTagsPanel) BimViewerUI.refreshTagsPanel();
  }

  // ============================================================
  // PANEL — Steuerung unter Werkzeuge → Notizen & Prüfung
  // ============================================================

  function t(key) {
    return (typeof window.t === 'function') ? window.t(key)
         : (window.ILeenI18n ? ILeenI18n.t(key) : key);
  }

  function panelHtml() {
    const options = DISTANCES.map((d) =>
      `<option value="${d.value}"${d.value === maxDistance ? ' selected' : ''}>${d.label}</option>`
    ).join('');

    return `
      <div class="section">
        <div class="section__label">${t('anno.section')}</div>
        <div class="row">
          <span class="row__label">${t('anno.show')}</span>
          <label class="switch">
            <input type="checkbox" id="annoToggle"${enabled ? ' checked' : ''}
                   onchange="Annotations.setEnabled(this.checked)">
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="row">
          <span class="row__label">${t('anno.onlyOpen')}</span>
          <label class="switch">
            <input type="checkbox" id="annoOnlyOpen"${onlyOpen ? ' checked' : ''}
                   onchange="Annotations.setOnlyOpen(this.checked)">
            <span class="switch__track"></span>
          </label>
        </div>
        <div class="field">
          <label class="field__label" for="annoDistance">${t('anno.distance')}</label>
          <select id="annoDistance" class="select"
                  onchange="Annotations.setMaxDistance(Number(this.value))">${options}</select>
        </div>
        <button class="btn btn--block btn--sm" onclick="Annotations.resetLayout()">
          ${t('anno.reset')}
        </button>
        <p class="hint">${t('anno.hint')}</p>
      </div>`;
  }

  function injectPanel() {
    if (typeof BimViewerUI === 'undefined' || !BimViewerUI.getTagsContent) return;

    const original = BimViewerUI.getTagsContent.bind(BimViewerUI);
    BimViewerUI.getTagsContent = function () {
      return original() + panelHtml();
    };

    // Nach jedem Neuzeichnen des Panels stehen die Schalter wieder auf dem
    // Anfangswert des Markups — hier die tatsächlichen Werte nachziehen.
    const refresh = BimViewerUI.refreshTagsPanel?.bind(BimViewerUI);
    if (refresh) {
      BimViewerUI.refreshTagsPanel = function () {
        refresh();
        syncPanel();
      };
    }
  }

  function syncPanel() {
    const toggle = document.getElementById('annoToggle');
    const open   = document.getElementById('annoOnlyOpen');
    const dist   = document.getElementById('annoDistance');
    if (toggle) toggle.checked = enabled;
    if (open)   open.checked = onlyOpen;
    if (dist)   dist.value = String(maxDistance);
  }

  // ============================================================
  // START
  // ============================================================

  function start() {
    viewer = window.BimViewer.viewer;
    scene  = viewer.scene;
    canvas = scene.canvas;

    ensureLayer();
    layer.style.display = enabled ? '' : 'none';

    removeRenderListener = scene.postRender.addEventListener(update);

    // Eine gespeicherte Notiz erscheint sofort; die Schleife holt sie ohnehin
    // beim nächsten Bild, aber der Panel-Zähler soll mitlaufen.
    document.addEventListener('tags:changed', () => {
      if (window.BimViewerUI?.refreshTagsPanel) BimViewerUI.refreshTagsPanel();
    });

    // Beschriftungen sind in Viewport-Anteilen abgelegt: nach einem
    // Größenwechsel stimmen die gemessenen Kästen nicht mehr.
    window.addEventListener('resize', () => {
      for (const view of views.values()) view.size = null;
    });

    // ⇧A wie in splides — im Begehungsmodus ist A aber Seitwärtsgehen.
    window.addEventListener('keydown', (e) => {
      if (!e.shiftKey || e.code !== 'KeyA' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement
          && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (window.WalkMode?.isEnabled?.()) return;
      e.preventDefault();
      Annotations.setEnabled(!enabled);
    });

    console.log('✅ Annotations geladen — Beschriftungen ' + (enabled ? 'sichtbar' : 'aus'));
  }

  function boot() {
    loadState();
    injectPanel();

    const wait = setInterval(() => {
      if (!window.BimViewer?.viewer || !window.Tags) return;
      clearInterval(wait);
      start();
    }, 400);
  }

  // ============================================================
  // ÖFFENTLICHE SCHNITTSTELLE
  // ============================================================

  const Annotations = {
    /** Beschriftungen ein-/ausschalten. */
    setEnabled(on) {
      enabled = !!on;
      if (layer) layer.style.display = enabled ? '' : 'none';
      saveState();
      syncPanel();
      if (viewer) viewer.scene.requestRender();
    },
    isEnabled() { return enabled; },

    /** Erledigte Notizen ausblenden. */
    setOnlyOpen(on) {
      onlyOpen = !!on;
      saveState();
      syncPanel();
    },

    /** Ab welcher Entfernung Beschriftungen verschwinden (m). */
    setMaxDistance(metres) {
      if (Number.isFinite(metres) && metres > 0) maxDistance = metres;
      saveState();
      syncPanel();
    },

    /** Verschobene Beschriftungen wieder an ihren Anker legen. */
    resetLayout(id) {
      if (id) delete layout[id];
      else for (const key of Object.keys(layout)) delete layout[key];
      saveLayout();
    },

    select,
    flyTo,

    /** Für Tests / Fehlersuche. */
    _views: views,
    _layout: layout,
    _markdown: markdownLite
  };

  window.Annotations = Annotations;
  boot();

})();
