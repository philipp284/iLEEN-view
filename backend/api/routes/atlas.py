"""
Atlas (World Labs, Marble 2): aus einer Ansicht des Modells ein Foto.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

    GET    /atlas/status                       Schlüssel da? Nimmt World Labs ihn an?
    GET    /atlas/laeufe                       alle Läufe, neueste zuerst (Kopfdaten)
    POST   /atlas/laeufe                       Lauf anlegen: Beschreibung, Kameras, Optionen
    PUT    /atlas/laeufe/{id}/tiefe/{i}        Tiefe der Ansicht i (float32 1280×720, Zeile 0 oben)
    PUT    /atlas/laeufe/{id}/bild/{i}         Bild der Szene an Ansicht i (PNG)
    POST   /atlas/laeufe/{id}/starten          hochladen, einreichen, warten, Ergebnisse holen
    GET    /atlas/laeufe/{id}                  Stand des Laufs
    GET    /atlas/laeufe/{id}/datei/{name}     ergebnis_0.png, szene_0.png, tiefe_0.png, tiefe_0.exr …
    DELETE /atlas/laeufe/{id}
    POST   /atlas/mesh/{splat_job}             Mesh aus einem Splat-Asset (splats2Mesh) anstoßen
    GET    /atlas/mesh/{splat_job}             Stand des Meshes (setzt ein unterbrochenes Warten fort)
    GET    /atlas/mesh                         alle Meshes

Der Viewer (``frontend/atlas*.js``) nimmt je Ansicht die Tiefe und die
Kamera auf; hier wird daraus ein ``atlasChisel``-Auftrag, und die Bilder
kommen zurück in den Bucket ``atlas``. Bezahlt wird je Auftrag — deshalb
bleibt jeder Lauf mit Anfrage, Operation und Ergebnis liegen, bis ihn jemand
löscht, und eine Wiederholung nach einem Netzaussetzer geht mit demselben
Idempotenzschlüssel hinaus (kein zweiter Auftrag).

Der Schlüssel kommt aus der Datei der World-Labs-CLI (``ileen/atlas.py``),
nie aus dem Browser.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from minio.error import S3Error

from ileen import atlas as A
from storage.minio_client import delete_prefix, get_bytes, get_json, get_minio, put_bytes, put_json

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "atlas"
FORMAT = "ileen-atlas"
HIMMEL_M = float(os.environ.get("ATLAS_HIMMEL_M", "10000"))

_KENNUNG = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$")
_DATEI = re.compile(r"^(ergebnis|szene|tiefe|ergebnis_tiefe)_[0-9]{1,2}\.(png|jpg|exr)$|^(anfrage|operation)\.json$")
_TYPEN = {"png": "image/png", "jpg": "image/jpeg", "exr": "image/x-exr", "json": "application/json"}

#: Läufe, an denen gerade ein Hintergrundauftrag arbeitet.
_aktiv: dict[str, asyncio.Task] = {}
#: Der letzte erfolgreiche Status — World Labs nicht bei jedem Öffnen des Reiters fragen.
_status_merk: dict = {"zeit": 0.0, "stand": None}


# ── Ablage ──────────────────────────────────────────────────────────────────

def _bucket():
    client = get_minio()
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)
    return client


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _kennung(kennung: str) -> str:
    if not _KENNUNG.match(kennung or ""):
        raise HTTPException(status_code=400, detail=f"Ungültige Laufkennung: {kennung!r}")
    return kennung


def _lauf(kennung: str) -> dict:
    try:
        return get_json(BUCKET, f"{_kennung(kennung)}/lauf.json")
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchObject", "NoSuchBucket"):
            raise HTTPException(status_code=404, detail="Kein Atlas-Lauf unter dieser Kennung") from e
        raise


def _ablegen(lauf: dict):
    lauf["geaendert"] = _jetzt()
    put_json(BUCKET, f"{lauf['id']}/lauf.json", lauf)


def _kopf(lauf: dict) -> dict:
    ansichten = lauf.get("ansichten") or []
    return {k: lauf.get(k) for k in ("id", "erstellt", "geaendert", "zustand", "meldung", "prompt",
                                     "promptUsed", "titel", "aufgabe", "fortschritt")} | {
        "ansichten": len(ansichten),
        "ergebnisse": sum(1 for a in ansichten if a.get("ergebnis")),
    }


# ── Status ──────────────────────────────────────────────────────────────────

@router.get("/status")
async def status(frisch: bool = False):
    jetzt = time.monotonic()
    merk = _status_merk["stand"]
    if merk and merk.get("gueltig") and not frisch and jetzt - _status_merk["zeit"] < 120:
        return merk
    stand = await A.pruefen()
    _status_merk.update(zeit=jetzt, stand=stand)
    return stand


# ── Läufe ───────────────────────────────────────────────────────────────────

@router.get("/laeufe")
async def laeufe():
    client = _bucket()
    aus = []
    for o in client.list_objects(BUCKET, recursive=True):
        teile = o.object_name.split("/")
        if len(teile) == 2 and teile[1] == "lauf.json":
            try:
                aus.append(_kopf(get_json(BUCKET, o.object_name)))
            except (S3Error, ValueError):
                continue
    aus.sort(key=lambda k: k.get("erstellt") or "", reverse=True)
    return {"laeufe": aus}


@router.post("/laeufe")
async def lauf_anlegen(request: Request):
    """Legt einen Lauf an. Körper::

        {prompt, titel?, aufgabe: "atlasChisel",
         optionen: {enhancePrompt, seed, voxelSize, farbvorgabe, returnDepth},
         bezug: {ursprung_ecef, achsen}, modelle: [...],
         ansichten: [{name, kamera: {extrinsics, intrinsics}, pose: {pos, hpr, fov}}]}
    """
    try:
        daten = json.loads(await request.body())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Kein JSON: {e}") from e
    if not isinstance(daten, dict):
        raise HTTPException(status_code=400, detail="Erwartet ein JSON-Objekt")
    prompt = str(daten.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="Ohne Beschreibung der Szene malt Atlas nichts (prompt)")
    if len(prompt) > 4000:
        raise HTTPException(status_code=422, detail="Beschreibung zu lang (höchstens 4000 Zeichen)")
    roh = daten.get("ansichten") or []
    if not isinstance(roh, list) or not 1 <= len(roh) <= 32:
        raise HTTPException(status_code=422, detail="1 bis 32 Ansichten je Lauf")
    ansichten = []
    for i, a in enumerate(roh):
        try:
            kamera = A.kamera_pruefen((a or {}).get("kamera") or {}, f"Ansicht {i + 1}")
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        ansichten.append({"name": str((a or {}).get("name") or f"Ansicht {i + 1}")[:80],
                          "kamera": kamera, "pose": (a or {}).get("pose"),
                          "tiefe": False, "bild": False, "ergebnis": None})
    opt = daten.get("optionen") or {}
    optionen = {
        "enhancePrompt": bool(opt.get("enhancePrompt", True)),
        "seed": int(opt["seed"]) if str(opt.get("seed", "")).strip().lstrip("-").isdigit() else None,
        "voxelSize": float(opt["voxelSize"]) if opt.get("voxelSize") not in (None, "", 0, "0") else None,
        "farbvorgabe": bool(opt.get("farbvorgabe", False)),
        "returnDepth": bool(opt.get("returnDepth", False)),
    }
    if optionen["voxelSize"] is not None and not 0 <= optionen["voxelSize"] <= 1:
        raise HTTPException(status_code=422, detail="voxelSize liegt sinnvoll zwischen 0 und 0,4")
    kennung = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    lauf = {
        "format": FORMAT, "version": 1, "id": kennung,
        "aufgabe": "atlasChisel", "erstellt": _jetzt(), "zustand": "entwurf", "meldung": None,
        "titel": str(daten.get("titel") or "")[:120] or None,
        "prompt": prompt, "promptUsed": None, "optionen": optionen,
        "bezug": daten.get("bezug"), "modelle": daten.get("modelle"),
        "ansichten": ansichten, "operation": None, "versuche": 0, "fortschritt": None,
    }
    _bucket()
    _ablegen(lauf)
    return lauf


@router.put("/laeufe/{kennung}/tiefe/{i}")
async def tiefe_ablegen(kennung: str, i: int, request: Request):
    lauf = _lauf(kennung)
    if lauf["zustand"] != "entwurf":
        raise HTTPException(status_code=409, detail="Der Lauf ist schon gestartet")
    if not 0 <= i < len(lauf["ansichten"]):
        raise HTTPException(status_code=404, detail="Keine Ansicht mit dieser Nummer")
    roh = await request.body()
    try:
        tiefe, stat = A.tiefe_aufbereiten(roh, HIMMEL_M)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if stat["himmel_anteil"] > 0.97:
        raise HTTPException(status_code=422, detail=f"Ansicht {i + 1} trifft fast nur Himmel — "
                                                    "kein Modell im Bild?")
    exr = await asyncio.to_thread(A.exr_schreiben, tiefe)
    vorschau = await asyncio.to_thread(A.tiefe_vorschau_png, tiefe, HIMMEL_M)
    put_bytes(BUCKET, f"{kennung}/tiefe_{i}.exr", exr, _TYPEN["exr"])
    put_bytes(BUCKET, f"{kennung}/tiefe_{i}.png", vorschau, _TYPEN["png"])
    lauf = _lauf(kennung)
    lauf["ansichten"][i]["tiefe"] = True
    lauf["ansichten"][i]["tiefe_stat"] = stat
    _ablegen(lauf)
    return {"ansicht": i, **stat}


@router.put("/laeufe/{kennung}/bild/{i}")
async def bild_ablegen(kennung: str, i: int, request: Request):
    lauf = _lauf(kennung)
    if lauf["zustand"] != "entwurf":
        raise HTTPException(status_code=409, detail="Der Lauf ist schon gestartet")
    if not 0 <= i < len(lauf["ansichten"]):
        raise HTTPException(status_code=404, detail="Keine Ansicht mit dieser Nummer")
    roh = await request.body()
    if not roh.startswith(b"\x89PNG"):
        raise HTTPException(status_code=415, detail="Das Bild der Szene muss ein PNG sein")
    if len(roh) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Bild zu groß")
    put_bytes(BUCKET, f"{kennung}/szene_{i}.png", roh, _TYPEN["png"])
    lauf["ansichten"][i]["bild"] = True
    _ablegen(lauf)
    return {"ansicht": i, "bytes": len(roh)}


@router.post("/laeufe/{kennung}/starten")
async def starten(kennung: str):
    lauf = _lauf(kennung)
    if kennung in _aktiv and not _aktiv[kennung].done():
        return lauf
    if lauf["zustand"] in ("hochladen", "eingereicht"):
        _fortsetzen(lauf)
        return _lauf(kennung)
    if lauf["zustand"] == "fertig":
        raise HTTPException(status_code=409, detail="Der Lauf ist fertig — für eine Variante einen neuen anlegen")
    fehlt = [str(n + 1) for n, a in enumerate(lauf["ansichten"]) if not a.get("tiefe")]
    if fehlt:
        raise HTTPException(status_code=409, detail=f"Tiefe fehlt für Ansicht {', '.join(fehlt)}")
    if lauf["optionen"].get("farbvorgabe"):
        ohne = [str(n + 1) for n, a in enumerate(lauf["ansichten"]) if not a.get("bild")]
        if ohne:
            raise HTTPException(status_code=409, detail=f"Bild der Szene fehlt für Ansicht {', '.join(ohne)}")
    lauf["zustand"] = "hochladen"
    lauf["meldung"] = None
    lauf["versuche"] = int(lauf.get("versuche") or 0) + 1
    lauf["operation"] = None
    _ablegen(lauf)
    _aktiv[kennung] = asyncio.create_task(_ablauf(kennung))
    return lauf


@router.get("/laeufe/{kennung}")
async def lauf_lesen(kennung: str):
    lauf = _lauf(kennung)
    if lauf["zustand"] in ("hochladen", "eingereicht") and not (kennung in _aktiv and not _aktiv[kennung].done()):
        # Der Container ist neu gestartet, während der Lauf arbeitete.
        _fortsetzen(lauf)
        lauf = _lauf(kennung)
    return lauf


@router.get("/laeufe/{kennung}/datei/{name}")
async def datei(kennung: str, name: str):
    _kennung(kennung)
    if not _DATEI.match(name):
        raise HTTPException(status_code=400, detail="Unbekannte Datei")
    try:
        daten = get_bytes(BUCKET, f"{kennung}/{name}")
    except S3Error as e:
        raise HTTPException(status_code=404, detail="Datei nicht vorhanden") from e
    return Response(content=daten, media_type=_TYPEN[name.rsplit(".", 1)[1]],
                    headers={"Cache-Control": "private, max-age=86400"})


@router.delete("/laeufe/{kennung}")
async def lauf_loeschen(kennung: str):
    _kennung(kennung)
    aufgabe = _aktiv.pop(kennung, None)
    if aufgabe and not aufgabe.done():
        # Das Warten endet hier; der Auftrag bei World Labs läuft weiter (und kostet).
        aufgabe.cancel()
    delete_prefix(BUCKET, kennung + "/")
    return {"id": kennung, "geloescht": True}


# ── Der Ablauf im Hintergrund ───────────────────────────────────────────────

def _fortsetzen(lauf: dict):
    kennung = lauf["id"]
    if lauf["zustand"] == "eingereicht" and (lauf.get("operation") or {}).get("id"):
        _aktiv[kennung] = asyncio.create_task(_ablauf(kennung, nur_warten=True))
    else:
        lauf["zustand"] = "fehler"
        lauf["meldung"] = "Unterbrochen, bevor der Auftrag eingereicht war — bitte erneut starten."
        _ablegen(lauf)


async def _ablauf(kennung: str, nur_warten: bool = False):
    try:
        if not nur_warten:
            await _einreichen(kennung)
        await _warten_und_holen(kennung)
    except asyncio.CancelledError:
        raise
    except A.AtlasFehler as e:
        _fehler(kennung, e.meldung)
    except Exception as e:  # noqa: BLE001 — jeder Fehler gehört in den Lauf, nicht nur ins Protokoll
        logger.exception("Atlas-Lauf %s gescheitert", kennung)
        _fehler(kennung, f"Interner Fehler: {e}")
    finally:
        _aktiv.pop(kennung, None)


def _fehler(kennung: str, meldung: str):
    try:
        lauf = _lauf(kennung)
    except HTTPException:
        return  # inzwischen gelöscht
    lauf["zustand"] = "fehler"
    lauf["meldung"] = meldung
    _ablegen(lauf)


async def _einreichen(kennung: str):
    lauf = _lauf(kennung)
    opt = lauf["optionen"]
    tiefen, quellen, kameras = [], [], []
    for i, a in enumerate(lauf["ansichten"]):
        _fortschritt(lauf, "hochladen", f"Ansicht {i + 1} von {len(lauf['ansichten'])}")
        exr = get_bytes(BUCKET, f"{kennung}/tiefe_{i}.exr")
        a["tiefe_asset"] = await A.asset_hochladen(exr, "image/x-exr", f"ileen-{kennung}-tiefe-{i}.exr")
        if opt.get("farbvorgabe"):
            png = get_bytes(BUCKET, f"{kennung}/szene_{i}.png")
            a["bild_asset"] = await A.asset_hochladen(png, "image/png", f"ileen-{kennung}-szene-{i}.png")
            quellen.append((a["bild_asset"], a["kamera"]))
        tiefen.append(a["tiefe_asset"])
        kameras.append(a["kamera"])
        _ablegen(lauf)
    koerper = A.chisel_koerper(prompt=lauf["prompt"], kameras=kameras, tiefen=tiefen, quellen=quellen,
                               enhance=opt.get("enhancePrompt", True), seed=opt.get("seed"),
                               voxel=opt.get("voxelSize"), return_depth=opt.get("returnDepth", False))
    put_json(BUCKET, f"{kennung}/anfrage.json", koerper)
    # Je Startversuch ein Schlüssel; innerhalb eines Versuchs wiederholt anfrage() mit demselben.
    schluessel = f"ileen-atlas-{kennung}-{lauf['versuche']}"
    _fortschritt(lauf, "einreichen", None)
    op = await A.aufgabe_einreichen(lauf["aufgabe"], koerper, schluessel)
    lauf = _lauf(kennung)
    lauf["operation"] = {"id": op.get("id"), "name": op.get("name"), "idempotenz": schluessel,
                         "eingereicht": _jetzt()}
    lauf["zustand"] = "eingereicht"
    _ablegen(lauf)
    if op.get("done"):
        put_json(BUCKET, f"{kennung}/operation.json", op)


async def _warten_und_holen(kennung: str):
    lauf = _lauf(kennung)
    op_id = (lauf.get("operation") or {}).get("id")
    if not op_id:
        raise A.AtlasFehler(502, "World Labs hat keine Operationskennung zurückgegeben")
    letzter = {"t": 0.0}

    def stand(op):
        meta = op.get("metadata") or {}
        jetzt = time.monotonic()
        if jetzt - letzter["t"] < 3:
            return
        letzter["t"] = jetzt
        l = _lauf(kennung)
        _fortschritt(l, meta.get("phase") or meta.get("state") or "rechnet", meta.get("progressPercent"))

    op = await A.operation_warten(op_id, bei_stand=stand)
    put_json(BUCKET, f"{kennung}/operation.json", op)
    if op.get("error"):
        fehler = op["error"] or {}
        raise A.AtlasFehler(500, f"World Labs meldet: {fehler.get('message') or fehler}")
    antwort = op.get("response") or {}
    frames = antwort.get("frames") or []
    lauf = _lauf(kennung)
    _fortschritt(lauf, "ergebnisse", f"{len(frames)} Bilder")
    for i, frame in enumerate(frames[:len(lauf["ansichten"])]):
        bild = await A.asset_lesen(frame.get("imageAsset") or {})
        endung = "jpg" if bild[:3] == b"\xff\xd8\xff" else "png"
        put_bytes(BUCKET, f"{kennung}/ergebnis_{i}.{endung}", bild, _TYPEN[endung])
        a = lauf["ansichten"][i]
        a["ergebnis"] = f"ergebnis_{i}.{endung}"
        a["ergebnis_asset"] = (frame.get("imageAsset") or {}).get("assetId")
        if frame.get("camera"):
            a["kamera_ergebnis"] = frame["camera"]
        tiefe = (frame.get("depth") or {}).get("depthAsset")
        if tiefe:
            put_bytes(BUCKET, f"{kennung}/ergebnis_tiefe_{i}.exr", await A.asset_lesen(tiefe), _TYPEN["exr"])
            a["ergebnis_tiefe"] = f"ergebnis_tiefe_{i}.exr"
        _ablegen(lauf)
    lauf["promptUsed"] = antwort.get("promptUsed")
    lauf["requestId"] = antwort.get("requestId")
    lauf["zustand"] = "fertig" if frames else "fehler"
    lauf["meldung"] = None if frames else "World Labs hat keine Bilder zurückgegeben"
    lauf["fortschritt"] = None
    lauf["fertig"] = _jetzt()
    _ablegen(lauf)


def _fortschritt(lauf: dict, phase: str, wert):
    lauf["fortschritt"] = {"phase": phase, "wert": wert, "zeit": _jetzt()}
    _ablegen(lauf)


# ═══ Mesh aus einem Splat (splats2Mesh) ════════════════════════════════════
#
#   POST /atlas/mesh/{splat_job}   {qualitaet, ansicht, zuschnitt}  → startet
#   GET  /atlas/mesh/{splat_job}   Stand (setzt ein unterbrochenes Warten fort)
#   GET  /atlas/mesh               alle Stände
#
# Der Stand liegt im Bucket `atlas` unter `mesh/<splat_job>.json`; das Mesh wird ein eigenes
# Asset (neue Kennung) mit der Platzierung des Splats (ileen/atlas_mesh.py). Aus dem
# Splat-Training heraus startet es die Übernahme, wenn der Auftrag `mesh` trägt.

_mesh_aktiv: dict[str, asyncio.Task] = {}
_JOB = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _splat_job(kennung: str) -> str:
    if not _JOB.match(kennung or ""):
        raise HTTPException(status_code=400, detail=f"Ungültige Asset-Kennung: {kennung!r}")
    return kennung


def _mesh_stand(splat_job: str) -> dict | None:
    try:
        return get_json(BUCKET, f"mesh/{splat_job}.json")
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchObject", "NoSuchBucket"):
            return None
        raise


def _mesh_ablegen(stand: dict) -> dict:
    stand["geaendert"] = _jetzt()
    put_json(BUCKET, f"mesh/{stand['splat_job']}.json", stand)
    return stand


def mesh_starten(splat_job: str, optionen: dict | None = None) -> dict:
    """Legt einen Mesh-Lauf an und startet ihn im Hintergrund. Auch vom Splat-Training gerufen."""
    from ileen import atlas_mesh as M

    o = optionen or {}
    qualitaet = o.get("qualitaet") if o.get("qualitaet") in M.QUALITAET else "standard"
    ansicht = o.get("ansicht") if o.get("ansicht") in M.ANSICHTEN else "aufnahme"
    alt = _mesh_stand(splat_job) or {}
    if alt.get("zustand") in ("vorbereiten", "hochladen", "eingereicht", "holen", "kacheln") \
            and splat_job in _mesh_aktiv and not _mesh_aktiv[splat_job].done():
        return alt
    _bucket()
    stand = _mesh_ablegen({
        "format": "ileen-atlas-mesh", "splat_job": splat_job, "erstellt": _jetzt(), "zustand": "vorbereiten",
        "meldung": "Splat wird vorbereitet…", "optionen": {"qualitaet": qualitaet, "ansicht": ansicht,
                                                         "zuschnitt": bool(o.get("zuschnitt", True))},
        "name": o.get("name"), "versuche": int(alt.get("versuche") or 0) + 1, "operation": None,
        "mesh_job": None, "vorige_meshes": [m for m in [alt.get("mesh_job"), *(alt.get("vorige_meshes") or [])] if m],
    })
    _mesh_aktiv[splat_job] = asyncio.create_task(_mesh_ablauf(splat_job))
    return stand


def _aufnahmeorte(splat_job: str):
    """Kamerazentren eines Foto-Splats (ENU = Quellrahmen der PLY), sonst None."""
    from splatwerk import auftrag as AU
    from splatwerk import colmap_modell

    try:
        pfad = AU.verzeichnis(splat_job) / "colmap" / "txt_ausgerichtet" / "images.txt"
    except ValueError:
        return None
    if not pfad.exists():
        return None
    import numpy as np
    return np.array([b["zentrum"] for b in colmap_modell.lese_bilder_txt(pfad)])


async def _mesh_ablauf(splat_job: str, nur_warten: bool = False):
    try:
        if not nur_warten:
            await _mesh_einreichen(splat_job)
        await _mesh_holen(splat_job)
    except asyncio.CancelledError:
        raise
    except A.AtlasFehler as e:
        _mesh_fehler(splat_job, e.meldung)
    except HTTPException as e:
        _mesh_fehler(splat_job, str(e.detail))
    except Exception as e:  # noqa: BLE001
        logger.exception("Mesh aus Splat %s gescheitert", splat_job)
        _mesh_fehler(splat_job, f"Interner Fehler: {e}")
    finally:
        _mesh_aktiv.pop(splat_job, None)


def _mesh_fehler(splat_job: str, meldung: str):
    stand = _mesh_stand(splat_job)
    if stand:
        stand.update(zustand="fehler", meldung=meldung)
        _mesh_ablegen(stand)


def _splat_vorbereiten(splat_job: str) -> tuple[bytes, dict, list, str]:
    """(SPZ, Aufbereitung ohne Bytes, Ansichtspunkte, Anzeigename) — läuft im Thread."""
    import tempfile
    from pathlib import Path

    from api.routes.splat_export import _anzeigename, _quelle
    from ileen import atlas_mesh as M

    bucket, objekt = _quelle(splat_job)
    with tempfile.TemporaryDirectory() as tmp:
        ply = Path(tmp) / "splat.ply"
        get_minio().fget_object(bucket, objekt, str(ply))
        aufb = M.splat_aufbereiten(ply)
    daten = aufb.pop("spz")
    anker = M.anker(_aufnahmeorte(splat_job), aufb["mitte"])
    return daten, {k: (v.tolist() if hasattr(v, "tolist") else v) for k, v in aufb.items()}, anker, _anzeigename(splat_job)


async def _mesh_einreichen(splat_job: str):
    from ileen import atlas_mesh as M

    stand = _mesh_stand(splat_job)
    o = stand["optionen"]
    daten, aufb, anker, name = await asyncio.to_thread(_splat_vorbereiten, splat_job)
    put_json(BUCKET, f"mesh/{splat_job}/aufbereitung.json", {**aufb, "anker": anker})
    stand.update(zustand="hochladen", meldung=f"Splat an World Labs ({len(daten) / 1e6:.1f} MB SPZ)…",
                 splats=aufb["anzahl"], anker=len(anker), name=stand.get("name") or f"{name} — Mesh (Atlas)")
    _mesh_ablegen(stand)
    asset = await A.asset_hochladen(daten, "application/octet-stream", f"ileen-{splat_job[:8]}.spz")
    if o["ansicht"] == "aufnahme" and not anker:
        o["ansicht"] = "auto"           # kein Foto-Splat: keine Aufnahmeorte bekannt
    koerper = M.anfrage(asset, aufb, o["qualitaet"], o["ansicht"], anker, o["zuschnitt"])
    put_json(BUCKET, f"mesh/{splat_job}/anfrage.json", koerper)
    schluessel = f"ileen-mesh-{splat_job}-{stand['versuche']}"
    op = await A.aufgabe_einreichen("splats2Mesh", koerper, schluessel)
    stand.update(zustand="eingereicht", meldung="World Labs rechnet das Mesh…", optionen=o,
                 operation={"id": op.get("id"), "idempotenz": schluessel, "eingereicht": _jetzt()})
    _mesh_ablegen(stand)


async def _mesh_holen(splat_job: str):
    from ileen import atlas_mesh as M

    stand = _mesh_stand(splat_job)
    op_id = (stand.get("operation") or {}).get("id")
    if not op_id:
        raise A.AtlasFehler(502, "World Labs hat keine Operationskennung zurückgegeben")
    letzter = {"t": 0.0}

    def zwischenstand(op):
        meta = op.get("metadata") or {}
        if time.monotonic() - letzter["t"] < 5:
            return
        letzter["t"] = time.monotonic()
        s = _mesh_stand(splat_job) or stand
        p = meta.get("progressPercent")
        s["meldung"] = "World Labs rechnet das Mesh" + (f" — {meta.get('phase')}" if meta.get("phase") else "") \
            + (f" ({p} %)" if p is not None else "") + "…"
        _mesh_ablegen(s)

    op = await A.operation_warten(op_id, bei_stand=zwischenstand, frist_s=4 * 3600)
    put_json(BUCKET, f"mesh/{splat_job}/operation.json", op)
    fehler = A.fehler_der_operation(op)
    if fehler:
        raise A.AtlasFehler(500, fehler)
    mesh = (op.get("response") or {}).get("mesh")
    if not mesh:
        raise A.AtlasFehler(502, "World Labs hat kein Mesh zurückgegeben")
    stand = _mesh_stand(splat_job)
    stand.update(zustand="holen", meldung="Mesh abholen…")
    _mesh_ablegen(stand)
    glb = await A.asset_lesen(mesh)
    put_bytes(BUCKET, f"mesh/{splat_job}/atlas.glb", glb, "model/gltf-binary")
    stand.update(zustand="kacheln", meldung=f"Mesh ({len(glb) / 1e6:.1f} MB) wird gekachelt und verortet…")
    _mesh_ablegen(stand)
    mesh_job, bericht = await asyncio.to_thread(_mesh_asset, splat_job, glb, stand["name"])
    stand = _mesh_stand(splat_job)
    stand.update(zustand="fertig", meldung="Fertig — das Mesh liegt auf dem Splat.", mesh_job=mesh_job,
                 bericht=bericht, fertig=_jetzt(),
                 asset={"job_id": mesh_job, "tileset_url": f"/tiles/{mesh_job}/tileset.json"})
    _mesh_ablegen(stand)
    logger.info("[%s] Mesh aus Splat fertig: %s %s", splat_job[:8], mesh_job, bericht)


def _mesh_asset(splat_job: str, glb: bytes, name: str) -> tuple[str, dict]:
    """GLB → eigenes Mesh-Asset mit der Platzierung des Splats. Läuft im Thread."""
    import io
    import shutil
    import tempfile
    import uuid as _uuid
    from pathlib import Path

    from api.routes.placement import _apply, load_placement
    from api.routes.upload import JOBS
    from ileen import atlas_mesh as M
    from splatwerk import auftrag as AU
    from splatwerk.uebernahme import ankerpunkt
    from storage.minio_client import upload_directory
    from tiling.formats.mesh import tile_mesh_objekt

    import numpy as np

    aufb = get_json(BUCKET, f"mesh/{splat_job}/aufbereitung.json")
    if not aufb.get("kernpunkte"):
        # Aufbereitung von vor der Lagemessung: Kernpunkte aus derselben PLY nachholen (Mitte bleibt gleich).
        _, neu, _, _ = _splat_vorbereiten(splat_job)
        if np.allclose(neu["mitte"], aufb["mitte"], atol=1e-6):
            aufb["kernpunkte"] = neu["kernpunkte"]
            put_json(BUCKET, f"mesh/{splat_job}/aufbereitung.json", aufb)
    anker_splat, _ = ankerpunkt(get_json("tiles", f"{splat_job}/tileset.json"))
    mesh, bericht = M.mesh_zurueck(glb, aufb, anker_splat)
    mesh_job = str(_uuid.uuid4())
    dateiname = AU.sauberer_name(name, "mesh") + ".glb"
    out = Path(tempfile.mkdtemp(prefix=f"mesh_{mesh_job[:8]}_"))
    try:
        # Die Quelle so, wie die Pipeline GLB liest (Scheitelwerte Z oben): ein erneutes
        # Kacheln (Materialassistent) ergibt dasselbe Tileset.
        puffer = io.BytesIO()
        mesh.export(puffer, file_type="glb")
        get_minio().put_object("uploads", f"{mesh_job}/{dateiname}", io.BytesIO(puffer.getvalue()),
                               length=len(puffer.getvalue()), content_type="model/gltf-binary")
        versatz = tile_mesh_objekt(mesh, out, Path(dateiname).stem)
        upload_directory(out, bucket="tiles", prefix=mesh_job)
    finally:
        shutil.rmtree(out, ignore_errors=True)
    platzierung = M.platzierung_fuer_mesh(load_placement(splat_job), versatz)
    _apply(mesh_job, platzierung)
    # Gemessene Farben: der Viewer neutralisiert sonst die Eigenfarbe wie bei einem IFC (farben.js).
    ts = get_json("tiles", f"{mesh_job}/tileset.json")
    ts["extras"] = {**(ts.get("extras") or {}), "ileen_quelle": "photogrammetrie", "aus_splat": splat_job}
    put_json("tiles", f"{mesh_job}/tileset.json", ts)
    put_json("tiles", f"{mesh_job}/meta.json", {"display_name": name, "aus_splat": splat_job,
                                                "verfahren": "World Labs splats2Mesh"})
    JOBS[mesh_job] = {"job_id": mesh_job, "filename": dateiname, "status": "done",
                      "message": "Mesh aus Splat (World Labs).", "tileset_url": f"/tiles/{mesh_job}/tileset.json",
                      "updated_at": _jetzt()}
    bericht["versatz"] = [round(float(v), 4) for v in versatz]
    return mesh_job, bericht


@router.post("/mesh/{splat_job}")
async def mesh_anlegen(splat_job: str, request: Request):
    _splat_job(splat_job)
    try:
        o = json.loads(await request.body() or b"{}")
    except ValueError:
        o = {}
    from api.routes.splat_export import _quelle
    await asyncio.to_thread(_quelle, splat_job)       # 404/409, bevor etwas bezahlt wird
    return mesh_starten(splat_job, o if isinstance(o, dict) else {})


@router.post("/mesh/{splat_job}/neu-aufbauen")
async def mesh_neu_aufbauen(splat_job: str):
    """Das schon bezahlte GLB von World Labs neu verorten und kacheln — ohne neuen Auftrag.

    Für den Fall, dass sich am Rückweg etwas geändert hat (Lage, Platzierung des Splats). Das
    neue Mesh wird ein neues Asset; das alte steht danach unter ``vorige_meshes``.
    """
    stand = _mesh_stand(_splat_job(splat_job))
    if not stand:
        raise HTTPException(status_code=404, detail="Für diesen Splat wurde noch kein Mesh angestoßen")
    if splat_job in _mesh_aktiv and not _mesh_aktiv[splat_job].done():
        raise HTTPException(status_code=409, detail="Für diesen Splat läuft gerade ein Mesh")
    try:
        glb = get_bytes(BUCKET, f"mesh/{splat_job}/atlas.glb")
    except S3Error:
        raise HTTPException(status_code=409, detail="Kein Mesh von World Labs gespeichert — erst eins rechnen lassen")
    mesh_job, bericht = await asyncio.to_thread(_mesh_asset, splat_job, glb, stand.get("name") or "Mesh (Atlas)")
    stand = _mesh_stand(splat_job)
    stand.update(zustand="fertig", meldung="Neu aufgebaut — das Mesh liegt auf dem Splat.", mesh_job=mesh_job,
                 bericht=bericht, fertig=_jetzt(),
                 vorige_meshes=[m for m in [stand.get("mesh_job"), *(stand.get("vorige_meshes") or [])] if m],
                 asset={"job_id": mesh_job, "tileset_url": f"/tiles/{mesh_job}/tileset.json"})
    _mesh_ablegen(stand)
    logger.info("[%s] Mesh neu aufgebaut: %s %s", splat_job[:8], mesh_job, bericht)
    return stand


@router.get("/mesh")
async def mesh_liste():
    client = _bucket()
    aus = []
    for o in client.list_objects(BUCKET, prefix="mesh/", recursive=False):
        if o.object_name.endswith(".json"):
            try:
                aus.append(get_json(BUCKET, o.object_name))
            except (S3Error, ValueError):
                continue
    aus.sort(key=lambda s: s.get("erstellt") or "", reverse=True)
    return {"meshes": aus}


@router.get("/mesh/{splat_job}")
async def mesh_lesen(splat_job: str):
    stand = _mesh_stand(_splat_job(splat_job))
    if not stand:
        raise HTTPException(status_code=404, detail="Für diesen Splat wurde noch kein Mesh angestoßen")
    laeuft = splat_job in _mesh_aktiv and not _mesh_aktiv[splat_job].done()
    if not laeuft and stand.get("zustand") in ("vorbereiten", "hochladen", "eingereicht", "holen", "kacheln"):
        if stand.get("zustand") in ("eingereicht", "holen", "kacheln") and (stand.get("operation") or {}).get("id"):
            _mesh_aktiv[splat_job] = asyncio.create_task(_mesh_ablauf(splat_job, nur_warten=True))
        else:
            stand.update(zustand="fehler", meldung="Unterbrochen, bevor der Auftrag eingereicht war — bitte erneut starten.")
            _mesh_ablegen(stand)
    return stand


def purge(job_id: str):
    """Beim Löschen eines Assets: sein Mesh-Stand (als Splat) und Verweise auf es (als Mesh).

    Das Mesh-Asset selbst bleibt, wenn der Splat gelöscht wird — es ist ein eigenes Asset.
    Gelöscht wird nur der Stand, der sonst ein Mesh zum Laden anböte, das es nicht mehr gibt.
    """
    try:
        client = _bucket()
        delete_prefix(BUCKET, f"mesh/{job_id}/")
        client.remove_object(BUCKET, f"mesh/{job_id}.json")
        for o in client.list_objects(BUCKET, prefix="mesh/", recursive=False):
            if o.object_name.endswith(".json"):
                stand = get_json(BUCKET, o.object_name)
                if stand.get("mesh_job") == job_id:
                    stand.update(mesh_job=None, zustand="fehler", meldung="Das Mesh-Asset wurde gelöscht.")
                    _mesh_ablegen(stand)
                elif job_id in (stand.get("vorige_meshes") or []):
                    stand["vorige_meshes"] = [m for m in stand["vorige_meshes"] if m != job_id]
                    _mesh_ablegen(stand)
    except Exception as e:  # noqa: BLE001 — das Löschen des Assets darf daran nicht scheitern
        logger.warning("[%s] Atlas-Mesh-Stand nicht aufgeräumt: %s", job_id, e)
