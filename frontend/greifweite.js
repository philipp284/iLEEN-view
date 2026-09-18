/**
 * greifweite.js — wie weit man die Welt anfassen darf
 *
 * Cesium packt beim Ziehen den Punkt unter dem Zeiger und hält ihn dort fest.
 * Das ist genau richtig, solange der Punkt in der Nähe liegt. Erwischt man
 * dagegen knapp über dem Horizont ein Stück Gelände in zwanzig Kilometern
 * Entfernung, wird derselbe Zentimeter Zeigerweg zu einem Sprung über die
 * halbe Landschaft — man steht plötzlich woanders und weiß nicht, wo.
 *
 * Der zu weite Griff wird deshalb **gekürzt, nicht weggeworfen**: der Punkt
 * rutscht auf demselben Sehstrahl bis auf die erlaubte Weite heran. Gezogen
 * wird weiter — nur eben mit dem Hebel der Nähe statt dem der Ferne. (Die
 * erste Fassung hat den Griff verworfen; dann rotierte Cesium bloß noch auf
 * der Stelle, und Greifen und Vor-/Zurückschieben waren weg. Ein Werkzeug,
 * das eine Bewegung dämpfen soll, darf sie nicht abschaffen.)
 *
 * Greift der Strahl ins Leere, bleibt alles, wie es war: der Himmel ist kein
 * Griff, da schaut Cesium nur (`look3D`), und das ist richtig so.
 *
 * Die Grenze wächst mit der Höhe über Grund: unten im Detail ein paar Dutzend
 * Meter, über dem Quartier ein paar Kilometer. Wer hoch steht, meint auch
 * weite Wege.
 *
 *   Greifweite.einstellen({ faktor: 3, minimum: 30 });
 *   Greifweite.aus();  /  Greifweite.an();
 */
'use strict';

