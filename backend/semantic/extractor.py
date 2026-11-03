"""
Semantic Extraction → LanceDB Vektorindex.

Zwei Extraktionswege, je nach Dateityp:

* **IFC** wird nativ über IfcOpenShell ausgelesen (Elementtyp, Name, Etage,
  Material, Property-Sets). Kreuzberg kennt IFC nicht — und selbst als
  Rohtext gelesen wäre eine STEP-Datei für Embeddings wertlos, weil sie aus
  Referenznummern statt aus Fachsprache besteht.
* **Dokumente** (PDF, DOCX, XLSX, Markdown …) laufen über Kreuzbergs native
  Python-API. Der frühere Weg über eine REST-API entfällt: `kreuzberg serve`
  benötigt ein separates Rust-Binary, die Bibliothek selbst extrahiert
  in-process und ohne HTTP-Overhead.
"""

import hashlib
import logging
import os
from pathlib import Path

import lancedb
from sentence_transformers import SentenceTransformer

from semantic.properties import PROPERTIES_FILE, iter_elements
 
logger = logging.getLogger(__name__)

LANCE_DB_PATH = os.getenv("LANCE_DB_PATH", "/tmp/lancedb")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
TABLE_NAME = "cesium_chunks"

# Zeichen pro Chunk — passt zum 256-Token-Fenster von all-MiniLM-L6-v2
_CHUNK_CHARS = 1000
_CHUNK_OVERLAP = 200

_model: SentenceTransformer | None = None
_db: lancedb.DBConnection | None = None


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        logger.info(f"Lade Embedding-Modell: {EMBEDDING_MODEL}")
        _model = SentenceTransformer(EMBEDDING_MODEL)
    return _model


def _get_db() -> lancedb.DBConnection:
    global _db
    if _db is None:
        _db = lancedb.connect(LANCE_DB_PATH)
    return _db


# ── Extraktion ───────────────────────────────────────────────────────────────


def _extract_ifc_properties(db_path: Path) -> tuple[list[str], list[str]]:
    """
    Liest die Bauteiltexte aus der `properties.sqlite`, die das Tiling erzeugt hat.

    Das Tiling ist ohnehin schon einmal durch jedes Bauteil gelaufen und hat
    Typ, Name, Geschoss und Property-Sets abgelegt. Die IFC-Datei dafür ein
    zweites Mal zu parsen, kostet bei einem 500-MB-Modell Minuten und mehrere
    Gigabyte — für exakt dieselben Angaben.
    """
    lines: list[str] = []
    type_counts: dict[str, int] = {}
    storeys: set[str] = set()

    for element in iter_elements(db_path):
        ifc_type = element["ifc_type"]
        type_counts[ifc_type] = type_counts.get(ifc_type, 0) + 1
        if element["storey"]:
            storeys.add(element["storey"])

        parts = [
            p
            for p in (
                ifc_type,
                element["name"],
                element["object_type"],
                element["description"],
                element["storey"],
            )
            if p
        ]
        for pset_name, props in list(element["psets"].items())[:5]:
            values = [
                f"{k}={v}"
                for k, v in list(props.items())[:8]
                if v not in (None, "", "unknown")
            ]
            if values:
                parts.append(f"{pset_name}: {', '.join(values)}")
        lines.append(" | ".join(parts))

    if not lines:
        return [], []

    for storey in sorted(storeys):
        lines.insert(0, f"Geschoss: {storey}")
    lines.insert(0, f"Modellinhalt: {_summary(type_counts)}")
    return _group_lines(lines), _keywords(type_counts)


def _summary(type_counts: dict) -> str:
    return ", ".join(
        f"{count}x {name}"
        for name, count in sorted(type_counts.items(), key=lambda kv: -kv[1])[:20]
    )


def _keywords(type_counts: dict) -> list[str]:
    """Häufigste Bauteiltypen, ohne das IFC-Präfix."""
    return [
        name[3:] if name.startswith("Ifc") else name
        for name, _ in sorted(type_counts.items(), key=lambda kv: -kv[1])[:20]
    ]


