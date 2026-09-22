/**
 * iLEEN — Themenablage: die Brücke zwischen Notizen im Viewer und dem Backend.
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Alles, was im Viewer getaggt, notiert oder gemessen wird, ist dasselbe Ding:
 * eine **Notiz** (`tags.js`). Dieses Modul gibt ihr ein zweites Zuhause —
 * `backend/api/routes/issues.py`, also SQLite mit Verlauf, BCF-Ausgabe,
 * BCF-Einlesen und HTML-Bericht.
 *
 *     tags.js  ──DualStore──▶  issues-store.js  ──HTTP──▶  /issues
 *        │                            │
 *   annotations.js              issue-manager.js
 *   (im Bild)                   (Liste, Verlauf, BCF)
 *
 * Zwei Ablagen, eine Wahrheit
 * ===========================
 * Der `localStorage` bleibt — nicht als Zweitschrift aus Bequemlichkeit,
 * sondern weil eine Notiz auf der Baustelle auch dann entstehen muss, wenn das
 * Backend nicht erreichbar ist. Die Regel ist deshalb:
 *
 *   - **Geschrieben wird immer zuerst lokal**, danach zum Server. Ein
 *     fehlgeschlagener Server macht aus dem Klick keinen Fehler, sondern einen
 *     Eintrag in der Warteschlange (`ileen_issues_queue`).
 *   - **Gelesen wird der Server**, wenn er antwortet. Er hat den Verlauf, die
 *     importierten Themen und die Notizen der anderen.
 *   - **Beim ersten erfolgreichen Lesen wandert alles Lokale hinauf**, was der
 *     Server nicht kennt. So kommt der Altbestand aus dem Browser dorthin, wo
 *     er hingehört, ohne dass jemand etwas exportieren muss.
 *
 * Die GUID ist dabei dieselbe: `tags.js` vergibt UUIDv4, und BCF verlangt genau
 * das. Eine Notiz, ein Thema, eine Kennung — über alle drei Ablagen hinweg.
 *
 * Warum nicht gleich gaeco
 * ========================
 * Weil die Kopplung dorthin (Kafka, Link-Ontologie, IDs per UUIDv5 aus der
 * IFC-GUID) eine eigene Baustelle ist. Diese Schicht ist bewusst so schmal,
 * dass ein Wechsel der Gegenstelle nur hier und in `issues_db.py` stattfindet:
 * `holen`, `sichern`, `entfernen`, `kommentieren`, `ansichtSichern`. Der Rest
 * des Viewers redet weiter mit `Tags`.
 */
'use strict';

