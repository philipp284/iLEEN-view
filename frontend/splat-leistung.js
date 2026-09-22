/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// SPLAT-LEISTUNG — Bildrate halten, wenn Gaussian Splats in der Szene liegen
//
// Ein Splat-Tileset kostet je Bild so viel, wie Splats im Bild sind, und die
// Zahl schwankt mit dem Standpunkt um eine Größenordnung. Eine feste
// Einstellung ist deshalb entweder aus der Nähe zu langsam oder aus der Ferne
// zu grob. Dieser Regler dreht an den beiden Größen, die die Kosten
// bestimmen, in dieser Reihenfolge:
//
//   1. maximumScreenSpaceError der Splat-Tilesets — weniger, gröbere Splats.
//      Kostet zuerst Detail in der Tiefe, wo man es am wenigsten sieht.
//   2. viewer.resolutionScale — weniger Pixel, also weniger Überzeichnung.
//      Erst, wenn der Bildschirmfehler am Anschlag steht: ein unscharfes
//      Bild fällt mehr auf als ein gröberes Tile in 80 m Entfernung.
//
// Zurück geht es in umgekehrter Reihenfolge — und über den Ausgangswert
// hinaus: bleibt Reserve, sinkt der Bildschirmfehler bis `sseMin`, das Bild
// wird also feiner als voreingestellt. Damit der Regler nicht pendelt:
//
//   · getrennte Schwellen — herunter unter 85 % des Ziels, hinauf erst über
//     115 %, und das zwei bzw. drei Messfenster am Stück;
//   · nach jedem Eingriff eine Sperrzeit: ein geänderter Bildschirmfehler
//     lädt Tiles nach, und der Einbruch dabei ist die Folge des Eingriffs,
//     nicht ein Grund für den nächsten;
//   · gemessen wird nur, während wirklich gezeichnet wird. Bei
//     requestRenderMode ruht die Szene zwischen zwei Bildern, und die Pause
//     wäre sonst ein „langsames Bild".
//
// Die Obergrenze von resolutionScale ist der Wert, der beim Einschalten
// gilt — also der der Darstellungsstufe. Der Regler nimmt nur weg, was er
// selbst weggenommen hat.
//
// Bedienung:
//   SplatLeistung.an(viewer, { zielFps: 60 })  /  .aus()  /  .stand()
//
// Gemessen in #8 (frontend/tests/splat-bench/, Konfiguration „adaptiv").
// ===============================
'use strict';

