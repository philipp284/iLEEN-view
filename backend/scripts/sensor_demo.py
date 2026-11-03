"""
Erzeugt künstliche, aber plausible Sensordaten für das Campusmodell.

Es gibt am Campus keine Sensoren und es gibt im Modell keine Räume — beides ist
nachgesehen, nicht vermutet: `GET /assets/<job>/rooms` liefert `[]`, und in der
Property-Datenbank des Jobs steht kein einziger `IfcSpace`. Ohne Messwerte lässt
sich die Zustandsanzeige im Viewer aber nicht erproben, und ohne echte GlobalId
träfe der Join über die IRI ins Leere.

Deshalb hängt hier jeder Sensor an einer **Zone**, und jede Zone an einem real
vorhandenen Ankerbauteil, dessen GlobalId in der Batch Table jedes B3DM steht
und damit im Viewer anklickbar ist. Bringt ein Modell später echte `IfcSpace`
mit, tritt deren GlobalId an die Stelle des Ankers; an Format und Rechenregel
ändert sich dabei nichts.

Die beiden Rechenregeln für die IRI — der einzige Join-Key — stehen in
`_iri_bauteil()` und `_iri_sensor()`. Die erste ist dieselbe, die der
gaeco-Export benutzt; nur so treffen Messwert und Graphknoten denselben
Schlüssel.

Der Zufall ist an Seed und Kennung gebunden, nicht an einen Generatorzustand
(`_gleich()`): zwei Läufe mit gleichem Seed liefern damit Byte für Byte
dieselbe Ausgabe, auch wenn sich die Reihenfolge der Sensoren einmal ändert.

    python3 scripts/sensor_demo.py --verlauf 7d --schritt 60 --seed 42
    python3 scripts/sensor_demo.py --live               # Echtzeit
    python3 scripts/sensor_demo.py --live --raffer 60   # ein Tag in 24 Minuten

Das Register liegt daneben in `data/zonen.csv` und `data/sensoren.csv`.
"""

import argparse
import csv
import hashlib
import json
import math
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── Festlegungen ────────────────────────────────────────────────────────────

# Der Namensraum steht hier und nirgends sonst: ob er mit dem Basis-Namensraum
# verträglich ist, den gaecos InstanceService vergibt, ist erst am laufenden
# Stack prüfbar. Ein Wechsel soll eine Zeile bleiben.
IRI_NAMENSRAUM_SENSOR = "https://ileen.hs-mainz.de/sensor/"

STANDORT_BREITE = 49.99   # Mainz, Grad Nord
STANDORT_LAENGE = 8.24    # Grad Ost
SOLARKONSTANTE = 1000.0   # W/m² bei senkrechtem Einfall, klarer Himmel

PV_KWP = 120.0            # Anlagengröße
PV_TEMPERATURBEIWERT = 0.004   # je Kelvin über 25 °C
PV_BEZUGSTEMPERATUR = 25.0

ZAEHLER_STARTWERT = 1_250_000.0   # kWh, frei gewählt

# Grundlast je Zone in kW
GRUNDLAST = {"Z-UG": 12.0, "Z-EG": 9.0, "Z-OG1": 8.0,
             "Z-OG2": 7.0, "Z-OG3": 6.0, "Z-DACH": 2.0}

# Zuschlag auf die Raumtemperatur je Zone
ZONENVERSATZ = {"Z-UG": -2.0, "Z-DACH": 1.5}

# Das Wetter ist eine Eigenschaft der Zeit, nicht des Abtastrasters: der
# Wolkengang wird immer auf diesem Raster gerechnet, unabhängig von --schritt.
WETTERRASTER_S = 60

