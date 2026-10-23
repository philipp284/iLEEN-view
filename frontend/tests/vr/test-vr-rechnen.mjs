// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Die Rechnungen der VR-Seite ohne Browser und ohne Brille.
//
// Aufruf:  node tests/vr/test-vr-rechnen.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import {
  VR_FAEHIG, backendBasis, startAbstand, tischMassstab, begehbar, punktBegehbar,
  totzone, schrittDrehung, schwebeFolgen, bauteilZeilen, ifcName,
  filterNeu, filterLeer, bauteilSichtbar, geschossRang, geschosseSortieren,
  wertText, eigenschaftsGruppen, meterText, messung, STUFE, bodenNachfuehren, fussRechteck, imFuss,
  DOP_LAENDER, KARTEN, GELAENDE, kachelMerc, kachelGrad, mercPixel, pixelGrad, meterProPixel,
  schichtPasst, schichtQuelle, kartenVermerke, inDeutschland,
} from '../../vr-rechnen.js';

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
}
const nahe = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Backend-Adresse ─────────────────────────────────────────────
const seite = (url) => { const u = new URL(url); return { host: u.hostname, protokoll: u.protocol, ursprung: u.origin }; };
pruefe('am Mac bleibt localhost',
  backendBasis(null, 'http://localhost:8100', seite('http://localhost:5181/vr.html')) === 'http://localhost:8100');
pruefe('über adb reverse bleibt localhost',
  backendBasis(null, 'http://localhost:8100/', seite('http://localhost:5181/vr.html')) === 'http://localhost:8100');
const wlan = backendBasis(null, 'http://localhost:8100', seite('http://192.168.0.9:5181/vr.html'));
pruefe('WLAN über http: localhost zeigt auf den Rechner der Seite', wlan === 'http://192.168.0.9:8100', wlan);
const https = backendBasis(null, 'http://localhost:8100', seite('https://192.168.0.9:5443/vr.html'));
pruefe('WLAN über https: Backend durch den Dev-Server (kein Mixed Content)',
  https === 'https://192.168.0.9:5443/backend', https);
pruefe('https über den Bonjour-Namen ebenso',
  backendBasis(null, 'http://localhost:8100', seite('https://macbook.local:5443/')) === 'https://macbook.local:5443/backend');
pruefe('127.0.0.1 ebenso',
  backendBasis(null, 'http://127.0.0.1:8100', seite('http://192.168.0.9:5181/')) === 'http://192.168.0.9:8100');
pruefe('gespeicherte Adresse geht vor',
  backendBasis('https://ileen.example.org/api', 'http://localhost:8100', seite('https://192.168.0.9:5443/')) === 'https://ileen.example.org/api');
pruefe('fremder Server bleibt unangetastet',
  backendBasis(null, 'http://server.lan:8100', seite('http://192.168.0.9:5181/')) === 'http://server.lan:8100');
pruefe('leer bleibt leer', backendBasis(null, '', seite('http://localhost:5181/')) === '');

// ── Startpunkt und Tischmodell ──────────────────────────────────
pruefe('kleines Haus: mindestens 4 m Abstand', startAbstand(5, 4) === 4);
pruefe('Halle 30 m: 18 m Abstand', nahe(startAbstand(15, 30), 18));
pruefe('Campus: höchstens 80 m', startAbstand(400, 300) === 80);
pruefe('Tischmodell: 30-m-Halle wird 70 cm', nahe(tischMassstab(15, 10, 30) * 30, 0.7));
pruefe('Tischmodell: nie größer als 1:1', tischMassstab(0.2, 0.1, 0.3) === 1);
pruefe('Tischmodell: leerer Kasten bleibt 1:1', tischMassstab(0, 0, 0) === 1);

// ── Landeplätze ─────────────────────────────────────────────────
pruefe('Decke ist Landeplatz', begehbar(1));
pruefe('Treppe (35°) ist Landeplatz', begehbar(Math.cos(35 * Math.PI / 180)));
pruefe('Wand ist keiner', !begehbar(0));
pruefe('Dach mit 60° ist keiner', !begehbar(Math.cos(60 * Math.PI / 180)));
pruefe('Punkt am Boden ist Landeplatz', punktBegehbar(0.05, 1.7));
pruefe('Punkt in Augenhöhe ist keiner', !punktBegehbar(1.6, 1.7));

// ── Sticks ──────────────────────────────────────────────────────
pruefe('Ruhezittern bewegt nichts', totzone(0.1) === 0 && totzone(-0.15) === 0);
pruefe('voller Ausschlag bleibt 1', totzone(1) === 1 && totzone(-1) === -1);
pruefe('halber Ausschlag gestreckt', nahe(totzone(0.575), 0.5));