(function () {

  var VORGABE = {
    zielFps: 60,
    fenster: 1.0,        // s je Messfenster
    runterNach: 2,       // Fenster am Stück unter der Schwelle
    raufNach: 3,         // Fenster am Stück über der Schwelle
    sperre: 2.0,         // s nach einem Eingriff
    sseStart: 16,        // Cesiums Voreinstellung
    sseMin: 8,           // mit Reserve darf es feiner werden als voreingestellt
    sseMax: 64,
    sseSchritt: 1.5,     // Faktor je Eingriff
    aufloesungMin: 0.5,
    aufloesungSchritt: 0.1,
  };

  var zustand = null;

  function splatTilesets(viewer) {
    var liste = [];
    var prims = viewer.scene.primitives;
    for (var i = 0; i < prims.length; i++) {
      var p = prims.get(i);
      if (p && p.gaussianSplatPrimitive !== undefined && p.show !== false) liste.push(p);
      else if (p && p._isGaussianSplat) liste.push(p);
    }
    return liste;
  }

  function sseSetzen(z, wert) {
    z.sse = Math.max(z.o.sseMin, Math.min(z.o.sseMax, wert));
    splatTilesets(z.viewer).forEach(function (t) { t.maximumScreenSpaceError = z.sse; });
  }

  function eingreifen(z, richtung) {
    var o = z.o;
    if (richtung < 0) {
      if (z.sse < o.sseMax) sseSetzen(z, z.sse * o.sseSchritt);
      else if (z.viewer.resolutionScale > o.aufloesungMin + 1e-6) {
        z.viewer.resolutionScale = Math.max(o.aufloesungMin,
          +(z.viewer.resolutionScale - o.aufloesungSchritt).toFixed(2));
      } else return false;
    } else {
      if (z.viewer.resolutionScale < z.aufloesungMax - 1e-6) {
        z.viewer.resolutionScale = Math.min(z.aufloesungMax,
          +(z.viewer.resolutionScale + o.aufloesungSchritt).toFixed(2));
      } else if (z.sse > o.sseMin) sseSetzen(z, z.sse / o.sseSchritt);
      else return false;
    }
    z.eingriffe++;
    z.gesperrtBis = z.jetzt + o.sperre;
    z.unter = z.ueber = 0;
    return true;
  }

  function nachBild(z) {
    var t = performance.now() / 1000;
    if (z.letztes !== null) {
      var dt = t - z.letztes;
      // Pausen über 250 ms sind keine Bilder, sondern Ruhe (requestRenderMode,
      // verdeckter Tab) — sie würden jede Messung sprengen.
      if (dt < 0.25) { z.summe += dt; z.bilder++; }
    }
    z.letztes = t;
    z.jetzt = t;
    if (z.summe < z.o.fenster) return;

    var fps = z.bilder / z.summe;
    z.fps = fps;
    z.summe = 0; z.bilder = 0;
    if (t < z.gesperrtBis) return;
    if (!splatTilesets(z.viewer).length) {
      // Kein Splat mehr in der Szene: zurückgeben, was genommen wurde.
      if (z.viewer.resolutionScale !== z.aufloesungMax) z.viewer.resolutionScale = z.aufloesungMax;
      z.sse = z.o.sseStart;
      return;
    }

    if (fps < 0.85 * z.o.zielFps) { z.unter++; z.ueber = 0; }
    else if (fps > 1.15 * z.o.zielFps) { z.ueber++; z.unter = 0; }
    else { z.unter = 0; z.ueber = 0; }

    if (z.unter >= z.o.runterNach) eingreifen(z, -1);
    else if (z.ueber >= z.o.raufNach) eingreifen(z, +1);
  }

  function an(viewer, optionen) {
    aus();
    var o = Object.assign({}, VORGABE, optionen || {});
    var z = {
      viewer: viewer, o: o, sse: o.sseStart, aufloesungMax: viewer.resolutionScale,
      letztes: null, summe: 0, bilder: 0, jetzt: 0, gesperrtBis: 0,
      unter: 0, ueber: 0, fps: null, eingriffe: 0,
    };
    sseSetzen(z, o.sseStart);
    z.weg = viewer.scene.postRender.addEventListener(function () { nachBild(z); });
    // Neu geladene Splat-Tilesets bekommen den aktuellen Wert.
    z.wache = setInterval(function () {
      splatTilesets(viewer).forEach(function (t) {
        if (t.maximumScreenSpaceError !== z.sse) t.maximumScreenSpaceError = z.sse;
      });
    }, 1000);
    zustand = z;
    return stand();
  }

  function aus() {
    if (!zustand) return;
    zustand.weg();
    clearInterval(zustand.wache);
    zustand.viewer.resolutionScale = zustand.aufloesungMax;
    sseSetzen(zustand, zustand.o.sseStart);
    zustand = null;
  }

  /**
   * Neue Obergrenze für resolutionScale — wenn die Darstellungsstufe
   * wechselt (core.js → applyPerformanceSettings). Sonst gäbe `aus()` später
   * den Wert der alten Stufe zurück.
   */
  function aufloesungBasis(wert) {
    if (!zustand) return;
    zustand.aufloesungMax = wert;
    if (zustand.viewer.resolutionScale > wert) zustand.viewer.resolutionScale = wert;
  }

  function stand() {
    if (!zustand) return { an: false };
    return {
      an: true,
      zielFps: zustand.o.zielFps,
      fps: zustand.fps && +zustand.fps.toFixed(1),
      maximumScreenSpaceError: +zustand.sse.toFixed(1),
      resolutionScale: zustand.viewer.resolutionScale,
      eingriffe: zustand.eingriffe,
    };
  }

  window.SplatLeistung = {
    an: an, aus: aus, stand: stand, aufloesungBasis: aufloesungBasis, VORGABE: VORGABE,
    aktiv: function () { return !!zustand; },
  };
})();
