"""
Textur-Zuordnung: Materialbibliothek und Zuordnungsassistent.

IFC-Dateien enthalten praktisch nie Bildtexturen, nur benannte
`IfcSurfaceStyle`-Diffusfarben ("Beton - Estrich", "Metall Aluminium, matt").
`tiling/materials.py` ordnet solche Namen automatisch einer von 73 PBR-Kategorien
zu — gut, aber nie perfekt: Firmenstandards, Fantasienamen und Fremdsprachen
kann kein Keyword-Verfahren zuverlässig treffen.

Diese Routen machen die Zuordnung deshalb korrigierbar:

    GET  /materials/library                     Kategorien, nach Gruppen sortiert
    GET  /materials/library/{category}/preview  Vorschaubild (JPEG)
    GET  /assets/{job_id}/materials             Stile des Modells + Vorschläge
    PUT  /assets/{job_id}/materials             Zuordnung speichern
    POST /assets/{job_id}/materials/retile      mit dieser Zuordnung neu tilen
    GET  /assets/{job_id}/materials/index       Bauteil → Stil, für den Materialmodus

Der Ablauf ist bewusst zweistufig: Der Upload tilt sofort mit der automatischen
Erkennung durch, sodass das Modell direkt sichtbar ist. Erst wer nachbessern
will, öffnet den Assistenten und stößt danach ein Re-Tiling an — statt jeden
Upload hinter einem Dialog zu blockieren.
"""

import asyncio
import logging
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import Response
from minio.error import S3Error
from pydantic import BaseModel, Field

from fastapi.responses import JSONResponse

from storage.minio_client import get_json, get_minio, put_json
from tiling.formats.ifc import MATERIAL_INDEX_FILE, MATERIALS_FILE
from tiling.materials import FARBE_PREFIX, ist_farbwert, suggest_category
from tiling.textures import CATEGORIES, GROUPS, category_dir, installed_categories

logger = logging.getLogger(__name__)

# Zwei Router, weil die Endpunkte an zwei Stellen der API hängen: die Bibliothek
# ist modellunabhängig (`/materials/...`), die Zuordnung gehört zum Asset
# (`/assets/{job_id}/materials`) und steht damit neben Placement und Elements.
library_router = APIRouter()
router = APIRouter()

_TILES_BUCKET = "tiles"
_UPLOADS_BUCKET = "uploads"
_OVERRIDES_FILE = "material_overrides.json"

# Fortschritt laufender Re-Tiling-Jobs, analog zu upload.JOBS.
RETILE_JOBS: dict[str, dict] = {}

# Läufe des Stilindex-Nachbaus. Er dauert so lange wie das Öffnen der
# IFC-Datei (beim Campusmodell eine Viertelminute) und darf deshalb nicht in
# der Anfrage hängen, die ihn auslöst.
INDEX_JOBS: dict[str, str] = {}


# ── Modelle ──────────────────────────────────────────────────────────────────


class CategoryInfo(BaseModel):
    key: str
    label: str
    group: str
    source: str
    slug: str
    tile_size_m: float
    installed: bool


class StyleInfo(BaseModel):
    name: str
    farbe: str | None = Field(
        None, description="Diffusfarbe des IFC-Stils als #rrggbb — die Farbe im Modell"
    )
    transparenz: float = 0.0
    ersatzfarbe: str | None = Field(
        None, description="Zugeordnete Volltonfarbe (#rrggbb) statt einer Textur"
    )
    suggested: str | None = None
    confidence: float = 0.0
    category: str | None = None
    overridden: bool = False
    occurrences: int = 1


class MaterialsResponse(BaseModel):
    job_id: str
    styles: list[StyleInfo]
    overrides: dict[str, str]
    generated_at: str | None = None
    available: bool = Field(
        True, description="False, wenn das Modell keine IFC-Oberflächenstile hat"
    )


class OverridesUpdate(BaseModel):
    overrides: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Stilname → Kategorie, oder `farbe:#rrggbb` für eine matte "
            "Volltonfarbe statt einer Textur. Ein leerer Wert bedeutet "
            "ausdrücklich: keine Textur. Ein fehlender Eintrag bedeutet: "
            "automatisch erkennen."
        ),
    )
    retile: bool = Field(False, description="Direkt nach dem Speichern neu tilen")


class RetileStatus(BaseModel):
    job_id: str
    status: str
    message: str
    updated_at: str


# ── Materialbibliothek ───────────────────────────────────────────────────────


