/**
 * Prüfstein für die reinen Rechenteile von pano-tour.js — ohne Browser.
 *
 * Nicht abgedeckt und nur im Browser prüfbar: die Panoramakugel (braucht eine
 * GPU), das Umsehen und die Überblendung. Hier geht es um das, was zwischen
 * tour.json und der Szene liegt: Normalisierung, der Nachbargraph und der
 * Winkelumlauf.
 *
 *   node tests/pano-tour/test-pano-tour.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Das Modul liegt in der Repo-Wurzel (ESM-Scope) und lässt sich nicht direkt
// requiren; wie die übrigen Prüfsteine wird es in einer vm-Umgebung geladen.
// Cesium wird NICHT gebraucht — die geprüften Rechenteile (P) benutzen es
// nicht, und die Cesium-Methoden werden hier nie aufgerufen.
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  setInterval: () => 0,
  clearInterval: () => {},
  performance: { now: () => 0 }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../pano-tour.js'), 'utf8'), sandbox);
const PanoTour = sandbox.window.PanoTour;
const P = PanoTour._intern;

let geprueft = 0, fehler = 0;
function ok(bed, name) {
  geprueft++;
  if (!bed) { fehler++; console.error('  ✗ ' + name); }
}
function nahe(a, b, eps, name) { ok(Math.abs(a - b) <= (eps || 1e-9), name + ' (' + a + ' ≈ ' + b + ')'); }

// ── 1. Normalisierung ──────────────────────────────────────────────────────
(function () {
  const json = {
    name: 'T', spots: [
      { id: 1, name: 'Eingang', lon: 8.25, lat: 49.99, hoehe: 112, heading: 1.2, panorama: 'pano/a.jpg' },
      { lon: 8.2501, lat: 49.99, height: 113, panorama: 'https://x/y.jpg' },
      { id: 'x', lon: 'kaputt', lat: 49.99 }             // fällt heraus
    ]
  };
  const s = P.tourNormalisieren(json, 'http://h/tour/');
  ok(s.length === 2, 'ungültiger Spot (nicht-numerische lon) fällt heraus');
  ok(s[0].id === '1', 'id wird zu String');
  ok(s[0].panorama === 'http://h/tour/pano/a.jpg', 'relative URL wird gegen die Basis aufgelöst');
  ok(s[1].panorama === 'https://x/y.jpg', 'absolute URL bleibt unangetastet');
  ok(s[1].id === 'spot2', 'fehlende id wird vergeben');
  ok(s[1].name === 'Spot 2', 'fehlender Name wird vergeben');
  nahe(s[1].hoehe, 113, 1e-9, 'height wird als hoehe übernommen');
  nahe(s[0].heading, 1.2, 1e-9, 'heading bleibt');

  const dataUri = P.tourNormalisieren(
    { spots: [{ id: 'd', lon: 1, lat: 1, panorama: 'data:image/png;base64,AAAA' }] }, 'http://h/');
  ok(dataUri[0].panorama === 'data:image/png;base64,AAAA', 'data:-URI bleibt unangetastet');
})();

// ── 2. Nachbargraph automatisch ─────────────────────────────────────────────
(function () {
  // Vier Spots in einer Reihe im Abstand 5 m; Radius 12 fasst je zwei.
  const spots = [
    { id: 'a', _pos: { x: 0, y: 0, z: 0 }, nachbarn: null },
    { id: 'b', _pos: { x: 5, y: 0, z: 0 }, nachbarn: null },
    { id: 'c', _pos: { x: 10, y: 0, z: 0 }, nachbarn: null },
    { id: 'd', _pos: { x: 40, y: 0, z: 0 }, nachbarn: null }   // zu weit weg
  ];
  P.nachbarnBilden(spots, { radius: 12, maxN: 4 });
  const nach = {}; spots.forEach(s => nach[s.id] = s.nachbarn.slice().sort());
  ok(nach.a.join() === 'b,c', 'a bekommt die beiden nächsten innerhalb 12 m');
  ok(nach.b.indexOf('a') >= 0 && nach.b.indexOf('c') >= 0, 'b hängt an a und c');
  ok(nach.d.length === 0, 'der ferne Spot d bleibt ohne Nachbarn');
  ok(nach.a.indexOf('a') < 0, 'kein Selbstbezug');
})();

// ── 3. Nachbarschaft ist beidseitig ─────────────────────────────────────────
(function () {
  // Nur a→b angegeben; die Rückkante muss ergänzt werden.
  const spots = [
    { id: 'a', _pos: { x: 0, y: 0, z: 0 }, nachbarn: ['b'] },
    { id: 'b', _pos: { x: 3, y: 0, z: 0 }, nachbarn: [] }
  ];
  P.nachbarnBilden(spots, {});
  ok(spots[1].nachbarn.indexOf('a') >= 0, 'einseitig angegebene Kante wird beidseitig geschlossen');
})();

// ── 4. Vorgegebene Nachbarn überschreiben die Automatik nicht ───────────────
(function () {
  const spots = [
    { id: 'a', _pos: { x: 0, y: 0, z: 0 }, nachbarn: ['c'] },
    { id: 'b', _pos: { x: 1, y: 0, z: 0 }, nachbarn: ['c'] },
    { id: 'c', _pos: { x: 2, y: 0, z: 0 }, nachbarn: ['a', 'b'] }
  ];
  P.nachbarnBilden(spots, { radius: 12, maxN: 4 });
  ok(spots[0].nachbarn.join() === 'c', 'a behält seine angegebene Nachbarschaft (kein Auto-b)');
})();

// ── 5. Winkelumlauf ─────────────────────────────────────────────────────────
(function () {
  nahe(P.wrap(0), 0, 1e-9, 'wrap 0');
  nahe(P.wrap(Math.PI * 3), -Math.PI, 1e-9, 'wrap 3π → -π');
  nahe(P.wrap(-Math.PI * 1.5), Math.PI * 0.5, 1e-9, 'wrap -1.5π → 0.5π');
  ok(P.wrap(7) >= -Math.PI && P.wrap(7) < Math.PI, 'wrap liegt in [-π,π)');
})();

// ── 6. Nächster Spot ────────────────────────────────────────────────────────
(function () {
  const spots = [
    { id: 'a', _pos: { x: 0, y: 0, z: 0 } },
    { id: 'b', _pos: { x: 10, y: 0, z: 0 } }
  ];
  ok(P.naechster(spots, { x: 9, y: 0, z: 0 }).id === 'b', 'naechster findet b');
  ok(P.naechster(spots, { x: 1, y: 1, z: 0 }).id === 'a', 'naechster findet a');
})();

console.log((fehler ? '✗' : '✓') + ' pano-tour: ' + (geprueft - fehler) + '/' + geprueft + ' Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
