/**
 * iLEEN — Sprachumschaltung (Deutsch / Englisch)
 *
 * Ein Wörterbuch, zwei Zugriffswege:
 *
 *   1. Im JavaScript:  `t('panel.models')`
 *   2. Im Markup:      `<span data-i18n="panel.models"></span>`
 *
 * Beim Sprachwechsel läuft `apply()` über alle `data-i18n`-Knoten im Dokument
 * und ersetzt deren Text. Panels, die ihren Inhalt selbst erzeugen, hören
 * stattdessen auf das Ereignis `ileen:language-changed` und zeichnen neu.
 *
 * Fehlt ein Schlüssel, wird der Schlüssel selbst ausgegeben — auffällig genug,
 * um beim Testen sofort zu sehen, was fehlt, aber ohne die Oberfläche zu
 * zerlegen. Fehlt nur die englische Fassung, greift die deutsche.
 *
 * Standard ist Deutsch: die Anwendung entsteht im deutschsprachigen
 * BIM-Umfeld, und die IFC-Terminologie (Bauteil, Geschoss, Bauherr) ist dort
 * die fachlich richtige.
 */
'use strict';

const ILeenI18n = (() => {

  const STORAGE_KEY = 'ileen_language';
  const DEFAULT_LANGUAGE = 'de';
  const LANGUAGES = ['de', 'en'];

  let current = DEFAULT_LANGUAGE;

  const DICT = {
    de: {
      // ── Panels / Navigation ────────────────────────────────────────────
      'panel.models': 'Asset Browser',
      'panel.models.hint': 'Modelle aus Cesium Ion und dem Modell-Browser laden',
      'panel.view': 'Ansicht',
      'panel.view.hint': 'Kamera, Beleuchtung, Vergleichsansicht',
      'panel.ifc': 'Bauteile',
      'panel.ifc.hint': 'Filtern, isolieren, Eigenschaften',
      'panel.tools': 'Werkzeuge',
      'panel.tools.hint': 'Messen, Schnitte, Notizen',
      'panel.analysis': 'Analyse',
      'panel.analysis.hint': 'Verschattung, Kollisionen, Auswertungen',
      'panel.settings': 'Einstellungen',
      'panel.help': 'Hilfe',

      // ── Untergruppen ───────────────────────────────────────────────────
      'group.ionAssets': 'Cesium Ion',
      'group.backend': 'Modell-Browser',
      'group.layers': 'Layer',
      'group.pointcloud': 'Punktwolken',
      'group.camera': 'Kamera & Ansichten',
      'group.lighting': 'Beleuchtung',
      'group.split': 'Vergleichsansicht',
      'group.filter': 'Filter',
      'group.rooms': 'Räume & Nutzung',
      'group.properties': 'Eigenschaften',
      'group.measure': 'Messen',
      'group.clipping': 'Schnitte',
      'group.tags': 'Notizen & Prüfung',
      'group.solar': 'Verschattung',
      'group.clash': 'Kollisionsprüfung',
      'group.quality': 'Darstellung',
      'group.language': 'Sprache',
      'group.terrain': 'Gelände',

      // ── Allgemeine Aktionen ────────────────────────────────────────────
      'action.load': 'Laden',
      'action.save': 'Speichern',
      'action.cancel': 'Abbrechen',
      'action.close': 'Schließen',
      'action.reset': 'Zurücksetzen',
      'action.apply': 'Anwenden',
      'action.delete': 'Löschen',
      'action.remove': 'Entfernen',
      'action.import': 'Importieren',
      'action.export': 'Exportieren',
      'action.start': 'Starten',
      'action.stop': 'Beenden',
      'action.refresh': 'Neu laden',
      'action.showAll': 'Alle anzeigen',
      'action.hideAll': 'Alle ausblenden',
      'action.flyTo': 'Hinfliegen',
      'action.isolate': 'Isolieren',
      'action.copy': 'Kopieren',

      // ── Zustände ───────────────────────────────────────────────────────
      'state.on': 'An',
      'state.off': 'Aus',
      'state.loading': 'Lädt…',
      'state.empty': 'Nichts vorhanden',
      'state.error': 'Fehler',
      'state.none': 'Keine',
      'state.yes': 'Ja',
      'state.no': 'Nein',

      // ── Eigenschaften / Rollen ─────────────────────────────────────────
      'props.title': 'Eigenschaften',
      'props.noSelection': 'Kein Bauteil ausgewählt. Klicke ein Element im Modell an.',
      'props.loadingDetails': 'Lade vollständige Eigenschaften…',
      'props.moreProperties': 'Weitere Eigenschaften',
      'props.allProperties': 'Alle Eigenschaften',
      'props.showRaw': 'Rohdaten anzeigen',
      'props.noData': 'Für dieses Bauteil liegen keine Eigenschaften vor.',
      'props.fromModel': 'Aus dem Modell',
      'props.fromBackend': 'Aus der Bauteildatenbank',
      'props.copied': 'In die Zwischenablage kopiert',

      'role.architect': 'Architektur',
      'role.engineer': 'Tragwerk',
      'role.sitemanager': 'Bauleitung',
      'role.fm': 'Betrieb & Wartung',
      'role.surveyor': 'Vermessung',
      'role.hint.architect': 'Entwurf, Aufbau, Bauphysik',
      'role.hint.engineer': 'Tragverhalten, Querschnitte, Lasten',
      'role.hint.sitemanager': 'Mengen, Termine, Ausführung',
      'role.hint.fm': 'Anlagen, Wartung, Kosten',
      'role.hint.surveyor': 'Lage, Höhe, Maße',

      // ── Eigenschaftsgruppen ────────────────────────────────────────────
      'pgroup.identity': 'Kennzeichnung',
      'pgroup.dimensions': 'Abmessungen',
      'pgroup.buildup': 'Aufbau & Material',
      'pgroup.physics': 'Bauphysik',
      'pgroup.openings': 'Öffnungen & Verglasung',
      'pgroup.structure': 'Tragverhalten',
      'pgroup.section': 'Querschnitt & Profil',
      'pgroup.loads': 'Lasten',
      'pgroup.reinforcement': 'Bewehrung',
      'pgroup.quantities': 'Mengen',
      'pgroup.schedule': 'Termine & Phasen',
      'pgroup.status': 'Status & Freigabe',
      'pgroup.supplier': 'Hersteller & Lieferung',
      'pgroup.asset': 'Anlagenkennung',
      'pgroup.maintenance': 'Wartung & Lebensdauer',
      'pgroup.operation': 'Betrieb & Anschlusswerte',
      'pgroup.classification': 'Klassifizierung & Kosten',
      'pgroup.location': 'Lage & Höhe',
      'pgroup.tolerance': 'Genauigkeit',

      // ── Gelände ────────────────────────────────────────────────────────
      'terrain.align': 'Modelle auf Gelände ausrichten',
      'terrain.alignHint':
        'Gleicht die im Backend gesetzte Höhe „über Gelände" gegen das Terrain ' +
        'dieses Viewers ab. Ohne diese Korrektur schwebt oder versinkt das Modell ' +
        'um die Differenz der beiden Geländemodelle.',
      'terrain.alignNow': 'Jetzt ausrichten',
      'terrain.aligned': 'Ausgerichtet: {delta} m',
      'terrain.notAligned': 'Nicht ausgerichtet',

      // ── Annotationen (annotations.js) ──────────────────────────────────
      'anno.section': 'Beschriftungen im Modell',
      'anno.show': 'Beschriftungen anzeigen',
      'anno.onlyOpen': 'Nur unerledigte',
      'anno.distance': 'Sichtbar bis',
      'anno.reset': 'Verschobene Beschriftungen zurücksetzen',
      'anno.hint':
        'Jede Notiz bekommt einen Punkt im Modell und eine Beschriftung daneben. ' +
        'Die Beschriftung lässt sich verschieben, ihre Lage bleibt gespeichert. ' +
        'Überdecken sich zwei, klappt die weiter entfernte auf ihren Punkt ' +
        'zusammen und öffnet sich beim Überfahren. Umschalten mit ⇧A.',
      'anno.untitled': 'Ohne Titel',
      'anno.status.open': 'offen',
      'anno.status.in_progress': 'in Arbeit',
      'anno.status.closed': 'erledigt',
      'anno.confirmDelete': 'Notiz „{title}" wirklich löschen?',

      // ── Werkzeuge, Modelle, Notizen (Panel-Umbau 2026-08) ──────────────
      'panel.tags': 'Notizen',
      'panel.tags.hint': 'Notizen und Prüfung am Modell',
      'group.loaded': 'Geladene Modelle',
      'underground.mode': 'Untergrund-Modus',
      'underground.zeroLevel': 'Nullebene zeigen',
      'underground.seeThrough': 'Durchblick über Modellen',
      'underground.hint':
        'Kamera darf unter das Gelände — für Keller, Gründung und Baugruben. '
        + 'Das Gelände bleibt deckend; mit Durchblick verdeckt es die Modelle '
        + 'nicht. Ein Raster (10 m / 50 m) markiert die Oberkante.',
      'group.session': 'Sitzung',

      'state.noAssets': 'Noch kein Modell geladen',

      // ── Panel-Aufräumen 2026-08 ────────────────────────────────────────
      'models.ionField': 'Asset aus dem Ion-Konto oder Asset-ID',
      'models.ionPlaceholder': 'Name wählen oder ID eintippen',
      'models.ionReady': '{n} Assets im Konto — Name wählen oder ID eintippen',
      'models.ionFailed': 'Ion-Konto nicht erreichbar — Asset-ID trotzdem eintippbar',
      'models.ionInvalid': 'Keine gültige Ion-Asset-ID erkannt',
      'models.glb': 'Lokale GLB-Modelle',

      // ── Revit-Filter ───────────────────────────────────────────────────
      'revit.hint': 'Revit-Kategorien gibt es nur bei Modellen aus Cesium Ion: die .rvt-Datei zuerst dort hochladen und tilen lassen (ion.cesium.com), dann oben unter „Modelle → Cesium Ion" per Name oder Asset-ID laden. Diese Liste färbt und filtert danach automatisch nach Revit-Kategorie.',
      'revit.selectAll': 'Alle',
      'revit.deselectAll': 'Keine',
      'models.glbPick': 'GLB-Modell wählen …',
      'models.backendUrl': 'Adresse des Modellservers',
      'models.backendOffline': 'Nicht verbunden',
      'models.backendJob': 'Job-ID oder tileset.json-URL',
      'models.backendJobPlaceholder': 'Job-ID oder URL',
      'models.search': 'Name suchen …',
      'models.filterAll': 'Alle',
      'models.type.ifc': 'IFC',
      'models.type.mesh': 'Mesh',
      'models.type.pointcloud': 'Punktwolke',
      'models.type.splat': 'Splat',
      'models.type.unknown': 'Sonstiges',

      'layer.basemap': 'Karte',
      'layer.tiles3d': '3D-Ebenen',
      'layer.terrain': 'Gelände',
      'layer.geoid': 'Geoid-Gelände',
      'layer.bathymetry': 'Bathymetrie',
      'layer.vector': 'Vektorkarte',
      'layer.vectorHint': 'Amtliche Vektorkacheln (basemap.de, BKG) direkt auf dem '
        + 'Gelände — scharf in jeder Zoomstufe, jedes Objekt anklickbar.',
      'vector.drape': 'Auflegen auf',
      'vector.drapeTerrain': 'Gelände',
      'vector.drapeAll': 'Gelände und Modelle',
      'vector.buildings': 'Gebäudeumrisse',
      'vector.traffic': 'Verkehr',
      'vector.water': 'Gewässer',
      'vector.borders': 'Grenzen',
      'vector.loading': 'lädt …',

      'pc.presets': 'Voreinstellungen',
      'pc.colorMode': 'Farbmodus',
      'pc.edl': 'Eye-Dome-Lighting',
      'pc.appearance': 'Punktdarstellung',
      'pc.performance': 'Leistung',
      'pc.detail': 'Detailstufe',
      'pc.detailHint': 'Zulässiger Bildschirmfehler in Pixeln. Größer heißt weniger Kacheln und mehr Bilder je Sekunde — die Abschwächung schließt die gröbere Wolke optisch wieder.',
      'pc.dynamic': 'Ferne vergröbern',
      'pc.dynamicHint': 'Kacheln weit von der Kamera zusätzlich vergröbern. Bei großen Wolken der wirksamste Einzelschalter.',
      'pc.auto': 'Bildrate halten',
      'pc.autoHint': 'Zieht die Detailstufe selbsttätig hoch, wenn die Szene unter 30 Bilder je Sekunde fällt, und wieder zurück, sobald Luft ist.',
      'pc.heightFrom': 'Untere Höhe der Farbrampe (m über Ellipsoid)',
      'pc.heightTo': 'Obere Höhe der Farbrampe (m über Ellipsoid)',
      'pc.heightAuto': 'Spanne aus der Wolke übernehmen',

      'action.deleteAll': 'Alle löschen',
      'action.download': 'Herunterladen',

      'clash.models': 'IFC-Modelle',
      'clash.upload': 'Lokale IFC-Datei wählen',
      'clash.dashboard': 'Kennzahlen',
      'clash.elements': 'Bauteile',
      'clash.storeys': 'Geschosse',
      'clash.found': 'Gefundene Kollisionen',
      'clash.open': 'Kollisionsprüfung starten',
      'clash.reportHtml': 'Kollisionsbericht (HTML)',
      'clash.dashboardHtml': 'IFC-Kennzahlen (HTML)',

      'tags.filter': 'Filter',
      'tags.type': 'Art',
      'tags.target': 'Ziel',
      'tags.status': 'Status',
      'tags.emptyAll': 'Noch keine Notiz — C drücken und rechtsklicken',
      'tags.emptyFilter': 'Keine Notiz passt zum Filter',

      'asset.visibility': 'Modell ein-/ausblenden',
      'asset.tagMode': 'Notizmodus: Rechtsklick setzt eine Notiz',
      'asset.transform': 'Ausrichten — verschieben, drehen, Deckkraft',
      'asset.opacity': 'Deckkraft',
      'asset.move': 'Verschieben',
      'asset.east': 'Ost',
      'asset.north': 'Nord',
      'asset.up': 'Höhe',
      'asset.rotation': 'Drehung',
      'asset.resetAll': 'Ausrichtung zurücksetzen',
      'asset.position': 'Lage',
      'asset.height': 'Höhe (m)',
      'asset.scale': 'Maßstab',
      'asset.speed': 'Tempo',

      'am.measure': 'Messen',
      'am.stop': 'Messen beenden',
      'am.finish': 'Abschließen',
      'am.back': 'Zurück',
      'am.intro': 'Ein Modus für alles: 1 Klick = Punkt · 2 = Strecke · ab 3 = Fläche, Box und Volumen. Enter schließt ab, Esc verwirft.',
      'am.running': 'Laufende Messung',
      'am.points': 'Punkte',
      'am.length': 'Länge',
      'am.area': 'Fläche',
      'am.perimeter': 'Umfang',
      'am.box': 'Box',
      'am.boxVolume': 'Boxvolumen',
      'am.volume': 'Volumen',
      'am.fillRatio': 'Füllverhältnis',
      'am.fromPoints': 'aus Punkten',
      'am.snap': 'Fang',
      'am.target': 'Gemessen wird auf',
      'am.targetAuto': 'alles',
      'am.targetModel': 'nur Modell',
      'am.targetSplat': 'nur Splat',
      'am.targetTerrain': 'nur Gelände',
      'am.targetHint': 'Mit „alles" gewinnt, was der Kamera am nächsten liegt — auch ein Splat vor der Fassade. Liegt ein Scan dicht über dem Gelände, entscheiden Zentimeter darüber, welcher von beiden getroffen wird; dann sagt man es besser.',
      'am.targetNoSplat': 'Keine Splatwolke in der Szene',
      'am.corners': 'Ecken',
      'am.edges': 'Kanten',
      'am.measurePoints': 'Messpunkte',
      'am.free': 'frei',
      'am.snapHint': 'Ecke schlägt Kante schlägt Raster. Ein gefangener Punkt wird nicht nachgerundet — das Raster greift nur auf freier Fläche. Taste G schaltet es weiter.',
      'am.quantities': 'Berührte Bauteile',
      'am.parts': 'Bauteile',
      'am.partVolume': 'Volumen',
      'am.mass': 'Masse',
      'am.withoutQuantity': 'ohne Mengenangabe',
      'am.noParts': 'Noch kein Bauteil getroffen',
      'am.quantitiesHint': 'Volumen, Material, Masse und CO₂ des ganzen Bauteils — nicht der gemessenen Fläche davon. Die Mengen kommen aus den Property-Sets im Backend, Masse und CO₂ sind daraus gerechnet (Rohdichte und GWP A1–A3 als Richtwert). Was im Modell fehlt, bleibt leer statt geschätzt.',
      'am.volumeTitle': 'Topografisches Aufmaß',
      'am.autoVolume': 'bei jeder Fläche mitrechnen',
      'am.autoVolumeHint': 'Eine fertige Fläche stößt das topografische Aufmaß (Volumen aus den Punkten der Wolke) von selbst an. Aus geschaltet bleibt die Fläche eine Fläche — das Aufmaß steht weiter unten als eigener Modus und lässt sich jederzeit einzeln starten.',
      'am.clipTitle': 'Schnittgrenzen',
      'am.clipOn': 'Box schneidet',
      'am.clipOff': 'Aus',
      'am.clipHint': 'Die Box der letzten Fläche — Hauptrichtung des Umrisses, vom tiefsten bis zum höchsten Punkt. Was außerhalb liegt, wird ausgeblendet.',
      'am.graph': 'Graph (Turtle)',
      'am.save': '.ttl sichern',
      'am.load': '.ttl laden',
      'am.focus': 'Getroffene freistellen',
      'am.showAll': 'Alle zeigen',
      'am.focusHint': 'Der Regler bestimmt, wie durchsichtig alles wird, was in der Messung nicht vorkommt. Eine .ttl aus SPIDER wirkt genauso — es zählt, welche GlobalIds darin stehen.',
      'am.graphPoints': 'Messpunkte',
      'am.graphDims': 'Bemaßungen',
      'am.graphMeas': 'Messungen',
      'am.graphParts': 'Bauteile',
      'am.graphTriples': 'Tripel',
      'am.list': 'Messungen',
      'am.empty': 'Noch nichts gemessen',
      'am.pointShort': 'Punkt',

      'topo.title': 'Topografisches Aufmaß',
      'topo.draw': 'Fläche aufziehen',
      'topo.discard': 'Verwerfen',
      'topo.reference': 'Bezugsebene',
      'topo.refLowest': 'Tiefste gesetzte Ecke',
      'topo.refMean': 'Mittel der gesetzten Ecken',
      'topo.refTilted': 'Ausgleichsebene durch die Ecken (geneigt)',
      'topo.refFixed': 'Feste Höhe',
      'topo.fixedHeight': 'Bezugshöhe (m über Ellipsoid)',
      'topo.aggregate': 'Maschenhöhe',
      'topo.aggMean': 'Mittel der Punkte — Regelfall',
      'topo.aggHigh': 'Höchster Punkt — Haldenoberkante, Kronendach',
      'topo.aggLow': 'Tiefster Punkt — Gelände unter Bewuchs und Gerät',
      'topo.cell': 'Maschenweite',
      'topo.cellAuto': 'Automatisch — aus der Punktdichte',
      'topo.ramp': 'Farbstufen',
      'topo.rampHeight': 'Höhe — dunkles Grün bis Sandweiß',
      'topo.rampCutFill': 'Auftrag / Abtrag — blau unter, rot über der Bezugsebene',
      'topo.interval': 'Höhenlinien',
      'topo.intervalAuto': 'Automatisch',
      'topo.contours': 'Höhenlinien',
      'topo.hillshade': 'Schummerung',
      'topo.steps': 'Stufenkarte statt Verlauf',
      'topo.overlay': 'Karte in der Szene',
      'topo.opacity': 'Deckkraft',
      'topo.saveMap': 'Kartenblatt sichern (PNG)',
      'topo.log': 'In Sitzung ablegen',
      'topo.hint':
        'Ecken anklicken, dann „Fläche schließen" — Doppelklick oder Enter tun ' +
        'dasselbe. Gerechnet wird aus den Punkten selbst: Splats kommen aus dem ' +
        'Renderpuffer, Punktwolken aus den 3D-Tiles-Kacheln, die dafür in voller ' +
        'Auflösung geladen werden. Hat die Szene keine Punkte, wird sie ' +
        'abgetastet wie beim Volumen gegen Oberfläche.',


      // ── Sprache ────────────────────────────────────────────────────────
      'language.label': 'Sprache der Oberfläche',
      'language.de': 'Deutsch',
      'language.en': 'Englisch',
    },

    en: {
      'panel.models': 'Asset Browser',
      'panel.models.hint': 'Load models from Cesium Ion and the model browser',
      'panel.view': 'View',
      'panel.view.hint': 'Camera, lighting, comparison view',
      'panel.ifc': 'Components',
      'panel.ifc.hint': 'Filter, isolate, properties',
      'panel.tools': 'Tools',
      'panel.tools.hint': 'Measure, sections, notes',
      'panel.analysis': 'Analysis',
      'panel.analysis.hint': 'Shading, clashes, evaluations',
      'panel.settings': 'Settings',
      'panel.help': 'Help',

      'group.ionAssets': 'Cesium Ion',
      'group.backend': 'Model browser',
      'group.layers': 'Layers',
      'group.pointcloud': 'Point clouds',
      'group.camera': 'Camera & views',
      'group.lighting': 'Lighting',
      'group.split': 'Comparison view',
      'group.filter': 'Filter',
      'group.rooms': 'Rooms & use',
      'group.properties': 'Properties',
      'group.measure': 'Measure',
      'group.clipping': 'Sections',
      'group.tags': 'Notes & inspection',
      'group.solar': 'Shading',
      'group.clash': 'Clash detection',
      'group.quality': 'Rendering',
      'group.language': 'Language',
      'group.terrain': 'Terrain',

      'action.load': 'Load',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'action.reset': 'Reset',
      'action.apply': 'Apply',
      'action.delete': 'Delete',
      'action.remove': 'Remove',
      'action.import': 'Import',
      'action.export': 'Export',
      'action.start': 'Start',
      'action.stop': 'Stop',
      'action.refresh': 'Refresh',
      'action.showAll': 'Show all',
      'action.hideAll': 'Hide all',
      'action.flyTo': 'Fly to',
      'action.isolate': 'Isolate',
      'action.copy': 'Copy',

      'state.on': 'On',
      'state.off': 'Off',
      'state.loading': 'Loading…',
      'state.empty': 'Nothing here',
      'state.error': 'Error',
      'state.none': 'None',
      'state.yes': 'Yes',
      'state.no': 'No',

      'props.title': 'Properties',
      'props.noSelection': 'No component selected. Click an element in the model.',
      'props.loadingDetails': 'Loading full properties…',
      'props.moreProperties': 'More properties',
      'props.allProperties': 'All properties',
      'props.showRaw': 'Show raw data',
      'props.noData': 'No properties available for this component.',
      'props.fromModel': 'From the model',
      'props.fromBackend': 'From the component database',
      'props.copied': 'Copied to clipboard',

      'role.architect': 'Architecture',
      'role.engineer': 'Structure',
      'role.sitemanager': 'Site management',
      'role.fm': 'Operation & maintenance',
      'role.surveyor': 'Surveying',
      'role.hint.architect': 'Design, build-up, building physics',
      'role.hint.engineer': 'Structural behaviour, sections, loads',
      'role.hint.sitemanager': 'Quantities, schedule, execution',
      'role.hint.fm': 'Equipment, maintenance, cost',
      'role.hint.surveyor': 'Position, elevation, dimensions',

      'pgroup.identity': 'Identification',
      'pgroup.dimensions': 'Dimensions',
      'pgroup.buildup': 'Build-up & material',
      'pgroup.physics': 'Building physics',
      'pgroup.openings': 'Openings & glazing',
      'pgroup.structure': 'Structural behaviour',
      'pgroup.section': 'Section & profile',
      'pgroup.loads': 'Loads',
      'pgroup.reinforcement': 'Reinforcement',
      'pgroup.quantities': 'Quantities',
      'pgroup.schedule': 'Schedule & phases',
      'pgroup.status': 'Status & approval',
      'pgroup.supplier': 'Manufacturer & supply',
      'pgroup.asset': 'Asset identification',
      'pgroup.maintenance': 'Maintenance & service life',
      'pgroup.operation': 'Operation & ratings',
      'pgroup.classification': 'Classification & cost',
      'pgroup.location': 'Position & elevation',
      'pgroup.tolerance': 'Accuracy',

      'terrain.align': 'Align models to terrain',
      'terrain.alignHint':
        'Reconciles the height set as "above terrain" in the backend with this ' +
        'viewer\'s terrain. Without it the model floats or sinks by the ' +
        'difference between the two terrain models.',
      'terrain.alignNow': 'Align now',
      'terrain.aligned': 'Aligned: {delta} m',
      'terrain.notAligned': 'Not aligned',

      'anno.section': 'Labels in the model',
      'anno.show': 'Show labels',
      'anno.onlyOpen': 'Unresolved only',
      'anno.distance': 'Visible up to',
      'anno.reset': 'Reset moved labels',
      'anno.hint':
        'Every note gets a dot in the model and a label beside it. Labels can be ' +
        'dragged and keep their place. Where two overlap, the more distant one ' +
        'folds back into its dot and reopens on hover. Toggle with ⇧A.',
      'anno.untitled': 'Untitled',
      'anno.status.open': 'open',
      'anno.status.in_progress': 'in progress',
      'anno.status.closed': 'resolved',
      'anno.confirmDelete': 'Delete note “{title}”?',

      // ── Tools, models, notes (panel rework 2026-08) ────────────────────
      'panel.tags': 'Notes',
      'panel.tags.hint': 'Notes and inspection on the model',
      'group.loaded': 'Loaded models',
      'underground.mode': 'Underground mode',
      'underground.zeroLevel': 'Show ground level',
      'underground.seeThrough': 'See through above models',
      'underground.hint':
        'Lets the camera move below the terrain — for basements, foundations '
        + 'and excavations. The terrain stays opaque; with see-through it no longer '
        + 'hides the models. A grid (10 m / 50 m) marks the surface.',
      'group.session': 'Session',

      'state.noAssets': 'No model loaded yet',

      // ── Panel cleanup 2026-08 ──────────────────────────────────────────
      'models.ionField': 'Asset from your Ion account, or an asset ID',
      'models.ionPlaceholder': 'Pick a name or type an ID',
      'models.ionReady': '{n} assets in the account — pick a name or type an ID',
      'models.ionFailed': 'Ion account unreachable — you can still type an asset ID',
      'models.ionInvalid': 'No valid Ion asset ID recognised',
      'models.glb': 'Local GLB models',

      // ── Revit filter ───────────────────────────────────────────────────
      'revit.hint': 'Revit categories only appear on models loaded from Cesium Ion: upload and tile the .rvt file there first (ion.cesium.com), then load it above under "Models → Cesium Ion" by name or asset ID. This list then colors and filters by Revit category automatically.',
      'revit.selectAll': 'All',
      'revit.deselectAll': 'None',
      'models.glbPick': 'Choose a GLB model …',
      'models.backendUrl': 'Model server address',
      'models.backendOffline': 'Not connected',
      'models.backendJob': 'Job ID or tileset.json URL',
      'models.backendJobPlaceholder': 'Job ID or URL',
      'models.search': 'Search name …',
      'models.filterAll': 'All',
      'models.type.ifc': 'IFC',
      'models.type.mesh': 'Mesh',
      'models.type.pointcloud': 'Point cloud',
      'models.type.splat': 'Splat',
      'models.type.unknown': 'Other',

      'layer.basemap': 'Basemap',
      'layer.tiles3d': '3D layers',
      'layer.terrain': 'Terrain',
      'layer.geoid': 'Geoid terrain',
      'layer.bathymetry': 'Bathymetry',
      'layer.vector': 'Vector map',
      'layer.vectorHint': 'Official vector tiles (basemap.de, BKG) draped onto the '
        + 'terrain — sharp at every zoom level, every feature clickable.',
      'vector.drape': 'Drape onto',
      'vector.drapeTerrain': 'Terrain',
      'vector.drapeAll': 'Terrain and models',
      'vector.buildings': 'Building footprints',
      'vector.traffic': 'Transport',
      'vector.water': 'Water',
      'vector.borders': 'Boundaries',
      'vector.loading': 'loading …',

      'pc.presets': 'Presets',
      'pc.colorMode': 'Colour mode',
      'pc.edl': 'Eye dome lighting',
      'pc.appearance': 'Point appearance',
      'pc.performance': 'Performance',
      'pc.detail': 'Detail level',
      'pc.detailHint': 'Allowed screen-space error in pixels. Larger means fewer tiles and more frames per second — attenuation closes the coarser cloud again visually.',
      'pc.dynamic': 'Coarsen distance',
      'pc.dynamicHint': 'Additionally coarsen tiles far from the camera. The single most effective switch for large clouds.',
      'pc.auto': 'Hold frame rate',
      'pc.autoHint': 'Raises the detail level automatically when the scene drops below 30 frames per second, and lowers it again once there is headroom.',
      'pc.heightFrom': 'Lower height of the colour ramp (m above ellipsoid)',
      'pc.heightTo': 'Upper height of the colour ramp (m above ellipsoid)',
      'pc.heightAuto': 'Take the range from the cloud',

      'action.deleteAll': 'Delete all',
      'action.download': 'Download',

      'clash.models': 'IFC models',
      'clash.upload': 'Choose local IFC file',
      'clash.dashboard': 'Key figures',
      'clash.elements': 'Elements',
      'clash.storeys': 'Storeys',
      'clash.found': 'Clashes found',
      'clash.open': 'Run clash detection',
      'clash.reportHtml': 'Clash report (HTML)',
      'clash.dashboardHtml': 'IFC dashboard (HTML)',

      'tags.filter': 'Filter',
      'tags.type': 'Type',
      'tags.target': 'Target',
      'tags.status': 'Status',
      'tags.emptyAll': 'No notes yet — press C and right-click',
      'tags.emptyFilter': 'No note matches the filter',

      'asset.visibility': 'Show / hide model',
      'asset.tagMode': 'Note mode: right-click places a note',
      'asset.transform': 'Align — move, rotate, opacity',
      'asset.opacity': 'Opacity',
      'asset.move': 'Move',
      'asset.east': 'East',
      'asset.north': 'North',
      'asset.up': 'Height',
      'asset.rotation': 'Rotation',
      'asset.resetAll': 'Reset alignment',
      'asset.position': 'Position',
      'asset.height': 'Height (m)',
      'asset.scale': 'Scale',
      'asset.speed': 'Speed',

      'am.measure': 'Measure',
      'am.stop': 'Stop measuring',
      'am.finish': 'Finish',
      'am.back': 'Undo',
      'am.intro': 'One mode for everything: 1 click = point · 2 = distance · 3+ = area, box and volume. Enter finishes, Esc discards.',
      'am.running': 'Current measurement',
      'am.points': 'Points',
      'am.length': 'Length',
      'am.area': 'Area',
      'am.perimeter': 'Perimeter',
      'am.box': 'Box',
      'am.boxVolume': 'Box volume',
      'am.volume': 'Volume',
      'am.fillRatio': 'Fill ratio',
      'am.fromPoints': 'from points',
      'am.snap': 'Snap',
      'am.target': 'Measure on',
      'am.targetAuto': 'anything',
      'am.targetModel': 'models only',
      'am.targetSplat': 'splats only',
      'am.targetTerrain': 'terrain only',
      'am.targetHint': 'With "anything", whatever sits closest to the camera wins — including a splat in front of the facade. Where a scan lies just above the terrain, centimetres decide which of the two is hit; better to say which you mean.',
      'am.targetNoSplat': 'No splat cloud in the scene',
      'am.corners': 'Corners',
      'am.edges': 'Edges',
      'am.measurePoints': 'Measured points',
      'am.free': 'free',
      'am.snapHint': 'Corner beats edge beats grid. A snapped point is never re-rounded — the grid applies on free surfaces only. Press G to cycle.',
      'am.quantities': 'Elements touched',
      'am.parts': 'Elements',
      'am.partVolume': 'Volume',
      'am.mass': 'Mass',
      'am.withoutQuantity': 'without quantity',
      'am.noParts': 'No element hit yet',
      'am.quantitiesHint': 'Volume, material, mass and CO\u2082 of the whole element \u2014 not of the measured area on it. Quantities come from the backend property sets; mass and CO\u2082 are derived from them (density and GWP A1\u2013A3 as guide values). What the model lacks stays empty rather than estimated.',
      'am.volumeTitle': 'Topographic survey',
      'am.autoVolume': 'run with every area',
      'am.autoVolumeHint': 'A finished area triggers the topographic survey (volume from the cloud\u2019s own points) by itself. Switched off, an area stays an area \u2014 the survey remains below as its own mode and can be started separately at any time.',
      'am.clipTitle': 'Section bounds',
      'am.clipOn': 'Box clips',
      'am.clipOff': 'Off',
      'am.clipHint': 'The box of the last area — principal direction of the outline, from lowest to highest point. Everything outside is hidden.',
      'am.graph': 'Graph (Turtle)',
      'am.save': 'Save .ttl',
      'am.load': 'Load .ttl',
      'am.focus': 'Isolate what was hit',
      'am.showAll': 'Show all',
      'am.focusHint': 'The slider sets how transparent everything becomes that the measurement does not touch. A .ttl from SPIDER works the same way — what counts are the GlobalIds inside.',
      'am.graphPoints': 'Measured points',
      'am.graphDims': 'Dimensions',
      'am.graphMeas': 'Measurements',
      'am.graphParts': 'Elements',
      'am.graphTriples': 'Triples',
      'am.list': 'Measurements',
      'am.empty': 'Nothing measured yet',
      'am.pointShort': 'Point',

      'topo.title': 'Topographic survey',
      'topo.draw': 'Draw area',
      'topo.discard': 'Discard',
      'topo.reference': 'Reference plane',
      'topo.refLowest': 'Lowest placed corner',
      'topo.refMean': 'Mean of placed corners',
      'topo.refTilted': 'Best-fit plane through the corners (tilted)',
      'topo.refFixed': 'Fixed height',
      'topo.fixedHeight': 'Reference height (m above ellipsoid)',
      'topo.aggregate': 'Cell height',
      'topo.aggMean': 'Mean of the points — default',
      'topo.aggHigh': 'Highest point — stockpile top, canopy',
      'topo.aggLow': 'Lowest point — ground below vegetation and machinery',
      'topo.cell': 'Cell size',
      'topo.cellAuto': 'Automatic — from point density',
      'topo.ramp': 'Colour scale',
      'topo.rampHeight': 'Elevation — dark green to sand white',
      'topo.rampCutFill': 'Cut / fill — blue below, red above the reference plane',
      'topo.interval': 'Contour interval',
      'topo.intervalAuto': 'Automatic',
      'topo.contours': 'Contour lines',
      'topo.hillshade': 'Hillshade',
      'topo.steps': 'Stepped bands instead of a gradient',
      'topo.overlay': 'Map in the scene',
      'topo.opacity': 'Opacity',
      'topo.saveMap': 'Save map sheet (PNG)',
      'topo.log': 'Add to session',
      'topo.hint':
        'Click the corners, then "Close area" — double-click or Enter do the same. ' +
        'The volume is summed from the points themselves: splats come from the ' +
        'render buffers, point clouds from the 3D Tiles tiles, which are loaded at ' +
        'full resolution for the purpose. If the scene holds no points, it is ' +
        'sampled the way "Volume against surface" does.',


      'language.label': 'Interface language',
      'language.de': 'German',
      'language.en': 'English',
    }
  };

  /**
   * Übersetzt einen Schlüssel. `params` ersetzt Platzhalter der Form `{name}`.
   */
  function t(key, params) {
    let text = DICT[current]?.[key];
    if (text === undefined) text = DICT[DEFAULT_LANGUAGE]?.[key];
    if (text === undefined) return key;

    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  }

  /**
   * Ersetzt den Text aller `data-i18n`-Knoten. Zusätzlich unterstützt:
   * `data-i18n-title` (Tooltip) und `data-i18n-placeholder`.
   */
  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
  }

  function setLanguage(language) {
    if (!LANGUAGES.includes(language) || language === current) return;
    current = language;
    localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
    apply();
    // Panels, die ihren Inhalt als HTML-String erzeugen, können sich nicht über
    // data-i18n aktualisieren — sie zeichnen auf dieses Ereignis hin neu.
    document.dispatchEvent(
      new CustomEvent('ileen:language-changed', { detail: { language } })
    );
    console.log(`🌐 Sprache: ${language}`);
  }

  function getLanguage() {
    return current;
  }

  function init() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (LANGUAGES.includes(stored)) {
      current = stored;
    } else {
      // Browsersprache nur als Erstbelegung, danach entscheidet die Auswahl.
      const browser = (navigator.language || '').slice(0, 2).toLowerCase();
      current = LANGUAGES.includes(browser) ? browser : DEFAULT_LANGUAGE;
    }
    document.documentElement.lang = current;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => apply());
    } else {
      apply();
    }
  }

  return { t, apply, setLanguage, getLanguage, init, LANGUAGES };
})();

window.ILeenI18n = ILeenI18n;
// Kurzform, die in den Panel-Templates ständig gebraucht wird.
window.t = (key, params) => ILeenI18n.t(key, params);
ILeenI18n.init();
