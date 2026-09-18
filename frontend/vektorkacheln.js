/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */
/**
 * Vektorkarte — amtliche Vektorkacheln (basemap.de) auf dem Gelände.
 *
 * Seit CesiumJS 1.141 lädt `MVTDataProvider` Mapbox Vector Tiles direkt als
 * 3D Tiles, seit 1.144/1.145 werden Flächen und Linien auf Gelände und
 * 3D-Kacheln drapiert (`heightReference`). Das ist etwas anderes als eine
 * Rasterkarte: jede Gebäudefläche, jede Straßenachse ist ein eigenes Feature
 * mit Eigenschaften, das sich per `Cesium3DTileStyle` einfärben, ausblenden und
 * anklicken lässt — und das bei jeder Zoomstufe scharf bleibt, weil es erst
 * auf der Grafikkarte gerastert wird.
 *
 * **Quelle: basemap.de Vektor (BKG, GeoBasis-DE).** Die amtliche Kartenbasis
 * Deutschlands aus ALKIS/ATKIS, bis Zoomstufe 15, mit CORS für fremde Seiten.
 * Die Wahl ist fachlich: die Gebäudeflächen sind die Katasterumrisse, also
 * dieselben Kanten, gegen die ein Lageplan im Bauantrag geprüft wird — keine
 * OSM-Zeichnung.
 *
 * **Die Quellebene steht in `_layer`.** `buildVectorGltfFromMVT` schreibt den
 * Namen der MVT-Ebene („Gebaeudeflaeche", „Verkehrslinie" …) als Eigenschaft
 * `_layer` an jedes Feature. Darüber filtert der Style. Die übrigen
 * Eigenschaften (`klasse`, `name`, `funktion` …) sind die der Quelle,
 * unverändert.
 *
 * **Nicht alles zeigen.** Der Datensatz führt über dreißig Ebenen, darunter
 * flächendeckende wie Vegetation, Siedlungsfläche und Hintergrund. Drapiert
 * deckten sie das Luftbild vollständig zu. Gezeigt werden deshalb nur Themen,
 * die über einem Luftbild eine Aussage tragen — und jede davon halbdurchlässig.
 *
 * **Auflegen auf Gelände, nicht auf Modelle — voreingestellt.**
 * `CLAMP_TO_GROUND` legt die Karte auf Gelände UND 3D-Kacheln, also auch auf
 * das Dach eines geladenen IFC-Modells. Für eine Kulisse um ein Fachmodell ist
 * das falsch; wählbar bleibt es, weil es über Google 3D Tiles (Globus aus) der
 * einzige Weg ist, die Karte zu sehen. Die Auflage ist eine Konstruktoroption
 * des Providers — ein Wechsel lädt die Ebene neu.
 *
 * `MVTDataProvider` ist in Cesium als experimentell markiert. Fehlt er (ältere
 * Cesium-Version), meldet die Zeile das, statt stumm nichts zu tun.
 */
