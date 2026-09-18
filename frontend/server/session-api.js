/**
 * iLEEN — Session Store API v1.0
 * Backend-Handler für Session-Logs, Export-Dateien und die fortschreibende Datenbank
 *
 * Kann als:
 *   A) Vite-Dev-Plugin (via vite.config.js)  ← Standardweg
 *   B) Eigenständiger Express-Server (node server/session-api.js)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// issues/ liegt eine Ebene über dem server/-Ordner (also in cesium-viewer/issues/)
const ISSUES_DIR = path.resolve(__dirname, '..', 'issues');
const SESSIONS_DIR = path.join(ISSUES_DIR, 'sessions');
const EXPORTS_DIR = path.join(ISSUES_DIR, 'exports');
const DATABASE_FILE = path.join(ISSUES_DIR, 'database.ndjson');

// -------------------------------------------------------
// Verzeichnisse initialisieren
// -------------------------------------------------------

function ensureDirs() {
  [ISSUES_DIR, SESSIONS_DIR, EXPORTS_DIR].forEach(function (dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log('[SessionAPI] Verzeichnis angelegt:', dir);
    }
  });
  // Datenbank-Datei anlegen falls nicht vorhanden
  if (!fs.existsSync(DATABASE_FILE)) {
    fs.writeFileSync(DATABASE_FILE, '', 'utf8');
    console.log('[SessionAPI] Datenbank angelegt:', DATABASE_FILE);
  }
}

// -------------------------------------------------------
// NDJSON append (atomarer Zeilenappend)
// -------------------------------------------------------

function appendNDJSON(filePath, obj) {
  const line = JSON.stringify(obj) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

// -------------------------------------------------------
// Request-Body lesen (für nativen Node http)
// -------------------------------------------------------

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Ungültiges JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

// -------------------------------------------------------
// Antwort-Helper
// -------------------------------------------------------

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

// -------------------------------------------------------
// Route-Handler
// -------------------------------------------------------

/**
 * POST /api/sessions/start
 * Loggt den Session-Start und legt die Session-Datei an.
 */
async function handleStart(req, res) {
  try {
    const body = await readBody(req);
    const { sessionId, sessionUUID, startedAt, user, userAgent } = body;

    if (!sessionId) {
      return json(res, 400, { error: 'sessionId fehlt' });
    }

    ensureDirs();

    const record = {
      kind: 'session_start',
      sessionId,
      sessionUUID,
      startedAt: startedAt || new Date().toISOString(),
      user: user || null,
      userAgent: userAgent || null,
      _logged: new Date().toISOString()
    };

    // Session-Datei anlegen
    const sessionFile = path.join(SESSIONS_DIR, sessionId + '.ndjson');
    appendNDJSON(sessionFile, record);

    // Globale Datenbank
    appendNDJSON(DATABASE_FILE, record);

    console.log('[SessionAPI] 🚀 Session gestartet:', sessionId);
    json(res, 200, { ok: true, sessionId, file: sessionFile });

  } catch (e) {
    console.error('[SessionAPI] /start Fehler:', e.message);
    json(res, 500, { error: e.message });
  }
}

/**
 * POST /api/sessions/log
 * Schreibt einen einzelnen Eintrag (Messung oder BCF-Topic) sofort.
 */
async function handleLog(req, res) {
  try {
    const body = await readBody(req);
    const { sessionId, sessionUUID, entry } = body;

    if (!sessionId || !entry) {
      return json(res, 400, { error: 'sessionId und entry erforderlich' });
    }

    ensureDirs();

    const record = {
      ...entry,
      sessionId,
      sessionUUID: sessionUUID || null,
      _logged: new Date().toISOString()
    };

    // Session-Log (append)
    const sessionFile = path.join(SESSIONS_DIR, sessionId + '.ndjson');
    appendNDJSON(sessionFile, record);

    // Globale fortschreibende Datenbank (append)
    appendNDJSON(DATABASE_FILE, record);

    const kind = entry.kind || 'unknown';
    const label = entry.label || entry.title || entry.type || '—';
    console.log('[SessionAPI] 📝 Eintrag geloggt:', kind, '|', label, '→', sessionId);

    json(res, 200, { ok: true, logged: kind });

  } catch (e) {
    console.error('[SessionAPI] /log Fehler:', e.message);
    json(res, 500, { error: e.message });
  }
}