window.Greifweite = (function () {

  let viewer = null;
  let aktiv = true;
  let faktor = 4.0;        // × Höhe über Grund
  let minimum = 50.0;      // m — darunter wird nicht begrenzt

  // Die beiden Wege, auf denen der Kamera-Controller den Griff bestimmt.
  let originalGlobePick = null;
  let originalScenePick = null;
  let klemmeSteht = false;

  /**
   * Die Grenze in Metern. `hoeheUeberGrund` darf null sein (keine Kachel
   * geladen) — dann bleibt die Höhe über dem Ellipsoid der beste Anhaltspunkt.
   */
  function grenze(hoeheUeberGrund) {
    const h = (typeof hoeheUeberGrund === 'number' && isFinite(hoeheUeberGrund))
      ? Math.abs(hoeheUeberGrund) : 0;
    return Math.max(minimum, faktor * h);
  }

  function hoeheUeberGrund() {
    if (!viewer) return null;
    const scene = viewer.scene;
    const carto = viewer.camera.positionCartographic;
    if (!carto) return null;
    const globe = scene.globe;
    if (globe && typeof globe.getHeight === 'function') {
      const gelaende = globe.getHeight(carto);
      // getHeight liest nur die schon geladene Kachel — fehlt sie, ist die
      // Höhe über dem Ellipsoid die ehrlichere Näherung als eine erfundene 0.
      if (typeof gelaende === 'number' && isFinite(gelaende)) return carto.height - gelaende;
    }
    return carto.height;
  }

  /** Liegt der Treffer weiter weg als erlaubt? */
  function zuWeit(treffer, kamera, weite) {
    if (!treffer) return false;
    return Cesium.Cartesian3.distance(treffer, kamera) > weite;
  }

  /**
   * Zieht den Griffpunkt auf demselben Sehstrahl bis auf `weite` heran.
   * Verändert `treffer` an Ort und Stelle — Cesium reicht hier seine eigenen
   * Zwischenspeicher durch und erwartet genau dieses Objekt zurück.
   */
  function klemmen(treffer, kamera, weite) {
    if (!treffer) return treffer;
    const abstand = Cesium.Cartesian3.distance(treffer, kamera);
    if (!(abstand > weite) || !(abstand > 0)) return treffer;
    const anteil = weite / abstand;
    treffer.x = kamera.x + (treffer.x - kamera.x) * anteil;
    treffer.y = kamera.y + (treffer.y - kamera.y) * anteil;
    treffer.z = kamera.z + (treffer.z - kamera.z) * anteil;
    return treffer;
  }

  // =========================================================================
  // KLEMME — nur für die Dauer eines Zugs
  // =========================================================================

  /**
   * Die Begrenzung gilt ausschließlich zwischen Drücken und Loslassen. Beide
   * Pick-Funktionen benutzt auch der Rest der Anwendung (Messen, Anklicken,
   * Notizen), und dort wäre eine stillschweigende Reichweitengrenze ein Fehler
   * und kein Komfort. Cesium fragt den Griffpunkt ohnehin nur bei der ersten
   * Bewegung eines Zugs ab.
   */
  function klemmeAn() {
    if (klemmeSteht || !aktiv || !viewer) return;
    const scene = viewer.scene;
    const globe = scene.globe;
    if (!globe) return;
    // Im Geh- und Flugmodus liegt die Kamera ohnehin nicht am Zeiger.
    if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled && WalkMode.isEnabled()) return;

    const weite = grenze(hoeheUeberGrund());
    const kamera = Cesium.Cartesian3.clone(viewer.camera.positionWC, new Cesium.Cartesian3());

    originalGlobePick = globe.pickWorldCoordinates;
    globe.pickWorldCoordinates = function () {
      return klemmen(originalGlobePick.apply(this, arguments), kamera, weite);
    };

    if (typeof scene.pickPositionWorldCoordinates === 'function') {
      originalScenePick = scene.pickPositionWorldCoordinates;
      scene.pickPositionWorldCoordinates = function () {
        return klemmen(originalScenePick.apply(this, arguments), kamera, weite);
      };
    }
    klemmeSteht = true;
  }

  function klemmeAus() {
    if (!klemmeSteht) return;
    const scene = viewer.scene;
    if (originalGlobePick && scene.globe) scene.globe.pickWorldCoordinates = originalGlobePick;
    if (originalScenePick) scene.pickPositionWorldCoordinates = originalScenePick;
    originalGlobePick = null;
    originalScenePick = null;
    klemmeSteht = false;
  }

  // =========================================================================
  // START
  // =========================================================================

  function init(cesiumViewer) {
    if (viewer) return;
    viewer = cesiumViewer || (typeof BimViewer !== 'undefined' ? BimViewer.viewer : null);
    if (!viewer) return;
    const canvas = viewer.canvas;

    // Vor Cesium: der Griffpunkt fällt erst bei der ersten Bewegung, das
    // Drücken kommt in jedem Fall zuerst. Capture, damit kein Werkzeug
    // dazwischen abbricht.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      klemmeAn();
    }, { capture: true });

    ['pointerup', 'pointercancel', 'blur'].forEach(art =>
      window.addEventListener(art, klemmeAus, { capture: true }));

    console.log('[Greifweite] aktiv — Griff auf', faktor + '× Höhe über Grund, mindestens', minimum + ' m');
  }

  function warten() {
    const v = (typeof BimViewer !== 'undefined') ? BimViewer.viewer : null;
    if (v && v.scene && v.canvas) { init(v); return; }
    setTimeout(warten, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', warten);
  else warten();

  return {
    init,
    an: () => { aktiv = true; },
    aus: () => { aktiv = false; klemmeAus(); },
    istAn: () => aktiv,
    einstellen: (o) => {
      if (!o) return;
      if (typeof o.faktor === 'number' && o.faktor > 0) faktor = o.faktor;
      if (typeof o.minimum === 'number' && o.minimum >= 0) minimum = o.minimum;
      if (typeof o.aus === 'boolean') aktiv = !o.aus;
    },
    werte: () => ({ faktor, minimum, aktiv }),
    _pruefsteine: { grenze, zuWeit, klemmen, einstellen: (f, m) => { faktor = f; minimum = m; } },
  };

})();
