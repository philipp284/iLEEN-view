// Prüft den Bauteilfilter ohne Browser.
//
// Aufruf:  node tests/filter/test-ifc-filter.js
//
// Der Fehler, der diesen Prüfstein veranlasst hat: `show` war ein ODER über
// alle *angehakten* Typen. Damit entschied die gepflegte Typenliste über die
// Sichtbarkeit — wer einen einzigen Haken löste, verlor zusätzlich alles,
// dessen Typ nicht in IFC_ENTITIES stand. Bei mehrschichtigen Wänden waren
// das sämtliche IfcBuildingElementPart, und im Bild sah es aus wie ein
// kaputtes Modell, nicht wie ein Filter.
//
// Geprüft wird deshalb:
//   1. dass `show` als Ausschluss gebaut wird — ein unbekannter Typ bleibt
//      stehen, ein abgewählter verschwindet;
//   2. dass "Keine" trotzdem wirklich alles ausblendet;
//   3. dass der Typ-Scan aus der Batch Table meldet, was das Modell führt,
//      und unbekannte Typen einer Kategorie zuordnet;
//   4. dass der Kategorieschalter die Typen seiner Kategorie trifft — und nur
//      die, die im Modell vorkommen.

const path = require('path');

// ── Umgebung: so viel Cesium, wie der Filter beim Laden und Rechnen anfasst ─

const stile = [];   // jeder gesetzte Tileset-Stil, in der Reihenfolge

globalThis.window = { innerWidth: 1600, innerHeight: 900 };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, appendChild() {}, classList: { add() {}, remove() {} } }),
  querySelector: () => null,
  body: { appendChild() {} },
};
globalThis.Cesium = {
  Color: Object.assign(class { }, { YELLOW: {}, fromCssColorString: () => ({}) }),
  Cesium3DTileStyle: class { constructor(def) { this.definition = def; stile.push(def); } },
  ScreenSpaceEventHandler: class { setInputAction() {} destroy() {} },
  ScreenSpaceEventType: { LEFT_CLICK: 0, MOUSE_MOVE: 1 },
  defined: (v) => v !== undefined && v !== null,
};

const FRONTEND = path.resolve(__dirname, '..', '..');

// IFC_ENTITIES und ifcTypEinordnen stehen in core.js — core.js selbst zieht
// den halben Viewer nach, deshalb wird nur der Definitionsteil ausgeschnitten
// und ausgeführt. Die Grenze ist die Zeile hinter ifcTypEinordnen().
const fs = require('fs');
const vm = require('vm');
const coreQuelle = fs.readFileSync(path.join(FRONTEND, 'core.js'), 'utf8');
const von = coreQuelle.indexOf('const IFC_ENTITIES = [');
const bis = coreQuelle.indexOf('// ── Ende der IFC-Typenliste');
if (von < 0 || bis < 0) { console.error('✗ IFC_ENTITIES-Block in core.js nicht gefunden'); process.exit(1); }
vm.runInThisContext(coreQuelle.slice(von, bis) +
  '\nglobalThis.IFC_ENTITIES = IFC_ENTITIES; globalThis.ifcTypEinordnen = ifcTypEinordnen;');

globalThis.BimViewer = {
  loadedAssets: new Map(),
  drawing: { active: false, positions: [], polygon: null, visible: true, clipBoth: false },
  savedViews: new Map(),
  ifcFilter: { enabledEntities: new Set(), allEntities: new Set() },
  revitFilter: { enabledCategories: new Set(), allCategories: new Set() },
  viewer: { scene: { canvas: {}, primitives: { length: 0 } } },
  updateStatus() {},
  updateModeIndicator() {},
  isPointCloudTileset: () => false,
  reapplyHiddenFeatures() {},
};
globalThis.window.BimViewer = globalThis.BimViewer;

require(path.join(FRONTEND, 'features.js'));

let fehler = 0;
function pruefe(name, bedingung, zusatz) {
  const ok = !!bedingung;
  if (!ok) fehler++;
  console.log((ok ? '✓ ' : '✗ ') + name + (zusatz ? '   ' + zusatz : ''));
}
function abschnitt(titel) {
  console.log(`\n── ${titel} ${'─'.repeat(Math.max(2, 60 - titel.length))}`);
}

// ── Ein Modell, wie das Backend es liefert ────────────────────────────────
//
// Die Batch Table der Backend-Tiles führt IfcType (tiling/formats/ifc.py).
// IfcBuildingElementPart steht bewusst dabei: der Typ, an dem der Fehler
// aufgefallen ist.

const TYPEN_IM_MODELL = [
  'IfcWall', 'IfcWall', 'IfcWall',
  'IfcSlab', 'IfcSlab',
  'IfcBuildingElementPart', 'IfcBuildingElementPart', 'IfcBuildingElementPart',
  'IfcDoor',
  'IfcPumpConnector',           // kennt die Typenliste nicht — Heuristik: mep
];

