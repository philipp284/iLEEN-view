"""
Bauzeichnung aus einem verorteten Modell: Grundriss und Schnitt als Vektordaten.

Der Ausschnitt kommt als Quader herein — dieselbe Box, die der Viewer für das
Clipping ohnehin aufzieht, in denselben tile-lokalen Koordinaten. Zurück kommen
die Bauteilfiguren mit ihrer Signatur nach `tiling/signaturen.json`, zweifach
ausgegeben: metrisch in der Zeichenebene (für Blattlayout, Maßstab und eine
spätere SVG-Ausgabe) und, sofern es ein Grundriss ist, zusätzlich als GeoJSON
in WGS84 (damit CesiumJS sie als Layer über das Gelände legen kann).

Warum nicht nur GeoJSON: Ein senkrechter Schnitt hat keine geografischen
Koordinaten — seine Achsen sind Länge und Höhe. Ihn in Längen- und Breitengrade
zu pressen wäre eine Lüge über die Bedeutung der Zahlen.
"""

import asyncio
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from minio.error import S3Error
from pydantic import BaseModel, Field

from api.routes.placement import load_placement
from storage.minio_client import get_minio
from tiling import georef, pdf2svg, raumsemantik, section

logger = logging.getLogger(__name__)

router = APIRouter()

# Eigener Router, weil der Katalog kein Asset ist: unter `/assets` gelesen
# würde "signaturen" auf die job_id-Route fallen und ein Asset dieses Namens
# suchen. Gleiches Muster wie `materials.library_router`.
catalog_router = APIRouter()

_CACHE_DIR = Path(os.getenv("SOURCE_CACHE", "/tmp/sources"))
_IFC_SUFFIXES = (".ifc", ".ifczip")


class SectionRequest(BaseModel):
    """Der Planausschnitt, beschrieben wie die Clipping-Box im Viewer."""

    center: tuple[float, float, float]
    size: tuple[float, float, float]
    yaw: float = 0.0
    mode: Literal["grundriss", "schnitt"] = "grundriss"
    cut_height: float = Field(
        section.DEFAULT_CUT_HEIGHT,
        description="Schnitthöhe über der Unterkante der Box, in Metern. Nur im Grundriss.",
    )
    with_views: bool = Field(
        True, description="Ansichtskanten der Bauteile unter der Schnittebene mitzeichnen."
    )
    with_rooms: bool = Field(
        False,
        description=(
            "Räume des Ausschnitts als Beschriftungsdaten mitliefern (Name, Nutzung, "
            "Fläche, Umriss). Nur im Grundriss."
        ),
    )
    cut_offset: float | None = Field(
        None,
        description=(
            "Lage der Schnittebene innerhalb der Box, gemessen von der Kante -size[1]/2, "
            "in Metern. Nur im Schnitt; ohne Angabe liegt die Ebene in der Box-Mitte."
        ),
    )


class Storey(BaseModel):
    name: str
    hoehe: float
    bauteile: int


class PlanFigure(BaseModel):
    global_id: str
    ifc_type: str
    name: str | None = None
    storey: str | None = None
    material: str | None = None
    signature: str | None = None
    kind: str
    rings: list[list[tuple[float, float]]]


class PlanRoom(BaseModel):
    global_id: str
    name: str | None = None
    long_name: str | None = None
    storey: str | None = None
    area: float
    height: float | None = None
    anchor: tuple[float, float]
    rings: list[list[tuple[float, float]]]


class Plan(BaseModel):
    job_id: str
    mode: str
    figures: list[PlanFigure]
    rooms: list[PlanRoom] = []
    bounds: tuple[float, float, float, float]
    plane_origin: tuple[float, float, float]
    signaturen: dict
    geojson: dict | None = None


class BauteilBox(BaseModel):
    """
    Ein Bauteil des Elementverzeichnisses, in denselben Koordinaten wie `ElementBox`.

    Dasselbe wie `ElementBox`, nur ohne die abgeleiteten Felder `center`/`size`
    und für die ganze Liste gedacht: Bei einigen tausend Bauteilen ist jedes
    eingesparte Feld ein spürbarer Teil der Antwort, und wer die Mitte braucht,
    rechnet sie aus `lo`/`hi` billiger aus, als sie zu übertragen wäre.
    """

    global_id: str
    ifc_type: str | None = None
    name: str | None = None
    storey: str | None = None
    material: str | None = None
    lo: tuple[float, float, float]
    hi: tuple[float, float, float]


