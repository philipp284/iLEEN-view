/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 */

// ===============================
// PRAESENTATION-TEXT — der Folientext: Markdown-Dialekt, HTML und Canvas
//
// Eine Folie trägt einen Text, der über dem Bild steht. Er entsteht in zwei
// Gestalten, und beide müssen gleich aussehen:
//
//   · als DOM-Element über der Szene (Live-Ansicht, Show) — `html()`
//   · als gezeichneter Canvas im Video — `zeichnen()`
//
// Der Video-Export nimmt nur den Canvas der Szene auf, nicht die Seite; ein
// DOM-Label darüber käme nie ins Bild. Deshalb gibt es zwei Zeichenwege, die
// dieselben Maße benutzen (Schriftgröße als Anteil der Bildhöhe, Polster,
// Radius, Überschriftenstufen). praesentation.css spiegelt sie als em-Werte.
//
// Der Dialekt und beide Zeichenwege sind aus splides übernommen
// (~/Projekte/splides/src/caption.ts) — dasselbe Projekt, dieselbe Hand, und
// derselbe Text soll in beiden Werkzeugen gleich gesetzt aussehen.
//
// Dialekt:  **fett**  *kursiv*  ~~durchgestrichen~~  ++unterstrichen++
//           ==markiert==  ^hoch^  ~tief~  ((Plakette))  `Code`
//           [Text]{sky} [Text]{#ff8800}  [Text](https://…)  \* maskiert
//           # … ###### Überschriften   - Liste   1. Liste   - [x] Aufgabe
//           > Zitat   --- Linie   -# Kleingedrucktes   ::: center | left | right
//
// Der Text kommt aus einem Textfeld und landet im DOM: alles wird maskiert,
// Farben sind auf Hex und eine Palette beschränkt, Links sind nur Schmuck und
// navigieren nie.
// ===============================
'use strict';

