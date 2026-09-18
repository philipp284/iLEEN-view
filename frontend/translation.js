/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *
 */

// ===============================
// CESIUM BIM VIEWER - TRANSLATION MODULE v1.0
// Verschiebt 3D-Tiles-/IFC-Modelle waagerecht: X = Ost, Y = Nord, in Metern.
//
// Warum ein eigenes Modul und nicht zwei Regler im Z-Offset:
// Höhe, Drehung und Lage sind drei Bedienschritte, aber *eine* Matrix. Jedes
// Modul hält nur seinen Wert; zusammengesetzt wird an einer einzigen Stelle
// (z-offset.js → applyZOffsetToAsset), die immer von der unveränderten
// Ausgangsmatrix ausgeht. Sonst würde die zuletzt bediente Achse die beiden
// anderen zurücksetzen.
//
// Ost/Nord beziehen sich auf das lokale ENU-Koordinatensystem im
// ursprünglichen Mittelpunkt des Modells — dieselbe Bezugsstelle, die
// rotation.js für die Drehachse benutzt.
// GLB-Modelle haben eigene Lon/Lat-Felder (core.js) und bleiben unberührt.
// ===============================
'use strict';

(function(BimViewer) {

  BimViewer.initTranslation = function() {
    this.translation = {
      individualOffsets: new Map()  // tileset -> { east, north } in Metern
    };

    console.log('✅ Translation system initialized (v1.0 — X/Y in Metern)');
  };

  /**
   * Waagerechte Verschiebung eines Modells (absolut, nicht kumulativ).
   *
   * `east`/`north` sind Meter gegenüber der Ausgangslage — 0/0 ist also
   * immer die Stelle, an der das Modell geladen wurde.
   */
  BimViewer.applyIndividualTranslation = async function(assetId, east, north, isLiveUpdate = false) {
    const asset = Array.from(this.loadedAssets.values()).find(a => a.id === assetId);

    if (!asset || !asset.tileset) {
      console.error(`Asset ${assetId} not found or has no tileset`);
      return;
    }

    if (!this.translation) this.initTranslation();
    this._ensureOriginalTransform(asset.tileset);

    this.translation.individualOffsets.set(asset.tileset, {
      east: Number(east) || 0,
      north: Number(north) || 0
    });

    // Über den Z-Offset-Weg zeichnen, damit Höhe und Drehung erhalten bleiben.
    const currentOffset = this.zOffset.individualOffsets.get(asset.tileset) || 0;
    const originalCartographic = this.zOffset.originalCartographics.get(asset.tileset);
    await this.applyZOffsetToAsset(asset, currentOffset, originalCartographic, true);

    if (!isLiveUpdate) {
      console.log(`↔️ ${asset.name}: X ${Number(east).toFixed(2)} m · Y ${Number(north).toFixed(2)} m`);
      this.updateStatus(
        `Verschoben: ${asset.name} — X ${Number(east).toFixed(2)} m / Y ${Number(north).toFixed(2)} m`,
        'success'
      );
    }
  };

  /** Setzt die waagerechte Verschiebung zurück (Höhe und Drehung bleiben). */
  BimViewer.resetAssetTranslation = function(assetId) {
    const asset = Array.from(this.loadedAssets.values()).find(a => a.id === assetId);

    if (!asset || !asset.tileset || !this.translation || !this.zOffset) {
      return;
    }

    this.translation.individualOffsets.delete(asset.tileset);

    const originalCartographic = this.zOffset.originalCartographics.get(asset.tileset);
    if (!originalCartographic) return;

    const currentOffset = this.zOffset.individualOffsets.get(asset.tileset) || 0;
    this.applyZOffsetToAsset(asset, currentOffset, originalCartographic, true);

    console.log(`♻️ ${asset.name}: Verschiebung zurückgesetzt`);
  };

  console.log('✅ Translation module v1.0 geladen (Modelle in X/Y verschieben)');

})(window.BimViewer = window.BimViewer || {});
