"""
Tiles-Endpunkt: tileset.json + Tile-Blobs aus MinIO proxyen.
Ermöglicht CesiumJS direkt auf diesen Server zu zeigen statt auf Cesium Ion.

Die Objekte werden gestreamt, nicht komplett in den Speicher gelesen — ein
einzelnes B3DM kann mehrere hundert MB groß sein.
"""

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from minio.error import S3Error

from storage.minio_client import get_minio
from tiling import http_kopf

logger = logging.getLogger(__name__)

router = APIRouter()

_CHUNK = 1024 * 1024

_MEDIA_TYPES = {
    ".json": "application/json",
    ".b3dm": "application/octet-stream",
    ".pnts": "application/octet-stream",
    ".cmpt": "application/octet-stream",
    ".i3dm": "application/octet-stream",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".bin": "application/octet-stream",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


def _stream_object(object_name: str, request: Request) -> Response:
    minio = get_minio()
    try:
        response = minio.get_object("tiles", object_name)
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchBucket"):
            raise HTTPException(status_code=404, detail=f"'{object_name}' nicht gefunden.")
        logger.error(f"MinIO-Fehler bei '{object_name}': {e}")
        raise HTTPException(status_code=502, detail=f"Storage-Fehler: {e.code}")

    def freigeben():
        # release_conn() ist bei minio-py zwingend, sonst bleibt die
        # Verbindung belegt und der Connection-Pool läuft voll.
        response.close()
        response.release_conn()

    # Zwischenspeicher, Validierung (ETag → 304), Kompression: siehe tiling/http_kopf.py.
    # Vorher ging jede Kachel ohne Cache-Control, ETag und Last-Modified hinaus; der
    # Browser konnte keine aus seinem HTTP-Cache holen, und jede vom Kachelspeicher der
    # Viewer verworfene kam neu übers Netz.
    status, kopf = http_kopf.cache_kopf(object_name, response.headers, request.headers)
    if status == 304:
        freigeben()
        return Response(status_code=304, headers=kopf)

    size = response.headers.get("Content-Length")
    groesse = int(size) if size and size.isdigit() else None

    if http_kopf.json_zippen(object_name, groesse, request.headers):
        # tileset.json: 300 kB bis einige MB, als Text 10:1 komprimierbar
        try:
            daten = response.read()
        finally:
            freigeben()
        gezippt = http_kopf.zippen(daten)
        kopf["Content-Encoding"] = "gzip"
        kopf["Content-Length"] = str(len(gezippt))
        return Response(content=gezippt, media_type=_guess_media_type(object_name), headers=kopf)

    def iterator():
        try:
            yield from response.stream(_CHUNK)
        finally:
            freigeben()

    if groesse is not None:
        kopf["Content-Length"] = str(groesse)

    return StreamingResponse(
        iterator(),
        media_type=_guess_media_type(object_name),
        headers=kopf,
    )


@router.get("/{job_id}/tileset.json")
async def get_tileset(job_id: str, request: Request):
    return _stream_object(f"{job_id}/tileset.json", request)


@router.get("/{job_id}/{tile_path:path}")
async def get_tile(job_id: str, tile_path: str, request: Request):
    # Pfad-Traversal über relative URIs im Tileset unterbinden
    if ".." in tile_path:
        raise HTTPException(status_code=400, detail="Ungültiger Tile-Pfad.")
    return _stream_object(f"{job_id}/{tile_path}", request)


def _guess_media_type(path: str) -> str:
    dot = path.rfind(".")
    if dot == -1:
        return "application/octet-stream"
    return _MEDIA_TYPES.get(path[dot:].lower(), "application/octet-stream")