function tilesetBauen(typen) {
  const content = {
    featuresLength: typen.length,
    getFeature: (i) => ({
      getProperty: (name) => (name === 'IfcType' ? typen[i] : undefined),
      getPropertyIds: () => ['GlobalId', 'IfcType', 'Name', 'Geschoss'],
    }),
  };
  return {
    root: { content, children: [] },
    _selectedTiles: [{ content }],
    tileLoad: { addEventListener() {} },
    style: undefined,
  };
}

function assetSetzen(typen) {
  stile.length = 0;
  BimViewer.loadedAssets.clear();
  BimViewer._gescannteContents = new WeakSet();
  BimViewer.ifcFilter.gefundeneTypen = new Map();
  BimViewer.ifcFilter.enabledEntities = new Set();
  BimViewer.ifcFilter.allEntities = new Set();
  IFC_ENTITIES.forEach(e => {
    BimViewer.ifcFilter.allEntities.add(e.entity);
    BimViewer.ifcFilter.enabledEntities.add(e.entity);
  });
  const assetData = {
    tileset: tilesetBauen(typen),
    ifcPropertyName: 'IfcType',
    opacity: 1.0,
    isPointCloud: false,
  };
  BimViewer.loadedAssets.set('1', assetData);
  return assetData;
}

/** Wertet eine `show`-Bedingung für einen Typ aus (String-Vergleiche wie Cesium). */
function sichtbar(showAusdruck, typ) {
  if (showAusdruck === true) return true;
  if (showAusdruck === false) return false;
  const term = String(showAusdruck).replace(/\$\{IfcType\}/g, JSON.stringify(typ));
  return vm.runInNewContext(term);
}

