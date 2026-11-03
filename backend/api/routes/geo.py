"""
Geländeauskunft für das Verortungs-UI, plus Verwaltung der lokalen
Geländereferenz (`tiling/terrain.py`).

Der Browser könnte die Höhe nicht selbst ermitteln: Cesium World Terrain
bräuchte einen Ion-Token, und genau den soll dieses Backend nicht voraussetzen.
Die Abfrage läuft deshalb serverseitig über `tiling/elevation.py`, das
Ergebnis wird im UI für die Live-Vorschau gebraucht.
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from tiling import elevation, terrain

logger = logging.getLogger(__name__)

router = APIRouter()


class Elevation(BaseModel):
    lon: float
    lat: float
    ground_msl: float | None
    ground_ellipsoid: float | None
    undulation: float
    default_reference: str
    source: str  # "local" (Geländereferenz), "dem" (externer Dienst) oder "none"


class TerrainReference(BaseModel):
    job_id: str
    source_filename: str
    point_count: int
    rows: int
    cols: int
    resolution_m: float
    filled_cells: int
    updated_at: str


# Synchron definiert: der DEM-Aufruf ist blockierendes I/O und läuft so im
# Threadpool von FastAPI, statt den Event-Loop für Sekunden anzuhalten.
@router.get("/elevation", response_model=Elevation)
def get_elevation(
    lon: float = Query(..., ge=-180.0, le=180.0),
    lat: float = Query(..., ge=-90.0, le=90.0),
):
    """Geländehöhe an einem Punkt — über NHN und über dem Ellipsoid."""
    local = terrain.sample_ellipsoid(lon, lat)
    undulation = elevation.geoid_undulation()

    if local is not None:
        msl, source = local - undulation, "local"
    else:
        msl = elevation.ground_msl(lon, lat)
        source = "dem" if msl is not None else "none"

    return Elevation(
        lon=lon,
        lat=lat,
        ground_msl=msl,
        ground_ellipsoid=None if msl is None else msl + undulation,
        undulation=undulation,
        default_reference=elevation.default_reference(),
        source=source,
    )


@router.get("/terrain-reference", response_model=TerrainReference | None)
async def get_terrain_reference():
    """Aktive Geländereferenz, `null` wenn keine gesetzt ist."""
    info = await asyncio.to_thread(terrain.reference_info)
    return TerrainReference(**info) if info else None


@router.put("/terrain-reference/{job_id}", response_model=TerrainReference)
async def set_terrain_reference(job_id: str):
    """
    Markiert ein hochgeladenes Asset als Geländereferenz und baut sein
    Höhenraster auf. Das Asset muss zuvor im Asset-Manager verortet
    (gespeichert) worden sein — siehe `tiling/terrain.py`.

    Blockierend (IfcOpenShell/trimesh/laspy) — läuft deshalb im Threadpool,
    damit die Event-Loop für andere Anfragen frei bleibt.
    """
    try:
        meta = await asyncio.to_thread(terrain.build_height_grid, job_id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return TerrainReference(**meta)


@router.delete("/terrain-reference", status_code=204)
async def delete_terrain_reference():
    """Entfernt die Geländereferenz — Platzierungen fallen wieder auf das DEM zurück."""
    await asyncio.to_thread(terrain.clear_reference)
