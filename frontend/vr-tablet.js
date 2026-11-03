// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Das Tablet am Controller — eine Oberfläche auf einer Leinwand.
//
// In der Brille gibt es kein DOM: Was man lesen und antippen will, muss als
// Bild auf einer Fläche im Raum liegen. Diese Datei zeichnet Knöpfe, Schalter
// und Listen auf ein <canvas> und merkt sich, wo welcher Knopf liegt. Der
// Strahl der anderen Hand trifft die Fläche, vr.js rechnet den Treffer in
// Pixel um und fragt hier, was dort liegt.
//
// Sofort-Zeichnen statt Bausteinbaum: Jede Seite (vr-seiten.js) ist eine
// Funktion, die bei jedem Neuzeichnen alles von vorn zeichnet und dabei ihre
// Trefferflächen anmeldet. Ein Zustand, der sich ändert, setzt `schmutzig`;
// gezeichnet und hochgeladen wird nur dann. So bleibt das Tablet billig, auch
// wenn es in jedem Bild sichtbar ist.
//
// Am Bildschirm hängt dieselbe Leinwand im DOM; Maus und Rad gehen über
// dieselben Wege (zeiger, klick, rollen). Was am Mac geht, geht in der Brille.

export const TABLET_PX = { breite: 1024, hoehe: 704 };

export const FARBE = {
  grund: 'rgba(18, 18, 18, 0.95)',
  flaeche: '#1f1f1f',
  flaecheHell: '#2a2a2a',
  rand: 'rgba(255, 255, 255, 0.12)',
  randStark: 'rgba(255, 255, 255, 0.28)',
  text: '#ececec',
  text2: '#9a9a9a',
  text3: '#6a6a6a',
  akzent: '#97bf0d',
  akzentDunkel: '#10140a',
  akzentFlaeche: 'rgba(151, 191, 13, 0.16)',
  fehler: '#e05c5c',
};

const SCHRIFT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

