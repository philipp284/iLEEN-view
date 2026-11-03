"""
Splat-Export: ein Asset als SOG (PlayCanvas) oder 3DGS-PLY herunterladen.

    POST /assets/{job}/export/sog?ausrichtung=auto&sh_grad=   Export anstoßen (oder Treffer im Cache)
    GET  /assets/{job}/export/sog/status                      laeuft · fertig · fehler
    GET  /assets/{job}/export/sog                             die Datei
    GET  /assets/{job}/export/ply                             die 3DGS-PLY, aus der gekachelt wurde

Die Quelle ist nie das Tileset: Kacheln sind eine verlustbehaftete, ausgelichtete,
zusammengeführte Fassung (HLOD, SPZ-Quantisierung, Ausreißerfilter). Exportiert wird die
PLY, aus der sie entstanden sind. Das ist die Quelldatei im Bucket `uploads` — auch bei
Assets, die aus einem Laserscan oder aus Fotos entstanden sind: dort legt die Übernahme die
erzeugte Splat-PLY als Quelle ab (und nicht den LAS), damit das Asset als Splat geführt wird.

Der SOG-Export dauert je nach Größe Sekunden bis Minuten und braucht Speicher, deshalb
läuft er im Hintergrund und einer nach dem anderen. Das Ergebnis liegt im Bucket `exports`
und wird wiederverwendet: die Quelle ändert sich nie.
"""

import asyncio
import logging
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from minio.error import S3Error

from splatwerk import plyhilfe, sog
from splatwerk.auftrag import sauberer_name
from storage.minio_client import get_json, get_minio

logger = logging.getLogger(__name__)

router = APIRouter()

_BUCKET = "exports"

# Zustand der laufenden und zuletzt beendeten Exporte; der Cache selbst ist der Bucket.
_LAUF: dict[str, dict] = {}
_EINER_NACH_DEM_ANDEREN = asyncio.Semaphore(1)
_AUSRICHTUNGEN = ("auto", "colmap", "unveraendert")


def _objekt(ausrichtung: str, sh_grad: int | None) -> str:
    return f"{ausrichtung}{'' if sh_grad is None else f'-sh{sh_grad}'}.sog"


def _quelle(job_id: str) -> tuple[str, str]:
    """`(Bucket, Objekt)` der Splat-PLY dieses Assets, sonst 404/409."""
    minio = get_minio()
    try:
        minio.stat_object("tiles", f"{job_id}/tileset.json")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Kein Asset '{job_id}'.")
    for obj in minio.list_objects("uploads", prefix=f"{job_id}/", recursive=True):
        if obj.object_name.lower().endswith(".ply"):
            antwort = minio.get_object("uploads", obj.object_name, offset=0, length=65536)
            try:
                roh = antwort.read()
            finally:
                antwort.close()
                antwort.release_conn()
            try:
                if plyhilfe.ist_3dgs(plyhilfe.kopf_aus_bytes(roh, obj.object_name)):
                    return "uploads", obj.object_name
            except ValueError:
                pass
    raise HTTPException(
        status_code=409,
        detail="Dieses Asset ist kein Gaussian Splat. Ein Laserscan lässt sich beim Hochladen "
               "mit „Als Gaussian Splat umwandeln“ in einen Splat verwandeln.")


def _anzeigename(job_id: str) -> str:
    try:
        n = get_json("tiles", f"{job_id}/meta.json").get("display_name")
        if n:
            return str(n)
    except S3Error:
        pass
    bucket, objekt = _quelle(job_id)
    return Path(objekt).stem


def _vorhanden(job_id: str, objekt: str):
    try:
        return get_minio().stat_object(_BUCKET, f"{job_id}/{objekt}")
    except S3Error:
        return None