class ElementBox(BaseModel):
    """Die Hüllbox eines Bauteils, in denselben Koordinaten wie `SectionRequest`."""

    global_id: str
    ifc_type: str | None = None
    name: str | None = None
    storey: str | None = None
    center: tuple[float, float, float]
    size: tuple[float, float, float]
    lo: tuple[float, float, float]
    hi: tuple[float, float, float]


class RoomBox(BaseModel):
    """
    Ein Raum mit seinem Hüllquader, in denselben Koordinaten wie `ElementBox`.

    `flaeche_quelle` und `volumen_quelle` stehen mit dabei, weil die Zahlen
    unterschiedlich viel wert sind: eine Fläche aus dem Mengensatz ist die
    Angabe des Entwurfsverfassers, eine aus dem Netz gerechnete eine Ableitung.
    Wer ein Raumbuch daraus baut, muss den Unterschied sehen können.
    """

    global_id: str
    name: str | None = None
    long_name: str | None = None
    storey: str | None = None
    flaeche_m2: float
    flaeche_quelle: str
    hoehe_m: float
    volumen_m3: float
    volumen_quelle: str
    center: tuple[float, float, float]
    size: tuple[float, float, float]
    lo: tuple[float, float, float]
    hi: tuple[float, float, float]
    # Die Grundrissfigur, tile-lokal wie lo/hi: erst die Außenkontur, dann
    # ihre Löcher. Nur mit `?grundriss=true` — sie hat Dutzende Punkte je Raum.
    grundriss: list[list[tuple[float, float]]] | None = None
    # Was der Raum laut IFC über sich sagt: je Merkmal `{wert, quelle}`
    # (`ileen/raumdaten.py`). Leer, wenn die Datei nichts davon führt.
    merkmale: dict = {}
    # PredefinedType, ObjectType, Description, Klassifikation, Zonen.
    ifc: dict = {}
    # Die Nutzlastkategorie, wie der Lastabtrag sie ansetzt —
    # `raumlasten.kategorie_von()`, dieselbe Funktion, nicht eine zweite Deutung.
    nutzlast: dict | None = None


class RoomDetail(BaseModel):
    """Alles, was das IFC über einen Raum führt — für den Steckbrief im Viewer."""

    global_id: str
    psets: dict
    merkmale: dict
    ifc: dict


