// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Die Seiten des Tablets: Info · Ebenen · Welt · Karte · Werkzeuge · Gruppe · Hilfe.
//
// Jede Seite zeichnet sich bei jedem Neuzeichnen ganz (vr-tablet.js) und
// liest dafür nur aus `app` (vr.js): Zustand, Auswahl, Ebenen, Welt und die
// Aktionen. Hier steht kein Zustand und keine Rechnung über die Szene — so
// bleibt die Oberfläche austauschbar und die Logik an einer Stelle.
//
// Maße: Die Leinwand hat 1024 × 704 px auf 26 cm Breite, also gut 4 px je
// Millimeter. Schrift ab 22 px (5 mm) ist auf Armlänge lesbar, Knöpfe sind
// mindestens 56 px (14 mm) hoch, damit der Strahl sie ruhig trifft.

import { FARBE, TABLET_PX } from './vr-tablet.js';
import { meterText, mercPixel, pixelGrad } from './vr-rechnen.js';

const W = TABLET_PX.breite;
const H = TABLET_PX.hoehe;
const RAND = 16;
const OBEN = 104;                // Inhalt beginnt unter den Reitern
const UNTEN = H - 52;            // darunter die Fußzeile

export const SEITEN = [
  ['info', 'Info'],
  ['ebenen', 'Ebenen'],
  ['welt', 'Welt'],
  ['karte', 'Karte'],
  ['werkzeuge', 'Werkzeuge'],
  ['gemeinsam', 'Gruppe'],
  ['hilfe', 'Hilfe'],
];

export function tabletZeichnen(ui, app) {
  ui.anfang();
  reiter(ui, app);
  const seite = app.tablet.seite;
  if (seite === 'info') info(ui, app);
  else if (seite === 'ebenen') ebenen(ui, app);
  else if (seite === 'welt') welt(ui, app);
  else if (seite === 'karte') karte(ui, app);
  else if (seite === 'werkzeuge') werkzeuge(ui, app);
  else if (seite === 'gemeinsam') gemeinsam(ui, app);
  else hilfe(ui, app);
  fusszeile(ui, app);
}

function reiter(ui, app) {
  const n = SEITEN.length;
  const luecke = 8;
  const b = (W - 2 * RAND - (n - 1) * luecke) / n;
  // Sieben Reiter: etwas kleiner, sonst würde „Werkzeuge" gekürzt
  const groesse = n > 6 ? 21 : 25;
  SEITEN.forEach(([id, text], i) => {
    ui.knopf(`reiter:${id}`, RAND + i * (b + luecke), RAND, b, 72, text,
      () => app.aktionen.seite(id), { an: app.tablet.seite === id, groesse });
  });
}

function fusszeile(ui, app) {
  const z = app.zustand;
  const y = H - 38;
  const laden = app.ladestand();
  const links = `${z.name || 'Kein Modell'}${laden < 1 ? ` · lädt ${Math.round(laden * 100)} %` : ''}`;
  ui.text(links, RAND + 8, y, { groesse: 21, farbe: FARBE.text2, max: W * 0.62 });
  const hinweis = z.modus === 'vorschau' ? 'Mausrad rollt · Klick tippt' : 'Y / B: Tablet aus · Stick rollt';
  ui.text(hinweis, W - RAND - 8, y, { groesse: 21, farbe: FARBE.text3, ausrichtung: 'right', max: W * 0.36 });
}

function titel(ui, text, y, unter = '') {
  ui.text(text, RAND + 8, y, { groesse: 34, gewicht: 600, max: W - 2 * RAND - 16 });
  if (unter) ui.text(unter, RAND + 8, y + 44, { groesse: 25, farbe: FARBE.text2, max: W - 2 * RAND - 16 });
}

function absatz(ui, text, y, { groesse = 26, farbe = FARBE.text2, zeilenMax = 6, breite = W - 2 * RAND - 16 } = {}) {
  const zeilen = ui.umbrechen(text, breite, { groesse, zeilenMax });
  zeilen.forEach((z, i) => ui.text(z, RAND + 8, y + i * (groesse + 10), { groesse, farbe }));
  return zeilen.length * (groesse + 10);
}

// ── Info ──────────────────────────────────────────────────────────

