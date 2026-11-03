/**
 * iLEEN — Schnitt: der Rechenkern
 *
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Alles am Schnittwerkzeug, was sich ohne Cesium und ohne Browser rechnen
 * lässt: welche Stelle stehen bleibt, wie eine gezogene Linie zur Scheibe
 * wird, was unter dem Zeiger liegt, wie die Karte auf den Bildschirm fällt,
 * und wie ein Ausschnitt als Anfrage ans Backend aussieht. `schnitt.js` und
 * `schnitt-karte.js` benutzen nur diese Funktionen; `tests/schnitt/` prüft sie
 * in einer `vm`.
 *
 * ── Das Bezugssystem ─────────────────────────────────────────────────────
 *
 * Gerechnet wird im **Rahmen**: ein ENU-System im Schwerpunkt der Szene,
 * gedreht um die Hochachse (`yaw`, mathematisch positiv). x und y liegen
 * waagerecht, z zeigt nach oben. Die Box ist ein achsparalleler Quader in
 * diesem Rahmen (`min`/`max`), eine Scheibe ein senkrechter Streifen: eine
 * Gerade im Grundriss mit einer Dicke.
 *
 * ── Scheiben ─────────────────────────────────────────────────────────────
 *
 * Eine Scheibe ist `{ winkel, d, dicke }`: `winkel` ist die Richtung ihrer
 * **Normalen** im Grundriss (Grad, 0 = +x), `d` der Abstand der Mittellinie
 * vom Ursprung längs dieser Normalen. Ein „X-Schnitt" hat die Normale +x —
 * die Linie steht quer zur x-Achse, `d` ist ihr x-Wert. Diese Form steht
 * unverändert im Shader: `abs(dot(n, p.xy) − d) ≤ dicke/2`.
 *
 * ── Was stehen bleibt ────────────────────────────────────────────────────
 *
 *   innen(p) = min( Abstand zur nächsten Boxfläche,
 *                   max über alle Scheiben (halbe Dicke − Abstand zur Mitte) )
 *
 * Positiv heißt: in der Box **und** in mindestens einer Scheibe. Ohne
 * Scheiben zählt die Box allein. „Innen behalten" verwirft `innen < 0`,
 * „Innen weg" verwirft `innen ≥ 0` — genau das Gegenstück, und zwar für Box
 * und Scheiben zugleich. Mit Cesiums Clipping-Ebenen ging das nicht: dort
 * lässt sich nur „eine Ebene reicht" oder „alle Ebenen müssen" wählen, und
 * eine Vereinigung mehrerer Streifen ist keines von beidem.
 */
'use strict';

