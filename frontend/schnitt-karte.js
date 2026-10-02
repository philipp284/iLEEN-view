/**
 * iLEEN — Schnittkarte und Reiter „Schnitte"
 *
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Die Bedienung zu `schnitt.js`, in zwei Teilen:
 *
 * **Die Schnittkarte** schwebt oben rechts über der Szene, wie das
 * Transekt-Fenster in 3Dtrees.earth: eine Draufsicht, eingefärbt nach der
 * Höhe, daneben eine Höhenleiste. Die Box wird an ihren Kanten
 * eingeschoben — von unten gezogen schneidet sie den Süden weg, von oben den
 * Norden, links und rechts ebenso; an der Leiste unten und oben. Scheiben
 * entstehen über X, Y oder eine frei gezogene Linie (✎) und werden an ihren
 * Kanten dicker oder dünner, in der Mitte verschoben und am runden Griff
 * gedreht.
 *
 * **Der Reiter** im Panel Werkzeuge trägt, was nicht auf die Karte passt:
 * Zahlen zum Eintippen, die Liste der Scheiben, Geschosse, Darstellung,
 * Detailzeichnung. Beide lesen denselben Zustand und melden sich über
 * `Schnitt.beobachten()` — keiner kennt den anderen.
 *
 * Die Karte zeichnet im Rahmen von `schnitt.js`: Rahmen-y nach oben. Ist der
 * Rahmen auf die Modellachsen gedreht, steht das Gebäude in der Karte
 * gerade; der Nordpfeil zeigt dann schräg.
 */
'use strict';

