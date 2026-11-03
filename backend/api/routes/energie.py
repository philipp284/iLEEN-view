"""
GEG-Energiebilanz: ein Gebäude rechnen und die Bilanz ablegen.

Das Gegenstück zu `fem.py`. Dort wird eine Decke gerechnet und die Rechnung
hängt am Bauwerk; hier ist das Bauwerk selbst der Gegenstand, und die Bilanz
hängt genauso an seiner `job_id`.

    POST   /assets/{job_id}/energie                     Bilanz rechnen → Bericht
    GET    /assets/{job_id}/energie                      alle Bilanzen dieses Modells
    GET    /assets/{job_id}/energie/{result_id}          Bericht und Bildliste
    GET    /assets/{job_id}/energie/{result_id}/bild/{n} ein Bild als PNG
    GET    /assets/{job_id}/energie/{result_id}/modell   die gerechnete Eingabe
    DELETE /assets/{job_id}/energie/{result_id}
    GET    /assets/{job_id}/energie-huelle               Hüllflächen aus dem IFC
    GET    /assets/{job_id}/energie-geometrie            Volumen und Fläche aus dem IFC

**Warum synchron und nicht als Hintergrundaufgabe.** Die Bilanz ist eine
Handvoll Matrixoperationen über zwölf Monate und braucht auch bei hundert
Bauteilen unter einer Sekunde — der Umweg über Statusabfragen wäre hier
Verwaltung ohne Nutzen. Die Statikrechnung nebenan macht das anders, weil sie
Minuten dauert. Der einzige Grund für die Sperre ist matplotlib: `pyplot` hält
globalen Zustand, und FastAPI führt synchrone Endpunkte in einem Threadpool
aus. Zwei gleichzeitige Anfragen würden sich sonst die Figuren vertauschen.

**Die Kataloge kommen aus derselben Quelle wie die Rechnung.** `GET /energie/
katalog` liefert Erzeuger, Energieträger, Bauteilarten und die Referenz-U-Werte
direkt aus `ileen.energie` — das Frontend baut seine Auswahllisten daraus,
statt sie ein zweites Mal zu führen. Eine Liste an zwei Stellen läuft
auseinander, und zwar an der Stelle, an der jemand einen Primärenergiefaktor
korrigiert.
"""

import asyncio
import logging
import shutil
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from minio.error import S3Error
from pydantic import BaseModel, Field

from storage.minio_client import get_bytes, get_json, get_minio, json_bytes, put_bytes, put_json

logger = logging.getLogger(__name__)

router = APIRouter()
katalog_router = APIRouter()

BUCKET = "energie"

# matplotlib.pyplot ist nicht threadsicher — siehe Modulkopf.
_sperre = threading.Lock()


class EnergieAnfrage(BaseModel):
    """Die Hüllflächen des Gebäudes, dazu was die Bauteilliste nicht enthält."""

    modell: dict = Field(..., description="{titel, bauteile:[…]} — siehe ileen.energie.Gebaeude")
    annahmen: dict | None = Field(
        None,
        description=("Volumen, Nutzfläche, Luftwechsel, Wärmebrücken, Erzeuger, "
                     "Energieträger, Anforderungsniveau — siehe ileen.energie.Annahmen"),
    )
    titel: str | None = Field(None, description="Anzeigename; sonst der Modelltitel")


class EnergieLauf(BaseModel):
    result_id: str
    job_id: str
    titel: str
    status: str                       # done | failed
    gestartet: str
    beendet: str | None = None
    fehler: str | None = None
    # Kurzfassung für die Liste, damit das Panel nicht jeden Bericht laden muss
    nachweis_max: float | None = None
    nachweise_offen: list[str] = []
    primaerenergie_kwh_m2a: float | None = None
    effizienzhaus: str | None = None
    bilder: int = 0


class EnergieErgebnis(EnergieLauf):
    bericht: dict | None = None


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat()


def _praefix(job_id: str, result_id: str) -> str:
    return f"{job_id}/{result_id}"


def _ensure_bucket() -> None:
    minio = get_minio()
    if not minio.bucket_exists(BUCKET):
        minio.make_bucket(BUCKET)


def _als_lauf(eintrag: dict) -> EnergieLauf:
    bekannt = set(EnergieLauf.model_fields)
    return EnergieLauf(**{k: v for k, v in eintrag.items() if k in bekannt})


# ── Endpunkte ──────────────────────────────────────────────────────────────


