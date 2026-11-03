/**
 * iLEEN — Gelände ohne Cesium ion
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Ersetzt Cesium World Terrain (ion-Asset 1) durch zwei frei abrufbare
 * Quellen, die erst hier im Browser zu einem Gelände werden:
 *
 *   · Deutschland: basemap.de 3D Gelände — das ATKIS-DGM5 der Länder, vom
 *     BKG als heightmap-1.0 ausgeliefert (65 × 65 Stützstellen je Kachel,
 *     bis Ebene 16, also rund 4 m Abstand).
 *   · Überall sonst: Terrain Tiles (Mapzen/Tilezen, AWS Open Data) im
 *     Terrarium-Format — PNG-Kacheln in Web Mercator aus SRTM, EU-DEM,
 *     GMTED2010, ETOPO1 u. a.
 *
 * **Beide Quellen liefern Höhen über dem Meer, Cesium rechnet über dem
 * Ellipsoid.** basemap.de gibt am Mainzer Rheinufer 85,8 m aus — als
 * Ellipsoidhöhe gelesen läge das Gelände 48 m unter jedem IFC-Modell, das
 * richtig steht. Jede Stützstelle bekommt deshalb die EGM96-Undulation aus
 * geoid.js aufgeschlagen: dieselbe, mit der Backend und Viewer Modelle „über
 * NN“ platzieren. Gegen GCG2016, den amtlichen Bezug von NHN, bleibt ein
 * Restfehler unter einem Meter — aber er wirkt auf Modell und Gelände
 * gleich, und darauf kommt es an.
 *
 * **Die Grenze.** basemap.de füllt Kacheln außerhalb Deutschlands mit
 * genau 0,0 m (Rohwert 5000). Diese Stützstellen — und nur sie — kommen aus
 * Terrain Tiles. Straßburg liegt so auf 140 m und nicht auf einer Klippe
 * hinter Kehl.
 *
 * **Meer.** Terrain Tiles führen über See die Bathymetrie; ein Luftbild
 * darübergelegt zeigte Häfen als Gräben. Außerhalb des DGM5 wird deshalb auf
 * den Meeresspiegel begrenzt. Was dabei verloren geht, sind Senken unter
 * Meeresniveau im Ausland (Polder, Totes Meer); in Deutschland stehen die
 * echten Werte aus dem DGM5.
 *
 * **Normalen.** Ausgeliefert wird ein Quantized Mesh mit selbst gerechneten
 * Vertexnormalen, nicht die Heightmap. Ohne Normalen beleuchtet Cesium das
 * Gelände mit der Ellipsoidnormale: ein Hang wirft dann weder Licht noch
 * Schatten. An der Kachelkante wird einseitig differenziert — die
 * Nachbarkachel ist nicht geladen.
 *
 * **Lizenz basemap.de 3D (Beta):** Nutzung über den Dienst, Speichern nur
 * zur Laufzeit, Quellenvermerk „© GeoBasis-DE/BKG <Jahr>“ mit
 * Veränderungshinweis. Deshalb rechnet der Browser um, und das Backend hält
 * keine Kopie dieser Kacheln.
 */
'use strict';

