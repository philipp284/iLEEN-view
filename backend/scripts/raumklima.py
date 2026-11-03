"""
Raumklima: künstliche Sensoren je Raum — Register und Messmodell.

`sensor_demo.py` hängt seine Sensoren an Geschoss-Ankerbauteile, weil es im
Campusmodell lange keine Räume gab. Seit das Modell 511 `IfcSpace` trägt
(Job bf9da2a7, siehe projekte/2026_1017_hsm_campus), kann jeder Sensor an den
Raum, in dem er hängt. Der Join bleibt derselbe: `uuid5(DNS, GlobalId)` des
IfcSpace — damit trifft ein Messwert die gaeco-Instanz des Raums, den
Raumkörper im Viewer und den SPIDER-Knoten, ohne dass irgendwo eine
Zuordnungstabelle stünde.

Zwei Teile:

* `register_aus_raeumen()` liest die Raumliste des Backends
  (`GET /assets/<job>/rooms`) und schreibt `data/sensoren_raeume.csv`.
  Welche Sensoren ein Raum bekommt, entscheidet sein Profil (Büro, Seminar,
  Labor, Flur …), abgeleitet aus dem Raumnamen.
* `RaumModell.messung()` rechnet zu Sensor und Zeitpunkt einen plausiblen
  Wert: Belegung nach Tagesplan, CO₂ aus Belegung und Luftwechsel, Temperatur
  mit Nachtabsenkung, Sonne und Personenwärme, Feuchte aus Außenluft.

Alles ist zustandslos in Seed, Raum und Zeit: dieselbe Zeit liefert denselben
Wert, gleich in welcher Reihenfolge abgetastet wird. Deshalb gibt es keinen
Gang über die Zeit wie beim Zählerstand, und Rückblick und Echtzeit passen
nahtlos zueinander.

Die Stundenangaben sind **Ortszeit** (Europe/Berlin). Die Zeitstempel der
Messwerte bleiben UTC.
"""

from __future__ import annotations

import csv
import hashlib
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ORT = ZoneInfo("Europe/Berlin")
DATEN = Path(__file__).resolve().parent.parent / "data"
REGISTER = DATEN / "sensoren_raeume.csv"

SPALTEN = ["sensor_id", "raum_guid", "raum_name", "raum_bezeichnung", "storey", "profil",
           "messgroesse", "einheit", "intervall_s", "brick_klasse", "bereich_min",
           "bereich_max", "flaeche_m2", "volumen_m3", "einbau", "hersteller", "modell"]

INTERVALL_S = 300          # Raumsensoren melden alle fünf Minuten
SCHLITZ_S = 300            # Raster der Belegung

# Messgrößen: Kurzzeichen für die Sensorkennung, Einheit, Brick-Klasse, Bereich
GROESSEN = {
    "raumtemperatur": ("T",   "°C",  "brick:Air_Temperature_Sensor",         5.0, 40.0),
    "co2":            ("CO2", "ppm", "brick:CO2_Level_Sensor",             350.0, 5000.0),
    "luftfeuchte":    ("RF",  "%",   "brick:Relative_Humidity_Sensor",       0.0, 100.0),
    "praesenz":       ("PRS", "",    "brick:Occupancy_Sensor",               0.0, 1.0),
}
HERSTELLER = {"raumtemperatur": ("Messwerk", "RT-100"), "co2": ("Luftgüte GmbH", "CO2-M5"),
              "luftfeuchte": ("Messwerk", "RF-20"), "praesenz": ("Raumsinn", "PIR-2")}

# Profil → (Soll tags, Soll nachts, Messgrößen, m² je Person, Luftwechsel besetzt /h)
PROFILE = {
    "lehre":        (21.0, 17.0, ("raumtemperatur", "co2", "luftfeuchte", "praesenz"), 2.0, 3.0),
    "buero":        (21.0, 17.0, ("raumtemperatur", "co2", "praesenz"), 12.0, 1.0),
    "arbeitsplatz": (21.0, 17.0, ("raumtemperatur", "co2", "praesenz"), 3.0, 2.0),
    "labor":        (20.0, 17.0, ("raumtemperatur", "co2", "luftfeuchte", "praesenz"), 15.0, 4.0),
    "verkehr":      (19.0, 16.0, ("raumtemperatur", "praesenz"), 25.0, 1.0),
    "sanitaer":     (20.0, 16.0, ("raumtemperatur", "luftfeuchte", "praesenz"), 8.0, 4.0),
    "teekueche":    (21.0, 17.0, ("raumtemperatur", "praesenz"), 8.0, 2.0),
    "technik":      (16.0, 14.0, ("raumtemperatur",), 50.0, 1.0),
    "sonstig":      (20.0, 17.0, ("raumtemperatur",), 20.0, 1.0),
}

