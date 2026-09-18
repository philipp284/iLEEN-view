/**
 * iLEEN — Viewer-Kern: Szene, Modelle, Darstellung
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `BimViewer` ist der gemeinsame Anker aller Module: der Cesium-Viewer, die
 * geladenen Modelle (`loadedAssets`, Map Schlüssel → assetData) und die
 * Darstellungsschalter. Werkzeuge hängen sich als Eigenschaften an dieses
 * Objekt (`BimViewer.Aufmass`, `BimViewer.Explosion` …) statt eigene Globale
 * anzulegen.
 *
 * assetData:
 *   { id, name, tileset, visible, opacity, type, isPointCloud,
 *     ifcPropertyName, guidPropertyName, jobId, url }
 *   type: '3DTILES' (Cesium ion) | 'BACKEND' (eigener Server)
 *
 * Die Schlüssel der Map sind Zeichenketten: sie wandern durch DOM-Attribute
 * (`onclick="…('${id}')"`) und kämen als Zahl nie wieder an.
 */
'use strict';

// ───────────────────────────────────────────────────────────────────────────
// KONFIGURATION
// ───────────────────────────────────────────────────────────────────────────

const CONFIG = {
  backend: {
    // Quelle: config.js (ILEEN_CONFIG.backendUrl), zur Laufzeit über das
    // Modelle-Panel überschreibbar. Leer → Backend-Teil inaktiv.
    URL: (typeof ILEEN_CONFIG !== 'undefined' && ILEEN_CONFIG.backendUrl) || ''
  },

  camera: {
    // Startansicht: senkrecht über Mitteleuropa. ileen-logo.js legt den
    // Schriftzug genau in diesen Blick.
    DEFAULT_POSITION: {
      longitude: 8.2473,
      latitude: 49.9929,
      height: 10000000,
      heading: 0,
      pitch: -90
    }
  },

  // Darstellungsstufen. `maximumScreenSpaceError` ist der eigentliche Hebel
  // für die Kachelmenge, alles andere sind Bildeffekte.
  performance: {
    presets: {
      PERFORMANCE: {
        name: 'Performance',
        maximumScreenSpaceError: 24,
        memoryUsage: 1024,
        resolutionScale: 0.85,
        shadows: false,
        shadowSize: 1024,
        enableSSAO: false,
        enableFXAA: true,
        enableMSAA: false,
        enableHDR: false
      },
      BALANCED: {
        name: 'Balanced',
        maximumScreenSpaceError: 16,
        memoryUsage: 2048,
        resolutionScale: 1.0,
        shadows: true,
        shadowSize: 2048,
        enableSSAO: false,
        enableFXAA: true,
        enableMSAA: false,
        enableHDR: true
      },
      QUALITY: {
        name: 'Quality',
        maximumScreenSpaceError: 8,
        memoryUsage: 4096,
        resolutionScale: 1.0,
        shadows: true,
        shadowSize: 4096,
        enableSSAO: true,
        ssaoIntensity: 3.0,
        ssaoBias: 0.1,
        enableFXAA: true,
        enableMSAA: false,
        enableHDR: true
      },
      ULTRA: {
        name: 'Ultra',
        maximumScreenSpaceError: 4,
        memoryUsage: 8192,
        resolutionScale: Math.min(2, window.devicePixelRatio || 1),
        shadows: true,
        shadowSize: 4096,
        enableSSAO: true,
        ssaoIntensity: 3.0,
        ssaoBias: 0.1,
        enableFXAA: false,
        enableMSAA: true,
        enableHDR: true
      }
    }
  }
};

// ───────────────────────────────────────────────────────────────────────────
// IFC-TYPEN
//
// Anzeigename, Filterfarbe und Kategorie je IFC-Klasse. Die Liste ist nie
// vollständig — was ein Modell sonst noch führt, meldet der Typ-Scan in
// features.js über ifcTypEinordnen() nach.
// ───────────────────────────────────────────────────────────────────────────

const IFC_ENTITIES = [
  // Tragwerk
  { entity: 'IfcWall', displayName: 'Wand', color: '#B8B4AE', category: 'structure' },
  { entity: 'IfcWallStandardCase', displayName: 'Wand (Standard)', color: '#B8B4AE', category: 'structure' },
  { entity: 'IfcSlab', displayName: 'Decke / Platte', color: '#C9C6C0', category: 'structure' },
  { entity: 'IfcColumn', displayName: 'Stütze', color: '#8E8B86', category: 'structure' },
  { entity: 'IfcBeam', displayName: 'Träger', color: '#7F7C77', category: 'structure' },
  { entity: 'IfcMember', displayName: 'Stab', color: '#8A8F96', category: 'structure' },
  { entity: 'IfcPlate', displayName: 'Blech / Tafel', color: '#D0D3D6', category: 'structure' },
  { entity: 'IfcRoof', displayName: 'Dach', color: '#A0623F', category: 'structure' },
  { entity: 'IfcFooting', displayName: 'Fundament', color: '#6E6A65', category: 'structure' },
  { entity: 'IfcPile', displayName: 'Pfahl', color: '#5F5B56', category: 'structure' },

  // Ausbau
  { entity: 'IfcDoor', displayName: 'Tür', color: '#C7A070', category: 'interior' },
  { entity: 'IfcWindow', displayName: 'Fenster', color: '#8CC3E0', category: 'interior' },
  { entity: 'IfcStair', displayName: 'Treppe', color: '#C0773A', category: 'interior' },
  { entity: 'IfcRamp', displayName: 'Rampe', color: '#C28A55', category: 'interior' },
  { entity: 'IfcRailing', displayName: 'Geländer', color: '#9C9C9C', category: 'interior' },
  { entity: 'IfcCurtainWall', displayName: 'Vorhangfassade', color: '#79B6D6', category: 'interior' },
  { entity: 'IfcCovering', displayName: 'Bekleidung', color: '#D8CBB5', category: 'interior' },
  { entity: 'IfcFurnishingElement', displayName: 'Ausstattung', color: '#A87A4F', category: 'interior' },
  { entity: 'IfcFurniture', displayName: 'Möbel', color: '#A06E44', category: 'interior' },

  // Technische Gebäudeausrüstung
  { entity: 'IfcPipeSegment', displayName: 'Rohr', color: '#3F7FBF', category: 'mep' },
  { entity: 'IfcPipeFitting', displayName: 'Rohrformstück', color: '#4A8FD0', category: 'mep' },
  { entity: 'IfcDuctSegment', displayName: 'Luftkanal', color: '#6FA8C8', category: 'mep' },
  { entity: 'IfcDuctFitting', displayName: 'Kanalformstück', color: '#7DB5D3', category: 'mep' },
  { entity: 'IfcCableSegment', displayName: 'Kabel', color: '#D9A43B', category: 'mep' },
  { entity: 'IfcCableCarrierSegment', displayName: 'Kabeltrasse', color: '#C8963A', category: 'mep' },
  { entity: 'IfcFlowTerminal', displayName: 'Endgerät', color: '#5DA7B8', category: 'mep' },
  { entity: 'IfcLightFixture', displayName: 'Leuchte', color: '#F2D25C', category: 'mep' },
  { entity: 'IfcDistributionElement', displayName: 'Verteilung', color: '#5F8FB0', category: 'mep' },

  // Gebäudestruktur
  { entity: 'IfcSpace', displayName: 'Raum', color: '#D6E6C8', category: 'building' },
  { entity: 'IfcSite', displayName: 'Grundstück', color: '#9DBF7F', category: 'building' },
  { entity: 'IfcBuilding', displayName: 'Gebäude', color: '#CFCFCF', category: 'building' },
  { entity: 'IfcBuildingStorey', displayName: 'Geschoss', color: '#DADADA', category: 'building' },

  // Sonstiges
  { entity: 'IfcBuildingElementProxy', displayName: 'Platzhalter', color: '#B5A6C9', category: 'other' },
  { entity: 'IfcOpeningElement', displayName: 'Öffnung', color: '#FFFFFF', category: 'other' },
  { entity: 'IfcFlowSegment', displayName: 'Flow Segment', color: '#4169E1', category: 'mep' },
  { entity: 'IfcFlowFitting', displayName: 'Flow Fitting', color: '#1E90FF', category: 'mep' },
  { entity: 'IfcFlowController', displayName: 'Flow Controller', color: '#00BFFF', category: 'mep' },
  { entity: 'IfcFlowMovingDevice', displayName: 'Flow Moving Device', color: '#ADD8E6', category: 'mep' },
  { entity: 'IfcFlowStorageDevice', displayName: 'Flow Storage', color: '#4682B4', category: 'mep' },
  { entity: 'IfcDistributionControlElement', displayName: 'Control Element', color: '#FFD700', category: 'mep' },
  { entity: 'IfcDiscreteAccessory', displayName: 'Accessory', color: '#A9A9A9', category: 'parts' },
  { entity: 'IfcFastener', displayName: 'Fastener', color: '#708090', category: 'parts' },
  { entity: 'IfcMechanicalFastener', displayName: 'Mech. Fastener', color: '#778899', category: 'parts' },

  // Teile, Schichten, Bewehrung — die Kategorie 'parts'.
  // IfcBuildingElementPart ist der haeufigste Typ, der in Listen fehlt: eine
  // mehrschichtige Wand aus Revit/ArchiCAD liefert je Schicht ein Part, und
  // ohne Eintrag hier verschwand bei jedem aktiven Filter der halbe Aufbau.
  { entity: 'IfcBuildingElementPart', displayName: 'Bauteilschicht', color: '#9E8B70', category: 'parts' },
  { entity: 'IfcElementAssembly', displayName: 'Baugruppe', color: '#8F7B62', category: 'parts' },
  { entity: 'IfcElementComponent', displayName: 'Bauteilkomponente', color: '#9C9C8A', category: 'parts' },
  { entity: 'IfcReinforcingBar', displayName: 'Bewehrungsstab', color: '#C05A2E', category: 'parts' },
  { entity: 'IfcReinforcingMesh', displayName: 'Bewehrungsmatte', color: '#B4552C', category: 'parts' },
  { entity: 'IfcReinforcingElement', displayName: 'Bewehrung', color: '#A84E28', category: 'parts' },
  { entity: 'IfcTendon', displayName: 'Spannglied', color: '#8C4A2F', category: 'parts' },
  { entity: 'IfcTendonAnchor', displayName: 'Spanngliedverankerung', color: '#7A4028', category: 'parts' },

  // *StandardCase — dieselben Bauteile, andere Klasse. IFC4 schreibt sie so,
  // IFC2x3-Exporte oft nicht; beide muessen in der Liste stehen.
  { entity: 'IfcSlabStandardCase', displayName: 'Slab (Standard)', color: '#C0C0C0', category: 'structure' },
  { entity: 'IfcColumnStandardCase', displayName: 'Column (Standard)', color: '#808080', category: 'structure' },
  { entity: 'IfcBeamStandardCase', displayName: 'Beam (Standard)', color: '#696969', category: 'structure' },
  { entity: 'IfcMemberStandardCase', displayName: 'Member (Standard)', color: '#778899', category: 'structure' },
  { entity: 'IfcPlateStandardCase', displayName: 'Plate (Standard)', color: '#D3D3D3', category: 'structure' },
  { entity: 'IfcDoorStandardCase', displayName: 'Door (Standard)', color: '#DEB887', category: 'interior' },
  { entity: 'IfcWindowStandardCase', displayName: 'Window (Standard)', color: '#87CEEB', category: 'interior' },
  { entity: 'IfcWallElementedCase', displayName: 'Wall (Elemented)', color: '#B0B0B0', category: 'structure' },
  { entity: 'IfcSlabElementedCase', displayName: 'Slab (Elemented)', color: '#C0C0C0', category: 'structure' },

  // Weitere gaengige Bauteiltypen
  { entity: 'IfcStairFlight', displayName: 'Stair Flight', color: '#D2691E', category: 'interior' },
  { entity: 'IfcRampFlight', displayName: 'Ramp Flight', color: '#CD853F', category: 'interior' },
  { entity: 'IfcChimney', displayName: 'Chimney', color: '#8B4513', category: 'structure' },
  { entity: 'IfcShadingDevice', displayName: 'Shading Device', color: '#BDB76B', category: 'interior' },
  { entity: 'IfcSanitaryTerminal', displayName: 'Sanitary Terminal', color: '#B0E0E6', category: 'mep' },
  { entity: 'IfcAirTerminal', displayName: 'Air Terminal', color: '#ADD8E6', category: 'mep' },
  { entity: 'IfcSpaceHeater', displayName: 'Space Heater', color: '#F08080', category: 'mep' },
  { entity: 'IfcTransportElement', displayName: 'Transport Element', color: '#9370DB', category: 'other' },
  { entity: 'IfcSystemFurnitureElement', displayName: 'System Furniture', color: '#A0522D', category: 'other' },
  { entity: 'IfcAnnotation', displayName: 'Annotation', color: '#DDA0DD', category: 'other' },
  { entity: 'IfcVirtualElement', displayName: 'Virtual Element', color: '#E6E6FA', category: 'other' },
  { entity: 'IfcGrid', displayName: 'Grid', color: '#B0C4DE', category: 'building' },
  { entity: 'IfcZone', displayName: 'Zone', color: '#E0E0E0', category: 'building' },
  { entity: 'IfcExternalSpatialElement', displayName: 'External Spatial', color: '#D8F0D8', category: 'building' }
];

