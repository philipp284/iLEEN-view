/**
 * iLEEN — Karten, Luftbilder, Gebäude und Ortssuche ohne Cesium ion
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Bis Oktober 2026 kam die ganze Welt unter dem Modell über Cesium ion:
 * Bing-Luftbild, Weltgelände, OSM Buildings, Google 3D Tiles und die
 * Ortssuche. Jetzt wird jede Quelle direkt angesprochen, und ion bleibt für
 * Modelle, die noch im eigenen ion-Konto liegen — und für das, was Google
 * Projekten im EWR verweigert (siehe „Google: direkt, sonst über ion").
 *
 *   Was               woher                                     Schlüssel
 *   Luftbild          DOP20 der Länder (WMS) über Sentinel-2    keiner
 *   Karte             basemap.de Web Raster, OpenStreetMap       keiner
 *   Gelände           gelaende.js (DGM5 + Terrain Tiles)        keiner
 *   Gebäude           basemap.de 3D LoD2                        keiner
 *   Ortssuche         Nominatim (OSM)                           keiner
 *   Google            Karte, Geocoding direkt                   eigener Google-Schlüssel
 *                     Satellit, 3D Tiles über Cesium ion        ion-Token
 *
 * **Warum Google nicht die Vorgabe ist:** Die Map Tiles API erlaubt je
 * Projekt 15 000 2D-Kacheln am Tag. Ein Luftbild als Grundkarte verbraucht
 * davon bei einem einzigen Rundflug Hunderte. Google bleibt deshalb
 * wählbar, ist aber nie das, was beim Start ungefragt abgerufen wird.
 *
 * **Warum ein Mosaik aus Länderdiensten:** Ein bundesweites, frei nutzbares
 * Orthophoto gibt es nicht (das DOP des BKG ist Bundesbehörden vorbehalten).
 * Die Länder geben ihre DOP20 aber frei ab. Jede Ebene ist auf das Rechteck
 * ihres Landes begrenzt und kommt transparent außerhalb der Landesfläche —
 * am Rhein zwischen Mainz und Wiesbaden stoßen RLP und Hessen ohne Lücke
 * aneinander. Wo kein Land eingetragen ist, scheint Sentinel-2 durch.
 * Ein weiteres Land ist ein Eintrag in `DOP_LAENDER`.
 */
'use strict';