def _local_source(job_id: str) -> Path:
    """
    Pfad zur lokalen Kopie der IFC-Quelldatei; lädt sie bei Bedarf aus MinIO.

    Gleiches Muster wie `elements._local_properties()`: erst neben das Ziel
    schreiben, dann umbenennen, damit eine zweite Anfrage nicht die halb
    heruntergeladene Datei öffnet.

    Das Umbenennen allein reicht allerdings nicht, wenn zwei Anfragen dasselbe
    Modell gleichzeitig anfordern — genau der Normalfall beim Öffnen eines
    Assets, wo Planpanel (`/storeys`) und Raumkonzept (`/rooms`) zusammen
    starten. Beide riefen dann `fget_object()` auf denselben Zielpfad auf;
    MinIO lädt in eine eigene Zwischendatei und benennt sie am Ende dorthin um,
    und wer zuerst umbenennt, zieht dem anderen die Datei unter den Händen weg.
    Der zweite Aufruf endet mit `FileNotFoundError` statt mit einer Zeichnung.
    Deshalb dieselbe Sperre wie beim Verzeichnisaufbau, hier auf die Quelldatei.
    """
    minio = get_minio()
    name = None
    irgendwas = False
    for obj in minio.list_objects("uploads", prefix=f"{job_id}/", recursive=True):
        irgendwas = True
        candidate = obj.object_name.split("/", 1)[-1]
        if candidate.lower().endswith(_IFC_SUFFIXES):
            name = candidate
            break

    if not irgendwas:
        # Gar keine Quelldatei: das Modell ist gelöscht (oder unter neuer
        # Kennung neu hochgeladen). Ein Viewer, der es noch im Bild hat, zeigt
        # die Kacheln aus seinem Zwischenspeicher — die Meldung „kein IFC"
        # schickte die Fehlersuche dann in die falsche Richtung.
        raise HTTPException(
            status_code=404,
            detail=(f"Das Modell '{job_id}' gibt es im Backend nicht mehr — gelöscht oder "
                    "unter neuer Kennung neu hochgeladen. Im Viewer neu laden."),
        )
    if name is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Für Job '{job_id}' liegt keine IFC-Quelldatei vor. Bauzeichnungen "
                "entstehen aus der Originalgeometrie; Punktwolken, Splats und reine "
                "Mesh-Formate tragen keine Bauteile, aus denen sich schneiden ließe."
            ),
        )

    path = _CACHE_DIR / job_id / name
    if path.exists():
        return path

    with section.build_lock(path):
        # Zweiter Blick unter der Sperre: Wer gewartet hat, während ein anderer
        # Aufruf geladen hat, nimmt dessen Datei und lädt sie nicht erneut.
        if path.exists():
            return path

        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(path.suffix + ".part")
        try:
            minio.fget_object("uploads", f"{job_id}/{name}", str(partial))
        except S3Error as e:
            partial.unlink(missing_ok=True)
            logger.error(f"[{job_id}] Quelldatei nicht ladbar: {e}")
            raise HTTPException(status_code=502, detail=f"Storage-Fehler: {e.code}")

        partial.replace(path)
        logger.info(f"[{job_id}] Quelldatei zwischengespeichert: {path}")
        return path


def purge_cache(job_id: str):
    """Entfernt die lokale Kopie der Quelldatei — beim Löschen eines Assets."""
    import shutil

    shutil.rmtree(_CACHE_DIR / job_id, ignore_errors=True)
    section.purge_cache(job_id)
    raumsemantik.purge_cache(job_id)


def _to_geojson(drawing: section.Drawing, placement: dict) -> dict:
    """
    Die Figuren in WGS84, als FeatureCollection.

    Die Zeichenebene liegt hier waagerecht, ihre 2D-Punkte sind also direkt die
    tile-lokalen X/Y auf Höhe der Schnittebene. Von dort führt `root.transform`
    nach ECEF — dieselbe Matrix, mit der der Viewer auch das Tileset stellt.
    Deshalb wird sie über `placement_transform()` geholt und nicht neu gebaut:
    jede eigene Herleitung würde bei gedrehten oder skalierten Platzierungen
    von der Darstellung abweichen.
    """
    matrix = georef.to_matrix(georef.placement_transform(placement))
    z = drawing.plane_origin[2]

    features = []
    for figure in drawing.figures:
        rings = []
        for ring in figure.rings:
            local = np.array([[x, y, z, 1.0] for x, y in ring])
            ecef = (matrix @ local.T).T[:, :3]
            geodetic = georef.ecef_to_geodetic(ecef)
            rings.append([[round(lon, 9), round(lat, 9)] for lon, lat, _ in geodetic])
        if not rings:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": rings},
                "properties": {
                    "global_id": figure.global_id,
                    "ifc_type": figure.ifc_type,
                    "name": figure.name,
                    "storey": figure.storey,
                    "material": figure.material,
                    "signatur": figure.signature,
                    "art": figure.kind,
                },
            }
        )

    return {"type": "FeatureCollection", "features": features}