/**
 * POST /api/sessions/export
 * Speichert eine exportierte Datei (.md oder .bcf) im exports/-Ordner.
 */
async function handleExport(req, res) {
  try {
    const body = await readBody(req);
    const { sessionId, filename, type, content, contentBase64 } = body;

    if (!sessionId || !filename) {
      return json(res, 400, { error: 'sessionId und filename erforderlich' });
    }

    // Sicherheit: Pfad-Traversal verhindern
    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const exportPath = path.join(EXPORTS_DIR, safeFilename);

    ensureDirs();

    if (type === 'bcf' && contentBase64) {
      // Binär-Datei (BCF = ZIP)
      const buffer = Buffer.from(contentBase64, 'base64');
      fs.writeFileSync(exportPath, buffer);
    } else if (content) {
      // Text-Datei (.md)
      fs.writeFileSync(exportPath, content, 'utf8');
    } else {
      return json(res, 400, { error: 'content oder contentBase64 erforderlich' });
    }

    // Export-Ereignis in Datenbank schreiben
    appendNDJSON(DATABASE_FILE, {
      kind: 'export',
      sessionId,
      filename: safeFilename,
      type: type || 'unknown',
      exportedAt: new Date().toISOString()
    });

    console.log('[SessionAPI] 💾 Export gespeichert:', exportPath);
    json(res, 200, { ok: true, path: exportPath });

  } catch (e) {
    console.error('[SessionAPI] /export Fehler:', e.message);
    json(res, 500, { error: e.message });
  }
}

/**
 * POST /api/clash
 * Führt die IFC-Kollisionsprüfung auf dem Server aus (via IfcOpenShell).
 */
async function handleClash(req, res) {
  try {
    const body = await readBody(req);
    const { modelA, modelB } = body;

    if (!modelA || !modelB) {
      return json(res, 400, { error: 'Zwei Modelle (modelA, modelB) erforderlich' });
    }

    // Sicherheit: Pfad-Traversal verhindern & absolute Pfade auflösen
    const safeA = path.join(__dirname, '..', modelA.replace(/\.\./g, ''));
    const safeB = path.join(__dirname, '..', modelB.replace(/\.\./g, ''));

    const pythonScript = path.join(__dirname, '..', 'ifclash', 'ifclash', 'run_clash_api.py');
    const command = `python3 "${pythonScript}" "${safeA}" "${safeB}"`;

    console.log('[ClashAPI] ⚔️ Starte Kollisionsprüfung:', modelA, '↔', modelB);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('[ClashAPI] Fehler:', error.message);
        return json(res, 500, { error: 'Kollisionsprüfung fehlgeschlagen', details: error.message });
      }

      try {
        const result = JSON.parse(stdout);
        json(res, 200, result);
      } catch (parseError) {
        console.error('[ClashAPI] Parsing-Fehler:', parseError, stdout);
        json(res, 500, { error: 'Ungültige Antwort vom Clash-Skript', stdout });
      }
    });

  } catch (e) {
    console.error('[ClashAPI] /clash Fehler:', e.message);
    json(res, 500, { error: e.message });
  }
}

/**
 * GET /api/sessions
 * Listet alle Session-Dateien auf.
 */
