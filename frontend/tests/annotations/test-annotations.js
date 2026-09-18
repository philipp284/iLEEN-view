// Annotationen ohne Browser. Geprüft wird in zwei Teilen:
//
//   1. Was ohne Kamera Bestand hat — Markdown (inklusive Maskierung fremden
//      Textes), Panel-Markup, gespeicherter Zustand.
//   2. Die Zeichenschleife selbst, gegen einen DOM- und Cesium-Ersatz: dass
//      sie durchläuft, den Anker projiziert und die Entzerrung greift.
//
// Der zweite Teil ersetzt keinen Blick in den Browser — Farben, Größen und die
// tatsächliche Projektion prüft er nicht. Er hält aber fest, dass die Schleife
// über echte Notizdaten läuft, ohne zu werfen, und dass sich zwei
// übereinanderliegende Beschriftungen nicht gegenseitig überdecken.

globalThis.window = globalThis;
globalThis.innerWidth = 1600;
globalThis.innerHeight = 900;
globalThis.addEventListener = () => {};

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};

// ── DOM-Ersatz: hält nur fest, was geschrieben wurde ───────────────────────
function element() {
  const node = {
    className: '', textContent: '', innerHTML: '',
    style: {}, children: [],
    offsetWidth: 180, offsetHeight: 60,
    append(...kids) { node.children.push(...kids); },
    appendChild(kid) { node.children.push(kid); return kid; },
    addEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
    remove() {},
    querySelector() { return element(); },
    closest() { return null; }
  };
  return node;
}

globalThis.document = {
  readyState: 'complete',
  documentElement: { lang: 'de' },
  getElementById: () => null,
  querySelectorAll: () => [],
  createElement: element,
  addEventListener: () => {},
  body: { appendChild: () => {} }
};
globalThis.navigator = { language: 'de-DE' };
globalThis.HTMLElement = class {};

// ── Cesium-Ersatz: nur die Vektorrechnung der Zeichenschleife ──────────────
class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
}
Cartesian3.fromElements = (x, y, z, r = new Cartesian3()) => { r.x = x; r.y = y; r.z = z; return r; };
Cartesian3.subtract = (a, b, r = new Cartesian3()) => {
  r.x = a.x - b.x; r.y = a.y - b.y; r.z = a.z - b.z; return r;
};
Cartesian3.dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
Cartesian3.magnitude = (a) => Math.hypot(a.x, a.y, a.z);

globalThis.Cesium = {
  Cartesian3,
  EllipsoidalOccluder: class { constructor() { this.cameraPosition = null; } isPointVisible() { return true; } },
  // Bildschirmkoordinate = x/y der Weltkoordinate, das genügt für die Prüfung
  SceneTransforms: { worldToWindowCoordinates: (scene, p) => ({ x: p.y, y: p.z }) }
};

const path = require('path');
require(path.join(__dirname, '..', '..', 'i18n.js'));

globalThis.BimViewerUI = {
  getTagsContent: () => '<div class="section">Notizen</div>',
  refreshTagsPanel: () => {}
};

require(path.join(__dirname, '..', '..', 'annotations.js'));
const A = globalThis.Annotations;

let fehler = 0;
const pruefe = (name, ok, hinweis = '') => {
  console.log(name.padEnd(24) + ':', ok ? '✓' : '✗ ' + hinweis);
  if (!ok) fehler++;
};

// ══ Teil 1: ohne Kamera ═══════════════════════════════════════════════════

// ── Markdown ───────────────────────────────────────────────────────────────
const md = A._markdown;

pruefe('HTML maskiert', !md('<img src=x onerror=alert(1)>').includes('<img'),
       md('<img src=x onerror=alert(1)>'));
pruefe('Fettung', md('**Riss** im Sturz').includes('<strong>Riss</strong>'));
pruefe('Code', md('Bauteil `IfcWall`').includes('<code>IfcWall</code>'));
pruefe('Aufzählung', md('- erste\n- zweite') === '<ul><li>erste</li><li>zweite</li></ul>',
       md('- erste\n- zweite'));
pruefe('Häkchen gesetzt', md('- [x] aufgenommen').includes('☑'));
pruefe('Häkchen offen', md('- [ ] offen').includes('☐'));
pruefe('Absätze', md('erste Zeile\n\nzweite Zeile')
       === '<p>erste Zeile</p><p>zweite Zeile</p>', md('erste Zeile\n\nzweite Zeile'));

