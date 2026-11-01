// iLEEN — fehlende Vektorkacheln als leere Kachel ausliefern
// © 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// tippecanoe schreibt nur Kacheln, in denen etwas liegt. Fragt Cesium eine
// leere an, beantwortet Vite sie mit index.html (SPA-Rückfall, HTTP 200) —
// der MVT-Leser scheitert daran und meldet jede leere Kachel als Fehler.
// Eine Kachel ohne Bytes ist dagegen ein gültiges, leeres Vector Tile.

import fs from 'node:fs';
import path from 'node:path';

export function leereKachelnPlugin(praefix = '/data/zwilling/kacheln/') {
  return {
    name: 'ileen-leere-kacheln',
    configureServer(server) {
      const wurzel = server.config.root;
      server.middlewares.use((req, res, next) => {
        const pfad = (req.url || '').split('?')[0];
        if (!pfad.startsWith(praefix) || !pfad.endsWith('.pbf')) return next();
        const datei = path.join(wurzel, decodeURIComponent(pfad));
        if (fs.existsSync(datei)) return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-protobuf');
        res.setHeader('Cache-Control', 'max-age=3600');
        res.end();
      });
    },
  };
}
