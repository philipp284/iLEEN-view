// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Rechenkern von bewegungsweich.js, ohne Browser: wann der Detailverzicht steigt, wie er nach
// der Landung zurückgeht — und dass der Bildschirmfehler nur zurückgibt, was er genommen hat.
//   node tests/bewegungsweich/test-bewegungsweich.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = { setInterval: () => 0, clearInterval: () => {} };
const sandbox = { window: win, document: undefined, setInterval: win.setInterval, clearInterval: win.clearInterval,
                  localStorage: undefined, performance: { now: () => 0 }, Cesium: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'bewegungsweich.js'), 'utf8'), sandbox);
const P = win.Bewegungsweich._pruefsteine;
const { neuerZustand, schritt, sprungMelden, sseFaktor, bewegung, fehlerSetzen, VORGABE } = P;

let fehler = 0;
function pruefe(name, ok, hinweis) {
  if (ok) console.log('✓ ' + name);
  else { fehler++; console.log('✗ ' + name + (hinweis !== undefined ? '\n    ' + hinweis : '')); }
}

/** Lässt den Zustand `s` Sekunden mit den Eingaben `e` laufen (Bildzeit 16 ms); gibt das letzte Ergebnis zurück. */
function lauf(z, s, e) {
  let aus = null;
  for (let t = 0; t < s; t += 0.016) aus = schritt(z, 0.016, typeof e === 'function' ? e(t) : e);
  return aus;
}
const still = { flug: false, rel: 0, geladen: true };

// ── Stand ──────────────────────────────────────────────────────────────
{
  const z = neuerZustand();
  const a = lauf(z, 3, still);
  pruefe('im Stand: kein Detailverzicht, Phase ruhe', a.sse === 0 && z.phase === 'ruhe');
}

// ── Sprung bemisst, wie viel Neues zu sehen ist ────────────────────────
{
  const z = neuerZustand();
  sprungMelden(z, 1.0);                       // ein Hüpfer im Raum
  const a = lauf(z, 1.5, { flug: true, rel: 1 });
  pruefe('kleiner Hüpfer (Sprung 1): kein Verzicht', a.sse < 0.02, JSON.stringify(a));
}
{
  const z = neuerZustand();
  sprungMelden(z, 4);                         // mittlerer Sprung
  const a = lauf(z, 1, { flug: true, rel: 1 });
  pruefe('mittlerer Sprung (4): teilweise', a.sse > 0.15 && a.sse < 0.9, JSON.stringify(a));
}
{
  const z = neuerZustand();
  sprungMelden(z, 25000);                     // aus dem All zum Gebäude
  const a = lauf(z, 0.6, { flug: true, rel: 1 });
  pruefe('Flug aus dem All: Verzicht in 0,6 s fast voll', a.sse > 0.95, JSON.stringify(a));
}
{
  const z = neuerZustand();
  sprungMelden(z, 2); sprungMelden(z, 25000); sprungMelden(z, 3);
  pruefe('der größte Sprung der Fahrt zählt', z.sprung === 25000);
}
{
  const z = neuerZustand();
  const a = lauf(z, 2, { flug: true, rel: 1 });     // Flug ohne Ankündigung
  pruefe('Flug ohne Ankündigung: mittlerer Wert, nicht null', a.sse > 0.1 && a.sse < 1, JSON.stringify(a));
}

// ── Freie Bewegung: Umsehen und Verschieben bleiben, wie sie sind ───────
{
  const z = neuerZustand();
  const a = lauf(z, 2, { flug: false, rel: 5 });
  pruefe('Maus/Tasten (5 Höhen/s): kein Verzicht', a.sse === 0, JSON.stringify(a));
  const b = lauf(neuerZustand(), 2, { flug: false, rel: 70 });
  pruefe('wirklich schnelle Fahrt (70 Höhen/s): voller Verzicht', b.sse > 0.95, JSON.stringify(b));
}

