"""
Flugverkehr über dem Modell — Proxy auf das OpenSky Network.

Warum überhaupt serverseitig? Zwei Gründe, die beide nicht verhandelbar sind:

1. **Das Geheimnis.** OpenSky hat Basic Auth abgeschafft; Zugang läuft über
   OAuth2 Client Credentials. Ein `client_secret` im Browser-Bundle wäre für
   jeden in den Devtools lesbar und würde fremdes Guthaben verbrennen. Der
   Token wird deshalb hier geholt und liegt hier.
2. **Das Guthaben.** Ein angemeldeter Zugang hat 4 000 Credits am Tag, ein
   anonymer 400. Jede Abfrage einer Box bis 25 Quadratgrad kostet einen
   Credit — bei zehn offenen Browsertabs wäre das Tageskontingent in einer
   Stunde weg. Der Cache unten macht aus n Tabs eine Abfrage.

Der Rest ist Umformung: OpenSky liefert Zustandsvektoren als Arrays mit 18
Positionen, deren Bedeutung nur in der Doku steht. Was hier herausgeht, hat
Namen.

## Höhenbezug — der Punkt, an dem ein Flugzeug sonst im Boden steckt

OpenSky liefert zwei Höhen, und sie meinen Verschiedenes:

* `baro_altitude` — barometrisch, bezogen auf die Standardatmosphäre. In der
  Luftfahrt die maßgebliche Größe (Flugflächen), aber kein geometrischer Ort.
* `geo_altitude` — geometrisch aus GNSS, bezogen auf das **WGS84-Ellipsoid**.

CesiumJS rechnet ellipsoidisch. `geo_altitude` ist damit die Höhe, die direkt
verwendbar ist; `baro_altitude` braucht die Geoidundulation als Zuschlag
(dasselbe Thema wie in `tiling/elevation.py`, nur andersherum). Beide gehen
deshalb unverändert heraus, und der Viewer entscheidet — er kennt seinen
Geländebezug besser als dieses Modul.

## Konfiguration

    OPENSKY_CLIENT_ID       aus dem Konto-Dashboard auf opensky-network.org
    OPENSKY_CLIENT_SECRET   dito; fehlt beides, läuft alles anonym weiter
    OPENSKY_CACHE_TTL_S     Vorhaltezeit einer Antwort (Vorgabe: modusabhängig)

Ohne Zugangsdaten ist der Dienst nicht kaputt, sondern langsamer: anonym gibt
es dieselben Zustandsvektoren, nur mit 10-Sekunden-Auflösung und 400 Credits.
Genau dafür ist `modus` in jeder Antwort enthalten.
"""

import asyncio
import logging
import os
import time

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

_TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/"
    "protocol/openid-connect/token"
)
_API = "https://opensky-network.org/api"
_TIMEOUT = 15.0

# Poll-Vorgabe, die der Viewer übernimmt. Bemessen am Tageskontingent: 20 s
# ergeben bei durchgehendem Betrieb 4 320 Abfragen — knapp über den 4 000
# Credits, in der Praxis reichlich, weil niemand einen Tag lang zusieht.
# Anonym wären 400 Credits nach zwei Stunden weg, deshalb dort 60 s.
_INTERVALL = {"oauth": 20, "anon": 60}

# Die Box wird auf dieses Raster gerundet, bevor sie zum Cache-Schlüssel wird.
# Ohne das ist jede Kamerabewegung eine neue Abfrage; mit ihm bleibt ein
# langsam schwenkender Viewer im selben Eimer. Ein Viertelgrad ist rund 28 km
# in der Breite — schmal genug, dass der Rand nicht auffällt.
_RASTER = 0.25

# 25 Quadratgrad kosten einen Credit, alles darüber zwei bis vier. Größere
# Boxen werden nicht abgelehnt, aber die Antwort sagt, was sie gekostet hat.
_BILLIG_GRAD2 = 25.0

_token: str | None = None
_token_bis = 0.0
_token_sperre = asyncio.Lock()

# Schlüssel → (zeitpunkt, nutzlast). Klein genug, dass ein dict genügt; ein
# Eintrag ist ein paar hundert Kilobyte, und alte Schlüssel räumt _aufraeumen.
_cache: dict[str, tuple[float, dict]] = {}
_cache_sperre = asyncio.Lock()
_guthaben: int | None = None


