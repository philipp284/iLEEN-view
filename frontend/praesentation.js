/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// PRAESENTATION — Kamerapose plus Text als Folie, und der Weg durch das Modell
//
// Aus splides übernommen (~/Projekte/splides/src/presentation.ts, dort „Slide-
// Modus"): eine Folie ist ein Standpunkt der Kamera mit einem Text darüber.
// Aus einer Reihe solcher Folien wird eine Vorführung — von Hand weitergeklickt
// wie in PowerPoint, als zeitgesteuerte Fahrt oder als Video.
//
// ## Was es neben den Kameraposen der Bauzeitleiste ist
//
// `sim4d-posen.js` legt Kameraposen auf die Zeitachse eines Bauablaufs: die
// Kamera folgt dem Regler, ein Text gehört nicht dazu, und es gibt weder eine
// Show noch ein Video. Hier ist es umgekehrt — die Folie führt die Zeit:
// `halt` Sekunden stehen, `uebergang` Sekunden fliegen, der Text blendet sich
// dazu ein. Beides sind Kamerafahrten, sie haben verschiedene Zwecke und teilen
// sich deshalb nichts außer dem Gedanken, die Pose aus der Zeit zu BERECHNEN
// statt sie abzuspielen.
//
// ## Die Pose
//
//     { pos: [x, y, z]   Kameraort, ECEF in Metern
//       hpr: [h, p, r]   Kurs, Neigung, Rollwinkel in Radiant
//       fov: Grad }      vertikaler Öffnungswinkel
//
// splides hält die Kamera als Orbit (Ziel, Abstand, Gier, Neigung) — dort ist
// das die natürliche Darstellung. In Cesium ist es Ort und Blickrichtung, und
// darauf lässt sich auch ohne Ziel sauber interpolieren.
//
// ## Interpolation: um die Erde herum, nicht durch sie hindurch
//
// Zwischen zwei Standpunkten wird der Betrag des Ortsvektors linear geführt und
// seine Richtung auf der Kugel (slerp). Über die paar Meter einer
// Gebäudetour ist das von der Geraden nicht zu unterscheiden; über hundert
// Kilometer bleibt die Kamera über dem Gelände, statt die Sehne durch das Erdinnere
// zu nehmen. Der Kurs läuft auf dem kürzesten Winkelweg — von 350° auf 10° sind
// es zwanzig Grad und keine dreihundertvierzig.
//
// ## Die Zeit bestimmt die Pose
//
// `zeitachseAbtasten(achse, folien, t)` liefert Pose, Text und Deckkraft zu
// einem Zeitpunkt. Auto-Play und Video-Export fragen dieselbe Funktion, nur
// mit anderer Uhr — deshalb zeigt das Video, was die Vorschau zeigt.
//
// ## Die Szene gehört zur Folie
//
// Neben der Kamera trägt eine Folie (optional) die SZENE: welche Modelle
// geladen sind, welche Bauteiltypen fehlen, wo der Schnitt steht, wie offen die
// Explosion ist, welche Notizen im Bild sind, Farben, Licht, Sonne. Das liest
// und stellt die Registry `BimViewer.Zustand` (zustand.js) her; jedes Werkzeug
// meldet sich dort selbst an. Eine Folie ohne `szene` lässt die Szene, wie sie ist.
//
// Zwischen zwei Folien springt, was sich nicht mischen lässt, zu BEGINN der
// Fahrt (ein Modell soll da sein, bevor die Kamera hinfliegt), und was eine
// Zahl ist, fährt mit: der Schnitt, der durchs Haus läuft, die Explosion, die
// sich öffnet, die Sonne, die wandert. Vor der ersten Folie lädt
// `Zustand.vorbereiten` alles, was irgendeine Folie braucht — sonst käme ein
// Modell mitten im Flug.
//
// Die Oberfläche steht in praesentation-panel.js.
// ===============================
'use strict';