function handleListSessions(req, res) {
  try {
    ensureDirs();
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.ndjson'))
      .sort()
      .reverse();

    const sessions = files.map(function (f) {
      const sessionId = f.replace('.ndjson', '');
      const filePath = path.join(SESSIONS_DIR, f);
      const stat = fs.statSync(filePath);
      // Ersten Eintrag (session_start) lesen
      let meta = {};
      try {
        const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
        if (firstLine) meta = JSON.parse(firstLine);
      } catch (e) { }

      return {
        sessionId,
        file: f,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        user: meta.user || null,
        startedAt: meta.startedAt || null
      };
    });

    json(res, 200, { sessions, count: sessions.length });

  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

/**
 * GET /api/sessions/:sessionId
 * Gibt alle Einträge einer Session zurück.
 */
function handleGetSession(req, res, sessionId) {
  try {
    const sessionFile = path.join(SESSIONS_DIR, sessionId + '.ndjson');
    if (!fs.existsSync(sessionFile)) {
      return json(res, 404, { error: 'Session nicht gefunden: ' + sessionId });
    }

    const lines = fs.readFileSync(sessionFile, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));

    json(res, 200, { sessionId, entries: lines, count: lines.length });

  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

/**
 * GET /api/sessions/database
 * Gibt die gesamte fortschreibende Datenbank zurück.
 */
function handleGetDatabase(req, res) {
  try {
    ensureDirs();
    if (!fs.existsSync(DATABASE_FILE)) {
      return json(res, 200, { entries: [], count: 0 });
    }

    const entries = fs.readFileSync(DATABASE_FILE, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => {
        try { return JSON.parse(l); }
        catch (e) { return null; }
      })
      .filter(Boolean);

    json(res, 200, { entries, count: entries.length, file: DATABASE_FILE });

  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

// -------------------------------------------------------
// Zentraler Request-Router
// -------------------------------------------------------

export async function handleRequest(req, res) {
  const url = req.url || '';
  const method = req.method || 'GET';

  // CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // Routen
  if (method === 'POST' && url.startsWith('/api/sessions/start')) {
    return handleStart(req, res);
  }
  if (method === 'POST' && url.startsWith('/api/sessions/log')) {
    return handleLog(req, res);
  }
  if (method === 'POST' && url.startsWith('/api/sessions/export')) {
    return handleExport(req, res);
  }
  if (method === 'POST' && url.startsWith('/api/clash')) {
    return handleClash(req, res);
  }
  if (method === 'GET' && url.startsWith('/api/sessions/database')) {
    return handleGetDatabase(req, res);
  }
  if (method === 'GET' && url.match(/^\/api\/sessions\/([^/?]+)/)) {
    const sessionId = url.match(/^\/api\/sessions\/([^/?]+)/)[1];
    return handleGetSession(req, res, sessionId);
  }
  if (method === 'GET' && url.startsWith('/api/sessions')) {
    return handleListSessions(req, res);
  }

  // Keine Route gefunden
  json(res, 404, { error: 'Unbekannte Route: ' + method + ' ' + url });
}

// -------------------------------------------------------
// Als Vite-Plugin exportieren
// -------------------------------------------------------

export function sessionApiPlugin() {
  return {
    name: 'ileen-session-api',
    configureServer(server) {
      server.middlewares.use(async function (req, res, next) {
        if (req.url && req.url.startsWith('/api/sessions')) {
          return handleRequest(req, res);
        }
        next();
      });
      console.log('[SessionAPI] ✅ Vite-Middleware registriert → /api/sessions/*');
    }
  };
}

// -------------------------------------------------------
// Als eigenständiger Express-kompatibler Server
// (node server/session-api.js  oder  node server/standalone.js)
// -------------------------------------------------------

// Wenn direkt ausgeführt: HTTP-Server starten
if (process.argv[1] && process.argv[1].endsWith('session-api.js')) {
  const http = await import('http');
  const PORT = process.env.SESSION_API_PORT || 3001;

  ensureDirs();
  const server = http.default.createServer(async function (req, res) {
    // Nur /api/sessions-Routen
    if (req.url && req.url.startsWith('/api/sessions')) {
      return handleRequest(req, res);
    }
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, function () {
    console.log('[SessionAPI] 🚀 Standalone-Server läuft auf Port', PORT);
    console.log('[SessionAPI] Issues-Ordner:', ISSUES_DIR);
    console.log('[SessionAPI] Datenbank:', DATABASE_FILE);
  });
}