class Flugzeug(BaseModel):
    icao24: str
    rufzeichen: str | None
    land: str | None
    lon: float
    lat: float
    hoehe_baro: float | None      # m über MSL (Standardatmosphäre)
    hoehe_geo: float | None       # m über WGS84-Ellipsoid
    am_boden: bool
    geschwindigkeit: float | None  # m/s über Grund
    kurs: float | None             # rechtweisend, Grad von Nord
    steigrate: float | None        # m/s, positiv = steigend
    squawk: str | None
    kategorie: int | None
    zeit_position: float | None    # Unixzeit der letzten Positionsmeldung


class Zustaende(BaseModel):
    zeit: float                    # Unixzeit des Datenstands laut OpenSky
    alter_s: float                 # wie alt dieser Stand jetzt ist
    intervall_s: int               # empfohlene Abfragefolge für den Viewer
    modus: str                     # "oauth" | "anon"
    guthaben: int | None           # Restcredits, soweit OpenSky sie meldet
    kosten: int                    # Credits, die diese Box kostet
    aus_cache: bool
    anzahl: int
    flugzeuge: list[Flugzeug]


class Spurpunkt(BaseModel):
    zeit: float
    lat: float
    lon: float
    hoehe_baro: float | None
    kurs: float | None
    am_boden: bool


class Spur(BaseModel):
    icao24: str
    rufzeichen: str | None
    beginn: float | None
    ende: float | None
    punkte: list[Spurpunkt]


class Stand(BaseModel):
    modus: str
    zugang: str
    intervall_s: int
    cache_ttl_s: int
    guthaben: int | None
    eintraege_im_cache: int


def _zugangsdaten() -> tuple[str, str] | None:
    kennung = (os.getenv("OPENSKY_CLIENT_ID") or "").strip()
    geheimnis = (os.getenv("OPENSKY_CLIENT_SECRET") or "").strip()
    return (kennung, geheimnis) if kennung and geheimnis else None


def _modus() -> str:
    return "oauth" if _zugangsdaten() else "anon"


def _zahl_aus_umgebung(name: str, vorgabe: int) -> int:
    """Ganzzahl aus einer Umgebungsvariablen — leer und unsinnig zählen nicht.

    docker-compose reicht nicht gesetzte Werte als **leeren String** durch
    (`${OPENSKY_POLL_S:-}`), nicht als fehlende Variable. `os.getenv(name,
    vorgabe)` liefert dann "" statt der Vorgabe, und int("") wirft.
    """
    roh = (os.getenv(name) or "").strip()
    if not roh:
        return vorgabe
    try:
        return int(roh)
    except ValueError:
        logger.warning("%s=%r ist keine Zahl — es gilt %s", name, roh, vorgabe)
        return vorgabe


def _intervall() -> int:
    return max(5, _zahl_aus_umgebung("OPENSKY_POLL_S", _INTERVALL[_modus()]))


def _ttl() -> int:
    # Die Vorhaltezeit liegt eine Sekunde unter dem Poll-Intervall: sonst
    # liefert der Cache dem pünktlich wiederkommenden Viewer denselben Stand
    # noch einmal, und die Anzeige friert für eine Runde ein.
    return max(1, _zahl_aus_umgebung("OPENSKY_CACHE_TTL_S", max(1, _intervall() - 1)))


