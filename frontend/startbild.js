/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// STARTBILD — erst nur das Logo, dann die Welt, hell überblendet, mit Glühen
//
// Markup und Aussehen stehen in index.html (am Anfang des Body) und
// startbild.css; hier steht nur, WANN das Logo geht und was dabei mit der
// Welt geschieht.
//
// Puffern: Hinter dem Logo zeichnet der Viewer längst. Das Logo geht erst,
// wenn die Welt dahinter fertig dasteht —
//   · der Viewer steht, hat eine Grundkarte und zeichnet,
//   · die Kacheln des Globus sind da (drei Bilder am Stück) und der Schriftzug
//     im Orbit (ileen-logo.js) ist geladen — sonst käme der Globus grob und
//     blockig herein und der Schriftzug spränge nach (so sah es mit 0,7 s
//     Wartezeit aus),
//   · das Logo ist fertig aufgebaut (minMs, gerechnet ab dem ersten Anstrich): Buchstabe für
//     Buchstabe und der Untertitel brauchen gut drei Sekunden, und das Überblenden soll
//     unmittelbar danach einsetzen — in einem Fluss, nicht mitten im Aufbau,
// oder, wenn ein langsames Netz die Kacheln nicht liefert, kachelnMs nach dem
// ersten Bild; nach maxMs in jedem Fall. (Dahinter sitzt noch ein Notausgang
// in index.html, falls dieses Modul gar nicht erst läuft.)
//
// Kein Bloom: Cesiums Bloom addiert seine Helligkeit im HSB-Raum, und eine
// Stärke über die Schwelle zu regeln (stark negativ = unsichtbar) erzeugt
// negative Werte, die je Farbkanal verschieden ausfallen — im Bild standen
// magenta und rote Flecken über dem Globus. Das Glühen läuft deshalb allein
// über die Atmosphäre; sie ändert nur Uniforms und übersetzt nichts neu.
//
// Das Überblenden: Das Logo löst sich in ein helles, bläuliches Licht auf
// (startbild.css), das über 2 s abklingt und die Welt freigibt; im selben
// Augenblick glüht sie auf (Gipfel nach 1,4 s, wenn der Lichtschein sie freigibt) und
// kühlt über insgesamt 4,8 s auf ihre Einstellung ab. Gedreht wird an zwei Dingen, die sonst niemand anfasst —
// Himmelsatmosphäre und Bodenatmosphäre — und am Ende stehen beide wieder
// genau auf ihrem Anfangswert (auch auf einem, den jemand vor dem Start
// umgestellt hat).
//
// Aus: ?startbild=aus oder localStorage.ileen_startbild = 'aus'. Bei
// Automatisierung (navigator.webdriver) ist es ohnehin aus, damit Prüfsteine
// nicht in ein Logo klicken; ?startbild=an erzwingt es dort.
// BimViewer.Startbild.aufgluehen() spielt das Glühen jederzeit erneut ab.
// ===============================
'use strict';

