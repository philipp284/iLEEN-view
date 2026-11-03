"""
Rundgang-Endpunkt: aus 360°-Fotos eine tour.json bauen, ablegen, ausliefern.

    POST   /tour                 Fotos (+ optional Manifest/Anker) → {tour_id}
                                 mit entwurf=true: Bilder unverortet, Fotos optional
    GET    /tour                 alle Touren auflisten (mit verortet/ausgerichtet)
    GET    /tour/{id}/tour.json  die Tour, wie sie das Frontend lädt
    GET    /tour/{id}/pano/{f}   ein Panorama (gestreamt)
    GET    /tour/{id}/vorschau/{f}  Vorschaubild 640 × 320
    POST   /tour/{id}/bilder     Fotos unverortet anhängen (Import, ein Bild je Aufruf geht)
    PUT    /tour/{id}            Änderungen aus dem Editor (Lage, Richtung, Namen, Nachbarn, Reihenfolge)
    DELETE /tour/{id}

Das Frontend (pano-tour.js) lädt `…/tour/{id}/tour.json` und löst die relativen
Panorama-URLs (`pano/x.jpg`) gegen deren Basis auf — landet also wieder hier bei
`GET /tour/{id}/pano/x.jpg`. Deshalb schreibt der Kern die URLs relativ.

Der Rechenkern (Verortung, EXIF, Zusammenbau) steht server-frei in
`panorama_tour.py` und ist ohne dieses Backend prüfbar (tests/test_tour.py) —
hier liegt nur die Anbindung an Upload, Ablage und Auslieferung.
"""

import io
import json
import logging
import re
import uuid

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from minio.error import S3Error

import panorama_tour as kern
from storage.minio_client import (
    delete_prefix,
    get_json,
    get_minio,
    put_bytes,
    put_json,
)
from tiling import elevation

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "tour"
_CHUNK = 1024 * 1024
_ID = re.compile(r"[0-9a-f]{6,32}")


@router.post("", include_in_schema=True)
@router.post("/", include_in_schema=False)
async def tour_erstellen(
    files: list[UploadFile] | None = File(None, description="Equirectangulare 360°-Fotos"),
    name: str = Form("Rundgang"),
    entwurf: bool = Form(False, description="Bilder unverortet aufnehmen; verortet wird im Viewer"),
    manifest: str | None = Form(None, description="Optional: JSON mit Koordinaten je Datei"),
    lon: float | None = Form(None),
    lat: float | None = Form(None),
    hoehe: float | None = Form(None),
    spacing: float | None = Form(None, description="Abstand der Standpunkte (m) bei automatischer Reihe"),
    richtung: float | None = Form(None, description="Azimut der Reihe (Grad, 0=Nord)"),
):
    files = files or []
    if not files and not entwurf:
        raise HTTPException(status_code=400, detail="Keine Fotos übermittelt.")

    manifest_obj = None
    if manifest:
        try:
            manifest_obj = json.loads(manifest)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Manifest ist kein gültiges JSON: {e}")

    # Ankerpunkt für die automatische Reihe — nur wenn lon/lat gesetzt sind.
    anchor = None
    if lon is not None and lat is not None:
        anchor = {"lon": lon, "lat": lat}
        if hoehe is not None:
            anchor["hoehe"] = hoehe
        if spacing is not None:
            anchor["spacing"] = spacing
        if richtung is not None:
            anchor["richtung"] = richtung

    dateien = []
    for f in files:
        roh = await f.read()
        dateien.append((f.filename or "bild.jpg", roh))

    try:
        tour, objekte = kern.tour_zusammenstellen(
            name, dateien, manifest=manifest_obj, anchor=anchor, entwurf=entwurf,
            undulation=elevation.geoid_undulation())
    except ValueError as e:
        # Fachlicher Fehler (keine Bilder, keine Lage) → 422, mit dem Grund.
        raise HTTPException(status_code=422, detail=str(e))

    tour_id = uuid.uuid4().hex[:12]
    for pfad, roh, ctype in objekte:
        put_bytes(BUCKET, f"{tour_id}/{pfad}", roh, content_type=ctype)
    put_json(BUCKET, f"{tour_id}/tour.json", tour)

    logger.info("Tour %s angelegt: %d Spots%s", tour_id, len(tour["spots"]),
                " (Entwurf)" if entwurf else "")
    return {
        "tour_id": tour_id,
        "name": tour["name"],
        **kern.zaehlen(tour),
        "tour_url": f"/tour/{tour_id}/tour.json",
    }


def _tour_holen(tour_id: str) -> dict:
    if not _ID.fullmatch(tour_id or ""):
        raise HTTPException(status_code=400, detail="Ungültige Tour-Kennung.")
    try:
        return get_json(BUCKET, f"{tour_id}/tour.json")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Tour '{tour_id}' nicht gefunden.")


