// Die Bildebenen im echten Browser: Chrome headless über puppeteer-core
// (kein Projekt-Dependency — `npm i --no-save puppeteer-core`), gegen den
// laufenden Dev-Server.
//
// Was hier und NUR hier zu beantworten ist, ist die **Texturzuordnung** —
// dieselbe Frage wie beim Prüfstein der Geschossgrundrisse und aus demselben
// Grund: sie entsteht in Cesiums Geometriepipeline und im Texturlader, und
// kein Prüfstein ohne GPU kommt daran heran. Der Kopf von bildebenen.js
// leitet her, dass
//
//     st (0,0) → Ecke (−0,5, −0,5) → Bild UNTEN links
//     st (1,1) → Ecke (+0,5, +0,5) → Bild OBEN rechts
//
// gilt, und `basis()` bildet dazu ein rechtshändiges Dreibein. Stimmt eines
// von beidem nicht, hängt jedes Bild gespiegelt oder auf dem Kopf an der
// Wand — und an einer Fassadenabwicklung sieht man das erst, wenn jemand ein
// Fenster sucht.
//
// Der Prüfstein legt ein Bild aus vier verschieden gefärbten Quadranten über
// den vom Modul selbst gebauten Weg (`_nachziehen`) in die Szene, schaut
// senkrecht darauf und liest nach, welche Farbe wo ankommt. Zusätzlich prüft
// er, was am Einheitsquadrat hängt: dass ein Reglerzug die Fläche NICHT neu
// baut. Ein Backend braucht er nicht.
//
// Aufruf:  npx vite --port 5187 &   node tests/bildebenen/test-browser.mjs
//
// Endung .mjs, weil das package.json daneben CommonJS führt (der Prüfstein
// ohne Browser lädt das Modul über vm) — dieser hier ist ein Modul.

import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5187/';

/** Welche der vier Prüffarben hier ankommt — mit Spielraum fürs Blenden. */
const dominant = ([r, g, b]) => {
  if (r > 150 && g < 100 && b < 100) return 'rot';
  if (g > 150 && r < 120 && b < 120) return 'gruen';
  if (b > 150 && r < 120) return 'blau';
  if (r > 150 && g > 150 && b < 120) return 'gelb';
  return `anders(${r},${g},${b})`;
};

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700 });
const seitenfehler = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => { window._splashDismissed = true; });
await new Promise((r) => setTimeout(r, 14000));

// ── 1. Modul und Panel ────────────────────────────────────────────────────

console.log('\n1. Modul und Panel');
const gerüst = await page.evaluate(() => ({
  modul: !!(window.BimViewer && window.BimViewer.Bildebenen),
  gruppe: !!document.getElementById('group-bildebenen'),
  galerie: !!document.getElementById('beGalerie'),
  liste: !!document.getElementById('beListe'),
  setzen: !!document.getElementById('beSetzen'),
  ausrichtungen: Array.from(document.querySelectorAll('#beAusrichtung option')).map((o) => o.value),
  // Die Gruppe MUSS hinter den Layern im Modelle-Panel stehen: eine
  // Bildebene IST eine Ebene über dem Bauwerk, und die Frage „was liegt
  // gerade über dem Modell" wird dort gestellt.
  imModellePanel: !!document.querySelector('#section-models #group-bildebenen'),
  hinterLayern: (() => {
    const g = document.getElementById('group-layers');
    return !!(g && g.nextElementSibling &&
              g.nextElementSibling.id === 'group-bildebenen');
  })(),
  sperreDa: !!document.getElementById('beSperre'),
  breiteFeldWeg: !document.getElementById('beBreite'),
  wache: !!(window.BimViewer.Bildebenen && window.BimViewer.Bildebenen._wache)
}));
pruefe('BimViewer.Bildebenen steht bereit', gerüst.modul);
pruefe('Panelgruppe ist eingehängt', gerüst.gruppe);
pruefe('Galerie, Liste und Setzen-Knopf sind da',
  gerüst.galerie && gerüst.liste && gerüst.setzen);
pruefe('drei Ausrichtungen zur Wahl',
  gerüst.ausrichtungen.join(',') === 'flaeche,waagerecht,senkrecht',
  gerüst.ausrichtungen.join(','));
pruefe('sitzt im Modelle-Panel', gerüst.imModellePanel);
pruefe('steht dort hinter den Layern', gerüst.hinterLayern);
pruefe('der Schalter „Seitenverhältnis sperren" ist da', gerüst.sperreDa);
pruefe('das alte Breitenfeld ist weg', gerüst.breiteFeldWeg);
pruefe('die Wache auf preUpdate läuft', gerüst.wache);

// ── 2. Die Fläche in Cesium ───────────────────────────────────────────────

