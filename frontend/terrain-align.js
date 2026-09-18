/**
 * iLEEN — Geländeausrichtung für Backend-Assets
 *
 * Behebt die Höhendifferenz zwischen Asset-Manager und Viewer.
 *
 * Das Backend löst eine Platzierung „0 m über Gelände" gegen Copernicus GLO-90
 * (bzw. eine lokale Geländereferenz) auf und schreibt das Ergebnis als feste
 * ellipsoidische Höhe in `root.transform`. CesiumJS zeigt dieselbe Stelle aber
 * auf Cesium World Terrain — eine andere Datenquelle mit anderer Geländehöhe.
 * Die Differenz beträgt je nach Ort einige Meter bis mehrere Zehnermeter, und
 * genau um diesen Betrag schwebt oder versinkt das Modell im Viewer, obwohl im
 * Backend „auf Gelände" eingestellt ist.
 *
 * Dieses Modul wiederholt die Auflösung im Viewer:
 *
 *     Backend :  height_ellipsoid = height + DEM(lon,lat)      [Copernicus]
 *     Viewer  :  ziel             = height + Terrain(lon,lat)  [Cesium]
 *     Versatz  = ziel − height_ellipsoid
 *
 * Der Versatz wird als Translation entlang der lokalen Hochachse auf
 * `tileset.modelMatrix` gelegt — dieselbe Technik wie in `z-offset.js`, damit
 * beide sich sauber überlagern: die ausgerichtete Lage wird dort als
 * „Originalposition" gespeichert, ein Z-Offset des Nutzers addiert darauf.
 *
 * Wirkt ausschließlich bei `height_reference === 'terrain'`. Wer im Backend
 * bewusst `ellipsoid` oder `msl` gewählt hat, meint eine absolute Höhe — die
 * darf der Viewer nicht verschieben.
 */
'use strict';

