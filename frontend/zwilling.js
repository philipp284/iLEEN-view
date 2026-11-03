/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

/*
 * MAINZ-ZWILLING — alle Fachdaten des Projekts 2026_1031_mainz_zwilling auf dem Gelände
 *
 * Kataster (ALKIS), rechtliche Festlegungen, Wasser, Untergrund (LGB), Verkehr
 * (Mobilitätsatlas), OpenStreetMap, Wikidata und Live-Schnappschüsse: 83 Ebenen,
 * gut 420 000 Objekte. Als GeoJSON wären das 800 MB im Browser; deshalb macht
 * `projekte/2026_1031_mainz_zwilling/skripte/fuer_ileen.py` daraus EINEN
 * Vektorkachelsatz (tippecanoe) nach `data/zwilling/` (gitignored) mit einem
 * `katalog.json` daneben — Titel, Gruppe, Farbe, Anzahl je Ebene.
 *
 * Gezeichnet wird wie in vektorkacheln.js über Cesiums `MVTDataProvider`:
 * eine Quelle, ein Tileset, und welche Ebene zu sehen ist, entscheidet allein
 * der Style über `${_layer}`. Ein- und Ausschalten lädt also nichts nach,
 * es tauscht nur den Style. Kleinteiliges (Flurstücke, Gebäude, OSM-Punkte)
 * steht erst ab Zoomstufe 13/14 in den Kacheln — aus der Ferne wäre es Rauschen
 * und füllte jede Übersichtskachel.
 *
 * Punkte gehen einen eigenen Weg: Cesiums MVT-Lader legt sie zwar an, gezeichnet
 * wurden sie im Versuch nicht (auch nicht mit 24 px). Sie kommen deshalb als
 * `punkte/<ebene>.json` und werden hier als Billboards aufs Gelände geklemmt —
 * geladen erst, wenn jemand die Ebene einschaltet. Flurstücke und andere
 * lückenlose Einteilungen stehen als Umrisslinien in den Kacheln, weil Cesium
 * für Vektorflächen keinen Umriss kennt.
 *
 * Die Live-Ebenen sind Schnappschüsse vom Zeitpunkt des Bauens, nicht live.
 */
