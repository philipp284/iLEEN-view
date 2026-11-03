/**
 * iLEEN — Karte, Gelände und 3D-Ebenen unter dem Modell
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Drei Fragen, drei Listen: welche Karte liegt auf dem Globus, welches
 * Gelände trägt sie, und welche amtliche Gebäudekulisse steht darauf. Das
 * Panel dazu baut ui.js (`getLayerManagerContent`); diese Datei füllt dessen
 * Behälter `#basemapList`, `#terrainList` und `#tilesetLayersList`.
 *
 * Keine der drei Listen braucht Cesium ion. Woher die Quellen kommen, steht
 * in kartenquellen.js (Karten, Gebäude, Suche) und gelaende.js (Gelände).
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
    // Seit Oktober 2026 steht hier LoD2 Deutschland aus basemap.de 3D — die
    // LoD2-Gebäude aller Länder als ein Dienst, Ersatz für OSM Buildings aus
    // Cesium ion. Der Eintrag kommt aus kartenquellen.js (`lod2Deutschland()`)
    // und wird in `init()` angehängt.
    //
    // Bis September 2026 stand hier die selbst gerechnete LoD2-Kachel von
    // Mainz (`data/rlp-lod2/`, erzeugt mit `backend/scripts/citygml2tiles.py`).
    // Sie deckte zwei Quadratkilometer ab und ist herausgenommen; die
    // Maschinerie bleibt: `enableTileset()` lädt jedes 3D-Tiles-Gebäudeset,
    // `ALKIS_DACHFORM` übersetzt die Dachform, und der Klick liest die
    // Eigenschaften. Ein weiterer Datensatz ist ein Eintrag hier:
    //
    //   { id: 'rlp-lod2', name: 'RLP LoD2', nameEN: 'RLP LoD2 Buildings',
    //     description: 'Gebäudemodelle Rheinland-Pfalz (CityGML, Open Data)',
    //     url: 'data/rlp-lod2/tileset.json', tileset: null,
    //     active: false, loading: false, heightOffset: 0,
    //     credit: 'Landesamt für Vermessung und Geobasisinformation '
    //           + 'Rheinland-Pfalz — dl-de/by-2-0' }
    //
    // Höhenbezug: `heightOffset: 0`, wenn die Kacheln schon auf dem Ellipsoid
    // stehen (citygml2tiles.py rechnet die Undulation ein). Ein Dienst mit
    // Normalhöhen bekommt `hoehenbezug: 'nhn'` — dann führt
    // `ILeenKarten.geoidNachfuehren()` die Undulation am Blickpunkt nach. Ein
    // pauschaler `heightOffset` in Metern bleibt für Dienste mit festem Versatz.
    tilesetLayers: [],

    // ── Start ──────────────────────────────────────────────────────────

    /**
     * Listen füllen und die Grundkarte legen. Gibt das Versprechen der
     * Grundkarte zurück, damit core.js erst danach „bereit" meldet.
     */
    init(viewer) {
      this.viewer = viewer;
      const K = window.ILeenKarten;

      this.basemaps = K ? K.grundkarten() : [
        { id: 'osm', name: 'OpenStreetMap',
          laden: async () => [{ anbieter: new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }) }] },
        { id: 'none', name: 'Keine Karte', laden: async () => [] }
      ];

      // Das Gelände vom Start wird weiterverwendet: es hat seinen Bestand
      // schon gelesen, ein Wechsel zurück soll nicht erneut beim BKG fragen.
      const start = viewer.terrainProvider;
      const eigenes = window.ILeenGelaende && start instanceof window.ILeenGelaende.Provider ? start : null;
      this._gelaende = eigenes;
      this.terrains = [
        { id: 'gelaende', name: 'DGM5 Deutschland, sonst Terrain Tiles',
          laden: async () => this._gelaende || (this._gelaende = await window.ILeenGelaende.erzeugen()) },
        { id: 'ellipsoid', name: 'Ohne Gelände (Ellipsoid)',
          laden: async () => new Cesium.EllipsoidTerrainProvider() }
      ];
      this.aktivesGelaende = eigenes ? 'gelaende' : 'ellipsoid';

      if (K && !this.tilesetLayers.some((t) => t.id === 'lod2-de')) {
        this.tilesetLayers.unshift(K.lod2Deutschland());
      }

      this.aktiveKarte = null;
      this.populateUI();
      return this.switchBasemap(this.basemaps[0].id);
    },

    // ── Karte ──────────────────────────────────────────────────────────

    async switchBasemap(id) {
      const K = window.ILeenKarten;
      id = (K && K.KARTE_FRUEHER[id]) || id;   // Zustände aus der ion-Zeit
      const ziel = this.basemaps.find((b) => b.id === id);
      if (!ziel || !this.viewer) return;
      const ebenen = this.viewer.imageryLayers;
      try {
        // Erst laden, dann tauschen: scheitert Google, bleibt die alte Karte stehen
        const teile = await ziel.laden();
        for (let i = ebenen.length - 1; i >= 0; i--) {
          const ebene = ebenen.get(i);
          if (ebene._ileenGrundkarte) ebenen.remove(ebene, true);
        }
        // Die Grundkarte ist immer unten; Überlagerungen darüber bleiben
        // unberührt. Eine Grundkarte kann aus mehreren Ebenen bestehen
        // (Luftbild: Sentinel-2 und die DOP der Länder darüber).
        teile.forEach((teil, i) => {
          const ebene = new Cesium.ImageryLayer(teil.anbieter, teil.optionen || {});
          ebene._ileenGrundkarte = true;
          ebenen.add(ebene, i);
        });
        this.aktiveKarte = id;
        this.updateBasemapUI();
        this.viewer.scene.requestRender();
        // Google-Satellit kommt aus dem EWR nur über ion — das soll man sehen
        const hinweis = teile.map((teil) => teil.hinweis).find(Boolean);
        if (hinweis) BimViewer.updateStatus(ziel.name + ' ' + hinweis, 'info');
      } catch (fehler) {
        console.error('Karte nicht verfügbar:', fehler);
        BimViewer.updateStatus(fehler && /Google/.test(fehler.message) ? fehler.message : ziel.name + ' nicht verfügbar',
                               'error');
      }
    },

    // ── Gelände ────────────────────────────────────────────────────────

    async switchTerrain(id) {
      const K = window.ILeenKarten;
      id = (K && K.GELAENDE_FRUEHER[id]) || id;
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
      const ohneSchluessel = !(window.ILeenKarten && ILeenKarten.googleKey());
      return liste.map((eintrag) =>
        '<label class="row layer-choice"' +
          (eintrag.google && ohneSchluessel ? ' title="Braucht einen Google-Schlüssel (Einstellungen › Kartendienste)"' : '') + '>' +
          '<span class="row__label">' + eintrag.name +
            (eintrag.google && ohneSchluessel ? ' <span class="unit">Schlüssel fehlt</span>' : '') + '</span>' +
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

    /** `surface` aus basemap.de 3D in Klartext. */
    FLAECHE: { roof: 'Dach', wall: 'Wand', bridge: 'Brücke' },

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

        // Unter Google 3D Tiles stünde dasselbe Haus zweimal im Bild
        const sichtbar = () => !(BimViewer.googleTiles && BimViewer.googleTiles.enabled);

        // NHN → Ellipsoid. `hoehenbezug: 'nhn'` (basemap.de): die Undulation
        // wird am Blickpunkt nachgeführt — über Deutschland ändert sie sich um
        // mehr als zehn Meter, ein fester Wert stimmte nur an einer Stelle.
        // `heightOffset` bleibt für Dienste mit festem Versatz; die selbst
        // erzeugte RLP-Ebene bringt den Bezug schon im `root.transform` mit.
        if (entry.hoehenbezug === 'nhn' && window.ILeenKarten) {
          entry._geoidAb = ILeenKarten.geoidNachfuehren(this.viewer, entry.tileset, sichtbar);
        } else if (entry.heightOffset) {
          const mitte = Cesium.Cartographic.fromCartesian(entry.tileset.boundingSphere.center);
          const unten = Cesium.Cartesian3.fromRadians(mitte.longitude, mitte.latitude, 0);
          const oben = Cesium.Cartesian3.fromRadians(mitte.longitude, mitte.latitude, entry.heightOffset);
          const translation = Cesium.Cartesian3.subtract(oben, unten, new Cesium.Cartesian3());
          entry.tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
        }

        if (entry.hoehenbezug !== 'nhn') entry.tileset.show = sichtbar();

        // Ein Stil nur, wo der Eintrag einen mitbringt. Die RLP-Kacheln tragen
        // ihre Farbe als Vertexfarbe, eine Batch-ID ist dort das *Gebäude*;
        // ein Stil über die Fläche fände nichts und übermalte über seinen
        // `true`-Zweig alles einheitlich. basemap.de führt `surface` je Fläche.
        if (entry.stil) entry.tileset.style = new Cesium.Cesium3DTileStyle(entry.stil);
        // Gebäude, die der Bauplaner aus LoD2 übernommen hat, weichen dem geplanten Haus (bauplaner-lod2.js)
        if (entry.id === 'lod2-de' && window.BauplanerLod2) BauplanerLod2.ausblendenAnwenden();
        if (BimViewer._currentPerformanceSettings && BimViewer.applySettingsToTileset) {
          BimViewer.applySettingsToTileset(entry.tileset, BimViewer._currentPerformanceSettings);
        }

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
          // Während der Bauplaner ein Gebäude aus LoD2 übernimmt, ist der Klick eine Auswahl, keine Abfrage
          if (window.BauplanerLod2 && BauplanerLod2.waehlt()) return;

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
          var surf   = lies('surfaceType') || self.FLAECHE[lies('surface')] || lies('surface');

          if (gmlId)     props[entry.hoehenbezug === 'nhn' ? 'Gebäude-ID' : 'ALKIS-ID'] = gmlId;
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
      if (entry._geoidAb) {
        entry._geoidAb();
        entry._geoidAb = null;
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
