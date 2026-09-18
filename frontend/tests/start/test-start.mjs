// Der Start-Prüfstein: lädt iLEEN-view im echten Browser und sieht nach, ob
// etwas kaputt ist.
//
// Voraussetzung: puppeteer-core (`npm i --no-save puppeteer-core`) und ein
// laufender Dev-Server auf Port 5190 (`npx vite`) — NICHT 5181, dort läuft die
// Vollfassung, und der Prüfstein würde sie messen statt dieser Fassung.
//
// Aufruf:  node tests/start/test-start.mjs
//
// Warum ausgerechnet dieser
// =========================
// Alle anderen Prüfsteine hier laufen ohne Browser: sie laden ein Modul in
// eine `vm` und prüfen seine Rechnung. Das ist schnell und sagt viel — aber
// eine Sache sagt es grundsätzlich nicht: ob die 50 Skripte, die `index.html`
// in einer bestimmten Reihenfolge einbindet, zusammen überhaupt hochkommen.
//
// Genau das ist der Fehler, den ein Zuschnitt erzeugt. Fehlt ein Modul, auf
// das ein anderes ungeschützt zugreift, wirft der Browser beim Laden, der
// Rest der Datei läuft nicht mehr, und das Ergebnis ist kein Absturz, sondern
// eine Anwendung, in der irgendein Werkzeug stillschweigend nichts tut.
// Denselben Fehler gab es beim Bauen dieser Fassung tatsächlich: eine `const`
// stand hinter ihrer Verwendung, `aufmass-fang.js` warf beim Laden, und der
// Messmodus fiel wortlos auf seinen Rückfallweg zurück.
//
// Geprüft wird deshalb die Startbedingung und sonst nichts:
//   · keine Fehler in der Konsole, keine unbehandelte Ausnahme
//   · jedes Modul hat seinen globalen Namen angelegt
//   · der Viewer steht, die Szene zeichnet
//   · jedes Panel lässt sich öffnen und baut sein Markup
//   · kein unaufgelöster Übersetzungsschlüssel im Bild
//   · nichts verweist auf ein Modul, das es hier nicht gibt
//   · die Trennung hält: links nur Viewer, rechts kein einziger Reiter

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5190/';

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '\n      ' + hinweis : ''}`); }
}

// Module, die sich mit ihrem globalen Namen melden müssen. Die Liste ist der
// eigentliche Zuschnitt dieser Fassung — was hier steht, gehört zum Viewer.
const ERWARTET = [
  'BimViewer', 'BimViewerUI', 'ILeenI18n', 'WalkMode', 'FlugTrackpad', 'Greifweite',
  'AufmassFang', 'AufmassPanel', 'SplatPick', 'LayerManager', 'Tags',
  'FpsAnzeige',
];

// Dieselbe Frage für die Module, die sich unter `BimViewer` anmelden statt
// unter `window`.
const ERWARTET_BV = ['Aufmass', 'SectionBox', 'Explosion', 'Bildebenen', 'Untergrund'];

// Und die Gegenprobe: was hier steht, darf es NICHT geben. Ohne sie fiele
// nicht auf, wenn ein Analysewerkzeug über eine vergessene Einbindung
// zurückkommt — und dann läge es im öffentlichen Repo.
const VERBOTEN = [
  'SolarAnalysis', 'IFClash', 'FlugTracker', 'Bauplaner', 'KonzeptPanel',
  'Konzept4D', 'Sim4DHud', 'IFC4D', 'Stage4D', 'AufmassRDF', 'AufmassMengen',
  // Die Anmelde-Dateien der Auswertungen. Sie sind der eigentliche Zuschnitt
  // seit der Trennung: das Panelgerüst links wie rechts ist in beiden
  // Fassungen dieselbe Datei, verschieden ist nur, wer sich anmeldet.
  'SolarPanel', 'BimLpPanel', 'IFClashPanel', 'RoomConceptPanel',
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--window-size=1280,900'],
});

try {
  const seite = await browser.newPage();
  await seite.setViewport({ width: 1280, height: 900 });

  const konsole = [];
  const geworfen = [];
  seite.on('console', (m) => { if (m.type() === 'error') konsole.push(m.text()); });
  seite.on('pageerror', (e) => geworfen.push(String(e)));
  // Ein fehlendes Skript meldet sich nicht in der Konsole, sondern als
  // gescheiterte Anfrage — sonst bliebe genau der Fehler unbemerkt, den ein
  // Zuschnitt erzeugt.
  // Nur Skripte und Stylesheets. Ein nicht erreichbares Backend
  // (`localhost:8100/assets/`) ist hier kein Befund — die Anwendung läuft
  // ohne, und der Prüfstein soll nicht davon abhängen, dass es läuft.
  const istCode = (u) => /\.(js|mjs|css)(\?|$)/.test(u);
  const fehlend = [];
  seite.on('requestfailed', (r) => { if (istCode(r.url())) fehlend.push(r.url()); });
  seite.on('response', (r) => {
    if (r.status() >= 400 && istCode(r.url())) fehlend.push(r.url() + ' → ' + r.status());
  });

  // `domcontentloaded` und nicht `networkidle`: der Viewer lädt dauernd
  // Kacheln nach und kommt nie zur Ruhe — ein Warten auf Netzstille läuft
  // immer in den Zeitablauf. Gewartet wird stattdessen auf den Viewer selbst.
  await seite.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Misst der Prüfstein überhaupt diese Anwendung? Ein belegter Port lässt
  // `vite` mit `strictPort` gar nicht erst starten, und dann antwortet
  // irgendein anderes Projekt derselben Werkstatt mit HTTP 200. Das ist beim
  // Bauen dieser Fassung zweimal passiert — einmal war es die Vollfassung
  // (und alle Module waren „vorhanden"), einmal eine fremde React-App (und
  // keines). Beides ist ohne diese Prüfung stundenlang verwirrend.
  const titel = await seite.title();
  if (!/iLEEN/i.test(titel)) {
    console.log(`✗ auf ${URL} antwortet nicht iLEEN-view, sondern „${titel}"`);
    console.log('      Läuft dort ein anderes Projekt? `npx vite` im Viewer starten');
    await browser.close();
    process.exit(1);
  }
  // Der Viewer wird asynchron angelegt; ohne dieses Warten prüft man den
  // Zustand vor dem Start und findet nie einen Fehler.
  await seite.waitForFunction(
    () => window.BimViewer && window.BimViewer.viewer && window.BimViewer.viewer.scene,
    { timeout: 45000 });
  await new Promise((r) => setTimeout(r, 3000));

  // ── 1 · Nichts ist beim Laden geworfen ──────────────────────────────────

  pruefe('keine unbehandelte Ausnahme beim Start', geworfen.length === 0,
    geworfen.slice(0, 3).join('\n      '));
  pruefe('keine Datei fehlt', fehlend.length === 0,
    fehlend.slice(0, 5).join('\n      '));

  // Cesiums eigene Meldungen über fehlendes WebGL, ion-Token oder Kacheln
  // sind hier kein Befund: der Prüfstein läuft ohne Token und auf einem
  // Software-Renderer. Alles andere schon.
  const eigene = konsole.filter((t) => !/ion|token|terrain|tile|WebGL|GPU|SwiftShader|CORS|401|403|Failed to fetch|net::/i.test(t));
  pruefe('keine eigenen Fehler in der Konsole', eigene.length === 0,
    eigene.slice(0, 5).join('\n      '));

  // ── 2 · Jedes Modul ist da ──────────────────────────────────────────────

  const vorhanden = await seite.evaluate((namen) =>
    namen.filter((n) => typeof window[n] === 'undefined'), ERWARTET);
  pruefe('jedes Viewer-Modul hat sich angemeldet', vorhanden.length === 0,
    'fehlt: ' + vorhanden.join(', '));

  const vorhandenBV = await seite.evaluate((namen) =>
    namen.filter((n) => !window.BimViewer[n]), ERWARTET_BV);
  pruefe('jedes Werkzeug hängt an BimViewer', vorhandenBV.length === 0,
    'fehlt: ' + vorhandenBV.join(', '));

  const uebrig = await seite.evaluate((namen) =>
    namen.filter((n) => typeof window[n] !== 'undefined'), VERBOTEN);
  pruefe('kein Analysewerkzeug ist übrig geblieben', uebrig.length === 0,
    'gefunden: ' + uebrig.join(', '));

  // ── 3 · Die Szene zeichnet ──────────────────────────────────────────────

  const szene = await seite.evaluate(() => {
    const v = window.BimViewer.viewer;
    return { bilder: v.scene.frameState.frameNumber, breite: v.canvas.width };
  });
  pruefe('die Szene hat Bilder gezeichnet', szene.bilder > 1, 'frameNumber=' + szene.bilder);
  pruefe('die Leinwand hat eine Größe', szene.breite > 100);

  // ── 4 · Jedes Panel geht auf und baut sein Markup ───────────────────────

  const PANELS = ['models', 'view', 'ifc', 'tools', 'tags', 'settings', 'about'];
  for (const id of PANELS) {
    const erg = await seite.evaluate((p) => {
      try { window.BimViewerUI.activateSection(p); } catch (e) { return { fehler: String(e) }; }
      const el = document.getElementById('section-' + p);
      return { da: !!el, laenge: el ? el.innerHTML.length : 0 };
    }, id);
    pruefe(`Panel „${id}" öffnet und ist gefüllt`,
      !erg.fehler && erg.da && erg.laenge > 200,
      erg.fehler || `da=${erg.da} laenge=${erg.laenge}`);
  }

  // ── 4b · Die Trennung hält ─────────────────────────────────────────────
  //
  // Der Kern dieser Fassung. Links stehen die Viewer-Werkzeuge, rechts stünden
  // die Auswertungen — und rechts ist hier nichts angemeldet. Das Gerüst
  // (`right-panel.js`) wird trotzdem ausgeliefert: es ist die Fassung, in die
  // sich ein Analysewerkzeug einhängen kann, wenn eines dazukommen soll.
  //
  // Diese Prüfung ist der Grund, warum eine vergessene `<script>`-Zeile nicht
  // stillschweigend im öffentlichen Repo landet: ein eingebundenes
  // Auswertungswerkzeug meldet hier sofort einen Reiter an.

  const trennung = await seite.evaluate(() => ({
    // `RightPanel` ist ein `const` im Skript-Bereich und steht NICHT auf
    // `window` — `window.RightPanel` wäre immer undefined und die Prüfung
    // immer grün. Deshalb der blosse Name.
    rpDa: typeof RightPanel !== 'undefined',
    reiter: typeof RightPanel !== 'undefined' ? RightPanel.reiterListe : ['<RightPanel fehlt>'],
    reiterKnoepfe: [...document.querySelectorAll('#roleBar [data-reiter-btn]')]
      .map((b) => b.dataset.reiterBtn),
    anmeldenDa: typeof RightPanel !== 'undefined'
      && typeof RightPanel.reiterAnmelden === 'function'
      && typeof RightPanel.brueckeAnmelden === 'function',
    bereichAnmeldenDa: typeof window.BimViewerUI.bereichAnmelden === 'function'
      && typeof window.BimViewerUI.gruppeAnmelden === 'function',
    bereiche: [...document.querySelectorAll('#activityBar .activity-btn[data-section]')]
      .map((b) => b.dataset.section),
    gruppen: [...document.querySelectorAll('#sidebarPanel details.panel-group')]
      .map((d) => d.id).filter(Boolean),
    // Brückennamen, die nur eine Auswertung anhängt. Sind sie da, ist eine
    // Auswertung mitgeliefert worden.
    bruecken: typeof RightPanel !== 'undefined'
      ? ['solarShowLoading', 'solarShowError', '_selectLp', '_selectPhase', '_resetLpFilter']
          .filter((n) => typeof RightPanel[n] === 'function')
      : [],
  }));

  pruefe('das Panelgerüst der rechten Seite ist da', trennung.rpDa);
  pruefe('die Anmeldung rechts ist benutzbar', trennung.anmeldenDa,
    'reiterAnmelden/brueckeAnmelden fehlen — das Gerüst ist kein Gerüst mehr');
  pruefe('die Anmeldung links ist benutzbar', trennung.bereichAnmeldenDa,
    'bereichAnmelden/gruppeAnmelden fehlen in BimViewerUI');
  pruefe('rechts ist kein Reiter angemeldet', trennung.reiter.length === 0,
    'angemeldet: ' + trennung.reiter.join(', '));
  pruefe('rechts steht kein Werkzeugknopf', trennung.reiterKnoepfe.length === 0,
    'gefunden: ' + trennung.reiterKnoepfe.join(', '));
  pruefe('keine Auswertung hat sich an die Brücke gehängt', trennung.bruecken.length === 0,
    'gefunden: ' + trennung.bruecken.join(', '));

  // Links die Gegenprobe: die Gruppen der Auswertungen dürfen nicht auftauchen.
  const VERBOTENE_GRUPPEN = ['group-rooms', 'group-clash'];
  const fremdeGruppen = VERBOTENE_GRUPPEN.filter((g) => trennung.gruppen.includes(g));
  pruefe('links steht keine Auswertungs-Gruppe', fremdeGruppen.length === 0,
    'gefunden: ' + fremdeGruppen.join(', '));

  // Und die Viewer-Seite ist vollständig.
  const ERWARTETE_BEREICHE = ['models', 'view', 'ifc', 'tools', 'tags', 'settings', 'about'];
  const fehlendeBereiche = ERWARTETE_BEREICHE.filter((b) => !trennung.bereiche.includes(b));
  pruefe('jeder Viewer-Bereich steht in der Leiste', fehlendeBereiche.length === 0,
    'fehlt: ' + fehlendeBereiche.join(', '));

  // Der 360°-Rundgang gehört in den Asset-Browser und nicht als eigenes Symbol
  // in die Leiste — eine Tour ist ein geladener Bestand wie ein Modell.
  pruefe('der 360°-Rundgang hängt im Asset-Browser',
    trennung.gruppen.includes('group-panotour') && !trennung.bereiche.includes('panotour'),
    'Gruppen: ' + trennung.gruppen.join(', ') + ' — Bereiche: ' + trennung.bereiche.join(', '));

  // ── 5 · Keine unaufgelösten Übersetzungsschlüssel ───────────────────────
  //
  // `t()` gibt bei einem fehlenden Schlüssel den Schlüssel selbst aus. Das ist
  // beim Entwickeln richtig und im Bild eines Releases ein Fehler.

  for (const sprache of ['de', 'en']) {
    const roh = await seite.evaluate((spr) => {
      window.ILeenI18n.setLanguage(spr);
      const text = document.getElementById('toolbar').textContent;
      const praefixe = [...new Set(Object.keys(window.ILeenI18n.dict
        ? window.ILeenI18n.dict() : {}).map((k) => k.split('.')[0]))];
      const muster = praefixe.length
        ? new RegExp('\\b(?:' + praefixe.join('|') + ')\\.[a-zA-Z][a-zA-Z0-9]{2,24}\\b', 'g')
        : /\b(?:panel|group|action|state|am|pc|layer|props|anno|terrain)\.[a-zA-Z][a-zA-Z0-9]{2,24}\b/g;
      return [...new Set(text.match(muster) || [])];
    }, sprache);
    pruefe(`kein unaufgelöster Schlüssel im Bild (${sprache})`, roh.length === 0,
      roh.slice(0, 6).join(', '));
  }
  await seite.evaluate(() => window.ILeenI18n.setLanguage('de'));

  // ── 6 · Die reparierten Stellen sind wirklich repariert ─────────────────

  const pc = await seite.evaluate(() => ({
    sse: window.BimViewer.pointCloudSettings.maximumScreenSpaceError,
    att: window.BimViewer.pointCloudSettings.attenuationEnabled,
    laden: typeof window.BimViewer.pointCloudLoadOptions === 'function',
    mesh: typeof window.BimViewer.meshLoadOptions === 'function',
    wache: !!window.BimViewer._speicherWache,
  }));
  pruefe('die Punktwolken-Detailstufe steht auf dem neuen Wert', pc.sse >= 16);
  pruefe('die Abschwächung ist an', pc.att === true);
  pruefe('die Ladeoptionen sind erreichbar', pc.laden && pc.mesh);
  pruefe('die Speicherwache läuft', pc.wache);

  const mesh = await seite.evaluate(() => window.BimViewer.meshLoadOptions());
  pruefe('Mesh-Tilesets bekommen einen Kachelspeicher', mesh.cacheBytes > 0);
  pruefe('und einen Überlauf dazu', mesh.maximumCacheOverflowBytes > 0);
  pruefe('skipLevelOfDetail ist aus (die Tilesets verfeinern additiv)',
    mesh.skipLevelOfDetail === false);

  const fang = await seite.evaluate(() => ({
    ziel: window.AufmassFang.ziel,
    ziele: window.AufmassFang.ziele(),
    kreuz: typeof window.FlugTrackpad.haeltZeiger === 'function',
  }));
  pruefe('der Messmodus startet auf „alles"', fang.ziel === 'auto');
  pruefe('alle vier Messziele sind da', fang.ziele.length === 4);
  pruefe('das Fadenkreuz kennt den Zeigerfang', fang.kreuz);

  // ── 7 · Der Messmodus läuft an und wieder ab ────────────────────────────

  const messen = await seite.evaluate(() => {
    const a = window.BimViewer.Aufmass;
    if (!a) return { fehler: 'kein Aufmaß' };
    try {
      const an = a.start ? a.start() : a.umschalten(true);
      const z = a.zustand();
      a.stop ? a.stop() : a.umschalten(false);
      return { an: !!an, aktiv: !!z.aktiv, ziel: z.ziel };
    } catch (e) { return { fehler: String(e) }; }
  });
  pruefe('der Messmodus startet ohne Ausnahme', !messen.fehler, messen.fehler);
  pruefe('und meldet sein Ziel', messen.ziel === 'auto');

  console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
} finally {
  await browser.close();
}
process.exit(fehler ? 1 : 0);
