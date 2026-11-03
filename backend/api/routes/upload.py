"""
Upload-Endpunkt: Datei hochladen → MinIO → Tiling-Job anstoßen → Semantic Extraction.
Unterstützte Formate: IFC, LAS, LAZ, PLY, OBJ, STL, GLTF, GLB, XYZ, PTS, 3DGS-PLY

Uploads werden streamend auf Platte geschrieben statt komplett in den RAM
gelesen — Punktwolken und BIM-Modelle sind regelmäßig mehrere GB groß.
"""

import asyncio
import logging
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from semantic.extractor import extract_and_index
from storage.minio_client import get_minio, put_json
from tiling.pipeline import run_tiling

logger = logging.getLogger(__name__)

router = APIRouter()

SUPPORTED = {
    ".ifc", ".las", ".laz", ".ply", ".obj", ".stl",
    ".gltf", ".glb", ".xyz", ".pts",
}

# Formate, die sich mit `als=splat` in Gaussian Splats umrechnen lassen.
PUNKTWOLKEN = {".las", ".laz", ".xyz", ".pts", ".ply"}

# Arbeitsverzeichnis für Uploads (im Container als Volume gemountet)
WORK_DIR = Path("/tmp/uploads")

# Job-Status im Prozessspeicher. Reicht für den Single-Worker-Betrieb;
# bei mehreren uvicorn-Workern bräuchte es einen geteilten Store (Redis).
JOBS: dict[str, dict] = {}

_CHUNK = 8 * 1024 * 1024


class UploadResponse(BaseModel):
    job_id: str
    filename: str
    format: str
    status: str
    message: str


class JobStatus(BaseModel):
    job_id: str
    filename: str
    status: str
    message: str
    tileset_url: str | None = None
    updated_at: str


def _splat_ablegen(job_id: str, src: Path, umgerechnet: dict):
    """
    Macht aus einem getileten Laserscan-Splat ein Asset: Quelle tauschen, verorten, benennen.

    Die Splat-PLY ersetzt den LAS in `uploads/{job}/` — das Asset ist ein Splat, die Liste
    soll es so führen (`assets._content_type` liest die Endung der Quelle), und der Export
    (SOG, PLY) findet seine Eingabe an der einen Stelle, an der er immer sucht. Der Scan selbst
    liegt weiter beim Absender; was wir von ihm behalten, ist der Schwerpunktversatz im Bericht.
    """
    from splatwerk.uebernahme import verorte_scan_splat

    minio = get_minio()
    ply = umgerechnet["ply"]
    stamm = Path(src.name).stem
    minio.remove_object("uploads", f"{job_id}/{src.name}")
    minio.fput_object("uploads", f"{job_id}/{stamm}.ply", str(ply), content_type="application/octet-stream")
    verorte_scan_splat(job_id, umgerechnet["crs"], umgerechnet["bericht"]["offset_xyz"])
    put_json("tiles", f"{job_id}/meta.json",
             {"display_name": f"{stamm} (Splat)", "scan2gs": umgerechnet["bericht"]})


def _set_status(job_id: str, **fields):
    entry = JOBS.setdefault(job_id, {"job_id": job_id})
    entry.update(fields)
    entry["updated_at"] = datetime.now(timezone.utc).isoformat()


@router.post("/", response_model=UploadResponse, include_in_schema=False)
@router.post("", response_model=UploadResponse)
async def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    als: str | None = Query(None, description="`splat`: Punktwolke als Gaussian Splat umrechnen (Surfels, ohne Training)"),
    voxel_cm: float | None = Query(None, ge=0.1, le=500, description="Voxelgröße der Umrechnung in cm; leer = automatisch"),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Kein Dateiname übermittelt.")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in SUPPORTED:
        detail = f"Format '{suffix}' nicht unterstützt. Erlaubt: {sorted(SUPPORTED)}"
        if suffix == ".e57":
            detail += " — E57 bitte vorher nach LAS/LAZ oder PLY konvertieren."
        raise HTTPException(status_code=415, detail=detail)

    if als not in (None, "", "splat"):
        raise HTTPException(status_code=422, detail=f"'als={als}' unbekannt. Erlaubt: splat")
    als_splat = als == "splat"
    if als_splat and suffix not in PUNKTWOLKEN:
        raise HTTPException(status_code=422, detail=f"Als Splat umrechnen lässt sich nur eine Punktwolke "
                                                    f"({', '.join(sorted(PUNKTWOLKEN))}), keine {suffix}-Datei.")

    job_id = str(uuid.uuid4())
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    src = job_dir / Path(file.filename).name

    # Streamend auf Platte schreiben, damit große Dateien den RAM nicht sprengen
    size = 0
    try:
        with src.open("wb") as out:
            while chunk := await file.read(_CHUNK):
                out.write(chunk)
                size += len(chunk)
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    if size == 0:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Datei ist leer.")

    # Quelldatei in MinIO sichern (uploads-Bucket)
    object_name = f"{job_id}/{src.name}"
    try:
        minio = get_minio()
        minio.fput_object(
            bucket_name="uploads",
            object_name=object_name,
            file_path=str(src),
            content_type=file.content_type or "application/octet-stream",
        )
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        logger.error(f"[{job_id}] Upload nach MinIO fehlgeschlagen: {e}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Storage nicht erreichbar: {e}")

    _set_status(
        job_id,
        filename=src.name,
        status="queued",
        message="Datei empfangen, Tiling steht an.",
        tileset_url=None,
    )

    background_tasks.add_task(
        _process_job, job_id=job_id, src=src, suffix=suffix,
        als_splat=als_splat, voxel_m=None if voxel_cm is None else voxel_cm / 100.0,
    )

    return UploadResponse(
        job_id=job_id,
        filename=src.name,
        format=suffix,
        status="queued",
        message=(
            f"{size / 1e6:.1f} MB empfangen. Tiling + Semantic Extraction "
            f"laufen im Hintergrund — Fortschritt unter /upload/status/{job_id}"
        ),
    )


