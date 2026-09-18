/**
 * iLEEN — Google 3D Tiles Auto-Mask
 * Automatically clips Google 3D Tiles in the footprint of loaded IFC/3D Tile assets.
 * Works independently of the manual clipping system in clipping.js.
 */
'use strict';

(function () {

  // ── State ─────────────────────────────────────────────────────────────────
  BimViewer.googleAutoMask = {
    enabled: true,
    masks: new Map(), // assetId (string) → Cartesian3[] footprint points
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Compute a rectangular footprint from a tileset's bounding sphere.
   * Returns 4 Cartesian3 corners at height 0 (column-clip, height-independent).
   */
  BimViewer._computeTilesetFootprint = function (tileset, padding) {
    padding = padding !== undefined ? padding : 1.4;
    const bs = tileset.boundingSphere;
    const carto = Cesium.Cartographic.fromCartesian(bs.center);
    const r = bs.radius * padding;

    const dLat = r / 6371000;                                   // radians
    const dLon = r / (6371000 * Math.cos(carto.latitude));      // radians
    const lon = carto.longitude;
    const lat = carto.latitude;

    // SW → SE → NE → NW  (orientation auto-corrected by isCounterClockwise)
    return [
      Cesium.Cartesian3.fromRadians(lon - dLon, lat - dLat, 0),
      Cesium.Cartesian3.fromRadians(lon + dLon, lat - dLat, 0),
      Cesium.Cartesian3.fromRadians(lon + dLon, lat + dLat, 0),
      Cesium.Cartesian3.fromRadians(lon - dLon, lat + dLat, 0),
    ];
  };

  /**
   * Build a ClippingPolygon from a set of Cartesian3 points.
   * Ensures CCW orientation (clip-inside = remove Google 3D within the polygon).
   */
  BimViewer._buildClippingPolygon = function (points) {
    // Tiefe Kopie: ClippingPolygon friert seit CesiumJS 1.145 das Array und
    // jedes Cartesian3 darin ein (in place). Die Masken leben weiter in
    // googleAutoMask.masks und werden bei jedem Anwenden neu gebaut.
    let pts = points.map((p) => Cesium.Cartesian3.clone(p));
    if (typeof BimViewer.isCounterClockwise === 'function') {
      if (!BimViewer.isCounterClockwise(pts)) pts = pts.reverse();
    }
    return new Cesium.ClippingPolygon({ positions: pts });
  };

  // ── Core: apply all auto-masks to Google 3D Tiles ─────────────────────────

  BimViewer._applyAutoMasksToGoogle = function () {
    if (!this.googleTiles.tileset || !this.googleTiles.enabled) return;
    if (!this.googleAutoMask.enabled || this.googleAutoMask.masks.size === 0) {
      // Clear if we have nothing
      if (this._autoMaskLastCollection) {
        this._autoMaskLastCollection.enabled = false;
      }
      return;
    }

    // Build auto-mask polygons
    const autoPolygons = [];
    for (const pts of this.googleAutoMask.masks.values()) {
      autoPolygons.push(this._buildClippingPolygon(pts));
    }

    // Read back any existing manual-clipping polygons (set by clipping.js)
    // so we can merge both into one collection (Cesium only allows one per tileset).
    const existing = this.googleTiles.tileset.clippingPolygons;
    const manualPolygons = [];
    const useInverse = existing ? existing.inverse : false;
    if (existing && existing.length > 0) {
      for (let i = 0; i < existing.length; i++) {
        manualPolygons.push(existing.get(i));
      }
    }

    const merged = new Cesium.ClippingPolygonCollection({
      polygons: [...manualPolygons, ...autoPolygons],
      enabled: true,
      inverse: useInverse,
    });

    this.googleTiles.tileset.clippingPolygons = merged;
    this._autoMaskLastCollection = merged;

    console.log(
      `🗺️ Auto-mask: ${autoPolygons.length} footprint(s) + ${manualPolygons.length} manual polygon(s) applied to Google 3D Tiles`
    );
  };

  // ── Add / remove masks ────────────────────────────────────────────────────

  BimViewer.addGoogleAutoMask = function (assetId) {
    const key = assetId.toString();
    const assetData = this.loadedAssets.get(key);
    if (!assetData || !assetData.tileset) return;

    // Skip point clouds — they have huge bounding spheres that would mask too much
    if (assetData.isPointCloud) return;

    const points = this._computeTilesetFootprint(assetData.tileset);
    this.googleAutoMask.masks.set(key, points);

    if (this.googleTiles.enabled && this.googleTiles.tileset) {
      this._applyAutoMasksToGoogle();
    }

    console.log(`🗺️ Auto-mask registered for asset ${assetId}`);
  };

  BimViewer.removeGoogleAutoMask = function (assetId) {
    const key = assetId.toString();
    if (!this.googleAutoMask.masks.has(key)) return;
    this.googleAutoMask.masks.delete(key);
    if (this.googleTiles.enabled && this.googleTiles.tileset) {
      this._applyAutoMasksToGoogle();
    }
    console.log(`🗺️ Auto-mask removed for asset ${assetId}`);
  };

  // ── UI toggle ─────────────────────────────────────────────────────────────

  BimViewer.toggleGoogleAutoMask = function () {
    this.googleAutoMask.enabled = !this.googleAutoMask.enabled;

    const btn = document.getElementById('toggleAutoMask');
    if (btn) btn.classList.toggle('active', this.googleAutoMask.enabled);

    if (this.googleAutoMask.enabled) {
      this._applyAutoMasksToGoogle();
      this.updateStatus('🗺️ Auto-Mask ON — Google 3D Tiles cropped at IFC footprints', 'success');
    } else {
      if (this._autoMaskLastCollection) {
        this._autoMaskLastCollection.enabled = false;
      }
      this.updateStatus('🗺️ Auto-Mask OFF', 'info');
    }
  };

  // ── Hooks ─────────────────────────────────────────────────────────────────

  // Hook 1: When any asset is added to loadedAssets (Map.set override),
  // wait for flyTo to complete so bounding sphere is populated, then add mask.
  const _nativeSet = Map.prototype.set;
  const _targetMap = BimViewer.loadedAssets;
  _targetMap.set = function (key, value) {
    const result = _nativeSet.call(this, key, value);
    // Only act on BimViewer.loadedAssets (not other Maps)
    if (this === _targetMap) {
      setTimeout(function () {
        BimViewer.addGoogleAutoMask(parseInt(key, 10));
      }, 2500); // wait for flyTo + tile load
    }
    return result;
  };

  // Hook 2: When Google 3D Tiles are toggled on, re-apply auto-masks.
  const _origToggle = BimViewer.toggleGoogle3DTiles;
  BimViewer.toggleGoogle3DTiles = async function () {
    await _origToggle.call(this);
    if (this.googleTiles.enabled) {
      // Small delay so the tileset is fully ready
      setTimeout(() => this._applyAutoMasksToGoogle(), 800);
    }
  };

  // Hook 3: After manual clipping is applied, merge auto-masks back in.
  if (typeof BimViewer.applyClipping === 'function') {
    const _origApply = BimViewer.applyClipping;
    BimViewer.applyClipping = function () {
      _origApply.call(this);
      if (this.googleTiles.enabled && this.googleAutoMask.masks.size > 0) {
        // Small defer so applyClipping finishes setting collections first
        setTimeout(() => this._applyAutoMasksToGoogle(), 0);
      }
    };
  }

  // Hook 4: When an asset is removed, clean up its mask.
  if (typeof BimViewer.removeAsset === 'function') {
    const _origRemove = BimViewer.removeAsset;
    BimViewer.removeAsset = function (assetId) {
      _origRemove.call(this, assetId);
      this.removeGoogleAutoMask(assetId);
    };
  }

  console.log('🗺️ Google Auto-Mask module loaded');
})();
