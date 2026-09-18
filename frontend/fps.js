/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Licensed under BSL 1.1 (siehe clipping-planes.js).
 */

// ===============================
// FPS-ANZEIGE — was das Bild kostet, während man es ansieht
//
// Chrome kann das auch: DevTools → Cmd+Shift+P → „Show frame rendering
// stats". Nur zeigt Chrome die Bildrate des ganzen Fensters, nicht die der
// Szene, es verschwindet im Vollbild und in der Präsentation, und niemand
// öffnet vor einem Kunden die Entwicklerwerkzeuge. Deshalb diese Anzeige.
//
// Sie hängt am `postRender` der Cesium-Szene und misst damit genau das, was
// hier interessiert: den Abstand zwischen zwei GEZEICHNETEN Bildern. Ein
// eigener `requestAnimationFrame`-Zähler würde bei `requestRenderMode`
// (core.js schaltet ihn zeitweise ein) fröhlich 60 melden, während die Szene
// gar nicht neu zeichnet.
//
// ## Warum drei Zahlen statt einer
//
// Der Mittelwert versteckt genau das, was stört. 55 FPS im Mittel können ein
// ruhiges Bild sein oder sechzig gute Bilder und ein Ruckler von 200 ms beim
// Nachladen einer Kachel — den sieht man, den Mittelwert nicht. Darum:
//
//   · FPS   — gleitender Mittelwert der letzten Sekunde
//   · ms    — die Zeit für ein Bild, die Größe, an der man rechnen kann
//   · min   — das SCHLECHTESTE Bild der letzten Sekunde, als FPS gelesen
//
// Der Balkengraph darunter zeigt die letzten 120 Bilder einzeln. Ein Ruckler
// ist dort ein einzelner hoher Balken; eine dauerhaft zu schwere Szene ist
// ein flächig hohes Band. Das sind zwei verschiedene Probleme mit zwei
// verschiedenen Ursachen, und der Graph unterscheidet sie auf einen Blick.
//
// Die Zeile „lädt" zählt die Tilesets (und das Terrain), die gerade noch
// Kacheln nachladen. Fast jeder Ruckler in diesem Viewer fällt mit ihr
// zusammen — ohne sie sucht man den Fehler in der Geometrie statt im Netz.
//
// ## Bedienung
//
//   Strg/Cmd + Alt + F   umschalten   (F allein gehört flug-trackpad.js)
//   window.FpsAnzeige.umschalten() / .an() / .aus()
//
// Sichtbarkeit und Position liegen im localStorage: wer die Anzeige braucht,
// braucht sie meist über mehrere Sitzungen, und wo sie nicht stört, weiß nur
// der Nutzer — deshalb ist sie mit der Maus verschiebbar.
//
// Ist sie aus, hängt kein Listener an der Szene. Eine Messanzeige, die im
// ausgeschalteten Zustand Rechenzeit kostet, misst sich selbst.
// ===============================
'use strict';

