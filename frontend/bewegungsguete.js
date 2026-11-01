/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// BEWEGUNGSGÜTE — in Bewegung gröber zeichnen, im Stand scharf
//
// Gemessen (tests/tiles-bench/app-varianten.mjs, M4 Pro, Retina, Stufe
// BALANCED, Campus-IFC mit 87 Kacheln und 4,1 Mio. Dreiecken im Bild):
//
//   Ausgangslage                        21 fps  (48 ms je Bild)
//   resolutionScale 1 statt 2           41 fps
//   Schatten aus                        31 fps
//   resolutionScale 1 + Schatten aus    68 fps
//
// Das Netz war es nie: lokal kommen 5,8 MB in 35 ms an. Die Zeit geht in die
// Grafikkarte — Retina verdoppelt die Auflösung je Achse (vier Mal so viele
// Bildpunkte, jeder mit PBR-Material, Normalen- und Rauheitskarte), und die
// Schattenkarte zeichnet das Modell ein zweites Mal. Das CPU-Profil der
// laufenden App zeigt es genauso: 31 % der Zeit in uniformMatrix4fv, 7 % in
// drawElements — der Treiber wartet auf die Grafikkarte.
//
// Was man beim Fliegen und Drehen sieht, ist nicht dasselbe wie das, was man
// beim Stehen sieht: eine Kante, die mit dem Bild wandert, verlangt keine
// Retina-Schärfe, aber sie verlangt Flüssigkeit. Deshalb:
//
//   Stufe 0  die Darstellungsstufe, wie eingestellt (Stand)
//   Stufe 1  resolutionScale auf 1 (bei Retina) bzw. 85 %
//   Stufe 2  zusätzlich ein Viertel weniger Bildpunkte, Schatten aus
//
// Wann gewechselt wird, entscheidet das Messen, nicht ein fester Plan:
//
//   · Leichte Szene (Bild im Stand unter dem Ziel) → nie eine Stufe. Wer
//     nur ein kleines Modell ansieht, behält die volle Auflösung auch beim
//     Drehen.
//   · Schwere Szene → schon das erste bewegte Bild kommt in Stufe 1. Das
//     Bild im Stand ist ja bekannt; zu warten, bis es sich im Ruckeln
//     wiederholt, hieße, jede Bewegung mit Hängern zu beginnen.
//   · Reicht Stufe 1 nicht, folgt Stufe 2 nach einigen Bildern.
//   · Steht die Kamera 0,35 s still, geht es zurück auf Stufe 0.
//
// Zurückgenommen wird nur, was dieser Regler selbst genommen hat. Ändert
// jemand anderes die Auflösung (Darstellungsstufe, Splat-Regler), gilt dessen
// Wert, und der Regler fängt von vorn an. Solange Gaussian Splats in der
// Szene liegen, regelt splat-leistung.js (nach Bildrate, mit Bildschirmfehler);
// zwei Regler an derselben Auflösung würden gegeneinander arbeiten.
//
// Ausschalten: localStorage.ileen_bewegungsguete = 'aus' (oder
// BimViewer.Bewegungsguete.aus()). Einstellen: .einstellen({ zielMs: 16 }).
// ===============================
'use strict';