let d = schrittDrehung(0.9, true);
pruefe('Ausschlag nach rechts dreht nach rechts (negativ)', nahe(d.winkel, -Math.PI / 6) && d.gespannt === false);
d = schrittDrehung(0.9, d.gespannt);
pruefe('gehaltener Stick dreht nicht weiter', d.winkel === 0 && d.gespannt === false);
d = schrittDrehung(0.1, d.gespannt);
pruefe('zurück zur Mitte spannt wieder', d.winkel === 0 && d.gespannt === true);
d = schrittDrehung(-0.95, d.gespannt);
pruefe('Ausschlag nach links dreht nach links', nahe(d.winkel, Math.PI / 6));

// ── Schwebendes Tablet (Brille ohne Controller) ─────────────────
let sw = schwebeFolgen({ gier: 0, folgt: false }, 0.5, 0.016);
pruefe('Tablet bleibt stehen, solange man sich unter 0,8 rad wegdreht', sw.gier === 0 && !sw.folgt);
sw = schwebeFolgen({ gier: 0, folgt: false }, 1.2, 0.016);
pruefe('weiter weggedreht: es folgt, weich', sw.folgt && sw.gier > 0 && sw.gier < 0.1, JSON.stringify(sw));
for (let i = 0; i < 200; i++) sw = schwebeFolgen(sw, 1.2, 0.016);
pruefe('es kommt vorn an und hört auf zu folgen', nahe(sw.gier, 1.2, 0.03) && !sw.folgt, JSON.stringify(sw));
sw = schwebeFolgen({ gier: 3.0, folgt: false }, -3.0, 0.016);
pruefe('über ±π hinweg der kurze Weg (0,28 rad) — kein Folgen', sw.gier === 3.0 && !sw.folgt);
sw = schwebeFolgen({ gier: 3.0, folgt: true }, -3.0, 0.35);
pruefe('folgt über ±π auf dem kurzen Weg', nahe(sw.gier, 3.0 + (2 * Math.PI - 6.0), 1e-9), sw.gier);

// ── Bauteiltafel ────────────────────────────────────────────────
let z = bauteilZeilen({ GlobalId: '2X9NnrP', IfcType: 'IfcWallStandardCase', Name: 'AW 30', Geschoss: 'EG' });
pruefe('Backend-Spalten: deutscher Titel', z.titel === 'Wand' && z.typ === 'IfcWallStandardCase');
pruefe('Backend-Spalten: Name, Geschoss, GUID', z.name === 'AW 30' && z.geschoss === 'EG' && z.guid === '2X9NnrP');
z = bauteilZeilen({ className: 'IfcBeam', name: 'HEB 300' });
pruefe('Ion-Spalten ohne Rücksicht auf Schreibung', z.titel === 'Träger' && z.name === 'HEB 300');
z = bauteilZeilen({ IfcType: 'IfcFlowController' });
pruefe('unbekannter Typ bleibt als Typ stehen', z.titel === 'IfcFlowController');
z = bauteilZeilen({});
pruefe('leere Zeile: „Bauteil"', z.titel === 'Bauteil' && z.name === '');

// ── Was die Brille zeigt ────────────────────────────────────────
pruefe('IFC, Mesh, Punktwolke ja', ['ifc', 'mesh', 'pointcloud'].every(a => VR_FAEHIG.has(a)));
pruefe('Splat ja (über Spark)', VR_FAEHIG.has('splat'));

// ── Ebenen ──────────────────────────────────────────────────────
const wand = { typ: 'IfcWall', geschoss: 'EG', guid: 'W1' };
const decke = { typ: 'IfcSlab', geschoss: '1. OG', guid: 'D1' };
let f = filterNeu();
pruefe('leerer Filter zeigt alles', filterLeer(f) && bauteilSichtbar(wand, f) && bauteilSichtbar(decke, f));
f.klassen.add('IfcWall');
pruefe('Klasse aus: Wand weg, Decke bleibt', !bauteilSichtbar(wand, f) && bauteilSichtbar(decke, f) && !filterLeer(f));
f = filterNeu(); f.geschosse.add('1. OG');
pruefe('Geschoss aus: Decke im 1. OG weg', bauteilSichtbar(wand, f) && !bauteilSichtbar(decke, f));
f = filterNeu(); f.guids.add('W1');
pruefe('einzeln ausgeblendet', !bauteilSichtbar(wand, f) && bauteilSichtbar(decke, f));
f = filterNeu(); f.klassen.add('IfcWall'); f.nur = new Set(['W1']);
pruefe('Isolieren schlägt die Klasse', bauteilSichtbar(wand, f) && !bauteilSichtbar(decke, f));
pruefe('ohne Typ heißt „ohne Typ“', ifcName('') === 'ohne Typ' && ifcName('IfcColumn') === 'Stütze');
const reihe = geschosseSortieren(['DG', '1. OG', 'EG', 'UG', 'OK RFB OG', '2.UG', 'Technik', 'OK FFB KG', 'Level 3', 'OK Dachaufbau']);
pruefe('Geschosse von unten nach oben', reihe.join(' | ') === '2.UG | OK FFB KG | UG | EG | 1. OG | OK RFB OG | Level 3 | DG | OK Dachaufbau | Technik', reihe.join(' | '));
pruefe('ohne Name ganz ans Ende', geschossRang('') > geschossRang('Technik'));

