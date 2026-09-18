/**
 * iLEEN — BCF-2.1-Ausgabe (Notizen, Kollisionen, Kommentare)
 * © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Ein BCF-Paket ist ein ZIP mit `bcf.version` und je Thema einem Ordner:
 *
 *   <Thema-GUID>/markup.bcf       Thema, Kommentar, Verweis auf die Ansicht
 *   <Thema-GUID>/viewpoint.bcfv   Kamera und betroffene Bauteile (IfcGuid)
 *   <Thema-GUID>/snapshot.png     Bild der Szene
 *
 * Die Kamera wird in das örtliche System des ersten geladenen Modells
 * umgerechnet (dessen `root.computedTransform`). ECEF-Koordinaten in der
 * Größenordnung des Erdradius versteht keine BIM-Software als Projektlage.
 *
 * Braucht JSZip (index.html lädt es vom CDN).
 */
'use strict';

(function () {

  // ── Hilfen ───────────────────────────────────────────────────────────────

  function guid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = new Uint8Array(16);
    (window.crypto || { getRandomValues: (a) => a.map(() => Math.random() * 256) }).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function xml(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function zeitpunkt(wert) {
    const d = wert ? new Date(wert) : new Date();
    return isNaN(d) ? new Date().toISOString() : d.toISOString();
  }

  function kuerzen(text, laenge) {
    const s = String(text || '');
    return s.length > laenge ? s.slice(0, laenge - 1) + '…' : s;
  }

  function zahl(v) { return (isFinite(v) ? v : 0).toFixed(6); }

  // ── Kamera und Bild ──────────────────────────────────────────────────────

  function erstesModell() {
    const assets = window.BimViewer && BimViewer.loadedAssets;
    if (!assets) return null;
    for (const asset of assets.values()) {
      if (asset.tileset && asset.tileset.root) return asset.tileset;
    }
    return null;
  }

  /** Kamera im örtlichen System des ersten Modells (sonst ECEF). */
  function kamera() {
    const viewer = window.BimViewer && BimViewer.viewer;
    if (!viewer) return null;
    const cam = viewer.camera;
    let pos = Cesium.Cartesian3.clone(cam.positionWC);
    let dir = Cesium.Cartesian3.clone(cam.directionWC);
    let up = Cesium.Cartesian3.clone(cam.upWC);

    const tileset = erstesModell();
    const rahmen = tileset && tileset.root.computedTransform;
    if (rahmen) {
      const invers = Cesium.Matrix4.inverse(rahmen, new Cesium.Matrix4());
      pos = Cesium.Matrix4.multiplyByPoint(invers, pos, new Cesium.Cartesian3());
      dir = Cesium.Matrix4.multiplyByPointAsVector(invers, dir, new Cesium.Cartesian3());
      up = Cesium.Matrix4.multiplyByPointAsVector(invers, up, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(dir, dir);
      Cesium.Cartesian3.normalize(up, up);
    }
    const fov = cam.frustum && cam.frustum.fov ? Cesium.Math.toDegrees(cam.frustum.fov) : 60;
    return { position: pos, direction: dir, up: up, fov: fov };
  }

  /** PNG der aktuellen Szene; setzt `preserveDrawingBuffer` voraus (core.js). */
  function bild() {
    const viewer = window.BimViewer && BimViewer.viewer;
    if (!viewer) return null;
    try {
      viewer.render();
      return viewer.canvas.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  }

  function dataUriZuBlob(uri) {
    if (!uri || uri.indexOf(',') < 0) return null;
    const [kopf, daten] = uri.split(',');
    const typ = (kopf.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    const roh = atob(daten);
    const bytes = new Uint8Array(roh.length);
    for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
    return new Blob([bytes], { type: typ });
  }

  // ── XML ──────────────────────────────────────────────────────────────────

  function versionXml() {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
      '  <DetailedVersion>2.1</DetailedVersion>\n' +
      '</Version>\n';
  }

  function markupXml(thema, themaGuid, kommentarGuid, ansichtGuid, mitBild) {
    const titel = kuerzen(thema.title || thema.text || 'Thema', 80);
    const text = thema.text || thema.description || '';
    const autor = thema.author || thema.creation_author || 'iLEEN';
    const datum = zeitpunkt(thema.timestamp || thema.creation_date);
    const typ = thema.category || thema.topic_type || 'Issue';
    const status = thema.status || thema.topic_status || 'Open';
    const prio = thema.priority || 'Normal';

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
      '  <Topic Guid="' + themaGuid + '" TopicType="' + xml(typ) + '" TopicStatus="' + xml(status) + '">\n' +
      '    <Title>' + xml(titel) + '</Title>\n' +
      '    <Priority>' + xml(prio) + '</Priority>\n' +
      '    <CreationDate>' + datum + '</CreationDate>\n' +
      '    <CreationAuthor>' + xml(autor) + '</CreationAuthor>\n' +
      (text ? '    <Description>' + xml(text) + '</Description>\n' : '') +
      '  </Topic>\n' +
      '  <Comment Guid="' + kommentarGuid + '">\n' +
      '    <Date>' + datum + '</Date>\n' +
      '    <Author>' + xml(autor) + '</Author>\n' +
      '    <Comment>' + xml(text || titel) + '</Comment>\n' +
      '    <Viewpoint Guid="' + ansichtGuid + '"/>\n' +
      '  </Comment>\n' +
      '  <Viewpoints Guid="' + ansichtGuid + '">\n' +
      '    <Viewpoint>viewpoint.bcfv</Viewpoint>\n' +
      (mitBild ? '    <Snapshot>snapshot.png</Snapshot>\n' : '') +
      '  </Viewpoints>\n' +
      '</Markup>\n';
  }

  /** Bauteile als Auswahl; nimmt GUID-Texte oder Objekte {ifc_guid, …}. */
  function bauteileXml(bauteile) {
    if (!bauteile || !bauteile.length) return '';
    const zeilen = bauteile.map((b) => {
      const g = typeof b === 'string' ? b : (b.ifc_guid || b.ifcGuid);
      if (!g) return '';
      const system = typeof b === 'object' ? (b.originating_system || b.originatingSystem) : null;
      const werkzeug = typeof b === 'object' ? (b.authoring_tool_id || b.authoringToolId) : null;
      return '      <Component IfcGuid="' + xml(g) + '">\n' +
             (system ? '        <OriginatingSystem>' + xml(system) + '</OriginatingSystem>\n' : '') +
             (werkzeug ? '        <AuthoringToolId>' + xml(werkzeug) + '</AuthoringToolId>\n' : '') +
             '      </Component>\n';
    }).filter(Boolean).join('');
    if (!zeilen) return '';
    return '  <Components>\n' +
           '    <Selection>\n' + zeilen + '    </Selection>\n' +
           '    <Visibility DefaultVisibility="true"/>\n' +
           '  </Components>\n';
  }

  function ansichtXml(k, ansichtGuid, bauteile) {
    const vektor = (name, v) =>
      '    <' + name + '>\n' +
      '      <X>' + zahl(v.x) + '</X>\n' +
      '      <Y>' + zahl(v.y) + '</Y>\n' +
      '      <Z>' + zahl(v.z) + '</Z>\n' +
      '    </' + name + '>\n';
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<VisualizationInfo Guid="' + ansichtGuid + '" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
      bauteileXml(bauteile) +
      '  <PerspectiveCamera>\n' +
      vektor('CameraViewPoint', k.position) +
      vektor('CameraDirection', k.direction) +
      vektor('CameraUpVector', k.up) +
      '    <FieldOfView>' + Math.max(1, Math.min(179, k.fov || 60)).toFixed(1) + '</FieldOfView>\n' +
      '  </PerspectiveCamera>\n' +
      '</VisualizationInfo>\n';
  }

  // ── Paket ────────────────────────────────────────────────────────────────

  async function paketSchreiben(themen, dateiname) {
    const status = (text, art) => window.BimViewer && BimViewer.updateStatus && BimViewer.updateStatus(text, art);
    if (!Array.isArray(themen)) themen = [themen];
    if (!themen.length) {
      status('BCF: nichts zu exportieren', 'warning');
      return;
    }
    if (typeof JSZip === 'undefined') {
      status('BCF: JSZip ist nicht geladen', 'error');
      return;
    }

    const zip = new JSZip();
    zip.file('bcf.version', versionXml());

    // Ein Bild und eine Kamera für alle Themen ohne eigene Ansicht
    const aktuelleKamera = kamera();
    const aktuellesBild = dataUriZuBlob(bild());

    for (const thema of themen) {
      const themaGuid = thema.id && /^[0-9a-f-]{36}$/i.test(thema.id) ? thema.id : guid();
      const ordner = zip.folder(themaGuid);
      const k = thema.camera || aktuelleKamera;
      const png = thema.snapshot ? dataUriZuBlob(thema.snapshot) : aktuellesBild;
      const ansichtGuid = guid();

      ordner.file('markup.bcf', markupXml(thema, themaGuid, guid(), ansichtGuid, !!png));
      if (k) ordner.file('viewpoint.bcfv', ansichtXml(k, ansichtGuid, thema.components));
      if (png) ordner.file('snapshot.png', png);
    }

    try {
      status('BCF-Paket wird geschrieben …', 'loading');
      const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' });
      const stempel = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (dateiname || 'ileen') + '-' + stempel + '.bcf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      status('BCF: ' + themen.length + ' Thema/Themen exportiert', 'success');
    } catch (fehler) {
      console.error('BCF-Export fehlgeschlagen:', fehler);
      status('BCF-Export fehlgeschlagen', 'error');
    }
  }

  // ── Notizen → BCF-Themen ─────────────────────────────────────────────────

  const TYP = { note: 'Comment', issue: 'Issue', inspection: 'Inspection', 'measurement-anchor': 'Issue', custom: 'Issue' };
  const STATUS = { open: 'Open', in_progress: 'InProgress', closed: 'Closed' };
  const PRIO = { low: 'Low', normal: 'Normal', high: 'High' };

  function notizZuThema(tag) {
    const p = tag.payload || {};
    return {
      id: tag.id,
      title: p.title || '(ohne Titel)',
      text: p.body || '',
      topic_type: p.topicType || TYP[tag.type] || 'Issue',
      topic_status: STATUS[p.status] || 'Open',
      priority: PRIO[p.priority] || 'Normal',
      creation_date: tag.createdAt,
      author: p.author || tag.author || 'iLEEN',
      components: tag.target && tag.target.ifcGuid
        ? [{ ifc_guid: tag.target.ifcGuid, originating_system: 'iLEEN Notizen' }]
        : []
    };
  }

  window.ILEEN_BCF = {
    exportComment: function (kommentar) {
      if (kommentar) paketSchreiben([kommentar], 'kommentar');
    },

    exportComments: function (kommentare) {
      paketSchreiben(kommentare || [], 'kommentare');
    },

    /** Kollisionen aus ifclash.js. */
    exportClashes: function (kollisionen) {
      const themen = (kollisionen || []).map((c) => ({
        title: 'Kollision: ' + c.mep_type + ' / ' + c.arch_type,
        text: 'Kollision zwischen ' + c.mep_name + ' und ' + c.arch_name +
              (c.arch_storey ? ' in ' + c.arch_storey : '') + '.',
        topic_type: 'Clash',
        topic_status: 'Open',
        priority: c.severity === 'Hoch' ? 'High' : (c.severity === 'Mittel' ? 'Normal' : 'Low'),
        author: 'iLEEN Kollisionsprüfung',
        components: [c.mep_guid, c.arch_guid].filter(Boolean)
      }));
      paketSchreiben(themen, 'kollisionen');
    },

    /**
     * Notizen aus tags.js. Notizen mit IFC-GlobalId bekommen die
     * Bauteilauswahl in ihre Ansicht.
     * @param {Array} [tags]  Standard: window.Tags.items
     * @param {{onlyIfc?: boolean}} [optionen]
     */
    exportTags: function (tags, optionen) {
      optionen = optionen || {};
      let liste = tags || (window.Tags ? Tags.items : []);
      if (optionen.onlyIfc) liste = liste.filter((t) => t.target && t.target.ifcGuid);
      paketSchreiben(liste.map(notizZuThema), 'notizen');
    },

    _internals: { markupXml, ansichtXml, versionXml, bauteileXml, notizZuThema }
  };
})();