@router.post("/{tour_id}/bilder")
async def bilder_anhaengen(
    tour_id: str,
    files: list[UploadFile] = File(..., description="Equirectangulare 360°-Fotos"),
):
    """Fotos unverortet an eine Tour hängen — der Import schickt eins je Aufruf,
    damit der Viewer einen Fortschritt zeigen kann und kein Gigabyte auf einmal
    im Speicher liegt."""
    tour = _tour_holen(tour_id)
    dateien = []
    for f in files:
        dateien.append((f.filename or "bild.jpg", await f.read()))
    vorhandene = [s.get("id") for s in tour.get("spots", [])]
    spots, objekte = kern.bilder_aufnehmen(dateien, vorhandene_ids=vorhandene,
                                           nummer_ab=len(vorhandene) + 1)
    if not spots:
        raise HTTPException(status_code=422, detail="Keine Bilder (.jpg/.jpeg/.png) dabei.")
    for pfad, roh, ctype in objekte:
        put_bytes(BUCKET, f"{tour_id}/{pfad}", roh, content_type=ctype)
    tour.setdefault("spots", []).extend(spots)
    tour.setdefault("einstellungen", dict(kern.EINSTELLUNGEN_VORGABE))
    put_json(BUCKET, f"{tour_id}/tour.json", tour)
    logger.info("Tour %s: %d Bilder angehängt", tour_id, len(spots))
    return {"tour_id": tour_id, "neu": spots, **kern.zaehlen(tour)}


@router.put("/{tour_id}")
def tour_aendern(tour_id: str, aenderung: dict = Body(...)):
    """Was der Editor im Viewer festgelegt hat: Lage, Blickrichtung, Namen,
    Nachbarn, Reihenfolge — und welche Standpunkte wegfallen."""
    tour = _tour_holen(tour_id)
    try:
        neu, entfernt = kern.tour_bearbeiten(tour, aenderung)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    put_json(BUCKET, f"{tour_id}/tour.json", neu)
    minio = get_minio()
    for s in entfernt:
        for pfad in kern.objekte_von(s):
            try:
                minio.remove_object(BUCKET, f"{tour_id}/{pfad}")
            except S3Error:
                pass
    return JSONResponse(neu, headers={"Cache-Control": "no-cache"})


@router.get("")
@router.get("/", include_in_schema=False)
def touren_auflisten():
    """Alle Touren: id, Name, Spotzahl, Anlagezeit."""
    minio = get_minio()
    out = []
    try:
        for obj in minio.list_objects(BUCKET, recursive=True):
            if not obj.object_name.endswith("/tour.json"):
                continue
            tid = obj.object_name.split("/")[0]
            try:
                t = get_json(BUCKET, obj.object_name)
            except Exception:
                continue
            out.append({
                "tour_id": tid,
                "name": t.get("name", tid),
                **kern.zaehlen(t),
                "erstellt": t.get("erstellt"),
                "geaendert": t.get("geaendert"),
                "tour_url": f"/tour/{tid}/tour.json",
            })
    except S3Error as e:
        if e.code in ("NoSuchBucket",):
            return []
        raise HTTPException(status_code=502, detail=f"Storage-Fehler: {e.code}")
    out.sort(key=lambda x: x.get("erstellt") or "", reverse=True)
    return out


@router.get("/{tour_id}/tour.json")
def tour_lesen(tour_id: str):
    t = _tour_holen(tour_id)
    # Die Datei ändert sich beim Neuanlegen; der Browser darf sie nicht festhalten.
    return JSONResponse(t, headers={"Cache-Control": "no-cache"})


@router.get("/{tour_id}/pano/{dateiname}")
def panorama_lesen(tour_id: str, dateiname: str):
    return _objekt_streamen(tour_id, "pano", dateiname)


@router.get("/{tour_id}/vorschau/{dateiname}")
def vorschau_lesen(tour_id: str, dateiname: str):
    return _objekt_streamen(tour_id, "vorschau", dateiname)


def _objekt_streamen(tour_id: str, ordner: str, dateiname: str):
    # Kein Pfadausbruch: weder Kennung noch Dateiname dürfen ein Verzeichnis tragen.
    if not _ID.fullmatch(tour_id or "") or "/" in dateiname or "\\" in dateiname or ".." in dateiname:
        raise HTTPException(status_code=400, detail="Ungültiger Dateiname.")
    objekt = f"{tour_id}/{ordner}/{dateiname}"
    minio = get_minio()
    try:
        antwort = minio.get_object(BUCKET, objekt)
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchBucket"):
            raise HTTPException(status_code=404, detail=f"'{objekt}' nicht gefunden.")
        raise HTTPException(status_code=502, detail=f"Storage-Fehler: {e.code}")

    def strom():
        try:
            yield from antwort.stream(_CHUNK)
        finally:
            antwort.close()
            antwort.release_conn()

    ctype = kern.content_type(dateiname)
    size = antwort.headers.get("Content-Length")
    headers = {"Cache-Control": "public, max-age=86400"}
    if size:
        headers["Content-Length"] = size
    return StreamingResponse(strom(), media_type=ctype, headers=headers)


@router.delete("/{tour_id}")
def tour_loeschen(tour_id: str):
    if not _ID.fullmatch(tour_id or ""):
        raise HTTPException(status_code=400, detail="Ungültige Tour-Kennung.")
    delete_prefix(BUCKET, f"{tour_id}/")
    return {"geloescht": tour_id}