const ILeenTerrainAlign = {
  /** Automatisch beim Laden ausrichten. Über die Einstellungen schaltbar. */
  enabled: true,

  /** tileset → { delta, terrainHeight, backendHeight, lon, lat, height } */
  applied: new WeakMap(),

  /** Unterhalb dieses Betrags lohnt die Verschiebung nicht (Sample-Rauschen). */
  THRESHOLD_M: 0.05,

  // ── Platzierung ermitteln ──────────────────────────────────────────────────

  /**
   * Platzierungsinfo eines Assets: bevorzugt aus `root.extras.ileen` der
   * tileset.json (kommt ohne Zusatz-Request und funktioniert auch beim Laden
   * direkt aus dem MinIO-Bucket), sonst über die Placement-API — der Fall für
   * Tilesets, die vor Einführung der Extras getilt wurden.
   */
  async readPlacement(assetData) {
    const extras = assetData?.tileset?.root?.extras?.ileen;
    if (extras && typeof extras.heightEllipsoid === 'number') {
      return {
        lon: extras.lon,
        lat: extras.lat,
        height: extras.height,
        heightReference: extras.heightReference,
        heightEllipsoid: extras.heightEllipsoid,
        source: 'extras'
      };
    }

    const jobId = assetData?.jobId || this._jobIdFromUrl(assetData?.url);
    const baseUrl = window.BimViewer && BimViewer.getBackendUrl && BimViewer.getBackendUrl();
    if (!jobId || !baseUrl) return null;

    try {
      const response = await fetch(`${baseUrl}/assets/${jobId}/placement`);
      if (!response.ok) return null;
      const p = await response.json();
      return {
        lon: p.lon,
        lat: p.lat,
        height: p.height,
        heightReference: p.height_reference,
        heightEllipsoid: p.height_ellipsoid,
        source: 'api'
      };
    } catch (e) {
      console.warn('[TerrainAlign] Platzierung nicht abrufbar:', e.message);
      return null;
    }
  },

  _jobIdFromUrl(url) {
    if (!url) return null;
    const match = /\/tiles\/([^/]+)\/tileset\.json/.exec(url);
    return match ? match[1] : null;
  },

  // ── Ausrichten ─────────────────────────────────────────────────────────────

  /**
   * Richtet ein geladenes Asset auf das Terrain des Viewers aus.
   * Gibt das angewandte Delta in Metern zurück, oder null wenn nichts zu tun war.
   */
  async alignAsset(assetData, { force = false } = {}) {
    if (!this.enabled && !force) return null;
    if (!assetData || !assetData.tileset || !window.BimViewer?.viewer) return null;

    const placement = await this.readPlacement(assetData);
    if (!placement) return null;

    if (placement.heightReference !== 'terrain') {
      // 'ellipsoid' und 'msl' sind absolute Höhen — die sind im Viewer bereits
      // korrekt und dürfen nicht nachgerechnet werden.
      return null;
    }

    const terrainHeight = await this.sampleTerrain(placement.lon, placement.lat);
    if (terrainHeight === null) return null;

    const target = terrainHeight + placement.height;
    const delta = target - placement.heightEllipsoid;

    if (!isFinite(delta) || Math.abs(delta) < this.THRESHOLD_M) {
      this.applied.set(assetData.tileset, {
        delta: 0, terrainHeight, backendHeight: placement.heightEllipsoid,
        lon: placement.lon, lat: placement.lat, height: placement.height
      });
      return 0;
    }

    this.applyShift(assetData.tileset, placement.lon, placement.lat, delta);
    this.applied.set(assetData.tileset, {
      delta, terrainHeight, backendHeight: placement.heightEllipsoid,
      lon: placement.lon, lat: placement.lat, height: placement.height
    });

    console.log(
      `[TerrainAlign] ${assetData.name}: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} m ` +
      `(Backend ${placement.heightEllipsoid.toFixed(1)} m → Cesium-Gelände ` +
      `${terrainHeight.toFixed(1)} m ${placement.height >= 0 ? '+' : ''}${placement.height} m)`
    );
    return delta;
  },

  /**
   * Geländehöhe über dem Ellipsoid an einer Position, oder null wenn der
   * Viewer gar kein Terrain zeigt (Ellipsoid-Modus, u.a. wenn Google
   * Photorealistic 3D Tiles aktiv sind — dort ist die sichtbare Oberfläche die
   * der Tiles, nicht die des Terrain-Providers).
   */
  async sampleTerrain(lon, lat) {
    const viewer = BimViewer.viewer;
    const provider = viewer.terrainProvider;
    if (!provider || provider instanceof Cesium.EllipsoidTerrainProvider) {
      console.log('[TerrainAlign] Kein Terrain-Provider aktiv — Ausrichtung übersprungen.');
      return null;
    }

    try {
      const positions = [Cesium.Cartographic.fromDegrees(lon, lat)];
      const [sampled] = await Cesium.sampleTerrainMostDetailed(provider, positions);
      if (!sampled || typeof sampled.height !== 'number' || !isFinite(sampled.height)) {
        return null;
      }
      return sampled.height;
    } catch (e) {
      console.warn('[TerrainAlign] Terrain-Abfrage fehlgeschlagen:', e.message);
      return null;
    }
  },

  /**
   * Legt eine vertikale Verschiebung auf die `modelMatrix`.
   *
   * Der Vektor wird als Differenz zweier Punkte auf derselben Lotlinie gebildet
   * statt als skalierte Normale: so zeigt er exakt entlang der Ellipsoidnormale
   * am Modellstandort, unabhängig von Breitengrad und Abplattung.
   */
  applyShift(tileset, lon, lat, deltaMeters) {
    const surface = Cesium.Cartesian3.fromDegrees(lon, lat, 0.0);
    const raised = Cesium.Cartesian3.fromDegrees(lon, lat, deltaMeters);
    const translation = Cesium.Cartesian3.subtract(raised, surface, new Cesium.Cartesian3());
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);

    // z-offset.js merkt sich beim ersten Schieben die damalige modelMatrix als
    // „Originalposition". Wurde sie vor dieser Ausrichtung gespeichert, zeigt
    // sie auf die alte, falsche Höhe — verwerfen, damit der nächste Z-Offset
    // von der ausgerichteten Lage aus rechnet.
    const zOffset = window.BimViewer && BimViewer.zOffset;
    if (zOffset?.originalPositions?.has(tileset)) {
      zOffset.originalPositions.delete(tileset);
      zOffset.originalCartographics?.delete(tileset);
      zOffset.individualOffsets?.delete(tileset);
    }
  },

  /** Hebt die Ausrichtung eines Assets auf. */
  reset(tileset) {
    if (!tileset) return;
    tileset.modelMatrix = Cesium.Matrix4.IDENTITY.clone();
    this.applied.delete(tileset);
  },

  /** Angewandte Ausrichtung eines Assets, für die Anzeige im UI. */
  info(tileset) {
    return tileset ? this.applied.get(tileset) || null : null;
  },

  // ── Sammelaktionen ─────────────────────────────────────────────────────────

  /** Richtet alle geladenen Backend-Assets neu aus (z.B. nach Terrainwechsel). */
  async alignAll({ force = false } = {}) {
    if (!window.BimViewer?.loadedAssets) return 0;
    let count = 0;
    for (const assetData of BimViewer.loadedAssets.values()) {
      if (assetData.type !== 'BACKEND') continue;
      const delta = await this.alignAsset(assetData, { force });
      if (delta !== null && Math.abs(delta) >= this.THRESHOLD_M) count++;
    }
    if (count > 0 && window.BimViewer?.updateStatus) {
      BimViewer.updateStatus(`${count} Modell(e) auf das Gelände ausgerichtet`, 'success');
    }
    return count;
  },

  /** Schaltet die automatische Ausrichtung um und wendet sie sofort an. */
  async setEnabled(enabled) {
    this.enabled = !!enabled;
    localStorage.setItem('ileen_terrain_align', this.enabled ? '1' : '0');

    if (!window.BimViewer?.loadedAssets) return;
    if (this.enabled) {
      await this.alignAll();
    } else {
      for (const assetData of BimViewer.loadedAssets.values()) {
        if (assetData.type === 'BACKEND') this.reset(assetData.tileset);
      }
    }
  },

  /**
   * Die Ausrichtung läuft immer — der Schalter dafür ist aus den Einstellungen
   * verschwunden. Ein früher gespeichertes „aus" wird deshalb bewusst nicht
   * mehr gelesen: es ließe sich ohne Bedienelement nie wieder zurücknehmen und
   * die Modelle blieben für immer neben dem Gelände stehen.
   */
  init() {
    localStorage.removeItem('ileen_terrain_align');
    console.log(`✅ Geländeausrichtung ${this.enabled ? 'aktiv' : 'deaktiviert'}`);
  }
};

window.ILeenTerrainAlign = ILeenTerrainAlign;
ILeenTerrainAlign.init();