(function () {

  var VORGABE = {
    minMs: 3100,        // so lange steht das Logo mindestens: der Aufbau in startbild.css (3,1 s) läuft vorher aus
    kachelnMs: 3000,    // so lange wird nach dem ersten Bild auf Globuskacheln und Orbit-Logo gewartet
    maxMs: 9000,        // dann geht es in jedem Fall
    ruhigeBilder: 3,    // so viele Bilder am Stück mit fertiger Welt
    logoWartetMs: 1500, // so lange wird auf den Start des Orbit-Logos gewartet (fehlt die Datei, nicht länger)
    abgangMs: 2000,     // so lange dauert das Überblenden (startbild.css: 2 s)
    gluehenS: 4.8,      // Dauer des ganzen Glühens (Anstieg 1,4 s, dann Abkühlen)
    gluehen: 1.0,       // Stärke des Glühens; 0 = aus
  };

  // ── Rechenkern (ohne Cesium, prüfbar) ─────────────────────────────────

  function glatt(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /**
   * Verlauf des Glühens, 0 … 1, über die Zeit `t` (s) seit Beginn des Abgangs.
   * Steigt über 1,4 s an — so lange blendet das Licht noch ab (2 s), der Gipfel
   * fällt also in den Augenblick, in dem die Welt frei liegt —, steht kurz auf
   * dem Gipfel und kühlt danach bis `dauer` aus. Die Abkühlung fällt zuerst
   * steil und läuft dann lang aus (Quadrat), so wirkt es wie Nachglühen und
   * nicht wie ein Dimmer, der heruntergedreht wird.
   */
  function verlauf(t, dauer) {
    if (t <= 0 || t >= dauer) return 0;
    var auf = glatt(0, 1.4, t);
    var ab = 1 - glatt(1.6, dauer, t);
    return auf * ab * ab;
  }

  /**
   * Ob der Start zu Ende ist: der Viewer steht, die Welt ist ruhig, das Logo
   * hat lange genug gestanden — oder die Frist ist um.
   */
  function fertig(z, jetzt) {
    var stand = jetzt - z.beginn;
    if (stand >= z.o.maxMs) return true;
    if (stand < z.o.minMs) return false;
    if (z.ruhig >= z.o.ruhigeBilder) return true;
    return z.seit !== null && jetzt - z.seit >= z.o.kachelnMs;
  }

  /**
   * Ein gezeichnetes Bild: zählt die Bilder am Stück, in denen die Welt fertig
   * ist (Globus und Orbit-Logo), und merkt sich, wann das erste Bild stand.
   */
  function bild(z, weltFertig, jetzt) {
    if (z.seit === null) z.seit = jetzt;
    z.ruhig = weltFertig ? z.ruhig + 1 : 0;
  }

  /**
   * Ist das Orbit-Logo (ileen-logo.js) für den Start so weit? Fertig, wenn es
   * geladen und zeichenbereit ist, wenn es ausgeschaltet ist — oder wenn es
   * nach `logoWartetMs` nicht einmal zu laden begonnen hat (Datei fehlt).
   */
  function logoBereit(logo, sinceMs, o) {
    if (!logo) return true;
    if (logo.sichtbar === false) return true;
    if (logo.modell) return logo.modell.ready !== false;
    if (logo._laedt) return false;
    return sinceMs >= o.logoWartetMs;
  }

  function neuerZustand(optionen, jetzt) {
    return { o: Object.assign({}, VORGABE, optionen || {}), beginn: jetzt, ruhig: 0, seit: null };
  }

  // ── Anbindung ─────────────────────────────────────────────────────────

  var el = document.getElementById('ileenStart');

  /**
   * Seit wann steht das Logo? Die Animation beginnt mit dem ersten Anstrich, nicht mit dem Lauf dieses
   * Skripts (der liegt Hunderte Millisekunden später): `minMs` rechnet ab dort.
   */
  function logoStart() {
    try {
      var p = performance.getEntriesByName('first-paint')[0];
      if (p) return p.startTime;
    } catch (e) { /* kein Paint-Timing */ }
    return performance.now();
  }

  var z = neuerZustand(null, logoStart());
  try {
    // Ohne Bewegung gibt es keinen Aufbau, auf den zu warten wäre
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) z.o.minMs = 800;
  } catch (e) { /* alt */ }
  var geht = false;
  var glut = null;         // vorbereitetes Glühen: { setzen, zurueck, weg }
  var basisErst = null;    // was an der Szene stand, bevor das Startbild sie anfasste (für Prüfsteine)

  function dauerAus() {
    try { return localStorage.getItem('ileen_startbild') === 'aus'; } catch (e) { return false; }
  }

  /**
   * Das Glühen vorbereiten. Gemerkt wird, was jeweils an der Szene stand, und
   * am Ende genau das zurückgegeben — der Verlauf ist nur eine Hülle darüber.
   */
  function glutVorbereiten(viewer) {
    if (glut) return glut;
    var scene = viewer.scene;
    var sky = scene.skyAtmosphere;
    var boden = scene.globe;
    var basis = {
      skyLicht: sky ? sky.atmosphereLightIntensity : null,
      skyHell: sky ? sky.brightnessShift : null,
      bodenLicht: boden ? boden.atmosphereLightIntensity : null,
      bodenHell: boden ? boden.atmosphereBrightnessShift : null,
    };
    if (!basisErst) basisErst = basis;
    var st = z.o.gluehen;

    function setzen(h) {
      if (sky) {
        sky.atmosphereLightIntensity = basis.skyLicht * (1 + 1.1 * st * h);
        sky.brightnessShift = basis.skyHell + 0.16 * st * h;
      }
      if (boden) {
        // Die Bodenatmosphäre nur leicht: stärker gedreht färbt sie den
        // Sonnenrand orange, und der Saum des Logos ist blau.
        boden.atmosphereLightIntensity = basis.bodenLicht * (1 + 0.3 * st * h);
        boden.atmosphereBrightnessShift = basis.bodenHell + 0.04 * st * h;
      }
    }

    function zurueck() {
      if (sky) { sky.atmosphereLightIntensity = basis.skyLicht; sky.brightnessShift = basis.skyHell; }
      if (boden) { boden.atmosphereLightIntensity = basis.bodenLicht; boden.atmosphereBrightnessShift = basis.bodenHell; }
    }

    setzen(0);                 // merkt den Ausgang und stellt ihn unverändert hin
    glut = { setzen: setzen, zurueck: zurueck, weg: null, basis: basis };
    return glut;
  }

  /** Das Glühen abspielen (vorbereitet oder frisch). */
  function aufgluehen(viewer) {
    viewer = viewer || (window.BimViewer && BimViewer.viewer);
    if (!viewer || !viewer.scene || z.o.gluehen <= 0) return;
    var g = glutVorbereiten(viewer);
    if (g.weg) { try { g.weg(); } catch (e) { /* Viewer weg */ } }
    var t0 = performance.now();
    g.weg = viewer.scene.preRender.addEventListener(function () {
      var t = (performance.now() - t0) / 1000;
      if (t >= z.o.gluehenS) { abkuehlenSofort(); return; }
      g.setzen(verlauf(t, z.o.gluehenS));
    });
  }

  function abkuehlenSofort() {
    if (!glut) return;
    var g = glut;
    glut = null;
    try { if (g.weg) g.weg(); } catch (e) { /* Viewer weg */ }
    try { g.zurueck(); } catch (e) { /* Viewer weg */ }
  }

  /** Logo überblenden, Glühen starten, danach aus dem Dokument nehmen. */
  function gehen() {
    if (geht) return;
    geht = true;
    aufgluehen();
    if (el && el.parentNode) {
      el.classList.add('geht');
      setTimeout(function () {
        if (el.parentNode) el.remove();
        try { document.dispatchEvent(new CustomEvent('ileen:startbild-fertig')); } catch (e) { /* alt */ }
      }, z.o.abgangMs + 200);
    }
  }

  function starten() {
    // Viewer abwarten, wie die übrigen Beiwerk-Module: keine feste Ladereihenfolge
    var warten = setInterval(function () {
      var jetzt = performance.now();
      var v = window.BimViewer && BimViewer.viewer;
      if (v && v.scene && v.scene.globe && v.imageryLayers && v.imageryLayers.length > 0) {
        clearInterval(warten);
        var scene = v.scene;
        try { glutVorbereiten(v); } catch (e) { /* Beiwerk */ }
        var weg = scene.postRender.addEventListener(function () {
          var jetzt = performance.now();
          // Der Globus ist fertig, wenn seine Kacheln da sind. Ist er nicht zu
          // sehen (Google 3D Tiles an), gibt es nichts abzuwarten.
          var globusDa = !scene.globe.show || scene.globe.tilesLoaded;
          var seit = z.seit === null ? 0 : jetzt - z.seit;
          var logoDa = logoBereit(window.BimViewer && BimViewer.ILeenLogo, seit, z.o);
          bild(z, globusDa && logoDa, jetzt);
          if (fertig(z, jetzt)) { weg(); gehen(); }
        });
        // Fehlt das Zeichnen (Tab im Hintergrund), greift trotzdem die Frist
        setTimeout(function () { try { weg(); } catch (e) { /* schon weg */ } gehen(); },
          Math.max(0, z.o.maxMs - (jetzt - z.beginn)));
      } else if (jetzt - z.beginn > z.o.maxMs) {
        clearInterval(warten);
        gehen();
      }
    }, 100);
  }

  window.BimViewer = window.BimViewer || {};
  window.BimViewer.Startbild = {
    aufgluehen: function () { aufgluehen(); },
    stand: function () {
      return {
        sichtbar: !!(el && el.parentNode) && !geht, geht: geht, glueht: !!(glut && glut.weg), bilder: z.ruhig,
        seitErstemBildMs: z.seit === null ? null : Math.round(performance.now() - z.seit),
        basis: basisErst,
      };
    },
    einstellen: function (teil) { Object.assign(z.o, teil || {}); return z.o; },
    _pruefsteine: { verlauf: verlauf, fertig: fertig, bild: bild, neuerZustand: neuerZustand, logoBereit: logoBereit,
                    VORGABE: VORGABE },
  };

  if (!el || dauerAus()) {
    // Kein Logo (Automatisierung, ?startbild=aus): kein Warten, kein Glühen —
    // die Szene bleibt, wie die Einstellungen sie beschreiben.
    if (el && el.parentNode) el.remove();
    return;
  }
  starten();

})();
