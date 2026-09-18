/**
 * iLEEN — Bauteile: Merkmale, Filter, Auswahl, Ausblenden
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Alles, was an einzelnen Features eines 3D-Tilesets hängt: welches Merkmal
 * den IFC-Typ trägt, der Typfilter samt Hervorhebung, der Klick auf ein
 * Bauteil mit Eigenschaftsanzeige, das Isolieren und der Ausblendmodus.
 *
 * Die App parst kein IFC. Alles läuft über die Batch Table der Kacheln
 * (`feature.getPropertyIds()` / `feature.getProperty(name)`).
 */
'use strict';

(function () {
  if (typeof BimViewer === 'undefined') {
    console.error('features.js: core.js muss vorher geladen sein');
    return;
  }

  // ─────────────────────────────────────────────────────────────────────
  // WELCHES MERKMAL TRÄGT DEN IFC-TYP?
  // ─────────────────────────────────────────────────────────────────────

  // Backend-Tiles führen `IfcType`, der ion-Tiler `className`; andere
  // Exporteure schreiben eines der übrigen.
  const IFC_DEFAULT_PROPERTY = 'className';

  BimViewer.detectIFCProperties = async function (tileset) {
    if (!tileset) return null;

    const possiblePropertyNames = [
      'IfcType',
      'className',    // Cesium Ion IFC tiler
      'IfcEntity', 'element_type', 'IFC_Type',
      'Category', 'class', 'type', 'ifcType', 'entityType'
    ];

    // Extract property name from a single content object.
    // Handles Composite tiles (CMPT) via innerContents — Composite.featuresLength is always 0.
    const tryContent = (content) => {
      if (!content) return null;
      // Composite tile: recurse into inner contents
      if (content.innerContents && content.innerContents.length > 0) {
        for (const inner of content.innerContents) {
          const found = tryContent(inner);
          if (found) return found;
        }
        return null;
      }
      if (!content.featuresLength || content.featuresLength === 0) return null;
      try {
        const feature = content.getFeature(0);
        const ids = feature.getPropertyIds();
        for (const propName of possiblePropertyNames) {
          if (ids.includes(propName)) {
            const value = feature.getProperty(propName);
            if (typeof value === 'string' && value.length > 0) {
              return propName;
            }
          }
        }
      } catch (e) { /* content not fully ready */ }
      return null;
    };

    const scanAllTiles = () => {
      // _selectedTiles — tiles currently rendered by Cesium (most reliable)
      const selected = tileset._selectedTiles;
      if (selected && selected.length > 0) {
        for (const tile of selected) {
          const found = tryContent(tile.content);
          if (found) return found;
        }
      }
      // Recursive walk as fallback (unlimited depth)
      const walk = (tile) => {
        const found = tryContent(tile.content);
        if (found) return found;
        if (tile.children) {
          for (const child of tile.children) {
            const r = walk(child);
            if (r) return r;
          }
        }
        return null;
      };
      if (tileset.root) return walk(tileset.root);
      return null;
    };

    // Poll up to 5 s in 200 ms steps — Ion streams tiles lazily
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = scanAllTiles();
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
  };

  // ─────────────────────────────────────────────────────────────────────
  // BAUTEIL-HERVORHEBUNG ÜBER DIE GlobalId
  //
  // Ein Bauteil, das anderswo gewählt wird — in der Bauteilliste des
  // Lastabtrags, aus einem Bericht, über MCP —, soll im Modell zu sehen sein,
  // ohne dass jemand es anklickt.
  //
  // Der Klickweg färbt dafür `feature.color`. Das geht hier nicht: ein
  // `Cesium3DTileFeature` gibt es nur für Tiles, die gerade geladen sind, und
  // beim nächsten LOD-Wechsel ist die Farbe wieder fort. Die Hervorhebung
  // läuft deshalb über den **Stil des Tilesets**: `Cesium3DTileStyle` wertet
  // die Farbbedingungen von oben nach unten aus und nimmt die erste
  // zutreffende. Die Highlight-Bedingung steht darum vor den Entitätsfarben
  // des IFC-Filters und übersteht jedes Nachladen.
  //
  // Weil ein Tileset nur *einen* Stil hat, setzt nicht diese Stelle den Stil,
  // sondern _applyIFCFilterInner() baut Filter und Hervorhebung zusammen. Hier
  // stehen nur der Zustand und die Bedingungen.
  // ─────────────────────────────────────────────────────────────────────
  BimViewer.ifcHighlight = { ids: new Set(), color: '#ff2d95' };

  // Die Batch Table der Backend-Tiles führt GlobalId, IfcType, Name und
  // Geschoss (tiling/formats/ifc.py); andere Konverter schreiben 'globalId'.
  var GUID_PROPERTY_NAMES = ['GlobalId', 'globalId', 'GUID', 'Guid', 'guid', 'IfcGUID'];

  // Ohne diese Eigenschaft darf keine String-Bedingung in den Stil — an einem
  // Tileset ohne Batch Table bricht der Shader mit "String literals are not
  // supported" ab (derselbe Grund, aus dem der IFC-Filter unten Punktwolken
  // ausspart).
  //
  // Der Rückgabewert unterscheidet zwei Fälle, die man nicht verwechseln darf:
  // `featuresGesehen: false` heißt "noch keine Kachel mit Inhalt geladen" —
  // dann ist über das Tileset gar nichts gesagt und die Prüfung muss später
  // wiederholt werden. Erst `featuresGesehen: true` ohne `eigenschaft` ist die
  // belastbare Aussage "dieses Tileset führt keine GlobalId". Ohne die
  // Unterscheidung merkte sich ein Asset, das direkt nach dem Laden geprüft
  // wird, dauerhaft ein falsches Nein.
  BimViewer._scanGuidProperty = function (tileset) {
    var ergebnis = { eigenschaft: null, featuresGesehen: false };
    if (!tileset) return ergebnis;

    var pruefe = function (content) {
      if (!content || ergebnis.eigenschaft) return;
      if (content.innerContents && content.innerContents.length) {
        content.innerContents.forEach(pruefe);
        return;
      }
      if (!content.featuresLength) return;
      ergebnis.featuresGesehen = true;
      try {
        var ids = content.getFeature(0).getPropertyIds() || [];
        for (var i = 0; i < GUID_PROPERTY_NAMES.length; i++) {
          if (ids.includes(GUID_PROPERTY_NAMES[i])) {
            ergebnis.eigenschaft = GUID_PROPERTY_NAMES[i];
            return;
          }
        }
      } catch (e) { /* Tile noch nicht bereit */ }
    };

    var selected = tileset._selectedTiles;
    if (selected) {
      for (var i = 0; i < selected.length && !ergebnis.eigenschaft; i++) {
        pruefe(selected[i].content);
      }
    }
    if (ergebnis.eigenschaft) return ergebnis;

    var stapel = tileset.root ? [tileset.root] : [];
    while (stapel.length && !ergebnis.eigenschaft) {
      var tile = stapel.pop();
      pruefe(tile.content);
      if (tile.children) {
        for (var c = 0; c < tile.children.length; c++) stapel.push(tile.children[c]);
      }
    }
    return ergebnis;
  };

  BimViewer.detectGuidProperty = function (tileset) {
    return this._scanGuidProperty(tileset).eigenschaft;
  };

  // Das Merken des Ergebnisses am Asset — siehe _scanGuidProperty: ein Nein
  // wird nur festgeschrieben, wenn wirklich Bauteile zu sehen waren.
  BimViewer._guidEigenschaftMerken = function (assetData) {
    if (!assetData || assetData.guidPropertyName !== undefined) return;
    var scan = this._scanGuidProperty(assetData.tileset);
    if (scan.eigenschaft) assetData.guidPropertyName = scan.eigenschaft;
    else if (scan.featuresGesehen) assetData.guidPropertyName = null;
  };

  /**
   * Bauteile über ihre IFC-GlobalId hervorheben.
   *
   * `globalIds` ist eine GlobalId oder ein Array davon; leer oder null löscht
   * die Hervorhebung. `optionen.farbe` überschreibt das Magenta. Zurück kommt
   * die Zahl der Tilesets, in denen die Bedingung greifen konnte — 0 heißt,
   * dass kein geladenes Modell eine GlobalId je Bauteil führt.
   */
  BimViewer.highlightIFCElements = async function (globalIds, optionen) {
    var eingabe = globalIds == null ? [] : (Array.isArray(globalIds) ? globalIds : [globalIds]);
    var ids = eingabe.filter(function (id) { return typeof id === 'string' && id.length > 0; });
    this.ifcHighlight.ids = new Set(ids);
    if (optionen && optionen.farbe) this.ifcHighlight.color = optionen.farbe;

    var treffer = 0;
    this.loadedAssets.forEach(function (assetData) {
      if (!assetData.tileset || assetData.isPointCloud) return;
      BimViewer._guidEigenschaftMerken(assetData);
      if (assetData.guidPropertyName) treffer++;
    });

    await this.applyIFCFilter();
    return treffer;
  };

  BimViewer.clearIFCHighlight = function () {
    return this.highlightIFCElements([]);
  };

  // Die Farbbedingungen eines Assets — leer, wenn nichts hervorgehoben ist
  // oder das Tileset keine GlobalId führt.
  BimViewer._ifcHighlightConditions = function (assetData) {
    var hl = this.ifcHighlight;
    if (!hl || !hl.ids.size || !assetData || !assetData.guidPropertyName) return [];
    var eigenschaft = assetData.guidPropertyName;
    var farbe = hl.color;
    return Array.from(hl.ids).map(function (id) {
      return ['${' + eigenschaft + "} === '" + String(id).replace(/'/g, "\\'") + "'",
              "color('" + farbe + "')"];
    });
  };

  // ─────────────────────────────────────────────────────────────────────
  // WELCHE TYPEN STEHEN WIRKLICH IM MODELL?
  //
  // IFC_ENTITIES ist eine gepflegte Liste, kein Abbild des geladenen Modells.
  // Was dort fehlt, konnte man bisher weder sehen noch filtern — man merkte es
  // erst daran, dass Bauteile fehlten. Der Scan hier liest die Typen aus den
  // Batch Tables der geladenen Kacheln, meldet unbekannte ueber
  // ifcTypEinordnen() (core.js) nach und zaehlt je Typ mit.
  //
  // Gescannt wird nur, was ohnehin im Speicher liegt; jeder Content genau
  // einmal (WeakSet). Beim Streamen kommen Kacheln nach, deshalb haengt
  // _typScanAnhaengen() zusaetzlich am tileLoad-Ereignis.
  // ─────────────────────────────────────────────────────────────────────
  BimViewer.ifcFilter.gefundeneTypen = new Map();   // Typ → Anzahl Bauteile
  BimViewer._gescannteContents = new WeakSet();

  BimViewer._typenAusContent = function (content, eigenschaft, gefunden) {
    if (!content) return;
    if (content.innerContents && content.innerContents.length) {
      content.innerContents.forEach(inner =>
        this._typenAusContent(inner, eigenschaft, gefunden));
      return;
    }
    if (!content.featuresLength) return;
    if (this._gescannteContents.has(content)) return;
    this._gescannteContents.add(content);

    for (let i = 0; i < content.featuresLength; i++) {
      try {
        const wert = content.getFeature(i).getProperty(eigenschaft);
        if (typeof wert === 'string' && wert.length) {
          gefunden.set(wert, (gefunden.get(wert) || 0) + 1);
        }
      } catch (e) { break; /* Content nicht bereit — beim naechsten Lauf wieder */ }
    }
  };

  /**
   * Die Typen eines Assets einsammeln.
   * Rueckgabe: Zahl der Typen, die vorher unbekannt waren.
   */
  BimViewer.scanIFCTypes = function (assetData) {
    const eigenschaft = assetData && assetData.ifcPropertyName;
    const tileset = assetData && assetData.tileset;
    if (!eigenschaft || !tileset || assetData.isPointCloud) return 0;

    const gefunden = new Map();
    const selected = tileset._selectedTiles;
    if (selected) {
      for (let i = 0; i < selected.length; i++) {
        this._typenAusContent(selected[i].content, eigenschaft, gefunden);
      }
    }
    const stapel = tileset.root ? [tileset.root] : [];
    while (stapel.length) {
      const tile = stapel.pop();
      this._typenAusContent(tile.content, eigenschaft, gefunden);
      if (tile.children) {
        for (let c = 0; c < tile.children.length; c++) stapel.push(tile.children[c]);
      }
    }

    // Ein neu entdeckter Typ ist zunaechst sichtbar — es sei denn, gerade ist
    // ohnehin alles abgewaehlt ("Keine"), dann darf ein nachladendes Tile den
    // Zustand nicht aufweichen.
    const alleAus = this.ifcFilter.enabledEntities.size === 0;
    const neueTypen = [];

    gefunden.forEach((anzahl, typ) => {
      const bisher = this.ifcFilter.gefundeneTypen.get(typ) || 0;
      this.ifcFilter.gefundeneTypen.set(typ, bisher + anzahl);

      if (!this.ifcFilter.allEntities.has(typ)) {
        this.ifcFilter.allEntities.add(typ);
        if (!alleAus) this.ifcFilter.enabledEntities.add(typ);
        neueTypen.push(typ);
      }
      // In IFC_ENTITIES nachtragen, damit Farbe, Liste und Kategorie stimmen
      if (typeof IFC_ENTITIES !== 'undefined' &&
          !IFC_ENTITIES.some(e => e.entity === typ) &&
          typeof ifcTypEinordnen === 'function') {
        IFC_ENTITIES.push(ifcTypEinordnen(typ));
      }
    });

    if (neueTypen.length) {
      console.log(`🔎 ${neueTypen.length} neue(r) IFC-Typ(en) im Modell: ${neueTypen.join(', ')}`);
    }
    return neueTypen.length;
  };

  // Nachladende Kacheln melden ihre Typen selbst. Das Neuzeichnen wird
  // gebuendelt — beim Streamen kommen sonst dutzende Ereignisse in Folge.
  BimViewer._typScanAnhaengen = function (assetData) {
    const tileset = assetData && assetData.tileset;
    if (!tileset || assetData._typScanHook || !assetData.ifcPropertyName) return;
    assetData._typScanHook = true;
    tileset.tileLoad.addEventListener(() => {
      if (this._typScanTimer) return;
      this._typScanTimer = setTimeout(() => {
        this._typScanTimer = null;
        const neue = this.scanIFCTypes(assetData);
        if (neue) {
          if (typeof this.updateIFCFilterUI === 'function') this.updateIFCFilterUI();
          this.applyIFCFilter();
        } else {
          this.updateEntityCounts();
        }
      }, 800);
    });
  };

  // ─────────────────────────────────────────────────────────────────────
  // IFC-FILTER
  // ─────────────────────────────────────────────────────────────────────

  BimViewer._ifcFilterRunning = false;

  BimViewer.applyIFCFilter = async function () {
    // Prevent overlapping runs — last toggle wins: queue at most one pending call
    if (this._ifcFilterRunning) {
      this._ifcFilterPending = true;
      return;
    }
    this._ifcFilterRunning = true;
    this._ifcFilterPending = false;

    try {
      await this._applyIFCFilterInner();
    } finally {
      this._ifcFilterRunning = false;
      if (this._ifcFilterPending) {
        this._ifcFilterPending = false;
        this.applyIFCFilter();
      }
    }
  };

  BimViewer._applyIFCFilterInner = async function () {
    if (!this.loadedAssets || this.loadedAssets.size === 0) return;

    // Kein Typ abgewählt: gilt über die bekannten Typen, nicht über die Zahl
    const allEnabled = Array.from(this.ifcFilter.allEntities)
      .every((typ) => this.ifcFilter.enabledEntities.has(typ));

    for (const [assetId, assetData] of this.loadedAssets) {
      const tileset = assetData.tileset;
      if (!tileset) continue;
      if (assetData.isPointCloud || tileset._isGaussianSplat) continue;
      // Die Baustufen (sequencing.js) haben das Tileset gerade eingefärbt —
      // ein Filterlauf nähme ihnen den Stil.
      if (this.sequencing && this.sequencing.activeAssetId === assetId) continue;

      // Die Hervorhebung eines Bauteils (highlightIFCElements) teilt sich den
      // Stil mit dem Filter — beides muss deshalb hier zusammenkommen, und die
      // Bedingungen werden vor den Aussteigern unten gebraucht.
      this._guidEigenschaftMerken(assetData);
      const hlBedingungen = this._ifcHighlightConditions(assetData);
      const opacity = assetData.opacity === undefined ? 1.0 : assetData.opacity;

      // Detect IFC property name if not yet known — do this BEFORE deciding to skip,
      // because detection needs tile content which may not have been available at load time.
      if (!assetData.ifcPropertyName) {
        try {
          const detected = await this.detectIFCProperties(tileset);
          if (detected) {
            assetData.ifcPropertyName = detected;
            console.log(`✅ Asset ${assetId}: IFC property detected on demand: "${detected}"`);
          }
        } catch (e) { /* weiter ohne Merkmal */ }
      }

      // Skip assets with no IFC properties — applying string-literal style conditions
      // to non-IFC tilesets (e.g. point clouds) causes "String literals are not
      // supported" shader errors. Only skip when all types are enabled (initial state);
      // when the user actively filters, fall back to 'className' so Ion-Assets work.
      if (!assetData.ifcPropertyName) {
        if (allEnabled) {
          // Ohne Typmerkmal und ohne aktiven Filter bleibt der Stil unangetastet.
          // Ist aber ein Bauteil hervorgehoben und das Tileset führt eine
          // GlobalId, genügt ein Stil aus Hervorhebung plus neutralem Weiß:
          // color('white') multipliziert die Materialfarbe mit eins und lässt
          // Texturen unverändert.
          if (hlBedingungen.length) {
            tileset.style = new Cesium.Cesium3DTileStyle({
              show: true,
              color: {
                conditions: hlBedingungen.concat(
                  [['true', `color('white', ${opacity})`]])
              }
            });
          }
          continue;
        }
        assetData.ifcPropertyName = IFC_DEFAULT_PROPERTY;
      }

      try {
        const ifcPropertyName = assetData.ifcPropertyName;

        // Erst schauen, was im Modell steht, dann filtern: sonst faerbt und
        // zaehlt der Filter Typen, die er noch gar nicht kennt.
        this.scanIFCTypes(assetData);
        this._typScanAnhaengen(assetData);

        // ---------------------------------------------------------------
        // AUSSCHLUSS STATT EINSCHLUSS
        // ---------------------------------------------------------------
        // `show` ist die Verneinung der *abgewaehlten* Typen. Was der
        // Nutzer nicht ausdruecklich ausblendet, bleibt sichtbar — auch ein
        // Typ, den die Liste nicht kennt. Nebenbei ist die Bedingung kuerzer,
        // denn ueblicherweise sind wenige Typen aus als an.
        //
        // `alleAusblenden` ist der Gegenfall: bei "Keine" soll wirklich
        // nichts stehen bleiben, auch nichts Unbekanntes.
        const abgewaehlt = [];
        this.ifcFilter.allEntities.forEach(entity => {
          if (!this.ifcFilter.enabledEntities.has(entity)) abgewaehlt.push(entity);
        });
        const alleAusblenden = this.ifcFilter.enabledEntities.size === 0;
        const showConditions = abgewaehlt.map(entity =>
          `\${${ifcPropertyName}} !== '${entity}'`);

        // Farben — die Hervorhebung zuerst, denn Cesium3DTileStyle nimmt die
        // erste zutreffende Bedingung.
        const colorConditions = hlBedingungen.slice();
        IFC_ENTITIES.forEach(e => {
          if (this.ifcFilter.enabledEntities.has(e.entity)) {
            colorConditions.push([`\${${ifcPropertyName}} === '${e.entity}'`,
                                  `color('${e.color}', ${opacity})`]);
          }
        });
        colorConditions.push(['true', `color('white', ${opacity})`]);

        if (alleAusblenden) {
          // "Keine" — nichts bleibt stehen, auch keine unbekannten Typen
          tileset.style = new Cesium.Cesium3DTileStyle({ show: false });
        } else if (allEnabled || showConditions.length === 0) {
          // Kein Typ abgewaehlt — alles zeigen, nur einfaerben
          tileset.style = new Cesium.Cesium3DTileStyle({
            show: true,
            color: { conditions: colorConditions }
          });
        } else {
          tileset.style = new Cesium.Cesium3DTileStyle({
            show: showConditions.join(' && '),
            color: { conditions: colorConditions }
          });
        }
      } catch (error) {
        console.warn(`IFC-Filter für ${assetId} nicht anwendbar:`, error.message);
        try {
          tileset.style = new Cesium.Cesium3DTileStyle({
            show: true
          });
        } catch (e) { /* Tileset zerstört */ }
      }
    }

    this.updateEntityCounts();
    // Ein neuer Stil setzt `feature.show` aus seinem Ausdruck neu — ausgeblendete
    // Bauteile kämen sonst zurück.
    if (typeof this.reapplyHiddenFeatures === 'function') this.reapplyHiddenFeatures();
  };

  BimViewer.updateEntityCounts = function () {
    // Sobald der Typ-Scan gelaufen ist, zaehlt nur, was im Modell steht:
    // "6/8" ist eine Aussage, "6/71" ist Rauschen aus der Typenliste.
    const gefunden = this.ifcFilter.gefundeneTypen;
    let activeCount, totalCount;
    if (gefunden && gefunden.size) {
      const typen = Array.from(gefunden.keys());
      totalCount = typen.length;
      activeCount = typen.filter(t => this.ifcFilter.enabledEntities.has(t)).length;
    } else {
      activeCount = this.ifcFilter.enabledEntities.size;
      totalCount = this.ifcFilter.allEntities.size;
    }

    const aktiv = document.getElementById('activeEntityCount');
    if (aktiv) aktiv.textContent = activeCount;
    const gesamt = document.getElementById('totalEntityCount');
    if (gesamt) gesamt.textContent = totalCount;
  };

  // ─────────────────────────────────────────────────────────────────────
  // IFC SELECT / DESELECT ALL
  // ─────────────────────────────────────────────────────────────────────

  BimViewer.selectAllIFCTypes = function () {
    IFC_ENTITIES.forEach(e => {
      this.ifcFilter.enabledEntities.add(e.entity);
      this.ifcFilter.allEntities.add(e.entity);
    });
    // Auch die im Modell gefundenen Typen, falls sie (noch) nicht in
    // IFC_ENTITIES stehen
    this.ifcFilter.allEntities.forEach(t => this.ifcFilter.enabledEntities.add(t));
    if (typeof this.updateIFCFilterUI === 'function') this.updateIFCFilterUI();
    if (typeof this.applyIFCFilter === 'function') this.applyIFCFilter();
    this.updateStatus('Alle IFC-Typen aktiviert', 'success');
  };

  // ─────────────────────────────────────────────────────────────────────
  // KATEGORIEFILTER
  //
  // Einzelne Typen anzuhaken ist muehsam, sobald ein Modell dreissig davon
  // fuehrt. Die Kategorie ist die Ebene, auf der man tatsaechlich denkt:
  // "Tragwerk ja, TGA nein" — oder eben "Bauteilschichten weg".
  //
  // Welche Typen zu einer Kategorie gehoeren, steht in IFC_ENTITIES; entdeckte
  // Typen bekommen ihre Kategorie von ifcTypEinordnen() und sind damit hier
  // gleichberechtigt.
  //
  // `alleZeigen` entscheidet, worauf sich eine Kategorie bezieht: normalerweise
  // auf die Typen, die im Modell wirklich vorkommen — sonst stuende ein Kopf
  // auf "teilweise", weil irgendein IfcTendon in der Typenliste noch aktiv
  // ist, den das Modell gar nicht kennt. Zeigt die Liste die ganze Typenliste
  // ("nur im Modell" aus), gilt eben diese.
  // ─────────────────────────────────────────────────────────────────────
  BimViewer.ifcTypenDerKategorie = function (kategorie, alleZeigen) {
    const gefunden = this.ifcFilter.gefundeneTypen;
    const nurGefundene = !alleZeigen && gefunden && gefunden.size > 0;
    const typen = new Set();
    IFC_ENTITIES.forEach(e => {
      if ((e.category || 'other') === kategorie) typen.add(e.entity);
    });
    return Array.from(typen).filter(t =>
      this.ifcFilter.allEntities.has(t) && (!nurGefundene || gefunden.has(t)));
  };

  /**
   * Zustand einer Kategorie: 'alle' | 'keine' | 'teilweise' | 'leer'.
   * 'leer' heisst: kein Typ dieser Kategorie ist bekannt.
   */
  BimViewer.ifcKategorieZustand = function (kategorie, alleZeigen) {
    const typen = this.ifcTypenDerKategorie(kategorie, alleZeigen);
    if (!typen.length) return 'leer';
    const an = typen.filter(t => this.ifcFilter.enabledEntities.has(t)).length;
    if (an === 0) return 'keine';
    if (an === typen.length) return 'alle';
    return 'teilweise';
  };

  BimViewer.setIFCCategory = function (kategorie, an, alleZeigen) {
    this.ifcTypenDerKategorie(kategorie, alleZeigen).forEach(t => {
      if (an) this.ifcFilter.enabledEntities.add(t);
      else this.ifcFilter.enabledEntities.delete(t);
    });
    if (typeof this.updateIFCFilterUI === 'function') this.updateIFCFilterUI();
    if (typeof this.applyIFCFilter === 'function') this.applyIFCFilter();
  };

  // Teilweise aktiv zaehlt als "an" — ein Klick schaltet die Kategorie dann
  // komplett aus, der naechste komplett ein.
  BimViewer.toggleIFCCategory = function (kategorie, alleZeigen) {
    const zustand = this.ifcKategorieZustand(kategorie, alleZeigen);
    this.setIFCCategory(kategorie, zustand === 'keine', alleZeigen);
  };

  // Genau eine Kategorie sichtbar lassen (Isolieren)
  BimViewer.isolateIFCCategory = function (kategorie, alleZeigen) {
    const kategorien = new Set();
    IFC_ENTITIES.forEach(e => kategorien.add(e.category || 'other'));
    kategorien.forEach(k => {
      this.ifcTypenDerKategorie(k, alleZeigen).forEach(t => {
        if (k === kategorie) this.ifcFilter.enabledEntities.add(t);
        else this.ifcFilter.enabledEntities.delete(t);
      });
    });
    if (typeof this.updateIFCFilterUI === 'function') this.updateIFCFilterUI();
    if (typeof this.applyIFCFilter === 'function') this.applyIFCFilter();
  };

  BimViewer.deselectAllIFCTypes = function () {
    this.ifcFilter.enabledEntities.clear();
    if (typeof this.updateIFCFilterUI === 'function') this.updateIFCFilterUI();
    if (typeof this.applyIFCFilter === 'function') this.applyIFCFilter();
    this.updateStatus('Alle IFC-Typen deaktiviert', 'success');
  };

  // allEntities initial aus IFC_ENTITIES befüllen (vor erstem Asset-Load)
  IFC_ENTITIES.forEach(e => {
    BimViewer.ifcFilter.allEntities.add(e.entity);
    BimViewer.ifcFilter.enabledEntities.add(e.entity);
  });

  // ─────────────────────────────────────────────────────────────────────
  // KLICK AUF EIN BAUTEIL
  // ─────────────────────────────────────────────────────────────────────

  BimViewer.initClickHandler = function () {
    if (this._klickHandler || !this.viewer) return;
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((klick) => this._bauteilKlick(klick.position),
                           Cesium.ScreenSpaceEventType.LEFT_CLICK);
    this._klickHandler = handler;
  };

  BimViewer._bauteilKlick = function (position) {
    if (!this.viewer) return;
    if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled && WalkMode.isEnabled()) {
      return;
    }
    // Im Ausblendmodus heißt ein Klick „weg damit", nicht „zeig mir das".
    if (this.hiddenFeatures.isHideMode) {
      this._unterZeigerAusblenden(position);
      return;
    }
    // Solange die Schnittbox auf ihr Bauteil wartet, gehört der Klick ihr:
    // sonst öffnete derselbe Klick zusätzlich die Eigenschaftsanzeige und
    // färbte das Bauteil ein, das gleich hinter einer Box verschwindet.
    if (this.SectionBox && this.SectionBox.faengtKlick()) {
      return;
    }
    // Und ebenso, solange eine Bildebene auf ihre Stelle wartet: der Klick
    // legt dort ein Bild ab und soll nicht zugleich das Bauteil darunter
    // auswählen, das gleich verdeckt ist.
    if (this.Bildebenen && this.Bildebenen.faengtKlick()) {
      return;
    }

    const picked = this.viewer.scene.pick(position);
    this._auswahlZuruecksetzen();

    if (!(picked instanceof Cesium.Cesium3DTileFeature)) {
      this.closeInfoBox();
      return;
    }
    // Die amtlichen Gebäudeebenen (layerManager.js) beantworten ihren Klick
    // selbst, mit ALKIS-Klartext statt roher Batch Table.
    if (window.LayerManager && LayerManager.tilesetLayers.some((t) => t.tileset === picked.tileset)) {
      return;
    }

    // Eine laufende Isolierung gilt dem vorigen Bauteil
    if (this.isIsolated) {
      this.showAll();
    }

    this.selectedFeature = picked;
    try {
      this._auswahlVorher = Cesium.Color.clone(picked.color);
      picked.color = Cesium.Color.LIME;
    } catch (e) { /* Feature ohne Farbe (Punktwolke) */ }

    const properties = {};
    let ids = [];
    try { ids = picked.getPropertyIds() || []; } catch (e) { /* ohne Batch Table */ }
    ids.forEach((id) => {
      try {
        const wert = picked.getProperty(id);
        if (wert !== undefined && wert !== null && wert !== '') properties[id] = wert;
      } catch (e) { /* einzelnes Merkmal nicht lesbar */ }
    });
    this.displayIFCProperties(properties);
  };

  BimViewer._auswahlZuruecksetzen = function () {
    const vorher = this.selectedFeature;
    if (vorher && this._auswahlVorher) {
      try {
        const tileset = vorher.tileset;
        if (!tileset || !tileset.isDestroyed || !tileset.isDestroyed()) vorher.color = this._auswahlVorher;
      } catch (e) { /* Content inzwischen entladen */ }
    }
    this.selectedFeature = null;
    this._auswahlVorher = null;
  };

  // ─────────────────────────────────────────────────────────────────────
  // EIGENSCHAFTSANZEIGE
  // ─────────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  BimViewer.displayIFCProperties = function (properties) {
    // Rollenbasierte Anzeige: kuratierte Gruppen je Benutzerrolle, angereichert
    // um die vollständigen Property-Sets aus der Bauteildatenbank
    // (siehe ifc-role-properties.js). Der Block darunter greift nur, solange
    // das Modul nicht geladen ist.
    if (window.IFCRoleProperties) {
      IFCRoleProperties.display(properties);
      const rolePanel = document.getElementById('infoBoxPanel');
      if (rolePanel) rolePanel.classList.add('visible');
      return;
    }

    const koerper = document.getElementById('infoBoxCustom');
    const panel = document.getElementById('infoBoxPanel');
    if (!koerper || !panel) return;
    const eintraege = Object.entries(properties || {}).filter(([k]) => !k.startsWith('_'));
    koerper.innerHTML = eintraege.length
      ? '<div class="props-container">' + eintraege.map(([k, v]) =>
          '<div class="props-row"><span class="props-key">' + esc(k) + '</span>' +
          '<span class="props-value">' + esc(v) + '</span></div>').join('') + '</div>'
      : '<div class="props-empty">Keine Eigenschaften</div>';
    panel.classList.add('visible');
  };

  BimViewer.closeInfoBox = function () {
    const panel = document.getElementById('infoBoxPanel');
    if (panel) panel.classList.remove('visible');
    this._auswahlZuruecksetzen();
  };

  // ─────────────────────────────────────────────────────────────────────
  // AUSBLENDEN
  //
  // Klick auf ein Bauteil blendet es aus (H schaltet den Modus, Umschalt+H
  // holt alles zurück). Gemerkt wird die GlobalId, wo es eine gibt: ein
  // Feature-Objekt überlebt das Entladen seiner Kachel nicht, die GlobalId
  // schon — nachgeladene Kacheln werden beim Eintreffen wieder bereinigt.
  // ─────────────────────────────────────────────────────────────────────

  BimViewer.hiddenFeatures = {
    isHideMode: false,
    eintraege: []          // { tileset, guidEigenschaft, guid, feature }
  };

  function contentsDurchlaufen(tileset, callback) {
    const besuche = (content) => {
      if (!content) return;
      if (content.innerContents && content.innerContents.length) {
        content.innerContents.forEach(besuche);
        return;
      }
      if (content.featuresLength) callback(content);
    };
    const stapel = tileset && tileset.root ? [tileset.root] : [];
    while (stapel.length) {
      const tile = stapel.pop();
      besuche(tile.content);
      if (tile.children) for (let i = 0; i < tile.children.length; i++) stapel.push(tile.children[i]);
    }
  }

  BimViewer.initHideFeatures = function () {
    if (this._hideTastenAktiv) return;
    this._hideTastenAktiv = true;
    document.addEventListener('keydown', (ereignis) => {
      const ziel = ereignis.target;
      if (ziel && (ziel.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ziel.tagName))) return;
      if (ereignis.ctrlKey || ereignis.metaKey || ereignis.altKey) return;
      if (ereignis.key === 'h' || ereignis.key === 'H') {
        if (ereignis.shiftKey) this.showAllHidden();
        else this.toggleHideMode();
      } else if (ereignis.key === 'Escape' && this.hiddenFeatures.isHideMode) {
        this.toggleHideMode();
      }
    });
  };

  BimViewer.toggleHideMode = function () {
    const zustand = this.hiddenFeatures;
    zustand.isHideMode = !zustand.isHideMode;
    const knopf = document.getElementById('toggleHideMode');
    if (knopf) knopf.classList.toggle('active', zustand.isHideMode);
    this.updateModeIndicator();
    if (zustand.isHideMode) this.closeInfoBox();
    this.updateStatus(zustand.isHideMode
      ? 'Ausblenden: Bauteile anklicken (Esc beendet)'
      : 'Ausblenden beendet', 'info');
  };

  BimViewer._unterZeigerAusblenden = function (position) {
    const picked = this.viewer.scene.pick(position);
    if (!(picked instanceof Cesium.Cesium3DTileFeature)) return;
    const tileset = picked.tileset;
    const asset = Array.from(this.loadedAssets.values()).find((a) => a.tileset === tileset);
    if (asset) this._guidEigenschaftMerken(asset);
    const eigenschaft = asset && asset.guidPropertyName;
    let guid = null;
    try { guid = eigenschaft ? picked.getProperty(eigenschaft) : null; } catch (e) { /* ohne GlobalId */ }

    picked.show = false;
    this.hiddenFeatures.eintraege.push({ tileset, guidEigenschaft: eigenschaft, guid, feature: picked });
    if (tileset && !tileset._ileenAusblendHaken) {
      tileset._ileenAusblendHaken = true;
      tileset.tileLoad.addEventListener(() => this.reapplyHiddenFeatures());
    }
    this._ausgeblendetZaehlen();
  };

  BimViewer.reapplyHiddenFeatures = function () {
    const eintraege = this.hiddenFeatures.eintraege;
    if (!eintraege.length) return;
    const jeTileset = new Map();
    eintraege.forEach((e) => {
      if (e.guid && e.guidEigenschaft) {
        if (!jeTileset.has(e.tileset)) jeTileset.set(e.tileset, { eigenschaft: e.guidEigenschaft, ids: new Set() });
        jeTileset.get(e.tileset).ids.add(e.guid);
      } else if (e.feature) {
        try { e.feature.show = false; } catch (fehler) { /* Kachel entladen */ }
      }
    });
    jeTileset.forEach(({ eigenschaft, ids }, tileset) => {
      if (tileset.isDestroyed && tileset.isDestroyed()) return;
      contentsDurchlaufen(tileset, (content) => {
        for (let i = 0; i < content.featuresLength; i++) {
          try {
            const f = content.getFeature(i);
            if (ids.has(f.getProperty(eigenschaft))) f.show = false;
          } catch (fehler) { break; }
        }
      });
    });
  };

  BimViewer.showAllHidden = function () {
    const eintraege = this.hiddenFeatures.eintraege;
    const jeTileset = new Map();
    eintraege.forEach((e) => {
      try { if (e.feature) e.feature.show = true; } catch (fehler) { /* Kachel entladen */ }
      if (e.guid && e.guidEigenschaft) {
        if (!jeTileset.has(e.tileset)) jeTileset.set(e.tileset, { eigenschaft: e.guidEigenschaft, ids: new Set() });
        jeTileset.get(e.tileset).ids.add(e.guid);
      }
    });
    this.hiddenFeatures.eintraege = [];
    jeTileset.forEach(({ eigenschaft, ids }, tileset) => {
      if (tileset.isDestroyed && tileset.isDestroyed()) return;
      contentsDurchlaufen(tileset, (content) => {
        for (let i = 0; i < content.featuresLength; i++) {
          try {
            const f = content.getFeature(i);
            if (ids.has(f.getProperty(eigenschaft))) f.show = true;
          } catch (fehler) { break; }
        }
      });
    });
    // Der Filterstil entscheidet wieder allein, was zu sehen ist
    if (typeof this.applyIFCFilter === 'function') this.applyIFCFilter();
    this._ausgeblendetZaehlen();
    this.updateStatus('Alle ausgeblendeten Bauteile wieder sichtbar', 'success');
  };

  BimViewer._ausgeblendetZaehlen = function () {
    const n = this.hiddenFeatures.eintraege.length;
    const badge = document.getElementById('hiddenFeaturesCount');
    if (badge) {
      badge.textContent = n;
      badge.style.display = n ? '' : 'none';
    }
  };

  // ─────────────────────────────────────────────────────────────────────
  // START
  // ─────────────────────────────────────────────────────────────────────

  BimViewer.initFeatures = function () {
    this.initClickHandler();
    this.initHideFeatures();
    document.addEventListener('keydown', (ereignis) => {
      if (ereignis.key !== 'Escape') return;
      const ziel = ereignis.target;
      if (ziel && /^(INPUT|TEXTAREA|SELECT)$/.test(ziel.tagName)) return;
      if (!this.hiddenFeatures.isHideMode) this.closeInfoBox();
    });
  };

  // ─────────────────────────────────────────────────────────────────────
  // ISOLATE FEATURE
  // ─────────────────────────────────────────────────────────────────────
  BimViewer.isIsolated = false;

  BimViewer.toggleIsolate = function () {
    if (!this.selectedFeature) {
      this.updateStatus('Select an element to isolate', 'error');
      return;
    }

    if (!this.isIsolated) {
      this.isolateSelected();
    } else {
      this.showAll();
    }
  };

  BimViewer.isolateSelected = function () {
    if (!this.selectedFeature) return;
    this.isIsolated = true;

    const pickedFeature = this.selectedFeature;
    const tileset = pickedFeature.tileset;
    const andereAusblenden = () => {
      this.loadedAssets.forEach(asset => {
        if (asset.tileset && asset.tileset !== tileset) asset.tileset.show = false;
      });
    };

    // Try IFC GlobalId first (Cesium Ion IFC tiler), then fallback to other id fields
    const globalId = pickedFeature.getProperty('GlobalId') || pickedFeature.getProperty('globalId');
    const elemId   = pickedFeature.getProperty('id') || pickedFeature.getProperty('elementId');

    if (globalId !== undefined) {
      tileset.style = new Cesium.Cesium3DTileStyle({
        show: `\${'GlobalId'} === '${globalId}'`
      });
      andereAusblenden();
      this.updateStatus('Element isolated', 'success');
    } else if (elemId !== undefined) {
      const propName = pickedFeature.getProperty('id') !== undefined ? 'id' : 'elementId';
      tileset.style = new Cesium.Cesium3DTileStyle({
        show: `\${${propName}} === ${typeof elemId === 'string' ? "'" + elemId + "'" : elemId}`
      });
      andereAusblenden();
      this.updateStatus('Element isolated', 'success');
    } else {
      // No unique ID — hide all other tilesets, show selected tileset fully
      andereAusblenden();
      this.updateStatus('Asset isolated (no element ID found)', 'warning');
    }

    const btn = document.querySelector('.isolate-btn');
    if (btn) {
      btn.innerHTML = '🔄 Show All';
      btn.classList.add('active');
    }
  };

  BimViewer.showAll = function () {
    this.isIsolated = false;

    // Restore all tilesets
    this.loadedAssets.forEach(asset => {
      if (asset.tileset) {
        asset.tileset.show = asset.visible !== false;
        // Restore style
        if (!asset.ifcPropertyName) {
           asset.tileset.style = undefined;
        }
      }
    });
    if (typeof this.applyIFCFilter === 'function') this.applyIFCFilter();

    const btn = document.querySelector('.isolate-btn');
    if (btn) {
      btn.innerHTML = '🎯 Isolate';
      btn.classList.remove('active');
    }
    this.updateStatus('All elements visible', 'success');
  };
})();
