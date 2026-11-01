/**
 * iLEEN — Isolate Mode
 * Click any IFC element to isolate it — everything else in the same tileset
 * is hidden temporarily. Click again (or press Escape / ⇧I) to restore all.
 *
 * Distinct from hideFeatures.js (which hides individual clicked elements).
 * Isolate Mode shows ONLY the clicked element and hides all others.
 */
'use strict';

(function () {

  // ── State ─────────────────────────────────────────────────────────────────
  BimViewer.isolateMode = {
    active: false,
    isolatedFeature: null,      // the one visible Cesium3DTileFeature
    hiddenFeatures: [],         // array of { feature } that were hidden
    handler: null,              // ScreenSpaceEventHandler
  };

  // ── Activate / Deactivate ─────────────────────────────────────────────────

  BimViewer.toggleIsolateMode = function () {
    if (this.isolateMode.active) {
      this.exitIsolateMode();
    } else {
      this.enterIsolateMode();
    }
  };

  BimViewer.enterIsolateMode = function () {
    // Exit hide mode if active
    if (this.hiddenFeatures && this.hiddenFeatures.isHideMode) {
      if (typeof this.toggleHideMode === 'function') this.toggleHideMode();
    }

    this.isolateMode.active = true;

    // Update UI
    const btn = document.getElementById('toggleIsolateMode');
    const indicator = document.getElementById('isolateModeIndicator');
    if (btn) btn.classList.add('active');
    if (indicator) {
      indicator.classList.add('active');
      indicator.textContent = '🔍 ISOLATE MODE — Click an element to isolate it (ESC or I to exit)';
    }

    this.updateStatus('Isolate Mode — click an element to isolate it', 'warning');
    console.log('🔍 Isolate mode ACTIVATED');

    // Set up click handler
    this.isolateMode.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);

    const self = this;
    this.isolateMode.handler.setInputAction(function (click) {
      if (!self.isolateMode.active) return;

      const picked = self.viewer.scene.pick(click.position);

      if (Cesium.defined(picked) && picked instanceof Cesium.Cesium3DTileFeature) {
        self._isolateFeature(picked);
      } else {
        // Clicked empty space — restore
        self.exitIsolateMode();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Esc beendet; ⇧I schaltet über den globalen Hörer unten um. I allein
    // gehört seit 2026-10-19 den IFC-Modellen (tastenkuerzel.js).
    document.addEventListener('keydown', this._isolateModeKeyHandler = function (e) {
      if (e.key === 'Escape') {
        self.exitIsolateMode();
      }
    });
  };

  BimViewer.exitIsolateMode = function () {
    if (!this.isolateMode.active) return;

    this.isolateMode.active = false;

    // Restore all hidden features
    for (const entry of this.isolateMode.hiddenFeatures) {
      try { entry.feature.show = true; } catch (_) {}
    }
    this.isolateMode.hiddenFeatures = [];
    this.isolateMode.isolatedFeature = null;

    // Update UI
    const btn = document.getElementById('toggleIsolateMode');
    const indicator = document.getElementById('isolateModeIndicator');
    if (btn) btn.classList.remove('active');
    if (indicator) indicator.classList.remove('active');

    // Clean up event handler
    if (this.isolateMode.handler) {
      this.isolateMode.handler.destroy();
      this.isolateMode.handler = null;
    }
    if (this._isolateModeKeyHandler) {
      document.removeEventListener('keydown', this._isolateModeKeyHandler);
      this._isolateModeKeyHandler = null;
    }

    this.updateStatus('Isolate Mode deactivated — all elements restored', 'success');
    console.log('🔍 Isolate mode DEACTIVATED');
  };

  // ── Isolate a single feature ───────────────────────────────────────────────

  BimViewer._isolateFeature = function (targetFeature) {
    // Restore previously hidden features first
    for (const entry of this.isolateMode.hiddenFeatures) {
      try { entry.feature.show = true; } catch (_) {}
    }
    this.isolateMode.hiddenFeatures = [];

    // Find the tileset that owns this feature
    const targetTileset = targetFeature.tileset;
    if (!targetTileset) {
      this.updateStatus('Could not determine tileset for selected element', 'error');
      return;
    }

    // Walk all loaded tilesets and hide every feature EXCEPT the target
    const hidden = [];

    const walkContent = (content) => {
      if (!content) return;
      const len = content.featuresLength;
      for (let i = 0; i < len; i++) {
        try {
          const f = content.getFeature(i);
          if (f !== targetFeature) {
            f.show = false;
            hidden.push({ feature: f });
          }
        } catch (_) {}
      }
    };

    const walkTile = (tile) => {
      if (tile.content) walkContent(tile.content);
      if (tile.children) tile.children.forEach(walkTile);
    };

    if (targetTileset.root) walkTile(targetTileset.root);

    this.isolateMode.hiddenFeatures = hidden;
    this.isolateMode.isolatedFeature = targetFeature;

    // Get element name for status
    let name = 'element';
    try { name = targetFeature.getProperty('Name') || targetFeature.getProperty('className') || 'element'; } catch (_) {}

    this.updateStatus(`Isolated: ${name} — ${hidden.length} elements hidden. Press ⇧I or ESC to restore.`, 'success');
    console.log(`🔍 Isolated "${name}", hid ${hidden.length} elements`);
  };

  // ── Tastenkürzel ⇧I ───────────────────────────────────────────────────────
  // Seit 2026-10-19 mit Umschalt: I allein blendet die IFC-Modelle ein und aus
  // (tastenkuerzel.js). `code`, weil ⇧I je nach Tastatur kein großes I liefert.
  document.addEventListener('keydown', function (e) {
    // Only when not typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'KeyI' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      BimViewer.toggleIsolateMode();
    }
  });

  console.log('🔍 Isolate Mode module loaded — Press ⇧I to toggle');
})();
