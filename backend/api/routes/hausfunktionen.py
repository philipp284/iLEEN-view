"""
Hausfunktionen: Animationspakete eines Gebäudes im Betrieb ablegen und ausliefern.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

    GET    /hausfunktionen                          Modelle mit Paketen
    GET    /hausfunktionen/{job}                    Pakete zu einem Modell (Kopfdaten)
    GET    /hausfunktionen/{job}/{paket}/{datei}    hausfunktionen.json, geometrie.bin.gz
    PUT    /hausfunktionen/{job}/{paket}/{datei}    eine Datei ablegen (Rohkörper)
    POST   /hausfunktionen/{job}/{paket}/andocken   Bezug zum Tileset aus den Ankern rechnen
    DELETE /hausfunktionen/{job}/{paket}

Ein Paket im Format „ileen-hausfunktionen" beschreibt, was in einem Haus fließt:
Leitungen und Lastpfade als Kanäle (Polylinien im IFC-System, als Rohre
trianguliert in geometrie.bin.gz), Geräte als Knoten und Szenarien als
Zeitreihen je Kanal (Durchfluss, Leistung, Kraft). Gerechnet wird hier nichts —
die Simulation läuft in der Studie, der Viewer (`frontend/hausfunktionen.js`)
spielt sie ab. Ablage und Andocken wie beim Einsturz (`api/routes/einsturz.py`):
eigener Bucket, weil ein neues Tiling `tiles/<job>/` leert; der Bezug wird aus
Ankern (GlobalId + Hüllbox) gegen die Kacheln gemessen, nicht gerechnet.
"""

import json
import logging
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from minio.error import S3Error

from ileen import einsturz as anker
from storage.minio_client import delete_prefix, get_bytes, get_json, get_minio, put_bytes, put_json

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "hausfunktionen"
KOPF = "hausfunktionen.json"
_CHUNK = 1024 * 1024
_NAME = re.compile(r"^[A-Za-z0-9_.\-]+$")


def _pruefen(*teile: str):
    for t in teile:
        if not _NAME.match(t) or ".." in t:
            raise HTTPException(status_code=400, detail=f"Ungültiger Name: {t!r}")


def _kopf(paket: str, k: dict) -> dict:
    """Was die Auswahlliste braucht — ohne Kanäle und Zeitreihen."""
    return {
        "paket": paket,
        "titel": k.get("titel", paket),
        "untertitel": k.get("untertitel", ""),
        "kanaele": len(k.get("kanaele", [])),
        "erstellt": k.get("erstellt"),
        "angedockt": bool(k.get("bezug")),
        "systeme": [s.get("id") for s in k.get("systeme", [])],
        "szenarien": [{"id": s["id"], "titel": s.get("titel", s["id"]), "gruppe": s.get("gruppe", "")}
                      for s in k.get("szenarien", [])],
    }


@router.get("")
@router.get("/", include_in_schema=False)
def modelle():
    minio = get_minio()
    if not minio.bucket_exists(BUCKET):
        return {"modelle": []}
    zaehler: dict[str, int] = {}
    for obj in minio.list_objects(BUCKET, recursive=True):
        if obj.object_name.endswith("/" + KOPF):
            job = obj.object_name.split("/")[0]
            zaehler[job] = zaehler.get(job, 0) + 1
    return {"modelle": [{"job_id": j, "pakete": n} for j, n in sorted(zaehler.items())]}


@router.get("/{job_id}")
def pakete(job_id: str):
    _pruefen(job_id)
    minio = get_minio()
    out = []
    if minio.bucket_exists(BUCKET):
        for obj in minio.list_objects(BUCKET, prefix=f"{job_id}/", recursive=True):
            if not obj.object_name.endswith("/" + KOPF):
                continue
            paket = obj.object_name.split("/")[1]
            try:
                out.append(_kopf(paket, get_json(BUCKET, obj.object_name)))
            except Exception as fehler:
                logger.warning(f"Hausfunktionspaket {obj.object_name} unlesbar: {fehler}")
    return {"job_id": job_id, "pakete": sorted(out, key=lambda p: p["paket"])}


