/**
 * iLEEN — Session Container & Issue Database v1.0
 * © 2026 BIM.LABOR. BSL 1.1 — MIT on 2030-03-01
 *
 * Features:
 *  - Pro Session einen isolierten Container
 *  - Messungen sofort als NDJSON-Log ins Backend schreiben
 *  - Fortschreibende globale Datenbank (issues/database.ndjson)
 *  - Export aller Messungen + BCF als .md und .bcf in issues/
 *  - UI-Panel im Measurements-Sidebar
 */
'use strict';

/* ======================================================
   SESSION CONTAINER MODULE
   ====================================================== */

window.ILEEN_SESSION = (function () {

  // -------------------------------------------------------
  // Helpers
  // -------------------------------------------------------

  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function nowISO() {
    return new Date().toISOString();
  }

  /** Format ISO-String als YYYY-MM-DD_HH-mm-ss */
  function sessionTimestamp() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' +
      pad(d.getMonth() + 1) + '-' +
      pad(d.getDate()) + '_' +
      pad(d.getHours()) + '-' +
      pad(d.getMinutes()) + '-' +
      pad(d.getSeconds());
  }

  /** Basisname für Export-Dateien */
  function safeFilename(str) {
    return String(str).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  }

  // -------------------------------------------------------
  // Session State
  // -------------------------------------------------------

  var _session = {
    id: 'session_' + sessionTimestamp(),
    uuid: generateUUID(),
    startedAt: nowISO(),
    user: null,          // wird nach Auth-Init befüllt
    measurements: [],    // { id, type, label, positions, results, timestamp, bcfId }
    bcfTopics: [],       // BCF-Topics (aus comments.js / BCF Storage)
    logWritten: 0        // Anzahl bereits an Backend gesendeter Einträge
  };

  // -------------------------------------------------------
  // Backend-API Kommunikation
  // -------------------------------------------------------

  var _apiBase = '/api/sessions';

  /**
   * Sendet einen einzelnen Log-Eintrag ans Backend.
   * Schreibt sofort — feuern & vergessen, kein Blocking.
   */
  function _logToBackend(entry) {
    fetch(_apiBase + '/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: _session.id,
        sessionUUID: _session.uuid,
        entry: entry
      })
    }).catch(function (err) {
      // Backend nicht erreichbar → still degradieren
      console.warn('[SessionContainer] Backend not reachable:', err.message);
    });
  }

  /**
   * Sendet die initialen Session-Metadaten, sobald bekannt.
   */
  function _logSessionStart() {
    fetch(_apiBase + '/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: _session.id,
        sessionUUID: _session.uuid,
        startedAt: _session.startedAt,
        user: _session.user,
        userAgent: navigator.userAgent.substring(0, 120)
      })
    }).catch(function (err) {
      console.warn('[SessionContainer] Session-Start konnte nicht geloggt werden:', err.message);
    });
  }

  // -------------------------------------------------------
  // Measurement-Hook
  // -------------------------------------------------------

  /**
   * Wird nach jeder abgeschlossenen Messung aufgerufen — aus `aufmass.js`.
   * @param {object} m  - { type, label, positions, results }
   */
  function recordMeasurement(m) {
    var entry = {
      kind: 'measurement',
      id: m.id || generateUUID(),
      type: m.type,
      label: m.label,
      positions: m.positions || [],
      results: m.results || {},
      timestamp: m.timestamp || nowISO(),
      session: _session.id,
      user: _session.user
    };

    _session.measurements.push(entry);
    _logToBackend(entry);
    _renderSessionPanel();

    console.log('[SessionContainer] 📏 Messung geloggt:', entry.label, '→', _session.id);
    return entry;
  }

  /**
   * Wird nach jedem gespeicherten BCF-Topic aufgerufen.
   */
  function recordBcfTopic(topic) {
    var entry = {
      kind: 'bcf_topic',
      guid: topic.guid || generateUUID(),
      title: topic.title,
      type: topic.topic_type || 'Issue',
      status: topic.topic_status || 'Open',
      priority: topic.priority || 'Normal',
      description: topic.description || '',
      author: topic.creation_author || _session.user,
      timestamp: topic.creation_date || nowISO(),
      session: _session.id,
      position: topic.position || null
    };

    _session.bcfTopics.push(entry);
    _logToBackend(entry);
    _renderSessionPanel();

    console.log('[SessionContainer] 🏷️ BCF-Topic geloggt:', entry.title, '→', _session.id);
    return entry;
  }

  // -------------------------------------------------------
  // Hooks installieren
  // -------------------------------------------------------

  function _installHooks() {
    // --- Aufmaß ---
    // `aufmass.js` meldet sich selbst über recordMeasurement(), sobald eine
    // Messung abgeschlossen ist — es gibt hier nichts zu umwickeln. Der
    // Vorgänger musste `MeasurementV4.save` überschreiben und 150 ms später
    // nachsehen, was dabei herausgekommen war; ein Umweg, der nur nötig war,
    // weil das Speichern dort nichts zurückgab.

    // --- BCF Storage hook ---
    if (window.BIM_BCF_Storage) {
      var origSaveTopic = BIM_BCF_Storage.saveTopic;
      BIM_BCF_Storage.saveTopic = async function (topicData) {
        var result = await origSaveTopic.call(BIM_BCF_Storage, topicData);
        recordBcfTopic(result);
        return result;
      };
    }

    console.log('[SessionContainer] ✅ Hooks installiert für Session:', _session.id);
  }

  // -------------------------------------------------------
  // Markdown Export
  // -------------------------------------------------------

  function _buildMarkdown() {
    var lines = [];
    var d = new Date(_session.startedAt);

    lines.push('# iLEEN Session Report');
    lines.push('');
    lines.push('| | |');
    lines.push('|---|---|');
    lines.push('| **Session-ID** | `' + _session.id + '` |');
    lines.push('| **UUID** | `' + _session.uuid + '` |');
    lines.push('| **Gestartet** | ' + d.toLocaleString('de-DE') + ' |');
    lines.push('| **Benutzer** | ' + (_session.user || 'Anonym') + ' |');
    lines.push('| **Messungen** | ' + _session.measurements.length + ' |');
    lines.push('| **BCF-Topics** | ' + _session.bcfTopics.length + ' |');
    lines.push('');

    // --- Messungen ---
    if (_session.measurements.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('## 📏 Messungen');
      lines.push('');

      _session.measurements.forEach(function (m, i) {
        var ts = new Date(m.timestamp).toLocaleString('de-DE');
        lines.push('### ' + (i + 1) + '. ' + (m.label || m.type));
        lines.push('');
        lines.push('| Feld | Wert |');
        lines.push('|---|---|');
        lines.push('| **Typ** | ' + m.type + ' |');
        lines.push('| **Zeitstempel** | ' + ts + ' |');
        lines.push('| **ID** | `' + m.id + '` |');

        // Ergebnisse
        if (m.results) {
          Object.keys(m.results).forEach(function (k) {
            var v = m.results[k];
            if (typeof v === 'number') {
              v = v.toFixed(4);
            }
            lines.push('| **' + k + '** | ' + v + ' |');
          });
        }

        // Positionen
        if (m.positions && m.positions.length > 0) {
          lines.push('');
          lines.push('**Positionen:**');
          lines.push('');
          lines.push('| # | Lon | Lat | Höhe (m) |');
          lines.push('|---|---|---|---|');
          m.positions.forEach(function (p, pi) {
            var lon = p.lon !== undefined ? p.lon.toFixed(7) : (p.longitude || '—');
            var lat = p.lat !== undefined ? p.lat.toFixed(7) : (p.latitude || '—');
            var h   = p.height !== undefined ? p.height.toFixed(2) : '—';
            lines.push('| ' + (pi + 1) + ' | ' + lon + ' | ' + lat + ' | ' + h + ' |');
          });
        }

        lines.push('');
      });
    }

    // --- BCF Topics ---
    if (_session.bcfTopics.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('## 🏷️ BCF Issues');
      lines.push('');

      _session.bcfTopics.forEach(function (t, i) {
        var ts = new Date(t.timestamp).toLocaleString('de-DE');
        lines.push('### Issue ' + (i + 1) + ': ' + (t.title || 'Ohne Titel'));
        lines.push('');
        lines.push('| Feld | Wert |');
        lines.push('|---|---|');
        lines.push('| **GUID** | `' + t.guid + '` |');
        lines.push('| **Typ** | ' + t.type + ' |');
        lines.push('| **Status** | ' + t.status + ' |');
        lines.push('| **Priorität** | ' + t.priority + ' |');
        lines.push('| **Erstellt** | ' + ts + ' |');
        lines.push('| **Autor** | ' + (t.author || '—') + ' |');
        if (t.description) {
          lines.push('');
          lines.push('**Beschreibung:** ' + t.description);
        }
        lines.push('');
      });
    }

    lines.push('---');
    lines.push('');
    lines.push('*Exportiert von iLEEN — ' + new Date().toLocaleString('de-DE') + '*');
    lines.push('');

    return lines.join('\n');
  }

  // -------------------------------------------------------
  // BCF-ZIP Export (alle Topics der Session)
  // -------------------------------------------------------

  async function _buildBcfZip() {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip nicht geladen');
    }

    var zip = new JSZip();

    // bcf.version
    zip.file('bcf.version',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Version VersionId="2.1">\n' +
      '  <DetailedVersion>2.1</DetailedVersion>\n' +
      '</Version>'
    );

    function escXml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    // BCF-Topics aus BCF Storage
    _session.bcfTopics.forEach(function (t) {
      var folder = zip.folder(t.guid);
      var iso = new Date(t.timestamp).toISOString();
      var commentGuid = generateUUID();

      folder.file('markup.bcf',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        '  <Topic Guid="' + t.guid + '" TopicType="' + escXml(t.type) + '" TopicStatus="' + escXml(t.status) + '">\n' +
        '    <Title>' + escXml(t.title) + '</Title>\n' +
        '    <Priority>' + escXml(t.priority) + '</Priority>\n' +
        '    <CreationDate>' + iso + '</CreationDate>\n' +
        '    <CreationAuthor>' + escXml(t.author || 'Unknown') + '</CreationAuthor>\n' +
        '    <Description>' + escXml(t.description) + '</Description>\n' +
        '  </Topic>\n' +
        '  <Comment Guid="' + commentGuid + '">\n' +
        '    <Date>' + iso + '</Date>\n' +
        '    <Author>' + escXml(t.author || 'Unknown') + '</Author>\n' +
        '    <Comment>' + escXml(t.description || t.title) + '</Comment>\n' +
        '  </Comment>\n' +
        '</Markup>'
      );
    });

    // Messungen als BCF Topics (ohne Viewpoint)
    _session.measurements.forEach(function (m) {
      var topicGuid = m.id || generateUUID();
      var commentGuid = generateUUID();
      var folder = zip.folder(topicGuid);
      var iso = new Date(m.timestamp).toISOString();
      var title = 'Messung: ' + (m.label || m.type);
      var desc = 'Typ: ' + m.type + '\nErgebnis: ' + m.label;

      if (m.results) {
        Object.keys(m.results).forEach(function (k) {
          var v = m.results[k];
          desc += '\n' + k + ': ' + (typeof v === 'number' ? v.toFixed(4) : v);
        });
      }

      folder.file('markup.bcf',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
        '  <Topic Guid="' + topicGuid + '" TopicType="Measurement" TopicStatus="Closed">\n' +
        '    <Title>' + escXml(title) + '</Title>\n' +
        '    <CreationDate>' + iso + '</CreationDate>\n' +
        '    <CreationAuthor>' + escXml(m.user || 'Unknown') + '</CreationAuthor>\n' +
        '    <Description>' + escXml(desc) + '</Description>\n' +
        '  </Topic>\n' +
        '  <Comment Guid="' + commentGuid + '">\n' +
        '    <Date>' + iso + '</Date>\n' +
        '    <Author>' + escXml(m.user || 'Unknown') + '</Author>\n' +
        '    <Comment>' + escXml(title) + '</Comment>\n' +
        '  </Comment>\n' +
        '</Markup>'
      );
    });

    return await zip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' });
  }

  // -------------------------------------------------------
  // Download-Trigger
  // -------------------------------------------------------

  function _downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function _downloadText(text, filename, mimeType) {
    _downloadBlob(new Blob([text], { type: mimeType || 'text/plain' }), filename);
  }

  // -------------------------------------------------------
  // Export an Backend senden + Download auslösen
  // -------------------------------------------------------

  async function exportMarkdown() {
    var md = _buildMarkdown();
    var filename = safeFilename(_session.id) + '.md';

    // Backend: Datei speichern
    try {
      await fetch(_apiBase + '/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: _session.id,
          filename: filename,
          type: 'markdown',
          content: md
        })
      });
    } catch (e) {
      console.warn('[SessionContainer] MD-Export-Backend nicht erreichbar, nur Download.');
    }

    // Browser-Download
    _downloadText(md, filename, 'text/markdown');

    if (window.BimViewer && BimViewer.updateStatus) {
      BimViewer.updateStatus('📋 Markdown exportiert: ' + filename, 'success');
    }
    console.log('[SessionContainer] 📋 Markdown exportiert:', filename);
  }

  async function exportBcf() {
    var filename = safeFilename(_session.id) + '.bcf';

    var blob;
    try {
      blob = await _buildBcfZip();
    } catch (e) {
      console.error('[SessionContainer] BCF-Aufbau fehlgeschlagen:', e);
      if (window.BimViewer && BimViewer.updateStatus) {
        BimViewer.updateStatus('BCF-Export fehlgeschlagen: ' + e.message, 'error');
      }
      return;
    }

    // Backend: Datei speichern (binär via base64)
    try {
      var reader = new FileReader();
      reader.onload = async function () {
        var base64 = reader.result.split(',')[1];
        await fetch(_apiBase + '/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: _session.id,
            filename: filename,
            type: 'bcf',
            contentBase64: base64
          })
        });
      };
      reader.readAsDataURL(blob);
    } catch (e) {
      console.warn('[SessionContainer] BCF-Export-Backend nicht erreichbar, nur Download.');
    }

    // Browser-Download
    _downloadBlob(blob, filename);

    if (window.BimViewer && BimViewer.updateStatus) {
      BimViewer.updateStatus('🏷️ BCF exportiert: ' + filename, 'success');
    }
    console.log('[SessionContainer] 🏷️ BCF exportiert:', filename);
  }

  async function exportBoth() {
    await exportMarkdown();
    await exportBcf();
  }

  // -------------------------------------------------------
  // UI — Session-Panel im Measurements-Tab
  // -------------------------------------------------------

  function _renderSessionPanel() {
    var container = document.getElementById('ileen-session-panel');
    if (!container) return;

    var mCount = _session.measurements.length;
    var bCount = _session.bcfTopics.length;
    var total = mCount + bCount;

    // Badge aktualisieren
    var badge = document.getElementById('ileen-session-badge');
    if (badge) {
      badge.textContent = total;
      badge.style.display = total > 0 ? 'inline-flex' : 'none';
    }

    // Liste rendern
    var list = document.getElementById('ileen-session-list');
    if (!list) return;

    if (total === 0) {
      list.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,.25);font-size:11px;padding:10px 0;">Noch keine Einträge</div>';
      return;
    }

    var allEntries = [];

    _session.measurements.forEach(function (m) {
      allEntries.push({ kind: 'measurement', ts: m.timestamp, label: m.label || m.type, type: m.type });
    });
    _session.bcfTopics.forEach(function (t) {
      allEntries.push({ kind: 'bcf_topic', ts: t.timestamp, label: t.title, type: t.type });
    });

    // Zeitlich sortieren (neueste zuerst)
    allEntries.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });

    var ICONS = { measurement: '📏', bcf_topic: '🏷️' };
    var html = '';
    allEntries.slice(0, 20).forEach(function (e) {
      var time = new Date(e.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      html +=
        '<div style="display:flex;align-items:center;gap:7px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05);">' +
          '<span style="font-size:14px;">' + (ICONS[e.kind] || '📌') + '</span>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:11px;color:rgba(255,255,255,.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (e.label || '—') + '</div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,.35);">' + time + '</div>' +
          '</div>' +
        '</div>';
    });
    if (allEntries.length > 20) {
      html += '<div style="text-align:center;font-size:10px;color:rgba(255,255,255,.3);padding:4px 0;">+ ' + (allEntries.length - 20) + ' weitere</div>';
    }

    list.innerHTML = html;
  }

  /**
   * Erzeugt das Session-Panel HTML (wird in ui.js eingebunden).
   */
  function getSessionPanelHTML() {
    return (
      '<div id="ileen-session-panel" style="margin-top:14px;border-top:1px solid rgba(255,255,255,.08);padding-top:12px;">' +

        // Header
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<span style="font-size:11px;font-weight:700;letter-spacing:.5px;color:rgba(255,255,255,.5);text-transform:uppercase;">📁 Session</span>' +
            '<span id="ileen-session-badge" style="display:none;background:rgba(151,191,13,.2);color:#97BF0D;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;min-width:18px;text-align:center;"></span>' +
          '</div>' +
          '<span style="font-size:9px;color:rgba(255,255,255,.2);font-family:monospace;" title="Session-ID">' +
            '<span id="ileen-session-id-label"></span>' +
          '</span>' +
        '</div>' +

        // Eintrags-Liste
        '<div id="ileen-session-list" style="max-height:180px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent;margin-bottom:10px;">' +
          '<div style="text-align:center;color:rgba(255,255,255,.25);font-size:11px;padding:10px 0;">Noch keine Einträge</div>' +
        '</div>' +

        // Export-Buttons
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">' +
          '<button onclick="ILEEN_SESSION.exportMarkdown()" ' +
            'style="padding:7px 4px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#c8e6c9;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;" ' +
            'onmouseenter="this.style.background=\'rgba(255,255,255,.12)\'" onmouseleave="this.style.background=\'rgba(255,255,255,.06)\'">' +
            '📋 Export .md' +
          '</button>' +
          '<button onclick="ILEEN_SESSION.exportBcf()" ' +
            'style="padding:7px 4px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#b3e5fc;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;" ' +
            'onmouseenter="this.style.background=\'rgba(255,255,255,.12)\'" onmouseleave="this.style.background=\'rgba(255,255,255,.06)\'">' +
            '🏷️ Export .bcf' +
          '</button>' +
        '</div>' +

        '<button onclick="ILEEN_SESSION.exportBoth()" ' +
          'style="width:100%;padding:8px;background:linear-gradient(135deg,rgba(151,191,13,.15),rgba(79,172,254,.15));border:1px solid rgba(151,191,13,.3);border-radius:8px;color:#97BF0D;font-size:11px;font-weight:700;cursor:pointer;transition:all .15s;" ' +
          'onmouseenter="this.style.background=\'linear-gradient(135deg,rgba(151,191,13,.25),rgba(79,172,254,.25))\'" onmouseleave="this.style.background=\'linear-gradient(135deg,rgba(151,191,13,.15),rgba(79,172,254,.15))\'">' +
          '⬇️ Beides exportieren (.md + .bcf)' +
        '</button>' +

      '</div>'
    );
  }

  // -------------------------------------------------------
  // Init
  // -------------------------------------------------------

  function init() {
    // Die App hat keine Anmeldung; ein Name kann lokal hinterlegt sein
    try { _session.user = localStorage.getItem('ileen_autor') || null; } catch (e) { /* privates Fenster */ }

    // Session-Start ins Backend loggen
    _logSessionStart();

    // Hooks installieren (mit Retry falls Module noch nicht geladen)
    _installHooks();
    setTimeout(_installHooks, 1500);
    setTimeout(_installHooks, 4000);

    // Session-Label ins Panel schreiben sobald DOM bereit
    var _setLabel = function () {
      var el = document.getElementById('ileen-session-id-label');
      if (el) {
        el.textContent = _session.id.replace('session_', '').substring(0, 16);
        el.title = _session.id;
      }
    };
    setTimeout(_setLabel, 500);
    setTimeout(_setLabel, 2000);

    console.log('[SessionContainer] 🚀 Session gestartet:', _session.id);
    console.log('[SessionContainer] UUID:', _session.uuid);
  }

  // -------------------------------------------------------
  // Öffentliches API
  // -------------------------------------------------------

  return {
    init: init,
    getSession: function () { return _session; },
    recordMeasurement: recordMeasurement,
    recordBcfTopic: recordBcfTopic,
    exportMarkdown: exportMarkdown,
    exportBcf: exportBcf,
    exportBoth: exportBoth,
    getSessionPanelHTML: getSessionPanelHTML
  };

})();

// Auto-Init
(function () {
  var doInit = function () { ILEEN_SESSION.init(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', doInit);
  } else {
    doInit();
  }
})();

console.log('✅ Session Container Module v1.0 geladen');
