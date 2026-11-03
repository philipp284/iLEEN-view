"""
Prüfstein für den HTTP-Kopf der Kacheln (tiling/http_kopf.py und api/routes/tiles.py) —
ohne MinIO, ohne Container.

Warum es das gibt: Kacheln und tileset.json gingen ohne Cache-Control, ETag und
Last-Modified hinaus. Der Browser konnte sie nicht aus seinem HTTP-Cache holen; jede vom
Kachelspeicher der VR-Seite verworfene Kachel kam neu übers WLAN (Campus-Modell: 410 MB).

Geprüft wird, was dabei leicht falsch wird: dass Dinge, die sich ändern (Wurzel-tileset.json,
placement.json), nicht für einen Tag zwischengespeichert werden; dass 304 keinen Körper hat und
die Verbindung trotzdem freigegeben wird; dass nur JSON gezippt wird; und dass die Route mit
einer MinIO-Attrappe wirklich so antwortet.

    python3 tests/test_tiles_kopf.py
"""

import gzip
import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

geprueft = 0
fehler = 0


def ok(bed, name, hinweis=""):
    global geprueft, fehler
    geprueft += 1
    if not bed:
        fehler += 1
        print("  ✗", name, hinweis)


from tiling import http_kopf as h  # noqa: E402

# ── 1. Welche Regel für welches Objekt ──────────────────────────────────────
ETAG = {"ETag": '"abc123"', "Last-Modified": "Sat, 24 Oct 2026 10:00:00 GMT"}

st, k = h.cache_kopf("job/tile_3.b3dm", ETAG, {})
ok(st == 200, "Kachel: 200 ohne If-None-Match")
ok(k["Cache-Control"] == "public, max-age=86400", "Kachel: ein Tag", k.get("Cache-Control"))
ok(k["ETag"] == '"abc123"' and k["Last-Modified"].startswith("Sat"), "ETag und Last-Modified durchgereicht")
ok("Vary" not in k, "Kachel: kein Vary (wird nicht gezippt)")

for n in ("job/a.glb", "job/b.pnts", "job/c.png", "job/d.jpg", "job/e.bin", "job/f.cmpt"):
    ok(h.cache_kopf(n, ETAG, {})[1]["Cache-Control"].startswith("public"), f"{n}: zwischenspeicherbar")

st, k = h.cache_kopf("job/tileset.json", ETAG, {})
ok(k["Cache-Control"] == "no-cache", "Wurzel-tileset.json: immer fragen (ändert sich beim Verorten)")
ok(k["Vary"] == "Accept-Encoding", "JSON variiert mit der Kodierung")
ok(h.cache_kopf("tileset.json", ETAG, {})[1]["Cache-Control"] == "no-cache", "auch ohne Job-Präfix")

for n in ("job/placement.json", "job/meta.json", "job/materials.json", "job/material_overrides.json"):
    ok(h.cache_kopf(n, ETAG, {})[1]["Cache-Control"] == "no-cache", f"{n}: ändert sich → immer fragen")

ok(h.cache_kopf("job/tileset.12.json", ETAG, {})[1]["Cache-Control"] == "public, max-age=86400",
   "Unter-Tileset (py3dtiles) gehört zum Lauf und ändert sich nicht")
ok(h.cache_kopf("job/sub/tileset.7.json", ETAG, {})[1]["Cache-Control"].startswith("public"), "auch in Unterordnern")
ok(h.cache_kopf("job/tileset.json", ETAG, {})[1]["Cache-Control"] == "no-cache",
   "das Wurzel-tileset.json bleibt trotz Unter-Tileset-Regel no-cache")

# ── 2. Validierung ─────────────────────────────────────────────────────────
ok(h.cache_kopf("job/t.b3dm", ETAG, {"If-None-Match": '"abc123"'})[0] == 304, "gleicher ETag → 304")
ok(h.cache_kopf("job/t.b3dm", ETAG, {"if-none-match": '"abc123"'})[0] == 304, "Kopfname egal ob groß oder klein")
ok(h.cache_kopf("job/t.b3dm", ETAG, {"If-None-Match": '"anderer"'})[0] == 200, "anderer ETag → 200")
ok(h.cache_kopf("job/t.b3dm", ETAG, {"If-None-Match": 'W/"abc123"'})[0] == 304, "schwacher Validator zählt")
ok(h.cache_kopf("job/t.b3dm", ETAG, {"If-None-Match": '"x", "abc123", "y"'})[0] == 304, "Liste von Validatoren")
ok(h.cache_kopf("job/t.b3dm", ETAG, {"If-None-Match": "*"})[0] == 304, "* passt auf alles")
ok(h.cache_kopf("job/t.b3dm", {}, {"If-None-Match": '"abc123"'})[0] == 200, "ohne ETag der Quelle nie 304")
ok(h.cache_kopf("job/t.b3dm", {"etag": "abc123"}, {"If-None-Match": '"abc123"'})[0] == 304,
   "ETag ohne Anführungszeichen (MinIO liefert beides) und kleiner Kopfname")