export class TabletUI {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.regionen = [];
    this.bereiche = new Map();     // id → { x, y, w, h, inhalt }
    this.scroll = new Map();       // id → Pixel
    this.zeigerPos = null;
    this.hoverId = null;
    this.schmutzig = true;
    this._clip = null;
  }

  // ── Zeichnen ──────────────────────────────────────────────────

  anfang() {
    const { ctx, canvas } = this;
    this.regionen = [];
    this.bereiche.clear();
    this._clip = null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = FARBE.grund;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 30);
    ctx.fill();
    ctx.strokeStyle = FARBE.randStark;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  schrift(groesse = 28, gewicht = 400) {
    this.ctx.font = `${gewicht} ${groesse}px ${SCHRIFT}`;
  }

  flaeche(x, y, w, h, r, farbe, rand = null) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (farbe) { ctx.fillStyle = farbe; ctx.fill(); }
    if (rand) { ctx.strokeStyle = rand; ctx.lineWidth = 2; ctx.stroke(); }
  }

  /** Text, auf `max` Pixel gekürzt. Gibt die gezeichnete Breite zurück. */
  text(t, x, y, { groesse = 28, farbe = FARBE.text, gewicht = 400, max = Infinity, ausrichtung = 'left', grundlinie = 'top' } = {}) {
    const { ctx } = this;
    this.schrift(groesse, gewicht);
    const s = kuerze(ctx, String(t ?? ''), max);
    ctx.fillStyle = farbe;
    ctx.textAlign = ausrichtung;
    ctx.textBaseline = grundlinie;
    ctx.fillText(s, x, y);
    return ctx.measureText(s).width;
  }

  /** Zeilen für `breite` Pixel, höchstens `zeilenMax` (die letzte gekürzt). */
  umbrechen(t, breite, { groesse = 28, gewicht = 400, zeilenMax = 3 } = {}) {
    const { ctx } = this;
    this.schrift(groesse, gewicht);
    const woerter = String(t ?? '').split(/\s+/).filter(Boolean);
    const zeilen = [];
    let zeile = '';
    for (let i = 0; i < woerter.length; i++) {
      const probe = zeile ? `${zeile} ${woerter[i]}` : woerter[i];
      if (ctx.measureText(probe).width <= breite || !zeile) {
        zeile = probe;
        continue;
      }
      zeilen.push(zeile);
      zeile = woerter[i];
      if (zeilen.length === zeilenMax - 1) {
        zeile = woerter.slice(i).join(' ');
        break;
      }
    }
    if (zeile) zeilen.push(zeile);
    return zeilen.slice(0, zeilenMax).map((z, i, a) => (i === a.length - 1 ? kuerze(ctx, z, breite) : z));
  }

  /** Eine Trefferfläche. Innerhalb eines Bereichs auf dessen Sichtfenster beschnitten. */
  region(x, y, w, h, id, aktion) {
    let r = { x, y, w, h };
    if (this._clip) {
      const c = this._clip;
      const x0 = Math.max(x, c.x);
      const y0 = Math.max(y, c.y);
      const x1 = Math.min(x + w, c.x + c.w);
      const y1 = Math.min(y + h, c.y + c.h);
      if (x1 <= x0 || y1 <= y0) return;
      r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    this.regionen.push({ ...r, id, aktion });
  }

  istHover(id) {
    return id !== undefined && id !== null && this.hoverId === id;
  }

  knopf(id, x, y, w, h, beschriftung, aktion, { an = false, gesperrt = false, art = 'normal', groesse = 26 } = {}) {
    const hover = !gesperrt && this.istHover(id);
    let farbe = FARBE.flaeche;
    let rand = FARBE.rand;
    let schrift = FARBE.text;
    if (art === 'haupt' && !gesperrt) { farbe = FARBE.akzent; rand = FARBE.akzent; schrift = FARBE.akzentDunkel; }
    if (an) { farbe = FARBE.akzentFlaeche; rand = FARBE.akzent; }
    if (art === 'gefahr' && !gesperrt) rand = FARBE.fehler;
    if (hover) { rand = FARBE.akzent; if (art !== 'haupt') farbe = an ? 'rgba(151, 191, 13, 0.26)' : FARBE.flaecheHell; }
    this.ctx.globalAlpha = gesperrt ? 0.4 : 1;
    this.flaeche(x, y, w, h, Math.min(16, h / 2), farbe, rand);
    this.text(beschriftung, x + w / 2, y + h / 2 + 1, {
      groesse, gewicht: 600, farbe: schrift, max: w - 20, ausrichtung: 'center', grundlinie: 'middle',
    });
    this.ctx.globalAlpha = 1;
    if (!gesperrt && aktion) this.region(x, y, w, h, id, aktion);
  }

  /** Eine Zeile mit Beschriftung links und Schalter rechts; die ganze Zeile ist die Trefferfläche. */
  schalter(id, x, y, w, h, beschriftung, an, aktion, { unter = '', gesperrt = false } = {}) {
    const hover = !gesperrt && this.istHover(id);
    this.ctx.globalAlpha = gesperrt ? 0.4 : 1;
    this.flaeche(x, y, w, h, 14, hover ? FARBE.flaecheHell : FARBE.flaeche, hover ? FARBE.akzent : null);
    const textY = unter ? y + h / 2 - 16 : y + h / 2;
    this.text(beschriftung, x + 22, textY, { groesse: 27, grundlinie: 'middle', max: w - 150 });
    if (unter) this.text(unter, x + 22, y + h / 2 + 17, { groesse: 21, farbe: FARBE.text2, grundlinie: 'middle', max: w - 150 });
    // Schalter
    const sw = 76;
    const sh = 40;
    const sx = x + w - sw - 20;
    const sy = y + (h - sh) / 2;
    this.flaeche(sx, sy, sw, sh, sh / 2, an ? FARBE.akzent : '#3a3a3a');
    this.ctx.fillStyle = an ? FARBE.akzentDunkel : '#cfcfcf';
    this.ctx.beginPath();
    this.ctx.arc(an ? sx + sw - sh / 2 : sx + sh / 2, sy + sh / 2, sh / 2 - 6, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.globalAlpha = 1;
    if (!gesperrt && aktion) this.region(x, y, w, h, id, aktion);
  }

  /** Auswahl aus wenigen Möglichkeiten nebeneinander. */
  segment(id, x, y, w, h, optionen, wert, aktion, { gesperrt = false } = {}) {
    const n = optionen.length;
    const b = w / n;
    this.ctx.globalAlpha = gesperrt ? 0.4 : 1;
    this.flaeche(x, y, w, h, 14, FARBE.flaeche, FARBE.rand);
    optionen.forEach((o, i) => {
      const oid = `${id}:${o.wert}`;
      const gewaehlt = o.wert === wert;
      const hover = !gesperrt && this.istHover(oid);
      if (gewaehlt || hover) {
        this.flaeche(x + i * b + 4, y + 4, b - 8, h - 8, 11,
          gewaehlt ? FARBE.akzent : FARBE.flaecheHell, hover && !gewaehlt ? FARBE.akzent : null);
      }
      this.text(o.text, x + i * b + b / 2, y + h / 2 + 1, {
        groesse: 24, gewicht: 600, farbe: gewaehlt ? FARBE.akzentDunkel : FARBE.text,
        max: b - 16, ausrichtung: 'center', grundlinie: 'middle',
      });
      if (!gesperrt) this.region(x + i * b, y, b, h, oid, () => aktion(o.wert));
    });
    this.ctx.globalAlpha = 1;
  }

  /**
   * Ein rollbarer Bereich. `zeichne(oben)` zeichnet den Inhalt ab der Höhe
   * `oben` (schon um das Rollen verschoben) und gibt seine Gesamthöhe zurück.
   */
  bereich(id, x, y, w, h, zeichne) {
    const { ctx } = this;
    const maxScroll = () => Math.max(0, (this.bereiche.get(id)?.inhalt ?? 0) - h);
    let s = this.scroll.get(id) || 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    this._clip = { x, y, w, h };
    const inhalt = zeichne(y - s) || 0;
    this._clip = null;
    ctx.restore();
    this.bereiche.set(id, { x, y, w, h, inhalt });
    const grenze = maxScroll();
    if (s > grenze) { s = grenze; this.scroll.set(id, s); }
    if (inhalt > h) {
      // Rollbalken
      const bh = Math.max(40, h * h / inhalt);
      const by = y + (h - bh) * (s / grenze || 0);
      this.flaeche(x + w - 8, y, 6, h, 3, 'rgba(255, 255, 255, 0.06)');
      this.flaeche(x + w - 8, by, 6, bh, 3, 'rgba(255, 255, 255, 0.35)');
    }
  }

  // ── Bedienen ──────────────────────────────────────────────────

  treffer(px, py) {
    for (let i = this.regionen.length - 1; i >= 0; i--) {
      const r = this.regionen[i];
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r;
    }
    return null;
  }

  /** Wo der Strahl oder die Maus steht; null = nirgends. */
  zeiger(px, py) {
    this.zeigerPos = px === null || px === undefined ? null : [px, py];
    const r = this.zeigerPos ? this.treffer(px, py) : null;
    const id = r ? r.id : null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.schmutzig = true;
    }
  }

  /** Antippen. Die Aktion bekommt die Pixel (für Flächen wie die Minikarte). */
  klick(px, py) {
    const r = this.treffer(px, py);
    if (!r) return false;
    this.schmutzig = true;
    r.aktion(px, py);
    return true;
  }

  /** Den Bereich unter dem Zeiger (sonst den ersten) um `dy` Pixel rollen. */
  rollen(dy, px, py) {
    let ziel = null;
    for (const [id, b] of this.bereiche) {
      if (px !== undefined && px !== null && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) { ziel = id; break; }
      if (!ziel) ziel = id;
    }
    if (!ziel) return false;
    const b = this.bereiche.get(ziel);
    const grenze = Math.max(0, b.inhalt - b.h);
    const alt = this.scroll.get(ziel) || 0;
    const neu = Math.min(grenze, Math.max(0, alt + dy));
    if (neu === alt) return false;
    this.scroll.set(ziel, neu);
    this.schmutzig = true;
    return true;
  }

  oben(id) {
    this.scroll.set(id, 0);
    this.schmutzig = true;
  }
}

export function kuerze(ctx, text, breite) {
  let t = String(text);
  if (!(breite < Infinity) || ctx.measureText(t).width <= breite) return t;
  // Halbieren statt Zeichen für Zeichen: lange Werte (Hersteller-Psets) kosten sonst
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mitte = (lo + hi + 1) >> 1;
    if (ctx.measureText(t.slice(0, mitte) + '…').width <= breite) lo = mitte;
    else hi = mitte - 1;
  }
  return t.slice(0, lo) + '…';
}