// ── Eigenschaften ───────────────────────────────────────────────
pruefe('Werte: ja/nein, Komma, Listen, leer', wertText(true) === 'ja' && wertText(false) === 'nein'
  && wertText(0.25) === '0,25' && wertText(['EXISTING', 'NEW']) === 'EXISTING, NEW' && wertText('') === '–' && wertText(null) === '–');
const gruppen = eigenschaftsGruppen({
  global_id: 'X', object_type: 'Wandpaneel', psets: {
    ArchiCADProperties: { 'Element-Typ': 'Wand' },
    Qto_WallBaseQuantities: { Length: 4.2 },
    Pset_WallCommon: { IsExternal: true, LoadBearing: false },
    'Component Properties': { Stahlbeton: { id: 1, type: 'IfcComplexProperty', UsageName: 'Stahlbeton', properties: { 'Enthaltenes CO2': '1084 kg' } } },
  },
});
pruefe('Kopf zuerst, dann Pset_…Common, Mengen, Hersteller am Ende',
  gruppen.map(g => g.titel).join(' | ') === 'Bauteil | Pset_WallCommon | Qto_WallBaseQuantities | Component Properties | ArchiCADProperties',
  gruppen.map(g => g.titel).join(' | '));
const komplex = gruppen.find(g => g.titel === 'Component Properties').zeilen;
pruefe('IfcComplexProperty wird zu „Teil › Name“, ohne id/type', komplex.length === 1 && komplex[0][0] === 'Stahlbeton › Enthaltenes CO2', JSON.stringify(komplex));
pruefe('leeres Bauteil: keine Gruppen', eigenschaftsGruppen({ psets: {} }).length === 0 && eigenschaftsGruppen(null).length === 0);

// ── Messen, Boden, Grundriss ────────────────────────────────────
const m = messung([0, 0, 0], [3, 1, 4]);
pruefe('Messung: Strecke, waagerecht, Höhe', nahe(m.abstand, Math.sqrt(26)) && nahe(m.waagerecht, 5) && m.hoehe === 1);
pruefe('Meter mit Komma', meterText(4.2357) === '4,24 m' && meterText(123.45) === '123,5 m', `${meterText(4.2357)} / ${meterText(123.45)}`);
pruefe('Stufe hinauf: sofort', bodenNachfuehren(0, 0.18, 0.016) === 0.18);
pruefe('zu hoch (Tisch): bleibt', bodenNachfuehren(0, 0.75, 0.016) === 0 && STUFE < 0.75);
pruefe('hinab: weich, nicht durch den Boden', nahe(bodenNachfuehren(3, 0, 0.1), 2.2) && bodenNachfuehren(0.1, 0, 0.1) === 0);
pruefe('kein Boden: bleibt', bodenNachfuehren(1, null, 0.1) === 1);
// 20 × 10 m, um 30° gedreht
const w30 = Math.PI / 6;
const u = [Math.cos(w30), 0, Math.sin(w30)];
const v = [-Math.sin(w30), 0, Math.cos(w30)];
const ecken = [];
for (const su of [-1, 1]) for (const sv of [-1, 1]) for (const y of [0, 8]) ecken.push([su * 10 * u[0] + sv * 5 * v[0] + 2, y, su * 10 * u[2] + sv * 5 * v[2] - 1]);
const fr = fussRechteck(ecken, [u, [0, 1, 0], v]);
pruefe('Grundriss gedreht erkannt: Mitte, halbe Seiten', nahe(fr.cx, 2, 1e-9) && nahe(fr.cz, -1, 1e-9) && nahe(fr.a, 10, 1e-9) && nahe(fr.b, 5, 1e-9), JSON.stringify(fr));
pruefe('im Grundriss / knapp daneben', imFuss(fr, 2, -1) && imFuss(fr, 2 + 9.9 * u[0], -1 + 9.9 * u[2]) && !imFuss(fr, 2 + 10.5 * u[0], -1 + 10.5 * u[2]));
pruefe('mit Rand', imFuss(fr, 2 + 10.5 * u[0], -1 + 10.5 * u[2], 1));
pruefe('kein Grundriss: nie drin', !imFuss(null, 0, 0));