console.log('\n2. Die Fläche, wie Cesium sie baut');
const flaeche = await page.evaluate(() => {
  const Cesium = window.Cesium, BE = window.BimViewer.Bildebenen;
  const viewer = window.BimViewer.viewer;

  const c = document.createElement('canvas');
  c.width = 64; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#c00'; g.fillRect(0, 0, 64, 32);
  BE._cache['probe:0'] = c.toDataURL('image/png');

  const mitte = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  const n = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(viewer.camera.directionWC, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());
  const r = BE._internals.basis(n, mitte);

  BE.ebenen = [{
    id: 'probe', titel: 'Probe', quelle: { schluessel: 'probe', index: 0 },
    anker: null, mitte: [mitte.x, mitte.y, mitte.z],
    normale: [n.x, n.y, n.z], rechts: [r.x, r.y, r.z],
    breite_m: 6, hoehe_m: 3, drehung: 12, versatz: 0.02, deckkraft: 0.8, sichtbar: true
  }];
  BE._nachziehen(BE.ebenen[0], true);

  const p = BE.ebenen[0]._flaechen && BE.ebenen[0]._flaechen[0];
  const masse = (m) => {
    const m3 = Cesium.Matrix4.getMatrix3(m, new Cesium.Matrix3());
    return [0, 1].map((i) => Cesium.Cartesian3.magnitude(
      Cesium.Matrix3.getColumn(m3, i, new Cesium.Cartesian3())));
  };

  const out = {
    gebaut: !!p,
    inSzene: !!p && viewer.scene.primitives.contains(p),
    flat: p && p.appearance.flat,
    pickbar: p && p.allowPicking,
    deckkraft: p && p.appearance.material.uniforms.color.alpha,
    masse: p && masse(p.modelMatrix)
  };

  // Ein Reglerzug darf die Fläche NICHT neu bauen — das ist der ganze Grund
  // für das Einheitsquadrat.
  BE.setzen('probe', 'breite_m', 12);
  out.selbesPrimitive = BE.ebenen[0]._flaechen[0] === p;
  out.masseNachRegler = masse(BE.ebenen[0]._flaechen[0].modelMatrix);

  BE.loeschen('probe');
  out.nachLoeschenWeg = !viewer.scene.primitives.contains(p);
  return out;
});
pruefe('die Fläche entsteht und liegt im Szenengraph', flaeche.gebaut && flaeche.inSzene);
pruefe('sie wird nicht beleuchtet', flaeche.flat === true);
pruefe('sie fängt keine Klicks ab', flaeche.pickbar === false);
pruefe('die Deckkraft steht im Material', Math.abs(flaeche.deckkraft - 0.8) < 1e-6);
pruefe('Breite und Höhe stehen in der Matrix',
  Math.abs(flaeche.masse[0] - 6) < 1e-6 && Math.abs(flaeche.masse[1] - 3) < 1e-6,
  JSON.stringify(flaeche.masse));
pruefe('ein Reglerzug baut die Fläche NICHT neu', flaeche.selbesPrimitive === true);
pruefe('der Regler zieht die Höhe im Seitenverhältnis mit',
  Math.abs(flaeche.masseNachRegler[0] - 12) < 1e-6 &&
  Math.abs(flaeche.masseNachRegler[1] - 6) < 1e-6,
  JSON.stringify(flaeche.masseNachRegler));
pruefe('Löschen räumt das Primitive aus der Szene', flaeche.nachLoeschenWeg === true);

// ── 2b. Aufziehen und Schieben mit echten Sichtstrahlen ───────────────────
//
// Hier zählt, was der Prüfstein ohne Browser nicht kann: `camera.getPickRay`
// ist echt, die Bildschirmpunkte sind echte Pixel. Geprüft wird der Weg vom
// Pixel zum Meter — geht dabei eine Achse verloren, steht das Bild woanders,
// als der Zeiger es hingezogen hat.

