"""
Sortierte Ansicht: Bauteile eines Typs nebeneinander auf einer Ebene.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

    GET  /assets/{job}/sortiert/typen             welche Typen es gibt, mit Anzahl
    POST /assets/{job}/sortiert                   Ansicht bauen (oder die fertige melden)
    GET  /assets/{job}/sortiert/{kennung}         Stand · bei „fertig" der Bericht

Das Ergebnis ist ein eigenes Asset (`tiling/sortiert.py` erklärt, warum): gleiche
Geometrie, gleiche GlobalIds, gleiche Platzierung wie das Modell, nur die Bauteile
stehen in Reihen. Es erscheint in der Assetliste und lässt sich wie jedes andere
löschen. Die Kennung ist aus der Anfrage abgeleitet — dieselbe Anfrage liefert
dasselbe Asset, statt bei jedem Klick ein neues anzulegen.
"""

import asyncio
import io
import json
import logging
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from minio.error import S3Error
from pydantic import BaseModel, Field

from storage.minio_client import get_json, get_minio, put_json, upload_directory
from tiling import sortiert as S

logger = logging.getLogger(__name__)

router = APIRouter()

# Eine Ansicht zur Zeit: ifcopenshell.open() kostet bei großen Modellen mehrere
# Gigabyte, und zwei gleichzeitige Läufe wären nicht schneller, sondern beide
# vom Speicher bedroht (wie bei der Statik, `fem.py`).
_SPERRE = asyncio.Semaphore(1)
_STAND: dict[str, dict] = {}
_AUFGABEN: set = set()


class Anfrage(BaseModel):
    typen: list[str] = Field(..., min_length=1, max_length=12)
    gruppe: str = Field("typname", pattern="^(" + "|".join(S.GRUPPEN) + ")$")
    sortierung: str = Field("breite", pattern="^(" + "|".join(S.SORTIERUNGEN) + ")$")
    abstand_m: float = Field(S.ABSTAND, ge=0.1, le=5.0)
    zeilenbreite_m: float = Field(S.ZEILENBREITE, ge=5.0, le=300.0)
    neu: bool = False   # eine fertige Ansicht verwerfen und neu bauen


def _kennung(job_id: str, a: Anfrage) -> str:
    schluessel = "|".join([job_id, ",".join(sorted(a.typen)), a.gruppe, a.sortierung,
                           f"{a.abstand_m:.2f}", f"{a.zeilenbreite_m:.1f}"])
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "ileen-sortiert:" + schluessel))


def _fertig(kennung: str) -> dict | None:
    """Der Bericht einer vorhandenen Ansicht, sonst None."""
    try:
        get_minio().stat_object("tiles", f"{kennung}/tileset.json")
        return get_json("tiles", f"{kennung}/layout.json")
    except S3Error:
        return None


def _anzeigename(job_id: str, a: Anfrage) -> str:
    try:
        name = get_json("tiles", f"{job_id}/meta.json").get("display_name")
    except S3Error:
        name = None
    if not name:
        name = job_id[:8]
    was = ", ".join(sorted({S.bezeichnung(t) for t in a.typen}))
    return f"{name} — {was} sortiert"


def _bauen(job_id: str, kennung: str, a: Anfrage) -> dict:
    """Quelldatei holen, kacheln, ablegen, verorten. Läuft im Thread."""
    from api.routes.placement import _apply, load_placement
    from api.routes.plan import _local_source
    from api.routes.upload import JOBS

    src = _local_source(job_id)
    out = Path(tempfile.mkdtemp(prefix=f"sortiert_{kennung[:8]}_"))
    try:
        bericht = S.sortiert_tilen(src, out, a.typen, a.gruppe, a.sortierung,
                                   a.abstand_m, a.zeilenbreite_m)
        bericht["aus_modell"] = job_id
        (out / "layout.json").write_text(json.dumps(bericht, ensure_ascii=False, indent=1), encoding="utf-8")
        # Ein neuer Lauf mit anderen Kacheln darf nicht auf Resten des alten stehen.
        _leeren(kennung)
        upload_directory(out, bucket="tiles", prefix=kennung)
    finally:
        shutil.rmtree(out, ignore_errors=True)

    # Dieselbe Platzierung wie das Modell: dann gelten Verschieben, Höhenbezug und
    # der Geländeabgleich im Viewer für beide gleich. Wohin die Reihen neben dem
    # Haus kommen, rechnet der Viewer aus den Hüllboxen beider Tilesets.
    _apply(kennung, load_placement(job_id))

    ts = get_json("tiles", f"{kennung}/tileset.json")
    ts["extras"] = {**(ts.get("extras") or {}), "ileen_quelle": "sortiert", "aus_modell": job_id}
    put_json("tiles", f"{kennung}/tileset.json", ts)
    name = _anzeigename(job_id, a)
    put_json("tiles", f"{kennung}/meta.json", {
        "display_name": name, "aus_modell": job_id, "verfahren": "sortierte Ansicht",
        "typen": bericht["typen"]})

    # Marke in `uploads/`, damit die Assetliste das Asset einordnen kann
    # (`assets._content_type`) — es gibt keine Quelldatei, aus der es getilt wäre.
    get_minio().put_object("uploads", f"{kennung}/sortiert.sortiert", io.BytesIO(b"{}"),
                           length=2, content_type="application/json")
    JOBS[kennung] = {"job_id": kennung, "filename": "sortiert.sortiert", "status": "done",
                     "message": "Sortierte Ansicht.", "tileset_url": f"/tiles/{kennung}/tileset.json"}
    return bericht


