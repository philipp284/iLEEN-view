"""
Baugrundmodell: Aufschlüsse, Schichten, Bilder — Ablage, Bildlesen, Import.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

    GET    /baugrund/modelle                         Modelle: Name, Aufschlüsse, Stand
    GET    /baugrund/modelle/{name}                  Modell lesen (Format ileen-baugrund)
    PUT    /baugrund/modelle/{name}                  Modell ablegen
    DELETE /baugrund/modelle/{name}                  Modell samt Bildern
    PUT    /baugrund/modelle/{name}/bilder/{bild}    Bild eines Aufschlusses ablegen (Rohkörper)
    GET    /baugrund/modelle/{name}/bilder/{bild}    Bild lesen
    DELETE /baugrund/modelle/{name}/bilder/{bild}
    GET    /baugrund/lesen                           steht das Bildmodell bereit?
    POST   /baugrund/lesen?hinweis=…                 Bild (Rohkörper) → Schichten, Kurzzeichen, Text
    POST   /baugrund/import/ground                   GGU-CONNECT .GROUND (Rohkörper) → Modell

Gerechnet wird das Modell im Browser (``frontend/baugrund-kern.js``): die
Interpolation hängt am Geländemodell des Viewers, und das gibt es nur dort.
Das Backend hält, was den Browser überleben muss — das Modell und die Bilder —,
und tut zwei Dinge, die im Browser nicht gehen: ein Bild mit dem lokalen
Bildsprachmodell lesen (``ileen/baugrund_lesen.py``) und eine .GROUND-Datei
samt Lagesystem umrechnen (``ileen/baugrund_ground.py``, pyproj).

Die Bilder liegen getrennt vom Modell. Ein Modell mit zwanzig Bohrprofilen als
Base64 wären zwanzig Megabyte, die bei jeder Änderung einer Schichtgrenze neu
über die Leitung gingen.
"""

import asyncio
import json
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from minio.error import S3Error

from ileen import baugrund_lesen
from ileen.baugrund_ground import GroundFehler, ground_lesen
from storage.minio_client import delete_prefix, get_bytes, get_json, get_minio, put_bytes, put_json

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "baugrund"
_NAME = re.compile(r"^[A-Za-z0-9_.\-]{1,80}$")
_MAX_MODELL = 8 * 1024 * 1024
_MAX_BILD = 40 * 1024 * 1024
_BILDTYPEN = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
              "image/heic": "heic", "image/tiff": "tif", "application/pdf": "pdf"}

#: Eine Lesung zur Zeit: das Bildmodell belegt mehrere Gigabyte GPU-Speicher,
#: zwei gleichzeitig wären nicht schneller, sondern beide bedroht.
_lesesperre = asyncio.Semaphore(1)


def _bucket():
    client = get_minio()
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)
    return client


def _name(name: str) -> str:
    if not _NAME.match(name) or ".." in name:
        raise HTTPException(status_code=400, detail=f"Ungültiger Name: {name!r}")
    return name


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _lesen(objekt: str):
    try:
        return get_json(BUCKET, objekt)
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchObject"):
            return None
        raise


@router.get("/modelle")
async def modelle():
    client = _bucket()
    out = []
    for o in client.list_objects(BUCKET, recursive=True):
        teile = o.object_name.split("/")
        if len(teile) == 2 and teile[1] == "kopf.json":
            kopf = _lesen(o.object_name) or {}
            out.append({"name": teile[0], **kopf})
    out.sort(key=lambda k: k.get("geaendert", ""), reverse=True)
    return {"modelle": out}


@router.get("/modelle/{name}")
async def modell_lesen(name: str):
    daten = _lesen(f"{_name(name)}/modell.json")
    if daten is None:
        raise HTTPException(status_code=404, detail="Kein Baugrundmodell unter diesem Namen")
    return daten


