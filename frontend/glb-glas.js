/**
 * iLEEN
 *
 * GLAS IN GLB-MODELLEN — Materialien vor dem Laden umschreiben
 * =============================================================
 *
 * CesiumJS kennt kein echtes Glas. Die Extensions, mit denen Blender,
 * Rhino & Co. Verglasung exportieren — `KHR_materials_transmission`,
 * `KHR_materials_volume`, `KHR_materials_ior`, `KHR_materials_dispersion`,
 * `KHR_materials_sheen` — werden von Cesium nicht ausgewertet (unterstützt
 * sind unlit, specular, clearcoat, anisotropy, emissive_strength). Ein
 * Fensterglas kommt deshalb als undurchsichtige weiße Fläche an: die
 * Durchsicht steckt allein in der Extension, `alphaMode` bleibt `OPAQUE`.
 *
 * Schlimmer noch: steht so eine Extension in `extensionsRequired`, bricht
 * Cesium das Laden der ganzen Datei ab.
 *
 * Dieses Modul liest die Datei vor dem Laden, erkennt Glasmaterialien und
 * schreibt sie auf klassische Alpha-Transparenz um — was Cesium beherrscht.
 * Geändert wird nur eine Kopie im Speicher; die Datei auf der Platte bleibt
 * unangetastet.
 *
 * Was Alpha-Blending nicht kann: Brechung, Tiefenverzerrung und getrennte
 * Reflexionen der Rückseite. Eine Scheibe sieht aus wie eine Scheibe, ein
 * Wasserglas nicht wie ein Wasserglas.
 */
'use strict';

