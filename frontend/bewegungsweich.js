/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// BEWEGUNG WEICH — in Fahrt weniger Detail verlangen
//
// Philipp: „der Sprung von einem zum anderen oder zu einem Modell ist etwas
// juddery durch die Tiles, die geladen werden."
//
// Beim Flug in neue Gegenden fordert Cesium auf einmal Dutzende Kacheln an,
// entpackt sie und lädt sie auf die Grafikkarte — das sind die Hänger.
// Solange die Kamera in Fahrt ist, wird deshalb weniger Detail verlangt:
// `maximumScreenSpaceError` des Globus (Gelände, Luftbild) und der
// Modell-Kacheln (IFC, Google 3D Tiles, LoD2) steigt um einen Faktor, der mit
// der Fahrt wächst. Weniger Kacheln heißt weniger Arbeit je Bild.
//
// (Ein Schleier — leichter Weichzeichner, ausgewaschen —, der das Hereinspringen
// der feinen Kacheln verdeckte, war eine Zeit lang dabei und ist auf Philipps
// Wunsch wieder draußen. Das Detail kommt jetzt sichtbar herein, deshalb geht
// der Verzicht nach der Landung schrittweise zurück und nicht in einem Schritt.)
//
// Wie stark die Fahrt wirkt, entscheidet, wie viel NEUES zu sehen ist, nicht
// wie schnell die Kamera ist: der Sprung (Abstand ÷ Höhe über Grund). Ein
// Hüpfer von 30 m in einem Raum, wo man 20 m hoch steht (Sprung 1,5), ändert
// kaum etwas an den Kacheln und bleibt unberührt; ein Flug von Mainz zum Campus
// (Sprung 20) oder aus dem All zum Gebäude (Sprung > 1000) lädt alles neu und
// bekommt den vollen Verzicht. Frei geführte Bewegung (Maus, Tasten) wird nach
// Geschwindigkeit in Höhen je Sekunde bemessen und erst bei wirklich schneller
// Fahrt gedrosselt — Umsehen und Verschieben bleiben, wie sie sind.
//
// Der Ablauf einer Fahrt:
//
//   Fahrt      der Verzicht steigt in ~0,12 s auf den Wert des Sprungs
//   Nachlauf   die Kamera steht (0,3 s): der Verzicht nimmt über ~0,8 s ab, damit
//              die feinen Kacheln nicht alle auf einmal anfallen (gemessen am
//              Campus-IFC: der Schub nach der Landung ist der zweite Hänger)
//
// Gaussian Splats und Punktwolken regeln ihre Detailstufe selbst; ihr
// Bildschirmfehler bleibt unangetastet. Aus ist der Verzicht während einer
// Präsentationsvorführung (`body.praes-laeuft`).
//
// Zurückgegeben wird nur, was dieses Modul genommen hat: stellt jemand anderes
// `maximumScreenSpaceError` um (Darstellungsstufe, Google-Qualität), gilt
// dessen Wert als neuer Ausgangspunkt, genau wie bei bewegungsguete.js.
//
// Ausschalten: localStorage.ileen_bewegungsweich = 'aus' oder
// BimViewer.Bewegungsweich.aus(). Einstellen: .einstellen({ sprungAb: 3 }).
// ===============================
'use strict';

