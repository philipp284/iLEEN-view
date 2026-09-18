/**
 * splat-pick.js — Treffsicheres Anklicken von Gaussian Splats.
 *
 * Warum es dieses Modul gibt
 * ==========================
 * Cesium rendert Gaussian Splats weder im Pick-Pass noch in den Tiefenpuffer:
 *
 *   GaussianSplatPrimitive.update():  if (frameState.passes.pick) return;
 *   buildGSplatDrawCommand():         renderStateOptions.depthMask = false;
 *
 * Damit liefert `scene.pick()` über einer Splatwolke *nie* etwas, und
 * `scene.pickPosition()` liest den Tiefenpuffer — also das Terrain *hinter*
 * der Wolke. Jedes Werkzeug, das sich auf eines von beidem verlässt, misst
 * und setzt Marken systematisch an der falschen Stelle.
 *
 * Wie hier gepickt wird
 * =====================
 * Nicht „welches Splatzentrum liegt dem Sichtstrahl am nächsten" — diese
 * Regel lässt einen einzelnen halbdurchsichtigen Streusplat vor der Fassade
 * jeden Klick abfangen. Stattdessen wird nachgerechnet, was der Renderer
 * ohnehin tut: die Splats entlang des Strahls von vorn nach hinten
 * überblenden und den Punkt nehmen, an dem die Deckkraft die Hälfte
 * überschreitet. Das ist genau die Fläche, die das Auge als Oberfläche sieht;
 * Nebel und Ausreißer tragen zu wenig bei, um sie zu gewinnen.
 *
 * Der Beitrag eines Splats stammt aus Cesiums Fragment-Shader
 *
 *     B = exp(-4 * r_norm^2) * alpha
 *
 * mit r_norm = Abstand / Quad-Halbachse und Halbachse = sqrt(2*lambda).
 * Umgerechnet auf den Mahalanobis-Abstand m der 3D-Gaußverteilung ist das
 *
 *     alpha_eff = alpha * exp(-2 * m^2),
 *
 * und der Sichtbarkeitsrand liegt bei r_norm = 2, also m ≈ 2.83 Sigma.
 *
 * Datengrundlage
 * ==============
 * `tileset.gaussianSplatPrimitive` hält einen aggregierten Schnappschuss
 * *aller gerade sichtbaren* Splats in flachen Puffern — genau die Splats, die
 * auch auf dem Schirm stehen, ohne Tile-Iteration:
 *
 *   _positions   Float32Array, 3/Splat, lokal zu _rootTransform
 *   _scales      Float32Array, 3/Splat, lineare Sigma in Metern
 *   _rotations   Float32Array, 4/Splat, Quaternion (x,y,z,w), normalisiert
 *   _colors      Uint8Array,   4/Splat, RGBA, A = Opazität
 *   _numSplats, _splatDataGeneration
 *
 * Das sind private Felder. Sie können mit jedem Cesium-Update wegbrechen,
 * deshalb prüft `available()` sie einzeln nach und alle Aufrufer haben einen
 * Rückfallweg. Geprüft gegen CesiumJS 1.139–1.141.
 */

