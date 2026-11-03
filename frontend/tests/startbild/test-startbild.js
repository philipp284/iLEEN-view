// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Startbild ohne Browser: wann das Logo geht, wie das Glühen verläuft, und dass index.html
// Markup, Stylesheet, Notausgang und die beiden Skripte in der richtigen Reihenfolge führt.
//   node tests/startbild/test-startbild.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.join(__dirname, '..', '..');
const win = {};
const sandbox = { window: win, document: { getElementById: () => null }, localStorage: undefined, performance: { now: () => 0 },
                  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(WURZEL, 'startbild.js'), 'utf8'), sandbox);
const { verlauf, fertig, bild, neuerZustand, logoBereit, VORGABE } = win.BimViewer.Startbild._pruefsteine;

let fehler = 0;
function pruefe(name, ok, hinweis) {
  if (ok) console.log('✓ ' + name);
  else { fehler++; console.log('✗ ' + name + (hinweis !== undefined ? '\n    ' + hinweis : '')); }
}

// ── Verlauf des Glühens ─────────────────────────────────────────────────
const D = VORGABE.gluehenS;
pruefe('Glühen: vor dem Abgang und nach der Dauer aus', verlauf(-1, D) === 0 && verlauf(0, D) === 0 && verlauf(D, D) === 0 && verlauf(D + 5, D) === 0);
let gipfel = 0, tGipfel = 0;
for (let t = 0; t < D; t += 0.01) { const h = verlauf(t, D); if (h > gipfel) { gipfel = h; tGipfel = t; } }
pruefe('Glühen: Gipfel bei 1 (Stärke 1 wird erreicht)', gipfel > 0.99, gipfel.toFixed(3));
pruefe('Glühen: Gipfel um 1,4–1,6 s — wenn der Lichtschein (2 s) die Welt freigibt', tGipfel >= 1.3 && tGipfel <= 1.7, tGipfel.toFixed(2) + ' s');
let steigt = true, faellt = true;
for (let t = 0.01; t < 1.4; t += 0.01) if (verlauf(t, D) < verlauf(t - 0.01, D)) steigt = false;
for (let t = 1.7; t < D; t += 0.01) if (verlauf(t, D) > verlauf(t - 0.01, D)) faellt = false;
pruefe('Glühen: steigt in 1,4 s, fällt danach ohne Zacken', steigt && faellt);
pruefe('Glühen: auf halbem Weg zwischen Gipfel und Ende nur noch ein Viertel (Nachglühen, kein Dimmer)', verlauf((1.6 + D) / 2, D) < 0.3, verlauf((1.6 + D) / 2, D).toFixed(3));

// ── Wann das Logo geht ──────────────────────────────────────────────────
{
  const z = neuerZustand(null, 0);
  pruefe('vor dem ersten Bild geht es nie (außer nach der Frist)', !fertig(z, 1000) && !fertig(z, VORGABE.maxMs - 1) && fertig(z, VORGABE.maxMs));
}
{
  const z = neuerZustand(null, 0);
  for (let i = 0; i < 3; i++) bild(z, true, 100 + i * 16);
  pruefe('Globus fertig, aber Logo zu kurz da: es bleibt', !fertig(z, VORGABE.minMs - 1));
  pruefe('Globus fertig und Mindestdauer um: es geht', fertig(z, VORGABE.minMs));
}
{
  const z = neuerZustand(null, 0);
  bild(z, false, 1000); bild(z, false, 1016);
  pruefe('Kacheln noch nicht da, erstes Bild eben erst: es wartet', !fertig(z, 1100));
  pruefe('Kacheln kommen nicht: nach kachelnMs seit dem ersten Bild geht es trotzdem', fertig(z, 1000 + VORGABE.kachelnMs));
  bild(z, true, 1100); bild(z, true, 1116);
  pruefe('zwei ruhige Bilder genügen nicht, drei schon', !(z.ruhig >= 3));
  bild(z, true, 1132);
  pruefe('drei ruhige Bilder am Stück (nach Ablauf des Aufbaus: fertig)', z.ruhig === 3 && !fertig(z, 1140) && fertig(z, VORGABE.minMs));
  bild(z, false, 1150);
  pruefe('ein unruhiges Bild setzt die Zählung zurück', z.ruhig === 0);
}
pruefe('Puffern: Logo mindestens so lange wie sein Aufbau, Kacheln dürfen 2–3,5 s nach dem ersten Bild brauchen, nie über 9 s',
  VORGABE.minMs >= 3000 && VORGABE.minMs <= 3600 && VORGABE.kachelnMs >= 2000 && VORGABE.kachelnMs <= 3500 && VORGABE.maxMs <= 9000);