(function (wurzel) {

  var MAX_SCHEIBEN = 8;
  var MINDEST = 0.05;          // m — dünner wird weder Box noch Scheibe
  var BUCHSTABEN = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  function rad(grad) { return grad * Math.PI / 180; }
  function grad(r) { return r * 180 / Math.PI; }

  /** Winkel auf (−180, 180]. */
  function winkelNorm(w) {
    var x = ((w + 180) % 360 + 360) % 360 - 180;
    return x === -180 ? 180 : x;
  }

  function normale(s) {
    var w = rad(s.winkel);
    return [Math.cos(w), Math.sin(w)];
  }

  // ── Was stehen bleibt ──────────────────────────────────────────────────

  /** Abstand zur nächsten Boxfläche; positiv innen, negativ außen. */
  function boxInnen(p, box) {
    var w = Infinity;
    for (var i = 0; i < 3; i++) {
      w = Math.min(w, p[i] - box.min[i], box.max[i] - p[i]);
    }
    return w;
  }

  /** Halbe Dicke minus Abstand zur Mittellinie; positiv in der Scheibe. */
  function scheibeInnen(p, s) {
    var n = normale(s);
    return s.dicke / 2 - Math.abs(n[0] * p[0] + n[1] * p[1] - s.d);
  }

  /** Die wirksamen Scheiben: eingeschaltet, höchstens so viele wie der Shader trägt. */
  function wirksameScheiben(scheiben) {
    return (scheiben || []).filter(function (s) { return s.an !== false; }).slice(0, MAX_SCHEIBEN);
  }

  /**
   * Dieselbe Rechnung wie im Shader (`schnitt.js`, `FRAGMENT`).
   * Positiv: der Punkt liegt im stehengelassenen Bereich von „Innen behalten".
   */
  function innen(p, box, scheiben) {
    var wert = boxInnen(p, box);
    var liste = wirksameScheiben(scheiben);
    if (liste.length) {
      var s = -Infinity;
      liste.forEach(function (sch) { s = Math.max(s, scheibeInnen(p, sch)); });
      wert = Math.min(wert, s);
    }
    return wert;
  }

  /** Bleibt der Punkt stehen? */
  function bleibt(p, box, scheiben, modus) {
    var w = innen(p, box, scheiben);
    return modus === 'aussen' ? w < 0 : w >= 0;
  }

  /** Schneidet die Box etwas weg, oder steht sie auf der ganzen Szene? */
  function boxSchneidet(box, szene) {
    if (!box || !szene) return false;
    for (var i = 0; i < 3; i++) {
      if (box.min[i] > szene.min[i] + 1e-6 || box.max[i] < szene.max[i] - 1e-6) return true;
    }
    return false;
  }

  /** Wirkt überhaupt ein Schnitt? Sonst bleibt der Shader im Ruhestand. */
  function wirksam(box, szene, scheiben, modus) {
    if (!box) return false;
    if (modus === 'aussen') return true;
    return boxSchneidet(box, szene) || wirksameScheiben(scheiben).length > 0;
  }

  // ── Scheiben anlegen ───────────────────────────────────────────────────

  /**
   * Eine Scheibe aus einer gezogenen Linie von `a` nach `b` (Grundriss).
   * Die Normale steht links der Zugrichtung — damit bleibt die Richtung
   * nachvollziehbar, wenn man dieselbe Linie andersherum zieht: die Scheibe
   * ist dieselbe, nur ihre Normale zeigt zur anderen Seite.
   */
  function scheibeAusLinie(a, b, dicke) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < 1e-9) return null;
    var w = winkelNorm(grad(Math.atan2(dy, dx)) + 90);
    var n = [Math.cos(rad(w)), Math.sin(rad(w))];
    return { winkel: w, d: n[0] * a[0] + n[1] * a[1], dicke: Math.max(dicke, MINDEST) };
  }

  /** Achsscheibe durch die Mitte der Box: 'x' steht quer zur x-Achse, 'y' quer zur y-Achse. */
  function achsScheibe(achse, box, dicke) {
    var i = achse === 'y' ? 1 : 0;
    return {
      winkel: achse === 'y' ? 90 : 0,
      d: (box.min[i] + box.max[i]) / 2,
      dicke: Math.max(dicke, MINDEST),
    };
  }

  /** Der nächste freie Buchstabe — Schnitte heißen im Plan A–A, B–B … */
  function freierName(scheiben) {
    var belegt = {};
    (scheiben || []).forEach(function (s) { belegt[s.name] = true; });
    for (var i = 0; i < BUCHSTABEN.length; i++) {
      if (!belegt[BUCHSTABEN[i]]) return BUCHSTABEN[i];
    }
    return String((scheiben || []).length + 1);
  }

  /**
   * Eine Kante der Scheibe einseitig verschieben — die gegenüberliegende
   * bleibt stehen, wie bei den Flächen der Box. `seite` +1 ist die Kante in
   * Normalenrichtung, −1 die andere; `lage` ist der neue Abstand dieser
   * Kante vom Ursprung längs der Normalen.
   */
  function scheibenKante(s, seite, lage) {
    var gegen = s.d - seite * s.dicke / 2;
    var dicke = Math.max(MINDEST, seite * (lage - gegen));
    return { winkel: s.winkel, d: gegen + seite * dicke / 2, dicke: dicke };
  }

  /**
   * Die Scheibe um einen Drehpunkt auf ihrer Mittellinie drehen. Der
   * Drehpunkt bleibt auf der Linie — sonst wanderte die Scheibe beim Drehen
   * aus dem Bild.
   */
  function scheibeDrehen(s, drehpunkt, winkel) {
    var w = winkelNorm(winkel);
    var n = [Math.cos(rad(w)), Math.sin(rad(w))];
    return { winkel: w, d: n[0] * drehpunkt[0] + n[1] * drehpunkt[1], dicke: s.dicke };
  }

  /** Der Punkt der Mittellinie, der einem gegebenen Punkt am nächsten liegt. */
  function aufMittellinie(s, p) {
    var n = normale(s);
    var ab = n[0] * p[0] + n[1] * p[1] - s.d;
    return [p[0] - ab * n[0], p[1] - ab * n[1]];
  }

  // ── Linien im Rechteck ─────────────────────────────────────────────────

  /**
   * Die Gerade `dot(n, p) = d` im Rechteck [min, max] (Grundriss) als
   * Strecke, oder null. Liang–Barsky auf der Parameterform.
   */
  function linieImRechteck(winkel, d, min, max) {
    var w = rad(winkel);
    var n = [Math.cos(w), Math.sin(w)];
    var u = [-n[1], n[0]];                 // Linienrichtung
    var p0 = [n[0] * d, n[1] * d];
    var t0 = -Infinity, t1 = Infinity;
    for (var i = 0; i < 2; i++) {
      if (Math.abs(u[i]) < 1e-12) {
        if (p0[i] < min[i] - 1e-9 || p0[i] > max[i] + 1e-9) return null;
        continue;
      }
      var a = (min[i] - p0[i]) / u[i];
      var b = (max[i] - p0[i]) / u[i];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (!(t1 > t0)) return null;
    return {
      a: [p0[0] + u[0] * t0, p0[1] + u[1] * t0],
      b: [p0[0] + u[0] * t1, p0[1] + u[1] * t1],
      t0: t0, t1: t1, richtung: u, normale: n,
    };
  }

  /** Mittellinie und beide Kanten einer Scheibe im Rechteck. */
  function scheibenLinien(s, min, max) {
    return {
      mitte: linieImRechteck(s.winkel, s.d, min, max),
      plus: linieImRechteck(s.winkel, s.d + s.dicke / 2, min, max),
      minus: linieImRechteck(s.winkel, s.d - s.dicke / 2, min, max),
    };
  }

  // ── Karte: Welt ↔ Bild ─────────────────────────────────────────────────

  /**
   * Die Kartenansicht: Mitte in Rahmenkoordinaten, Maßstab in Pixel je
   * Meter, Bildgröße. Norden (Rahmen-y) zeigt nach oben — Bild-y wächst
   * nach unten, deshalb das Minus.
   */
  function zuBild(ansicht, x, y) {
    return [
      ansicht.b / 2 + (x - ansicht.cx) * ansicht.massstab,
      ansicht.h / 2 - (y - ansicht.cy) * ansicht.massstab,
    ];
  }

  function zuWelt(ansicht, px, py) {
    return [
      ansicht.cx + (px - ansicht.b / 2) / ansicht.massstab,
      ansicht.cy - (py - ansicht.h / 2) / ansicht.massstab,
    ];
  }

  /** Ansicht, in der das Rechteck [min, max] mit `rand` Pixeln Luft ganz zu sehen ist. */
  function einpassen(min, max, b, h, rand) {
    var r = rand === undefined ? 18 : rand;
    var bx = Math.max(max[0] - min[0], 1e-3);
    var by = Math.max(max[1] - min[1], 1e-3);
    var m = Math.min((b - 2 * r) / bx, (h - 2 * r) / by);
    return {
      cx: (min[0] + max[0]) / 2, cy: (min[1] + max[1]) / 2,
      massstab: Math.max(m, 1e-6), b: b, h: h,
    };
  }

  /** Um den Bildpunkt (px, py) zoomen — der Punkt unter dem Zeiger bleibt stehen. */
  function zoomen(ansicht, px, py, faktor) {
    var vorher = zuWelt(ansicht, px, py);
    var neu = Object.assign({}, ansicht, { massstab: ansicht.massstab * faktor });
    var nachher = zuWelt(neu, px, py);
    neu.cx += vorher[0] - nachher[0];
    neu.cy += vorher[1] - nachher[1];
    return neu;
  }

  function abstandZurStrecke(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var l2 = dx * dx + dy * dy;
    var t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  /**
   * Was liegt unter dem Zeiger? `maus` in Bildpixeln.
   *
   * Reihenfolge von klein nach groß: der Drehgriff der gewählten Scheibe,
   * dann die Scheibenkanten, dann die Boxkanten (Ecken zuerst), dann der
   * Scheibenkörper. Ohne diese Reihenfolge wäre eine Scheibe, die an der
   * Boxkante liegt, nicht mehr zu greifen — der breitere Treffer gewönne.
   *
   * Ergebnis: { art: 'drehen' | 'scheibenkante' | 'ecke' | 'kante' |
   *             'scheibe' | null, … }
   */
  function treffer(ansicht, maus, box, scheiben, aktiv, toleranz) {
    var tol = toleranz || 7;
    var liste = scheiben || [];

    var gewaehlt = liste.filter(function (s) { return s.id === aktiv; })[0];
    if (gewaehlt) {
      var g = drehgriff(ansicht, gewaehlt, box);
      if (g && Math.hypot(maus[0] - g[0], maus[1] - g[1]) <= tol + 2) {
        return { art: 'drehen', id: gewaehlt.id };
      }
    }

    // Die gewählte Scheibe zuerst, dann die übrigen von oben nach unten.
    var reihe = liste.slice().sort(function (a, b) {
      return (b.id === aktiv) - (a.id === aktiv);
    });
    for (var i = 0; i < reihe.length; i++) {
      var s = reihe[i];
      if (s.an === false) continue;
      var linien = scheibenLinien(s, box.min, box.max);
      var beste = null;
      [['plus', 1], ['minus', -1]].forEach(function (paar) {
        var l = linien[paar[0]];
        if (!l) return;
        var a = zuBild(ansicht, l.a[0], l.a[1]);
        var b = zuBild(ansicht, l.b[0], l.b[1]);
        var ab = abstandZurStrecke(maus, a, b);
        if (ab <= tol && (!beste || ab < beste.ab)) beste = { ab: ab, seite: paar[1] };
      });
      // Eine sehr dünne Scheibe hat beide Kanten unter dem Zeiger. Dann ist
      // „verschieben" gemeint — sonst bliebe sie auf ewig unbeweglich, weil
      // jeder Griff nur ihre Dicke verändert.
      var dickeImBild = s.dicke * ansicht.massstab;
      if (beste && dickeImBild > 2 * tol) {
        return { art: 'scheibenkante', id: s.id, seite: beste.seite };
      }
    }

    // Boxkanten: x-Kanten sind senkrecht im Bild, y-Kanten waagerecht.
    var ecke = zuBild(ansicht, box.min[0], box.max[1]);
    var gegen = zuBild(ansicht, box.max[0], box.min[1]);
    var links = ecke[0], oben = ecke[1], rechts = gegen[0], unten = gegen[1];
    var imX = maus[0] >= links - tol && maus[0] <= rechts + tol;
    var imY = maus[1] >= oben - tol && maus[1] <= unten + tol;
    var nahLinks = Math.abs(maus[0] - links) <= tol && imY;
    var nahRechts = Math.abs(maus[0] - rechts) <= tol && imY;
    var nahOben = Math.abs(maus[1] - oben) <= tol && imX;
    var nahUnten = Math.abs(maus[1] - unten) <= tol && imX;
    var xSeite = nahLinks ? 'min' : nahRechts ? 'max' : null;
    var ySeite = nahUnten ? 'min' : nahOben ? 'max' : null;
    if (xSeite && ySeite) return { art: 'ecke', x: xSeite, y: ySeite };
    if (xSeite) return { art: 'kante', achse: 0, seite: xSeite };
    if (ySeite) return { art: 'kante', achse: 1, seite: ySeite };

    // Der Körper einer Scheibe — irgendwo zwischen ihren Kanten.
    var welt = zuWelt(ansicht, maus[0], maus[1]);
    for (var j = 0; j < reihe.length; j++) {
      var sch = reihe[j];
      if (sch.an === false) continue;
      var halbImBild = Math.max(sch.dicke * ansicht.massstab / 2, tol);
      var n = normale(sch);
      var ab2 = Math.abs(n[0] * welt[0] + n[1] * welt[1] - sch.d) * ansicht.massstab;
      if (ab2 <= halbImBild && welt[0] >= box.min[0] && welt[0] <= box.max[0] &&
          welt[1] >= box.min[1] && welt[1] <= box.max[1]) {
        return { art: 'scheibe', id: sch.id };
      }
    }
    return null;
  }

  /**
   * Der Drehgriff einer Scheibe, in Bildpixeln: am Ende der Mittellinie,
   * 14 px nach innen versetzt, damit er nicht auf der Boxkante sitzt.
   */
  function drehgriff(ansicht, s, box) {
    var l = linieImRechteck(s.winkel, s.d, box.min, box.max);
    if (!l) return null;
    var a = zuBild(ansicht, l.a[0], l.a[1]);
    var b = zuBild(ansicht, l.b[0], l.b[1]);
    var dx = a[0] - b[0], dy = a[1] - b[1];
    var laenge = Math.hypot(dx, dy);
    if (laenge < 30) return null;
    // Das obere Ende ist leichter zu greifen als das untere: dort liegt die
    // Leiste mit den Knöpfen nicht im Weg.
    var ende = a[1] <= b[1] ? a : b, anfang = ende === a ? b : a;
    var ex = (anfang[0] - ende[0]) / laenge, ey = (anfang[1] - ende[1]) / laenge;
    return [ende[0] + ex * 14, ende[1] + ey * 14];
  }

  // ── Farben ─────────────────────────────────────────────────────────────

  // Viridis in neun Stützstellen: dunkel unten, hell oben, und in Graustufen
  // gedruckt immer noch geordnet. Dieselbe Rampe steht an der Höhenleiste.
  var VIRIDIS = [
    [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141],
    [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37],
  ];

  function viridis(t) {
    var x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
    var i = Math.min(Math.floor(x), VIRIDIS.length - 2);
    var f = x - i;
    var a = VIRIDIS[i], b = VIRIDIS[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ];
  }

  // ── Anfragen ans Backend ───────────────────────────────────────────────

  /**
   * Die drei Detailebenen eines tile-lokalen Ausschnitts
   * `{ center, size, yaw }` — dieselbe Vereinbarung wie zuvor in der
   * Schnittbox (Kompass-Yaw, `cut_offset` von der −Y-Kante, YZ als um 90°
   * gedrehte Box). Siehe CLAUDE.md, „Als Detail in den Plan".
   */
  function detailAnfrage(b, ebene, anteil) {
    var t = Math.min(1, Math.max(0, anteil === undefined ? 0.5 : anteil));
    var gemeinsam = { with_views: true, with_rooms: false };
    if (ebene === 'xy') {
      return Object.assign({ center: b.center.slice(), size: b.size.slice(), yaw: b.yaw || 0,
        mode: 'grundriss', cut_height: b.size[2] * t }, gemeinsam);
    }
    if (ebene === 'xz') {
      return Object.assign({ center: b.center.slice(), size: b.size.slice(), yaw: b.yaw || 0,
        mode: 'schnitt', cut_offset: b.size[1] * t }, gemeinsam);
    }
    if (ebene === 'yz') {
      return Object.assign({ center: b.center.slice(), size: [b.size[1], b.size[0], b.size[2]],
        yaw: (b.yaw || 0) + 90, mode: 'schnitt', cut_offset: b.size[0] * t }, gemeinsam);
    }
    return null;
  }

  /**
   * Der Ausschnitt einer Scheibe im Rahmen: Mitte, Größe und die Richtung
   * der Box-x-Achse (Grad im Rahmen). x läuft längs der Schnittlinie, y quer
   * dazu durch die Scheibendicke — das Backend schneidet im Schnitt-Modus
   * quer zu `size[1]`, also genau durch die Scheibe.
   */
  function scheibenAusschnitt(s, box) {
    var l = linieImRechteck(s.winkel, s.d, box.min, box.max);
    if (!l) return null;
    var tm = (l.t0 + l.t1) / 2;
    return {
      mitte: [
        l.normale[0] * s.d + l.richtung[0] * tm,
        l.normale[1] * s.d + l.richtung[1] * tm,
        (box.min[2] + box.max[2]) / 2,
      ],
      groesse: [l.t1 - l.t0, s.dicke, box.max[2] - box.min[2]],
      richtung: winkelNorm(s.winkel + 90),
    };
  }

  /**
   * Kompass-Yaw einer Richtung, die im tile-lokalen System als Vektor
   * vorliegt. Das Backend dreht im Uhrzeigersinn (`along = [cos a, −sin a]`),
   * deshalb das Minus — dieselbe Rechnung wie in `plan-panel.js`.
   */
  function kompassYaw(xTile) {
    return grad(Math.atan2(-xTile[1], xTile[0]));
  }

  /** Einen Wert auf ein Raster ziehen — `schritt` ≤ 0 lässt ihn stehen. */
  function einrasten(wert, schritt) {
    if (!(schritt > 0)) return wert;
    return Math.round(wert / schritt) * schritt;
  }

  /** Ein schönes Raster für die Kartenbeschriftung: 1, 2 oder 5 mal einer Zehnerpotenz. */
  function schoenerSchritt(roh) {
    if (!(roh > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(roh)));
    var f = roh / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  var SchnittRechnen = {
    MAX_SCHEIBEN: MAX_SCHEIBEN,
    MINDEST: MINDEST,
    rad: rad, grad: grad, winkelNorm: winkelNorm, normale: normale,
    boxInnen: boxInnen, scheibeInnen: scheibeInnen, innen: innen, bleibt: bleibt,
    wirksameScheiben: wirksameScheiben, boxSchneidet: boxSchneidet, wirksam: wirksam,
    scheibeAusLinie: scheibeAusLinie, achsScheibe: achsScheibe, freierName: freierName,
    scheibenKante: scheibenKante, scheibeDrehen: scheibeDrehen, aufMittellinie: aufMittellinie,
    linieImRechteck: linieImRechteck, scheibenLinien: scheibenLinien,
    zuBild: zuBild, zuWelt: zuWelt, einpassen: einpassen, zoomen: zoomen,
    abstandZurStrecke: abstandZurStrecke, treffer: treffer, drehgriff: drehgriff,
    viridis: viridis,
    detailAnfrage: detailAnfrage, scheibenAusschnitt: scheibenAusschnitt, kompassYaw: kompassYaw,
    einrasten: einrasten, schoenerSchritt: schoenerSchritt,
  };

  wurzel.SchnittRechnen = SchnittRechnen;
  if (typeof module !== 'undefined' && module.exports) module.exports = SchnittRechnen;

})(typeof window !== 'undefined' ? window : globalThis);