// ───────────────────────────────────────────────────────────────────────────
// TYPEN, DIE NICHT IN DER LISTE STEHEN
//
// Die Liste oben ist lang, aber niemals vollstaendig: IFC kennt ueber 700
// Klassen, jeder Exporteur schreibt andere, und Sonderklassen (IfcBoiler,
// IfcPump, IfcTank ...) tauchen erst am konkreten Modell auf. Damit ein
// solcher Typ nicht unsichtbar wird, ordnet ihn diese Heuristik am Namen
// einer Kategorie zu und gibt ihm eine Farbe — er wird dann wie jeder andere
// Typ gelistet, gefaerbt und filterbar.
// ───────────────────────────────────────────────────────────────────────────

const IFC_CATEGORY_BASE_COLOR = {
  structure: '#9A9A9A',
  interior:  '#D9B98C',
  mep:       '#5B9BD5',
  building:  '#CFCFCF',
  parts:     '#9E8B70',
  other:     '#A9A9A9'
};

// Reihenfolge zaehlt: der erste passende Treffer gewinnt, deshalb stehen die
// engeren Muster (Bewehrung, Teile) vor den weiteren (Wall, Flow).
const IFC_CATEGORY_PATTERNS = [
  [/(Reinforc|Tendon|Fastener|Accessory|ElementPart|ElementAssembly|ElementComponent|Anchor)/i, 'parts'],
  [/(Wall|Column|Beam|Slab|Roof|Footing|Pile|Member|Truss|Chimney|Foundation|Structural)/i, 'structure'],
  [/(Door|Window|Stair|Ramp|Railing|CurtainWall|Covering|Furni|Shading|Blind|Partition)/i, 'interior'],
  [/(Pipe|Duct|Cable|Flow|Electric|Sanitary|Air|Boiler|Pump|Valve|Chiller|Coil|Fan|Tank|Filter|Damper|Lamp|Light|Outlet|Sensor|Actuator|Controller|Junction|Motor|Switch|Transformer|Unitary|Waste|Heater|Cooled|Burner|Compressor|Condenser|Evaporator|Humidifier|Stack|Interceptor|Alarm|Protective|Distribution|Energy|Fire|Audio|Communication|Solar|Medical)/i, 'mep'],
  [/(Space|Site|Building|Storey|Zone|Grid|Spatial|Project)/i, 'building']
];

/**
 * Einen unbekannten IFC-Typ einordnen.
 * Liefert {entity, displayName, color, category, entdeckt:true}.
 */