(function () {

  if (!window.BimViewer || !BimViewer.Schnitt || !window.SchnittRechnen) {
    console.error('❌ schnitt-karte.js: schnitt.js muss vorher geladen sein');
    return;
  }

  var S = BimViewer.Schnitt;
  var R = window.SchnittRechnen;
  var Z = S.zustand;

  var DICKEN = [0.5, 1, 5, 10, 20];
  var AKZENT = '#97BF0D';
  var KARTE_B = 252, KARTE_H = 236, LEISTE_B = 58;

  function ue(schluessel, ersatz) {
    var s = (typeof t === 'function') ? t(schluessel) : schluessel;
    return (s === schluessel) ? ersatz : s;
  }

  function zahl(w, stellen) {
    var s = (w >= 0 ? '+' : '−') + Math.abs(w).toFixed(stellen === undefined ? 2 : stellen);
    return s.replace('.', ',');
  }

  function meter(w, stellen) {
    return Math.abs(w).toFixed(stellen === undefined ? 2 : stellen).replace('.', ',') + ' m';
  }

  function el(id) { return document.getElementById(id); }

  // ═══════════════════════════════════════════════════════════════════════
  //  Die Karte
  // ═══════════════════════════════════════════════════════════════════════

  var karte = null;        // DOM
  var ansicht = null;      // { cx, cy, massstab, b, h }
  var zug = null;          // laufender Zug auf der Karte
  var leistenZug = null;   // laufender Zug an der Höhenleiste
  var unterMaus = null;    // Treffer unter dem Zeiger (ohne Zug)
  var mausWelt = null;     // Rahmenkoordinate unter dem Zeiger
  var zeichnet = false;    // ✎: nächster Zug legt eine Scheibe an
  var klein = false;
  var geplant = false;
  var hbBild = null;       // Canvas mit dem Höhenbild, eine Zelle je Pixel
  var hbStand = -1;

  function box2() {
    return Z.box ? { min: [Z.box.min[0], Z.box.min[1]], max: [Z.box.max[0], Z.box.max[1]] } : null;
  }

  function kartenBau() {
    if (karte) return karte;
    var k = document.createElement('div');
    k.className = 'snk';
    k.id = 'schnittKarte';
    k.tabIndex = 0;
    k.innerHTML =
      '<div class="snk-kopf">' +
        '<span class="snk-titel">✂ ' + ue('schnitt.titel', 'Schnitt') + '</span>' +
        '<div class="snk-neu">' +
          '<button class="snk-k" data-neu="x" title="' + ue('schnitt.neuX', 'Scheibe quer zur X-Achse durch die Boxmitte') + '">X</button>' +
          '<button class="snk-k" data-neu="y" title="' + ue('schnitt.neuY', 'Scheibe quer zur Y-Achse durch die Boxmitte') + '">Y</button>' +
          '<button class="snk-k" data-neu="frei" title="' + ue('schnitt.neuFrei', 'Schnittlinie frei in die Karte ziehen') + '">✎</button>' +
        '</div>' +
        '<button class="snk-k snk-rund" data-tat="klein" title="' + ue('schnitt.klein', 'Einklappen') + '">–</button>' +
        '<button class="snk-k snk-rund" data-tat="zu" title="' + ue('schnitt.beenden', 'Schnitt beenden') + '">×</button>' +
      '</div>' +
      '<div class="snk-rumpf">' +
        '<div class="snk-bilder">' +
          '<canvas class="snk-karte"></canvas>' +
          '<canvas class="snk-leiste"></canvas>' +
        '</div>' +
        '<div class="snk-anzeige" id="snkAnzeige">—</div>' +
        '<div class="snk-fuss">' +
          '<div class="snk-dicken" id="snkDicken"></div>' +
          '<button class="snk-k" data-tat="ganz" title="' + ue('schnitt.ganzHint', 'Box zurück auf die ganze Szene') + '">▣</button>' +
          '<button class="snk-k" data-tat="passen" title="' + ue('schnitt.passenHint', 'Karte auf die Szene einpassen (Doppelklick)') + '">⤢</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(k);
    karte = k;

    k.querySelector('.snk-dicken').innerHTML = DICKEN.map(function (d) {
      return '<button class="snk-pill" data-dicke="' + d + '">' + String(d).replace('.', ',') + ' m</button>';
    }).join('');

    k.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.neu === 'frei') { zeichnet = !zeichnet; stand(); return; }
      if (b.dataset.neu) { zeichnet = false; S.scheibeNeu(b.dataset.neu); return; }
      if (b.dataset.dicke) { S.setDicke(parseFloat(b.dataset.dicke)); return; }
      if (b.dataset.tat === 'klein') { klein = !klein; stand(); return; }
      if (b.dataset.tat === 'zu') { S.beenden(); return; }
      if (b.dataset.tat === 'ganz') { S.ganz(); return; }
      if (b.dataset.tat === 'passen') { passen(); return; }
    });

    k.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && Z.aktiv) {
        S.scheibeWeg(Z.aktiv);
        e.preventDefault();
      } else if (e.key === 'Escape' && zeichnet) {
        zeichnet = false;
        stand();
      }
    });

    kopfZiehen(k.querySelector('.snk-kopf'));
    kartenEreignisse(k.querySelector('.snk-karte'));
    leistenEreignisse(k.querySelector('.snk-leiste'));
    groesse();
    return k;
  }

  /** Die Karte lässt sich am Kopf verschieben — sie soll nie das verdecken, was man ansieht. */
  function kopfZiehen(kopf) {
    var start = null;
    kopf.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      var r = karte.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, links: r.left, oben: r.top };
      kopf.setPointerCapture(e.pointerId);
    });
    kopf.addEventListener('pointermove', function (e) {
      if (!start) return;
      var links = Math.max(0, Math.min(window.innerWidth - 80, start.links + e.clientX - start.x));
      var oben = Math.max(0, Math.min(window.innerHeight - 40, start.oben + e.clientY - start.y));
      karte.style.left = links + 'px';
      karte.style.top = oben + 'px';
      karte.style.right = 'auto';
    });
    kopf.addEventListener('pointerup', function () { start = null; });
  }

  function groesse() {
    var dpr = window.devicePixelRatio || 1;
    [['.snk-karte', KARTE_B], ['.snk-leiste', LEISTE_B]].forEach(function (p) {
      var c = karte.querySelector(p[0]);
      c.style.width = p[1] + 'px';
      c.style.height = KARTE_H + 'px';
      c.width = Math.round(p[1] * dpr);
      c.height = Math.round(KARTE_H * dpr);
    });
  }

  function passen() {
    if (!Z.szene) return;
    ansicht = R.einpassen(Z.szene.min, Z.szene.max, KARTE_B, KARTE_H, 16);
    planen();
  }

  function planen() {
    if (geplant) return;
    geplant = true;
    requestAnimationFrame(function () {
      geplant = false;
      zeichnen();
    });
  }

  // ── Höhenbild ──────────────────────────────────────────────────────────

  /**
   * Aus den Abtastwerten ein Bild, eine Zelle je Pixel. Grob nach fein:
   * jede Stufe malt einen Block ihrer Größe, die feinere übermalt ihn.
   * Leere Zellen malen ausdrücklich durchsichtig — sonst bliebe am Rand
   * eines Gebäudes der grobe Block der Vorstufe stehen.
   *
   * Ist das Bild fertig, kommt eine leichte Schummerung dazu (Licht von
   * Nordwesten): Dachflächen und Traufen lesen sich dann als Form, nicht
   * nur als Farbstufe.
   */
  function hoehenbildBauen() {
    var hb = Z.hoehenbild;
    if (!hb || !Z.szene) { hbBild = null; return; }
    var sp = hb.spalten, ze = hb.zeilen;
    if (!hbBild || hbBild.width !== sp || hbBild.height !== ze) {
      hbBild = document.createElement('canvas');
      hbBild.width = sp;
      hbBild.height = ze;
    }
    var ctx = hbBild.getContext('2d');
    var bild = ctx.createImageData(sp, ze);
    var d = bild.data;
    var z0 = Z.szene.min[2], z1 = Z.szene.max[2];
    var spanne = Math.max(z1 - z0, 1e-3);

    function licht(i, j) {
      if (!hb.fertig) return 1;
      function w(a, b) {
        a = Math.max(0, Math.min(sp - 1, a)); b = Math.max(0, Math.min(ze - 1, b));
        var v = hb.werte[b * sp + a];
        return isNaN(v) ? null : v;
      }
      var mitte = w(i, j);
      var gx = ((w(i + 1, j) === null ? mitte : w(i + 1, j)) - (w(i - 1, j) === null ? mitte : w(i - 1, j))) / (2 * hb.zelle);
      var gy = ((w(i, j + 1) === null ? mitte : w(i, j + 1)) - (w(i, j - 1) === null ? mitte : w(i, j - 1))) / (2 * hb.zelle);
      var n = [-gx, -gy, 1];
      var l = Math.hypot(n[0], n[1], n[2]);
      var hell = (n[0] * -0.5 + n[1] * 0.5 + n[2] * 0.7071) / l;
      return 0.55 + 0.45 * Math.max(0, Math.min(1, hell));
    }

    [8, 4, 2, 1].forEach(function (st) {
      for (var k = 0; k < hb.stufe.length; k++) {
        if (hb.stufe[k] !== st) continue;
        var i = k % sp, j = Math.floor(k / sp);
        var v = hb.werte[k];
        var farbe = isNaN(v) ? null : R.viridis((v - z0) / spanne);
        var f = farbe ? licht(i, j) : 0;
        for (var bj = j; bj < Math.min(ze, j + st); bj++) {
          var zeile = ze - 1 - bj;
          for (var bi = i; bi < Math.min(sp, i + st); bi++) {
            var o = (zeile * sp + bi) * 4;
            if (farbe) {
              d[o] = farbe[0] * f; d[o + 1] = farbe[1] * f; d[o + 2] = farbe[2] * f; d[o + 3] = 235;
            } else {
              d[o + 3] = 0;
            }
          }
        }
      }
    });
    ctx.putImageData(bild, 0, 0);
  }

  // ── Zeichnen ───────────────────────────────────────────────────────────

  function zeichnen() {
    if (!karte || !Z.an || klein) return;
    if (!ansicht) passen();
    if (!ansicht) return;
    var c = karte.querySelector('.snk-karte');
    var ctx = c.getContext('2d');
    var dpr = c.width / KARTE_B;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, KARTE_B, KARTE_H);
    ctx.fillStyle = '#0c0d0e';
    ctx.fillRect(0, 0, KARTE_B, KARTE_H);

    raster(ctx);
    hoehenbildMalen(ctx, dpr);
    umrisseMalen(ctx);
    abdeckungMalen(ctx);
    scheibenMalen(ctx);
    boxMalen(ctx);
    stiftMalen(ctx);
    nordpfeil(ctx);
    massstab(ctx);
    fortschritt(ctx);

    leisteZeichnen();
    anzeige();
  }

  function raster(ctx) {
    var schritt = R.schoenerSchritt(40 / ansicht.massstab);
    var lo = R.zuWelt(ansicht, 0, KARTE_H), hi = R.zuWelt(ansicht, KARTE_B, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = Math.ceil(lo[0] / schritt) * schritt; x <= hi[0]; x += schritt) {
      var p = R.zuBild(ansicht, x, 0);
      ctx.moveTo(Math.round(p[0]) + 0.5, 0); ctx.lineTo(Math.round(p[0]) + 0.5, KARTE_H);
    }
    for (var y = Math.ceil(lo[1] / schritt) * schritt; y <= hi[1]; y += schritt) {
      var q = R.zuBild(ansicht, 0, y);
      ctx.moveTo(0, Math.round(q[1]) + 0.5); ctx.lineTo(KARTE_B, Math.round(q[1]) + 0.5);
    }
    ctx.stroke();
  }

  /**
   * Das Höhenbild liegt im ungedrehten ENU; die Karte im gedrehten Rahmen.
   * Eine einzige Affinabbildung (Pixel → ENU → Rahmen → Karte) legt es
   * richtig — ohne Neuabtastung beim Drehen.
   */
  function hoehenbildMalen(ctx, dpr) {
    var hb = Z.hoehenbild;
    if (!hb || !Z.rahmen) return;
    if (hbStand !== hb.anteil + (hb.fertig ? 1 : 0) || !hbBild) {
      hoehenbildBauen();
      hbStand = hb.anteil + (hb.fertig ? 1 : 0);
    }
    if (!hbBild) return;
    var psi = R.rad(Z.rahmen.yaw || 0);
    var co = Math.cos(psi), si = Math.sin(psi);
    var m = ansicht.massstab, z = hb.zelle;
    var ex0 = hb.min[0], eyTop = hb.min[1] + hb.zeilen * z;
    var a = m * z * co, b = m * z * si, c = -m * z * si, d = m * z * co;
    var e = KARTE_B / 2 - ansicht.cx * m + m * (co * ex0 + si * eyTop);
    var f = KARTE_H / 2 + ansicht.cy * m + m * (si * ex0 - co * eyTop);
    ctx.save();
    ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
    ctx.imageSmoothingEnabled = m * z > 3;
    ctx.drawImage(hbBild, 0, 0);
    ctx.restore();
  }

  function umrisseMalen(ctx) {
    var liste = S.umrisse ? S.umrisse() : [];
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    liste.forEach(function (poly) {
      ctx.beginPath();
      poly.forEach(function (p, i) {
        var q = R.zuBild(ansicht, p[0], p[1]);
        if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
      });
      ctx.closePath();
      ctx.stroke();
    });
  }

  function boxRechteck() {
    var a = R.zuBild(ansicht, Z.box.min[0], Z.box.max[1]);
    var b = R.zuBild(ansicht, Z.box.max[0], Z.box.min[1]);
    return { x: a[0], y: a[1], b: b[0] - a[0], h: b[1] - a[1] };
  }

  /** Eine Scheibe als Viereck, weit über die Box hinaus — zugeschnitten wird mit `clip()`. */
  function scheibenPfad(ctx, s) {
    var n = R.normale(s), u = [-n[1], n[0]];
    var weit = 1e5;
    var ecken = [[-weit, -1], [weit, -1], [weit, 1], [-weit, 1]].map(function (e) {
      var ab = s.d + e[1] * s.dicke / 2;
      return R.zuBild(ansicht, n[0] * ab + u[0] * e[0], n[1] * ab + u[1] * e[0]);
    });
    ctx.moveTo(ecken[0][0], ecken[0][1]);
    for (var i = 1; i < 4; i++) ctx.lineTo(ecken[i][0], ecken[i][1]);
    ctx.closePath();
  }

  /**
   * Was weggeschnitten wird, liegt unter einem dunklen Schleier — im Modus
   * „innen behalten" alles außer Box ∩ Scheiben, im Modus „innen weg" genau
   * dieser Bereich. Auf einer eigenen Ebene, damit „ausstanzen" mit
   * `destination-out` den Rest der Karte nicht anfasst.
   */
  var schleier = null;
  function abdeckungMalen(ctx) {
    if (!Z.box) return;
    var dpr = window.devicePixelRatio || 1;
    if (!schleier) schleier = document.createElement('canvas');
    schleier.width = Math.round(KARTE_B * dpr);
    schleier.height = Math.round(KARTE_H * dpr);
    var s = schleier.getContext('2d');
    s.setTransform(dpr, 0, 0, dpr, 0, 0);
    var r = boxRechteck();
    var scheiben = R.wirksameScheiben(Z.scheiben);

    function bereich() {
      s.save();
      s.beginPath();
      s.rect(r.x, r.y, r.b, r.h);
      s.clip();
      s.beginPath();
      if (scheiben.length) scheiben.forEach(function (sch) { scheibenPfad(s, sch); });
      else s.rect(r.x, r.y, r.b, r.h);
      s.fill('nonzero');
      s.restore();
    }

    s.fillStyle = 'rgba(8,9,10,0.72)';
    if (Z.modus === 'aussen') {
      bereich();
    } else {
      s.fillRect(0, 0, KARTE_B, KARTE_H);
      s.globalCompositeOperation = 'destination-out';
      s.fillStyle = '#000';
      bereich();
      s.globalCompositeOperation = 'source-over';
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(schleier, 0, 0);
    ctx.restore();
  }

  function scheibenMalen(ctx) {
    if (!Z.box) return;
    var b2 = box2();
    Z.scheiben.forEach(function (s) {
      var gewaehlt = s.id === Z.aktiv;
      var aus = s.an === false;
      var linien = R.scheibenLinien(s, b2.min, b2.max);
      var hover = (zug && zug.id === s.id) || (unterMaus && unterMaus.id === s.id);

      ctx.save();
      var r = boxRechteck();
      ctx.beginPath(); ctx.rect(r.x, r.y, r.b, r.h); ctx.clip();
      ctx.beginPath();
      scheibenPfad(ctx, s);
      ctx.fillStyle = aus ? 'rgba(255,255,255,0.04)' : (gewaehlt ? 'rgba(151,191,13,0.16)' : 'rgba(151,191,13,0.08)');
      ctx.fill();
      ctx.restore();

      ['plus', 'minus'].forEach(function (k) {
        var l = linien[k];
        if (!l) return;
        var a = R.zuBild(ansicht, l.a[0], l.a[1]), b = R.zuBild(ansicht, l.b[0], l.b[1]);
        var heiss = (zug && zug.art === 'scheibenkante' && zug.id === s.id && zug.seite === (k === 'plus' ? 1 : -1)) ||
          (!zug && unterMaus && unterMaus.art === 'scheibenkante' && unterMaus.id === s.id &&
           unterMaus.seite === (k === 'plus' ? 1 : -1));
        ctx.strokeStyle = aus ? 'rgba(255,255,255,0.25)' : heiss ? '#fff' : AKZENT;
        ctx.lineWidth = heiss ? 2 : (gewaehlt ? 1.5 : 1);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });

      var m = linien.mitte;
      if (!m) return;
      var a = R.zuBild(ansicht, m.a[0], m.a[1]), b = R.zuBild(ansicht, m.b[0], m.b[1]);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = aus ? 'rgba(255,255,255,0.25)' : (hover || gewaehlt ? '#fff' : 'rgba(255,255,255,0.7)');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);

      // Schnittmarken wie im Plan: der Buchstabe an beiden Enden, die
      // Blickrichtung (Normale) als kurzer Pfeil.
      var n = R.normale(s);
      var pfeil = [n[0] * 10, -n[1] * 10];
      [a, b].forEach(function (p) {
        ctx.fillStyle = aus ? 'rgba(255,255,255,0.35)' : (gewaehlt ? AKZENT : '#fff');
        ctx.font = '600 10px Inter, "Helvetica Neue", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s.name, p[0] - pfeil[0] * 0.9, p[1] - pfeil[1] * 0.9);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + pfeil[0], p[1] + pfeil[1]); ctx.stroke();
      });

      if (gewaehlt && !aus) {
        var g = R.drehgriff(ansicht, s, b2);
        if (g) {
          var heissG = (zug && zug.art === 'drehen') || (!zug && unterMaus && unterMaus.art === 'drehen');
          ctx.beginPath();
          ctx.arc(g[0], g[1], heissG ? 6 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = heissG ? '#fff' : '#101112';
          ctx.fill();
          ctx.strokeStyle = heissG ? '#fff' : AKZENT;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    });
  }

  /**
   * Die Box mit vier Schiebern. Ein Schieber ist eine Lasche in der Mitte
   * jeder Kante — gezogen wird aber die ganze Kante, die Lasche sagt nur,
   * dass man es kann.
   */
  function boxMalen(ctx) {
    if (!Z.box) return;
    var r = boxRechteck();
    var heiss = function (achse, seite) {
      var h = zug || unterMaus;
      if (!h) return false;
      if (h.art === 'kante') return h.achse === achse && h.seite === seite;
      if (h.art === 'ecke') return (achse === 0 && h.x === seite) || (achse === 1 && h.y === seite);
      return false;
    };
    var kanten = [
      { achse: 0, seite: 'min', a: [r.x, r.y], b: [r.x, r.y + r.h] },
      { achse: 0, seite: 'max', a: [r.x + r.b, r.y], b: [r.x + r.b, r.y + r.h] },
      { achse: 1, seite: 'max', a: [r.x, r.y], b: [r.x + r.b, r.y] },
      { achse: 1, seite: 'min', a: [r.x, r.y + r.h], b: [r.x + r.b, r.y + r.h] },
    ];
    kanten.forEach(function (k) {
      var h = heiss(k.achse, k.seite);
      ctx.strokeStyle = h ? '#fff' : AKZENT;
      ctx.lineWidth = h ? 2 : 1.25;
      ctx.beginPath(); ctx.moveTo(k.a[0], k.a[1]); ctx.lineTo(k.b[0], k.b[1]); ctx.stroke();
      var mx = (k.a[0] + k.b[0]) / 2, my = (k.a[1] + k.b[1]) / 2;
      var senk = k.achse === 0;
      var lb = senk ? 6 : 22, lh = senk ? 22 : 6;
      ctx.fillStyle = h ? '#fff' : AKZENT;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(mx - lb / 2, my - lh / 2, lb, lh, 3);
      else ctx.rect(mx - lb / 2, my - lh / 2, lb, lh);
      ctx.fill();
    });
  }

  function stiftMalen(ctx) {
    if (!zug || zug.art !== 'stift' || !zug.ende) return;
    var a = R.zuBild(ansicht, zug.start[0], zug.start[1]);
    var b = R.zuBild(ansicht, zug.ende[0], zug.ende[1]);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
  }

  function nordpfeil(ctx) {
    if (!Z.rahmen) return;
    var psi = R.rad(Z.rahmen.yaw || 0);
    // Norden im Rahmen: ENU (0, 1) um −yaw gedreht → (sin ψ, cos ψ).
    var nx = Math.sin(psi), ny = Math.cos(psi);
    var cx = KARTE_B - 16, cy = 18;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(nx, ny));
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(4, 4); ctx.lineTo(0, 1.5); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
    ctx.font = '600 8px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -11);
    ctx.restore();
  }

  function massstab(ctx) {
    var laenge = R.schoenerSchritt(60 / ansicht.massstab);
    var px = laenge * ansicht.massstab;
    var x = 10, y = KARTE_H - 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 3); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 3);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(laenge).replace('.', ',') + ' m', x + px + 4, y + 1);
  }

  function fortschritt(ctx) {
    var hb = Z.hoehenbild;
    if (!hb || hb.fertig) return;
    ctx.fillStyle = 'rgba(151,191,13,0.9)';
    ctx.fillRect(0, KARTE_H - 2, KARTE_B * hb.anteil, 2);
  }

  // ── Höhenleiste ────────────────────────────────────────────────────────

  var LEISTE_OBEN = 10, LEISTE_UNTEN = 10;

  function leisteY(z) {
    var z0 = Z.szene.min[2], z1 = Z.szene.max[2];
    var t = (z - z0) / Math.max(z1 - z0, 1e-6);
    return KARTE_H - LEISTE_UNTEN - t * (KARTE_H - LEISTE_OBEN - LEISTE_UNTEN);
  }

  function leisteZ(y) {
    var z0 = Z.szene.min[2], z1 = Z.szene.max[2];
    var t = (KARTE_H - LEISTE_UNTEN - y) / (KARTE_H - LEISTE_OBEN - LEISTE_UNTEN);
    return z0 + t * (z1 - z0);
  }

  /**
   * Die Höhe als senkrechte Leiste in derselben Farbrampe wie die Karte.
   * Zwei Schieber (unten, oben) begrenzen die Box; die Geschosse stehen als
   * Marken daneben — ein Klick auf den Namen stellt die Box auf dessen
   * Grundriss.
   */
  function leisteZeichnen() {
    if (!Z.szene || !Z.box) return;
    var c = karte.querySelector('.snk-leiste');
    var ctx = c.getContext('2d');
    var dpr = c.width / LEISTE_B;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, LEISTE_B, KARTE_H);

    var x = 8, b = 10;
    var y0 = leisteY(Z.szene.min[2]), y1 = leisteY(Z.szene.max[2]);
    var verlauf = ctx.createLinearGradient(0, y0, 0, y1);
    for (var i = 0; i <= 8; i++) {
      var f = R.viridis(i / 8);
      verlauf.addColorStop(i / 8, 'rgb(' + f.join(',') + ')');
    }
    ctx.fillStyle = verlauf;
    ctx.fillRect(x, y1, b, y0 - y1);

    var yu = leisteY(Z.box.min[2]), yo = leisteY(Z.box.max[2]);
    ctx.fillStyle = 'rgba(8,9,10,0.72)';
    if (Z.modus === 'aussen') ctx.fillRect(x, yo, b, yu - yo);
    else {
      ctx.fillRect(x, y1, b, yo - y1);
      ctx.fillRect(x, yu, b, y0 - yu);
    }

    // Geschossmarken
    ctx.font = '9px Inter, "Helvetica Neue", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var belegt = [];
    Z.geschosse.forEach(function (g, i) {
      var y = leisteY(g.z);
      if (y < y1 - 1 || y > y0 + 1) return;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 3, Math.round(y) + 0.5); ctx.lineTo(x + b + 3, Math.round(y) + 0.5); ctx.stroke();
      // Zu dicht stehende Namen überspringen, die Marke bleibt.
      if (belegt.some(function (v) { return Math.abs(v - y) < 10; })) return;
      belegt.push(y);
      var heiss = unterMausLeiste && unterMausLeiste.art === 'geschoss' && unterMausLeiste.i === i;
      ctx.fillStyle = heiss ? AKZENT : 'rgba(255,255,255,0.7)';
      var name = g.name.length > 7 ? g.name.slice(0, 6) + '…' : g.name;
      ctx.fillText(name, x + b + 6, y);
    });

    // Schieber
    [['min', yu], ['max', yo]].forEach(function (p) {
      var heiss = (leistenZug && leistenZug.seite === p[0]) ||
        (!leistenZug && unterMausLeiste && unterMausLeiste.art === 'grenze' && unterMausLeiste.seite === p[0]);
      ctx.fillStyle = heiss ? '#fff' : AKZENT;
      ctx.strokeStyle = heiss ? '#fff' : AKZENT;
      ctx.lineWidth = heiss ? 2 : 1.5;
      ctx.beginPath(); ctx.moveTo(x - 4, p[1]); ctx.lineTo(x + b + 4, p[1]); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 4, p[1]); ctx.lineTo(x - 8, p[1] - 4); ctx.lineTo(x - 8, p[1] + 4); ctx.closePath();
      ctx.fill();
    });
  }

  var unterMausLeiste = null;

  function leistenTreffer(y, x) {
    if (!Z.box || !Z.szene) return null;
    var yu = leisteY(Z.box.min[2]), yo = leisteY(Z.box.max[2]);
    var du = Math.abs(y - yu), dO = Math.abs(y - yo);
    if (Math.min(du, dO) <= 6) return { art: 'grenze', seite: du < dO ? 'min' : 'max' };
    if (x > 20) {
      for (var i = 0; i < Z.geschosse.length; i++) {
        if (Math.abs(leisteY(Z.geschosse[i].z) - y) <= 5) return { art: 'geschoss', i: i };
      }
    }
    return { art: 'leiste' };
  }

  function leistenEreignisse(c) {
    function lage(e) {
      var r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }
    c.addEventListener('pointerdown', function (e) {
      var p = lage(e);
      var h = leistenTreffer(p[1], p[0]);
      if (!h) return;
      if (h.art === 'geschoss') { S.geschoss(h.i); return; }
      var seite = h.art === 'grenze' ? h.seite
        : (Math.abs(p[1] - leisteY(Z.box.min[2])) < Math.abs(p[1] - leisteY(Z.box.max[2])) ? 'min' : 'max');
      leistenZug = { seite: seite };
      c.setPointerCapture(e.pointerId);
      S.setGrenze(2, seite, leisteZ(p[1]));
    });
    c.addEventListener('pointermove', function (e) {
      var p = lage(e);
      if (leistenZug) {
        S.setGrenze(2, leistenZug.seite, leisteZ(p[1]));
        return;
      }
      var h = leistenTreffer(p[1], p[0]);
      unterMausLeiste = h;
      c.style.cursor = h && h.art === 'geschoss' ? 'pointer' : 'ns-resize';
      hoverHoehe = leisteZ(p[1]);
      planen();
    });
    c.addEventListener('pointerup', function () { leistenZug = null; planen(); });
    c.addEventListener('pointerleave', function () { unterMausLeiste = null; hoverHoehe = null; planen(); });
  }

  var hoverHoehe = null;

  // ── Zeiger auf der Karte ───────────────────────────────────────────────

  function kartenEreignisse(c) {
    function lage(e) {
      var r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    c.addEventListener('pointerdown', function (e) {
      if (!Z.box || !ansicht) return;
      karte.focus({ preventScroll: true });
      var p = lage(e);
      var w = R.zuWelt(ansicht, p[0], p[1]);
      c.setPointerCapture(e.pointerId);

      if (zeichnet) {
        zug = { art: 'stift', start: w, ende: w, startPx: p };
        return;
      }
      var h = R.treffer(ansicht, p, box2(), Z.scheiben, Z.aktiv);
      if (!h) {
        zug = { art: 'schieben', px: p, cx: ansicht.cx, cy: ansicht.cy };
        c.style.cursor = 'grabbing';
        return;
      }
      if (h.id) S.scheibeWaehlen(h.id);
      var s = h.id ? Z.scheiben.filter(function (x) { return x.id === h.id; })[0] : null;
      zug = Object.assign({}, h, { start: w });
      if (h.art === 'scheibe') zug.d = s.d;
      if (h.art === 'drehen') {
        var mitte = [(Z.box.min[0] + Z.box.max[0]) / 2, (Z.box.min[1] + Z.box.max[1]) / 2];
        zug.drehpunkt = R.aufMittellinie(s, mitte);
        zug.winkel = s.winkel;
        zug.phi = R.grad(Math.atan2(w[1] - zug.drehpunkt[1], w[0] - zug.drehpunkt[0]));
      }
    });

    c.addEventListener('pointermove', function (e) {
      if (!ansicht) return;
      var p = lage(e);
      var w = R.zuWelt(ansicht, p[0], p[1]);
      mausWelt = w;
      if (!zug) {
        unterMaus = zeichnet ? null : (Z.box ? R.treffer(ansicht, p, box2(), Z.scheiben, Z.aktiv) : null);
        c.style.cursor = zeichnet ? 'crosshair' : cursorFuer(unterMaus);
        planen();
        return;
      }
      var fein = e.altKey;   // Alt: ohne Raster
      var raster = fein ? 0 : R.schoenerSchritt(2 / ansicht.massstab) / 2;
      switch (zug.art) {
        case 'schieben':
          ansicht.cx = zug.cx - (p[0] - zug.px[0]) / ansicht.massstab;
          ansicht.cy = zug.cy + (p[1] - zug.px[1]) / ansicht.massstab;
          planen();
          break;
        case 'stift':
          zug.ende = w;
          planen();
          break;
        case 'kante':
          S.setGrenze(zug.achse, zug.seite, R.einrasten(w[zug.achse], raster));
          break;
        case 'ecke':
          S.setGrenze(0, zug.x, R.einrasten(w[0], raster));
          S.setGrenze(1, zug.y, R.einrasten(w[1], raster));
          break;
        case 'scheibenkante': {
          var s = scheibeNach(zug.id);
          if (!s) break;
          var n = R.normale(s);
          var lage2 = R.einrasten(n[0] * w[0] + n[1] * w[1], raster);
          S.scheibeSetzen(s.id, R.scheibenKante(s, zug.seite, lage2));
          break;
        }
        case 'scheibe': {
          var s2 = scheibeNach(zug.id);
          if (!s2) break;
          var n2 = R.normale(s2);
          var weg = n2[0] * (w[0] - zug.start[0]) + n2[1] * (w[1] - zug.start[1]);
          S.scheibeSetzen(s2.id, { d: R.einrasten(zug.d + weg, raster) });
          break;
        }
        case 'drehen': {
          var s3 = scheibeNach(zug.id);
          if (!s3) break;
          var phi = R.grad(Math.atan2(w[1] - zug.drehpunkt[1], w[0] - zug.drehpunkt[0]));
          var winkel = zug.winkel + (phi - zug.phi);
          // Umschalt: auf 15° einrasten — die üblichen Winkel am Bau.
          if (e.shiftKey) winkel = Math.round(winkel / 15) * 15;
          S.scheibeSetzen(s3.id, R.scheibeDrehen(s3, zug.drehpunkt, winkel));
          break;
        }
      }
    });

    c.addEventListener('pointerup', function (e) {
      if (!zug) return;
      if (zug.art === 'stift') {
        var p = lage(e);
        if (Math.hypot(p[0] - zug.startPx[0], p[1] - zug.startPx[1]) > 6) {
          S.scheibeNeu(R.scheibeAusLinie(zug.start, zug.ende, Z.dicke));
        }
        zeichnet = false;
      }
      zug = null;
      c.style.cursor = '';
      stand();
    });

    c.addEventListener('pointerleave', function () {
      if (zug) return;
      unterMaus = null;
      mausWelt = null;
      planen();
    });

    c.addEventListener('wheel', function (e) {
      if (!ansicht) return;
      e.preventDefault();
      var p = lage(e);
      ansicht = R.zoomen(ansicht, p[0], p[1], Math.pow(1.0015, -e.deltaY));
      planen();
    }, { passive: false });

    c.addEventListener('dblclick', function (e) {
      var p = lage(e);
      if (!R.treffer(ansicht, p, box2(), Z.scheiben, Z.aktiv)) passen();
    });
  }

  function scheibeNach(id) {
    return Z.scheiben.filter(function (s) { return s.id === id; })[0] || null;
  }

  function cursorFuer(h) {
    if (!h) return 'grab';
    if (h.art === 'kante') return h.achse === 0 ? 'ew-resize' : 'ns-resize';
    if (h.art === 'ecke') return (h.x === 'min') === (h.y === 'min') ? 'nesw-resize' : 'nwse-resize';
    if (h.art === 'drehen') return 'alias';
    if (h.art === 'scheibenkante') return 'col-resize';
    if (h.art === 'scheibe') return 'move';
    return 'default';
  }

  // ── Anzeigezeile ───────────────────────────────────────────────────────

  var SEITEN = {
    '0min': ['schnitt.west', 'West'], '0max': ['schnitt.ost', 'Ost'],
    '1min': ['schnitt.sued', 'Süd'], '1max': ['schnitt.nord', 'Nord'],
    '2min': ['schnitt.unten', 'unten'], '2max': ['schnitt.oben', 'oben'],
  };

  function seitenName(achse, seite) {
    var s = SEITEN[achse + seite];
    // Gedreht sind Ost/Nord nur noch Näherungen — dann die Achsnamen.
    if (achse < 2 && Z.rahmen && Math.abs(Z.rahmen.yaw) > 0.5) {
      return (achse === 0 ? 'x ' : 'y ') + seite;
    }
    return ue(s[0], s[1]);
  }

  function scheibenText(s) {
    var lage;
    if (Math.abs(s.winkel) < 1e-6) lage = 'x ' + zahl(s.d);
    else if (Math.abs(s.winkel - 90) < 1e-6) lage = 'y ' + zahl(s.d);
    else lage = Math.round(s.winkel) + '° · ' + zahl(s.d);
    return s.name + '–' + s.name + ' · ' + lage + ' m · ' + ue('schnitt.dicke', 'Dicke') + ' ' + meter(s.dicke);
  }

  function hoeheNhn(z) {
    // Absolute Höhe: Ellipsoidhöhe des Rahmenursprungs plus z, minus
    // Geoidundulation. Über die Ausdehnung einer Szene ist die Erdkrümmung
    // dabei ohne Belang (d²/2R: 1 cm auf 350 m).
    if (!Z.rahmen) return null;
    var c = Z.rahmen.carto;
    var h = c.height + z;
    var G = window.ILEEN_GEOID;
    var n = G && G.geladen ? G.getUndulation(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude)) : null;
    return n === null || n === undefined ? { wert: h, bezug: 'ell.' } : { wert: h - n, bezug: 'NHN' };
  }

  function anzeige() {
    var a = el('snkAnzeige');
    if (!a) return;
    var text = '';
    var h = zug || unterMaus;
    if (zeichnet) {
      text = ue('schnitt.stiftHint', 'Linie ziehen — daraus wird eine Scheibe von') + ' ' + meter(Z.dicke);
    } else if (hoverHoehe !== null && !leistenZug) {
      var n = hoeheNhn(hoverHoehe);
      text = 'z ' + zahl(hoverHoehe) + ' m' + (n ? ' · ' + n.wert.toFixed(2).replace('.', ',') + ' m ' + n.bezug : '');
    } else if (leistenZug) {
      var z = Z.box[leistenZug.seite][2];
      var n2 = hoeheNhn(z);
      text = seitenName(2, leistenZug.seite) + ' z ' + zahl(z) + ' m' +
        (n2 ? ' · ' + n2.wert.toFixed(2).replace('.', ',') + ' m ' + n2.bezug : '');
    } else if (h && h.art === 'kante') {
      text = seitenName(h.achse, h.seite) + ' · ' + (h.achse ? 'y ' : 'x ') + zahl(Z.box[h.seite][h.achse]) + ' m';
    } else if (h && h.art === 'ecke') {
      text = 'x ' + zahl(Z.box[h.x][0]) + ' · y ' + zahl(Z.box[h.y][1]) + ' m';
    } else if (h && h.id && scheibeNach(h.id)) {
      text = scheibenText(scheibeNach(h.id));
    } else if (Z.aktiv && scheibeNach(Z.aktiv)) {
      text = scheibenText(scheibeNach(Z.aktiv));
    } else {
      text = 'Box ' + S.boxMasse();
    }
    a.textContent = text;
  }

  // ── Stand der Karte ────────────────────────────────────────────────────

  function stand() {
    if (!Z.an) {
      if (karte) karte.style.display = 'none';
      return;
    }
    kartenBau();
    karte.style.display = '';
    karte.classList.toggle('is-klein', klein);
    karte.classList.toggle('is-stift', zeichnet);
    karte.querySelectorAll('[data-neu="frei"]').forEach(function (b) { b.classList.toggle('is-aktiv', zeichnet); });
    var s = scheibeNach(Z.aktiv);
    var dicke = s ? s.dicke : Z.dicke;
    karte.querySelectorAll('[data-dicke]').forEach(function (b) {
      b.classList.toggle('is-aktiv', Math.abs(parseFloat(b.dataset.dicke) - dicke) < 1e-6);
    });
    planen();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Der Reiter „Schnitte"
  // ═══════════════════════════════════════════════════════════════════════

  function schalter(id, an, handler, label) {
    return '<div class="row">' +
      '<span class="row__label">' + label + '</span>' +
      '<label class="switch"><input type="checkbox" id="' + id + '"' + (an ? ' checked' : '') +
      ' onchange="' + handler + '(this.checked)"><span class="switch__track"></span></label>' +
    '</div>';
  }

  function achsZeile(i, label) {
    return '<div class="snp-achse">' +
      '<span class="snp-achse__name">' + label + '</span>' +
      '<input class="input input--num" type="number" step="0.01" id="snMin' + i + '"' +
        ' onchange="SchnittKarte.grenze(' + i + ',\'min\',this.value)">' +
      '<span class="unit">…</span>' +
      '<input class="input input--num" type="number" step="0.01" id="snMax' + i + '"' +
        ' onchange="SchnittKarte.grenze(' + i + ',\'max\',this.value)">' +
      '<span class="unit">m</span>' +
    '</div>';
  }

  function panelHtml() {
    return '' +
      '<div class="section snp">' +
        '<div class="section__label">' + ue('schnitt.titelPanel', 'Schnitt · Box und Scheiben') + '</div>' +
        '<button class="btn btn--block btn--primary" id="snStart" onclick="BimViewer.Schnitt.umschalten()">' +
          '✂ ' + ue('schnitt.starten', 'Schnitt starten') + '</button>' +
        '<p class="hint">' + ue('schnitt.hint', 'Eine Box über alle geladenen Modelle, dazu beliebig viele ' +
          'Schnittscheiben. Die Schnittkarte oben rechts zeigt die Szene von oben: die Box an ihren Kanten ' +
          'einschieben — von unten gezogen schneidet sie den Süden weg, von oben den Norden —, die Höhe an ' +
          'der Leiste daneben. Scheiben mit X, Y oder ✎ anlegen, an den Kanten dicker ziehen, in der Mitte ' +
          'verschieben, am runden Griff drehen.') + '</p>' +
        '<div class="snp-status" id="snStatus"></div>' +
      '</div>' +

      '<div id="snAktiv">' +
        '<div class="section">' +
          '<div class="section__label">' + ue('schnitt.box', 'Box') +
            ' <span class="snp-masse" id="snMasse"></span></div>' +
          achsZeile(0, 'x') + achsZeile(1, 'y') + achsZeile(2, 'z') +
          '<div class="btn-group snp-knoepfe">' +
            '<button class="btn btn--sm" onclick="BimViewer.Schnitt.ganz()" title="' +
              ue('schnitt.ganzHint', 'Box zurück auf die ganze Szene') + '">▣ ' + ue('schnitt.ganz', 'Ganz') + '</button>' +
            '<button class="btn btn--sm" id="snPick" onclick="BimViewer.Schnitt.auswahlUmschalten()" title="' +
              ue('schnitt.pickHint', 'Ein Bauteil anklicken — ein Meterwürfel legt sich an die Stelle') + '">⌖ ' +
              ue('schnitt.pick', 'Bauteil') + '</button>' +
            '<button class="btn btn--sm" onclick="BimViewer.Schnitt.aufBauteil()" title="' +
              ue('schnitt.aufBauteilHint', 'Box genau um das angeklickte Bauteil legen') + '">' +
              ue('schnitt.aufBauteil', 'Einpassen') + '</button>' +
            '<button class="btn btn--sm" onclick="BimViewer.Schnitt.hinfliegen()" title="' +
              ue('schnitt.hinHint', 'Kamera auf die Box') + '">➜</button>' +
          '</div>' +
          '<div class="btn-group snp-modus">' +
            '<button class="btn btn--sm" id="snInnen" onclick="BimViewer.Schnitt.setModus(\'innen\')" title="' +
              ue('schnitt.innenHint', 'Alles außerhalb von Box und Scheiben verschwindet') + '">▣ ' +
              ue('schnitt.innen', 'Innen behalten') + '</button>' +
            '<button class="btn btn--sm" id="snAussen" onclick="BimViewer.Schnitt.setModus(\'aussen\')" title="' +
              ue('schnitt.aussenHint', 'Genau das Innere verschwindet — der Blick geht an dieser Stelle ins Bauwerk') + '">▢ ' +
              ue('schnitt.aussen', 'Innen weg') + '</button>' +
          '</div>' +
          '<div class="snp-geschosse" id="snGeschosse"></div>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section__label">' + ue('schnitt.scheiben', 'Scheiben') + '</div>' +
          '<div class="snp-liste" id="snListe"></div>' +
          '<div class="btn-group">' +
            '<button class="btn btn--sm" onclick="BimViewer.Schnitt.scheibeNeu(\'x\')">＋ X</button>' +
            '<button class="btn btn--sm" onclick="BimViewer.Schnitt.scheibeNeu(\'y\')">＋ Y</button>' +
            '<button class="btn btn--sm" id="snStift" onclick="SchnittKarte.stift()">✎ ' +
              ue('schnitt.linie', 'Linie') + '</button>' +
          '</div>' +
          '<div class="pill-group snp-dicken" id="snDicken">' +
            '<span class="pill-group__label">' + ue('schnitt.dicke', 'Dicke') + '</span>' +
            DICKEN.map(function (d) {
              return '<button class="pill" data-dicke="' + d + '" onclick="BimViewer.Schnitt.setDicke(' + d + ')">' +
                String(d).replace('.', ',') + ' m</button>';
            }).join('') +
          '</div>' +
          '<p class="hint">' + ue('schnitt.scheibenHint', 'Eine Scheibe ist ein senkrechter Streifen. Sind welche ' +
            'eingeschaltet, bleibt nur stehen, was in der Box UND in mindestens einer Scheibe liegt. ' +
            'Entf löscht die gewählte, ◫ zeichnet sie als Schnitt in den Plan.') + '</p>' +
        '</div>' +

        '<div class="section">' +
          '<div class="section__label">' + ue('schnitt.darstellung', 'Rahmen und Darstellung') + '</div>' +
          '<div class="slider-row">' +
            '<span class="slider-row__label">' + ue('schnitt.drehung', 'Drehung') + '</span>' +
            '<input type="range" class="slider" id="snYaw" min="-90" max="90" step="0.5" value="0"' +
              ' oninput="BimViewer.Schnitt.setYaw(this.value)">' +
            '<span class="slider-row__value" id="snYawWert">0°</span>' +
          '</div>' +
          '<div class="btn-group">' +
            '<button class="btn btn--sm" onclick="BimViewer.Schnitt.nachNorden()">' + ue('schnitt.norden', 'Norden') + '</button>' +
            '<button class="btn btn--sm" onclick="BimViewer.Schnitt.amModellAusrichten()" title="' +
              ue('schnitt.achsenHint', 'Box und Karte an den Achsen des Modells ausrichten') + '">' +
              ue('schnitt.achsen', 'Modellachsen') + '</button>' +
            '<button class="btn btn--sm" onclick="BimViewer.Schnitt.einpassen()" title="' +
              ue('schnitt.einpassenHint', 'Nullpunkt, Ausdehnung und Höhenbild neu aus den geladenen Modellen nehmen') + '">' +
              ue('schnitt.einpassen', 'Neu einpassen') + '</button>' +
          '</div>' +
          schalter('snFlaechen', Z.flaechen, 'BimViewer.Schnitt.setFlaechen',
            ue('schnitt.flaechen', 'Schnittflächen füllen')) +
          schalter('snKante', Z.kante, 'BimViewer.Schnitt.setKante', ue('schnitt.kante', 'Schnittkante zeigen')) +
          schalter('snGriffe', Z.griffe, 'BimViewer.Schnitt.setGriffe', ue('schnitt.griffe', 'Box und Griffe im Bild')) +
          '<p class="hint">' + ue('schnitt.flaechenHint', 'Cesium schließt Schnitte nicht — eine geschnittene Wand ' +
            'ist innen hohl. Durch das Loch sieht man ihre Rückseiten; die werden dunkel und schraffiert ' +
            'gezeichnet, so liest sich der Schnitt wie im Plan. Ohne Füllung schaut man durch das Bauteil ' +
            'hindurch — richtig, um Kanten und doppelte Flächen zu prüfen.') + '</p>' +
        '</div>' +
        detailHtml() +
      '</div>';
  }

  // Zeichnen heißt: der Zeichenmodus (`plan-*.js`) nimmt das Blatt entgegen.
  // In iLEEN-view gibt es ihn nicht — dort stünden sonst Knöpfe, die nur
  // „Der Zeichenmodus ist nicht geladen" melden. Gefragt wird beim Aufbau des
  // Reiters; dann sind alle Skripte gelaufen, auch die nach dieser Datei.
  function zeichnenMoeglich() { return !!BimViewer.Plan2D; }

  function detailHtml() {
    if (!zeichnenMoeglich()) return '';
    return '' +
        '<div class="section">' +
          '<div class="section__label">' + ue('schnitt.detail', 'Als Detail zeichnen') + '</div>' +
          '<div class="slider-row">' +
            '<span class="slider-row__label">' + ue('schnitt.ebene', 'Schnittebene') + '</span>' +
            '<input type="range" class="slider" id="snAnteil" min="0" max="1" step="0.02" value="0.5"' +
              ' oninput="BimViewer.Schnitt.setSchnittanteil(this.value)">' +
            '<span class="slider-row__value" id="snAnteilWert">50 %</span>' +
          '</div>' +
          '<div class="btn-group">' +
            '<button class="btn btn--sm btn--primary" onclick="BimViewer.Schnitt.detail(\'xy\')" title="' +
              ue('schnitt.xyHint', 'Waagerecht — Grundriss') + '">▤ XY</button>' +
            '<button class="btn btn--sm btn--primary" onclick="BimViewer.Schnitt.detail(\'xz\')" title="' +
              ue('schnitt.xzHint', 'Senkrecht, quer zur Box-y-Achse') + '">◫ XZ</button>' +
            '<button class="btn btn--sm btn--primary" onclick="BimViewer.Schnitt.detail(\'yz\')" title="' +
              ue('schnitt.yzHint', 'Senkrecht, quer zur Box-x-Achse') + '">◫ YZ</button>' +
          '</div>' +
          (BimViewer.PlanBauteil
            ? '<button class="btn btn--sm btn--block snp-plansatz" onclick="BimViewer.PlanBauteil.vomAuswahl()"' +
                ' title="' + ue('schnitt.plansatzHint', 'Alle drei Ebenen um das angeklickte Bauteil als Plansatz ins Archiv') + '">📐 ' +
                ue('schnitt.plansatz', 'Bauteil als Plansatz ablegen') + '</button>'
            : '') +
          '<div class="snp-modell" id="snModell"></div>' +
          '<p class="hint">' + ue('schnitt.detailHint', 'Die Boxgrenzen gehen als Ausschnitt ans Backend, der Regler ' +
            'schiebt die Zeichenebene darin von einer Kante zur anderen. Gezeichnet wird immer der Boxinhalt, auch ' +
            'wenn er gerade weggeschnitten ist. Öffnet den Zeichenmodus; beim Schließen geht das Blatt ins Archiv.') + '</p>' +
        '</div>';
  }

  var listenStand = '';
  var geschossStand = '';

  function panelStand() {
    var start = el('snStart');
    if (!start) return;
    start.textContent = Z.an ? '✂ ' + ue('schnitt.beenden', 'Schnitt beenden') : '✂ ' + ue('schnitt.starten', 'Schnitt starten');
    start.classList.toggle('btn--primary', !Z.an);
    var aktiv = el('snAktiv');
    if (aktiv) aktiv.style.display = Z.an ? '' : 'none';

    var status = el('snStatus');
    if (status) {
      status.textContent = Z.meldung.text;
      status.className = 'snp-status' + (Z.meldung.art ? ' snp-status--' + Z.meldung.art : '');
    }
    if (!Z.an || !Z.box) return;

    var masse = el('snMasse');
    if (masse) masse.textContent = S.boxMasse();
    for (var i = 0; i < 3; i++) {
      ['Min', 'Max'].forEach(function (k) {
        var f = el('sn' + k + i);
        if (f && document.activeElement !== f) f.value = Z.box[k.toLowerCase()][i].toFixed(2);
      });
    }
    var pick = el('snPick');
    if (pick) pick.classList.toggle('is-aktiv', Z.waehlt);
    var innen = el('snInnen'), aussen = el('snAussen');
    if (innen) innen.classList.toggle('btn--primary', Z.modus === 'innen');
    if (aussen) aussen.classList.toggle('btn--primary', Z.modus === 'aussen');

    var yaw = el('snYaw');
    var w = Z.rahmen ? Z.rahmen.yaw : 0;
    if (yaw && document.activeElement !== yaw) yaw.value = w;
    var yw = el('snYawWert');
    if (yw) yw.textContent = (Math.round(w * 10) / 10).toString().replace('.', ',') + '°';

    [['snFlaechen', Z.flaechen], ['snKante', Z.kante], ['snGriffe', Z.griffe]].forEach(function (p) {
      var h = el(p[0]);
      if (h) h.checked = p[1];
    });
    var anteil = el('snAnteil');
    if (anteil && document.activeElement !== anteil) anteil.value = Z.schnittanteil;
    var aw = el('snAnteilWert');
    if (aw) aw.textContent = Math.round(Z.schnittanteil * 100) + ' %';
    var stift = el('snStift');
    if (stift) stift.classList.toggle('is-aktiv', zeichnet);

    var s = scheibeNach(Z.aktiv);
    var dicke = s ? s.dicke : Z.dicke;
    document.querySelectorAll('#snDicken [data-dicke]').forEach(function (b) {
      b.classList.toggle('is-active', Math.abs(parseFloat(b.dataset.dicke) - dicke) < 1e-6);
    });

    var modell = el('snModell');
    if (modell) {
      var m = S.zeichenModell();
      modell.textContent = m ? ue('schnitt.zeichnetAus', 'Zeichnet aus') + ': ' + (m.name || m.jobId) +
        (Z.quelle ? ' · ' + S.bauteilText(Z.quelle.ifcType, Z.quelle.name) : '')
        : ue('schnitt.keinBackendModell', 'Kein Modell aus dem eigenen Backend geladen — Zeichnen geht nur mit IFC-Quelle.');
    }

    listeZeichnen();
    geschosseZeichnen();
  }

  function listeZeichnen() {
    var liste = el('snListe');
    if (!liste) return;
    var neu = JSON.stringify([Z.aktiv, Z.scheiben]);
    if (neu === listenStand && liste.childElementCount === Z.scheiben.length) return;
    listenStand = neu;
    if (!Z.scheiben.length) {
      liste.innerHTML = '<div class="snp-leer">' + ue('schnitt.keineScheibe', 'Noch keine Scheibe — ohne Scheiben zählt die Box allein.') + '</div>';
      return;
    }
    liste.innerHTML = Z.scheiben.map(function (s) {
      return '<div class="snp-scheibe' + (s.id === Z.aktiv ? ' is-aktiv' : '') + (s.an === false ? ' is-aus' : '') +
        '" onclick="BimViewer.Schnitt.scheibeWaehlen(' + s.id + ')">' +
        '<input type="checkbox"' + (s.an !== false ? ' checked' : '') +
          ' onclick="event.stopPropagation()" onchange="BimViewer.Schnitt.scheibeSetzen(' + s.id + ',{an:this.checked})">' +
        '<span class="snp-scheibe__text">' + scheibenText(s) + '</span>' +
        (zeichnenMoeglich()
          ? '<button class="btn btn--sm btn--icon" title="' + ue('schnitt.zeichnen', 'Als Schnitt in den Plan') + '"' +
              ' onclick="event.stopPropagation();BimViewer.Schnitt.scheibeZeichnen(' + s.id + ')">◫</button>'
          : '') +
        '<button class="btn btn--sm btn--icon" title="' + ue('schnitt.loeschen', 'Scheibe löschen') + '"' +
          ' onclick="event.stopPropagation();BimViewer.Schnitt.scheibeWeg(' + s.id + ')">✕</button>' +
      '</div>';
    }).join('');
  }

  function geschosseZeichnen() {
    var g = el('snGeschosse');
    if (!g) return;
    var neu = JSON.stringify(Z.geschosse);
    if (neu === geschossStand && (g.childElementCount > 0) === (Z.geschosse.length > 0)) return;
    geschossStand = neu;
    if (!Z.geschosse.length) { g.innerHTML = ''; return; }
    g.innerHTML = '<div class="pill-group">' +
      '<span class="pill-group__label">' + ue('schnitt.grundriss', 'Grundriss') + '</span>' +
      Z.geschosse.map(function (x, i) {
        return '<button class="pill" title="' + ue('schnitt.geschossHint', 'Box auf dieses Geschoss: von unter der Rohdecke bis 1,20 m darüber') +
          '" onclick="BimViewer.Schnitt.geschoss(' + i + ')">' + x.name + '</button>';
      }).join('') +
    '</div>';
  }

  // ── Einhängen ──────────────────────────────────────────────────────────
  //
  // Der Reiter „Schnitte" gehört ui.js, sein Inhalt wird hier davorgesetzt —
  // derselbe Weg wie vorher bei `schnitte-xyz.js`; die Google-Freistellung
  // aus `ui-new-features-extension.js` bleibt dahinter stehen.

  if (typeof BimViewerUI !== 'undefined' && BimViewerUI.getDrawingContent) {
    var urspruenglich = BimViewerUI.getDrawingContent.bind(BimViewerUI);
    BimViewerUI.getDrawingContent = function () {
      listenStand = '';
      geschossStand = '';
      setTimeout(panelStand, 0);
      return panelHtml() + urspruenglich();
    };
  }

  document.addEventListener('ileen:language-changed', function () {
    listenStand = '';
    geschossStand = '';
    if (karte) { karte.remove(); karte = null; }
    setTimeout(function () { panelStand(); stand(); }, 0);
  });

  window.addEventListener('resize', function () {
    if (!karte) return;
    var r = karte.getBoundingClientRect();
    if (r.left > window.innerWidth - 80) { karte.style.left = ''; karte.style.right = ''; }
  });

  S.beobachten(function (was) {
    if (was === 'einpassen' || was === 'drehung') ansicht = null;
    if (was === 'hoehenbild') hbStand = -1;
    if (was === 'aus') { zeichnet = false; zug = null; }
    stand();
    panelStand();
  });

  window.SchnittKarte = {
    grenze: function (i, seite, wert) { S.setGrenze(i, seite, parseFloat(wert)); },
    stift: function () {
      if (!Z.an && !S.starten()) return;
      zeichnet = !zeichnet;
      stand();
      panelStand();
    },
    passen: passen,
    get ansicht() { return ansicht; },
    zeichnen: zeichnen,
    panelHtml: panelHtml,
  };
})();