(function () {
  'use strict';

  var SPEICHER = 'ileen_zwilling_v1';
  var BASIS = 'data/zwilling/';
  var MAINZ = { lon: 8.2711, lat: 49.9929 };

  var S = {
    katalog: null,
    fehler: '',
    aktiv: false,
    laedt: false,
    provider: null,
    klick: null,
    credit: null,
    sichtbar: null,        // Set der Ebenen-IDs; null = Vorgabe aus dem Katalog
    suche: '',
    punkte: {},            // Ebene → { sammlung, laedt }
    offen: {}              // aufgeklappte Gruppen
  };

  try {
    var g = JSON.parse(localStorage.getItem(SPEICHER) || '{}');
    if (Array.isArray(g.sichtbar)) S.sichtbar = new Set(g.sichtbar);
    if (g.offen) S.offen = g.offen;
  } catch (e) { /* Vorgabe */ }

  function sichern() {
    try {
      localStorage.setItem(SPEICHER, JSON.stringify({ sichtbar: Array.from(S.sichtbar || []), offen: S.offen }));
    } catch (e) { /* egal */ }
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

  function zahl(n) { return Number(n).toLocaleString('de-DE'); }

  // ── Katalog ─────────────────────────────────────────────────────────────

  async function katalogLaden() {
    if (S.katalog) return S.katalog;
    try {
      var r = await fetch(BASIS + 'katalog.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      S.katalog = await r.json();
      if (!S.sichtbar) {
        S.sichtbar = new Set(S.katalog.ebenen.filter(function (e) { return e.an; }).map(function (e) { return e.id; }));
      }
      S.fehler = '';
    } catch (err) {
      S.fehler = 'Kein Kachelsatz gefunden (' + err.message + '). Bauen mit: ' +
        'python3 -I projekte/2026_1031_mainz_zwilling/skripte/fuer_ileen.py';
    }
    return S.katalog;
  }

  function ebene(id) {
    return S.katalog && S.katalog.ebenen.find(function (e) { return e.id === id; });
  }

  // ── Style ───────────────────────────────────────────────────────────────

  /** Deckkraft nach Geometrie: Flächen lassen Luftbild und Gelände durchscheinen. */
  function deckkraft(e) {
    if (e.arten.indexOf('flaeche') >= 0 && e.arten.length === 1) return 0.45;
    if (e.arten.indexOf('linie') >= 0 && e.arten.indexOf('punkt') < 0) return 0.9;
    return 1.0;
  }

  /** Style-Definition aus den sichtbaren Ebenen — rein, prüfbar. */
  function stilDefinition(ebenen, sichtbar) {
    var aktive = ebenen.filter(function (e) { return sichtbar.has(e.id); });
    if (!aktive.length) return { show: 'false' };
    function bed(e) { return "${_layer} === '" + e.id + "'"; }
    return {
      show: aktive.map(bed).join(' || '),
      color: {
        conditions: aktive.map(function (e) {
          return [bed(e), "color('" + e.farbe + "', " + deckkraft(e) + ')'];
        }).concat([['true', "color('#ffffff', 0.0)"]])
      },
      lineWidth: {
        conditions: aktive.map(function (e) { return [bed(e), e.umriss ? '1.5' : '2.5']; }).concat([['true', '1']])
      }
    };
  }

  function stilAnwenden() {
    if (S.provider && S.provider.tileset && S.katalog) {
      S.provider.tileset.style = new Cesium.Cesium3DTileStyle(stilDefinition(S.katalog.ebenen, S.sichtbar));
    }
  }

  // ── Punkte ──────────────────────────────────────────────────────────────

  var marken = {};
  /** Runde Marke in der Ebenenfarbe mit weißem Rand, je Farbe einmal gemalt. */
  function marke(farbe) {
    if (marken[farbe]) return marken[farbe];
    var c = document.createElement('canvas');
    c.width = c.height = 20;
    var g = c.getContext('2d');
    g.beginPath(); g.arc(10, 10, 8, 0, 2 * Math.PI);
    g.fillStyle = farbe; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = '#ffffff'; g.stroke();
    return (marken[farbe] = c);
  }

  async function punkteLaden(e) {
    var v = viewer();
    var p = S.punkte[e.id] || (S.punkte[e.id] = { sammlung: null, laedt: false });
    if (p.sammlung || p.laedt || !v) return;
    p.laedt = true;
    try {
      var r = await fetch(BASIS + e.punkte);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var daten = await r.json();
      var sammlung = new Cesium.BillboardCollection({ scene: v.scene });
      var bild = marke(e.farbe);
      // Große Ebenen (Ladesäulen, OSM-Punkte) nur aus der Nähe, sonst ein Teppich
      var weit = e.anzahl > 5000 ? 6000 : 80000;
      var sichtbar = new Cesium.DistanceDisplayCondition(0, weit);
      var schrumpfen = new Cesium.NearFarScalar(300, 1.0, 20000, 0.45);
      daten.objekte.forEach(function (o) {
        sammlung.add({
          position: Cesium.Cartesian3.fromDegrees(o[0], o[1]),
          image: bild,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          scaleByDistance: schrumpfen,
          distanceDisplayCondition: sichtbar,
          // Über dem Gelände immer sichtbar, aus der Ferne nicht durch Häuser hindurch
          disableDepthTestDistance: 1500,
          id: { zwilling: e.id, eigenschaften: o[2] }
        });
      });
      sammlung.show = S.aktiv && S.sichtbar.has(e.id);
      v.scene.primitives.add(sammlung);
      p.sammlung = sammlung;
    } catch (err) {
      console.error('[Zwilling] Punkte ' + e.id + ':', err);
      melden('Mainz-Zwilling: ' + e.titel + ' nicht geladen (' + err.message + ')', 'error');
    } finally {
      p.laedt = false;
    }
  }

  /** Punktebenen an Schalter und Gesamtschalter angleichen. */
  function punkteAbgleichen() {
    if (!S.katalog) return;
    S.katalog.ebenen.forEach(function (e) {
      if (!e.punkte) return;
      var soll = S.aktiv && S.sichtbar.has(e.id);
      var p = S.punkte[e.id];
      if (p && p.sammlung) p.sammlung.show = soll;
      else if (soll) punkteLaden(e);
    });
  }

  // ── Laden und Entladen ──────────────────────────────────────────────────

  async function einschalten() {
    var v = viewer();
    S.aktiv = true;
    if (!v || S.provider || S.laedt) { zeichnen(); return; }
    if (typeof Cesium.MVTDataProvider === 'undefined') {
      S.aktiv = false;
      melden('Vektorkacheln brauchen CesiumJS ≥ 1.145', 'error');
      zeichnen();
      return;
    }
    S.laedt = true;
    zeichnen();
    var p = null;
    try {
      var k = await katalogLaden();
      if (!k) throw new Error(S.fehler);
      var b = k.grenzen;
      p = await Cesium.MVTDataProvider.fromUrl(new URL(BASIS + k.kacheln, location.href).href, {
        minZoom: k.minZoom,
        maxZoom: k.maxZoom,
        extent: Cesium.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]),
        heightReference: Cesium.HeightReference.CLAMP_TO_TERRAIN,
        scene: v.scene
      });
      if (!S.aktiv) { p.destroy(); return; }
      S.provider = p;
      stilAnwenden();
      punkteAbgleichen();
      v.scene.primitives.add(p);
      S.credit = new Cesium.Credit('Mainz-Zwilling: ' + k.gruppen.map(function (gr) { return gr.lizenz; })
        .filter(function (l, i, a) { return a.indexOf(l) === i; }).join(' · '), false);
      v.creditDisplay.addStaticCredit(S.credit);
      klickAnhaengen(v);
      melden('Mainz-Zwilling: ' + k.ebenen.length + ' Ebenen bereit', 'success');
    } catch (err) {
      console.error('[Zwilling]', err);
      S.aktiv = false;
      if (p && !S.provider && !p.isDestroyed()) p.destroy();
      melden('Mainz-Zwilling: ' + err.message, 'error');
    } finally {
      S.laedt = false;
      zeichnen();
    }
  }

  function ausschalten() {
    var v = viewer();
    S.aktiv = false;
    if (S.klick) { S.klick.destroy(); S.klick = null; }
    if (v && S.credit) v.creditDisplay.removeStaticCredit(S.credit);
    S.credit = null;
    if (v && S.provider) v.scene.primitives.remove(S.provider);
    S.provider = null;
    punkteAbgleichen();
    zeichnen();
  }

  function klickAnhaengen(v) {
    S.klick = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    S.klick.setInputAction(function (bewegung) {
      var getroffen = v.scene.pick(bewegung.position);
      var eigenschaften;
      if (getroffen && getroffen.id && getroffen.id.zwilling) {
        eigenschaften = punktEigenschaften(getroffen.id);
      } else {
        if (!(getroffen instanceof Cesium.Cesium3DTileFeature)) return;
        if (!S.provider || getroffen.tileset !== S.provider.tileset) return;
        eigenschaften = featureEigenschaften(getroffen);
      }
      setTimeout(function () {
        if (typeof window.BimViewer.displayIFCProperties === 'function') {
          window.BimViewer.displayIFCProperties(eigenschaften);
        }
      }, 0);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function featureEigenschaften(feature) {
    var props = {};
    var ids = typeof feature.getPropertyIds === 'function' ? feature.getPropertyIds() : [];
    ids.forEach(function (id) {
      if (id === '_layer') return;
      var wert = feature.getProperty(id);
      if (wert === undefined || wert === null || wert === '') return;
      props[id] = wert;
    });
    var e = ebene(feature.getProperty('_layer'));
    var gruppe = e && S.katalog.gruppen.find(function (gr) { return gr.id === e.gruppe; });
    props['_Layer'] = 'Mainz-Zwilling · ' + (e ? e.titel : feature.getProperty('_layer'));
    if (gruppe) props['_Quelle'] = gruppe.lizenz;
    return props;
  }

  function punktEigenschaften(kennung) {
    var props = Object.assign({}, kennung.eigenschaften);
    var e = ebene(kennung.zwilling);
    var gruppe = e && S.katalog.gruppen.find(function (gr) { return gr.id === e.gruppe; });
    props['_Layer'] = 'Mainz-Zwilling · ' + (e ? e.titel : kennung.zwilling);
    if (gruppe) props['_Quelle'] = gruppe.lizenz;
    return props;
  }

  // ── Sichtbarkeit ────────────────────────────────────────────────────────

  async function setzen(ids, an) {
    // Von außen (Konsole, MCP) auch vor dem ersten Öffnen des Panels aufrufbar
    if (!S.sichtbar) await katalogLaden();
    if (!S.sichtbar) S.sichtbar = new Set();
    ids.forEach(function (id) { if (an) S.sichtbar.add(id); else S.sichtbar.delete(id); });
    sichern();
    stilAnwenden();
    punkteAbgleichen();
    if (an && !S.aktiv) einschalten(); else zeichnen();
  }

  function hinfliegen() {
    var v = viewer();
    if (!v) return;
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(MAINZ.lon, MAINZ.lat - 0.045, 3500),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
      duration: 2
    });
  }

  // ── Panel ───────────────────────────────────────────────────────────────

  function markup() {
    return '<div class="section"><div id="zwillingPanel"><div class="hint">Lädt …</div></div></div>';
  }

  function passt(e) {
    if (!S.suche) return true;
    var q = S.suche.toLowerCase();
    return e.titel.toLowerCase().indexOf(q) >= 0 || e.id.indexOf(q) >= 0;
  }

  async function zeichnen() {
    var box = document.getElementById('zwillingPanel');
    if (!box) return;
    if (!S.katalog && !S.fehler) { await katalogLaden(); box = document.getElementById('zwillingPanel'); if (!box) return; }
    if (!S.katalog) {
      box.innerHTML = '<div class="hint hint--warn">' + esc(S.fehler) + '</div>';
      return;
    }
    var k = S.katalog;
    var z = [];
    z.push(
      '<div class="row">' +
        '<span class="row__label">Auf dem Gelände zeigen' +
          (S.laedt ? ' <span class="unit">lädt …</span>' : '') + '</span>' +
        '<label class="switch"><input type="checkbox" data-zw="aktiv"' + (S.aktiv ? ' checked' : '') +
          (S.laedt ? ' disabled' : '') + '><span class="switch__track"></span></label>' +
      '</div>' +
      '<div class="input-row">' +
        '<input class="input" type="search" data-zw="suche" placeholder="Ebene suchen …" value="' + esc(S.suche) + '">' +
        '<button class="btn btn--sm" data-zw="hin" title="Kamera nach Mainz">🎯 Mainz</button>' +
      '</div>' +
      '<div class="row"><span class="row__label unit">' + k.ebenen.length + ' Ebenen · ' +
        zahl(k.ebenen.reduce(function (s, e) { return s + e.anzahl; }, 0)) + ' Objekte · ' +
        S.sichtbar.size + ' sichtbar</span>' +
        '<button class="btn btn--sm btn--ghost" data-zw="keine">alle aus</button></div>'
    );
    k.gruppen.forEach(function (gr) {
      var ebenen = k.ebenen.filter(function (e) { return e.gruppe === gr.id && passt(e); });
      if (!ebenen.length) return;
      var an = ebenen.filter(function (e) { return S.sichtbar.has(e.id); }).length;
      var offen = S.suche || S.offen[gr.id];
      z.push(
        '<details class="panel-group" data-zw-gruppe="' + gr.id + '"' + (offen ? ' open' : '') + '>' +
        '<summary title="' + esc(gr.lizenz) + '">' + esc(gr.titel) +
          ' <span class="unit">' + an + '/' + ebenen.length + '</span>' +
          '<label class="switch" style="float:right" onclick="event.stopPropagation()">' +
            '<input type="checkbox" data-zw-alle="' + gr.id + '"' + (an === ebenen.length ? ' checked' : '') + '>' +
            '<span class="switch__track"></span></label>' +
        '</summary>'
      );
      ebenen.forEach(function (e) {
        var zeichen = e.arten.indexOf('punkt') >= 0 ? '●' : e.arten.indexOf('linie') >= 0 ? '━' : '■';
        z.push(
          '<div class="row" title="' + esc(e.id) + (e.abZoom ? ' — erst aus der Nähe sichtbar' : '') + '">' +
            '<span class="row__label"><span style="color:' + e.farbe + '">' + zeichen + '</span> ' + esc(e.titel) +
              ' <span class="unit">' + zahl(e.anzahl) + (e.abZoom ? ' · nah' : '') + '</span></span>' +
            '<label class="switch"><input type="checkbox" data-zw-ebene="' + e.id + '"' +
              (S.sichtbar.has(e.id) ? ' checked' : '') + '><span class="switch__track"></span></label>' +
          '</div>'
        );
      });
      z.push('<div class="hint">' + esc(gr.lizenz) + '</div></details>');
    });
    z.push('<div class="hint">Stand des Kachelsatzes: ' + esc(k.erzeugt.replace('T', ' ')) +
      '. Live-Ebenen sind Schnappschüsse von diesem Zeitpunkt.</div>');
    box.innerHTML = z.join('');
    // Der Fokus der Suche überlebt das Neuzeichnen
    var feld = box.querySelector('[data-zw="suche"]');
    if (S._sucheFokus && feld) { feld.focus(); feld.setSelectionRange(feld.value.length, feld.value.length); }

    if (!box._zwGebunden) {
      box._zwGebunden = true;
      box.addEventListener('change', function (ev) {
        var t = ev.target;
        if (t.dataset.zw === 'aktiv') { if (t.checked) einschalten(); else ausschalten(); }
        else if (t.dataset.zwEbene) setzen([t.dataset.zwEbene], t.checked);
        else if (t.dataset.zwAlle) {
          setzen(S.katalog.ebenen.filter(function (e) { return e.gruppe === t.dataset.zwAlle && passt(e); })
            .map(function (e) { return e.id; }), t.checked);
        }
      });
      box.addEventListener('input', function (ev) {
        if (ev.target.dataset.zw !== 'suche') return;
        S.suche = ev.target.value.trim();
        S._sucheFokus = true;
        zeichnen();
      });
      box.addEventListener('click', function (ev) {
        var t = ev.target.closest('[data-zw]');
        if (!t) return;
        if (t.dataset.zw === 'hin') hinfliegen();
        if (t.dataset.zw === 'keine') setzen(Array.from(S.sichtbar), false);
      });
      box.addEventListener('toggle', function (ev) {
        var d = ev.target;
        if (d.dataset && d.dataset.zwGruppe && !S.suche) { S.offen[d.dataset.zwGruppe] = d.open; sichern(); }
      }, true);
    }
  }

  function anmelden() {
    if (!window.BimViewerUI || typeof BimViewerUI.bereichAnmelden !== 'function') return false;
    BimViewerUI.bereichAnmelden({
      id: 'zwilling', symbol: '🏙️', ordnung: 70,
      titel: () => 'Mainz-Zwilling',
      inhalt: markup,
      beimOeffnen: function () { setTimeout(zeichnen, 0); }
    });
    return true;
  }

  window.Zwilling = {
    einschalten: einschalten,
    ausschalten: ausschalten,
    setzen: setzen,
    hinfliegen: hinfliegen,
    zeichnen: zeichnen,
    stand: function () {
      return {
        aktiv: S.aktiv, geladen: !!S.provider, laedt: S.laedt, fehler: S.fehler,
        ebenen: S.katalog ? S.katalog.ebenen.length : 0,
        sichtbar: S.sichtbar ? Array.from(S.sichtbar) : []
      };
    },
    _pruefsteine: {
      stilDefinition: stilDefinition, featureEigenschaften: featureEigenschaften,
      provider: function () { return S.provider; },
      /** Sind alle eingeschalteten Punktebenen fertig geladen? */
      punkteBereit: function () {
        return !S.katalog || S.katalog.ebenen.every(function (e) {
          if (!e.punkte || !S.aktiv || !S.sichtbar.has(e.id)) return true;
          var p = S.punkte[e.id];
          return !!(p && p.sammlung);
        });
      },
      /** Ebene → Zahl der gezeigten Marken */
      punkteStand: function () {
        var aus = {};
        Object.keys(S.punkte).forEach(function (id) {
          var p = S.punkte[id];
          if (p.sammlung && p.sammlung.show) aus[id] = p.sammlung.length;
        });
        return aus;
      }
    }
  };

  if (!anmelden()) {
    var warten = setInterval(function () { if (anmelden()) clearInterval(warten); }, 200);
  }
})();