(function () {

  const WARTESCHLANGE = 'ileen_issues_queue_v1';

  // Der Zustand der Verbindung wird gemerkt, nicht bei jedem Aufruf neu
  // erfragt: die Notizliste wird bei jedem `tags:changed` gezeichnet, und ein
  // fehlschlagender `fetch` kostet in Chrome rund eine Sekunde, bis er es
  // aufgibt. Geprüft wird deshalb höchstens alle 30 s neu.
  const Z = { erreichbar: null, geprueft: 0, autor: null };
  const PRUEF_PAUSE_MS = 30000;

  const basis = () => (window.BimViewer && BimViewer.getBackendUrl
    ? BimViewer.getBackendUrl() : '') + '/issues';

  function autor() {
    if (Z.autor) return Z.autor;
    try { Z.autor = localStorage.getItem('ileen_autor') || 'iLEEN'; }
    catch (e) { Z.autor = 'iLEEN'; }
    return Z.autor;
  }

  async function ruf(pfad, optionen) {
    const antwort = await fetch(basis() + (pfad || ''), Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, optionen || {}));
    if (!antwort.ok) {
      const text = await antwort.text().catch(() => '');
      throw new Error(antwort.status + ' ' + (text || antwort.statusText));
    }
    return antwort.status === 204 ? null : antwort.json();
  }

  async function erreichbar(erzwingen) {
    const jetzt = Date.now();
    if (!erzwingen && Z.erreichbar !== null && jetzt - Z.geprueft < PRUEF_PAUSE_MS) {
      return Z.erreichbar;
    }
    Z.geprueft = jetzt;
    try {
      await ruf('/zahlen');
      Z.erreichbar = true;
    } catch (e) {
      Z.erreichbar = false;
    }
    return Z.erreichbar;
  }

  // ── Notiz ↔ Thema ────────────────────────────────────────────────────────

  // `tag.type` ist die Art der Notiz im Viewer, `topicType` die des BCF-Themas.
  // Beide bleiben erhalten: der BCF-Typ, weil fremde Software danach filtert,
  // die Viewer-Art, weil sie das Symbol im Bild bestimmt (`annotations.js`).
  const STATUS_HIN = { open: 'Open', in_progress: 'InProgress', closed: 'Closed' };
  const STATUS_ZURUECK = { Open: 'open', InProgress: 'in_progress', Closed: 'closed',
                           ReOpened: 'open' };
  const PRIO_HIN = { low: 'Low', normal: 'Normal', high: 'High' };
  const PRIO_ZURUECK = { Low: 'low', Normal: 'normal', High: 'high', Critical: 'high' };
  const TYP_HIN = { note: 'Comment', issue: 'Issue', inspection: 'Inspection',
                    'measurement-anchor': 'Info', custom: 'Issue' };

  /**
   * Eine Notiz als Thema.
   *
   * Alles, was BCF nicht kennt — Ort, getroffenes Bauteil, Prüfangaben, Fotos —
   * geht als `daten` mit. Das ist kein Abladeplatz: genau diese Felder machen
   * aus einem importierten Thema wieder eine Notiz, die im Modell an der
   * richtigen Stelle steht.
   */
  function tagZuThema(tag) {
    const p = tag.payload || {};
    return {
      guid: tag.id,
      titel: p.title || '(ohne Titel)',
      beschreibung: p.body || '',
      typ: p.topicType || TYP_HIN[tag.type] || 'Issue',
      status: STATUS_HIN[p.status] || 'Open',
      prioritaet: PRIO_HIN[p.priority] || 'Normal',
      zugewiesen: p.assignedTo || null,
      faellig: p.dueDate || null,
      marken: [tag.type].filter(Boolean),
      erstellt: tag.createdAt,
      autor: tag.author || autor(),
      daten: {
        tagTyp: tag.type,
        position: tag.position || null,
        target: tag.target || null,
        inspection: p.inspection && p.inspection.enabled ? p.inspection : null,
        photos: p.photos || [],
        attachments: p.attachments || [],
      },
    };
  }

  /** Ein Thema als Notiz — die Umkehr, für alles, was von außen kommt. */
  function themaZuTag(thema) {
    const d = thema.daten || {};
    const marke = (thema.marken || []).find((m) =>
      ['note', 'issue', 'inspection', 'measurement-anchor', 'custom'].indexOf(m) >= 0);
    return {
      id: thema.guid,
      type: d.tagTyp || marke || 'issue',
      position: d.position || { worldCart: null, lon: null, lat: null, height: null },
      target: d.target || { kind: 'free', assetId: null, ifcGuid: _ifcGuid(thema),
                            splatIdx: null, featureProps: null },
      payload: {
        title: thema.titel || '(ohne Titel)',
        body: thema.beschreibung || '',
        photos: d.photos || [],
        attachments: d.attachments || [],
        status: STATUS_ZURUECK[thema.status] || 'open',
        priority: PRIO_ZURUECK[thema.prioritaet] || 'normal',
        dueDate: thema.faellig || null,
        topicType: thema.typ || 'Issue',
        assignedTo: thema.zugewiesen || '',
        inspection: d.inspection || { enabled: false, condition: null,
                                      component: null, damage: null },
      },
      createdAt: thema.erstellt,
      updatedAt: thema.geaendert,
      author: thema.autor || 'iLEEN',
      // Nur lesend, für die Oberfläche — wird beim Zurückschreiben verworfen.
      _stand: thema.stand,
      _quelle: thema.quelle,
      _kommentare: (thema.kommentare || []).length,
    };
  }

  /** Die erste Bauteil-GUID, die ein Thema nennt — aus `daten` oder aus einer Ansicht. */
  function _ifcGuid(thema) {
    const ziel = (thema.daten || {}).target || {};
    if (ziel.ifcGuid) return ziel.ifcGuid;
    for (const a of thema.ansichten || []) {
      for (const k of a.komponenten || []) if (k.ifc_guid) return k.ifc_guid;
    }
    return null;
  }

  // ── Warteschlange ────────────────────────────────────────────────────────

  function warteschlange() {
    try { return JSON.parse(localStorage.getItem(WARTESCHLANGE) || '[]'); }
    catch (e) { return []; }
  }

  function warteschlangeSchreiben(liste) {
    try { localStorage.setItem(WARTESCHLANGE, JSON.stringify(liste.slice(-500))); }
    catch (e) { /* voll oder gesperrt — dann geht der Eintrag verloren */ }
  }

  function vormerken(art, nutzlast) {
    const liste = warteschlange().filter((e) =>
      !(e.art === art && e.id === (nutzlast.guid || nutzlast)));
    liste.push({ art, id: nutzlast.guid || nutzlast, nutzlast, zeit: Date.now() });
    warteschlangeSchreiben(liste);
  }

  /** Alles nachholen, was offline liegen geblieben ist. */
  async function nachholen() {
    const liste = warteschlange();
    if (!liste.length || !(await erreichbar())) return { erledigt: 0, offen: liste.length };
    const rest = [];
    let erledigt = 0;
    for (const eintrag of liste) {
      try {
        if (eintrag.art === 'sichern') await _sichern(eintrag.nutzlast);
        else if (eintrag.art === 'entfernen') await _entfernen(eintrag.id);
        erledigt++;
      } catch (e) {
        rest.push(eintrag);
      }
    }
    warteschlangeSchreiben(rest);
    return { erledigt, offen: rest.length };
  }

  // ── Schreiben ────────────────────────────────────────────────────────────

  async function _sichern(thema) {
    // Erst ändern, dann anlegen: ein bekanntes Thema soll seinen Verlauf
    // behalten, und ein Anlegen mit bekannter GUID wäre im Backend ohnehin
    // eine Änderung — nur eine, die „erneut eingelesen" in die Kladde schreibt.
    try {
      return await ruf('/' + thema.guid, {
        method: 'PATCH',
        body: JSON.stringify(Object.assign({}, thema, { autor: autor() })),
      });
    } catch (e) {
      if (!/^404/.test(e.message)) throw e;
      return ruf('', { method: 'POST', body: JSON.stringify(
        Object.assign({}, thema, { autor: thema.autor || autor(), quelle: 'viewer' })) });
    }
  }

  const _entfernen = (guid) =>
    ruf('/' + guid + '?autor=' + encodeURIComponent(autor()), { method: 'DELETE' });

  /**
   * Eine Notiz sichern. Schlägt der Server fehl, wird vorgemerkt statt
   * geworfen — der Aufrufer (tags.js) hat lokal bereits gespeichert, und ein
   * Fehler hier dürfte ihn nicht rückgängig machen.
   */
  async function tagSichern(tag) {
    const thema = tagZuThema(tag);
    try {
      if (!(await erreichbar())) throw new Error('offline');
      const gesichert = await _sichern(thema);
      nachholen().catch(() => {});
      return gesichert;
    } catch (e) {
      vormerken('sichern', thema);
      Z.erreichbar = false;
      return null;
    }
  }

  async function entfernen(guid) {
    try {
      if (!(await erreichbar())) throw new Error('offline');
      return await _entfernen(guid);
    } catch (e) {
      vormerken('entfernen', guid);
      return null;
    }
  }

  // ── Lesen ────────────────────────────────────────────────────────────────

  const liste = (filter) => {
    const f = new URLSearchParams();
    Object.entries(filter || {}).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') f.set(k, v);
    });
    const anhang = f.toString();
    return ruf(anhang ? '?' + anhang : '');
  };

  const holen = (guid) => ruf('/' + guid);
  const versionen = (guid) => ruf('/' + guid + '/versionen');
  const version = (guid, stand) => ruf('/' + guid + '/versionen/' + stand);
  const zuruecksetzen = (guid, stand) =>
    ruf('/' + guid + '/zuruecksetzen/' + stand + '?autor=' + encodeURIComponent(autor()),
        { method: 'POST' });
  const aendern = (guid, felder, grund) => ruf('/' + guid, {
    method: 'PATCH',
    body: JSON.stringify(Object.assign({}, felder, { autor: autor(), grund })),
  });
  const kommentieren = (guid, text) => ruf('/' + guid + '/kommentare', {
    method: 'POST', body: JSON.stringify({ text, autor: autor() }),
  });
  const zahlen = () => ruf('/zahlen');
  const berichtUrl = (filter) => {
    const f = new URLSearchParams(filter || {});
    return basis() + '/bericht' + (f.toString() ? '?' + f.toString() : '');
  };
  const bcfUrl = (filter) => {
    const f = new URLSearchParams(filter || {});
    return basis() + '/bcf' + (f.toString() ? '?' + f.toString() : '');
  };

  /**
   * Alle Themen als Notizen — und der Altbestand aus dem Browser hinterher.
   *
   * Der Abgleich läuft in eine Richtung: was lokal liegt und der Server nicht
   * kennt, wandert hinauf. Umgekehrt wird **nicht** gelöscht. Ein Server, der
   * kurz eine leere Liste liefert (falsche Adresse, frische Datenbank), würde
   * sonst den ganzen lokalen Bestand mitnehmen.
   */
  async function alleAlsTags(lokal) {
    if (!(await erreichbar())) return null;
    await nachholen().catch(() => {});
    const antwort = await liste({ grenze: 2000 });
    const themen = antwort.themen || [];
    const bekannt = new Set(themen.map((t) => t.guid));

    const fehlend = (lokal || []).filter((t) => t && t.id && !bekannt.has(t.id));
    for (const tag of fehlend) {
      try { await _sichern(tagZuThema(tag)); } catch (e) { vormerken('sichern', tagZuThema(tag)); }
    }
    if (fehlend.length) {
      console.log('[Themen] ' + fehlend.length + ' Notiz(en) aus dem Browser übernommen');
      const nach = await liste({ grenze: 2000 });
      return (nach.themen || []).map(themaZuTag);
    }
    return themen.map(themaZuTag);
  }

  // ── Ansichten: Kamera, Bauteile, Schnappschuss ───────────────────────────

  function erstesModell() {
    const assets = window.BimViewer && BimViewer.loadedAssets;
    if (!assets) return null;
    for (const asset of assets.values()) {
      if (asset.tileset && asset.tileset.root) return asset.tileset;
    }
    return null;
  }

  /**
   * Die aktuelle Kamera im Projektsystem des ersten Modells.
   *
   * Dieselbe Rechnung wie in `bcf-export.js` — und bewusst dieselbe: eine
   * Ansicht, die hier anders umgerechnet würde als dort, ließe zwei Pakete
   * desselben Bauwerks an verschiedenen Stellen aufgehen.
   */
  function kameraJetzt() {
    const viewer = window.BimViewer && BimViewer.viewer;
    if (!viewer) return null;
    const cam = viewer.camera;
    let pos = Cesium.Cartesian3.clone(cam.positionWC);
    let dir = Cesium.Cartesian3.clone(cam.directionWC);
    let oben = Cesium.Cartesian3.clone(cam.upWC);
    const tileset = erstesModell();
    const rahmen = tileset && tileset.root.computedTransform;
    if (rahmen) {
      const invers = Cesium.Matrix4.inverse(rahmen, new Cesium.Matrix4());
      pos = Cesium.Matrix4.multiplyByPoint(invers, pos, new Cesium.Cartesian3());
      dir = Cesium.Matrix4.multiplyByPointAsVector(invers, dir, new Cesium.Cartesian3());
      oben = Cesium.Matrix4.multiplyByPointAsVector(invers, oben, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(dir, dir);
      Cesium.Cartesian3.normalize(oben, oben);
    }
    return {
      art: 'perspektiv',
      position: { x: pos.x, y: pos.y, z: pos.z },
      richtung: { x: dir.x, y: dir.y, z: dir.z },
      oben: { x: oben.x, y: oben.y, z: oben.z },
      sichtfeld: cam.frustum && cam.frustum.fov ? Cesium.Math.toDegrees(cam.frustum.fov) : 60,
    };
  }

  /** Die Umkehr: eine BCF-Kamera anfliegen. */
  function ansichtAnfliegen(kamera) {
    const viewer = window.BimViewer && BimViewer.viewer;
    if (!viewer || !kamera || !kamera.position) return false;
    const c3 = (v) => new Cesium.Cartesian3(v.x || 0, v.y || 0, v.z || 0);
    let pos = c3(kamera.position);
    let dir = c3(kamera.richtung || { x: 0, y: 1, z: 0 });
    let oben = c3(kamera.oben || { x: 0, y: 0, z: 1 });
    const tileset = erstesModell();
    const rahmen = tileset && tileset.root.computedTransform;
    if (rahmen) {
      pos = Cesium.Matrix4.multiplyByPoint(rahmen, pos, new Cesium.Cartesian3());
      dir = Cesium.Matrix4.multiplyByPointAsVector(rahmen, dir, new Cesium.Cartesian3());
      oben = Cesium.Matrix4.multiplyByPointAsVector(rahmen, oben, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(dir, dir);
      Cesium.Cartesian3.normalize(oben, oben);
    }
    if (typeof WalkMode !== 'undefined' && WalkMode.isEnabled && WalkMode.isEnabled()) {
      WalkMode.toggle(false);
    }
    viewer.camera.flyTo({
      destination: pos,
      orientation: { direction: dir, up: oben },
      duration: 1.2,
    });
    return true;
  }

  /** Bild der Szene. Setzt `preserveDrawingBuffer` voraus (core.js setzt es). */
  function bildJetzt() {
    const viewer = window.BimViewer && BimViewer.viewer;
    if (!viewer) return null;
    try {
      viewer.render();
      return viewer.canvas.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      return null;
    }
  }

  /** Aktuelle Kamera, Bauteilauswahl und Bild als Ansicht an ein Thema hängen. */
  async function ansichtSichern(guid, komponenten) {
    return ruf('/' + guid + '/ansichten', {
      method: 'POST',
      body: JSON.stringify({
        kamera: kameraJetzt(),
        komponenten: komponenten || [],
        bild: bildJetzt(),
      }),
    });
  }

  async function bcfEinlesen(datei) {
    const formular = new FormData();
    formular.append('file', datei);
    const antwort = await fetch(basis() + '/bcf?autor=' + encodeURIComponent(autor()),
                                { method: 'POST', body: formular });
    if (!antwort.ok) throw new Error(await antwort.text().catch(() => antwort.statusText));
    return antwort.json();
  }

  // ── Zum Bauteil springen ─────────────────────────────────────────────────

  /**
   * Die Kamera auf das Bauteil eines Themas stellen.
   *
   * Drei Wege, in dieser Reihenfolge: die gespeicherte Ansicht (die genaueste,
   * weil jemand sie eingestellt hat), die Hüllbox des Bauteils aus dem Backend
   * (`…/elements/{gid}/box` — im Browser gibt es sie nicht, ein B3DM ist
   * gebatcht), und zuletzt der Ort der Notiz.
   */
  async function springen(thema) {
    const viewer = window.BimViewer && BimViewer.viewer;
    if (!viewer) return false;

    const ansicht = (thema.ansichten || []).find((a) => a.kamera && a.kamera.position);
    if (ansicht && ansichtAnfliegen(ansicht.kamera)) return true;

    const guid = _ifcGuid(thema);
    if (guid && await _aufBauteil(guid)) return true;

    const p = (thema.daten || {}).position;
    if (p && p.worldCart) {
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(
          new Cesium.Cartesian3(p.worldCart.x, p.worldCart.y, p.worldCart.z), 8),
        { duration: 1.2 });
      return true;
    }
    if (p && isFinite(p.lon) && isFinite(p.lat)) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, (p.height || 0) + 30),
        duration: 1.2,
      });
      return true;
    }
    return false;
  }

  async function _aufBauteil(globalId) {
    const assets = window.BimViewer && BimViewer.loadedAssets;
    if (!assets) return false;
    for (const [schluessel, asset] of assets) {
      const jobId = asset.jobId || schluessel;
      if (!jobId || !asset.tileset || !asset.tileset.root) continue;
      let box;
      try {
        const antwort = await fetch(BimViewer.getBackendUrl() + '/assets/' + jobId +
          '/elements/' + encodeURIComponent(globalId) + '/box');
        if (!antwort.ok) continue;
        box = await antwort.json();
      } catch (e) {
        continue;
      }
      const mitte = Cesium.Matrix4.multiplyByPoint(
        asset.tileset.root.computedTransform,
        new Cesium.Cartesian3(box.center[0], box.center[1], box.center[2]),
        new Cesium.Cartesian3());
      const halb = Math.max(1.5, 0.75 * Math.hypot(box.size[0], box.size[1], box.size[2]));
      BimViewer.viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(mitte, halb), { duration: 1.2 });
      // Freistellen, wenn das Aufmaß-Modul da ist: hinfliegen allein hilft in
      // einem dichten Modell wenig, wenn das Bauteil hinter drei anderen liegt.
      if (window.AufmassRDF && AufmassRDF.fokus) {
        AufmassRDF.fokus([globalId], 0.12).catch(function () { /* optional */ });
      }
      return true;
    }
    return false;
  }

  window.ILEEN_ISSUES = {
    erreichbar, nachholen,
    liste, holen, aendern, kommentieren, versionen, version, zuruecksetzen, zahlen,
    tagSichern, entfernen, alleAlsTags, tagZuThema, themaZuTag,
    ansichtSichern, ansichtAnfliegen, kameraJetzt, bildJetzt, springen,
    bcfEinlesen, bcfUrl, berichtUrl,
    ifcGuid: _ifcGuid,
    get offen() { return warteschlange().length; },
    get autor() { return autor(); },
    set autor(name) {
      Z.autor = name || 'iLEEN';
      try { localStorage.setItem('ileen_autor', Z.autor); } catch (e) { /* egal */ }
    },
  };

  console.log('🗂  Themenablage geladen — Notizen, Messungen und BCF an einer Stelle');
})();