# Die drei absichtlichen Störungen
STOER_EINFRIEREN = "TMP-OG2-N"     # liefert ab Tag 4, 09:00 denselben Wert
STOER_LUECKE = "PWR-OG3"           # täglich 02:00–02:20 UTC keine Zeile
STOER_AUSREISSER = "TMP-UG-N"      # etwa jede 200. Messung außerhalb des Bereichs
EINFRIERPUNKT = timedelta(days=3, hours=9)
LUECKE_VON_H, LUECKE_BIS_MIN = 2, 20
AUSREISSER_TAKT, AUSREISSER_VERSATZ = 200, 137

DATEN = Path(__file__).resolve().parent.parent / "data"


# ── Zufall, der sich nicht merken muss, wo er stand ─────────────────────────

def _gleich(seed, *teile):
    """Gleichverteilt in [0,1), allein aus Seed und Kennung."""
    roh = hashlib.sha256("|".join([str(seed)] + [str(t) for t in teile]).encode()).digest()
    return int.from_bytes(roh[:8], "big") / 2.0 ** 64


def _normal(seed, *teile):
    """Standardnormalverteilt, Box-Muller aus zwei gleichverteilten Werten."""
    u1 = max(_gleich(seed, "n1", *teile), 1e-12)
    u2 = _gleich(seed, "n2", *teile)
    return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


# ── Die IRI: der einzige Join-Key ───────────────────────────────────────────

def _iri_bauteil(global_id):
    """Dieselbe Regel, die der gaeco-Export benutzt."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, global_id))


def _iri_sensor(sensor_id):
    """Sensoren sind keine IFC-Objekte und brauchen deshalb eine eigene Regel."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, IRI_NAMENSRAUM_SENSOR + sensor_id))


# ── Register ────────────────────────────────────────────────────────────────

def lies_register(raeume=False, nur_raeume=False):
    """Liest zonen.csv und sensoren.csv; die Reihenfolge der Datei ist die Reihenfolge der Ausgabe.

    Mit `raeume` kommen die Raumsensoren aus `sensoren_raeume.csv` dazu (siehe
    `raumklima.py`), mit `nur_raeume` bleiben allein diese übrig.
    """
    with open(DATEN / "zonen.csv", encoding="utf-8", newline="") as f:
        zonen = {z["zone_id"]: z for z in csv.DictReader(f)}
    with open(DATEN / "sensoren.csv", encoding="utf-8", newline="") as f:
        sensoren = list(csv.DictReader(f))
    if nur_raeume:
        sensoren = []
    for s in sensoren:
        s["intervall_s"] = int(s["intervall_s"])
        s["bereich_min"] = float(s["bereich_min"])
        s["bereich_max"] = float(s["bereich_max"])
        s["iri"] = _iri_sensor(s["sensor_id"])
        s["anker_iri"] = _iri_bauteil(s["anker_guid"])
        if s["zone_id"] not in zonen:
            raise SystemExit(f"Sensor {s['sensor_id']}: Zone {s['zone_id']} steht nicht in zonen.csv")
        if s["anker_guid"] != zonen[s["zone_id"]]["anker_guid"]:
            raise SystemExit(f"Sensor {s['sensor_id']}: Anker weicht von der Zone ab")
    if raeume or nur_raeume:
        sensoren += _raumsensoren()
    return zonen, sensoren