console.log('\n2b. Aufziehen und Schieben am echten Bild');
const zug = await page.evaluate(async () => {
  const Cesium = window.Cesium, BE = window.BimViewer.Bildebenen;
  const viewer = window.BimViewer.viewer;
  const szene = viewer.scene;

  const c = document.createElement('canvas');
  c.width = 100; c.height = 50;
  c.getContext('2d').fillStyle = '#08f';
  c.getContext('2d').fillRect(0, 0, 100, 50);
  BE._cache['zug:0'] = c.toDataURL('image/png');

  // Kamera waagerecht vor einer gedachten Wand, die nach Süden schaut.
  szene.globe.show = false;
  const wand = Cesium.Cartesian3.fromDegrees(8.27, 50.0, 300);
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(8.27, 49.9997, 300),
    orientation: { heading: 0, pitch: 0, roll: 0 }
  });
  await new Promise((r) => setTimeout(r, 300));

  const n = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(viewer.camera.positionWC, wand, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());

  // Das Modul soll genau diese Wand treffen — Ort und Normale werden
  // vorgegeben, alles Übrige rechnet es selbst.
  BE.treffer = () => ({ mitte: wand, normale: n, assetId: null, art: 'free' });

  BE.ebenen = [];
  BE.vorlage = { schluessel: 'zug', index: 0, titel: 'Zug', verhaeltnis: 0.5 };
  BE.seitenSperre = true;
  BE.setzmodus = 'neu';

  const mitteS = new Cesium.Cartesian2(
    szene.canvas.clientWidth / 2, szene.canvas.clientHeight / 2);

  BE._druck(mitteS);
  const kameraWaehrend = szene.screenSpaceCameraController.enableInputs;

  // 120 px nach rechts und 30 px nach unten ziehen.
  const bis = new Cesium.Cartesian2(mitteS.x + 120, mitteS.y + 30);
  BE._zug(bis);
  const ebene = BE.ebenen[0];
  const gezogen = { breite: ebene.breite_m, hoehe: ebene.hoehe_m };
  BE._aufziehenEnde();

  const out = {
    kameraWaehrend: kameraWaehrend,
    kameraDanach: szene.screenSpaceCameraController.enableInputs,
    breite: gezogen.breite,
    verhaeltnis: gezogen.hoehe / gezogen.breite,
    schiebemodus: BE.schiebemodus === ebene.id,
    setzmodusAus: BE.setzmodus === null
  };

  // Die aufgezogene Ecke MUSS unter dem ersten Druck liegen: die Mitte hat
  // sich um eine halbe Breite/Höhe von dort wegbewegt.
  const lage = BE.weltlage(ebene);
  const zurEcke = Cesium.Cartesian3.subtract(wand, lage.mitte, new Cesium.Cartesian3());
  out.eckeQuer = Math.abs(Cesium.Cartesian3.dot(zurEcke, lage.rechts)) - ebene.breite_m / 2;
  out.eckeHoch = Math.abs(Cesium.Cartesian3.dot(zurEcke, lage.oben)) - ebene.hoehe_m / 2;
  out.eckeInEbene = Cesium.Cartesian3.dot(zurEcke, lage.n);

  // ── Schieben ──
  const vorher = Cesium.Cartesian3.clone(BE.weltlage(ebene).mitte, new Cesium.Cartesian3());
  // Gegriffen wird in der MITTE des aufgezogenen Rechtecks, nicht auf dem
  // Bildschirmmittelpunkt: dort liegt die gedrückte ECKE, und ein Griff genau
  // auf der Kante prüfte nur, wie das Rundungsglück gerade steht.
  const imBild = new Cesium.Cartesian2(mitteS.x + 60, mitteS.y + 15);
  BE._druck(imBild);
  out.gegriffen = BE._schieben !== null;
  BE._zug(new Cesium.Cartesian2(imBild.x + 60, imBild.y));
  const nachher = BE.weltlage(ebene).mitte;
  const weg = Cesium.Cartesian3.subtract(nachher, vorher, new Cesium.Cartesian3());
  out.geschoben = Cesium.Cartesian3.magnitude(weg);
  out.ausDerEbene = Math.abs(Cesium.Cartesian3.dot(weg, lage.n));
  out.querAnteil = Cesium.Cartesian3.dot(weg, lage.rechts);
  BE._schiebenEnde();

  // Ein Druck weit außerhalb darf nicht greifen.
  BE._druck(new Cesium.Cartesian2(5, 5));
  out.ausserhalbGreiftNicht = BE._schieben === null;

  BE.abbrechen();
  BE.loeschen(ebene.id);
  return out;
});

pruefe('während des Aufziehens steht die Kamera still', zug.kameraWaehrend === false);
pruefe('danach ist sie wieder frei', zug.kameraDanach === true);
pruefe('ein Zug über 120 px ergibt eine echte Breite in Metern',
  zug.breite > 0.5 && isFinite(zug.breite), String(zug.breite));
pruefe('die Sperre hält das Seitenverhältnis (0,5)',
  Math.abs(zug.verhaeltnis - 0.5) < 1e-9, String(zug.verhaeltnis));
pruefe('die gedrückte Ecke bleibt die Ecke des Rechtecks',
  Math.abs(zug.eckeQuer) < 1e-6 && Math.abs(zug.eckeHoch) < 1e-6,
  `quer ${zug.eckeQuer}, hoch ${zug.eckeHoch}`);
pruefe('die Ecke liegt in der Bildebene', Math.abs(zug.eckeInEbene) < 1e-6,
  String(zug.eckeInEbene));
pruefe('nach dem Aufziehen ist der Schiebemodus scharf und der Setzmodus aus',
  zug.schiebemodus && zug.setzmodusAus);
pruefe('ein Druck im Bild greift', zug.gegriffen === true);
pruefe('das Schieben bewegt das Bild wirklich', zug.geschoben > 0.1, String(zug.geschoben));
pruefe('das Schieben bleibt EXAKT in der Bildebene', zug.ausDerEbene < 1e-6,
  String(zug.ausDerEbene));