@library_router.get("", response_model=list[CategoryInfo], tags=["Materials"])
async def list_categories():
    """Alle Texturkategorien, sortiert nach der Gruppenreihenfolge der Registry."""
    installed = set(installed_categories())
    entries = [
        CategoryInfo(
            key=key,
            label=spec.label,
            group=spec.group,
            source=spec.source,
            slug=spec.slug,
            tile_size_m=spec.tile_size_m,
            installed=key in installed,
        )
        for key, spec in CATEGORIES.items()
    ]
    order = {group: i for i, group in enumerate(GROUPS)}
    return sorted(entries, key=lambda e: (order.get(e.group, len(GROUPS)), e.label))


@library_router.get("/{category}/preview", tags=["Materials"])
async def category_preview(category: str):
    """BaseColor-Kachel einer Kategorie — die Vorschau im Assistenten."""
    if category not in CATEGORIES:
        raise HTTPException(status_code=404, detail=f"Unbekannte Kategorie '{category}'.")

    path = category_dir(category) / "basecolor.jpg"
    if not path.is_file():
        raise HTTPException(
            status_code=404,
            detail=(
                f"Für '{category}' liegen keine Bilddateien vor — "
                "`python3 scripts/fetch_textures.py` einmalig ausführen."
            ),
        )
    # Die Bilder ändern sich nur, wenn das Fetch-Skript läuft.
    return Response(
        content=path.read_bytes(),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── Zuordnung je Modell ──────────────────────────────────────────────────────


def _load_overrides(job_id: str) -> dict:
    try:
        data = get_json(_TILES_BUCKET, f"{job_id}/{_OVERRIDES_FILE}")
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchBucket"):
            return {}
        raise
    return data.get("overrides", {}) if isinstance(data, dict) else {}


@router.get("/{job_id}/materials", response_model=MaterialsResponse, tags=["Materials"])
async def get_materials(job_id: str):
    """
    Oberflächenstile des Modells mit automatischem Vorschlag und aktueller
    Zuordnung. Quelle ist die beim Tiling geschriebene `materials.json`.
    """
    overrides = _load_overrides(job_id)

    try:
        report = get_json(_TILES_BUCKET, f"{job_id}/{MATERIALS_FILE}")
    except S3Error as e:
        if e.code not in ("NoSuchKey", "NoSuchBucket"):
            raise
        # Kein Bericht: entweder kein IFC, oder vor Einführung des Assistenten
        # getilt. Beides ist kein Fehler — der Assistent zeigt dann einen Hinweis.
        return MaterialsResponse(
            job_id=job_id, styles=[], overrides=overrides, available=False
        )

    # Farbe und Häufigkeit stehen erst seit dem Materialmodus im Bericht.
    # Für Modelle, die davor getilt wurden, kommen sie aus dem Stilindex —
    # sonst zeigte der Assistent bei genau den Modellen keine Farben, bei
    # denen man sie am nötigsten braucht: den vorhandenen.
    index = _index_laden(job_id) or {}
    aus_index = {
        eintrag["name"]: eintrag for eintrag in index.get("styles", [])
    }

    # Der Bericht wird beim Tiling geschrieben; seither gespeicherte Overrides
    # sind darin noch nicht sichtbar. Hier zusammenführen, statt für jede
    # Änderung neu tilen zu müssen.
    styles = []
    for entry in report.get("styles", []):
        name = entry.get("name")
        suggested = entry.get("suggested")
        confidence = entry.get("confidence", 0.0)
        if suggested is None and confidence == 0.0 and name:
            suggested, confidence = suggest_category(name)

        ersatzfarbe = None
        if name in overrides:
            value = overrides[name]
            category = value if value in CATEGORIES else None
            if ist_farbwert(value):
                ersatzfarbe = "#" + value[len(FARBE_PREFIX):].strip().lstrip("#")
            overridden = True
        else:
            category = suggested
            overridden = False

        styles.append(
            StyleInfo(
                name=name,
                farbe=entry.get("farbe") or aus_index.get(name, {}).get("farbe"),
                transparenz=(
                    entry.get("transparenz")
                    if entry.get("transparenz") is not None
                    else aus_index.get(name, {}).get("transparenz", 0.0)
                ) or 0.0,
                ersatzfarbe=ersatzfarbe,
                suggested=suggested,
                confidence=round(confidence, 2),
                category=category,
                overridden=overridden,
                occurrences=(
                    entry.get("occurrences")
                    or aus_index.get(name, {}).get("zuweisungen")
                    or 1
                ),
            )
        )

    return MaterialsResponse(
        job_id=job_id,
        styles=styles,
        overrides=overrides,
        generated_at=report.get("generated_at"),
        available=True,
    )


@router.put("/{job_id}/materials", response_model=MaterialsResponse, tags=["Materials"])
async def set_materials(job_id: str, update: OverridesUpdate, background_tasks: BackgroundTasks):
    """
    Speichert die Zuordnung. Sie greift erst beim nächsten Tiling — mit
    `retile: true` wird das direkt angestoßen.
    """
    # Gültig sind: leer (einfarbig lassen), eine Texturkategorie, oder eine
    # Volltonfarbe `farbe:#rrggbb`. Ein Tippfehler in der Farbe soll nicht als
    # „unbekannte Kategorie" durchgehen, deshalb prüft `ist_farbwert()` sie.
    unknown = {
        name: value
        for name, value in update.overrides.items()
        if value and value not in CATEGORIES and not ist_farbwert(value)
    }
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=(
                "Weder Texturkategorie noch Farbe (erwartet `farbe:#rrggbb`): "
                + ", ".join(sorted(set(unknown.values())))
            ),
        )

    put_json(
        _TILES_BUCKET,
        f"{job_id}/{_OVERRIDES_FILE}",
        {
            "overrides": update.overrides,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    logger.info(f"[{job_id}] Texturzuordnung gespeichert: {len(update.overrides)} Stil(e)")

    if update.retile:
        _set_retile_status(job_id, status="queued", message="Neu-Tiling steht an.")
        background_tasks.add_task(_retile_job, job_id)

    return await get_materials(job_id)


# ── Stilindex: welches Bauteil trägt welchen Stil ────────────────────────────


def _index_laden(job_id: str) -> dict | None:
    try:
        return get_json(_TILES_BUCKET, f"{job_id}/{MATERIAL_INDEX_FILE}")
    except S3Error as e:
        if e.code in ("NoSuchKey", "NoSuchBucket"):
            return None
        raise


def _index_bauen(job_id: str):
    """
    Baut den Stilindex aus der IFC-Quelldatei nach und legt ihn zu den Tiles.

    Für Modelle, die vor dem Materialmodus getilt wurden. Neue Uploads bringen
    ihn aus dem Tiling mit (`ifc._write_material_report()`), wo die Datei
    ohnehin offen ist.
    """
    import ifcopenshell

    from api.routes.plan import _local_source
    from tiling import stilindex

    try:
        INDEX_JOBS[job_id] = "laeuft"
        src = _local_source(job_id)
        ifc_file = ifcopenshell.open(str(src))
        index = stilindex.aufbauen(ifc_file)
        put_json(_TILES_BUCKET, f"{job_id}/{MATERIAL_INDEX_FILE}", index)
        INDEX_JOBS[job_id] = "fertig"
        logger.info(f"[{job_id}] Stilindex nachgebaut: {len(index['elemente'])} Bauteile")
    except HTTPException as e:
        # `_local_source` meldet fehlende IFC-Quellen als 404 — das ist kein
        # Fehler des Index, sondern heißt: für dieses Format gibt es keinen.
        INDEX_JOBS[job_id] = f"fehlt: {e.detail}"
    except Exception as e:
        logger.error(f"[{job_id}] Stilindex fehlgeschlagen: {e}", exc_info=True)
        INDEX_JOBS[job_id] = f"fehlgeschlagen: {e}"


@router.get("/{job_id}/materials/index", tags=["Materials"])
async def material_index(job_id: str, background_tasks: BackgroundTasks):
    """
    Bauteil → Oberflächenstil, dazu je Stil Farbe und Häufigkeit.

    Die Antwort geht als Ganzes über die Leitung und bleibt im Viewer liegen:
    beim Ziehen über die Szene muss unter dem Zeiger sofort feststehen, welches
    Material dort liegt — eine Rückfrage je Mausbewegung wäre nicht bedienbar.

    Fehlt der Index (Modell von vor dem Materialmodus), wird er im Hintergrund
    gebaut und die Antwort ist `202` mit Status; der Aufrufer fragt erneut.
    """
    index = _index_laden(job_id)
    if index is not None:
        INDEX_JOBS.pop(job_id, None)
        return JSONResponse(index)

    stand = INDEX_JOBS.get(job_id)
    if stand is None:
        background_tasks.add_task(asyncio.to_thread, _index_bauen, job_id)
        stand = "angestossen"
    elif stand.startswith(("fehlt", "fehlgeschlagen")):
        # Ein gescheiterter Lauf wird nicht endlos wiederholt; die Meldung
        # steht im Status und der Aufrufer sieht sie.
        return JSONResponse({"status": stand}, status_code=409)

    return JSONResponse(
        {"status": stand, "hinweis": "Der Stilindex wird aufgebaut — erneut abfragen."},
        status_code=202,
    )


# ── Re-Tiling ────────────────────────────────────────────────────────────────


def _set_retile_status(job_id: str, **fields):
    entry = RETILE_JOBS.setdefault(job_id, {"job_id": job_id})
    entry.update(fields)
    entry["updated_at"] = datetime.now(timezone.utc).isoformat()


@router.post("/{job_id}/materials/retile", response_model=RetileStatus, tags=["Materials"])
async def retile(job_id: str, background_tasks: BackgroundTasks):
    """Tilt das Modell mit der gespeicherten Zuordnung neu."""
    running = RETILE_JOBS.get(job_id)
    if running and running.get("status") in ("queued", "running"):
        raise HTTPException(status_code=409, detail="Für dieses Modell läuft bereits ein Tiling.")

    _set_retile_status(job_id, status="queued", message="Neu-Tiling steht an.")
    background_tasks.add_task(_retile_job, job_id)
    return RetileStatus(**RETILE_JOBS[job_id])


@router.get("/{job_id}/materials/retile", response_model=RetileStatus, tags=["Materials"])
async def retile_status(job_id: str):
    job = RETILE_JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Kein Tiling-Vorgang für '{job_id}'.")
    return RetileStatus(**job)


def _source_object(job_id: str) -> str:
    """Objektname der Quelldatei im uploads-Bucket."""
    objects = list(
        get_minio().list_objects(_UPLOADS_BUCKET, prefix=f"{job_id}/", recursive=True)
    )
    if not objects:
        raise HTTPException(
            status_code=404,
            detail=f"Keine Quelldatei für '{job_id}' — sie wurde gelöscht oder nie hochgeladen.",
        )
    return objects[0].object_name


async def _retile_job(job_id: str):
    """
    Lädt die Quelldatei aus dem uploads-Bucket, tilt sie mit der gespeicherten
    Zuordnung neu und ersetzt die Tiles.

    Die vorhandene Platzierung wird davor gesichert und danach wieder
    angewandt — sonst würde das Modell nach jeder Texturänderung an den
    Standard-Referenzpunkt zurückspringen.
    """
    from tiling.georef import PLACEMENT_FILE, apply_placement
    from tiling.pipeline import run_tiling
    from storage.minio_client import delete_prefix

    tmp_dir = None
    tiles_dir = None
    try:
        _set_retile_status(job_id, status="running", message="Quelldatei wird geladen…")
        object_name = _source_object(job_id)
        if not object_name.lower().endswith(".ifc"):
            _set_retile_status(
                job_id,
                status="failed",
                message="Texturzuordnung gibt es nur für IFC-Modelle.",
            )
            return

        try:
            placement = get_json(_TILES_BUCKET, f"{job_id}/{PLACEMENT_FILE}")
        except S3Error:
            placement = None

        overrides = _load_overrides(job_id)

        tmp_dir = Path(tempfile.mkdtemp(prefix=f"retile_{job_id[:8]}_"))
        src = tmp_dir / Path(object_name).name
        get_minio().fget_object(_UPLOADS_BUCKET, object_name, str(src))

        _set_retile_status(job_id, status="running", message="Tiling läuft…")
        # Alte Tiles zuerst weg: ein Modell mit weniger Tiles als zuvor würde
        # sonst Reste des alten Laufs behalten, die die tileset.json nicht mehr
        # referenziert — sie blieben als Leichen im Bucket liegen.
        delete_prefix(_TILES_BUCKET, f"{job_id}/")
        tiles_dir = await asyncio.to_thread(run_tiling, src, job_id, overrides)

        if placement:
            tileset = get_json(_TILES_BUCKET, f"{job_id}/tileset.json")
            put_json(_TILES_BUCKET, f"{job_id}/tileset.json", apply_placement(tileset, placement))
            put_json(_TILES_BUCKET, f"{job_id}/{PLACEMENT_FILE}", placement)

        # Die Overrides liegen unter demselben Präfix und wurden mitgelöscht.
        put_json(
            _TILES_BUCKET,
            f"{job_id}/{_OVERRIDES_FILE}",
            {"overrides": overrides, "updated_at": datetime.now(timezone.utc).isoformat()},
        )

        _set_retile_status(
            job_id,
            status="done",
            message=f"Neu getilt mit {len(overrides)} manuellen Zuordnungen.",
        )
        logger.info(f"[{job_id}] Re-Tiling abgeschlossen.")

    except Exception as e:
        logger.error(f"[{job_id}] Re-Tiling fehlgeschlagen: {e}", exc_info=True)
        _set_retile_status(job_id, status="failed", message=f"Fehlgeschlagen: {e}")
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        if tiles_dir:
            shutil.rmtree(tiles_dir, ignore_errors=True)
