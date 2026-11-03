"""
Platzierung von Tilesets: Referenzpunkt, Drehung und Maßstab nachträglich ändern
— das Gegenstück zu "Adjust tileset location" in Cesium Ion.

Geschrieben wird direkt in die `tileset.json` im tiles-Bucket. Damit gilt die
neue Position für jeden Konsumenten, egal ob er über den API-Proxy oder
direkt über den öffentlichen MinIO-Bucket lädt. Die Eingabewerte liegen
daneben in `placement.json`, sonst ließe sich aus der fertigen 4x4-Matrix
weder der Referenzpunkt noch die Drehung zurücklesen.
"""

import logging
from datetime import datetime, timezone
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from minio.error import S3Error
from pydantic import BaseModel, Field

from storage.minio_client import get_json, put_json
from tiling import elevation
from tiling.georef import (
    PLACEMENT_FILE,
    apply_placement,
    default_placement,
    default_transform,
    placement_transform,
    to_column_major,
    to_matrix,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_BUCKET = "tiles"


class Placement(BaseModel):
    lon: float = Field(..., ge=-180.0, le=180.0, description="Längengrad WGS84")
    lat: float = Field(..., ge=-90.0, le=90.0, description="Breitengrad WGS84")
    height: float = Field(..., description="Höhe im Bezug von height_reference, in Metern")
    height_reference: Literal["terrain", "msl", "ellipsoid"] = Field(
        elevation.ELLIPSOID,
        description="terrain = über Gelände, msl = über NHN, ellipsoid = roh",
    )
    heading: float = Field(0.0, description="Drehung um die Hochachse, im Uhrzeigersinn")
    pitch: float = Field(0.0, description="Kippen um die Ost-Achse")
    roll: float = Field(0.0, description="Kippen um die Nord-Achse")
    scale: float = Field(1.0, gt=0.0, description="Gleichmäßiger Maßstabsfaktor")


class PlacementInfo(Placement):
    height_ellipsoid: float | None = Field(
        None, description="Aufgelöste Höhe über dem Ellipsoid — steht so im Transform"
    )
    adjustable: bool = True
    updated_at: str | None = None


def _tileset_key(job_id: str) -> str:
    return f"{job_id}/tileset.json"


def load_placement(job_id: str) -> dict:
    """
    Platzierung eines Jobs — aus `placement.json`, sonst aus der `tileset.json`
    rekonstruiert.

    Der Fallback greift für Tilesets, die vor Einführung der Platzierung
    entstanden sind: ihr `root.transform` wird gegen den ENU-Transform des
    aktuellen Referenzpunkts gerechnet, der Rest bleibt als `base_transform`
    stehen. Das Modell liegt dadurch zunächst exakt dort, wo es schon lag.
    """
    try:
        return get_json(_BUCKET, f"{job_id}/{PLACEMENT_FILE}")
    except S3Error as e:
        if e.code not in ("NoSuchKey", "NoSuchBucket"):
            raise

    try:
        tileset = get_json(_BUCKET, _tileset_key(job_id))
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Kein Tileset für Job '{job_id}'.")

    placement = default_placement()
    existing = tileset.get("root", {}).get("transform")
    if existing:
        # Gegen genau die Matrix rechnen, die diese Platzierung erzeugen würde —
        # sonst verschiebt schon das Einlesen das Modell um den Höhenbezug.
        current = to_matrix(placement_transform(dict(placement, base_transform=None)))
        placement["base_transform"] = to_column_major(
            np.linalg.inv(current) @ to_matrix(existing)
        )
    logger.info(f"[{job_id}] placement.json fehlte — aus tileset.json rekonstruiert.")
    return placement


def _apply(job_id: str, placement: dict):
    """
    Schreibt `root.transform` und `root.extras.ileen` in die tileset.json im
    tiles-Bucket. Die Extras sagen dem Viewer, wie die Höhe *gemeint* war —
    ohne sie kann er „auf Gelände" nicht gegen sein eigenes Terrain auflösen.
    """
    try:
        tileset = get_json(_BUCKET, _tileset_key(job_id))
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Kein Tileset für Job '{job_id}'.")

    put_json(_BUCKET, _tileset_key(job_id), apply_placement(tileset, placement))
    put_json(_BUCKET, f"{job_id}/{PLACEMENT_FILE}", placement)


@router.get("/{job_id}/placement", response_model=PlacementInfo)
async def get_placement(job_id: str):
    return PlacementInfo(**load_placement(job_id))


@router.put("/{job_id}/placement", response_model=PlacementInfo)
async def set_placement(job_id: str, update: Placement):
    """Verortet ein Tileset neu. Wirkt sofort — CesiumJS muss nur neu laden."""
    placement = load_placement(job_id)

    if not placement.get("adjustable", True):
        raise HTTPException(
            status_code=409,
            detail=(
                "Dieses Tileset ist bereits echt georeferenziert — seine "
                "Koordinaten sind ECEF. Eine Platzierung würde es von seiner "
                "wahren Position wegschieben."
            ),
        )

    placement.update(update.model_dump())
    # Neu auflösen statt den alten Wert weiterzuschleppen: Bezug, Position und
    # damit die Geländehöhe können sich gerade geändert haben.
    placement["height_ellipsoid"] = elevation.to_ellipsoid(
        update.height, update.height_reference, update.lon, update.lat
    )
    placement["updated_at"] = datetime.now(timezone.utc).isoformat()

    _apply(job_id, placement)
    logger.info(
        f"[{job_id}] neu verortet: {update.lat:.6f}, {update.lon:.6f}, "
        f"{update.height:.1f} m ({update.height_reference}) → "
        f"{placement['height_ellipsoid']:.1f} m ellipsoidisch, "
        f"Heading {update.heading:.1f}°"
    )
    return PlacementInfo(**placement)