// ── Kacheln (Web Mercator) ──────────────────────────────────────
const mainz = mercPixel(50.0, 8.27, 18);
const g = pixelGrad(mainz.x, mainz.y, 18);
pruefe('Pixel ↔ Grad hin und zurück', nahe(g.lat, 50, 1e-9) && nahe(g.lon, 8.27, 1e-9));
const kx = Math.floor(mainz.x / 256);
const ky = Math.floor(mainz.y / 256);
const gr = kachelGrad(kx, ky, 18);
pruefe('Kachel enthält den Punkt', gr[0] <= 8.27 && gr[2] >= 8.27 && gr[1] <= 50 && gr[3] >= 50, gr.join(', '));
const mb = kachelMerc(kx, ky, 18);
pruefe('Kachel z18 ist ~153 m breit (Mercator)', nahe(mb[2] - mb[0], 152.874, 1e-2), mb[2] - mb[0]);
pruefe('Meter je Pixel in Mainz, z18', nahe(meterProPixel(50, 18), 0.3842, 1e-3), meterProPixel(50, 18));
const sentinel = KARTEN.luftbild.schichten[0];
let q = schichtQuelle(sentinel, kx, ky, 18);
pruefe('Sentinel-2 über z14: Vorfahrin z14 mit Ausschnitt 16 px', /\/14\/\d+\/\d+\.jpg$/.test(q.url) && q.ausschnitt && q.ausschnitt[2] === 16, JSON.stringify(q));
q = schichtQuelle(sentinel, kx >> 4, ky >> 4, 14);
pruefe('Sentinel-2 bis z14 direkt', !q.ausschnitt && q.url.endsWith(`/14/${ky >> 4}/${kx >> 4}.jpg`), q.url);
const rp = KARTEN.luftbild.schichten.find(s => s.id === 'rp');
q = schichtQuelle(rp, kx, ky, 18);
pruefe('DOP RLP als WMS in EPSG:3857 mit Rechteck der Kachel', /CRS=EPSG%3A3857/.test(q.url) && q.url.includes(`BBOX=${mb.map(String).join('%2C')}`), q.url.slice(0, 200));
pruefe('DOP erst ab z11', !schichtPasst(rp, kx >> 8, ky >> 8, 10) && schichtPasst(rp, kx, ky, 18));
pruefe('Mainz: DOP RLP und Hessen tragen bei, Bayern nicht',
  schichtPasst(rp, kx, ky, 18) && schichtPasst(KARTEN.luftbild.schichten.find(s => s.id === 'he'), kx, ky, 18)
  && !schichtPasst(KARTEN.luftbild.schichten.find(s => s.id === 'by'), kx, ky, 18));
const vermerke = kartenVermerke('luftbild', 50, 8.27);
pruefe('Vermerke in Mainz: Sentinel, RLP, Hessen', vermerke.length === 3 && vermerke.some(t => /RLP/.test(t)) && vermerke.some(t => /Hessen/.test(t)), vermerke.join(' / '));
pruefe('Deutschland ja, Paris nein', inDeutschland(50, 8.27) && !inDeutschland(48.86, 2.35));
pruefe('Gelände: Mapterhorn fein, Terrain Tiles als Rückfall', GELAENDE.mapterhorn.kachel === 512 && GELAENDE.terrarium.kodierung === 'terrarium');

// Dieselben Länder wie im Viewer (kartenquellen.js, dort für Cesium)
{
  const quelle = fs.readFileSync(new URL('../../kartenquellen.js', import.meta.url), 'utf8');
  const kontext = { window: {}, Date };
  vm.runInNewContext(quelle, kontext);
  const viewer = kontext.window.ILeenKarten.DOP_LAENDER.map(l => [l.id, l.url, l.layers, l.format, l.rechteck.join(',')].join(' '));
  const brille = DOP_LAENDER.map(l => [l.id, l.url, l.layers, l.format, l.rechteck.join(',')].join(' '));
  pruefe('DOP-Länder gleich wie in kartenquellen.js', viewer.join('\n') === brille.join('\n'),
    `Viewer:\n        ${viewer.join('\n        ')}\n      Brille:\n        ${brille.join('\n        ')}`);
}

console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
