"""
Nutzungsprotokoll und Ansichtsvorlagen des Viewers.

    POST /nutzung/ereignisse     Ereignisse anhängen (vom Viewer gebündelt, auch per sendBeacon)
    GET  /nutzung/auswertung     Zusammenfassung: Modelle, Tasten, Bereiche, Werkzeuge, Vorlagen, Zeiten
    GET  /nutzung/ereignisse     die rohen Ereignisse eines Zeitraums (zum Selbstauswerten)
    GET  /nutzung/zuletzt        zuletzt geladene Modelle, neueste zuerst
    GET  /nutzung/vorlagen       gespeicherte Ansichtsvorlagen
    PUT  /nutzung/vorlagen       die ganze Liste ersetzen

Ablage und Grenzen stehen in `ileen.nutzung`; dieser Router kennt keine Pfade.

**Warum `POST /ereignisse` den Rumpf selbst liest.** Beim Verlassen der Seite
schickt der Viewer per `navigator.sendBeacon`. Das kann keine Vorabanfrage
(CORS-Preflight) und darf deshalb nur einen der einfachen Typen tragen —
`text/plain`. FastAPI würde einen solchen Rumpf nicht als JSON-Modell
annehmen; die letzten Ereignisse einer Sitzung, also genau die, die zeigen,
womit sie aufhörte, gingen verloren.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Body, HTTPException, Query, Request

from ileen import nutzung

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/ereignisse")
async def ereignisse_anhaengen(request: Request):
    roh = await request.body()
    if len(roh) > 2_000_000:
        raise HTTPException(status_code=413, detail="Paket zu groß")
    try:
        paket = json.loads(roh.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=422, detail="kein JSON")
    try:
        n = await asyncio.to_thread(nutzung.anhaengen, paket)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"geschrieben": n}


@router.get("/ereignisse")
async def ereignisse_lesen(
    tage: int = Query(7, ge=1, le=366),
    art: str | None = Query(None, description="nur diese Art, etwa modell_geladen oder taste"),
):
    liste = await asyncio.to_thread(nutzung.lesen, tage)
    aus = [{k: v for k, v in e.items() if k != "_t"} for e in liste if not art or e.get("art") == art]
    return {"tage": tage, "anzahl": len(aus), "ereignisse": aus}


@router.get("/auswertung")
async def auswertung(tage: int = Query(30, ge=1, le=366)):
    liste = await asyncio.to_thread(nutzung.lesen, tage)
    ergebnis = nutzung.auswerten(liste, tage)
    ergebnis["je_tag"] = nutzung.nach_tagen(liste)
    ergebnis["zuletzt_geladen"] = nutzung.zuletzt_geladen(liste, 15)
    return ergebnis


@router.get("/zuletzt")
async def zuletzt(n: int = Query(20, ge=1, le=200), tage: int = Query(180, ge=1, le=3660)):
    liste = await asyncio.to_thread(nutzung.lesen, tage)
    return {"modelle": nutzung.zuletzt_geladen(liste, n)}


@router.get("/vorlagen")
async def vorlagen_lesen():
    return await asyncio.to_thread(nutzung.vorlagen_lesen)


@router.put("/vorlagen")
async def vorlagen_schreiben(inhalt: dict = Body(...)):
    try:
        return await asyncio.to_thread(nutzung.vorlagen_schreiben, inhalt.get("vorlagen"))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
