"""
Sensoren und ihre Messwerte.

    POST   /sensoren/messwerte          Messwerte aufnehmen (JSON Lines oder JSON-Liste)
    GET    /sensoren                    das Register: 24 Sensoren mit IRI, Zone, Anker
    GET    /sensoren/stand              je Sensor der letzte bekannte Wert
    GET    /sensoren/zahlen             Überblick zur Ablage
    GET    /sensoren/raeume             alle Räume mit Messwerten (?zeit= für einen früheren Stand)
    GET    /sensoren/raeume/matrix      eine Messgröße aller Räume über ein Zeitfenster
    GET    /sensoren/bauteil/{iri}      alle Sensoren an einem Bauteil, je mit letztem Wert
    GET    /sensoren/{iri}/verlauf      Zeitreihe eines Sensors

**Die Reihenfolge der Routen ist Teil der Zusicherung.** `/sensoren/stand` und
`/sensoren/bauteil/…` stehen vor `/sensoren/{iri}/…`, sonst liest FastAPI
„stand" als IRI.

Der Join läuft über die IRI und über nichts sonst
=================================================
Kein Endpunkt nimmt eine IFC-GlobalId entgegen. Das Frontend kennt beim Klick
auf ein Bauteil dessen GlobalId, rechnet daraus `uuid5(NAMESPACE_DNS, guid)`
und fragt damit hier an — dieselbe Regel, die der gaeco-Export benutzt. Gäbe
es hier einen zweiten Weg hinein, gäbe es über kurz oder lang zwei
Schlüsselräume.

**Dieser Router kennt kein SQL und keine Dateipfade.** Er ruft ausschließlich
`ileen.zeitreihe` auf. Die Ablage ist vorläufig (Entscheidung E2); wer sie
gegen eine Zeitreihen-Datenbank tauscht, tauscht genau ein Modul.
"""

import logging

from fastapi import APIRouter, HTTPException, Query, Request

from ileen import zeitreihe

logger = logging.getLogger(__name__)

router = APIRouter()

# Ein Rückblick über sieben Tage sind rund 36 MB. Der Strom wird zeilenweise
# verarbeitet, damit nicht die ganze Menge zugleich im Speicher liegt.
_STAPEL = 20_000


# ── Aufnehmen ────────────────────────────────────────────────────────────────

@router.post("/messwerte")
async def messwerte_aufnehmen(request: Request):
    """
    Nimmt Messwerte entgegen — JSON Lines wie aus `scripts/sensor_demo.py`,
    oder eine JSON-Liste.

    Das Einspeisen ist idempotent: Schlüssel ist (Sensor, Zeitpunkt), dieselbe
    Datei zweimal hineingegeben ergibt dieselbe Ablage. Ein abgebrochener
    Import lässt sich damit einfach wiederholen.
    """
    uebernommen = 0
    rest = b""
    stapel: list[dict] = []
    als_liste = None

    try:
        async for stueck in request.stream():
            if not stueck:
                continue
            if als_liste is None:
                als_liste = stueck.lstrip()[:1] == b"["
            if als_liste:
                rest += stueck
                continue
            rest += stueck
            *zeilen, rest = rest.split(b"\n")
            for zeile in zeilen:
                if zeile.strip():
                    stapel.append(_gelesen(zeile))
            if len(stapel) >= _STAPEL:
                uebernommen += zeitreihe.aufnehmen(stapel)
                stapel = []

        if als_liste:
            stapel = zeitreihe.aus_zeilen(rest.decode("utf-8"))
        elif rest.strip():
            stapel.append(_gelesen(rest))
        if stapel:
            uebernommen += zeitreihe.aufnehmen(stapel)
    except ValueError as fehler:
        raise HTTPException(status_code=400, detail=f"Messwerte nicht lesbar: {fehler}")

    logger.info("Messwerte aufgenommen: %d", uebernommen)
    return {"uebernommen": uebernommen, **zeitreihe.zahlen()}


def _gelesen(zeile: bytes) -> dict:
    import json
    try:
        return json.loads(zeile)
    except json.JSONDecodeError as fehler:
        raise ValueError(f"Zeile ist kein JSON: {fehler}") from fehler


# ── Register und Stand ───────────────────────────────────────────────────────

@router.get("", include_in_schema=True)
@router.get("/", include_in_schema=False)
def sensorregister():
    """Die statische Seite: was es gibt, woran es hängt, in welchem Bereich es misst."""
    return zeitreihe.register()


@router.get("/stand")
def letzter_stand():
    """Je Sensor der jüngste Wert. Ein Sensor ohne Messung trägt `status: "ohne"`."""
    return zeitreihe.stand()


@router.get("/zahlen")
def zahlen():
    return zeitreihe.zahlen()


# ── Räume ────────────────────────────────────────────────────────────────────

@router.get("/raeume")
def raeume_stand(
    zeit: str | None = Query(None, description="ISO-Zeit mit Z; ohne: der jüngste Stand"),
    kompakt: bool = Query(False, description="nur GlobalId, Wert, Zeit, Alter — für Anzeigen, die färben"),
):
    """
    Alle Räume mit dem jüngsten Wert je Messgröße (Temperatur, CO₂, Feuchte, Präsenz).

    Der Anker der Raumsensoren ist der IfcSpace; `global_id` und `iri` benennen
    ihn wie jedes andere Bauteil. Mit `zeit` kommt der Zustand von damals.
    """
    return zeitreihe.raeume_stand(zeit, kompakt=kompakt)


@router.get("/raeume/matrix")
def raeume_matrix(
    groesse: str = Query("raumtemperatur", description="raumtemperatur · co2 · luftfeuchte · praesenz"),
    von: str | None = Query(None), bis: str | None = Query(None),
    schritt: int = Query(15, ge=5, le=240, description="Rasterschritt in Minuten"),
    stunden: int = Query(48, ge=1, le=24 * 31, description="Fensterlänge, wenn `von` fehlt"),
):
    """Eine Messgröße aller Räume über ein Zeitfenster — die Grundlage des Abspielens."""
    return zeitreihe.raeume_matrix(groesse, von=von, bis=bis, schritt_min=schritt, stunden=stunden)


# ── Der Join über die IRI ────────────────────────────────────────────────────

@router.get("/bauteil/{iri}")
def sensoren_am_bauteil(iri: str):
    """
    Alle Sensoren an einem Bauteil, je mit letztem Wert.

    Ein Bauteil ohne Sensoren liefert eine leere Liste mit HTTP 200 — das ist
    der Normalfall und kein Fehler. Ein 404 hier hieße, dass das Frontend bei
    jedem Klick auf eine Wand einen Fehler behandeln müsste.
    """
    return zeitreihe.am_bauteil(iri)


@router.get("/{iri}/verlauf")
def sensorverlauf(
    iri: str,
    von: str | None = Query(None, description="ISO-Zeit mit Z, einschließlich"),
    bis: str | None = Query(None, description="ISO-Zeit mit Z, einschließlich"),
    hoechstens: int | None = Query(None, alias="max", ge=1, le=100_000,
                                   description="höchstens so viele Werte; dünnt aus, mittelt nicht"),
):
    """
    Die Zeitreihe eines Sensors, aufsteigend nach Zeit.

    Ohne Fenster die letzten 24 Stunden vor dem jüngsten vorhandenen Wert.
    """
    return zeitreihe.verlauf(iri, von=von, bis=bis, hoechstens=hoechstens)
