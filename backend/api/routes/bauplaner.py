"""
Tragwerksaufträge aus dem Bauplaner: Ablage für den Weg zur Tragwerksplanung und zurück.

    GET    /bauplaner/auftraege                     Aufträge: Plan, Nummer, Titel, ob ein Ergebnis da ist
    PUT    /bauplaner/auftraege/{plan}              Auftrag ablegen (der Entwurf als Tragwerksexport)
    GET    /bauplaner/auftraege/{plan}              Auftrag lesen
    PUT    /bauplaner/auftraege/{plan}/ergebnis     Ergebnis ablegen (Querschnitte je Gruppe, η je Bauteil)
    GET    /bauplaner/auftraege/{plan}/ergebnis     Ergebnis lesen — 404, solange keines da ist
    PUT    /bauplaner/auftraege/{plan}/bericht      Bericht als Markdown ablegen (Rohtext)
    GET    /bauplaner/auftraege/{plan}/bericht      Bericht lesen
    DELETE /bauplaner/auftraege/{plan}

Gerechnet wird hier nichts — wie beim Einsturz. Der Bauplaner (frontend/
bauplaner-tragwerk.js) legt seinen Entwurf als Auftrag ab, der twp-Skill
(`~/.claude/skills/twp/werkzeuge/bauplaner_tragwerk.py`) holt ihn, rechnet,
bemisst und legt das Ergebnis daneben; der Bauplaner fragt danach und
übernimmt die Querschnitte. Die Statik gehört in die geprüfte Kette, nicht in
eine zweite Fassung im Server.

Jeder neue Auftrag bekommt eine fortlaufende Nummer je Plan. Das Ergebnis
nennt die Nummer, zu der es gerechnet wurde (`auftrag_nummer`): Schickt
jemand einen geänderten Entwurf, während twp noch am alten rechnet, sieht
der Bauplaner, dass das eintreffende Ergebnis zum alten Stand gehört.
"""

import json
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse
from minio.error import S3Error

from storage.minio_client import delete_prefix, get_bytes, get_json, get_minio, put_bytes, put_json

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "bauplaner"
_NAME = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
_MAX = 40 * 1024 * 1024        # 40 MB — ein Hochhaus im Bauplaner hat einige tausend Bauteile


def _bucket():
    client = get_minio()
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)
    return client


def _plan(plan: str) -> str:
    if not _NAME.match(plan) or ".." in plan:
        raise HTTPException(status_code=400, detail=f"Ungültiger Plan: {plan!r}")
    return plan


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _lesen(objekt: str):
    try:
        return get_json(BUCKET, objekt)
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchObject"):
            return None
        raise


async def _json_koerper(request: Request) -> dict:
    roh = await request.body()
    if len(roh) > _MAX:
        raise HTTPException(status_code=413, detail="Auftrag zu groß")
    try:
        daten = json.loads(roh)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Kein JSON: {e}")
    if not isinstance(daten, dict):
        raise HTTPException(status_code=400, detail="Erwartet ein JSON-Objekt")
    return daten


@router.get("/auftraege")
async def auftraege():
    """Alle Aufträge mit Kopfdaten, der jüngste zuerst."""
    client = _bucket()
    plaene = set()
    for o in client.list_objects(BUCKET, recursive=True):
        teile = o.object_name.split("/")
        if len(teile) == 2:
            plaene.add(teile[0])
    out = []
    for p in plaene:
        kopf = _lesen(f"{p}/kopf.json") or {}
        out.append({"plan": p, **kopf})
    out.sort(key=lambda k: k.get("eingang", ""), reverse=True)
    return {"auftraege": out}


@router.put("/auftraege/{plan}")
async def auftrag_ablegen(plan: str, request: Request):
    plan = _plan(plan)
    daten = await _json_koerper(request)
    if daten.get("format") != "ileen-bauplaner-tragwerk":
        raise HTTPException(status_code=400, detail="format muss 'ileen-bauplaner-tragwerk' sein")
    _bucket()
    alt = _lesen(f"{plan}/kopf.json") or {}
    nummer = int(alt.get("nummer", 0)) + 1
    daten["nummer"] = nummer
    daten["eingang"] = _jetzt()
    put_json(BUCKET, f"{plan}/auftrag.json", daten)
    kopf = {
        "nummer": nummer, "eingang": daten["eingang"], "titel": daten.get("titel", plan),
        "bauweise": (daten.get("erzeuger") or {}).get("bauweise"),
        "bauteile": len(daten.get("bauteile") or []),
        "ergebnis": alt.get("ergebnis"), "ergebnis_nummer": alt.get("ergebnis_nummer"),
    }
    put_json(BUCKET, f"{plan}/kopf.json", kopf)
    logger.info("Bauplaner-Auftrag %s Nr. %s: %s Bauteile", plan, nummer, kopf["bauteile"])
    return {"plan": plan, "nummer": nummer, "eingang": daten["eingang"]}


@router.get("/auftraege/{plan}")
async def auftrag_lesen(plan: str):
    daten = _lesen(f"{_plan(plan)}/auftrag.json")
    if daten is None:
        raise HTTPException(status_code=404, detail="Kein Auftrag unter diesem Plan")
    return daten


@router.put("/auftraege/{plan}/ergebnis")
async def ergebnis_ablegen(plan: str, request: Request):
    plan = _plan(plan)
    daten = await _json_koerper(request)
    if daten.get("format") != "ileen-bauplaner-tragwerk-ergebnis":
        raise HTTPException(status_code=400, detail="format muss 'ileen-bauplaner-tragwerk-ergebnis' sein")
    kopf = _lesen(f"{plan}/kopf.json")
    if kopf is None:
        raise HTTPException(status_code=404, detail="Zu diesem Plan gibt es keinen Auftrag")
    daten.setdefault("erstellt", _jetzt())
    put_json(BUCKET, f"{plan}/ergebnis.json", daten)
    kopf["ergebnis"] = daten["erstellt"]
    kopf["ergebnis_nummer"] = daten.get("auftrag_nummer")
    put_json(BUCKET, f"{plan}/kopf.json", kopf)
    return {"plan": plan, "erstellt": daten["erstellt"], "auftrag_nummer": daten.get("auftrag_nummer")}


@router.get("/auftraege/{plan}/ergebnis")
async def ergebnis_lesen(plan: str):
    daten = _lesen(f"{_plan(plan)}/ergebnis.json")
    if daten is None:
        raise HTTPException(status_code=404, detail="Noch kein Ergebnis")
    return daten


@router.put("/auftraege/{plan}/bericht")
async def bericht_ablegen(plan: str, request: Request):
    plan = _plan(plan)
    roh = await request.body()
    if len(roh) > _MAX:
        raise HTTPException(status_code=413, detail="Bericht zu groß")
    put_bytes(BUCKET, f"{plan}/bericht.md", roh, content_type="text/markdown; charset=utf-8")
    return {"plan": plan, "bytes": len(roh)}


@router.get("/auftraege/{plan}/bericht", response_class=PlainTextResponse)
async def bericht_lesen(plan: str):
    try:
        return get_bytes(BUCKET, f"{_plan(plan)}/bericht.md").decode("utf-8")
    except S3Error:
        raise HTTPException(status_code=404, detail="Kein Bericht")


@router.delete("/auftraege/{plan}")
async def auftrag_loeschen(plan: str):
    delete_prefix(BUCKET, _plan(plan) + "/")
    return {"plan": plan, "geloescht": True}
