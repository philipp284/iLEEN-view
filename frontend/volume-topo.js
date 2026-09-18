/**
 * iLEEN
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 *
 */

// =============================================================================
// TOPOGRAFISCHES AUFMASS — Volumen aus den Punkten selbst
//
// Das ältere `volume-surface.js` legt ein Raster über das Polygon und schießt
// je Rasterzelle einen Strahl in den Tiefenpuffer. Das misst nicht die
// Punktwolke, sondern ihr Bild: es kostet Zehntausende Picks, hängt an der
// gerade geladenen Kachelstufe, und was zwischen zwei Punkten hindurchgeht,
// kommt als Loch zurück.
//
// Hier werden stattdessen **die Punkte selbst genommen** — bei Gaussian
// Splats aus den Puffern, die der Renderer ohnehin im Speicher hält, bei
// 3D-Tiles-Punktwolken aus den `.pnts`-Kacheln, die dafür einmal geladen und
// gelesen werden. Kein einziger Pick, keine Abhängigkeit von der Ansicht,
// und die volle Auflösung statt der zufällig sichtbaren Kachelstufe.
//
// Es müssen nicht alle Punkte sein: über einer Million wird gleichmäßig
// ausgedünnt (jeder zweite, jeder vierte …). Für das Volumen ändert das
// nichts — die Höhen mitteln sich in jeder Masche ohnehin —, für die
// Rechenzeit alles.
//
// Aus den Punkten entsteht ein Geländemodell: eine Masche, deren Weite sich
// aus der Punktdichte selbst ergibt (rund sechs Punkte je Masche), je Masche
// die mittlere, höchste oder tiefste Punkthöhe. Das ist kein Abtastraster —
// es wird nichts nachgeschlagen, sondern nur einsortiert, was schon da ist.
//
//   Volumen = Σ (Maschenhöhe − Bezugshöhe) × Maschenfläche × Flächenanteil
//
// Der Flächenanteil ist der Teil der Masche, der wirklich im Polygon liegt —
// sonst wäre der Rand immer um eine halbe Maschenweite zu groß oder zu klein.
//
// Und weil aus einem Geländemodell ohnehin eine Karte wird: Höhenstufen,
// Schummerung und Höhenlinien werden in eine Leinwand gezeichnet, die
// zweimal verwendet wird — als Textur über der Oberfläche in der Szene und
// als Kartenblatt im Panel, mit Legende, Maßstab und Nordpfeil.
// =============================================================================
'use strict';