(function () {
  'use strict';

  var SPEICHER = 'ileen_vektorkacheln_v1';

  var QUELLE = {
    name: 'basemap.de',
    url: 'https://sgx.geodatenzentrum.de/gdz_basemapde_vektor/tiles/v2/bm_web_de_3857/{z}/{x}/{y}.pbf',
    maxZoom: 15,
    // Aus der TileJSON: Kacheln außerhalb gibt es nicht, also auch nicht anfragen.
    grenzen: [5.8, 47.2, 15.1, 55.1],
    credit: '© basemap.de / BKG | Datenquellen: © GeoBasis-DE'
  };

  // Reihenfolge = Reihenfolge der Bedingungen im Style; die erste passende gewinnt.
  var THEMEN = [
    { id: 'gebaeude',  key: 'vector.buildings', ebenen: ['Gebaeudeflaeche'],                  farbe: "color('#e4572e', 0.55)", an: true },
    { id: 'verkehr',   key: 'vector.traffic',   ebenen: ['Verkehrslinie', 'Verkehrsflaeche'], farbe: "color('#ffc914', 0.8)",  an: true },
    { id: 'gewaesser', key: 'vector.water',     ebenen: ['Gewaesserflaeche', 'Gewaesserlinie'], farbe: "color('#2e86de', 0.6)", an: true },
    { id: 'grenzen',   key: 'vector.borders',   ebenen: ['Grenze_Linie'],                     farbe: "color('#b33dc6', 0.9)",  an: false }
  ];

  var S = {
    aktiv: false,          // gewünschter Zustand — kann während des Ladens umspringen
    laedt: false,
    provider: null,
    klick: null,
    credit: null,
    auflage: 'gelaende',   // 'gelaende' | 'alles'
    themen: {}
  };
  THEMEN.forEach(function (t) { S.themen[t.id] = t.an; });

  try {
    var g = JSON.parse(localStorage.getItem(SPEICHER) || '{}');
    if (g.auflage === 'gelaende' || g.auflage === 'alles') S.auflage = g.auflage;
    if (g.themen) THEMEN.forEach(function (t) {
      if (typeof g.themen[t.id] === 'boolean') S.themen[t.id] = g.themen[t.id];
    });
  } catch (e) { /* Voreinstellung */ }

  function sichern() {
    try { localStorage.setItem(SPEICHER, JSON.stringify({ auflage: S.auflage, themen: S.themen })); } catch (e) { /* egal */ }
  }

  function tr(key, rueckfall) {
    var s = (typeof window.t === 'function') ? window.t(key) : key;
    return s === key && rueckfall ? rueckfall : s;
  }

  function viewer() { return window.BimViewer && window.BimViewer.viewer; }

  function melden(text, art) {
    if (window.BimViewer && typeof window.BimViewer.updateStatus === 'function') {
      window.BimViewer.updateStatus(text, art || 'success');
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Style ───────────────────────────────────────────────────────────────

  function ebenenBedingung(thema) {
    return thema.ebenen.map(function (e) { return "${_layer} === '" + e + "'"; }).join(' || ');
  }

  /** Style-Definition aus den eingeschalteten Themen — rein, prüfbar. */
  function stilDefinition(themen) {
    var aktive = THEMEN.filter(function (t) { return themen[t.id]; });
    if (!aktive.length) return { show: 'false' };
    return {
      show: aktive.map(function (t) { return '(' + ebenenBedingung(t) + ')'; }).join(' || '),
      color: {
        conditions: aktive.map(function (t) { return [ebenenBedingung(t), t.farbe]; })
          .concat([['true', "color('#ffffff', 0.0)"]])
      }
    };
  }

  function stilAnwenden() {
    if (S.provider && S.provider.tileset) {
      S.provider.tileset.style = new Cesium.Cesium3DTileStyle(stilDefinition(S.themen));
    }
  }

  // ── Laden und Entladen ──────────────────────────────────────────────────

  async function einschalten() {
    var v = viewer();
    S.aktiv = true;
    if (!v || S.provider || S.laedt) { panelZeichnen(); return; }

    if (typeof Cesium.MVTDataProvider === 'undefined') {
      S.aktiv = false;
      melden('Vektorkacheln brauchen CesiumJS ≥ 1.145', 'error');
      panelZeichnen();
      return;
    }
    if (v.scene.mode !== Cesium.SceneMode.SCENE3D) {
      S.aktiv = false;
      melden('Vektorkarte nur im 3D-Modus', 'warning');
      panelZeichnen();
      return;
    }

    S.laedt = true;
    panelZeichnen();
    var p = null;
    try {
      var b = QUELLE.grenzen;
      p = await Cesium.MVTDataProvider.fromUrl(QUELLE.url, {
        maxZoom: QUELLE.maxZoom,
        extent: Cesium.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]),
        heightReference: S.auflage === 'alles'
          ? Cesium.HeightReference.CLAMP_TO_GROUND
          : Cesium.HeightReference.CLAMP_TO_TERRAIN,
        scene: v.scene
      });
      // Während des Ladens abgeschaltet: nichts in die Szene hängen.
      if (!S.aktiv) { p.destroy(); return; }

      S.provider = p;
      stilAnwenden();
      v.scene.primitives.add(p);
      S.credit = new Cesium.Credit(QUELLE.credit, false);
      v.creditDisplay.addStaticCredit(S.credit);
      klickAnhaengen(v);
      melden(QUELLE.name + ' Vektorkarte geladen', 'success');
    } catch (err) {
      console.error('Vektorkacheln:', err);
      S.aktiv = false;
      if (p && !S.provider && !p.isDestroyed()) p.destroy();
      melden(QUELLE.name + ' nicht erreichbar', 'error');
    } finally {
      S.laedt = false;
      panelZeichnen();
    }
  }

  function ausschalten() {
    var v = viewer();
    S.aktiv = false;
    if (S.klick) { S.klick.destroy(); S.klick = null; }
    if (v && S.credit) { v.creditDisplay.removeStaticCredit(S.credit); }
    S.credit = null;
    // primitives.remove zerstört den Provider samt Tileset (destroyPrimitives).
    if (v && S.provider) v.scene.primitives.remove(S.provider);
    S.provider = null;
    panelZeichnen();
  }

  function klickAnhaengen(v) {
    S.klick = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    S.klick.setInputAction(function (bewegung) {
      var getroffen = v.scene.pick(bewegung.position);
      if (!(getroffen instanceof Cesium.Cesium3DTileFeature)) return;
      if (!S.provider || getroffen.tileset !== S.provider.tileset) return;
      var eigenschaften = featureEigenschaften(getroffen);
      // Verzögert, damit diese Ausgabe die des allgemeinen IFC-Handlers
      // überschreibt — dieselbe Reihenfolge wie bei den LoD2-Gebäuden.
      setTimeout(function () {
        if (typeof window.BimViewer.displayIFCProperties === 'function') {
          window.BimViewer.displayIFCProperties(eigenschaften);
        }
      }, 0);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  /** Eigenschaften eines Features ohne leere Werte, Quellebene als Kopf. */
  function featureEigenschaften(feature) {
    var props = {};
    var ids = typeof feature.getPropertyIds === 'function' ? feature.getPropertyIds() : [];
    ids.forEach(function (id) {
      if (id === '_layer') return;
      var wert = feature.getProperty(id);
      if (wert === undefined || wert === null || wert === '') return;
      props[id] = wert;
    });
    props['_Layer'] = QUELLE.name + ' · ' + (feature.getProperty('_layer') || '?');
    return props;
  }

  // ── Panel ───────────────────────────────────────────────────────────────

  function panelZeichnen() {
    var box = document.getElementById('vectorLayersList');
    if (!box) return;

    var zeilen = [];
    zeilen.push(
      '<div class="row" title="' + esc(QUELLE.credit) + '">' +
        '<span class="row__label">' + QUELLE.name +
          (S.laedt ? ' <span class="unit">' + tr('vector.loading', 'lädt …') + '</span>' : '') +
        '</span>' +
        '<label class="switch">' +
          '<input type="checkbox" data-vk="aktiv"' + (S.aktiv ? ' checked' : '') + (S.laedt ? ' disabled' : '') + '>' +
          '<span class="switch__track"></span>' +
        '</label>' +
      '</div>'
    );
    zeilen.push(
      '<div class="row">' +
        '<span class="row__label">' + tr('vector.drape', 'Auflegen auf') + '</span>' +
        '<select class="select" data-vk="auflage">' +
          '<option value="gelaende"' + (S.auflage === 'gelaende' ? ' selected' : '') + '>' + tr('vector.drapeTerrain', 'Gelände') + '</option>' +
          '<option value="alles"' + (S.auflage === 'alles' ? ' selected' : '') + '>' + tr('vector.drapeAll', 'Gelände und Modelle') + '</option>' +
        '</select>' +
      '</div>'
    );
    THEMEN.forEach(function (th) {
      zeilen.push(
        '<div class="row">' +
          '<span class="row__label">' + tr(th.key, th.id) + '</span>' +
          '<label class="switch">' +
            '<input type="checkbox" data-vk-thema="' + th.id + '"' + (S.themen[th.id] ? ' checked' : '') + '>' +
            '<span class="switch__track"></span>' +
          '</label>' +
        '</div>'
      );
    });
    box.innerHTML = zeilen.join('');

    // Der Behälter entsteht bei jedem Panel-Neuaufbau neu; gebunden wird am
    // Element, nicht einmal global.
    if (!box._vkGebunden) {
      box._vkGebunden = true;
      box.addEventListener('change', function (e) {
        var ziel = e.target;
        if (ziel.dataset.vk === 'aktiv') {
          if (ziel.checked) einschalten(); else ausschalten();
        } else if (ziel.dataset.vk === 'auflage') {
          auflageSetzen(ziel.value);
        } else if (ziel.dataset.vkThema) {
          themaSetzen(ziel.dataset.vkThema, ziel.checked);
        }
      });
    }
  }

  function themaSetzen(id, an) {
    if (!(id in S.themen)) return;
    S.themen[id] = !!an;
    sichern();
    stilAnwenden();
  }

  function auflageSetzen(wert) {
    if (wert !== 'gelaende' && wert !== 'alles') return;
    if (wert === S.auflage) return;
    S.auflage = wert;
    sichern();
    if (S.provider) {
      ausschalten();
      einschalten();
    } else {
      panelZeichnen();
    }
  }

  window.Vektorkacheln = {
    einschalten: einschalten,
    ausschalten: ausschalten,
    themaSetzen: themaSetzen,
    auflageSetzen: auflageSetzen,
    panelZeichnen: panelZeichnen,
    stand: function () {
      return {
        aktiv: S.aktiv,
        geladen: !!S.provider,
        laedt: S.laedt,
        auflage: S.auflage,
        themen: Object.assign({}, S.themen),
        quelle: QUELLE.url
      };
    },
    _pruefsteine: {
      stilDefinition: stilDefinition,
      featureEigenschaften: featureEigenschaften,
      THEMEN: THEMEN,
      QUELLE: QUELLE,
      provider: function () { return S.provider; }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', panelZeichnen);
  } else {
    panelZeichnen();
  }
})();