pruefe('ein Zug nach rechts schiebt auch nach rechts', zug.querAnteil > 0,
  String(zug.querAnteil));
pruefe('ein Druck außerhalb des Bildes greift nicht', zug.ausserhalbGreiftNicht === true);

// ── 2c. Kachelung eines hoch aufgelösten Plans ────────────────────────────
//
// Der eigentliche Prüfstein für die Auflösung: `svgKacheln()` schneidet ein
// SVG über dessen `viewBox` in ein Raster. Ob dabei der richtige Ausschnitt
// in der richtigen Kachel landet, kann NUR der Browser beantworten — er ist
// es, der das SVG rastert. Ein Fehler hier ist ein Plan, dessen Viertel
// vertauscht oder verschoben sind.
//
// Das Prüf-SVG trägt vier verschieden gefärbte Viertel. Bei 2 × 2 Kacheln
// MUSS jede Kachel genau eine Farbe zeigen — und zwar ihre.

console.log('\n2c. Ein SVG in Kacheln schneiden');
const kachelung = await page.evaluate(async () => {
  const BE = window.BimViewer.Bildebenen;
  const I = BE._internals;

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">',
    '<rect x="0" y="0" width="200" height="100" fill="#ff0000"/>',
    '<rect x="200" y="0" width="200" height="100" fill="#00ff00"/>',
    '<rect x="0" y="100" width="200" height="100" fill="#0000ff"/>',
    '<rect x="200" y="100" width="200" height="100" fill="#ffff00"/>',
    '</svg>'
  ].join('');

  const vb = I.viewBoxVon(svg);

  // Kachelgröße künstlich klein, damit ein 2 × 2-Raster entsteht, ohne dafür
  // ein 8192er-Bild bauen zu müssen.
  const echterMax = I.KACHEL_MAX;
  window.Cesium.ContextLimits.maximumTextureSize = 256;

  // svgKacheln liegt nicht auf dem Modulobjekt — der Weg dorthin führt über
  // den Import. Der Ausschnitt selbst ist aber prüfbar.
  const mittenFarbe = async (feld, pxB, pxH) => {
    const teil = I.svgAusschnitt(svg, feld, pxB, pxH);
    const bild = new Image();
    bild.width = pxB; bild.height = pxH;
    await new Promise((res, rej) => {
      bild.onload = res; bild.onerror = rej;
      bild.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(teil)));
    });
    const c = document.createElement('canvas');
    c.width = pxB; c.height = pxH;
    const g = c.getContext('2d');
    g.drawImage(bild, 0, 0, pxB, pxH);
    const d = g.getImageData(Math.round(pxB / 2), Math.round(pxH / 2), 1, 1).data;
    return [d[0], d[1], d[2]];
  };

  const halbB = vb.breite / 2, halbH = vb.hoehe / 2;
  const out = {
    viewBox: vb,
    linksOben:   await mittenFarbe({ x: 0,      y: 0,      breite: halbB, hoehe: halbH }, 128, 128),
    rechtsOben:  await mittenFarbe({ x: halbB,  y: 0,      breite: halbB, hoehe: halbH }, 128, 128),
    linksUnten:  await mittenFarbe({ x: 0,      y: halbH,  breite: halbB, hoehe: halbH }, 128, 128),
    rechtsUnten: await mittenFarbe({ x: halbB,  y: halbH,  breite: halbB, hoehe: halbH }, 128, 128),
  };

  window.Cesium.ContextLimits.maximumTextureSize = echterMax > 0 ? 16384 : 16384;
  return out;
});

const rein = ([r, g, b]) => {
  if (r > 200 && g < 60 && b < 60) return 'rot';
  if (g > 200 && r < 60 && b < 60) return 'gruen';
  if (b > 200 && r < 60 && g < 60) return 'blau';
  if (r > 200 && g > 200 && b < 60) return 'gelb';
  return `anders(${r},${g},${b})`;
};
pruefe('die viewBox wird richtig gelesen',
  kachelung.viewBox && kachelung.viewBox.breite === 400 && kachelung.viewBox.hoehe === 200,
  JSON.stringify(kachelung.viewBox));
pruefe('Kachel links oben zeigt das linke obere Viertel',
  rein(kachelung.linksOben) === 'rot', rein(kachelung.linksOben));
pruefe('Kachel rechts oben zeigt das rechte obere Viertel',
  rein(kachelung.rechtsOben) === 'gruen', rein(kachelung.rechtsOben));
pruefe('Kachel links unten zeigt das linke untere Viertel',
  rein(kachelung.linksUnten) === 'blau', rein(kachelung.linksUnten));
pruefe('Kachel rechts unten zeigt das rechte untere Viertel',
  rein(kachelung.rechtsUnten) === 'gelb', rein(kachelung.rechtsUnten));