@router.get("/{job_id}/storeys", response_model=list[Storey])
async def get_storeys(job_id: str):
    """
    Die Geschosse des Modells mit ihrer Höhe im tile-lokalen System.

    Vor dem ersten Schnitt aufzurufen: die Schnitthöhe ist relativ zum
    Geschossfußboden gemeint, und dessen Lage ist ohne diese Liste nicht
    bekannt. Baut beim ersten Aufruf das Elementverzeichnis mit auf und
    dauert dann entsprechend lang.
    """
    src = await asyncio.to_thread(_local_source, job_id)
    try:
        found = await asyncio.to_thread(section.storeys, src, job_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return [Storey(**entry) for entry in found]


@router.get("/{job_id}/elements/{global_id}/box", response_model=ElementBox)
async def element_box(job_id: str, global_id: str):
    """
    Die Hüllbox eines Bauteils im tile-lokalen System.

    Damit legt der Viewer eine Schnittbox um ein angeklicktes Bauteil, ohne die
    Geometrie selbst zu kennen: die B3DM-Tiles sind gebatcht, aus ihnen ließe
    sich die Ausdehnung eines einzelnen Bauteils nur über den Umweg über die
    Batch-IDs schätzen. Hier steht sie ohnehin schon — `build_index()` legt sie
    für jeden Schnitt an, in derselben Zentrierung wie `SectionRequest.center`.
    Der zurückgegebene Quader lässt sich also unverändert wieder hineinreichen.

    Der erste Aufruf je Modell baut das Elementverzeichnis auf und dauert
    entsprechend lange; jeder weitere liest nur den Cache.
    """
    src = await asyncio.to_thread(_local_source, job_id)
    try:
        _, elements = await asyncio.to_thread(section.build_index, src, job_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    found = next((e for e in elements if e["global_id"] == global_id), None)
    if found is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Bauteil '{global_id}' hat in Modell '{job_id}' keine Geometrie. "
                "Räume, Aussparungen und Anmerkungen stehen nicht im Verzeichnis "
                "— aus ihnen lässt sich keine Schnittbox ableiten."
            ),
        )

    lo = np.asarray(found["lo"], dtype=float)
    hi = np.asarray(found["hi"], dtype=float)
    return ElementBox(
        global_id=global_id,
        ifc_type=found.get("ifc_type"),
        name=found.get("name"),
        storey=found.get("storey"),
        center=tuple((lo + hi) / 2.0),
        size=tuple(hi - lo),
        lo=tuple(lo),
        hi=tuple(hi),
    )


