/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *
 */

// ===============================
// CESIUM BIM VIEWER - ROTATION MODULE v1.0
// Rotate 3D-Tiles / IFC assets around their own vertical (Z) axis.
// Shares the "original modelMatrix" snapshot with the Z-Offset module
// (z-offset.js) so both features can be combined without overwriting
// each other. GLB models already have their own heading control
// (see core.js updateGLBPosition) and are not touched by this module.
// ===============================
'use strict';

(function(BimViewer) {

  // Initialize Rotation system
  BimViewer.initRotation = function() {
    this.rotation = {
      individualHeadings: new Map() // tileset -> current heading in degrees (0-360)
    };

    console.log('✅ Rotation system initialized (v1.0 - Z-Axis Heading)');
  };

  // Make sure the "original" modelMatrix/cartographic snapshot exists for
  // this tileset. Reuses the Z-Offset module's storage so both modules
  // always compose relative to the same untouched baseline.
  BimViewer._ensureOriginalTransform = function(tileset) {
    if (!this.zOffset) {
      this.initZOffset();
    }
    if (!this.zOffset.originalPositions.has(tileset)) {
      this.zOffset.originalPositions.set(tileset, Cesium.Matrix4.clone(tileset.modelMatrix));

      const originalCenter = Cesium.Cartesian3.clone(tileset.boundingSphere.center);
      const originalCartographic = Cesium.Cartographic.fromCartesian(originalCenter);
      this.zOffset.originalCartographics.set(tileset, originalCartographic);
    }
  };

  // Builds a 4x4 matrix that rotates around the local vertical axis
  // (the ellipsoid surface normal) passing through the tileset's ORIGINAL
  // center point, by headingDegrees. Positive heading = clockwise when
  // viewed from above, matching compass heading convention used elsewhere
  // (see GLB heading in core.js).
  BimViewer.buildHeadingRotationMatrix = function(tileset, headingDegrees) {
    const originalCartographic = this.zOffset.originalCartographics.get(tileset);

    const originalCenter = Cesium.Cartesian3.fromRadians(
      originalCartographic.longitude,
      originalCartographic.latitude,
      originalCartographic.height
    );

    const axis = Cesium.Cartesian3.normalize(originalCenter, new Cesium.Cartesian3());
    const quaternion = Cesium.Quaternion.fromAxisAngle(axis, -Cesium.Math.toRadians(headingDegrees));
    const rotation3 = Cesium.Matrix3.fromQuaternion(quaternion);
    const rotate = Cesium.Matrix4.fromRotationTranslation(rotation3, Cesium.Cartesian3.ZERO, new Cesium.Matrix4());

    const toOrigin = Cesium.Matrix4.fromTranslation(
      Cesium.Cartesian3.negate(originalCenter, new Cesium.Cartesian3()),
      new Cesium.Matrix4()
    );
    const fromOrigin = Cesium.Matrix4.fromTranslation(originalCenter, new Cesium.Matrix4());

    let matrix = Cesium.Matrix4.multiply(rotate, toOrigin, new Cesium.Matrix4());
    matrix = Cesium.Matrix4.multiply(fromOrigin, matrix, matrix);
    return matrix;
  };

  // Apply Z-axis rotation to a specific asset (absolute heading in degrees)
  BimViewer.applyIndividualRotation = async function(assetId, headingDegrees, isLiveUpdate = false) {
    const asset = Array.from(this.loadedAssets.values()).find(a => a.id === assetId);

    if (!asset || !asset.tileset) {
      console.error(`Asset ${assetId} not found or has no tileset`);
      return;
    }

    this._ensureOriginalTransform(asset.tileset);

    const normalizedHeading = ((headingDegrees % 360) + 360) % 360;
    this.rotation.individualHeadings.set(asset.tileset, normalizedHeading);

    // Re-run the Z-Offset matrix build (with the current offset, 0 if none)
    // so it folds in this rotation and both stay combined correctly.
    const currentOffset = this.zOffset.individualOffsets.get(asset.tileset) || 0;
    const originalCartographic = this.zOffset.originalCartographics.get(asset.tileset);
    await this.applyZOffsetToAsset(asset, currentOffset, originalCartographic, true);

    if (!isLiveUpdate) {
      console.log(`🔄 ${asset.name}: rotated to ${normalizedHeading.toFixed(0)}° around Z-axis`);
      this.updateStatus(`Rotation: ${asset.name} = ${normalizedHeading.toFixed(0)}°`, 'success');
    }
  };

  // Reset asset rotation to 0° (keeps any current Z-Offset intact)
  BimViewer.resetAssetRotation = function(assetId) {
    const asset = Array.from(this.loadedAssets.values()).find(a => a.id === assetId);

    if (!asset || !asset.tileset || !this.zOffset) {
      return;
    }

    this.rotation.individualHeadings.delete(asset.tileset);

    const originalCartographic = this.zOffset.originalCartographics.get(asset.tileset);
    if (!originalCartographic) return;

    const currentOffset = this.zOffset.individualOffsets.get(asset.tileset) || 0;
    this.applyZOffsetToAsset(asset, currentOffset, originalCartographic, true);

    console.log(`♻️ ${asset.name} rotation reset to 0°`);
  };

  console.log('✅ Rotation module v1.0 loaded (rotate assets around Z-axis)');

})(window.BimViewer = window.BimViewer || {});