function ifcTypEinordnen(typ) {
  let kategorie = 'other';
  for (const [muster, kat] of IFC_CATEGORY_PATTERNS) {
    if (muster.test(typ)) { kategorie = kat; break; }
  }

  // Die Farbe faechert die Kategorie-Grundfarbe leicht auf, damit sich zwei
  // entdeckte Typen derselben Kategorie im Modell unterscheiden lassen. Der
  // Versatz kommt aus dem Namen, ist also ueber Sitzungen hinweg derselbe.
  let hash = 0;
  for (let i = 0; i < typ.length; i++) hash = (hash * 31 + typ.charCodeAt(i)) & 0xffff;
  const basis = IFC_CATEGORY_BASE_COLOR[kategorie] || '#A9A9A9';
  const kanal = (offset, versatz) => {
    const wert = parseInt(basis.substr(offset, 2), 16) + versatz;
    return Math.max(24, Math.min(238, wert)).toString(16).padStart(2, '0');
  };
  const color = '#' + kanal(1, ((hash & 0x1f) - 16) * 2)
                    + kanal(3, (((hash >> 5) & 0x1f) - 16) * 2)
                    + kanal(5, (((hash >> 10) & 0x1f) - 16) * 2);

  return {
    entity: typ,
    displayName: typ.replace(/^Ifc/, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
    color: color,
    category: kategorie,
    entdeckt: true
  };
}

// ── Ende der IFC-Typenliste ── (tests/filter/test-ifc-filter.js schneidet bis hierher aus)

// ───────────────────────────────────────────────────────────────────────────
// BIMVIEWER
// ───────────────────────────────────────────────────────────────────────────

const BimViewer = {
  viewer: null,
  loadedAssets: new Map(),
  selectedFeature: null,

  googleTiles: {
    tileset: null,
    enabled: false,
    isLoading: false,
    preset: 'balanced'
  },

  googleTilesPresets: {
    performance: { name: 'Speed', maximumScreenSpaceError: 32 },
    balanced: { name: 'Balanced', maximumScreenSpaceError: 16 },
    quality: { name: 'Quality', maximumScreenSpaceError: 6 }
  },

  osmBuildings: {
    tileset: null,
    enabled: false,
    isLoading: false
  },

  ifcFilter: {
    enabledEntities: new Set(),
    allEntities: new Set()
  },

  undergroundMode: {
    enabled: false
  },

  _currentPerformanceSettings: null,

  // ───────────────────────────────────────────────────────────────────
  // LADEOPTIONEN UND SPEICHER
  //
  // Warum das hier steht und nicht als Objektliteral an drei Ladestellen:
  // die drei Stellen (ion, Backend, Backend-per-URL) hatten denselben Satz
  // dreimal abgeschrieben, und zweimal davon fehlte `cacheBytes`.
  //
  // Der fehlende Cache ist kein Schönheitsfehler. Cesium führt neben dem
  // eingestellten `maximumScreenSpaceError` einen zweiten, den
  // `memoryAdjustedScreenSpaceError`: Sobald die geladenen Kacheln
  // `cacheBytes` überschreiten, wird er **je Bild um zwei Prozent erhöht**
  // (`increaseScreenSpaceError` in Cesium3DTileset.js) und fällt erst
  // zurück, wenn der Speicher wieder unter der Grenze liegt. In einer
  // Sekunde sind das Faktor 3, in zweien Faktor 10.
  //
  // Bei den Tilesets dieses Backends hat das eine Folge, die es bei
  // REPLACE-Tilesets nicht gäbe: `refine` steht durchgängig auf ADD
  // (tiling/georef.py), und bei ADD blendet Cesium ein Tile, dessen Fehler
  // unter die Schwelle fällt, **ganz aus** (`meetsScreenSpaceErrorEarly`)
  // — es gibt keine gröbere Fassung davon, die stattdessen einspränge.
  // Genau das ist das Bild „die Außenbauteile großer Projekte verschwinden,
  // obwohl ich nah dran bin": nicht die Entfernung blendet sie aus, sondern
  // der volle Kachelspeicher.
  MESH_CACHE_MB: 2048,
  MESH_OVERFLOW_MB: 512,

  /** Ladeoptionen für ein Mesh-/IFC-Tileset (B3DM). */
  meshLoadOptions() {
    const stufe = this._currentPerformanceSettings || CONFIG.performance.presets.BALANCED;
    return {
      maximumScreenSpaceError: stufe.maximumScreenSpaceError,
      // Der Speicher gehört in die Konstruktoroptionen, nicht in einen
      // Nachtrag: die ersten Kacheln laden, bevor irgendein Nachtrag läuft,
      // und bis dahin gälte Cesiums Vorgabe von 512 MB.
      cacheBytes: (stufe.memoryUsage || this.MESH_CACHE_MB) * 1024 * 1024,
      maximumCacheOverflowBytes: this.MESH_OVERFLOW_MB * 1024 * 1024,
      // `skipLevelOfDetail` und sein Gefolge wirken ausschließlich bei
      // REPLACE-Verfeinerung (`replace &&` in updateVisibility). An einem
      // ADD-Tileset sind sie wirkungslos — und damit irreführend: sie haben
      // hier jahrelang wie eine Einstellung ausgesehen, die etwas tut.
      skipLevelOfDetail: false,
      loadSiblings: true,
      // Bei ADD trägt jeder Knoten eigene Geometrie; die Vereinigung der
      // Kinderhüllen deckt sie nicht ab. Cesium wendet die Abkürzung zwar
      // ohnehin nur bei REPLACE an, aber sie einzuschalten hieße, sich auf
      // diese Einzelheit zu verlassen.
      cullWithChildrenBounds: false
    };
  },

  /**
   * Hält den speicherbedingt hochgezogenen Bildschirmfehler im Blick.
   *
   * Cesium meldet das Hochziehen nur einmal je Sitzung als Konsolenwarnung —
   * und zwar dort, wo niemand hinsieht, während im Bild Bauteile fehlen. Die
   * Wache vergleicht je Sekunde den geführten mit dem eingestellten Wert und
   * hebt den Cache an, statt das Modell löchrig zu lassen: Arbeitsspeicher ist
   * das billigere Gut, und ein Bauantragsmodell, dem die Fassade fehlt, ist
   * nicht bloß unschön.
   */
  _speicherWacheStarten() {
    if (this._speicherWache) return;
    this._speicherWache = setInterval(() => {
      this.loadedAssets.forEach((asset) => {
        const ts = asset.tileset;
        if (!ts || ts._isGaussianSplat) return;
        const gefuehrt = ts.memoryAdjustedScreenSpaceError;
        const gestellt = ts.maximumScreenSpaceError;
        if (!(gefuehrt > gestellt * 1.2)) return;

        // Höchstens viermal verdoppeln — irgendwann ist das Modell wirklich
        // zu groß für die Maschine, und dann ist die gröbere Darstellung die
        // richtige Antwort und nicht noch ein Gigabyte.
        const jetzt = ts.cacheBytes || 0;
        const grenze = this.MESH_CACHE_MB * 1024 * 1024 * 16;
        if (jetzt >= grenze) {
          if (!ts._speicherGemeldet) {
            ts._speicherGemeldet = true;
            this.updateStatus('⚠️ ' + asset.name + ': Kachelspeicher am Anschlag — ' +
                              'die Darstellung bleibt gröber als eingestellt', 'warning');
          }
          return;
        }
        ts.cacheBytes = Math.min(grenze, jetzt * 2 || this.MESH_CACHE_MB * 1024 * 1024);
        console.info('[iLEEN] ' + asset.name + ': Kachelspeicher auf ' +
                     Math.round(ts.cacheBytes / 1048576) + ' MB erhöht (Bildschirmfehler stand bei ' +
                     gefuehrt.toFixed(1) + ' statt ' + gestellt.toFixed(1) + ')');
      });
    }, 1000);
  },


  // ── Zugangsdaten ──────────────────────────────────────────────────────

  ION_TOKEN_STORAGE_KEY: 'ileen_ion_token',

  getIonToken() {
    let gespeichert = null;
    try { gespeichert = localStorage.getItem(this.ION_TOKEN_STORAGE_KEY); } catch (e) { /* privates Fenster */ }
    return gespeichert || (typeof ILEEN_CONFIG !== 'undefined' && ILEEN_CONFIG.ionToken) || '';
  },

  setIonToken(token) {
    const sauber = (token || '').trim();
    try {
      if (sauber) localStorage.setItem(this.ION_TOKEN_STORAGE_KEY, sauber);
      else localStorage.removeItem(this.ION_TOKEN_STORAGE_KEY);
    } catch (e) { /* privates Fenster */ }
    if (typeof Cesium !== 'undefined') Cesium.Ion.defaultAccessToken = sauber;
    return sauber;
  },

  // ── Start ─────────────────────────────────────────────────────────────

  async init() {
    const token = this.getIonToken();
    if (token) Cesium.Ion.defaultAccessToken = token;

    // Ohne ion-Token gibt es weder Weltgelände noch Luftbild. Der Viewer
    // startet dann auf dem Ellipsoid mit OpenStreetMap — Modelle aus dem
    // eigenen Backend lassen sich trotzdem laden und bearbeiten.
    let gelaende;
    try {
      gelaende = token
        ? await Cesium.createWorldTerrainAsync({ requestVertexNormals: true })
        : new Cesium.EllipsoidTerrainProvider();
    } catch (fehler) {
      console.warn('Weltgelände nicht verfügbar, weiter ohne Gelände:', fehler.message);
      gelaende = new Cesium.EllipsoidTerrainProvider();
    }

    const grundkarte = token
      ? Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2))
      : new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }));

    this.viewer = new Cesium.Viewer('cesiumContainer', {
      terrainProvider: gelaende,
      baseLayer: grundkarte,
      baseLayerPicker: false,
      geocoder: !!token,
      homeButton: true,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: true,
      infoBox: false,
      selectionIndicator: false,
      shadows: true,
      msaaSamples: 4,
      // Ohne erhaltenen Zeichenpuffer liefert `canvas.toDataURL()` ein leeres
      // Bild — BCF-Schnappschüsse, Berichte und die Browser-Prüfsteine lesen
      // die Pixel aus.
      contextOptions: {
        webgl: {
          preserveDrawingBuffer: true
        }
      }
    });

    const viewer = this.viewer;
    const scene = viewer.scene;
    if (viewer.imageryLayers.length) viewer.imageryLayers.get(0)._ileenGrundkarte = true;

    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.enableLighting = true;
    scene.highDynamicRange = true;
    scene.fog.enabled = true;
    scene.postProcessStages.fxaa.enabled = true;
    viewer.shadowMap.softShadows = true;
    viewer.shadowMap.size = 2048;
    viewer.shadowMap.darkness = 0.45;

    // Home-Knopf führt zur Startansicht, nicht zu Cesiums Weltansicht
    if (viewer.homeButton) {
      viewer.homeButton.viewModel.command.beforeExecute.addEventListener((ereignis) => {
        ereignis.cancel = true;
        this.initCamera(2.0);
      });
    }

    if (window.Views && typeof window.Views.init === 'function') {
      try { window.Views.init(this); } catch (e) { console.warn('Views.init failed', e); }
    }

    this.initCamera();
    if (typeof this.initZOffset === 'function') this.initZOffset();
    if (typeof this.initRotation === 'function') this.initRotation();
    if (typeof this.initTranslation === 'function') this.initTranslation();

    // Initialize Walk Mode
    if (typeof WalkMode !== 'undefined') {
      WalkMode.init(this.viewer);
      console.log('✅ Walk Mode initialized');
    }

    if (window.LayerManager) {
      try { LayerManager.init(viewer); } catch (e) { console.warn('LayerManager.init failed', e); }
    }

    this.initLighting();
    this._speicherWacheStarten();
    // initPointCloudSettings() ruft index.html, nachdem die Darstellungsstufe
    // steht — hier wäre es einmal zu früh und einmal zu viel.
    this.updateStatus(token ? 'iLEEN bereit' : 'iLEEN bereit — ohne ion-Token (kein Gelände, keine ion-Assets)',
                      token ? 'success' : 'warning');
  },

  initCamera(dauer) {
    const p = CONFIG.camera.DEFAULT_POSITION;
    const ziel = {
      destination: Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, p.height),
      orientation: {
        heading: Cesium.Math.toRadians(p.heading),
        pitch: Cesium.Math.toRadians(p.pitch),
        roll: 0
      }
    };
    if (dauer) this.viewer.camera.flyTo(Object.assign({ duration: dauer }, ziel));
    else this.viewer.camera.setView(ziel);
  },

  // ── Rückmeldung ───────────────────────────────────────────────────────

  /** Kurze Meldung unten rechts. `art`: success | error | warning | info | loading */
  updateStatus(text, art = 'info') {
    const el = document.getElementById('statusIndicator');
    if (!el) { console.log('[Status]', text); return; }
    el.textContent = text;
    el.className = 'status-indicator status-indicator--' + art;
    el.style.display = 'block';
    clearTimeout(this._statusTimer);
    if (art !== 'loading') {
      this._statusTimer = setTimeout(() => { el.style.display = 'none'; }, art === 'error' ? 6000 : 3500);
    }
  },

  /** Hinweisbalken oben für Modi, die den Klick umdeuten. */
  updateModeIndicator() {
    const hide = document.getElementById('hideModeIndicator');
    if (hide) hide.classList.toggle('active', !!(this.hiddenFeatures && this.hiddenFeatures.isHideMode));
  },

  _asset(assetId) {
    if (assetId === undefined || assetId === null) return null;
    return this.loadedAssets.get(String(assetId)) ||
      Array.from(this.loadedAssets.values()).find((a) => String(a.id) === String(assetId)) || null;
  },

  // ── Cesium ion ────────────────────────────────────────────────────────

  /** Die Assets des ion-Kontos (Name, ID, Typ). */
  async fetchAvailableAssets() {
    const token = this.getIonToken();
    if (!token) return [];
    const antwort = await fetch('https://api.cesium.com/v1/assets?limit=200', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!antwort.ok) throw new Error('ion /v1/assets: HTTP ' + antwort.status);
    const daten = await antwort.json();
    return daten.items || [];
  },

  async loadSelectedAsset(assetId, assetName) {
    const schluessel = String(assetId);
    if (this.loadedAssets.has(schluessel)) {
      this.updateStatus('⚠️ Bereits geladen: ' + this.loadedAssets.get(schluessel).name, 'warning');
      return;
    }

    try {
      this.updateStatus('Lade ion-Asset ' + assetId + ' …', 'loading');

      // Splat-Erkennung VOR Load: Asset-IDs die als Gaussian Splats bekannt sind.
      // (extensionsUsed ist erst nach Load verfügbar, daher hier explizite Liste.)
      const KNOWN_SPLAT_ASSETS = new Set([4587934, 4574084]);
      const isSplatTileset = KNOWN_SPLAT_ASSETS.has(Number(assetId));

      // Splat-Tilesets: Minimallader (NICHTS außer fromIonAssetId).
      // fromUrl mit Optionen + nachträgliches Patchen erzeugt Spike-Artefakte.
      const tileset = isSplatTileset
        ? await Cesium.Cesium3DTileset.fromIonAssetId(assetId)
        : await Cesium.Cesium3DTileset.fromUrl(await Cesium.IonResource.fromAssetId(assetId),
                                                this.meshLoadOptions());

      if (isSplatTileset) {
        tileset._isGaussianSplat = true;
        console.log(`✨ Asset ${assetId}: Gaussian Splat — minimal loader (no LOD overrides)`);
      }

      this.viewer.scene.primitives.add(tileset);

      // Splat-Tilesets: KEINE Beleuchtungs- oder Darstellungseingriffe.
      // Splats bringen ihre eigene Spherical-Harmonics-Beleuchtung mit;
      // Schatten drüberzulegen erzeugt Render-Artefakte.
      if (!tileset._isGaussianSplat) {
        this.enableTilesetLighting(tileset);
        this.applyBackFaceCulling(tileset);
        if (this._currentPerformanceSettings) this.applySettingsToTileset(tileset, this._currentPerformanceSettings);
      }

      const assetData = {
        id: Number(assetId),
        name: assetName || ('ion ' + assetId),
        tileset: tileset,
        visible: true,
        opacity: 1.0,
        type: '3DTILES',
        isPointCloud: this.isPointCloudTileset ? this.isPointCloudTileset(tileset) : false
      };
      this.loadedAssets.set(schluessel, assetData);
      this._nachDemLaden(schluessel, assetData);
      await this.cinematicFlyToTileset(tileset, 5.0);
      this.updateStatus('✅ Geladen: ' + assetData.name, 'success');
    } catch (error) {
      console.error('ion-Asset nicht ladbar:', error);
      this.updateStatus('❌ ion-Asset ' + assetId + ' nicht ladbar', 'error');
    }
  },

  /** Was nach jedem Laden gleich abläuft: Oberfläche, Punktwolke, IFC-Merkmal. */
  _nachDemLaden(schluessel, assetData) {
    if (assetData.isPointCloud && typeof this.applyPointCloudSettings === 'function') {
      this.applyPointCloudSettings(assetData.tileset);
    }
    if (window.BimViewerUI && typeof BimViewerUI.createAssetControls === 'function') {
      BimViewerUI.createAssetControls(schluessel);
    }
    if (!this.googleTiles.enabled) this.viewer.scene.globe.show = true;

    // IFC-Property erkennen, dann Filter anwenden. Verzögert, weil die
    // Kacheln erst eintreffen müssen, bevor ein Merkmal zu sehen ist.
    if (!assetData.isPointCloud && !assetData.tileset._isGaussianSplat &&
        typeof this.detectIFCProperties === 'function') {
      setTimeout(async () => {
        try {
          const detectedProp = await this.detectIFCProperties(assetData.tileset);
          if (detectedProp) {
            assetData.ifcPropertyName = detectedProp;
            console.log(`📋 ${assetData.name}: IFC property = "${detectedProp}"`);
          }
          if (typeof this.applyIFCFilter === 'function') await this.applyIFCFilter();
        } catch (e) {
          console.error('❌ IFC detection failed for ' + assetData.name, e);
        }
      }, 1500);
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // SELF-HOSTED BACKEND ASSETS (backend/ — FastAPI + MinIO)
  // ─────────────────────────────────────────────────────────────────

  // Backend-URL: config.js liefert den Default, das Assets-Panel kann ihn zur
  // Laufzeit überschreiben (localStorage), damit zwischen lokalem Server und
  // Produktion gewechselt werden kann, ohne config.js anzufassen.
  BACKEND_URL_STORAGE_KEY: 'ileen_backend_url',

  getBackendUrl() {
    let stored = null;
    try {
      stored = localStorage.getItem(this.BACKEND_URL_STORAGE_KEY);
    } catch (e) {
      // localStorage kann in privaten Fenstern blockiert sein — dann Default nutzen
    }
    return (stored || CONFIG.backend.URL || '').replace(/\/+$/, '');
  },

  setBackendUrl(url) {
    const clean = (url || '').trim().replace(/\/+$/, '');
    try {
      if (clean) localStorage.setItem(this.BACKEND_URL_STORAGE_KEY, clean);
      else localStorage.removeItem(this.BACKEND_URL_STORAGE_KEY);
    } catch (e) {
      console.warn('Backend-URL konnte nicht gespeichert werden:', e);
    }
    return clean;
  },

  async fetchBackendAssets() {
    const baseUrl = this.getBackendUrl();
    if (!baseUrl) return [];
    try {
      const response = await fetch(`${baseUrl}/assets/`);
      if (!response.ok) throw new Error(`Backend /assets/ returned ${response.status}`);
      const data = await response.json();
      return data.assets || data || [];
    } catch (error) {
      console.error('Failed to fetch backend assets:', error);
      return [];
    }
  },

  // Gaussian-Splat-Erkennung VOR dem eigentlichen fromUrl()-Load. Bei Ion-Assets
  // steht dafür eine feste ID-Liste bereit (KNOWN_SPLAT_ASSETS); Backend-Jobs haben
  // keine solche Liste, also wird die kleine tileset.json vorab separat geholt
  // (derselbe Request, den Cesium ohnehin gleich danach stellt) und auf
  // KHR_gaussian_splatting geprüft — dieselbe Regex wie in isPointCloudTileset().
  // Schlägt der Fetch fehl, wird konservativ "kein Splat" angenommen.
  //
  // Geprüft wird an ZWEI Stellen, nicht nur `json.extensionsUsed`: 3D Tiles 1.1
  // meldet glTF-Extensions, die der Tile-*Inhalt* braucht, nicht als Extension
  // des Tilesets selbst, sondern verschachtelt unter der 3DTILES_content_gltf-
  // Erweiterung (siehe `tiling/georef.py:build_tileset()` im Backend). Ein
  // Splat-Tileset von dort hat also `extensionsUsed: ["3DTILES_content_gltf"]`
  // auf oberster Ebene — eine rein oberflächliche Prüfung fände darin nie
  // "gaussian_splatting" und schaltete den aggressiven LOD-Loader scharf, der
  // bei Splats Schlieren-Artefakte erzeugt.
  //
  // Dieselbe Vorabprüfung erkennt zusätzlich Punktwolken (py3dtiles benennt
  // den Root-Content immer "preview.pnts"). Grund: der aggressive Mesh-Loader
  // (baseScreenSpaceError 1024, cullWithChildrenBounds, skipLevels …) ist
  // gegen B3DM-Octrees getuned und lässt ein PNTS-Tileset komplett leer
  // bleiben — die Kacheln laden laut Netzwerk-Tab korrekt (200 OK), es wird
  // nur nie etwas gerendert. Punktwolken bekommen deshalb denselben
  // Minimal-Loader wie Splats.
  async detectTilesetKind(tilesetUrl) {
    try {
      const response = await fetch(tilesetUrl);
      if (!response.ok) return { isSplat: false, isPointCloud: false };
      const json = await response.json();
      const topLevel = json.extensionsUsed || [];
      const nested = json.extensions?.['3DTILES_content_gltf']?.extensionsUsed || [];
      const exts = [...topLevel, ...nested];
      const isSplat = exts.some((e) => /gaussian_splatting/i.test(e));

      const contentUri = (json.root?.content?.uri || json.root?.content?.url || '').toLowerCase();
      const isPointCloud = !isSplat && contentUri.endsWith('.pnts');

      return { isSplat, isPointCloud };
    } catch (e) {
      console.warn('Tileset-Vorabprüfung fehlgeschlagen, behandle als Mesh:', e.message);
      return { isSplat: false, isPointCloud: false };
    }
  },

  /** Lädt ein Tileset mit dem Lader, der zu seiner Art passt. */
  async _backendTilesetLaden(tilesetUrl) {
    const { isSplat: isSplatTileset, isPointCloud: isPointCloudPre } = await this.detectTilesetKind(tilesetUrl);

    // Splat-Tilesets: NUR fromUrl ohne Optionen. Die aggressiven
    // LOD-Skip-Optionen erzeugen bei Gaussian Splats Spike-Artefakte — grobe
    // Octree-Knoten mit großskalierten Splats bleiben sichtbar stehen,
    // während feinere Kind-Tiles nachladen.
    //
    // Punktwolken bekommen denselben Minimal-Loader (siehe detectTilesetKind()):
    // derselbe aggressive Optionssatz lässt ein PNTS-Tileset komplett leer
    // bleiben, obwohl die Kacheln laut Netzwerk-Tab korrekt laden.
    const tileset = isSplatTileset
      ? await Cesium.Cesium3DTileset.fromUrl(tilesetUrl)
      : isPointCloudPre
      ? await Cesium.Cesium3DTileset.fromUrl(tilesetUrl,
          typeof this.pointCloudLoadOptions === 'function'
            ? this.pointCloudLoadOptions() : { maximumScreenSpaceError: 16 })
      : await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, this.meshLoadOptions());

    if (isSplatTileset) tileset._isGaussianSplat = true;
    return { tileset, isSplatTileset, isPointCloudPre };
  },

  async loadBackendAsset(jobId, assetName = null) {
    const baseUrl = this.getBackendUrl();
    if (!baseUrl) {
      this.updateStatus('❌ Backend-URL nicht konfiguriert (config.js → backendUrl)', 'error');
      return;
    }

    const assetKey = `backend_${jobId}`;
    if (this.loadedAssets.has(assetKey)) {
      this.updateStatus('⚠️ Backend asset already loaded', 'warning');
      return;
    }

    const tilesetUrl = `${baseUrl}/tiles/${jobId}/tileset.json`;

    try {
      this.updateStatus(`Loading backend asset ${jobId}...`, 'loading');

      const { tileset, isSplatTileset, isPointCloudPre } = await this._backendTilesetLaden(tilesetUrl);
      if (isSplatTileset) {
        console.log(`✨ Backend asset ${jobId}: Gaussian Splat — minimal loader (no LOD overrides)`);
      } else if (isPointCloudPre) {
        console.log(`☁️ Backend asset ${jobId}: Punktwolke — minimal loader (no LOD overrides)`);
      }

      if (tileset.tileFailed) {
        tileset.tileFailed.addEventListener((error) => {
          console.warn(`⚠️ Backend tile failed for ${jobId}:`, error);
        });
      }

      this.viewer.scene.primitives.add(tileset);

      // Splat-Tilesets bringen eigene Spherical-Harmonics-Beleuchtung mit;
      // Schatten und Darstellungsstufen drüberzulegen erzeugt Render-Artefakte.
      if (!tileset._isGaussianSplat) {
        this.enableTilesetLighting(tileset);
        this.applyBackFaceCulling(tileset);
        if (this._currentPerformanceSettings && !isPointCloudPre) {
          this.applySettingsToTileset(tileset, this._currentPerformanceSettings);
        }
      }

      const assetData = {
        id: assetKey,
        name: assetName || `Backend: ${jobId}`,
        tileset: tileset,
        url: tilesetUrl,
        visible: true,
        opacity: 1.0,
        type: 'BACKEND',
        jobId: jobId,
        isPointCloud: isPointCloudPre || (!!this.isPointCloudTileset && this.isPointCloudTileset(tileset))
      };
      this.loadedAssets.set(assetKey, assetData);

      // Geländebezug aus dem Asset-Manager gegen das Terrain des Viewers
      // auflösen — muss vor dem Kameraflug laufen, sonst zielt der auf die
      // noch unverschobene Position (siehe terrain-align.js).
      if (window.ILeenTerrainAlign) await ILeenTerrainAlign.alignAsset(assetData);

      this._nachDemLaden(assetKey, assetData);
      await this.cinematicFlyToTileset(tileset, 5.0);

      this.updateStatus(`✅ Backend asset loaded: ${assetData.name}`, 'success');
    } catch (error) {
      console.error(`Failed to load backend asset ${jobId}:`, error);
      this.updateStatus(`❌ Failed to load backend asset: ${jobId}`, 'error');
    }
  },

  // Schlüssel eines per URL geladenen Tilesets. Er muss die **ganze** URL
  // abbilden: sechzehn Base64-Zeichen einer URL kodieren genau zwölf Bytes —
  // bei jedem Backend-Tileset also "http://local". Damit bekämen alle
  // URL-Assets denselben Schlüssel, und ab der zweiten Ergebniswolke bräche
  // das Laden mit "Asset already loaded" ab, obwohl es eine ganz andere Wolke
  // ist: Geschoss und Ergebnisfeld stehen erst am Ende der URL
  // (/tragwerk/<lauf>/wolke/<geschoss>/<feld>/tileset.json).
  //
  // Der Schlüssel landet in DOM-IDs (`asset_<key>`) und CSS-Selektoren, darf
  // also nur [a-z0-9_] enthalten — deshalb ein Hash statt der URL selbst.
  // FNV-1a über die vollständige URL, die Länge zusätzlich angehängt.
  _urlAssetKey(tilesetUrl) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < tilesetUrl.length; i++) {
      hash ^= tilesetUrl.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `backend_url_${hash.toString(36)}_${tilesetUrl.length.toString(36)}`;
  },

  async loadBackendAssetByUrl(tilesetUrl, assetName = null) {
    const assetKey = this._urlAssetKey(tilesetUrl);
    const vorhanden = this.loadedAssets.get(assetKey);
    if (vorhanden) {
      // Jetzt trifft das nur noch dieselbe URL — dann liegt das Asset wirklich
      // schon in der Szene, und der Name sagt, welches.
      this.updateStatus(`⚠️ Bereits geladen: ${vorhanden.name}`, 'warning');
      return assetKey;
    }
    try {
      this.updateStatus(`Loading from URL...`, 'loading');

      const { tileset, isSplatTileset, isPointCloudPre } = await this._backendTilesetLaden(tilesetUrl);
      if (isSplatTileset) {
        console.log('✨ Backend-URL asset: Gaussian Splat — minimal loader (no LOD overrides)');
      } else if (isPointCloudPre) {
        console.log('☁️ Backend-URL asset: Punktwolke — minimal loader (no LOD overrides)');
      }

      this.viewer.scene.primitives.add(tileset);

      if (!tileset._isGaussianSplat) {
        this.enableTilesetLighting(tileset);
        this.applyBackFaceCulling(tileset);
        if (this._currentPerformanceSettings && !isPointCloudPre) {
          this.applySettingsToTileset(tileset, this._currentPerformanceSettings);
        }
      }

      const assetData = {
        id: assetKey,
        name: assetName || tilesetUrl.split('/').slice(-2).join('/'),
        tileset: tileset,
        url: tilesetUrl,
        visible: true,
        opacity: 1.0,
        type: 'BACKEND',
        isPointCloud: isPointCloudPre || (!!this.isPointCloudTileset && this.isPointCloudTileset(tileset))
      };
      this.loadedAssets.set(assetKey, assetData);

      // Siehe loadBackendAsset() — Geländebezug vor dem Kameraflug auflösen.
      if (window.ILeenTerrainAlign) await ILeenTerrainAlign.alignAsset(assetData);

      this._nachDemLaden(assetKey, assetData);
      await this.cinematicFlyToTileset(tileset, 5.0);

      this.updateStatus(`✅ Loaded: ${assetData.name}`, 'success');
      return assetKey;
    } catch (error) {
      console.error('Failed to load tileset from URL:', error);
      this.updateStatus(`❌ Failed to load: ${tilesetUrl}`, 'error');
      return null;
    }
  },

  // ── Modelle verwalten ─────────────────────────────────────────────────

  unloadAsset(assetId) {
    const assetData = this._asset(assetId);
    if (!assetData) return;
    const schluessel = Array.from(this.loadedAssets.entries()).find(([, a]) => a === assetData)[0];

    if (this.sequencing && this.sequencing.activeAssetId === schluessel &&
        typeof this.deactivateSequencing === 'function') {
      this.deactivateSequencing();
    }
    if (window.BimViewerUI && BimViewerUI._transformAssetId === String(schluessel)) {
      BimViewerUI.closeAssetTransform();
    }
    if (this.selectedFeature && assetData.tileset && this.selectedFeature.tileset === assetData.tileset) {
      this.selectedFeature = null;
      if (typeof this.closeInfoBox === 'function') this.closeInfoBox();
    }

    if (assetData.tileset && this.viewer) {
      // `remove` zerstört das Tileset mit (primitives.destroyPrimitives)
      this.viewer.scene.primitives.remove(assetData.tileset);
    }
    this.loadedAssets.delete(schluessel);

    const zeile = document.getElementById('asset_' + schluessel);
    if (zeile) zeile.remove();
    if (window.BimViewerUI && typeof BimViewerUI.updateLoadedAssetsCount === 'function') {
      BimViewerUI.updateLoadedAssetsCount();
    }
    this.updateStatus('Entfernt: ' + assetData.name, 'info');
  },

  _disableWalkAndFly() {
    if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled()) {
      WalkMode.toggle(false);
    }
  },

  // Kinematischer Flug zu einem Tileset:
  // 1) kurzer Vorflug in aktuelle Blickrichtung (leicht angehoben)
  // 2) Bogen auf das Ziel mit flachem End-Pitch (~ -25°)
  async cinematicFlyToTileset(tileset, totalDuration = 5.0) {
    if (!tileset || !this.viewer) return;
    this._disableWalkAndFly();
    try {
      const sphere = tileset.boundingSphere;
      if (!sphere) { await this.viewer.flyTo(tileset, { duration: totalDuration }); return; }

      const camera = this.viewer.camera;
      const startPos = camera.positionWC.clone();
      const dir = camera.directionWC.clone();
      const up = camera.upWC.clone();

      const targetCenter = sphere.center;
      const distToTarget = Cesium.Cartesian3.distance(startPos, targetCenter);

      // Vorwärts-Wegpunkt: ~25 % der Distanz in Blickrichtung, leicht nach oben gehoben
      const forwardFrac = 0.25;
      const forward = Cesium.Cartesian3.multiplyByScalar(dir, distToTarget * forwardFrac, new Cesium.Cartesian3());
      const lift = Cesium.Cartesian3.multiplyByScalar(up, distToTarget * 0.08, new Cesium.Cartesian3());
      const waypoint = Cesium.Cartesian3.add(startPos, forward, new Cesium.Cartesian3());
      Cesium.Cartesian3.add(waypoint, lift, waypoint);

      const phase1 = totalDuration * 0.35;
      const phase2 = totalDuration - phase1;

      await new Promise((resolve) => {
        camera.flyTo({
          destination: waypoint,
          orientation: { direction: dir, up: up },
          duration: phase1,
          easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          complete: resolve,
          cancel: resolve
        });
      });

      // Anflug-Pitch flach (~ -25°), Range etwas größer als sphere.radius für Übersicht
      const range = Math.max(sphere.radius * 2.5, 50);
      await new Promise((resolve) => {
        camera.flyToBoundingSphere(sphere, {
          duration: phase2,
          offset: new Cesium.HeadingPitchRange(camera.heading, Cesium.Math.toRadians(-25), range),
          easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
          complete: resolve,
          cancel: resolve
        });
      });
    } catch (err) {
      console.warn('cinematicFlyToTileset fallback:', err);
      try { await this.viewer.flyTo(tileset, { duration: totalDuration }); } catch (_) {}
    }
  },

  zoomToAsset(assetId) {
    this._disableWalkAndFly();
    const assetData = this._asset(assetId);
    if (!assetData || !assetData.tileset) return;
    this.viewer.flyTo(assetData.tileset, { duration: 2.0 });
  },

  toggleAssetVisibility(assetId) {
    const assetData = this._asset(assetId);
    if (!assetData || !assetData.tileset) return;
    assetData.visible = !assetData.visible;
    assetData.tileset.show = assetData.visible;
    const schalter = document.querySelector(`#asset_${assetData.id} .asset-visibility input`);
    if (schalter) schalter.checked = assetData.visible;
  },

  updateAssetOpacity(assetId, wert) {
    const assetData = this._asset(assetId);
    if (!assetData || !assetData.tileset) return;
    assetData.opacity = Math.max(0, Math.min(1, parseFloat(wert)));
    // Mit IFC-Merkmal trägt der Filterstil die Deckkraft (eine Farbe je Typ);
    // ohne gibt es genau eine Farbe für alles.
    if (assetData.ifcPropertyName && typeof this.applyIFCFilter === 'function') {
      this.applyIFCFilter();
    } else if (assetData.isPointCloud && typeof this.applyColorMode === 'function') {
      this.applyColorMode(assetData.tileset, this.pointCloudSettings.colorMode);
    } else if (!assetData.tileset._isGaussianSplat) {
      assetData.tileset.style = new Cesium.Cesium3DTileStyle({
        color: `color('white', ${assetData.opacity})`
      });
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // NAVIGATION & WALK / FLY MODE
  // ─────────────────────────────────────────────────────────────────

  // Geschwindigkeits-Labels für HUD-Feedback
  // Stufe 0 (Index -1) ist keine feste Zahl, sondern die Rampe aus WalkMode.
  _walkSpeedLabels: ['1 m/s', '3 m/s', '7 m/s', '20 m/s', '60 m/s', '200 m/s'],

  // Wird von WalkMode aufgerufen wenn Speed-Stufe per Tastatur geändert wird
  onWalkSpeedChanged(lvl, val) {
    this._syncWalkSpeedButtons(lvl, val);
  },

  // Wird von WalkMode aufgerufen wenn ESC gedrückt
  onWalkModeExited() {
    this._walkRestoreGlobe();
    this._syncWalkModeButtons(false, WalkMode.getMode());
    const controls = document.getElementById('walkModeControls');
    if (controls) controls.style.display = 'none';
  },

  // Gespeicherter Globe-Zustand vor Walk/Fly-Aktivierung
  _walkGlobeSavedState: null,

  // Stellt sicher dass der Globe sichtbar (aber ggf. transparent) ist,
  // damit globe.pick() und globe.getHeight() im Walk-Mode funktionieren.
  // Wenn Globe vorher wegen Google 3D Tiles ausgeblendet war → transparent einblenden.
  _walkEnsureGlobePickable() {
    const globe = this.viewer.scene.globe;
    const wasHidden = !globe.show;
    this._walkGlobeSavedState = {
      show: globe.show,
      translucencyEnabled: globe.translucency.enabled,
      frontFaceAlpha: globe.translucency.frontFaceAlpha,
      backFaceAlpha:  globe.translucency.backFaceAlpha,
    };
    if (wasHidden) {
      // Globe einschalten aber vollständig transparent → unsichtbar aber pickbar
      globe.show = true;
      globe.translucency.enabled = true;
      globe.translucency.frontFaceAlpha = 0.0;
      globe.translucency.backFaceAlpha  = 0.0;
    }
  },

  // Stellt den Globe-Zustand von vor dem Walk/Fly-Mode wieder her.
  _walkRestoreGlobe() {
    if (!this._walkGlobeSavedState) return;
    const globe = this.viewer.scene.globe;
    const s = this._walkGlobeSavedState;
    globe.show = s.show;
    globe.translucency.enabled    = s.translucencyEnabled;
    globe.translucency.frontFaceAlpha = s.frontFaceAlpha;
    globe.translucency.backFaceAlpha  = s.backFaceAlpha;
    this._walkGlobeSavedState = null;
  },

  toggleWalkMode(requestedMode) {
    if (typeof WalkMode === 'undefined') return;

    const targetMode = requestedMode || 'walk';
    const wasEnabled = WalkMode.isEnabled();
    const currentMode = WalkMode.getMode();

    if (wasEnabled && currentMode === targetMode) {
      // Gleicher Modus aktiv → deaktivieren
      WalkMode.toggle(false);
      this._walkRestoreGlobe();
      this._syncWalkModeButtons(false, targetMode);
      const controls = document.getElementById('walkModeControls');
      if (controls) controls.style.display = 'none';
      this.updateStatus('Navigation beendet', 'info');
      return false;
    }

    // Anderer Modus aktiv → erst sauber deaktivieren, damit _enable()
    // beim neuen Modus garantiert frisch läuft (Snap, Pointer-Lock,
    // Heading/Pitch). Sonst hängt v.a. bei Gaussian Splats die Kamera
    // gelegentlich im Orbit, weil enable() früh returnt.
    if (wasEnabled && currentMode !== targetMode) {
      WalkMode.toggle(false);
    }

    // Modus setzen
    WalkMode.setMode(targetMode);

    // Globe pickbar machen bevor WalkMode startet
    this._walkEnsureGlobePickable();

    const isEnabled = WalkMode.toggle(true);

    this._syncWalkModeButtons(isEnabled, targetMode);

    const controls = document.getElementById('walkModeControls');
    if (controls) controls.style.display = isEnabled ? 'block' : 'none';

    // Walk-only: Augenhöhe-Gruppe anzeigen/ausblenden
    const hGroup = document.getElementById('walkHeightGroup');
    if (hGroup) hGroup.style.display = targetMode === 'walk' ? 'block' : 'none';

    this.updateStatus(`${targetMode === 'fly' ? 'Fly' : 'Walk'} Mode ${isEnabled ? 'aktiv' : 'beendet'}`, isEnabled ? 'success' : 'info');
    return isEnabled;
  },

  _syncWalkModeButtons(active, mode) {
    const walkBtn = document.getElementById('toggleWalkMode');
    const flyBtn  = document.getElementById('toggleFlyMode');
    if (walkBtn) walkBtn.classList.toggle('active', active && mode === 'walk');
    if (flyBtn) flyBtn.classList.toggle('active', active && mode === 'fly');
  },

  setWalkHeight(h) {
    if (typeof WalkMode === 'undefined') return;
    const v = parseFloat(h);
    WalkMode.setHeight(v);
    const el = document.getElementById('walkHeightValue');
    if (el) el.textContent = v.toFixed(1) + ' m';
    const sl = document.getElementById('walkHeightSlider');
    if (sl && sl.value !== String(v)) sl.value = v;
  },

  setWalkZOffset(z) {
    if (typeof WalkMode === 'undefined') return;
    const v = parseFloat(z);
    WalkMode.setZOffset(v);
    const el = document.getElementById('walkZOffsetValue');
    if (el) el.textContent = (v >= 0 ? '+' : '') + v.toFixed(1) + ' m';
    const sl = document.getElementById('walkZOffsetSlider');
    if (sl && sl.value !== String(v)) sl.value = v;
  },

  setWalkSpeedLevel(lvl) {
    if (typeof WalkMode === 'undefined') return;
    WalkMode.setSpeedLevel(lvl);
    this._syncWalkSpeedButtons(lvl, WalkMode.getSpeedValue());
  },

  _syncWalkSpeedButtons(lvl, val) {
    const ramp = document.getElementById('walkSpeedBtnRamp');
    if (ramp) ramp.classList.toggle('active', lvl === -1);
    for (let i = 0; i < 6; i++) {
      const btn = document.getElementById(`walkSpeedBtn${i}`);
      if (btn) btn.classList.toggle('active', i === lvl);
    }
    const el = document.getElementById('walkSpeedValue');
    // Stufe 0 meldet gebrochene Werte — Formatierung kommt aus WalkMode.
    if (el) el.textContent = (typeof WalkMode !== 'undefined' && WalkMode.formatSpeed)
      ? WalkMode.formatSpeed(val)
      : val + ' m/s';
  },

  setWalkSpeed(s) {
    if (typeof WalkMode !== 'undefined') WalkMode.setSpeed(s);
  },

  toggleEyeLevel(useDefault) {
    if (typeof WalkMode !== 'undefined') {
      WalkMode.setEyeLevel(useDefault);
      if (useDefault) this.setWalkHeight(1.8);
      const slider = document.getElementById('walkHeightSlider');
      if (slider) {
        slider.disabled = useDefault;
        slider.parentElement.style.opacity = useDefault ? '0.5' : '1';
      }
    }
  },

  toggleVR() {
    if (!this.viewer) return;
    // Cesiums eigener VR-Knopf kennt den Weg in den WebXR-Modus; er steht
    // versteckt im Viewer und wird hier nur ausgelöst.
    const vrBtn = this.viewer.container.querySelector('.cesium-vrButton');
    if (vrBtn) {
      vrBtn.click();
    } else {
      this.updateStatus('VR Mode not available', 'warning');
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // DARSTELLUNG
  // ─────────────────────────────────────────────────────────────────

  applySettingsToTileset(tileset, einstellungen) {
    // Gaussian-Splat-Tilesets reagieren empfindlich auf aggressive LOD-Settings
    // (Performance-Presets würden sonst Spike-Artefakte erzeugen)
    if (!tileset || !einstellungen || tileset._isGaussianSplat) return;
    try {
      tileset.maximumScreenSpaceError = einstellungen.maximumScreenSpaceError;
      if ('cacheBytes' in tileset) {
        // Nur anheben, nie senken: die Speicherwache hat womöglich schon
        // nachgelegt, weil dem Modell sonst Bauteile fehlen. Ein Wechsel der
        // Darstellungsstufe ist kein Grund, das wieder einzukassieren.
        const gewuenscht = einstellungen.memoryUsage * 1024 * 1024;
        if (gewuenscht > (tileset.cacheBytes || 0)) tileset.cacheBytes = gewuenscht;
      }
      if ('maximumCacheOverflowBytes' in tileset) {
        tileset.maximumCacheOverflowBytes = this.MESH_OVERFLOW_MB * 1024 * 1024;
      }
      tileset.shadows = einstellungen.shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
    } catch (e) {
      console.warn('Darstellungsstufe nicht anwendbar:', e.message);
    }
  },

  applyPerformanceSettings(einstellungen) {
    if (!this.viewer || !einstellungen) return;
    this._currentPerformanceSettings = einstellungen;
    const viewer = this.viewer;
    const scene = viewer.scene;

    scene.highDynamicRange = !!einstellungen.enableHDR;
    scene.postProcessStages.fxaa.enabled = !!einstellungen.enableFXAA;
    if ('msaaSamples' in scene) scene.msaaSamples = einstellungen.enableMSAA ? 4 : 1;
    viewer.resolutionScale = einstellungen.resolutionScale || 1.0;

    viewer.shadows = !!einstellungen.shadows;
    viewer.shadowMap.enabled = !!einstellungen.shadows;
    viewer.shadowMap.size = einstellungen.shadowSize || 2048;

    const ao = scene.postProcessStages.ambientOcclusion;
    if (ao && Cesium.PostProcessStageLibrary.isAmbientOcclusionSupported(scene)) {
      ao.enabled = !!einstellungen.enableSSAO;
      if (einstellungen.enableSSAO) {
        ao.uniforms.intensity = einstellungen.ssaoIntensity || 3.0;
        ao.uniforms.bias = einstellungen.ssaoBias || 0.1;
      }
      const aoSchalter = document.getElementById('toggleAO');
      if (aoSchalter) aoSchalter.checked = ao.enabled;
    }

    this.loadedAssets.forEach((asset) => {
      if (asset.tileset && !asset.isPointCloud) this.applySettingsToTileset(asset.tileset, einstellungen);
    });
    if (this.osmBuildings.tileset) this.applySettingsToTileset(this.osmBuildings.tileset, einstellungen);
    scene.requestRender();
  },

  toggleTileBoundingBoxes() {
    this._showTileBoundingBoxes = !this._showTileBoundingBoxes;
    const show = this._showTileBoundingBoxes;
    const primitives = this.viewer.scene.primitives;
    for (let i = 0; i < primitives.length; i++) {
      const prim = primitives.get(i);
      if (prim instanceof Cesium.Cesium3DTileset) {
        prim.debugShowBoundingVolume = show;
      }
    }
    return show;
  },

  setFieldOfView(degrees) {
    if (!this.viewer) return;
    const frustum = this.viewer.camera.frustum;
    if (!frustum || typeof frustum.fov === 'undefined') return;
    const clamped = Math.max(20, Math.min(120, degrees));
    frustum.fov = Cesium.Math.toRadians(clamped);
    const label = Math.round(clamped) + '°';
    // Sync all FOV controls (Settings tab + View tab)
    [['fovSlider', 'fovValue'], ['viewFovSlider', 'viewFovValue']].forEach(([sliderId, valId]) => {
      const s = document.getElementById(sliderId);
      const v = document.getElementById(valId);
      if (s) s.value = clamped;
      if (v) v.textContent = label;
    });
  },

  setGlobeTransparency(alpha) {
    const globe = this.viewer.scene.globe;
    const a = Math.max(0, Math.min(1, parseFloat(alpha)));
    globe.translucency.enabled = a < 1;
    globe.translucency.frontFaceAlpha = a;
    globe.translucency.backFaceAlpha = a;
  },

  toggleGlobeTransparency(an) {
    const slider = document.getElementById('globeAlphaSlider');
    this.setGlobeTransparency(an ? (slider ? slider.value : 0.5) : 1);
  },

  /**
   * Untergrund-Modus: die Kamera darf unter die Oberfläche. Die Arbeit steht
   * seit v0.5 in untergrund.js — das Gelände bleibt deckend, verdeckt die
   * Modelle aber nicht (depthTestAgainstTerrain aus), eine Nullebene markiert
   * die Geländeoberkante.
   *
   * Bis v0.4 schaltete diese Stelle `globe.translucency` auf 0,35: das ganze
   * Gelände wurde halbdurchsichtig, und von unten war nicht mehr zu erkennen,
   * wo die Oberfläche liegt — genau das, wofür man hinuntersteigt.
   */
  toggleUndergroundView(an) {
    const zustand = typeof an === 'boolean' ? an : !this.undergroundMode.enabled;
    if (this.Untergrund) {
      if (zustand) this.Untergrund.an(); else this.Untergrund.aus();
      this.undergroundMode.enabled = this.Untergrund.istAn();
    } else {
      // Rückfall ohne Modul: nur die Kamera durchlassen, das Gelände in Ruhe.
      this.undergroundMode.enabled = zustand;
      this.viewer.scene.screenSpaceCameraController.enableCollisionDetection = !zustand;
    }
    const schalter = document.getElementById('toggleUndergroundView');
    if (schalter) schalter.checked = zustand;
    this.updateStatus(zustand ? 'Untergrund-Modus an' : 'Untergrund-Modus aus', 'info');
  },

  // ── Weltkulisse: OSM-Gebäude und Google 3D Tiles ──────────────────────

  async toggleOSMBuildings(an) {
    const zustand = typeof an === 'boolean' ? an : !this.osmBuildings.enabled;
    const osm = this.osmBuildings;
    if (!zustand) {
      if (osm.tileset) osm.tileset.show = false;
      osm.enabled = false;
      return;
    }
    if (osm.tileset) {
      osm.tileset.show = true;
      osm.enabled = true;
      return;
    }
    if (osm.isLoading || !this.getIonToken()) return;
    osm.isLoading = true;
    try {
      osm.tileset = await Cesium.createOsmBuildingsAsync();
      this.viewer.scene.primitives.add(osm.tileset);
      if (this._currentPerformanceSettings) this.applySettingsToTileset(osm.tileset, this._currentPerformanceSettings);
      osm.enabled = true;
    } catch (fehler) {
      console.warn('OSM Buildings nicht verfügbar:', fehler.message);
      this.updateStatus('OSM Buildings nicht verfügbar', 'error');
    } finally {
      osm.isLoading = false;
      const schalter = document.getElementById('toggleOSMBuildings');
      if (schalter) schalter.checked = osm.enabled;
    }
  },

  async toggleGoogle3DTiles() {
    const g = this.googleTiles;
    if (g.isLoading) return;
    const scene = this.viewer.scene;

    if (g.enabled) {
      if (g.tileset) g.tileset.show = false;
      g.enabled = false;
      scene.globe.show = true;
      if (this.osmBuildings.tileset && this.osmBuildings.enabled) this.osmBuildings.tileset.show = true;
      return;
    }

    if (!this.getIonToken()) {
      this.updateStatus('Google 3D Tiles brauchen einen ion-Token', 'warning');
      return;
    }

    g.isLoading = true;
    try {
      if (!g.tileset) {
        this.updateStatus('Google 3D Tiles werden geladen …', 'loading');
        g.tileset = await Cesium.createGooglePhotorealistic3DTileset();
        scene.primitives.add(g.tileset);
      }
      g.tileset.show = true;
      g.tileset.maximumScreenSpaceError = this.googleTilesPresets[g.preset].maximumScreenSpaceError;
      // Die fotorealistischen Kacheln bringen ihr Gelände mit; der Globus
      // darunter stünde als zweite Oberfläche im Bild.
      scene.globe.show = false;
      if (this.osmBuildings.tileset) this.osmBuildings.tileset.show = false;
      g.enabled = true;
      this.updateStatus('Google 3D Tiles an', 'success');
    } catch (fehler) {
      console.error('Google 3D Tiles nicht verfügbar:', fehler);
      this.updateStatus('Google 3D Tiles nicht verfügbar', 'error');
    } finally {
      g.isLoading = false;
    }
  },

  setGoogleTilesQuality(preset) {
    const stufe = this.googleTilesPresets[preset];
    if (!stufe) return;
    this.googleTiles.preset = preset;
    if (this.googleTiles.tileset) this.googleTiles.tileset.maximumScreenSpaceError = stufe.maximumScreenSpaceError;
    document.querySelectorAll('.google-tiles-preset-btn').forEach((knopf) => {
      knopf.classList.toggle('active', knopf.dataset.preset === preset);
    });
  },

  /**
   * Umlaufsinn eines Polygons aus Cartesian3-Punkten, im Grundriss
   * (Länge/Breite). google-tiles-mask.js braucht Polygone gegen den
   * Uhrzeigersinn für die Ausschnittsebene.
   */
  isCounterClockwise(punkte) {
    if (!punkte || punkte.length < 3) return true;
    let flaeche = 0;
    const karto = punkte.map((p) => Cesium.Cartographic.fromCartesian(p));
    for (let i = 0; i < karto.length; i++) {
      const a = karto[i];
      const b = karto[(i + 1) % karto.length];
      flaeche += (b.longitude - a.longitude) * (b.latitude + a.latitude);
    }
    return flaeche < 0;
  },

  // ── Beleuchtung ───────────────────────────────────────────────────────

  initLighting() {
    this.lighting = { stunde: null, schatten: true };
    this.viewer.clock.shouldAnimate = false;
    this.viewer.clock.currentTime = Cesium.JulianDate.now();
  },

  /** Sonnenstand über die Uhrzeit (0–24, Ortszeit des Rechners), heutiges Datum. */
  setLightingTime(stunde) {
    if (!this.viewer) return;
    const h = Math.max(0, Math.min(24, parseFloat(stunde)));
    const datum = new Date();
    datum.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
    this.viewer.clock.currentTime = Cesium.JulianDate.fromDate(datum);
    this.lighting.stunde = h;
    this.viewer.scene.requestRender();
  },

  setShadows(an) {
    if (!this.viewer) return;
    this.viewer.shadows = !!an;
    this.viewer.shadowMap.enabled = !!an;
    this.lighting.schatten = !!an;
  },

  /** Schatten für ein Tileset einschalten (explosion.js ruft das für Klone). */
  enableTilesetLighting(tileset) {
    if (!tileset || tileset._isGaussianSplat) return;
    tileset.shadows = Cesium.ShadowMode.ENABLED;
  },

  // ── Rückseiten ────────────────────────────────────────────────────────

  // IFC/Revit-to-glTF-Exporter markieren dünne Wände und Decken oft als
  // doubleSided, damit die Geometrie von beiden Seiten sichtbar bleibt; das
  // erzeugt Z-Fighting, wo zwei doppelseitige Dreiecke übereinanderliegen.
  // `tileset.backFaceCulling` allein hilft nicht — es wirkt nur auf
  // Materialien, die ohnehin einseitig sind —, deshalb verwirft zusätzlich
  // der Shader rückwärtige Fragmente.
  //
  // `ordnung: 0` — der Verwurf steht am Anfang jedes Verbunds. Alles, was
  // ein anderer Baustein an einem rückwärtigen Fragment rechnete, wäre sonst
  // Arbeit für ein Fragment, das gleich darauf verworfen wird.
  _rueckseitenBaustein: {
    ordnung: 0,
    fragment: /* glsl */ `
        if (czm_backFacing()) {
          discard;
        }
    `
  },

  // Rückfall für den Fall, dass shader-verbund.js nicht geladen ist.
  _backFaceCullingShader: null,
  _getBackFaceCullingShader() {
    if (this._backFaceCullingShader) return this._backFaceCullingShader;
    this._backFaceCullingShader = new Cesium.CustomShader({
      fragmentShaderText: /* glsl */ `
        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
          if (czm_backFacing()) {
            discard;
          }
        }
      `,
      mode: Cesium.CustomShaderMode.MODIFY_MATERIAL
    });
    return this._backFaceCullingShader;
  },

  // One-sided rendering for a BIM/IFC tileset (only the outward-facing
  // normal side is drawn). Skips Gaussian splats, which have no back faces.
  //
  // Geht über den Shader-Verbund: die Explosion und die Bildprojektion
  // wollen denselben Steckplatz, und wer ihn allein belegt, schaltet den
  // anderen still ab.
  applyBackFaceCulling(tileset) {
    if (!tileset || tileset._isGaussianSplat) return;
    try {
      tileset.backFaceCulling = true;
      if (BimViewer.ShaderVerbund) {
        BimViewer.ShaderVerbund.setzen(tileset, 'rueckseite', this._rueckseitenBaustein);
      } else {
        tileset.customShader = this._getBackFaceCullingShader();
      }
    } catch (error) {
      console.warn('Could not apply back-face culling to tileset:', error.message);
    }
  },

  /**
   * Nimmt den Rückseitenschnitt zurück, ohne den übrigen Verbund zu räumen.
   *
   * Für section-box.js: „Rückseiten zeigen" heißt, genau diesen einen
   * Baustein abzumelden — eine laufende Explosion oder eine Bildprojektion
   * bleiben dabei stehen.
   */
  removeBackFaceCulling(tileset) {
    if (!tileset) return;
    try {
      tileset.backFaceCulling = false;
      if (BimViewer.ShaderVerbund) BimViewer.ShaderVerbund.entfernen(tileset, 'rueckseite');
      else tileset.customShader = undefined;
    } catch (error) {
      console.warn('Could not remove back-face culling:', error.message);
    }
  }
};

// Globale Anker. `const` auf oberster Ebene eines klassischen Skripts landet
// nicht auf `window`; Module prüfen aber `window.BimViewer`.
window.CONFIG = CONFIG;
window.IFC_ENTITIES = IFC_ENTITIES;
window.ifcTypEinordnen = ifcTypEinordnen;
window.BimViewer = BimViewer;