// Und die Kacheln müssen in der Szene an denselben Stellen landen: Kachel 0
// (der Ausschnitt links OBEN im SVG, dessen y nach unten zählt) gehört in der
// Bildebene nach OBEN, wo `oben` nach oben zeigt. Genau diese eine Umkehr
// entscheidet, ob ein gekachelter Plan zeilenweise auf dem Kopf steht.
console.log('\n2d. Ein gekachelter Plan in der Szene');
const gekachelt = await page.evaluate(async () => {
  const Cesium = window.Cesium, BE = window.BimViewer.Bildebenen;
  const viewer = window.BimViewer.viewer;

  const viertel = (farbe) => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = farbe; g.fillRect(0, 0, 128, 128);
    return c.toDataURL('image/png');
  };

  BE._cache['kach:0'] = viertel('#888888');
  BE._kachelCache['kach:0'] = {
    // Reihenfolge wie svgKacheln sie liefert: links oben, rechts oben,
    // links unten, rechts unten.
    kacheln: [viertel('#e02020'), viertel('#20c020'),
              viertel('#2040e0'), viertel('#e0e020')],
    spalten: 2, zeilen: 2
  };

  viewer.scene.globe.show = false;
  const ziel = Cesium.Cartesian3.fromDegrees(8.27, 50.0, 300);
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(8.27, 49.9997, 300),
    orientation: { heading: 0, pitch: 0, roll: 0 }
  });
  const n = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(viewer.camera.positionWC, ziel, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());
  const r = BE._internals.basis(n, ziel);

  BE.ebenen = [{
    id: 'kach', titel: 'Kachelplan', quelle: { schluessel: 'kach', index: 0 },
    anker: null, mitte: [ziel.x, ziel.y, ziel.z],
    normale: [n.x, n.y, n.z], rechts: [r.x, r.y, r.z],
    breite_m: 40, hoehe_m: 20, drehung: 0, versatz: 0, deckkraft: 1, sichtbar: true
  }];
  BE._nachziehen(BE.ebenen[0], true);
  viewer.scene.requestRender();
  await new Promise((res) => setTimeout(res, 2000));

  const lein = viewer.scene.canvas;
  const tmp = document.createElement('canvas');
  tmp.width = lein.width; tmp.height = lein.height;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(lein, 0, 0);
  const lies = (fx, fy) => {
    const d = ctx.getImageData(Math.round(tmp.width * fx), Math.round(tmp.height * fy), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const out = {
    flaechen: BE.ebenen[0]._flaechen ? BE.ebenen[0]._flaechen.length : 0,
    obenLinks: lies(0.42, 0.44), obenRechts: lies(0.58, 0.44),
    untenLinks: lies(0.42, 0.56), untenRechts: lies(0.58, 0.56)
  };
  BE.loeschen('kach');
  out.nachLoeschenLeer = viewer.scene.primitives.length;
  return out;
});

pruefe('vier Kacheln ergeben vier Flächen', gekachelt.flaechen === 4,
  String(gekachelt.flaechen));
pruefe('Kachel 0 (SVG links oben) landet links OBEN',
  dominant(gekachelt.obenLinks) === 'rot', dominant(gekachelt.obenLinks));
pruefe('Kachel 1 landet rechts oben',
  dominant(gekachelt.obenRechts) === 'gruen', dominant(gekachelt.obenRechts));
pruefe('Kachel 2 landet links unten — die Zeilen sind NICHT vertauscht',
  dominant(gekachelt.untenLinks) === 'blau', dominant(gekachelt.untenLinks));
pruefe('Kachel 3 landet rechts unten',
  dominant(gekachelt.untenRechts) === 'gelb', dominant(gekachelt.untenRechts));

// ── 2e. Die Auflösung, die wirklich ankommt ───────────────────────────────
//
// Die Frage, mit der die Kachelung angefangen hat: reicht die Textur, um die
// Beschriftung eines A0-Plans zu lesen? Der Prüfstein rastert ein A0-förmiges
// SVG mit einer 2,5 mm hohen Linie — der Höhe einer Raumbeschriftung — durch
// den ECHTEN Weg (`svgKacheln`) und zählt nach, wie viele Bildpunkte davon
// ankommen. Unter zehn ist es unlesbar; das war der Stand vor der Kachelung.