// Der Filterlauf ist asynchron, CommonJS kennt kein Top-Level-await.
async function main() {

// ══════════════════════════════════════════════════════════════════════════
abschnitt('Typ-Scan: was steht wirklich im Modell?');

let asset = assetSetzen(TYPEN_IM_MODELL);
const neue = BimViewer.scanIFCTypes(asset);

const gefunden = BimViewer.ifcFilter.gefundeneTypen;
pruefe('Alle fünf Typen des Modells erkannt', gefunden.size === 5,
  `gefunden: ${Array.from(gefunden.keys()).join(', ')}`);
pruefe('IfcBuildingElementPart mit richtiger Anzahl',
  gefunden.get('IfcBuildingElementPart') === 3,
  `gezählt: ${gefunden.get('IfcBuildingElementPart')}`);
pruefe('Der unbekannte Typ wurde nachgemeldet', neue === 1,
  `neue Typen: ${neue}`);
pruefe('Unbekannter Typ ist jetzt filterbar',
  BimViewer.ifcFilter.allEntities.has('IfcPumpConnector') &&
  BimViewer.ifcFilter.enabledEntities.has('IfcPumpConnector'));

const eingeordnet = IFC_ENTITIES.find(e => e.entity === 'IfcPumpConnector');
pruefe('Unbekannter Typ landet per Heuristik in der TGA',
  eingeordnet && eingeordnet.category === 'mep',
  eingeordnet ? `Kategorie: ${eingeordnet.category}` : 'nicht in IFC_ENTITIES');
pruefe('… mit lesbarem Namen und eigener Farbe',
  eingeordnet && eingeordnet.displayName === 'Pump Connector' &&
  /^#[0-9a-f]{6}$/.test(eingeordnet.color),
  eingeordnet ? `${eingeordnet.displayName} / ${eingeordnet.color}` : '');

pruefe('IfcBuildingElementPart steht in der Typenliste',
  IFC_ENTITIES.some(e => e.entity === 'IfcBuildingElementPart' && e.category === 'parts'));

// Ein zweiter Lauf darf nicht doppelt zählen
BimViewer.scanIFCTypes(asset);
pruefe('Zweiter Scan zählt denselben Content nicht doppelt',
  BimViewer.ifcFilter.gefundeneTypen.get('IfcBuildingElementPart') === 3,
  `gezählt: ${BimViewer.ifcFilter.gefundeneTypen.get('IfcBuildingElementPart')}`);

// ══════════════════════════════════════════════════════════════════════════
abschnitt('Sichtbarkeit: ein Haken weniger ist ein Typ weniger');

asset = assetSetzen(TYPEN_IM_MODELL);
BimViewer.scanIFCTypes(asset);

// Der Nutzer blendet die Türen aus — sonst nichts.
BimViewer.ifcFilter.enabledEntities.delete('IfcDoor');
stile.length = 0;
await BimViewer._applyIFCFilterInner();

const show = stile.length ? stile[stile.length - 1].show : undefined;
pruefe('Ein Stil wurde gesetzt', stile.length === 1);
pruefe('Türen sind weg', !sichtbar(show, 'IfcDoor'), `show = ${show}`);
pruefe('Wände bleiben', sichtbar(show, 'IfcWall'));
pruefe('BAUTEILSCHICHTEN BLEIBEN', sichtbar(show, 'IfcBuildingElementPart'),
  'der eigentliche Fehler: sie verschwanden mit');
pruefe('Ein Typ, den niemand kennt, bleibt ebenfalls stehen',
  sichtbar(show, 'IfcIrgendwasVoellingNeues'),
  'Ausschlusslogik: nur Abgewähltes verschwindet');

// ══════════════════════════════════════════════════════════════════════════
abschnitt('"Keine" blendet wirklich alles aus');

asset = assetSetzen(TYPEN_IM_MODELL);
BimViewer.scanIFCTypes(asset);
BimViewer.ifcFilter.enabledEntities.clear();
stile.length = 0;
await BimViewer._applyIFCFilterInner();
pruefe('show === false', stile.length === 1 && stile[0].show === false,
  `show = ${stile.length ? stile[0].show : '(kein Stil)'}`);

// ══════════════════════════════════════════════════════════════════════════
abschnitt('Alles an: kein einschränkender Filter');

asset = assetSetzen(TYPEN_IM_MODELL);
BimViewer.scanIFCTypes(asset);
stile.length = 0;
await BimViewer._applyIFCFilterInner();
pruefe('show === true', stile.length === 1 && stile[0].show === true,
  `show = ${stile.length ? stile[0].show : '(kein Stil)'}`);
pruefe('Farben werden trotzdem gesetzt',
  stile[0].color && stile[0].color.conditions.length > 1);

// ══════════════════════════════════════════════════════════════════════════
abschnitt('Kategoriefilter');

asset = assetSetzen(TYPEN_IM_MODELL);
BimViewer.scanIFCTypes(asset);

pruefe('Kategorie "parts" kennt genau den Typ aus dem Modell',
  JSON.stringify(BimViewer.ifcTypenDerKategorie('parts')) ===
  JSON.stringify(['IfcBuildingElementPart']),
  JSON.stringify(BimViewer.ifcTypenDerKategorie('parts')));

pruefe('… über die ganze Typenliste sind es mehr',
  BimViewer.ifcTypenDerKategorie('parts', true).length > 5,
  `${BimViewer.ifcTypenDerKategorie('parts', true).length} Typen`);

pruefe('Zustand vor dem Klick: alle an',
  BimViewer.ifcKategorieZustand('parts') === 'alle');

BimViewer.toggleIFCCategory('parts');
pruefe('Nach dem Klick: Kategorie aus',
  BimViewer.ifcKategorieZustand('parts') === 'keine' &&
  !BimViewer.ifcFilter.enabledEntities.has('IfcBuildingElementPart'));
pruefe('… und nur diese Kategorie',
  BimViewer.ifcKategorieZustand('structure') === 'alle' &&
  BimViewer.ifcFilter.enabledEntities.has('IfcWall'));

stile.length = 0;
await BimViewer._applyIFCFilterInner();
const showParts = stile[stile.length - 1].show;
pruefe('Im Bild sind die Schichten weg', !sichtbar(showParts, 'IfcBuildingElementPart'));
pruefe('… die Wände nicht', sichtbar(showParts, 'IfcWall'));

BimViewer.toggleIFCCategory('parts');
pruefe('Erneuter Klick schaltet sie wieder ein',
  BimViewer.ifcKategorieZustand('parts') === 'alle');

// Teilweise → ein Klick schaltet komplett aus
BimViewer.ifcFilter.enabledEntities.delete('IfcWall');
pruefe('Kategorie mit einem abgewählten Typ ist "teilweise"',
  BimViewer.ifcKategorieZustand('structure') === 'teilweise',
  `Zustand: ${BimViewer.ifcKategorieZustand('structure')}`);
BimViewer.toggleIFCCategory('structure');
pruefe('… und wird durch einen Klick ganz ausgeschaltet',
  BimViewer.ifcKategorieZustand('structure') === 'keine');

// Isolieren
asset = assetSetzen(TYPEN_IM_MODELL);
BimViewer.scanIFCTypes(asset);
BimViewer.isolateIFCCategory('structure');
pruefe('Isolieren lässt genau eine Kategorie an',
  BimViewer.ifcKategorieZustand('structure') === 'alle' &&
  BimViewer.ifcKategorieZustand('parts') === 'keine' &&
  BimViewer.ifcKategorieZustand('interior') === 'keine');

// ══════════════════════════════════════════════════════════════════════════
abschnitt('Zähler');

asset = assetSetzen(TYPEN_IM_MODELL);
BimViewer.scanIFCTypes(asset);
BimViewer.ifcFilter.enabledEntities.delete('IfcDoor');
let angezeigt = {};
globalThis.document.getElementById = (id) => ({
  set textContent(v) { angezeigt[id] = v; },
  get textContent() { return angezeigt[id]; },
});
BimViewer.updateEntityCounts();
pruefe('Der Zähler bezieht sich auf das Modell, nicht auf die Typenliste',
  angezeigt.totalEntityCount === 5 && angezeigt.activeEntityCount === 4,
  `${angezeigt.activeEntityCount}/${angezeigt.totalEntityCount}`);

// ══════════════════════════════════════════════════════════════════════════
}

main().then(() => {
  console.log(`\n${fehler === 0 ? '✅ alles grün' : '❌ ' + fehler + ' Prüfung(en) fehlgeschlagen'}`);
  process.exit(fehler === 0 ? 0 : 1);
}).catch(err => {
  console.error('✗ Prüflauf abgebrochen:', err);
  process.exit(1);
});