function info(ui, app) {
  const a = app.auswahl;
  const ak = app.aktionen;
  if (!a) {
    titel(ui, 'Kein Bauteil gewählt', OBEN + 8);
    let y = OBEN + 64;
    y += absatz(ui, app.zustand.modus === 'vorschau'
      ? 'Klick auf ein Bauteil: Hier stehen dann Typ, Geschoss und alle Property-Sets aus dem Modell.'
      : 'Zeig mit dem rechten Strahl auf ein Bauteil und drück den Abzug oder den Griff. Hier stehen dann Typ, Geschoss und alle Property-Sets.', y);
    if (!app.ebenen.filterLeer) {
      ui.knopf('info:alles', RAND + 8, y + 24, 320, 64, 'Alles wieder zeigen', ak.allesZeigen);
    }
    return;
  }
  titel(ui, a.titel, OBEN + 4, a.name || '');
  const y = OBEN + 96;
  const bw = (W - 2 * RAND - 3 * 10) / 4;
  const ausModell = a.quelle === 'modell';
  ui.knopf('info:aus', RAND, y, bw, 60, 'Ausblenden', ak.ausblenden, { gesperrt: !ausModell });
  ui.knopf('info:iso', RAND + (bw + 10), y, bw, 60, 'Isolieren', ak.isolieren, { gesperrt: !ausModell, an: app.ebenen.isoliert });
  ui.knopf('info:alles', RAND + 2 * (bw + 10), y, bw, 60, 'Alles zeigen', ak.allesZeigen, { gesperrt: app.ebenen.filterLeer });
  ui.knopf('info:weg', RAND + 3 * (bw + 10), y, bw, 60, 'Abwählen', ak.auswahlWeg);

  ui.bereich('info', RAND, y + 76, W - 2 * RAND, UNTEN - (y + 76), oben => {
    let yy = oben;
    const zeile = (name, wert, hell = false) => { yy += eigenschaft(ui, name, wert, yy, hell); };
    for (const [name, wert] of a.kopf) zeile(name, wert, true);
    yy += 10;
    const e = a.eigenschaften;
    if (e === 'laedt') {
      ui.text('Lade Eigenschaften …', RAND + 8, yy + 8, { groesse: 25, farbe: FARBE.text2 });
      yy += 50;
    } else if (e === 'fehlt') {
      yy += absatz(ui, a.quelle === 'modell'
        ? 'Keine Property-Sets im Backend für dieses Bauteil — gezeigt wird, was die Kachel selbst trägt.'
        : 'Mehr steht in den Kacheln nicht.', yy + 8, { groesse: 24 }) + 16;
    } else if (Array.isArray(e)) {
      for (const g of e) {
        const offen = app.tablet.offen.has(g.titel);
        const id = `gruppe:${g.titel}`;
        const hover = ui.istHover(id);
        ui.flaeche(RAND, yy, W - 2 * RAND - 14, 54, 12, hover ? FARBE.flaecheHell : FARBE.flaeche, hover ? FARBE.akzent : null);
        ui.text(`${offen ? '▾' : '▸'}  ${g.titel}`, RAND + 16, yy + 27, { groesse: 25, gewicht: 600, grundlinie: 'middle', max: W - 220 });
        ui.text(String(g.zeilen.length), W - RAND - 34, yy + 27, { groesse: 23, farbe: FARBE.text2, grundlinie: 'middle', ausrichtung: 'right' });
        ui.region(RAND, yy, W - 2 * RAND - 14, 54, id, () => ak.gruppeUmschalten(g.titel));
        yy += 62;
        if (offen) {
          for (const [name, wert] of g.zeilen) zeile(name, wert);
          yy += 8;
        }
      }
    }
    return yy - oben + 12;
  });
}

/** Eine Eigenschaft: Name links, Wert rechts, bis zu zwei Zeilen. */
function eigenschaft(ui, name, wert, y, hell) {
  const links = RAND + 16;
  const nameBreite = 360;
  const wertX = links + nameBreite + 16;
  const wertBreite = W - RAND - 24 - wertX;
  const zeilen = ui.umbrechen(wert, wertBreite, { groesse: 24, zeilenMax: 2 });
  ui.text(name, links, y + 6, { groesse: 23, farbe: FARBE.text2, max: nameBreite });
  zeilen.forEach((z, i) => ui.text(z, wertX, y + 6 + i * 30, { groesse: 24, farbe: hell ? FARBE.text : '#d6d6d6' }));
  return Math.max(1, zeilen.length) * 30 + 12;
}

// ── Ebenen ────────────────────────────────────────────────────────