def _extract_ifc(src: Path) -> tuple[list[str], list[str]]:
    """
    Liest ein IFC-Modell als Fließtext je Bauteil.

    Fallback für den Fall, dass keine `properties.sqlite` vorliegt — etwa wenn
    das Tiling mit `IFC_EXTRACT_PSETS=false` lief.

    Gibt (Chunks, Keywords) zurück. Ein Chunk fasst mehrere Bauteile zusammen,
    damit die Chunk-Anzahl bei großen Modellen handhabbar bleibt.
    """
    import ifcopenshell
    import ifcopenshell.util.element

    model = ifcopenshell.open(str(src))

    lines: list[str] = []
    type_counts: dict[str, int] = {}

    project = model.by_type("IfcProject")
    if project:
        lines.append(f"Projekt: {project[0].Name or 'ohne Namen'}")

    for storey in model.by_type("IfcBuildingStorey"):
        lines.append(f"Geschoss: {storey.Name or 'unbenannt'}")

    for element in model.by_type("IfcElement"):
        ifc_type = element.is_a()
        type_counts[ifc_type] = type_counts.get(ifc_type, 0) + 1

        parts = [ifc_type]
        if element.Name:
            parts.append(str(element.Name))
        if getattr(element, "ObjectType", None):
            parts.append(str(element.ObjectType))
        if element.Description:
            parts.append(str(element.Description))

        try:
            psets = ifcopenshell.util.element.get_psets(element)
            for pset_name, props in list(psets.items())[:5]:
                values = [
                    f"{k}={v}"
                    for k, v in list(props.items())[:8]
                    if v not in (None, "", "unknown") and k != "id"
                ]
                if values:
                    parts.append(f"{pset_name}: {', '.join(values)}")
        except Exception:
            pass

        lines.append(" | ".join(parts))

    if not lines:
        return [], []

    lines.insert(0, f"Modellinhalt: {_summary(type_counts)}")
    return _group_lines(lines), _keywords(type_counts)


def _group_lines(lines: list[str]) -> list[str]:
    """Fasst Zeilen zu Chunks von etwa _CHUNK_CHARS Zeichen zusammen."""
    chunks: list[str] = []
    current: list[str] = []
    length = 0
    for line in lines:
        current.append(line)
        length += len(line) + 1
        if length >= _CHUNK_CHARS:
            chunks.append("\n".join(current))
            current, length = [], 0
    if current:
        chunks.append("\n".join(current))
    return chunks


async def _extract_document(src: Path) -> tuple[list[str], list[str]]:
    """Dokumentextraktion über Kreuzbergs native Python-API."""
    from importlib import import_module

    kreuzberg = import_module("kreuzberg")
    ChunkingConfig = kreuzberg.ChunkingConfig
    ExtractionConfig = kreuzberg.ExtractionConfig
    extract_file = kreuzberg.extract_file

    config = ExtractionConfig(
        chunking=ChunkingConfig(max_chars=_CHUNK_CHARS, max_overlap=_CHUNK_OVERLAP),
        output_format="markdown",
    )
    result = await extract_file(str(src), config=config)

    chunks = list(result.chunks or [])
    if not chunks and result.content:
        chunks = _group_lines(result.content.splitlines())

    keywords = [k[0] if isinstance(k, (tuple, list)) else str(k) for k in (result.keywords or [])]
    return chunks, keywords[:20]


