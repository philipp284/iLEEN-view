"""
HTTP-Kopf für Kacheln aus dem Tiles-Bucket: Zwischenspeicher, Validierung, Kompression.

Ohne Abhängigkeiten (kein FastAPI, kein MinIO), damit sich die Regeln ohne Server prüfen
lassen (tests/test_tiles_kopf.py).

Wozu: Kacheln und tileset.json gingen bisher ohne Cache-Control, ETag und Last-Modified
hinaus — der Browser konnte sie nicht aus seinem HTTP-Cache holen. Verwirft der Kachelspeicher
der VR-Seite eine Kachel (LRU) oder startet man eine zweite Sitzung, kam jedes Byte neu übers
WLAN; bei einem Campus-Modell sind das 410 MB. Der Kommentar in tiles.py nannte die Kacheln
„unveränderlich“, geschickt wurde davon nichts.

Regeln (die Route liefert alles unter dem Job-Präfix aus, nicht nur Kacheln):

* **Kacheln** (b3dm, glb, pnts, Bilder, …) und **Unter-Tilesets** (`tileset.12.json`, wie sie py3dtiles
  anlegt): `public, max-age=86400` und ETag. Sie gehören zu einem Tiling-Lauf; ein neuer Lauf ist ein
  neuer Job. Ändert sich eine Kachel ausnahmsweise an Ort und Stelle, kommt sie nach spätestens einem
  Tag oder mit einem harten Neuladen.
* **Die Wurzel `tileset.json`** ändert sich beim Verorten, ebenso `placement.json`, `meta.json`,
  `materials.json` (Umbenennen, Zuordnung): `no-cache` — immer fragen —, aber mit ETag, sodass die
  Antwort 304 ohne Körper sein kann.
* **JSON** wird gezippt, wenn der Browser es annimmt (tileset.json sind je nach Modell 300 kB bis
  mehrere MB, Text komprimiert 10:1). Binäre Kacheln nicht: GLB/B3DM sind kaum komprimierbar, und
  die CPU des Servers wäre verschenkt.
"""

import gzip
from typing import Mapping, Optional, Tuple

KACHEL_MAX_AGE = 86400
# Größer als das hier wird nicht im Speicher gezippt, sondern wie bisher gestreamt.
JSON_ZIP_MAX = 16 * 1024 * 1024
JSON_ZIP_MIN = 1024


def _basisname(objektname: str) -> str:
    return objektname.rsplit("/", 1)[-1]


def ist_json(objektname: str) -> bool:
    return objektname.lower().endswith(".json")


def ist_unter_tileset(objektname: str) -> bool:
    """`tileset.12.json` & Co.: ein Teil des Baums, unveränderlich wie die Kacheln."""
    name = _basisname(objektname).lower()
    return name.startswith("tileset") and name.endswith(".json") and name != "tileset.json"


def _etag(minio_kopf: Mapping[str, str]) -> Optional[str]:
    roh = None
    for k, v in minio_kopf.items():
        if k.lower() == "etag":
            roh = v
            break
    if not roh:
        return None
    return roh.strip().strip('"')


def _passt(if_none_match: Optional[str], etag: str) -> bool:
    """`If-None-Match` kann `*`, eine Liste und schwache Validatoren (W/"…") enthalten."""
    if not if_none_match:
        return False
    for teil in if_none_match.split(","):
        teil = teil.strip()
        if teil == "*":
            return True
        if teil.startswith("W/"):
            teil = teil[2:]
        if teil.strip('"') == etag:
            return True
    return False


def akzeptiert_gzip(accept_encoding: Optional[str]) -> bool:
    if not accept_encoding:
        return False
    for teil in accept_encoding.split(","):
        name, _, rest = teil.strip().partition(";")
        if name.strip().lower() in ("gzip", "x-gzip"):
            q = rest.strip().lower()
            if q.startswith("q="):
                try:
                    return float(q[2:]) > 0
                except ValueError:
                    return True
            return True
    return False


def cache_kopf(objektname: str, minio_kopf: Mapping[str, str],
               anfrage_kopf: Mapping[str, str]) -> Tuple[int, dict]:
    """
    (Status, Antwortkopf) für ein Objekt: 200 oder 304.

    `minio_kopf` ist der Kopf der MinIO-Antwort (ETag, Last-Modified), `anfrage_kopf` der
    der Anfrage des Browsers (If-None-Match, Accept-Encoding) — beide mit beliebiger Schreibung
    der Namen.
    """
    anfrage = {k.lower(): v for k, v in anfrage_kopf.items()}
    kopf = {}
    etag = _etag(minio_kopf)
    if etag:
        kopf["ETag"] = f'"{etag}"'
    for k, v in minio_kopf.items():
        if k.lower() == "last-modified" and v:
            kopf["Last-Modified"] = v

    json_objekt = ist_json(objektname)
    if ist_unter_tileset(objektname) or not json_objekt:
        kopf["Cache-Control"] = f"public, max-age={KACHEL_MAX_AGE}"
    else:
        # Wurzel-tileset.json, placement.json, meta.json, materials.json: ändern sich
        kopf["Cache-Control"] = "no-cache"
    if json_objekt:
        kopf["Vary"] = "Accept-Encoding"

    if etag and _passt(anfrage.get("if-none-match"), etag):
        return 304, kopf
    return 200, kopf


def json_zippen(objektname: str, groesse: Optional[int], anfrage_kopf: Mapping[str, str]) -> bool:
    """Soll dieses Objekt gezippt werden (JSON, nicht winzig, nicht riesig, Browser kann es)?"""
    if not ist_json(objektname):
        return False
    anfrage = {k.lower(): v for k, v in anfrage_kopf.items()}
    if not akzeptiert_gzip(anfrage.get("accept-encoding")):
        return False
    if groesse is None:
        return False
    return JSON_ZIP_MIN <= groesse <= JSON_ZIP_MAX


def zippen(daten: bytes) -> bytes:
    # Stufe 6: bei JSON liegt der Gewinn von 9 gegenüber 6 unter 3 %, die Zeit ist doppelt
    return gzip.compress(daten, compresslevel=6, mtime=0)