(function () {

  var ID = 'fpsAnzeige';
  var SCHLUESSEL = 'ileen.fps';

  // 120 Bilder ≈ zwei Sekunden bei 60 FPS — so breit ist der Graph in Pixeln,
  // ein Balken je Bild, kein Umrechnen.
  var BILDER = 120;

  var Z = {
    an: false,
    viewer: null,
    entfernen: null,       // Abmelder des postRender-Listeners
    zeiten: new Float32Array(BILDER),
    schreibZeiger: 0,
    gefuellt: 0,
    letzteZeit: 0,
    letzteAusgabe: 0,
    wurzel: null,
    graph: null,
    stift: null
  };

  // =========================================================================
  // MESSUNG
  // =========================================================================

  function bildFertig() {
    var jetzt = performance.now();
    if (Z.letzteZeit) {
      var dt = jetzt - Z.letzteZeit;
      // Ein Tab im Hintergrund liefert Abstände von Sekunden. Die sind keine
      // Aussage über die Szene und würden den Graphen für Minuten verderben.
      if (dt < 1000) {
        Z.zeiten[Z.schreibZeiger] = dt;
        Z.schreibZeiger = (Z.schreibZeiger + 1) % BILDER;
        if (Z.gefuellt < BILDER) Z.gefuellt++;
      }
    }
    Z.letzteZeit = jetzt;

    // Vier Mal je Sekunde ablesen. Bei jedem Bild wäre die Zahl unlesbar,
    // und das Schreiben ins DOM wäre selbst ein Teil der Messung.
    if (jetzt - Z.letzteAusgabe >= 250) {
      Z.letzteAusgabe = jetzt;
      ausgeben();
    }
  }

  /** Mittel und Maximum über die letzten `fenster` Millisekunden. */
  function auswerten(fenster) {
    var summe = 0, anzahl = 0, schlimmste = 0, gesamt = 0;
    for (var i = 0; i < Z.gefuellt; i++) {
      // rückwärts, jüngstes Bild zuerst
      var idx = (Z.schreibZeiger - 1 - i + BILDER * 2) % BILDER;
      var dt = Z.zeiten[idx];
      gesamt += dt;
      summe += dt;
      anzahl++;
      if (dt > schlimmste) schlimmste = dt;
      if (gesamt >= fenster) break;
    }
    if (!anzahl) return null;
    return { mittel: summe / anzahl, schlimmste: schlimmste, anzahl: anzahl };
  }

  /**
   * Wie viele Datenquellen gerade noch nachladen. Cesium führt darüber keine
   * gemeinsame Zahl, also werden Tilesets und Terrain einzeln gefragt —
   * `tilesLoaded` ist der öffentliche Teil dieser Auskunft.
   */
  function ladenZaehlen() {
    var szene = Z.viewer && Z.viewer.scene;
    if (!szene) return 0;
    var offen = 0;
    try {
      var prims = szene.primitives;
      for (var i = 0; i < prims.length; i++) {
        var p = prims.get(i);
        if (p && p.tilesLoaded === false) offen++;
      }
      if (szene.globe && szene.globe.tilesLoaded === false) offen++;
    } catch (e) { /* eine kaputte Auskunft darf die Anzeige nicht anhalten */ }
    return offen;
  }

  // =========================================================================
  // AUSGABE
  // =========================================================================

  function farbe(fps) {
    if (fps >= 50) return 'var(--ds-accent, #97BF0D)';
    if (fps >= 28) return 'var(--ds-warning, #e0a33e)';
    return 'var(--ds-danger, #e05c5c)';
  }

  function ausgeben() {
    if (!Z.wurzel) return;
    var w = auswerten(1000);
    if (!w) return;

    var fps = 1000 / w.mittel;
    var minFps = 1000 / w.schlimmste;

    var zFps = Z.wurzel.querySelector('.fps-wert');
    zFps.textContent = fps.toFixed(0);
    zFps.style.color = farbe(fps);
    Z.wurzel.querySelector('.fps-ms').textContent = w.mittel.toFixed(1) + ' ms';
    Z.wurzel.querySelector('.fps-min').textContent = 'min ' + minFps.toFixed(0);

    var laden = ladenZaehlen();
    var zLaden = Z.wurzel.querySelector('.fps-laden');
    zLaden.textContent = laden ? ('lädt ' + laden) : '';
    zLaden.style.opacity = laden ? '1' : '0';

    // Der JS-Heap ist eine Chrome-Eigenheit; in anderen Browsern bleibt die
    // Zeile leer statt „—" zu behaupten, es gäbe die Zahl.
    var zSpeicher = Z.wurzel.querySelector('.fps-speicher');
    var m = performance.memory;
    zSpeicher.textContent = m ? (Math.round(m.usedJSHeapSize / 1048576) + ' MB') : '';

    graphZeichnen();
  }

  function graphZeichnen() {
    if (!Z.stift) return;
    var c = Z.graph, g = Z.stift;
    var dpr = window.devicePixelRatio || 1;
    var b = BILDER, h = 34;

    if (c.width !== b * dpr || c.height !== h * dpr) {
      c.width = b * dpr;
      c.height = h * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    g.clearRect(0, 0, b, h);

    // Die Linie bei 16,7 ms — die Marke, an der sich alles misst.
    var skala = 50;  // ms, die die volle Höhe bedeuten
    var linie = h - (16.7 / skala) * h;
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, linie + 0.5);
    g.lineTo(b, linie + 0.5);
    g.stroke();

    for (var i = 0; i < Z.gefuellt; i++) {
      var idx = (Z.schreibZeiger - Z.gefuellt + i + BILDER * 2) % BILDER;
      var dt = Z.zeiten[idx];
      var hoehe = Math.max(1, Math.min(h, (dt / skala) * h));
      var f = 1000 / dt;
      g.fillStyle = f >= 50 ? 'rgba(151,191,13,0.85)'
        : f >= 28 ? 'rgba(224,163,62,0.9)'
          : 'rgba(224,92,92,0.95)';
      g.fillRect(b - Z.gefuellt + i, h - hoehe, 1, hoehe);
    }
  }

  // =========================================================================
  // MARKUP
  // =========================================================================

  function stilEinhaengen() {
    if (document.getElementById('fpsAnzeigeStil')) return;
    var s = document.createElement('style');
    s.id = 'fpsAnzeigeStil';
    s.textContent = [
      '#' + ID + '{position:fixed;top:48px;right:12px;z-index:500;',
      '  background:var(--bg-overlay,rgba(20,22,24,0.86));',
      '  border:1px solid var(--ds-border,rgba(255,255,255,0.11));',
      '  border-radius:var(--ds-radius,6px);padding:6px 8px;',
      '  font:11px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;',
      '  color:var(--text-primary,#e8eaed);user-select:none;cursor:grab;',
      '  backdrop-filter:blur(8px);box-shadow:0 2px 10px rgba(0,0,0,0.35);}',
      '#' + ID + '.zieht{cursor:grabbing;}',
      '#' + ID + ' .fps-kopf{display:flex;align-items:baseline;gap:6px;}',
      '#' + ID + ' .fps-wert{font-size:19px;font-weight:600;line-height:1;',
      '  font-variant-numeric:tabular-nums;}',
      '#' + ID + ' .fps-einheit{font-size:9.5px;opacity:0.55;letter-spacing:0.04em;}',
      '#' + ID + ' .fps-min{margin-left:auto;font-size:10px;opacity:0.65;}',
      '#' + ID + ' canvas{display:block;margin:5px 0 3px;image-rendering:pixelated;}',
      '#' + ID + ' .fps-fuss{display:flex;gap:8px;font-size:9.5px;opacity:0.6;}',
      '#' + ID + ' .fps-laden{color:var(--ds-info,#4ea3ff);opacity:0;',
      '  transition:opacity 140ms;margin-left:auto;}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function bauen() {
    stilEinhaengen();
    var d = document.createElement('div');
    d.id = ID;
    d.title = 'Bildrate der Szene — Strg/Cmd+Alt+F blendet aus, ziehen verschiebt';
    d.innerHTML = [
      '<div class="fps-kopf">',
      '  <span class="fps-wert">–</span>',
      '  <span class="fps-einheit">FPS</span>',
      '  <span class="fps-min"></span>',
      '</div>',
      '<canvas width="' + BILDER + '" height="34"></canvas>',
      '<div class="fps-fuss">',
      '  <span class="fps-ms"></span>',
      '  <span class="fps-speicher"></span>',
      '  <span class="fps-laden"></span>',
      '</div>'
    ].join('');
    document.body.appendChild(d);

    Z.wurzel = d;
    Z.graph = d.querySelector('canvas');
    Z.stift = Z.graph.getContext('2d');

    positionHolen();
    ziehbarMachen(d);
    return d;
  }

  // =========================================================================
  // VERSCHIEBEN
  // =========================================================================

  function positionHolen() {
    try {
      var p = JSON.parse(localStorage.getItem(SCHLUESSEL + '.pos') || 'null');
      if (p && typeof p.left === 'number') {
        Z.wurzel.style.left = p.left + 'px';
        Z.wurzel.style.top = p.top + 'px';
        Z.wurzel.style.right = 'auto';
      }
    } catch (e) { /* eine unlesbare Position ist kein Grund, nichts zu zeigen */ }
  }

  function ziehbarMachen(d) {
    var startX = 0, startY = 0, startL = 0, startT = 0;

    d.addEventListener('pointerdown', function (e) {
      var r = d.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startL = r.left; startT = r.top;
      d.classList.add('zieht');
      d.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    d.addEventListener('pointermove', function (e) {
      if (!d.classList.contains('zieht')) return;
      var l = startL + (e.clientX - startX);
      var t = startT + (e.clientY - startY);
      // im Fenster halten, sonst ist die Anzeige weg und der Schalter auch
      l = Math.max(0, Math.min(window.innerWidth - d.offsetWidth, l));
      t = Math.max(0, Math.min(window.innerHeight - d.offsetHeight, t));
      d.style.left = l + 'px';
      d.style.top = t + 'px';
      d.style.right = 'auto';
    });

    d.addEventListener('pointerup', function (e) {
      if (!d.classList.contains('zieht')) return;
      d.classList.remove('zieht');
      d.releasePointerCapture(e.pointerId);
      var r = d.getBoundingClientRect();
      try {
        localStorage.setItem(SCHLUESSEL + '.pos',
          JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
      } catch (err) { /* privater Modus */ }
    });
  }

  // =========================================================================
  // SCHALTEN
  // =========================================================================

  function viewerHolen() {
    return (typeof BimViewer !== 'undefined' && BimViewer.viewer) ? BimViewer.viewer : null;
  }

  function an() {
    if (Z.an) return;
    var v = viewerHolen();
    if (!v || !v.scene) { console.warn('[FPS] Viewer noch nicht bereit'); return; }
    Z.viewer = v;
    Z.an = true;
    Z.letzteZeit = 0;
    Z.gefuellt = 0;
    Z.schreibZeiger = 0;
    if (!Z.wurzel) bauen();
    Z.wurzel.style.display = '';
    Z.entfernen = v.scene.postRender.addEventListener(bildFertig);
    merken(true);
  }

  function aus() {
    if (!Z.an) return;
    Z.an = false;
    if (Z.entfernen) { Z.entfernen(); Z.entfernen = null; }
    if (Z.wurzel) Z.wurzel.style.display = 'none';
    merken(false);
  }

  function umschalten() { Z.an ? aus() : an(); }

  function merken(wert) {
    try { localStorage.setItem(SCHLUESSEL, wert ? '1' : '0'); } catch (e) { }
  }

  // =========================================================================
  // START
  // =========================================================================

  window.addEventListener('keydown', function (e) {
    // F allein fliegt (flug-trackpad.js), Shift+F geht — also mit Strg/Cmd+Alt.
    if (e.code === 'KeyF' && e.altKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      umschalten();
    }
  });

  function warten() {
    if (viewerHolen()) { an(); return; }
    setTimeout(warten, 400);
  }

  try {
    if (localStorage.getItem(SCHLUESSEL) === '1') warten();
  } catch (e) { /* ohne localStorage startet die Anzeige eben aus */ }

  window.FpsAnzeige = {
    an: an,
    aus: aus,
    umschalten: umschalten,
    /** Momentaufnahme für die Konsole oder MCP: { fps, ms, min, laden } */
    stand: function () {
      var w = auswerten(1000);
      if (!w) return null;
      return {
        fps: +(1000 / w.mittel).toFixed(1),
        ms: +w.mittel.toFixed(2),
        min: +(1000 / w.schlimmste).toFixed(1),
        laden: ladenZaehlen()
      };
    }
  };

})();