def _leeren(kennung: str):
    from storage.minio_client import delete_prefix
    try:
        delete_prefix("tiles", f"{kennung}/")
    except Exception as e:      # noch nichts da — nichts zu leeren
        logger.debug("Leeren übersprungen: %s", e)


async def _ablauf(job_id: str, kennung: str, a: Anfrage):
    try:
        async with _SPERRE:
            _STAND[kennung].update(zustand="laeuft", meldung="Bauteile werden gelesen und angeordnet …")
            bericht = await asyncio.to_thread(_bauen, job_id, kennung, a)
        _STAND[kennung].update(zustand="fertig", meldung="", bericht=bericht)
    except HTTPException as e:
        _STAND[kennung].update(zustand="fehler", meldung=str(e.detail))
    except Exception as e:
        logger.exception("[%s] Sortierte Ansicht fehlgeschlagen", job_id[:8])
        _STAND[kennung].update(zustand="fehler", meldung=f"{type(e).__name__}: {e}")


@router.get("/{job_id}/sortiert/typen")
async def typen(job_id: str):
    """Die Bauteiltypen des Modells mit Anzahl — aus der Eigenschaftsdatei, ohne Geometrie."""
    import sqlite3

    from api.routes.elements import _local_properties

    pfad = await asyncio.to_thread(_local_properties, job_id)

    def lesen():
        with sqlite3.connect(f"file:{pfad}?mode=ro", uri=True) as db:
            return db.execute(
                "SELECT ifc_type, COUNT(*) FROM elements WHERE ifc_type IS NOT NULL "
                "GROUP BY ifc_type ORDER BY COUNT(*) DESC").fetchall()

    zeilen = await asyncio.to_thread(lesen)
    return [{"ifc_type": t, "bezeichnung": S.bezeichnung(t), "anzahl": n} for t, n in zeilen]


@router.post("/{job_id}/sortiert")
async def anlegen(job_id: str, a: Anfrage):
    from api.routes.assets import _assert_exists

    _assert_exists(job_id)
    kennung = _kennung(job_id, a)

    if not a.neu:
        bericht = await asyncio.to_thread(_fertig, kennung)
        if bericht is not None:
            return {"kennung": kennung, "zustand": "fertig", "bericht": bericht}
    laufend = _STAND.get(kennung)
    if laufend and laufend["zustand"] in ("wartet", "laeuft"):
        return {"kennung": kennung, "zustand": laufend["zustand"]}

    _STAND[kennung] = {"zustand": "wartet", "meldung": "Wartet auf den Rechner …"}
    aufgabe = asyncio.create_task(_ablauf(job_id, kennung, a))
    _AUFGABEN.add(aufgabe)
    aufgabe.add_done_callback(_AUFGABEN.discard)
    return {"kennung": kennung, "zustand": "wartet"}


@router.get("/{job_id}/sortiert/{kennung}")
async def stand(job_id: str, kennung: str):
    s = _STAND.get(kennung)
    if s and s["zustand"] in ("wartet", "laeuft", "fehler"):
        return {"kennung": kennung, **s}
    bericht = await asyncio.to_thread(_fertig, kennung)
    if bericht is not None:
        return {"kennung": kennung, "zustand": "fertig", "bericht": bericht}
    raise HTTPException(status_code=404, detail="Diese sortierte Ansicht gibt es nicht (mehr).")