@router.put("/modelle/{name}")
async def modell_ablegen(name: str, request: Request):
    name = _name(name)
    roh = await request.body()
    if len(roh) > _MAX_MODELL:
        raise HTTPException(status_code=413, detail="Modell zu groß — Bilder gehören nicht ins Modell")
    try:
        daten = json.loads(roh)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Kein JSON: {e}")
    if not isinstance(daten, dict) or daten.get("format") != "ileen-baugrund":
        raise HTTPException(status_code=400, detail="format muss 'ileen-baugrund' sein")
    _bucket()
    daten["geaendert"] = _jetzt()
    put_json(BUCKET, f"{name}/modell.json", daten)
    kopf = {"titel": daten.get("name") or name, "geaendert": daten["geaendert"],
            "aufschluesse": len(daten.get("aufschluesse") or []),
            "schichten": len(daten.get("schichten") or [])}
    put_json(BUCKET, f"{name}/kopf.json", kopf)
    return {"name": name, **kopf}


@router.delete("/modelle/{name}")
async def modell_loeschen(name: str):
    delete_prefix(BUCKET, _name(name) + "/")
    return {"name": name, "geloescht": True}


@router.put("/modelle/{name}/bilder/{bild}")
async def bild_ablegen(name: str, bild: str, request: Request):
    name, bild = _name(name), _name(bild)
    typ = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if typ not in _BILDTYPEN:
        raise HTTPException(status_code=415, detail=f"Kein Bild: {typ or 'ohne Typ'}")
    roh = await request.body()
    if not roh:
        raise HTTPException(status_code=400, detail="Leerer Körper")
    if len(roh) > _MAX_BILD:
        raise HTTPException(status_code=413, detail="Bild zu groß (höchstens 40 MB)")
    _bucket()
    put_bytes(BUCKET, f"{name}/bilder/{bild}", roh, content_type=typ)
    return {"name": name, "bild": bild, "bytes": len(roh), "typ": typ}


@router.get("/modelle/{name}/bilder/{bild}")
async def bild_lesen(name: str, bild: str):
    name, bild = _name(name), _name(bild)
    client = _bucket()
    try:
        stat = client.stat_object(BUCKET, f"{name}/bilder/{bild}")
        daten = get_bytes(BUCKET, f"{name}/bilder/{bild}")
    except S3Error:
        raise HTTPException(status_code=404, detail="Kein Bild unter diesem Namen")
    return Response(content=daten, media_type=stat.content_type or "application/octet-stream",
                    headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/modelle/{name}/bilder/{bild}")
async def bild_loeschen(name: str, bild: str):
    name, bild = _name(name), _name(bild)
    try:
        _bucket().remove_object(BUCKET, f"{name}/bilder/{bild}")
    except S3Error:
        pass
    return {"name": name, "bild": bild, "geloescht": True}


@router.get("/lesen")
async def lesen_stand():
    return await asyncio.to_thread(baugrund_lesen.verfuegbar)


@router.post("/lesen")
async def lesen(request: Request, hinweis: str | None = None):
    roh = await request.body()
    if not roh:
        raise HTTPException(status_code=400, detail="Kein Bild im Körper")
    if len(roh) > _MAX_BILD:
        raise HTTPException(status_code=413, detail="Bild zu groß (höchstens 40 MB)")
    async with _lesesperre:
        try:
            return await asyncio.to_thread(baugrund_lesen.lesen, roh, hinweis)
        except baugrund_lesen.LeseFehler as e:
            raise HTTPException(status_code=503, detail=str(e))
        except OSError as e:
            raise HTTPException(status_code=415, detail=f"Bild nicht lesbar: {e}")


@router.post("/import/ground")
async def import_ground(request: Request):
    roh = await request.body()
    if len(roh) > _MAX_BILD:
        raise HTTPException(status_code=413, detail="Datei zu groß")
    try:
        return await asyncio.to_thread(ground_lesen, roh)
    except GroundFehler as e:
        raise HTTPException(status_code=422, detail=str(e))