window.GlbGlas = (function() {

  // Restdeckkraft der Scheibe: 0.2 = 20 % sichtbar, 80 % Durchsicht
  var DECKKRAFT = 0.2;

  // Materialnamen, die auf Verglasung hindeuten. IFC-Exporte benennen ihre
  // Materialien meist sprechend ("Glas", "Fensterglas", "Glazing_Clear").
  var NAMENSMUSTER = /glas|glass|glazing|fenster|window|verglas|scheibe|vitr/i;

  // Extensions, die Glas beschreiben und die Cesium nicht kennt. Ihr
  // Vorhandensein ist das verlässlichste Erkennungsmerkmal — verlässlicher
  // als jeder Name.
  var GLAS_EXTENSIONS = [
    'KHR_materials_transmission',
    'KHR_materials_volume',
    'KHR_materials_ior',
    'KHR_materials_dispersion'
  ];

  // Zusätzlich aus `extensionsRequired` zu streichen: sonst verweigert Cesium
  // die Datei, obwohl das Ergebnis ohne diese Extension brauchbar ist.
  var UNBEKANNTE_EXTENSIONS = GLAS_EXTENSIONS.concat([
    'KHR_materials_sheen',
    'KHR_materials_iridescence',
    'KHR_materials_diffuse_transmission'
  ]);

  var JSON_CHUNK = 0x4E4F534A;   // 'JSON'
  var BIN_CHUNK = 0x004E4942;    // 'BIN\0'
  var GLB_MAGIC = 0x46546C67;    // 'glTF'

  // ===============================
  // GLB-CONTAINER
  // ===============================

  /** Zerlegt einen GLB-Puffer in JSON-Teil und (optional) Binärteil. */
  function glbZerlegen(puffer) {
    var sicht = new DataView(puffer);
    if (sicht.byteLength < 12 || sicht.getUint32(0, true) !== GLB_MAGIC) return null;

    var gesamt = sicht.getUint32(8, true);
    var pos = 12;
    var json = null;
    var bin = null;

    while (pos + 8 <= Math.min(gesamt, sicht.byteLength)) {
      var laenge = sicht.getUint32(pos, true);
      var typ = sicht.getUint32(pos + 4, true);
      var anfang = pos + 8;
      if (anfang + laenge > sicht.byteLength) break;

      if (typ === JSON_CHUNK) {
        json = new TextDecoder('utf-8').decode(new Uint8Array(puffer, anfang, laenge));
      } else if (typ === BIN_CHUNK) {
        bin = new Uint8Array(puffer, anfang, laenge);
      }
      pos = anfang + laenge;
    }

    return json ? { json: json, bin: bin } : null;
  }

  /** Baut aus JSON-Objekt und Binärteil wieder einen GLB-Puffer. */
  function glbBauen(gltf, bin) {
    var jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
    // Beide Chunks müssen auf 4 Byte ausgerichtet sein — JSON wird mit
    // Leerzeichen aufgefüllt, der Binärteil mit Nullen.
    var jsonFuell = (4 - (jsonBytes.length % 4)) % 4;
    var binLaenge = bin ? bin.length : 0;
    var binFuell = bin ? (4 - (binLaenge % 4)) % 4 : 0;

    var gesamt = 12 + 8 + jsonBytes.length + jsonFuell +
      (bin ? 8 + binLaenge + binFuell : 0);

    var puffer = new ArrayBuffer(gesamt);
    var sicht = new DataView(puffer);
    var bytes = new Uint8Array(puffer);

    sicht.setUint32(0, GLB_MAGIC, true);
    sicht.setUint32(4, 2, true);
    sicht.setUint32(8, gesamt, true);

    var pos = 12;
    sicht.setUint32(pos, jsonBytes.length + jsonFuell, true);
    sicht.setUint32(pos + 4, JSON_CHUNK, true);
    bytes.set(jsonBytes, pos + 8);
    for (var i = 0; i < jsonFuell; i++) bytes[pos + 8 + jsonBytes.length + i] = 0x20;
    pos += 8 + jsonBytes.length + jsonFuell;

    if (bin) {
      sicht.setUint32(pos, binLaenge + binFuell, true);
      sicht.setUint32(pos + 4, BIN_CHUNK, true);
      bytes.set(bin, pos + 8);
      // Füllbytes bleiben 0
    }

    return puffer;
  }

  // ===============================
  // MATERIALIEN
  // ===============================

  function istGlas(material) {
    if (!material) return false;

    var ext = material.extensions;
    if (ext) {
      for (var i = 0; i < GLAS_EXTENSIONS.length; i++) {
        var name = GLAS_EXTENSIONS[i];
        if (!ext[name]) continue;
        // transmissionFactor 0 heißt: die Extension steht drin, wirkt aber nicht
        if (name === 'KHR_materials_transmission' &&
            ext[name].transmissionFactor === 0) continue;
        return true;
      }
    }

    return !!(material.name && NAMENSMUSTER.test(material.name));
  }

  /**
   * Schreibt ein Glasmaterial auf Alpha-Transparenz um.
   * Gibt true zurück, wenn etwas geändert wurde.
   */
  function glasUmschreiben(material, deckkraft) {
    var pbr = material.pbrMetallicRoughness;
    if (!pbr) {
      pbr = material.pbrMetallicRoughness = {};
    }

    var farbe = pbr.baseColorFactor;
    if (!Array.isArray(farbe) || farbe.length < 4) {
      farbe = pbr.baseColorFactor = [1, 1, 1, 1];
    }

    // Bringt die Datei schon eine geringere Deckkraft mit, bleibt sie stehen —
    // der Ersteller hat sich dabei etwas gedacht.
    var bereitsTransparent = material.alphaMode === 'BLEND' && farbe[3] < 1;
    if (!bereitsTransparent) farbe[3] = deckkraft;

    material.alphaMode = 'BLEND';
    // Beide Seiten: eine Scheibe ohne Rückseite verschwindet, sobald man
    // von innen dagegen schaut.
    material.doubleSided = true;

    // Glas ist nicht metallisch und sehr glatt — sonst wird die Scheibe grau.
    if (pbr.metallicFactor === undefined || pbr.metallicFactor > 0.1) pbr.metallicFactor = 0.0;
    if (pbr.roughnessFactor === undefined || pbr.roughnessFactor > 0.2) pbr.roughnessFactor = 0.05;

    return !bereitsTransparent;
  }

  /**
   * Ändert das glTF-JSON in-place. Gibt zurück, wie viele Materialien
   * angefasst wurden und ob überhaupt etwas geändert wurde.
   */
  function gltfPatchen(gltf, deckkraft) {
    var glasZahl = 0;
    var geaendert = false;

    (gltf.materials || []).forEach(function(material) {
      if (!istGlas(material)) return;
      glasZahl++;
      if (glasUmschreiben(material, deckkraft)) geaendert = true;
    });

    // Nicht unterstützte Extensions aus `extensionsRequired` streichen,
    // sonst verweigert Cesium die Datei komplett. In `extensionsUsed` dürfen
    // sie stehen bleiben — Unbekanntes dort wird schlicht ignoriert.
    if (Array.isArray(gltf.extensionsRequired)) {
      var vorher = gltf.extensionsRequired.length;
      gltf.extensionsRequired = gltf.extensionsRequired.filter(function(name) {
        return UNBEKANNTE_EXTENSIONS.indexOf(name) === -1;
      });
      if (gltf.extensionsRequired.length !== vorher) geaendert = true;
      if (gltf.extensionsRequired.length === 0) delete gltf.extensionsRequired;
    }

    return { glasZahl: glasZahl, geaendert: geaendert };
  }

  // ===============================
  // ÖFFENTLICHE SCHNITTSTELLE
  // ===============================

  return {
    DECKKRAFT: DECKKRAFT,

    setDeckkraft: function(wert) {
      DECKKRAFT = Math.max(0.02, Math.min(1.0, Number(wert) || 0.2));
      this.DECKKRAFT = DECKKRAFT;
    },

    /**
     * Liest eine .glb/.gltf, macht ihr Glas durchsichtig und liefert die
     * Optionen für `Cesium.Model.fromGltfAsync`:
     *
     *   { url, basePath, blobUrl }
     *
     * `basePath` zeigt weiter auf das Originalverzeichnis, damit externe
     * Puffer und Texturen einer .gltf gefunden werden. `blobUrl` ist gesetzt,
     * wenn eine Kopie angelegt wurde — der Aufrufer muss sie beim Entladen
     * mit URL.revokeObjectURL freigeben.
     *
     * Bei jedem Fehler (Netz, kaputter Container, fremdes Format) wird still
     * die Original-URL zurückgegeben: das Modell lädt dann wie bisher.
     */
    aufbereiten: async function(url) {
      var ergebnis = { url: url, basePath: undefined, blobUrl: null, glasZahl: 0 };

      try {
        var quelle = Cesium.Resource.createIfNeeded(url);
        var puffer = await quelle.fetchArrayBuffer();
        if (!puffer) return ergebnis;

        var zerlegt = glbZerlegen(puffer);
        var istGlb = !!zerlegt;
        var gltf;

        if (istGlb) {
          gltf = JSON.parse(zerlegt.json);
        } else {
          gltf = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(puffer)));
        }

        var bericht = gltfPatchen(gltf, DECKKRAFT);
        ergebnis.glasZahl = bericht.glasZahl;

        if (!bericht.geaendert) return ergebnis;

        var blob = istGlb
          ? new Blob([glbBauen(gltf, zerlegt.bin)], { type: 'model/gltf-binary' })
          : new Blob([JSON.stringify(gltf)], { type: 'model/gltf+json' });

        ergebnis.blobUrl = URL.createObjectURL(blob);
        ergebnis.url = ergebnis.blobUrl;
        // Relative Pfade der Originaldatei bleiben auflösbar (nur bei .gltf
        // relevant, schadet bei .glb aber nicht).
        ergebnis.basePath = quelle.url.replace(/[^/]*$/, '');

        console.log('🪟 Glas: ' + bericht.glasZahl + ' Material(ien) auf ' +
          Math.round(DECKKRAFT * 100) + ' % Deckkraft umgeschrieben (' + url + ')');

        return ergebnis;
      } catch (fehler) {
        console.warn('⚠️ Glas-Aufbereitung übersprungen (' + url + '):', fehler.message);
        return { url: url, basePath: undefined, blobUrl: null, glasZahl: 0 };
      }
    }
  };

})();

console.log('✅ Glas-Modul geladen (GLB-Materialien → Alpha-Transparenz)');