// ── Orbit-Logo: der Start wartet darauf, aber nicht ewig ───────────────
{
  const o = VORGABE;
  pruefe('Orbit-Logo: gibt es keins, wartet nichts', logoBereit(null, 0, o) === true);
  pruefe('Orbit-Logo: ausgeschaltet, wartet nichts', logoBereit({ sichtbar: false, modell: null, _laedt: true }, 0, o) === true);
  pruefe('Orbit-Logo: lädt gerade → Start wartet', logoBereit({ sichtbar: true, modell: null, _laedt: true }, 500, o) === false);
  pruefe('Orbit-Logo: geladen, aber noch nicht zeichenbereit → Start wartet', logoBereit({ sichtbar: true, modell: { ready: false } }, 500, o) === false);
  pruefe('Orbit-Logo: zeichenbereit → fertig', logoBereit({ sichtbar: true, modell: { ready: true } }, 500, o) === true);
  pruefe('Orbit-Logo: noch nicht angefangen zu laden → erst nach logoWartetMs aufgegeben (Datei fehlt)',
    logoBereit({ sichtbar: true, modell: null, _laedt: false }, o.logoWartetMs - 1, o) === false &&
    logoBereit({ sichtbar: true, modell: null, _laedt: false }, o.logoWartetMs, o) === true);
}

// ── index.html ──────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf8');
const bodyStart = html.indexOf('<body>');
pruefe('Markup steht am Anfang des Body, vor dem Viewer-Behälter',
  html.indexOf('id="ileenStart"') > bodyStart && html.indexOf('id="ileenStart"') < html.indexOf('id="cesiumContainer"'));
pruefe('startbild.css ist eingebunden', /<link rel="stylesheet" href="startbild\.css">/.test(html));
pruefe('Logo aus fünf Buchstaben, Cyan an i-Punkt und beiden E',
  (html.match(/class="sb-b"/g) || []).length === 5 && (html.match(/class="sb-c"/g) || []).length === 3);
pruefe('Notausgang: nach 15 s geht das Logo auch ohne startbild.js', /15000/.test(html) && /className \+= ' geht'/.test(html));
pruefe('Aus bei Automatisierung, ?startbild=aus und localStorage; ?startbild=an erzwingt',
  /navigator\.webdriver/.test(html) && /startbild/.test(html) && /ileen_startbild/.test(html) && /p !== 'an'/.test(html));
const posCore = html.indexOf('<script src="core.js">');
pruefe('startbild.js und bewegungsweich.js laden nach core.js (das BimViewer anlegt)',
  html.indexOf('<script src="startbild.js">') > posCore && html.indexOf('<script src="bewegungsweich.js">') > posCore);
pruefe('bewegungsweich.js nach bewegungsguete.js', html.indexOf('<script src="bewegungsweich.js">') > html.indexOf('<script src="bewegungsguete.js">'));

// ── CSS ─────────────────────────────────────────────────────────────────
const css = fs.readFileSync(path.join(WURZEL, 'startbild.css'), 'utf8');
pruefe('CSS: Logo liegt über allem, nimmt beim Abgang keine Klicks mehr', /z-index:\s*2147483000/.test(css) && /\.geht\s*\{[^}]*pointer-events:\s*none/.test(css));
pruefe('CSS: Abgang in zwei Takten (Licht steigt, dann klingt alles ab), 2 s lang',
  /ileenStartAb 2s/.test(css) && /ileenStartLicht 2s/.test(css) && /@keyframes ileenStartLicht/.test(css) && /@keyframes ileenStartAb/.test(css));