(function () {

  var SPEICHER = 'ileen.praesentation.v1';
  var FORMAT = 'ileen-praesentation';
  var VORGABE = { uebergang: 3, halt: 2.5 };
  var TEXT_LAGE = { x: 0.5, y: 0.8 };
  var FOV_VORGABE = 60;

  var T = window.PraesentationText;

  // ── Zustand ────────────────────────────────────────────────────────────────

  var einstellungen = { uebergang: VORGABE.uebergang, halt: VORGABE.halt };
  var folien = [];
  var gewaehlt = null;
  var modus = 'ruhe';              // 'ruhe' | 'manuell' | 'auto' | 'aufnahme'
  var horcher = [];

  function melden() {
    horcher.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
  }

  function viewer() { return window.BimViewer && window.BimViewer.viewer; }

  function meldung(text, art) {
    if (window.BimViewer && window.BimViewer.updateStatus) window.BimViewer.updateStatus(text, art || 'info');
    else console.log('[Präsentation]', text);
  }

  // ── Kleine Rechnung ────────────────────────────────────────────────────────

  function klemmen(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function mischen(a, b, t) { return a + (b - a) * t; }
  function weichMitte(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function weich(t) { var x = klemmen(t, 0, 1); return x * x * (3 - 2 * x); }

  function neueId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'f-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Der kürzeste Weg zwischen zwei Winkeln (Radiant). Ohne das dreht sich die
   * Kamera beim Übergang von 350° auf 10° einmal fast ganz herum.
   */
  function winkelDelta(a, b) {
    var d = (b - a) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function laenge(v) { return Math.hypot(v[0], v[1], v[2]); }

  /**
   * Zwei Kamerastandorte mischen: Betrag linear, Richtung auf der Kugel.
   * Fallen beide Richtungen zusammen oder genau gegenüber, gibt es keinen
   * eindeutigen Großkreis — dann die gewöhnliche Mischung, normiert.
   */
  function ortMischen(a, b, t) {
    var ra = laenge(a), rb = laenge(b);
    if (ra === 0 || rb === 0) {
      return [mischen(a[0], b[0], t), mischen(a[1], b[1], t), mischen(a[2], b[2], t)];
    }
    var r = mischen(ra, rb, t);
    var ua = [a[0] / ra, a[1] / ra, a[2] / ra];
    var ub = [b[0] / rb, b[1] / rb, b[2] / rb];
    var dot = klemmen(ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2], -1, 1);
    var w = Math.acos(dot);
    var dir;
    if (w < 1e-7 || Math.PI - w < 1e-6) {
      dir = [mischen(ua[0], ub[0], t), mischen(ua[1], ub[1], t), mischen(ua[2], ub[2], t)];
      var l = laenge(dir) || 1;
      dir = [dir[0] / l, dir[1] / l, dir[2] / l];
    } else {
      var sw = Math.sin(w);
      var ka = Math.sin((1 - t) * w) / sw, kb = Math.sin(t * w) / sw;
      dir = [ka * ua[0] + kb * ub[0], ka * ua[1] + kb * ub[1], ka * ua[2] + kb * ub[2]];
    }
    return [dir[0] * r, dir[1] * r, dir[2] * r];
  }

  function poseMischen(a, b, t) {
    return {
      pos: ortMischen(a.pos, b.pos, t),
      hpr: [
        a.hpr[0] + winkelDelta(a.hpr[0], b.hpr[0]) * t,
        mischen(a.hpr[1], b.hpr[1], t),
        mischen(a.hpr[2], b.hpr[2], t),
      ],
      fov: mischen(a.fov, b.fov, t),
    };
  }

  // ── Folien lesen, prüfen, ablegen ──────────────────────────────────────────

  function zahlen(liste, n) {
    return Array.isArray(liste) && liste.length === n &&
           liste.every(function (z) { return typeof z === 'number' && isFinite(z); });
  }

  function poseNormalisieren(roh) {
    if (!roh || !zahlen(roh.pos, 3) || !zahlen(roh.hpr, 3)) return null;
    return {
      pos: roh.pos.slice(),
      hpr: roh.hpr.slice(),
      fov: (typeof roh.fov === 'number' && isFinite(roh.fov)) ? klemmen(roh.fov, 20, 120) : FOV_VORGABE,
    };
  }

  /** Eine Folie aus Speicher oder Datei; ohne brauchbare Pose wird sie verworfen (null). */
  function folieNormalisieren(roh, vorgabe) {
    var pose = poseNormalisieren(roh && roh.pose);
    if (!pose) return null;
    var lage = roh.caption || {};
    return {
      id: typeof roh.id === 'string' && roh.id ? roh.id : neueId(),
      tag: typeof roh.tag === 'string' ? roh.tag : '',
      hold: (typeof roh.hold === 'number' && isFinite(roh.hold) && roh.hold >= 0) ? roh.hold : vorgabe.halt,
      pose: pose,
      caption: {
        x: klemmen(typeof lage.x === 'number' ? lage.x : TEXT_LAGE.x, 0, 1),
        y: klemmen(typeof lage.y === 'number' ? lage.y : TEXT_LAGE.y, 0, 1),
      },
      style: T.stilNormalisieren(roh.style),
      // Die Szene ist reines JSON aus der Registry; ihren Inhalt prüft jeder
      // Anmelder beim Anwenden selbst. Hier nur: ein Objekt oder nichts.
      szene: (roh.szene && typeof roh.szene === 'object' && !Array.isArray(roh.szene) &&
              Object.keys(roh.szene).length) ? JSON.parse(JSON.stringify(roh.szene)) : null,
    };
  }

  function einstellungenNormalisieren(roh) {
    roh = roh || {};
    return {
      uebergang: (typeof roh.uebergang === 'number' && roh.uebergang >= 0.2) ? roh.uebergang : VORGABE.uebergang,
      halt: (typeof roh.halt === 'number' && roh.halt >= 0) ? roh.halt : VORGABE.halt,
    };
  }

  /** Was in einer Deckdatei steht; wirft mit einer Begründung, wenn es keines ist. */
  function deckLesen(text) {
    var d = JSON.parse(text);
    if (!d || typeof d !== 'object') throw new Error('Keine Präsentationsdatei');
    var liste = d.folien || d.slides;
    if (!Array.isArray(liste)) throw new Error('Keine Folien in der Datei');
    // Ein splides-Deck führt die Kamera als Orbit (yaw/pitch/distance/target)
    // für einen bestimmten Splat; das lässt sich nicht in eine Weltpose rechnen.
    if (liste.length && liste[0] && liste[0].pose && 'yaw' in liste[0].pose && !('pos' in liste[0].pose)) {
      throw new Error('Das ist ein splides-Deck (Orbit-Kamera eines Splats) — die Posen lassen sich nicht übernehmen');
    }
    var einst = einstellungenNormalisieren(d.einstellungen);
    var aus = [];
    var verworfen = 0;
    liste.forEach(function (roh) {
      var f = folieNormalisieren(roh, einst);
      if (f) aus.push(f); else verworfen++;
    });
    return { einstellungen: einst, folien: aus, verworfen: verworfen };
  }

  function deckSchreiben() {
    return JSON.stringify({
      format: FORMAT, version: 2, einstellungen: einstellungen, folien: folien,
    }, null, 2);
  }

  function speichern() {
    try {
      localStorage.setItem(SPEICHER, deckSchreiben());
    } catch (e) { /* privater Modus, volle Quote — das Deck lebt dann nur in dieser Sitzung */ }
  }

  function laden() {
    try {
      var roh = localStorage.getItem(SPEICHER);
      if (!roh) return;
      var d = deckLesen(roh);
      einstellungen = d.einstellungen;
      folien = d.folien;
    } catch (e) {
      console.warn('[Präsentation] Gespeichertes Deck nicht lesbar:', e.message);
    }
  }

  // ── Die Zeitachse ──────────────────────────────────────────────────────────

  /** Abwechselnd Halt auf einer Folie und Übergang zur nächsten. */
  function zeitachseBauen(liste, einst) {
    var phasen = [];
    var t = 0;
    for (var i = 0; i < liste.length; i++) {
      var halt = Math.max(0, liste[i].hold);
      phasen.push({ art: 'halt', index: i, start: t, ende: t + halt });
      t += halt;
      if (i < liste.length - 1) {
        var fahrt = Math.max(0.2, einst.uebergang);
        phasen.push({ art: 'fahrt', von: i, nach: i + 1, start: t, ende: t + fahrt });
        t += fahrt;
      }
    }
    return { phasen: phasen, gesamt: Math.max(t, 0.001) };
  }

  /**
   * Pose, Text und Deckkraft zu einem Zeitpunkt. Der Text blendet über die
   * Mitte der Fahrt hinweg über: erst der alte aus, dann der neue ein.
   */
  function zeitachseAbtasten(achse, liste, verstrichen) {
    var fertig = verstrichen >= achse.gesamt;
    var t = klemmen(verstrichen, 0, achse.gesamt);

    var phase = achse.phasen[achse.phasen.length - 1];
    for (var i = 0; i < achse.phasen.length; i++) {
      var p = achse.phasen[i];
      if (t >= p.start && t <= p.ende) { phase = p; break; }
    }

    var pose, folie, deckkraft, ph;
    if (phase.art === 'halt') {
      folie = liste[phase.index];
      pose = folie.pose;
      deckkraft = 1;
      ph = { art: 'halt', index: phase.index };
    } else {
      var spanne = (phase.ende - phase.start) || 1;
      var u = klemmen((t - phase.start) / spanne, 0, 1);
      pose = poseMischen(liste[phase.von].pose, liste[phase.nach].pose, weichMitte(u));
      ph = { art: 'fahrt', von: phase.von, nach: phase.nach, u: weichMitte(u) };
      if (u < 0.5) { folie = liste[phase.von]; deckkraft = 1 - weich(u / 0.5); }
      else { folie = liste[phase.nach]; deckkraft = weich((u - 0.5) / 0.5); }
    }

    // Sanft ein- und ausblenden, ganz am Anfang und am Ende der Vorführung.
    var rand = Math.min(0.6, achse.gesamt / 4);
    deckkraft *= Math.min(weich(t / rand), weich((achse.gesamt - t) / rand));

    return {
      pose: pose, tag: folie.tag, pos: folie.caption, style: folie.style,
      deckkraft: deckkraft, fortschritt: t / achse.gesamt, fertig: fertig, phase: ph,
    };
  }

  // ── Die Kamera lesen und stellen ───────────────────────────────────────────

  function poseLesen() {
    var v = viewer();
    if (!v) return null;
    var c = v.camera;
    var fov = (c.frustum && typeof c.frustum.fov === 'number')
      ? Cesium.Math.toDegrees(c.frustum.fov) : FOV_VORGABE;
    var p = c.positionWC;
    return { pos: [p.x, p.y, p.z], hpr: [c.heading, c.pitch, c.roll], fov: fov };
  }

  function poseStellen(pose, mitRegler) {
    var v = viewer();
    if (!v || !pose) return;
    var c = v.camera;
    c.cancelFlight();
    c.setView({
      destination: new Cesium.Cartesian3(pose.pos[0], pose.pos[1], pose.pos[2]),
      orientation: { heading: pose.hpr[0], pitch: pose.hpr[1], roll: pose.hpr[2] },
    });
    var frustum = c.frustum;
    if (frustum && typeof frustum.fov === 'number' && Math.abs(Cesium.Math.toDegrees(frustum.fov) - pose.fov) > 0.01) {
      // Je Bild nur das Feld setzen; die Regler im Panel (BimViewer.setFieldOfView)
      // werden erst beim Stillstand nachgeführt — die suchen ihre Elemente im DOM.
      if (mitRegler && window.BimViewer && window.BimViewer.setFieldOfView) window.BimViewer.setFieldOfView(pose.fov);
      else frustum.fov = Cesium.Math.toRadians(klemmen(pose.fov, 20, 120));
    }
  }

  // ── Das Label über der Szene ───────────────────────────────────────────────

  var label = null;
  var labelInhalt = null;
  var labelSchluessel = '';

  function labelBauen() {
    if (label) return;
    label = document.createElement('div');
    label.className = 'praes-label';
    labelInhalt = document.createElement('div');
    labelInhalt.className = 'praes-label__inhalt';
    label.appendChild(labelInhalt);
    document.body.appendChild(label);
    labelZiehen(label);
  }

  function labelZeichnen(text, pos, stil, deckkraft, bearbeiten) {
    labelBauen();
    var leer = T.istLeer(text);
    var schluessel = (bearbeiten ? 'e|' : 'p|') + text;
    if (schluessel !== labelSchluessel) {
      labelSchluessel = schluessel;
      labelInhalt.innerHTML = leer
        ? (bearbeiten ? '<span class="pmd-placeholder">Folientext …</span>' : '')
        : T.html(text);
    }
    // stilAnwenden setzt den Klassennamen neu — die Zustandsklassen danach wieder auf.
    var zieht = label.classList.contains('is-dragging');
    T.stilAnwenden(label, stil);
    if (bearbeiten) label.classList.add('is-editing');
    if (zieht) label.classList.add('is-dragging');

    var a = T.animVersatz(stil.anim, deckkraft);
    label.style.left = (pos.x * 100) + '%';
    label.style.top = (pos.y * 100) + '%';
    label.style.transform = 'translate(-50%, -50%) translate(' + (a.dx * window.innerWidth) + 'px, ' +
      (a.dy * window.innerHeight) + 'px) scale(' + a.scale + ')';
    // Ein leeres Label darf keinen leeren Kasten im Bild stehen lassen.
    label.style.opacity = String(leer && !bearbeiten ? 0 : deckkraft);
  }

  function labelVerbergen() {
    if (!label) return;
    label.style.opacity = '0';
    label.classList.remove('is-editing');
  }

  /** Solange eine Folie gewählt ist, liegt ihr Label im Bild und lässt sich an die Stelle ziehen. */
  function vorschau() {
    if (modus !== 'ruhe') return;
    var f = folieGewaehlt();
    if (!f) { labelVerbergen(); return; }
    labelZeichnen(f.tag, f.caption, f.style, 1, true);
  }

  function labelZiehen(knoten) {
    var zieht = false, dx = 0, dy = 0;
    knoten.addEventListener('pointerdown', function (e) {
      if (modus !== 'ruhe' || !folieGewaehlt()) return;
      e.preventDefault();
      var r = knoten.getBoundingClientRect();
      dx = e.clientX - (r.left + r.width / 2);
      dy = e.clientY - (r.top + r.height / 2);
      zieht = true;
      knoten.setPointerCapture(e.pointerId);
      knoten.classList.add('is-dragging');
    });
    knoten.addEventListener('pointermove', function (e) {
      if (!zieht) return;
      var f = folieGewaehlt();
      if (!f) return;
      f.caption = {
        x: klemmen((e.clientX - dx) / window.innerWidth, 0, 1),
        y: klemmen((e.clientY - dy) / window.innerHeight, 0, 1),
      };
      vorschau();
    });
    function ende(e) {
      if (!zieht) return;
      zieht = false;
      knoten.classList.remove('is-dragging');
      if (knoten.hasPointerCapture(e.pointerId)) knoten.releasePointerCapture(e.pointerId);
      speichern();
      melden();
    }
    knoten.addEventListener('pointerup', ende);
    knoten.addEventListener('pointercancel', ende);
  }

  // ── Folien bearbeiten ──────────────────────────────────────────────────────

  function folieGewaehlt() {
    for (var i = 0; i < folien.length; i++) if (folien[i].id === gewaehlt) return folien[i];
    return null;
  }

  function folieMit(id) {
    for (var i = 0; i < folien.length; i++) if (folien[i].id === id) return folien[i];
    return null;
  }

  function kopie(o) { return JSON.parse(JSON.stringify(o)); }

  // ── Die Szene einer Folie ──────────────────────────────────────────────────

  function Zt() { return window.BimViewer && window.BimViewer.Zustand; }

  /** Der Zustand der Szene jetzt, oder null, wenn die Registry fehlt oder nichts meldet. */
  function szeneLesen() {
    var Z = Zt();
    if (!Z) return null;
    var z = Z.lesen();
    return Object.keys(z).length ? z : null;
  }

  // Szenenwechsel laufen nacheinander: ein Schnitt braucht das Modell, das er
  // schneidet, und ein Modell zu laden dauert. Je Bild eine neue Anwendung
  // anzustoßen, solange die vorige noch läuft, hieße dieselbe Arbeit zweimal.
  var szenenLauf = { kette: Promise.resolve(), busy: 0, angewandt: -1, fahrt: null };

  function szeneAnwenden(szene, opt) {
    var Z = Zt();
    if (!Z || !szene) return Promise.resolve();
    szenenLauf.busy++;
    var p = szenenLauf.kette
      .then(function () { return Z.anwenden(szene, opt); })
      .then(function (r) {
        if (r && r.fehler && r.fehler.length && !(opt && opt.weich)) {
          meldung('Szene: ' + r.fehler.map(function (f) { return f.id + ': ' + f.meldung; }).join(' · '), 'warning');
        }
      })
      .catch(function (e) { console.error('[Präsentation] Szene:', e); })
      .then(function () { szenenLauf.busy--; });
    szenenLauf.kette = p;
    return p;
  }

  /** Die letzte Szene bis einschließlich `index` — eine Folie ohne Szene erbt die davor. */
  function szeneFuer(index) {
    for (var i = Math.min(index, folien.length - 1); i >= 0; i--) if (folien[i].szene) return folien[i].szene;
    return null;
  }

  /**
   * Der Übergang zwischen zwei Szenen. Zu Beginn springt, was sich nicht mischen
   * lässt (Modelle, Filter …); danach fährt je Bild, was eine Zahl ist; am Ende
   * steht die Szene der Zielfolie genau.
   */
  function szenenFahrtStart(a, b) {
    var Z = Zt();
    if (!Z || !b) return null;
    a = a || Z.lesen();
    var ids = Z.geaendert(a, b);
    if (ids.length) szeneAnwenden(Z.uebergangStart(a, b));
    return { a: a, b: b, ids: ids };
  }

  function szenenFahrtBild(f, u) {
    var Z = Zt();
    if (!Z || !f || !f.ids.length || szenenLauf.busy > 0) return;
    szeneAnwenden(Z.mischen(f.a, f.b, u), { weich: true, nur: f.ids });
  }

  /** Der Zeitachse folgen: im Halt die Szene der Folie, in der Fahrt der Übergang dorthin. */
  function szeneTreiben(ph) {
    if (!ph || !Zt()) return;
    if (ph.art === 'halt') {
      if (szenenLauf.angewandt !== ph.index) {
        szenenLauf.angewandt = ph.index;
        szenenLauf.fahrt = null;
        var f = folien[ph.index];
        if (f && f.szene) szeneAnwenden(f.szene);
      }
      return;
    }
    if (!szenenLauf.fahrt || szenenLauf.fahrt.nach !== ph.nach) {
      var ziel = folien[ph.nach];
      szenenLauf.fahrt = ziel && ziel.szene ? szenenFahrtStart(szeneFuer(ph.von), ziel.szene) : { ids: [] };
      szenenLauf.fahrt.nach = ph.nach;
    }
    szenenFahrtBild(szenenLauf.fahrt, ph.u);
  }

  function waehlen(id, springen) {
    gewaehlt = id;
    var f = folieGewaehlt();
    if (f && springen !== false) {
      poseStellen(f.pose, true);
      if (modus === 'ruhe' && f.szene) szeneAnwenden(f.szene);
    }
    vorschau();
    melden();
  }

  /** Die aktuelle Ansicht als Folie, hinter der gewählten — sie erbt deren Stil, damit ein Deck einheitlich bleibt. */
  function hinzufuegen() {
    var pose = poseLesen();
    if (!pose) throw new Error('Viewer noch nicht bereit');
    var vorher = folieGewaehlt() || folien[folien.length - 1];
    var f = {
      id: neueId(), tag: '', hold: einstellungen.halt, pose: pose,
      caption: vorher ? kopie(vorher.caption) : kopie(TEXT_LAGE),
      style: vorher ? kopie(vorher.style) : T.stilNormalisieren(),
      szene: szeneLesen(),
    };
    var i = vorher ? folien.indexOf(vorher) + 1 : folien.length;
    folien.splice(i, 0, f);
    speichern();
    waehlen(f.id, false);
    return f;
  }

  function duplizieren(id) {
    var f = folieMit(id || gewaehlt);
    if (!f) return null;
    var k = kopie(f);
    k.id = neueId();
    folien.splice(folien.indexOf(f) + 1, 0, k);
    speichern();
    waehlen(k.id, false);
    return k;
  }

  function loeschen(id) {
    var i = folien.indexOf(folieMit(id || gewaehlt));
    if (i < 0) return;
    folien.splice(i, 1);
    if (folieGewaehlt() === null) gewaehlt = folien.length ? folien[Math.min(i, folien.length - 1)].id : null;
    speichern();
    vorschau();
    melden();
  }

  function kameraSetzen(id) {
    var f = folieMit(id || gewaehlt);
    var pose = poseLesen();
    if (!f || !pose) return;
    f.pose = pose;
    speichern();
    melden();
  }

  /** Die Szene, wie sie jetzt ist, in die Folie schreiben. */
  function szeneAufnehmen(id) {
    var f = folieMit(id || gewaehlt);
    if (!f) return;
    f.szene = szeneLesen();
    speichern();
    melden();
  }

  /** Die Folie lässt die Szene künftig, wie sie ist (sie erbt die der vorigen). */
  function szeneEntfernen(id) {
    var f = folieMit(id || gewaehlt);
    if (!f) return;
    f.szene = null;
    speichern();
    melden();
  }

  /** Die Szene einer Folie herstellen, ohne die Kamera anzufassen. */
  function szeneZeigen(id) {
    var f = folieMit(id || gewaehlt);
    return f && f.szene ? szeneAnwenden(f.szene) : Promise.resolve();
  }

  function stilAufAlle(id) {
    var f = folieMit(id || gewaehlt);
    if (!f) return;
    folien.forEach(function (x) { x.style = kopie(f.style); });
    speichern();
    vorschau();
    melden();
  }

  function verschieben(von, nach) {
    if (von === nach || von < 0 || nach < 0 || von >= folien.length || nach >= folien.length) return;
    var m = folien.splice(von, 1)[0];
    folien.splice(nach, 0, m);
    speichern();
    melden();
  }

  function textSetzen(id, text) {
    var f = folieMit(id);
    if (!f) return;
    f.tag = String(text);
    speichern();
    vorschau();
  }

  function haltSetzen(id, sekunden) {
    var f = folieMit(id);
    var v = parseFloat(sekunden);
    if (!f || !isFinite(v) || v < 0) return;
    f.hold = v;
    speichern();
    melden();
  }

  function lageSetzen(id, x, y) {
    var f = folieMit(id);
    if (!f) return;
    f.caption = { x: klemmen(x, 0, 1), y: klemmen(y, 0, 1) };
    speichern();
    vorschau();
    melden();
  }

  function stilSetzen(id, feld, wert) {
    var f = folieMit(id);
    if (!f || !(feld in T.STIL_VORGABE)) return;
    var s = kopie(f.style);
    s[feld] = wert;
    f.style = T.stilNormalisieren(s);
    speichern();
    vorschau();
    melden();
  }

  function einstellungSetzen(feld, wert) {
    var v = parseFloat(wert);
    if (!isFinite(v)) return;
    if (feld === 'uebergang') einstellungen.uebergang = Math.max(0.2, v);
    else if (feld === 'halt') einstellungen.halt = Math.max(0, v);
    else return;
    speichern();
    melden();
  }

  function leeren() {
    beenden(false);
    folien = [];
    gewaehlt = null;
    speichern();
    vorschau();
    melden();
  }

  function jsonEinlesen(text) {
    var d = deckLesen(text);
    if (!d.folien.length) throw new Error('Die Datei enthält keine brauchbare Folie');
    beenden(false);
    einstellungen = d.einstellungen;
    folien = d.folien;
    gewaehlt = folien[0].id;
    speichern();
    vorschau();
    melden();
    return d;
  }

  // ===========================================================================
  // DIE VORFÜHRUNG
  // ===========================================================================

  var treiber = null;              // { vorRender, nachRender } — Cesium-Ereignisentferner
  var davorPose = null;
  var davorSzene = null;
  var startet = false;
  var eingabenVorher = true;
  var manuell = { index: 0, von: null, zeit: 0, dauer: 1, ausVon: -1 };
  var letzterStempel = 0;
  var aufnahme = null;
  var tastenHorcher = null;

  /** Auf Cesiums Bildablauf haken: Zeit und Pose vor dem Zeichnen, Aufnahme danach. */
  function treiberAn(beiBild, nachBild) {
    var v = viewer();
    treiberAb();
    var scene = v.scene;
    letzterStempel = performance.now();
    var vor = scene.preUpdate.addEventListener(function () {
      var jetzt = performance.now();
      // Ein Bildsprung (Tab im Hintergrund, Nachladen) darf die Fahrt nicht
      // weiterkatapultieren.
      var dt = Math.min(0.25, (jetzt - letzterStempel) / 1000);
      var roh = (jetzt - letzterStempel) / 1000;
      letzterStempel = jetzt;
      beiBild(dt, roh);
      scene.requestRender();
    });
    var nach = nachBild ? scene.postRender.addEventListener(nachBild) : null;
    treiber = { vor: vor, nach: nach };
  }

  function treiberAb() {
    if (!treiber) return;
    treiber.vor();
    if (treiber.nach) treiber.nach();
    treiber = null;
  }

  function eingaben(an) {
    var v = viewer();
    if (v) v.scene.screenSpaceCameraController.enableInputs = an;
  }

  function vorfuehrungEin(neu) {
    // Der Geh- und Flugmodus schreibt den Kurs in jedem Bild auf die Kamera —
    // er würde die Folienpose sofort wieder überschreiben.
    if (window.WalkMode && window.WalkMode.isEnabled && window.WalkMode.isEnabled()) window.WalkMode.toggle(false);
    var v = viewer();
    eingabenVorher = v ? v.scene.screenSpaceCameraController.enableInputs : true;
    modus = neu;
    davorPose = poseLesen();
    document.body.classList.add('praes-laeuft');
    document.body.classList.toggle('praes-manuell', neu === 'manuell');
    labelVerbergen();
    eingaben(false);
    melden();
  }

  function vorfuehrungAus(zurueck) {
    treiberAb();
    tastenAb();
    modus = 'ruhe';
    document.body.classList.remove('praes-laeuft', 'praes-manuell');
    labelVerbergen();
    eingaben(eingabenVorher);
    if (zurueck && davorPose) {
      poseStellen(davorPose, true);
      if (davorSzene) szeneAnwenden(davorSzene);
    } else if (window.BimViewer && window.BimViewer.setFieldOfView && poseLesen()) window.BimViewer.setFieldOfView(poseLesen().fov);
    davorPose = null;
    davorSzene = null;
    szenenLauf.fahrt = null;
    vorschau();
    melden();
  }

  function pruefenBereit() {
    if (startet) return false;
    if (!folien.length) { meldung('Erst eine Folie anlegen', 'warning'); return false; }
    if (!viewer()) { meldung('Viewer noch nicht bereit', 'warning'); return false; }
    if (modus !== 'ruhe') beenden(true);
    return true;
  }

  /**
   * Bevor die erste Folie läuft: merken, wie die Szene vorher aussah (für Esc),
   * alles laden, was irgendeine Folie braucht — mitten im Flug käme ein Modell
   * zu spät —, und die Szene der Startfolie herstellen.
   */
  async function startbereit(index) {
    var Z = Zt();
    davorSzene = szeneLesen();
    szenenLauf.fahrt = null;
    szenenLauf.angewandt = index;
    if (!Z) return true;
    var szenen = folien.map(function (f) { return f.szene; }).filter(Boolean);
    if (!szenen.length) return true;
    startet = true;
    try {
      meldung('Szene wird vorbereitet …', 'loading');
      await Z.vorbereiten(szenen);
      var erste = szeneFuer(index);
      if (erste) await szeneAnwenden(erste);
    } finally {
      startet = false;
    }
    return true;
  }

  // ── Von Hand weiterklicken ─────────────────────────────────────────────────

  function tastenAn() {
    tastenAb();
    tastenHorcher = function (e) {
      var ziel = e.target;
      if (ziel && /^(INPUT|TEXTAREA|SELECT)$/.test(ziel.tagName)) return;
      var taste = e.key;
      var vor = taste === 'ArrowRight' || taste === 'ArrowDown' || taste === ' ' || taste === 'PageDown';
      var zurueck = taste === 'ArrowLeft' || taste === 'ArrowUp' || taste === 'PageUp' || taste === 'Backspace';
      if (!(vor || zurueck || taste === 'Home' || taste === 'End' || taste === 'Escape')) return;
      // In der Erfassungsphase und ohne Weitergabe: dieselben Tasten gehören sonst
      // dem Flugmodus, dem Rundgang und den Werkzeugen.
      e.preventDefault();
      e.stopPropagation();
      if (modus === 'manuell') {
        if (vor) zu(manuell.index + 1);
        else if (zurueck) zu(manuell.index - 1);
        else if (taste === 'Home') zu(0);
        else if (taste === 'End') zu(folien.length - 1);
      }
      if (taste === 'Escape') beenden(true);
    };
    window.addEventListener('keydown', tastenHorcher, true);
  }

  function tastenAb() {
    if (tastenHorcher) window.removeEventListener('keydown', tastenHorcher, true);
    tastenHorcher = null;
  }

  function zu(index) {
    if (modus !== 'manuell') return;
    var n = klemmen(index, 0, folien.length - 1);
    if (n === manuell.index && manuell.von === null) return;
    manuell.ausVon = manuell.index;
    manuell.index = n;
    manuell.von = poseLesen();
    manuell.zeit = 0;
    manuell.dauer = Math.max(0.2, einstellungen.uebergang);
    // Von der Szene aus, die gerade wirklich steht — zwischen zwei Folien durfte
    // man sich umsehen und etwas verstellen.
    manuell.fahrt = folien[n].szene ? szenenFahrtStart(null, folien[n].szene) : null;
    eingaben(false);
    melden();
  }

  async function praesentieren(ab) {
    if (!pruefenBereit()) return;
    var start = klemmen((typeof ab === 'number') ? ab : Math.max(0, folien.indexOf(folieGewaehlt())), 0, folien.length - 1);
    await startbereit(start);
    vorfuehrungEin('manuell');
    manuell = { index: start, von: poseLesen(), zeit: 0, fahrt: null,
                dauer: Math.max(0.2, einstellungen.uebergang), ausVon: -1 };
    tastenAn();

    treiberAn(function (dt) {
      var f = folien[manuell.index];
      if (!f) return;
      if (manuell.von) {
        manuell.zeit += dt;
        var t = klemmen(manuell.zeit / manuell.dauer, 0, 1);
        poseStellen(poseMischen(manuell.von, f.pose, weichMitte(t)), false);
        szenenFahrtBild(manuell.fahrt, weichMitte(t));
        // Der alte Text blendet zuerst aus, der neue übernimmt.
        var davor = folien[manuell.ausVon];
        if (t < 0.4 && davor) labelZeichnen(davor.tag, davor.caption, davor.style, 1 - weich(t / 0.4), false);
        else labelZeichnen(f.tag, f.caption, f.style, weich((t - 0.4) / 0.6), false);
        if (t >= 1) {
          if (manuell.fahrt) szeneAnwenden(manuell.fahrt.b);
          manuell.fahrt = null;
          manuell.von = null;
          manuell.ausVon = -1;
          // Die Kamera zurückgeben, damit sich das Publikum umsehen kann.
          eingaben(true);
        }
      } else {
        labelZeichnen(f.tag, f.caption, f.style, 1, false);
      }
    });
    melden();
  }

  // ── Zeitgesteuert ──────────────────────────────────────────────────────────

  var fortschritt = 0;

  async function auto() {
    if (!pruefenBereit()) return;
    var achse = zeitachseBauen(folien, einstellungen);
    await startbereit(0);
    vorfuehrungEin('auto');
    tastenAn();
    var verstrichen = 0;
    fortschritt = 0;

    treiberAn(function (dt) {
      verstrichen += dt;
      var z = zeitachseAbtasten(achse, folien, verstrichen);
      poseStellen(z.pose, false);
      szeneTreiben(z.phase);
      labelZeichnen(z.tag, z.pos, z.style, z.deckkraft, false);
      fortschritt = z.fortschritt;
      melden();
      if (z.fertig) vorfuehrungAus(false);
    });
  }

  // ── Video ──────────────────────────────────────────────────────────────────

  /** Safaris MediaRecorder kennt nur MP4/H.264, nie WebM — er kommt deshalb hinter die WebM-Kandidaten, aber hinein. */
  function codecWaehlen() {
    var kandidaten = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
                      'video/mp4;codecs=avc1', 'video/mp4'];
    for (var i = 0; i < kandidaten.length; i++) {
      if (MediaRecorder.isTypeSupported(kandidaten[i])) return kandidaten[i];
    }
    return '';
  }

  async function video() {
    if (!pruefenBereit()) return;
    var quelle = viewer().canvas;
    if (typeof MediaRecorder === 'undefined' || typeof quelle.captureStream !== 'function') {
      meldung('Video-Export wird in diesem Browser nicht unterstützt', 'error');
      return;
    }
    var codec = codecWaehlen();
    if (!codec) { meldung('Kein passender Video-Kodierer im Browser', 'error'); return; }

    // Die Labels kommen INS Video: aufgenommen wird der Canvas der Szene, und
    // ein DOM-Label darüber käme nie hinein. Also wird je Bild die Szene in
    // einen zweiten Canvas kopiert und der Text dazugezeichnet.
    var breite = quelle.width, hoehe = quelle.height;
    var mischung = document.createElement('canvas');
    mischung.width = breite;
    mischung.height = hoehe;
    var ctx = mischung.getContext('2d', { alpha: false });
    if (!ctx) { meldung('Aufnahmefläche nicht anlegbar', 'error'); return; }

    var achse = zeitachseBauen(folien, einstellungen);
    await startbereit(0);   // die Modelle sind da, bevor die Aufnahme läuft
    var stuecke = [];
    var rekorder = new MediaRecorder(mischung.captureStream(30), { mimeType: codec, videoBitsPerSecond: 12000000 });
    rekorder.ondataavailable = function (e) { if (e.data.size > 0) stuecke.push(e.data); };
    rekorder.onstop = function () {
      treiberAb();
      var blob = new Blob(stuecke, { type: codec });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'praesentation-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) +
                   '.' + (codec.indexOf('video/mp4') === 0 ? 'mp4' : 'webm');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      aufnahme = null;
      vorfuehrungAus(true);
      meldung('Video gespeichert', 'success');
    };

    vorfuehrungEin('aufnahme');
    tastenAn();
    aufnahme = { rekorder: rekorder, z: null };
    fortschritt = 0;
    rekorder.start();

    // Die Zeit läuft mit der Wanduhr, denn der MediaRecorder stempelt auch so.
    var beginn = performance.now();
    treiberAn(function () {
      var z = zeitachseAbtasten(achse, folien, (performance.now() - beginn) / 1000);
      poseStellen(z.pose, false);
      szeneTreiben(z.phase);
      aufnahme.z = z;
      fortschritt = z.fortschritt;
      labelVerbergen();   // das DOM-Label bleibt aus, das Video trägt sein eigenes
      melden();
    }, function () {
      // Nach dem Zeichnen: die Szene steht jetzt auf der Pose von eben.
      var z = aufnahme && aufnahme.z;
      if (!z) return;
      ctx.drawImage(quelle, 0, 0, breite, hoehe);
      T.zeichnen(ctx, quelle, { text: z.tag, opacity: z.deckkraft, width: breite, height: hoehe,
                                pos: z.pos, style: z.style });
      if (z.fertig && rekorder.state !== 'inactive') rekorder.stop();
    });
  }

  function beenden(zurueck) {
    if (aufnahme && aufnahme.rekorder && aufnahme.rekorder.state !== 'inactive') {
      aufnahme.rekorder.stop();          // onstop räumt auf und speichert das Bisherige
      return;
    }
    if (modus !== 'ruhe') vorfuehrungAus(zurueck !== false);
  }

  // ── Bild für Bild: Rendern auf Zeitpunkt t ─────────────────────────────────
  //
  // Die Aufnahme des MediaRecorders läuft mit der Wanduhr — auf einem Rechner
  // ohne GPU (oder im Headless-Chrome des MCP) schafft die Szene ein Bild je
  // Sekunde, und das Video wäre eine Diashow. Hier bestimmt nicht die Uhr,
  // sondern der Aufrufer die Zeit: `bildBei(t)` stellt Pose, Szene und Text für
  // den Zeitpunkt t her, wartet, bis Kacheln und Modelle stehen, und liefert das
  // fertige Bild. Wie lange das dauert, ist gleichgültig; das Ergebnis ist bei
  // jedem Lauf dasselbe — dieselbe Zeitachse, dieselbe Szenenfahrt, derselbe Text
  // wie in der Vorführung.

  var rendernZustand = null;

  /** Die Zeitachse für Aufrufer von außen: Dauer und der Mittelpunkt jedes Halts. */
  function zeitachseGeben() {
    var achse = zeitachseBauen(folien, einstellungen);
    var halte = achse.phasen.filter(function (p) { return p.art === 'halt'; }).map(function (p) {
      return { index: p.index, start: p.start, ende: p.ende, mitte: (p.start + p.ende) / 2 };
    });
    return { gesamt: achse.gesamt, halte: halte, uebergang: einstellungen.uebergang };
  }

  /** Alles laden, was irgendeine Folie braucht, und die Szene der ersten herstellen. */
  async function rendernStart() {
    if (!folien.length) throw new Error('Kein Deck — erst Folien anlegen');
    if (!viewer()) throw new Error('Viewer noch nicht bereit');
    if (modus !== 'ruhe') beenden(true);
    var davor = { pose: poseLesen(), szene: szeneLesen() };
    var Z = Zt();
    var szenen = folien.map(function (f) { return f.szene; }).filter(Boolean);
    if (Z && szenen.length) {
      await Z.vorbereiten(szenen);
      if (szenen[0]) await szeneAnwenden(szeneFuer(0));
    }
    szenenLauf.fahrt = null;
    szenenLauf.angewandt = 0;
    var breite = viewer().canvas.width, hoehe = viewer().canvas.height;
    var mischung = document.createElement('canvas');
    mischung.width = breite; mischung.height = hoehe;
    rendernZustand = { achse: zeitachseBauen(folien, einstellungen), davor: davor, mischung: mischung };
    labelVerbergen();
    eingaben(false);
    return { gesamt: rendernZustand.achse.gesamt, breite: breite, hoehe: hoehe };
  }

  function kachelnFertig() {
    var v = viewer();
    // Ein ausgeblendeter Globus lädt nichts — auf ihn zu warten hieße, bis zur Frist zu warten.
    if (v.scene.globe.show !== false && !v.scene.globe.tilesLoaded) return false;
    var B = window.BimViewer, fertig = true;
    if (B.loadedAssets instanceof Map) {
      B.loadedAssets.forEach(function (a) {
        var t = a && a.tileset;
        if (t && a.visible !== false && typeof t.tilesLoaded === 'boolean' && !t.tilesLoaded) fertig = false;
      });
    }
    return fertig;
  }

  /**
   * So lange zeichnen, bis das Bild steht: alle Kacheln da UND zwei aufeinander
   * folgende Bilder gleich. Die zweite Bedingung ist nötig, weil nach einem
   * Szenenwechsel Shader neu gebaut werden (Weißabgleich, Schnitt) und das erste
   * Bild danach leer oder dunkel bleiben kann — auch wenn alle Kacheln geladen
   * sind. Verglichen wird ein 16×9-Abzug des Bildes, das kostet nichts.
   */
  async function ausrendern(v, frist) {
    var klein = document.createElement('canvas');
    klein.width = 16; klein.height = 9;
    var kc = klein.getContext('2d', { willReadFrequently: true });
    var vorher = null, gleich = 0, n = 0;
    var ende = performance.now() + frist;
    while (performance.now() < ende) {
      v.scene.render();
      n++;
      kc.drawImage(v.canvas, 0, 0, 16, 9);
      var sig = Array.prototype.join.call(kc.getImageData(0, 0, 16, 9).data, ',');
      if (n >= 3 && kachelnFertig() && sig === vorher) { if (++gleich >= 2) return; }
      else gleich = 0;
      vorher = sig;
      await new Promise(function (r) { setTimeout(r, 60); });
    }
    v.scene.render();
  }

  /**
   * Das Bild zum Zeitpunkt t (Sekunden seit Beginn) als data:-URI.
   * `opt`: { format: 'png' | 'jpeg', qualitaet: 0..1, frist: ms Wartezeit auf Kacheln }
   */
  async function bildBei(t, opt) {
    opt = opt || {};
    if (!rendernZustand) throw new Error('rendernStart() fehlt');
    var R = rendernZustand;
    var z = zeitachseAbtasten(R.achse, folien, t);
    poseStellen(z.pose, false);
    szeneTreiben(z.phase);
    await szenenLauf.kette;

    var v = viewer();
    await ausrendern(v, opt.frist || 8000);

    var quelle = v.canvas, ctx = R.mischung.getContext('2d', { alpha: false });
    if (R.mischung.width !== quelle.width || R.mischung.height !== quelle.height) {
      R.mischung.width = quelle.width; R.mischung.height = quelle.height;
    }
    ctx.drawImage(quelle, 0, 0, quelle.width, quelle.height);
    T.zeichnen(ctx, quelle, { text: z.tag, opacity: z.deckkraft, width: quelle.width, height: quelle.height,
                              pos: z.pos, style: z.style });
    var mime = opt.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return { bild: R.mischung.toDataURL(mime, opt.qualitaet || 0.92), t: t, phase: z.phase, fertig: z.fertig };
  }

  /** Aufräumen: die Ansicht von vor dem Rendern zurückgeben. */
  async function rendernEnde() {
    if (!rendernZustand) return;
    var davor = rendernZustand.davor;
    rendernZustand = null;
    eingaben(true);
    if (davor.pose) poseStellen(davor.pose, true);
    if (davor.szene) await szeneAnwenden(davor.szene);
    szenenLauf.fahrt = null;
    vorschau();
  }

  // ── Öffentliche Schnittstelle ──────────────────────────────────────────────

  laden();

  window.Praesentation = {
    FORMAT: FORMAT,
    folien: function () { return folien; },
    einstellungen: function () { return einstellungen; },
    gewaehlt: function () { return gewaehlt; },
    folieGewaehlt: folieGewaehlt,
    zustand: function () {
      return { modus: modus, index: manuell.index, anzahl: folien.length, fortschritt: fortschritt,
               gewaehlt: gewaehlt, szeneBusy: szenenLauf.busy };
    },
    horchen: function (f) { if (typeof f === 'function') horcher.push(f); },

    waehlen: waehlen,
    hinzufuegen: hinzufuegen,
    duplizieren: duplizieren,
    loeschen: loeschen,
    kameraSetzen: kameraSetzen,
    szeneAufnehmen: szeneAufnehmen,
    szeneEntfernen: szeneEntfernen,
    szeneZeigen: szeneZeigen,
    stilAufAlle: stilAufAlle,
    verschieben: verschieben,
    textSetzen: textSetzen,
    haltSetzen: haltSetzen,
    lageSetzen: lageSetzen,
    stilSetzen: stilSetzen,
    einstellungSetzen: einstellungSetzen,
    leeren: leeren,
    vorschau: vorschau,

    praesentieren: praesentieren,
    zu: zu,
    auto: auto,
    video: video,
    beenden: beenden,

    zeitachse: zeitachseGeben,
    rendernStart: rendernStart,
    bildBei: bildBei,
    rendernEnde: rendernEnde,

    jsonAusgeben: deckSchreiben,
    jsonEinlesen: jsonEinlesen,

    _intern: {
      poseMischen: poseMischen, ortMischen: ortMischen, winkelDelta: winkelDelta,
      zeitachseBauen: zeitachseBauen, zeitachseAbtasten: zeitachseAbtasten,
      folieNormalisieren: folieNormalisieren, deckLesen: deckLesen, deckSchreiben: deckSchreiben,
      einstellungenNormalisieren: einstellungenNormalisieren, poseNormalisieren: poseNormalisieren,
      weichMitte: weichMitte, SPEICHER: SPEICHER,
    },
  };

  console.log('🎬 Präsentation (Folien mit Kamerapose) geladen');
})();
