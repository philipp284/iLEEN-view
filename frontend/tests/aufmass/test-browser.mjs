// Der Messmodus im echten Browser: Chrome headless über puppeteer-core (kein
// Projekt-Dependency — `npm i --no-save puppeteer-core`), gegen einen
// laufenden Dev-Server.
//
// Was hier und NUR hier geprüft werden kann:
//   · dass der Systemzeiger bleibt (`cursor: crosshair`, kein nachgezeichnetes
//     Kreuz) und dass eine Mausbewegung NICHTS liest — gezählt an den
//     Tiefenabfragen und Pick-Durchgängen, die eine Serie von Mausbewegungen
//     auslöst
//   · dass nach der Ruhe des Zeigers Kante und Ecke erkannt, im Ablesefeld
//     genannt und in der Szene markiert werden
//   · dass die Markierung nicht anklickbar ist (`scene.pick` sieht durch sie hindurch)
//   · dass der Klick an der Kante bzw. Ecke einrastet
//   · dass die Markierung verschwindet, wenn der Zeiger oder die Kamera wandert
//   · dass das Bauteil im Ablesefeld erscheint
//
// Die Szene: ein Quader (Entity, 4 × 3 × 3 m) frei im Raum. Er schreibt Tiefe
// und ist anklickbar, wie ein Bauteil; seine Kanten und Ecken liegen genau
// bekannt und lassen sich gegen den gefangenen Punkt rechnen.
//
// Aufruf:  npx vite --port 5197 &   VIEWER_URL=http://localhost:5197/ node tests/aufmass/test-browser.mjs

import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.VIEWER_URL || 'http://localhost:5197/';