(function () {
  'use strict';

  // Sichtbarkeitsrand eines Splats in Vielfachen von Sigma (siehe Kopf).
  const SIGMA_CUTOFF = 3.0;
  // Deckkraft, ab der ein Punkt als „Oberfläche" gilt.
  const COVERAGE_SURFACE = 0.5;
  // Ab hier ist dahinter nichts mehr zu holen — Strahlmarsch abbrechen.
  const COVERAGE_SATURATED = 0.995;
  // Unterhalb dieser Deckkraft gilt der Strahl als „durchgeflogen".
  const COVERAGE_MIN = 0.06;
  // Mindestbreite eines Splats in Bildschirmpixeln. Cesium addiert im Shader
  // 0.3 auf die Diagonale der Bildschirmkovarianz, damit hauchdünne, kantig
  // stehende Splats nicht auf Subpixelbreite zusammenfallen. Ohne dieselbe
  // Zugabe wären genau diese Splats hier unklickbar.
  const MIN_PIXEL_SIGMA = 0.6;
  // Zielbelegung einer Gitterzelle. Kleiner = mehr Zellen (Speicher, Aufbau),
  // größer = mehr lineare Tests je Zelle.
  const GRID_TARGET_PER_CELL = 64;
  const GRID_MAX_CELLS = 1 << 21;
  // Splats, die deutlich größer sind als eine Zelle, würden das Gitter
  // sprengen (sie müssten in dutzende Zellen eingetragen werden). Sie landen
  // stattdessen in einer eigenen Liste, die bei jedem Pick linear läuft.
  const OVERSIZE_CELL_FACTOR = 2.0;

  const scratch = {
    a: new Cesium.Cartesian3(), b: new Cesium.Cartesian3(),
    c: new Cesium.Cartesian3(), d: new Cesium.Cartesian3(),
    m4: new Cesium.Matrix4()
  };

  // ============================================================
  // SCHNAPPSCHUSS
  // ============================================================

  function splatPrimitiveOf(tileset) {
    return tileset && tileset.gaussianSplatPrimitive || null;
  }

  function isGaussianTileset(tileset) {
    if (!tileset) return false;
    if (tileset._isGaussianSplat) return true;          // von core.js aus extensionsUsed
    if (tileset.gaussianSplatPrimitive) return true;
    return false;
  }

  /**
   * Die aggregierten Puffer eines Tilesets, oder null wenn (noch) keine da
   * sind — dann hat der Aufrufer auf seinen alten Weg zurückzufallen.
   */
  function snapshotOf(tileset) {
    const prim = splatPrimitiveOf(tileset);
    if (!prim) return null;

    const n = prim._numSplats | 0;
    if (n <= 0) return null;

    const positions = prim._positions;
    const scales    = prim._scales;
    const rotations = prim._rotations;
    const colors    = prim._colors;

    if (!ArrayBuffer.isView(positions) || positions.length < n * 3) return null;
    if (!ArrayBuffer.isView(scales)    || scales.length    < n * 3) return null;

    return {
      prim: prim,
      count: n,
      positions: positions,
      scales: scales,
      // Ohne Rotationen wird isotrop gerechnet; ohne Farben zählt jeder Splat
      // als voll deckend. Beides ist schlechter, aber nicht falsch.
      rotations: (ArrayBuffer.isView(rotations) && rotations.length >= n * 4) ? rotations : null,
      colors:    (ArrayBuffer.isView(colors)    && colors.length    >= n * 4) ? colors    : null,
      root: prim._rootTransform || null,
      generation: prim._splatDataGeneration | 0
    };
  }

  function available() {
    if (typeof Cesium === 'undefined') return false;
    const assets = window.BimViewer && BimViewer.loadedAssets;
    if (!assets) return false;
    for (const [, data] of assets) {
      if (data && data.tileset && isGaussianTileset(data.tileset)) {
        return snapshotOf(data.tileset) !== null;
      }
    }
    return false;
  }

  // ============================================================
  // GITTER
  // ============================================================

  const gridCache = new WeakMap();   // tileset -> { generation, count, grid }

  /**
   * Uniformes Gitter über die lokalen Splatpositionen.
   *
   * Zweimal linear über alle Splats (zählen, einsortieren) — bei zwei
   * Millionen Splats sind das rund 80 ms. Der Aufbau passiert deshalb faul
   * beim ersten Pick einer Schnappschuss-Generation, nicht beim Rendern.
   */
  function buildGrid(snap) {
    const n = snap.count;
    const pos = snap.positions;
    const sc = snap.scales;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let maxRadius = 0;

    const radii = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

      const s = Math.max(sc[i * 3], sc[i * 3 + 1], sc[i * 3 + 2]);
      const r = s * SIGMA_CUTOFF;
      radii[i] = r;
      if (r > maxRadius) maxRadius = r;
    }
    if (!isFinite(minX)) return null;

    const spanX = Math.max(maxX - minX, 1e-3);
    const spanY = Math.max(maxY - minY, 1e-3);
    const spanZ = Math.max(maxZ - minZ, 1e-3);

    let cell = Math.cbrt((spanX * spanY * spanZ) * GRID_TARGET_PER_CELL / n);
    if (!isFinite(cell) || cell <= 0) cell = 1;

    let nx, ny, nz;
    for (;;) {
      nx = Math.max(1, Math.ceil(spanX / cell));
      ny = Math.max(1, Math.ceil(spanY / cell));
      nz = Math.max(1, Math.ceil(spanZ / cell));
      if (nx * ny * nz <= GRID_MAX_CELLS) break;
      cell *= 1.5;
    }

    const cellCount = nx * ny * nz;
    const oversizeLimit = cell * OVERSIZE_CELL_FACTOR;

    // Zählen. Übergroße Splats werden ausgeklammert und separat geführt.
    const counts = new Uint32Array(cellCount + 1);
    const oversize = [];
    const cellOf = new Int32Array(n);

    for (let i = 0; i < n; ++i) {
      if (radii[i] > oversizeLimit) { cellOf[i] = -1; oversize.push(i); continue; }
      const ix = Math.min(nx - 1, ((pos[i * 3]     - minX) / cell) | 0);
      const iy = Math.min(ny - 1, ((pos[i * 3 + 1] - minY) / cell) | 0);
      const iz = Math.min(nz - 1, ((pos[i * 3 + 2] - minZ) / cell) | 0);
      const c = (iz * ny + iy) * nx + ix;
      cellOf[i] = c;
      counts[c + 1]++;
    }

    for (let c = 0; c < cellCount; ++c) counts[c + 1] += counts[c];

    const items = new Uint32Array(counts[cellCount]);
    const cursor = counts.slice(0, cellCount);
    for (let i = 0; i < n; ++i) {
      const c = cellOf[i];
      if (c >= 0) items[cursor[c]++] = i;
    }

    return {
      minX: minX, minY: minY, minZ: minZ,
      nx: nx, ny: ny, nz: nz, cell: cell,
      starts: counts, items: items,
      radii: radii, maxRadius: maxRadius,
      oversize: Uint32Array.from(oversize),
      // Besuchsstempel, damit dieselbe Zelle im Strahlmarsch nicht mehrfach
      // abgearbeitet wird. Eine laufende Nummer spart das Zurücksetzen.
      stamp: new Uint32Array(cellCount),
      stampCounter: 0
    };
  }

  function gridFor(tileset, snap, allowBuild) {
    const cached = gridCache.get(tileset);
    if (cached && cached.generation === snap.generation && cached.count === snap.count) {
      return cached.grid;
    }
    // Aufrufer, die an jeder Mausbewegung hängen (Ziehen eines Messpunktes),
    // dürfen den Neuaufbau nicht auslösen — er kostet bei Millionen Splats
    // zu viel, um ihn in eine Zugbewegung zu legen. Sie bekommen erst nach
    // dem nächsten Klick wieder ein Ergebnis.
    if (allowBuild === false) return null;
    const grid = buildGrid(snap);
    if (grid) gridCache.set(tileset, { generation: snap.generation, count: snap.count, grid: grid });
    return grid;
  }

  // ============================================================
  // GEWICHT EINES SPLATS AM SICHTSTRAHL
  // ============================================================

  /**
   * Dreht einen Vektor mit der *inversen* Rotation eines Splats — bringt eine
   * Weltachse in das Eigensystem der Gaußverteilung, wo die Kovarianz
   * diagonal ist. (v' = q^-1 * v * q, mit normalisiertem q.)
   */
  function rotateInverse(qx, qy, qz, qw, vx, vy, vz, out) {
    // t = 2 * (-q_xyz) x v
    const tx = 2 * (-qy * vz + qz * vy);
    const ty = 2 * (-qz * vx + qx * vz);
    const tz = 2 * (-qx * vy + qy * vx);
    out[0] = vx + qw * tx + (-qy * tz + qz * ty);
    out[1] = vy + qw * ty + (-qz * tx + qx * tz);
    out[2] = vz + qw * tz + (-qx * ty + qy * tx);
  }

  const uLocal = new Float64Array(3);
  const vLocal = new Float64Array(3);

  /**
   * Effektive Deckkraft, die ein Splat am Sichtstrahl beisteuert.
   *
   * Die 3D-Kovarianz wird auf die Ebene senkrecht zum Strahl projiziert
   * (Sigma2 = [[a,b],[b,c]] mit a = u^T Sigma u usw.), daraus der
   * Mahalanobis-Abstand des Strahls zum Splatzentrum. Das ist dieselbe
   * Ellipse, die der Vertex-Shader auf den Schirm zeichnet — nur ohne die
   * perspektivische Verzerrung, die auf Splatgröße keine Rolle spielt.
   */
  function splatWeight(snap, i, ux, uy, uz, vx, vy, vz, px, py, minVar) {
    const sc = snap.scales;
    const sx = sc[i * 3], sy = sc[i * 3 + 1], sz = sc[i * 3 + 2];

    let a, b, c;
    if (snap.rotations) {
      const r = snap.rotations;
      const qx = r[i * 4], qy = r[i * 4 + 1], qz = r[i * 4 + 2], qw = r[i * 4 + 3];
      rotateInverse(qx, qy, qz, qw, ux, uy, uz, uLocal);
      rotateInverse(qx, qy, qz, qw, vx, vy, vz, vLocal);
      const xx = sx * sx, yy = sy * sy, zz = sz * sz;
      a = xx * uLocal[0] * uLocal[0] + yy * uLocal[1] * uLocal[1] + zz * uLocal[2] * uLocal[2];
      c = xx * vLocal[0] * vLocal[0] + yy * vLocal[1] * vLocal[1] + zz * vLocal[2] * vLocal[2];
      b = xx * uLocal[0] * vLocal[0] + yy * uLocal[1] * vLocal[1] + zz * uLocal[2] * vLocal[2];
    } else {
      const s = (sx + sy + sz) / 3;
      a = c = s * s;
      b = 0;
    }

    a += minVar;
    c += minVar;

    const det = a * c - b * b;
    if (det <= 1e-20) return 0;

    const m2 = (c * px * px - 2 * b * px * py + a * py * py) / det;
    if (m2 > SIGMA_CUTOFF * SIGMA_CUTOFF) return 0;

    const alpha = snap.colors ? snap.colors[i * 4 + 3] / 255 : 1;
    if (alpha <= 0) return 0;

    return alpha * Math.exp(-2 * m2);
  }

  // ============================================================
  // PICK GEGEN EIN TILESET
  // ============================================================

  /**
   * Sichtstrahl gegen die Splats eines Tilesets.
   * Liefert `{ position, splatCenter, index, distance, coverage, tested }`
   * in Weltkoordinaten, oder null.
   */
  function pickTileset(ray, tileset, viewer, opts) {
    opts = opts || {};
    const snap = snapshotOf(tileset);
    if (!snap) return null;
    const grid = gridFor(tileset, snap, (opts && opts.budget) !== 'low');
    if (!grid) return null;

    // Strahl in das lokale System des Schnappschusses. _rootTransform ist ein
    // ENU-Rahmen — Rotation und Verschiebung, keine Skalierung — Längen und
    // damit die Sigma in Metern bleiben also gültig.
    let ox, oy, oz, dx, dy, dz;
    if (snap.root) {
      const inv = Cesium.Matrix4.inverse(snap.root, scratch.m4);
      const o = Cesium.Matrix4.multiplyByPoint(inv, ray.origin, scratch.a);
      const end = Cesium.Cartesian3.add(ray.origin, ray.direction, scratch.b);
      const e = Cesium.Matrix4.multiplyByPoint(inv, end, scratch.c);
      ox = o.x; oy = o.y; oz = o.z;
      dx = e.x - ox; dy = e.y - oy; dz = e.z - oz;
    } else {
      ox = ray.origin.x; oy = ray.origin.y; oz = ray.origin.z;
      dx = ray.direction.x; dy = ray.direction.y; dz = ray.direction.z;
    }
    const dLen = Math.hypot(dx, dy, dz) || 1;
    dx /= dLen; dy /= dLen; dz /= dLen;

    // Zwei Achsen senkrecht zum Strahl.
    let ux, uy, uz;
    if (Math.abs(dx) < 0.9) { ux = 1; uy = 0; uz = 0; } else { ux = 0; uy = 1; uz = 0; }
    let t0 = ux * dx + uy * dy + uz * dz;
    ux -= t0 * dx; uy -= t0 * dy; uz -= t0 * dz;
    const uLen = Math.hypot(ux, uy, uz) || 1;
    ux /= uLen; uy /= uLen; uz /= uLen;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    // Weltmeter je Bildschirmpixel in Entfernung t: pixelSlope * t.
    const camera = viewer.camera;
    const fovy = (camera.frustum && camera.frustum.fovy) || (Math.PI / 3);
    const canvas = viewer.scene.canvas;
    const viewportH = canvas.clientHeight || canvas.height || 1;
    const pixelSlope = (2 * Math.tan(fovy * 0.5)) / viewportH;

    // Eintritts- und Austrittsstelle in der Gitterbox, um den Marsch
    // einzugrenzen. Der Rand wird um den größten Splatradius geweitet.
    const pad = grid.maxRadius + grid.cell;
    const boxMin = [grid.minX - pad, grid.minY - pad, grid.minZ - pad];
    const boxMax = [
      grid.minX + grid.nx * grid.cell + pad,
      grid.minY + grid.ny * grid.cell + pad,
      grid.minZ + grid.nz * grid.cell + pad
    ];
    const dir = [dx, dy, dz], org = [ox, oy, oz];
    let tEnter = 0, tExit = Infinity;
    for (let k = 0; k < 3; ++k) {
      if (Math.abs(dir[k]) < 1e-12) {
        if (org[k] < boxMin[k] || org[k] > boxMax[k]) return null;
        continue;
      }
      let ta = (boxMin[k] - org[k]) / dir[k];
      let tb = (boxMax[k] - org[k]) / dir[k];
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > tEnter) tEnter = ta;
      if (tb < tExit) tExit = tb;
      if (tEnter > tExit) return null;
    }
    if (tExit <= 0) return null;
    tEnter = Math.max(tEnter, 0);

    // ── Kandidaten einsammeln ────────────────────────────────────────────
    // Schrittweise am Strahl entlang; je Schritt die Zellen im Umkreis der
    // Suchweite. Der Besuchsstempel verhindert Doppelarbeit bei überlappenden
    // Umkreisen aufeinanderfolgender Schritte.
    const cellSize = grid.cell;
    const stampId = ++grid.stampCounter;
    const stamp = grid.stamp;
    const starts = grid.starts, items = grid.items, radii = grid.radii;
    const pos = snap.positions;

    const hitIdx = [], hitT = [], hitW = [];
    let coarseSum = 0;

    const collect = (i, tolVar) => {
      const ex = pos[i * 3] - ox, ey = pos[i * 3 + 1] - oy, ez = pos[i * 3 + 2] - oz;
      const t = ex * dx + ey * dy + ez * dz;
      if (t <= 0) return;
      const px = ex * ux + ey * uy + ez * uz;
      const py = ex * vx + ey * vy + ez * vz;
      const w = splatWeight(snap, i, ux, uy, uz, vx, vy, vz, px, py, tolVar);
      if (w <= 0.002) return;
      hitIdx.push(i); hitT.push(t); hitW.push(w);
      coarseSum += w;
    };

    const maxSteps = 4096;
    let steps = 0;
    for (let t = tEnter; t < tExit && steps < maxSteps; t += cellSize, ++steps) {
      const sigmaMin = MIN_PIXEL_SIGMA * pixelSlope * Math.max(t, 1e-3);
      const tolVar = sigmaMin * sigmaMin;
      const reach = grid.maxRadius + SIGMA_CUTOFF * sigmaMin + cellSize * 0.5;
      const rCells = Math.min(8, Math.max(1, Math.ceil(reach / cellSize)));

      const cx = ox + dx * t, cy = oy + dy * t, cz = oz + dz * t;
      const ix = ((cx - grid.minX) / cellSize) | 0;
      const iy = ((cy - grid.minY) / cellSize) | 0;
      const iz = ((cz - grid.minZ) / cellSize) | 0;

      for (let z = Math.max(0, iz - rCells); z <= Math.min(grid.nz - 1, iz + rCells); ++z) {
        for (let y = Math.max(0, iy - rCells); y <= Math.min(grid.ny - 1, iy + rCells); ++y) {
          const rowBase = (z * grid.ny + y) * grid.nx;
          for (let x = Math.max(0, ix - rCells); x <= Math.min(grid.nx - 1, ix + rCells); ++x) {
            const c = rowBase + x;
            if (stamp[c] === stampId) continue;
            stamp[c] = stampId;
            const from = starts[c], to = starts[c + 1];
            for (let k = from; k < to; ++k) collect(items[k], tolVar);
          }
        }
      }

      // Vor uns liegt nichts mehr, was das Bild noch ändern könnte.
      if (coarseSum >= 3) break;
    }

    // Die wenigen übergroßen Splats liegen in keiner Zelle.
    if (grid.oversize.length) {
      const sigmaMin = MIN_PIXEL_SIGMA * pixelSlope * Math.max(tEnter, 1e-3);
      const tolVar = sigmaMin * sigmaMin;
      for (let k = 0; k < grid.oversize.length; ++k) collect(grid.oversize[k], tolVar);
    }

    if (!hitIdx.length) return null;

    // ── Von vorn nach hinten überblenden ─────────────────────────────────
    const order = hitIdx.map((_, k) => k).sort((p, q) => hitT[p] - hitT[q]);

    let transmittance = 1;
    let surfaceT = 0, surfaceIdx = -1;
    let weightedT = 0, weightedSum = 0;

    for (let k = 0; k < order.length; ++k) {
      const j = order[k];
      const contribution = hitW[j] * transmittance;
      weightedT += hitT[j] * contribution;
      weightedSum += contribution;
      transmittance *= (1 - Math.min(hitW[j], 0.999));

      const coverage = 1 - transmittance;
      if (surfaceIdx < 0 && coverage >= COVERAGE_SURFACE) {
        surfaceT = hitT[j];
        surfaceIdx = hitIdx[j];
      }
      if (coverage >= COVERAGE_SATURATED) break;
    }

    const coverage = 1 - transmittance;
    if (coverage < COVERAGE_MIN) return null;

    // Reicht die Deckkraft nicht bis zur Hälfte (dünne Wolke, Rand des
    // Modells), gilt der deckkraftgewichtete Schwerpunkt als beste Auskunft.
    if (surfaceIdx < 0) {
      if (weightedSum <= 0) return null;
      surfaceT = weightedT / weightedSum;
      let best = 0;
      for (let k = 1; k < hitW.length; ++k) if (hitW[k] > hitW[best]) best = k;
      surfaceIdx = hitIdx[best];
    }

    // Zurück in Weltkoordinaten. Für Messungen zählt der Punkt *auf dem
    // Strahl* — das Splatzentrum liegt seitlich daneben und würde jede
    // Strecke um bis zu eine Splatbreite verfälschen.
    const localHit = new Cesium.Cartesian3(ox + dx * surfaceT, oy + dy * surfaceT, oz + dz * surfaceT);
    const localCenter = new Cesium.Cartesian3(
      pos[surfaceIdx * 3], pos[surfaceIdx * 3 + 1], pos[surfaceIdx * 3 + 2]
    );

    const position = snap.root
      ? Cesium.Matrix4.multiplyByPoint(snap.root, localHit, new Cesium.Cartesian3())
      : localHit;
    const splatCenter = snap.root
      ? Cesium.Matrix4.multiplyByPoint(snap.root, localCenter, new Cesium.Cartesian3())
      : localCenter;

    return {
      position: position,
      splatCenter: splatCenter,
      index: surfaceIdx,
      tileset: tileset,
      distance: Cesium.Cartesian3.distance(viewer.camera.positionWC, position),
      coverage: coverage,
      tested: hitIdx.length
    };
  }

  // ============================================================
  // PICK ÜBER ALLE GELADENEN SPLAT-ASSETS
  // ============================================================

  function pickRay(ray, viewer, opts) {
    opts = opts || {};
    const assets = window.BimViewer && BimViewer.loadedAssets;
    if (!assets || !ray) return null;

    const candidates = [];
    const preferred = opts.preferredAssetId;
    if (preferred != null) {
      const entry = assets.get(String(preferred));
      if (entry && entry.tileset) candidates.push([preferred, entry]);
    }
    for (const [id, data] of assets) {
      if (String(id) === String(preferred)) continue;
      if (!data || !data.tileset) continue;
      if (data.visible === false || data.tileset.show === false) continue;
      candidates.push([id, data]);
    }

    let best = null;
    for (const [id, data] of candidates) {
      if (!isGaussianTileset(data.tileset)) continue;
      const hit = pickTileset(ray, data.tileset, viewer, opts);
      if (!hit) continue;
      hit.assetId = id;
      // Weltmeter vergleichen — `t` gilt je Tileset in einem anderen lokalen
      // System und ist zwischen Assets nicht vergleichbar.
      if (!best || hit.distance < best.distance) best = hit;
    }
    return best;
  }

  function pickScreen(screenPos, opts) {
    if (!window.BimViewer || !BimViewer.viewer) return null;
    const viewer = BimViewer.viewer;
    const ray = viewer.camera.getPickRay(screenPos);
    if (!Cesium.defined(ray)) return null;
    return pickRay(ray, viewer, opts);
  }

  window.SplatPick = {
    available: available,
    isGaussianTileset: isGaussianTileset,
    snapshotOf: snapshotOf,
    pickRay: pickRay,
    pickScreen: pickScreen,
    pickTileset: pickTileset,
    COVERAGE_SURFACE: COVERAGE_SURFACE
  };

  console.log('[SplatPick] ready');
})();

