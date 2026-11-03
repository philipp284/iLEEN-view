"""
Bauteileigenschaften eines IFC-Modells als SQLite-Datei neben dem Tileset.

**Warum eine Datenbank und nicht JSON.** Die Batch Table im B3DM trägt nur, was
für Auswahl und Beschriftung nötig ist — GlobalId, Typ, Name, Geschoss. Die
vollständigen Property-Sets eines Campus-Modells sind zweistellige Megabytes;
sie in jedes Tile zu schreiben würde die Tiles vervielfachen, und als eine große
JSON-Datei müsste der Server sie für jede Einzelabfrage komplett parsen. SQLite
beantwortet den Zugriff über den Primärschlüssel, ohne die Datei zu laden.

Die Datei wird beim Tiling geschrieben, landet als `properties.sqlite` im
tiles-Bucket und wird von `api/routes/elements.py` bei Bedarf einmal
heruntergeladen und danach lokal abgefragt.
"""

import json
import logging
import sqlite3
import zlib
from pathlib import Path

logger = logging.getLogger(__name__)

PROPERTIES_FILE = "properties.sqlite"

# Property-Sets werden je Zeile zlib-komprimiert abgelegt. ArchiCAD-Exporte
# bringen rund 4 kB Text je Bauteil mit, überwiegend immer dieselben deutschen
# Schlüsselnamen — beim Campus-Modell wurde die Datei dadurch 143 MB groß, und
# die lädt die API beim ersten Klick vollständig herunter. Komprimiert bleibt
# etwa ein Fünftel davon übrig; das Entpacken einer einzelnen Zeile kostet
# nichts.
_COMPRESS_LEVEL = 6

_SCHEMA = """
CREATE TABLE IF NOT EXISTS elements (
    global_id   TEXT PRIMARY KEY,
    ifc_type    TEXT,
    name        TEXT,
    object_type TEXT,
    description TEXT,
    storey      TEXT,
    psets       BLOB
);
"""

_INSERT = """
INSERT OR REPLACE INTO elements
    (global_id, ifc_type, name, object_type, description, storey, psets)
VALUES (?, ?, ?, ?, ?, ?, ?)
"""

_BATCH = 2000


class PropertyWriter:
    """Sammelt Bauteileigenschaften und schreibt sie gebündelt in die Datei."""

    def __init__(self, path: Path):
        self.path = path
        path.unlink(missing_ok=True)
        self._db = sqlite3.connect(path)
        # Journal aus und synchron aus: die Datei wird in einem Rutsch neu
        # aufgebaut, ein Absturz mittendrin macht den ganzen Job ungültig.
        self._db.execute("PRAGMA journal_mode = OFF")
        self._db.execute("PRAGMA synchronous = OFF")
        self._db.executescript(_SCHEMA)
        self._pending: list[tuple] = []
        self.count = 0

    def add(
        self,
        global_id: str,
        ifc_type: str,
        name: str | None,
        object_type: str | None,
        description: str | None,
        storey: str | None,
        psets: dict | None,
    ):
        self._pending.append(
            (global_id, ifc_type, name, object_type, description, storey, encode_psets(psets))
        )
        self.count += 1
        if len(self._pending) >= _BATCH:
            self.flush()

    def flush(self):
        if self._pending:
            self._db.executemany(_INSERT, self._pending)
            self._pending.clear()

    def close(self):
        self.flush()
        self._db.commit()
        self._db.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def encode_psets(psets: dict | None) -> bytes | None:
    """Property-Sets als komprimiertes JSON. `id` fliegt raus — das ist nur die
    Entity-Nummer des Property-Sets in der IFC-Datei, für niemanden von Belang."""
    if not psets:
        return None
    cleaned = {
        name: {k: v for k, v in values.items() if k != "id"}
        for name, values in psets.items()
        if isinstance(values, dict)
    }
    payload = json.dumps(cleaned, ensure_ascii=False, default=str).encode("utf-8")
    return zlib.compress(payload, _COMPRESS_LEVEL)


def decode_psets(value) -> dict:
    """Gegenstück zu `encode_psets`, tolerant gegenüber unkomprimiertem JSON."""
    if not value:
        return {}
    if isinstance(value, (bytes, bytearray)):
        value = zlib.decompress(value).decode("utf-8")
    return json.loads(value)


def iter_elements(path: Path):
    """
    Alle Bauteile als Dictionaries — für die semantische Indexierung, die den
    gesamten Bestand einmal durchläuft statt einzelne Bauteile nachzuschlagen.
    """
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        db.row_factory = sqlite3.Row
        for row in db.execute(
            "SELECT global_id, ifc_type, name, object_type, description, storey, psets "
            "FROM elements"
        ):
            element = {k: row[k] for k in row.keys()}
            element["psets"] = decode_psets(element["psets"])
            yield element
    finally:
        db.close()


def read_element(path: Path, global_id: str) -> dict | None:
    """Ein Bauteil samt Property-Sets, oder `None`, wenn es nicht enthalten ist."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT * FROM elements WHERE global_id = ?", (global_id,)
        ).fetchone()
    finally:
        db.close()

    if row is None:
        return None
    element = {k: row[k] for k in row.keys()}
    element["psets"] = decode_psets(element["psets"])
    return element


def count_elements(path: Path) -> int:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return int(db.execute("SELECT COUNT(*) FROM elements").fetchone()[0])
    finally:
        db.close()