let fehler = 0;
const pruefe = (name, ok, zusatz = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${name}${zusatz ? ' — ' + zusatz : ''}`);
  if (!ok) fehler++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const seitenfehler = [];
page.on('pageerror', (e) => seitenfehler.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(
  () => !!(window.BimViewer?.viewer && window.BimViewer.Aufmass && window.AufmassFang),
  { timeout: 90000 });

// ── Szene aufbauen ─────────────────────────────────────────────────────────

const aufbau = await page.evaluate(async () => {
  const viewer = BimViewer.viewer, scene = viewer.scene;
  window.__renderFehler = [];
  scene.renderError.addEventListener((s, e) => window.__renderFehler.push(String((e && e.message) || e)));
  viewer.camera.cancelFlight();
  BimViewer.ILeenLogo?.verbergen?.();
  document.getElementById('startbild')?.remove();

  // Ein Quader hoch über dem Gelände: dahinter nur Himmel.
  const mitte = Cesium.Cartesian3.fromDegrees(8.2599, 49.9929, 900);
  const M = Cesium.Transforms.eastNorthUpToFixedFrame(mitte);
  const enu = (x, y, z) => Cesium.Matrix4.multiplyByPoint(M, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
  window.__enu = enu;
  window.__kiste = viewer.entities.add({
    position: mitte,
    box: {
      dimensions: new Cesium.Cartesian3(4, 3, 3),
      material: Cesium.Color.fromCssColorString('#b9b7b0'),
    },
  });

  // Kamera: schräg von Südost, leicht von oben. Der Quader steht um `mitte`
  // (±2 / ±1,5 / ±1,5 m).
  viewer.camera.lookAt(mitte, new Cesium.HeadingPitchRange(
    Cesium.Math.toRadians(-35), Cesium.Math.toRadians(-28), 14));
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

  for (let i = 0; i < 40; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  const bild = (p) => { const b = scene.cartesianToCanvasCoordinates(p); return b ? { x: b.x, y: b.y } : null; };
  const ecken = {};
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    ecken[`${sx},${sy},${sz}`] = { welt: enu(2 * sx, 1.5 * sy, 1.5 * sz) };
  }
  // Sichtbar sind die drei Flächen zur Kamera: die Ecke, die ihr am nächsten
  // liegt, hat drei sichtbare Flächen.
  let nah = null, d0 = Infinity;
  for (const [k, e] of Object.entries(ecken)) {
    const d = Cesium.Cartesian3.distance(e.welt, scene.camera.positionWC);
    if (d < d0) { d0 = d; nah = k; }
  }
  const [nx, ny, nz] = nah.split(',').map(Number);
  // Die drei Kanten, die von dieser Ecke ausgehen.
  const ecke = enu(2 * nx, 1.5 * ny, 1.5 * nz);
  const kanteZ = [enu(2 * nx, 1.5 * ny, 1.5 * nz), enu(2 * nx, 1.5 * ny, -1.5 * nz)];   // senkrechte Kante
  return {
    ecke: { welt: [ecke.x, ecke.y, ecke.z], bild: bild(ecke) },
    kanteZ: kanteZ.map((p) => [p.x, p.y, p.z]),
    kanteBild: kanteZ.map(bild),
    pickSupported: scene.pickPositionSupported,
    nah,
  };
});

console.log('Szene:', JSON.stringify({ ecke: aufbau.ecke.bild, kante: aufbau.kanteBild, nah: aufbau.nah }));
pruefe('Tiefenpuffer lesbar (scene.pickPositionSupported)', aufbau.pickSupported);
pruefe('Ecke und Kante liegen im Bild', aufbau.ecke.bild && aufbau.kanteBild.every(Boolean));

// ── Hilfen im Seitenkontext ────────────────────────────────────────────────

await page.evaluate(() => {
  const scene = BimViewer.viewer.scene;
  window.__zaehler = { pos: 0, pick: 0, fang: 0 };
  const pp = scene.pickPosition.bind(scene), pk = scene.pick.bind(scene);
  scene.pickPosition = (...a) => { window.__zaehler.pos++; return pp(...a); };
  scene.pick = (...a) => { window.__zaehler.pick++; return pk(...a); };
  const ff = AufmassFang.fang.bind(AufmassFang);
  AufmassFang.fang = (...a) => { window.__zaehler.fang++; return ff(...a); };
  window.__nullen = () => { window.__zaehler.pos = 0; window.__zaehler.pick = 0; window.__zaehler.fang = 0; };

  const C3 = Cesium.Cartesian3;
  // Abstand eines Punktes von der Geraden (a, b), in Metern.
  window.__abstandGerade = (p, a, b) => {
    const u = C3.normalize(C3.subtract(b, a, new C3()), new C3());
    const w = C3.subtract(p, a, new C3());
    const l = C3.dot(w, u);
    return C3.magnitude(C3.subtract(w, C3.multiplyByScalar(u, l, new C3()), new C3()));
  };
  window.__stand = () => {
    const z = BimViewer.Aufmass.zustand();
    const Z = BimViewer.Aufmass._Z;
    return {
      art: z.letzterFang, traeger: z.letzterTraeger, punkte: z.punkte,
      marken: z.fangMarke,
      hud: Z.hud ? Z.hud.innerText : null,
      cursor: scene.canvas.style.cursor,
      fang: Z.fang ? [Z.fang.position.x, Z.fang.position.y, Z.fang.position.z] : null,
      kreuz: !!document.querySelector('.aufmass-kreuz'),
    };
  };
});

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
// Der Fang läuft in dieser Umgebung (Software-GL) um ein Vielfaches langsamer
// als auf einer Grafikkarte; gewartet wird deshalb auf den Zustand, nicht auf Zeit.
const sieht = () => page.waitForFunction(() => BimViewer.Aufmass._Z.fangPos !== null, { timeout: 40000 });
// Der Canvas liegt nicht unbedingt bei (0, 0) der Seite.
const versatz = await page.evaluate(() => {
  const r = BimViewer.viewer.scene.canvas.getBoundingClientRect();
  return { x: r.left, y: r.top };
});
const bewege = (x, y, schritte = 1) => page.mouse.move(versatz.x + x, versatz.y + y, { steps: schritte });

// ── Start ──────────────────────────────────────────────────────────────────

console.log('\n1 · Der Zeiger bleibt, und eine Bewegung liest nichts');
await page.evaluate(() => BimViewer.Aufmass.start());
await warte(300);
{
  const s = await page.evaluate(() => window.__stand());
  pruefe('der Systemzeiger ist ein Fadenkreuz-Cursor, nicht ausgeblendet', s.cursor === 'crosshair', s.cursor);
  pruefe('es gibt kein nachgezeichnetes Kreuz im Bild', !s.kreuz);
}

{
  // 300 Mausbewegungen in einer einzigen Aufgabe des Browsers: schneller, als
  // irgendeine Hand fährt. Gelesen werden darf währenddessen nichts, und
  // danach genau einmal, wenn der Zeiger ruht.
  await page.evaluate(() => window.__nullen());
  const gefahren = await page.evaluate(([vx, vy]) => {
    const c = BimViewer.viewer.scene.canvas;
    const sende = (x, y) => {
      const o = { clientX: vx + x, clientY: vy + y, bubbles: true, pointerType: 'mouse', isPrimary: true };
      c.dispatchEvent(window.PointerEvent ? new PointerEvent('pointermove', o) : new MouseEvent('mousemove', o));
    };
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) sende(300 + i * 2, 350 + (i % 40));
    const z = { ...window.__zaehler };
    return { ms: performance.now() - t0, waehrend: z };
  }, [versatz.x, versatz.y]);
  pruefe(`300 Mausbewegungen in ${gefahren.ms.toFixed(0)} ms: kein Fang, keine Tiefenabfrage, kein Pick`,
    gefahren.waehrend.fang === 0 && gefahren.waehrend.pos === 0 && gefahren.waehrend.pick === 0,
    JSON.stringify(gefahren.waehrend));
  await page.waitForFunction(() => BimViewer.Aufmass._Z.fangPos !== null, { timeout: 30000 });
  const danach = await page.evaluate(() => ({ ...window.__zaehler }));
  pruefe('danach, in der Ruhe, genau ein Fang', danach.fang === 1, `${danach.fang} Fänge`);
  console.log(`      (ein Fang: ${danach.pos} Tiefenabfragen, ${danach.pick} Pick-Durchgänge)`);
}

// ── Kante ──────────────────────────────────────────────────────────────────

console.log('\n2 · Kante: Zeiger ruhen lassen');
const kb = aufbau.kanteBild;
const kanteMitte = { x: (kb[0].x + kb[1].x) / 2, y: (kb[0].y + kb[1].y) / 2 };
const rechts = kb[1].x >= kb[0].x ? 1 : -1;

{
  await bewege(kanteMitte.x - 22, kanteMitte.y, 8);      // 22 px neben der Kante
  await sieht();
  const s = await page.evaluate(() => window.__stand());
  console.log('      HUD:', JSON.stringify(s.hud));
  pruefe('nach der Ruhe ist die Kante erkannt', s.art === 'kante', `art=${s.art}`);
  pruefe('das Ablesefeld nennt „Kante"', /Kante/.test(s.hud || ''));
  pruefe('über der Leinwand steht eine Markierung (Strecke + Punkt)', s.marken >= 3, `${s.marken} Formen`);

  if (s.fang) {
    const d = await page.evaluate(([p, a, b]) => {
      const C = Cesium.Cartesian3;
      return window.__abstandGerade(new C(...p), new C(...a), new C(...b));
    }, [s.fang, aufbau.kanteZ[0], aufbau.kanteZ[1]]);
    pruefe('der gefangene Punkt liegt auf der Kante (< 3 cm)', d < 0.03, `${(d * 100).toFixed(2)} cm`);
  }

  // Die Markierung liegt über der Kante, an der der nächste Fang nach dem
  // Bauteil fragt. Läge sie in der Szene, träfe scene.pick sie statt des
  // Quaders — oder gar nichts: gemessen an Cesium 1.145 verdeckt auch ein
  // Primitive mit allowPicking: false.
  const getroffen = await page.evaluate(([x, y]) => {
    const scene = BimViewer.viewer.scene;
    const aus = [];
    for (const dx of [-14, -6, -3]) {            // auf der Fläche neben der Kante, unter der Markierung
      const p = scene.pick(new Cesium.Cartesian2(x + dx, y));
      aus.push(p && p.id === window.__kiste ? 'kiste' : (p ? 'anderes' : 'nichts'));
    }
    return aus;
  }, [kanteMitte.x, kanteMitte.y]);
  pruefe('die Markierung ist nicht anklickbar: scene.pick trifft darunter den Quader',
    getroffen.every((g) => g === 'kiste'), getroffen.join(', '));
}

console.log('\n3 · Kante: Klick rastet ein');
{
  await page.evaluate(() => window.__nullen());
  await page.mouse.click(versatz.x + kanteMitte.x - 22, versatz.y + kanteMitte.y);
  await warte(250);
  const s = await page.evaluate(() => ({ ...window.__stand(), z: { ...window.__zaehler } }));
  pruefe('ein Punkt ist gesetzt', s.punkte === 1, `punkte=${s.punkte}`);
  // Der Klick übernimmt den gesehenen Fang: kein zweiter Fang. (Cesiums eigene
  // Kamerasteuerung fragt beim Tastendruck einmal selbst nach der Tiefe.)
  pruefe('der Klick übernimmt den gesehenen Fang (kein zweiter Fang)', s.z.fang === 0, `${s.z.fang} Fänge`);
  const d = await page.evaluate(([a, b]) => {
    const C = Cesium.Cartesian3;
    const p = BimViewer.Aufmass._Z.punkte[0].ecef;
    return window.__abstandGerade(p, new C(...a), new C(...b));
  }, aufbau.kanteZ);
  pruefe('der gesetzte Punkt liegt auf der Kante (< 3 cm)', d < 0.03, `${(d * 100).toFixed(2)} cm`);
  await page.evaluate(() => BimViewer.Aufmass.abbrechen());
}

// ── Klick ohne Ruhe ────────────────────────────────────────────────────────

console.log('\n4 · Klick ohne zu ruhen: der Klick greift ab');
{
  await bewege(kanteMitte.x - 200, kanteMitte.y + 40, 1);
  await warte(450);
  await page.evaluate(() => window.__nullen());
  // Sofort an die Kante und klicken, ohne dass der Zeitgeber ablaufen kann.
  await bewege(kanteMitte.x - 20, kanteMitte.y, 1);
  await page.mouse.click(versatz.x + kanteMitte.x - 20, versatz.y + kanteMitte.y);
  const s = await page.evaluate(() => ({ ...window.__stand(), z: { ...window.__zaehler } }));
  pruefe('ein Punkt ist gesetzt', s.punkte === 1, `punkte=${s.punkte}`);
  pruefe('… und der Klick hat selbst gefangen', s.z.pos > 0, `${s.z.pos} Abfragen`);
  const d = await page.evaluate(([a, b]) => {
    const C = Cesium.Cartesian3;
    return window.__abstandGerade(BimViewer.Aufmass._Z.punkte[0].ecef, new C(...a), new C(...b));
  }, aufbau.kanteZ);
  pruefe('… und ist auf die Kante eingerastet (< 3 cm)', d < 0.03, `${(d * 100).toFixed(2)} cm`);
  await page.evaluate(() => BimViewer.Aufmass.abbrechen());
}

// ── Ecke ───────────────────────────────────────────────────────────────────

console.log('\n5 · Ecke');
{
  const e = aufbau.ecke.bild;
  // Schräg unter der Ecke, 11 px von ihr und weiter als das von jeder Kante: dort
  // gewinnt nach der Regel (Ecke zählt 40 % näher) die Ecke. Weiter weg, dicht
  // an einer Kante, gewinnt die Kante — das ist Absicht und im Prüfstein ohne
  // Browser belegt.
  await bewege(e.x - 8, e.y + 8, 6);
  await sieht();
  const s = await page.evaluate(() => window.__stand());
  console.log('      HUD:', JSON.stringify(s.hud));
  pruefe('nach der Ruhe ist die Ecke erkannt', s.art === 'ecke', `art=${s.art}`);
  pruefe('das Ablesefeld nennt „Ecke"', /Ecke/.test(s.hud || ''));
  pruefe('über der Leinwand steht eine Markierung (Ring)', s.marken >= 2, `${s.marken} Formen`);
  if (s.fang) {
    const d = await page.evaluate(([p, e]) => {
      const C = Cesium.Cartesian3;
      return C.distance(new C(...p), new C(...e));
    }, [s.fang, aufbau.ecke.welt]);
    pruefe('der gefangene Punkt liegt auf der Ecke (< 3 cm)', d < 0.03, `${(d * 100).toFixed(2)} cm`);
  }

  // Zeiger wandert weg: die Markierung gilt nicht mehr.
  await bewege(e.x - 8 - 60, e.y + 8 + 40, 6);
  const weg = await page.evaluate(() => window.__stand());
  pruefe('der Zeiger wandert weg: Markierung und Fang sind verworfen',
    weg.marken === 0 && weg.art === null, `marken=${weg.marken}, art=${weg.art}`);
  pruefe('das Ablesefeld zeigt „…" statt eines alten Fangs', /…/.test(weg.hud || ''), JSON.stringify(weg.hud));
}

// ── Kamera ─────────────────────────────────────────────────────────────────

console.log('\n6 · Kamera bewegt sich');
{
  const e = aufbau.ecke.bild;
  await bewege(e.x - 8, e.y + 8, 4);
  await sieht();
  const vorher = await page.evaluate(() => window.__stand());
  await page.evaluate(() => { BimViewer.viewer.camera.moveForward(0.8); });
  // Die Kamera meldet ihre Fahrt erst im nächsten Bild.
  await page.waitForFunction(() => BimViewer.Aufmass.zustand().fangMarke === 0, { timeout: 20000 }).catch(() => {});
  const nachher = await page.evaluate(() => window.__stand());
  pruefe('vor der Kamerafahrt war gefangen', vorher.marken > 0, `marken=${vorher.marken}`);
  pruefe('mit der Kamerafahrt ist die Markierung weg', nachher.marken === 0, `marken=${nachher.marken}`);
  // moveEnd kommt, wenn die Kamera `cameraEventWaitTime` (500 ms) ruht.
  await page.waitForFunction(() => BimViewer.Aufmass._Z.fangPos !== null, { timeout: 40000 })
    .then(() => pruefe('nach der Fahrt sieht der Fang von selbst wieder hin', true))
    .catch(() => pruefe('nach der Fahrt sieht der Fang von selbst wieder hin', false, 'nach 40 s nichts'));
  await page.evaluate(() => BimViewer.Aufmass.abbrechen());
}

// ── Bauteil im Ablesefeld ──────────────────────────────────────────────────

console.log('\n7 · Das Bauteil steht im Ablesefeld');
{
  // Ein echtes Bauteil ist ein Cesium3DTileFeature mit Batch Table. Hier wird
  // `scene.pick` für den Quader durch ein solches Feature ersetzt.
  await page.evaluate(() => {
    const scene = BimViewer.viewer.scene;
    const original = scene.pick.bind(scene);
    const eig = {
      GlobalId: '2O2Fr$t4X7Zf8NGew_RkQr', IfcType: 'IfcWall',
      Name: 'Außenwand <b>36,5</b>', Storey: 'EG',
    };
    const feature = Object.create(Cesium.Cesium3DTileFeature.prototype);
    feature.getProperty = (n) => eig[n];
    feature._content = { tileset: {} };      // `tileset` ist ein Getter darauf
    window.__pickAlt = original;
    scene.pick = (p) => {
      const echt = original(p);
      return echt && echt.id === window.__kiste ? feature : echt;
    };
  });
  const e = aufbau.ecke.bild;
  await bewege(e.x - 40, e.y + 60, 6);
  await bewege(e.x - 8, e.y + 8, 6);
  await sieht();
  const s = await page.evaluate(() => window.__stand());
  console.log('      HUD:', JSON.stringify(s.hud));
  pruefe('das Ablesefeld nennt die IFC-Klasse', /IfcWall/.test(s.hud || ''));
  pruefe('… den Namen (ohne Markup durchzulassen)', /Außenwand <b>36,5<\/b>/.test(s.hud || ''));
  const markup = await page.evaluate(() => BimViewer.Aufmass._Z.hud.querySelectorAll('b').length);
  pruefe('… und ein Name mit <b> wird nicht als Markup gelesen', markup === 1, `${markup} <b>-Elemente (nur die Fangart)`);
  pruefe('… und das Geschoss', /EG/.test(s.hud || ''));
  await page.evaluate(() => { BimViewer.viewer.scene.pick = window.__pickAlt; });
}

// ── Aus ────────────────────────────────────────────────────────────────────

console.log('\n8 · Messmodus beenden');
{
  await page.evaluate(() => BimViewer.Aufmass.stop());
  const s = await page.evaluate(() => ({
    cursor: BimViewer.viewer.scene.canvas.style.cursor,
    marken: BimViewer.Aufmass.zustand().fangMarke,
    hud: BimViewer.Aufmass._Z.hud ? BimViewer.Aufmass._Z.hud.style.display : null,
  }));
  pruefe('der Zeiger ist wieder der normale', s.cursor === '', JSON.stringify(s.cursor));
  pruefe('keine Markierung bleibt zurück', s.marken === 0 && !(await page.evaluate(() => !!document.querySelector('.aufmass-marke'))));
  pruefe('das Ablesefeld ist weg', s.hud === 'none');
  await page.evaluate(() => window.__nullen());
  await bewege(500, 400, 20);
  await warte(600);
  const z = await page.evaluate(() => ({ ...window.__zaehler }));
  pruefe('nach dem Beenden liest eine Mausbewegung nichts mehr', z.pos === 0 && z.pick === 0, `${z.pos}/${z.pick}`);
}

// ── Fehler ─────────────────────────────────────────────────────────────────

const renderFehler = await page.evaluate(() => window.__renderFehler);
pruefe('kein Renderfehler', renderFehler.length === 0, renderFehler.join(' | '));
const eigene = seitenfehler.filter((m) => /aufmass|Aufmass|Fang/i.test(m));
pruefe('kein Seitenfehler aus dem Messmodus', eigene.length === 0, eigene.join(' | '));
if (seitenfehler.length) console.log('  (Seitenfehler gesamt:', seitenfehler.length, '—', seitenfehler.slice(0, 2).join(' | '), ')');

await browser.close();
console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exit(fehler ? 1 : 0);