(function () {

  var VORGABE = {
    zielMs: 22,        // ≈ 45 Bilder/s: darüber ruckelt es
    schwelle: 1.15,    // Toleranz gegen Rauschen
    ruheMs: 350,       // so lange still → zurück auf Stufe 0
    fensterBilder: 5,  // so viele schwere Bilder am Stück für die nächste Stufe
    sperreMs: 450,     // nach einem Wechsel erst ausmessen (der Wechsel selbst kostet ein Bild)
    glaetten: 0.2,     // Gewicht des neuen Bildes im gleitenden Mittel (Bewegung)
    glaettenRuhe: 0.1, // dasselbe im Stand
    maxStufe: 2,
  };

  // ── Rechenkern (ohne Cesium, prüfbar) ─────────────────────────────────

  function mittel(alt, neu, gewicht) {
    return alt === null || alt === undefined ? neu : alt + (neu - alt) * gewicht;
  }

  function neuerZustand(optionen) {
    return {
      o: Object.assign({}, VORGABE, optionen || {}),
      stufe: 0,
      ruheKosten: null,       // Bildzeit der vollen Güte im Stand (gleitend)
      ema: null,              // Bildzeit in der laufenden Bewegung (gleitend)
      schwer: 0,              // schwere Bilder am Stück
      letzteBewegung: -1e12,
      letzterWechsel: -1e12,
      inBewegung: false,
    };
  }

  /**
   * Ein Bild: Zeit `t` (ms), Dauer `dt` (ms), `bewegt` (Kamera hat sich
   * bewegt). Gibt die Stufe zurück, die ab dem nächsten Bild gelten soll.
   */
  function schritt(z, t, dt, bewegt) {
    var o = z.o;
    if (bewegt) z.letzteBewegung = t;
    var ruht = (t - z.letzteBewegung) > o.ruheMs;

    if (ruht) {
      z.inBewegung = false;
      // Die Kosten der vollen Güte lernt man nur in der vollen Güte.
      if (z.stufe === 0) z.ruheKosten = mittel(z.ruheKosten, dt, o.glaettenRuhe);
      else wechseln(z, 0, t);
      return z.stufe;
    }

    if (!z.inBewegung) {
      z.inBewegung = true;
      z.ema = null;
      z.schwer = 0;
      // Beginn einer Bewegung: ist die Szene im Stand schon zu schwer, gleich
      // runter, ohne erst ein paar ruckelnde Bilder abzuwarten.
      if (z.stufe === 0 && z.ruheKosten !== null && z.ruheKosten > o.zielMs * o.schwelle) {
        wechseln(z, 1, t);
        return z.stufe;
      }
    }

    z.ema = mittel(z.ema, dt, o.glaetten);
    if (t - z.letzterWechsel > o.sperreMs) {
      if (z.ema > o.zielMs * o.schwelle) z.schwer++; else z.schwer = 0;
      if (z.schwer >= o.fensterBilder && z.stufe < o.maxStufe) wechseln(z, z.stufe + 1, t);
    }
    return z.stufe;
  }

  function wechseln(z, stufe, t) {
    z.stufe = stufe;
    z.letzterWechsel = t;
    z.ema = null;
    z.schwer = 0;
  }

  /** resolutionScale je Stufe, ausgehend von dem der Darstellungsstufe. */
  function aufloesung(basis, stufe) {
    if (stufe <= 0) return basis;
    var eins = basis > 1.01 ? 1 : +(basis * 0.85).toFixed(3);
    if (stufe === 1) return eins;
    return Math.max(0.5, +(eins * 0.75).toFixed(3));
  }

  // ── Anbindung an den Viewer ───────────────────────────────────────────

  var regler = null;

  // Was gilt, wenn der Regler nichts genommen hat: genau das, was beim Verlassen von
  // Stufe 0 an der Szene stand — nicht, was die Darstellungsstufe vorsieht. Wer die
  // Schatten im Beleuchtungsmenü ausgeschaltet hat, bekommt sie nicht zurück.
  function merken(r) {
    r.basisRS = r.viewer.resolutionScale;
    r.basisSchatten = r.viewer.shadowMap ? !!r.viewer.shadowMap.enabled : false;
  }

  function fremdRegelt() {
    // Splat-Regler: nach Bildrate, mit eigenem Zustand
    if (window.SplatLeistung && SplatLeistung.stand && SplatLeistung.stand().an) return true;
    // Aufnahme einer Präsentation: ein Video in wechselnder Auflösung wäre keins
    if (document.body && document.body.classList.contains('praes-laeuft')) return true;
    return false;
  }

  function anwenden(r, stufe) {
    var v = r.viewer;
    if (stufe > 0 && r.angewandt === 0) merken(r);
    var rs = aufloesung(r.basisRS, stufe);
    if (v.resolutionScale !== rs) v.resolutionScale = rs;
    r.gesetzt = rs;
    var schatten = stufe >= 2 ? false : r.basisSchatten;
    if (v.shadowMap && v.shadowMap.enabled !== schatten) v.shadowMap.enabled = schatten;
    r.angewandt = stufe;
  }

  function kameraBewegt(r) {
    var c = r.viewer.camera;
    var p = c.positionWC, d = c.directionWC;
    var bewegt = !r.pos || !Cesium.Cartesian3.equalsEpsilon(p, r.pos, 0, 0.01) ||
                 !Cesium.Cartesian3.equalsEpsilon(d, r.dir, 0, 1e-5);
    if (bewegt) {
      r.pos = Cesium.Cartesian3.clone(p, r.pos);
      r.dir = Cesium.Cartesian3.clone(d, r.dir);
    }
    return bewegt && r.hatVorher;
  }

  function nachBild(r) {
    var t = performance.now();
    var dt = r.letzteZeit === null ? null : t - r.letzteZeit;
    r.letzteZeit = t;
    var bewegt = kameraBewegt(r);
    r.hatVorher = true;
    if (dt === null || dt > 250) return;   // Pause (Tab im Hintergrund, requestRenderMode) ist kein Bild

    if (fremdRegelt()) {
      if (r.angewandt > 0) { anwenden(r, 0); r.z.stufe = 0; }
      return;
    }
    // Hat jemand anderes die Auflösung gestellt, gilt sein Wert.
    if (r.angewandt > 0 && r.viewer.resolutionScale !== r.gesetzt) {
      r.angewandt = 0; r.z.stufe = 0; r.z.ruheKosten = null;
      return;
    }

    var vorher = r.z.stufe;
    var stufe = schritt(r.z, t, dt, bewegt);
    if (stufe !== vorher) anwenden(r, stufe);
  }

  function an(viewer, optionen) {
    aus();
    var r = {
      viewer: viewer, z: neuerZustand(optionen),
      letzteZeit: null, pos: null, dir: null, hatVorher: false,
      angewandt: 0, gesetzt: viewer.resolutionScale,
      basisRS: viewer.resolutionScale, basisSchatten: true,
    };
    r.weg = viewer.scene.postRender.addEventListener(function () { nachBild(r); });
    regler = r;
    return stand();
  }

  function aus() {
    if (!regler) return;
    regler.weg();
    if (regler.angewandt > 0) anwenden(regler, 0);
    regler = null;
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
      stufe: z.stufe,
      resolutionScale: regler.viewer.resolutionScale,
      schatten: regler.viewer.shadowMap ? regler.viewer.shadowMap.enabled : null,
      ruheMs: z.ruheKosten === null ? null : +z.ruheKosten.toFixed(1),
      bewegtMs: z.ema === null ? null : +z.ema.toFixed(1),
      zielMs: z.o.zielMs,
    };
  }

  window.Bewegungsguete = {
    an: an, aus: aus, einstellen: einstellen, stand: stand,
    _pruefsteine: { neuerZustand: neuerZustand, schritt: schritt, aufloesung: aufloesung, VORGABE: VORGABE },
  };

  // Start, sobald der Viewer steht (wie die übrigen Werkzeuge: keine feste Ladereihenfolge)
  var versuche = 0;
  var warten = setInterval(function () {
    if (++versuche > 240) { clearInterval(warten); return; }
    if (!window.BimViewer || !BimViewer.viewer || !BimViewer.viewer.scene || !BimViewer._currentPerformanceSettings) return;
    clearInterval(warten);
    var aus_ = false;
    try { aus_ = localStorage.getItem('ileen_bewegungsguete') === 'aus'; } catch (e) { /* privat */ }
    if (!aus_) {
      an(BimViewer.viewer);
      BimViewer.Bewegungsguete = window.Bewegungsguete;
    }
  }, 250);

})();
