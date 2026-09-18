/**
 * iLEEN — UI Extension: Google Auto-Mask · Isolate Mode · Building Stamps
 * Injects UI controls for the three new modules into existing panel sections.
 */
'use strict';

(function () {

  if (typeof BimViewerUI === 'undefined') {
    console.error('❌ BimViewerUI not found — load ui.js first');
    return;
  }

  // ── 1. Inject Auto-Mask controls into the Clipping section ──────────────
  const _origDrawing = BimViewerUI.getDrawingContent.bind(BimViewerUI);
  BimViewerUI.getDrawingContent = function () {
    return _origDrawing() + `
      <div class="section">
        <div class="section__label">Google 3D — Freistellen</div>
        <div class="btn-group">
          <button id="toggleAutoMask" class="btn btn--sm active"
                  onclick="BimViewer.toggleGoogleAutoMask()"
                  title="Google-3D-Kacheln im Grundriss der geladenen Modelle wegschneiden">
            <span class="modern-btn-icon">🗺️</span><span>Automatisch</span>
          </button>
          <button class="btn btn--sm" onclick="BimViewer._applyAutoMasksToGoogle()"
                  title="Nach einer Kamerafahrt neu anwenden">
            <span class="modern-btn-icon">🔄</span><span>Neu anwenden</span>
          </button>
        </div>
        <p class="hint">
          Schneidet die Google-3D-Kacheln im Grundriss jedes geladenen Modells weg,
          damit die fotorealistischen Gebäude nicht in den eigenen Modellen stecken.
        </p>
      </div>
    `;
  };

  // ── 2. Inject Isolate Mode controls into the Visibility section ───────────
  const _origVisibility = BimViewerUI.getVisibilityContent.bind(BimViewerUI);
  BimViewerUI.getVisibilityContent = function () {
    return _origVisibility() + `
      <div class="modern-divider" style="margin-top: 16px;">
        <span class="modern-divider-text">Isolate Mode</span>
      </div>
      <div class="modern-group">
        <div class="modern-hint">
          Click any element to <strong>isolate</strong> it — all other elements in the tileset
          are hidden. Press <strong>I</strong> or <strong>ESC</strong> to restore.
        </div>
        <button id="toggleIsolateMode" class="modern-btn modern-btn-primary"
                onclick="BimViewer.toggleIsolateMode()" title="Isolate a single IFC element (Keyboard: I)">
          <span class="modern-btn-icon">🔍</span>
          <span>Isolate Mode</span>
        </button>
      </div>
      <div id="isolateModeIndicator" class="modern-mode-indicator" style="display:none;"></div>

      <style>
        .modern-mode-indicator {
          margin-top: 8px;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 12px;
          background: rgba(230,126,34,0.18);
          color: #e67e22;
          border: 1px solid rgba(230,126,34,0.4);
        }
        .modern-mode-indicator.active { display: block !important; }
      </style>
    `;
  };

  // ── 3. Inject Building Stamps controls into a new panel section ────────────
  // We hook into the panel init to add a new "Building Stamps" section.
  const _origInit = BimViewerUI.init ? BimViewerUI.init.bind(BimViewerUI) : null;

  // Because init() runs synchronously and addSection is a local closure,
  // we inject the stamp section by appending a DOM element after the panel is ready.
  window.addEventListener('load', function () {
    setTimeout(_injectStampsSection, 1200);
  });

  function _injectStampsSection() {
    const panel = document.getElementById('controlPanel') || document.querySelector('.modern-panel');
    if (!panel) return;

    const container = document.createElement('div');
    container.className = 'modern-section';
    container.id = 'section-stamps';
    container.innerHTML = `
      <div class="modern-section-header" onclick="this.closest('.modern-section').classList.toggle('open')">
        <span class="modern-section-icon">📍</span>
        <span class="modern-section-title">Building Stamps</span>
        <span id="buildingStampCount" class="modern-badge" style="display:none;">0</span>
        <span class="modern-section-arrow">▸</span>
      </div>
      <div class="modern-section-content">
        <div class="modern-group">
          <div class="modern-hint">
            A location pin is automatically placed at the centre of each loaded tileset.
            Export all pins as a GeoJSON FeatureCollection.
          </div>
          <button id="toggleBuildingStamps" class="modern-btn modern-btn-primary active"
                  onclick="BimViewer.toggleBuildingStamps()" title="Show/hide building pins">
            <span class="modern-btn-icon">📍</span>
            <span>Toggle Pins</span>
          </button>
          <button class="modern-btn modern-btn-secondary"
                  onclick="BimViewer.exportBuildingStampsGeoJSON()" title="Download GeoJSON">
            <span class="modern-btn-icon">⬇️</span>
            <span>Export GeoJSON</span>
          </button>
        </div>

        <div id="stampsList" class="modern-hidden-list" style="margin-top:10px;">
          <div class="modern-empty-state">No stamps yet — load a tileset</div>
        </div>
      </div>
    `;

    // Insert before the last section (About)
    const aboutSection = panel.querySelector('#section-about') || panel.lastElementChild;
    panel.insertBefore(container, aboutSection);

    // Patch addBuildingStamp to also update the stamps list in the UI
    const _origAdd = BimViewer.addBuildingStamp.bind(BimViewer);
    BimViewer.addBuildingStamp = function (assetId) {
      _origAdd(assetId);
      _refreshStampsList();
    };

    const _origRemove = BimViewer.removeBuildingStamp.bind(BimViewer);
    BimViewer.removeBuildingStamp = function (assetId) {
      _origRemove(assetId);
      _refreshStampsList();
    };
  }

  function _refreshStampsList() {
    const list = document.getElementById('stampsList');
    if (!list || !BimViewer.buildingStamps) return;
    const stamps = BimViewer.buildingStamps.stamps;
    if (stamps.size === 0) {
      list.innerHTML = '<div class="modern-empty-state">No stamps yet — load a tileset</div>';
      return;
    }
    let html = '';
    for (const [id, { geojson }] of stamps) {
      const coords = geojson.geometry.coordinates;
      html += `
        <div class="modern-hidden-item" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.07);">
          <span style="font-size:16px;">📍</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${geojson.properties.name}</div>
            <div style="font-size:10px;color:rgba(255,255,255,0.5);">${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}</div>
          </div>
          <button class="modern-btn-icon-only" title="Fly to" onclick="BimViewer.viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(${coords[0]},${coords[1]},${coords[2] + 200})})">✈️</button>
          <button class="modern-btn-icon-only" title="Remove stamp" onclick="BimViewer.removeBuildingStamp(${id})">✕</button>
        </div>
      `;
    }
    list.innerHTML = html;
  }

  console.log('📍🗺️🔍 New features UI extension loaded');
})();