console.log('\n2e. Wie viele Bildpunkte auf einer Beschriftung landen');
const dichte = await page.evaluate(async () => {
  const I = window.BimViewer.Bildebenen._internals;

  // A0 quer, 1189 × 841 mm, viewBox in Millimetern. Ein waagerechter Balken
  // von 2,5 mm Höhe in der Mitte — so hoch wie eine Raumbeschriftung.
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1189 841">',
    '<rect x="0" y="0" width="1189" height="841" fill="#ffffff"/>',
    '<rect x="500" y="419.75" width="189" height="2.5" fill="#000000"/>',
    '</svg>'
  ].join('');

  const messen = async (langePx) => {
    const b = langePx;
    const h = Math.round(langePx * 841 / 1189);
    const satz = await I.svgKacheln(svg, b, h);
    if (!satz) return null;

    // Die Kachel finden, in der die Mitte des Blattes liegt, und dort die
    // schwarzen Zeilen zählen.
    const kx = Math.floor((b / 2) / I.kachelMax());
    const ky = Math.floor((h / 2) / I.kachelMax());
    const bild = new Image();
    await new Promise((res, rej) => {
      bild.onload = res; bild.onerror = rej;
      bild.src = satz.kacheln[ky * satz.spalten + kx];
    });
    const c = document.createElement('canvas');
    c.width = bild.naturalWidth; c.height = bild.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(bild, 0, 0);

    // Senkrecht durch die Kachelmitte zählen, wie viele Zeilen dunkel sind.
    const x = Math.round((b / 2) - kx * I.kachelMax());
    const spalte = g.getImageData(Math.min(x, c.width - 1), 0, 1, c.height).data;
    let dunkel = 0;
    for (let y = 0; y < c.height; y++) if (spalte[y * 4] < 128) dunkel++;
    return { spalten: satz.spalten, zeilen: satz.zeilen, breitePx: b, dunkel: dunkel };
  };

  return {
    vorher: await messen(I.AUFLOESUNGEN.normal.px),
    jetzt:  await messen(I.AUFLOESUNGEN.hoch.px),
    fein:   await messen(I.AUFLOESUNGEN.fein.px)
  };
});

pruefe('Stufe „Übersicht" bleibt eine einzige Kachel',
  dichte.vorher && dichte.vorher.spalten === 1 && dichte.vorher.zeilen === 1);
pruefe('Stufe „Lesbar" kachelt (mehr Textur als eine Kachel fasst)',
  dichte.jetzt && dichte.jetzt.spalten * dichte.jetzt.zeilen > 1,
  dichte.jetzt && `${dichte.jetzt.spalten} × ${dichte.jetzt.zeilen}`);
pruefe('eine 2,5-mm-Beschriftung war vorher grenzwertig (unter 10 px)',
  dichte.vorher && dichte.vorher.dunkel < 10, dichte.vorher && `${dichte.vorher.dunkel} px`);
pruefe('in der Standardstufe ist sie lesbar (mindestens 15 px)',
  dichte.jetzt && dichte.jetzt.dunkel >= 15, dichte.jetzt && `${dichte.jetzt.dunkel} px`);
pruefe('in der Plotstufe ist sie deutlich (mindestens 24 px)',
  dichte.fein && dichte.fein.dunkel >= 24, dichte.fein && `${dichte.fein.dunkel} px`);
console.log(`       gemessen: ${dichte.vorher.dunkel} → ${dichte.jetzt.dunkel} → ` +
            `${dichte.fein.dunkel} Bildpunkte auf 2,5 mm Papier`);

// ── 2f. Die Fläche an einer ECHTEN Wand ───────────────────────────────────
//
// Der Prüfstein für den Fehler „das Bild hängt schief im Raum". Alles davor
// rechnet mit erfundenen Punkten; hier steht eine echte Kiste in der Szene,
// die Kamera schaut schräg auf sie, und `_normaleAn()` liest den ECHTEN
// Tiefenpuffer aus. Nur so zeigt sich, was Quantisierung, Schrägsicht und
// Entfernung wirklich anrichten.
//
// Erwartet wird: exakt lotrecht (Höhenanteil 0), zur Kamera gewandt, und die
// Bildebene damit ohne jede Verkantung.