(function () {

  var ACCENT = '#8dd7ff';

  var STIL_VORGABE = {
    align: 'center',
    theme: 'glass',
    scale: 1,
    width: 0.62,
    accent: ACCENT,
    anim: 'fade',
  };

  var AUSRICHTUNGEN = ['left', 'center', 'right'];
  var THEMEN = ['glass', 'solid', 'outline', 'bar', 'plain'];
  var ANIMATIONEN = ['fade', 'up', 'down', 'left', 'right', 'zoom'];

  // Gemeinsame Maße — praesentation.css führt sie als em-Werte mit.
  var SCHRIFT_ANTEIL = 0.03;        // Grundschrift als Anteil der Bildhöhe
  var ZEILE = 1.35;
  var POLSTER_X = 0.9;              // in em der Grundschrift
  var POLSTER_Y = 0.55;
  var RADIUS = 0.55;
  var EINZUG = 1.25;                // je Listenebene, in em
  var UEBERSCHRIFT = [1, 1.75, 1.45, 1.25, 1.12, 1.0, 0.92];
  var GEWICHT_TEXT = 500;
  var GEWICHT_FETT = 800;
  var GEWICHT_UEBERSCHRIFT = [GEWICHT_TEXT, 800, 750, 700, 700, 700, 700];
  var KLEIN = 0.78;
  var HOCH_TIEF = 0.72;
  var ZITAT_ABSTAND = 0.5;          // em zwischen Balken und Zitat
  var ZITAT_BALKEN = 0.13;

  var GEDAEMPFT = 'rgba(255, 255, 255, 0.62)';
  var CODE_FARBE = '#a5f3fc';

  var FARBEN = {
    red: '#f87171', orange: '#fb923c', amber: '#fbbf24', yellow: '#fde047',
    lime: '#a3e635', green: '#4ade80', teal: '#2dd4bf', cyan: '#22d3ee',
    sky: '#38bdf8', blue: '#60a5fa', indigo: '#818cf8', violet: '#a78bfa',
    purple: '#c084fc', pink: '#f472b6', rose: '#fb7185', white: '#ffffff',
    black: '#0b0e13', gray: '#9ca3af', grey: '#9ca3af', accent: ACCENT,
    muted: '#94a3b8',
  };

  var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  function klemmen(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** Ein geladener oder handbearbeiteter Stil: jedes Feld wird geprüft. */
  function stilNormalisieren(roh) {
    roh = roh || {};
    return {
      align: AUSRICHTUNGEN.indexOf(roh.align) >= 0 ? roh.align : STIL_VORGABE.align,
      theme: THEMEN.indexOf(roh.theme) >= 0 ? roh.theme : STIL_VORGABE.theme,
      scale: klemmen(Number(roh.scale) || STIL_VORGABE.scale, 0.5, 2.5),
      width: klemmen(Number(roh.width) || STIL_VORGABE.width, 0.2, 0.96),
      accent: (typeof roh.accent === 'string' && HEX.test(roh.accent)) ? roh.accent : STIL_VORGABE.accent,
      anim: ANIMATIONEN.indexOf(roh.anim) >= 0 ? roh.anim : STIL_VORGABE.anim,
    };
  }

  function farbeAufloesen(roh) {
    var wert = String(roh).trim().toLowerCase();
    if (HEX.test(wert)) return wert;
    return FARBEN[wert] || null;
  }

  /** `#rgb`/`#rgba` auffächern und mit Alpha versehen — für Markierung und Plakette. */
  function mitAlpha(farbe, alpha) {
    var hex = String(farbe).trim();
    if (!HEX.test(hex)) return farbe;
    var k = hex.slice(1);
    if (k.length === 3 || k.length === 4) k = k.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(k.slice(0, 2), 16);
    var g = parseInt(k.slice(2, 4), 16);
    var b = parseInt(k.slice(4, 6), 16);
    var a = k.length === 8 ? parseInt(k.slice(6, 8), 16) / 255 : 1;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + (a * alpha).toFixed(3) + ')';
  }

  // ── Zeichen im Text ────────────────────────────────────────────────────────

  var BASIS = {
    bold: false, italic: false, strike: false, underline: false, mark: false,
    badge: false, sup: false, sub: false, color: null, href: null,
  };

  function sichereVerknuepfung(roh) {
    var wert = String(roh).trim();
    if (!wert) return null;
    return /^(https?:|mailto:|tel:|\/|#|\.)/i.test(wert) ? wert : null;
  }

  /** `[Text](url)` oder `[Text]{farbe}` ab der '[' bei `start`; sonst bleibt '[' wörtlich. */
  function klammer(text, start) {
    var tiefe = 0, ende = -1;
    for (var j = start; j < text.length; j++) {
      var c = text[j];
      if (c === '\\') { j += 1; continue; }
      if (c === '[') tiefe += 1;
      else if (c === ']') {
        tiefe -= 1;
        if (tiefe === 0) { ende = j; break; }
      }
    }
    if (ende === -1) return null;
    var label = text.slice(start + 1, ende);
    var danach = text[ende + 1];
    if (danach === '(') {
      var zu = text.indexOf(')', ende + 2);
      if (zu === -1) return null;
      var href = sichereVerknuepfung(text.slice(ende + 2, zu));
      return href ? { label: label, color: null, href: href, next: zu + 1 } : null;
    }
    if (danach === '{') {
      var zu2 = text.indexOf('}', ende + 2);
      if (zu2 === -1) return null;
      var farbe = farbeAufloesen(text.slice(ende + 2, zu2));
      return farbe ? { label: label, color: farbe, href: null, next: zu2 + 1 } : null;
    }
    return null;
  }

  function istLeer(c) { return c === undefined || /\s/.test(c); }
  function istWortzeichen(c) { return c !== undefined && /[\p{L}\p{N}]/u.test(c); }

  /**
   * Ein Begrenzer öffnet nur, wenn später in derselben Zeile ein Gegenstück
   * folgt. Ohne die Prüfung kippte ein einzelnes `*`, `_`, `~` oder `^` den
   * Rest des Labels in Kursiv oder Tiefstellung — der häufigste Grund, warum
   * „Markdown nicht ging".
   */
  function hatSchluss(text, von, begrenzer) {
    for (var j = von; j < text.length; j++) {
      if (text[j] === '\\') { j += 1; continue; }
      if (text.indexOf(begrenzer, j) === j && !istLeer(text[j - 1])) return true;
    }
    return false;
  }

  function lauf(text, code, s) {
    return {
      text: text, bold: s.bold, italic: s.italic, strike: s.strike, code: code,
      underline: s.underline, mark: s.mark, badge: s.badge, sup: s.sup, sub: s.sub,
      color: s.color, href: s.href,
    };
  }

  function inlineParsen(text, ctx) {
    ctx = ctx || BASIS;
    var laeufe = [];
    var s = {
      bold: ctx.bold, italic: ctx.italic, strike: ctx.strike, underline: ctx.underline,
      mark: ctx.mark, badge: ctx.badge, sup: ctx.sup, sub: ctx.sub,
      color: ctx.color, href: ctx.href,
    };
    var puffer = '';
    var i = 0;

    function leeren() {
      if (puffer) { laeufe.push(lauf(puffer, false, s)); puffer = ''; }
    }
    function kopie(ueber) {
      var k = {};
      for (var n in s) k[n] = s[n];
      for (var m in ueber) k[m] = ueber[m];
      return k;
    }

    // Gemeinsame Öffnen/Schließen-Entscheidung aller Umschalt-Begrenzer.
    function schaltet(aktiv, begrenzer, wortgrenze) {
      var vor = text[i - 1];
      var nach = text[i + begrenzer.length];
      if (aktiv) {
        // Schließen: nicht hinter Leerraum; bei _ / __ nicht im Wort (snake_case bleibt heil).
        if (istLeer(vor)) return false;
        return !wortgrenze || !istWortzeichen(nach);
      }
      if (istLeer(nach)) return false;
      if (wortgrenze && istWortzeichen(vor)) return false;
      return hatSchluss(text, i + begrenzer.length, begrenzer);
    }

    while (i < text.length) {
      var ch = text[i];

      if (ch === '\\' && i + 1 < text.length) { puffer += text[i + 1]; i += 2; continue; }

      if (ch === '`') {
        var e = text.indexOf('`', i + 1);
        if (e === -1) { puffer += '`'; i += 1; continue; }
        leeren();
        laeufe.push(lauf(text.slice(i + 1, e), true, s));
        i = e + 1;
        continue;
      }

      if (ch === '(' && text.indexOf('((', i) === i) {
        var e2 = text.indexOf('))', i + 2);
        if (e2 !== -1) {
          leeren();
          laeufe.push.apply(laeufe, inlineParsen(text.slice(i + 2, e2), kopie({ badge: true })));
          i = e2 + 2;
          continue;
        }
      }

      if (ch === '[') {
        var kl = klammer(text, i);
        if (kl) {
          leeren();
          laeufe.push.apply(laeufe, inlineParsen(kl.label, kopie({
            color: kl.color || s.color, href: kl.href || s.href,
          })));
          i = kl.next;
          continue;
        }
      }

      var zwei = text.slice(i, i + 2);
      if ((zwei === '**' || zwei === '__') && schaltet(s.bold, zwei, zwei === '__')) {
        leeren(); s.bold = !s.bold; i += 2; continue;
      }
      if (zwei === '~~' && schaltet(s.strike, zwei, false)) {
        leeren(); s.strike = !s.strike; i += 2; continue;
      }
      if (zwei === '==' && schaltet(s.mark, zwei, false)) {
        leeren(); s.mark = !s.mark; i += 2; continue;
      }
      if (zwei === '++' && schaltet(s.underline, zwei, false)) {
        leeren(); s.underline = !s.underline; i += 2; continue;
      }
      if ((ch === '*' || ch === '_') && zwei !== '**' && zwei !== '__' && schaltet(s.italic, ch, ch === '_')) {
        leeren(); s.italic = !s.italic; i += 1; continue;
      }
      if (ch === '~' && schaltet(s.sub, ch, false)) {
        leeren(); s.sub = !s.sub; i += 1; continue;
      }
      if (ch === '^' && schaltet(s.sup, ch, false)) {
        leeren(); s.sup = !s.sup; i += 1; continue;
      }

      puffer += ch;
      i += 1;
    }

    leeren();
    return laeufe;
  }

  // ── Blöcke ─────────────────────────────────────────────────────────────────

  var LINIE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  var AUSRICHTUNG = /^\s*:::\s*(left|center|centre|right)\s*$/i;
  var UEBERSCHRIFT_RE = /^(#{1,6})\s+(.*)$/;
  var KLEIN_RE = /^\s*-#\s+(.*)$/;
  var ZITAT = /^(\s*)>\s?(.*)$/;
  var AUFGABE = /^(\s*)[-*+]\s+\[([ xX])\]\s*(.*)$/;
  var NUMMER = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
  var PUNKT = /^(\s*)[-*+•]\s+(.*)$/;

  /** Zwei Leerzeichen (oder ein Tab) je Ebene, bei drei gedeckelt. */
  function einzugVon(vorn) {
    return Math.min(3, Math.floor(vorn.replace(/\t/g, '  ').length / 2));
  }

  function leereZeile(align) {
    return { level: 0, kind: 'text', marker: '', indent: 0, align: align,
             checked: false, small: false, runs: [] };
  }

  function mit(basis, felder) {
    var z = {};
    for (var k in basis) z[k] = basis[k];
    for (var f in felder) z[f] = felder[f];
    return z;
  }

  function zeileParsen(roh, align) {
    var b = leereZeile(align);
    var m;
    if (LINIE.test(roh)) return mit(b, { kind: 'rule' });
    if ((m = UEBERSCHRIFT_RE.exec(roh))) return mit(b, { level: m[1].length, runs: inlineParsen(m[2]) });
    if ((m = KLEIN_RE.exec(roh))) return mit(b, { small: true, runs: inlineParsen(m[1]) });
    if ((m = ZITAT.exec(roh))) return mit(b, { kind: 'quote', indent: einzugVon(m[1]), runs: inlineParsen(m[2]) });
    if ((m = AUFGABE.exec(roh))) {
      return mit(b, { kind: 'todo', indent: einzugVon(m[1]),
                      checked: m[2].toLowerCase() === 'x', runs: inlineParsen(m[3]) });
    }
    if ((m = NUMMER.exec(roh))) {
      return mit(b, { kind: 'ordered', indent: einzugVon(m[1]), marker: m[2] + '.', runs: inlineParsen(m[3]) });
    }
    if ((m = PUNKT.exec(roh))) return mit(b, { kind: 'bullet', indent: einzugVon(m[1]), runs: inlineParsen(m[2]) });
    return mit(b, { runs: inlineParsen(roh) });
  }

  /**
   * `::: center` (und left/right) schaltet die Ausrichtung für die folgenden
   * Zeilen um — so kann ein Label einen zentrierten Titel über einer linken
   * Liste führen.
   */
  function markdownParsen(text) {
    var aus = [];
    var align = null;
    String(text == null ? '' : text).split('\n').forEach(function (roh) {
      var d = AUSRICHTUNG.exec(roh);
      if (d) {
        var w = d[1].toLowerCase();
        align = w === 'centre' ? 'center' : w;
        return;
      }
      aus.push(zeileParsen(roh, align));
    });
    return aus;
  }

  function nurLeer(zeilen) {
    return zeilen.every(function (z) {
      return z.kind === 'text' && z.runs.every(function (r) { return !r.text.trim(); });
    });
  }

  /** Erste nichtleere Zeile als Klartext — Titel in der Folienliste. */
  function titel(text) {
    var zeilen = markdownParsen(text);
    for (var i = 0; i < zeilen.length; i++) {
      var klar = zeilen[i].runs.map(function (r) { return r.text; }).join('').trim();
      if (klar) return klar;
      if (zeilen[i].kind === 'rule') return '───';
    }
    return '';
  }

  // ── HTML (Live-Ansicht) ────────────────────────────────────────────────────

  function esc(w) {
    return String(w).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function laufHtml(r) {
    var h = esc(r.text);
    if (r.code) {
      h = '<code>' + h + '</code>';
    } else {
      if (r.sub) h = '<sub>' + h + '</sub>';
      if (r.sup) h = '<sup>' + h + '</sup>';
      if (r.strike) h = '<del>' + h + '</del>';
      if (r.underline) h = '<u>' + h + '</u>';
      if (r.mark) {
        // Eine ausdrückliche Farbe tönt die Markierung selbst, nicht nur die Glyphen.
        var bg = r.color ? ' style="background:' + mitAlpha(r.color, 0.3) + '"' : '';
        h = '<mark class="pmd-mark"' + bg + '>' + h + '</mark>';
      }
      if (r.italic) h = '<em>' + h + '</em>';
      if (r.bold) h = '<strong>' + h + '</strong>';
    }
    // Die Farbe ist geprüft (Hex oder Palette) und darf deshalb ins Attribut.
    if (r.color && !r.mark) h = '<span style="color:' + r.color + '">' + h + '</span>';
    if (r.badge) {
      var bg2 = r.color
        ? ' style="background:' + mitAlpha(r.color, 0.22) + ';border-color:' + mitAlpha(r.color, 0.5) + '"'
        : '';
      h = '<span class="pmd-badge"' + bg2 + '>' + h + '</span>';
    }
    if (r.href) h = '<span class="pmd-link" title="' + esc(r.href) + '">' + h + '</span>';
    return h;
  }

  function html(text) {
    return markdownParsen(text).map(function (z) {
      var klassen = ['pmd-line'];
      if (z.align) klassen.push('pmd-al-' + z.align);
      var einzug = z.indent ? ' style="padding-inline-start:' + (z.indent * EINZUG) + 'em"' : '';

      if (z.kind === 'rule') {
        klassen.push('pmd-rule-line');
        return '<div class="' + klassen.join(' ') + '"' + einzug + '><span class="pmd-rule"></span></div>';
      }

      var innen = z.runs.map(laufHtml).join('') || '&nbsp;';
      if (z.level) klassen.push('pmd-h' + z.level);
      if (z.small) klassen.push('pmd-small');
      if (z.kind === 'quote') klassen.push('pmd-quote');
      if (z.kind === 'bullet' || z.kind === 'ordered' || z.kind === 'todo') klassen.push('pmd-li');

      var vor = '';
      if (z.kind === 'bullet') vor = '<span class="pmd-marker">' + (z.indent % 2 ? '◦' : '•') + '</span>';
      if (z.kind === 'ordered') vor = '<span class="pmd-marker">' + esc(z.marker) + '</span>';
      if (z.kind === 'todo') {
        vor = '<span class="pmd-marker pmd-check' + (z.checked ? ' is-checked' : '') + '">' +
              (z.checked ? '☑' : '☐') + '</span>';
      }
      return '<div class="' + klassen.join(' ') + '"' + einzug + '>' + vor + innen + '</div>';
    }).join('');
  }

  /** Klassen und Variablen, die einen Stil auf das Overlay tragen. */
  function stilAnwenden(knoten, stil) {
    knoten.className = 'praes-label is-theme-' + stil.theme + ' is-align-' + stil.align;
    knoten.style.setProperty('--cap-scale', String(stil.scale));
    knoten.style.setProperty('--cap-width', String(stil.width));
    knoten.style.setProperty('--cap-accent', stil.accent);
    knoten.style.setProperty('--cap-accent-soft', mitAlpha(stil.accent, 0.28));
    knoten.style.setProperty('--cap-accent-line', mitAlpha(stil.accent, 0.55));
  }

  /**
   * Versatz der Einblendung, gemeinsam für Overlay und Video, damit beide sich
   * gleich bewegen. t = 1 heißt vollständig da.
   */
  function animVersatz(anim, t) {
    var k = 1 - klemmen(t, 0, 1);
    switch (anim) {
      case 'up':    return { dx: 0, dy: k * 0.06, scale: 1 };
      case 'down':  return { dx: 0, dy: -k * 0.06, scale: 1 };
      case 'left':  return { dx: k * 0.06, dy: 0, scale: 1 };
      case 'right': return { dx: -k * 0.06, dy: 0, scale: 1 };
      case 'zoom':  return { dx: 0, dy: 0, scale: 1 - k * 0.14 };
      default:      return { dx: 0, dy: 0, scale: 1 };
    }
  }

  // ── Canvas (Video) ─────────────────────────────────────────────────────────

  function schrift(groesse, gewicht, kursiv, code) {
    var familie = code
      ? 'ui-monospace, "SFMono-Regular", Menlo, monospace'
      : 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
    return (kursiv ? 'italic ' : '') + gewicht + ' ' + groesse + 'px ' + familie;
  }

  function schritt(t) { return t.padLeft + t.width + t.padRight; }

  function marke(ctx, text, stil, leer, basis) {
    var groesse = (stil.sup || stil.sub) ? basis * HOCH_TIEF : basis;
    ctx.font = schrift(groesse, stil.weight, stil.italic, stil.code);
    var t = { text: text, space: leer, size: groesse, baseSize: basis,
              width: ctx.measureText(text).width, padLeft: 0, padRight: 0, x: 0 };
    for (var k in stil) t[k] = stil[k];
    return t;
  }

  var MARKER_STIL = {
    weight: GEWICHT_TEXT, italic: false, strike: false, code: false, underline: false,
    mark: false, badge: false, sup: false, sub: false, color: GEDAEMPFT, alpha: 1,
  };

  function mitFarbe(basis, farbe) {
    var s = {};
    for (var k in basis) s[k] = basis[k];
    s.color = farbe;
    return s;
  }

  /** Legt die Markdown-Zeilen als umbrochene Sichtzeilen aus, die in `maxBreite` passen. */
  function auslegen(ctx, zeilen, basis, maxBreite, stil) {
    var aus = [];

    zeilen.forEach(function (z) {
      var align = z.align || stil.align;
      var einzugPx = z.indent * EINZUG * basis;

      if (z.kind === 'rule') {
        aus.push({ tokens: [], width: maxBreite * 0.5, height: basis * ZEILE,
                   kind: 'rule', align: align, indent: einzugPx });
        return;
      }

      var faktor = z.small ? KLEIN : (UEBERSCHRIFT[z.level] || 1);
      var groesse = basis * faktor;
      var hoehe = groesse * ZEILE;
      var gewichtZeile = GEWICHT_UEBERSCHRIFT[z.level] || GEWICHT_TEXT;
      var zitatFarbe = z.kind === 'quote' ? GEDAEMPFT : null;

      var tokens = [];
      if (z.kind === 'bullet') tokens.push(marke(ctx, (z.indent % 2 ? '◦' : '•') + '  ', MARKER_STIL, false, groesse));
      if (z.kind === 'ordered') tokens.push(marke(ctx, z.marker + '  ', MARKER_STIL, false, groesse));
      if (z.kind === 'todo') {
        tokens.push(marke(ctx, (z.checked ? '☑' : '☐') + '  ',
          mitFarbe(MARKER_STIL, z.checked ? stil.accent : GEDAEMPFT), false, groesse));
      }

      z.runs.forEach(function (r) {
        var ts = {
          weight: r.bold ? Math.max(GEWICHT_FETT, gewichtZeile) : gewichtZeile,
          italic: r.italic || z.kind === 'quote',
          strike: r.strike, code: r.code,
          underline: r.underline || Boolean(r.href),
          mark: r.mark, badge: r.badge, sup: r.sup, sub: r.sub,
          color: r.color || (r.href ? stil.accent : zitatFarbe),
          alpha: z.small ? 0.75 : 1,
        };
        var gemacht = [];
        if (r.badge) {
          // Plaketten bleiben ganz und werden nie an Leerzeichen getrennt.
          if (r.text) gemacht.push(marke(ctx, r.text, ts, false, groesse));
        } else {
          r.text.split(/(\s+)/).forEach(function (teil) {
            if (teil === '') return;
            var leer = /^\s+$/.test(teil);
            gemacht.push(marke(ctx, leer ? ' ' : teil, ts, leer, groesse));
          });
        }
        // Plaketten und Markierungen schieben den Text weg wie ihr CSS-Polster —
        // nur an den Rändern des Laufs, nicht zwischen seinen Wörtern.
        var polster = r.badge ? groesse * 0.42 : r.mark ? groesse * 0.16 : r.code ? groesse * 0.22 : 0;
        if (polster && gemacht.length) {
          gemacht[0].padLeft = polster;
          gemacht[gemacht.length - 1].padRight = polster;
        }
        tokens.push.apply(tokens, gemacht);
      });

      if (tokens.length === 0) {
        aus.push({ tokens: [], width: 0, height: hoehe, kind: z.kind, align: align, indent: einzugPx });
        return;
      }

      var frei = Math.max(basis * 4, maxBreite - einzugPx);
      var aktuell = [];
      var aktuellBreite = 0;

      function abschliessen() {
        while (aktuell.length && aktuell[0].space) { aktuellBreite -= schritt(aktuell[0]); aktuell.shift(); }
        while (aktuell.length && aktuell[aktuell.length - 1].space) {
          aktuellBreite -= schritt(aktuell[aktuell.length - 1]); aktuell.pop();
        }
        aus.push({ tokens: aktuell, width: aktuellBreite, height: hoehe, kind: z.kind,
                   align: align, indent: einzugPx });
      }

      tokens.forEach(function (t) {
        var hatWort = aktuell.some(function (x) { return !x.space; });
        if (!t.space && hatWort && aktuellBreite + schritt(t) > frei) {
          abschliessen();
          aktuell = [];
          aktuellBreite = 0;
        }
        if (t.space && aktuell.length === 0) return;   // kein Leerraum am Zeilenanfang
        aktuell.push(t);
        aktuellBreite += schritt(t);
      });
      if (aktuell.length) abschliessen();
    });

    return aus;
  }

  function rundesRechteck(ctx, x, y, w, h, r) {
    var rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function grundlinie(t, y) {
    if (t.sup) return y - t.baseSize * 0.16;
    if (t.sub) return y + t.baseSize * 0.3;
    return y;
  }

  /**
   * Benachbarte Token mit derselben Auszeichnung werden als EIN Lauf gezeichnet.
   * Sonst zeigten halbtransparente Markierungen Nähte, wo sich die Füllungen
   * der einzelnen Wörter überlappen.
   */
  function abschnitte(tokens, pruefen) {
    var aus = [];
    var start = -1;
    for (var i = 0; i < tokens.length; i++) {
      var an = pruefen(tokens[i]);
      if (an && start === -1) start = i;
      var ende = !an || i === tokens.length - 1;
      if (start !== -1 && ende) {
        var letzter = an ? i : i - 1;
        var e = letzter;
        while (e > start && tokens[e].space) e -= 1;   // nie über das Zeilenende hinaus
        aus.push({
          from: tokens[start].x - tokens[start].padLeft,
          to: tokens[e].x + tokens[e].width + tokens[e].padRight,
          token: tokens[start],
        });
        start = -1;
      }
    }
    return aus;
  }

  function linienZeichnen(ctx, teile, y, versatz) {
    teile.forEach(function (seg) {
      var t = seg.token;
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.globalAlpha *= t.alpha;
      // Unterstrich und Durchstreichung erben die Glyphenfarbe, wie im CSS.
      ctx.strokeStyle = t.color || (t.code ? CODE_FARBE : '#ffffff');
      ctx.lineWidth = Math.max(1, t.size * 0.06);
      var ly = grundlinie(t, y) + t.size * versatz;
      ctx.beginPath();
      ctx.moveTo(seg.from, ly);
      ctx.lineTo(seg.to, ly);
      ctx.stroke();
      ctx.restore();
    });
  }

  /**
   * Ein Label in den Canvas zeichnen, verankert an `pos` — mit denselben Maßen,
   * Themen und Einblendbewegungen wie das Overlay.
   * `opt`: { text, opacity, width, height, pos:{x,y}, style }
   */
  function zeichnen(ctx, quelle, opt) {
    var text = opt.text, deckkraft = opt.opacity, breite = opt.width, hoehe = opt.height;
    var pos = opt.pos, stil = opt.style;
    if (deckkraft <= 0.01) return;
    var zeilen = markdownParsen(text);
    if (nurLeer(zeilen)) return;

    var basis = Math.max(10, hoehe * SCHRIFT_ANTEIL * stil.scale);
    var schlicht = stil.theme === 'plain';
    var balken = stil.theme === 'bar';
    var padX = schlicht ? 0 : basis * POLSTER_X;
    var padY = schlicht ? 0 : basis * POLSTER_Y;
    var balkenBreite = balken ? basis * 0.16 : 0;
    var balkenLuecke = balken ? basis * 0.55 : 0;

    var maxBreite = Math.max(basis * 6, breite * stil.width);
    var sicht = auslegen(ctx, zeilen, basis, maxBreite, stil);

    var inhaltB = Math.max.apply(null, [1].concat(sicht.map(function (v) { return v.width + v.indent; })));
    var inhaltH = sicht.reduce(function (s, v) { return s + v.height; }, 0);
    var boxB = Math.min(breite * 0.96, inhaltB + padX * 2 + balkenBreite + balkenLuecke);
    var boxH = inhaltH + padY * 2;

    var anim = animVersatz(stil.anim, deckkraft);
    var cx = klemmen(pos.x * breite + anim.dx * breite, boxB / 2 + 8, breite - boxB / 2 - 8);
    var cy = klemmen(pos.y * hoehe + anim.dy * hoehe, boxH / 2 + 8, hoehe - boxH / 2 - 8);
    var boxX = cx - boxB / 2;
    var boxY = cy - boxH / 2;
    var radius = basis * RADIUS;
    var textLinks = boxX + padX + balkenBreite + balkenLuecke;
    var textRechts = boxX + boxB - padX;
    var akzent = stil.accent;

    ctx.save();
    ctx.globalAlpha = klemmen(deckkraft, 0, 1);
    if (anim.scale !== 1) {
      ctx.translate(cx, cy);
      ctx.scale(anim.scale, anim.scale);
      ctx.translate(-cx, -cy);
    }

    if (stil.theme === 'glass') {
      // Milchglas: die Szene dahinter, unscharf.
      ctx.save();
      rundesRechteck(ctx, boxX, boxY, boxB, boxH, radius);
      ctx.clip();
      ctx.filter = 'blur(' + Math.round(hoehe * 0.016) + 'px)';
      ctx.drawImage(quelle, 0, 0, breite, hoehe);
      ctx.restore();

      rundesRechteck(ctx, boxX, boxY, boxB, boxH, radius);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fill();
      var glanz = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
      glanz.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
      glanz.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)');
      glanz.addColorStop(1, 'rgba(255, 255, 255, 0.06)');
      ctx.fillStyle = glanz;
      ctx.fill();
      ctx.lineWidth = Math.max(1, hoehe * 0.0015);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.stroke();
    } else if (stil.theme === 'solid') {
      rundesRechteck(ctx, boxX, boxY, boxB, boxH, radius);
      ctx.fillStyle = 'rgba(9, 11, 15, 0.86)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, hoehe * 0.0012);
      ctx.strokeStyle = mitAlpha(akzent, 0.32);
      ctx.stroke();
    } else if (stil.theme === 'outline') {
      rundesRechteck(ctx, boxX, boxY, boxB, boxH, radius);
      ctx.fillStyle = 'rgba(9, 11, 15, 0.28)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, basis * 0.07);
      ctx.strokeStyle = mitAlpha(akzent, 0.85);
      ctx.stroke();
    } else if (balken) {
      rundesRechteck(ctx, boxX, boxY, balkenBreite, boxH, balkenBreite / 2);
      ctx.fillStyle = akzent;
      ctx.fill();
    }

    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = basis * ((schlicht || balken) ? 0.7 : 0.4);
    var y = boxY + padY;

    sicht.forEach(function (zeile) {
      var frei = textRechts - textLinks - zeile.indent;
      var x = textLinks + zeile.indent;
      if (zeile.align === 'center') x += Math.max(0, (frei - zeile.width) / 2);
      else if (zeile.align === 'right') x += Math.max(0, frei - zeile.width);

      if (zeile.kind === 'rule') {
        ctx.save();
        ctx.shadowBlur = 0;
        var ry = y + zeile.height / 2;
        var rb = Math.min(zeile.width, inhaltB);
        var rx = zeile.align === 'center'
          ? x + Math.max(0, (frei - rb) / 2 - (frei - zeile.width) / 2)
          : x;
        ctx.strokeStyle = mitAlpha(akzent, 0.42);
        ctx.lineWidth = Math.max(1, basis * 0.05);
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx + rb, ry);
        ctx.stroke();
        ctx.restore();
        y += zeile.height;
        return;
      }

      // Akzentbalken links der Zitatzeilen — derselbe Abstand wie im CSS.
      if (zeile.kind === 'quote' && zeile.width > 0) {
        ctx.save();
        ctx.shadowBlur = 0;
        var qb = Math.max(2, basis * ZITAT_BALKEN);
        rundesRechteck(ctx, x - basis * (ZITAT_ABSTAND + ZITAT_BALKEN), y + zeile.height * 0.12,
                       qb, zeile.height * 0.76, qb / 2);
        ctx.fillStyle = akzent;
        ctx.fill();
        ctx.restore();
      }

      var cursor = x;
      zeile.tokens.forEach(function (t) {
        t.x = cursor + t.padLeft;
        cursor += schritt(t);
      });

      // 1. Markierung, Plakette, Code hinter den Glyphen
      abschnitte(zeile.tokens, function (t) { return t.mark; }).forEach(function (seg) {
        var t = seg.token;
        ctx.save();
        ctx.shadowBlur = 0;
        rundesRechteck(ctx, seg.from, grundlinie(t, y) - t.size * 0.06, seg.to - seg.from, t.size * 1.1, t.size * 0.24);
        ctx.fillStyle = mitAlpha(t.color || akzent, 0.3);
        ctx.fill();
        ctx.restore();
      });
      abschnitte(zeile.tokens, function (t) { return t.badge; }).forEach(function (seg) {
        var t = seg.token;
        ctx.save();
        ctx.shadowBlur = 0;
        var h = t.size * 1.24;
        rundesRechteck(ctx, seg.from, grundlinie(t, y) - t.size * 0.12, seg.to - seg.from, h, h / 2);
        ctx.fillStyle = mitAlpha(t.color || akzent, 0.22);
        ctx.fill();
        ctx.lineWidth = Math.max(1, t.size * 0.04);
        ctx.strokeStyle = mitAlpha(t.color || akzent, 0.5);
        ctx.stroke();
        ctx.restore();
      });
      abschnitte(zeile.tokens, function (t) { return t.code; }).forEach(function (seg) {
        var t = seg.token;
        ctx.save();
        ctx.shadowBlur = 0;
        rundesRechteck(ctx, seg.from, grundlinie(t, y) - t.size * 0.06, seg.to - seg.from, t.size * 1.12, t.size * 0.22);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.fill();
        ctx.restore();
      });

      // 2. Glyphen
      zeile.tokens.forEach(function (t) {
        if (!t.text.trim()) return;
        ctx.save();
        ctx.globalAlpha *= t.alpha;
        ctx.font = schrift(t.size, t.weight, t.italic, t.code);
        ctx.fillStyle = t.color || (t.code ? CODE_FARBE : '#ffffff');
        ctx.fillText(t.text, t.x, grundlinie(t, y));
        ctx.restore();
      });

      // 3. Unterstrich und Durchstreichung obenauf, als zusammenhängende Linien
      linienZeichnen(ctx, abschnitte(zeile.tokens, function (t) { return t.underline; }), y, 0.96);
      linienZeichnen(ctx, abschnitte(zeile.tokens, function (t) { return t.strike; }), y, 0.58);

      y += zeile.height;
    });

    ctx.restore();
  }

  window.PraesentationText = {
    ACCENT: ACCENT,
    STIL_VORGABE: STIL_VORGABE,
    AUSRICHTUNGEN: AUSRICHTUNGEN,
    THEMEN: THEMEN,
    ANIMATIONEN: ANIMATIONEN,
    FARBEN: FARBEN,
    stilNormalisieren: stilNormalisieren,
    mitAlpha: mitAlpha,
    markdownParsen: markdownParsen,
    titel: titel,
    html: html,
    stilAnwenden: stilAnwenden,
    animVersatz: animVersatz,
    zeichnen: zeichnen,
    istLeer: function (text) { return nurLeer(markdownParsen(text)); },
  };
})();
