/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// ZUSTAND — die Registry für alles, was die Szene ausmacht
//
// Eine Folie der Präsentation merkt sich mehr als die Kamera: welche Modelle
// geladen sind, welche Bauteiltypen fehlen, wo der Schnitt steht, wie weit die
// Explosion offen ist, welche Farben und welches Licht gelten. Damit das nicht
// an einer zentralen Stelle steht, die jedes Werkzeug kennen müsste, meldet sich
// jedes Werkzeug selbst an — dieselbe Bauart wie `bereichAnmelden` in ui.js:
//
//     BimViewer.Zustand.anmelden({
//       id: 'schnitt', ordnung: 40, titel: 'Schnitt',
//       lesen:  () => ({ an: true, box: { min: [..], max: [..] } }),   // reines JSON
//       setzen: async (wert, opt) => { … },                            // idempotent
//       weich:  ['box.min', 'box.max', 'yaw@winkel'],                  // fährt zwischen Folien
//       schema: { 'box.min': { typ: 'meter3' }, … },                   // für das MCP
//       vorbereiten: async (werte) => { … },                           // optional
//     });
//
// ## Was `lesen` liefert
//
// Reines JSON aus Zahlen, Text, Wahrheitswerten, Listen einfacher Werte und
// verschachtelten Objekten. Was mehrere gleichartige Dinge hält (Modelle,
// Scheiben), ist ein OBJEKT nach Kennung und keine Liste — sonst ließe sich der
// Zustand zweier Folien weder vergleichen noch Zahl für Zahl mischen.
//
// ## Was `setzen` tun muss
//
// Idempotent sein: den Zustand herstellen, der übergeben wird, gleich wie er
// vorher war. Ein Modell, das schon geladen ist, wird nicht neu geladen. Mit
// `opt.weich === true` kommt derselbe Aufbau, aber mit gemischten Zahlen —
// dann nur diese Zahlen nachziehen und nichts neu aufbauen (Bildrate!).
//
// ## Weich und hart
//
// `weich` nennt die Pfade, die zwischen zwei Folien MITFAHREN: Zahlen, und
// Listen von Zahlen (elementweise). Alles andere springt, und zwar zu Beginn des
// Übergangs — ein Modell, das erscheinen soll, soll da sein, bevor die Kamera
// hinfliegt. Ein `@winkel` hinter dem Pfad mischt Grad auf dem kurzen Weg
// (350° → 10° sind 20°). `*` passt auf genau einen Pfadabschnitt:
// `modelle.*.deckkraft`.
//
// Ein Pfad, der nur in EINEM der beiden Zustände vorkommt (der Schnitt, der
// erst auf der zweiten Folie da ist), lässt sich nicht mischen — er springt.
//
// ## Reihenfolge
//
// `ordnung` bestimmt sie, nicht der Zeitpunkt der Anmeldung: Modelle (10) vor
// Filter (20) vor Schnitt (40) vor Darstellung (60…). Sonst hinge die Szene an
// der Reihenfolge der `<script>`-Zeilen. Angewendet wird nacheinander und mit
// Warten, denn ein Schnitt braucht das Modell, das er schneidet.
// ===============================
'use strict';