# Reihenfolge zählt: der erste Treffer gewinnt („Technik" vor „Büro" usw.)
_STICHWORTE = [
    ("technik", ("technik", "schacht", "lager", "abstell", "abfall", "putz", "server")),
    ("sanitaer", ("wc", "vorr. wc", "dusche", "umkleide")),
    ("teekueche", ("teeküche", "teekueche", "küche")),
    ("verkehr", ("flur", "magistrale", "windfang", "aufzug", "trh", "treppe", "foyer", "kopie")),
    ("lehre", ("seminar", "hörsaal", "vorlesung")),
    ("arbeitsplatz", ("stud. arbeits", "stud. selbst", "stud. hilfs", "kommunikationszone")),
    ("labor", ("labor", "prüfstelle", "werkstatt", "studio", "druck", "halle", "gips", "tragwerksbau",
               "verkehrsbau", "buchbinden", "gestalten")),
    ("buero", ("professor", "fb-", "fb ", "forschung", "sekretariat", "lehrbeauftragte", "geschäftsführer",
               "besprechung", "pumi", "büro")),
]

# Die absichtlichen Störungen — sie sollen in der Anzeige auffallen
STOER_LUEFTUNG = "lehre"       # der Seminarraum mit dem höchsten Rang: Zuluft defekt
STOER_UEBERHITZT = "technik"   # der Technikraum mit dem höchsten Rang: Wärmestau
STOER_FENSTER = "buero"        # das Büro mit dem höchsten Rang: Fenster dauerhaft gekippt
STOER_AUSREISSER = "buero"     # ein zweites Büro: Temperatursensor mit Ausreißern


# ── Zufall ohne Gedächtnis (wie in sensor_demo.py) ──────────────────────────

def _gleich(seed, *teile) -> float:
    roh = hashlib.sha256("|".join([str(seed)] + [str(t) for t in teile]).encode()).digest()
    return int.from_bytes(roh[:8], "big") / 2.0 ** 64


def _normal(seed, *teile) -> float:
    u1 = max(_gleich(seed, "n1", *teile), 1e-12)
    u2 = _gleich(seed, "n2", *teile)
    return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


def _glatt(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3.0 - 2.0 * x)


# ── Register ────────────────────────────────────────────────────────────────

def profil_von(long_name: str | None) -> str:
    text = (long_name or "").lower()
    if not text.strip():
        return "sonstig"
    for profil, woerter in _STICHWORTE:
        if any(w in text for w in woerter):
            return profil
    return "sonstig"


