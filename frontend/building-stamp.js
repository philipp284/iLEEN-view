/**
 * iLEEN — Building Stamp / GeoJSON Marker
 * For every loaded tileset, places a pin marker at the building's center.
 * All markers are available as a GeoJSON FeatureCollection (downloadable).
 */
'use strict';

(function () {

  // ── State ─────────────────────────────────────────────────────────────────
  BimViewer.buildingStamps = {
    enabled: true,
    stamps: new Map(),   // assetId (string) → { entity, geojson }
  };

  // ── Add stamp for an asset ─────────────────────────────────────────────────

  BimViewer.addBuildingStamp = function (assetId) {
    const key = assetId.toString();
    const assetData = this.loadedAssets.get(key);
    if (!assetData || !assetData.tileset) return;
    if (!this.buildingStamps.enabled) return;

    // Remove any existing stamp for this asset
    this.removeBuildingStamp(assetId);

    const bs = assetData.tileset.boundingSphere;
    if (!bs || !bs.center) return;

    const carto = Cesium.Cartographic.fromCartesian(bs.center);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const height = carto.height;

    const label = assetData.name || `Asset ${assetId}`;

    // ── Cesium Entity (pin in scene) ────────────────────────────────────────
    const entity = this.viewer.entities.add({
      id: `building_stamp_${key}`,
      name: label,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, height + 5),
      billboard: {
        image: _buildPinSvg(),
        width: 36,
        height: 36,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.NONE,
      },
      label: {
        text: label,
        font: '12px sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -40),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.6),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      },
    });

    // ── GeoJSON feature ─────────────────────────────────────────────────────
    const geojsonFeature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [
          Math.round(lon * 1e7) / 1e7,
          Math.round(lat * 1e7) / 1e7,
          Math.round(height * 100) / 100,
        ],
      },
      properties: {
        assetId: assetId,
        name: label,
        timestamp: new Date().toISOString(),
      },
    };

    this.buildingStamps.stamps.set(key, { entity, geojson: geojsonFeature });
    this._updateStampCount();

    console.log(`📍 Building stamp added: ${label} (${lon.toFixed(5)}, ${lat.toFixed(5)})`);
  };

  BimViewer.removeBuildingStamp = function (assetId) {
    const key = assetId.toString();
    const stamp = this.buildingStamps.stamps.get(key);
    if (!stamp) return;

    this.viewer.entities.remove(stamp.entity);
    this.buildingStamps.stamps.delete(key);
    this._updateStampCount();
  };

  // ── Export GeoJSON ─────────────────────────────────────────────────────────

  BimViewer.exportBuildingStampsGeoJSON = function () {
    if (this.buildingStamps.stamps.size === 0) {
      this.updateStatus('No building stamps to export', 'error');
      return;
    }

    const features = [];
    for (const { geojson } of this.buildingStamps.stamps.values()) {
      features.push(geojson);
    }

    const collection = {
      type: 'FeatureCollection',
      features,
    };

    const json = JSON.stringify(collection, null, 2);
    const blob = new Blob([json], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `building-stamps_${new Date().toISOString().slice(0, 10)}.geojson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.updateStatus(`Exported ${features.length} building stamp(s) as GeoJSON`, 'success');
    console.log('📍 GeoJSON exported:', collection);
  };

  // ── Toggle stamps visibility ───────────────────────────────────────────────

  BimViewer.toggleBuildingStamps = function () {
    this.buildingStamps.enabled = !this.buildingStamps.enabled;
    for (const { entity } of this.buildingStamps.stamps.values()) {
      entity.show = this.buildingStamps.enabled;
    }
    const btn = document.getElementById('toggleBuildingStamps');
    if (btn) btn.classList.toggle('active', this.buildingStamps.enabled);
    this.updateStatus(
      this.buildingStamps.enabled ? '📍 Building stamps visible' : '📍 Building stamps hidden',
      'info'
    );
  };

  // ── Internal helpers ───────────────────────────────────────────────────────

  BimViewer._updateStampCount = function () {
    const badge = document.getElementById('buildingStampCount');
    if (badge) {
      const n = this.buildingStamps.stamps.size;
      badge.textContent = n;
      badge.style.display = n > 0 ? 'inline-flex' : 'none';
    }
  };

  /** Simple colored location-pin SVG rendered as a data-URI. */
  function _buildPinSvg() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
      <path d="M18 2C12.5 2 8 6.5 8 12c0 7.5 10 22 10 22s10-14.5 10-22C28 6.5 23.5 2 18 2z"
            fill="#E74C3C" stroke="#fff" stroke-width="2"/>
      <circle cx="18" cy="12" r="4" fill="#fff"/>
    </svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  // ── Hook into asset loading ────────────────────────────────────────────────

  // Piggyback on the same Map.set hook used by google-tiles-mask.js (if loaded),
  // or set up our own. We use a separate timer to avoid race conditions.
  const _target = BimViewer.loadedAssets;
  const _existingSet = _target.set.bind(_target);
  _target.set = function (key, value) {
    const result = _existingSet(key, value);
    setTimeout(function () {
      BimViewer.addBuildingStamp(parseInt(key, 10));
    }, 3000); // wait for flyTo + bounding sphere population
    return result;
  };

  // Clean up stamp when asset is removed
  if (typeof BimViewer.removeAsset === 'function') {
    const _origRemove = BimViewer.removeAsset;
    BimViewer.removeAsset = function (assetId) {
      _origRemove.call(this, assetId);
      this.removeBuildingStamp(assetId);
    };
  }

  console.log('📍 Building Stamp module loaded');
})();
