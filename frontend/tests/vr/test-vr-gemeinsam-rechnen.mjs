// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Die Rechnungen von „Gemeinsam in der Brille" (vr-gemeinsam-rechnen.js), ohne
// Browser und ohne Netz.
//
// Aufruf:  node tests/vr/test-vr-gemeinsam-rechnen.mjs
//
// Der Kern ist die Frage, die nur eine Rechnung beantworten kann: Zwei Brillen
// mit verschiedenen Rahmen (jede hat ihren eigenen Ursprung und ihre eigene
// Blickrichtung beim Start) messen dieselben zwei Marken. Liegt danach jeder
// Punkt des Raumes bei beiden an derselben Stelle — im 1:1-Modus wie am Tisch,
// auch wenn eine von beiden gerade geht, dreht oder das Modell greift?

import {
  lage, EINS, winkel, drehen, lagePunkt, lageMal, lageInvers, lageGueltig, lageGleich, lageMischen, lageSprung, lageRunden,
  gruppeAus, nutzerAusGruppe, modellAusGruppe, stichprobe, stichprobeFehler, kalibrierung, kalibrierVergleich, KALIBRIER,
  gierQuat, quatMal, quatDrehen, quatGier, slerp, poseLage, poseMischen, poseGueltig, poseRunden, paketMischen, paketSprung,
  paketSauber, avatarMassstab, Puffer, filterAlsDaten, filterAusDaten, ansichtSauber, ansichtLeer, raumAdresse, raumName,
  kennungGueltig, kennungNeu, nameSauber, anzeigeName, nummerWaehlen, farbeWaehlen, FARBEN,
} from '../../vr-gemeinsam-rechnen.js';

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis !== undefined ? `\n      ${hinweis}` : ''}`); }
}

const nah = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const abstand = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const GRAD = Math.PI / 180;

// Fester Zufall: jeder Lauf prüft dasselbe
let saat = 7;
const zufall = () => { saat = (saat * 16807) % 2147483647; return (saat - 1) / 2147483646; };
const zw = (a, b) => a + (b - a) * zufall();
const zufallsLage = (s = 1) => lage(zw(-20, 20), zw(-3, 3), zw(-20, 20), zw(-Math.PI, Math.PI), s);
const zufallsPunkt = () => [zw(-8, 8), zw(0, 2.5), zw(-8, 8)];

// ── Drehsinn wie three.js ─────────────────────────────────────────
{
  const [x, z] = drehen(Math.PI / 2, 1, 0);
  pruefe('R_y(+90°) dreht +x nach −z (wie three.js)', nah(x, 0) && nah(z, -1), `${x} ${z}`);
  let gleich = true;
  for (let i = 0; i < 50; i++) {
    const g = zw(-4, 4);
    const v = zufallsPunkt();
    const a = quatDrehen(gierQuat(g), v);
    const [bx, bz] = drehen(g, v[0], v[2]);
    gleich = gleich && nah(a[0], bx, 1e-12) && nah(a[1], v[1], 1e-12) && nah(a[2], bz, 1e-12);
  }
  pruefe('Gier-Quaternion dreht wie R_y', gleich);
  let gier = true;
  for (let i = 0; i < 50; i++) {
    const g = zw(-3.1, 3.1);
    const nick = zw(-1.2, 1.2);
    const q = quatMal(gierQuat(g), [Math.sin(nick / 2), 0, 0, Math.cos(nick / 2)]);
    gier = gier && nah(quatGier(q), g, 1e-9);
  }
  pruefe('Gierwinkel aus einer Quaternion mit Neigung', gier);
  pruefe('Winkel auf [−π, π)', nah(winkel(3 * Math.PI / 2), -Math.PI / 2) && nah(winkel(-3 * Math.PI / 2), Math.PI / 2) && nah(winkel(0.3), 0.3));
}

// ── Lagen ─────────────────────────────────────────────────────────
{
  let ok = true;
  let assoz = true;
  for (let i = 0; i < 100; i++) {
    const A = zufallsLage(zw(0.01, 3));
    const B = zufallsLage(zw(0.01, 3));
    const C = zufallsLage(zw(0.5, 2));
    const p = zufallsPunkt();
    const eins = lageMal(lageInvers(A), A);
    ok = ok && lageGleich(eins, EINS, 1e-9);
    const ab = lagePunkt(lageMal(A, B), p);
    const a_b = lagePunkt(A, lagePunkt(B, p));
    ok = ok && abstand(ab, a_b) < 1e-9;
    assoz = assoz && lageGleich(lageMal(lageMal(A, B), C), lageMal(A, lageMal(B, C)), 1e-9);
  }
  pruefe('A⁻¹ ∘ A = 1 und (A ∘ B)(p) = A(B(p)), auch mit Maßstab', ok);
  pruefe('Verkettung ist assoziativ', assoz);
  pruefe('Lage prüfen: kaputte Werte fallen auf', lageGueltig(lage(1, 2, 3, 0.4, 0.02)) && !lageGueltig(lage(NaN)) && !lageGueltig(lage(0, 0, 0, 0, 0))
    && !lageGueltig({ x: 1 }) && !lageGueltig(null));
  const r = lageRunden(lage(1.234567891, 0, 0, 7, 0.0123456789));
  pruefe('Runden: 0,1 mm und Winkel normiert', r.x === 1.2346 && nah(r.gier, winkel(7), 1e-6) && r.s === 0.012345679, JSON.stringify(r));
}

// ── Mischen und Springen ──────────────────────────────────────────
{
  const a = lage(0, 0, 0, 170 * GRAD, 1);
  const b = lage(2, 0, 0, -170 * GRAD, 4);
  const m = lageMischen(a, b, 0.5);
  pruefe('Mischen dreht auf dem kurzen Weg über ±180°', nah(Math.abs(m.gier), Math.PI, 1e-9) && nah(m.x, 1), `${m.gier / GRAD}°`);
  pruefe('Maßstab wird geometrisch gemischt', nah(m.s, 2));
  pruefe('Gehen ist kein Sprung', !lageSprung(lage(0, 0, 0), lage(0.2, 0, 0, 0.05)));
  pruefe('Teleport, Drehschritt und Maßstabssprung sind Sprünge',
    lageSprung(lage(0, 0, 0), lage(3, 0, 0)) && lageSprung(lage(), lage(0, 0, 0, 30 * GRAD)) && lageSprung(lage(), lage(0, 0, 0, 0, 2)));
  // Am Tisch zählt der Weg in Metern, nicht in Modelleinheiten (S.s = 100)
  pruefe('Sprung am Tisch in echten Metern', !lageSprung(lage(0, 0, 0, 0, 100), lage(20, 0, 0, 0, 100)) && lageSprung(lage(0, 0, 0, 0, 100), lage(200, 0, 0, 0, 100)));
}

// ── Kalibrierung: zwei Brillen, dieselben Marken ──────────────────
// Die Welt ist hier der wirkliche Raum. Jede Brille sieht ihn in ihrem Rahmen:
// phys = T⁻¹(welt), T = wo und wie gedreht ihre Sitzung begann.
const TA = lage(0.4, 0, -1.2, 25 * GRAD);
const TB = lage(-3.1, 0, 2.7, -140 * GRAD);
const physA = w => lagePunkt(lageInvers(TA), w);
const physB = w => lagePunkt(lageInvers(TB), w);
const MARKE1 = [1.0, 0.04, 0.5];
const MARKE2 = [3.6, 0.05, 1.9];
const KA = kalibrierung(physA(MARKE1), physA(MARKE2));
const KB = kalibrierung(physB(MARKE1), physB(MARKE2));
{
  pruefe('Kalibrierung: Abstand der Marken', nah(KA.abstand, Math.hypot(2.6, 1.4), 1e-9) && nah(KA.abstand, KB.abstand, 1e-9), KA.abstand);
  let maxFehler = 0;
  for (let i = 0; i < 200; i++) {
    const w = zufallsPunkt();
    maxFehler = Math.max(maxFehler, abstand(lagePunkt(KA.physNachRaum, physA(w)), lagePunkt(KB.physNachRaum, physB(w))));
  }
  pruefe('jeder Punkt liegt in beiden Brillen an derselben Raumstelle', maxFehler < 1e-9, maxFehler);
  const r1 = lagePunkt(KA.physNachRaum, physA(MARKE1));
  const r2 = lagePunkt(KA.physNachRaum, physA(MARKE2));
  pruefe('Raum: Marke 1 im Ursprung, Marke 2 auf der x-Achse',
    nah(r1[0], 0, 1e-12) && nah(r1[2], 0, 1e-12) && nah(r2[0], KA.abstand, 1e-9) && nah(r2[2], 0, 1e-9) && nah(r2[1], 0.05, 1e-12));
  pruefe('Raum: y bleibt die Bodenhöhe der Brille', nah(r1[1], 0.04, 1e-12));
  pruefe('zu nahe Marken werden abgelehnt', kalibrierung([0, 0, 0], [0.5, 0, 0.2]).fehler === 'nah');

  // Mit Messrauschen von ±4 mm: wie weit liegen die Brillen 6 m entfernt auseinander?
  let schlimmste = 0;
  for (let n = 0; n < 200; n++) {
    const rauschen = p => p.map(v => v + zw(-0.004, 0.004));
    const ka = kalibrierung(rauschen(physA(MARKE1)), rauschen(physA(MARKE2)));
    const kb = kalibrierung(rauschen(physB(MARKE1)), rauschen(physB(MARKE2)));
    const w = [MARKE1[0] + 6, 1.6, MARKE1[2] - 2];
    schlimmste = Math.max(schlimmste, abstand(lagePunkt(ka.physNachRaum, physA(w)), lagePunkt(kb.physNachRaum, physB(w))));
  }
  console.log(`      ±4 mm Messrauschen, Marken 2,95 m auseinander: 6 m weiter höchstens ${(schlimmste * 100).toFixed(1)} cm Versatz`);
  pruefe('Messrauschen von ±4 mm gibt 6 m weiter weniger als 6 cm', schlimmste < 0.06, schlimmste);

  const passt = kalibrierVergleich(KA, [{ name: 'B', abstand: KB.abstand + 0.01, hoehe: KB.hoehe }]);
  const passtNicht = kalibrierVergleich(KA, [{ name: 'B', abstand: KB.abstand + 0.01, hoehe: KB.hoehe }, { name: 'C', abstand: KA.abstand + 0.3, hoehe: KA.hoehe }]);
  pruefe('Vergleich: 1 cm Unterschied passt', passt && passt.passt);
  pruefe('Vergleich: 30 cm Unterschied fällt auf, der schlimmste wird genannt', passtNicht && !passtNicht.passt && passtNicht.name === 'C');
  pruefe('Vergleich: andere Höhe fällt auf', !kalibrierVergleich(KA, [{ name: 'B', abstand: KA.abstand, hoehe: KA.hoehe + 0.5 }]).passt);
  pruefe('Vergleich ohne andere: nichts', kalibrierVergleich(KA, [{ name: 'Mac' }]) === null);
}

// ── Stichprobe einer Marke ────────────────────────────────────────
{
  const ruhig = Array.from({ length: 30 }, () => [1 + zw(-0.003, 0.003), 0.05 + zw(-0.003, 0.003), 2 + zw(-0.003, 0.003)]);
  const s = stichprobe(ruhig);
  pruefe('ruhige Hand: Mittel auf wenige mm, keine Beanstandung', abstand(s.mitte, [1, 0.05, 2]) < 0.003 && stichprobeFehler(s) === null);
  const wacklig = [...ruhig, [1.05, 0.05, 2]];
  pruefe('ein Ausreißer von 5 cm: unruhig', stichprobeFehler(stichprobe(wacklig)) === 'unruhig');
  pruefe('zu wenige Proben: zu kurz', stichprobeFehler(stichprobe(ruhig.slice(0, KALIBRIER.mindestProben - 1))) === 'kurz');
}

// ── Die Gruppe: 1:1 ───────────────────────────────────────────────
// A geht, B geht mit. Für jeden Punkt des Raumes müssen beide an derselben
// Stelle im Modell stehen: Welt ist im 1:1-Modus der Modellrahmen (M = 1).
{
  let schlimmste = 0;
  let einfach = true;
  for (let i = 0; i < 100; i++) {
    const NA = zufallsLage();                       // wohin A gegangen ist
    const S = gruppeAus(EINS, NA, KA.physNachRaum);
    const NB = nutzerAusGruppe(EINS, S, KB.physNachRaum);
    einfach = einfach && nah(NB.s, 1, 1e-12);
    for (let k = 0; k < 5; k++) {
      const w = zufallsPunkt();
      schlimmste = Math.max(schlimmste, abstand(lagePunkt(NA, physA(w)), lagePunkt(NB, physB(w))));
    }
    // Zurück: aus B's Lage dieselbe Gruppe
    schlimmste = Math.max(schlimmste, abstand(lagePunkt(gruppeAus(EINS, NB, KB.physNachRaum), [1, 2, 3]), lagePunkt(S, [1, 2, 3])));
  }
  pruefe('1:1: wer mitgeht, steht im Modell, wo er wirklich steht', schlimmste < 1e-9, schlimmste);
  pruefe('1:1: die Nutzerlage bleibt ohne Maßstab', einfach);
}

// ── Die Gruppe: Tisch ─────────────────────────────────────────────
// B greift das Modell (Maßstab 1:80, gedreht, verschoben), A sieht es am selben
// Fleck auf dem Tisch: ein Modellpunkt liegt für beide an derselben Stelle der Welt.
{
  let schlimmste = 0;
  for (let i = 0; i < 100; i++) {
    const MB = lage(zw(-2, 2), zw(0.6, 1.1), zw(-2, 2), zw(-3, 3), 1 / zw(20, 300));
    const S = gruppeAus(MB, EINS, KB.physNachRaum);
    const MA = modellAusGruppe(EINS, S, KA.physNachRaum);
    for (let k = 0; k < 5; k++) {
      const q = [zw(-30, 30), zw(0, 20), zw(-30, 30)];   // Punkt im Modell
      const weltA = lagePunkt(TA, lagePunkt(MA, q));      // wo A ihn im Raum sieht
      const weltB = lagePunkt(TB, lagePunkt(MB, q));
      schlimmste = Math.max(schlimmste, abstand(weltA, weltB));
    }
  }
  pruefe('Tisch: das Modell steht für beide am selben Fleck', schlimmste < 1e-9, schlimmste);
}

// ── Posen durch Lagen ─────────────────────────────────────────────
{
  const L = lage(1, 2, 3, 0.7, 0.05);
  const q = quatMal(gierQuat(0.3), [Math.sin(0.2), 0, 0, Math.cos(0.2)]);
  const pose = [0.5, 1.6, -0.2, ...q];
  const p2 = poseLage(L, pose);
  const vor = quatDrehen(p2.slice(3), [0, 0, -1]);
  const soll = quatDrehen(gierQuat(0.7), quatDrehen(q, [0, 0, -1]));
  pruefe('Pose durch Lage: Ort mit Maßstab, Richtung ohne', abstand(p2, lagePunkt(L, pose)) < 1e-12 && abstand(vor, soll) < 1e-12 && nah(Math.hypot(...p2.slice(3)), 1, 1e-12));
  const r = poseRunden([1.23456, 0, 0, 0.123456, 0, 0, 0.99235]);
  pruefe('Pose runden: mm und 1e-4', r[0] === 1.235 && r[3] === 0.1235);
  pruefe('Pose prüfen', poseGueltig(pose) && !poseGueltig([0, 0, 0, 0, 0, 0, 0]) && !poseGueltig([0, 0, NaN, 0, 0, 0, 1]) && !poseGueltig([1, 2, 3]) && !poseGueltig([1e9, 0, 0, 0, 0, 0, 1]));
  const a = [0, 0, 0, ...gierQuat(0)];
  const b = [2, 0, 0, ...gierQuat(1)];
  const m = poseMischen(a, b, 0.5);
  pruefe('Pose mischen: halber Weg, halbe Drehung', nah(m[0], 1) && nah(quatGier(m.slice(3)), 0.5, 1e-9));
  const s = slerp(gierQuat(0.2), gierQuat(0.2 + 2 * Math.PI), 0.5);
  pruefe('slerp nimmt bei −q den kurzen Weg', nah(quatGier(s), 0.2, 1e-9));
}

// ── Pakete ────────────────────────────────────────────────────────
{
  const k = [1, 1.6, 2, 0, 0, 0, 1];
  const sauber = paketSauber({ k, h: [k, 'quatsch'], z: [[0, 0, 0, 1, 1, 1], [1]], s: 0.02, m: 'tisch', f: 0, r: { k, h: [] }, boese: 'x' });
  pruefe('Paket säubern: Kaputtes fällt weg, Gutes bleibt',
    sauber && sauber.h[0] && sauber.h[1] === null && sauber.z[0] && sauber.z[1] === null && sauber.s === 0.02 && sauber.m === 'tisch' && sauber.r.k && !('boese' in sauber),
    JSON.stringify(sauber));
  pruefe('Paket ohne gültigen Kopf: verworfen', paketSauber({ k: [0, 0, 0] }) === null && paketSauber(null) === null && paketSauber('x') === null);
  pruefe('Paket mit Unsinn: Maßstab 1, Modus Vorschau', (() => { const p = paketSauber({ k, s: -3, m: 'boese' }); return p.s === 1 && p.m === 'vorschau'; })());
  const a = paketSauber({ k: [0, 1.6, 0, 0, 0, 0, 1], h: [null, [0.2, 1, 0, 0, 0, 0, 1]], s: 1, m: 'vr', f: 0 });
  const b = paketSauber({ k: [0.2, 1.6, 0, 0, 0, 0, 1], h: [[0, 1, 0, 0, 0, 0, 1], [0.4, 1, 0, 0, 0, 0, 1]], s: 1, m: 'vr', f: 0.2 });
  const m = paketMischen(a, b, 0.5);
  pruefe('Paket mischen: Kopf, Hand und Fuß', nah(m.k[0], 0.1) && nah(m.h[1][0], 0.3) && nah(m.f, 0.1) && m.h[0] && m.h[0][0] === 0);
  pruefe('Paket springt beim Teleport, nicht beim Gehen',
    !paketSprung(a, b) && paketSprung(a, { ...b, k: [3, 1.6, 0, 0, 0, 0, 1] }) && paketSprung(a, { ...b, m: 'tisch' }));
  pruefe('Avatarmaßstab: gleich 1, Tisch sieht Begeher klein, gekappt',
    avatarMassstab(1, 1) === 1 && nah(avatarMassstab(0.02, 1), 0.02) && avatarMassstab(1, 0.01) === 4 && avatarMassstab(0.0001, 1) === 0.01);
}

// ── Puffer ────────────────────────────────────────────────────────
{
  const p = new Puffer(4);
  pruefe('leerer Puffer: nichts', p.lesen(10, lageMischen) === null && p.leer);
  p.neu(100, lage(0, 0, 0), 1);
  p.neu(140, lage(1, 0, 0), 2);
  p.neu(180, lage(5, 0, 0), 3);   // Sprung
  pruefe('vor dem ersten: der erste', p.lesen(50, lageMischen, lageSprung).x === 0);
  pruefe('dazwischen gemischt', nah(p.lesen(120, lageMischen, lageSprung).x, 0.5));
  pruefe('über einen Sprung nicht gemischt', p.lesen(170, lageMischen, lageSprung).x === 1);
  pruefe('nach dem letzten: der letzte', p.lesen(500, lageMischen, lageSprung).x === 5);
  p.neu(190, lage(6, 0, 0), 4);
  p.neu(200, lage(7, 0, 0), 5);
  pruefe('Puffer hält höchstens max Einträge', p.eintraege.length === 4 && p.eintraege[0].seq === 2);
  p.abSeq(4);
  pruefe('abSeq verwirft Überholtes', p.eintraege.length === 1 && p.letzter.seq === 5);
  p.neu(150, lage(8, 0, 0), 6);
  pruefe('Ankunft vor dem letzten wird nachgereiht', p.letzter.t === 200);
}

// ── Ansicht ───────────────────────────────────────────────────────
{
  const f = { klassen: new Set(['IfcWall', 'IfcDoor']), geschosse: new Set(['EG']), guids: new Set(['a$b']), nur: null };
  const d = filterAlsDaten(f);
  const zurueck = filterAusDaten(JSON.parse(JSON.stringify(d)));
  pruefe('Filter als Daten und zurück', d.klassen.join() === 'IfcDoor,IfcWall' && zurueck.klassen.has('IfcWall') && zurueck.guids.has('a$b') && zurueck.nur === null);
  pruefe('Isolieren überlebt den Weg', filterAusDaten(filterAlsDaten({ ...f, nur: new Set(['g1']) })).nur.has('g1'));
  pruefe('Filter aus Unsinn: leer', (() => { const x = filterAusDaten({ klassen: 'IfcWall', nur: 5 }); return x.klassen.size === 0 && x.nur === null; })());
  const a = ansichtSauber({ filter: d, schnitt: { an: 1, hoehe: 'x' }, modell: 0 });
  pruefe('Ansicht säubern', a.schnitt.an === true && a.schnitt.hoehe === 3 && a.modell === true, JSON.stringify(a));
  pruefe('leere Ansicht erkannt', ansichtLeer(ansichtSauber({})) && !ansichtLeer(a));
}

// ── Adresse, Namen, Nummern, Farben ───────────────────────────────
{
  pruefe('Adresse über https: derselbe Ursprung, wss', raumAdresse({ protokoll: 'https:', host: '192.168.0.9:5443', hostname: '192.168.0.9' }) === 'wss://192.168.0.9:5443/vr-raum');
  pruefe('Adresse am Mac: direkt zum Relais', raumAdresse({ protokoll: 'http:', host: 'localhost:5181', hostname: 'localhost' }) === 'ws://127.0.0.1:5446/vr-raum');
  pruefe('Adresse über http im WLAN: keine', raumAdresse({ protokoll: 'http:', host: '192.168.0.9:5181', hostname: '192.168.0.9' }) === null);
  pruefe('Adresse aus Vorgabe (Prüfstein)', raumAdresse({ protokoll: 'http:', hostname: 'x', vorgabe: 'ws://127.0.0.1:9/vr-raum' }) === 'ws://127.0.0.1:9/vr-raum'
    && raumAdresse({ protokoll: 'http:', hostname: 'x', vorgabe: 'javascript:alert(1)' }) === null);
  pruefe('Raumname: nur Buchstaben, Ziffern, - und _', raumName('labor-2') === 'labor-2' && raumName('../x') === 'labor' && raumName(5) === 'labor');
  const k = kennungNeu();
  pruefe('neue Kennung ist gültig und zufällig', kennungGueltig(k) && k !== kennungNeu() && !kennungGueltig('ab') && !kennungGueltig('a b c d e f'));
  pruefe('Name säubern', nameSauber(' Anna\u0000 ') === 'Anna' && nameSauber('x'.repeat(40)).length === 24 && nameSauber(null) === '');
  pruefe('Anzeigename', anzeigeName({ geraet: 'brille', nummer: 2 }) === 'Brille 2' && anzeigeName({ geraet: 'bildschirm', nummer: 1 }) === 'Bildschirm 1'
    && anzeigeName({ name: 'Anna', geraet: 'brille', nummer: 1 }) === 'Anna');
  pruefe('Nummer: kleinste freie, die frühere bevorzugt', nummerWaehlen(new Set([1, 2]), null) === 3 && nummerWaehlen(new Set([1]), 4) === 4 && nummerWaehlen(new Set([1, 4]), 4) === 2);
  pruefe('Farbe: freie, die frühere bevorzugt, sonst reihum',
    farbeWaehlen(new Set([0]), null) === 1 && farbeWaehlen(new Set([0]), 3) === 3 && farbeWaehlen(new Set([0, 3]), 3) === 1
    && Number.isInteger(farbeWaehlen(new Set(FARBEN.map((_, i) => i)), null)));
  pruefe('kein Teilnehmer trägt das Akzentgrün', !FARBEN.includes('#97bf0d'));
}

console.log(fehler ? `\n${fehler} Fehler` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
