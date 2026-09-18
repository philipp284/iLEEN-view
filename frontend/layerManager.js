/**
 * iLEEN — Karte, Gelände und 3D-Ebenen unter dem Modell
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Drei Fragen, drei Listen: welche Karte liegt auf dem Globus, welches
 * Gelände trägt sie, und welche amtliche Gebäudekulisse steht darauf. Das
 * Panel dazu baut ui.js (`getLayerManagerContent`); diese Datei füllt dessen
 * Behälter `#basemapList`, `#terrainList` und `#tilesetLayersList`.
 */
'use strict';

(function () {

  const LayerManager = {
    viewer: null,
    aktiveKarte: null,
    aktivesGelaende: null,

    basemaps: [],
    terrains: [],

    // ── Amtliche Gebäudekulisse ────────────────────────────────────────
    //
    // Die Liste ist leer, und das ist eine Entscheidung, keine Lücke.
    //
    // Bis September 2026 stand hier die selbst gerechnete LoD2-Kachel von
    // Mainz (`data/rlp-lod2/`, erzeugt mit `backend/scripts/citygml2tiles.py`).
    // Sie ist herausgenommen worden: die Kachel deckt zwei Quadratkilometer ab,
    // liegt als 9 MB im Auslieferungsstand und zeigt überall sonst nichts —
    // eine Gebäudekulisse, die nur an einer Stelle Gebäude hat, ist für einen
    // ausgelieferten Viewer eine Fehlbedienung mit Ansage. OSM Buildings und
    // Google 3D Tiles darüber beantworten dieselbe Frage flächendeckend.
    //
    // Die Maschinerie bleibt vollständig: `enableTileset()` lädt jedes
    // 3D-Tiles-Gebäudeset, `ALKIS_DACHFORM` übersetzt die Dachform, und der
    // Klick liest die Batch Table. Ein neuer Datensatz ist ein Eintrag hier:
    //
    //   { id: 'rlp-lod2', name: 'RLP LoD2', nameEN: 'RLP LoD2 Buildings',
    //     description: 'Gebäudemodelle Rheinland-Pfalz (CityGML, Open Data)',
    //     url: 'data/rlp-lod2/tileset.json', tileset: null,
    //     active: false, loading: false, heightOffset: 0,
    //     credit: 'Landesamt für Vermessung und Geobasisinformation '
    //           + 'Rheinland-Pfalz — dl-de/by-2-0' }
    //
    // `heightOffset` ist dabei 0, wenn der Konverter die Normalhöhen schon
    // über die EGM96-Undulation auf den Ellipsoid gerechnet hat (das tut
    // citygml2tiles.py). Ein Dienst, der Normalhöhen ausliefert, braucht dort
    // einen Aufschlag.
    tilesetLayers: [],

    // ── Start ──────────────────────────────────────────────────────────

    init(viewer) {
      this.viewer = viewer;

      this.basemaps = [
        { id: 'bing-aerial', name: 'Luftbild (Bing)', laden: () => Cesium.IonImageryProvider.fromAssetId(2) },
        { id: 'bing-labels', name: 'Luftbild mit Beschriftung', laden: () => Cesium.IonImageryProvider.fromAssetId(3) },
        { id: 'bing-roads', name: 'Straßenkarte (Bing)', laden: () => Cesium.IonImageryProvider.fromAssetId(4) },
        { id: 'osm', name: 'OpenStreetMap',
          laden: async () => new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }) },
        { id: 'sentinel', name: 'Sentinel-2', laden: () => Cesium.IonImageryProvider.fromAssetId(3954) },
        { id: 'none', name: 'Keine Karte', laden: null }
      ];

      this.terrains = [
        { id: 'world', name: 'Cesium World Terrain',
          laden: () => Cesium.createWorldTerrainAsync({ requestVertexNormals: true }) },
        { id: 'ellipsoid', name: 'Ohne Gelände (Ellipsoid)',
          laden: async () => new Cesium.EllipsoidTerrainProvider() }
      ];

      // Was core.js beim Anlegen des Viewers gesetzt hat
      this.aktiveKarte = 'bing-aerial';
      this.aktivesGelaende = viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider
        ? 'ellipsoid' : 'world';

      this.populateUI();
    },

    // ── Karte ──────────────────────────────────────────────────────────

    async switchBasemap(id) {
      const ziel = this.basemaps.find((b) => b.id === id);
      if (!ziel || !this.viewer) return;
      const ebenen = this.viewer.imageryLayers;
      try {
        // Die Grundkarte ist immer die unterste Ebene; Überlagerungen darüber
        // bleiben unberührt.
        if (ebenen.length > 0 && ebenen.get(0)._ileenGrundkarte !== false) {
          ebenen.remove(ebenen.get(0), true);
        }
        if (ziel.laden) {
          const anbieter = await ziel.laden();
          const ebene = ebenen.addImageryProvider(anbieter, 0);
          ebene._ileenGrundkarte = true;
        }
        this.aktiveKarte = id;
        this.updateBasemapUI();
        this.viewer.scene.requestRender();
      } catch (fehler) {
        console.error('Karte nicht verfügbar:', fehler);
        BimViewer.updateStatus(ziel.name + ' nicht verfügbar', 'error');
      }
    },

    // ── Gelände ────────────────────────────────────────────────────────

    async switchTerrain(id) {
      const ziel = this.terrains.find((g) => g.id === id);
      if (!ziel || !this.viewer) return;
      try {
        BimViewer.updateStatus('Gelände wird geladen …', 'loading');
        this.viewer.terrainProvider = await ziel.laden();
        this.aktivesGelaende = id;
        this.updateTerrainUI();
        BimViewer.updateStatus('Gelände: ' + ziel.name, 'success');
      } catch (fehler) {
        console.error('Gelände nicht verfügbar:', fehler);
        BimViewer.updateStatus(ziel.name + ' nicht verfügbar', 'error');
      }
    },

    // ── Panel ──────────────────────────────────────────────────────────

    populateUI() {
      this.updateBasemapUI();
      this.updateTerrainUI();
      this.updateTilesetUI();
    },

    _auswahlZeilen(liste, aktiv, name, aufruf) {
      return liste.map((eintrag) =>
        '<label class="row layer-choice">' +
          '<span class="row__label">' + eintrag.name + '</span>' +
          '<input type="radio" name="' + name + '" value="' + eintrag.id + '"' +
            (eintrag.id === aktiv ? ' checked' : '') +
            ' onchange="LayerManager.' + aufruf + '(this.value)">' +
        '</label>').join('');
    },

    updateBasemapUI() {
      const behaelter = document.getElementById('basemapList');
      if (behaelter) behaelter.innerHTML = this._auswahlZeilen(this.basemaps, this.aktiveKarte, 'ileenBasemap', 'switchBasemap');
    },

    updateTerrainUI() {
      const behaelter = document.getElementById('terrainList');
      if (behaelter) behaelter.innerHTML = this._auswahlZeilen(this.terrains, this.aktivesGelaende, 'ileenTerrain', 'switchTerrain');
    },

    /**
     * ALKIS-Dachform in Klartext.
     *
     * Die Abgabe führt die Dachform als Zahl aus dem AAA-Objektartenkatalog:
     * „3100" statt „Satteldach". Der Rohwert bleibt in Klammern stehen — er
     * ist die belastbare Angabe, der Klartext nur die Lesehilfe.
     *
     * Für die **Gebäudefunktion** (`31001_2000`, `51009_1610`) gibt es hier
     * bewusst keine Tabelle. Der Katalog hat mehrere hundert Schlüssel, und
     * ein falsch zugeordneter Klartext („Hütte" auf einem Bürohaus) ist
     * schlimmer als die Zahl: die Zahl sagt wenigstens, dass man nachsehen
     * muss. Sie steht deshalb als „ALKIS-Funktionsschlüssel" da.
     */
    ALKIS_DACHFORM: {
      1000: 'Flachdach',
      2100: 'Pultdach',
      2200: 'Versetztes Pultdach',
      3100: 'Satteldach',
      3200: 'Walmdach',
      3300: 'Krüppelwalmdach',
      3400: 'Mansarddach',
      3500: 'Zeltdach',
      3600: 'Kegeldach',
      3700: 'Kuppeldach',
      3800: 'Sheddach',
      3900: 'Bogendach',
      4000: 'Turmdach',
      5000: 'Mischform',
      9999: 'Sonstiges'
    },

    /** `3100` → `Satteldach (3100)`; unbekannte Schlüssel bleiben unverändert. */
    alkisKlartext(code, tabelle) {
      if (code === undefined || code === null || code === '') return null;
      const roh = String(code);
      const text = tabelle[parseInt(roh.split('_').pop(), 10)];
      return text ? text + ' (' + roh + ')' : roh;
    },

    // ── 3D-Ebenen ──────────────────────────────────────────────────────

    async enableTileset(id) {
      const entry = this.tilesetLayers.find((t) => t.id === id);
      if (!entry || entry.active || entry.loading || !this.viewer) return;
      if (this.viewer.scene.mode !== Cesium.SceneMode.SCENE3D) {
        BimViewer.updateStatus(entry.name + ' nur im 3D-Modus verfügbar', 'warning');
        return;
      }

      entry.loading = true;
      this.updateTilesetUI();

      try {
        entry.tileset = await Cesium.Cesium3DTileset.fromUrl(entry.url, {
          maximumScreenSpaceError: 16
        });
        this.viewer.scene.primitives.add(entry.tileset);

        // Pauschaler Höhenaufschlag NHN → Ellipsoid. Nur für Dienste nötig,
        // die ihre Kacheln mit Normalhöhen ausliefern; die selbst erzeugte
        // RLP-Ebene bringt den Bezug schon im `root.transform` mit
        // (heightOffset: 0), siehe backend/scripts/citygml2tiles.py.
        if (entry.heightOffset) {
          const mitte = Cesium.Cartographic.fromCartesian(entry.tileset.boundingSphere.center);
          const unten = Cesium.Cartesian3.fromRadians(mitte.longitude, mitte.latitude, 0);
          const oben = Cesium.Cartesian3.fromRadians(mitte.longitude, mitte.latitude, entry.heightOffset);
          const translation = Cesium.Cartesian3.subtract(oben, unten, new Cesium.Cartesian3());
          entry.tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
        }

        // Kein `Cesium3DTileStyle` für die Einfärbung nach Flächentyp: die
        // RLP-Kacheln tragen die Farbe als Vertexfarbe, eine Batch-ID ist dort
        // das *Gebäude*. Ein Style über `surfaceType` fände nichts und würde
        // über seinen `true`-Zweig alles einheitlich übermalen.

        if (entry.credit && this.viewer.creditDisplay && this.viewer.creditDisplay.addStaticCredit) {
          entry._credit = new Cesium.Credit(entry.credit);
          this.viewer.creditDisplay.addStaticCredit(entry._credit);
        }

        // Klick auf ein Gebäude → Eigenschaften aus der Batch Table
        var layerTileset = entry.tileset;
        var layerName = entry.name;
        var self = this;
        var handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
        handler.setInputAction(function (movement) {
          var picked = self.viewer.scene.pick(movement.position);
          if (!(picked instanceof Cesium.Cesium3DTileFeature)) return;
          if (picked.tileset !== layerTileset) return;

          var lies = function (name) {
            var v = picked.getProperty(name);
            return (v === undefined || v === null || v === '' || v === 'undefined') ? null : v;
          };

          var props = {};
          var gmlId  = lies('gml_id');
          var fn     = lies('function');
          var roof   = self.alkisKlartext(lies('roofType'), self.ALKIS_DACHFORM);
          var hoehe  = lies('measuredHeight');
          var geschosse = lies('storeys');
          var name   = lies('name');
          var surf   = lies('surfaceType');   // nur bei Diensten mit Flächen-Batches

          if (gmlId)     props['ALKIS-ID'] = gmlId;
          if (fn)        props['ALKIS-Funktionsschlüssel'] = fn;
          if (roof)      props['Dachform'] = roof;
          if (hoehe)     props['Gebäudehöhe'] = parseFloat(hoehe).toFixed(2) + ' m';
          if (geschosse) props['Geschosse über Grund'] = geschosse;
          if (name)      props['Name'] = name;
          if (surf)      props['Fläche'] = surf;
          props['_Layer'] = layerName + ' Gebäude';

          // Verzögert, damit diese Ausgabe die des allgemeinen IFC-Handlers
          // überschreibt und nicht umgekehrt
          setTimeout(function () {
            if (typeof BimViewer.displayIFCProperties === 'function') {
              BimViewer.displayIFCProperties(props);
            }
          }, 0);
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        entry.clickHandler = handler;

        entry.active = true;
        BimViewer.updateStatus(entry.name + ' eingeblendet', 'success');
      } catch (error) {
        console.error('3D-Ebene nicht ladbar:', error);
        entry.tileset = null;
        BimViewer.updateStatus(entry.name + ' nicht erreichbar', 'error');
      } finally {
        entry.loading = false;
        this.updateTilesetUI();
      }
    },

    disableTileset(id) {
      const entry = this.tilesetLayers.find((t) => t.id === id);
      if (!entry) return;

      if (entry.clickHandler) {
        entry.clickHandler.destroy();
        entry.clickHandler = null;
      }
      if (entry.tileset && this.viewer) {
        this.viewer.scene.primitives.remove(entry.tileset);   // zerstört das Tileset mit
        entry.tileset = null;
      }
      if (entry._credit && this.viewer && this.viewer.creditDisplay.removeStaticCredit) {
        this.viewer.creditDisplay.removeStaticCredit(entry._credit);
        entry._credit = null;
      }
      entry.active = false;
      this.updateTilesetUI();
    },

    /**
     * Die amtlichen Gebäudeebenen als Schalterzeile.
     *
     * Vorher war jede Ebene eine Karte mit Namen, gekürzter URL,
     * Beschreibungszeile und einem Augensymbol — direkt unter zwei
     * gewöhnlichen Schalterzeilen (OSM Buildings, Google 3D Tiles), die
     * dasselbe tun. Drei 3D-Ebenen, zwei Bedienarten. Jetzt sind es drei
     * gleiche Zeilen; die Herkunft steht im `title`, wo sie beim Draufzeigen
     * zu lesen ist, statt dauerhaft Platz zu belegen.
     */
    updateTilesetUI() {
      const container = document.getElementById('tilesetLayersList');
      if (!container) return;
      container.innerHTML = this.tilesetLayers.map((t) => {
        const titel = t.description ? t.description + ' — ' + t.url : t.url;
        return '<div class="row" data-tileset-id="' + t.id + '">' +
          '<span class="row__label" title="' + titel + '">' + t.name +
            (t.loading ? ' <span class="unit">lädt …</span>' : '') +
          '</span>' +
          '<label class="switch">' +
            '<input type="checkbox" data-toggle-tileset="' + t.id + '"' +
              (t.active ? ' checked' : '') + (t.loading ? ' disabled' : '') + '>' +
            '<span class="switch__track"></span>' +
          '</label>' +
        '</div>';
      }).join('');
    },

    getState() {
      return {
        karte: this.aktiveKarte,
        gelaende: this.aktivesGelaende,
        ebenen: this.tilesetLayers.map((t) => ({
          id: t.id,
          name: t.name,
          aktiv: t.active
        }))
      };
    }
  };

  window.LayerManager = LayerManager;
})();