@router.get("/status/{job_id}", response_model=JobStatus)
async def job_status(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' unbekannt.")
    return JobStatus(**job)


@router.get("/status", response_model=list[JobStatus])
async def all_jobs():
    return [JobStatus(**job) for job in JOBS.values()]


def _zu_splat(job_id: str, src: Path, voxel_m: float | None) -> dict:
    """
    Punktwolke → 3DGS-PLY (Surfels), neben die Quelldatei. Läuft im Thread.

    Gibt `{ply, bericht, crs}` zurück. Das CRS wird jetzt gelesen, nicht erst beim Verorten:
    nach dem Tiling gibt es die Quelldatei nicht mehr (`finally` unten).
    """
    from splatwerk import plyhilfe, scan2gs
    from tiling.formats.pointcloud import _source_crs

    if src.suffix.lower() == ".ply" and plyhilfe.ist_3dgs(plyhilfe.lese_kopf(src)):
        raise ValueError("Diese PLY ist schon ein Gaussian Splat — ohne „Als Splat umwandeln“ hochladen.")
    ziel = src.with_name(src.stem + ".splat.ply")
    opt = scan2gs.Optionen(voxel_m=voxel_m, max_splats=int(os.getenv("SCAN_SPLAT_MAX", "6000000")))

    def fortschritt(stufe: str, anteil: float):
        text = {"voxel": "Punkte lesen und rastern", "nachbarn": "Nachbarschaften suchen",
                "surfels": "Surfels berechnen"}.get(stufe, stufe)
        _set_status(job_id, status="converting", message=f"Gaussian Splats berechnen — {text} ({anteil * 100:.0f} %)")

    bericht = scan2gs.konvertiere(src, ziel, opt, fortschritt)
    crs = _source_crs(src) if src.suffix.lower() in (".las", ".laz") or os.getenv("POINTCLOUD_CRS_IN") else None
    return {"ply": ziel, "bericht": bericht, "crs": crs}


async def _process_job(job_id: str, src: Path, suffix: str, als_splat: bool = False,
                       voxel_m: float | None = None):
    filename = src.name
    tiles_dir: Path | None = None
    umgerechnet: dict | None = None
    try:
        quelle = src
        if als_splat:
            # 0. Laserscan → Splat. Ein PLY, das schon ein Splat ist, braucht das nicht.
            _set_status(job_id, status="converting", message="Gaussian Splats berechnen…")
            try:
                umgerechnet = await asyncio.to_thread(_zu_splat, job_id, src, voxel_m)
            except Exception as e:
                logger.error(f"[{job_id}] Umrechnung fehlgeschlagen: {e}", exc_info=True)
                _set_status(job_id, status="failed", message=f"Umrechnung in Splats fehlgeschlagen: {e}")
                return
            quelle = umgerechnet["ply"]

        # 1. Tiling → 3D Tiles in MinIO/tiles-Bucket
        _set_status(job_id, status="tiling", message="Tiling läuft…")
        try:
            tiles_dir = await asyncio.to_thread(run_tiling, quelle, job_id)
            if umgerechnet is not None:
                await asyncio.to_thread(_splat_ablegen, job_id, src, umgerechnet)
        except Exception as e:
            logger.error(f"[{job_id}] Tiling fehlgeschlagen: {e}", exc_info=True)
            _set_status(job_id, status="failed", message=f"Tiling fehlgeschlagen: {e}")
            return

        _set_status(
            job_id,
            status="done",
            message="Tiling abgeschlossen.",
            tileset_url=f"/tiles/{job_id}/tileset.json",
        )

        # 2. Semantic Extraction — nur IFC trägt Fachsemantik (Typen, Namen, Psets).
        # OBJ/GLTF/STL sind reine Geometrie; Kreuzberg lehnt .obj zudem als
        # "application/x-tgif" ab. Der Dokumentpfad bleibt für spätere
        # Formate (PDF, DOCX) in extractor.py erhalten.
        #
        # `tiles_dir` wird mitgegeben, weil dort die `properties.sqlite` des
        # Tilings liegt: die IFC-Datei ein zweites Mal zu parsen kostet bei
        # großen Modellen Minuten und mehrere Gigabyte für dieselben Angaben.
        if suffix == ".ifc":
            _set_status(job_id, status="indexing", message="Semantische Indexierung läuft…")
            try:
                await extract_and_index(src, job_id, filename, tiles_dir=tiles_dir)
                _set_status(job_id, status="done", message="Tiling + Indexierung abgeschlossen.")
            except Exception as e:
                logger.warning(f"[{job_id}] Semantic Extraction fehlgeschlagen: {e}")
                _set_status(
                    job_id,
                    status="done",
                    message=f"Tiling ok, Indexierung fehlgeschlagen: {e}",
                )
    finally:
        shutil.rmtree(src.parent, ignore_errors=True)
        if tiles_dir is not None:
            shutil.rmtree(tiles_dir, ignore_errors=True)