window.ILeenKarten = (function () {
  const GOOGLE_SPEICHER = 'ileen_google_key';
  const JAHR = new Date().getFullYear();

  // ── Google-Schlüssel ────────────────────────────────────────────────

  function googleKey() {
    let gespeichert = null;
    try { gespeichert = localStorage.getItem(GOOGLE_SPEICHER); } catch (e) { /* privates Fenster */ }
    return (gespeichert || (typeof ILEEN_CONFIG !== 'undefined' && ILEEN_CONFIG.googleMapsKey) || '').trim();
  }

  function setGoogleKey(schluessel) {
    const sauber = (schluessel || '').trim();
    try {
      if (sauber) localStorage.setItem(GOOGLE_SPEICHER, sauber);
      else localStorage.removeItem(GOOGLE_SPEICHER);
    } catch (e) { /* privates Fenster */ }
    if (typeof Cesium !== 'undefined') Cesium.GoogleMaps.defaultApiKey = googleKey() || undefined;
    for (const art of Object.keys(direktAbgelehnt)) delete direktAbgelehnt[art];
    return sauber;
  }

  /**
   * Fehler der Google-APIs in einen Satz, mit dem man etwas anfangen kann.
   * Die häufigsten sind kein Fehler im Code: die API ist im Cloud-Projekt des
   * Schlüssels nicht freigeschaltet, oder das Projekt hängt an einer
   * Rechnungsadresse im EWR.
   */
  function googleFehlerText(fehler, api) {
    const roh = String((fehler && (fehler.response || fehler.message)) || fehler || '');
    const status = fehler && fehler.statusCode;
    if (/not available for your account and region/.test(roh)) {
      return 'Google: Satellit und 3D Tiles sind für Cloud-Projekte im EWR gesperrt';
    }
    if (status === 403 || /PERMISSION_DENIED|has not been used|is disabled|not activated|REQUEST_DENIED/.test(roh)) {
      return 'Google: ' + api + ' ist im Cloud-Projekt des Schlüssels nicht freigeschaltet';
    }
    if (status === 400 && /API key not valid|INVALID_ARGUMENT/.test(roh)) return 'Google: Schlüssel ungültig';
    if (status === 429 || /RESOURCE_EXHAUSTED|OVER_QUERY_LIMIT/.test(roh)) return 'Google: Tageskontingent erschöpft';
    return 'Google ' + api + ' nicht erreichbar';
  }

  /**
   * Einmal beim Start, vor dem Anlegen des Viewers: Schlüssel setzen,
   * Google-Logo lokal statt von assets.ion.cesium.com, und der feste Vermerk
   * unten links nennt CesiumJS statt „Cesium ion" — die Szene kommt nicht mehr
   * von dort. Wird ein Modell aus dem ion-Konto geladen, bringt ion sein Logo
   * als Vermerk dieses Modells selbst mit.
   */
  function einrichten() {
    Cesium.GoogleMaps.defaultApiKey = googleKey() || undefined;
    Cesium.GoogleMaps.getDefaultCredit = function () {
      return new Cesium.Credit('<img alt="Google" src="Assets/google-attribution.png" style="vertical-align:-6px">', true);
    };
    Cesium.CreditDisplay.cesiumCredit = new Cesium.Credit(
      '<a href="https://cesium.com/platform/cesiumjs/" target="_blank" rel="noopener">' +
      '<img src="' + Cesium.buildModuleUrl('Assets/Images/cesium_credit.png') + '" style="vertical-align:-7px" title="CesiumJS"></a>',
      true);
  }

  // ── Bildquellen ─────────────────────────────────────────────────────

  /**
   * Amtliche Orthophotos (20 cm) der Länder, die frei und mit CORS liefern.
   * `format`: `image/vnd.jpeg-png` liefert JPEG, wo die Kachel voll ist, und
   * PNG mit Transparenz am Landesrand — NRW kann das nicht und bekommt PNG.
   * Rechtecke in Grad (West, Süd, Ost, Nord), etwas weiter als das Land.
   */
  const DOP_LAENDER = [
    { id: 'rp', land: 'Rheinland-Pfalz', url: 'https://geo4.service24.rlp.de/wms/rp_dop20.fcgi',
      layers: 'rp_dop20', format: 'image/vnd.jpeg-png', rechteck: [6.10, 48.95, 8.52, 50.96],
      credit: 'Luftbild RLP: ©GeoBasis-DE / LVermGeoRP ' + JAHR + ', dl-de/by-2-0, www.lvermgeo.rlp.de' },
    { id: 'he', land: 'Hessen', url: 'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows',
      layers: 'he_dop_rgb', format: 'image/vnd.jpeg-png', rechteck: [7.76, 49.38, 10.25, 51.67],
      credit: 'Luftbild Hessen: © HVBG' },
    { id: 'nw', land: 'Nordrhein-Westfalen', url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop',
      layers: 'nw_dop_rgb', format: 'image/png', rechteck: [5.85, 50.31, 9.47, 52.54],
      credit: 'Luftbild NRW: © Geobasis NRW, dl-de/zero-2-0' },
    { id: 'by', land: 'Bayern', url: 'https://geoservices.bayern.de/od/wms/dop/v1/dop20',
      layers: 'by_dop20c', format: 'image/vnd.jpeg-png', rechteck: [8.96, 47.26, 13.85, 50.57],
      credit: 'Luftbild Bayern: © Bayerische Vermessungsverwaltung, www.geodaten.bayern.de, CC BY 4.0' },
    { id: 'sl', land: 'Saarland', url: 'https://geoportal.saarland.de/freewms/dop',
      layers: 'sl_dop', format: 'image/vnd.jpeg-png', rechteck: [6.34, 49.10, 7.42, 49.65],
      credit: 'Luftbild Saarland: © LVGL Saarland' }
  ];

  // Unterhalb dieser Geländeebene (Kacheln über ~6 km) zeigt Sentinel-2 mehr
  // als ein heruntergerechnetes 20-cm-Bild — und die Länderdienste bleiben
  // vom Abruf ganzer Bundesländer verschont.
  const DOP_AB_EBENE = 11;

  function ebene(anbieter, optionen) {
    return { anbieter: anbieter, optionen: optionen || {} };
  }

  function dopEbene(land) {
    return ebene(new Cesium.WebMapServiceImageryProvider({
      url: land.url,
      layers: land.layers,
      parameters: { format: land.format, transparent: true },
      rectangle: Cesium.Rectangle.fromDegrees(land.rechteck[0], land.rechteck[1], land.rechteck[2], land.rechteck[3]),
      maximumLevel: 19,
      enablePickFeatures: false,
      credit: new Cesium.Credit(land.credit)
    }), { minimumTerrainLevel: DOP_AB_EBENE });
  }

  /** Sentinel-2 cloudless (EOX), wolkenfreies Jahresmosaik, 10 m, weltweit. */
  function sentinel() {
    return new Cesium.UrlTemplateImageryProvider({
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      maximumLevel: 14,
      credit: new Cesium.Credit('<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless – s2maps.eu</a> ' +
        'by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)')
    });
  }

  function basemapDe() {
    return new Cesium.UrlTemplateImageryProvider({
      url: 'https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png',
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      rectangle: Cesium.Rectangle.fromDegrees(5.5, 47.0, 15.6, 55.2),
      maximumLevel: 18,
      credit: new Cesium.Credit('© basemap.de / BKG ' + JAHR + ' | Datenquellen: © GeoBasis-DE')
    });
  }

  function osm() {
    return new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      credit: new Cesium.Credit('© OpenStreetMap-Mitwirkende (ODbL)')
    });
  }

  // ── Google: direkt, sonst über ion ──────────────────────────────────
  //
  // Seit dem 8. Juli 2025 gibt Google Satellitenkacheln (2D) und
  // Photorealistic 3D Tiles nicht mehr an Cloud-Projekte mit
  // Rechnungsadresse im EWR ab: die Map Tiles API antwortet 403 „not
  // available for your account and region", mit jedem Schlüssel dieses
  // Projekts. Straßen- und Geländekarte und das Geocoding laufen direkt.
  // Was Google direkt verweigert, kommt über Cesium ion, wo Google an
  // Cesiums Vertrag hängt. Das ist die einzige Stelle, an der Karte und
  // Kulisse ion noch berühren — und nur, wenn jemand Google wählt.
  const ION_GOOGLE_3D = 2275207;
  const ION_GOOGLE_2D = 3830184;

  // Je Art ('satellite', 'roadmap', '3d') der Grund, aus dem Google direkt
  // abgelehnt hat — für die Sitzung, damit nicht jeder Wechsel erst eine
  // 403 abholt. Netzfehler zählen nicht; ein neuer Schlüssel löscht alles.
  const direktAbgelehnt = {};

  function ionToken() {
    return (window.BimViewer && typeof BimViewer.getIonToken === 'function' && BimViewer.getIonToken()) || '';
  }

  /**
   * Erst direkt mit eigenem Schlüssel, bei Ablehnung über ion. Gibt
   * `{ ergebnis, hinweis }` zurück; `hinweis` ist leer, wenn Google direkt
   * geliefert hat, und sagt sonst, warum ion einsprang.
   */
  async function googleHolen(art, api, direkt, ueberIon) {
    const schluessel = googleKey();
    let grund = direktAbgelehnt[art] || (schluessel ? '' : 'Kein Google-Schlüssel — Einstellungen › Kartendienste');
    if (!grund) {
      try {
        return { ergebnis: await direkt(schluessel), hinweis: '' };
      } catch (fehler) {
        console.warn('Google ' + art + ' direkt abgelehnt:', fehler);
        grund = googleFehlerText(fehler, api);
        if (grund.startsWith('Google: ')) direktAbgelehnt[art] = grund;
      }
    }
    const token = ionToken();
    if (!token) throw new Error(grund);
    try {
      return { ergebnis: await ueberIon(token), hinweis: 'über Cesium ion (' + grund.replace(/^Google: /, '') + ')' };
    } catch (fehler) {
      console.error('Google ' + art + ' auch über Cesium ion nicht verfügbar:', fehler);
      throw new Error(grund + ' — auch über Cesium ion nicht erreichbar');
    }
  }

  /** Google 2D als Grundkartenebene; `hinweis` nennt einen Umweg über ion. */
  async function googleEbene(mapType) {
    const optionen = { mapType: mapType, language: 'de-DE', region: 'DE' };
    const r = await googleHolen(mapType, 'Map Tiles API',
      (schluessel) => Cesium.Google2DImageryProvider.fromUrl(Object.assign({ key: schluessel }, optionen)),
      () => Cesium.Google2DImageryProvider.fromIonAssetId(Object.assign({ assetId: ION_GOOGLE_2D }, optionen)));
    return Object.assign(ebene(r.ergebnis), { hinweis: r.hinweis });
  }

  /**
   * Google Photorealistic 3D Tiles — `{ tileset, hinweis }`. Ohne `key`
   * fiele Cesium stillschweigend auf seinen Standard-Token für ion zurück;
   * deshalb geht der Weg über ion nur ausdrücklich, mit eigenem Token.
   */
  async function google3D(optionen) {
    const r = await googleHolen('3d', 'Map Tiles API',
      (schluessel) => Cesium.createGooglePhotorealistic3DTileset({ key: schluessel, onlyUsingWithGoogleGeocoder: true }, optionen),
      async (token) => Cesium.Cesium3DTileset.fromUrl(
        await Cesium.IonResource.fromAssetId(ION_GOOGLE_3D, { accessToken: token }), optionen));
    return { tileset: r.ergebnis, hinweis: r.hinweis };
  }

  /**
   * Die Grundkarten der Layer-Liste. `laden()` gibt die Ebenen von unten
   * nach oben zurück; layerManager.js legt sie als Grundkarte unter alle
   * übrigen Bildebenen.
   */
  function grundkarten() {
    return [
      { id: 'luftbild', name: 'Luftbild amtlich (DOP der Länder, sonst Sentinel-2)',
        laden: async () => [ebene(sentinel())].concat(DOP_LAENDER.map(dopEbene)) },
      { id: 'sentinel', name: 'Sentinel-2 (weltweit, 10 m)', laden: async () => [ebene(sentinel())] },
      { id: 'google-luftbild', name: 'Luftbild Google', google: true,
        laden: async () => [await googleEbene('satellite')] },
      // OSM darunter, weil basemap.de an der Bundesgrenze endet
      { id: 'basemapde', name: 'Karte basemap.de (amtlich)', laden: async () => [ebene(osm()), ebene(basemapDe())] },
      { id: 'google-karte', name: 'Karte Google', google: true,
        laden: async () => [await googleEbene('roadmap')] },
      { id: 'osm', name: 'OpenStreetMap', laden: async () => [ebene(osm())] },
      { id: 'none', name: 'Keine Karte', laden: async () => [] }
    ];
  }

  /** Kennungen gespeicherter Zustände aus der ion-Zeit → heutige Karte. */
  const KARTE_FRUEHER = { 'bing-aerial': 'luftbild', 'bing-labels': 'luftbild', 'bing-roads': 'basemapde' };
  const GELAENDE_FRUEHER = { world: 'gelaende' };

  // ── Gebäude: basemap.de 3D LoD2 ─────────────────────────────────────

  /**
   * Bundesweite LoD2-Gebäude als 3D Tiles. Die Variante „Höhe DGM5“ steht
   * auf demselben Gelände wie gelaende.js — und damit ebenfalls in NHN:
   * am Mainzer Rathaus liegt die Unterkante bei 80,7 m statt bei 129 m über
   * dem Ellipsoid. `hoehenbezug: 'nhn'` lässt layerManager.js das Tileset
   * mit `geoidNachfuehren()` anheben.
   *
   * Lizenz wie beim Gelände (Beta, zu Testzwecken, nur über den Dienst).
   */
  function lod2Deutschland() {
    return {
      id: 'lod2-de', name: 'LoD2 Deutschland', nameEN: 'LoD2 Germany',
      description: 'Amtliche 3D-Gebäude der Länder (basemap.de 3D, BKG)',
      url: 'https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gebaeude/lod2_4326_dgm5.json',
      hoehenbezug: 'nhn',
      // Farben wie im Standardstil von basemap.de: Dach rot, Wand grau, Brücke dunkel
      stil: {
        color: { conditions: [
          ["${surface} === 'roof'", "color('#b5533f')"],
          ["${surface} === 'bridge'", "color('#3c3c3c')"],
          ['true', "color('#d8d4cb')"]
        ] }
      },
      credit: '3D-Gebäude: © GeoBasis-DE/BKG ' + JAHR + ' (basemap.de 3D, verändert: Höhen auf das WGS84-Ellipsoid umgerechnet)',
      tileset: null, active: false, loading: false
    };
  }

  /**
   * Hebt ein Tileset mit NHN-Höhen auf den Ellipsoid: eine Verschiebung um
   * N entlang der Lotrichtung am Bildmittelpunkt, nachgeführt, sobald sich
   * der Blick mehr als einen Kilometer davon entfernt. Die Undulation ändert
   * sich in Deutschland um wenige Zentimeter je Kilometer; am Ort, auf den
   * man schaut, stimmen Gebäude und Gelände damit auf Zentimeter überein.
   *
   * Bis zur ersten gültigen Undulation bleibt das Tileset unsichtbar — ein
   * Gebäude 48 m im Boden sähe aus wie ein Datenfehler. Gibt die
   * Abmeldefunktion zurück.
   */
  function geoidNachfuehren(viewer, tileset, sichtbar) {
    let bezug = null;
    const mitte = new Cesium.Cartesian2();
    function nachfuehren() {
      const G = window.ILEEN_GEOID;
      if (!G || tileset.isDestroyed()) return;
      const leinwand = viewer.scene.canvas;
      mitte.x = leinwand.clientWidth / 2;
      mitte.y = leinwand.clientHeight / 2;
      const treffer = viewer.camera.pickEllipsoid(mitte, viewer.scene.globe.ellipsoid);
      const ort = treffer ? Cesium.Cartographic.fromCartesian(treffer) : viewer.camera.positionCartographic;
      const unten = Cesium.Cartesian3.fromRadians(ort.longitude, ort.latitude, 0);
      if (bezug && Cesium.Cartesian3.distance(bezug, unten) < 1000) return;
      const n = G.getUndulation(Cesium.Math.toDegrees(ort.latitude), Cesium.Math.toDegrees(ort.longitude));
      if (n === null) return;
      const oben = Cesium.Cartesian3.fromRadians(ort.longitude, ort.latitude, n);
      tileset.modelMatrix = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.subtract(oben, unten, new Cesium.Cartesian3()));
      if (!bezug) tileset.show = sichtbar ? sichtbar() : true;
      bezug = unten;
    }
    tileset.show = false;
    if (window.ILEEN_GEOID) window.ILEEN_GEOID.load().then(nachfuehren);
    return viewer.camera.moveEnd.addEventListener(nachfuehren);
  }

  // ── Ortssuche ───────────────────────────────────────────────────────

  async function nominatimSuchen(eingabe, art) {
    // Nominatim untersagt Abfragen je Tastendruck; gesucht wird beim Absenden.
    if (art === Cesium.GeocodeType.AUTOCOMPLETE) return [];
    const frage = (eingabe || '').trim();
    if (!frage) return [];
    const sprache = (window.ILeenI18n && ILeenI18n.getLanguage && ILeenI18n.getLanguage()) || 'de';
    const antwort = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q: frage, format: 'jsonv2', limit: '5', 'accept-language': sprache
    }), { headers: { Accept: 'application/json' } });
    if (!antwort.ok) throw new Error('Nominatim: HTTP ' + antwort.status);
    const liste = await antwort.json();
    return liste.map((e) => {
      const bb = (e.boundingbox || []).map(Number);   // [Süd, Nord, West, Ost]
      const ziel = bb.length === 4 && bb.every(isFinite)
        ? Cesium.Rectangle.fromDegrees(bb[2], bb[0], bb[3], bb[1])
        : Cesium.Cartesian3.fromDegrees(Number(e.lon), Number(e.lat), 500);
      return { displayName: e.display_name, destination: ziel };
    });
  }

  /**
   * Ein Suchdienst für das Suchfeld des Viewers. Google 3D Tiles dürfen nach
   * Googles Bedingungen nur mit Googles eigener Suche gezeigt werden; solange
   * sie an sind, sucht deshalb Google, sonst Nominatim (OpenStreetMap).
   */
  function ortssuche() {
    const nominatim = {
      credit: new Cesium.Credit('Suche: Nominatim, © OpenStreetMap-Mitwirkende'),
      geocode: nominatimSuchen
    };
    let google = null;
    function waehlen() {
      const schluessel = googleKey();
      const googleKulisse = window.BimViewer && BimViewer.googleTiles && BimViewer.googleTiles.enabled;
      if (!schluessel || !googleKulisse) return nominatim;
      if (!google || google._ileenSchluessel !== schluessel) {
        google = new Cesium.GoogleGeocoderService({ key: schluessel });
        google._ileenSchluessel = schluessel;
      }
      return google;
    }
    return {
      get credit() { return waehlen().credit; },
      geocode(eingabe, art) {
        const dienst = waehlen();
        return Promise.resolve(dienst.geocode(eingabe, art)).catch((fehler) => {
          if (dienst !== nominatim) throw new Error(googleFehlerText(fehler, 'Geocoding API'));
          throw fehler;
        });
      }
    };
  }

  return {
    googleKey: googleKey,
    setGoogleKey: setGoogleKey,
    googleFehlerText: googleFehlerText,
    google3D: google3D,
    einrichten: einrichten,
    grundkarten: grundkarten,
    KARTE_FRUEHER: KARTE_FRUEHER,
    GELAENDE_FRUEHER: GELAENDE_FRUEHER,
    DOP_LAENDER: DOP_LAENDER,
    lod2Deutschland: lod2Deutschland,
    geoidNachfuehren: geoidNachfuehren,
    ortssuche: ortssuche,
    _intern: { nominatimSuchen: nominatimSuchen }
  };
})();