ok(h.cache_kopf("job/t.b3dm", ETAG, {"If-None-Match": '"abc1234"'})[0] == 200, "Präfix eines ETag ist kein ETag")
st, k = h.cache_kopf("job/t.b3dm", ETAG, {"If-None-Match": '"abc123"'})
ok(k["Cache-Control"] and k["ETag"], "auch ein 304 trägt Cache-Control und ETag (sonst verlängert er nichts)")

# ── 3. Kompression ─────────────────────────────────────────────────────────
ok(h.akzeptiert_gzip("gzip, deflate, br"), "Accept-Encoding mit gzip")
ok(h.akzeptiert_gzip("br;q=1.0, gzip;q=0.8"), "mit q-Wert")
ok(not h.akzeptiert_gzip("gzip;q=0"), "q=0 heißt nein")
ok(not h.akzeptiert_gzip("br, deflate"), "ohne gzip")
ok(not h.akzeptiert_gzip(None) and not h.akzeptiert_gzip(""), "ohne Angabe")

gz = {"Accept-Encoding": "gzip"}
ok(h.json_zippen("job/tileset.json", 400_000, gz), "tileset.json wird gezippt")
ok(h.json_zippen("job/placement.json", 5_000, gz), "auch andere JSON")
ok(not h.json_zippen("job/tile.b3dm", 400_000, gz), "Kacheln nie (kaum komprimierbar)")
ok(not h.json_zippen("job/tileset.json", 400_000, {}), "ohne Accept-Encoding nicht")
ok(not h.json_zippen("job/tileset.json", 200, gz), "winzige Dateien lohnen nicht")
ok(not h.json_zippen("job/tileset.json", 100 * 1024 * 1024, gz), "riesige werden gestreamt statt im Speicher gezippt")
ok(not h.json_zippen("job/tileset.json", None, gz), "ohne bekannte Größe nicht")

roh = json.dumps({"root": {"children": [{"geometricError": 1.5, "content": {"uri": f"t_{i}.b3dm"}} for i in range(3000)]}}).encode()
z = h.zippen(roh)
ok(gzip.decompress(z) == roh, "Rundlauf gzip")
ok(len(z) < len(roh) / 8, f"tileset-artiges JSON schrumpft über 8:1 ({len(roh)} → {len(z)})")
ok(h.zippen(roh) == z, "deterministisch (mtime 0): derselbe Körper, derselbe ETag-Sinn")

# ── 4. Die Route, mit einer MinIO-Attrappe ─────────────────────────────────
try:
    import httpx  # noqa: F401
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    route_geht = True
except Exception as e:  # noqa: BLE001
    print("  (Routen-Teil übersprungen:", e, ")")
    route_geht = False

