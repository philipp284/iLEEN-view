"""
Assets-Endpunkt: Liste aller verarbeiteten Jobs/Tilesets.
Gibt CesiumJS-kompatible Asset-Metadaten zurück.
"""

import logging
import os

from fastapi import APIRouter, HTTPException
from minio.error import S3Error
from pydantic import BaseModel, Field

from api.routes.elements import purge_cache
from api.routes.fem import purge as purge_fem
from api.routes.energie import purge as purge_energie
from api.routes.tragwerk import purge as purge_tragwerk
from api.routes.einsturz import purge as purge_einsturz
from api.routes.hausfunktionen import purge as purge_hausfunktionen
from api.routes.splat_export import purge as purge_exports
from api.routes.atlas import purge as purge_atlas
from api.routes.plan import purge_cache as purge_plan_cache
from api.routes.upload import JOBS
from semantic.extractor import delete_job
from storage.minio_client import delete_prefix, get_json, get_minio, put_json

logger = logging.getLogger(__name__)

router = APIRouter()

_TILES_BUCKET = "tiles"
_UPLOADS_BUCKET = "uploads"
_META_FILE = "meta.json"


class Asset(BaseModel):
    job_id: str
    name: str
    tileset_url: str
    content_type: str
    size_bytes: int
    last_modified: str | None = None


class RenameRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


def _meta_key(job_id: str) -> str:
    return f"{job_id}/{_META_FILE}"


def _load_meta(job_id: str) -> dict:
    try:
        return get_json(_TILES_BUCKET, _meta_key(job_id))
    except S3Error as e:
        if e.code not in ("NoSuchKey", "NoSuchBucket"):
            raise
        return {}


def _assert_exists(job_id: str):
    try:
        get_minio().stat_object(_TILES_BUCKET, f"{job_id}/tileset.json")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Kein Tileset für Job '{job_id}'.")


def _source_names() -> dict[str, str]:
    """
    Ordnet jedem Job den Namen seiner Quelldatei zu (aus `uploads/{job_id}/{datei}`).

    Ein einzelnes rekursives Listing des uploads-Buckets ist günstiger als eine
    Einzelabfrage je Job — der Bucket enthält pro Job nur die eine Quelldatei.
    """
    names: dict[str, str] = {}
    try:
        for obj in get_minio().list_objects("uploads", recursive=True):
            job_id, _, filename = obj.object_name.partition("/")
            if filename:
                names.setdefault(job_id, filename)
    except S3Error:
        pass
    return names


@router.get("/", response_model=list[Asset])
async def list_assets():
    """
    Listet alle Jobs, für die ein tileset.json vorliegt.

    Die Job-Präfixe werden nicht-rekursiv geholt und je Präfix wird gezielt
    das tileset.json abgefragt — ein rekursiver Listing-Durchlauf würde bei
    Punktwolken mit tausenden Tiles unnötig viele Objekte durchgehen.
    """
    minio = get_minio()
    tiles_url = os.getenv("TILES_PUBLIC_URL", "http://localhost:8100/tiles").rstrip("/")
    names = _source_names()

    assets: list[Asset] = []
    for prefix_obj in minio.list_objects("tiles", recursive=False):
        job_id = prefix_obj.object_name.rstrip("/")
        # "_terrain/" ist kein Job, sondern die Ablage der Geländereferenz (siehe geo.py)
        if not job_id or job_id.startswith("_"):
            continue
        try:
            stat = minio.stat_object("tiles", f"{job_id}/tileset.json")
        except S3Error:
            continue  # Job ohne (fertiges) Tileset

        source_name = names.get(job_id, job_id[:8])
        # Anzeigename ist umbenennbar; die Formaterkennung bleibt an der
        # tatsächlichen Quelldatei, sonst verliert ein umbenanntes Asset sein Tag.
        display_name = _load_meta(job_id).get("display_name") or source_name
        assets.append(
            Asset(
                job_id=job_id,
                name=display_name,
                tileset_url=f"{tiles_url}/{job_id}/tileset.json",
                content_type=_content_type(source_name),
                size_bytes=stat.size or 0,
                last_modified=stat.last_modified.isoformat() if stat.last_modified else None,
            )
        )

    assets.sort(key=lambda a: a.last_modified or "", reverse=True)
    return assets


@router.put("/{job_id}/name", response_model=Asset)
async def rename_asset(job_id: str, update: RenameRequest):
    """Setzt einen Anzeigenamen, unabhängig vom Namen der hochgeladenen Quelldatei."""
    _assert_exists(job_id)
    meta = _load_meta(job_id)
    meta["display_name"] = update.name.strip()
    put_json(_TILES_BUCKET, _meta_key(job_id), meta)
    logger.info(f"[{job_id}] umbenannt zu '{meta['display_name']}'.")

    refreshed = [a for a in await list_assets() if a.job_id == job_id]
    if not refreshed:
        raise HTTPException(status_code=404, detail=f"Kein Tileset für Job '{job_id}'.")
    return refreshed[0]


@router.delete("/{job_id}", status_code=204)
async def delete_asset(job_id: str):
    """
    Entfernt ein Asset vollständig: Tiles, Quelldatei, Bauteilsemantik,
    Statikrechnungen und Vektorindex. Wirkt sofort — ein Viewer, der das
    Tileset schon geladen hat, bemerkt davon nichts mehr, ein neuer
    Ladeversuch bekommt 404.
    """
    _assert_exists(job_id)

    delete_prefix(_TILES_BUCKET, f"{job_id}/")
    try:
        delete_prefix(_UPLOADS_BUCKET, f"{job_id}/")
    except S3Error:
        pass  # Quelldatei kann schon aufgeräumt sein — nicht fatal

    purge_cache(job_id)
    purge_plan_cache(job_id)  # IFC-Kopie und Elementverzeichnis der Bauzeichnung
    purge_fem(job_id)         # Statikrechnungen: Bericht und Ergebnisbilder
    purge_energie(job_id)     # GEG-Bilanzen: Bericht und Bilder
    purge_tragwerk(job_id)    # Lastabtrag: Bauteilkonten und Geschossberichte
    purge_einsturz(job_id)    # Einsturzrechnungen: Pakete samt Bezug
    purge_hausfunktionen(job_id)  # Animationspakete der Hausfunktionen samt Bezug
    purge_exports(job_id)     # Splat-PLY aus Scan/Training und SOG-Exporte
    purge_atlas(job_id)       # Mesh-Stand des Splats (Atlas) — oder der Verweis auf dieses Mesh
    try:
        delete_job(job_id)
    except Exception as e:
        logger.warning(f"[{job_id}] Vektorindex-Einträge nicht entfernt: {e}")
    JOBS.pop(job_id, None)

    logger.info(f"[{job_id}] gelöscht.")


def _content_type(name: str) -> str:
    """Grobe Kategorie für die Anzeige im Viewer."""
    suffix = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if suffix in {"las", "laz", "xyz", "pts"}:
        return "pointcloud"
    if suffix == "ply":
        return "splat"
    if suffix == "ifc":
        return "ifc"
    if suffix in {"obj", "stl", "glb", "gltf", "sortiert"}:
        # „sortiert": die Marke einer sortierten Ansicht (api/routes/sortiert.py) —
        # ein Teilmodell ohne eigene Quelldatei.
        return "mesh"
    return "unknown"