async def _hole_token() -> str | None:
    """Gültiges Bearer-Token, oder `None` im anonymen Betrieb."""
    global _token, _token_bis

    daten = _zugangsdaten()
    if daten is None:
        return None

    if _token and time.time() < _token_bis:
        return _token

    async with _token_sperre:
        # Zweite Prüfung in der Sperre: während des Wartens kann ein anderer
        # Aufruf den Token schon erneuert haben.
        if _token and time.time() < _token_bis:
            return _token

        kennung, geheimnis = daten
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as klient:
                antwort = await klient.post(
                    _TOKEN_URL,
                    data={
                        "grant_type": "client_credentials",
                        "client_id": kennung,
                        "client_secret": geheimnis,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
            if antwort.status_code != 200:
                logger.warning(
                    "OpenSky-Token abgelehnt (%s) — es wird anonym weitergefragt",
                    antwort.status_code,
                )
                _token, _token_bis = None, 0.0
                return None

            nutzlast = antwort.json()
            _token = nutzlast.get("access_token")
            # Der Token läuft nach 30 Minuten ab; 60 s Sicherheitsabstand,
            # damit keine Abfrage genau in den Wechsel fällt.
            gueltig = float(nutzlast.get("expires_in") or 1800)
            _token_bis = time.time() + max(60.0, gueltig - 60.0)
            return _token
        except httpx.HTTPError as fehler:
            logger.warning("OpenSky-Token nicht erreichbar: %s", fehler)
            _token, _token_bis = None, 0.0
            return None


def _rastern(wert: float) -> float:
    return round(round(wert / _RASTER) * _RASTER, 4)


def _kosten(lamin: float, lomin: float, lamax: float, lomax: float) -> int:
    flaeche = abs(lamax - lamin) * abs(lomax - lomin)
    if flaeche <= _BILLIG_GRAD2:
        return 1
    if flaeche <= 400:
        return 2
    if flaeche <= 1600:
        return 3
    return 4


async def _aufraeumen(jetzt: float) -> None:
    alt = [s for s, (t, _) in _cache.items() if jetzt - t > 300]
    for schluessel in alt:
        _cache.pop(schluessel, None)


async def _frage_opensky(pfad: str, parameter: dict) -> dict:
    """Ein Aufruf gegen OpenSky, mit Token wenn vorhanden."""
    global _guthaben, _token, _token_bis

    token = await _hole_token()
    kopfzeilen = {"Authorization": f"Bearer {token}"} if token else {}

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as klient:
            antwort = await klient.get(
                f"{_API}{pfad}", params=parameter, headers=kopfzeilen
            )
    except httpx.HTTPError as fehler:
        raise HTTPException(502, f"OpenSky nicht erreichbar: {fehler}") from fehler

    rest = antwort.headers.get("X-Rate-Limit-Remaining")
    if rest is not None:
        try:
            _guthaben = int(rest)
        except ValueError:
            pass

    if antwort.status_code == 429:
        raise HTTPException(
            429,
            "OpenSky-Kontingent erschöpft. Ohne Zugangsdaten sind es 400 "
            "Credits am Tag — OPENSKY_CLIENT_ID/SECRET setzen hebt auf 4 000.",
        )
    if antwort.status_code == 401:
        # Token abgelaufen oder Client gesperrt: verwerfen, damit der nächste
        # Aufruf ihn neu holt statt ewig gegen 401 zu laufen.
        _token, _token_bis = None, 0.0
        raise HTTPException(502, "OpenSky hat die Zugangsdaten abgelehnt.")
    if antwort.status_code == 404:
        # `/tracks/all` führt OpenSky als experimentell und antwortet für
        # fremde Flugzeuge regelmäßig mit 404. Das ist kein Serverfehler,
        # sondern eine Auskunft: für dieses Flugzeug gibt es keine Spur.
        raise HTTPException(404, "OpenSky führt zu diesem Flugzeug keine Spur.")
    if antwort.status_code != 200:
        raise HTTPException(502, f"OpenSky antwortet mit {antwort.status_code}.")

    return antwort.json() or {}


def _zu_flugzeug(vektor: list) -> Flugzeug | None:
    """Ein Zustandsvektor (18 Positionen) wird zu einem benannten Datensatz.

    Ohne Länge/Breite ist der Eintrag für eine Karte wertlos — OpenSky führt
    solche Flugzeuge trotzdem, wenn nur der Transponder gehört wurde. Sie
    fallen hier heraus.
    """
    if len(vektor) < 17 or vektor[5] is None or vektor[6] is None:
        return None

    def zahl(index: int) -> float | None:
        wert = vektor[index] if index < len(vektor) else None
        return None if wert is None else float(wert)

    rufzeichen = (vektor[1] or "").strip() or None
    return Flugzeug(
        icao24=str(vektor[0]).lower(),
        rufzeichen=rufzeichen,
        land=vektor[2] or None,
        lon=float(vektor[5]),
        lat=float(vektor[6]),
        hoehe_baro=zahl(7),
        hoehe_geo=zahl(13),
        am_boden=bool(vektor[8]),
        geschwindigkeit=zahl(9),
        kurs=zahl(10),
        steigrate=zahl(11),
        squawk=vektor[14] if len(vektor) > 14 else None,
        kategorie=int(vektor[17]) if len(vektor) > 17 and vektor[17] is not None else None,
        zeit_position=zahl(3),
    )


@router.get("/zustaende", response_model=Zustaende)
async def zustaende(
    lamin: float = Query(..., ge=-90.0, le=90.0, description="Süden der Box"),
    lomin: float = Query(..., ge=-180.0, le=180.0, description="Westen der Box"),
    lamax: float = Query(..., ge=-90.0, le=90.0, description="Norden der Box"),
    lomax: float = Query(..., ge=-180.0, le=180.0, description="Osten der Box"),
):
    """Alle Flugzeuge in einer Box — der eine Endpunkt, den der Viewer pollt."""
    if lamax <= lamin or lomax <= lomin:
        raise HTTPException(400, "Die Box ist leer oder verdreht.")

    box = (_rastern(lamin), _rastern(lomin), _rastern(lamax), _rastern(lomax))
    schluessel = "z:%s,%s,%s,%s" % box
    jetzt = time.time()

    async with _cache_sperre:
        await _aufraeumen(jetzt)
        gespeichert = _cache.get(schluessel)
        if gespeichert and jetzt - gespeichert[0] < _ttl():
            nutzlast = gespeichert[1]
            return Zustaende(
                **{
                    **nutzlast,
                    "alter_s": round(jetzt - nutzlast["zeit"], 1),
                    "aus_cache": True,
                    "guthaben": _guthaben,
                    "intervall_s": _intervall(),
                }
            )

    roh = await _frage_opensky(
        "/states/all",
        {
            "lamin": box[0],
            "lomin": box[1],
            "lamax": box[2],
            "lomax": box[3],
            "extended": 1,
        },
    )

    vektoren = roh.get("states") or []
    flugzeuge = [f for f in (_zu_flugzeug(v) for v in vektoren) if f is not None]
    zeit = float(roh.get("time") or jetzt)

    nutzlast = {
        "zeit": zeit,
        "alter_s": round(jetzt - zeit, 1),
        "intervall_s": _intervall(),
        "modus": _modus(),
        "guthaben": _guthaben,
        "kosten": _kosten(*box),
        "aus_cache": False,
        "anzahl": len(flugzeuge),
        "flugzeuge": [f.model_dump() for f in flugzeuge],
    }

    async with _cache_sperre:
        _cache[schluessel] = (jetzt, nutzlast)

    return Zustaende(**nutzlast)


@router.get("/spur", response_model=Spur)
async def spur(icao24: str = Query(..., min_length=6, max_length=6)):
    """Geflogener Weg der letzten Zeit — für die Spur hinter dem Flugzeug.

    Kostet deutlich mehr Credits als eine Boxabfrage und wird deshalb nur auf
    Klick geholt, nie im Takt.
    """
    kennung = icao24.strip().lower()
    if not all(z in "0123456789abcdef" for z in kennung):
        raise HTTPException(400, "icao24 ist eine sechsstellige Hexadresse.")

    schluessel = f"s:{kennung}"
    jetzt = time.time()

    async with _cache_sperre:
        gespeichert = _cache.get(schluessel)
        if gespeichert and jetzt - gespeichert[0] < 60:
            return Spur(**gespeichert[1])

    roh = await _frage_opensky("/tracks/all", {"icao24": kennung, "time": 0})

    punkte = []
    for weg in roh.get("path") or []:
        if len(weg) < 6 or weg[1] is None or weg[2] is None:
            continue
        punkte.append(
            Spurpunkt(
                zeit=float(weg[0]),
                lat=float(weg[1]),
                lon=float(weg[2]),
                hoehe_baro=None if weg[3] is None else float(weg[3]),
                kurs=None if weg[4] is None else float(weg[4]),
                am_boden=bool(weg[5]),
            )
        )

    nutzlast = {
        "icao24": kennung,
        "rufzeichen": (roh.get("callsign") or "").strip() or None,
        "beginn": roh.get("startTime"),
        "ende": roh.get("endTime"),
        "punkte": [p.model_dump() for p in punkte],
    }

    async with _cache_sperre:
        _cache[schluessel] = (jetzt, nutzlast)

    return Spur(**nutzlast)


@router.get("/stand", response_model=Stand)
async def stand():
    """Betriebszustand — beantwortet im Panel die Frage „warum so träge?“."""
    modus = _modus()
    return Stand(
        modus=modus,
        zugang=(
            "Zugangsdaten gesetzt (4 000 Credits/Tag)"
            if modus == "oauth"
            else "anonym (400 Credits/Tag, 10-s-Auflösung)"
        ),
        intervall_s=_intervall(),
        cache_ttl_s=_ttl(),
        guthaben=_guthaben,
        eintraege_im_cache=len(_cache),
    )
