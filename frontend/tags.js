/**
 * iLEEN — Unified Tags Module v1.0
 * © 2026 Tragwerkslabor / BIM-Labor HSM.
 *
 * Vereinheitlichtes Tagging-System für IFC-Features, B3DM-Meshes,
 * Gaussian-Splats und freie Punkte. Ersetzt gaussian-tags.js und den
 * Marker-Anteil aus comments.js.
 *
 * Persistenz: Notizen im localStorage, Anhänge in IndexedDB.
 */
'use strict';

(function () {

  console.log('Loading Tags module v1.0 (skeleton)...');

  // ============================================================
  // CONSTANTS
  // ============================================================

  const LOCAL_STORAGE_KEY    = 'mib_tags_v1';
  const RETRY_QUEUE_KEY      = 'mib_tags_retry_v1';

  const TAG_TYPES   = ['note', 'issue', 'inspection', 'measurement-anchor', 'custom'];
  const TAG_STATUS  = ['open', 'in_progress', 'closed'];
  const TAG_PRIO    = ['low', 'normal', 'high'];
  const TARGET_KIND = ['ifc', 'b3dm', 'splat', 'free'];

  // BCF Topic Type (buildingSMART) — surfaced separately from internal `type`
  const TOPIC_TYPES = ['Issue', 'Info', 'Error', 'Request', 'Warning'];

  // Inspection sub-schema (bridge / structure inspection per DIN 1076 style)
  const INSPECTION_CONDITIONS = [
    { value: '1', label: '1 — Good' },
    { value: '2', label: '2 — Fair' },
    { value: '3', label: '3 — Poor' },
    { value: '4', label: '4 — Critical' }
  ];
  const INSPECTION_COMPONENTS = [
    'superstructure', 'substructure', 'bearings', 'joints', 'drainage', 'equipment'
  ];
  const INSPECTION_DAMAGES = [
    'crack', 'spalling', 'corrosion', 'deformation', 'leakage', 'other'
  ];

  // ============================================================
  // UTILITIES
  // ============================================================

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function nowISO() { return new Date().toISOString(); }

  function currentAuthor() {
    try { return localStorage.getItem('ileen_autor') || 'Anonymous'; }
    catch { return 'Anonymous'; }
  }

  // ============================================================
  // ATTACHMENTS — IndexedDB blob storage (photos + PDFs)
  // localStorage is ~5 MB total → far too small for PDFs.
  // Tag.payload.attachments holds metadata only; the blob lives in IDB.
  // ============================================================

  const IDB_NAME    = 'ileen_tag_attachments';
  const IDB_STORE   = 'files';
  const IDB_VERSION = 1;

  let _idbPromise = null;
  function openIdb() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return _idbPromise;
  }

  const Attachments = {
    async put(file) {
      const db = await openIdb();
      const id = uuid();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(file, id);
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
      });
      return id;
    },
    async get(id) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => reject(req.error);
      });
    },
    async url(id) {
      const blob = await this.get(id);
      return blob ? URL.createObjectURL(blob) : null;
    },
    async remove(id) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = resolve;
        tx.onerror    = () => reject(tx.error);
      });
    }
  };

  // ============================================================
  // FACTORY — build a Tag from picking result + payload
  // ============================================================

  function makeTag({ position, target, type, payload }) {
    if (!position || !target) throw new Error('Tag.make: position+target required');
    if (!TAG_TYPES.includes(type)) type = 'note';
    if (!TARGET_KIND.includes(target.kind)) throw new Error('Tag.make: invalid target.kind ' + target.kind);

    const ts = nowISO();
    return {
      id: uuid(),
      type,
      position: {
        worldCart: position.worldCart || null,
        lon:       position.lon ?? null,
        lat:       position.lat ?? null,
        height:    position.height ?? null
      },
      target: {
        kind:         target.kind,
        assetId:      target.assetId ?? null,
        ifcGuid:      target.ifcGuid ?? null,
        splatIdx:     target.splatIdx ?? null,
        featureProps: target.featureProps ?? null
      },
      payload: {
        title:       payload?.title       || '',
        body:        payload?.body        || '',
        photos:      payload?.photos      || [],
        attachments: payload?.attachments || [],   // [{id, name, type, size, addedAt}]
        status:     TAG_STATUS.includes(payload?.status)   ? payload.status   : 'open',
        priority:   TAG_PRIO.includes(payload?.priority)   ? payload.priority : 'normal',
        dueDate:    payload?.dueDate    || null,
        topicType:  TOPIC_TYPES.includes(payload?.topicType) ? payload.topicType : 'Issue',
        assignedTo: payload?.assignedTo || '',
        inspection: payload?.inspection?.enabled
          ? {
              enabled:   true,
              condition: payload.inspection.condition || '1',
              component: payload.inspection.component || 'superstructure',
              damage:    payload.inspection.damage    || 'crack'
            }
          : { enabled: false, condition: null, component: null, damage: null }
      },
      createdAt: ts,
      updatedAt: ts,
      author:    currentAuthor()
    };
  }

  // ============================================================
  // STORE — LocalStorage adapter
  // ============================================================

  const LocalStore = {
    load() {
      try {
        const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    },
    save(tags) {
      try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(tags));
        return true;
      } catch (e) {
        console.warn('[Tags] LocalStore save failed', e);
        return false;
      }
    },
    upsert(tag) {
      const all = this.load();
      const i = all.findIndex(t => t.id === tag.id);
      if (i >= 0) all[i] = tag; else all.push(tag);
      return this.save(all);
    },
    remove(id) {
      const all = this.load().filter(t => t.id !== id);
      return this.save(all);
    },
    clear() { localStorage.removeItem(LOCAL_STORAGE_KEY); }
  };

  // ============================================================
  // STORE — Retry queue (Altbestand aus früheren Versionen, bleibt leer)
  // ============================================================

  const RetryQueue = {
    load() {
      try {
        const raw = localStorage.getItem(RETRY_QUEUE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    },
    save(items) {
      try { localStorage.setItem(RETRY_QUEUE_KEY, JSON.stringify(items)); }
      catch (e) { console.warn('[Tags] RetryQueue save failed', e); }
    },
    enqueue(op) {
      const q = this.load();
      q.push({ ...op, queuedAt: nowISO() });
      this.save(q);
    },
    clear() { localStorage.removeItem(RETRY_QUEUE_KEY); }
  };

  // ============================================================
  // STORE — lokal
  // ============================================================

  // Notizen liegen ausschließlich im localStorage; bcf-export.js liest window.Tags.items.
  const DualStore = {
    async load() {
      return LocalStore.load();
    },
    async upsert(tag) {
      LocalStore.upsert(tag);
      return tag;
    },
    async remove(id) {
      LocalStore.remove(id);
    },

    async flushRetryQueue() { return { flushed: 0, remaining: 0 }; }
  };

  // ============================================================
  // PICKING LAYER — generic resolver for screen-pos → {position, target}
  // ============================================================

  // Common IFC GlobalId property names across IFC→glTF/B3DM converters
  const IFC_GUID_KEYS = ['GlobalId', 'globalId', 'GLOBALID', 'IfcGUID', 'IFC_GUID', 'GUID', 'Guid', 'guid'];

  function extractIfcGuid(feature) {
    if (!feature || !feature.getPropertyIds) return null;
    let ids;
    try { ids = feature.getPropertyIds(); } catch { return null; }
    if (!ids) return null;
    for (const key of IFC_GUID_KEYS) {
      if (ids.includes(key)) {
        try { const v = feature.getProperty(key); if (v) return String(v); } catch {}
      }
    }
    return null;
  }

  function extractFeatureProps(feature) {
    if (!feature || !feature.getPropertyIds) return null;
    let ids;
    try { ids = feature.getPropertyIds(); } catch { return null; }
    if (!ids || !ids.length) return null;
    const props = {};
    for (const id of ids) {
      try { props[id] = feature.getProperty(id); } catch {}
    }
    return props;
  }

  // Walk loadedAssets to find which assetId owns a given tileset/primitive
  function findAssetIdForTileset(tileset) {
    if (!tileset || !window.BimViewer || !BimViewer.loadedAssets) return null;
    for (const [id, data] of BimViewer.loadedAssets) {
      if (data && data.tileset === tileset) return id;
    }
    return null;
  }

  function isGaussianTileset(tileset) {
    if (!tileset) return false;
    // Von core.js aus `extensionsUsed` der tileset.json gesetzt — das
    // verlässlichste Signal, weil es schon vor dem ersten geladenen Tile steht.
    if (tileset._isGaussianSplat) return true;
    // Cesium legt das Primitive im Konstruktor des ersten Splat-Contents an.
    if (tileset.gaussianSplatPrimitive) return true;
    const probe = (tile) => {
      const c = tile && tile.content;
      if (!c) return false;
      const name = c.constructor && c.constructor.name;
      if (name && name.toLowerCase().includes('splat')) return true;
      return ArrayBuffer.isView(c.positions);
    };
    if (probe(tileset.root)) return true;
    if (tileset.root && tileset.root.children) {
      for (const c of tileset.root.children) if (probe(c)) return true;
    }
    return false;
  }

  function isSplatPick(picked) {
    if (!picked || !picked.primitive) return false;
    const ctor = picked.primitive.constructor && picked.primitive.constructor.name;
    if (ctor && ctor.toLowerCase().includes('splat')) return true;
    const content = picked.primitive._content;
    if (content && content.constructor && content.constructor.name &&
        content.constructor.name.toLowerCase().includes('splat')) return true;
    return false;
  }

  /**
   * Splat-Tiles eines Tilesets, die für einen Raytest taugen.
   *
   * `content._transformed` ist die entscheidende Bedingung: Cesium überschreibt
   * `content.positions` in `GaussianSplatPrimitive.transformTile()` in-place mit
   * den Koordinaten im lokalen System von `_rootTransform`. Vorher stehen dort
   * noch die glTF-lokalen Koordinaten des Tiles — die liegen ganz woanders und
   * erzeugen entweder Fehltreffer oder gar keine.
   */
  function collectSplatTiles(tileset) {
    const usable = (t) =>
      t && t.content && ArrayBuffer.isView(t.content.positions) &&
      t.content.positions.length > 0 && t.content._transformed === true;

    const selected = tileset._selectedTiles;
    if (selected && selected.length) {
      const hits = Array.from(selected).filter(usable);
      if (hits.length) return hits;
    }

    const out = [];
    const stack = [tileset.root];
    while (stack.length) {
      const t = stack.pop();
      if (!t) continue;
      if (usable(t)) out.push(t);
      if (t.children) for (const c of t.children) stack.push(c);
    }
    return out;
  }

  function isNearOrigin(pos) {
    return Cesium.Cartesian3.magnitude(pos) < 1000;
  }

  /**
   * Raycast gegen die einzelnen Gaußverteilungen eines Splat-Tilesets.
   * Liefert `{position, index, tile, t, perpDistance}` oder null.
   *
   * Die Trefferzone ist ein **Kegel um den Sichtstrahl**, kein Zylinder: die
   * Weltbreite von 12 Bildschirmpixeln wächst linear mit der Entfernung, und
   * genau das ist die Toleranz, die ein Nutzer erwartet — was auf dem Schirm
   * unter dem Cursor liegt, soll getroffen werden, egal ob es 5 m oder 200 m
   * entfernt ist. Die frühere Fassung berechnete die Toleranz einmalig aus der
   * Distanz zum Tileset-*Zentrum*; bei einem 100-m-Gebäude war sie damit für
   * die nahe Fassade um ein Vielfaches zu groß (es gewann ein zufälliger Splat
   * weit vor dem Cursor) und für die ferne Seite zu klein.
   */
  function pickSplat(ray, tileset, viewer) {
    const tiles = collectSplatTiles(tileset);
    if (!tiles.length) return null;

    const splatPrim = tileset.gaussianSplatPrimitive;
    const root = splatPrim && splatPrim._rootTransform;

    let rayOrigin, rayDir;
    if (root) {
      const inv = Cesium.Matrix4.inverse(root, new Cesium.Matrix4());
      rayOrigin = Cesium.Matrix4.multiplyByPoint(inv, ray.origin, new Cesium.Cartesian3());
      const end = Cesium.Cartesian3.add(ray.origin, ray.direction, new Cesium.Cartesian3());
      const localEnd = Cesium.Matrix4.multiplyByPoint(inv, end, new Cesium.Cartesian3());
      rayDir = Cesium.Cartesian3.subtract(localEnd, rayOrigin, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(rayDir, rayDir);
    } else {
      rayOrigin = Cesium.Cartesian3.clone(ray.origin);
      rayDir    = Cesium.Cartesian3.clone(ray.direction);
    }

    const camera = viewer.camera;
    const fov = camera.frustum.fovy || (Math.PI / 3);
    const viewportH = viewer.scene.canvas.clientHeight || viewer.scene.canvas.height || 1;
    // Weltmeter je Bildschirmpixel in Entfernung t = PIXEL_TOLERANCE * slope * t
    const slope = (2 * Math.tan(fov * 0.5)) / viewportH;
    const PIXEL_TOLERANCE = 12;
    const tolSlope = PIXEL_TOLERANCE * slope;

    let bestT = Infinity, bestPerp = Infinity, bestIndex = -1, bestTile = null;
    const splatPos = new Cesium.Cartesian3();
    const toSplat = new Cesium.Cartesian3();
    const closestOnRay = new Cesium.Cartesian3();
    const perpVec = new Cesium.Cartesian3();

    for (const tile of tiles) {
      // Grobfilter je Tile: Millionen Splats einzeln zu prüfen kostet spürbar,
      // die Tile-Hülle schließt die meisten in einem Test aus. Sie liegt in
      // Weltkoordinaten, deshalb gegen den unverwandelten Strahl testen.
      if (tile.boundingSphere &&
          !Cesium.defined(Cesium.IntersectionTests.raySphere(ray, tile.boundingSphere))) {
        continue;
      }

      const positions = tile.content.positions;
      const scales = ArrayBuffer.isView(tile.content.scales) ? tile.content.scales : null;
      const splatCount = (positions.length / 3) | 0;

      for (let i = 0; i < splatCount; ++i) {
        splatPos.x = positions[i * 3];
        splatPos.y = positions[i * 3 + 1];
        splatPos.z = positions[i * 3 + 2];
        Cesium.Cartesian3.subtract(splatPos, rayOrigin, toSplat);
        const t = Cesium.Cartesian3.dot(toSplat, rayDir);
        if (t <= 0 || t >= bestT) continue;  // hinter der Kamera oder schon überboten

        Cesium.Cartesian3.multiplyByScalar(rayDir, t, closestOnRay);
        Cesium.Cartesian3.add(rayOrigin, closestOnRay, closestOnRay);
        Cesium.Cartesian3.subtract(splatPos, closestOnRay, perpVec);
        const perpSq = Cesium.Cartesian3.magnitudeSquared(perpVec);

        // Ein Splat ist eine Fläche, kein Punkt: seine eigene Ausdehnung zählt
        // mit, sonst wird ein großer Splat aus der Nähe unklickbar.
        let tol = tolSlope * t;
        if (scales) {
          const radius = (scales[i * 3] + scales[i * 3 + 1] + scales[i * 3 + 2]) / 3;
          if (radius > tol) tol = radius;
        }

        if (perpSq < tol * tol) {
          bestT = t; bestPerp = Math.sqrt(perpSq); bestIndex = i; bestTile = tile;
        }
      }
    }

    if (bestIndex < 0) return null;
    const positions = bestTile.content.positions;
    const center = new Cesium.Cartesian3(
      positions[bestIndex * 3],
      positions[bestIndex * 3 + 1],
      positions[bestIndex * 3 + 2]
    );
    const worldCenter = root
      ? Cesium.Matrix4.multiplyByPoint(root, center, new Cesium.Cartesian3())
      : center;
    return { position: worldCenter, index: bestIndex, tile: bestTile, t: bestT, perpDistance: bestPerp };
  }

  /**
   * Bester Splat-Treffer über *alle* geladenen Gaussian-Tilesets.
   *
   * Der Grund für diese Funktion: `Tags.activeAssetId` ist nur gesetzt, wenn
   * der Tag-Modus aus einer Assetzeile heraus gestartet wurde. Über die Taste
   * `C` (der übliche Weg) ist er null — und ohne bevorzugtes Asset fiel das
   * Picking früher direkt auf `scene.pickPosition()` durch und markierte den
   * Boden hinter dem Modell. Deshalb wird ohne Vorgabe schlicht jedes
   * Splat-Tileset geprüft und das der Kamera nächste Ergebnis genommen.
   */
  function pickSplatAcrossAssets(ray, viewer, preferredAssetId) {
    const assets = window.BimViewer && BimViewer.loadedAssets;
    if (!assets) return null;

    const candidates = [];
    if (preferredAssetId != null) {
      const preferred = assets.get(String(preferredAssetId));
      if (preferred && preferred.tileset) candidates.push([preferredAssetId, preferred]);
    } else {
      for (const [id, data] of assets) {
        if (data && data.tileset && data.visible !== false) candidates.push([id, data]);
      }
    }

    let best = null;
    for (const [id, data] of candidates) {
      if (!isGaussianTileset(data.tileset)) continue;
      const hit = pickSplat(ray, data.tileset, viewer);
      if (!hit) continue;
      // Distanz in Weltmetern vergleichen — `hit.t` gilt im lokalen System des
      // jeweiligen Tilesets und ist zwischen Assets nicht vergleichbar.
      const distance = Cesium.Cartesian3.distance(viewer.camera.positionWC, hit.position);
      if (!best || distance < best.distance) best = { hit, assetId: id, distance };
    }
    return best;
  }

  /**
   * Splat-Treffer über alle Assets.
   *
   * Erste Wahl ist `SplatPick` (splat-pick.js): es rechnet auf dem
   * aggregierten Schnappschuss des Primitives und blendet die Splats entlang
   * des Strahls von vorn nach hinten über, statt das nächstgelegene Zentrum
   * zu nehmen. Damit fängt kein einzelner Streusplat mehr den Klick ab.
   *
   * Der alte Kegeltest bleibt als Rückfall stehen: `SplatPick` greift auf
   * private Cesium-Felder zu, die mit einem Update verschwinden können.
   */
  function resolveSplatHit(ray, viewer, preferredAssetId) {
    if (window.SplatPick && typeof SplatPick.pickRay === 'function') {
      try {
        const hit = SplatPick.pickRay(ray, viewer, { preferredAssetId: preferredAssetId });
        if (hit) {
          return {
            hit: { position: hit.position, index: hit.index },
            assetId: hit.assetId,
            distance: hit.distance,
            coverage: hit.coverage
          };
        }
        // Kein Treffer heißt hier wirklich „der Strahl geht durch": SplatPick
        // prüft dieselben Splats, die gerendert werden. Der alte Weg würde
        // nur einen Zufallstreffer nachliefern.
        if (SplatPick.available()) return null;
      } catch (e) {
        console.warn('[Tags] SplatPick fehlgeschlagen, nutze Kegeltest:', e);
      }
    }
    return pickSplatAcrossAssets(ray, viewer, preferredAssetId);
  }

  function cartToGeo(cart) {
    if (!cart) return { worldCart: null, lon: null, lat: null, height: null };
    const c = Cesium.Cartographic.fromCartesian(cart);
    return {
      worldCart: { x: cart.x, y: cart.y, z: cart.z },
      lon: Cesium.Math.toDegrees(c.longitude),
      lat: Cesium.Math.toDegrees(c.latitude),
      height: c.height
    };
  }

  /**
   * Generic pick — auto-detect target kind, resolve position with appropriate
   * fallbacks. Returns { position, target } or null.
   *
   * Optional opts.preferredAssetId: bias splat-picking toward this asset
   * even if scene.pick missed (Gaussians often miss scene.pick entirely).
   */
  function pickAtScreen(screenPos, opts = {}) {
    if (!window.BimViewer || !BimViewer.viewer) return null;
    const viewer = BimViewer.viewer;
    const scene  = viewer.scene;
    const ray    = viewer.camera.getPickRay(screenPos);
    if (!Cesium.defined(ray)) return null;

    const picked = scene.pick(screenPos);

    // ── 1. IFC / B3DM: ein echtes Feature ist immer die genaueste Auskunft ──
    if (picked && picked instanceof Cesium.Cesium3DTileFeature) {
      const standard = scene.pickPosition(screenPos);
      if (Cesium.defined(standard) && !isNearOrigin(standard)) {
        const ifcGuid = extractIfcGuid(picked);
        const tileset = picked.tileset || picked.primitive;
        return {
          position: cartToGeo(standard),
          target: {
            kind: ifcGuid ? 'ifc' : 'b3dm',
            assetId: findAssetIdForTileset(tileset),
            ifcGuid: ifcGuid,
            splatIdx: null,
            featureProps: extractFeatureProps(picked)
          }
        };
      }
    }

    // ── 2. Splats ───────────────────────────────────────────────────────────
    // Gaussian Splats schreiben keine pickbare Geometrie: `scene.pick()` liefert
    // hier fast immer nichts, `scene.pickPosition()` dagegen den *Boden hinter*
    // dem Modell. Deshalb wird der eigene Raycast unbedingt versucht — auch
    // ohne bevorzugtes Asset (Tag-Modus per Taste `C`) — und *bevor* auf die
    // Weltoberfläche zurückgefallen wird. Genau diese Reihenfolge fehlte:
    // vorher gewann das Terrain und markierte irgendeine Stelle der Welt.
    const splatHit = resolveSplatHit(ray, viewer, opts.preferredAssetId);

    // ── 3. Oberfläche (Terrain, 3D Tiles, B3DM ohne Feature) ────────────────
    const surface = scene.pickPosition(screenPos);
    const surfaceValid = Cesium.defined(surface) && !isNearOrigin(surface);

    // Liegt der Splat vor der getroffenen Oberfläche, hat der Nutzer das Modell
    // gemeint und nicht den Boden dahinter. Die 1-m-Zugabe deckt den Fall ab,
    // dass die Oberfläche selbst durch das Splat-Modell hindurch gemessen wurde.
    if (splatHit) {
      const surfaceDistance = surfaceValid
        ? Cesium.Cartesian3.distance(viewer.camera.positionWC, surface)
        : Infinity;
      if (splatHit.distance <= surfaceDistance + 1.0) {
        return {
          position: cartToGeo(splatHit.hit.position),
          coverage: splatHit.coverage,
          target: {
            kind: 'splat',
            assetId: splatHit.assetId,
            ifcGuid: null,
            splatIdx: splatHit.hit.index,
            featureProps: null
          }
        };
      }
    }

    if (surfaceValid) {
      const tileset = picked && (picked.tileset || picked.primitive?._tileset || picked.primitive);
      const assetId = tileset ? findAssetIdForTileset(tileset) : null;
      return {
        position: cartToGeo(surface),
        target: {
          kind: assetId ? 'b3dm' : 'free',
          assetId: assetId,
          ifcGuid: null,
          splatIdx: null,
          featureProps: null
        }
      };
    }

    // ── 4. Hüllkugel des Splat-Assets ───────────────────────────────────────
    // Greift, wenn die Splats des angeklickten Bereichs noch nicht geladen sind
    // (LOD im Nachladen) und auch kein Terrain darunter liegt.
    const preferredId = opts.preferredAssetId;
    if (preferredId) {
      const ts = BimViewer.loadedAssets?.get(String(preferredId))?.tileset;
      if (ts && ts.boundingSphere) {
        const hit = Cesium.IntersectionTests.raySphere(ray, ts.boundingSphere);
        if (Cesium.defined(hit)) {
          const t = hit.start >= 0 ? hit.start : hit.stop;
          const pos = Cesium.Ray.getPoint(ray, t);
          return {
            position: cartToGeo(pos),
            target: { kind: 'splat', assetId: preferredId, ifcGuid: null, splatIdx: null, featureProps: null }
          };
        }
      }
    }

    // ── 5. Globus / Terrain als letzte Instanz ──────────────────────────────
    const globePos = scene.globe.pick(ray, scene);
    if (Cesium.defined(globePos)) {
      return {
        position: cartToGeo(globePos),
        target: { kind: 'free', assetId: null, ifcGuid: null, splatIdx: null, featureProps: null }
      };
    }

    return null;
  }

  // ============================================================
  // TAG-MODE + INPUT HANDLING
  // ============================================================

  const ModeState = {
    handler: null,            // Cesium.ScreenSpaceEventHandler
    keyHandler: null,         // window keydown listener
    indicatorEl: null,
    cursorPrev: ''
  };

  function showModeIndicator() {
    if (ModeState.indicatorEl) return;
    const el = document.createElement('div');
    el.id = 'tagsModeIndicator';
    el.textContent = '🏷️  Tag-Mode  ·  Punkt folgt dem Zeiger  ·  RECHTSKLICK setzt  ·  C / ESC beendet';
    Object.assign(el.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      padding: '6px 14px', borderRadius: '4px',
      background: '#000', color: '#7CFC00',
      border: '1px solid #7CFC00', fontFamily: 'monospace', fontSize: '12px',
      zIndex: 99999, pointerEvents: 'none',
      boxShadow: '0 0 12px rgba(124,252,0,.4)'
    });
    document.body.appendChild(el);
    ModeState.indicatorEl = el;
  }

  function hideModeIndicator() {
    if (ModeState.indicatorEl) {
      ModeState.indicatorEl.remove();
      ModeState.indicatorEl = null;
    }
  }

  function setCursor(value) {
    const c = document.getElementById('cesiumContainer');
    if (!c) return;
    if (value && !ModeState.cursorPrev) ModeState.cursorPrev = c.style.cursor || '';
    c.style.cursor = value;
    if (!value) ModeState.cursorPrev = '';
  }

  function attachInput() {
    if (!window.BimViewer || !BimViewer.viewer) {
      console.warn('[Tags] BimViewer.viewer not ready, cannot attach input');
      return;
    }
    const viewer = BimViewer.viewer;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((evt) => {
      if (!Tags.active) return;
      const screenPos = evt.position;
      const result = Tags.pick(screenPos, { preferredAssetId: Tags.activeAssetId });
      if (!result) {
        if (BimViewer.updateStatus) {
          BimViewer.updateStatus('Tag: could not resolve position', 'error');
        }
        return;
      }
      Tags.openDialog(result, screenPos);
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    ModeState.handler = handler;
    attachHover();
  }

  /**
   * Vorschaupunkt unter dem Mauszeiger, solange der Tag-Modus läuft.
   *
   * Bewusst über `Tags.pick` und nicht direkt über `SplatPick`: die Vorschau
   * soll dieselbe Entscheidung treffen wie der Klick — auch dann, wenn unter
   * dem Zeiger gerade ein IFC-Bauteil oder das Terrain liegt. Sonst zeigt sie
   * eine Stelle, an der die Marke gar nicht landen würde.
   */
  function attachHover() {
    if (!window.SplatPick || !SplatPick.hover) return;
    SplatPick.hover.enable({
      pickFn: (screenPos) => {
        const r = Tags.pick(screenPos, { preferredAssetId: Tags.activeAssetId });
        const wc = r && r.position && r.position.worldCart;
        if (!wc) return null;
        const kind = r.target && r.target.kind;
        return {
          position: new Cesium.Cartesian3(wc.x, wc.y, wc.z),
          // Ein Treffer auf dem freien Globus ist kein Modelltreffer — gelb
          // markiert, damit man nicht versehentlich das Terrain hinter der
          // Wolke beschriftet.
          coverage: kind === 'free' ? 0.2 : (r.coverage ?? 1),
          kind: kind
        };
      }
    });
  }

  function detachInput() {
    if (ModeState.handler) {
      ModeState.handler.destroy();
      ModeState.handler = null;
    }
    if (window.SplatPick && SplatPick.hover) SplatPick.hover.disable();
  }

  function attachKeyHandler() {
    if (ModeState.keyHandler) return;
    const fn = (e) => {
      // Skip when user types into a form
      const tag = (e.target && e.target.tagName) || '';
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) ||
                     (e.target && e.target.isContentEditable);
      if (e.key === 'Escape') {
        const dlg = document.getElementById('tagsDialog');
        if (dlg) { dlg.remove(); e.preventDefault(); return; }
        if (Tags.active) { Tags.deactivate(); e.preventDefault(); }
        return;
      }
      if (typing) return;
      if (e.key === 'c' || e.key === 'C') {
        Tags.toggleMode();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', fn);
    ModeState.keyHandler = fn;
  }

  function detachKeyHandler() {
    if (ModeState.keyHandler) {
      window.removeEventListener('keydown', ModeState.keyHandler);
      ModeState.keyHandler = null;
    }
  }

  // ============================================================
  // DIALOG
  // ============================================================

  function injectDialogStyles() {
    if (document.getElementById('tagsDialogStyles')) return;
    const css = `
      #tagsDialog {
        position: fixed; z-index: 100000;
        min-width: 360px; max-width: 420px;
        background: #000; color: #e0e0e0;
        border: 1px solid #7CFC00; border-radius: 4px;
        font-family: -apple-system, system-ui, sans-serif; font-size: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,.6), 0 0 16px rgba(124,252,0,.25);
      }
      #tagsDialog .td-header {
        display:flex; align-items:center; gap:8px;
        padding:10px 12px; border-bottom:1px solid #2a2a2a;
        background: linear-gradient(90deg, rgba(124,252,0,.08), transparent);
      }
      #tagsDialog .td-header-icon { font-size:16px; }
      #tagsDialog .td-header-title { flex:1; color:#7CFC00; font-weight:600; letter-spacing:.5px; }
      #tagsDialog .td-close {
        background:none; border:none; color:#888; font-size:16px; cursor:pointer; padding:0 4px;
      }
      #tagsDialog .td-close:hover { color:#7CFC00; }
      #tagsDialog .td-context {
        padding:8px 12px; background:#0a0a0a; border-bottom:1px solid #1a1a1a;
        font-family: 'SFMono-Regular', Menlo, monospace; font-size:11px;
        color:#9aa39a; line-height:1.5; word-break:break-all;
      }
      #tagsDialog .td-context .td-ctx-label { color:#7CFC00; }
      #tagsDialog .td-body { padding:12px; display:flex; flex-direction:column; gap:8px; }
      #tagsDialog label { font-size:10px; color:#888; text-transform:uppercase; letter-spacing:.6px; }
      #tagsDialog input[type=text], #tagsDialog textarea, #tagsDialog select {
        background:#0a0a0a; color:#e0e0e0;
        border:1px solid #2a2a2a; border-radius:3px;
        padding:6px 8px; font-size:12px; font-family:inherit;
        outline:none; width:100%; box-sizing:border-box;
      }
      #tagsDialog input[type=text]:focus, #tagsDialog textarea:focus, #tagsDialog select:focus {
        border-color:#7CFC00;
      }
      #tagsDialog textarea { resize:vertical; min-height:60px; }
      #tagsDialog .td-row { display:flex; gap:8px; }
      #tagsDialog .td-row > div { flex:1; }
      #tagsDialog .td-actions {
        display:flex; gap:8px; justify-content:flex-end;
        padding:10px 12px; border-top:1px solid #1a1a1a; background:#0a0a0a;
      }
      #tagsDialog button.td-btn {
        padding:6px 14px; border-radius:3px; cursor:pointer; font-size:11px;
        text-transform:uppercase; letter-spacing:.6px; border:1px solid #2a2a2a;
        background:#000; color:#aaa;
      }
      #tagsDialog button.td-btn:hover { border-color:#444; color:#ddd; }
      #tagsDialog button.td-btn-primary {
        background:#7CFC00; color:#000; border-color:#7CFC00; font-weight:600;
      }
      #tagsDialog button.td-btn-primary:hover { background:#9eff33; }
      #tagsDialog .td-input-error { border-color:#ff4444 !important; }
    `;
    const style = document.createElement('style');
    style.id = 'tagsDialogStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildContextBlock(target, position) {
    const lat = position.lat?.toFixed(7) ?? '?';
    const lon = position.lon?.toFixed(7) ?? '?';
    const h   = position.height?.toFixed(2) ?? '?';
    const coords = `${lat}°N, ${lon}°E · ${h} m`;

    if (target.kind === 'ifc') {
      const props = target.featureProps || {};
      const ifcType = props.IfcType || props.type || props.expressType || props.IFC_TYPE || 'IfcElement';
      const name    = props.Name || props.name || '';
      return `
        <div><span class="td-ctx-label">IFC:</span> ${ifcType}${name ? ' · ' + name : ''}</div>
        <div><span class="td-ctx-label">GlobalId:</span> ${target.ifcGuid}</div>
        <div>${coords}</div>
      `;
    }
    if (target.kind === 'splat') {
      const assetName = window.BimViewer?.loadedAssets?.get(String(target.assetId))?.name || target.assetId || '?';
      return `
        <div><span class="td-ctx-label">Gaussian:</span> Asset ${assetName} · Splat #${target.splatIdx ?? '–'}</div>
        <div>${coords}</div>
      `;
    }
    if (target.kind === 'b3dm') {
      const props = target.featureProps || {};
      const assetName = window.BimViewer?.loadedAssets?.get(String(target.assetId))?.name || target.assetId || '?';
      const summary = Object.keys(props).slice(0, 2).map(k => `${k}=${String(props[k]).slice(0,32)}`).join(' · ');
      return `
        <div><span class="td-ctx-label">Mesh:</span> ${assetName}</div>
        ${summary ? `<div>${summary}</div>` : ''}
        <div>${coords}</div>
      `;
    }
    return `<div><span class="td-ctx-label">Free point</span></div><div>${coords}</div>`;
  }

  function positionDialog(dialog, screenPos) {
    const margin = 12;
    const W = window.innerWidth, H = window.innerHeight;
    const dw = dialog.offsetWidth || 380;
    const dh = dialog.offsetHeight || 320;
    let left = (screenPos?.x ?? W / 2) + 16;
    let top  = (screenPos?.y ?? H / 2) + 16;
    if (left + dw > W - margin) left = (screenPos?.x ?? W / 2) - dw - 16;
    if (top + dh > H - margin)   top  = H - dh - margin;
    if (left < margin) left = margin;
    if (top < margin)  top  = margin;
    dialog.style.left = left + 'px';
    dialog.style.top  = top + 'px';
  }

  /** Pending dialog state (closure across save handler) */
  const _dialogState = { pickResult: null, resolveFn: null };

  function openDialog(pickResult, screenPos) {
    injectDialogStyles();
    const old = document.getElementById('tagsDialog');
    if (old) old.remove();

    _dialogState.pickResult = pickResult;
    const { target, position } = pickResult;

    const topicOpts = TOPIC_TYPES.map(t =>
      `<option value="${t}"${t === 'Issue' ? ' selected' : ''}>${t}</option>`).join('');
    const statusOpts = TAG_STATUS.map(s =>
      `<option value="${s}"${s === 'open' ? ' selected' : ''}>${s}</option>`).join('');
    const prioOpts = TAG_PRIO.map(p =>
      `<option value="${p}"${p === 'normal' ? ' selected' : ''}>${p}</option>`).join('');
    const condOpts = INSPECTION_CONDITIONS.map(c =>
      `<option value="${c.value}">${c.label}</option>`).join('');
    const compOpts = INSPECTION_COMPONENTS.map(c =>
      `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join('');
    const dmgOpts = INSPECTION_DAMAGES.map(d =>
      `<option value="${d}">${d[0].toUpperCase() + d.slice(1)}</option>`).join('');

    const dialog = document.createElement('div');
    dialog.id = 'tagsDialog';
    dialog.innerHTML = `
      <div class="td-header">
        <span class="td-header-icon">🏷️</span>
        <span class="td-header-title">New Annotation · BCF Issue</span>
        <button class="td-close" id="tdClose" title="Close (ESC)">✕</button>
      </div>
      <div class="td-context">${buildContextBlock(target, position)}</div>
      <div class="td-body">
        <div>
          <label>Title *</label>
          <input id="tdTitle" type="text" placeholder="Comment title…" maxlength="120" autocomplete="off">
        </div>
        <div>
          <label>Comment</label>
          <textarea id="tdBody" rows="3" maxlength="2000" placeholder="Your comment…"></textarea>
        </div>
        <div class="td-row">
          <div>
            <label>Topic Type</label>
            <select id="tdTopicType">${topicOpts}</select>
          </div>
          <div>
            <label>Status</label>
            <select id="tdStatus">${statusOpts}</select>
          </div>
        </div>
        <div class="td-row">
          <div>
            <label>Priority</label>
            <select id="tdPriority">${prioOpts}</select>
          </div>
          <div>
            <label>Assigned To</label>
            <input id="tdAssigned" type="text" placeholder="User email…" autocomplete="off">
          </div>
        </div>
        <div>
          <label>Attachments (Photos · PDFs)</label>
          <input id="tdAttachInput" type="file" multiple accept="image/*,application/pdf"
                 style="font-size:11px; padding:4px 0; background:transparent; border:none;">
          <div id="tdAttachList" style="margin-top:4px; font-size:10px; color:#888; display:flex; flex-direction:column; gap:2px;"></div>
        </div>
        <div class="td-inspection-toggle">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; text-transform:none; letter-spacing:0;">
            <input id="tdInspectionChk" type="checkbox" style="width:auto; accent-color:#97BF0D;">
            <span style="color:#aaa; font-size:11px;">Inspection comment</span>
          </label>
        </div>
        <div id="tdInspectionFields" style="display:none; border:1px solid #2a2a2a; border-radius:3px; padding:8px; background:rgba(124,252,0,.03);">
          <div class="td-row">
            <div>
              <label>Condition</label>
              <select id="tdInspCondition">${condOpts}</select>
            </div>
            <div>
              <label>Component</label>
              <select id="tdInspComponent">${compOpts}</select>
            </div>
            <div>
              <label>Damage</label>
              <select id="tdInspDamage">${dmgOpts}</select>
            </div>
          </div>
        </div>
      </div>
      <div class="td-actions">
        <button class="td-btn" id="tdCancel">Cancel</button>
        <button class="td-btn td-btn-primary" id="tdSave">Save BCF Issue</button>
      </div>
    `;
    document.body.appendChild(dialog);
    positionDialog(dialog, screenPos);

    const close = () => dialog.remove();
    dialog.querySelector('#tdClose').onclick = close;
    dialog.querySelector('#tdCancel').onclick = close;

    const inspChk    = dialog.querySelector('#tdInspectionChk');
    const inspFields = dialog.querySelector('#tdInspectionFields');
    inspChk.onchange = () => { inspFields.style.display = inspChk.checked ? 'block' : 'none'; };

    // Attachment staging: keep selected files in memory until Save
    const escapeHtmlLocal = (s) => String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
    const pendingFiles = [];
    const attachInput = dialog.querySelector('#tdAttachInput');
    const attachList  = dialog.querySelector('#tdAttachList');
    function renderPending() {
      if (!pendingFiles.length) { attachList.innerHTML = ''; return; }
      attachList.innerHTML = pendingFiles.map((f, i) => {
        const sizeKB = (f.size / 1024).toFixed(0);
        const icon = f.type.startsWith('image/') ? '🖼️' : (f.type === 'application/pdf' ? '📄' : '📎');
        return `<div style="display:flex; align-items:center; gap:6px;">
          <span>${icon}</span>
          <span style="flex:1; color:#bbb; word-break:break-all;">${escapeHtmlLocal(f.name)} <span style="color:#555;">(${sizeKB} KB)</span></span>
          <button type="button" data-idx="${i}" class="td-attach-rm" style="background:none; border:none; color:#888; cursor:pointer; font-size:11px;">✕</button>
        </div>`;
      }).join('');
      attachList.querySelectorAll('.td-attach-rm').forEach(b => {
        b.onclick = () => { pendingFiles.splice(Number(b.dataset.idx), 1); renderPending(); };
      });
    }
    attachInput.onchange = () => {
      for (const f of attachInput.files) pendingFiles.push(f);
      attachInput.value = '';
      renderPending();
    };

    dialog.querySelector('#tdSave').onclick = async () => {
      const titleEl = dialog.querySelector('#tdTitle');
      const title = titleEl.value.trim();
      if (!title) {
        titleEl.classList.add('td-input-error');
        titleEl.focus();
        return;
      }
      const inspectionEnabled = inspChk.checked;

      // Persist files to IndexedDB first; collect metadata for the tag.
      const attachments = [];
      for (const f of pendingFiles) {
        try {
          const id = await Attachments.put(f);
          attachments.push({
            id, name: f.name, type: f.type, size: f.size, addedAt: nowISO()
          });
        } catch (err) {
          console.error('[Tags] attachment put failed', f.name, err);
          if (window.BimViewer?.updateStatus) {
            BimViewer.updateStatus(`Attachment failed: ${f.name}`, 'error');
          }
        }
      }

      const tag = makeTag({
        position,
        target,
        // Internal type: 'inspection' if user checked the inspection box, else 'issue'
        type: inspectionEnabled ? 'inspection' : 'issue',
        payload: {
          title,
          body:       dialog.querySelector('#tdBody').value,
          status:     dialog.querySelector('#tdStatus').value,
          priority:   dialog.querySelector('#tdPriority').value,
          topicType:  dialog.querySelector('#tdTopicType').value,
          assignedTo: dialog.querySelector('#tdAssigned').value.trim(),
          attachments,
          inspection: inspectionEnabled ? {
            enabled:   true,
            condition: dialog.querySelector('#tdInspCondition').value,
            component: dialog.querySelector('#tdInspComponent').value,
            damage:    dialog.querySelector('#tdInspDamage').value
          } : { enabled: false }
        }
      });
      try {
        await Tags.save(tag);
        if (window.BimViewer?.updateStatus) {
          BimViewer.updateStatus(`Tag saved: ${title} (${target.kind})`, 'success');
        }
        close();
        // notify any UI listeners
        document.dispatchEvent(new CustomEvent('tags:changed', { detail: { tag } }));
      } catch (e) {
        console.error('[Tags] save failed', e);
        if (window.BimViewer?.updateStatus) {
          BimViewer.updateStatus('Tag save failed: ' + e.message, 'error');
        }
      }
    };

    setTimeout(() => dialog.querySelector('#tdTitle').focus(), 0);
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  const Tags = {
    // state
    items: [],
    active: false,            // tag-mode
    activeAssetId: null,      // optional bias for picking (e.g. focused gaussian asset)
    selectedId: null,

    // constants
    TYPES:   TAG_TYPES,
    STATUS:  TAG_STATUS,
    PRIO:    TAG_PRIO,
    KINDS:   TARGET_KIND,

    // factory
    make: makeTag,

    // picking — { position:{worldCart,lon,lat,height}, target:{kind,assetId,ifcGuid?,splatIdx?,featureProps?} } | null
    pick: pickAtScreen,

    // picking helpers (exposed for testing / debugging)
    _pick: {
      isGaussianTileset,
      isSplatPick,
      pickSplat,
      extractIfcGuid,
      extractFeatureProps,
      findAssetIdForTileset
    },

    // store (exposed for inspection / testing)
    _local: LocalStore,
    _retry: RetryQueue,
    _dual: DualStore,

    /**
     * Bootstrap: load tags into memory + attach hotkeys.
     * Call after Cesium is ready.
     */
    async init() {
      this.items = await DualStore.load();
      attachKeyHandler();
      console.log('[Tags] init complete: ' + this.items.length + ' tags');
      DualStore.flushRetryQueue().catch(() => {});
      return this.items;
    },

    /**
     * Tag-mode: toggle / activate / deactivate.
     * Optional assetId biases picking toward a specific (typically gaussian) asset.
     */
    toggleMode(assetId) {
      if (this.active) this.deactivate();
      else this.activate(assetId);
    },

    activate(assetId) {
      if (this.active) return;
      this.active = true;
      this.activeAssetId = assetId ?? null;
      attachInput();
      showModeIndicator();
      setCursor('crosshair');
      if (window.BimViewer?.updateStatus) {
        BimViewer.updateStatus('Tag-Mode ON — RIGHT-CLICK to place a tag', 'success');
      }
      document.dispatchEvent(new CustomEvent('tags:mode-on'));
    },

    deactivate() {
      if (!this.active) return;
      this.active = false;
      this.activeAssetId = null;
      detachInput();
      hideModeIndicator();
      setCursor('');
      if (window.BimViewer?.updateStatus) {
        BimViewer.updateStatus('Tag-Mode OFF', 'success');
      }
      document.dispatchEvent(new CustomEvent('tags:mode-off'));
    },

    /**
     * Fly the camera to a tag's position.
     */
    flyTo(id) {
      if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled()) WalkMode.toggle(false);
      const tag = this.items.find(t => t.id === id);
      if (!tag || !tag.position?.worldCart || !window.BimViewer?.viewer) return;
      const c = tag.position.worldCart;
      BimViewer.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromElements(c.x, c.y, c.z),
        duration: 1.5
      });
    },

    /**
     * Open the contextual New-Tag dialog at the picked position.
     */
    openDialog(pickResult, screenPos) {
      return openDialog(pickResult, screenPos);
    },

    /**
     * Save (create or update) a tag.
     */
    async save(tag) {
      tag.updatedAt = nowISO();
      await DualStore.upsert(tag);
      const i = this.items.findIndex(t => t.id === tag.id);
      if (i >= 0) this.items[i] = tag; else this.items.unshift(tag);
      return tag;
    },

    /**
     * Delete a tag by id.
     */
    async remove(id) {
      const tag = this.items.find(t => t.id === id);
      if (tag?.payload?.attachments?.length) {
        for (const a of tag.payload.attachments) {
          try { await Attachments.remove(a.id); } catch (e) { console.warn('[Tags] attach remove', e); }
        }
      }
      await DualStore.remove(id);
      this.items = this.items.filter(t => t.id !== id);
      if (this.selectedId === id) this.selectedId = null;
    },

    // IDB attachment access for UI (thumbnails, download links)
    attachments: Attachments,

    /**
     * Filter helpers.
     */
    byType(type) { return this.items.filter(t => t.type === type); },
    byKind(kind) { return this.items.filter(t => t.target.kind === kind); },
    byStatus(s)  { return this.items.filter(t => t.payload.status === s); },

    /**
     * Get all tags with an IFC GlobalId (for BCF export).
     */
    withIfcGuid() {
      return this.items.filter(t => t.target.kind === 'ifc' && t.target.ifcGuid);
    }
  };

  window.Tags = Tags;

  console.log('✅ Tags module v1.0 loaded');

})();
