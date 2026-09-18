// Prüft die Vektorkarte ohne Browser: Style gegen echte Cesium-Ausdrücke,
// Eigenschaften eines Features, Panel und Einbindung.
//
// Aufruf:  node tests/vektorkacheln/test-vektorkacheln.js
//
// Das Laden der Kacheln selbst braucht WebGL und das Netz und steht deshalb
// nicht hier. Hier steht, was ohne beides falsch sein kann — und am teuersten
// wäre ein Style, der still alles zeigt: dann deckt die flächendeckende
// Vegetationsebene das Luftbild zu, und es sieht aus wie ein Kartenfehler.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.resolve(__dirname, '..', '..');
const Cesium = require(path.join(WURZEL, 'node_modules', 'cesium'));

let fehler = 0;
function pruefe(name, bedingung, hinweis) {
  if (bedingung) console.log(`✓ ${name}`);
  else { fehler++; console.log(`✗ ${name}${hinweis ? '   ' + hinweis : ''}`); }
}

function lade() {
  const box = {
    innerHTML: '',
    _hoerer: null,
    addEventListener(art, f) { if (art === 'change') this._hoerer = f; },
  };
  const kontext = {
    Cesium, console, setTimeout,
    localStorage: { getItem: () => null, setItem() {} },
    document: { readyState: 'complete', addEventListener() {}, getElementById: (id) => (id === 'vectorLayersList' ? box : null) },
  };
  kontext.window = kontext;
  kontext.window.BimViewer = { viewer: null, updateStatus() {} };
  kontext.window.t = (k) => k;
  vm.createContext(kontext);
  vm.runInContext(fs.readFileSync(path.join(WURZEL, 'vektorkacheln.js'), 'utf8'), kontext);
  return { api: kontext.window.Vektorkacheln, box };
}

// Cesium3DTileStyle liest Variablen über getPropertyInherited — die Attrappe
// muss das können, sonst prüft sie einen Weg, den der Style nicht geht.
function feature(werte) {
  return {
    getProperty: (n) => werte[n],
    getPropertyInherited: (n) => werte[n],
    hasProperty: (n) => n in werte,
    getPropertyIds: () => Object.keys(werte),
  };
}

const { api, box } = lade();
const P = api._pruefsteine;

// ── 1 · Style ───────────────────────────────────────────────────────────────

{
  const def = P.stilDefinition({ gebaeude: true, verkehr: true, gewaesser: false, grenzen: false });
  const stil = new Cesium.Cesium3DTileStyle(def);
  const zeigt = (layer) => stil.show.evaluate(feature({ _layer: layer }));

  pruefe('Gebäudeflächen sichtbar', zeigt('Gebaeudeflaeche') === true);
  pruefe('Verkehrslinien sichtbar', zeigt('Verkehrslinie') === true);
  pruefe('abgeschaltetes Thema unsichtbar (Gewässer)', zeigt('Gewaesserflaeche') === false);
  pruefe('flächendeckende Vegetation bleibt aus', zeigt('Vegetationsflaeche') === false);
  pruefe('Hintergrund bleibt aus', zeigt('Hintergrund') === false);

  const farbe = stil.color.evaluateColor(feature({ _layer: 'Gebaeudeflaeche' }), new Cesium.Color());
  pruefe('Gebäude sind halbdurchlässig (Luftbild bleibt lesbar)', farbe.alpha > 0.3 && farbe.alpha < 0.9, `alpha=${farbe.alpha}`);
  const f2 = stil.color.evaluateColor(feature({ _layer: 'Verkehrslinie' }), new Cesium.Color());
  pruefe('Verkehr hat eine andere Farbe als Gebäude', !Cesium.Color.equals(farbe, f2));

  const leer = new Cesium.Cesium3DTileStyle(P.stilDefinition({}));
  pruefe('alle Themen aus: nichts sichtbar', leer.show.evaluate(feature({ _layer: 'Gebaeudeflaeche' })) === false);

  pruefe('jede Quellebene existiert im basemap.de-Datensatz',
    P.THEMEN.every((t) => t.ebenen.every((e) => /^[A-Z][a-z]+(_[A-Z][a-z]+)?$/.test(e) || /flaeche|linie/i.test(e))));
}

// ── 2 · Eigenschaften eines Features ────────────────────────────────────────

{
  const props = P.featureEigenschaften(feature({ _layer: 'Gebaeudeflaeche', klasse: 'Rathaus', name: '', hoehe: null, land: 'RP' }));
  pruefe('Quellebene steht als Kopf', props._Layer === 'basemap.de · Gebaeudeflaeche');
  pruefe('Werte der Quelle bleiben (klasse, land)', props.klasse === 'Rathaus' && props.land === 'RP');
  pruefe('leere Werte fallen weg', !('name' in props) && !('hoehe' in props));
  pruefe('_layer steht nicht doppelt', !('_layer' in props));
}

// ── 3 · Quelle, Panel, Einbindung ───────────────────────────────────────────

{
  pruefe('URL-Vorlage mit {z}/{x}/{y} (MVTDataProvider liest die Kachel daraus)',
    /\/\{z\}\/\{x\}\/\{y\}\.pbf$/.test(P.QUELLE.url));
  pruefe('maxZoom = 15 wie in der TileJSON', P.QUELLE.maxZoom === 15);

  api.panelZeichnen();
  pruefe('Panel: Hauptschalter', /data-vk="aktiv"/.test(box.innerHTML));
  pruefe('Panel: Auflage wählbar', /data-vk="auflage"/.test(box.innerHTML));
  pruefe('Panel: ein Schalter je Thema', P.THEMEN.every((t) => box.innerHTML.includes(`data-vk-thema="${t.id}"`)));
  pruefe('Panel: Änderungen werden am Behälter gehört', typeof box._hoerer === 'function');

  box._hoerer({ target: { dataset: { vkThema: 'grenzen' }, checked: true } });
  pruefe('Thema über das Panel schaltbar', api.stand().themen.grenzen === true);

  const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf8');
  pruefe('index.html lädt vektorkacheln.js', html.includes('src="vektorkacheln.js"'));
  pruefe('index.html lädt Cesium ≥ 1.145', /cesiumjs\/releases\/1\.(14[5-9]|1[5-9]\d)\//.test(html));
  const paket = JSON.parse(fs.readFileSync(path.join(WURZEL, 'package.json'), 'utf8'));
  pruefe('package.json: cesium ≥ 1.145', /1\.(14[5-9]|1[5-9]\d)/.test(paket.dependencies.cesium));
  pruefe('Cesium kennt MVTDataProvider', typeof Cesium.MVTDataProvider === 'function');

  const ui = fs.readFileSync(path.join(WURZEL, 'ui.js'), 'utf8');
  pruefe('ui.js legt den Behälter an', ui.includes('id="vectorLayersList"'));
  const i18n = fs.readFileSync(path.join(WURZEL, 'i18n.js'), 'utf8');
  ['layer.vector', 'layer.vectorHint', 'vector.buildings', 'underground.zeroLevel'].forEach((k) => {
    const n = i18n.split(`'${k}'`).length - 1;
    pruefe(`i18n: '${k}' in DE und EN`, n === 2, `${n}×`);
  });
}

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nalles in Ordnung');
process.exit(fehler ? 1 : 0);