@router.post("/{job_id}/energie", response_model=EnergieErgebnis, tags=["Energie"])
async def bilanz_rechnen(job_id: str, anfrage: EnergieAnfrage):
    """
    Rechnet die GEG-Bilanz und legt Bericht und Bilder ab.

    Geprüft wird vorab nur, was ohne Rechnung zu prüfen ist. Alles Weitere
    meldet `ileen.energie` selbst als `Abbruch` mit einem Satz, der für den
    Menschen im Werkzeug geschrieben ist — der geht als 400 zurück, nicht als
    Serverfehler, denn eine Bauteilliste ohne Flächen ist kein Defekt des
    Servers.
    """
    from ileen import energie as rechenwerk

    modell = anfrage.modell or {}
    if not modell.get("bauteile"):
        raise HTTPException(
            status_code=400,
            detail="Keine Hüllflächen im Modell. Im GEG-Werkzeug Bauteile anlegen "
                   "oder über „Aus dem Modell“ aus dem IFC übernehmen.")

    result_id = uuid.uuid4().hex[:12]
    titel = anfrage.titel or modell.get("titel") or "Energiebilanz"
    modell = {**modell, "titel": titel, "job_id": job_id}

    arbeit = Path(tempfile.mkdtemp(prefix=f"geg-{result_id}-"))
    try:
        with _sperre:
            try:
                bericht = rechenwerk.rechne(
                    modell, arbeit, rechenwerk.Annahmen.aus(anfrage.annahmen))
            except rechenwerk.Abbruch as grund:
                raise HTTPException(status_code=400, detail=str(grund))

        _ensure_bucket()
        praefix = _praefix(job_id, result_id)
        for datei in sorted(arbeit.glob("*.png")):
            put_bytes(BUCKET, f"{praefix}/bilder/{datei.name}",
                      datei.read_bytes(), content_type="image/png")

        put_json(BUCKET, f"{praefix}/modell.json", modell)
        # `json_bytes` fängt numpy-Skalare und NaN ab, die aus dem Rechenmodul
        # durchkommen — json kennt beides nicht.
        put_bytes(BUCKET, f"{praefix}/bericht.json",
                  json_bytes(bericht),
                  content_type="application/json")

        nachweis = bericht.get("nachweis", {}) or {}
        eintrag = {
            "result_id": result_id,
            "job_id": job_id,
            "titel": titel,
            "status": "done",
            "gestartet": _jetzt(),
            "beendet": _jetzt(),
            "nachweis_max": bericht.get("nachweis_max"),
            "nachweise_offen": bericht.get("nachweise_offen", []),
            "primaerenergie_kwh_m2a": (bericht.get("anlage") or {}).get(
                "primaerenergie_kwh_m2a"),
            "effizienzhaus": (nachweis.get("effizienzhaus") or {}).get("stufe"),
            "bilder": len(bericht.get("bilder", [])),
        }
        put_json(BUCKET, f"{praefix}/status.json", eintrag)
        return EnergieErgebnis(**eintrag, bericht=bericht)
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)


@router.get("/{job_id}/energie", response_model=list[EnergieLauf], tags=["Energie"])
async def bilanzen(job_id: str):
    """Alle Bilanzen dieses Modells, jüngste zuerst."""
    _ensure_bucket()
    ergebnis: list[EnergieLauf] = []
    minio = get_minio()
    for objekt in minio.list_objects(BUCKET, prefix=f"{job_id}/", recursive=False):
        result_id = objekt.object_name.rstrip("/").split("/")[-1]
        try:
            eintrag = get_json(BUCKET, f"{job_id}/{result_id}/status.json")
        except S3Error:
            continue
        if eintrag:
            ergebnis.append(_als_lauf(eintrag))
    ergebnis.sort(key=lambda e: e.gestartet, reverse=True)
    return ergebnis


@router.get("/{job_id}/energie/{result_id}", response_model=EnergieErgebnis,
            tags=["Energie"])
async def bilanz(job_id: str, result_id: str):
    """Der vollständige Bericht einer Bilanz."""
    try:
        eintrag = get_json(BUCKET, f"{_praefix(job_id, result_id)}/status.json")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Bilanz '{result_id}' gibt es nicht.")

    bericht = None
    try:
        bericht = get_json(BUCKET, f"{_praefix(job_id, result_id)}/bericht.json")
    except S3Error:
        logger.warning("GEG %s: Bericht fehlt trotz Status", result_id)

    bekannt = set(EnergieErgebnis.model_fields)
    return EnergieErgebnis(**{k: v for k, v in eintrag.items() if k in bekannt},
                           bericht=bericht)


