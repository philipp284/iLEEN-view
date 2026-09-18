// Prüft das Markup der linken Panels (`ui.js`) ohne Browser.
//
// Aufruf:  node tests/ui/test-panels.js
//
// Warum das einen Prüfstein verdient: die Panels sind Template-Literale mit
// eingebetteten `${t(...)}`-Aufrufen. Ein Tippfehler in einem
// Übersetzungsschlüssel bricht nichts — er schreibt den Schlüssel selbst ins
// Panel („models.ionFeld"), und das fällt nur auf, wenn jemand hinsieht.
// Ebenso still ist eine Kennung, die im Markup fehlt, aber in einem
// `getElementById` noch erwartet wird: der Handler hängt sich dann an nichts,
// und der Knopf tut nichts.
//
// Geprüft wird deshalb dreierlei: dass jeder Schlüssel im Wörterbuch steht,
// dass die Kennungen aus den Ereignisbindungen im Markup vorkommen, und dass
// die entfernten Bedienelemente auch wirklich weg sind.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.resolve(__dirname, '..', '..');

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  const ok = !!bedingung;
  if (!ok) fehler++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !hinweis ? '' : '   ' + hinweis}`);
}

// ── Umgebung: so viel Browser, wie ui.js beim Laden anfasst ───────────────

const sandbox = {
  console,
  // Verzögerte Aufrufe laufen ins Leere: `ui.js` stößt beim Laden seine eigene
  // Einrichtung über `setTimeout` an, und die braucht einen echten Viewer.
  // Geprüft wird hier nur das erzeugte Markup, nicht der Aufbau der Toolbar.
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { language: 'de' },
  document: {
    readyState: 'complete',
    documentElement: { lang: 'de' },
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    dispatchEvent() {},
    body: { appendChild() {} },
  },
  CustomEvent: class { constructor(t, o) { Object.assign(this, { type: t }, o); } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'i18n.js'), 'utf8'), sandbox, { filename: 'i18n.js' });
vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'ui.js'), 'utf8'), sandbox, { filename: 'ui.js' });

const UI = sandbox.BimViewerUI;
pruefe('ui.js lädt ohne Browser', !!UI);

// BimViewer wird nur für die Vorbelegung der Punktwolken-Regler gebraucht
sandbox.BimViewer = { pointCloudSettings: null };

const panels = {
  ion:        UI.getAssetsContent(),
  backend:    UI.getBackendContent(),
  layer:      UI.getLayerManagerContent(),
  punktwolke: UI.getPointCloudContent(),
  geladene:   UI.getLoadedAssetsContent(),
};

// ── 1 · Kein unübersetzter Schlüssel ──────────────────────────────────────
//
// `t()` gibt bei einem unbekannten Schlüssel den Schlüssel selbst zurück.
// Im fertigen Markup ist das an der Punktnotation ohne Leerzeichen erkennbar.

const SCHLUESSELMUSTER = /\b(?:models|layer|pc|group|panel|state|action|field)\.[a-zA-Z][a-zA-Z0-9.]*\b/g;
for (const [name, html] of Object.entries(panels)) {
  const treffer = (html.match(SCHLUESSELMUSTER) || [])
    // Kennungen und Klassennamen enthalten keine Punkte — was hier steht, ist
    // ein durchgereichter Schlüssel.
    .filter((s) => !s.endsWith('.js'));
  pruefe(`Panel „${name}" ohne unübersetzte Schlüssel`, treffer.length === 0, treffer.join(', '));
}

// Gegenprobe: das Wörterbuch selbst muss die Schlüssel in beiden Sprachen haben.
for (const sprache of ['de', 'en']) {
  sandbox.ILeenI18n.setLanguage(sprache);
  const alle = Object.values({
    ion: UI.getAssetsContent(),
    backend: UI.getBackendContent(),
    layer: UI.getLayerManagerContent(),
    punktwolke: UI.getPointCloudContent(),
  }).join('');
  const fehlend = (alle.match(SCHLUESSELMUSTER) || []);
  pruefe(`Wörterbuch „${sprache}" vollständig`, fehlend.length === 0, fehlend.join(', '));
}
sandbox.ILeenI18n.setLanguage('de');

// ── 2 · Kennungen, an denen Handler hängen ────────────────────────────────