(function () {

  var VORGABE = {
    sprungAb: 1.2,        // Sprung (Abstand ÷ Höhe), ab dem ein Flug etwas drosselt
    sprungVoll: 9,        // … und ab dem er voll drosselt
    freiAb: 8,            // frei geführt: Höhen je Sekunde, ab denen die Drosselung beginnt
    freiVoll: 40,         // … und voll ist
    drehGewicht: 2,       // eine Drehung von 1 rad/s zählt wie so viele Höhen je Sekunde
    bewegtAb: 0.03,       // darunter steht die Kamera
    hoeheMin: 30,         // m; flacher bemisst sich eine Höhe nicht (sonst „Sprung" beim Gehen)
    tauAuf: 0.12,         // s; so schnell steigt der Verzicht
    ruheS: 0.3,           // s ohne Bewegung bis zum Nachlauf
    sseAbS: 0.8,          // s, in denen der Verzicht nach der Landung zurückgeht
    sseGlobus: 2.0,       // Bildschirmfehler des Globus bis ×(1 + 2)
    sseModell: 1.5,       // der Modell-Kacheln bis ×(1 + 1,5)
    sseStufe: 0.25,       // Faktor in Stufen, damit nicht jedes Bild neu auswählt
  };

  // ── Rechenkern (ohne Cesium, prüfbar) ─────────────────────────────────

  function glatt(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function neuerZustand(optionen) {
    return {
      o: Object.assign({}, VORGABE, optionen || {}),
      sse: 0,          // Detailverzicht 0 … 1
      halten: 0,       // Spitze der laufenden Fahrt
      sprung: 0,       // größter angekündigter Flug dieser Fahrt
      still: 0,        // s ohne Bewegung
      phase: 'ruhe',   // ruhe | fahrt | nachlauf
    };
  }

  /** Ein Flug wird angekündigt (Abstand ÷ Höhe); der größte der Fahrt zählt. */
  function sprungMelden(z, sprung) {
    if (sprung > z.sprung) z.sprung = sprung;
  }

  /**
   * Ein Bild. `dt` in s; `e`:
   *   flug     läuft ein Kameraflug?
   *   rel      Bewegung in Höhen je Sekunde (Weg ÷ Höhe + Drehung × drehGewicht)
   * Gibt { sse } zurück — den Detailverzicht (0 … 1) für dieses Bild.
   */
  function schritt(z, dt, e) {
    var o = z.o;
    var ziel;
    if (e.flug) ziel = glatt(o.sprungAb, o.sprungVoll, z.sprung > 0 ? z.sprung : 4);
    else ziel = glatt(o.freiAb, o.freiVoll, e.rel);
    var bewegt = e.flug || e.rel > o.bewegtAb;

    if (e.flug || ziel > 0.02) {
      // Fahrt: der Verzicht steigt auf die Spitze und fällt nicht, solange die Bewegung läuft
      z.phase = 'fahrt';
      z.still = 0;
      if (ziel > z.halten) z.halten = ziel;
      z.sse += (z.halten - z.sse) * (1 - Math.exp(-dt / o.tauAuf));
    } else {
      z.still = bewegt ? 0 : z.still + dt;
      if (z.phase === 'fahrt' && z.still >= o.ruheS) {
        z.phase = z.halten > 0.02 ? 'nachlauf' : 'ruhe';
        z.sprung = 0;
      }
      if (z.phase === 'nachlauf') {
        // schrittweise zurück: sonst käme der ganze feine Satz Kacheln auf einmal
        z.sse = Math.max(0, z.sse - dt / o.sseAbS);
        if (z.sse === 0) { z.phase = 'ruhe'; z.halten = 0; }
      } else if (z.phase === 'ruhe') {
        z.sse = 0;
        z.halten = 0;
      }
    }
    return { sse: z.sse };
  }

  /** Faktor auf den Bildschirmfehler, in Stufen (sonst wählt Cesium bei jedem Bild neu aus). */
  function sseFaktor(zusatz, sse, stufe) {
    var f = 1 + zusatz * sse;
    return stufe > 0 ? 1 + Math.round((f - 1) / stufe) * stufe : f;
  }

  /** Bewegung in Höhen je Sekunde: Weg und Drehung, auf die Höhe über Grund bezogen. */
  function bewegung(weg, drehung, hoehe, dt, o) {
    if (!(dt > 0)) return 0;
    var h = Math.max(o.hoeheMin, hoehe);
    return (weg / h + drehung * o.drehGewicht) / dt;
  }

  // ── Anbindung an den Viewer ───────────────────────────────────────────

  var regler = null;

  function praesentation() {
    return !!(document.body && document.body.classList.contains('praes-laeuft'));
  }

  /** Mesh-Kacheln, deren Detail der Regler zurücknehmen darf: IFC, Google 3D Tiles, LoD2 … */
  function modellKacheln() {
    var liste = [];
    var BV = window.BimViewer;
    if (BV && BV.loadedAssets) {
      BV.loadedAssets.forEach(function (a) {
        var ts = a && a.tileset;
        if (ts && !a.isPointCloud && !ts._isGaussianSplat) liste.push(ts);
      });
    }
    if (BV && BV.googleTiles && BV.googleTiles.tileset && BV.googleTiles.enabled) liste.push(BV.googleTiles.tileset);
    var LM = window.LayerManager;
    if (LM && LM.tilesetLayers) {
      LM.tilesetLayers.forEach(function (e) { if (e.tileset && e.active) liste.push(e.tileset); });
    }
    return liste;
  }

  /**
   * Bildschirmfehler setzen: Ausgangswert merken, Faktor darauflegen. Hat
   * jemand anderes den Wert verändert, gilt der als neuer Ausgangswert.
   */
  function fehlerSetzen(spur, objekt, faktor) {
    var jetzt = objekt.maximumScreenSpaceError;
    var s = spur.get(objekt);
    if (s && jetzt !== s.gesetzt) s = null;                  // fremd geändert → neuer Ausgang
    if (!s) {
      if (faktor === 1) { spur.delete(objekt); return; }
      s = { basis: jetzt, gesetzt: jetzt };
    }
    var neu = s.basis * faktor;
    if (neu !== jetzt) objekt.maximumScreenSpaceError = neu;
    s.gesetzt = neu;
    if (faktor === 1) spur.delete(objekt); else spur.set(objekt, s);
  }

  function detailNachziehen(r, sse) {
    var o = r.z.o;
    var scene = r.viewer.scene;
    var fg = sseFaktor(o.sseGlobus, sse, o.sseStufe);
    var fm = sseFaktor(o.sseModell, sse, o.sseStufe);
    if (scene.globe && (fg !== r.fg || r.fehlerlauf)) fehlerSetzen(r.spur, scene.globe, fg);
    if (fm !== r.fm || r.fehlerlauf) modellKacheln().forEach(function (ts) { fehlerSetzen(r.spur, ts, fm); });
    r.fg = fg; r.fm = fm;
    // Alle Sekunde nachsehen: neu geladene Kacheln brauchen den Faktor auch, und
    // wer den Wert fremd verstellt hat, wird dabei bemerkt.
    r.fehlerlauf = false;
  }

  /** Bewegung dieses Bildes: Weg und Drehung seit dem vorigen, auf die Höhe bezogen. */
  function messen(r, dt) {
    var cam = r.viewer.camera;
    var p = cam.positionWC, d = cam.directionWC;
    var rel = 0;
    if (r.pos) {
      var weg = Cesium.Cartesian3.distance(p, r.pos);
      var dreh = Math.acos(Math.min(1, Math.max(-1, Cesium.Cartesian3.dot(d, r.dir))));
      var hoehe = r.viewer.scene.globe
        ? r.viewer.scene.mapProjection.ellipsoid.cartesianToCartographic(p, r.carto).height
        : 1000;
      rel = bewegung(weg, dreh, hoehe, dt, r.z.o);
    }
    r.pos = Cesium.Cartesian3.clone(p, r.pos);
    r.dir = Cesium.Cartesian3.clone(d, r.dir);
    return rel;
  }

  function vorBild(r) {
    var t = performance.now();
    var dt = r.t === null ? 0 : (t - r.t) / 1000;
    r.t = t;
    if (dt <= 0 || dt > 0.25) { r.pos = null; return; }       // Pause (Tab im Hintergrund) ist kein Bild

    // Vorführung: Bild für Bild das, was die Einstellungen sagen
    if (praesentation()) {
      if (r.z.phase !== 'ruhe' || r.z.sse > 0) {
        Object.assign(r.z, { sse: 0, halten: 0, sprung: 0, phase: 'ruhe', still: 0 });
        detailNachziehen(r, 0);
      }
      r.pos = null;
      return;
    }

    var rel = messen(r, dt);
    var flug = r.viewer.scene.tweens.length > 0;
    var aus = schritt(r.z, dt, { flug: flug, rel: rel });
    r.rel = rel;
    detailNachziehen(r, aus.sse);
  }

  /** Flug ankündigen: Sprung = Abstand zum Ziel ÷ Höhe über Grund. */
  function fluegeAbfangen(r) {
    var cam = r.viewer.camera;
    var orig = cam.flyTo;
    cam.flyTo = function (optionen) {
      try {
        var ziel = optionen && optionen.destination;
        if (ziel && typeof Cesium.Rectangle === 'function' && ziel instanceof Cesium.Rectangle) {
          ziel = cam.getRectangleCameraCoordinates(ziel);
        }
        if (ziel && !(optionen.duration === 0)) {
          var ell = r.viewer.scene.mapProjection.ellipsoid;
          var hJetzt = ell.cartesianToCartographic(cam.positionWC).height;
          var hZiel = ell.cartesianToCartographic(ziel).height;
          var h = Math.max(r.z.o.hoeheMin, Math.min(hJetzt, hZiel));
          sprungMelden(r.z, Cesium.Cartesian3.distance(cam.positionWC, ziel) / h);
        }
      } catch (e) { /* Ankündigung ist Beiwerk: der Flug selbst darf nie daran scheitern */ }
      return orig.apply(this, arguments);
    };
    r.fluegeFrei = function () { if (cam.flyTo !== orig) delete cam.flyTo; };
  }

  function an(viewer, optionen) {
    aus();
    var r = {
      viewer: viewer, z: neuerZustand(optionen),
      t: null, pos: null, dir: null, rel: 0,
      carto: new Cesium.Cartographic(),
      spur: new WeakMap(), fg: 1, fm: 1, fehlerlauf: false,
    };
    r.vor = viewer.scene.preRender.addEventListener(function () { vorBild(r); });
    r.takt = setInterval(function () { r.fehlerlauf = true; }, 1000);
    fluegeAbfangen(r);
    regler = r;
    return stand();
  }

  function aus() {
    if (!regler) return;
    var r = regler;
    regler = null;
    r.vor(); clearInterval(r.takt);
    r.fluegeFrei();
    r.fehlerlauf = true;
    try { detailNachziehen(r, 0); } catch (e) { /* Viewer weg */ }
  }

  function einstellen(teil) {
    if (regler) Object.assign(regler.z.o, teil || {});
    return stand();
  }

  function stand() {
    if (!regler) return { an: false };
    var z = regler.z;
    return {
      an: true,
      phase: z.phase,
      detailverzicht: +z.sse.toFixed(3),
      sprung: +z.sprung.toFixed(2),
      bewegung: +regler.rel.toFixed(2),
      faktorGlobus: regler.fg,
      faktorModell: regler.fm,
    };
  }

  window.Bewegungsweich = {
    an: an, aus: aus, einstellen: einstellen, stand: stand,
    _pruefsteine: {
      neuerZustand: neuerZustand, schritt: schritt, sprungMelden: sprungMelden,
      sseFaktor: sseFaktor, bewegung: bewegung, fehlerSetzen: fehlerSetzen,
      VORGABE: VORGABE,
    },
  };

  // Start, sobald der Viewer steht (wie die übrigen Werkzeuge: keine feste Ladereihenfolge)
  var versuche = 0;
  var warten = setInterval(function () {
    if (++versuche > 240) { clearInterval(warten); return; }
    if (!window.BimViewer || !BimViewer.viewer || !BimViewer.viewer.scene || !BimViewer._currentPerformanceSettings) return;
    clearInterval(warten);
    var aus_ = false;
    try { aus_ = localStorage.getItem('ileen_bewegungsweich') === 'aus'; } catch (e) { /* privat */ }
    if (!aus_) {
      an(BimViewer.viewer);
      BimViewer.Bewegungsweich = window.Bewegungsweich;
    }
  }, 250);

})();