window.TopoVolume = (function () {

  // ── Grenzen ────────────────────────────────────────────────────────────────

  // So viele Punkte werden höchstens behalten. Darüber wird beim Einlesen
  // gleichmäßig ausgedünnt: die Liste wird halbiert und die Schrittweite
  // verdoppelt. Das kostet nichts und deckelt den Speicher hart.
  const MAX_POINTS = 1500000;

  // Maschen des Geländemodells. Reicht für 1200 × 1200 Maschen — bei 0,10 m
  // Maschenweite ein Feld von 120 m Kantenlänge in voller Auflösung.
  //
  // Die Grenze kostet Zeit, nicht Speicher: das Feld selbst sind 25 MB, aber
  // `coverageGrid` prüft je Masche fünf Punkte gegen das Polygon und
  // `fillGaps` läuft viermal über alle acht Nachbarn. Gemessen an 1,4 Mio
  // Maschen sind das zusammen rund 1,3 s — spürbar, aber die Messung dauert
  // ohnehin länger, und eine erzwungene Vergröberung ist der schlechtere
  // Handel.
  const MAX_CELLS = 1500000;

  // Höchstzahl der Kacheln, die für eine Messung geladen werden. Wird sie
  // beim Absteigen überschritten, bleibt es bei der Stufe darüber — **nie**
  // wird die Auswahl vorne abgeschnitten. Das ist der Unterschied zwischen
  // „überall eine Stufe gröber" und „hier alles, dort nichts", und nur das
  // erste ist eine Messung.
  //
  // Die Zahl ist gemessen, nicht geraten. An einer py3dtiles-Wolke (720
  // Kacheln, 11 Stufen) über einem Feld von 70 × 70 m:
  //
  //     Grenze  Kacheln  angesehen  behalten  Belegung  Dauer
  //        400      204     1,16 M     925 k     100 %   0,6 s
  //       1200      748     4,33 M     942 k     100 %   2,2 s
  //
  // Die nächsttiefere Stufe holt viermal so viele Daten für zwei Prozent mehr
  // Punkte — den Rest wirft die Ausdünnung ohnehin weg. Höher zu gehen kostet
  // Zeit und Bandbreite und bringt keine Messgenauigkeit.
  const MAX_TILES = 400;

  // Zweite Bremse, in Byte: eine Kachelstufe kann wenige große oder viele
  // kleine Dateien haben, und die Kachelzahl allein sagt darüber nichts.
  const MAX_BYTES = 320 * 1024 * 1024;

  // Externe Tilesets (`content.uri` endet auf `.json`) werden aufgelöst, aber
  // nicht unbegrenzt: py3dtiles lagert dichte Bereiche in eigene Dateien aus,
  // und in einem großen Baum können das viele sein.
  const MAX_EXTERNAL = 80;

  // Rückfallweg für Szenen ohne Punkte (Netze, Google-3D-Kacheln, Gelände):
  // dort wird doch abgetastet, aber nur so oft.
  const MAX_SCAN = 20000;
  const SCAN_CHUNK = 250;

  // Unterhalb dieser Trefferzahl gilt „es wurden keine Punkte gefunden" und
  // der Rückfallweg greift. Ein paar Streupunkte ergeben kein Gelände.
  const MIN_POINTS = 25;

  // Maße der Kartenleinwand.
  //
  // Angestrebt werden drei Bildpunkte je Masche: die Höhenlinie wird aus dem
  // Abstand zur Höhenstufe *in Bildpunkten* gebildet, und mit weniger als
  // zwei Bildpunkten je Masche hat eine Linie keinen Platz mehr, weich
  // gezeichnet zu werden — sie wird treppig, obwohl das Geländemodell es
  // hergäbe.
  const MAP_PIXELS_PER_CELL = 3;

  // Zwei Deckel, beide nötig. Die Kante schützt vor der Texturgrenze der
  // Grafikkarte, die Gesamtzahl vor dem Speicher — ein langgestrecktes
  // Baufeld darf eine lange Kante haben, ein quadratisches nicht dieselbe.
  const MAP_MAX_EDGE = 4096;
  const MAP_MAX_PIXELS = 4000000;

  // Zielbelegung einer Masche in Punkten. Weniger heißt Löcher, mehr heißt
  // eine Karte, die gröber ist als die Daten.
  const POINTS_PER_CELL = 6;

  // Wie oft Löcher im Geländemodell aus der Nachbarschaft aufgefüllt werden.
  // Vier Durchgänge überbrücken höchstens vier Maschen — größere Lücken
  // bleiben Loch und gehen weder in das Volumen noch in die Karte ein.
  const FILL_PASSES = 4;

  const NICE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];

  // ── Farbverläufe ───────────────────────────────────────────────────────────
  //
  // Zwei, mehr nicht, und beide der Reihe nach geordnet:
  //
  // `hoehe` ist eine Folge — dunkles Grün unten bis helles Sandweiß oben.
  // Die Helligkeit steigt über den ganzen Verlauf, deshalb bleibt die
  // Reihenfolge auch in Graustufen und bei Farbfehlsichtigkeit lesbar. Ein
  // Regenbogen täte das nicht.
  //
  // `auftrag` ist zweipolig um die Bezugsebene: blau unter, grau auf, rot
  // über der Ebene. Genau die Frage beim Erdbau — was ist weg, was ist dazu.
  // In der Mitte steht ein neutrales Grau, kein dritter Farbton.
  const RAMPS = {
    hoehe: {
      diverging: false,
      stops: [
        [0.00, 47, 107, 76],
        [0.25, 79, 138, 75],
        [0.50, 138, 168, 81],
        [0.75, 198, 180, 121],
        [1.00, 244, 239, 227],
      ],
    },
    auftrag: {
      diverging: true,
      stops: [
        [0.00, 37, 99, 160],
        [0.25, 108, 168, 209],
        [0.50, 236, 236, 236],
        [0.75, 214, 126, 96],
        [1.00, 168, 55, 40],
      ],
    },
  };

  const ACCENT = '#97BF0D';

  // ── Zustand ────────────────────────────────────────────────────────────────

  const state = {
    active: false,       // im Zeichnen
    busy: false,         // im Rechnen
    aborted: false,
    step: '',            // Text neben dem Fortschritt
    positions: [],       // Cartesian3 der gesetzten Ecken
    entities: [],        // eigene Zeichnung
    outline: null,
    handler: null,
    result: null,
    error: null,
    grid: null,
    cloud: null,        // die gelesenen Punkte — für ein Umrechnen ohne Nachladen
    ctx: null,
    map: null,           // { canvas, figure, levels, interval, ... }
    surface: null,       // Cesium.Primitive
    refPlane: null,      // Entity der Bezugsebene
  };

  function viewer() {
    return window.BimViewer && BimViewer.viewer;
  }

  function status(message, kind) {
    if (window.BimViewer && BimViewer.updateStatus) BimViewer.updateStatus(message, kind);
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // ===========================================================================
  // ZEICHNEN
  // ===========================================================================

  function toggle() {
    if (state.busy) return;
    if (state.active) { finish(); return; }
    start();
  }

  function start() {
    const v = viewer();
    if (!v) { fail('Der Viewer ist noch nicht bereit'); return; }

    // Nur ein Messwerkzeug zur Zeit — sonst setzen zwei Handler bei jedem
    // Klick gleichzeitig Punkte in zwei verschiedene Messungen.
    if (window.BimViewer?.Aufmass?.laeuft) BimViewer.Aufmass.stop();

    clearAll(true);
    state.active = true;

    state.handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas);
    state.handler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    state.handler.setInputAction(finish, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    document.addEventListener('keydown', onKey);

    v.trackedEntity = undefined;

    render();
    status('Aufmaß: Ecken anklicken, dann „Fläche schließen" (Doppelklick oder Enter)', 'info');
  }

  function onClick(click) {
    const v = viewer();
    // Über einer Splatwolke liefert `pickPosition()` das Terrain dahinter.
    // `smartPickPosition` prüft die Splats vorher mit einem eigenen Strahltest.
    const position = (BimViewer.smartPickPosition
        ? BimViewer.smartPickPosition(click.position)
        : v.scene.pickPosition(click.position))
      || v.camera.pickEllipsoid(click.position, v.scene.globe.ellipsoid);
    if (!Cesium.defined(position)) return;

    // Der Doppelklick feuert vorher zweimal LEFT_CLICK — ohne diese Sperre
    // landet die letzte Ecke doppelt in der Liste.
    const previous = state.positions[state.positions.length - 1];
    if (previous && Cesium.Cartesian3.distance(previous, position) < 0.05) return;

    state.positions.push(position);
    drawCorner(position);
    drawOutline();
    render();
  }

  function onKey(event) {
    if (!state.active) return;
    if (event.key === 'Enter') { event.preventDefault(); finish(); }
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  }

  function drawCorner(position) {
    state.entities.push(viewer().entities.add({
      position,
      point: {
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString(ACCENT),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));
  }

  function drawOutline() {
    if (state.outline) return;
    state.outline = viewer().entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(
          () => (state.positions.length > 1 ? state.positions.concat([state.positions[0]]) : []),
          false
        ),
        width: 2,
        material: Cesium.Color.fromCssColorString(ACCENT),
        clampToGround: false,
        arcType: Cesium.ArcType.NONE,
      },
    });
    state.entities.push(state.outline);
  }

  function cancel(silent) {
    state.aborted = true;
    state.active = false;
    clearAll(true);
    if (!silent) { render(); status('Aufmaß abgebrochen', 'info'); }
  }

  /** Räumt Zeichnung, Oberfläche und Ergebnis aus Szene und Zustand. */
  function clearAll(keepQuiet) {
    const v = viewer();

    if (state.handler) { state.handler.destroy(); state.handler = null; }
    document.removeEventListener('keydown', onKey);

    if (v) state.entities.forEach((e) => v.entities.remove(e));
    state.entities = [];
    state.outline = null;
    state.refPlane = null;

    removeSurface();

    state.positions = [];
    state.result = null;
    state.error = null;
    state.grid = null;
    state.cloud = null;
    state.ctx = null;
    state.map = null;
    state.step = '';
    if (!keepQuiet) render();
  }

  function removeSurface() {
    const v = viewer();
    if (state.surface && v && !v.scene.primitives.isDestroyed?.()) {
      try { v.scene.primitives.remove(state.surface); } catch (e) { /* schon fort */ }
    }
    state.surface = null;
  }

  // ===========================================================================
  // ABLAUF
  // ===========================================================================

  async function finish() {
    if (!state.active || state.busy) return;
    if (state.positions.length < 3) {
      fail(`Mindestens drei Ecken nötig — gesetzt sind ${state.positions.length}`);
      return;
    }

    state.active = false;
    state.busy = true;
    state.aborted = false;
    state.error = null;

    if (state.handler) { state.handler.destroy(); state.handler = null; }
    document.removeEventListener('keydown', onKey);
    render();

    try {
      await measure(readOptions());
      state.busy = false;
      if (state.aborted) { render(); return; }
      render();
      status(`Aufmaß: ${format(state.result.net)} m³ netto aus ${state.result.points.toLocaleString('de-DE')} Punkten`, 'success');
      console.log('[Aufmaß] Ergebnis', state.result);
    } catch (error) {
      state.busy = false;
      if (String(error && error.message) === 'Abgebrochen') { render(); return; }
      console.error('[Aufmaß] fehlgeschlagen:', error);
      fail((error && error.message) || String(error));
    }
  }

  async function measure(options) {
    const ctx = buildContext(state.positions);
    state.ctx = ctx;

    // 1 — Punkte beschaffen
    setStep('Punkte werden gelesen…');
    await nextFrame();
    const cloud = await collectPoints(ctx);
    checkAbort();

    if (cloud.n < MIN_POINTS) {
      setStep('Keine Punkte gefunden — die Szene wird abgetastet…');
      await nextFrame();
      const scanned = await scanScene(ctx, options);
      checkAbort();
      cloud.xs = scanned.xs; cloud.ys = scanned.ys; cloud.hs = scanned.hs;
      cloud.n = scanned.n;
      cloud.source = 'scan';
      cloud.notes = cloud.notes.concat(scanned.notes);
      if (cloud.n < 3) {
        throw new Error('Unter der Fläche wurde nichts gefunden — weder Punkte noch '
          + 'eine Oberfläche. Liegt das Modell wirklich unter dem Polygon, und ist es '
          + 'sichtbar geschaltet?');
      }
    }

    // 2 — Geländemodell
    setStep('Geländemodell wird gebildet…');
    await nextFrame();

    state.cloud = cloud;

    const masche = chooseCell(ctx.area, cloud.n, options.cell, ctx.bounds);
    const cell = masche.cell;
    const grid = binPoints(cloud, ctx.bounds, cell, options.aggregate);
    const filled = fillGaps(grid, FILL_PASSES);
    grid.coverage = coverageGrid(grid, ctx.ring, 5);
    state.grid = grid;

    const plane = referencePlane(ctx, options);
    const sums = integrate(grid, plane);
    checkAbort();

    if (!sums.cells) {
      throw new Error('Im Polygon liegt keine gefüllte Masche — die Fläche ist '
        + 'kleiner als eine Maschenweite, oder alle Punkte liegen außerhalb.');
    }

    state.result = {
      net: sums.cut - sums.fill,
      cut: sums.cut,
      fill: sums.fill,
      polygonArea: ctx.area,
      coveredArea: sums.area,
      holeArea: sums.holeArea,
      minHeight: sums.hmin,
      maxHeight: sums.hmax,
      meanHeight: sums.hmean,
      referenceHeight: plane.a,
      tilt: Math.hypot(plane.b, plane.c),
      cell,
      cellForced: masche.forced ? masche.asked : 0,
      cells: sums.cells,
      interpolated: filled,
      points: cloud.n,
      scanned: cloud.scanned,
      stride: cloud.stride,
      source: cloud.source,
      tiles: cloud.tiles,
      notes: cloud.notes,
      aggregate: options.aggregate,
      reference: options.reference,
    };

    // 3 — Karte
    setStep('Karte wird gezeichnet…');
    await nextFrame();
    state.map = renderMap(grid, plane, ctx, options, state.result);
    checkAbort();

    // 4 — Szene
    drawReferencePlane(plane, ctx);
    if (options.overlay) buildSurface(ctx, grid, state.map.canvas, options);
    setStep('');
  }

  function checkAbort() {
    if (state.aborted) throw new Error('Abgebrochen');
  }

  function setStep(text) {
    state.step = text;
    const el = document.getElementById('tvBusy');
    if (el) { el.style.display = text ? '' : 'none'; el.textContent = text; }
  }

  // ===========================================================================
  // BEZUGSSYSTEM
  // ===========================================================================

  /**
   * Örtliches Ost-/Nord-System im Schwerpunkt der gesetzten Ecken.
   *
   * Darin ist das Polygon eine ebene Figur und die Masche rechtwinklig. Die
   * Höhe wird **nicht** aus diesem System genommen, sondern als Höhe über dem
   * Ellipsoid geführt: die Tangentialebene läuft der Erdkrümmung davon, auf
   * 500 m sind das 2 cm, auf einen Kilometer 8 cm. Der Term `(x²+y²)/(2R)`
   * rechnet das zurück — einmal je Punkt, statt einer vollen
   * Kartografie-Umrechnung, die millionenfach Minuten kosten würde.
   */
  function buildContext(positions) {
    const origin = Cesium.BoundingSphere.fromPoints(positions).center;
    const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    const toLocal = Cesium.Matrix4.inverseTransformation(frame, new Cesium.Matrix4());

    const ring = positions.map((p) => {
      const q = Cesium.Matrix4.multiplyByPoint(toLocal, p, new Cesium.Cartesian3());
      return { x: q.x, y: q.y };
    });
    const cornerHeights = positions.map((p) => Cesium.Cartographic.fromCartesian(p).height);

    const bounds = boundsOf(ring);
    const h0 = Cesium.Cartographic.fromCartesian(origin).height;
    const R = Cesium.Cartesian3.magnitude(origin);

    return {
      origin, frame, toLocal, ring, cornerHeights, bounds, h0, R,
      area: areaOf(ring),
      radius: Math.max(
        Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2, 1
      ),
      center: {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      },
    };
  }

  /** Ellipsoidhöhe aus der örtlichen z-Koordinate. */
  function heightFromLocal(ctx, x, y, z) {
    return ctx.h0 + z + (x * x + y * y) / (2 * ctx.R);
  }

  /** Umkehrung — örtliche z-Koordinate aus der Ellipsoidhöhe. */
  function localFromHeight(ctx, x, y, h) {
    return h - ctx.h0 - (x * x + y * y) / (2 * ctx.R);
  }

  // ===========================================================================
  // PUNKTE BESCHAFFEN
  // ===========================================================================

  /**
   * Sammelt alle Punkte, die im Polygon liegen — aus Splats und aus
   * `.pnts`-Kacheln. Beide Quellen werden zusammengeworfen: ein Bestand aus
   * Laserscan plus Befliegung ist ein Bestand.
   */
  async function collectPoints(ctx) {
    const sink = makeSink(ctx);
    const notes = [];
    let tiles = 0;

    try {
      harvestSplats(ctx, sink, notes);
    } catch (error) {
      console.warn('[Aufmaß] Splatpuffer nicht lesbar:', error);
      notes.push('Die Splatpuffer waren nicht lesbar.');
    }

    try {
      tiles = await harvestPnts(ctx, sink, notes);
    } catch (error) {
      // Der Abbruch ist keine Störung, sondern die Antwort auf einen Klick —
      // er muss durch, sonst rechnet das Werkzeug an einer Messung weiter,
      // die niemand mehr sehen will.
      if (String(error && error.message) === 'Abgebrochen') throw error;
      console.warn('[Aufmaß] Punktkacheln nicht lesbar:', error);
      notes.push('Die Punktkacheln konnten nicht geladen werden: ' + (error.message || error));
    }

    const out = sink.finish();
    out.notes = notes;
    out.tiles = tiles;
    out.source = out.n >= MIN_POINTS ? (tiles > 0 ? 'pnts' : 'splat') : 'none';
    return out;
  }

  /**
   * Nimmt Punkte entgegen und dünnt selbsttätig aus.
   *
   * Erreicht die Liste `MAX_POINTS`, wird jeder zweite Eintrag verworfen und
   * die Schrittweite verdoppelt — ab dann kommt nur noch jeder n-te Punkt an.
   * Das hält den Speicher gedeckelt, ohne vorher wissen zu müssen, wie viele
   * Punkte überhaupt im Polygon liegen, und ohne einen Teil des Gebietes zu
   * bevorzugen: ausgedünnt wird überall gleich.
   */
  function makeSink(ctx) {
    const xs = [], ys = [], hs = [];
    let stride = 1;
    let seen = 0;      // Punkte, die den Polygontest bestanden haben
    let scanned = 0;   // Punkte, die überhaupt angesehen wurden

    function decimate() {
      let w = 0;
      for (let r = 0; r < xs.length; r += 2, w++) { xs[w] = xs[r]; ys[w] = ys[r]; hs[w] = hs[r]; }
      xs.length = w; ys.length = w; hs.length = w;
      stride *= 2;
    }

    return {
      get stride() { return stride; },
      countScanned(n) { scanned += n; },
      /** Örtliche Koordinaten, Höhe wird hier gebildet. */
      push(x, y, z) {
        seen++;
        if (seen % stride !== 0) return;
        xs.push(x); ys.push(y);
        hs.push(heightFromLocal(ctx, x, y, z));
        if (xs.length >= MAX_POINTS) decimate();
      },
      finish() {
        return {
          xs: Float64Array.from(xs),
          ys: Float64Array.from(ys),
          hs: Float64Array.from(hs),
          n: xs.length,
          stride,
          scanned,
        };
      },
    };
  }

  /**
   * Gaussian Splats — die Zentren aus dem Puffer, den der Renderer hält.
   *
   * `SplatPick.snapshotOf()` liefert genau die Splats, die gerade gezeichnet
   * werden. Das ist zugleich die Einschränkung: was außerhalb des Sichtfeldes
   * oder in einer gröberen Kachelstufe liegt, ist nicht dabei. Deshalb steht
   * im Ergebnis, woher die Punkte kamen — bei Splats gehört ein Blick auf das
   * ganze Gebiet zur Messung dazu.
   */
  function harvestSplats(ctx, sink, notes) {
    if (!window.SplatPick || !SplatPick.snapshotOf) return;
    const assets = window.BimViewer && BimViewer.loadedAssets;
    if (!assets) return;

    let clouds = 0;
    for (const [, data] of assets) {
      const tileset = data && data.tileset;
      if (!tileset || tileset.show === false) continue;
      if (!SplatPick.isGaussianTileset(tileset)) continue;

      const snap = SplatPick.snapshotOf(tileset);
      if (!snap) continue;

      const M = snap.root
        ? Cesium.Matrix4.multiply(ctx.toLocal, snap.root, new Cesium.Matrix4())
        : Cesium.Matrix4.clone(ctx.toLocal, new Cesium.Matrix4());

      pushTransformed(snap.positions, snap.count, M, ctx, sink);
      clouds++;
    }
    if (clouds) notes.push(`${clouds} Splatwolke${clouds > 1 ? 'n' : ''} — nur die gerade sichtbaren Splats.`);
  }

  /**
   * Punkte durch eine Matrix in das örtliche System und in den Trichter.
   *
   * Die Matrixmultiplikation steht ausgeschrieben da, weil sie hier
   * millionenfach läuft: `Matrix4.multiplyByPoint` legt bei jedem Aufruf ein
   * `Cartesian3` an, und das ist bei zwei Millionen Punkten der Unterschied
   * zwischen 60 ms und mehreren Sekunden mit Aufräumpausen.
   */
  function pushTransformed(positions, count, M, ctx, sink) {
    const b = ctx.bounds;
    const m0 = M[0], m4 = M[4], m8 = M[8], m12 = M[12];
    const m1 = M[1], m5 = M[5], m9 = M[9], m13 = M[13];
    const m2 = M[2], m6 = M[6], m10 = M[10], m14 = M[14];
    const ring = ctx.ring;

    sink.countScanned(count);
    for (let i = 0; i < count; i++) {
      const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
      const x = m0 * px + m4 * py + m8 * pz + m12;
      if (x < b.minX || x > b.maxX) continue;
      const y = m1 * px + m5 * py + m9 * pz + m13;
      if (y < b.minY || y > b.maxY) continue;
      if (!isInside(x, y, ring)) continue;
      sink.push(x, y, m2 * px + m6 * py + m10 * pz + m14);
    }
  }

  /**
   * 3D-Tiles-Punktwolken — die `.pnts`-Kacheln werden gelesen.
   *
   * Nicht aus dem Speicher: CesiumJS wirft die Rohpunkte weg, sobald der
   * Zeichenbefehl steht (`PntsLoader` setzt `_parsedContent = undefined`).
   * Übrig bleibt ein Pufferobjekt auf der Grafikkarte, aus dem sich nichts
   * mehr herauslesen lässt.
   *
   * Also werden die Kacheln, die unter dem Polygon liegen, einmal geladen und
   * selbst gelesen. Das hat einen Vorteil, der den Umweg wert ist: es kommt
   * die **feinste** Stufe, unabhängig davon, wie weit die Kamera weg steht.
   */
  async function harvestPnts(ctx, sink, notes) {
    const assets = window.BimViewer && BimViewer.loadedAssets;
    if (!assets) return 0;

    let read = 0, draco = 0, missed = 0, bytes = 0;

    for (const [, data] of assets) {
      const tileset = data && data.tileset;
      if (!tileset || !tileset.root || tileset.show === false) continue;
      if (window.SplatPick && SplatPick.isGaussianTileset(tileset)) continue;
      if (BimViewer.isPointCloudTileset && !BimViewer.isPointCloudTileset(tileset)) continue;

      let jobs;
      try {
        jobs = await selectTiles(tileset, ctx, notes);
      } catch (error) {
        if (String(error && error.message) === 'Abgebrochen') throw error;
        console.warn('[Aufmaß] Kachelbaum nicht lesbar:', error);
        notes.push('Ein Kachelbaum war nicht lesbar: ' + (error.message || error));
        continue;
      }
      if (!jobs.length) continue;

      // Sechs Kacheln gleichzeitig: genug, um die Latenz zu überdecken, wenig
      // genug, dass der Browser nicht an der Verbindungsgrenze wartet.
      for (let i = 0; i < jobs.length; i += 6) {
        checkAbort();
        if (bytes > MAX_BYTES) {
          notes.push(`Nach ${Math.round(bytes / 1048576)} MB abgebrochen — `
            + `${jobs.length - i} Kacheln ungelesen. Kleinere Fläche wählen.`);
          break;
        }
        setStep(`Punktkacheln werden gelesen — ${Math.min(i + 6, jobs.length)} von ${jobs.length}`);
        await nextFrame();

        const batch = jobs.slice(i, i + 6);
        const buffers = await Promise.all(batch.map((job) =>
          job.resource.fetchArrayBuffer().catch(() => null)));

        buffers.forEach((buffer, k) => {
          // Ein Fehlschlag wird gezählt, nicht verschluckt: fehlende Kacheln
          // sind Löcher in der Messung, und ein Loch, von dem niemand weiß,
          // ist schlimmer als eines, das ausgewiesen wird.
          if (!buffer) { missed++; return; }
          bytes += buffer.byteLength;

          let parsed;
          try { parsed = parsePnts(buffer); } catch (e) { parsed = null; }
          if (!parsed) { missed++; return; }
          if (parsed.draco) { draco++; return; }

          const M = Cesium.Matrix4.multiply(ctx.toLocal, batch[k].transform, new Cesium.Matrix4());
          if (parsed.rtc) {
            Cesium.Matrix4.multiplyByTranslation(
              M, new Cesium.Cartesian3(parsed.rtc[0], parsed.rtc[1], parsed.rtc[2]), M);
          }
          pushTransformed(parsed.positions, parsed.count, M, ctx, sink);
          read++;
        });
      }
    }

    if (draco) {
      notes.push(`${draco} Kachel${draco > 1 ? 'n sind' : ' ist'} Draco-gepackt und `
        + `wurde${draco > 1 ? 'n' : ''} übersprungen.`);
    }
    if (missed) notes.push(`${missed} Kachel${missed > 1 ? 'n' : ''} konnte${missed > 1 ? 'n' : ''} nicht gelesen werden.`);
    return read;
  }

  /**
   * Die Kacheln unter dem Polygon, so tief wie das Budget zulässt.
   *
   * **Gearbeitet wird auf der `tileset.json`, nicht auf Cesiums Kachelbaum.**
   * Das war eine Korrektur, keine Vorliebe: Cesium hängt externe Tilesets
   * (`content.uri` endet auf `.json`) erst in den Baum, wenn der Renderer sie
   * durchlaufen hat. Bei py3dtiles sind das genau die dichten Bereiche — an
   * einer Baugrube lagen vier von sechs Blättern der Auswahl in solchen
   * Dateien, und die Karte hatte dort Löcher, während sie daneben stimmte.
   * Aus der JSON gelesen ist der Baum vollständig und vom Ladezustand
   * unabhängig; die externen Tilesets werden aufgelöst, sobald der Abstieg
   * sie erreicht.
   *
   * **Abgestiegen wird nur ganz oder gar nicht.** Reicht das Budget für die
   * nächste Stufe nicht, bleibt es bei der jetzigen. Die Auswahl vorne
   * abzuschneiden wäre der schlimmere Fehler: die Kacheln stehen in
   * Baumreihenfolge, und die ist räumlich sortiert — abgeschnitten fehlt
   * nicht überall ein bisschen, sondern in einer Ecke alles.
   */
  async function selectTiles(tileset, ctx, notes) {
    const resource = tileset.resource;
    if (!resource || typeof resource.fetchJson !== 'function') {
      notes.push('Der Kachelbaum war nicht erreichbar.');
      return [];
    }

    const json = await resource.fetchJson();
    if (!json || !json.root) return [];

    const base = Cesium.Matrix4.clone(tileset.modelMatrix || Cesium.Matrix4.IDENTITY,
                                      new Cesium.Matrix4());
    const root = makeNode(json.root, base, resource, ctx);
    if (!root || !overlaps(root, ctx)) return [];

    const additive = String(json.root.refine || json.asset?.refine || '').toUpperCase() === 'ADD';
    const chosen = [];
    let level = [root];
    let external = 0;
    let capped = false;

    for (;;) {
      checkAbort();
      if (additive) chosen.push(...level);

      // Externe Tilesets der jetzigen Stufe auflösen — erst hier, weil erst
      // hier feststeht, dass tiefer gegangen wird.
      const pending = level.filter((n) => n.external && external < MAX_EXTERNAL);
      if (pending.length) {
        setStep(`Kachelbäume werden aufgelöst — ${pending.length}`);
        await Promise.all(pending.map(async (node) => {
          external++;
          try { await expand(node, ctx); } catch (e) { node.external = false; }
        }));
      }

      const next = [];
      let settled = 0;
      for (const node of level) {
        const kids = childrenOf(node, ctx);
        // Eine Kachel, deren Kinder alle außerhalb liegen, ist hier unten
        // angekommen — sie bleibt, statt zu verschwinden. Genau daran fehlten
        // vorher ganze Bereiche: der Ast endete am Polygonrand, und die
        // Kachel mit ihren Punkten fiel lautlos aus der Auswahl.
        if (!kids.length) { settled++; next.push(node); continue; }
        next.push(...kids);
      }

      if (settled === level.length) break;          // überall unten
      if (next.length > MAX_TILES) { capped = true; break; }
      level = next;
    }

    if (!additive) chosen.push(...level);
    if (capped) {
      notes.push(`Eine Kachelstufe gröber genommen — die nächste hätte mehr als `
        + `${MAX_TILES} Kacheln gebraucht.`);
    }
    if (external >= MAX_EXTERNAL) {
      notes.push(`${MAX_EXTERNAL} eingebettete Kachelbäume aufgelöst — weitere blieben zu.`);
    }

    const jobs = [];
    for (const node of chosen) {
      if (node.external || !node.content) continue;
      jobs.push({ resource: node.content, transform: node.transform });
    }
    return jobs;
  }

  /**
   * Ein Kachelknoten aus der Tileset-JSON.
   *
   * Die Hülle wird als achsparalleles Rechteck im örtlichen Ost-/Nord-System
   * geführt, nicht als Kugel. Eine Kugel um eine flache, langgestreckte
   * Kachel ist um ein Vielfaches zu groß, und jede zu großzügig als
   * überlappend erkannte Kachel wird geladen und wieder weggeworfen.
   */
  function makeNode(json, parentTransform, resource, ctx) {
    if (!json) return null;
    const transform = json.transform
      ? Cesium.Matrix4.multiply(parentTransform, Cesium.Matrix4.unpack(json.transform),
                                new Cesium.Matrix4())
      : Cesium.Matrix4.clone(parentTransform, new Cesium.Matrix4());

    const hull = hullOf(json.boundingVolume, transform, ctx);
    if (!hull) return null;

    const uri = json.content && (json.content.uri || json.content.url);
    const external = !!uri && uri.toLowerCase().split('?')[0].endsWith('.json');

    return {
      json, transform, resource, external,
      content: uri && !external ? resource.getDerivedResource({ url: uri }) : null,
      externalUri: external ? uri : null,
      cx: hull.cx, cy: hull.cy, hx: hull.hx, hy: hull.hy,
      kids: null,
    };
  }

  /** Kinder eines Knotens, gefiltert auf Überlappung — einmal gebildet. */
  function childrenOf(node, ctx) {
    if (node.external) return [];
    if (!node.kids) {
      node.kids = (node.json.children || [])
        .map((child) => makeNode(child, node.transform, node.resource, ctx))
        .filter((child) => child && overlaps(child, ctx));
    }
    return node.kids;
  }

  /**
   * Ein externes Tileset an Ort und Stelle durch seinen Inhalt ersetzen.
   *
   * Nach 3D-Tiles gilt die Transformation der einbettenden Kachel weiter, und
   * die Wurzel des eingebetteten Tilesets bringt ihre eigene mit — beide
   * multiplizieren sich. Die Basis für die weiteren relativen Adressen ist
   * ab hier die Adresse der eingebetteten Datei, nicht mehr die äußere.
   */
  async function expand(node, ctx) {
    const resource = node.resource.getDerivedResource({ url: node.externalUri });
    const json = await resource.fetchJson();
    if (!json || !json.root) { node.external = false; return; }

    const inner = makeNode(json.root, node.transform, resource, ctx);
    if (!inner) { node.external = false; return; }

    node.json = inner.json;
    node.transform = inner.transform;
    node.resource = resource;
    node.content = inner.content;
    node.external = inner.external;
    node.externalUri = inner.externalUri;
    node.cx = inner.cx; node.cy = inner.cy; node.hx = inner.hx; node.hy = inner.hy;
    node.kids = null;
  }

  /**
   * Waagerechte Hülle eines `boundingVolume` im örtlichen System.
   *
   * `box` ist der Regelfall und wird genau abgebildet: Mittelpunkt und die
   * drei Halbachsen werden gedreht, und die Hülle ist die Summe ihrer
   * Beträge je Achse. `sphere` und `region` kommen selten vor und werden
   * konservativ als Quadrat um ihren Umkreis genommen.
   */
  function hullOf(bv, transform, ctx) {
    if (!bv) return null;
    const toLocal = ctx.toLocal;
    const p = new Cesium.Cartesian3();
    const v = new Cesium.Cartesian3();

    if (bv.box) {
      const b = bv.box;
      const M = Cesium.Matrix4.multiply(toLocal, transform, new Cesium.Matrix4());
      Cesium.Matrix4.multiplyByPoint(M, Cesium.Cartesian3.fromArray(b, 0, p), p);
      let hx = 0, hy = 0;
      for (const at of [3, 6, 9]) {
        Cesium.Matrix4.multiplyByPointAsVector(M, Cesium.Cartesian3.fromArray(b, at, v), v);
        hx += Math.abs(v.x); hy += Math.abs(v.y);
      }
      return { cx: p.x, cy: p.y, hx, hy };
    }

    if (bv.sphere) {
      const M = Cesium.Matrix4.multiply(toLocal, transform, new Cesium.Matrix4());
      Cesium.Matrix4.multiplyByPoint(M, Cesium.Cartesian3.fromArray(bv.sphere, 0, p), p);
      const r = bv.sphere[3];
      return { cx: p.x, cy: p.y, hx: r, hy: r };
    }

    if (bv.region) {
      // Ein Gebiet steht immer in WGS84 und lässt sich von der Transformation
      // der Kachel nicht beeindrucken.
      const [west, south, east, north, low, high] = bv.region;
      const sphere = Cesium.BoundingSphere.fromRectangle3D(
        new Cesium.Rectangle(west, south, east, north),
        Cesium.Ellipsoid.WGS84, (low + high) / 2);
      Cesium.Matrix4.multiplyByPoint(toLocal, sphere.center, p);
      return { cx: p.x, cy: p.y, hx: sphere.radius, hy: sphere.radius };
    }

    return null;
  }

  /** Überlappt die waagerechte Hülle das Polygonrechteck? */
  function overlaps(node, ctx) {
    const b = ctx.bounds;
    return !(node.cx + node.hx < b.minX || node.cx - node.hx > b.maxX
          || node.cy + node.hy < b.minY || node.cy - node.hy > b.maxY);
  }

  /**
   * `.pnts` nach 3D-Tiles 1.0.
   *
   * Kopf: 'pnts', Version, Gesamtlänge, dann vier Längen für Feature- und
   * Batch-Tabelle. Gebraucht wird davon nur die Feature-Tabelle: POSITION
   * (float32) oder POSITION_QUANTIZED (uint16 über QUANTIZED_VOLUME_*), dazu
   * RTC_CENTER.
   *
   * Die Positionen werden kopiert statt als Sicht angelegt: `byteOffset` in
   * der Feature-Tabelle ist auf 4 Byte ausgerichtet, der Beginn des
   * Binärteils aber nicht zwingend — eine unausgerichtete `Float32Array`-Sicht
   * wirft.
   */
  function parsePnts(buffer) {
    const dv = new DataView(buffer);
    if (buffer.byteLength < 28) return null;
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'pnts') return null;

    const ftJsonLength = dv.getUint32(12, true);
    const HEADER = 28;
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, HEADER, ftJsonLength)));
    const binOffset = HEADER + ftJsonLength;

    const count = json.POINTS_LENGTH | 0;
    if (!count) return null;

    if (json.extensions && json.extensions['3DTILES_draco_point_compression']) {
      return { draco: true, count: 0 };
    }

    const rtc = Array.isArray(json.RTC_CENTER) ? json.RTC_CENTER : null;

    if (json.POSITION && typeof json.POSITION.byteOffset === 'number') {
      const at = binOffset + json.POSITION.byteOffset;
      const positions = new Float32Array(buffer.slice(at, at + count * 12));
      return { count, positions, rtc };
    }

    if (json.POSITION_QUANTIZED && typeof json.POSITION_QUANTIZED.byteOffset === 'number') {
      const at = binOffset + json.POSITION_QUANTIZED.byteOffset;
      const q = new Uint16Array(buffer.slice(at, at + count * 6));
      const off = json.QUANTIZED_VOLUME_OFFSET || [0, 0, 0];
      const scale = json.QUANTIZED_VOLUME_SCALE || [1, 1, 1];
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = off[0] + (q[i * 3] / 65535) * scale[0];
        positions[i * 3 + 1] = off[1] + (q[i * 3 + 1] / 65535) * scale[1];
        positions[i * 3 + 2] = off[2] + (q[i * 3 + 2] / 65535) * scale[2];
      }
      return { count, positions, rtc };
    }

    return null;
  }

  /**
   * Rückfallweg für Szenen ohne Punkte — Netze, Google-3D-Kacheln, Gelände.
   *
   * Dort gibt es nichts aufzusummieren; die Oberfläche liegt nur im
   * Tiefenpuffer. Abgetastet wird an den Maschenmitten, von weit oben senkrecht
   * nach unten. Der `width`-Parameter darf dabei nicht 0 sein: Cesium baut
   * daraus die Breite eines Suchfensters entlang des Strahls, und bei 0 ist es
   * entartet — jede Stelle käme leer zurück.
   */
  async function scanScene(ctx, options) {
    const v = viewer();
    const notes = ['Die Szene hält keine Punkte bereit — abgetastet statt aufsummiert.'];
    if (!v || !v.scene.sampleHeightSupported) {
      return { xs: new Float64Array(0), ys: new Float64Array(0), hs: new Float64Array(0), n: 0, notes };
    }

    let cell = options.cell > 0 ? options.cell
      : Math.max(0.25, niceStep(Math.sqrt(ctx.area / 8000)));
    while (estimateCells(ctx.bounds, cell) > MAX_SCAN) cell *= 2;

    const spots = [];
    for (let x = ctx.bounds.minX + cell / 2; x < ctx.bounds.maxX; x += cell) {
      for (let y = ctx.bounds.minY + cell / 2; y < ctx.bounds.maxY; y += cell) {
        if (isInside(x, y, ctx.ring)) spots.push({ x, y });
      }
    }
    if (!spots.length) return { xs: new Float64Array(0), ys: new Float64Array(0), hs: new Float64Array(0), n: 0, notes };

    const width = Math.min(Math.max(cell / 2, 0.1), 1.0);
    const ellipsoid = v.scene.ellipsoid || Cesium.Ellipsoid.WGS84;
    const xs = [], ys = [], hs = [];

    state.entities.forEach((e) => { e.show = false; });
    try {
      for (let i = 0; i < spots.length; i += SCAN_CHUNK) {
        checkAbort();
        setStep(`Szene wird abgetastet — ${Math.min(i + SCAN_CHUNK, spots.length)} von ${spots.length}`);

        for (const spot of spots.slice(i, i + SCAN_CHUNK)) {
          const world = Cesium.Matrix4.multiplyByPoint(
            ctx.frame, new Cesium.Cartesian3(spot.x, spot.y, 0), new Cesium.Cartesian3());
          const carto = Cesium.Cartographic.fromCartesian(world);
          const normal = ellipsoid.geodeticSurfaceNormalCartographic(carto, new Cesium.Cartesian3());
          const from = Cesium.Cartesian3.fromRadians(
            carto.longitude, carto.latitude, Math.max(9000, ctx.h0 + 5000), ellipsoid);
          const ray = new Cesium.Ray(from, Cesium.Cartesian3.negate(normal, new Cesium.Cartesian3()));

          const hit = v.scene.pickFromRay(ray, state.entities, width);
          if (!hit || !Cesium.defined(hit.position)) continue;
          xs.push(spot.x); ys.push(spot.y);
          hs.push(Cesium.Cartographic.fromCartesian(hit.position).height);
        }
        await nextFrame();
      }
    } finally {
      state.entities.forEach((e) => { e.show = true; });
    }

    return {
      xs: Float64Array.from(xs), ys: Float64Array.from(ys), hs: Float64Array.from(hs),
      n: xs.length, notes,
    };
  }

  // ===========================================================================
  // GELÄNDEMODELL
  // ===========================================================================

  /**
   * Maschenweite aus der Punktdichte.
   *
   * Der mittlere Punktabstand in der Draufsicht ist √(Fläche / Punktzahl);
   * eine Masche soll rund sechs Punkte fassen, also das 2,5-fache davon. Das
   * ist der Grund, warum hier nichts einzustellen ist: eine feinere Masche
   * als die Daten erzeugt Löcher, eine gröbere wirft Gelände weg.
   */
  function autoCell(area, points) {
    const spacing = Math.sqrt(Math.max(area, 1e-6) / Math.max(points, 1));
    return niceStep(spacing * Math.sqrt(POINTS_PER_CELL));
  }

  /**
   * Die benutzte Maschenweite, und ob sie von der gewünschten abweicht.
   *
   * Eine stille Vergröberung ist der unangenehmste Fall: im Panel steht dann
   * eine andere Zahl als die gewählte, und es sieht aus, als sei die Eingabe
   * ignoriert worden. Sie wird deshalb ausgewiesen.
   */
  function chooseCell(area, points, wanted, bounds) {
    const asked = wanted > 0 ? Math.min(Math.max(wanted, 0.02), 100)
                             : autoCell(area, points);
    let cell = asked;
    while (estimateCells(bounds, cell) > MAX_CELLS) cell *= 2;
    return { cell, asked, forced: cell > asked };
  }

  /**
   * Punkte in Maschen einsortieren.
   *
   * Es wird nichts nachgeschlagen und nichts abgetastet — jeder Punkt fällt
   * genau einmal in genau eine Masche. Ein Durchgang, O(n).
   *
   * `mode`:
   *   mittel — arithmetisches Mittel. Der Regelfall; mittelt das Rauschen des
   *            Scanners heraus.
   *   hoch   — der höchste Punkt. Oberkante einer Halde, Dach, Kronendach.
   *   tief   — der tiefste Punkt. Das Gelände unter Bewuchs und Gerät; die
   *            klassische Wahl für den Aushub, weil ein Bagger im Bild sonst
   *            als Erdmassiv mitgerechnet würde.
   */
  function binPoints(cloud, bounds, cell, mode) {
    const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
    const ny = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cell));
    const h = new Float64Array(nx * ny);
    const cnt = new Int32Array(nx * ny);
    h.fill(NaN);

    const high = mode === 'hoch';
    const low = mode === 'tief';

    for (let i = 0; i < cloud.n; i++) {
      const gx = Math.floor((cloud.xs[i] - bounds.minX) / cell);
      const gy = Math.floor((cloud.ys[i] - bounds.minY) / cell);
      if (gx < 0 || gx >= nx || gy < 0 || gy >= ny) continue;
      const k = gy * nx + gx;
      const z = cloud.hs[i];

      if (cnt[k] === 0) { h[k] = z; cnt[k] = 1; continue; }
      cnt[k]++;
      if (high) { if (z > h[k]) h[k] = z; }
      else if (low) { if (z < h[k]) h[k] = z; }
      else h[k] += z;
    }

    if (!high && !low) {
      for (let k = 0; k < h.length; k++) if (cnt[k] > 1) h[k] /= cnt[k];
    }

    return { nx, ny, cell, x0: bounds.minX, y0: bounds.minY, h, cnt, interpolated: new Uint8Array(nx * ny) };
  }

  /**
   * Löcher aus der Nachbarschaft füllen.
   *
   * Eine leere Masche zwischen gefüllten ist eine Lücke in der Abtastung,
   * kein Loch im Gelände — sie mit der Nachbarschaft zu schließen ist richtig.
   * Ein leerer Streifen von zehn Maschen ist etwas anderes: ein Fensterschacht,
   * ein Wasserlauf, eine Verschattung. Deshalb wird nur `FILL_PASSES` mal
   * gefüllt und alles Größere bleibt Loch — es zählt dann weder in die Karte
   * noch in das Volumen, und die verlorene Fläche steht im Ergebnis.
   *
   * Verlangt werden mindestens zwei gefüllte Nachbarn: mit einem einzigen
   * würde sich ein Randwert Masche für Masche über das ganze Feld ziehen.
   */
  function fillGaps(grid, passes) {
    const { nx, ny, h } = grid;
    let filled = 0;

    for (let pass = 0; pass < passes; pass++) {
      const additions = [];
      for (let gy = 0; gy < ny; gy++) {
        for (let gx = 0; gx < nx; gx++) {
          const k = gy * nx + gx;
          if (!Number.isNaN(h[k])) continue;

          let sum = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const ax = gx + dx, ay = gy + dy;
              if (ax < 0 || ax >= nx || ay < 0 || ay >= ny) continue;
              const v = h[ay * nx + ax];
              if (Number.isNaN(v)) continue;
              sum += v; n++;
            }
          }
          if (n >= 2) additions.push([k, sum / n]);
        }
      }
      if (!additions.length) break;
      for (const [k, v] of additions) { h[k] = v; grid.interpolated[k] = 1; filled++; }
    }
    return filled;
  }

  /**
   * Der Anteil jeder Masche, der wirklich im Polygon liegt.
   *
   * Ohne ihn wäre der Rand systematisch falsch: eine Masche, die zu einem
   * Viertel im Polygon liegt, ginge entweder ganz oder gar nicht ein. Bei
   * einer Halde von zwanzig Maschen Durchmesser sind das mehrere Prozent.
   *
   * Innere Maschen erkennt man an ihren vier Ecken — liegen alle vier drin,
   * ist der Anteil 1, liegen alle vier und die Mitte draußen, ist er 0.
   * Nur die Randmaschen werden mit einem `samples`×`samples`-Muster
   * ausgezählt.
   */
  function coverageGrid(grid, ring, samples) {
    const { nx, ny, cell, x0, y0 } = grid;
    const cov = new Float32Array(nx * ny);

    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const ax = x0 + gx * cell, ay = y0 + gy * cell;
        const bx = ax + cell, by = ay + cell;

        const c1 = isInside(ax, ay, ring), c2 = isInside(bx, ay, ring);
        const c3 = isInside(bx, by, ring), c4 = isInside(ax, by, ring);
        const cm = isInside(ax + cell / 2, ay + cell / 2, ring);

        if (c1 && c2 && c3 && c4 && cm) { cov[gy * nx + gx] = 1; continue; }
        if (!c1 && !c2 && !c3 && !c4 && !cm) { cov[gy * nx + gx] = 0; continue; }

        let hits = 0;
        for (let sy = 0; sy < samples; sy++) {
          for (let sx = 0; sx < samples; sx++) {
            if (isInside(ax + (sx + 0.5) * cell / samples,
                         ay + (sy + 0.5) * cell / samples, ring)) hits++;
          }
        }
        cov[gy * nx + gx] = hits / (samples * samples);
      }
    }
    return cov;
  }

  // ===========================================================================
  // BEZUGSEBENE
  // ===========================================================================

  /**
   * Bezugsebene als h(x,y) = a + b·x + c·y im örtlichen System.
   *
   * Die drei waagerechten Fälle setzen b = c = 0. Der vierte — die
   * Ausgleichsebene durch die gesetzten Ecken — ist der praktische: eine
   * Baugrube in der Hanglage hat keine waagerechte Sohle, und gegen eine
   * waagerechte Ebene gerechnet steht in der Bilanz die halbe Böschung mit
   * drin.
   *
   * Bei drei Ecken geht die Ebene exakt durch sie hindurch, bei mehr ist es
   * die Ausgleichsebene nach kleinsten Quadraten. Wird das Gleichungssystem
   * entartet (alle Ecken auf einer Geraden), bleibt es beim Mittel.
   */
  function referencePlane(ctx, options) {
    const heights = ctx.cornerHeights;
    const ring = ctx.ring;

    if (options.reference === 'fest') return { a: options.fixedHeight, b: 0, c: 0 };
    if (options.reference === 'mittel') {
      return { a: heights.reduce((s, h) => s + h, 0) / heights.length, b: 0, c: 0 };
    }
    if (options.reference === 'geneigt') return fitPlane(ring, heights, ctx.center);
    return { a: Math.min(...heights), b: 0, c: 0 };   // 'tiefste'
  }

  function fitPlane(ring, heights, center) {
    const n = ring.length;
    const mean = heights.reduce((s, h) => s + h, 0) / n;
    if (n < 3) return { a: mean, b: 0, c: 0 };

    // Um den Mittelpunkt zentriert gerechnet: sonst stehen in der
    // Normalgleichung Koordinaten und ihre Quadrate nebeneinander, und bei
    // einem weit vom Ursprung entfernten Polygon frisst das die Stellen auf,
    // um die es geht.
    let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
    for (let i = 0; i < n; i++) {
      const x = ring[i].x - center.x, y = ring[i].y - center.y, z = heights[i] - mean;
      sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-9) return { a: mean, b: 0, c: 0 };

    const b = (sxz * syy - syz * sxy) / det;
    const c = (syz * sxx - sxz * sxy) / det;
    return { a: mean - b * center.x - c * center.y, b, c };
  }

  function planeAt(plane, x, y) {
    return plane.a + plane.b * x + plane.c * y;
  }

  // ===========================================================================
  // VOLUMEN
  // ===========================================================================

  /**
   * Prismensumme über die Maschen.
   *
   * Getrennt nach über und unter der Bezugsebene: beim Erdbau sind das
   * Auftrag und Abtrag, und die Differenz allein verschleiert, wie viel
   * jeweils bewegt wurde. Löcher zählen nicht mit — sie mit der Bezugshöhe
   * anzusetzen hieße zu behaupten, dort läge das Gelände genau auf Null.
   * Wie viel Fläche dabei ausfällt, steht als `holeArea` im Ergebnis.
   */
  function integrate(grid, plane) {
    const { nx, ny, cell, x0, y0, h, coverage } = grid;
    const full = cell * cell;

    let cut = 0, fill = 0, area = 0, holeArea = 0, cells = 0;
    let hmin = Infinity, hmax = -Infinity, hsum = 0;

    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const k = gy * nx + gx;
        const cov = coverage[k];
        if (cov <= 0) continue;

        const value = h[k];
        const a = cov * full;
        if (Number.isNaN(value)) { holeArea += a; continue; }

        const x = x0 + (gx + 0.5) * cell;
        const y = y0 + (gy + 0.5) * cell;
        const d = value - planeAt(plane, x, y);

        if (d >= 0) cut += d * a; else fill += -d * a;
        area += a;
        cells++;
        hsum += value;
        if (value < hmin) hmin = value;
        if (value > hmax) hmax = value;
      }
    }

    return {
      cut, fill, area, holeArea, cells,
      hmin: cells ? hmin : 0,
      hmax: cells ? hmax : 0,
      hmean: cells ? hsum / cells : 0,
    };
  }

  // ===========================================================================
  // KARTE
  // ===========================================================================

  /**
   * Höhenstufen, Schummerung und Höhenlinien in eine Leinwand.
   *
   * Gezeichnet wird je Bildpunkt, nicht je Masche: die Höhe wird zwischen den
   * Maschenmitten bilinear geholt, und daraus entstehen drei Dinge auf einmal.
   *
   * **Die Höhenlinie ohne Linienverfolgung.** Der Abstand zur nächsten
   * Höhenstufe in Metern, geteilt durch das Höhengefälle je Bildpunkt, ergibt
   * den Abstand zur Linie *in Bildpunkten*. Daraus wird die Deckung direkt
   * gebildet — die Linien sind damit überall gleich breit und weich
   * gezeichnet, ohne dass ein einziger Linienzug verfolgt werden müsste.
   * Marschierende Quadrate mit anschließendem Verketten wären zehnmal so viel
   * Code für ein schlechteres Bild.
   *
   * **Die Linienfarbe richtet sich nach dem Untergrund** — dunkel auf hellen,
   * hell auf dunklen Flächen. Eine feste braune Linie verschwindet im tiefen
   * Grün, eine feste weiße im hellen Sand.
   *
   * **Die Schummerung** kommt aus demselben Gefälle. Ohne sie ist eine
   * Farbstufenkarte flach; mit ihr sieht man die Form, bevor man die Legende
   * gelesen hat. Zweifach überhöht, weil Baugelände sonst zu flach ist, um
   * Licht zu fangen.
   */
  function renderMap(grid, plane, ctx, options, result) {
    const { nx, ny, cell, x0, y0, h } = grid;
    // Vorher stand hier `Math.max(1, …)` — das sicherte mindestens einen
    // Bildpunkt je Masche zu und ließ die Leinwand dabei über jede Grenze
    // wachsen. Jetzt begrenzen beide Deckel nach oben, und bei einem sehr
    // feinen Geländemodell wird die Karte eben gröber als das Modell. Das
    // steht dann im Ergebnis, statt den Browser zu sprengen.
    const scale = mapScale(nx, ny);
    const W = Math.max(2, Math.round(nx * scale));
    const H = Math.max(2, Math.round(ny * scale));

    const metresPerPixelX = (nx * cell) / W;
    const metresPerPixelY = (ny * cell) / H;

    // 1 — Höhenfeld je Bildpunkt (Zeile 0 ist Norden)
    const field = new Float32Array(W * H);
    const delta = new Float32Array(W * H);
    for (let py = 0; py < H; py++) {
      const y = y0 + ((H - 0.5 - py) * ny / H) * cell;
      for (let px = 0; px < W; px++) {
        const x = x0 + ((px + 0.5) * nx / W) * cell;
        const value = sample(grid, x, y);
        field[py * W + px] = value;
        delta[py * W + px] = Number.isNaN(value) ? NaN : value - planeAt(plane, x, y);
      }
    }

    // 2 — Maske aus dem Polygon. Der Umweg über den Pfad der Leinwand liefert
    // weiche Kanten frei Haus; ein Punkt-im-Polygon-Test je Bildpunkt wäre
    // zackig und bei einer Million Bildpunkten obendrein teuer.
    const mask = polygonMask(ctx.ring, grid, W, H);

    // 3 — Höhenstufen und Skalenenden
    const useDelta = options.ramp === 'auftrag';
    const values = useDelta ? delta : field;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (Number.isNaN(v) || mask[i] === 0) continue;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) hi = lo + 1e-6;

    // Zweipolig wird symmetrisch skaliert, sonst läge die neutrale Mitte
    // nicht auf der Bezugsebene und die Karte behauptete einen Auftrag, wo
    // keiner ist.
    const span = useDelta ? Math.max(Math.abs(lo), Math.abs(hi)) : 0;
    const from = useDelta ? -span : lo;
    const to = useDelta ? span : hi;

    const interval = options.interval > 0
      ? options.interval
      : niceStep((result.maxHeight - result.minHeight) / 14) || 0.1;

    // 4 — Zeichnen
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const image = canvas.getContext('2d').createImageData(W, H);
    const px32 = image.data;
    const ramp = RAMPS[options.ramp] || RAMPS.hoehe;
    const rgb = [0, 0, 0];

    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const p = py * W + px;
        const o = p * 4;
        const value = field[p];
        const alpha = mask[p];
        if (Number.isNaN(value) || alpha === 0) { px32[o + 3] = 0; continue; }

        // Gefälle aus den Nachbarn — am Rand einseitig.
        const hl = at(field, W, H, px - 1, py, value);
        const hr = at(field, W, H, px + 1, py, value);
        const hu = at(field, W, H, px, py - 1, value);
        const hd = at(field, W, H, px, py + 1, value);
        const gxPix = (hr - hl) / 2;
        const gyPix = (hd - hu) / 2;

        const t = ((useDelta ? delta[p] : value) - from) / (to - from);
        rampColor(ramp, options.steps ? quantize(t, from, to, interval) : t, rgb);

        if (options.hillshade) {
          // Steigung in Meter je Meter, zweifach überhöht. gy zeigt im Bild
          // nach unten, im Gelände also nach Süden — daher das Vorzeichen.
          const sx = (gxPix / metresPerPixelX) * 2;
          const sy = (-gyPix / metresPerPixelY) * 2;
          const inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
          // Licht aus Nordwesten, 45° hoch — die kartografische Übereinkunft;
          // von Südosten beleuchtet kippt jedes Tal zum Rücken.
          //
          // Beleuchtet wird die **Flächennormale** (−sx, −sy, 1), nicht die
          // Steigung selbst. Mit dem Gefälle statt der Normalen gerechnet
          // kommt genau das seitenverkehrte Bild heraus, und das sieht nicht
          // falsch aus — es sieht aus wie ein Krater statt eines Berges.
          const shade = Math.max(0, (0.5 * sx - 0.5 * sy + 0.7071) * inv);
          // Eine ebene Fläche trifft das Licht unter 45°, dort ist `shade`
          // gleich 0,7071 — und genau dort muss der Faktor 1 sein, sonst
          // verschiebt die Schummerung die abgelesene Höhe. Nach oben ist er
          // eng gedeckelt: bei der zweipoligen Skala liegt der Untergrund um
          // die Bezugsebene herum fast bei Weiß, und was dort ausbrennt, ist
          // nicht mehr von „genau auf der Ebene" zu unterscheiden.
          const f = Math.min(1.15, 0.45 + 0.78 * shade);
          rgb[0] = Math.min(255, rgb[0] * f);
          rgb[1] = Math.min(255, rgb[1] * f);
          rgb[2] = Math.min(255, rgb[2] * f);
        }

        if (options.contours) {
          const q = value / interval;
          const nearest = Math.round(q);
          const metres = Math.abs(q - nearest) * interval;
          const gradient = Math.max(Math.hypot(gxPix, gyPix), 1e-6);
          const distance = metres / gradient;               // in Bildpunkten
          const index = nearest % 5 === 0;
          const halfWidth = index ? 1.1 : 0.55;
          const line = Math.min(1, Math.max(0, halfWidth - distance + 0.5))
            * (index ? 0.85 : 0.6);
          if (line > 0) {
            // Helligkeit nach ITU-R BT.601 — reicht für die Frage „hell oder
            // dunkel" und kostet drei Multiplikationen.
            const light = (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) > 145;
            const ink = light ? 38 : 245;
            rgb[0] += (ink - rgb[0]) * line;
            rgb[1] += (ink - rgb[1]) * line;
            rgb[2] += (ink - rgb[2]) * line;
          }
        }

        px32[o] = rgb[0]; px32[o + 1] = rgb[1]; px32[o + 2] = rgb[2];
        px32[o + 3] = alpha;
      }
    }
    canvas.getContext('2d').putImageData(image, 0, 0);

    return {
      canvas,
      field, delta, mask, W, H,
      from, to, interval,
      useDelta,
      scale,
      steps: options.steps,
      ramp: options.ramp,
      metresPerPixelX,
      figure: renderFigure(canvas, { from, to, interval, useDelta, ramp, options, result, metresPerPixelX }),
    };
  }

  /**
   * Bildpunkte je Masche.
   *
   * Drei, wenn beide Deckel es zulassen — sonst so viele, wie hineinpassen.
   */
  function mapScale(nx, ny) {
    const byEdge = MAP_MAX_EDGE / Math.max(nx, ny);
    const byArea = Math.sqrt(MAP_MAX_PIXELS / (nx * ny));
    return Math.max(0.25, Math.min(MAP_PIXELS_PER_CELL, byEdge, byArea));
  }

  /**
   * Höhe an einer beliebigen Stelle — bikubisch, mit Rückfall auf bilinear.
   *
   * Bilinear allein ist der Grund, warum Höhenlinien das Rechenraster zeigen:
   * das Feld ist an jeder Maschengrenze geknickt, und eine Isolinie durch ein
   * geknicktes Feld ist ein Streckenzug mit Ecken genau auf den Maschenkanten.
   * Catmull-Rom macht das Feld stetig differenzierbar, und die Linien werden
   * rund — ohne dass eine einzige Höhe hinzuerfunden würde: an den
   * Maschenmitten liefert das Verfahren exakt die gemessenen Werte.
   *
   * **Geklemmt wird auf die vier inneren Nachbarn.** Catmull-Rom überschwingt
   * an Kanten, und ein Überschwinger ist hier keine Unschönheit, sondern eine
   * Falschaussage: er erzeugt eine Höhenlinie, die es nicht gibt, und
   * verschiebt die Enden der Farbskala.
   *
   * Liegt in der 4×4-Nachbarschaft ein Loch, wird bilinear gerechnet. So
   * bleiben die Löcher genau so groß, wie sie gemessen wurden — bikubisch
   * würden sie um eine Masche wachsen.
   */
  function sample(grid, x, y) {
    const { nx, ny, cell, x0, y0, h } = grid;
    const u = (x - x0) / cell - 0.5;
    const v = (y - y0) / cell - 0.5;
    const i = Math.floor(u), j = Math.floor(v);
    const fu = u - i, fv = v - j;

    const at = (gx, gy) => {
      const cx = gx < 0 ? 0 : gx >= nx ? nx - 1 : gx;
      const cy = gy < 0 ? 0 : gy >= ny ? ny - 1 : gy;
      return h[cy * nx + cx];
    };

    const h11 = at(i, j), h21 = at(i + 1, j), h12 = at(i, j + 1), h22 = at(i + 1, j + 1);
    if (Number.isNaN(h11) || Number.isNaN(h21) || Number.isNaN(h12) || Number.isNaN(h22)) {
      return NaN;
    }

    const rows = [];
    for (let r = -1; r <= 2; r++) {
      const a = at(i - 1, j + r), b = at(i, j + r), c = at(i + 1, j + r), d = at(i + 2, j + r);
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
        return bilinear(grid, x, y);
      }
      rows.push(catmullRom(a, b, c, d, fu));
    }
    const value = catmullRom(rows[0], rows[1], rows[2], rows[3], fv);

    const lo = Math.min(h11, h21, h12, h22);
    const hi = Math.max(h11, h21, h12, h22);
    return value < lo ? lo : value > hi ? hi : value;
  }

  /** Catmull-Rom durch vier Stützstellen; bei t = 0 genau `p1`, bei 1 `p2`. */
  function catmullRom(p0, p1, p2, p3, t) {
    return p1 + 0.5 * t * (p2 - p0
      + t * (2 * p0 - 5 * p1 + 4 * p2 - p3
      + t * (3 * (p1 - p2) + p3 - p0)));
  }

  /** Bilinear zwischen den Maschenmitten; ein Loch färbt ab. */
  function bilinear(grid, x, y) {
    const { nx, ny, cell, x0, y0, h } = grid;
    const u = (x - x0) / cell - 0.5;
    const v = (y - y0) / cell - 0.5;
    const i = Math.floor(u), j = Math.floor(v);
    const fu = u - i, fv = v - j;

    const g = (gx, gy) => {
      if (gx < 0 || gx >= nx || gy < 0 || gy >= ny) return NaN;
      return h[gy * nx + gx];
    };
    const h00 = g(i, j), h10 = g(i + 1, j), h01 = g(i, j + 1), h11 = g(i + 1, j + 1);
    if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) return NaN;

    return h00 * (1 - fu) * (1 - fv) + h10 * fu * (1 - fv)
         + h01 * (1 - fu) * fv + h11 * fu * fv;
  }

  function at(field, W, H, px, py, fallback) {
    if (px < 0 || px >= W || py < 0 || py >= H) return fallback;
    const v = field[py * W + px];
    return Number.isNaN(v) ? fallback : v;
  }

  function polygonMask(ring, grid, W, H) {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath();
    ring.forEach((p, i) => {
      const px = ((p.x - grid.x0) / (grid.nx * grid.cell)) * W;
      const py = H - ((p.y - grid.y0) / (grid.ny * grid.cell)) * H;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    });
    g.closePath();
    g.fill();

    const data = g.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3];
    return mask;
  }

  /** Wert auf die Mitte seiner Höhenstufe legen — für die Stufenkarte. */
  function quantize(t, from, to, interval) {
    const value = from + t * (to - from);
    const stepped = (Math.floor(value / interval) + 0.5) * interval;
    return (stepped - from) / (to - from);
  }

  function rampColor(ramp, t, out) {
    const u = Math.min(1, Math.max(0, t));
    const stops = ramp.stops;
    for (let i = 1; i < stops.length; i++) {
      if (u > stops[i][0] && i < stops.length - 1) continue;
      const a = stops[i - 1], b = stops[i];
      const f = b[0] === a[0] ? 0 : (u - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * f;
      out[1] = a[2] + (b[2] - a[2]) * f;
      out[2] = a[3] + (b[3] - a[3]) * f;
      return out;
    }
    out[0] = stops[0][1]; out[1] = stops[0][2]; out[2] = stops[0][3];
    return out;
  }

  // ── Kartenblatt ────────────────────────────────────────────────────────────

  /**
   * Dieselbe Karte, aber als Blatt: Rahmen, Legende, Maßstabsleiste,
   * Nordpfeil, Kopfzeile.
   *
   * Zwei Leinwände statt einer, weil sie zwei verschiedene Dinge sind. Die
   * eine liegt als Textur auf der Oberfläche in der Szene — dort wäre eine
   * Maßstabsleiste perspektivisch verzerrt und schlicht falsch. Die andere
   * ist ein Blatt zum Ansehen und Herausziehen, und dort fehlt ohne Legende
   * die halbe Aussage.
   */
  function renderFigure(map, info) {
    const D = 2;                       // doppelt gezeichnet, halb dargestellt
    const PAD = 18 * D;
    const LEGEND = 58 * D;
    const HEAD = 38 * D;

    const width = Math.min(map.width, 900);
    const height = Math.round(map.height * (width / map.width));

    const canvas = document.createElement('canvas');
    canvas.width = width * D + PAD * 2;
    canvas.height = height * D + PAD * 2 + LEGEND + HEAD;
    const g = canvas.getContext('2d');

    g.fillStyle = '#12141a';
    g.fillRect(0, 0, canvas.width, canvas.height);

    // Kopfzeile
    g.fillStyle = '#e8ecf2';
    g.font = `600 ${17 * D}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.textBaseline = 'middle';
    g.fillText(info.useDelta ? 'Auftrag und Abtrag gegen die Bezugsebene'
                             : 'Höhen über dem Ellipsoid', PAD, HEAD / 2 + PAD / 2);
    g.fillStyle = '#8b95a6';
    g.font = `${14 * D}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.textAlign = 'right';
    g.fillText(`Höhenlinien alle ${trim(info.interval)} m`, canvas.width - PAD, HEAD / 2 + PAD / 2);
    g.textAlign = 'left';

    // Karte
    const mapTop = HEAD + PAD / 2;
    g.imageSmoothingEnabled = true;
    g.drawImage(map, PAD, mapTop, width * D, height * D);
    g.strokeStyle = '#39404d';
    g.lineWidth = 1 * D;
    g.strokeRect(PAD - 0.5 * D, mapTop - 0.5 * D, width * D + D, height * D + D);

    drawNorthArrow(g, PAD + width * D - 26 * D, mapTop + 26 * D, 17 * D, D);
    drawScaleBar(g, PAD + 14 * D, mapTop + height * D - 18 * D,
      width * D, info.metresPerPixelX * (map.width / (width * D)), D);
    drawLegend(g, PAD, mapTop + height * D + 20 * D, canvas.width - PAD * 2, info, D);

    return canvas;
  }

  function drawLegend(g, x, y, width, info, D) {
    const barHeight = 13 * D;
    const gradient = g.createLinearGradient(x, 0, x + width, 0);
    const rgb = [0, 0, 0];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      rampColor(info.ramp, info.options.steps
        ? quantize(t, info.from, info.to, info.interval) : t, rgb);
      gradient.addColorStop(t, `rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0})`);
    }
    g.fillStyle = gradient;
    g.fillRect(x, y, width, barHeight);
    g.strokeStyle = '#39404d';
    g.lineWidth = 1 * D;
    g.strokeRect(x - 0.5 * D, y - 0.5 * D, width + D, barHeight + D);

    g.font = `${13 * D}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.fillStyle = '#aab3c0';
    g.textBaseline = 'top';

    // Fünf beschriftete Marken. Die Enden hängen an ihrer Kante, sonst
    // stünden sie über dem Blattrand.
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const value = info.from + t * (info.to - info.from);
      const px = x + t * width;
      g.beginPath();
      g.moveTo(px, y + barHeight);
      g.lineTo(px, y + barHeight + 4 * D);
      g.strokeStyle = '#5a6373';
      g.stroke();
      g.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      const label = (info.useDelta && value > 0 ? '+' : '') + trim(value) + ' m';
      g.fillText(label, px, y + barHeight + 6 * D);
    }
    g.textAlign = 'left';
  }

  function drawScaleBar(g, x, y, mapWidthPx, metresPerPixel, D) {
    const wanted = mapWidthPx * 0.22 * metresPerPixel;
    const metres = niceStep(wanted) || 1;
    const bar = metres / metresPerPixel;
    const h = 6 * D;

    g.fillStyle = 'rgba(10,12,16,0.62)';
    g.fillRect(x - 6 * D, y - 19 * D, bar + 12 * D, 27 * D);
    g.fillStyle = '#e8ecf2';
    g.fillRect(x, y, bar / 2, h);
    g.fillStyle = '#12141a';
    g.fillRect(x + bar / 2, y, bar / 2, h);
    g.strokeStyle = '#e8ecf2';
    g.lineWidth = 1 * D;
    g.strokeRect(x, y, bar, h);

    g.fillStyle = '#e8ecf2';
    g.font = `${13 * D}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.textBaseline = 'bottom';
    g.textAlign = 'left';
    g.fillText(`${trim(metres)} m`, x, y - 2 * D);
  }

  function drawNorthArrow(g, x, y, size, D) {
    g.save();
    g.translate(x, y);
    g.fillStyle = 'rgba(10,12,16,0.62)';
    g.beginPath();
    g.arc(0, 0, size, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#e8ecf2';
    g.beginPath();
    g.moveTo(0, -size * 0.62);
    g.lineTo(size * 0.34, size * 0.5);
    g.lineTo(0, size * 0.24);
    g.closePath();
    g.fill();
    g.fillStyle = '#8b95a6';
    g.beginPath();
    g.moveTo(0, -size * 0.62);
    g.lineTo(-size * 0.34, size * 0.5);
    g.lineTo(0, size * 0.24);
    g.closePath();
    g.fill();

    g.fillStyle = '#e8ecf2';
    g.font = `700 ${10 * D}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', 0, -size * 0.86);
    g.restore();
  }

  // ===========================================================================
  // OBERFLÄCHE IN DER SZENE
  // ===========================================================================

  /**
   * Die Karte als Textur über die gemessene Oberfläche.
   *
   * Die Eckpunkte des Netzes sind die Maschenmitten; ein Viereck entsteht nur,
   * wo alle vier Ecken eine Höhe haben — über einem Loch klafft dann auch im
   * Netz eines, und man sieht, wo nicht gemessen wurde, statt es zu überdecken.
   *
   * Gerechnet wird **örtlich** und die Matrix des Bezugssystems als
   * `modelMatrix` mitgegeben. Weltkoordinaten liegen bei 6,4 Millionen Metern;
   * in `float` bliebe davon keine Stelle für die Zentimeter, um die es geht.
   *
   * Die Textur wird über s/t angelegt, und weil Cesium Bilder mit `flipY`
   * lädt, liegt t = 1 an der Bildoberkante — also im Norden. Genau dort steht
   * in der Leinwand auch die erste Zeile.
   */
  function buildSurface(ctx, grid, canvas, options) {
    removeSurface();
    const v = viewer();
    if (!v) return;

    const { nx, ny, cell, x0, y0, h, coverage } = grid;
    const width = nx * cell, height = ny * cell;

    // Ein Hauch über der Messung, damit die Punktwolke nicht durch die Fläche
    // hindurchsticht. Nicht mehr — es ist eine Auflage, keine Etage.
    const lift = Math.max(0.03, (state.result.maxHeight - state.result.minHeight) * 0.01);

    const index = new Int32Array(nx * ny).fill(-1);
    const positions = [], normals = [], sts = [];
    let vertices = 0;

    for (let gy = 0; gy < ny; gy++) {
      for (let gx = 0; gx < nx; gx++) {
        const k = gy * nx + gx;
        if (coverage[k] <= 0 || Number.isNaN(h[k])) continue;
        const x = x0 + (gx + 0.5) * cell;
        const y = y0 + (gy + 0.5) * cell;
        positions.push(x, y, localFromHeight(ctx, x, y, h[k] + lift));
        normals.push(0, 0, 1);
        sts.push((x - x0) / width, (y - y0) / height);
        index[k] = vertices++;
      }
    }
    if (vertices < 4) return;

    const indices = [];
    for (let gy = 0; gy < ny - 1; gy++) {
      for (let gx = 0; gx < nx - 1; gx++) {
        const a = index[gy * nx + gx];
        const b = index[gy * nx + gx + 1];
        const c = index[(gy + 1) * nx + gx + 1];
        const d = index[(gy + 1) * nx + gx];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        indices.push(a, b, c, a, c, d);
      }
    }
    if (!indices.length) return;

    const geometry = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: new Float64Array(positions),
        }),
        // `flat: true` wertet die Normale nicht aus, das Vertexformat von
        // `MaterialAppearance` verlangt sie trotzdem.
        normal: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: new Float32Array(normals),
        }),
        st: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: new Float32Array(sts),
        }),
      },
      indices: vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
    });

    state.surface = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }),
      modelMatrix: ctx.frame,
      appearance: new Cesium.MaterialAppearance({
        material: Cesium.Material.fromType('Image', {
          image: canvas,
          color: new Cesium.Color(1, 1, 1, options.opacity),
        }),
        flat: true,
        faceForward: false,
        translucent: true,
        closed: false,
      }),
      asynchronous: false,
      // Eine Auflage über dem Bestand. Finge sie die Klicks ab, käme man an
      // die Punktwolke darunter nicht mehr heran.
      allowPicking: false,
    });
    v.scene.primitives.add(state.surface);
  }

  /** Die Bezugsebene als halbdurchsichtige Fläche — der Boden der Bilanz. */
  function drawReferencePlane(plane, ctx) {
    const v = viewer();
    if (!v) return;

    const outline = ctx.ring.map((p) => {
      const z = localFromHeight(ctx, p.x, p.y, planeAt(plane, p.x, p.y));
      return Cesium.Matrix4.multiplyByPoint(
        ctx.frame, new Cesium.Cartesian3(p.x, p.y, z), new Cesium.Cartesian3());
    });

    state.refPlane = v.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outline),
        perPositionHeight: true,
        material: Cesium.Color.fromCssColorString(ACCENT).withAlpha(0.18),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(ACCENT),
      },
    });
    state.entities.push(state.refPlane);
  }

  // ===========================================================================
  // GEOMETRIE
  // ===========================================================================

  function boundsOf(ring) {
    return ring.reduce((box, p) => ({
      minX: Math.min(box.minX, p.x), maxX: Math.max(box.maxX, p.x),
      minY: Math.min(box.minY, p.y), maxY: Math.max(box.maxY, p.y),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  }

  function estimateCells(bounds, cell) {
    return ((bounds.maxX - bounds.minX) / cell) * ((bounds.maxY - bounds.minY) / cell);
  }

  /** Gauß'sche Trapezformel im örtlichen System. */
  function areaOf(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
    }
    return Math.abs(sum / 2);
  }

  /** Punkt-im-Polygon nach der Geradenschnitt-Regel (even-odd). */
  function isInside(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const intersects = (ring[i].y > y) !== (ring[j].y > y)
        && x < (ring[j].x - ring[i].x) * (y - ring[i].y) / (ring[j].y - ring[i].y) + ring[i].x;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  /** Der nächste runde Wert nach oben — 0,25 / 0,5 / 1 / 2 / 2,5 / 5 … */
  function niceStep(raw) {
    if (!(raw > 0)) return 0;
    for (const step of NICE) if (step >= raw) return step;
    // Über 100 in Zehnerschritten weiter, statt die Liste zu verlängern.
    return Math.ceil(raw / 100) * 100;
  }

  // ===========================================================================
  // OBERFLÄCHE IM PANEL
  // ===========================================================================

  function readOptions() {
    const value = (id, fallback) => document.getElementById(id)?.value ?? fallback;
    const checked = (id, fallback) => {
      const el = document.getElementById(id);
      return el ? el.checked : fallback;
    };
    return {
      cell: parseFloat(value('tvCell', '0')) || 0,
      aggregate: value('tvAggregate', 'mittel'),
      reference: value('tvReference', 'tiefste'),
      fixedHeight: parseFloat(value('tvFixedHeight', '0')) || 0,
      ramp: value('tvRamp', 'hoehe'),
      interval: parseFloat(value('tvInterval', '0')) || 0,
      contours: checked('tvContours', true),
      hillshade: checked('tvHillshade', true),
      steps: checked('tvSteps', false),
      overlay: checked('tvOverlay', true),
      opacity: parseFloat(value('tvOpacity', '0.9')) || 0.9,
    };
  }

  /**
   * Neu rechnen, ohne die Punkte noch einmal zu holen.
   *
   * Das Lesen der Kacheln ist der teure Teil — Maschenweite, Maschenhöhe,
   * Bezugsebene und Karte hängen aber alle nur an den Punkten, die schon da
   * sind. Sie bleiben deshalb liegen, und jede Einstellung wirkt sofort.
   *
   * `rebin` = false spart auch noch das Einsortieren: Farbverlauf, Schummerung
   * und Höhenlinienabstand ändern nur das Bild, nicht das Geländemodell.
   */
  function recompute(rebin) {
    // Auch ohne Ergebnis neu zeichnen: die Wahl „Feste Höhe" blendet ein
    // Eingabefeld ein, und das soll vor der ersten Messung genauso auftauchen.
    if (!state.ctx || !state.result) { render(); return; }
    const options = readOptions();

    if (rebin && state.cloud) {
      const masche = chooseCell(state.ctx.area, state.cloud.n, options.cell, state.ctx.bounds);
      const grid = binPoints(state.cloud, state.ctx.bounds, masche.cell, options.aggregate);
      const filled = fillGaps(grid, FILL_PASSES);
      grid.coverage = coverageGrid(grid, state.ctx.ring, 5);
      state.grid = grid;
      state.result.cell = masche.cell;
      state.result.cellForced = masche.forced ? masche.asked : 0;
      state.result.interpolated = filled;
      state.result.aggregate = options.aggregate;
    }
    if (!state.grid) return;

    // Die Bezugsebene kann sich geändert haben — dann stimmt die Bilanz nicht
    // mehr, und eine Karte zu einem veralteten Ergebnis wäre schlimmer als
    // keine.
    const plane = referencePlane(state.ctx, options);
    const sums = integrate(state.grid, plane);
    Object.assign(state.result, {
      net: sums.cut - sums.fill, cut: sums.cut, fill: sums.fill,
      coveredArea: sums.area, holeArea: sums.holeArea,
      minHeight: sums.hmin, maxHeight: sums.hmax, meanHeight: sums.hmean,
      referenceHeight: plane.a, tilt: Math.hypot(plane.b, plane.c),
      cells: sums.cells, reference: options.reference,
    });

    state.map = renderMap(state.grid, plane, state.ctx, options, state.result);

    if (state.refPlane) {
      viewer()?.entities.remove(state.refPlane);
      state.entities = state.entities.filter((e) => e !== state.refPlane);
      state.refPlane = null;
    }
    drawReferencePlane(plane, state.ctx);
    if (options.overlay) buildSurface(state.ctx, state.grid, state.map.canvas, options);
    else removeSurface();
    render();
  }

  const redraw = () => recompute(false);
  const rebin = () => recompute(true);

  /**
   * Deckkraft ohne Neuaufbau — der Bildstoff hat einen Farb-Uniform, und
   * das Netz neu zu bauen, während jemand am Regler zieht, ruckelt.
   */
  function setOpacity(value) {
    const material = state.surface && state.surface.appearance && state.surface.appearance.material;
    if (material && material.uniforms) {
      material.uniforms.color = new Cesium.Color(1, 1, 1, parseFloat(value) || 1);
    }
  }

  /**
   * Die Karte in der Szene an- und abschalten.
   *
   * Der Schalter im Panel ist die einzige Wahrheit darüber — `readOptions()`
   * liest ihn mit. Ein zweiter Zustand im Modul daneben wäre die Sorte
   * Doppelbuchführung, die irgendwann auseinanderläuft.
   */
  function setOverlay(on) {
    if (!state.grid || !state.map) return;
    if (on) buildSurface(state.ctx, state.grid, state.map.canvas, readOptions());
    else removeSurface();
  }

  function downloadMap() {
    if (!state.map) { status('Es liegt keine Karte vor', 'warning'); return; }
    const link = document.createElement('a');
    link.download = `aufmass-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    link.href = state.map.figure.toDataURL('image/png');
    link.click();
  }

  function fail(message) {
    state.error = message;
    state.busy = false;
    render();
    status(message, 'error');
    console.warn('[Aufmaß] ' + message);
  }

  function format(value) {
    const abs = Math.abs(value);
    const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
    return value.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function trim(value) {
    const abs = Math.abs(value);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 1 : 2;
    return value.toLocaleString('de-DE', { maximumFractionDigits: digits });
  }

  /**
   * Zeichnet den gesamten Zustand des Werkzeugs ins Panel.
   *
   * Ein einziger Zeichenweg statt verstreuter `style.display`-Zuweisungen:
   * sonst bleibt das Panel in einem Zustand stehen, den es nicht mehr gibt —
   * und genau das sieht aus, als passiere nichts.
   */
  function render() {
    const button = document.getElementById('tvStart');
    const stop = document.getElementById('tvStop');
    const count = document.getElementById('tvCount');
    const busy = document.getElementById('tvBusy');
    const result = document.getElementById('tvResult');
    const map = document.getElementById('tvMap');
    const fixedRow = document.getElementById('tvFixedRow');
    const tools = document.getElementById('tvTools');

    const corners = state.positions.length;

    if (button) {
      button.textContent = state.busy ? 'Wird gerechnet…'
        : state.active ? (corners >= 3 ? 'Fläche schließen' : 'Ecken anklicken…')
        : 'Fläche aufziehen';
      button.disabled = state.busy || (state.active && corners < 3);
      button.classList.toggle('is-active', state.active);
    }

    if (stop) stop.style.display = (state.active || state.busy || state.result) ? '' : 'none';
    if (count) {
      count.style.display = corners && !state.result ? '' : 'none';
      count.textContent = `${corners} ${corners === 1 ? 'Ecke' : 'Ecken'}`;
    }
    if (busy) {
      busy.style.display = state.busy && state.step ? '' : 'none';
      busy.textContent = state.step;
    }
    if (fixedRow) {
      fixedRow.style.display =
        document.getElementById('tvReference')?.value === 'fest' ? '' : 'none';
    }
    if (tools) tools.style.display = state.result ? '' : 'none';

    // Im Panel steht die **reine** Karte, nicht das Blatt: Legende, Maßstab
    // und Nordpfeil sind dort in die Leinwand gezeichnet und auf Panelbreite
    // geschrumpft nicht mehr zu lesen. Sie stehen deshalb als Text daneben,
    // und das Blatt gibt es beim Sichern.
    if (map) {
      map.innerHTML = '';
      map.style.display = state.map ? '' : 'none';
      if (state.map) {
        const canvas = state.map.canvas;
        canvas.className = 'tv-karte';
        canvas.title = 'Zeigen für Höhe und Differenz';
        attachProbe(canvas);
        map.appendChild(canvas);
        map.insertAdjacentHTML('beforeend', legendHtml(state.map));
      }
    }

    if (!result) return;

    if (state.error) {
      result.style.display = '';
      result.innerHTML = `<p class="hint" style="color:var(--ds-danger);">${state.error}</p>`;
      return;
    }
    if (state.result) {
      result.style.display = '';
      result.innerHTML = resultHtml(state.result);
      return;
    }
    result.style.display = 'none';
    result.innerHTML = '';
  }

  /**
   * Legende als Text neben der Karte.
   *
   * Der Balken wird aus demselben Farbverlauf gebildet wie die Karte —
   * einschließlich der Stufung, wenn die Stufenkarte gewählt ist. Eine
   * Legende, die einen weichen Verlauf zeigt, während die Karte in Bändern
   * liegt, ist schlimmer als keine.
   */
  function legendHtml(map) {
    const ramp = RAMPS[map.ramp] || RAMPS.hoehe;
    const rgb = [0, 0, 0];
    const stops = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      rampColor(ramp, map.steps ? quantize(t, map.from, map.to, map.interval) : t, rgb);
      stops.push(`rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}) ${(t * 100).toFixed(1)}%`);
    }

    const marks = [];
    for (let i = 0; i <= 4; i++) {
      const value = map.from + (i / 4) * (map.to - map.from);
      marks.push(`<span>${(map.useDelta && value > 0 ? '+' : '') + trim(value)} m</span>`);
    }

    return `
      <div class="tv-legende">
        <div class="tv-legende__balken" style="background:linear-gradient(90deg,${stops.join(',')});"></div>
        <div class="tv-legende__marken">${marks.join('')}</div>
      </div>
      <p class="hint" style="margin-top:6px;">
        ${map.useDelta ? 'Differenz zur Bezugsebene' : 'Höhe über dem Ellipsoid'} ·
        Höhenlinien alle ${trim(map.interval)} m · Norden oben ·
        ${map.scale >= 1
          ? `${map.scale.toFixed(1)} Bildpunkte je Masche`
          : `${(1 / map.scale).toFixed(1)} Maschen je Bildpunkt — die Karte ist gröber als das Modell`}
      </p>
      <div id="tvProbe" class="hint" style="min-height:1.2em;"></div>
    `;
  }

  /**
   * Höhe und Differenz unter dem Zeiger.
   *
   * Eine Karte ohne Ablesemöglichkeit ist ein Bild. Der Wert kommt aus
   * demselben Höhenfeld, aus dem auch gezeichnet wurde — was man sieht, ist
   * damit dasselbe, was man liest.
   */
  function attachProbe(canvas) {
    canvas.onmousemove = (event) => {
      const probe = document.getElementById('tvProbe');
      if (!probe || !state.map) return;
      const box = canvas.getBoundingClientRect();
      const { W, H, field, delta, mask } = state.map;
      const px = Math.floor((event.clientX - box.left) / box.width * W);
      const py = Math.floor((event.clientY - box.top) / box.height * H);

      if (px < 0 || px >= W || py < 0 || py >= H) { probe.textContent = ''; return; }
      const i = py * W + px;
      if (mask[i] === 0 || Number.isNaN(field[i])) { probe.textContent = 'ohne Daten'; return; }
      const d = delta[i];
      probe.textContent = `Höhe ${field[i].toFixed(2)} m · `
        + `${d >= 0 ? 'Auftrag' : 'Abtrag'} ${Math.abs(d).toFixed(2)} m`;
    };
    canvas.onmouseleave = () => {
      const probe = document.getElementById('tvProbe');
      if (probe) probe.textContent = '';
    };
  }

  const SOURCE_TEXT = {
    splat: 'Splatpunkte aus dem Renderpuffer',
    pnts: 'Punkte aus den geladenen Kacheln',
    scan: 'Die Szene wurde abgetastet — es waren keine Punkte zu holen',
    none: 'keine Quelle',
  };

  const AGGREGATE_TEXT = {
    mittel: 'Maschenhöhe = Mittel der Punkte',
    hoch: 'Maschenhöhe = höchster Punkt',
    tief: 'Maschenhöhe = tiefster Punkt',
  };

  function resultHtml(r) {
    const coverage = r.polygonArea > 0 ? Math.round((r.coveredArea / r.polygonArea) * 100) : 0;
    const holes = r.holeArea > 0.005
      ? ` · ${format(r.holeArea)} m² ohne Daten` : '';
    const thinned = r.stride > 1
      ? ` · jeder ${r.stride}. Punkt` : '';
    const tilt = r.tilt > 1e-4
      ? ` · geneigt ${(Math.atan(r.tilt) * 180 / Math.PI).toFixed(1)}°` : '';

    return `
      <div class="row"><span class="row__label">Netto</span>
        <span class="row__value" style="font-weight:600;">${format(r.net)} m³</span></div>
      <div class="row"><span class="row__label">Auftrag (über Bezug)</span>
        <span class="row__value">${format(r.cut)} m³</span></div>
      <div class="row"><span class="row__label">Abtrag (unter Bezug)</span>
        <span class="row__value">${format(r.fill)} m³</span></div>
      <div class="row"><span class="row__label">Fläche</span>
        <span class="row__value">${format(r.polygonArea)} m²</span></div>
      <div class="row"><span class="row__label">Bezugshöhe</span>
        <span class="row__value">${r.referenceHeight.toFixed(2)} m${tilt}</span></div>
      <div class="row"><span class="row__label">Höhen</span>
        <span class="row__value">${r.minHeight.toFixed(2)} – ${r.maxHeight.toFixed(2)} m</span></div>
      <div class="row"><span class="row__label">Punkte</span>
        <span class="row__value">${r.points.toLocaleString('de-DE')}</span></div>
      <p class="hint">
        ${SOURCE_TEXT[r.source] || r.source}${r.tiles ? ` (${r.tiles} Kacheln)` : ''}${thinned} ·
        Masche ${trim(r.cell)} m${r.cellForced ? ` (aus ${trim(r.cellForced)} m vergröbert — sonst über ${(MAX_CELLS / 1e6).toFixed(1)} Mio Maschen)` : ''}
        aus ${r.cells.toLocaleString('de-DE')} belegten Feldern ·
        ${AGGREGATE_TEXT[r.aggregate]} ·
        ${coverage} % der Fläche belegt${holes}${r.interpolated ? ` · ${r.interpolated} Maschen aus der Nachbarschaft ergänzt` : ''}.
      </p>
      ${(r.notes || []).map((n) => `<p class="hint">${n}</p>`).join('')}
    `;
  }

  /** Ergebnis als Eintrag in die Sitzungsablage schreiben. */
  function logToSession() {
    if (!state.result) { status('Es liegt kein Ergebnis vor', 'warning'); return; }
    if (typeof ILEEN_SESSION === 'undefined' || !ILEEN_SESSION.recordMeasurement) {
      status('Sitzungsablage nicht geladen', 'warning');
      return;
    }
    const r = state.result;
    ILEEN_SESSION.recordMeasurement({
      type: 'topo_volume',
      label: `Aufmaß ${format(r.net)} m³ (${r.points.toLocaleString('de-DE')} Punkte, Masche ${trim(r.cell)} m)`,
      positions: state.positions.map((p) => {
        const carto = Cesium.Cartographic.fromCartesian(p);
        return {
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
          height: carto.height,
        };
      }),
      results: {
        net_m3: Number(r.net.toFixed(3)),
        above_reference_m3: Number(r.cut.toFixed(3)),
        below_reference_m3: Number(r.fill.toFixed(3)),
        area_m2: Number(r.polygonArea.toFixed(3)),
        covered_area_m2: Number(r.coveredArea.toFixed(3)),
        reference_height_m: Number(r.referenceHeight.toFixed(3)),
        cell_size_m: r.cell,
        points: r.points,
        source: r.source,
        min_height_m: Number(r.minHeight.toFixed(3)),
        max_height_m: Number(r.maxHeight.toFixed(3)),
      },
    });
    status('Aufmaß in der Sitzung abgelegt', 'success');
  }

  return {
    toggle, start, cancel, finish, redraw, rebin, recompute, setOverlay, setOpacity,
    downloadMap, logToSession, render,
    get state() { return state; },

    /** Nur für Prüfskripte: die Rechenteile ohne Szene. */
    _internals: {
      binPoints, fillGaps, coverageGrid, integrate, referencePlane, fitPlane, planeAt,
      autoCell, chooseCell, niceStep, isInside, areaOf, boundsOf, rampColor, quantize,
      bilinear, sample, catmullRom, mapScale, parsePnts, RAMPS,
      // Braucht eine Leinwand und läuft deshalb nur im Browser —
      // `tests/volume-topo/smoke.html` treibt es von dort aus an.
      renderMap, renderFigure, polygonMask,
      // Brauchen Cesium und ein geladenes Tileset, aber keine Szene —
      // `tests/volume-topo/echt.html` misst damit gegen echte Kacheln.
      buildContext, collectPoints, selectTiles, overlaps, harvestPnts,
      makeNode, childrenOf, hullOf,
    },
  };
})();

console.log('✅ Topografisches Aufmaß geladen (Punkte aufsummieren statt abtasten)');
