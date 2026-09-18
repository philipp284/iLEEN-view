/**
 * iLEEN — Geoidundulation aus dem EGM96-Gitter
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Cesium rechnet mit Höhen über dem WGS84-Ellipsoid, Pläne und Vermessung mit
 * Höhen über dem Meer. Die Differenz ist die Geoidundulation N:
 *
 *     H (NHN) ≈ h (Ellipsoid) − N
 *
 * `data/egm96-1deg.json` ist das amtliche 15′-Raster der NGA (EGM96,
 * gemeinfrei), bezogen über PROJ (`us_nga_egm96_15.tif`) und auf volle Grad
 * abgegriffen. Dieselbe Datei liest `backend/scripts/citygml2tiles.py` — eine
 * zweite Quelle liefe auseinander.
 *
 * Genauigkeit: bilinear über 1° liegt in Mitteleuropa unter einem halben Meter
 * neben dem vollen Modell. Für Anzeige und Kulisse genug, für eine
 * Vermessungsaufgabe nicht (dort gehört GCG2016 hin).
 */
'use strict';

window.ILEEN_GEOID = (function () {
  let raster = null;
  let laden = null;

  /** Lädt das Gitter einmal; weitere Aufrufe bekommen dasselbe Promise. */
  function load() {
    if (laden) return laden;
    laden = fetch('data/egm96-1deg.json')
      .then((antwort) => {
        if (!antwort.ok) throw new Error('HTTP ' + antwort.status);
        return antwort.json();
      })
      .then((daten) => {
        if (!daten || !Array.isArray(daten.grid) || daten.grid.length !== daten.rows) {
          throw new Error('unerwartetes Format');
        }
        raster = daten;
        return raster;
      })
      .catch((fehler) => {
        console.warn('EGM96-Gitter nicht geladen:', fehler.message);
        laden = null;   // später erneut versuchbar
        return null;
      });
    return laden;
  }

  function wert(zeile, spalte) {
    const z = Math.max(0, Math.min(raster.rows - 1, zeile));
    const s = ((spalte % raster.cols) + raster.cols) % raster.cols;   // Datumsgrenze umlaufend
    return raster.grid[z][s];
  }

  /**
   * Undulation N in Metern an (lat, lon) in Grad — oder null, solange das
   * Gitter nicht geladen ist. Nie eine erfundene Null: eine Höhe, die um
   * 48 m daneben liegt, sieht aus wie eine gemessene.
   */
  function getUndulation(lat, lon) {
    if (!raster || !isFinite(lat) || !isFinite(lon)) return null;
    const res = raster.resolution;
    const z = (raster.lat_start - lat) / res;        // Zeilen laufen von Nord nach Süd
    const s = (lon - raster.lon_start) / res;
    const z0 = Math.floor(z);
    const s0 = Math.floor(s);
    const fz = z - z0;
    const fs = s - s0;
    const oben = wert(z0, s0) * (1 - fs) + wert(z0, s0 + 1) * fs;
    const unten = wert(z0 + 1, s0) * (1 - fs) + wert(z0 + 1, s0 + 1) * fs;
    return oben * (1 - fz) + unten * fz;
  }

  /** Ellipsoidhöhe → Höhe über dem Geoid, samt der benutzten Undulation. */
  function toOrthometric(ellipsoidHoehe, lat, lon) {
    const n = getUndulation(lat, lon);
    if (n === null) return null;
    return { orthometric: ellipsoidHoehe - n, undulation: n };
  }

  /** Höhe über dem Geoid → Ellipsoidhöhe. */
  function toEllipsoidal(orthometrischeHoehe, lat, lon) {
    const n = getUndulation(lat, lon);
    return n === null ? null : orthometrischeHoehe + n;
  }

  return {
    load,
    getUndulation,
    toOrthometric,
    toEllipsoidal,
    get geladen() { return raster !== null; }
  };
})();
