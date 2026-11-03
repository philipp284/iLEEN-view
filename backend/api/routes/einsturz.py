"""
Einsturz-Endpunkt: Einsturzsimulationen zu einem Modell ablegen und ausliefern.

    GET    /einsturz                              Modelle mit Einsturzpaketen
    GET    /einsturz/{job}                        Pakete zu einem Modell (Kopfdaten)
    GET    /einsturz/{job}/{paket}/{datei}        einsturz.json, geometrie.bin.gz, <szenario>.bin.gz
    PUT    /einsturz/{job}/{paket}/{datei}        eine Datei ablegen (Rohkörper)
    POST   /einsturz/{job}/{paket}/andocken       Bezug zum Tileset aus den Ankern rechnen
    DELETE /einsturz/{job}/{paket}

Gerechnet wird hier nichts. Eine Einsturzrechnung läuft Stunden auf der GPU
und entsteht in der Studie selbst (etwa `~/Projekte/Statik-LUX/kollaps/stb`);
ihr Exporter schreibt ein Paket, `scripts/einsturz_hochladen.py` legt es hier
ab und dockt es an. Der Viewer (`frontend/einsturz.js`) lädt die Dateien
unverändert — die `.bin.gz` sind gzip-Blobs, die er selbst entpackt. Deshalb
geht kein `Content-Encoding` mit: sonst entpackte der Browser vorher, und der
Leser bekäme etwas anderes als das, was im Paket steht.

Die Ablage steht im Bucket `einsturz` und nicht unter `tiles/<job>/`: ein
erneutes Tiling leert jenen Präfix. Umgekehrt kann ein neues Tiling den
tile-lokalen Ursprung verschieben — deshalb merkt sich der Bezug die Wurzelbox
des Tilesets, gegen das er gerechnet wurde, und der Viewer vergleicht sie.
"""

import json
import logging
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from minio.error import S3Error

from ileen import einsturz as kern
from storage.minio_client import delete_prefix, get_bytes, get_json, get_minio, put_bytes, put_json

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "einsturz"
_CHUNK = 1024 * 1024
_NAME = re.compile(r"^[A-Za-z0-9_.\-]+$")


def _pruefen(*teile: str):
    for t in teile:
        if not _NAME.match(t) or ".." in t:
            raise HTTPException(status_code=400, detail=f"Ungültiger Name: {t!r}")


def _kopf(paket: str, k: dict) -> dict:
    """Was die Auswahlliste braucht — ohne Anker, Bauteile und Zeitreihen."""
    return {
        "paket": paket,
        "titel": k.get("titel", paket),
        "untertitel": k.get("untertitel", ""),
        "koerper": k.get("koerper"),
        "erstellt": k.get("erstellt"),
        "angedockt": bool(k.get("bezug")),
        "bytes": (k.get("geometrie") or {}).get("bytes", 0),
        "szenarien": [
            {"schluessel": s["schluessel"], "kurz": s.get("kurz", s["schluessel"]),
             "titel": s.get("titel", ""), "bilder": s.get("F"), "bytes": s.get("bytes", 0)}
            for s in k.get("szenarien", [])
        ],
    }


@router.get("")
@router.get("/", include_in_schema=False)
def modelle():
    """Welche Modelle Einsturzpakete haben — damit der Viewer sie anbieten kann, ohne alle abzufragen."""
    minio = get_minio()
    zaehler: dict[str, int] = {}
    for obj in minio.list_objects(BUCKET, recursive=True):
        if obj.object_name.endswith("/einsturz.json"):
            job = obj.object_name.split("/")[0]
            zaehler[job] = zaehler.get(job, 0) + 1
    return {"modelle": [{"job_id": j, "pakete": n} for j, n in sorted(zaehler.items())]}


@router.get("/{job_id}")
def pakete(job_id: str):
    _pruefen(job_id)
    minio = get_minio()
    out = []
    for obj in minio.list_objects(BUCKET, prefix=f"{job_id}/", recursive=True):
        if not obj.object_name.endswith("/einsturz.json"):
            continue
        paket = obj.object_name.split("/")[1]
        try:
            out.append(_kopf(paket, get_json(BUCKET, obj.object_name)))
        except Exception as fehler:          # ein kaputtes Paket soll die Liste nicht leeren
            logger.warning(f"Einsturzpaket {obj.object_name} unlesbar: {fehler}")
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
    # Ein Paket wird beim Neuexport überschrieben; mit ETag kostet das
    # Nachfragen nur einen Hin- und Rückweg statt 20 MB
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
    return StreamingResponse(strom(), media_type=art, headers=kopf)


@router.put("/{job_id}/{paket}/{datei}")
async def datei_ablegen(job_id: str, paket: str, datei: str, request: Request):
    _pruefen(job_id, paket, datei)
    if not (datei == "einsturz.json" or datei.endswith(".bin.gz")):
        raise HTTPException(status_code=400, detail="Erwartet einsturz.json oder *.bin.gz")
    roh = await request.body()
    if datei == "einsturz.json":
        try:
            k = json.loads(roh)
        except ValueError:
            raise HTTPException(status_code=400, detail="einsturz.json ist kein JSON.")
        if k.get("format") != "ileen-einsturz":
            raise HTTPException(status_code=400, detail="Kein Paket im Format ileen-einsturz.")
    put_bytes(BUCKET, f"{job_id}/{paket}/{datei}", roh,
              content_type="application/json" if datei.endswith(".json") else "application/octet-stream")
    return {"abgelegt": f"{job_id}/{paket}/{datei}", "bytes": len(roh)}


@router.post("/{job_id}/{paket}/andocken")
def andocken(job_id: str, paket: str):
    """
    Den Bezug zum Tileset des Modells aus den Ankern des Pakets rechnen.

    Liest dazu sämtliche Kacheln — beim LUX 35 Stück, ein paar Sekunden.
    """
    _pruefen(job_id, paket)
    try:
        k = get_json(BUCKET, f"{job_id}/{paket}/einsturz.json")
    except Exception:
        raise HTTPException(status_code=404, detail=f"Paket {paket} zu {job_id} nicht gefunden.")
    try:
        tileset = get_json("tiles", f"{job_id}/tileset.json")
    except Exception:
        raise HTTPException(status_code=404, detail=f"Kein Tileset zu {job_id}.")
    if not k.get("anker"):
        raise HTTPException(status_code=422, detail="Das Paket hat keine Anker.")
    boxen = kern.tileset_boxen(tileset, lambda uri: get_bytes("tiles", f"{job_id}/{uri}"))
    try:
        bezug = kern.bezug_rechnen(k["anker"], boxen)
    except ValueError as fehler:
        raise HTTPException(status_code=422, detail=str(fehler))
    bezug["job_id"] = job_id
    bezug["wurzelbox"] = kern.wurzelbox(tileset)
    k["bezug"] = bezug
    put_json(BUCKET, f"{job_id}/{paket}/einsturz.json", k)
    logger.info(f"Einsturz {job_id}/{paket} angedockt: {bezug['verschiebung']}, "
                f"Streuung {bezug['streuung_m'] * 1000:.3f} mm über {bezug['zur_probe']} Bauteile")
    return bezug


@router.delete("/{job_id}/{paket}")
def paket_loeschen(job_id: str, paket: str):
    _pruefen(job_id, paket)
    delete_prefix(BUCKET, f"{job_id}/{paket}/")
    return {"geloescht": f"{job_id}/{paket}"}


def purge(job_id: str):
    """Alle Einsturzpakete eines Modells — beim Löschen des Assets (assets.delete_asset)."""
    delete_prefix(BUCKET, f"{job_id}/")