async def extract_and_index(
    src: Path, job_id: str, filename: str, tiles_dir: Path | None = None
):
    """Extrahiert Text, bildet Embeddings und schreibt sie in den LanceDB-Index."""
    logger.info(f"[{job_id}] Semantic Extraction: {filename}")

    suffix = src.suffix.lower()
    properties = tiles_dir / PROPERTIES_FILE if tiles_dir else None
    if suffix == ".ifc" and properties and properties.exists():
        chunks, keywords = _extract_ifc_properties(properties)
    elif suffix == ".ifc":
        chunks, keywords = _extract_ifc(src)
    else:
        chunks, keywords = await _extract_document(src)

    chunks = [c for c in chunks if c and c.strip()]
    if not chunks:
        logger.info(f"[{job_id}] Kein extrahierbarer Inhalt, übersprungen.")
        return

    model = _get_model()
    db = _get_db()

    doc_id = hashlib.sha256(f"{job_id}:{filename}".encode()).hexdigest()[:16]
    keyword_str = ", ".join(keywords)

    vectors = model.encode(chunks, batch_size=32, show_progress_bar=False)
    rows = [
        {
            "chunk_id": f"{doc_id}_{i}",
            "doc_id": doc_id,
            "job_id": job_id,
            "filename": filename,
            "text": chunk[:2000],
            "keywords": keyword_str,
            "vector": vector.tolist(),
        }
        for i, (chunk, vector) in enumerate(zip(chunks, vectors))
    ]

    if TABLE_NAME in db.table_names():
        tbl = db.open_table(TABLE_NAME)
        tbl.add(rows)
    else:
        import pyarrow as pa

        schema = pa.schema(
            [
                pa.field("chunk_id", pa.string()),
                pa.field("doc_id", pa.string()),
                pa.field("job_id", pa.string()),
                pa.field("filename", pa.string()),
                pa.field("text", pa.string()),
                pa.field("keywords", pa.string()),
                pa.field("vector", pa.list_(pa.float32(), len(rows[0]["vector"]))),
            ]
        )
        tbl = db.create_table(TABLE_NAME, data=rows, schema=schema)

    _ensure_fts_index(tbl)
    logger.info(f"[{job_id}] {len(rows)} Chunks indexiert → LanceDB:{TABLE_NAME}")


def _ensure_fts_index(tbl):
    """
    Legt den Volltextindex an bzw. aktualisiert ihn. Ohne ihn scheitert
    `tbl.search("text")` — LanceDB kann einen String sonst nicht auflösen.
    """
    try:
        tbl.create_fts_index("text", replace=True)
    except Exception as e:
        logger.warning(f"FTS-Index konnte nicht erstellt werden: {e}")


# ── Löschen ──────────────────────────────────────────────────────────────────


def delete_job(job_id: str):
    """Entfernt alle indexierten Chunks eines Jobs — Gegenstück zu `extract_and_index()`."""
    db = _get_db()
    if TABLE_NAME not in db.table_names():
        return
    tbl = db.open_table(TABLE_NAME)
    tbl.delete(f"job_id = '{job_id}'")


# ── Suche ────────────────────────────────────────────────────────────────────


async def search_semantic(query: str, limit: int = 10) -> list[dict]:
    """Volltextsuche im LanceDB-Index."""
    db = _get_db()
    if TABLE_NAME not in db.table_names():
        return []
    tbl = db.open_table(TABLE_NAME)
    try:
        results = tbl.search(query, query_type="fts").limit(limit).to_list()
    except Exception as e:
        logger.warning(f"Volltextsuche fehlgeschlagen, weiche auf Vektorsuche aus: {e}")
        return await search_vector(query, limit=limit)
    return _format_results(results)


async def search_vector(query: str, limit: int = 10) -> list[dict]:
    """Semantische Vektorsuche im LanceDB-Index."""
    db = _get_db()
    if TABLE_NAME not in db.table_names():
        return []
    vec = _get_model().encode(query).tolist()
    tbl = db.open_table(TABLE_NAME)
    results = tbl.search(vec).limit(limit).to_list()
    return _format_results(results)


def _format_results(rows: list[dict]) -> list[dict]:
    return [
        {
            "doc_id": r["doc_id"],
            "job_id": r["job_id"],
            "filename": r["filename"],
            "score": float(r.get("_distance", r.get("_score", 0.0))),
            "excerpt": r["text"][:300],
        }
        for r in rows
    ]