def _raumsensoren():
    """Die Raumsensoren in derselben Gestalt wie die Zonensensoren (Anker = IfcSpace)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import raumklima
    if not raumklima.REGISTER.exists():
        raise SystemExit(f"{raumklima.REGISTER} fehlt — erst `python3 scripts/raumklima_register.py` laufen lassen")
    ergebnis = []
    for r in raumklima.register_lesen():
        r["intervall_s"] = int(r["intervall_s"])
        r["bereich_min"] = float(r["bereich_min"])
        r["bereich_max"] = float(r["bereich_max"])
        r["zone_id"] = r["storey"]
        r["anker_guid"] = r["raum_guid"]
        r["iri"] = _iri_sensor(r["sensor_id"])
        r["anker_iri"] = _iri_bauteil(r["raum_guid"])
        ergebnis.append(r)
    return ergebnis


# ── Tagesgänge ──────────────────────────────────────────────────────────────

def _sinus_sonnenhoehe(zeit):
    """Sinus der Sonnenhöhe über Mainz; negativ heißt Nacht."""
    tag = zeit.timetuple().tm_yday
    stunde = zeit.hour + zeit.minute / 60.0 + zeit.second / 3600.0
    dekl = math.radians(23.44) * math.sin(2.0 * math.pi * (tag - 81) / 365.0)
    # Sonnenmittag liegt um die geografische Länge vor 12:00 UTC.
    stundenwinkel = math.radians(15.0 * (stunde - 12.0) + STANDORT_LAENGE)
    breite = math.radians(STANDORT_BREITE)
    return (math.sin(breite) * math.sin(dekl)
            + math.cos(breite) * math.cos(dekl) * math.cos(stundenwinkel))


def _tagesform(stunde, bei_min=5.0, bei_max=15.0):
    """−1 zur Stunde des Minimums, +1 zur Stunde des Maximums, stückweise Kosinus.

    Ein reiner Sinus kann Minimum 05:00 und Maximum 15:00 nicht zugleich
    treffen — zwischen beiden liegen zehn Stunden, nicht zwölf.
    """
    h = stunde % 24.0
    if bei_min <= h < bei_max:
        return -math.cos(math.pi * (h - bei_min) / (bei_max - bei_min))
    laenge = 24.0 - (bei_max - bei_min)
    return math.cos(math.pi * (((h - bei_max) % 24.0) / laenge))


class Wetter:
    """Wolkengang als gedämpfter Random Walk auf festem Raster.

    Gedämpft, damit es nach Wetter aussieht und nicht nach Rauschen: der Walk
    kehrt zum Mittel 0,7 zurück, statt frei zu laufen.
    """

    RUECKKEHR, STOSS, MITTEL = 0.02, 0.03, 0.7

    def __init__(self, seed, start):
        self.seed, self.start, self._werte = seed, start, {}
        self._stand, self._bis = self.MITTEL, start

    def wolkenfaktor(self, zeit):
        gitter = self._gitterpunkt(zeit)
        while self._bis <= gitter:
            r = _normal(self.seed, "wolken", int(self._bis.timestamp()))
            self._stand += self.RUECKKEHR * (self.MITTEL - self._stand) + self.STOSS * r
            self._stand = min(1.0, max(0.2, self._stand))
            self._werte[self._bis] = self._stand
            self._bis += timedelta(seconds=WETTERRASTER_S)
        return self._werte.get(gitter, self.MITTEL)

    def _gitterpunkt(self, zeit):
        versatz = int((zeit - self.start).total_seconds())
        return self.start + timedelta(seconds=(versatz // WETTERRASTER_S) * WETTERRASTER_S)

    def globalstrahlung(self, zeit):
        hoehe = _sinus_sonnenhoehe(zeit)
        if hoehe <= 0.0:
            return 0.0
        return SOLARKONSTANTE * hoehe * self.wolkenfaktor(zeit)

    def aussentemperatur(self, zeit):
        tag = zeit.timetuple().tm_yday
        stunde = zeit.hour + zeit.minute / 60.0 + zeit.second / 3600.0
        jahr = 10.5 - 9.0 * math.cos(2.0 * math.pi * (tag - 15) / 365.0)
        return jahr + 5.0 * _tagesform(stunde) + 0.3 * _normal(self.seed, "ta", int(zeit.timestamp()))

    def modultemperatur(self, zeit):
        return self.aussentemperatur(zeit) + 0.03 * self.globalstrahlung(zeit)

    def pv_leistung(self, zeit):
        ghi = self.globalstrahlung(zeit)
        if ghi <= 0.0:
            return 0.0
        verlust = 1.0 - PV_TEMPERATURBEIWERT * (self.modultemperatur(zeit) - PV_BEZUGSTEMPERATUR)
        return max(0.0, PV_KWP * ghi / 1000.0 * verlust)

    def raumtemperatur(self, zeit, sensor):
        stunde = zeit.hour + zeit.minute / 60.0
        soll = 18.0 if (stunde >= 20.0 or stunde < 6.0) else 21.0
        wert = soll + ZONENVERSATZ.get(sensor["zone_id"], 0.0)
        if sensor["sensor_id"].endswith("-S"):
            # Südseite heizt sich mit der Sonne auf, Nordseite nicht.
            wert += 3.0 * min(1.0, self.globalstrahlung(zeit) / 800.0)
        return wert + 0.4 * _normal(self.seed, "rt", sensor["sensor_id"], int(zeit.timestamp()))

    def wirkleistung(self, zeit, zone_id):
        grund = GRUNDLAST[zone_id]
        werktag = zeit.weekday() < 5
        faktor = 2.5 if (werktag and 7 <= zeit.hour < 19) else 1.0
        rauschen = 1.0 + 0.08 * _normal(self.seed, "pwr", zone_id, int(zeit.timestamp()))
        return max(0.0, grund * faktor * rauschen)


# ── Der Lauf ────────────────────────────────────────────────────────────────

class Lauf:
    """Hält, was sich über die Zeit aufsummiert: Zählerstand und Tagesertrag."""

    def __init__(self, seed, start):
        self.wetter = Wetter(seed, start)
        self.seed = seed
        self.start = start
        self.zaehler = ZAEHLER_STARTWERT
        self.pv_tagesertrag = 0.0
        self._tag = start.date()
        self._bis = start
        self._eingefroren = None
        self.raummodell = None

    def raeume_vorbereiten(self, sensoren):
        """Das Raummodell entsteht erst, wenn Raumsensoren im Spiel sind."""
        raumzeilen = [s for s in sensoren if s.get("raum_guid")]
        if raumzeilen:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import raumklima
            self.raummodell = raumklima.RaumModell(self.seed, self.wetter, raumzeilen)

    def bis(self, zeit):
        """Integriert Zählerstand und Tagesertrag bis zum Zeitpunkt vor.

        Der Bezugszähler zählt `max(0, Verbrauch − Erzeugung)`: am Wochenende
        liegt die PV-Leistung über der Grundlast, und ein Bezugszähler läuft
        nicht rückwärts — die Einspeisung gehört auf einen zweiten Zähler.
        """
        schritt = timedelta(seconds=WETTERRASTER_S)
        while self._bis < zeit:
            if self._bis.date() != self._tag:
                self._tag, self.pv_tagesertrag = self._bis.date(), 0.0
            pv = self.wetter.pv_leistung(self._bis)
            verbrauch = sum(self.wetter.wirkleistung(self._bis, z) for z in GRUNDLAST)
            stunden = WETTERRASTER_S / 3600.0
            self.zaehler += max(0.0, verbrauch - pv) * stunden
            self.pv_tagesertrag += pv * stunden
            self._bis += schritt
        if self._bis.date() != self._tag:
            self._tag, self.pv_tagesertrag = self._bis.date(), 0.0

    def messung(self, zeit, sensor):
        """Einen Messwert als (wert, status) — oder None, wenn keine Zeile entsteht."""
        kennung, groesse = sensor["sensor_id"], sensor["messgroesse"]

        if sensor.get("raum_guid"):
            return self.raummodell.messung(zeit, sensor)

        # Störung 1: der Sensor fällt zeitweise ganz aus.
        if kennung == STOER_LUECKE and zeit.hour == LUECKE_VON_H and zeit.minute < LUECKE_BIS_MIN:
            return None

        # Störung 2: der Sensor friert ein und wiederholt seinen letzten Wert.
        if kennung == STOER_EINFRIEREN and zeit >= self.start + EINFRIERPUNKT:
            if self._eingefroren is None:
                self._eingefroren = round(self.wetter.raumtemperatur(self.start + EINFRIERPUNKT, sensor), 2)
            return self._eingefroren, "veraltet"

        # Störung 3: einzelne Messungen liegen außerhalb des Messbereichs.
        if kennung == STOER_AUSREISSER:
            n = int((zeit - self.start).total_seconds()) // sensor["intervall_s"]
            if n % AUSREISSER_TAKT == AUSREISSER_VERSATZ:
                hoch = (n // AUSREISSER_TAKT) % 2 == 0
                return (sensor["bereich_max"] + 55.0 if hoch else sensor["bereich_min"] - 55.0), "ausreisser"

        if groesse == "raumtemperatur":
            return round(self.wetter.raumtemperatur(zeit, sensor), 2), "ok"
        if groesse == "wirkleistung":
            return round(self.wetter.wirkleistung(zeit, sensor["zone_id"]), 2), "ok"
        if groesse == "arbeit":
            return round(self.zaehler, 2), "ok"
        if groesse == "pv_leistung":
            return round(self.wetter.pv_leistung(zeit), 2), "ok"
        if groesse == "pv_ertrag_tag":
            return round(self.pv_tagesertrag, 2), "ok"
        if groesse == "modultemperatur":
            return round(self.wetter.modultemperatur(zeit), 2), "ok"
        if groesse == "globalstrahlung":
            return round(self.wetter.globalstrahlung(zeit), 1), "ok"
        if groesse == "aussentemperatur":
            return round(self.wetter.aussentemperatur(zeit), 2), "ok"
        raise SystemExit(f"Unbekannte Messgröße {groesse!r} bei {kennung}")


def _zeile(sensor, zeit, wert, status):
    return json.dumps({
        "sensor": sensor["sensor_id"],
        "iri": sensor["iri"],
        "zone": sensor["zone_id"],
        "anker": sensor["anker_guid"],
        "zeit": zeit.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "wert": wert,
        "einheit": sensor["einheit"],
        "status": status,
    }, ensure_ascii=False)


def _faellig(sensor, zeit, start):
    return int((zeit - start).total_seconds()) % sensor["intervall_s"] == 0


def rueckblick(sensoren, start, ende, schritt, seed, schreibe):
    lauf = Lauf(seed, start)
    lauf.raeume_vorbereiten(sensoren)
    zeit = start
    while zeit < ende:
        lauf.bis(zeit)
        for s in sensoren:
            if not _faellig(s, zeit, start):
                continue
            ergebnis = lauf.messung(zeit, s)
            if ergebnis is not None:
                schreibe(_zeile(s, zeit, ergebnis[0], ergebnis[1]))
        zeit += timedelta(seconds=schritt)


def echtzeit(sensoren, start, schritt, raffer, seed, schreibe, abschicken=None,
             uhr=time.monotonic, schlafen=time.sleep):
    """Modellzeit läuft um den Raffer schneller als die Uhr.

    `uhr` und `schlafen` sind nur für den Prüfstein austauschbar: mit einer
    gestellten Uhr lässt sich das Zeitverhalten prüfen, ohne Sekunden zu warten.
    """
    lauf = Lauf(seed, start)
    lauf.raeume_vorbereiten(sensoren)
    zeit, angefangen = start, uhr()
    while True:
        lauf.bis(zeit)
        for s in sensoren:
            if not _faellig(s, zeit, start):
                continue
            ergebnis = lauf.messung(zeit, s)
            if ergebnis is not None:
                schreibe(_zeile(s, zeit, ergebnis[0], ergebnis[1]))
        sys.stdout.flush()
        if abschicken is not None:
            abschicken()
        zeit += timedelta(seconds=schritt)
        # Schlafen, bis der nächste Zeitpunkt wirklich fällig ist — in Häppchen
        # von höchstens einer Sekunde, damit Strg-C reaktiv bleibt. Früher stand
        # hier ein einzelner, gedeckelter Schlaf: danach ging es sofort weiter,
        # und bei `--schritt 60` lief die Modellzeit mit einer Minute je Sekunde,
        # gleich welcher Raffer. `--raffer 1` war damit kein Echtzeitbetrieb,
        # sondern `--raffer 60` unter anderem Namen — und die Zeitreihe füllte
        # sich mit Werten aus der Zukunft.
        while True:
            faellig_in = (zeit - start).total_seconds() / raffer - (uhr() - angefangen)
            if faellig_in <= 0:
                break
            schlafen(min(faellig_in, 1.0))


def _kafka_ausgang(broker):
    """Sammelt Zeilen und schickt sie als Stapel ins Topic.

    `sensor_kafka` liegt im Paket `ileen`, das dieses Skript sonst nicht
    braucht — deshalb wird der Pfad hier gesetzt und nicht oben importiert:
    ohne `--kafka` soll der Generator ohne `aiokafka` laufen.
    """
    import asyncio
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from ileen import sensor_kafka

    puffer = []

    def sammeln(zeile):
        puffer.append(zeile)
        # Im Echtzeitbetrieb soll nicht erst am Ende etwas ankommen.
        if len(puffer) >= 500:
            abschicken()

    def abschicken():
        if not puffer:
            return
        anzahl = asyncio.run(sensor_kafka.senden(list(puffer), broker=broker))
        print(f"{anzahl} Messwerte nach {sensor_kafka.TOPIC} bei {broker}", file=sys.stderr)
        puffer.clear()

    return sammeln, abschicken


def _post_ausgang(basis):
    """Sammelt Zeilen und schickt sie als JSON Lines an `POST <basis>/sensoren/messwerte`.

    Ohne Kafka und ohne Zwischendatei: der kürzeste Weg vom Generator in die
    Zeitreihe. Das Einspeisen ist idempotent, ein Abbruch also folgenlos.
    """
    import urllib.error
    import urllib.request
    url = basis.rstrip("/") + "/sensoren/messwerte"
    puffer, summe = [], [0]

    def abschicken():
        if not puffer:
            return
        anfrage = urllib.request.Request(url, data="\n".join(puffer).encode("utf-8"),
                                         headers={"Content-Type": "application/x-ndjson"})
        try:
            with urllib.request.urlopen(anfrage, timeout=300) as antwort:
                summe[0] += json.loads(antwort.read()).get("uebernommen", 0)
        except (urllib.error.URLError, OSError) as fehler:
            # Das Backend wird neu gestartet oder ist kurz weg: die Zeilen bleiben im Puffer und gehen beim
            # nächsten Mal mit. Ein Dauerstrom, der beim ersten Aussetzer endet, wäre keiner.
            print(f"Backend nicht erreichbar ({fehler}) — {len(puffer)} Messwerte warten", file=sys.stderr)
            del puffer[:-200_000]
            return
        print(f"{summe[0]} Messwerte an {url}", file=sys.stderr)
        puffer.clear()

    def sammeln(zeile):
        puffer.append(zeile)
        if len(puffer) >= 20_000:
            abschicken()

    return sammeln, abschicken


def _verlauf(text):
    einheiten = {"d": 86400, "h": 3600, "w": 604800}
    if not text or text[-1] not in einheiten or not text[:-1].isdigit():
        raise argparse.ArgumentTypeError("Verlauf als Zahl mit d, h oder w, etwa 7d")
    return timedelta(seconds=int(text[:-1]) * einheiten[text[-1]])


def parser():
    """Der Kommandozeilen-Parser — eigene Funktion, damit der Prüfstein die
    Standardwerte liest, statt sie abzuschreiben."""
    p = argparse.ArgumentParser(description="Künstliche Sensordaten für das Campusmodell.")
    p.add_argument("--verlauf", type=_verlauf, default=_verlauf("7d"),
                   help="Zeitspanne rückblickend, etwa 7d (Standard), 12h, 2w")
    p.add_argument("--schritt", type=int, default=60, help="Raster in Sekunden (Standard 60)")
    p.add_argument("--seed", type=int, default=42, help="macht den Lauf reproduzierbar")
    p.add_argument("--live", action="store_true", help="fortlaufend statt rückblickend")
    # Standard ist Echtzeit: seit E8 ist der Live-Strom der Regelbetrieb und der
    # Zeitraffer die Vorführung. Mit 60 als Standard schrieb jeder Strom, der
    # ohne --raffer gestartet wurde, in die Zukunft — und der Viewer zeigte dann
    # den Wert aus der Zukunft statt des aktuellen.
    p.add_argument("--raffer", type=float, default=1.0,
                   help="Sekunden Modellzeit je Sekunde Uhrzeit (nur mit --live): "
                        "1 = Echtzeit (Standard), 60 = ein Tag in 24 Minuten")
    p.add_argument("--ende", default=None,
                   help="Ende des Rückblicks als ISO-Zeit; Standard ist die letzte Mitternacht UTC")
    p.add_argument("--raeume", action="store_true",
                   help="zusätzlich die Raumsensoren aus data/sensoren_raeume.csv (siehe raumklima.py)")
    p.add_argument("--nur-raeume", action="store_true", dest="nur_raeume",
                   help="allein die Raumsensoren, ohne die Geschoss- und Anlagensensoren")
    p.add_argument("--post", nargs="?", const="http://localhost:8100", default=None, metavar="URL",
                   help="statt nach stdout direkt an POST <URL>/sensoren/messwerte schicken")
    p.add_argument("--kafka", nargs="?", const="localhost:9092", default=None,
                   metavar="BROKER",
                   help="statt nach stdout ins Topic ileen.sensor.messwerte schreiben")
    return p


def main():
    a = parser().parse_args()

    if a.schritt <= 0:
        raise SystemExit("--schritt muss größer als null sein")

    _, sensoren = lies_register(a.raeume, a.nur_raeume)

    if a.post:
        schreibe, abschicken = _post_ausgang(a.post)
    elif a.kafka:
        # Der Umweg über eine Liste ist Absicht: der Rückblick soll in einem
        # Zug gesendet werden, nicht mit einem Verbindungsaufbau je Zeile.
        # Im Echtzeitbetrieb wird nach jedem fälligen Zeitpunkt abgeschickt.
        schreibe, abschicken = _kafka_ausgang(a.kafka)
    else:
        schreibe, abschicken = (lambda z: print(z)), (lambda: None)

    try:
        if a.live:
            # Auf das Raster gerundet, damit --faellig auch live greift.
            jetzt = datetime.now(timezone.utc).replace(microsecond=0)
            echtzeit(sensoren, jetzt, a.schritt, a.raffer, a.seed, schreibe, abschicken)
        else:
            # Der Rückblick endet an der letzten Mitternacht, nicht „jetzt": sonst
            # lieferten zwei Läufe kurz nacheinander verschiedene Zeitstempel und
            # die Reproduzierbarkeit wäre nicht prüfbar.
            if a.ende:
                ende = datetime.fromisoformat(a.ende.replace("Z", "+00:00")).astimezone(timezone.utc)
            else:
                ende = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            rueckblick(sensoren, ende - a.verlauf, ende, a.schritt, a.seed, schreibe)
        abschicken()
    except KeyboardInterrupt:
        abschicken()
        sys.stdout.flush()
    except BrokenPipeError:
        # Der Leser ist weg (etwa `| head`). Der Kanal wird umgehängt, damit
        # Python beim Beenden nicht noch einmal darauf schreibt und klagt.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(0)


if __name__ == "__main__":
    main()