pruefe('CSS: das Licht ist ein heller, nach außen durchsichtiger Verlauf über dem Logo (::after)',
  /#ileenStart::after[\s\S]*radial-gradient[\s\S]*rgba\(234, 245, 255/.test(css));
// ── Der Aufbau des Logos und das Überblenden: ein Fluss ────────────────
{
  const stufe = css.match(/animation-delay:\s*calc\(var\(--i, 0\) \* (\d+)ms \+ (\d+)ms\)/);
  const dauerB = css.match(/#ileenStart \.sb-b \{[^}]*animation:\s*ileenStartEin ([\d.]+)s/);
  const sub = css.match(/#ileenStart \.sb-sub \{[^}]*animation:\s*ileenStartEin ([\d.]+)s [^;]*? ([\d.]+)s forwards/);
  const atmen = css.match(/#ileenStart \.sb-c \{[^}]*ileenStartAtmen [\d.]+s ease-in-out ([\d.]+)s/);
  pruefe('CSS: Aufbau Buchstabe für Buchstabe gelesen (Abstand, Verzug, Dauer)', !!stufe && !!dauerB, String(stufe) + String(dauerB));
  const buchstabenEnde = stufe && dauerB ? (+stufe[2] + 4 * +stufe[1]) / 1000 + +dauerB[1] : 0;
  const subEnde = sub ? +sub[2] + +sub[1] : 0;
  pruefe('CSS: Buchstaben fertig nach ~3 s (langsam, einer nach dem anderen)', buchstabenEnde >= 2.8 && buchstabenEnde <= 3.4 && +stufe[1] >= 400, buchstabenEnde + ' s');
  pruefe('CSS: Untertitel endet mit den Buchstaben (höchstens 0,2 s Unterschied)', Math.abs(subEnde - buchstabenEnde) <= 0.2, subEnde + ' vs ' + buchstabenEnde);
  pruefe('JS: minMs reicht bis ans Ende des Aufbaus und nicht viel darüber hinaus (Überblenden folgt direkt)',
    VORGABE.minMs >= Math.max(buchstabenEnde, subEnde) * 1000 - 1 && VORGABE.minMs <= Math.max(buchstabenEnde, subEnde) * 1000 + 300,
    VORGABE.minMs + ' vs ' + Math.max(buchstabenEnde, subEnde) * 1000);
  pruefe('CSS: Cyan beginnt zu atmen, wenn der Aufbau fertig ist', !!atmen && Math.abs(+atmen[1] - buchstabenEnde) <= 0.2, atmen && atmen[1]);
}
pruefe('Markup: Untertitel „Immersive Learning Environment" mit Cyan an I · L · E, über die ganze Breite gespannt',
  /<svg class="sb-sub"/.test(html) && /<tspan class="sb-c2">I<\/tspan>MMERSIVE <tspan class="sb-c2">L<\/tspan>EARNING <tspan class="sb-c2">E<\/tspan>NVIRONMENT/.test(html) && /textLength="931"/.test(html));
pruefe('Markup: jeder Buchstabe ein eigenes svg-Element (Compositor-Animation, nicht im Hauptthread)',
  (html.match(/<svg class="sb-b"/g) || []).length === 5);
pruefe('JS und CSS stimmen in der Abgangsdauer überein (2 s), und der Notausgang in index.html wartet sie ab', VORGABE.abgangMs === 2000 && /ileenStartAb 2s/.test(css) && /remove\(\); \}, 2300\)/.test(html));
pruefe('CSS: reduzierte Bewegung wird respektiert', /prefers-reduced-motion: reduce/.test(css));

// ── Atlas: kein Schleier mehr, also auch kein Warten darauf ─────────────
// atlas.js ist eine Auswertung und liegt nur in der Vollfassung
if (fs.existsSync(path.join(WURZEL, 'atlas.js'))) {
  const atlas = fs.readFileSync(path.join(WURZEL, 'atlas.js'), 'utf8');
  pruefe('Atlas ruft kein Bewegungsweich.klar() mehr (der Schleier ist draußen)', !/Bewegungsweich/.test(atlas));
}

console.log(fehler ? '\n' + fehler + ' Prüfung(en) fehlgeschlagen' : '\nAlle Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