def _sauber(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")


def register_aus_raeumen(raeume: list[dict]) -> list[dict]:
    """Aus der Raumliste des Backends die Sensorzeilen — je Profil die passenden Messgrößen."""
    zeilen, benutzt = [], set()
    for r in sorted(raeume, key=lambda x: (x.get("storey") or "", x.get("name") or "")):
        profil = profil_von(r.get("long_name"))
        flaeche = float(r.get("flaeche_m2") or 0.0)
        hoehe = float(r.get("hoehe_m") or 3.0)
        volumen = float(r.get("volumen_m3") or flaeche * hoehe)
        if flaeche <= 0.0:
            continue
        basis = _sauber(r.get("name") or r["global_id"][:8])
        if basis in benutzt:                       # Namen sind selten doppelt — dann die GlobalId anhängen
            basis = f"{basis}-{_sauber(r['global_id'][:6])}"
        benutzt.add(basis)
        for groesse in PROFILE[profil][2]:
            kurz, einheit, brick, lo, hi = GROESSEN[groesse]
            hersteller, modell = HERSTELLER[groesse]
            zeilen.append({
                "sensor_id": f"R-{basis}-{kurz}",
                "raum_guid": r["global_id"],
                "raum_name": r.get("name") or "",
                "raum_bezeichnung": r.get("long_name") or "",
                "storey": r.get("storey") or "",
                "profil": profil,
                "messgroesse": groesse, "einheit": einheit, "intervall_s": INTERVALL_S,
                "brick_klasse": brick, "bereich_min": lo, "bereich_max": hi,
                "flaeche_m2": round(flaeche, 2), "volumen_m3": round(volumen, 2),
                "einbau": "2026-03-02", "hersteller": hersteller, "modell": modell,
            })
    return zeilen


def register_schreiben(zeilen: list[dict], pfad: Path = REGISTER) -> Path:
    with open(pfad, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=SPALTEN, quoting=csv.QUOTE_ALL)
        w.writeheader()
        w.writerows(zeilen)
    return pfad


def register_lesen(pfad: Path = REGISTER) -> list[dict]:
    with open(pfad, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


# ── Das Modell ──────────────────────────────────────────────────────────────

class RaumModell:
    """Rechnet Belegung, CO₂, Temperatur und Feuchte je Raum und Zeit.

    `raeume` ist das Register (CSV-Zeilen); `wetter` ein Objekt mit
    `globalstrahlung(zeit)` und `aussentemperatur(zeit)` wie `sensor_demo.Wetter`.
    """

    def __init__(self, seed, wetter, register: list[dict]):
        self.seed, self.wetter = seed, wetter
        self.raeume: dict[str, dict] = {}
        for s in register:
            r = self.raeume.setdefault(s["raum_guid"], {
                "guid": s["raum_guid"], "name": s["raum_name"], "profil": s["profil"],
                "storey": s["storey"], "flaeche": float(s["flaeche_m2"]), "volumen": float(s["volumen_m3"]),
            })
            r["gross"] = r["flaeche"]
        self._plan: dict[tuple, list] = {}
        self._personen: dict[tuple, float] = {}
        self._rang = self._raenge()
        for guid, r in self.raeume.items():
            r["sued"] = _gleich(seed, "sued", guid)
            r["aussen"] = _gleich(seed, "aussen", guid) > 0.45 and r["storey"] != "UG"
            r["luftwechsel"] = PROFILE[r["profil"]][4] * (0.75 + 0.5 * _gleich(seed, "ach", guid))
            kopf = PROFILE[r["profil"]][3]
            r["kapazitaet"] = max(1.0, round(r["flaeche"] / kopf))
            r["stoerung"] = self._rang.get(guid)
            if r["stoerung"] == "lueftung":
                r["luftwechsel"] *= 0.2

    def _raenge(self) -> dict[str, str]:
        """Je Störungsart genau ein Raum — der mit dem höchsten Hashwert des Profils."""
        wahl = {}
        for art, profil in (("lueftung", STOER_LUEFTUNG), ("ueberhitzt", STOER_UEBERHITZT),
                            ("fenster", STOER_FENSTER), ("ausreisser", STOER_AUSREISSER)):
            kandidaten = [g for g, r in self.raeume.items()
                          if r["profil"] == profil and g not in wahl.values()
                          and (art != "lueftung" or r["flaeche"] > 20.0)]
            kandidaten.sort(key=lambda g: (-_gleich(self.seed, "stoer", art, g), g))
            if kandidaten:
                wahl[kandidaten[0]] = art
        return wahl

    # ── Belegung ─────────────────────────────────────────────────────────

    @staticmethod
    def _ortszeit(zeit: datetime) -> datetime:
        return zeit.astimezone(ORT)

    def _tagesplan(self, raum: dict, tag) -> list[tuple[float, float, float]]:
        """Belegte Abschnitte des Tages als (von_h, bis_h, Anteil der Kapazität)."""
        schluessel = (raum["guid"], tag)
        if schluessel in self._plan:
            return self._plan[schluessel]
        s, g = self.seed, raum["guid"]
        werktag = tag.weekday() < 5
        profil = raum["profil"]
        plan: list[tuple[float, float, float]] = []
        if profil == "lehre":
            if werktag:
                for i, (von, bis) in enumerate([(8.25, 9.75), (10.0, 11.5), (12.0, 13.5), (14.0, 15.5), (16.0, 17.5)]):
                    if _gleich(s, "block", g, tag, i) < 0.5:
                        plan.append((von, bis, 0.35 + 0.65 * _gleich(s, "anteil", g, tag, i)))
        elif profil == "buero":
            if werktag and _gleich(s, "da", g, tag) < 0.75:
                kommt = 7.5 + 2.0 * _gleich(s, "kommt", g, tag)
                geht = 15.5 + 2.5 * _gleich(s, "geht", g, tag)
                if _gleich(s, "pause", g, tag) < 0.5:
                    plan += [(kommt, 12.0, 1.0), (12.75, geht, 1.0)]
                else:
                    plan.append((kommt, geht, 1.0))
        elif profil == "arbeitsplatz":
            if werktag and _gleich(s, "da", g, tag) < 0.85:
                plan.append((9.0, 19.0, 0.2 + 0.5 * _gleich(s, "anteil", g, tag)))
        elif profil == "labor":
            if werktag and _gleich(s, "da", g, tag) < 0.6:
                plan.append((8.5, 16.5, 0.3 + 0.5 * _gleich(s, "anteil", g, tag)))
        elif profil in ("verkehr", "sanitaer", "teekueche"):
            pass                      # Durchgangsräume: Belegung je Schlitz, siehe `personen`
        self._plan[schluessel] = plan
        return plan

    def personen(self, raum: dict, zeit: datetime) -> float:
        """Anzahl Personen im Raum zum Zeitpunkt (Schlitz von fünf Minuten)."""
        lokal = self._ortszeit(zeit)
        schlitz = int(zeit.timestamp()) // SCHLITZ_S
        schluessel = (raum["guid"], schlitz)
        if schluessel in self._personen:
            return self._personen[schluessel]
        h = lokal.hour + lokal.minute / 60.0
        werktag = lokal.weekday() < 5
        profil, n = raum["profil"], 0.0
        if profil in ("verkehr", "sanitaer", "teekueche"):
            if werktag and 7.0 <= h < 18.5:
                spitze = {"verkehr": 0.28, "sanitaer": 0.14, "teekueche": 0.12}[profil]
                if profil == "teekueche" and 11.75 <= h < 13.0:
                    spitze = 0.5
                if profil == "verkehr" and (abs(h - 9.9) < 0.3 or abs(h - 11.75) < 0.3 or abs(h - 13.75) < 0.3):
                    spitze = 0.7
                if _gleich(self.seed, "slot", raum["guid"], schlitz) < spitze:
                    n = 1.0 + (2.0 if profil == "verkehr" and spitze > 0.6 else 0.0)
        elif profil in ("lehre", "buero", "arbeitsplatz", "labor"):
            for von, bis, anteil in self._tagesplan(raum, lokal.date()):
                if von <= h < bis:
                    n = max(1.0, round(raum["kapazitaet"] * anteil)) if profil != "buero" else min(2.0, raum["kapazitaet"])
                    break
        self._personen[schluessel] = n
        return n

    # ── CO₂, Temperatur, Feuchte ────────────────────────────────────────

    def co2(self, raum: dict, zeit: datetime) -> float:
        """Außenluft + gedämpfte Belegung der letzten drei Stunden (Massenbilanz in Fünf-Minuten-Schritten)."""
        Q = max(raum["luftwechsel"] * raum["volumen"], 1.0)          # m³/h
        tau_min = 60.0 * raum["volumen"] / Q
        dt = SCHLITZ_S / 60.0
        a = 1.0 - math.exp(-dt / tau_min)
        quelle = 0.018 / Q * 1e6                                     # ppm je Person im Beharrungszustand
        summe = 0.0
        for j in range(36):
            n = self.personen(raum, zeit - timedelta(seconds=j * SCHLITZ_S))
            summe += a * math.exp(-j * dt / tau_min) * n * quelle
        wert = 420.0 + summe
        wert += 12.0 * _normal(self.seed, "co2", raum["guid"], int(zeit.timestamp()))
        if raum["stoerung"] == "fenster":
            wert = 420.0 + 0.4 * (wert - 420.0)
        return min(5000.0, max(380.0, wert))

    def temperatur(self, raum: dict, zeit: datetime) -> float:
        tag, nacht = PROFILE[raum["profil"]][:2]
        lokal = self._ortszeit(zeit)
        h = lokal.hour + lokal.minute / 60.0
        werktag = lokal.weekday() < 5
        if raum["profil"] in ("technik",):
            soll = tag
        elif werktag:
            # Heizung fährt zwischen fünf und sieben Uhr hoch, ab 19 Uhr herunter
            soll = nacht + (tag - nacht) * (_glatt((h - 5.0) / 2.0) - _glatt((h - 19.0) / 2.5))
        else:
            soll = nacht
        aussen = self.wetter.aussentemperatur(zeit)
        wert = soll
        if raum["aussen"]:
            wert -= 0.03 * (soll - aussen)
            sonne = self.wetter.globalstrahlung(zeit - timedelta(hours=1))
            wert += 3.0 * raum["sued"] * min(1.0, sonne / 800.0)
        if raum["storey"] == "UG":
            wert -= 1.2
        n_gedaempft = sum(self.personen(raum, zeit - timedelta(seconds=j * SCHLITZ_S)) for j in range(0, 12, 2)) / 6.0
        wert += 0.9 * min(1.0, n_gedaempft / raum["kapazitaet"])
        if raum["stoerung"] == "ueberhitzt":
            wert += 9.0 * _glatt((h - 7.0) / 4.0) * (1.0 - _glatt((h - 19.0) / 3.0))
        elif raum["stoerung"] == "fenster":
            wert -= 0.45 * (wert - aussen) * (0.4 + 0.6 * (1.0 if 7.0 <= h < 18.0 else 0.0))
        return wert + 0.15 * _normal(self.seed, "t", raum["guid"], int(zeit.timestamp()))

    def feuchte(self, raum: dict, zeit: datetime) -> float:
        aussen = self.wetter.aussentemperatur(zeit)
        t_raum = self.temperatur(raum, zeit)
        n_gedaempft = sum(self.personen(raum, zeit - timedelta(seconds=j * SCHLITZ_S)) for j in range(0, 12, 2)) / 6.0
        wert = 32.0 + 1.3 * aussen - 0.9 * (t_raum - 21.0) + 2.5 * min(2.0, n_gedaempft)
        if raum["profil"] == "sanitaer":
            wert += 10.0
        return min(80.0, max(15.0, wert + 1.0 * _normal(self.seed, "rf", raum["guid"], int(zeit.timestamp()))))

    # ── Schnittstelle zu sensor_demo.Lauf.messung ───────────────────────

    def messung(self, zeit: datetime, sensor: dict):
        """(Wert, Status) für einen Raumsensor."""
        raum = self.raeume[sensor.get("anker_guid") or sensor["raum_guid"]]
        groesse = sensor["messgroesse"]
        if groesse == "praesenz":
            return (1.0 if self.personen(raum, zeit) > 0 else 0.0), "ok"
        if groesse == "co2":
            return round(self.co2(raum, zeit), 0), "ok"
        if groesse == "luftfeuchte":
            return round(self.feuchte(raum, zeit), 1), "ok"
        if groesse == "raumtemperatur":
            if raum["stoerung"] == "ausreisser":
                n = int(zeit.timestamp()) // INTERVALL_S
                if n % 150 == 61:
                    return (sensor["bereich_max"] + 40.0 if (n // 150) % 2 == 0 else sensor["bereich_min"] - 40.0), "ausreisser"
            return round(self.temperatur(raum, zeit), 2), "ok"
        raise SystemExit(f"Unbekannte Raummessgröße {groesse!r} bei {sensor['sensor_id']}")

    def stoerungen(self) -> list[dict]:
        """Für die Doku und die Anzeige: welche Räume absichtlich auffällig sind."""
        beschr = {"lueftung": "Zuluft defekt — CO₂ steigt bei Belegung weit über 1000 ppm",
                  "ueberhitzt": "Wärmestau — am Nachmittag rund 9 K zu warm",
                  "fenster": "Fenster dauerhaft gekippt — kühl, wenig CO₂",
                  "ausreisser": "Temperatursensor liefert gelegentlich Ausreißer"}
        return [{"raum_guid": g, "raum": r["name"], "art": r["stoerung"], "text": beschr[r["stoerung"]]}
                for g, r in self.raeume.items() if r["stoerung"]]