@router.get("/{job_id}/element-boxes", response_model=list[BauteilBox])
async def element_boxes(job_id: str, storey: str | None = None, ifc_type: str | None = None):
    """
    Das ganze Elementverzeichnis: jedes Bauteil mit Typ, Geschoss und Hüllquader.

    **Warum die Liste und nicht nur die Einzelabfrage.** `/elements/{global_id}/box`
    beantwortet „wo steckt dieses eine Bauteil" — die Frage beim Anklicken. Die
    4D-Simulation am Fachmodell stellt die umgekehrte: Sie hat einen Terminplan
    mit Zonen und muss JEDES Bauteil einer davon zuordnen, bevor der erste Tag
    läuft. Über Einzelabfragen wären das ein paar tausend Requests für Daten,
    die ohnehin in einem Verzeichnis nebeneinander liegen.

    Die Zuordnung braucht beides, was hier zusammenkommt und sonst nirgends:
    das **Geschoss** aus `IfcRelContainedInSpatialStructure` (die echte Relation
    des Modells, keine aus der Höhe geratene) und den **Hüllquader**, mit dem
    sich ein Bauteil einem Raum zuschlagen lässt. Aus den Kacheln ist der Quader
    nicht zu holen: Die B3DM-Tiles sind gebatcht, ein einzelnes Bauteil hat dort
    keine eigene Ausdehnung.

    `storey` und `ifc_type` filtern serverseitig — beim Campus-Modell ist das
    der Unterschied zwischen einer Antwort von ein paar hundert Kilobyte und
    einer von etlichen Megabyte.

    Der erste Aufruf je Modell baut das Elementverzeichnis auf und dauert
    entsprechend lange; jeder weitere liest nur den Cache.
    """
    src = await asyncio.to_thread(_local_source, job_id)
    try:
        _, elements = await asyncio.to_thread(section.build_index, src, job_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    typen = {t.strip() for t in ifc_type.split(",")} if ifc_type else None
    antwort: list[BauteilBox] = []
    for eintrag in elements:
        if storey is not None and eintrag.get("storey") != storey:
            continue
        if typen is not None and eintrag.get("ifc_type") not in typen:
            continue
        antwort.append(
            BauteilBox(
                global_id=eintrag["global_id"],
                ifc_type=eintrag.get("ifc_type"),
                name=eintrag.get("name"),
                storey=eintrag.get("storey"),
                material=eintrag.get("material"),
                lo=tuple(float(x) for x in eintrag["lo"]),
                hi=tuple(float(x) for x in eintrag["hi"]),
            )
        )
    return antwort


def _statik_nutzlast(long_name: str | None, name: str | None,
                     global_id: str = "", stand: dict | None = None) -> dict:
    """
    Die Nutzlastkategorie des Raums, so wie der nächste Lastabtrag sie ansetzt.

    In dieser Reihenfolge, derselben wie in `raumlasten.raumlasten()`:

    1. ein Eingriff `nutzlast_raum` (von Hand gesetzt) — `eingriff` trägt seine Nummer;
    2. die Deutung aus der Raumnutzung (`raumlasten.kategorie_von`);
    3. die Vorgabe der Annahmen aus dem jüngsten Lauf (`vorgabe: True`).

    Gibt es keinen Lauf, steht bei 3. `kategorie: None`: welche Vorgabe gilt,
    legt erst ein Lauf fest, und eine Zahl zu nennen wäre geraten. `gedeutet`
    hält die Deutung auch dann fest, wenn ein Eingriff sie sticht — die
    Raumansicht zeigt beides, und nach dem Aufheben fällt sie darauf zurück.
    """
    from ileen import raumlasten

    stand = stand or {}
    norm = "DIN EN 1991-1-1/NA Tab. 6.1DE"
    erkannt = raumlasten.kategorie_von(long_name, name)
    gedeutet = None
    if erkannt:
        wert, text, benutzt = raumlasten.nutzlast(erkannt)
        gedeutet = {"kategorie": benutzt, "q_k_kNm2": wert, "beschreibung": text}

    eingriff = (stand.get("eingriffe") or {}).get(global_id)
    if eingriff and eingriff.get("kategorie"):
        wert, text, benutzt = raumlasten.nutzlast(eingriff["kategorie"])
        return {"kategorie": benutzt, "q_k_kNm2": wert, "beschreibung": text, "norm": norm,
                "herkunft": f"von Hand gesetzt (Eingriff Nr. {eingriff.get('nr')})",
                "eingriff": eingriff.get("nr"), "gedeutet": gedeutet}
    if gedeutet:
        return {**gedeutet, "norm": norm, "gedeutet": gedeutet,
                "herkunft": "aus der Raumnutzung erkannt (raumlasten.kategorie_von)"}
    vorgabe = stand.get("vorgabe")
    if vorgabe and vorgabe.get("kategorie"):
        wert, text, benutzt = raumlasten.nutzlast(vorgabe["kategorie"])
        return {"kategorie": benutzt, "q_k_kNm2": wert, "beschreibung": text, "norm": norm,
                "vorgabe": True, "gedeutet": None,
                "herkunft": (f"keine Nutzung erkennbar — Vorgabe der Annahmen im jüngsten "
                             f"Lastabtrag ({vorgabe.get('lauf')}, {str(vorgabe.get('stand') or '')[:10]})")}
    return {"kategorie": None, "q_k_kNm2": None, "beschreibung": None, "gedeutet": None,
            "herkunft": "keine Nutzung erkennbar — der Lastabtrag setzt die Vorgabe der Annahmen an"}


def _nutzlast_stand(job_id: str) -> dict:
    """Eingriffe und Vorgabe aus der Tragwerksablage — `{}`, wenn sie nicht erreichbar ist."""
    from api.routes import tragwerk

    try:
        return tragwerk.nutzlast_stand(job_id)
    except Exception as e:  # noqa: BLE001 — die Raumliste darf daran nicht scheitern
        logger.warning(f"[{job_id}] Nutzlast-Stand nicht lesbar: {e}")
        return {}


def _semantik(job_id: str, src: Path) -> dict[str, dict]:
    """Die Raumsemantik oder `{}` — ihr Fehlen darf die Raumliste nicht kosten."""
    try:
        return raumsemantik.raumsemantik(src, job_id)
    except Exception as e:
        logger.warning(f"[{job_id}] Raumsemantik nicht lesbar: {e}")
        return {}


@router.get("/{job_id}/rooms", response_model=list[RoomBox])
async def get_rooms(job_id: str, grundriss: bool = False):
    """
    Alle `IfcSpace` des Modells mit Hüllquader — der Weg zu den Räumen.

    **Warum es diese Route braucht.** Räume stehen nicht in den Tiles: Der
    Tiler hält `IfcSpace` über `_EXCLUDE_TYPES` heraus, weil das Raumvolumen
    sonst als massiver Quader jede Wand darunter zudeckt. Das ist richtig für
    das Bild und lässt den Viewer trotzdem ohne Räume zurück — er findet über
    die Batch Table keinen einzigen, und zwar bei *jedem* über das Backend
    geladenen Modell. Die Angaben liegen im Raumverzeichnis ohnehin vor;
    hier werden sie herausgereicht.

    Anders als `POST /section` mit `with_rooms=true` gilt das für das ganze
    Gebäude statt für einen Ausschnitt, und mit Quader statt Schnittpolygon.
    Der Schnitt beantwortet „was steht auf diesem Blatt", diese Route „welche
    Räume hat der Bau".

    Der erste Aufruf je Modell baut das Raumverzeichnis auf und dauert
    entsprechend lange; jeder weitere liest den Cache.

    **Was die Raumansicht im Viewer zusätzlich braucht** (seit 2026-10):

    * `grundriss=true` legt die Grundrissfigur dazu — die Räume erscheinen
      dann als ihr eigener Körper statt als Hüllquader. Ein L-förmiger Raum
      überdeckt als Quader die Kerbe, und zwei Nachbarn ragen ineinander.
    * `merkmale` und `ifc` aus der Raumsemantik (`tiling/raumsemantik.py`):
      was der Planer in die Psets geschrieben hat, je Angabe mit Fundstelle.
    * `nutzlast` aus `raumlasten.kategorie_von()` — die Kategorie, mit der der
      Lastabtrag rechnet. Die Raumansicht soll keine andere Zahl zeigen.
    """
    src = await asyncio.to_thread(_local_source, job_id)
    try:
        raeume = await asyncio.to_thread(section.raumkennwerte, src, job_id, True, grundriss)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    semantik = await asyncio.to_thread(_semantik, job_id, src)
    stand = await asyncio.to_thread(_nutzlast_stand, job_id)

    antwort: list[RoomBox] = []
    for raum in raeume:
        lo = np.asarray(raum["lo"], dtype=float)
        hi = np.asarray(raum["hi"], dtype=float)
        sem = semantik.get(raum.get("global_id") or "", {})
        antwort.append(
            RoomBox(
                **{k: v for k, v in raum.items() if k not in ("lo", "hi", "z_unten", "z_oben")},
                center=tuple((lo + hi) / 2.0),
                size=tuple(hi - lo),
                lo=tuple(lo),
                hi=tuple(hi),
                merkmale=sem.get("merkmale") or {},
                ifc=sem.get("ifc") or {},
                nutzlast=_statik_nutzlast(raum.get("long_name"), raum.get("name"),
                                          raum.get("global_id") or "", stand),
            )
        )

    logger.info(f"[{job_id}] Raumliste: {len(antwort)} Räume an den Viewer")
    return antwort


class RaumIfcAnfrage(BaseModel):
    """Was die Raumansicht je Raum zusammengeführt hat — siehe `ileen/raum_ifc.py`."""

    raeume: dict[str, dict] = Field(
        ..., description="GlobalId → {klasse, klasse_bezeichnung, klasse_herkunft, "
                         "werte: {kriterium: {wert, quelle_art, quelle_text}}}")
    normsaetze: bool = Field(
        False, description="Zusätzlich leere IFC-Normsätze (Pset_Space…) und eine "
                           "DIN-277-Klassifikation füllen — nie überschreiben")


@router.post("/{job_id}/rooms/ifc")
async def rooms_ifc(job_id: str, anfrage: RaumIfcAnfrage):
    """
    Eine Kopie der Quelldatei mit `Pset_iLEEN_Raum` je Raum — zum Herunterladen.

    Was die Raumansicht weiß (Klasse, Anforderungsprofil, Nutzlast der Statik,
    TGA-Kennwerte, Prüfbefunde), steht danach im Modell, mit der Herkunft je
    Wert in `Pset_iLEEN_RaumHerkunft`. Eine so angereicherte Datei, wieder
    hochgeladen, bringt ihre Zuordnungen mit: `raumdaten.merkmale()` liest den
    Satz zurück, Richtwerte aus dem Katalog ausgenommen.

    Die Werte kommen vom Viewer und nicht aus einer zweiten Rechnung hier — er
    ist die eine Stelle, an der IFC, Statik und Katalog zusammengeführt werden.
    Das Protokoll steht in den Kopfzeilen `X-iLEEN-*`.
    """
    from ileen import raum_ifc

    if not anfrage.raeume:
        raise HTTPException(status_code=422, detail="Keine Räume übergeben.")
    src = await asyncio.to_thread(_local_source, job_id)
    arbeit = Path(tempfile.mkdtemp(prefix=f"raum-ifc-{job_id[:8]}-"))
    ziel = arbeit / f"{src.stem}_raeume.ifc"
    try:
        protokoll = await asyncio.to_thread(
            raum_ifc.anreichern, src, ziel, anfrage.raeume, normsaetze=anfrage.normsaetze)
    except Exception as e:  # noqa: BLE001
        shutil.rmtree(arbeit, ignore_errors=True)
        logger.exception(f"[{job_id}] Raum-IFC fehlgeschlagen")
        raise HTTPException(status_code=500, detail=f"IFC nicht schreibbar: {e}")

    kopf = {
        "X-iLEEN-Raeume": str(protokoll["raeume"]),
        "X-iLEEN-Werte": str(protokoll["werte"]),
        "X-iLEEN-Ersetzt": str(protokoll["ersetzt"]),
        "X-iLEEN-Normsaetze": str(protokoll["normsaetze_ergaenzt"]),
        "X-iLEEN-Normsaetze-Geteilt": str(protokoll["normsaetze_geteilt_uebersprungen"]),
        "X-iLEEN-DIN277": str(protokoll["din277_klassifiziert"]),
        "X-iLEEN-Nicht-Gefunden": str(len(protokoll["nicht_gefunden"])),
        "Access-Control-Expose-Headers": "Content-Disposition, X-iLEEN-Raeume, X-iLEEN-Werte, "
            "X-iLEEN-Ersetzt, X-iLEEN-Normsaetze, X-iLEEN-Normsaetze-Geteilt, X-iLEEN-DIN277, "
            "X-iLEEN-Nicht-Gefunden",
    }
    # Gestreamt und danach weggeräumt: ein angereichertes GoOP-Modell sind
    # 160 MB, die nicht als `bytes` im Speicher des Dienstes liegen müssen.
    return FileResponse(ziel, media_type="application/x-step", filename=ziel.name, headers=kopf,
                        background=BackgroundTask(shutil.rmtree, arbeit, ignore_errors=True))


@router.get("/{job_id}/rooms/{global_id}", response_model=RoomDetail)
async def get_room(job_id: str, global_id: str):
    """
    Die vollständigen Property-Sets eines Raums — für den Steckbrief.

    Nicht in der Raumliste, weil ein ArchiCAD-Raum rund achtzig Eigenschaften
    mitbringt und die Liste damit bei 300 Räumen ein Vielfaches wöge. Und
    nicht über `/elements/{gid}`: die Bauteildatenbank entsteht beim Tiling,
    und das lässt `IfcSpace` aus.
    """
    src = await asyncio.to_thread(_local_source, job_id)
    semantik = await asyncio.to_thread(_semantik, job_id, src)
    sem = semantik.get(global_id)
    if sem is None:
        raise HTTPException(status_code=404,
                            detail=f"Raum '{global_id}' nicht im Modell '{job_id}'.")
    return RoomDetail(global_id=global_id, psets=sem.get("psets") or {},
                      merkmale=sem.get("merkmale") or {}, ifc=sem.get("ifc") or {})


@router.post("/{job_id}/section", response_model=Plan)
async def build_section(job_id: str, request: SectionRequest):
    """
    Schneidet das Modell und gibt die Bauteilfiguren des Ausschnitts zurück.

    Blockierend (IfcOpenShell, trimesh, shapely) und beim ersten Aufruf je Job
    teuer, weil das Elementverzeichnis aufgebaut werden muss. Läuft deshalb im
    Threadpool — der Server hat nur einen Worker, hier stünde sonst die gesamte
    Event-Loop für die Dauer des Schnitts.
    """
    src = await asyncio.to_thread(_local_source, job_id)
    box = section.Box(center=request.center, size=request.size, yaw=request.yaw)

    try:
        drawing = await asyncio.to_thread(
            section.cut,
            src,
            job_id,
            box,
            request.mode,
            request.cut_height,
            request.with_views,
            request.with_rooms,
            request.cut_offset,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    geojson = None
    if drawing.mode == "grundriss" and drawing.figures:
        try:
            geojson = await asyncio.to_thread(_to_geojson, drawing, load_placement(job_id))
        except Exception as e:
            # Ohne Platzierung bleibt der Plan metrisch brauchbar — nur eben
            # nicht auf der Erdkugel. Das ist kein Grund, die Antwort zu kippen.
            logger.warning(f"[{job_id}] Kein GeoJSON: Platzierung nicht lesbar ({e})")

    logger.info(
        f"[{job_id}] {drawing.mode}: {len(drawing.figures)} Figuren, "
        f"Ausdehnung {np.round(drawing.bounds, 2).tolist()}"
    )

    return Plan(
        job_id=job_id,
        mode=drawing.mode,
        figures=[PlanFigure(**vars(figure)) for figure in drawing.figures],
        rooms=[PlanRoom(**vars(room)) for room in drawing.rooms],
        bounds=drawing.bounds,
        plane_origin=drawing.plane_origin,
        signaturen=section.catalog(),
        geojson=geojson,
    )


@catalog_router.get("/signaturen", response_model=dict)
async def signaturen():
    """Der Signaturkatalog allein — für Legende und Musterauswahl im Viewer."""
    return section.catalog()


class PdfPlan(BaseModel):
    """Eine PDF-Seite als Vektor-SVG samt ihrer Originalgröße."""

    seiten: int
    seite: int
    breite_mm: float
    hoehe_mm: float
    svg: str


@catalog_router.post("/pdf", response_model=PdfPlan)
async def pdf_to_svg(datei: UploadFile = File(...), seite: int = Form(1)):
    """
    Wandelt eine hochgeladene PDF-Seite in ein Vektor-SVG — die Grundlage für
    einen im Zeichenmodus geladenen Bestandsplan (siehe plan-pdf.js).

    Zustandslos: die Datei landet nur für die Dauer der Anfrage auf der
    Platte, es entsteht kein Job und keine `job_id`. Ein Seitenwechsel bei
    einer mehrseitigen Vorlage schickt sie deshalb erneut mit — für die paar
    Megabyte einer Planvorlage kein Aufwand, der ein serverseitiges
    Zwischenspeichern rechtfertigt, und ohne den Aufräumpfad, den ein
    liegengelassener Zwischenstand sonst bräuchte.
    """
    if not datei.filename or not datei.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=422, detail="Nur PDF-Dateien.")

    with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
        tmp.write(await datei.read())
        tmp.flush()
        pfad = Path(tmp.name)

        seiten = await asyncio.to_thread(pdf2svg.page_count, pfad)
        breite_mm, hoehe_mm = await asyncio.to_thread(pdf2svg.page_size_mm, pfad, seite)
        svg = await asyncio.to_thread(pdf2svg.to_svg, pfad, seite)

    return PdfPlan(seiten=seiten, seite=seite, breite_mm=breite_mm, hoehe_mm=hoehe_mm, svg=svg)