@router.get("/{job_id}/energie/{result_id}/bild/{name}", tags=["Energie"])
async def bild(job_id: str, result_id: str, name: str):
    """Ein Bild der Bilanz als PNG."""
    # Der Name kommt aus unserer eigenen Bildliste — trotzdem geprüft: ein
    # Pfadanteil darin lieferte sonst ein beliebiges Objekt des Buckets aus.
    sicher = Path(name).name
    if sicher != name or not sicher.endswith(".png"):
        raise HTTPException(status_code=400, detail="Ungültiger Bildname.")
    try:
        daten = get_bytes(BUCKET, f"{_praefix(job_id, result_id)}/bilder/{sicher}")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Bild '{sicher}' gibt es nicht.")
    return Response(content=daten, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/{job_id}/energie/{result_id}/modell", tags=["Energie"])
async def modell(job_id: str, result_id: str):
    """Die gerechnete Eingabe — für den Vergleich, wenn ein Ergebnis überrascht."""
    try:
        return get_json(BUCKET, f"{_praefix(job_id, result_id)}/modell.json")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Bilanz '{result_id}' gibt es nicht.")


@router.delete("/{job_id}/energie/{result_id}", tags=["Energie"])
async def bilanz_loeschen(job_id: str, result_id: str):
    purge(job_id, result_id)
    return {"geloescht": result_id}


def _bauteilboxen(job_id: str) -> dict:
    """
    Bounding Box je Bauteil, oder ein leeres Verzeichnis, wenn es nicht geht.

    Die Property-Sets sagen nicht, ob eine Platte Dach oder Bodenplatte ist und
    wohin ein Fenster schaut — beides steckt in der Lage des Bauteils. Die
    liefert das Elementverzeichnis aus `tiling/section.py`, dasselbe, aus dem
    die Bauzeichnungen entstehen; beim ersten Aufruf baut es sich aus der
    IFC-Quelldatei auf und liegt danach im Cache.

    **Scheitert das, ist es kein Fehler der Anfrage.** Modelle, deren
    Quelldatei nicht mehr im uploads-Bucket liegt, haben trotzdem eine
    verwertbare Bauteilablage; sie bekommen die Hüllfläche ohne diese
    Verfeinerung und einen Hinweis darauf in der Mängelliste.
    """
    from api.routes.plan import _local_source
    from tiling import section

    try:
        src = _local_source(job_id)
        _, index = section.build_index(src, job_id)
    except Exception as fehler:  # noqa: BLE001 — jede Ursache endet hier gleich
        logger.info("GEG %s: ohne Modellgeometrie (%s)", job_id, fehler)
        return {}

    return {
        eintrag["global_id"]: {"lo": list(map(float, eintrag["lo"])),
                              "hi": list(map(float, eintrag["hi"]))}
        for eintrag in index if eintrag.get("global_id")
    }


@router.get("/{job_id}/energie-huelle", tags=["Energie"])
async def huelle(job_id: str, nur_extern: bool = True):
    """
    Baut die Hüllflächenliste aus dem IFC-Modell.

    Der Weg führt über dieselbe `properties.sqlite`, aus der die Bauteilanzeige
    im Viewer ihre Property-Sets holt — nicht über ein zweites Parsen der
    IFC-Datei. Was fehlt, steht als `maengel` in der Antwort und wird im
    Werkzeug angezeigt: eine erfundene Fläche fällt in der Bilanz niemandem
    auf, ein fehlendes Bauteil schon.

    Dazu kommt die Bauteillage aus dem Elementverzeichnis, soweit es sich
    aufbauen lässt. `ausgeschlossen` führt jedes Bauteil auf, das ein
    Hüllbauteiltyp wäre, aber nicht in die Bilanz geht — mit Grund und
    GlobalId, damit das Werkzeug es im Modell zeigen kann.
    """
    from api.routes.elements import alle_bauteile
    from ileen import energie as rechenwerk

    # Download und SQLite-Zugriff sind blockierend; der Server läuft mit einem
    # einzigen Worker, hier würde sonst die gesamte Event-Loop warten. Fehlt das
    # Verzeichnis, wirft `_local_properties` bereits eine sprechende 404 —
    # Punktwolken und Meshes tragen keine Bauteilsemantik.
    bauteile = await asyncio.to_thread(alle_bauteile, job_id)
    geometrie = await asyncio.to_thread(_bauteilboxen, job_id)

    gefunden = rechenwerk.huelle_aus_bauteilen(
        bauteile, nur_extern=nur_extern, geometrie=geometrie)
    return {
        **gefunden,
        "geprueft": len(bauteile),
        "uebernommen": len(gefunden["bauteile"]),
        "mit_geometrie": bool(geometrie),
    }


@router.get("/{job_id}/energie-geometrie", tags=["Energie"])
async def geometrie(job_id: str):
    """
    Beheiztes Volumen und Nutzfläche aus dem Modell.

    Beides sind Pflichtangaben der Bilanz, und beide wurden bisher von Hand
    eingetragen oder aus der Hüllfläche geschätzt — mit einem A/V-Faustwert,
    der bei einem gedrungenen Bau um ein Drittel danebenliegt. Im Modell steht
    die Antwort: entweder als `IfcSpace` mit Volumen oder, wo es keine Räume
    gibt, als Deckenfläche je Geschoss mal Geschosshöhe.

    Die Räume und Geschosse gehen einzeln mit heraus, nicht nur die Summe. Ein
    beheiztes Volumen ist eine Zahl, der man nicht ansieht, ob ein Geschoss
    fehlt; eine Liste, in der das Dachgeschoss nicht vorkommt, sieht man an.
    """
    from api.routes.plan import _local_source
    from ileen import energie as rechenwerk
    from tiling import section

    src = await asyncio.to_thread(_local_source, job_id)

    def sammeln():
        # Beide teilen sich das Elementverzeichnis; der erste Aufruf baut es
        # auf, der zweite liest es aus dem Cache.
        return (section.raumkennwerte(src, job_id),
                section.geschosskennwerte(src, job_id, _plattenflaechen(job_id)))

    try:
        raeume, geschosse = await asyncio.to_thread(sammeln)
    except ValueError as fehler:
        # `build_index` wirft das bei einer Datei ohne verwertbare Geometrie.
        raise HTTPException(status_code=422, detail=str(fehler))

    return {"job_id": job_id, **rechenwerk.volumen_aus_geometrie(raeume, geschosse)}


def _plattenflaechen(job_id: str) -> dict[str, float]:
    """
    Die Fläche jeder Deckenplatte aus ihrem Mengensatz, `global_id` → m².

    Das Elementverzeichnis führt nur Bounding Boxes; die tatsächliche Fläche
    einer Platte steht in `Qto_SlabBaseQuantities`, und die liegt in der
    Bauteilablage. Zusammen begrenzen sich die beiden Schätzungen gegenseitig
    (siehe `section._bgf()`) — deshalb der zusätzliche Gang durch die
    `properties.sqlite`, obwohl die Geometrie allein schon eine Zahl ergäbe.

    Fehlt die Ablage, ist das kein Grund zu scheitern: dann bleibt es bei der
    umschriebenen Fläche.
    """
    from api.routes.elements import alle_bauteile
    from ileen.energie import _als_zahl, _feldwert

    try:
        bauteile = alle_bauteile(job_id)
    except Exception as fehler:  # noqa: BLE001
        logger.info("GEG %s: keine Plattenmengen (%s)", job_id, fehler)
        return {}

    flaechen: dict[str, float] = {}
    for eintrag in bauteile:
        if eintrag.get("ifc_type") not in ("IfcSlab", "IfcSlabStandardCase", "IfcRoof"):
            continue
        wert = _als_zahl(_feldwert(eintrag.get("psets"), ["grossarea", "netarea", "area"]))
        if wert and wert > 0 and eintrag.get("global_id"):
            flaechen[eintrag["global_id"]] = wert
    return flaechen


@katalog_router.get("/katalog", tags=["Energie"])
async def katalog():
    """
    Die Auswahllisten des Werkzeugs — aus derselben Quelle wie die Rechnung.

    Damit führt das Frontend keine zweite Fassung der Erzeuger- und
    Energieträgertabellen. Wer hier einen Primärenergiefaktor korrigiert,
    korrigiert ihn für Rechnung und Oberfläche zugleich.
    """
    from ileen import energie as rechenwerk

    return {
        "erzeuger": [{"schluessel": k, **v} for k, v in rechenwerk.ERZEUGER.items()],
        "energietraeger": [{"schluessel": k, **v}
                           for k, v in rechenwerk.ENERGIETRAEGER.items()],
        "bauteilarten": [
            {"schluessel": art, "fx": fx,
             "referenz_u": rechenwerk.REFERENZ_WOHNGEBAEUDE.get(art, {}).get("u"),
             "referenz_g": rechenwerk.REFERENZ_WOHNGEBAEUDE.get(art, {}).get("g"),
             "transparent": art in ("fenster", "dachfenster")}
            for art, fx in rechenwerk.FX_STANDARD.items()
        ],
        "orientierungen": rechenwerk.HIMMELSRICHTUNGEN,
        "klima": {
            "name": "Referenzklima Potsdam (GEG § 22)",
            "temperaturen_c": [float(t) for t in rechenwerk.KLIMA_POTSDAM],
            "monate": rechenwerk.MONATE,
        },
    }


# ── Aufräumen ──────────────────────────────────────────────────────────────


def purge(job_id: str, result_id: str | None = None) -> None:
    """
    Entfernt eine Bilanz oder alle eines Modells.

    Wird beim Löschen eines Assets mit aufgerufen (`assets.delete_asset`) —
    sonst bleiben die Bilder eines Gebäudes liegen, das längst weg ist.
    """
    from storage.minio_client import delete_prefix

    praefix = f"{job_id}/{result_id}" if result_id else f"{job_id}/"
    try:
        delete_prefix(BUCKET, praefix)
    except Exception as fehler:  # noqa: BLE001
        logger.warning("GEG: %s nicht löschbar (%s)", praefix, fehler)