function ebenen(ui, app) {
  const e = app.ebenen;
  const ak = app.aktionen;
  if (!e.hatBauteile) {
    titel(ui, 'Keine Bauteile', OBEN + 8);
    const y = OBEN + 64 + absatz(ui, 'Dieses Modell trägt keine Bauteildaten — eine Punktwolke, ein Splat oder ein Mesh. Ein- und ausblenden lässt es sich nur als Ganzes.', OBEN + 64);
    ui.schalter('ebenen:modell', RAND, y + 20, W - 2 * RAND, 72, 'Modell zeigen', app.zustand.modellSichtbar, () => ak.modellSichtbar(!app.zustand.modellSichtbar));
    return;
  }
  const art = app.tablet.ebenenArt;
  const klassen = art === 'klassen';
  const liste = klassen ? e.klassen() : e.geschosse();
  ui.segment('ebenen:art', RAND, OBEN, 560, 64, [
    { wert: 'klassen', text: `Klassen (${e.anzahlKlassen})` },
    { wert: 'geschosse', text: `Geschosse (${e.anzahlGeschosse})` },
  ], art, ak.ebenenArt);
  ui.knopf('ebenen:an', RAND + 576, OBEN, 200, 64, 'Alle an', () => ak.alle(art, true));
  ui.knopf('ebenen:aus', RAND + 788, OBEN, W - 2 * RAND - 788, 64, 'Alle aus', () => ak.alle(art, false));

  let y = OBEN + 76;
  const zusatz = [];
  if (e.isoliert) zusatz.push([`Isoliert: ${e.isoliertZahl} Bauteil${e.isoliertZahl === 1 ? '' : 'e'}`, 'Aufheben', ak.allesZeigen]);
  if (e.einzelnAus) zusatz.push([`${e.einzelnAus} einzeln ausgeblendet`, 'Zeigen', ak.einzelneZeigen]);
  for (const [text, knopf, aktion] of zusatz) {
    ui.flaeche(RAND, y, W - 2 * RAND, 56, 12, FARBE.akzentFlaeche, FARBE.akzent);
    ui.text(text, RAND + 18, y + 28, { groesse: 24, grundlinie: 'middle', max: W - 300 });
    ui.knopf(`ebenen:${knopf}`, W - RAND - 190, y + 6, 180, 44, knopf, aktion, { groesse: 22 });
    y += 64;
  }

  ui.bereich('ebenen', RAND, y + 4, W - 2 * RAND, UNTEN - y - 4, oben => {
    let yy = oben;
    for (const eintrag of liste) {
      const id = `ebene:${art}:${eintrag.schluessel}`;
      const hover = ui.istHover(id);
      const h = 62;
      ui.flaeche(0 + RAND, yy, W - 2 * RAND - 14, h - 6, 12, hover ? FARBE.flaecheHell : FARBE.flaeche, hover ? FARBE.akzent : null);
      // Kästchen
      const kx = RAND + 16;
      const ky = yy + (h - 6) / 2 - 16;
      ui.flaeche(kx, ky, 32, 32, 8, eintrag.an ? FARBE.akzent : '#3a3a3a');
      if (eintrag.an) ui.text('✓', kx + 16, ky + 17, { groesse: 26, gewicht: 700, farbe: FARBE.akzentDunkel, ausrichtung: 'center', grundlinie: 'middle' });
      const textX = kx + 50;
      const breite = ui.text(eintrag.name, textX, yy + (h - 6) / 2, {
        groesse: 27, grundlinie: 'middle', farbe: eintrag.an ? FARBE.text : FARBE.text3, max: 520,
      });
      if (klassen && eintrag.schluessel && eintrag.name !== eintrag.schluessel) {
        ui.text(eintrag.schluessel, textX + breite + 14, yy + (h - 6) / 2 + 2, { groesse: 20, farbe: FARBE.text3, grundlinie: 'middle', max: 600 - breite });
      }
      ui.text(String(eintrag.anzahl), W - RAND - 150, yy + (h - 6) / 2, { groesse: 24, farbe: FARBE.text2, grundlinie: 'middle', ausrichtung: 'right' });
      ui.region(RAND, yy, W - 2 * RAND - 140, h - 6, id, () => ak.ebeneUmschalten(art, eintrag.schluessel));
      ui.knopf(`nur:${art}:${eintrag.schluessel}`, W - RAND - 130, yy + 6, 104, h - 18, 'nur', () => ak.nur(art, eintrag.schluessel), { groesse: 22 });
      yy += h;
    }
    if (!liste.length) {
      ui.text('Noch nichts geladen …', RAND + 8, yy + 10, { groesse: 25, farbe: FARBE.text2 });
      yy += 50;
    }
    return yy - oben;
  });
}

// ── Welt ──────────────────────────────────────────────────────────

function welt(ui, app) {
  const w = app.welt;
  const ak = app.aktionen;
  if (!w.verortet) {
    titel(ui, 'Modell nicht verortet', OBEN + 8);
    absatz(ui, 'Ohne Lage auf der Erde gibt es keine Umgebung. Im Viewer unter Modelle → Platzieren lässt sich das Modell verorten; danach ist hier Gelände, Luftbild und Nachbarbebauung zu sehen.', OBEN + 64);
    ui.schalter('welt:raster', RAND, OBEN + 300, W - 2 * RAND, 72, 'Raster-Boden', w.raster, () => ak.raster(!w.raster));
    return;
  }
  ui.bereich('welt', RAND, OBEN, W - 2 * RAND, UNTEN - OBEN, oben => {
    let y = oben;
    const breite = W - 2 * RAND - 14;
    ui.schalter('welt:an', RAND, y, breite, 72, 'Umgebung zeigen', w.an, () => ak.welt({ an: !w.an }), { unter: 'Gelände, Luftbild oder Karte und Nachbargebäude' });
    y += 84;
    ui.text('Auf dem Gelände', RAND + 8, y + 4, { groesse: 23, farbe: FARBE.text2 });
    y += 38;
    ui.segment('welt:karte', RAND, y, breite, 64, [
      { wert: 'luftbild', text: 'Luftbild' }, { wert: 'karte', text: 'Karte' },
      { wert: 'osm', text: 'OSM' }, { wert: 'keine', text: 'nichts' },
    ], w.karte, karte => ak.welt({ karte }), { gesperrt: !w.an });
    y += 78;
    ui.schalter('welt:relief', RAND, y, breite, 72, 'Relief', w.relief, () => ak.welt({ relief: !w.relief }), {
      gesperrt: !w.an, unter: w.relief ? 'Gelände mit Höhen' : 'flache Karte auf Höhe der Sohle',
    });
    y += 84;
    ui.schalter('welt:lod2', RAND, y, breite, 72, 'Nachbargebäude (LoD2)', w.gebaeudeAn, () => ak.welt({ gebaeudeAn: !w.gebaeudeAn }), {
      gesperrt: !w.an || !w.inDeutschland, unter: w.inDeutschland ? 'amtliche 3D-Gebäude, basemap.de' : 'nur in Deutschland',
    });
    y += 92;

    // Höhe
    ui.text('Höhe des Geländes', RAND + 8, y, { groesse: 25, gewicht: 600 });
    const mitte = w.mitte === null ? 'Mitte: lädt …' : `in Grundrissmitte y = ${vorzeichen(w.mitte)}`;
    ui.text(`${w.versatz ? `${vorzeichen(w.versatz)} versetzt` : 'georeferenziert'} · ${mitte}`, RAND + 8, y + 36, { groesse: 23, farbe: FARBE.text2, max: breite });
    y += 76;
    const kb = (breite - 3 * 10) / 4;
    ui.knopf('welt:runter', RAND, y, kb, 60, '▼ 0,5 m', () => ak.versatz(-0.5), { gesperrt: !w.an });
    ui.knopf('welt:hoch', RAND + kb + 10, y, kb, 60, '▲ 0,5 m', () => ak.versatz(0.5), { gesperrt: !w.an });
    ui.knopf('welt:anlegen', RAND + 2 * (kb + 10), y, kb, 60, 'An Sohle', ak.anlegen, { gesperrt: !w.an || w.mitte === null });
    ui.knopf('welt:georef', RAND + 3 * (kb + 10), y, kb, 60, 'Georef.', () => ak.versatz(null), { gesperrt: !w.an || !w.versatz });
    y += 76;
    ui.schalter('welt:raster', RAND, y, breite, 72, 'Raster-Boden', w.raster, () => ak.raster(!w.raster), { unter: 'Gitter auf Höhe der Sohle, 1 m / 10 m' });
    y += 92;

    if (w.vermerke.length) {
      ui.text('Quellen', RAND + 8, y, { groesse: 22, farbe: FARBE.text2 });
      y += 32;
      for (const v of w.vermerke) {
        const zeilen = ui.umbrechen(v, breite - 16, { groesse: 19, zeilenMax: 3 });
        zeilen.forEach((z, i) => ui.text(z, RAND + 8, y + i * 25, { groesse: 19, farbe: FARBE.text3 }));
        y += zeilen.length * 25 + 6;
      }
    }
    return y - oben + 12;
  });
}