// ── Panel ──────────────────────────────────────────────────────────────────
const html = BimViewerUI.getTagsContent();
pruefe('Panel angehängt', html.includes('annoToggle') && html.includes('Notizen'));
const auf = (html.match(/<div/g) || []).length;
const zu  = (html.match(/<\/div>/g) || []).length;
pruefe('div auf/zu', auf === zu, `${auf} / ${zu}`);
pruefe('Sichtweiten', (html.match(/<option/g) || []).length === 4);

// ── Zustand ────────────────────────────────────────────────────────────────
A.setOnlyOpen(true);
A.setMaxDistance(5000);
const gespeichert = JSON.parse(store['ileen_annotations_state_v1']);
pruefe('Zustand gespeichert',
       gespeichert.onlyOpen === true && gespeichert.maxDistance === 5000,
       JSON.stringify(gespeichert));

A.setMaxDistance(0);   // ungültig — darf den Wert nicht zerstören
pruefe('Sichtweite geschützt',
       JSON.parse(store['ileen_annotations_state_v1']).maxDistance === 5000);

// ── Layout ─────────────────────────────────────────────────────────────────
A._layout['tag-1'] = { x: 0.2, y: -0.3, collapsed: true };
A.resetLayout('tag-1');
pruefe('Layout einzeln weg', !('tag-1' in A._layout));

A._layout['tag-2'] = { x: 0.1, y: 0.1 };
A.resetLayout();
pruefe('Layout ganz weg', Object.keys(A._layout).length === 0);
pruefe('Layout persistiert', store['ileen_annotation_labels_v1'] === '{}');

// ══ Teil 2: die Zeichenschleife ═══════════════════════════════════════════

const notiz = (id, title, y, z, status = 'open') => ({
  id, type: 'issue',
  position: { worldCart: { x: 100, y, z } },
  target: { kind: 'ifc', assetId: 'a1' },
  payload: { title, body: '- [x] aufgenommen', status, attachments: [] },
  author: 'pruefer@hs-mainz.de', createdAt: '2026-08-12T09:00:00.000Z'
});

globalThis.Tags = {
  items: [
    notiz('t1', 'Riss im Sturz', 400, 300),
    notiz('t2', 'Direkt daneben', 410, 305),      // überdeckt t1
    notiz('t3', 'Weit weg',      1200, 700, 'closed')
  ],
  flyTo() {}, save: async () => {}, remove: async () => {}
};

let zeichne = null;
globalThis.BimViewer = {
  viewer: {
    scene: {
      canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }) },
      camera: { positionWC: new Cartesian3(0, 0, 0), directionWC: new Cartesian3(1, 0, 0) },
      globe: { ellipsoid: {} },
      postRender: { addEventListener: (fn) => { zeichne = fn; } },
      requestRender() {}
    }
  }
};

// boot() wartet in einem Intervall auf Viewer und Tags — 400 ms Takt.
setTimeout(() => {
  pruefe('Schleife angemeldet', typeof zeichne === 'function');
  if (typeof zeichne !== 'function') { ende(); return; }

  A.setEnabled(true);
  A.setOnlyOpen(false);
  A.setMaxDistance(1e9);
  zeichne();

  pruefe('Views angelegt', A._views.size === 3, String(A._views.size));

  const v1 = A._views.get('t1');
  pruefe('Anker gesetzt', /translate\(400px, 300px\)/.test(v1.dot.style.transform || ''),
         v1.dot.style.transform);
  pruefe('Beschriftung gesetzt', v1.label.style.left === '400px', v1.label.style.left);
  pruefe('Statusfarbe', v1.root.className.includes('is-open'), v1.root.className);
  pruefe('Erledigt markiert', A._views.get('t3').root.className.includes('is-closed'));

  // t1 ist näher an der Kamera und gewinnt den Platz, t2 klappt zusammen.
  pruefe('Entzerrung greift',
         !v1.root.className.includes('is-collapsed')
         && A._views.get('t2').root.className.includes('is-collapsed'),
         v1.root.className + ' | ' + A._views.get('t2').root.className);

  // Erledigte ausblenden nimmt die Notiz aus der Szene, nicht nur aus der Liste
  A.setOnlyOpen(true);
  zeichne();
  pruefe('Nur unerledigte', A._views.size === 2, String(A._views.size));

  // Zweiter Durchlauf darf nichts doppelt anlegen und nicht werfen
  zeichne();
  pruefe('Zweiter Durchlauf', A._views.size === 2);

  ende();
}, 600);

function ende() {
  console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  process.exit(fehler ? 1 : 0);
}
