// Zustand und Folien mit Szene im echten Viewer: Chrome headless über
// puppeteer-core, gegen einen laufenden Dev-Server.
//
// Der Prüfstein ohne Browser (test-zustand.js) rechnet mit Attrappen. Hier
// lesen die Anmelder die ECHTEN Werkzeuge:
//
//   · Alle zwölf Anmelder melden sich an, und `lesen()` wirft bei keinem.
//   · Rundlauf gegen die echten Schnittstellen von Farben, Licht, Sonne,
//     Untergrund, Punktwolken, Explosion, Notizen, Filter und Schnitt.
//   · DIE SZENE FÄHRT MIT: zwei Folien mit verschiedenem Weißabgleich und
//     Sonnenstand; Auto-Play läuft, und Farben.stand().kelvin sowie die Sonne
//     liegen zwischendurch zwischen den beiden Werten und am Ende auf dem der
//     zweiten Folie. Das ist die Frage, die nur im laufenden Viewer zu
//     beantworten ist: ob die weichen Größen wirklich je Bild nachgezogen werden.
//   · Wählen einer Folie stellt ihre Szene her; Esc nach der Show stellt die
//     Szene von vorher wieder her.
//   · Das Deck trägt die Szene durch Sichern und Laden.
//
// Modelle laden braucht ein Backend und wird vom Prüfstein ohne Browser
// abgedeckt (mit der Regel „das Laden löst keinen Kameraflug aus").
//
// Aufruf:  npx vite --port 5190 &   VIEWER_URL=http://localhost:5190/ node tests/zustand/test-browser.mjs

