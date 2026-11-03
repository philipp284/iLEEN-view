// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Rechenkern von bewegungsguete.js, ohne Browser: wann welche Stufe gilt.
//   node tests/bewegungsguete/test-bewegungsguete.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = { setInterval: () => 0, clearInterval: () => {} };
const sandbox = { window: win, document: undefined, setInterval: win.setInterval, clearInterval: win.clearInterval,
                  localStorage: undefined, performance: { now: () => 0 }, Cesium: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'bewegungsguete.js'), 'utf8'), sandbox);
const { neuerZustand, schritt, aufloesung } = win.Bewegungsguete._pruefsteine;

let fehler = 0, n = 0;
function pruefe(name, ok, hinweis) {
  n++;
  if (ok) console.log('✓ ' + name);
  else { fehler++; console.log('✗ ' + name + (hinweis !== undefined ? '\n    ' + hinweis : '')); }
}

/** Lässt den Regler `ms` laufen: erst `stand` ms im Stand, dann `bewegung` ms Bewegung, Bildzeit `dt`. */
function fahre(z, t0, phasen) {
  let t = t0;
  const log = [];
  for (const [bewegt, dauer, dtFn] of phasen) {
    const ende = t + dauer;
    while (t < ende) {
      const dt = typeof dtFn === 'function' ? dtFn(z.stufe) : dtFn;
      t += dt;
      schritt(z, t, dt, bewegt);
      log.push({ t, stufe: z.stufe });
    }
  }
  return { t, log };
}

// ── Auflösung je Stufe ────────────────────────────────────────────────
pruefe('Retina (2): Stufe 1 = 1, Stufe 2 = 0,75', aufloesung(2, 1) === 1 && aufloesung(2, 2) === 0.75);
pruefe('Stufe 0 ist die Darstellungsstufe', aufloesung(2, 0) === 2 && aufloesung(1, 0) === 1 && aufloesung(0.85, 0) === 0.85);
pruefe('ohne Retina (1): 85 % bzw. 64 %', aufloesung(1, 1) === 0.85 && Math.abs(aufloesung(1, 2) - 0.6375) < 0.001, aufloesung(1, 2));
pruefe('nie unter 0,5', aufloesung(0.5, 2) === 0.5);

// ── Leichte Szene: nie eine Stufe ─────────────────────────────────────
{
  const z = neuerZustand();
  let r = fahre(z, 0, [[false, 2000, 8], [true, 4000, 9], [false, 2000, 8]]);
  pruefe('leichte Szene: Bewegung bleibt auf Stufe 0', r.log.every((e) => e.stufe === 0));
}

// ── Schwere Szene: erste Bewegung gleich Stufe 1 ──────────────────────
{
  const z = neuerZustand();
  // Stand: 48 ms je Bild (21 fps); Stufe 1: 24 ms, Stufe 2: 15 ms
  const kosten = (s) => [48, 24, 15][s];
  let r = fahre(z, 0, [[false, 3000, kosten]]);
  pruefe('im Stand bleibt die Güte voll', z.stufe === 0 && r.log.every((e) => e.stufe === 0));
  pruefe('Bildzeit im Stand wird gelernt', z.ruheKosten > 40, z.ruheKosten);
  const vorBew = z.stufe;
  let r2 = fahre(z, r.t, [[true, 100, kosten]]);
  pruefe('erstes bewegtes Bild: sofort Stufe 1 (kein Warten auf Ruckler)',
    r2.log[0].stufe === 1 && vorBew === 0, JSON.stringify(r2.log[0]));
}

// ── Stufe 1 reicht noch nicht → Stufe 2 nach einigen Bildern, aber nicht sofort ──
{
  const z = neuerZustand();
  const kosten = (s) => [90, 40, 18][s];
  let r = fahre(z, 0, [[false, 3000, kosten]]);
  let r2 = fahre(z, r.t, [[true, 3000, kosten]]);
  const erstes2 = r2.log.find((e) => e.stufe === 2);
  pruefe('Stufe 2 wird erreicht, wenn Stufe 1 zu langsam bleibt', !!erstes2);
  pruefe('… nicht früher als nach der Sperre', erstes2 && erstes2.t - r.t >= z.o.sperreMs, erstes2 && (erstes2.t - r.t));
  pruefe('… und höher als 2 geht es nicht', r2.log.every((e) => e.stufe <= 2));
  pruefe('Stufe 2 bleibt, solange die Bewegung läuft', r2.log.filter((e) => e.t >= erstes2.t).every((e) => e.stufe === 2));
}

// ── Stillstand → zurück ───────────────────────────────────────────────
{
  const z = neuerZustand();
  const kosten = (s) => [48, 24, 15][s];
  let r = fahre(z, 0, [[false, 3000, kosten], [true, 1500, kosten]]);
  pruefe('in Bewegung: Stufe 1', z.stufe === 1);
  let r2 = fahre(z, r.t, [[false, 200, kosten]]);
  pruefe('kurz nach dem Loslassen noch nicht zurück (Trägheit)', z.stufe === 1);
  let r3 = fahre(z, r2.t, [[false, 400, kosten]]);
  pruefe('nach 0,35 s Ruhe zurück auf Stufe 0', z.stufe === 0);
}

// ── Eine kurze Pause in der Bewegung ist keine Ruhe ───────────────────
{
  const z = neuerZustand();
  const kosten = (s) => [48, 24, 15][s];
  let r = fahre(z, 0, [[false, 3000, kosten], [true, 500, kosten], [false, 150, kosten], [true, 500, kosten]]);
  pruefe('Bewegung mit 150-ms-Pause bleibt auf Stufe ≥ 1', r.log.filter((e) => e.t > 3100).every((e) => e.stufe >= 1));
}

// ── Die Bildzeit im Stand wird nur auf Stufe 0 gelernt ────────────────
{
  const z = neuerZustand();
  const kosten = (s) => [48, 24, 15][s];
  fahre(z, 0, [[false, 3000, kosten]]);
  const gelernt = z.ruheKosten;
  fahre(z, 3000, [[true, 2000, kosten], [false, 300, kosten]]);
  pruefe('Messen in Stufe 1 verfälscht die Ruhekosten nicht', Math.abs(z.ruheKosten - gelernt) < 3, [gelernt, z.ruheKosten]);
}

// ── Eine Szene, die erst unterwegs schwer wird ────────────────────────
{
  const z = neuerZustand();
  let r = fahre(z, 0, [[false, 3000, 7]]);                 // leer: schnell
  let r2 = fahre(z, r.t, [[true, 3000, (s) => [60, 30, 16][s]]]);   // Modell kommt dazu
  pruefe('wird die Szene unterwegs schwer, folgt die Stufe der Bildzeit', z.stufe >= 1, z.stufe);
}

console.log(`\n${n - fehler} von ${n} Prüfungen bestanden.`);
process.exit(fehler ? 1 : 0);