function vorzeichen(m) {
  return `${m > 0 ? '+' : ''}${meterText(m)}`;
}

// ── Karte ─────────────────────────────────────────────────────────

/**
 * Die Minikarte: genordet, Kacheln aus derselben Quelle wie das Gelände
 * (vr-welt.js → kartenKachel). Der Pfeil ist man selbst, das Rechteck der
 * Grundriss des Modells. Antippen springt dorthin.
 */
function karte(ui, app) {
  const k = app.karte;
  const ak = app.aktionen;
  if (!k.verfuegbar) {
    titel(ui, 'Keine Karte', OBEN + 8);
    absatz(ui, 'Das Modell ist nicht verortet — ohne Lage auf der Erde gibt es keine Karte.', OBEN + 64);
    return;
  }
  const x = RAND;
  const y = OBEN;
  const w = W - 2 * RAND - 150;
  const h = UNTEN - OBEN - 8;
  const z = k.zoom;
  const mitte = k.mitte();
  const mp = mercPixel(mitte.lat, mitte.lon, z);
  const { ctx } = ui;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 16);
  ctx.clip();
  ctx.fillStyle = '#2a2d27';
  ctx.fillRect(x, y, w, h);
  const links = mp.x - w / 2;
  const obenPx = mp.y - h / 2;
  const n = 2 ** z;
  for (let tx = Math.floor(links / 256); tx <= Math.floor((links + w) / 256); tx++) {
    for (let ty = Math.floor(obenPx / 256); ty <= Math.floor((obenPx + h) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      const bild = k.kachel(((tx % n) + n) % n, ty, z);
      const px = x + tx * 256 - links;
      const py = y + ty * 256 - obenPx;
      if (bild) ctx.drawImage(bild, px, py, 256, 256);
      else { ctx.fillStyle = '#34372f'; ctx.fillRect(px + 1, py + 1, 254, 254); }
    }
  }
  const nachPx = (lat, lon) => {
    const p = mercPixel(lat, lon, z);
    return [x + p.x - links, y + p.y - obenPx];
  };
  // Grundriss
  const fuss = k.fuss();
  if (fuss) {
    ctx.beginPath();
    fuss.forEach(([lat, lon], i) => { const [px, py] = nachPx(lat, lon); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(151, 191, 13, 0.25)';
    ctx.fill();
    ctx.strokeStyle = FARBE.akzent;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  // Man selbst
  const ich = k.ich();
  if (ich) {
    const [px, py] = nachPx(ich.lat, ich.lon);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ich.richtung);
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.lineTo(17, 18);
    ctx.lineTo(0, 9);
    ctx.lineTo(-17, 18);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#10140a';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
  // Nordpfeil und Maßstab
  ui.flaeche(x + 14, y + 14, 52, 52, 26, 'rgba(18, 18, 18, 0.8)');
  ui.text('N', x + 40, y + 41, { groesse: 26, gewicht: 700, ausrichtung: 'center', grundlinie: 'middle' });
  const mpp = k.meterProPixel(mitte.lat, z);
  const meter = [5, 10, 20, 50, 100, 200, 500, 1000].find(m => m / mpp > 90) || 1000;
  const lp = meter / mpp;
  ui.flaeche(x + 14, y + h - 58, lp + 28, 44, 10, 'rgba(18, 18, 18, 0.8)');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + 28, y + h - 28, lp, 5);
  ui.text(meter >= 1000 ? `${meter / 1000} km` : `${meter} m`, x + 28, y + h - 52, { groesse: 20 });
  ctx.restore();

  if (k.antippbar) {
    ui.region(x, y, w, h, 'karte:flaeche', (px, py) => {
      const g = pixelGrad(links + (px - x), obenPx + (py - y), z);
      ak.hinspringen(g.lat, g.lon);
    });
  }
  ctx.strokeStyle = FARBE.randStark;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 16);
  ctx.stroke();

  // Knöpfe rechts
  const bx = W - RAND - 136;
  const bw = 136;
  ui.knopf('karte:plus', bx, y, bw, 64, '+', () => ak.karteZoom(1), { gesperrt: z >= 19, groesse: 34 });
  ui.knopf('karte:minus', bx, y + 74, bw, 64, '−', () => ak.karteZoom(-1), { gesperrt: z <= 13, groesse: 34 });
  ui.knopf('karte:ich', bx, y + 160, bw, 64, 'Ich', () => ak.karteMitte('ich'), { an: k.mitteArt === 'ich', gesperrt: !ich });
  ui.knopf('karte:modell', bx, y + 234, bw, 64, 'Modell', () => ak.karteMitte('modell'), { an: k.mitteArt === 'modell' });
  ui.knopf('karte:art', bx, y + 320, bw, 64, k.art === 'luftbild' ? 'Karte' : 'Luftbild', () => ak.karteArt(k.art === 'luftbild' ? 'karte' : 'luftbild'));
  const hinweis = !k.antippbar ? 'Tischmodell: nur Lage' : (app.zustand.modus === 'vr' ? 'Tippen: dorthin springen' : 'Klick: Blick dorthin');
  const zeilen = ui.umbrechen(hinweis, bw, { groesse: 20, zeilenMax: 3 });
  zeilen.forEach((t, i) => ui.text(t, bx, y + 404 + i * 26, { groesse: 20, farbe: FARBE.text2 }));
}

// ── Werkzeuge ─────────────────────────────────────────────────────

function werkzeuge(ui, app) {
  const wz = app.werkzeug;
  const ak = app.aktionen;
  const brille = app.zustand.modus !== 'vorschau';
  ui.bereich('werkzeuge', RAND, OBEN, W - 2 * RAND, UNTEN - OBEN, oben => {
    let y = oben;
    const breite = W - 2 * RAND - 14;
    // Ohne Sticks (Vision Pro) sind Drehen und Start nur hier zu erreichen; mit Controllern schaden sie nicht
    if (brille) {
      const kb = (breite - 2 * 10) / 3;
      if (app.zustand.modus === 'vr') {
        ui.knopf('wz:links', RAND, y, kb, 64, `◀ ${wz.drehschritt}°`, () => ak.drehen(1));
        ui.knopf('wz:rechts', RAND + kb + 10, y, kb, 64, `${wz.drehschritt}° ▶`, () => ak.drehen(-1));
        ui.knopf('wz:start', RAND + 2 * (kb + 10), y, kb, 64, 'Zum Start', ak.zumStart);
      } else {
        ui.knopf('wz:start', RAND, y, breite, 64, 'Modell wieder vor mich stellen', ak.zumStart);
      }
      y += 78;
    }
    ui.schalter('wz:messen', RAND, y, breite, 72, 'Messen', wz.messen, ak.messenUmschalten, {
      unter: wz.messen ? (wz.punkte === 1 ? 'Punkt A gesetzt — jetzt Punkt B' : 'Abzug setzt Punkt A, dann B') : 'Abstand zwischen zwei Punkten',
    });
    y += 84;
    if (wz.messung) {
      const m = wz.messung;
      ui.flaeche(RAND, y, breite, 128, 14, FARBE.akzentFlaeche, FARBE.akzent);
      ui.text(meterText(m.abstand), RAND + 22, y + 16, { groesse: 44, gewicht: 600 });
      ui.text(`waagerecht ${meterText(m.waagerecht)} · Höhe ${vorzeichen(m.hoehe)}`, RAND + 22, y + 78, { groesse: 24, farbe: FARBE.text2, max: breite - 260 });
      ui.knopf('wz:messungweg', RAND + breite - 220, y + 34, 200, 60, 'Löschen', ak.messungWeg);
      y += 140;
    }
    ui.schalter('wz:schnitt', RAND, y, breite, 72, 'Höhenschnitt', wz.schnitt.an, ak.schnittUmschalten, {
      unter: wz.schnitt.an ? `Modell abgeschnitten oberhalb ${vorzeichen(wz.schnitt.hoehe)} über der Sohle` : 'Draufsicht in ein Geschoss',
    });
    y += 84;
    if (wz.schnitt.an) {
      const kb = (breite - 3 * 10) / 4;
      ui.knopf('wz:s-', RAND, y, kb, 60, '▼ 0,25 m', () => ak.schnittHoehe(-0.25));
      ui.knopf('wz:s+', RAND + kb + 10, y, kb, 60, '▲ 0,25 m', () => ak.schnittHoehe(0.25));
      ui.knopf('wz:s--', RAND + 2 * (kb + 10), y, kb, 60, '▼ 3 m', () => ak.schnittHoehe(-3));
      ui.knopf('wz:skopf', RAND + 3 * (kb + 10), y, kb, 60, brille ? 'Über Kopf' : '▲ 3 m', brille ? ak.schnittKopf : () => ak.schnittHoehe(3));
      y += 76;
    }
    ui.schalter('wz:boden', RAND, y, breite, 72, 'Boden folgen', wz.bodenFolgen, () => ak.bodenFolgen(!wz.bodenFolgen), {
      unter: 'Treppen und Gelände folgen (Schweben setzt aus)',
    });
    y += 92;
    ui.text('Gehtempo', RAND + 8, y, { groesse: 23, farbe: FARBE.text2 });
    y += 34;
    ui.segment('wz:tempo', RAND, y, breite, 60, [
      { wert: 0.8, text: 'langsam' }, { wert: 1.4, text: 'normal' }, { wert: 2.6, text: 'schnell' },
    ], wz.tempo, ak.tempo);
    y += 74;
    ui.text('Drehen in Schritten', RAND + 8, y, { groesse: 23, farbe: FARBE.text2 });
    y += 34;
    ui.segment('wz:dreh', RAND, y, breite, 60, [
      { wert: 30, text: '30°' }, { wert: 45, text: '45°' }, { wert: 90, text: '90°' },
    ], wz.drehschritt, ak.drehschritt);
    y += 74;
    ui.text('Tablet', RAND + 8, y, { groesse: 23, farbe: FARBE.text2 });
    y += 34;
    ui.segment('wz:hand', RAND, y, breite, 60, [
      { wert: 'left', text: 'linke Hand' }, { wert: 'right', text: 'rechte Hand' }, { wert: 'schweben', text: 'schwebt' },
    ], wz.tabletHand, ak.tabletHand);
    y += 74;
    return y - oben + 8;
  });
}

// ── Gemeinsam ─────────────────────────────────────────────────────
//
// Wer ist im Raum, ist diese Brille kalibriert, geht sie mit (vr-gemeinsam.js).
// Die Kalibrierung ist der eine Handgriff, den jeder in der Brille einmal tun
// muss — sie steht deshalb oben und sagt in jedem Schritt, was zu tun ist.

const VERBINDUNG = {
  aus: 'nicht verbunden', verbinde: 'verbinde …', offen: 'verbunden', getrennt: 'getrennt — neuer Versuch läuft',
  keinDienst: 'kein Relais erreichbar', ersetzt: 'in einem anderen Fenster geöffnet', voll: 'Raum ist voll',
};

function farbpunkt(ui, x, y, farbe, r) {
  const { ctx } = ui;
  ctx.fillStyle = farbe;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function zeilenText(ui, text, x, y, breite, { groesse = 23, farbe = FARBE.text2, zeilenMax = 4 } = {}) {
  const zeilen = ui.umbrechen(text, breite, { groesse, zeilenMax });
  zeilen.forEach((z, i) => ui.text(z, x, y + i * (groesse + 8), { groesse, farbe }));
  return zeilen.length * (groesse + 8);
}

function gemeinsam(ui, app) {
  const gm = app.gemeinsam;
  const ak = app.aktionen;
  ui.bereich('gemeinsam', RAND, OBEN, W - 2 * RAND, UNTEN - OBEN, oben => {
    let y = oben;
    const breite = W - 2 * RAND - 14;
    const offen = gm.verbindung === 'offen';

    // Ich und die Verbindung
    ui.flaeche(RAND, y, breite, 72, 14, FARBE.flaeche);
    farbpunkt(ui, RAND + 30, y + 36, gm.ich.farbe, 13);
    ui.text(gm.ich.name || '…', RAND + 56, y + 23, { groesse: 27, gewicht: 600, grundlinie: 'middle', max: 420 });
    ui.text(`Raum ${gm.raum} · ${VERBINDUNG[gm.verbindung] || gm.verbindung}`, RAND + 56, y + 52,
      { groesse: 21, farbe: offen ? FARBE.akzent : FARBE.text2, grundlinie: 'middle', max: 560 });
    let kx = RAND + breite - 10;
    if (!offen && gm.verbindung !== 'verbinde') {
      kx -= 170;
      ui.knopf('gm:verbinden', kx, y + 10, 170, 52, 'Verbinden', ak.gmVerbinden, { groesse: 22, gesperrt: !gm.adresse });
    }
    if (!gm.xr) ui.knopf('gm:name', kx - 170, y + 10, 160, 52, 'Name …', ak.gmName, { groesse: 22 });
    y += 84;
    if (!gm.adresse) {
      y += zeilenText(ui, 'Gemeinsam geht über den Quest-Dienst: iLEEN unter https://<Mac>:5443 öffnen. Über http im WLAN gibt es weder VR noch Gemeinsam.',
        RAND + 8, y, breite - 16) + 12;
    }

    // Die anderen sehen ein anderes Modell
    if (gm.raumModell) {
      ui.flaeche(RAND, y, breite, 64, 12, FARBE.akzentFlaeche, FARBE.akzent);
      ui.text(`Die anderen sehen ${gm.raumModell.name}`, RAND + 18, y + 32, { groesse: 24, grundlinie: 'middle', max: breite - 240 });
      ui.knopf('gm:modell', RAND + breite - 200, y + 8, 190, 48, 'Wechseln', ak.gmModellWechseln, { groesse: 22 });
      y += 76;
    }

    y = kalibrierKarte(ui, gm, ak, y, breite);

    let mitUnter;
    if (!gm.brille) mitUnter = 'nur in der Brille';
    else if (!gm.kalib) mitUnter = gm.mitgehen ? 'nach der Kalibrierung: mit den anderen' : 'nach der Kalibrierung: jeder für sich';
    else if (!gm.mitgehen) mitUnter = 'jeder für sich — blasse Geister zeigen, wo die anderen wirklich stehen';
    else mitUnter = gm.fuehrt ? `mit der Gruppe — zuletzt bewegt von ${gm.fuehrt}` : 'wer geht, springt oder greift, nimmt alle mit';
    ui.schalter('gm:mitgehen', RAND, y, breite, 72, 'Mitgehen', gm.mitgehen, () => ak.gmMitgehen(!gm.mitgehen), { unter: mitUnter });
    y += 84;
    ui.schalter('gm:ansicht', RAND, y, breite, 72, 'Ansicht teilen', gm.ansichtTeilen, () => ak.gmAnsicht(!gm.ansichtTeilen), {
      unter: 'Ebenen, Isolieren und Höhenschnitt gelten für alle im selben Modell',
    });
    y += 92;

    // Wer ist da
    ui.text(gm.teilnehmer.length ? `Im Raum (${gm.teilnehmer.length})` : 'Im Raum', RAND + 8, y, { groesse: 23, farbe: FARBE.text2 });
    y += 36;
    if (!gm.teilnehmer.length) {
      y += zeilenText(ui, offen
        ? 'Noch niemand sonst. Andere Brillen öffnen dieselbe Adresse und drücken 🥽 — sie erscheinen von selbst.'
        : 'Erst wenn die Verbindung steht, sind die anderen zu sehen.', RAND + 8, y, breite - 16);
    }
    for (const t of gm.teilnehmer) {
      const h = 66;
      ui.flaeche(RAND, y, breite, h - 6, 12, FARBE.flaeche);
      farbpunkt(ui, RAND + 26, y + 30, t.farbe, 11);
      ui.text(t.name, RAND + 50, y + 18, { groesse: 25, gewicht: 600, grundlinie: 'middle', max: 420 });
      const kalib = t.kalibriert ? (t.mitgehen ? 'kalibriert, geht mit' : 'kalibriert') : (t.geraet === 'brille' ? 'nicht kalibriert' : null);
      const unter = [t.modus, kalib, t.anderesModell ? `anderes Modell: ${t.modell}` : null,
        t.abstand !== null && t.abstand !== undefined ? `${meterText(t.abstand)} entfernt` : null].filter(Boolean).join(' · ');
      ui.text(unter, RAND + 50, y + 44, { groesse: 20, farbe: t.anderesModell ? FARBE.fehler : FARBE.text2, grundlinie: 'middle', max: breite - 250 });
      if (t.neben) ui.knopf(`gm:neben:${t.id}`, RAND + breite - 180, y + 8, 170, 44, 'Daneben', () => ak.gmNeben(t.id), { groesse: 21 });
      y += h;
    }
    return y - oben + 8;
  });
}

/** Die Kalibrierung: was zu tun ist, was gemessen wurde, und ob es zu den anderen passt. */
function kalibrierKarte(ui, gm, ak, y, breite) {
  const x = RAND;
  const text = (t, yy, opt) => zeilenText(ui, t, x + 22, yy, breite - 260, opt);
  if (!gm.brille || !gm.xr) {
    const t = !gm.brille
      ? 'Am Bildschirm schaust du zu: Hier stehen die Brillen im Modell, mit Namen und Strahl. Was du anklickst, leuchtet bei ihnen in deiner Farbe.'
      : 'Kalibrieren geht in der Brille: 1:1 begehen oder Tischmodell, dann hier „Kalibrieren".';
    const h = zeilenText(ui, t, x + 8, y + 4, breite - 16) + 18;
    return y + h;
  }
  const m = gm.messen;
  if (m) {
    // Ohne Controller (Vision Pro) misst der Kneifpunkt: wo Daumen und Zeigefinger sich treffen
    const anleitung = m.schritt === 1
      ? (m.controller
        ? 'Spitze des Controllers (weißer Punkt) auf die erste Marke setzen, Abzug drücken und einen Moment still halten.'
        : 'Daumen und Zeigefinger auf der ersten Marke zusammendrücken (kneifen, nicht aufs Tablet schauen) und halten, bis die Marke steht.')
      : (m.controller
        ? 'Jetzt die zweite Marke — dieselbe Reihenfolge wie die anderen Brillen.'
        : 'Jetzt auf der zweiten Marke kneifen und halten — dieselbe Reihenfolge wie die anderen Brillen.');
    // Erst messen, dann zeichnen: die Karte ist so hoch wie ihr Text
    const zeilen = ui.umbrechen(anleitung, breite - 260, { groesse: 23, zeilenMax: 4 }).length
      + (m.meldung ? ui.umbrechen(m.meldung, breite - 260, { groesse: 23, zeilenMax: 2 }).length : 0);
    const h = Math.max(96, 62 + zeilen * 31 + 16);
    ui.flaeche(x, y, breite, h, 14, FARBE.akzentFlaeche, FARBE.akzent);
    ui.text(m.laeuft ? 'Messe … still halten' : `Marke ${m.schritt} von 2 messen`, x + 22, y + 18, { groesse: 30, gewicht: 600, max: breite - 260 });
    const yy = y + 62 + text(anleitung, y + 62, { farbe: FARBE.text });
    if (m.meldung) text(m.meldung, yy, { farbe: FARBE.fehler, zeilenMax: 2 });
    ui.knopf('gm:abbrechen', x + breite - 210, y + 16, 190, 56, 'Abbrechen', ak.gmAbbrechen, { groesse: 22 });
    return y + h + 12;
  }
  if (gm.kalib) {
    const v = gm.kalib.vergleich;
    const schlecht = v && !v.passt;
    ui.flaeche(x, y, breite, 124, 14, FARBE.flaeche, schlecht ? FARBE.fehler : FARBE.akzent);
    ui.text(`Kalibriert · Marken ${meterText(gm.kalib.abstand)} auseinander`, x + 22, y + 18, { groesse: 27, gewicht: 600, max: breite - 260 });
    let vergleich;
    if (!v) vergleich = 'Noch keine andere Brille kalibriert — dann steht hier, ob ihr dieselben Marken gemessen habt.';
    else if (v.passt) vergleich = `Passt zu ${v.name}: ${Math.round(v.abstand * 1000)} mm Unterschied im Abstand.`;
    else vergleich = `${v.name} misst ${Math.round(v.abstand * 100)} cm anders${v.hoehe > 0.08 ? ` und ${Math.round(v.hoehe * 100)} cm höher/tiefer` : ''} — andere Marke getroffen? Beide neu kalibrieren.`;
    text(vergleich, y + 58, { farbe: schlecht ? FARBE.fehler : FARBE.text2, zeilenMax: 2 });
    ui.knopf('gm:kalibrieren', x + breite - 230, y + 16, 210, 56, 'Neu kalibrieren', ak.gmKalibrieren, { groesse: 22 });
    return y + 136;
  }
  ui.flaeche(x, y, breite, 170, 14, FARBE.flaeche, FARBE.randStark);
  ui.text('Nicht kalibriert', x + 22, y + 18, { groesse: 27, gewicht: 600, max: breite - 260 });
  text('Zwei Marken im Raum, 2 bis 4 m auseinander (Klebeband am Boden, zwei Tischecken). Jede Brille misst beide in derselben Reihenfolge — dann steht jeder Avatar, wo der Mensch steht.',
    y + 58, { zeilenMax: 4 });
  ui.knopf('gm:kalibrieren', x + breite - 210, y + 16, 190, 56, 'Kalibrieren', ak.gmKalibrieren, { art: 'haupt', groesse: 22 });
  return y + 182;
}

// ── Hilfe ─────────────────────────────────────────────────────────

const HILFE = {
  vr: [
    ['Linker Stick', 'gehen · drücken: schneller'],
    ['Rechter Stick', '◀ ▶ drehen · ▲ ▼ schweben'],
    ['Abzug', 'Boden: hinspringen · Bauteil: Info'],
    ['Griff', 'Info zum Bauteil, auch Decken'],
    ['A / X', 'zurück zum Start'],
    ['B / Y', 'Tablet aus und an'],
    ['Strahl aufs Tablet', 'Abzug tippt · rechter Stick rollt'],
  ],
  tisch: [
    ['Griff', 'Modell greifen und bewegen'],
    ['Linker Stick ◀ ▶', 'Modell drehen'],
    ['Rechter Stick ▲ ▼', 'größer / kleiner'],
    ['Abzug', 'Info zum Bauteil'],
    ['A / X', 'Modell wieder vor dich stellen'],
    ['B / Y', 'Tablet aus und an'],
  ],
  // Ohne Controller: Vision Pro (hinsehen + kneifen) oder die Hände der Quest (zeigen + kneifen)
  vrHand: [
    ['Hinsehen, kneifen', 'Boden: hinspringen · Bauteil: Info'],
    ['Lange kneifen', 'Info, auch zu Decken und Böden'],
    ['Auf dem Tablet', 'kneifen tippt · kneifen und ziehen rollt'],
    ['Drehen, Start', 'Werkzeuge: ◀ 30° · 30° ▶ · Zum Start'],
    ['Tablet', 'schwebt links unten, folgt beim Wegdrehen'],
    ['Gehen', 'hinspringen — oder ein paar echte Schritte'],
  ],
  tischHand: [
    ['Kneifen', 'Info zum Bauteil'],
    ['Auf dem Tablet', 'kneifen tippt · kneifen und ziehen rollt'],
    ['Werkzeuge', 'Modell wieder vor mich stellen'],
  ],
  vorschau: [
    ['Ziehen', 'drehen · rechte Taste: schieben'],
    ['Mausrad', 'näher, weiter'],
    ['Klick', 'Bauteil wählen'],
    ['Tablet', 'wie in der Brille, mit der Maus'],
    ['In die Brille', 'iLEEN im Browser der Brille öffnen (Quest, Vision Pro), dann 1:1'],
  ],
};

function hilfe(ui, app) {
  const modus = app.zustand.modus;
  titel(ui, modus === 'tisch' ? 'Tischmodell' : modus === 'vr' ? '1:1 begehen' : 'Am Bildschirm', OBEN + 4);
  let y = OBEN + 64;
  const ohneController = app.steuerung === 'hand' && modus !== 'vorschau';
  for (const [taste, was] of HILFE[ohneController ? `${modus}Hand` : modus] || HILFE.vorschau) {
    ui.flaeche(RAND, y, W - 2 * RAND, 60, 12, FARBE.flaeche);
    ui.text(taste, RAND + 20, y + 30, { groesse: 26, gewicht: 600, grundlinie: 'middle', max: 330 });
    ui.text(was, RAND + 360, y + 30, { groesse: 26, farbe: '#d6d6d6', grundlinie: 'middle', max: W - 2 * RAND - 380 });
    y += 68;
  }
}
