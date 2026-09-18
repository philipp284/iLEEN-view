/**
 * iLEEN — Höhenversatz eines Modells und die gemeinsame Lagematrix
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Höhe (hier), Drehung (rotation.js) und Verschiebung (translation.js) sind
 * drei Bedienschritte, aber EINE Matrix. Zusammengesetzt wird ausschließlich
 * in `applyZOffsetToAsset`, und zwar immer von der unveränderten
 * Ausgangsmatrix aus — sonst setzte die zuletzt bediente Achse die beiden
 * anderen zurück.
 *
 *   Ausgang   zOffset.originalPositions      tileset → Matrix4 beim ersten Eingriff
 *   Bezug     zOffset.originalCartographics  tileset → Cartographic der Hüllkugel
 *   Höhe      zOffset.individualOffsets      tileset → Meter
 *
 * terrain-align.js leert die drei Einträge, wenn es ein Modell neu auf das
 * Gelände setzt; der nächste Eingriff nimmt dann die ausgerichtete Lage als
 * Ausgang.
 */
'use strict';

(function () {
  if (typeof BimViewer === 'undefined') {
    console.error('z-offset.js: core.js muss vorher geladen sein');
    return;
  }

  BimViewer.initZOffset = function () {
    if (this.zOffset) return;
    this.zOffset = {
      enabled: false,
      globalOffset: 0,
      originalPositions: new Map(),
      originalCartographics: new Map(),
      individualOffsets: new Map()
    };
  };

  function assetVon(assetId) {
    const direkt = BimViewer.loadedAssets.get(assetId);
    if (direkt) return direkt;
    return Array.from(BimViewer.loadedAssets.values()).find((a) => String(a.id) === String(assetId));
  }

  /** Merkt Ausgangsmatrix und Bezugspunkt, falls noch nicht geschehen. */
  BimViewer._lageAusgangSichern = function (tileset) {
    this.initZOffset();
    if (!this.zOffset.originalPositions.has(tileset)) {
      this.zOffset.originalPositions.set(tileset, Cesium.Matrix4.clone(tileset.modelMatrix));
    }
    if (!this.zOffset.originalCartographics.has(tileset)) {
      const kugel = tileset.boundingSphere;
      if (!kugel) return null;
      this.zOffset.originalCartographics.set(tileset, Cesium.Cartographic.fromCartesian(kugel.center));
    }
    return this.zOffset.originalCartographics.get(tileset);
  };

  /** Höhe eines Modells in Metern setzen (Regler im Asset-Flyout). */
  BimViewer.applyIndividualZOffset = async function (assetId, meter, liveUpdate) {
    const asset = assetVon(assetId);
    if (!asset || !asset.tileset) return;
    const wert = parseFloat(meter) || 0;
    const bezug = this._lageAusgangSichern(asset.tileset);
    if (!bezug) {
      console.warn('Höhenversatz: ' + asset.name + ' hat noch keine Hüllkugel');
      return;
    }
    // Vor dem Anwenden eintragen: rotation.js und translation.js lesen den
    // Wert, und ein laufender Aufruf darf ihnen keinen alten Stand zeigen.
    this.zOffset.individualOffsets.set(asset.tileset, wert);
    await this.applyZOffsetToAsset(asset, wert, bezug, liveUpdate);
  };

  /**
   * Setzt die Lagematrix eines Modells aus Ausgang, Drehung, Verschiebung und
   * Höhe zusammen. Liefert ein Promise, damit Aufrufer auf die neue Lage
   * warten können (rotation.js, translation.js).
   */
  BimViewer.applyZOffsetToAsset = function (asset, hoehe, bezug, liveUpdate) {
    return new Promise((fertig) => {
      try {
        const tileset = asset && asset.tileset;
        if (!tileset) return fertig();
        const ausgang = bezug || this._lageAusgangSichern(tileset);
        let basis = this.zOffset && this.zOffset.originalPositions.get(tileset);
        if (!ausgang || !basis) {
          console.error('Keine Ausgangslage für ' + (asset.name || asset.id));
          return fertig();
        }

        // Waagerechte Verschiebung aus translation.js — X = Ost, Y = Nord.
        const verschiebung = (this.translation && this.translation.individualOffsets.get(tileset))
          || { east: 0, north: 0 };

        // Ost/Nord/Oben am ursprünglichen Mittelpunkt (auf Ellipsoidhöhe 0)
        // in Weltkoordinaten drehen. Die dritte Achse ist die Ellipsoidnormale.
        const fusspunkt = Cesium.Cartesian3.fromRadians(ausgang.longitude, ausgang.latitude, 0.0);
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(fusspunkt);
        const achsen = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
        const oertlich = new Cesium.Cartesian3(verschiebung.east || 0, verschiebung.north || 0, hoehe || 0);
        const welt = Cesium.Matrix3.multiplyByVector(achsen, oertlich, new Cesium.Cartesian3());
        const versatz = Cesium.Matrix4.fromTranslation(welt);

        // Eine gesetzte Drehung um die Hochachse (rotation.js) gehört mit
        // hinein, sonst nähme jeder Höhenzug die Drehung zurück.
        if (this.rotation && this.rotation.individualHeadings.has(tileset) &&
            typeof this.buildHeadingRotationMatrix === 'function') {
          const grad = this.rotation.individualHeadings.get(tileset);
          const drehung = this.buildHeadingRotationMatrix(tileset, grad);
          basis = Cesium.Matrix4.multiply(drehung, basis, new Cesium.Matrix4());
        }

        tileset.modelMatrix = Cesium.Matrix4.multiply(versatz, basis, new Cesium.Matrix4());
        if (!liveUpdate && this.viewer) this.viewer.scene.requestRender();
      } catch (fehler) {
        console.error('Lagematrix konnte nicht gesetzt werden:', fehler);
      }
      fertig();
    });
  };

  /** Denselben Höhenversatz auf alle Modelle legen. */
  BimViewer.applyGlobalZOffset = async function (meter) {
    this.initZOffset();
    const wert = parseFloat(meter) || 0;
    this.zOffset.globalOffset = wert;
    const auftraege = [];
    this.loadedAssets.forEach((asset, id) => {
      if (asset.tileset) auftraege.push(this.applyIndividualZOffset(id, wert, false));
    });
    await Promise.all(auftraege);
  };

  /** Höhe auf null — Drehung und Verschiebung bleiben stehen. */
  BimViewer.resetAssetZOffset = function (assetId) {
    const asset = assetVon(assetId);
    if (!asset || !asset.tileset || !this.zOffset) return;
    const bezug = this.zOffset.originalCartographics.get(asset.tileset);
    if (!bezug) return;   // nie verschoben → nichts zurückzunehmen
    this.zOffset.individualOffsets.set(asset.tileset, 0);
    this.applyZOffsetToAsset(asset, 0, bezug, true);
  };
})();