import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5190/';

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${ok || !zusatz ? '' : ' — ' + zusatz}`);
  if (!ok) fehler++;
};
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 720 });
const seitenfehler = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => { window._splashDismissed = true; });
await warte(14000);

// ── 1 · Die Registry im Viewer ──────────────────────────────────────────────
console.log('\n1. Registry');
const reg = await page.evaluate(() => {
  const Z = BimViewer.Zustand;
  const gelesen = Z.lesen();
  return {
    ids: Z.ids().join(),
    gelesen: Object.keys(gelesen).join(),
    schema: Z.schema().length,
    jsonOk: (() => { try { JSON.parse(JSON.stringify(gelesen)); return true; } catch (e) { return false; } })(),
  };
});
pruefe('zwölf Anmelder, in Ordnung', reg.ids === 'modelle,filter,bildebenen,schnitt,explosion,notizen,welt,sonne,farben,licht,untergrund,punktwolken', reg.ids);
pruefe('lesen() liefert reines JSON und wirft bei keinem', reg.jsonOk && reg.gelesen.includes('farben') && reg.gelesen.includes('licht'), reg.gelesen);
pruefe('das Schema beschreibt alle', reg.schema === 12);

// ── 2 · Rundlauf gegen die echten Werkzeuge ─────────────────────────────────
console.log('\n2. Rundlauf gegen die echten Werkzeuge');
const rund = await page.evaluate(async () => {
  const Z = BimViewer.Zustand;
  const ist = Z.lesen();
  const aus = {};

  // Verstellen
  BimViewer.Farben.kelvinSetzen(4800); BimViewer.Farben.belichtungSetzen(1.3); BimViewer.Farben.schema('ifc');
  BimViewer.Licht.aufhellungSetzen(0.5); BimViewer.Licht.staerkeSetzen(2.5);
  BimViewer.setLightingTime(18); BimViewer.setShadows(false);
  BimViewer.setPointSize(5); BimViewer.setColorMode('height');
  BimViewer.Untergrund.nullebeneSetzen(false);
  window.Annotations.setMaxDistance(321); window.Annotations.setOnlyOpen(true); window.Annotations.setVisibleSet(['a', 'b']);
  BimViewer.ifcFilter.enabledEntities.delete('IfcSpace');
  aus.verstellt = Z.lesen();

  // Zurück auf den Ausgangsstand
  const r = await Z.anwenden(ist);
  const nach = Z.lesen();
  aus.fehler = r.fehler;
  aus.unterschiede = Object.keys(ist).filter((k) => JSON.stringify(ist[k]) !== JSON.stringify(nach[k]))
    .map((k) => k + ': ' + JSON.stringify(ist[k]) + ' ≠ ' + JSON.stringify(nach[k]));
  aus.verstelltKelvin = aus.verstellt.farben.kelvin;
  aus.kelvinNach = BimViewer.Farben.stand().kelvin;
  aus.spaceWieder = BimViewer.ifcFilter.enabledEntities.has('IfcSpace');
  aus.notizenIds = window.Annotations.getVisibleSet();
  return aus;
});
pruefe('verstellt war es wirklich anders', rund.verstelltKelvin === 4800);
pruefe('anwenden(Ausgangsstand) wirft bei keinem Anmelder', rund.fehler.length === 0, JSON.stringify(rund.fehler));
pruefe('der Ausgangsstand liest sich danach identisch zurück', rund.unterschiede.length === 0, rund.unterschiede.join(' || '));
pruefe('Farben, Filter und Notizen sind wirklich zurück', rund.kelvinNach !== 4800 && rund.spaceWieder === true && rund.notizenIds === null);

// ── 3 · Die Szene fährt mit ─────────────────────────────────────────────────
console.log('\n3. Folien mit Szene');
const folien = await page.evaluate(async () => {
  const P = Praesentation, Cesium = window.Cesium, v = BimViewer.viewer;
  P.leeren();
  v.camera.cancelFlight();
  const stand = (lon, lat, h, heading) => v.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
    orientation: { heading: Cesium.Math.toRadians(heading), pitch: Cesium.Math.toRadians(-30), roll: 0 } });
  P.einstellungSetzen('uebergang', 1.6); P.einstellungSetzen('halt', 0.5);

  BimViewer.Farben.kelvinSetzen(5000); BimViewer.Farben.belichtungSetzen(1.0);
  BimViewer.setLightingTime(9);
  BimViewer.Licht.aufhellungSetzen(0.1);
  stand(8.2650, 49.9900, 150, 350);
  const a = P.hinzufuegen();

  BimViewer.Farben.kelvinSetzen(7500); BimViewer.Farben.belichtungSetzen(1.6);
  BimViewer.setLightingTime(17);
  BimViewer.Licht.aufhellungSetzen(0.5);
  stand(8.2670, 49.9920, 100, 40);
  const b = P.hinzufuegen();
  return { a: a.id, b: b.id, szeneA: !!a.szene, szeneB: !!b.szene,
           kelvinA: a.szene.farben.kelvin, kelvinB: b.szene.farben.kelvin,
           sonneA: a.szene.sonne.stunde, sonneB: b.szene.sonne.stunde };
});
pruefe('jede Folie trägt beim Anlegen die Szene', folien.szeneA && folien.szeneB);
pruefe('mit den Werten von damals', folien.kelvinA === 5000 && folien.kelvinB === 7500 && folien.sonneA === 9 && folien.sonneB === 17);

// Wählen stellt die Szene her
await page.evaluate(async (id) => { Praesentation.waehlen(id); await new Promise((r) => setTimeout(r, 600)); }, folien.a);
const gewaehlt = await page.evaluate(() => ({ kelvin: BimViewer.Farben.stand().kelvin, stunde: BimViewer.lighting.stunde, aufh: BimViewer.Licht.stand().aufhellung }));
pruefe('Wählen einer Folie stellt ihre Szene her (Weißabgleich, Sonne, Licht)',
  gewaehlt.kelvin === 5000 && gewaehlt.stunde === 9 && Math.abs(gewaehlt.aufh - 0.1) < 1e-6, JSON.stringify(gewaehlt));

// Auto-Play: die weichen Größen fahren mit
await page.evaluate(() => {
  window.__proben = [];
  Praesentation.waehlen(Praesentation.folien()[0].id, false);
  window.__takt = setInterval(() => {
    window.__proben.push({ modus: Praesentation.zustand().modus, kelvin: BimViewer.Farben.stand().kelvin,
                           stunde: BimViewer.lighting.stunde, aufh: BimViewer.Licht.stand().aufhellung });
  }, 80);
  Praesentation.auto();
});
await page.waitForFunction(() => window.__proben.some((p) => p.modus === 'auto'), { timeout: 60000 });
await page.waitForFunction(() => Praesentation.zustand().modus === 'ruhe', { timeout: 120000 });
const fahrt = await page.evaluate(() => {
  clearInterval(window.__takt);
  const p = window.__proben.filter((x) => x.modus === 'auto');
  const k = p.map((x) => x.kelvin), s = p.map((x) => x.stunde), a = p.map((x) => x.aufh);
  const zwischen = (v, lo, hi) => v.filter((x) => x > lo + 1 && x < hi - 1).length;
  return {
    n: p.length, kStart: k[0], kEnde: k[k.length - 1], sEnde: s[s.length - 1], aEnde: a[a.length - 1],
    kZwischen: zwischen(k, 5000, 7500), sZwischen: zwischen(s, 9, 17) , aZwischen: a.filter((x) => x > 0.11 && x < 0.49).length,
    kMonoton: k.every((x, i) => i === 0 || x >= k[i - 1] - 1e-6),
    endeStand: { kelvin: BimViewer.Farben.stand().kelvin, stunde: BimViewer.lighting.stunde, aufh: BimViewer.Licht.stand().aufhellung },
  };
});
pruefe('die Vorführung lief (mehrere Bilder gemessen)', fahrt.n > 10, String(fahrt.n));
pruefe('der Weißabgleich liegt zwischendurch ZWISCHEN den beiden Folien', fahrt.kZwischen >= 2, `${fahrt.kZwischen} Bilder dazwischen`);
pruefe('… und wandert nur in eine Richtung', fahrt.kMonoton);
pruefe('die Sonne wandert mit', fahrt.sZwischen >= 2, `${fahrt.sZwischen} Bilder dazwischen`);
pruefe('das Licht fährt mit', fahrt.aZwischen >= 2, `${fahrt.aZwischen} Bilder dazwischen`);
pruefe('am Ende steht die Szene der zweiten Folie EXAKT',
  Math.abs(fahrt.endeStand.kelvin - 7500) < 0.01 && fahrt.endeStand.stunde === 17 && Math.abs(fahrt.endeStand.aufh - 0.5) < 1e-6, JSON.stringify(fahrt.endeStand));

// Esc stellt die Szene von vorher wieder her
const esc = await page.evaluate(async () => {
  BimViewer.Farben.kelvinSetzen(6300);   // die „Szene von vorher"
  BimViewer.setLightingTime(12);
  await Praesentation.praesentieren(0);
  await new Promise((r) => setTimeout(r, 1500));
  const mitten = BimViewer.Farben.stand().kelvin;
  Praesentation.beenden(true);
  await new Promise((r) => setTimeout(r, 1200));
  return { mitten, danach: BimViewer.Farben.stand().kelvin, stunde: BimViewer.lighting.stunde, modus: Praesentation.zustand().modus };
});
pruefe('während der manuellen Show gilt die Szene der Folie', esc.mitten === 5000, String(esc.mitten));
pruefe('Esc stellt die Szene von vorher wieder her', esc.danach === 6300 && esc.stunde === 12 && esc.modus === 'ruhe', JSON.stringify(esc));

// Datei
const datei = await page.evaluate(() => {
  const text = Praesentation.jsonAusgeben();
  const d = JSON.parse(text);
  const n = Praesentation.folien().length;
  Praesentation.leeren();
  Praesentation.jsonEinlesen(text);
  return { version: d.version, szene: !!d.folien[0].szene, kelvin: d.folien[1].szene.farben.kelvin,
           zurueck: Praesentation.folien().length === n, zurueckKelvin: Praesentation.folien()[1].szene.farben.kelvin };
});
pruefe('das Deck trägt die Szene durch Sichern und Laden', datei.version === 2 && datei.szene && datei.kelvin === 7500 && datei.zurueck && datei.zurueckKelvin === 7500);

// Szene aufnehmen / entfernen
const edit = await page.evaluate(() => {
  const f = Praesentation.folien()[0];
  Praesentation.szeneEntfernen(f.id);
  const weg = Praesentation.folien()[0].szene === null;
  BimViewer.Farben.kelvinSetzen(5800);
  Praesentation.szeneAufnehmen(f.id);
  return { weg, neu: Praesentation.folien()[0].szene.farben.kelvin };
});
pruefe('Szene entfernen und neu aufnehmen', edit.weg && edit.neu === 5800);

pruefe('keine Seitenfehler', seitenfehler.length === 0, seitenfehler.join(' | '));
await browser.close();
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