// ── Nachlauf: der Verzicht geht schrittweise zurück ────────────────────
{
  const z = neuerZustand();
  sprungMelden(z, 25000);
  lauf(z, 3, { flug: true, rel: 1 });                                // Flug
  lauf(z, VORGABE.ruheS + 0.05, { flug: false, rel: 0 });
  pruefe('nach der Landung: Phase nachlauf, der Verzicht steht noch', z.phase === 'nachlauf' && z.sse > 0.5, z.phase + ' ' + z.sse.toFixed(2));
  lauf(z, 0.4, { flug: false, rel: 0 });
  pruefe('Detailverzicht geht schrittweise zurück (nicht in einem Schritt)', z.sse > 0 && z.sse < 0.7, 'sse ' + z.sse.toFixed(2));
  let fallend = true, vorher = z.sse;
  for (let t = 0; t < 1; t += 0.016) { const a = schritt(z, 0.016, { flug: false, rel: 0 }); if (a.sse > vorher + 1e-9) fallend = false; vorher = a.sse; }
  pruefe('… ohne Rückschritt, bis 0; danach Phase ruhe', fallend && z.sse === 0 && z.phase === 'ruhe', z.phase + ' ' + z.sse);
}
{
  // Lücke zwischen zwei Flügen (cinematicFlyToTileset hat zwei Phasen): der Verzicht fällt nicht ab
  const z = neuerZustand(); sprungMelden(z, 25000);
  lauf(z, 2, { flug: true, rel: 1 });
  const lueck = lauf(z, 0.1, { flug: false, rel: 0 });
  pruefe('Lücke zwischen zwei Flügen (0,1 s): Verzicht bleibt', lueck.sse > 0.95 && z.phase === 'fahrt', z.phase);
  sprungMelden(z, 25000);
  const wieder = lauf(z, 1, { flug: true, rel: 1 });
  pruefe('zweiter Flug: weiterhin voll', wieder.sse > 0.95);
}
{
  // Eine neue Fahrt im Nachlauf: der Verzicht steigt von dort, wo er stand
  const z = neuerZustand(); sprungMelden(z, 25000);
  lauf(z, 2, { flug: true, rel: 1 });
  lauf(z, VORGABE.ruheS + 0.4, { flug: false, rel: 0 });
  const mitte = z.sse;
  sprungMelden(z, 25000);
  const a = lauf(z, 0.4, { flug: true, rel: 1 });
  pruefe('neue Fahrt im Nachlauf: steigt von dort, wo er stand', mitte > 0 && mitte < 1 && a.sse > 0.9, 'Mitte ' + mitte.toFixed(2));
}

// ── Bildschirmfehler: Stufen und Rückgabe ──────────────────────────────
pruefe('sseFaktor: 1 im Stand, volle Zusatzstärke bei 1', sseFaktor(2, 0, 0.25) === 1 && sseFaktor(2, 1, 0.25) === 3);
pruefe('sseFaktor: in Viertelstufen gerundet', sseFaktor(2, 0.3, 0.25) === 1.5 && sseFaktor(1.5, 1, 0.25) === 2.5);
pruefe('sseFaktor ohne Stufung bleibt stetig', Math.abs(sseFaktor(2, 0.3, 0) - 1.6) < 1e-9);
{
  const ts = { maximumScreenSpaceError: 16 };
  const spur = new WeakMap();
  fehlerSetzen(spur, ts, 2.5);
  pruefe('fehlerSetzen: Faktor wirkt auf den Ausgangswert', ts.maximumScreenSpaceError === 40);
  fehlerSetzen(spur, ts, 2);
  pruefe('fehlerSetzen: kein Aufschaukeln, Faktor gilt immer auf dem Ausgang', ts.maximumScreenSpaceError === 32);
  fehlerSetzen(spur, ts, 1);
  pruefe('fehlerSetzen: Faktor 1 gibt den Ausgangswert zurück', ts.maximumScreenSpaceError === 16 && !spur.has(ts));
  // jemand anderes stellt um (Darstellungsstufe)
  fehlerSetzen(spur, ts, 3);                       // 48
  ts.maximumScreenSpaceError = 8;                  // QUALITY
  fehlerSetzen(spur, ts, 3);
  pruefe('fremde Änderung wird neuer Ausgangswert (8 × 3 = 24)', ts.maximumScreenSpaceError === 24, ts.maximumScreenSpaceError);
  fehlerSetzen(spur, ts, 1);
  pruefe('… und zurückgegeben wird der fremde Wert, nicht der alte', ts.maximumScreenSpaceError === 8, ts.maximumScreenSpaceError);
  const unberuehrt = { maximumScreenSpaceError: 16 };
  fehlerSetzen(new WeakMap(), unberuehrt, 1);
  pruefe('Faktor 1 ohne Vorgeschichte ändert nichts', unberuehrt.maximumScreenSpaceError === 16);
}

// ── Bewegung ───────────────────────────────────────────────────────────
pruefe('bewegung: auf die Höhe bezogen', Math.abs(bewegung(100, 0, 100, 1, VORGABE) - 1) < 1e-9);
pruefe('bewegung: flacher als hoeheMin zählt nicht noch flacher', bewegung(30, 0, 1, 1, VORGABE) === 1);
pruefe('bewegung: Drehung zählt mit drehGewicht', Math.abs(bewegung(0, 1, 100, 1, VORGABE) - VORGABE.drehGewicht) < 1e-9);
pruefe('bewegung: dt = 0 gibt 0 (kein NaN)', bewegung(5, 1, 100, 0, VORGABE) === 0);

// ── Der Schleier ist draußen ────────────────────────────────────────────
const quelle = fs.readFileSync(path.join(__dirname, '..', '..', 'bewegungsweich.js'), 'utf8');
const code = quelle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
pruefe('kein Schleier mehr: keine Nachbearbeitungsstufe, kein Shader', !/PostProcessStage|fragmentShader|u_weich|textureSize/.test(code));
pruefe('keine Eingriffe in Aufnahmen mehr (toDataURL, toBlob, klar)', !/toDataURL|toBlob|klar\(/.test(code));
pruefe('der Detailverzicht ist geblieben (Bildschirmfehler von Globus und Modell-Kacheln)', /maximumScreenSpaceError/.test(code) && /scene\.globe/.test(code));

console.log(fehler ? '\n' + fehler + ' Prüfung(en) fehlgeschlagen' : '\nAlle Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
