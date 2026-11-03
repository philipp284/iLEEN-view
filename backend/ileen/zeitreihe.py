"""
Messwerte der Sensoren — in einer SQLite-Datei.

Warum überhaupt eine eigene Ablage
==================================
Zustand darf nicht durch den Tiler. Geometrie wird gekachelt und liegt danach
als 3D Tiles fest; ein Messwert ändert sich im Minutentakt und hätte in einer
Kachel nichts verloren. Beides trifft sich erst im Browser, und zwar über die
IRI — hier liegt die Seite, die sich ändert.

**Diese Ablage ist ausdrücklich vorläufig.** SQLite ist die pragmatische Wahl
für die Erprobung (Entscheidung E2); eine echte Zeitreihen-Datenbank kommt,
wenn aus Demodaten echte Sensoren werden. Damit dieser Wechsel eine Datei
betrifft und nicht das halbe Backend, ist die Schnittstelle nach außen schmal
und frei von SQL: `init`, `aufnehmen`, `register`, `stand`, `am_bauteil`,
`verlauf`, `zahlen`. Alles, was SQL kennt, steht in dieser Datei.

Der Schlüssel ist (Sensor, Zeitpunkt)
=====================================
Damit ist das Einspeisen idempotent: dieselbe Datei zweimal hineingegeben
ergibt dieselbe Ablage. Das ist keine Feinheit, sondern die Voraussetzung
dafür, dass sich ein abgebrochener Import einfach wiederholen lässt, statt
vorher aufgeräumt werden zu müssen.

Die Zeit ist ISO-Text mit `Z`
=============================
So, wie sie hereinkommt. Für ein festes Format mit fester Länge fallen
lexikografische Ordnung und Zeitordnung zusammen: ein Zeitfenster ist dann ein
Zeichenkettenvergleich, und der Index darüber trägt sowohl die Sortierung als
auch den Bereich. Unix-Sekunden wären schneller zu rechnen und an jeder
Fehlersuche teurer.

Das Register kommt aus der CSV, nicht aus der Datenbank
=======================================================
`data/sensoren.csv` und `data/zonen.csv` sind der Vertrag aus Paket 2 — die
statische Seite, die später als SOSA/SSN-Tripel nach gaeco geht. Die Datenbank
hält nur, was sich ändert.
"""

from __future__ import annotations

import csv
import json
import math
import os
import sqlite3
import threading
import uuid
from pathlib import Path

# Der Ort der Datei. Im Container liegt `/data` auf einem Volume — ohne das
# wären die Messwerte nach jedem `--build` weg.
DB_PFAD = Path(os.environ.get("ILEEN_SENSOR_DB", "/data/sensoren/zeitreihe.db"))

# Das Register liegt beim Generator, der es schreibt.
REGISTER_PFAD = Path(os.environ.get("ILEEN_SENSOR_REGISTER",
                                    Path(__file__).resolve().parent.parent / "data"))

# Muss mit `scripts/sensor_demo.py` übereinstimmen — der Prüfstein vergleicht
# beide gegeneinander, damit eine Änderung hier nicht still den Join zerreißt.
IRI_NAMENSRAUM_SENSOR = "https://ileen.hs-mainz.de/sensor/"

_lock = threading.Lock()
_register_zwischenspeicher: list[dict] | None = None

# Messwerte für Sensoren, die das Register nicht kennt. Wird in `zahlen()`
# gemeldet, damit eine falsch benannte Quelle auffällt, statt still zu
# verschwinden.
_abgewiesen = 0

SCHEMA = """
CREATE TABLE IF NOT EXISTS messwert (
  sensor  TEXT NOT NULL,
  iri     TEXT NOT NULL,
  zeit    TEXT NOT NULL,
  wert    REAL NOT NULL,
  einheit TEXT,
  status  TEXT NOT NULL DEFAULT 'ok',
  PRIMARY KEY (sensor, zeit)
) WITHOUT ROWID;

-- Für den Verlauf eines Sensors: trägt Bereich und Sortierung zugleich.
CREATE INDEX IF NOT EXISTS idx_messwert_iri_zeit ON messwert(iri, zeit);
"""


