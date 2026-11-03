"""
Bauteilsemantik: Eigenschaften eines angeklickten IFC-Elements.

Das Tileset liefert beim Klick nur die Batch Table — GlobalId, Typ, Name,
Geschoss. Die vollständigen Property-Sets stehen in `properties.sqlite` neben
dem Tileset im tiles-Bucket (siehe `semantic/properties.py`).

Die Datei wird beim ersten Zugriff einmal aus MinIO geholt und danach lokal
abgefragt. Ein Streaming-Zugriff wäre hier nichts wert: SQLite springt im File
umher, das ginge über S3 nur mit Range-Requests je Seite. Da die Datei zu einem
unveränderlichen Tiling gehört, ist das lokale Exemplar dauerhaft gültig.
"""

import asyncio
import logging
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from minio.error import S3Error
from pydantic import BaseModel

from semantic.properties import (PROPERTIES_FILE, count_elements, iter_elements,
                                 read_element)
from storage.minio_client import get_minio

logger = logging.getLogger(__name__)

router = APIRouter()

_BUCKET = "tiles"
_CACHE_DIR = Path(os.getenv("PROPERTIES_CACHE", "/tmp/properties"))


class Element(BaseModel):
    global_id: str
    ifc_type: str | None = None
    name: str | None = None
    object_type: str | None = None
    description: str | None = None
    storey: str | None = None
    psets: dict = {}


class ElementsInfo(BaseModel):
    job_id: str
    elements: int


def _local_properties(job_id: str) -> Path:
    """Pfad zur lokalen Kopie der Eigenschaftsdatei; lädt sie bei Bedarf."""
    path = _CACHE_DIR / f"{job_id}.sqlite"
    if path.exists():
        return path

    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # Erst neben das Ziel legen und dann umbenennen: sonst könnte eine zweite
    # Anfrage die halb heruntergeladene Datei öffnen.
    partial = path.with_suffix(".part")
    try:
        get_minio().fget_object(_BUCKET, f"{job_id}/{PROPERTIES_FILE}", str(partial))
    except S3Error as e:
        partial.unlink(missing_ok=True)
        if e.code in ("NoSuchKey", "NoSuchBucket"):
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Für Job '{job_id}' gibt es keine Bauteilsemantik. Sie "
                    "entsteht beim Tiling von IFC-Dateien; Punktwolken, Splats "
                    "und reine Mesh-Formate tragen keine."
                ),
            )
        logger.error(f"[{job_id}] Eigenschaften nicht ladbar: {e}")
        raise HTTPException(status_code=502, detail=f"Storage-Fehler: {e.code}")

    partial.replace(path)
    logger.info(f"[{job_id}] Eigenschaftsdatei zwischengespeichert: {path}")
    return path


def purge_cache(job_id: str):
    """Entfernt die lokale Kopie der Eigenschaftsdatei — beim Löschen eines Assets."""
    (_CACHE_DIR / f"{job_id}.sqlite").unlink(missing_ok=True)


def alle_bauteile(job_id: str) -> list[dict]:
    """
    Sämtliche Bauteile eines Modells samt Property-Sets.

    Das Gegenstück zu `read_element()` für Auswertungen, die den ganzen Bestand
    brauchen statt eines angeklickten Bauteils — die GEG-Hüllflächenliste ist
    die erste davon. Blockierend (Download und SQLite), gehört also in einen
    Thread; die Aufrufer tun das über `asyncio.to_thread`.
    """
    return list(iter_elements(_local_properties(job_id)))


@router.get("/{job_id}/elements", response_model=ElementsInfo)
async def elements_info(job_id: str):
    """Anzahl der semantisch erfassten Bauteile — auch der Test, ob es welche gibt."""
    # Download und SQLite-Zugriff sind blockierend; der Server läuft mit einem
    # einzigen Worker, hier würde sonst die gesamte Event-Loop warten.
    path = await asyncio.to_thread(_local_properties, job_id)
    return ElementsInfo(job_id=job_id, elements=await asyncio.to_thread(count_elements, path))


@router.get("/{job_id}/elements/{global_id}", response_model=Element)
async def element(job_id: str, global_id: str):
    """Ein Bauteil samt Property-Sets, adressiert über seine IFC-GlobalId."""
    path = await asyncio.to_thread(_local_properties, job_id)
    found = await asyncio.to_thread(read_element, path, global_id)
    if found is None:
        raise HTTPException(
            status_code=404, detail=f"Bauteil '{global_id}' nicht im Modell '{job_id}'."
        )
    return Element(**found)