/**
 * splat-pick.js, Teil 2 — Vorschau unter dem Mauszeiger.
 *
 * Ohne Rückmeldung vor dem Klick ist jedes Setzen einer Marke ein Blindflug:
 * man sieht erst hinterher, wo der Punkt gelandet ist, und weiß bei einem
 * Fehlgriff nicht, ob man danebengezielt hat oder ob das Picking versagt hat.
 * Der Punkt hier klebt live auf der Fläche, auf die geklickt würde.
 *
 * Die Drosselung ist kein Feinschliff, sondern nötig: nach jedem
 * Nachladeschritt der Kachelauswahl baut der Picker sein Gitter neu, und das
 * kostet bei Millionen Splats einige zehn Millisekunden. Solange die Kamera
 * fährt, wird deshalb nicht gepickt.
 */
(function () {
  'use strict';

  const State = {
    handler: null,
    points: null,
    marker: null,
    halo: null,
    lastPickTime: 0,
    lastX: -1, lastY: -1,
    opts: null,
    lastHit: null
  };

  const MIN_INTERVAL_MS = 45;
  const MIN_MOVE_PX = 2;

  function ensureOverlay(viewer) {
    if (State.points && !State.points.isDestroyed()) return;
    State.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    // Der Hof zeichnet die ungefähre Ausdehnung der getroffenen Fläche, der
    // Kern die Stelle selbst. Beide ohne Tiefentest, sonst verschluckt die
    // Splatwolke — die ja keine Tiefe schreibt — den Marker je nach Blickwinkel.
    State.halo = State.points.add({
      position: Cesium.Cartesian3.ZERO,
      pixelSize: 22,
      color: Cesium.Color.fromCssColorString('#7CFC00').withAlpha(0.18),
      outlineColor: Cesium.Color.fromCssColorString('#7CFC00').withAlpha(0.55),
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: false
    });
    State.marker = State.points.add({
      position: Cesium.Cartesian3.ZERO,
      pixelSize: 7,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString('#7CFC00'),
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: false
    });
  }

  function hide() {
    if (State.marker) State.marker.show = false;
    if (State.halo) State.halo.show = false;
    State.lastHit = null;
  }

  function show(hit) {
    if (!State.marker) return;
    State.marker.position = hit.position;
    State.halo.position = hit.position;

    // Grün, solange die Fläche unter dem Zeiger wirklich deckt; bei dünner
    // Belegung gelb — dann ist der Punkt eine Schätzung, keine Oberfläche.
    const solid = (hit.coverage ?? 1) >= window.SplatPick.COVERAGE_SURFACE;
    const tone = solid ? '#7CFC00' : '#FFC83D';
    State.marker.outlineColor = Cesium.Color.fromCssColorString(tone);
    State.halo.color = Cesium.Color.fromCssColorString(tone).withAlpha(0.18);
    State.halo.outlineColor = Cesium.Color.fromCssColorString(tone).withAlpha(0.55);

    State.marker.show = true;
    State.halo.show = true;
    State.lastHit = hit;
  }

  function cameraIsMoving(viewer) {
    const c = viewer.camera;
    if (!State._prevView) {
      State._prevView = Cesium.Matrix4.clone(c.viewMatrix, new Cesium.Matrix4());
      return true;
    }
    const moving = !Cesium.Matrix4.equalsEpsilon(c.viewMatrix, State._prevView, 1e-9);
    Cesium.Matrix4.clone(c.viewMatrix, State._prevView);
    return moving;
  }

  function enable(opts) {
    if (!window.BimViewer || !BimViewer.viewer) return false;
    opts = opts || {};
    State.opts = opts;
    const viewer = BimViewer.viewer;
    ensureOverlay(viewer);
    if (State.handler) return true;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement) => {
      const p = movement.endPosition;
      if (!p) return;

      if (Math.abs(p.x - State.lastX) < MIN_MOVE_PX &&
          Math.abs(p.y - State.lastY) < MIN_MOVE_PX) return;
      State.lastX = p.x; State.lastY = p.y;

      const now = performance.now();
      if (now - State.lastPickTime < MIN_INTERVAL_MS) return;
      State.lastPickTime = now;

      if (cameraIsMoving(viewer)) { hide(); return; }

      const pickFn = State.opts.pickFn;
      const hit = pickFn
        ? pickFn(p)
        : window.SplatPick.pickScreen(p, { preferredAssetId: State.opts.preferredAssetId });

      if (hit && hit.position) show(hit); else hide();
      if (State.opts.onHover) State.opts.onHover(hit || null, p);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    State.handler = handler;
    return true;
  }

  function disable() {
    if (State.handler) { State.handler.destroy(); State.handler = null; }
    hide();
    State.lastX = -1; State.lastY = -1;
    State._prevView = null;
    State.opts = null;
  }

  function destroy() {
    disable();
    if (State.points && !State.points.isDestroyed() && window.BimViewer && BimViewer.viewer) {
      BimViewer.viewer.scene.primitives.remove(State.points);
    }
    State.points = null; State.marker = null; State.halo = null;
  }

  window.SplatPick.hover = {
    enable: enable,
    disable: disable,
    destroy: destroy,
    // Der zuletzt angezeigte Treffer — der Klick kann ihn übernehmen, statt
    // ein zweites Mal zu picken. Das garantiert, dass gesetzt wird, was zu
    // sehen war.
    last: () => State.lastHit
  };
})();