def verbindung() -> sqlite3.Connection:
    """
    Eine Verbindung je Aufruf, nicht eine je Prozess.

    Wie in `issues_db.verbindung()`, aus demselben Grund: FastAPI führt
    synchrone Endpunkte im Threadpool aus. WAL erlaubt Lesen während des
    Schreibens — beim Einspeisen eines Sieben-Tage-Rückblicks ist das der
    Unterschied zwischen einer flüssigen Oberfläche und „database is locked".
    """
    DB_PFAD.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PFAD, timeout=10.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init() -> None:
    with _lock, verbindung() as con:
        con.executescript(SCHEMA)


# ── Die IRI: der einzige Join-Key ───────────────────────────────────────────

def iri_bauteil(global_id: str) -> str:
    """Dieselbe Regel, die der gaeco-Export und `sensor_demo.py` benutzen."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, global_id))


def iri_sensor(sensor_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, IRI_NAMENSRAUM_SENSOR + sensor_id))


# ── Register ────────────────────────────────────────────────────────────────

def register(neu_lesen: bool = False) -> list[dict]:
    """Die 24 Sensoren aus der CSV, angereichert um die beiden IRI."""
    global _register_zwischenspeicher
    if _register_zwischenspeicher is not None and not neu_lesen:
        return _register_zwischenspeicher

    with open(REGISTER_PFAD / "zonen.csv", encoding="utf-8", newline="") as f:
        zonen = {z["zone_id"]: z for z in csv.DictReader(f)}
    with open(REGISTER_PFAD / "sensoren.csv", encoding="utf-8", newline="") as f:
        zeilen = list(csv.DictReader(f))

    eintraege = []
    for s in zeilen:
        zone = zonen.get(s["zone_id"], {})
        eintraege.append({
            "sensor_id": s["sensor_id"],
            "bezeichnung": s["bezeichnung"],
            "messgroesse": s["messgroesse"],
            "einheit": s["einheit"],
            "intervall_s": int(s["intervall_s"]),
            "zone": s["zone_id"],
            "zone_bezeichnung": zone.get("bezeichnung", ""),
            "anker_guid": s["anker_guid"],
            "anker_iri": iri_bauteil(s["anker_guid"]),
            "anker_typ": zone.get("anker_typ", ""),
            "iri": iri_sensor(s["sensor_id"]),
            "brick_klasse": s["brick_klasse"],
            "bereich_min": float(s["bereich_min"]),
            "bereich_max": float(s["bereich_max"]),
        })
    _register_zwischenspeicher = eintraege
    return eintraege


_raum_zwischenspeicher: list[dict] | None = None


def raum_register(neu_lesen: bool = False) -> list[dict]:
    """
    Die Raumsensoren aus `data/sensoren_raeume.csv`, angereichert um die beiden IRI.

    Getrennt vom Zonenregister, weil Raumsensoren die Geschossansicht nicht
    fluten sollen: `register()` und `stand()` bleiben bei den 24 Sensoren, die
    `sensor-store.js` seit jeher erwartet. Der Anker ist hier die GlobalId des
    **IfcSpace**; seine IRI ist `uuid5(DNS, GlobalId)` wie bei jedem Bauteil.
    Fehlt die Datei, gibt es schlicht keine Raumsensoren.
    """
    global _raum_zwischenspeicher
    if _raum_zwischenspeicher is not None and not neu_lesen:
        return _raum_zwischenspeicher
    pfad = REGISTER_PFAD / "sensoren_raeume.csv"
    eintraege: list[dict] = []
    if pfad.exists():
        with open(pfad, encoding="utf-8", newline="") as f:
            for s in csv.DictReader(f):
                eintraege.append({
                    "sensor_id": s["sensor_id"],
                    "bezeichnung": f"{s['raum_name']} {s['raum_bezeichnung']}".strip(),
                    "messgroesse": s["messgroesse"],
                    "einheit": s["einheit"],
                    "intervall_s": int(s["intervall_s"]),
                    "zone": s["storey"],
                    "zone_bezeichnung": s["storey"],
                    "anker_guid": s["raum_guid"],
                    "anker_iri": iri_bauteil(s["raum_guid"]),
                    "anker_typ": "IfcSpace",
                    "iri": iri_sensor(s["sensor_id"]),
                    "brick_klasse": s["brick_klasse"],
                    "bereich_min": float(s["bereich_min"]),
                    "bereich_max": float(s["bereich_max"]),
                    "raum_name": s["raum_name"],
                    "raum_bezeichnung": s["raum_bezeichnung"],
                    "profil": s["profil"],
                    "flaeche_m2": float(s["flaeche_m2"]),
                })
    _raum_zwischenspeicher = eintraege
    return eintraege


def alle_sensoren() -> list[dict]:
    return register() + raum_register()


def _nach_iri() -> dict[str, dict]:
    return {s["iri"]: s for s in register()}


# ── Aufnehmen ───────────────────────────────────────────────────────────────

def aufnehmen(messwerte) -> int:
    """
    Nimmt Messwerte auf und liefert die Anzahl übernommener Zeilen.

    **Die IRI stammt aus dem Register, nicht aus der Nachricht.** Solange nur
    der eigene Generator einspeiste, konnte das nicht auffallen — beide rechnen
    dieselbe Regel. Sobald Werte von außen kommen, entstünde sonst ein zweiter
    Schlüsselraum: ein Wert mit passendem Sensornamen, aber fremder IRI, stünde
    im Stand (der über `sensor` geht) und fehlte im Verlauf (der über `iri`
    geht). Die Oberfläche zeigte dann eine Zahl, die der Verlauf nicht kennt.

    **Ein Sensor, den das Register nicht kennt, wird abgewiesen** und gezählt.
    Stillschweigend abzulegen hieße, eine Halde anzulegen, die nirgends
    sichtbar ist und trotzdem wächst.

    `INSERT OR REPLACE` statt `OR IGNORE`: derselbe Zeitpunkt darf
    nachträglich korrigiert werden. Für die Idempotenz macht es keinen
    Unterschied — der Schlüssel entscheidet, nicht die Reihenfolge.

    Ein `executemany` in **einer** Transaktion, nicht ein Commit je Zeile:
    bei 185.000 Werten ist das der Unterschied zwischen Sekunden und einer
    Viertelstunde.
    """
    global _abgewiesen
    init()
    bekannt = {s["sensor_id"]: s for s in alle_sensoren()}
    stapel = []
    for m in messwerte:
        try:
            kennung = m["sensor"]
            eintrag = bekannt.get(kennung)
            if eintrag is None:
                _abgewiesen += 1
                continue
            stapel.append((kennung, eintrag["iri"], m["zeit"], float(m["wert"]),
                           m.get("einheit") or eintrag["einheit"], m.get("status", "ok")))
        except (KeyError, TypeError, ValueError) as fehler:
            raise ValueError(f"unvollständiger Messwert: {fehler}") from fehler
    if not stapel:
        return 0
    with _lock, verbindung() as con:
        con.executemany(
            "INSERT OR REPLACE INTO messwert (sensor, iri, zeit, wert, einheit, status)"
            " VALUES (?, ?, ?, ?, ?, ?)", stapel)
    return len(stapel)


def aus_zeilen(text: str):
    """JSON Lines oder eine JSON-Liste — der Generator gibt Ersteres aus."""
    angefangen = text.lstrip()
    if angefangen.startswith("["):
        daten = json.loads(angefangen)
        if not isinstance(daten, list):
            raise ValueError("erwartet wird eine Liste von Messwerten")
        return daten
    return [json.loads(z) for z in text.splitlines() if z.strip()]


# ── Abfragen ────────────────────────────────────────────────────────────────

def stand() -> list[dict]:
    """
    Je Sensor der jüngste Wert, angereichert um das Register.

    `MAX(zeit)` mit sonst nackten Spalten ist in SQLite kein Zufall: bei genau
    einem `MAX()` oder `MIN()` je Gruppe stammen die übrigen Spalten
    garantiert aus genau der Zeile, die das Maximum trägt. Das erspart den
    Selbstverbund über (sensor, zeit) und ist bei 185.000 Zeilen der
    Unterschied zwischen Millisekunden und einer spürbaren Pause.
    """
    init()
    with verbindung() as con:
        zeilen = con.execute(
            "SELECT sensor, iri, MAX(zeit) AS zeit, wert, einheit, status"
            " FROM messwert GROUP BY sensor").fetchall()
    gemessen = {z["sensor"]: z for z in zeilen}
    ergebnis = []
    for s in register():
        z = gemessen.get(s["sensor_id"])
        ergebnis.append(_mit_messwert(s, z))
    return ergebnis


def am_bauteil(anker_iri: str) -> list[dict]:
    """
    Alle Sensoren an einem Bauteil, je mit letztem Wert.

    Der eigentliche Zweck der Ablage: das Frontend kennt beim Klick die
    GlobalId, rechnet daraus die IRI und fragt damit an. Ein Bauteil ohne
    Sensoren ist der Normalfall und liefert eine leere Liste — kein Fehler.
    """
    init()
    passend = [s for s in alle_sensoren() if s["anker_iri"] == anker_iri]
    if not passend:
        return []
    kennungen = [s["sensor_id"] for s in passend]
    platzhalter = ",".join("?" * len(kennungen))
    with verbindung() as con:
        zeilen = con.execute(
            "SELECT sensor, iri, MAX(zeit) AS zeit, wert, einheit, status"
            f" FROM messwert WHERE sensor IN ({platzhalter}) GROUP BY sensor",
            kennungen).fetchall()
    gemessen = {z["sensor"]: z for z in zeilen}
    return [_mit_messwert(s, gemessen.get(s["sensor_id"])) for s in passend]


def verlauf(sensor_iri: str, von: str | None = None, bis: str | None = None,
            hoechstens: int | None = None) -> list[dict]:
    """
    Die Zeitreihe eines Sensors, aufsteigend nach Zeit.

    Ohne Fenster die letzten 24 Stunden **vor dem jüngsten vorhandenen Wert**,
    nicht vor der Uhrzeit: ein Rückblick endet an der letzten Mitternacht, und
    ein Fenster relativ zu „jetzt" wäre bei Demodaten regelmäßig leer.

    `hoechstens` dünnt aus, indem es Werte überspringt — es mittelt nicht.
    Ein Mittelwert verschluckt genau die Ausreißer, die später den Alarm
    auslösen sollen.
    """
    init()
    if von is None or bis is None:
        with verbindung() as con:
            grenze = con.execute("SELECT MAX(zeit) AS bis FROM messwert WHERE iri = ?",
                                 (sensor_iri,)).fetchone()
        if grenze is None or grenze["bis"] is None:
            return []
        bis = bis or grenze["bis"]
        von = von or _minus_stunden(bis, 24)

    bedingung = "iri = ? AND zeit >= ? AND zeit <= ?"
    werte = [sensor_iri, von, bis]

    with verbindung() as con:
        if not hoechstens or hoechstens <= 0:
            zeilen = con.execute(
                f"SELECT zeit, wert, status FROM messwert WHERE {bedingung} ORDER BY zeit",
                werte).fetchall()
        else:
            gesamt = con.execute(
                f"SELECT COUNT(*) AS n FROM messwert WHERE {bedingung}", werte).fetchone()["n"]
            if gesamt <= hoechstens:
                zeilen = con.execute(
                    f"SELECT zeit, wert, status FROM messwert WHERE {bedingung} ORDER BY zeit",
                    werte).fetchall()
            else:
                # Schrittweite so, dass erster und letzter Wert sicher dabei
                # sind und die Antwort trotzdem nie mehr als `hoechstens` Zeilen
                # trägt — siehe Herleitung im Prüfstein.
                if hoechstens == 1:
                    # Erster *und* letzter Wert gehen bei einem einzigen nicht;
                    # dann zählt der jüngste, denn der ist der aktuelle Stand.
                    zeilen = con.execute(
                        f"SELECT zeit, wert, status FROM messwert WHERE {bedingung}"
                        " ORDER BY zeit DESC LIMIT 1", werte).fetchall()
                    return [{"zeit": z["zeit"], "wert": z["wert"], "status": z["status"]}
                            for z in zeilen]
                schritt = max(1, math.ceil((gesamt - 1) / (hoechstens - 1)))
                zeilen = con.execute(
                    "SELECT zeit, wert, status FROM ("
                    "  SELECT zeit, wert, status,"
                    "         ROW_NUMBER() OVER (ORDER BY zeit) AS rn"
                    f"  FROM messwert WHERE {bedingung}"
                    ") WHERE (rn - 1) % ? = 0 OR rn = ? ORDER BY zeit",
                    werte + [schritt, gesamt]).fetchall()
    return [{"zeit": z["zeit"], "wert": z["wert"], "status": z["status"]} for z in zeilen]


# ── Räume: Stand, Schnitt zu einer Zeit, Matrix zum Abspielen ───────────────

# Ein Raumwert gilt als „alt", wenn er älter ist als so viele Meldeintervalle.
ALT_NACH_INTERVALLEN = 3


def _raeume_gruppiert() -> dict[str, dict]:
    """Die Räume des Registers mit ihren Sensoren je Messgröße."""
    raeume: dict[str, dict] = {}
    for s in raum_register():
        r = raeume.setdefault(s["anker_guid"], {
            "global_id": s["anker_guid"], "iri": s["anker_iri"], "name": s["raum_name"],
            "bezeichnung": s["raum_bezeichnung"], "storey": s["zone"], "profil": s["profil"],
            "flaeche_m2": s["flaeche_m2"], "sensoren": {},
        })
        r["sensoren"][s["messgroesse"]] = s
    return raeume


def raeume_stand(zeit: str | None = None, kompakt: bool = False) -> dict:
    """
    Alle Räume mit dem jüngsten Wert je Messgröße — oder dem Wert **zu einer Zeit**.

    Ohne `zeit` gilt der jüngste Wert überhaupt; mit `zeit` der jüngste bis
    einschließlich dieser Zeit. So zeigt die Anzeige beim Zurückspulen den
    Zustand von damals, aus derselben Ablage und derselben Abfrage.

    `alt` ist wahr, wenn der Wert älter ist als drei Meldeintervalle gegenüber
    der Bezugszeit — ein Sensor, der schweigt, soll nicht wie ein gemessener
    Wert aussehen.
    """
    init()
    gruppiert = _raeume_gruppiert()
    if not gruppiert:
        return {"zeit": None, "modell": None, "raeume": []}
    with verbindung() as con:
        if zeit is None:
            zeit = con.execute("SELECT MAX(zeit) AS z FROM messwert WHERE sensor LIKE 'R-%'").fetchone()["z"]
        if zeit is None:
            bezug, zeilen = None, []
        else:
            bezug = zeit
            fenster = _minus_stunden(zeit, 2)
            zeilen = con.execute(
                "SELECT sensor, MAX(zeit) AS zeit, wert, status FROM messwert"
                " WHERE sensor LIKE 'R-%' AND zeit <= ? AND zeit >= ? GROUP BY sensor",
                (zeit, fenster)).fetchall()
    gemessen = {z["sensor"]: z for z in zeilen}
    ergebnis = []
    for r in gruppiert.values():
        werte = {}
        for groesse, s in r["sensoren"].items():
            z = gemessen.get(s["sensor_id"])
            if kompakt:
                # Für Anzeigen, die nur färben: kein Register, nur Wert, Zeit und Alter.
                werte[groesse] = {
                    "wert": z["wert"] if z else None, "zeit": z["zeit"] if z else None,
                    "alt": bool(z) is False or _alter_s(bezug, z["zeit"]) > ALT_NACH_INTERVALLEN * s["intervall_s"],
                    "einheit": s["einheit"],
                }
                continue
            werte[groesse] = {
                "sensor": s["sensor_id"], "iri": s["iri"], "einheit": s["einheit"],
                "wert": z["wert"] if z else None, "zeit": z["zeit"] if z else None,
                "status": z["status"] if z else "ohne",
                "alt": bool(z) is False or _alter_s(bezug, z["zeit"]) > ALT_NACH_INTERVALLEN * s["intervall_s"],
                "brick": s["brick_klasse"], "bereich": [s["bereich_min"], s["bereich_max"]],
            }
        if kompakt:
            ergebnis.append({"global_id": r["global_id"], "werte": werte})
        else:
            ergebnis.append({k: v for k, v in r.items() if k != "sensoren"} | {"werte": werte})
    return {"zeit": bezug, "modell": _raum_modell(), "raeume": ergebnis}


def _raum_modell() -> dict | None:
    """Das Modell, dessen IfcSpace die Raumsensoren tragen (Sidecar des Registers)."""
    pfad = REGISTER_PFAD / "sensoren_raeume.meta.json"
    try:
        return json.loads(pfad.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def raeume_matrix(groesse: str, von: str | None = None, bis: str | None = None,
                  schritt_min: int = 15, stunden: int = 48) -> dict:
    """
    Eine Messgröße aller Räume über ein Zeitfenster, auf ein gröberes Raster gebracht.

    Das ist die Grundlage des Abspielens: statt je Bild 500 Räume abzufragen,
    lädt die Oberfläche **einmal** die ganze Matrix (rund 100 000 Zahlen für
    48 Stunden Temperatur) und spielt sie lokal ab. Je Rasterschritt gilt der
    letzte Wert darin; für `praesenz` der größte, sonst verschwänden kurze
    Anwesenheiten zwischen zwei Rasterpunkten.
    """
    from datetime import datetime, timedelta, timezone
    init()
    sensoren = {s["sensor_id"]: s for s in raum_register() if s["messgroesse"] == groesse}
    if not sensoren:
        return {"groesse": groesse, "zeiten": [], "raeume": {}}
    schritt_min = max(5, int(schritt_min))
    with verbindung() as con:
        if bis is None:
            bis = con.execute("SELECT MAX(zeit) AS z FROM messwert WHERE sensor LIKE 'R-%'").fetchone()["z"]
        if bis is None:
            return {"groesse": groesse, "zeiten": [], "raeume": {}}
        von = von or _minus_stunden(bis, stunden)
        zeilen = con.execute(
            "SELECT sensor, zeit, wert FROM messwert WHERE sensor LIKE 'R-%' AND zeit >= ? AND zeit <= ?"
            " ORDER BY zeit", (von, bis)).fetchall()
    t0 = datetime.strptime(von, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    t1 = datetime.strptime(bis, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    # Das Raster liegt auf ganzen Schritten (…:00, …:30), nicht auf der Sekunde, in der die Abfrage zufällig beginnt:
    # sonst stünde ein Frühstück um 8:07 im Regler, und zwei Abfragen ließen sich nicht übereinanderlegen.
    ts = int(t0.timestamp())
    t0 = datetime.fromtimestamp(ts - ts % (schritt_min * 60), tz=timezone.utc)
    schritt = timedelta(minutes=schritt_min)
    n = int((t1 - t0) / schritt) + 1
    zeiten = [(t0 + i * schritt).strftime("%Y-%m-%dT%H:%M:%SZ") for i in range(n)]
    werte: dict[str, list] = {}
    nehmen_max = groesse == "praesenz"
    for z in zeilen:
        s = sensoren.get(z["sensor"])
        if s is None:
            continue
        t = datetime.strptime(z["zeit"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        i = min(n - 1, int((t - t0) / schritt))
        reihe = werte.setdefault(s["anker_guid"], [None] * n)
        alt = reihe[i]
        reihe[i] = z["wert"] if (alt is None or not nehmen_max) else max(alt, z["wert"])
    return {"groesse": groesse, "einheit": next(iter(sensoren.values()))["einheit"],
            "schritt_min": schritt_min, "zeiten": zeiten, "raeume": werte}


def zahlen() -> dict:
    """Überblick für die Oberfläche und zur Fehlersuche."""
    init()
    with verbindung() as con:
        z = con.execute("SELECT COUNT(*) AS werte, COUNT(DISTINCT sensor) AS sensoren,"
                        " MIN(zeit) AS von, MAX(zeit) AS bis FROM messwert").fetchone()
    return {"werte": z["werte"], "sensoren": z["sensoren"],
            "von": z["von"], "bis": z["bis"], "register": len(register()),
            "raumregister": len(raum_register()),
            "abgewiesen": _abgewiesen}


# ── Kleinkram ───────────────────────────────────────────────────────────────

def _mit_messwert(eintrag: dict, zeile) -> dict:
    """Registereintrag plus letzter Messwert; ohne Messung bleiben die Felder leer."""
    ergebnis = dict(eintrag)
    ergebnis.update({
        "wert": zeile["wert"] if zeile else None,
        "zeit": zeile["zeit"] if zeile else None,
        "status": zeile["status"] if zeile else "ohne",
    })
    return ergebnis


def _alter_s(bezug: str | None, zeit: str | None) -> float:
    from datetime import datetime
    if not bezug or not zeit:
        return float("inf")
    f = "%Y-%m-%dT%H:%M:%SZ"
    return (datetime.strptime(bezug, f) - datetime.strptime(zeit, f)).total_seconds()


def _minus_stunden(zeit: str, stunden: int) -> str:
    from datetime import datetime, timedelta, timezone
    t = datetime.strptime(zeit, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (t - timedelta(hours=stunden)).strftime("%Y-%m-%dT%H:%M:%SZ")