window.ILeenGelaende = (function () {
  const DGM5_URL = 'https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gelaende/dgm5_4326_mesh/';
  const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';

  const KANTE = 65;              // Stützstellen je Kachelkante (wie heightmap-1.0)
  const MAX_EBENE = 16;          // tiefste Ebene von basemap.de; darunter teilt Cesium selbst
  const DGM1_MAX_EBENE = 18;     // DGM1 RLP aus dem eigenen Backend: Ebene 18 ≈ 0,75 m Stützstellenabstand
  const DGM1_INFO_FRIST = 3000;  // ms; antwortet das Backend nicht, geht es ohne DGM1 weiter
  const TERRARIUM_MAX_Z = 15;
  const DGM_LEER = 5000;         // Rohwert für 0,0 m: basemap.de außerhalb Deutschlands
  const TERRARIUM_VORRAT = 96;   // dekodierte Terrarium-Kacheln im Speicher (je 256 KB)
  const LAYER_WARTEZEIT = 4000;  // ms; so lange darf layer.json brauchen, sonst bleibt es bei Terrain Tiles allein
  const LAYER_ERSTWARTE = 1000;  // ms; so lange hält layer.json den Start auf, danach startet der Viewer ohne und bekommt es nachgereicht
  const KACHEL_FRIST = 5000;     // ms je DGM5-Kachel; danach springen Terrain Tiles ein
  const AUSFALL_NACH = 3;        // so viele Fehlschläge am Stück → basemap.de gilt als ausgefallen
  const AUSFALL_PAUSE = 120000;  // ms ohne basemap.de, danach ein neuer Versuch
  const MERCATOR_GRENZE = 85.05112878;

  // ── Abruf und Dekodierung ───────────────────────────────────────────

  /**
   * Antwort von /gelaende/dgm1/{z}/{x}/{y}: 65 × 65 Float32, Reihe 0 im Süden, m ü. NHN,
   * NaN wo das DGM1 nichts hat. 204 (ganz außerhalb) kommt leer an → null.
   */
  function dgm1Lesen(puffer) {
    if (!puffer || puffer.byteLength < KANTE * KANTE * 4) return null;
    return new Float32Array(puffer, 0, KANTE * KANTE);
  }

  /**
   * Über Cesium.Resource, damit der Abruf in Cesiums Drosselung läuft:
   * mit `request` kommt bei voller Warteschlange `undefined` zurück, und
   * Cesium fragt die Kachel später erneut an.
   */
  function holenUeberCesium(url, request) {
    return new Cesium.Resource({ url: url, request: request }).fetchArrayBuffer();
  }

  /**
   * Ein Abruf, der nie antwortet, wirft keinen Fehler — er hängt. Am
   * 2026-10-31 nahm der Server des BKG keine Verbindung mehr an: jede
   * DGM5-Kachel blieb offen, die 18 Plätze, die Cesium einem Server gibt,
   * waren belegt, und weil Cesium eine Geländekachel erst verfeinert, wenn
   * ihr Gelände da ist, blieb unter ~500 m der ganze Globus auf Ebene 10
   * stehen. Gecachte Kacheln (und `layer.json`) verdeckten das.
   *
   * Nach der Frist wird der Abruf über `request.cancel()` abgebrochen — das
   * gibt Cesiums Platz frei — und das Versprechen mit `abgelaufen` verworfen.
   */
  function mitFrist(abruf, ms, request) {
    let uhr;
    const frist = new Promise((_, nein) => {
      uhr = setTimeout(() => {
        if (request && typeof request.cancel === 'function') request.cancel();
        const fehler = new Error('keine Antwort nach ' + ms / 1000 + ' s');
        fehler.abgelaufen = true;
        nein(fehler);
      }, ms);
    });
    return Promise.race([abruf, frist]).finally(() => clearTimeout(uhr));
  }

  /** PNG → RGBA-Pixel, ohne Farbraumumrechnung (sonst verschieben sich die Höhen). */
  async function bildLesen(puffer) {
    const bild = await createImageBitmap(new Blob([puffer], { type: 'image/png' }),
                                         { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const leinwand = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bild.width, bild.height)
      : Object.assign(document.createElement('canvas'), { width: bild.width, height: bild.height });
    const ctx = leinwand.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bild, 0, 0);
    if (bild.close) bild.close();
    const pixel = ctx.getImageData(0, 0, leinwand.width, leinwand.height);
    return { width: pixel.width, height: pixel.height, data: pixel.data };
  }

  /** Terrarium: h = R·256 + G + B/256 − 32768 (Meter über dem Meer). */
  function terrariumLesen(bild) {
    const anzahl = bild.width * bild.height;
    const hoehen = new Float32Array(anzahl);
    const d = bild.data;
    for (let k = 0; k < anzahl; k++) {
      hoehen[k] = d[4 * k] * 256 + d[4 * k + 1] + d[4 * k + 2] / 256 - 32768;
    }
    return { breite: bild.width, hoehe: bild.height, hoehen: hoehen };
  }

  /**
   * heightmap-1.0: 65 × 65 vorzeichenlose 16-Bit-Werte, Zeile 0 im Norden,
   * Höhe = Wert/5 − 1000. Dahinter ein Byte Kindmaske und die Wassermaske.
   * Gzip ohne Content-Encoding (bei manchen Terrain-Servern üblich) wird hier
   * ausgepackt, sonst läse man Kompressionsbytes als Höhen.
   */
  async function dgmLesen(puffer) {
    if (!puffer) return null;
    let bytes = new Uint8Array(puffer);
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const strom = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(strom).arrayBuffer());
    }
    if (bytes.byteLength < KANTE * KANTE * 2) return null;
    // Kopie auf eigenem, ausgerichtetem Puffer: Uint16Array verlangt gerade Offsets
    return new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + KANTE * KANTE * 2));
  }

  function mercatorY(latGrad, pixelGesamt) {
    const b = Cesium.Math.toRadians(Math.max(-MERCATOR_GRENZE, Math.min(MERCATOR_GRENZE, latGrad)));
    return (1 - Math.log(Math.tan(b) + 1 / Math.cos(b)) / Math.PI) / 2 * pixelGesamt;
  }

  function mercatorX(lonGrad, pixelGesamt) {
    return (lonGrad + 180) / 360 * pixelGesamt;
  }

  /** Zoomstufe, deren Pixel nicht gröber ist als der Stützstellenabstand. */
  function terrariumZoom(abstandGrad) {
    const z = Math.ceil(Math.log2(360 / (256 * abstandGrad)));
    return Math.max(0, Math.min(TERRARIUM_MAX_Z, z));
  }

  // ── Der Provider ────────────────────────────────────────────────────

  function Provider(opt) {
    this._tilingScheme = new Cesium.GeographicTilingScheme();
    this._ellipsoid = this._tilingScheme.ellipsoid;
    this._errorEvent = new Cesium.Event();
    this._occluder = new Cesium.EllipsoidalOccluder(this._ellipsoid);
    this._fehlerEbene0 = Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this._ellipsoid, KANTE, this._tilingScheme.getNumberOfXTilesAtLevel(0));

    // Überall Daten bis Ebene 16 — ohne Verfügbarkeitstabelle lehnt
    // sampleTerrainMostDetailed (terrain-align.js) den Provider ab.
    const dgm1 = opt.dgm1 && Cesium.Rectangle.fromDegrees(...opt.dgm1.grenzen);
    this._availability = new Cesium.TileAvailability(this._tilingScheme, dgm1 ? DGM1_MAX_EBENE : MAX_EBENE);
    for (let l = 0; l <= MAX_EBENE; l++) {
      this._availability.addAvailableTileRange(l, 0, 0,
        this._tilingScheme.getNumberOfXTilesAtLevel(l) - 1,
        this._tilingScheme.getNumberOfYTilesAtLevel(l) - 1);
    }
    // Feiner als das DGM5 nur dort, wo das DGM1 liegt (Rechteck um Rheinland-Pfalz)
    if (dgm1) {
      for (let l = MAX_EBENE + 1; l <= DGM1_MAX_EBENE; l++) {
        const nw = this._tilingScheme.positionToTileXY(Cesium.Rectangle.northwest(dgm1), l);
        const so = this._tilingScheme.positionToTileXY(Cesium.Rectangle.southeast(dgm1), l);
        this._availability.addAvailableTileRange(l, nw.x, nw.y, so.x, so.y);
      }
    }

    this._dgm = opt.dgm || null;              // { verfuegbar, version } aus layer.json
    this._undulation = opt.undulation;         // (latGrad, lonGrad) → N in m
    this._holen = opt.holen || holenUeberCesium;
    this._bild = opt.bild || bildLesen;
    this._terrarium = new Map();               // 'z/x/y' → Promise<Kachel>, älteste zuerst
    this._frist = opt.frist || KACHEL_FRIST;
    this._dgm1 = opt.dgm1 || null;             // { basis, grenzen: [W, S, O, N] Grad } aus /gelaende/dgm1/info
    this._dgm1Rechteck = this._dgm1 && Cesium.Rectangle.fromDegrees(...this._dgm1.grenzen);
    this._dgm1FehlFolge = 0;
    this._dgm1AusBis = 0;
    this._fehlFolge = 0;                       // DGM5-Fehlschläge am Stück
    this._ausBis = 0;                          // bis dahin kein Abruf bei basemap.de

    const jahr = new Date().getFullYear();
    this._creditDgm = new Cesium.Credit('Gelände Deutschland: © GeoBasis-DE/BKG ' + jahr +
      ' (basemap.de 3D, verändert: Höhen auf das WGS84-Ellipsoid umgerechnet)');
    this._creditDgm1 = new Cesium.Credit('Gelände Rheinland-Pfalz: DGM1 © GeoBasis-DE / LVermGeoRP (2022–2025), ' +
      'dl-de/by-2-0 (verändert: Höhen auf das WGS84-Ellipsoid umgerechnet)');
    this._creditWelt = new Cesium.Credit('Gelände: Terrain Tiles (Mapzen/Tilezen, AWS Open Data; ' +
      'SRTM, EU-DEM, GMTED2010, ETOPO1 u. a.)');
  }

  Object.defineProperties(Provider.prototype, {
    errorEvent: { get() { return this._errorEvent; } },
    // Kein Sammelvermerk: jede Kachel führt den ihrer Quelle, damit über
    // Frankreich nicht das BKG steht.
    credit: { get() { return undefined; } },
    tilingScheme: { get() { return this._tilingScheme; } },
    hasWaterMask: { get() { return false; } },
    hasVertexNormals: { get() { return true; } },
    availability: { get() { return this._availability; } },
    /** Für Anzeige und Prüfsteine: welche Quellen tatsächlich angebunden sind. */
    quellen: { get() { return { dgm1: !!this._dgm1, dgm5: !!this._dgm, terrainTiles: true }; } }
  });

  Provider.prototype.getLevelMaximumGeometricError = function (level) {
    return this._fehlerEbene0 / (1 << level);
  };

  Provider.prototype.getTileDataAvailable = function (x, y, level) {
    if (level <= MAX_EBENE) return true;
    return level <= DGM1_MAX_EBENE && !!this._dgm1Rechteck &&
      !!Cesium.Rectangle.intersection(this._tilingScheme.tileXYToRectangle(x, y, level), this._dgm1Rechteck);
  };

  /** Reicht das DGM1 in diese Kachel, und antwortet das Backend gerade? */
  Provider.prototype._dgm1Da = function (rechteck, level) {
    if (!this._dgm1Rechteck || level > DGM1_MAX_EBENE) return false;
    if (this._dgm1AusBis && Date.now() < this._dgm1AusBis) return false;
    return !!Cesium.Rectangle.intersection(rechteck, this._dgm1Rechteck);
  };

  Provider.prototype.loadTileDataAvailability = function () {
    return undefined;
  };

  /** Liegt die Kachel (TMS-Zählung) im Bestand von basemap.de? */
  Provider.prototype._dgmDa = function (x, tmsY, level) {
    if (!this._dgm || level > MAX_EBENE) return false;
    if (this._ausBis && Date.now() < this._ausBis) return false;
    const bereiche = this._dgm.verfuegbar[level];
    if (!bereiche) return false;
    return bereiche.some((b) => x >= b.startX && x <= b.endX && tmsY >= b.startY && tmsY <= b.endY);
  };

  Provider.prototype.requestTileGeometry = function (x, y, level, request) {
    const rechteck = this._tilingScheme.tileXYToRectangle(x, y, level);
    // Cesium zählt y von Norden, basemap.de (schema "tms") von Süden.
    const tmsY = this._tilingScheme.getNumberOfYTilesAtLevel(level) - 1 - y;

    // Zuerst das DGM1 RLP aus dem eigenen Backend (gleiche Kachelzählung wie Cesium); wo es Lücken
    // lässt (außerhalb von RLP), springen DGM5 und Terrain Tiles ein — dann ohne Cesiums Drosselung,
    // die gilt für genau eine Anfrage.
    if (this._dgm1Da(rechteck, level)) {
      const abruf = this._holen(this._dgm1.basis + '/' + level + '/' + x + '/' + y, request);
      if (!abruf) return undefined;
      return mitFrist(Promise.resolve(abruf), this._frist, request)
        .then((puffer) => { this._dgm1FehlFolge = 0; return dgm1Lesen(puffer); })
        .catch((fehler) => {
          const vonCesium = !(fehler && fehler.abgelaufen) && request &&
            Cesium.RequestState && request.state === Cesium.RequestState.CANCELLED;
          if (!vonCesium && ++this._dgm1FehlFolge >= AUSFALL_NACH) {
            this._dgm1AusBis = Date.now() + AUSFALL_PAUSE;
            this._dgm1FehlFolge = 0;
            console.warn('[Gelände] DGM1 (Backend) antwortet nicht — für ' + AUSFALL_PAUSE / 60000 + ' min ohne:',
                         fehler && fehler.message);
          }
          return null;
        })
        .then((dgm1) => this._ohneDgm1(x, tmsY, rechteck, level, undefined, dgm1));
    }
    return this._ohneDgm1(x, tmsY, rechteck, level, request, null);
  };

  /** DGM5 und Terrain Tiles für alles, was das DGM1 nicht abdeckt. */
  Provider.prototype._ohneDgm1 = function (x, tmsY, rechteck, level, request, dgm1) {
    const voll = dgm1 && dgm1.every(Number.isFinite);
    if (!voll && this._dgmDa(x, tmsY, level)) {
      const abruf = this._holen(DGM5_URL + level + '/' + x + '/' + tmsY + '.terrain?v=' + this._dgm.version, request);
      if (!abruf) return undefined;
      return mitFrist(Promise.resolve(abruf), this._frist, request)
        .then((puffer) => { this._fehlFolge = 0; return dgmLesen(puffer); })
        .catch((fehler) => {
          // Von Cesium abgebrochen (Kachel nicht mehr im Bild): kein Ausfall
          const vonCesium = !(fehler && fehler.abgelaufen) && request &&
            Cesium.RequestState && request.state === Cesium.RequestState.CANCELLED;
          if (!vonCesium) this._fehlschlag(fehler);
          console.warn('[Gelände] DGM5-Kachel ' + level + '/' + x + '/' + tmsY + ' fehlt, Terrain Tiles springen ein:',
                       fehler && fehler.message);
          return null;
        })
        .then((dgm) => this._zusammensetzen(rechteck, level, dgm, undefined, dgm1));
    }
    return this._zusammensetzen(rechteck, level, null, request, dgm1);
  };

  /**
   * Nach `AUSFALL_NACH` Fehlschlägen am Stück fragt der Provider basemap.de
   * für `AUSFALL_PAUSE` gar nicht mehr und nimmt Terrain Tiles allein — sonst
   * wartete jede neue Kachel erst ihre Frist ab. Danach ein neuer Versuch.
   */
  Provider.prototype._fehlschlag = function (fehler) {
    this._fehlFolge++;
    if (this._fehlFolge < AUSFALL_NACH || (this._ausBis && Date.now() < this._ausBis)) return;
    this._ausBis = Date.now() + AUSFALL_PAUSE;
    this._fehlFolge = 0;
    const text = 'Gelände: basemap.de (BKG) antwortet nicht — für ' + AUSFALL_PAUSE / 60000 +
      ' min Terrain Tiles (gröber)';
    console.warn('[Gelände] ' + text + ':', fehler && fehler.message);
    try {
      if (window.BimViewer && typeof BimViewer.updateStatus === 'function') BimViewer.updateStatus('⚠️ ' + text, 'warning');
    } catch (e) { /* Statuszeile fehlt */ }
  };

  /** Für Anzeige und Prüfsteine: Stand des Ausfallschalters. */
  Provider.prototype.dgmStand = function () {
    return { dgm5: !!this._dgm, aus: !!(this._ausBis && Date.now() < this._ausBis),
             ausBis: this._ausBis, fehlFolge: this._fehlFolge };
  };

  /**
   * Höhen über dem Meer für alle 65 × 65 Stützstellen — aus dem DGM5, wo es
   * Daten hat, sonst aus Terrain Tiles. Index j·65 + i, j = 0 im Süden.
   * Gibt `undefined` zurück, wenn Cesium den ersten Abruf gedrosselt hat.
   */
  Provider.prototype._zusammensetzen = function (rechteck, level, dgm, request, dgm1) {
    const n = KANTE;
    const meer = new Float64Array(n * n);
    const offen = [];
    let ausDgm1 = 0, ausDgm5 = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (dgm1 && Number.isFinite(dgm1[k])) { meer[k] = dgm1[k]; ausDgm1++; continue; }
        const roh = dgm ? dgm[(n - 1 - j) * n + i] : DGM_LEER;
        if (roh === DGM_LEER) offen.push(k);
        else { meer[k] = roh / 5 - 1000; ausDgm5++; }
      }
    }

    const credits = [];
    if (ausDgm1) credits.push(this._creditDgm1);
    if (ausDgm5) credits.push(this._creditDgm);
    if (!offen.length) return Promise.resolve(this._netz(rechteck, level, meer, credits));

    const abtaster = this._weltAbtaster(rechteck, request);
    if (!abtaster) return undefined;
    credits.push(this._creditWelt);

    const west = Cesium.Math.toDegrees(rechteck.west);
    const sued = Cesium.Math.toDegrees(rechteck.south);
    const dLon = Cesium.Math.toDegrees(rechteck.width) / (n - 1);
    const dLat = Cesium.Math.toDegrees(rechteck.height) / (n - 1);
    return abtaster.then((hoeheBei) => {
      for (const k of offen) {
        const i = k % n;
        const j = (k - i) / n;
        meer[k] = Math.max(0, hoeheBei(west + i * dLon, sued + j * dLat));
      }
      return this._netz(rechteck, level, meer, credits);
    });
  };

  /**
   * Lädt die Terrain-Tiles-Kacheln unter einem Rechteck und gibt eine
   * bilineare Abtastfunktion (lon, lat) → Höhe zurück. Nur der erste noch
   * fehlende Abruf läuft über Cesiums Drosselung (`request` gilt für genau
   * eine URL); die übrigen hängen sich an.
   */
  Provider.prototype._weltAbtaster = function (rechteck, request) {
    const westG = Cesium.Math.toDegrees(rechteck.west);
    const ostG = Cesium.Math.toDegrees(rechteck.east);
    const suedG = Cesium.Math.toDegrees(rechteck.south);
    const nordG = Cesium.Math.toDegrees(rechteck.north);
    const z = terrariumZoom((ostG - westG) / (KANTE - 1));
    const anzahl = 1 << z;
    const gesamt = anzahl * 256;

    const x0 = Math.floor((mercatorX(westG, gesamt) - 1) / 256);
    const x1 = Math.floor((mercatorX(ostG, gesamt) + 1) / 256);
    const y0 = Math.max(0, Math.floor((mercatorY(nordG, gesamt) - 1) / 256));
    const y1 = Math.min(anzahl - 1, Math.floor((mercatorY(suedG, gesamt) + 1) / 256));

    const kacheln = new Map();
    const warten = [];
    let gedrosselt = false;
    for (let ty = y0; ty <= y1 && !gedrosselt; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % anzahl) + anzahl) % anzahl;
        const schluessel = wx + '/' + ty;
        if (kacheln.has(schluessel)) continue;
        const neu = !this._terrarium.has(z + '/' + schluessel);
        const p = this._terrariumKachel(z, wx, ty, neu ? request : undefined);
        if (!p) { gedrosselt = true; break; }
        if (neu) request = undefined;
        kacheln.set(schluessel, null);
        warten.push(p.then((kachel) => kacheln.set(schluessel, kachel)));
      }
    }
    if (gedrosselt) return undefined;

    return Promise.all(warten).then(() => {
      function wert(gx, gy) {
        gy = Math.max(0, Math.min(gesamt - 1, gy));
        gx = ((gx % gesamt) + gesamt) % gesamt;
        const tx = Math.floor(gx / 256);
        const ty = Math.floor(gy / 256);
        const kachel = kacheln.get(tx + '/' + ty);
        return kachel.hoehen[(gy - ty * 256) * kachel.breite + (gx - tx * 256)];
      }
      return function (lon, lat) {
        // Pixelmitten liegen auf halben Koordinaten
        const fx = mercatorX(lon, gesamt) - 0.5;
        const fy = mercatorY(lat, gesamt) - 0.5;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const ax = fx - ix;
        const ay = fy - iy;
        return wert(ix, iy) * (1 - ax) * (1 - ay) + wert(ix + 1, iy) * ax * (1 - ay) +
               wert(ix, iy + 1) * (1 - ax) * ay + wert(ix + 1, iy + 1) * ax * ay;
      };
    });
  };

  Provider.prototype._terrariumKachel = function (z, x, y, request) {
    const schluessel = z + '/' + x + '/' + y;
    let eintrag = this._terrarium.get(schluessel);
    if (eintrag) {
      // Zuletzt benutzt ans Ende — die Map ist die Altersreihenfolge
      this._terrarium.delete(schluessel);
      this._terrarium.set(schluessel, eintrag);
      return eintrag;
    }
    const abruf = this._holen(TERRARIUM_URL + schluessel + '.png', request);
    if (!abruf) return undefined;
    eintrag = Promise.resolve(abruf).then((puffer) => this._bild(puffer)).then(terrariumLesen);
    // Ein Fehlschlag bleibt nicht im Vorrat stehen, sonst käme die Kachel nie wieder
    eintrag.catch(() => { if (this._terrarium.get(schluessel) === eintrag) this._terrarium.delete(schluessel); });
    this._terrarium.set(schluessel, eintrag);
    while (this._terrarium.size > TERRARIUM_VORRAT) {
      this._terrarium.delete(this._terrarium.keys().next().value);
    }
    return eintrag;
  };

  /**
   * Höhen über dem Meer → Ellipsoidhöhen → Quantized Mesh mit Normalen.
   */
  Provider.prototype._netz = function (rechteck, level, meer, credits) {
    const C = Cesium;
    const n = KANTE;
    const anzahl = n * n;
    const ell = this._ellipsoid;
    const dLon = rechteck.width / (n - 1);
    const dLat = rechteck.height / (n - 1);

    const h = new Float64Array(anzahl);
    let min = Infinity;
    let max = -Infinity;
    for (let j = 0; j < n; j++) {
      const lat = rechteck.south + j * dLat;
      const latG = C.Math.toDegrees(lat);
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const undulation = this._undulation(latG, C.Math.toDegrees(rechteck.west + i * dLon));
        if (undulation === null || undulation === undefined || !isFinite(undulation)) {
          throw new Error('Geoidundulation fehlt — Gelände bliebe um N zu tief');
        }
        h[k] = meer[k] + undulation;
        if (h[k] < min) min = h[k];
        if (h[k] > max) max = h[k];
      }
    }
    // Eine völlig flache Kachel hätte keine Spanne für die Quantisierung
    if (!(max - min > 0.01)) max = min + 0.01;
    const spanne = max - min;

    const vertices = new Uint16Array(anzahl * 3);
    const lagen = new Array(anzahl);
    const karto = new C.Cartographic();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        vertices[k] = Math.round(i * 32767 / (n - 1));
        vertices[anzahl + k] = Math.round(j * 32767 / (n - 1));
        vertices[2 * anzahl + k] = Math.round((h[k] - min) / spanne * 32767);
        karto.longitude = rechteck.west + i * dLon;
        karto.latitude = rechteck.south + j * dLat;
        karto.height = h[k];
        lagen[k] = ell.cartographicToCartesian(karto);
      }
    }

    // Zwei Dreiecke je Masche, gegen den Uhrzeigersinn von oben gesehen
    const indizes = new Uint16Array((n - 1) * (n - 1) * 6);
    let p = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const sw = j * n + i;
        const so = sw + 1;
        const nw = sw + n;
        const no = nw + 1;
        indizes[p++] = sw; indizes[p++] = so; indizes[p++] = no;
        indizes[p++] = sw; indizes[p++] = no; indizes[p++] = nw;
      }
    }

    const westI = [];
    const suedI = [];
    const ostI = [];
    const nordI = [];
    for (let t = 0; t < n; t++) {
      westI.push(t * n);
      ostI.push(t * n + n - 1);
      suedI.push(t);
      nordI.push((n - 1) * n + t);
    }

    // Normalen aus den Nachbarn in Ost-West- und Nord-Süd-Richtung
    const normalen = new Uint8Array(anzahl * 2);
    const ostwest = new C.Cartesian3();
    const nordsued = new C.Cartesian3();
    const normale = new C.Cartesian3();
    const oct = new C.Cartesian2();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        C.Cartesian3.subtract(lagen[j * n + Math.min(i + 1, n - 1)], lagen[j * n + Math.max(i - 1, 0)], ostwest);
        C.Cartesian3.subtract(lagen[Math.min(j + 1, n - 1) * n + i], lagen[Math.max(j - 1, 0) * n + i], nordsued);
        C.Cartesian3.cross(ostwest, nordsued, normale);
        if (C.Cartesian3.magnitudeSquared(normale) === 0) ell.geodeticSurfaceNormal(lagen[k], normale);
        else C.Cartesian3.normalize(normale, normale);
        C.AttributeCompression.octEncode(normale, oct);
        normalen[2 * k] = oct.x;
        normalen[2 * k + 1] = oct.y;
      }
    }

    const kugel = C.BoundingSphere.fromPoints(lagen);
    const horizont = this._occluder.computeHorizonCullingPointPossiblyUnderEllipsoid(kugel.center, lagen, min) ||
                     this._occluder.computeHorizonCullingPointFromRectangle(rechteck, ell) ||
                     C.Cartesian3.clone(kugel.center);
    const schuerze = this.getLevelMaximumGeometricError(level) * 5;

    return new C.QuantizedMeshTerrainData({
      minimumHeight: min,
      maximumHeight: max,
      quantizedVertices: vertices,
      indices: indizes,
      encodedNormals: normalen,
      boundingSphere: kugel,
      orientedBoundingBox: C.OrientedBoundingBox.fromRectangle(rechteck, min, max, ell),
      horizonOcclusionPoint: horizont,
      westIndices: westI,
      southIndices: suedI,
      eastIndices: ostI,
      northIndices: nordI,
      westSkirtHeight: schuerze,
      southSkirtHeight: schuerze,
      eastSkirtHeight: schuerze,
      northSkirtHeight: schuerze,
      childTileMask: level < MAX_EBENE ? 15 : 0,
      credits: credits
    });
  };

  // ── Anlegen ─────────────────────────────────────────────────────────

  async function undulationBereit() {
    const G = window.ILEEN_GEOID;
    if (!G) throw new Error('geoid.js ist nicht eingebunden');
    await G.load();
    if (G.getUndulation(50, 8) === null) throw new Error('EGM96-Gitter nicht geladen');
    return (lat, lon) => G.getUndulation(lat, lon);
  }

  async function dgmBestand(holen) {
    const abruf = Promise.resolve(holen(DGM5_URL + 'layer.json'))
      .then((puffer) => JSON.parse(new TextDecoder().decode(puffer)));
    const frist = new Promise((_, nein) => setTimeout(() => nein(new Error('keine Antwort nach ' +
      LAYER_WARTEZEIT / 1000 + ' s')), LAYER_WARTEZEIT));
    const layer = await Promise.race([abruf, frist]);
    // Ein Formatwechsel beim BKG soll auffallen, nicht als Höhenrauschen enden
    if (layer.format !== 'heightmap-1.0') throw new Error('unerwartetes Format ' + layer.format);
    if (layer.schema && layer.schema !== 'tms') throw new Error('unerwartetes Schema ' + layer.schema);
    return { verfuegbar: layer.available || [], version: layer.version || '1.1.0' };
  }

  /**
   * Gelände anlegen. Wirft, wenn die Geoidundulation fehlt — ein Gelände
   * 48 m zu tief wäre schlimmer als keins. Ist basemap.de nicht erreichbar,
   * geht es mit Terrain Tiles allein weiter.
   *
   * `opt` (für Prüfsteine): `holen(url, request)`, `bild(puffer)`,
   * `undulation(lat, lon)`, `dgm: false` (nur Terrain Tiles).
   */
  /** Ist das DGM1 im eigenen Backend bereit? Liefert { basis, grenzen } oder wirft. */
  async function dgm1Bestand() {
    const bv = window.BimViewer;
    const backend = bv && typeof bv.getBackendUrl === 'function' ? bv.getBackendUrl()
      : ((typeof ILEEN_CONFIG !== 'undefined' && ILEEN_CONFIG.backendUrl) || '');
    if (!backend) throw new Error('keine Backend-Adresse');
    const basis = backend.replace(/\/+$/, '') + '/gelaende/dgm1';
    const steuer = new AbortController();
    const uhr = setTimeout(() => steuer.abort(), DGM1_INFO_FRIST);
    try {
      const r = await fetch(basis + '/info', { signal: steuer.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const info = await r.json();
      if (!Array.isArray(info.grenzen) || info.grenzen.length !== 4) throw new Error('ohne Grenzen');
      return { basis: basis, grenzen: info.grenzen };
    } finally {
      clearTimeout(uhr);
    }
  }

  async function erzeugen(opt) {
    opt = opt || {};
    const holen = opt.holen || holenUeberCesium;
    const undulation = opt.undulation || await undulationBereit();
    let dgm1 = opt.dgm1 || null;
    if (opt.dgm1 === undefined) {
      try {
        dgm1 = await dgm1Bestand();
      } catch (fehler) {
        console.info('[Gelände] DGM1 RLP nicht verfügbar (' + fehler.message + '), weiter mit DGM5/Terrain Tiles');
      }
    }
    let dgm = null;
    let spaeter = null;
    if (opt.dgm !== false) {
      // Der Viewer steht erst, wenn das Gelände steht — und der Start hing an einem BKG, das
      // nicht antwortet, volle LAYER_WARTEZEIT lang vor einem leeren Bild. Jetzt wartet er
      // LAYER_ERSTWARTE; kommt die Antwort danach noch (bis LAYER_WARTEZEIT), wird sie
      // nachgereicht. Kacheln, die bis dahin schon aus Terrain Tiles standen, bleiben so —
      // das ist der Start aus dem All, noch weit oberhalb der Ebenen, in denen das DGM5 zählt.
      const abruf = dgmBestand(holen).then(
        (bestand) => ({ bestand: bestand }),
        (fehler) => ({ fehler: fehler }));
      const erst = await Promise.race([
        abruf,
        new Promise((ok) => setTimeout(() => ok(null), LAYER_ERSTWARTE))]);
      if (erst === null) spaeter = abruf;
      else if (erst.bestand) dgm = erst.bestand;
      else console.warn('[Gelände] basemap.de nicht erreichbar, weiter mit Terrain Tiles allein:', erst.fehler.message);
    }
    const provider = new Provider({ dgm: dgm, dgm1: dgm1, undulation: undulation, holen: holen, bild: opt.bild, frist: opt.frist });
    if (spaeter) {
      spaeter.then((erg) => {
        if (erg.bestand) provider._dgm = erg.bestand;
        else console.warn('[Gelände] basemap.de nicht erreichbar, weiter mit Terrain Tiles allein:', erg.fehler.message);
      });
    }
    return provider;
  }

  return {
    erzeugen: erzeugen,
    Provider: Provider,
    DGM5_URL: DGM5_URL,
    TERRARIUM_URL: TERRARIUM_URL,
    MAX_EBENE: MAX_EBENE,
    KACHEL_FRIST: KACHEL_FRIST,
    DGM1_MAX_EBENE: DGM1_MAX_EBENE,
    _intern: { mitFrist: mitFrist, dgm1Lesen: dgm1Lesen, dgmLesen: dgmLesen, terrariumLesen: terrariumLesen, terrariumZoom: terrariumZoom,
               mercatorX: mercatorX, mercatorY: mercatorY }
  };
})();