(function () {

  var eintraege = [];

  // ── Bäume vergleichen und kopieren ─────────────────────────────────────────

  function istObjekt(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  function kopie(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

  function gleich(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!gleich(a[i], b[i])) return false;
      return true;
    }
    if (istObjekt(a) && istObjekt(b)) {
      var ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var j = 0; j < ka.length; j++) {
        if (!Object.prototype.hasOwnProperty.call(b, ka[j]) || !gleich(a[ka[j]], b[ka[j]])) return false;
      }
      return true;
    }
    return typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b);
  }

  // ── Mischen ────────────────────────────────────────────────────────────────

  /** Der kürzeste Weg zwischen zwei Winkeln in Grad. */
  function winkelMischen(a, b, t) {
    var d = ((b - a) % 360 + 540) % 360 - 180;
    return a + d * t;
  }

  /** `modelle.*.deckkraft@winkel` → { teile: ['modelle','*','deckkraft'], winkel: true } */
  function musterLesen(text) {
    var winkel = false;
    var t = String(text);
    if (t.slice(-7) === '@winkel') { winkel = true; t = t.slice(0, -7); }
    return { teile: t.split('.'), winkel: winkel };
  }

  function passt(muster, pfad) {
    if (muster.teile.length !== pfad.length) return false;
    for (var i = 0; i < pfad.length; i++) {
      if (muster.teile[i] !== '*' && muster.teile[i] !== pfad[i]) return false;
    }
    return true;
  }

  function zahl(x) { return typeof x === 'number' && isFinite(x); }

  function blattMischen(a, b, t, winkel) {
    if (zahl(a) && zahl(b)) return winkel ? winkelMischen(a, b, t) : a + (b - a) * t;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(zahl) && b.every(zahl)) {
      return b.map(function (y, i) { return winkel ? winkelMischen(a[i], y, t) : a[i] + (y - a[i]) * t; });
    }
    return undefined;   // nicht mischbar — bleibt, wie es in b steht
  }

  /**
   * Der Zustand von B, bei dem die weichen Zahlen zwischen A und B liegen.
   * Was sich nicht mischen lässt, bleibt wie in B.
   */
  function baumMischen(a, b, t, muster, pfad) {
    if (istObjekt(b)) {
      var aus = {};
      Object.keys(b).forEach(function (k) {
        var p = pfad.concat(k);
        aus[k] = baumMischen(istObjekt(a) ? a[k] : undefined, b[k], t, muster, p);
      });
      return aus;
    }
    for (var i = 0; i < muster.length; i++) {
      if (passt(muster[i], pfad)) {
        var m = blattMischen(a, b, t, muster[i].winkel);
        if (m !== undefined) return m;
        break;
      }
    }
    return kopie(b);
  }

  // ── Anmelden ───────────────────────────────────────────────────────────────

  function anmelden(beschreibung) {
    if (!beschreibung || !beschreibung.id || typeof beschreibung.lesen !== 'function' ||
        typeof beschreibung.setzen !== 'function') {
      console.warn('[Zustand] anmelden braucht id, lesen und setzen');
      return;
    }
    var e = {
      id: beschreibung.id,
      ordnung: typeof beschreibung.ordnung === 'number' ? beschreibung.ordnung : 500,
      titel: beschreibung.titel || beschreibung.id,
      lesen: beschreibung.lesen,
      setzen: beschreibung.setzen,
      vorbereiten: beschreibung.vorbereiten || null,
      weich: (beschreibung.weich || []).map(musterLesen),
      weichText: (beschreibung.weich || []).slice(),
      schema: beschreibung.schema || {},
      beschreibung: beschreibung.beschreibung || '',
    };
    var i = eintraege.findIndex(function (x) { return x.id === e.id; });
    if (i >= 0) eintraege[i] = e; else eintraege.push(e);
    eintraege.sort(function (x, y) { return x.ordnung - y.ordnung; });
  }

  function eintrag(id) { return eintraege.filter(function (e) { return e.id === id; })[0] || null; }

  // ── Lesen und Anwenden ─────────────────────────────────────────────────────

  /** Der Zustand aller (oder der genannten) Anmelder als reines JSON. */
  function lesen(ids) {
    var aus = {};
    eintraege.forEach(function (e) {
      if (ids && ids.indexOf(e.id) < 0) return;
      try {
        var w = e.lesen();
        if (w !== undefined && w !== null) aus[e.id] = kopie(w);
      } catch (f) {
        console.error('[Zustand] lesen "' + e.id + '":', f);
      }
    });
    return aus;
  }

  /**
   * Einen Zustand herstellen. Anmelder, die im Zustand fehlen, bleiben, wie sie
   * sind — eine Folie darf nur einen Teil der Szene festlegen.
   * `opt`: { nur: [ids], weich: true }. Liefert { fehler: [{ id, meldung }] }.
   */
  async function anwenden(zustand, opt) {
    opt = opt || {};
    var fehler = [];
    for (var i = 0; i < eintraege.length; i++) {
      var e = eintraege[i];
      if (!zustand || !(e.id in zustand)) continue;
      if (opt.nur && opt.nur.indexOf(e.id) < 0) continue;
      if (opt.weich && !e.weich.length) continue;
      try {
        await e.setzen(kopie(zustand[e.id]), { weich: !!opt.weich });
      } catch (f) {
        console.error('[Zustand] setzen "' + e.id + '":', f);
        fehler.push({ id: e.id, meldung: String(f && f.message || f) });
      }
    }
    return { fehler: fehler };
  }

  /** Welche Anmelder unterscheiden sich in A und B? */
  function geaendert(a, b) {
    var ids = [];
    eintraege.forEach(function (e) {
      if (!b || !(e.id in b)) return;
      if (!a || !(e.id in a) || !gleich(a[e.id], b[e.id])) ids.push(e.id);
    });
    return ids;
  }

  /**
   * Der Zustand bei Bruchteil t zwischen A und B: Aufbau von B, weiche Zahlen
   * gemischt. Nur Anmelder mit weichen Pfaden, und nur solche, die in beiden da sind.
   */
  function mischen(a, b, t) {
    var aus = {};
    eintraege.forEach(function (e) {
      if (!e.weich.length || !b || !(e.id in b)) return;
      if (!a || !(e.id in a)) return;
      aus[e.id] = baumMischen(a[e.id], b[e.id], t, e.weich, []);
    });
    return aus;
  }

  /**
   * Der Zustand, mit dem ein Übergang von A nach B BEGINNT: für jeden
   * geänderten Anmelder der Aufbau von B (ein Modell soll da sein, bevor die
   * Kamera hinfliegt), aber mit den weichen Zahlen von A — sie fahren erst
   * während des Übergangs.
   */
  function uebergangStart(a, b) {
    var aus = {};
    var weich = mischen(a, b, 0);
    geaendert(a, b).forEach(function (id) { aus[id] = (id in weich) ? weich[id] : kopie(b[id]); });
    return aus;
  }

  /**
   * Was für eine Folge von Zuständen bereitstehen muss, bevor die erste Folie
   * läuft — zuerst das, was Zeit braucht: Modelle laden, solange noch niemand
   * zusieht, statt mitten im Flug.
   */
  async function vorbereiten(zustaende) {
    var fehler = [];
    for (var i = 0; i < eintraege.length; i++) {
      var e = eintraege[i];
      if (!e.vorbereiten) continue;
      var werte = zustaende.map(function (z) { return z && z[e.id]; }).filter(function (w) { return w !== undefined; });
      if (!werte.length) continue;
      try { await e.vorbereiten(kopie(werte)); }
      catch (f) { console.error('[Zustand] vorbereiten "' + e.id + '":', f); fehler.push({ id: e.id, meldung: String(f && f.message || f) }); }
    }
    return { fehler: fehler };
  }

  /** Beschreibung aller Anmelder — für die Oberfläche und das MCP. */
  function schema() {
    return eintraege.map(function (e) {
      return { id: e.id, titel: e.titel, ordnung: e.ordnung, beschreibung: e.beschreibung,
               weich: e.weichText.slice(), felder: kopie(e.schema) };
    });
  }

  window.BimViewer = window.BimViewer || {};
  window.BimViewer.Zustand = {
    anmelden: anmelden,
    ids: function () { return eintraege.map(function (e) { return e.id; }); },
    hat: function (id) { return !!eintrag(id); },
    lesen: lesen,
    anwenden: anwenden,
    geaendert: geaendert,
    mischen: mischen,
    uebergangStart: uebergangStart,
    vorbereiten: vorbereiten,
    schema: schema,
    gleich: gleich,
    _intern: { baumMischen: baumMischen, musterLesen: musterLesen, passt: passt,
               winkelMischen: winkelMischen, blattMischen: blattMischen, eintraege: eintraege },
  };
})();