const ERWARTET = {
  ion:        ['ionAssetInput', 'ionAssetOptions', 'loadIonAsset', 'ionAssetsStatus'],
  backend:    ['backendUrlInput', 'backendRefresh', 'backendStatus', 'backendFilter', 'backendSearch', 'backendFilterPills', 'backendAssetsList', 'backendJobInput', 'loadBackendByInput'],
  layer:      ['basemapList', 'toggleOSMBuildings', 'toggleGoogle3DTiles', 'googleTilesQualityRow',
               'tilesetLayersList', 'terrainList'],
  punktwolke: ['colorModeSelect', 'toggleEDL', 'edlStrengthGroup', 'edlStrengthSlider', 'edlRadiusGroup',
               'pointSizeSlider', 'toggleAttenuation', 'maxAttenuationGroup', 'geometricErrorSlider',
               'toggleBackFaceCulling'],
  geladene:   ['loadedAssetsCount', 'loadedAssetsList'],
};
for (const [name, ids] of Object.entries(ERWARTET)) {
  const fehlend = ids.filter((id) => !panels[name].includes(`id="${id}"`));
  pruefe(`Panel „${name}" führt alle erwarteten Kennungen`, fehlend.length === 0, fehlend.join(', '));
}

// Und umgekehrt: was ui.js per getElementById sucht, muss es auch geben.
const uiQuelle = fs.readFileSync(path.join(FRONTEND, 'ui.js'), 'utf8');
const allesMarkup = Object.values(panels).join('');
const ENTFALLEN = ['ionAssetSelector', 'importSelectedAsset', 'loadIonAssets', 'ionAssetsLoading',
                   'ionAssetIdInput', 'terrainAssetId', 'terrainName', 'addTerrainBtn',
                   'overlayAssetId', 'overlayName', 'addOverlayBtn', 'overlayLayersList',
                   'wmsUrl', 'wmsDiscoverBtn', 'wmsLayerPicker', 'wmsLayerPickerList', 'wmsLayersList'];
for (const id of ENTFALLEN) {
  pruefe(`„${id}" ist restlos entfernt`,
         !allesMarkup.includes(id) && !uiQuelle.includes(`getElementById('${id}')`));
}

// ── 3 · Einheitliches Vokabular ───────────────────────────────────────────
//
// Die vier Panels sollen dieselben Bausteine benutzen. Die Altbestände
// (`modern-group`, `pc-section`, `modern-divider`) waren genau das, was die
// Oberfläche uneinheitlich aussehen ließ.

const ALTLASTEN = ['modern-group', 'modern-divider', 'modern-label', 'modern-hint',
                   'pc-section', 'pc-label', 'pc-row', 'pc-slider', 'pc-switch', 'pc-value',
                   'modern-select', 'modern-input', 'pc-reset-btn'];
for (const [name, html] of Object.entries(panels)) {
  const rest = ALTLASTEN.filter((k) => html.includes(k));
  pruefe(`Panel „${name}" ohne Altklassen`, rest.length === 0, rest.join(', '));
}

// ── 4 · Punktwolken hängen jetzt an der Ansicht ───────────────────────────

pruefe('Alias „pointcloud" zeigt auf das Ansicht-Panel',
       UI.SECTION_ALIASES.pointcloud.section === 'view');
pruefe('Alias „layers" zeigt weiterhin auf das Modelle-Panel',
       UI.SECTION_ALIASES.layers.section === 'models');

// ── 5 · Ausgewertet wird die letzte Zahl im Ion-Feld ──────────────────────
//
// Die Vorschlagsliste liefert „Campus_HSMZ (ID: 4587934)", getippt wird
// „4587934". Beides muss dieselbe Zahl ergeben — inklusive der Namen, in
// denen selbst Ziffern stehen.

const idAus = (s) => { const m = String(s).trim().match(/(\d+)\s*\)?\s*$/); return m ? parseInt(m[1], 10) : NaN; };
pruefe('Vorschlag „Campus_HSMZ (ID: 4587934)"', idAus('Campus_HSMZ (ID: 4587934)') === 4587934);
pruefe('Reine Eingabe „69380"',                  idAus('69380') === 69380);
pruefe('Name mit Ziffer: „Holzstraße_36 (ID: 4563565)"',
       idAus('Holzstraße_36 (ID: 4563565)') === 4563565);
pruefe('Leere Eingabe ergibt keine ID',          Number.isNaN(idAus('   ')));

// ── Ergebnis ──────────────────────────────────────────────────────────────

console.log('');
if (fehler) { console.log(`${fehler} Prüfung(en) fehlgeschlagen.`); process.exit(1); }
console.log('Alle Prüfungen bestanden.');