@router.get("/{job_id}/{paket}/{datei}")
def datei_lesen(job_id: str, paket: str, datei: str, request: Request):
    _pruefen(job_id, paket, datei)
    name = f"{job_id}/{paket}/{datei}"
    minio = get_minio()
    try:
        stand = minio.stat_object(BUCKET, name)
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchBucket"):
            raise HTTPException(status_code=404, detail=f"'{name}' nicht gefunden.")
        raise HTTPException(status_code=502, detail=f"Storage-Fehler: {e.code}")
    etag = f'"{stand.etag}"'
    kopf = {"ETag": etag, "Cache-Control": "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=kopf)
    antwort = minio.get_object(BUCKET, name)

    def strom():
        try:
            yield from antwort.stream(_CHUNK)
        finally:
            antwort.close()
            antwort.release_conn()

    kopf["Content-Length"] = str(stand.size)
    art = "application/json" if datei.endswith(".json") else "application/octet-stream"
    # Kein Content-Encoding: der Viewer entpackt die .bin.gz selbst (DecompressionStream)
    return StreamingResponse(strom(), media_type=art, headers=kopf)


@router.put("/{job_id}/{paket}/{datei}")
async def datei_ablegen(job_id: str, paket: str, datei: str, request: Request):
    _pruefen(job_id, paket, datei)
    if not (datei == KOPF or datei.endswith(".bin.gz")):
        raise HTTPException(status_code=400, detail=f"Erwartet {KOPF} oder *.bin.gz")
    roh = await request.body()
    if datei == KOPF:
        try:
            k = json.loads(roh)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"{KOPF} ist kein JSON.")
        if k.get("format") != "ileen-hausfunktionen":
            raise HTTPException(status_code=400, detail="Kein Paket im Format ileen-hausfunktionen.")
    minio = get_minio()
    if not minio.bucket_exists(BUCKET):
        minio.make_bucket(BUCKET)
    put_bytes(BUCKET, f"{job_id}/{paket}/{datei}", roh,
              content_type="application/json" if datei.endswith(".json") else "application/octet-stream")
    return {"abgelegt": f"{job_id}/{paket}/{datei}", "bytes": len(roh)}


@router.post("/{job_id}/{paket}/andocken")
def andocken(job_id: str, paket: str):
    """Bezug zum Tileset aus den Ankern rechnen — dieselbe Messung wie beim Einsturz (ileen/einsturz.py)."""
    _pruefen(job_id, paket)
    try:
        k = get_json(BUCKET, f"{job_id}/{paket}/{KOPF}")
    except Exception:
        raise HTTPException(status_code=404, detail=f"Paket {paket} zu {job_id} nicht gefunden.")
    try:
        tileset = get_json("tiles", f"{job_id}/tileset.json")
    except Exception:
        raise HTTPException(status_code=404, detail=f"Kein Tileset zu {job_id}.")
    if not k.get("anker"):
        raise HTTPException(status_code=422, detail="Das Paket hat keine Anker.")
    boxen = anker.tileset_boxen(tileset, lambda uri: get_bytes("tiles", f"{job_id}/{uri}"))
    try:
        bezug = anker.bezug_rechnen(k["anker"], boxen)
    except ValueError as fehler:
        raise HTTPException(status_code=422, detail=str(fehler))
    bezug["job_id"] = job_id
    bezug["wurzelbox"] = anker.wurzelbox(tileset)
    k["bezug"] = bezug
    put_json(BUCKET, f"{job_id}/{paket}/{KOPF}", k)
    logger.info(f"Hausfunktionen {job_id}/{paket} angedockt: {bezug['verschiebung']}, "
                f"Streuung {bezug['streuung_m'] * 1000:.3f} mm über {bezug['zur_probe']} Bauteile")
    return bezug


@router.delete("/{job_id}/{paket}")
def paket_loeschen(job_id: str, paket: str):
    _pruefen(job_id, paket)
    delete_prefix(BUCKET, f"{job_id}/{paket}/")
    return {"geloescht": f"{job_id}/{paket}"}


def purge(job_id: str):
    """Alle Hausfunktionspakete eines Modells — beim Löschen des Assets (assets.delete_asset)."""
    try:
        delete_prefix(BUCKET, f"{job_id}/")
    except Exception as fehler:
        logger.warning(f"Hausfunktionen {job_id} nicht abgeräumt: {fehler}")