if route_geht:
    class S3Error(Exception):
        def __init__(self, code):
            super().__init__(code)
            self.code = code

    class Antwort:
        def __init__(self, daten, kopf):
            self._d = daten
            self.headers = kopf
            self.geschlossen = False
            self.freigegeben = False

        def stream(self, n):
            for i in range(0, len(self._d), n):
                yield self._d[i:i + n]

        def read(self):
            return self._d

        def close(self):
            self.geschlossen = True

        def release_conn(self):
            self.freigegeben = True

    OBJEKTE = {}
    LETZTE = []

    class Minio:
        def get_object(self, bucket, name):
            if name not in OBJEKTE:
                raise S3Error("NoSuchKey")
            daten, etag = OBJEKTE[name]
            a = Antwort(daten, {"Content-Length": str(len(daten)), "ETag": f'"{etag}"',
                                "Last-Modified": "Sat, 24 Oct 2026 10:00:00 GMT"})
            LETZTE.append(a)
            return a

    minio_modul = types.ModuleType("minio")
    minio_fehler = types.ModuleType("minio.error")
    minio_fehler.S3Error = S3Error
    minio_modul.error = minio_fehler
    speicher = types.ModuleType("storage")
    speicher_minio = types.ModuleType("storage.minio_client")
    speicher_minio.get_minio = lambda: Minio()
    speicher.minio_client = speicher_minio
    sys.modules.update({"minio": minio_modul, "minio.error": minio_fehler,
                        "storage": speicher, "storage.minio_client": speicher_minio})

    from api.routes import tiles  # noqa: E402

    app = FastAPI()
    app.include_router(tiles.router, prefix="/tiles")
    c = TestClient(app)

    OBJEKTE["j/tile_1.b3dm"] = (b"b3dm" + bytes(range(256)) * 20, "e1")
    OBJEKTE["j/tileset.json"] = (roh, "e2")
    OBJEKTE["j/placement.json"] = (b'{"lon": 8}' * 200, "e3")
    OBJEKTE["j/tileset.3.json"] = (roh, "e4")

    r = c.get("/tiles/j/tile_1.b3dm")
    ok(r.status_code == 200 and r.content == OBJEKTE["j/tile_1.b3dm"][0], "Kachel kommt unverändert an")
    ok(r.headers["cache-control"] == "public, max-age=86400" and r.headers["etag"] == '"e1"', "Kachel mit Cache-Kopf",
       str(dict(r.headers)))
    ok(r.headers["content-type"] == "application/octet-stream", "Medientyp bleibt")
    ok(r.headers.get("content-length") == str(len(OBJEKTE["j/tile_1.b3dm"][0])), "Content-Length bleibt")
    ok("content-encoding" not in r.headers, "Kachel nicht gezippt")
    ok(LETZTE[-1].geschlossen and LETZTE[-1].freigegeben, "Verbindung nach dem Streamen freigegeben")

    r = c.get("/tiles/j/tile_1.b3dm", headers={"If-None-Match": '"e1"'})
    ok(r.status_code == 304 and r.content == b"", "gleicher ETag → 304 ohne Körper")
    ok(LETZTE[-1].geschlossen and LETZTE[-1].freigegeben, "auch bei 304 wird die Verbindung freigegeben (sonst läuft der Pool voll)")
    ok(r.headers["cache-control"].startswith("public"), "304 trägt den Cache-Kopf")
    r = c.get("/tiles/j/tile_1.b3dm", headers={"If-None-Match": '"alt"'})
    ok(r.status_code == 200, "anderer ETag → voll")

    r = c.get("/tiles/j/tileset.json", headers={"Accept-Encoding": "gzip"})
    ok(r.status_code == 200 and r.headers.get("content-encoding") == "gzip", "tileset.json wird gezippt", str(dict(r.headers)))
    ok(r.json() == json.loads(roh), "und kommt nach dem Entpacken (httpx entpackt selbst) unverändert an")
    ok(int(r.headers["content-length"]) < len(roh) / 8, "Content-Length ist die gezippte Größe")
    ok(r.headers["cache-control"] == "no-cache" and r.headers["etag"] == '"e2"', "Wurzel: no-cache + ETag")
    ok(LETZTE[-1].geschlossen and LETZTE[-1].freigegeben, "Verbindung nach dem Zippen freigegeben")
    r = c.get("/tiles/j/tileset.json", headers={"Accept-Encoding": "identity"})
    ok(r.status_code == 200 and "content-encoding" not in r.headers and r.content == roh, "ohne gzip unverändert")
    r = c.get("/tiles/j/tileset.json", headers={"If-None-Match": '"e2"', "Accept-Encoding": "gzip"})
    ok(r.status_code == 304, "tileset.json: bekannter ETag → 304")
    r = c.get("/tiles/j/tileset.3.json")
    ok(r.headers["cache-control"].startswith("public"), "Unter-Tileset wird zwischengespeichert")
    r = c.get("/tiles/j/placement.json")
    ok(r.headers["cache-control"] == "no-cache", "placement.json nie für einen Tag")

    r = c.get("/tiles/j/gibtsnicht.b3dm")
    ok(r.status_code == 404, "unbekannt → 404")
    r = c.get("/tiles/j/..%2Fx")
    ok(r.status_code in (400, 404), "Pfadausbruch bleibt abgewiesen", str(r.status_code))

print(f"\n{geprueft} Prüfungen, {fehler} Fehler")
sys.exit(1 if fehler else 0)