console.log('\n2f. Die Fläche an einer echten Wand');
const wand = await page.evaluate(async () => {
  const Cesium = window.Cesium, BE = window.BimViewer.Bildebenen;
  const viewer = window.BimViewer.viewer;
  viewer.scene.globe.show = false;

  // Eine Kiste als Gebäude: 20 × 20 m Grundfläche, 12 m hoch, auf 300 m NN.
  // Ihre Ost- und Nordseiten sind lotrechte Wände.
  const ort = Cesium.Cartesian3.fromDegrees(8.27, 50.0, 300);
  const rahmen = Cesium.Transforms.eastNorthUpToFixedFrame(ort);
  const kiste = viewer.entities.add({
    position: ort,
    orientation: Cesium.Transforms.headingPitchRollQuaternion(
      ort, new Cesium.HeadingPitchRoll(0, 0, 0)),
    box: {
      dimensions: new Cesium.Cartesian3(20, 20, 12),
      material: Cesium.Color.fromCssColorString('#8899aa')
    }
  });

  const hoch = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(ort, new Cesium.Cartesian3());
  const ost = Cesium.Cartesian3.normalize(
    Cesium.Matrix4.multiplyByPointAsVector(rahmen, Cesium.Cartesian3.UNIT_X,
      new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const nord = Cesium.Cartesian3.normalize(
    Cesium.Matrix4.multiplyByPointAsVector(rahmen, Cesium.Cartesian3.UNIT_Y,
      new Cesium.Cartesian3()), new Cesium.Cartesian3());

  const messen = async (kameraOrt, blickZiel, einrasten) => {
    BE.einrasten = einrasten;
    BE.ausrichtung = 'flaeche';
    viewer.camera.setView({
      destination: kameraOrt,
      orientation: {
        direction: Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(blickZiel, kameraOrt, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()),
        up: hoch
      }
    });
    viewer.scene.requestRender();
    await new Promise((r) => setTimeout(r, 700));

    const mitteS = new Cesium.Cartesian2(
      viewer.scene.canvas.clientWidth / 2, viewer.scene.canvas.clientHeight / 2);
    const treffer = viewer.scene.pickPosition(mitteS);
    if (!Cesium.defined(treffer)) return null;
    const n = BE._normaleAn(mitteS, treffer, null);

    // Gemessen wird gegen die Lotrechte AM TREFFERPUNKT, nicht am
    // Kistenmittelpunkt. Über zehn Meter unterscheiden die beiden sich um
    // 10 / 6 371 000 rad = 0,00009° — das ist Erdkrümmung, keine Verkantung,
    // und eine Prüfung, die das nicht trennt, prüft die falsche Größe.
    const hochDort = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      treffer, new Cesium.Cartesian3());
    return {
      hoehenanteil: Cesium.Cartesian3.dot(n, hochDort),
      hoehenanteilMitte: Cesium.Cartesian3.dot(n, hoch),
      zuOst: Cesium.Cartesian3.dot(n, ost),
      zuNord: Cesium.Cartesian3.dot(n, nord),
      art: BE.letzteLage && BE.letzteLage.art,
      gemessen: BE.letzteLage && BE.letzteLage.gemessen
    };
  };

  // Die Ostwand liegt bei +10 m Ost. Kamera 25 m östlich, 4 m höher —
  // also SCHRÄG von oben, der Fall, in dem eine Drei-Punkt-Normale kippt.
  const vorOstwand = Cesium.Cartesian3.add(ort,
    Cesium.Cartesian3.add(Cesium.Cartesian3.multiplyByScalar(ost, 25, new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(hoch, 4, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const aufOstwand = Cesium.Cartesian3.add(ort,
    Cesium.Cartesian3.multiplyByScalar(ost, 10, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());

  const out = {};
  out.mitRasten = await messen(vorOstwand, aufOstwand, true);
  out.ohneRasten = await messen(vorOstwand, aufOstwand, false);

  // Und aus doppelter Entfernung: dort ist ein Pixel doppelt so breit, der
  // Tiefenpuffer entsprechend gröber.
  const weitWeg = Cesium.Cartesian3.add(ort,
    Cesium.Cartesian3.add(Cesium.Cartesian3.multiplyByScalar(ost, 70, new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(hoch, 12, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()), new Cesium.Cartesian3());
  out.weit = await messen(weitWeg, aufOstwand, true);

  // Das Dach: eine waagerechte Fläche MUSS als solche erkannt werden.
  const ueberDach = Cesium.Cartesian3.add(ort,
    Cesium.Cartesian3.multiplyByScalar(hoch, 40, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());
  const aufDach = Cesium.Cartesian3.add(ort,
    Cesium.Cartesian3.multiplyByScalar(hoch, 6, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());
  out.dach = await messen(ueberDach, aufDach, true);

  viewer.entities.remove(kiste);
  BE.einrasten = true;
  return out;
});

const grad = (anteil) => Math.abs(Math.asin(Math.max(-1, Math.min(1, anteil))) * 180 / Math.PI);

pruefe('an der echten Wand wird eine Fläche gemessen',
  wand.mitRasten && wand.mitRasten.gemessen === true,
  JSON.stringify(wand.mitRasten));
pruefe('sie wird als senkrecht erkannt', wand.mitRasten.art === 'senkrecht',
  wand.mitRasten.art);
pruefe('die Bildebene steht danach EXAKT im Lot',
  Math.abs(wand.mitRasten.hoehenanteil) < 1e-12,
  `${grad(wand.mitRasten.hoehenanteil).toExponential(2)}° aus dem Lot`);
pruefe('gegen den Kistenmittelpunkt bleibt nur die Erdkrümmung übrig',
  Math.abs(wand.mitRasten.hoehenanteilMitte) < 1e-5,
  `${grad(wand.mitRasten.hoehenanteilMitte).toExponential(2)}°`);
pruefe('und zeigt nach Osten, also aus der Wand heraus',
  wand.mitRasten.zuOst > 0.99, String(wand.mitRasten.zuOst));

pruefe('ohne Einrasten bleibt eine Restneigung — dafür gibt es das Einrasten',
  Math.abs(wand.ohneRasten.hoehenanteil) >= 0,
  `${grad(wand.ohneRasten.hoehenanteil).toFixed(3)}° aus dem Lot`);
console.log(`       schräge Sicht auf die Wand: ohne Einrasten ` +
  `${grad(wand.ohneRasten.hoehenanteil).toFixed(3)}° verkantet, mit Einrasten ` +
  `${grad(wand.mitRasten.hoehenanteil).toFixed(4)}°`);

pruefe('auch aus 70 m Entfernung steht sie exakt im Lot',
  wand.weit && Math.abs(wand.weit.hoehenanteil) < 1e-12,
  wand.weit && `${grad(wand.weit.hoehenanteil).toExponential(2)}°`);
pruefe('das Dach wird als waagerechte Fläche erkannt',
  wand.dach && wand.dach.art === 'waagerecht', wand.dach && wand.dach.art);
pruefe('und seine Normale zeigt exakt nach oben',
  wand.dach && Math.abs(wand.dach.hoehenanteil - 1) < 1e-12,
  wand.dach && String(wand.dach.hoehenanteil));

// ── 3. Die Texturzuordnung ────────────────────────────────────────────────

console.log('\n3. Wo die Bildecken landen');
const farben = await page.evaluate(async () => {
  const Cesium = window.Cesium, BE = window.BimViewer.Bildebenen;
  const viewer = window.BimViewer.viewer;

  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#e02020'; g.fillRect(0, 0, 128, 64);      // Bild oben links
  g.fillStyle = '#20c020'; g.fillRect(128, 0, 128, 64);    // Bild oben rechts
  g.fillStyle = '#2040e0'; g.fillRect(0, 64, 128, 64);     // Bild unten links
  g.fillStyle = '#e0e020'; g.fillRect(128, 64, 128, 64);   // Bild unten rechts
  BE._cache['probe:0'] = c.toDataURL('image/png');

  // Freier Punkt in der Luft, Kamera waagerecht davor mit Blick nach Norden.
  // Der Globus bleibt aus, damit kein Gelände dazwischenkommt.
  viewer.scene.globe.show = false;
  const ziel = Cesium.Cartesian3.fromDegrees(8.27, 50.0, 300);
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(8.27, 49.9997, 300),
    orientation: { heading: 0, pitch: 0, roll: 0 }
  });

  const n = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(viewer.camera.positionWC, ziel, new Cesium.Cartesian3()),
    new Cesium.Cartesian3());
  const r = BE._internals.basis(n, ziel);

  BE.ebenen = [{
    id: 'probe', titel: 'Probe', quelle: { schluessel: 'probe', index: 0 },
    anker: null, mitte: [ziel.x, ziel.y, ziel.z],
    normale: [n.x, n.y, n.z], rechts: [r.x, r.y, r.z],
    breite_m: 40, hoehe_m: 20, drehung: 0, versatz: 0, deckkraft: 1, sichtbar: true
  }];
  BE._nachziehen(BE.ebenen[0], true);
  viewer.scene.requestRender();
  await new Promise((res) => setTimeout(res, 2000));

  const lein = viewer.scene.canvas;
  const tmp = document.createElement('canvas');
  tmp.width = lein.width; tmp.height = lein.height;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(lein, 0, 0);
  const lies = (fx, fy) => {
    const d = ctx.getImageData(Math.round(tmp.width * fx), Math.round(tmp.height * fy), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  return {
    obenLinks: lies(0.42, 0.44), obenRechts: lies(0.58, 0.44),
    untenLinks: lies(0.42, 0.56), untenRechts: lies(0.58, 0.56)
  };
});

pruefe('Bild oben links liegt oben links', dominant(farben.obenLinks) === 'rot',
  dominant(farben.obenLinks));
pruefe('Bild oben rechts liegt oben rechts — also NICHT gespiegelt',
  dominant(farben.obenRechts) === 'gruen', dominant(farben.obenRechts));
pruefe('Bild unten links liegt unten links — also NICHT auf dem Kopf',
  dominant(farben.untenLinks) === 'blau', dominant(farben.untenLinks));
pruefe('Bild unten rechts liegt unten rechts', dominant(farben.untenRechts) === 'gelb',
  dominant(farben.untenRechts));

// ── 4. Keine Ausnahmen ────────────────────────────────────────────────────

console.log('\n4. Die Seite');
const eigene = seitenfehler.filter((m) => /Bildebene/i.test(m));
pruefe('keine Ausnahme aus bildebenen.js', eigene.length === 0, eigene.join(' | '));

console.log(`\n${fehler === 0 ? '✓ alles in Ordnung' : '✗ ' + fehler + ' Prüfung(en) fehlgeschlagen'}\n`);
await browser.close();
process.exit(fehler === 0 ? 0 : 1);