def _erzeuge(job_id: str, schluessel: str, ausrichtung: str, sh_grad: int | None):
    """Läuft im Thread: PLY holen, `splat-transform`, SOG in den Bucket."""
    tmp = Path(tempfile.mkdtemp(prefix="sog_"))
    zustand = _LAUF[schluessel]
    try:
        bucket, objekt = _quelle(job_id)
        quelle = tmp / "quelle.ply"
        get_minio().fget_object(bucket, objekt, str(quelle))
        ziel = tmp / "ausgabe.sog"
        info = sog.exportiere(quelle, ziel, ausrichtung=ausrichtung, sh_grad=sh_grad)
        get_minio().fput_object(_BUCKET, f"{job_id}/{_objekt(ausrichtung, sh_grad)}", str(ziel),
                                content_type="application/octet-stream")
        zustand.update(status="fertig", info=info, bytes=info["bytes"], meldung="Fertig.")
        logger.info(f"[{job_id}] SOG fertig: {info}")
    except HTTPException as e:
        zustand.update(status="fehler", meldung=str(e.detail))
    except sog.SogFehler as e:
        zustand.update(status="fehler", meldung=str(e))
    except Exception as e:  # unvorhergesehen — im Protokoll mit Traceback, im UI als Satz
        logger.exception(f"[{job_id}] SOG-Export")
        zustand.update(status="fehler", meldung=f"Unerwarteter Fehler: {type(e).__name__}: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def _lauf(job_id: str, schluessel: str, ausrichtung: str, sh_grad: int | None):
    async with _EINER_NACH_DEM_ANDEREN:
        _LAUF[schluessel].update(status="laeuft", meldung="Wird mit splat-transform kodiert…", seit=time.time())
        await asyncio.to_thread(_erzeuge, job_id, schluessel, ausrichtung, sh_grad)


def _pruefe(ausrichtung: str, sh_grad: int | None):
    if ausrichtung not in _AUSRICHTUNGEN:
        raise HTTPException(status_code=422, detail=f"Ausrichtung '{ausrichtung}' unbekannt. Erlaubt: {', '.join(_AUSRICHTUNGEN)}")
    if sh_grad is not None and not 0 <= sh_grad <= 3:
        raise HTTPException(status_code=422, detail="sh_grad liegt zwischen 0 und 3.")


@router.post("/{job_id}/export/sog")
async def sog_anstossen(job_id: str, ausrichtung: str = Query("auto"), sh_grad: int | None = Query(None)):
    _pruefe(ausrichtung, sh_grad)
    objekt = _objekt(ausrichtung, sh_grad)
    stat = _vorhanden(job_id, objekt)
    if stat is not None:
        return {"status": "fertig", "bytes": stat.size, "name": _anzeigename(job_id) + ".sog", "aus_cache": True}
    schluessel = f"{job_id}|{objekt}"
    if _LAUF.get(schluessel, {}).get("status") == "laeuft":
        return _LAUF[schluessel]
    _quelle(job_id)  # früh scheitern (404/409), bevor ein Hintergrundauftrag entsteht
    _LAUF[schluessel] = {"status": "wartet", "meldung": "Wartet auf einen freien Platz.", "seit": time.time()}
    asyncio.create_task(_lauf(job_id, schluessel, ausrichtung, sh_grad))
    return _LAUF[schluessel]


@router.get("/{job_id}/export/sog/status")
async def sog_status(job_id: str, ausrichtung: str = Query("auto"), sh_grad: int | None = Query(None)):
    _pruefe(ausrichtung, sh_grad)
    objekt = _objekt(ausrichtung, sh_grad)
    stat = _vorhanden(job_id, objekt)
    if stat is not None:
        return {"status": "fertig", "bytes": stat.size, "name": _anzeigename(job_id) + ".sog"}
    return _LAUF.get(f"{job_id}|{objekt}", {"status": "nicht_erzeugt", "meldung": "Noch nicht exportiert."})


def _strom(bucket: str, objekt: str, dateiname: str, groesse: int | None = None) -> StreamingResponse:
    antwort = get_minio().get_object(bucket, objekt)

    def teile():
        try:
            yield from antwort.stream(1024 * 1024)
        finally:
            antwort.close()
            antwort.release_conn()

    kopf = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(dateiname)}"}
    if groesse:
        kopf["Content-Length"] = str(groesse)
    return StreamingResponse(teile(), media_type="application/octet-stream", headers=kopf)


@router.get("/{job_id}/export/sog")
async def sog_laden(job_id: str, ausrichtung: str = Query("auto"), sh_grad: int | None = Query(None)):
    _pruefe(ausrichtung, sh_grad)
    objekt = _objekt(ausrichtung, sh_grad)
    stat = _vorhanden(job_id, objekt)
    if stat is None:
        raise HTTPException(status_code=409, detail="Noch nicht exportiert — erst POST …/export/sog.")
    return _strom(_BUCKET, f"{job_id}/{objekt}", _dateiname(_anzeigename(job_id)) + ".sog", stat.size)


@router.get("/{job_id}/export/ply")
async def ply_laden(job_id: str):
    bucket, objekt = _quelle(job_id)
    stat = get_minio().stat_object(bucket, objekt)
    return _strom(bucket, objekt, _dateiname(_anzeigename(job_id)) + ".ply", stat.size)


def _dateiname(name: str) -> str:
    return sauberer_name(name, "splat")


def purge(job_id: str):
    """Räumt die Exporte eines Assets weg — Gegenstück zu den anderen `purge()` beim Löschen."""
    from storage.minio_client import delete_prefix

    try:
        delete_prefix(_BUCKET, f"{job_id}/")
    except S3Error:
        pass
    for k in [k for k in _LAUF if k.startswith(f"{job_id}|")]:
        _LAUF.pop(k, None)
