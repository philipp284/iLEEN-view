"""
GEG-Energiebilanz: Monatsbilanzverfahren für den Nachweis am Gebäude.

Das Gegenstück zu `rechnung.py`. Dort wird eine Decke gerechnet, hier das
Gebäude als Ganzes: Hüllflächen mit U-Werten hinein, Jahres-Primärenergiebedarf
und spezifischer Transmissionswärmeverlust heraus, beide gegen das
Referenzgebäude nach GEG Anlage 1 gestellt.

**Dies ist eine Vorbemessung, kein geführter Nachweis.** Der Unterschied ist
keine Förmlichkeit, deshalb steht er hier zuerst und zusätzlich als
`einordnung` in jedem Bericht:

* Die Anlagentechnik wird über **pauschale Aufwandszahlen** bewertet, nicht im
  Tabellenverfahren nach DIN V 4701-10. Eine Musteranlage nach Beiblatt 1 kommt
  je nach Verteilung und Speicherung merklich anders heraus.
* Das Verfahren ist **gegen keine Vorlage validiert**. Für den echten Nachweis
  gibt es im Werkstattbestand `~/Projekte/GEG-Nachweis` — den Web-Nachbau der
  MoBi-Excel der Uni Kassel, gegen ebendiese Excel geprüft, mit Schichtaufbauten
  nach ISO 6946, IFC-Import samt Orientierung aus der Geometrie und einem
  Druckbericht in Fachberichtsform. Das Werkzeug im Viewer verweist darauf.

Wofür es taugt: einen Entwurf in Minuten einordnen, die Stellschrauben zeigen
(welche Bauteilart trägt wie viel H_T, was bringt eine bessere Verglasung) und
das Ergebnis als Skizze in den Berichtsentwurf legen.

Gerechnet wird das *Monatsbilanzverfahren* nach DIN V 4108-6, also das
vereinfachte Wohngebäudeverfahren. Es ist **nicht** die Mehrzonen-Monatsbilanz
nach DIN V 18599, die das GEG für Nichtwohngebäude verlangt — Kühlung,
Beleuchtung und Lüftungsanlagen werden hier nicht als eigene Teilbilanzen
geführt.

Die Rechnung ist deshalb durchgehend so gebaut, dass jeder Beiwert als Annahme
sichtbar ist und im Bericht steht. Wer eine Zahl nicht wiedererkennt, soll sie
finden und ändern können, statt sie zu glauben.

Ablauf:

    Hüllflächen (aus IFC oder von Hand)  →  H_T, H_V
                                          →  Monatsbilanz Q_h
                                          →  Warmwasser, Anlagentechnik
                                          →  Q_p, CO₂
    Referenzgebäude (GEG Anlage 1)        →  Q_p,zul, H_T',zul
                                          →  Nachweise
"""

from __future__ import annotations

import logging
import math
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from ileen import zeichnen  # noqa: E402

logger = logging.getLogger(__name__)


# ── Referenzklima ──────────────────────────────────────────────────────────

MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni",
          "Juli", "August", "September", "Oktober", "November", "Dezember"]

TAGE = np.array([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], dtype=float)

# Referenzklima Potsdam — der Standort, auf den das GEG den Nachweis bezieht
# (§ 22 i.V.m. DIN V 18599-10). Monatsmittel der Außentemperatur in °C.
#
# Warum ein fester Standort und nicht das Wetter am Bauplatz: der Nachweis ist
# ein *Vergleich* mit dem Referenzgebäude, und der ist nur aussagekräftig, wenn
# beide Seiten dasselbe Klima sehen. Das reale Standortklima gehört in eine
# Verbrauchsprognose, nicht in den Nachweis.
KLIMA_POTSDAM = np.array(
    [0.9, 1.6, 5.0, 9.5, 14.2, 17.3, 19.0, 18.6, 14.5, 9.8, 5.0, 1.9]
)

# Monatliche Summen der Solarstrahlung auf die geneigte Fläche in kWh/(m²·Monat),
# Referenzklima Potsdam. Gerundete Tabellenwerte — sie tragen den Nachweis, aber
# nicht die dritte Nachkommastelle eines Ertragsgutachtens.
STRAHLUNG = {
    "sued":       np.array([30, 42, 66, 77, 91, 87, 90, 88, 74, 57, 30, 22], dtype=float),
    "suedost":    np.array([23, 33, 56, 71, 88, 88, 89, 85, 67, 46, 23, 16], dtype=float),
    "suedwest":   np.array([23, 33, 56, 71, 88, 88, 89, 85, 67, 46, 23, 16], dtype=float),
    "ost":        np.array([16, 25, 47, 68, 94, 97, 97, 84, 60, 35, 17, 11], dtype=float),
    "west":       np.array([16, 25, 47, 68, 94, 97, 97, 84, 60, 35, 17, 11], dtype=float),
    "nordost":    np.array([11, 18, 33, 50, 71, 77, 75, 60, 41, 24, 12, 8], dtype=float),
    "nordwest":   np.array([11, 18, 33, 50, 71, 77, 75, 60, 41, 24, 12, 8], dtype=float),
    "nord":       np.array([10, 16, 28, 40, 56, 62, 60, 48, 33, 20, 11, 7], dtype=float),
    "horizontal": np.array([15, 26, 55, 87, 124, 129, 128, 108, 73, 41, 18, 11], dtype=float),
}

HIMMELSRICHTUNGEN = ["nord", "nordost", "ost", "suedost",
                     "sued", "suedwest", "west", "nordwest", "horizontal"]


def strahlung(orientierung: str) -> np.ndarray:
    """Monatssummen für eine Orientierung; unbekannte gelten als Ost/West."""
    return STRAHLUNG.get((orientierung or "").lower().strip(), STRAHLUNG["ost"])


# ── Bauteilarten der Hülle ─────────────────────────────────────────────────

# Temperaturkorrekturfaktor F_x nach DIN V 4108-6 Tabelle 3: gegen welches
# Medium das Bauteil dämmt. Gegen Außenluft ist er 1,0, gegen Erdreich oder
# einen unbeheizten Keller deutlich kleiner — dieselbe Dämmung wirkt dort
# weniger, weil das Temperaturgefälle kleiner ist.
FX_STANDARD = {
    "aussenwand": 1.0,
    "dach": 1.0,
    "fenster": 1.0,
    "dachfenster": 1.0,
    "tuer": 1.0,
    "wand_erdreich": 0.6,
    "boden_erdreich": 0.6,
    "kellerdecke": 0.5,
    "wand_unbeheizt": 0.5,
    "decke_unbeheizt": 0.8,
    "abseitenwand": 0.8,
}

# Referenzausführung Wohngebäude nach GEG Anlage 1 Tabelle 1 — die Hülle, gegen
# die der Entwurf antritt. U-Werte in W/(m²K), g als Gesamtenergiedurchlassgrad.
REFERENZ_WOHNGEBAEUDE = {
    "aussenwand":     {"u": 0.28},
    "wand_erdreich":  {"u": 0.35},
    "dach":           {"u": 0.20},
    "decke_unbeheizt": {"u": 0.20},
    "abseitenwand":   {"u": 0.28},
    "boden_erdreich": {"u": 0.35},
    "kellerdecke":    {"u": 0.35},
    "wand_unbeheizt": {"u": 0.35},
    "fenster":        {"u": 1.30, "g": 0.60},
    "dachfenster":    {"u": 1.40, "g": 0.60},
    "tuer":           {"u": 1.80},
}

# Primärenergiefaktoren (nicht erneuerbarer Anteil) nach GEG Anlage 4 sowie die
# CO₂-Emissionsfaktoren nach GEG Anlage 9, letztere in kg/kWh Endenergie.
ENERGIETRAEGER = {
    "erdgas":        {"fp": 1.1, "co2": 0.240, "name": "Erdgas"},
    "heizoel":       {"fp": 1.1, "co2": 0.310, "name": "Heizöl"},
    "fluessiggas":   {"fp": 1.1, "co2": 0.270, "name": "Flüssiggas"},
    "steinkohle":    {"fp": 1.1, "co2": 0.400, "name": "Steinkohle"},
    "holzpellets":   {"fp": 0.2, "co2": 0.020, "name": "Holzpellets"},
    "holzhackschnitzel": {"fp": 0.2, "co2": 0.020, "name": "Holzhackschnitzel"},
    "scheitholz":    {"fp": 0.2, "co2": 0.020, "name": "Scheitholz"},
    "strom":         {"fp": 1.8, "co2": 0.560, "name": "Strom (Netz)"},
    "fernwaerme_kwk": {"fp": 0.7, "co2": 0.180, "name": "Fernwärme aus KWK"},
    "fernwaerme_fossil": {"fp": 1.3, "co2": 0.300, "name": "Fernwärme fossil"},
    "nahwaerme_erneuerbar": {"fp": 0.1, "co2": 0.020, "name": "Nahwärme erneuerbar"},
}

# Erzeugeraufwandszahlen als Startwerte — das Verhältnis Endenergie zu
# Nutzenergie über das Jahr, Erzeugung, Verteilung und Speicherung zusammen.
# Bei der Wärmepumpe ist es der Kehrwert der Jahresarbeitszahl.
ERZEUGER = {
    "brennwert":       {"e_h": 1.11, "e_w": 1.30, "traeger": "erdgas",
                        "name": "Gas-Brennwertkessel"},
    "niedertemperatur": {"e_h": 1.35, "e_w": 1.60, "traeger": "erdgas",
                         "name": "Niedertemperaturkessel"},
    "oel_brennwert":   {"e_h": 1.13, "e_w": 1.35, "traeger": "heizoel",
                        "name": "Öl-Brennwertkessel"},
    "pellets":         {"e_h": 1.25, "e_w": 1.55, "traeger": "holzpellets",
                        "name": "Pelletkessel"},
    "waermepumpe_luft": {"e_h": 0.35, "e_w": 0.45, "traeger": "strom",
                         "name": "Luft/Wasser-Wärmepumpe (JAZ 2,9 / 2,2)"},
    "waermepumpe_sole": {"e_h": 0.25, "e_w": 0.33, "traeger": "strom",
                         "name": "Sole/Wasser-Wärmepumpe (JAZ 4,0 / 3,0)"},
    "fernwaerme":      {"e_h": 1.05, "e_w": 1.25, "traeger": "fernwaerme_kwk",
                        "name": "Fernwärmeübergabe"},
    "direktstrom":     {"e_h": 1.00, "e_w": 1.00, "traeger": "strom",
                        "name": "Stromdirektheizung"},
}

# Die Anlage des Referenzgebäudes nach GEG Anlage 1: Brennwertkessel, zentrale
# Warmwasserbereitung mit Solaranlage. Sie ist bewusst *nicht* die des Entwurfs
# — sonst verglichen sich zwei Gebäude mit demselben Kessel und der Nachweis
# sagte nichts über die Anlagentechnik aus.
REFERENZ_ANLAGE = {"erzeuger": "brennwert", "solar_ww_anteil": 0.35}


# ── Annahmen ───────────────────────────────────────────────────────────────


@dataclass
class Annahmen:
    """
    Was die Bauteilliste nicht enthält.

    Dieselbe Rolle wie `rechnung.Annahmen`: Ingenieurwissen über das Gebäude,
    an einer Stelle gesammelt, damit es im Bericht wiederzufinden ist.
    """

    gebaeudeart: str = "wohngebaeude"          # wohngebaeude | nichtwohngebaeude
    beheiztes_volumen_m3: float | None = None  # V_e; sonst aus Hüllfläche geschätzt
    nutzflaeche_m2: float | None = None        # A_N; sonst 0,32 · V_e (GEG § 20)
    geschosshoehe_m: float = 3.0

    # Innentemperatur der Heizperiode. 20 °C ist der Ansatz des GEG für
    # Wohngebäude; die Nachtabsenkung steckt bereits in den 20 °C und wird
    # nicht noch einmal abgezogen.
    innentemperatur_c: float = 20.0
    heizgrenze_c: float = 10.0                 # darüber wird nicht geheizt

    # Luftwechsel in 1/h. 0,55 gilt mit Dichtheitsprüfung nach GEG § 26,
    # 0,70 ohne — der Nachweis der Dichtheit ist also eine halbe Rechengröße.
    luftwechsel_1h: float = 0.55
    dichtheitspruefung: bool = True
    lueftung_wrg: float = 0.0                  # Wärmerückgewinnungsgrad 0…0,9

    # Wärmebrückenzuschlag ΔU_WB in W/(m²K) auf die gesamte Hüllfläche.
    # 0,10 ohne Nachweis, 0,05 bei Ausführung nach DIN 4108 Beiblatt 2,
    # 0,03 bei gleichwertigem Nachweis (GEG § 24).
    waermebruecken_w_m2k: float = 0.05

    # Interne Gewinne in W/m² Nutzfläche. 5,0 ist der Ansatz für Wohngebäude
    # nach DIN V 4108-6; Büro liegt höher, aber dann ist ohnehin 18599 dran.
    interne_gewinne_w_m2: float = 5.0

    # Wirksame Wärmespeicherfähigkeit in Wh/(m²K) Nutzfläche — sie bestimmt,
    # wie viel des solaren Gewinns tatsächlich genutzt statt weggelüftet wird.
    # 50 leichte Bauart, 90 mittelschwer, 130 schwer (Massivbau).
    speicherfaehigkeit_wh_m2k: float = 90.0

    # Anlagentechnik
    erzeuger: str = "brennwert"
    energietraeger: str | None = None          # sonst der des Erzeugers
    solar_ww_anteil: float = 0.0               # Deckungsanteil Solarthermie WW
    pv_kwh_a: float = 0.0                      # anrechenbarer PV-Ertrag

    # Warmwasser-Nutzwärmebedarf in kWh/(m²a) Nutzfläche. 12,5 ist der feste
    # Ansatz des GEG für Wohngebäude (§ 20 Abs. 3).
    warmwasser_kwh_m2a: float = 12.5

    # Anforderungsniveau: Anteil des Referenzgebäudes, der eingehalten werden
    # muss. GEG 2024 § 10 verlangt 55 % für den Neubau; 100 % entspricht dem
    # Referenzgebäude selbst (Bestandssanierung, § 50).
    anforderung_anteil: float = 0.55
    neubau: bool = True

    @classmethod
    def aus(cls, daten: dict | None) -> "Annahmen":
        """Nimmt nur bekannte Schlüssel — unbekannte fallen still weg."""
        if not daten:
            return cls()
        bekannt = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in daten.items() if k in bekannt and v is not None})

    def als_bericht(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


class Abbruch(Exception):
    """Die Eingabe lässt sich nicht bilanzieren — mit Begründung fürs Frontend."""


# ── Hüllflächen ────────────────────────────────────────────────────────────


@dataclass
class Bauteil:
    """Eine Hüllfläche: die kleinste Einheit, aus der H_T entsteht."""

    name: str
    art: str                      # Schlüssel aus FX_STANDARD
    flaeche_m2: float
    u_w_m2k: float
    orientierung: str = "nord"    # nur für transparente Bauteile ausgewertet
    g_wert: float | None = None   # Gesamtenergiedurchlassgrad, transparent
    fc: float = 1.0               # Abminderung durch Sonnenschutz
    ff: float = 0.70              # Rahmenanteil: Glasanteil an der Fensterfläche
    fs: float = 0.90              # Verschattung durch Umgebung und Überstand
    fx: float | None = None       # Temperaturkorrektur; sonst aus FX_STANDARD
    global_id: str | None = None  # Rückbindung ins IFC
    bemerkung: str = ""

    @property
    def transparent(self) -> bool:
        return self.art in ("fenster", "dachfenster") or self.g_wert is not None

    @property
    def faktor(self) -> float:
        return FX_STANDARD.get(self.art, 1.0) if self.fx is None else float(self.fx)

    @property
    def ht_w_k(self) -> float:
        """Transmissionswärmeverlust dieses Bauteils in W/K."""
        return self.faktor * self.u_w_m2k * self.flaeche_m2

    @classmethod
    def aus(cls, daten: dict) -> "Bauteil":
        bekannt = {f.name for f in cls.__dataclass_fields__.values()}
        gefiltert = {k: v for k, v in daten.items() if k in bekannt and v is not None}
        if "flaeche_m2" not in gefiltert or "u_w_m2k" not in gefiltert:
            raise Abbruch(
                f"Bauteil „{daten.get('name', '?')}“ ohne Fläche oder U-Wert — "
                "beide Angaben sind für die Bilanz zwingend."
            )
        gefiltert.setdefault("name", daten.get("art", "Bauteil"))
        gefiltert.setdefault("art", "aussenwand")
        return cls(**gefiltert)


@dataclass
class Gebaeude:
    """Das eingelesene Modell: Hülle, Kennwerte, Herkunft."""

    titel: str
    bauteile: list[Bauteil] = field(default_factory=list)
    job_id: str | None = None
    modell: str = ""
    plan: dict = field(default_factory=dict)

    @property
    def huellflaeche_m2(self) -> float:
        return float(sum(b.flaeche_m2 for b in self.bauteile))

    @classmethod
    def aus(cls, daten: dict) -> "Gebaeude":
        rohe = daten.get("bauteile") or []
        if not rohe:
            raise Abbruch(
                "Keine Hüllflächen angegeben. Ohne mindestens ein Bauteil mit "
                "Fläche und U-Wert gibt es nichts zu bilanzieren."
            )
        bauteile = [Bauteil.aus(b) for b in rohe]
        gesamt = sum(b.flaeche_m2 for b in bauteile)
        if gesamt <= 0:
            raise Abbruch("Die Summe aller Hüllflächen ist null.")
        return cls(
            titel=daten.get("titel") or "Gebäude",
            bauteile=bauteile,
            job_id=daten.get("job_id"),
            modell=daten.get("modell", ""),
            plan=daten.get("plan") or {},
        )


# ── Fortschritt ────────────────────────────────────────────────────────────


class Lauf:
    """Führt den Fortschritt und sammelt, was unterwegs schiefging."""

    def __init__(self, melden=None):
        self._melden = melden or (lambda anteil, text: None)
        self.hinweise: list[str] = []
        self.start = time.time()

    def schritt(self, anteil: float, text: str) -> None:
        logger.info("GEG %3.0f %% — %s", anteil * 100, text)
        self._melden(anteil, text)

    def hinweis(self, text: str) -> None:
        logger.warning("GEG: %s", text)
        self.hinweise.append(text)

    @contextmanager
    def versuche(self, was: str):
        """Ein Abschnitt, der scheitern darf — nur `Abbruch` bricht durch."""
        try:
            yield
        except Abbruch:
            raise
        except Exception as fehler:  # noqa: BLE001 — genau das ist der Zweck
            logger.warning("GEG: %s übersprungen (%s)", was, fehler, exc_info=True)
            self.hinweis(f"{was} nicht gerechnet: {fehler}")

    @property
    def dauer(self) -> float:
        return time.time() - self.start


# ── Bildersammlung ─────────────────────────────────────────────────────────


class Bilder:
    """Legt Figuren als PNG ab und führt Buch darüber — wie in `rechnung.py`."""

    def __init__(self, verzeichnis: Path, dpi: int = 110):
        self.verzeichnis = Path(verzeichnis)
        self.verzeichnis.mkdir(parents=True, exist_ok=True)
        self.dpi = dpi
        self.liste: list[dict] = []

    @contextmanager
    def figur(self, name: str, titel: str, gruppe: str, **kwargs):
        fig = plt.figure(**kwargs)
        try:
            yield fig
            datei = f"{name}.png"
            fig.savefig(self.verzeichnis / datei, dpi=self.dpi,
                        bbox_inches="tight", facecolor="white")
            self.liste.append({"name": name, "titel": titel,
                               "gruppe": gruppe, "datei": datei})
        finally:
            plt.close(fig)

    def als_liste(self) -> list[dict]:
        return list(self.liste)


# ── Die Bilanz ─────────────────────────────────────────────────────────────


def _volumen(gebaeude: Gebaeude, annahmen: Annahmen, lauf: Lauf) -> float:
    """
    Das beheizte Bruttovolumen V_e.

    Angegeben ist es fast immer; wenn nicht, wird es aus der Hüllfläche
    geschätzt. Die Schätzung nimmt einen Quader mit dem A/V-Verhältnis, das
    ein kompaktes Wohnhaus üblicherweise hat (0,7 1/m) — das ist eine grobe
    Näherung und wird deshalb als Hinweis vermerkt, nicht stillschweigend
    verwendet.
    """
    if annahmen.beheiztes_volumen_m3 and annahmen.beheiztes_volumen_m3 > 0:
        return float(annahmen.beheiztes_volumen_m3)
    geschaetzt = gebaeude.huellflaeche_m2 / 0.7
    lauf.hinweis(
        f"Beheiztes Volumen nicht angegeben — aus der Hüllfläche mit A/V = 0,7 1/m "
        f"auf {geschaetzt:.0f} m³ geschätzt. Für den Nachweis den wahren Wert eintragen."
    )
    return geschaetzt


def _nutzflaeche(volumen_m3: float, annahmen: Annahmen) -> float:
    """
    A_N nach GEG § 20 Abs. 1: 0,32 · V_e für Wohngebäude.

    Das ist keine Wohnfläche und auch keine Nutzfläche im Sinne der DIN 277 —
    es ist eine Rechengröße, auf die das GEG seine flächenbezogenen Kennwerte
    bezieht. Wer hier die Wohnfläche einträgt, rechnet rund 20 % zu klein.
    """
    if annahmen.nutzflaeche_m2 and annahmen.nutzflaeche_m2 > 0:
        return float(annahmen.nutzflaeche_m2)
    return 0.32 * volumen_m3


def _transmission(bauteile: list[Bauteil], huellflaeche_m2: float,
                  annahmen: Annahmen) -> dict:
    """H_T mit Wärmebrückenzuschlag, aufgeschlüsselt nach Bauteilart."""
    nach_art: dict[str, dict] = {}
    for b in bauteile:
        eintrag = nach_art.setdefault(
            b.art, {"art": b.art, "flaeche_m2": 0.0, "ht_w_k": 0.0, "anzahl": 0}
        )
        eintrag["flaeche_m2"] += b.flaeche_m2
        eintrag["ht_w_k"] += b.ht_w_k
        eintrag["anzahl"] += 1

    for eintrag in nach_art.values():
        flaeche = eintrag["flaeche_m2"]
        eintrag["u_mittel_w_m2k"] = (
            round(eintrag["ht_w_k"] / flaeche, 3) if flaeche > 0 else 0.0
        )
        eintrag["flaeche_m2"] = round(flaeche, 2)
        eintrag["ht_w_k"] = round(eintrag["ht_w_k"], 2)

    ht_bauteile = sum(b.ht_w_k for b in bauteile)
    ht_waermebruecken = annahmen.waermebruecken_w_m2k * huellflaeche_m2

    return {
        "ht_bauteile_w_k": round(ht_bauteile, 2),
        "ht_waermebruecken_w_k": round(ht_waermebruecken, 2),
        "ht_gesamt_w_k": round(ht_bauteile + ht_waermebruecken, 2),
        "nach_art": sorted(nach_art.values(), key=lambda e: -e["ht_w_k"]),
    }


def _lueftung(volumen_m3: float, annahmen: Annahmen) -> dict:
    """
    H_V = 0,34 · n · V_L.

    Das Luftvolumen V_L ist nicht das Bruttovolumen: DIN V 4108-6 setzt
    V_L = 0,76 · V_e an, weil Decken, Wände und Estriche nicht mitatmen.
    Eine Anlage mit Wärmerückgewinnung mindert den wirksamen Luftwechsel.
    """
    v_luft = 0.76 * volumen_m3
    n = float(annahmen.luftwechsel_1h)
    wrg = max(0.0, min(0.9, float(annahmen.lueftung_wrg)))
    n_wirksam = n * (1.0 - wrg)
    return {
        "luftvolumen_m3": round(v_luft, 1),
        "luftwechsel_1h": n,
        "wrg": wrg,
        "luftwechsel_wirksam_1h": round(n_wirksam, 3),
        "hv_w_k": round(0.34 * n_wirksam * v_luft, 2),
    }


def _solare_gewinne(bauteile: list[Bauteil]) -> tuple[np.ndarray, list[dict]]:
    """
    Monatliche solare Gewinne in kWh je Monat, dazu die Aufstellung je Fenster.

    Die wirksame Fläche ist A_w · F_F · F_S · F_C, der wirksame
    Durchlassgrad 0,9 · g — die 0,9 sind der nicht senkrechte Einfall über den
    Tag gemittelt (DIN V 4108-6). Wer sie vergisst, rechnet die Gewinne um gut
    ein Zehntel zu groß, und die Gewinne sind bei einem gut gedämmten Haus die
    Hälfte der Bilanz.
    """
    summe = np.zeros(12)
    aufstellung: list[dict] = []
    for b in bauteile:
        if not b.transparent:
            continue
        g = 0.60 if b.g_wert is None else float(b.g_wert)
        wirksam = b.flaeche_m2 * b.ff * b.fs * b.fc
        anteil = 0.9 * g * wirksam * strahlung(b.orientierung)
        summe += anteil
        aufstellung.append({
            "name": b.name,
            "orientierung": b.orientierung,
            "flaeche_m2": round(b.flaeche_m2, 2),
            "g_wert": round(g, 2),
            "wirksame_flaeche_m2": round(0.9 * g * wirksam, 2),
            "gewinn_kwh_a": round(float(anteil.sum()), 0),
        })
    aufstellung.sort(key=lambda e: -e["gewinn_kwh_a"])
    return summe, aufstellung


def _ausnutzungsgrad(gewinne: np.ndarray, verluste: np.ndarray,
                     zeitkonstante_h: float) -> np.ndarray:
    """
    η nach DIN V 4108-6 Gl. (17): wie viel des Gewinns wirklich ankommt.

    Ein Gewinn nützt nur, solange geheizt wird. Scheint im April die Sonne in
    ein Haus, das ohnehin warm genug ist, geht die Wärme durchs Fenster wieder
    hinaus. Der Ausnutzungsgrad bildet genau das ab: er fällt gegen null, wenn
    die Gewinne die Verluste übersteigen, und die Zeitkonstante entscheidet,
    wie schnell — ein schwerer Massivbau puffert einen sonnigen Nachmittag in
    die Nacht hinein, ein Leichtbau nicht.
    """
    a = 1.0 + zeitkonstante_h / 16.0
    with np.errstate(divide="ignore", invalid="ignore"):
        gamma = np.where(verluste > 0, gewinne / np.maximum(verluste, 1e-9), np.inf)
        eta = np.where(
            np.isclose(gamma, 1.0),
            a / (a + 1.0),
            (1.0 - gamma ** a) / (1.0 - gamma ** (a + 1.0)),
        )
    # Kein Gewinn ist nutzbar, wo nicht geheizt wird; und mehr als der Gewinn
    # selbst kann nie genutzt werden.
    eta = np.clip(np.nan_to_num(eta, nan=0.0, posinf=0.0, neginf=0.0), 0.0, 1.0)
    return np.where(verluste <= 0, 0.0, eta)


def _monatsbilanz(ht_w_k: float, hv_w_k: float, solar: np.ndarray,
                  nutzflaeche_m2: float, annahmen: Annahmen) -> dict:
    """
    Die Heizwärmebilanz Monat für Monat.

    Q_h = Q_Verlust − η · Q_Gewinn, je Monat und nie kleiner als null: ein
    Monat mit Überschuss verschenkt ihn, er wird nicht dem Winter gutgeschrieben.
    Genau daran scheitert die Jahresbilanz als Einzelrechnung — sie verrechnet
    den Sommerüberschuss mit dem Januar und kommt viel zu günstig heraus.
    """
    stunden = TAGE * 24.0
    delta_t = annahmen.innentemperatur_c - KLIMA_POTSDAM
    heizt = KLIMA_POTSDAM < annahmen.heizgrenze_c

    verluste = (ht_w_k + hv_w_k) * delta_t * stunden / 1000.0    # kWh
    verluste = np.maximum(verluste, 0.0)

    intern = annahmen.interne_gewinne_w_m2 * nutzflaeche_m2 * stunden / 1000.0
    gewinne = solar + intern

    zeitkonstante = (
        annahmen.speicherfaehigkeit_wh_m2k * nutzflaeche_m2 / max(ht_w_k + hv_w_k, 1e-6)
    )
    eta = _ausnutzungsgrad(gewinne, verluste, zeitkonstante)

    bedarf = np.maximum(verluste - eta * gewinne, 0.0)
    bedarf = np.where(heizt, bedarf, 0.0)

    return {
        "monate": MONATE,
        "aussentemperatur_c": [round(float(t), 1) for t in KLIMA_POTSDAM],
        "verluste_kwh": [round(float(v), 0) for v in verluste],
        "solare_gewinne_kwh": [round(float(v), 0) for v in solar],
        "interne_gewinne_kwh": [round(float(v), 0) for v in intern],
        "ausnutzungsgrad": [round(float(v), 3) for v in eta],
        "heizwaermebedarf_kwh": [round(float(v), 0) for v in bedarf],
        "zeitkonstante_h": round(float(zeitkonstante), 1),
        "heizmonate": int(heizt.sum()),
        "qh_kwh_a": round(float(bedarf.sum()), 0),
        "verluste_kwh_a": round(float(np.where(heizt, verluste, 0.0).sum()), 0),
        "gewinne_genutzt_kwh_a": round(float(np.where(heizt, eta * gewinne, 0.0).sum()), 0),
        "_bedarf": bedarf,
        "_verluste": verluste,
        "_gewinne": gewinne,
        "_eta": eta,
        "_heizt": heizt,
    }


def _anlage(qh_kwh_a: float, qw_kwh_a: float, annahmen: Annahmen,
            erzeuger_schluessel: str, solar_ww_anteil: float,
            pv_kwh_a: float = 0.0) -> dict:
    """
    Von der Nutzenergie zur Primärenergie.

    Q_end = Q_nutz · e, Q_p = Q_end · f_p. Die Aufwandszahl e trägt Erzeugung,
    Verteilung und Speicherung zusammen; bei der Wärmepumpe ist sie kleiner als
    eins, weil aus einer Kilowattstunde Strom mehrere Kilowattstunden Wärme
    werden. Der Solaranteil mindert die Nutzenergie *vor* der Aufwandszahl —
    was die Sonne liefert, muss der Kessel nicht erzeugen und auch nicht
    verlustbehaftet verteilen.
    """
    daten = ERZEUGER.get(erzeuger_schluessel) or ERZEUGER["brennwert"]
    traeger_schluessel = annahmen.energietraeger or daten["traeger"]
    traeger = ENERGIETRAEGER.get(traeger_schluessel) or ENERGIETRAEGER["erdgas"]

    solar = max(0.0, min(0.95, float(solar_ww_anteil)))
    qw_rest = qw_kwh_a * (1.0 - solar)

    end_h = qh_kwh_a * daten["e_h"]
    end_w = qw_rest * daten["e_w"]

    # Hilfsenergie: Pumpen, Regelung, Gebläse. Pauschal 1,5 % der Nutzenergie,
    # immer als Strom — sie fällt sonst unter den Tisch, obwohl sie mit f_p = 1,8
    # bewertet wird und damit spürbar ist.
    hilfe = 0.015 * (qh_kwh_a + qw_kwh_a)

    strom = ENERGIETRAEGER["strom"]
    qp_waerme = (end_h + end_w) * traeger["fp"]
    qp_hilfe = hilfe * strom["fp"]

    # PV mindert die Primärenergie, nicht die Endenergie der Wärmeerzeugung:
    # angerechnet wird der verdrängte Netzstrom.
    qp_pv = max(0.0, float(pv_kwh_a)) * strom["fp"]
    qp = max(0.0, qp_waerme + qp_hilfe - qp_pv)

    co2 = ((end_h + end_w) * traeger["co2"] + hilfe * strom["co2"]
           - max(0.0, float(pv_kwh_a)) * strom["co2"])

    return {
        "erzeuger": daten["name"],
        "erzeuger_schluessel": erzeuger_schluessel,
        "energietraeger": traeger["name"],
        "fp": traeger["fp"],
        "aufwandszahl_heizung": daten["e_h"],
        "aufwandszahl_warmwasser": daten["e_w"],
        "solar_ww_anteil": round(solar, 2),
        "endenergie_heizung_kwh_a": round(end_h, 0),
        "endenergie_warmwasser_kwh_a": round(end_w, 0),
        "hilfsenergie_kwh_a": round(hilfe, 0),
        "endenergie_kwh_a": round(end_h + end_w + hilfe, 0),
        "pv_gutschrift_kwh_a": round(max(0.0, float(pv_kwh_a)), 0),
        "primaerenergie_kwh_a": round(qp, 0),
        "co2_kg_a": round(max(0.0, co2), 0),
    }


def _referenzgebaeude(gebaeude: Gebaeude, annahmen: Annahmen,
                      volumen_m3: float, nutzflaeche_m2: float) -> dict:
    """
    Dasselbe Gebäude in der Ausführung nach GEG Anlage 1.

    Gleiche Geometrie, gleiche Orientierung, gleiche Flächen — nur U-Werte,
    g-Werte, Wärmebrückenzuschlag und Anlagentechnik sind die der Referenz.
    Das ist der Kern des Verfahrens: verglichen werden nicht zwei Gebäude,
    sondern zwei *Ausführungen desselben* Gebäudes. Deshalb darf hier nichts
    aus dem Entwurf übernommen werden außer der Geometrie.
    """
    referenz_bauteile: list[Bauteil] = []
    for b in gebaeude.bauteile:
        vorgabe = REFERENZ_WOHNGEBAEUDE.get(b.art, {"u": 0.28})
        referenz_bauteile.append(Bauteil(
            name=b.name,
            art=b.art,
            flaeche_m2=b.flaeche_m2,
            u_w_m2k=vorgabe["u"],
            orientierung=b.orientierung,
            g_wert=vorgabe.get("g"),
            # Sonnenschutz und Verschattung sind Eigenschaften des Ortes und
            # des Bauteils, nicht der Dämmung — sie bleiben wie im Entwurf.
            fc=b.fc, ff=b.ff, fs=b.fs, fx=b.fx,
        ))

    referenz_annahmen = Annahmen(
        **{**annahmen.__dict__,
           # GEG Anlage 1: Wärmebrückenzuschlag der Referenz ist 0,05 W/(m²K),
           # Luftdichtheit als geprüft, keine Wärmerückgewinnung, mittelschwere
           # Bauart. Alles andere (Geometrie, Klima, Nutzung) bleibt gleich.
           "waermebruecken_w_m2k": 0.05,
           "luftwechsel_1h": 0.55,
           "lueftung_wrg": 0.0,
           "speicherfaehigkeit_wh_m2k": 90.0,
           "erzeuger": REFERENZ_ANLAGE["erzeuger"],
           "energietraeger": None,
           "solar_ww_anteil": REFERENZ_ANLAGE["solar_ww_anteil"],
           "pv_kwh_a": 0.0}
    )

    huelle = sum(b.flaeche_m2 for b in referenz_bauteile)
    transmission = _transmission(referenz_bauteile, huelle, referenz_annahmen)
    lueftung = _lueftung(volumen_m3, referenz_annahmen)
    solar, _ = _solare_gewinne(referenz_bauteile)
    bilanz = _monatsbilanz(transmission["ht_gesamt_w_k"], lueftung["hv_w_k"],
                           solar, nutzflaeche_m2, referenz_annahmen)
    qw = referenz_annahmen.warmwasser_kwh_m2a * nutzflaeche_m2
    anlage = _anlage(bilanz["qh_kwh_a"], qw, referenz_annahmen,
                     REFERENZ_ANLAGE["erzeuger"], REFERENZ_ANLAGE["solar_ww_anteil"])

    return {
        "ht_gesamt_w_k": transmission["ht_gesamt_w_k"],
        "ht_spezifisch_w_m2k": round(transmission["ht_gesamt_w_k"] / huelle, 3),
        "qh_kwh_a": bilanz["qh_kwh_a"],
        "qw_kwh_a": round(qw, 0),
        "primaerenergie_kwh_a": anlage["primaerenergie_kwh_a"],
        "primaerenergie_kwh_m2a": round(
            anlage["primaerenergie_kwh_a"] / max(nutzflaeche_m2, 1e-6), 1),
        "anlage": anlage,
        "u_werte": {art: v["u"] for art, v in REFERENZ_WOHNGEBAEUDE.items()},
    }


# ── Der Ablauf ─────────────────────────────────────────────────────────────


def rechne(modell_daten: dict, ausgabe: Path, annahmen: Annahmen | None = None,
           melden=None) -> dict:
    """
    Die vollständige GEG-Bilanz — von der Bauteilliste bis zu den Nachweisen.

    Aufgebaut wie `rechnung.rechne()`: jeder Abschnitt schreibt in denselben
    `bericht`-Dict, Bilder gehen in `ausgabe`, und ein Abschnitt darf scheitern,
    ohne die Rechnung mitzureißen.
    """
    annahmen = annahmen or Annahmen()
    lauf = Lauf(melden)
    bilder = Bilder(Path(ausgabe))
    zeichnen.stil()

    lauf.schritt(0.05, "Gebäudemodell wird gelesen")
    gebaeude = Gebaeude.aus(modell_daten)

    if annahmen.gebaeudeart != "wohngebaeude":
        lauf.hinweis(
            "Als Nichtwohngebäude gekennzeichnet. Gerechnet wird trotzdem das "
            "Wohngebäudeverfahren nach DIN V 4108-6 — Beleuchtung, Kühlung und "
            "Lüftungsanlagen fehlen darin. Für den Nachweis ist DIN V 18599 zu führen."
        )
    if not annahmen.dichtheitspruefung and annahmen.luftwechsel_1h < 0.7:
        lauf.hinweis(
            f"Ohne Dichtheitsprüfung ist n = 0,70 1/h anzusetzen, eingetragen "
            f"sind {annahmen.luftwechsel_1h:.2f} 1/h. Die Bilanz fällt damit zu günstig aus."
        )

    huelle = gebaeude.huellflaeche_m2
    volumen = _volumen(gebaeude, annahmen, lauf)
    nutzflaeche = _nutzflaeche(volumen, annahmen)
    a_v = huelle / max(volumen, 1e-6)

    bericht: dict = {
        "titel": gebaeude.titel,
        "verfahren": "Monatsbilanz nach DIN V 4108-6, Anlagentechnik über Aufwandszahlen",
        "klima": "Referenzklima Potsdam (GEG § 22)",
        # Wandert mit dem Bericht in die Skizze und von dort in den Bauantrag.
        # Der Satz gehört an die Zahlen und nicht nur in die Oberfläche: eine
        # Kennwerttabelle wird herauskopiert, ein Bildschirmhinweis nicht.
        "einordnung": "VORBEMESSUNG",
        "einordnung_text": (
            "Vorbemessung zur Einordnung eines Entwurfs — kein geführter "
            "GEG-Nachweis. Die Anlagentechnik ist über pauschale Aufwandszahlen "
            "bewertet und nicht nach DIN V 4701-10 im Tabellenverfahren; das "
            "Verfahren ist nicht gegen die MoBi-Vorlage validiert. Für den "
            "Bauantrag ist der Nachweis mit einem dafür geeigneten Werkzeug zu "
            "führen (im GEG-Werkzeug unter „Nachweis führen“)."
        ),
        "plan": gebaeude.plan,
        "modell": gebaeude.modell,
        "annahmen": annahmen.als_bericht(),
        "geometrie": {
            "huellflaeche_m2": round(huelle, 2),
            "beheiztes_volumen_m3": round(volumen, 1),
            "nutzflaeche_m2": round(nutzflaeche, 2),
            "a_v_verhaeltnis_1m": round(a_v, 3),
            "bauteile": len(gebaeude.bauteile),
        },
        "warnungen": [],
    }

    # ── 1 Transmission ─────────────────────────────────────────────────────
    lauf.schritt(0.20, "Transmissionswärmeverluste")
    transmission = _transmission(gebaeude.bauteile, huelle, annahmen)
    ht_spezifisch = transmission["ht_gesamt_w_k"] / huelle
    transmission["ht_spezifisch_w_m2k"] = round(ht_spezifisch, 3)
    transmission["bauteile"] = [
        {"name": b.name, "art": b.art, "flaeche_m2": round(b.flaeche_m2, 2),
         "u_w_m2k": round(b.u_w_m2k, 3), "fx": round(b.faktor, 2),
         "ht_w_k": round(b.ht_w_k, 2), "orientierung": b.orientierung,
         "g_wert": b.g_wert, "global_id": b.global_id, "bemerkung": b.bemerkung}
        for b in sorted(gebaeude.bauteile, key=lambda x: -x.ht_w_k)
    ]
    bericht["transmission"] = transmission

    # ── 2 Lüftung ──────────────────────────────────────────────────────────
    lauf.schritt(0.30, "Lüftungswärmeverluste")
    lueftung = _lueftung(volumen, annahmen)
    bericht["lueftung"] = lueftung

    # ── 3 Gewinne und Monatsbilanz ─────────────────────────────────────────
    lauf.schritt(0.45, "Solare Gewinne und Monatsbilanz")
    solar, fensteraufstellung = _solare_gewinne(gebaeude.bauteile)
    bilanz = _monatsbilanz(transmission["ht_gesamt_w_k"], lueftung["hv_w_k"],
                           solar, nutzflaeche, annahmen)
    bericht["fenster"] = fensteraufstellung
    bericht["monatsbilanz"] = {k: v for k, v in bilanz.items() if not k.startswith("_")}

    qh = bilanz["qh_kwh_a"]
    bericht["heizwaerme"] = {
        "qh_kwh_a": qh,
        "qh_kwh_m2a": round(qh / max(nutzflaeche, 1e-6), 1),
    }

    # ── 4 Warmwasser und Anlagentechnik ────────────────────────────────────
    lauf.schritt(0.60, "Warmwasser und Anlagentechnik")
    qw = annahmen.warmwasser_kwh_m2a * nutzflaeche
    bericht["warmwasser"] = {
        "ansatz_kwh_m2a": annahmen.warmwasser_kwh_m2a,
        "qw_kwh_a": round(qw, 0),
    }
    anlage = _anlage(qh, qw, annahmen, annahmen.erzeuger,
                     annahmen.solar_ww_anteil, annahmen.pv_kwh_a)
    anlage["primaerenergie_kwh_m2a"] = round(
        anlage["primaerenergie_kwh_a"] / max(nutzflaeche, 1e-6), 1)
    anlage["endenergie_kwh_m2a"] = round(
        anlage["endenergie_kwh_a"] / max(nutzflaeche, 1e-6), 1)
    anlage["co2_kg_m2a"] = round(anlage["co2_kg_a"] / max(nutzflaeche, 1e-6), 1)
    bericht["anlage"] = anlage

    # ── 5 Referenzgebäude ──────────────────────────────────────────────────
    lauf.schritt(0.72, "Referenzgebäude nach GEG Anlage 1")
    referenz = _referenzgebaeude(gebaeude, annahmen, volumen, nutzflaeche)
    bericht["referenzgebaeude"] = referenz

    # ── 6 Nachweise ────────────────────────────────────────────────────────
    lauf.schritt(0.80, "Nachweise")
    qp_zul = referenz["primaerenergie_kwh_a"] * annahmen.anforderung_anteil
    ht_zul = referenz["ht_spezifisch_w_m2k"]

    nachweise: list[tuple[str, float]] = [
        ("Jahres-Primärenergiebedarf Qₚ", anlage["primaerenergie_kwh_a"] / max(qp_zul, 1e-6)),
        ("Transmissionswärmeverlust H_T'", ht_spezifisch / max(ht_zul, 1e-6)),
    ]

    bericht["nachweis"] = {
        "primaerenergie": {
            "ist_kwh_a": anlage["primaerenergie_kwh_a"],
            "ist_kwh_m2a": anlage["primaerenergie_kwh_m2a"],
            "zulaessig_kwh_a": round(qp_zul, 0),
            "zulaessig_kwh_m2a": round(qp_zul / max(nutzflaeche, 1e-6), 1),
            "anteil_referenz": annahmen.anforderung_anteil,
            "ausnutzung": round(anlage["primaerenergie_kwh_a"] / max(qp_zul, 1e-6), 3),
            "erfuellt": anlage["primaerenergie_kwh_a"] <= qp_zul,
        },
        "transmission": {
            "ist_w_m2k": round(ht_spezifisch, 3),
            "zulaessig_w_m2k": round(ht_zul, 3),
            "ausnutzung": round(ht_spezifisch / max(ht_zul, 1e-6), 3),
            "erfuellt": ht_spezifisch <= ht_zul,
        },
        "effizienzhaus": _effizienzhaus(anlage["primaerenergie_kwh_a"],
                                        referenz["primaerenergie_kwh_a"],
                                        ht_spezifisch, ht_zul),
    }
    bericht["nachweise"] = [{"name": n, "ausnutzung": round(w, 3)} for n, w in nachweise]
    bericht["nachweise_offen"] = [n for n, w in nachweise if w > 1.0]
    bericht["nachweis_max"] = round(max((w for _, w in nachweise), default=0.0), 3)

    # ── 7 Bilder ───────────────────────────────────────────────────────────
    lauf.schritt(0.88, "Bilder werden gezeichnet")
    with lauf.versuche("Bauteilbild"):
        _bild_bauteile(bilder, transmission, referenz)
    with lauf.versuche("Monatsbilanzbild"):
        _bild_monatsbilanz(bilder, bilanz)
    with lauf.versuche("Energiebilanzbild"):
        _bild_bilanz(bilder, transmission, lueftung, bilanz, qw, anlage)
    with lauf.versuche("Vergleich mit dem Referenzgebäude"):
        _bild_referenz(bilder, bericht, referenz, nutzflaeche)
    with lauf.versuche("Energieskala"):
        _bild_skala(bilder, anlage["endenergie_kwh_m2a"], gebaeude.titel)
    with lauf.versuche("Nachweisampel"):
        with bilder.figur("nachweise", "Nachweise", "Nachweise",
                          figsize=(8, 0.6 * len(nachweise) + 1.6)) as fig:
            ax = fig.add_subplot(111)
            zeichnen.ampel(ax, nachweise)
            ax.set_title(f"GEG-Nachweise — {gebaeude.titel}")
            fig.tight_layout()

    bericht["hinweise"] = lauf.hinweise
    bericht["bilder"] = bilder.als_liste()
    bericht["dauer_s"] = round(lauf.dauer, 1)

    lauf.schritt(1.0, f"fertig — {len(bericht['bilder'])} Bilder in {lauf.dauer:.1f} s")
    return bericht


def _effizienzhaus(qp_ist: float, qp_referenz: float,
                   ht_ist: float, ht_referenz: float) -> dict:
    """
    Die Einordnung als Effizienzhaus-Stufe.

    Maßgebend ist die *schlechtere* der beiden Kennzahlen: eine Stufe wird nur
    erreicht, wenn Primärenergie **und** Transmissionswärmeverlust sie halten.
    Der Hüllflächenwert darf dabei bei den Förderstufen 55 und 40 auf das
    0,7- bzw. 0,55-fache der Referenz — ein Haus lässt sich nicht allein über
    eine gute Heizung in eine Effizienzstufe rechnen.
    """
    anteil_qp = qp_ist / max(qp_referenz, 1e-6)
    anteil_ht = ht_ist / max(ht_referenz, 1e-6)
    stufen = [(0.40, "EH 40", 0.55), (0.55, "EH 55", 0.70),
              (0.70, "EH 70", 0.85), (0.85, "EH 85", 1.00),
              (1.00, "EH 100", 1.00)]
    erreicht = None
    for grenze_qp, name, grenze_ht in stufen:
        if anteil_qp <= grenze_qp and anteil_ht <= grenze_ht:
            erreicht = name
            break
    return {
        "stufe": erreicht or "über EH 100",
        "anteil_primaerenergie": round(anteil_qp, 3),
        "anteil_transmission": round(anteil_ht, 3),
    }


# ── Bildabschnitte ─────────────────────────────────────────────────────────


def _bild_bauteile(bilder: Bilder, transmission: dict, referenz: dict) -> None:
    """Wo die Wärme hinausgeht — nach Bauteilart, gegen die Referenz gestellt."""
    arten = transmission["nach_art"]
    if not arten:
        return
    namen = [a["art"].replace("_", " ") for a in arten]
    ht = [a["ht_w_k"] for a in arten]
    orte = np.arange(len(namen))[::-1]

    with bilder.figur("huelle_ht", "Transmission nach Bauteilart", "Hülle",
                      figsize=(9, 0.55 * len(namen) + 2.4)) as fig:
        ax = fig.add_subplot(111)
        ax.barh(orte, ht, color="#3B82F6", height=0.6)
        ax.set_yticks(orte)
        ax.set_yticklabels(namen)
        ax.set_xlabel("Transmissionswärmeverlust  H$_T$  [W/K]")
        for ort, wert, eintrag in zip(orte, ht, arten):
            ax.text(wert + max(ht) * 0.02, ort,
                    f"{wert:.0f} W/K   ({eintrag['flaeche_m2']:.0f} m², "
                    f"U = {eintrag['u_mittel_w_m2k']:.2f})",
                    va="center", fontsize=8)
        ax.set_xlim(0, max(ht) * 1.55)
        ax.grid(axis="x", alpha=0.25)
        ax.set_title("Wärmeverlust der Hüllflächen")
        fig.tight_layout()

    # U-Wert-Vergleich: der Entwurf gegen die Referenzausführung, Art für Art.
    vergleichbar = [a for a in arten if a["art"] in referenz["u_werte"]]
    if not vergleichbar:
        return
    with bilder.figur("huelle_u", "U-Werte gegen die Referenz", "Hülle",
                      figsize=(9, 0.55 * len(vergleichbar) + 2.4)) as fig:
        ax = fig.add_subplot(111)
        orte = np.arange(len(vergleichbar))[::-1]
        ist = [a["u_mittel_w_m2k"] for a in vergleichbar]
        soll = [referenz["u_werte"][a["art"]] for a in vergleichbar]
        ax.barh(orte + 0.18, ist, height=0.34, color="#3B82F6", label="Entwurf")
        ax.barh(orte - 0.18, soll, height=0.34, color="#9aa4b2", label="Referenz GEG")
        ax.set_yticks(orte)
        ax.set_yticklabels([a["art"].replace("_", " ") for a in vergleichbar])
        ax.set_xlabel("U-Wert  [W/(m²·K)]")
        ax.legend(loc="lower right", fontsize=8)
        ax.grid(axis="x", alpha=0.25)
        ax.set_title("Wärmedurchgang: Entwurf gegen Referenzgebäude")
        fig.tight_layout()


def _bild_monatsbilanz(bilder: Bilder, bilanz: dict) -> None:
    """Verluste, Gewinne und der Rest, der geheizt werden muss."""
    x = np.arange(12)
    kurz = [m[:3] for m in MONATE]
    with bilder.figur("monatsbilanz", "Monatsbilanz", "Bilanz",
                      figsize=(10, 5)) as fig:
        ax = fig.add_subplot(111)
        ax.bar(x - 0.22, bilanz["_verluste"], width=0.42,
               color="#EF4444", label="Wärmeverluste")
        ax.bar(x + 0.22, bilanz["_eta"] * bilanz["_gewinne"], width=0.42,
               color="#F59E0B", label="genutzte Gewinne")
        ax.plot(x, bilanz["_bedarf"], "o-", color="#111827", lw=1.8,
                ms=4, label="Heizwärmebedarf")
        ax.set_xticks(x)
        ax.set_xticklabels(kurz)
        ax.set_ylabel("Wärmemenge  [kWh/Monat]")
        ax.legend(fontsize=8)
        ax.grid(axis="y", alpha=0.25)
        ax.set_title(
            f"Monatsbilanz — Q$_h$ = {bilanz['qh_kwh_a']:.0f} kWh/a "
            f"({bilanz['heizmonate']} Heizmonate)"
        )
        fig.tight_layout()

    with bilder.figur("ausnutzung", "Ausnutzung der Gewinne", "Bilanz",
                      figsize=(10, 3.6)) as fig:
        ax = fig.add_subplot(111)
        ax.bar(x, bilanz["_eta"], color="#10B981", width=0.6)
        ax.set_xticks(x)
        ax.set_xticklabels(kurz)
        ax.set_ylim(0, 1.05)
        ax.set_ylabel("Ausnutzungsgrad  η  [–]")
        ax.grid(axis="y", alpha=0.25)
        ax.set_title(
            "Wie viel der Gewinne wirklich Heizwärme ersetzt "
            f"(Zeitkonstante {bilanz['zeitkonstante_h']:.0f} h)"
        )
        fig.tight_layout()


def _bild_bilanz(bilder: Bilder, transmission: dict, lueftung: dict,
                 bilanz: dict, qw: float, anlage: dict) -> None:
    """Die Jahresbilanz als zwei Säulen: was hinausgeht, was hineingeht."""
    ht = transmission["ht_gesamt_w_k"]
    hv = lueftung["hv_w_k"]
    anteil_t = ht / max(ht + hv, 1e-6)
    verlust_gesamt = bilanz["verluste_kwh_a"]

    raus = [("Transmission", verlust_gesamt * anteil_t, "#EF4444"),
            ("Lüftung", verlust_gesamt * (1 - anteil_t), "#F97316")]
    rein = [("solare Gewinne", float(np.where(bilanz["_heizt"],
                                              bilanz["_eta"] * np.array(
                                                  bilanz["solare_gewinne_kwh"]), 0).sum()),
             "#F59E0B"),
            ("interne Gewinne", float(np.where(bilanz["_heizt"],
                                               bilanz["_eta"] * np.array(
                                                   bilanz["interne_gewinne_kwh"]), 0).sum()),
             "#FBBF24"),
            ("Heizung", bilanz["qh_kwh_a"], "#3B82F6")]

    with bilder.figur("jahresbilanz", "Jahresbilanz", "Bilanz",
                      figsize=(7.5, 5.5)) as fig:
        ax = fig.add_subplot(111)
        for spalte, posten in ((0, raus), (1, rein)):
            unten = 0.0
            for name, wert, farbe in posten:
                ax.bar(spalte, wert, bottom=unten, width=0.55, color=farbe)
                if wert > verlust_gesamt * 0.04:
                    ax.text(spalte, unten + wert / 2,
                            f"{name}\n{wert:.0f} kWh", ha="center", va="center",
                            fontsize=8, color="white", fontweight="bold")
                unten += wert
        ax.set_xticks([0, 1])
        ax.set_xticklabels(["Wärmeverluste", "Wärmequellen"])
        ax.set_ylabel("Wärmemenge  [kWh/a]")
        ax.grid(axis="y", alpha=0.25)
        ax.set_title("Jahresbilanz der Heizperiode")
        fig.tight_layout()

    with bilder.figur("energiefluss", "Von der Heizwärme zur Primärenergie", "Anlage",
                      figsize=(9, 4.2)) as fig:
        ax = fig.add_subplot(111)
        stufen = [
            ("Nutzenergie\nHeizung", bilanz["qh_kwh_a"], "#3B82F6"),
            ("Nutzenergie\nWarmwasser", qw, "#60A5FA"),
            ("Endenergie", anlage["endenergie_kwh_a"], "#F59E0B"),
            ("Primärenergie", anlage["primaerenergie_kwh_a"], "#EF4444"),
        ]
        orte = np.arange(len(stufen))
        ax.bar(orte, [s[1] for s in stufen], color=[s[2] for s in stufen], width=0.6)
        for ort, (_, wert, _) in zip(orte, stufen):
            ax.text(ort, wert, f"  {wert:.0f}", ha="center", va="bottom", fontsize=9)
        ax.set_xticks(orte)
        ax.set_xticklabels([s[0] for s in stufen], fontsize=9)
        ax.set_ylabel("Energie  [kWh/a]")
        ax.grid(axis="y", alpha=0.25)
        ax.set_title(
            f"{anlage['erzeuger']} · {anlage['energietraeger']} "
            f"(f$_p$ = {anlage['fp']})"
        )
        fig.tight_layout()


def _bild_referenz(bilder: Bilder, bericht: dict, referenz: dict,
                   nutzflaeche: float) -> None:
    """Der eigentliche Nachweis als Bild: Entwurf, Grenzwert, Referenz."""
    nachweis = bericht["nachweis"]
    with bilder.figur("referenzvergleich", "Vergleich mit dem Referenzgebäude",
                      "Nachweise", figsize=(9, 4.4)) as fig:
        ax = fig.add_subplot(111)
        gruppen = ["Primärenergie\n[kWh/(m²·a)]", "H$_T$'\n[W/(m²·K)]"]
        orte = np.arange(2)
        ist = [nachweis["primaerenergie"]["ist_kwh_m2a"],
               nachweis["transmission"]["ist_w_m2k"]]
        zul = [nachweis["primaerenergie"]["zulaessig_kwh_m2a"],
               nachweis["transmission"]["zulaessig_w_m2k"]]
        ref = [referenz["primaerenergie_kwh_m2a"], referenz["ht_spezifisch_w_m2k"]]

        # Zwei Größen mit völlig verschiedenen Zahlenbereichen in einem Bild:
        # normiert auf den zulässigen Wert, dann steht die 1,0 für „gerade noch".
        ist_n = [i / max(z, 1e-9) for i, z in zip(ist, zul)]
        ref_n = [r / max(z, 1e-9) for r, z in zip(ref, zul)]

        farben = ["#4c9a2a" if v <= 1.0 else "#d13438" for v in ist_n]
        ax.bar(orte - 0.2, ist_n, width=0.36, color=farben, label="Entwurf")
        ax.bar(orte + 0.2, ref_n, width=0.36, color="#9aa4b2", label="Referenzgebäude")
        ax.axhline(1.0, color="k", ls="--", lw=1.2)
        ax.text(1.52, 1.02, "zulässig", fontsize=8, va="bottom", ha="right")

        for ort, (wert_n, wert) in zip(orte, zip(ist_n, ist)):
            ax.text(ort - 0.2, wert_n + 0.03, f"{wert:g}", ha="center", fontsize=8)
        for ort, (wert_n, wert) in zip(orte, zip(ref_n, ref)):
            ax.text(ort + 0.2, wert_n + 0.03, f"{wert:g}", ha="center",
                    fontsize=8, color="#555")

        ax.set_xticks(orte)
        ax.set_xticklabels(gruppen)
        ax.set_ylabel("bezogen auf den zulässigen Wert  [–]")
        ax.set_ylim(0, max(max(ist_n), max(ref_n), 1.2) * 1.25)
        ax.legend(fontsize=8, loc="upper right")
        ax.grid(axis="y", alpha=0.25)
        ax.set_title(
            f"GEG-Nachweis — {nachweis['effizienzhaus']['stufe']} "
            f"(zulässig: {nachweis['primaerenergie']['anteil_referenz']:.0%} der Referenz)"
        )
        fig.tight_layout()


def _bild_skala(bilder: Bilder, endenergie_kwh_m2a: float, titel: str) -> None:
    """
    Die Farbskala des Energieausweises — die eine Darstellung, die jeder kennt.

    Die Klassengrenzen stehen in GEG Anlage 10; sie beziehen sich auf den
    Endenergiebedarf je Quadratmeter Gebäudenutzfläche.
    """
    klassen = [("A+", 0, 30, "#009036"), ("A", 30, 50, "#4aa02c"),
               ("B", 50, 75, "#95c11f"), ("C", 75, 100, "#d7d700"),
               ("D", 100, 130, "#f9c700"), ("E", 130, 160, "#f5a000"),
               ("F", 160, 200, "#ee7f00"), ("G", 200, 250, "#e5540d"),
               ("H", 250, 300, "#cb1517")]
    with bilder.figur("energieskala", "Energieeffizienzklasse", "Nachweise",
                      figsize=(10, 2.6)) as fig:
        ax = fig.add_subplot(111)
        for name, von, bis, farbe in klassen:
            ax.barh(0, bis - von, left=von, height=0.6, color=farbe)
            ax.text((von + bis) / 2, 0, name, ha="center", va="center",
                    fontsize=9, color="white", fontweight="bold")
        ax.plot([endenergie_kwh_m2a], [0.48], marker="v", ms=13,
                color="#111827", clip_on=False)
        ax.text(endenergie_kwh_m2a, 0.62, f"{endenergie_kwh_m2a:.0f} kWh/(m²·a)",
                ha="center", fontsize=9, fontweight="bold")
        ax.set_xlim(0, 300)
        ax.set_ylim(-0.5, 0.9)
        ax.set_yticks([])
        ax.set_xlabel("Endenergiebedarf  [kWh/(m²·a)]")
        ax.set_title(f"Energieeffizienzklasse — {titel}")
        for rand in ("top", "right", "left"):
            ax.spines[rand].set_visible(False)
        fig.tight_layout()


# ── Beheiztes Volumen aus der Modellgeometrie ──────────────────────────────

# Verhältnis Nettoraumvolumen zu beheiztem Bruttovolumen V_e für Wohngebäude.
# Es ist eine Faustregel und keine Normkonstante — die Differenz sind die
# Wand-, Decken- und Dachquerschnitte, die V_e einschließt und die Summe der
# Raumvolumina nicht. Bei üblichen Wandstärken und Geschosshöhen liegt sie
# zwischen 0,75 und 0,85; 0,80 ist der Mittelwert daraus. Deshalb ist der Weg
# über die Geschossflächen der vorzuziehende: er misst das Bruttovolumen
# unmittelbar, statt es hochzurechnen.
NETTO_ZU_BRUTTO = 0.80

# Räume, die trotz `IfcSpace` nicht zum beheizten Volumen gehören. Verglichen
# wird normalisiert gegen Name und LongName. Bewusst kurz gehalten: was hier
# nicht steht, wird mitgezählt und ist in der Raumliste des Werkzeugs zu sehen
# — ein zu Unrecht mitgezählter Raum fällt dort auf, ein stillschweigend
# weggelassener nicht.
UNBEHEIZT_MUSTER = [
    "balkon", "terrasse", "loggia", "garage", "carport", "tiefgarage",
    "unbeheizt", "aussenbereich", "vordach", "laubengang",
]


def _anzahl(n: int, einzahl: str, mehrzahl: str) -> str:
    """„1 Raum" statt „1 Räume" — die Hinweise werden gelesen, nicht überflogen."""
    return f"{n} {einzahl if n == 1 else mehrzahl}"


def _unbeheizt(name: str | None, long_name: str | None) -> str | None:
    """Der Grund, warum ein Raum nicht zum beheizten Volumen zählt — sonst None."""
    text = _normalisiert(f"{name or ''} {long_name or ''}")
    for muster in UNBEHEIZT_MUSTER:
        if muster in text:
            return muster
    return None


def volumen_aus_geometrie(raeume: list[dict] | None,
                          geschosse: list[dict] | None) -> dict:
    """
    Beheiztes Volumen V_e und Nutzfläche A_N aus dem, was im IFC steht.

    Zwei unabhängige Wege, und der Unterschied zwischen ihnen ist kein Detail:

    * **Über die Räume** — die Summe der Raumvolumina, hochgerechnet über
      `NETTO_ZU_BRUTTO`. Sie ist ein Nettomaß und muss deshalb umgerechnet
      werden, beschreibt aber genau das, was V_e meint: den **beheizten**
      Bereich. Vorzugsweg, wo es Räume gibt.
    * **Über die Geschosse** — Bruttogrundfläche mal Geschosshöhe. Das braucht
      keine Umrechnung, umfasst aber alles, was die Deckenplatte überdeckt.

    **Der Geschossweg ist der Rückfall, nicht der Vorzug** — auch wenn er
    unmittelbar ein Bruttomaß liefert. Am `Ifc4_SampleHouse` misst die
    Bodenplatte 146 m², die drei Räume darauf zusammen 76 m²: die Platte reicht
    über die beheizte Zone hinaus, und V_e käme mit 444 m³ statt rund 333 m³
    um ein Drittel zu groß heraus. Eine Deckenplatte weiß nicht, wo geheizt
    wird; ein Raum weiß es.

    Liegen beide vor, gilt der Raumweg und die Geschosse bleiben als
    Kontrollzahl daneben stehen. Weichen sie um mehr als 15 % voneinander ab,
    ist eines von beiden im Modell unvollständig oder greift über die beheizte
    Zone hinaus — das ist ein Hinweis wert, denn nachgerechnet wird es sonst
    von niemandem.

    A_N bleibt **0,32 · V_e nach GEG § 20**, auch wenn das Modell Raumflächen
    führt. Das ist keine Bequemlichkeit: A_N ist eine Rechengröße des GEG und
    keine gemessene Fläche, und wer stattdessen die Nettogrundfläche einträgt,
    rechnet den flächenbezogenen Bedarf systematisch zu ungünstig. Die
    gemessenen Flächen kommen trotzdem mit heraus — zum Vergleichen.
    """
    hinweise: list[str] = []

    beheizt, unbeheizt = [], []
    for raum in raeume or []:
        grund = _unbeheizt(raum.get("name"), raum.get("long_name"))
        (unbeheizt if grund else beheizt).append({**raum, "grund": grund})

    volumen_raeume = float(sum(r.get("volumen_m3") or 0.0 for r in beheizt))
    flaeche_raeume = float(sum(r.get("flaeche_m2") or 0.0 for r in beheizt))

    volumen_geschosse = float(sum(
        (g.get("flaeche_m2") or 0.0) * (g.get("hoehe_m") or 0.0) for g in geschosse or []
    ))
    flaeche_geschosse = float(sum((g.get("flaeche_m2") or 0.0) for g in geschosse or []))
    ohne_flaeche = [g["name"] for g in geschosse or [] if not g.get("flaeche_m2")]

    if volumen_raeume > 0:
        volumen = volumen_raeume / NETTO_ZU_BRUTTO
        quelle = "raeume"
        hinweise.append(
            f"V_e aus {_anzahl(len(beheizt), 'Raumvolumen', 'Raumvolumina')} "
            f"({volumen_raeume:.0f} m³ netto), mit dem Faustwert "
            f"{NETTO_ZU_BRUTTO:.2f} auf Bruttomaß gebracht. Der Faktor steht für "
            "die Wand- und Deckenquerschnitte, die V_e einschließt und ein "
            "Raumvolumen nicht — er ist eine Praxisregel, keine Normkonstante."
        )
    elif volumen_geschosse > 0:
        volumen = volumen_geschosse
        quelle = "geschosse"
        hinweise.append(
            "Keine Räume im Modell — V_e aus Deckenfläche mal Geschosshöhe. "
            "Das umfasst alles, was die Deckenplatten überdecken; reichen sie "
            "über die beheizte Zone hinaus (Terrasse, Garage, Durchfahrt), ist "
            "das Volumen zu groß und von Hand zu kürzen."
        )
        if ohne_flaeche:
            hinweise.append(
                f"{_anzahl(len(ohne_flaeche), 'Geschoss', 'Geschosse')} ohne "
                f"erkennbare Deckenplatte ({', '.join(ohne_flaeche[:4])}) — sie "
                "gehen mit 0 m² ein und wirken in die Gegenrichtung."
            )
    else:
        return {
            "beheiztes_volumen_m3": None,
            "nutzflaeche_m2": None,
            "quelle": "keine",
            "hinweise": ["Weder Räume noch Geschossflächen im Modell — das "
                         "beheizte Volumen ist von Hand einzutragen."],
            "raeume": [], "unbeheizte_raeume": [], "geschosse": geschosse or [],
        }

    if volumen_raeume > 0 and volumen_geschosse > 0:
        brutto_aus_raeumen = volumen_raeume / NETTO_ZU_BRUTTO
        abweichung = abs(brutto_aus_raeumen - volumen_geschosse) / volumen_geschosse
        if abweichung > 0.15:
            hinweise.append(
                f"Die beiden Wege liegen {abweichung:.0%} auseinander: "
                f"{brutto_aus_raeumen:.0f} m³ aus den Raumvolumina gegen "
                f"{volumen_geschosse:.0f} m³ aus den Geschossflächen. Gerechnet "
                "wird mit dem ersten. Die Abweichung deutet entweder auf fehlende "
                "Räume oder auf Deckenplatten, die über die beheizte Zone "
                "hinausreichen — im Zweifel an der Raumliste unten prüfen."
            )

    if unbeheizt:
        namen = ", ".join(str(r.get("name") or r.get("long_name") or "?") for r in unbeheizt[:5])
        hinweise.append(
            f"{_anzahl(len(unbeheizt), 'Raum', 'Räume')} als unbeheizt gewertet und "
            f"nicht mitgezählt ({namen}). Stimmt das nicht, ist das Volumen von "
            "Hand zu setzen."
        )

    return {
        "beheiztes_volumen_m3": round(volumen, 1),
        "nutzflaeche_m2": round(0.32 * volumen, 1),
        "quelle": quelle,
        "volumen_raeume_netto_m3": round(volumen_raeume, 1) or None,
        "volumen_geschosse_m3": round(volumen_geschosse, 1) or None,
        "nettogrundflaeche_m2": round(flaeche_raeume, 1) or None,
        "bruttogrundflaeche_m2": round(flaeche_geschosse, 1) or None,
        "hinweise": hinweise,
        "raeume": beheizt,
        "unbeheizte_raeume": unbeheizt,
        "geschosse": geschosse or [],
    }


# ── Hüllflächen aus dem BIM-Modell ─────────────────────────────────────────

# Welcher IFC-Typ welche Bauteilart der Hülle ist. Bewusst grob: die
# Unterscheidung Außenwand/Innenwand kommt nicht aus dem Typ, sondern aus
# `IsExternal` — ein `IfcWall` allein sagt darüber nichts. Ebenso wenig sagt
# `IfcSlab`, ob eine Platte Dach, Geschossdecke oder Bodenplatte ist; das
# entscheidet `_platte_einordnen()` anhand ihrer Höhenlage im Bauwerk.
IFC_ARTEN = {
    "IfcWall": "aussenwand",
    "IfcWallStandardCase": "aussenwand",
    "IfcCurtainWall": "fenster",
    "IfcRoof": "dach",
    "IfcSlab": "dach",
    "IfcSlabStandardCase": "dach",
    "IfcWindow": "fenster",
    "IfcDoor": "tuer",
    "IfcPlate": "fenster",
}

# Feldnamen, unter denen die verschiedenen Werkzeuge denselben Wert ablegen.
# Verglichen wird normalisiert (klein, ohne Umlaute und Trenner) — dieselbe
# Regel wie in `ifc-role-properties.js` im Frontend. Die Reihenfolge ist
# bedeutsam: `_feldwert()` arbeitet sie von spezifisch nach allgemein ab.
FELD_U_WERT = ["uwert", "uvalue", "thermaltransmittance", "warmedurchgang",
               "heattransfercoefficient"]
FELD_FLAECHE = ["netsidearea", "netarea", "grosssidearea", "grossarea",
                "flaeche", "area"]
FELD_G_WERT = ["gwert", "gvalue", "solarheatgaincoefficient",
               "totalsolarenergytransmittance", "solartransmittance"]
FELD_EXTERN = ["isexternal", "aussenbauteil", "external"]


def _normalisiert(text: str) -> str:
    ersetzt = (text or "").lower()
    for alt, neu in (("ä", "a"), ("ö", "o"), ("ü", "u"), ("ß", "ss")):
        ersetzt = ersetzt.replace(alt, neu)
    return "".join(z for z in ersetzt if z.isalnum())


def _feldwert(psets: dict, muster: list[str]):
    """
    Sucht einen Wert über normalisierte Feldnamen in allen Property-Sets.

    **Erst exakt, dann als Teilstring, und beides in der Reihenfolge der
    Muster.** Das ist keine Feinheit, sondern der Unterschied zwischen einer
    brauchbaren und einer unbrauchbaren Bilanz: `GlazingAreaFraction`
    normalisiert zu `glazingareafraction` und enthält damit `area`. Eine reine
    Teilstringsuche greift bei einem Fenster deshalb den Glasflächen*anteil*
    0,7 ab, bevor sie `Area` = 12,0 m² erreicht — und ein Fenster mit 0,7 m²
    statt 12 m² fällt in keiner Summe auf, verfälscht aber Transmission und
    solare Gewinne um mehr als eine Größenordnung.

    Der exakte Durchgang zuerst löst das: `area` trifft `Area`, aber nicht
    `GlazingAreaFraction`. Erst wenn kein Feld exakt heißt, wird gesucht.
    """
    psets = psets or {}

    def felder():
        for pset in psets.values():
            if not isinstance(pset, dict):
                continue
            for schluessel, wert in pset.items():
                yield _normalisiert(str(schluessel)), wert

    paare = list(felder())
    for m in muster:
        for normal, wert in paare:
            if normal == m:
                return wert
    for m in muster:
        for normal, wert in paare:
            if m in normal:
                return wert
    return None


def _als_zahl(wert) -> float | None:
    if isinstance(wert, bool):
        return None
    if isinstance(wert, (int, float)):
        return float(wert)
    try:
        return float(str(wert).replace(",", ".").split()[0])
    except (ValueError, IndexError):
        return None


def _modellhuelle(geometrie: dict) -> dict | None:
    """Die Ausdehnung des ganzen Bauwerks als Bezug für Lageentscheidungen."""
    if not geometrie:
        return None
    lo = [min(box["lo"][i] for box in geometrie.values()) for i in range(3)]
    hi = [max(box["hi"][i] for box in geometrie.values()) for i in range(3)]
    return {"lo": lo, "hi": hi, "mitte": [(lo[i] + hi[i]) / 2.0 for i in range(3)]}


def _platte_einordnen(box: dict, modell: dict) -> tuple[str, str]:
    """
    Ob eine waagerechte Platte Dach, Bodenplatte oder Zwischendecke ist.

    Der IFC-Typ sagt es nicht: `IfcSlab` heißt beides, und `PredefinedType`
    steht nicht in den Property-Sets, sondern als Attribut an der Entität — die
    Bauteilablage führt es nicht. Was sie führt, ist die Bounding Box, und
    damit ist die Frage beantwortbar: eine Platte an der Oberkante des
    Bauwerks ist ein Dach, eine an der Unterkante die Bodenplatte.

    Die Schwelle ist ein Zehntel der Bauwerkshöhe. Bei einem zweigeschossigen
    Haus sind das gut sechzig Zentimeter — genug, um Aufbauhöhen und
    Attikaversprünge zu überbrücken, zu wenig, um ein ganzes Geschoss zu
    verschlucken.
    """
    hoehe = max(modell["hi"][2] - modell["lo"][2], 1e-6)
    toleranz = 0.1 * hoehe
    if box["hi"][2] >= modell["hi"][2] - toleranz:
        return "dach", ""
    if box["lo"][2] <= modell["lo"][2] + toleranz:
        return "boden_erdreich", "als Bodenplatte eingeordnet (unterste Lage im Modell)"
    return "decke_unbeheizt", ("waagerechte Platte in mittlerer Höhe — als Decke "
                              "gegen unbeheizt gewertet, im Zweifel prüfen")


def _orientierung_aus_box(box: dict, modell: dict) -> tuple[str | None, str]:
    """
    Die Himmelsrichtung eines Fensters aus der Lage seines Hüllquaders.

    Ein Fenster ist flach: eine seiner drei Kanten ist um ein Vielfaches kürzer
    als die anderen beiden, und sie zeigt in Richtung der Flächennormalen. Ist
    das die Hochachse, liegt das Fenster waagerecht — ein Dachfenster. Sonst
    entscheidet die kürzeste der beiden Grundrisskanten über die Achse und die
    Lage gegenüber der Bauwerksmitte über das Vorzeichen: ein Fenster östlich
    der Mitte, dessen Normale in Ost-West-Richtung zeigt, schaut nach Osten.

    **Das gilt für rechtwinklige, achsparallel modellierte Bauten.** Bei einer
    gedrehten oder gerundeten Fassade ist die Bounding Box nicht mehr flach,
    und die Funktion sagt das, statt zu raten: sie gibt `None` zurück, und der
    Aufrufer trägt den Mangel ein. Ein falsches „Süd" verdreifacht die solaren
    Gewinne gegenüber Nord — das ist der teuerste stille Fehler in dieser
    ganzen Rechnung.

    X ist Ost, Y ist Nord: das tile-lokale System aus `tiling/section.py`.
    """
    dx, dy, dz = (box["hi"][i] - box["lo"][i] for i in range(3))
    mitte = [(box["lo"][i] + box["hi"][i]) / 2.0 for i in range(3)]

    if dz <= 0.35 * min(dx, dy):
        return "horizontal", "waagerecht eingebaut — als Dachfenster gewertet"

    kurz, lang = min(dx, dy), max(dx, dy)
    # Bei einem schräg im Grundriss stehenden Fenster sind beide Grundrisskanten
    # ähnlich lang; dann sagt die Box über die Normale nichts mehr aus.
    if kurz > 0.4 * lang:
        return None, ""

    if dx < dy:
        return ("ost", "") if mitte[0] >= modell["mitte"][0] else ("west", "")
    return ("nord", "") if mitte[1] >= modell["mitte"][1] else ("sued", "")


def huelle_aus_bauteilen(bauteile: list[dict], vorgabe_u: dict | None = None,
                         nur_extern: bool = True,
                         geometrie: dict | None = None) -> dict:
    """
    Macht aus einer Liste von IFC-Bauteilen die Hüllflächenliste der Bilanz.

    Erwartet je Bauteil `{global_id, ifc_type, name, psets}` — genau das, was
    `GET /assets/{job}/elements/{global_id}` liefert. `geometrie` ist optional
    und bildet `global_id` auf `{lo, hi}` der Bounding Box ab, so wie
    `tiling/section.build_index()` sie führt; damit werden Plattenart und
    Fensterorientierung bestimmt, die aus den Property-Sets nicht hervorgehen.

    Zurück kommt ein Verzeichnis mit drei Listen: `bauteile` im Format von
    `Bauteil.aus()`, `maengel` als Text für den Menschen und `ausgeschlossen`
    mit je einem Grund. Die letzte ist nicht Zierde, sondern die Grundlage der
    Hüllflächen-Hervorhebung im Viewer: dass ein Bauteil *nicht* in der Bilanz
    steht, sieht man in der Bauteilliste nicht — im Modell schon.

    **`IsExternal` entscheidet, und zwar für jede Bauteilart.** Ein Bauteil
    ohne diese Angabe gehört nicht in die Hülle: die Alternative wäre, aus dem
    Typ zu schließen, und dann landet jede Zimmerwand darin und H_T verdoppelt
    sich. Bei Fenstern und Türen wurde früher eine Ausnahme gemacht — sie
    liegen ja fast immer in einer Außenwand —, aber „fast immer" ist bei einer
    Innentür schlicht falsch, und die Ausnahme machte die Hüllfläche zu einer
    Größe, deren Zustandekommen man dem Ergebnis nicht mehr ansah. Wo die
    Angabe fehlt, ist sie im Modell nachzutragen; jedes ausgeschlossene Bauteil
    steht namentlich in `ausgeschlossen` und lässt sich dort hervorheben.

    **Was hier bewusst nicht passiert: raten.** Fehlt der U-Wert, wird der
    Vorgabewert der Bauteilart eingesetzt und das im Feld `bemerkung`
    vermerkt; fehlt die Fläche, fällt das Bauteil heraus und steht in der
    Mängelliste. Eine erfundene Fläche fällt in der Bilanz niemandem auf, ein
    fehlendes Bauteil schon.
    """
    vorgabe_u = vorgabe_u or {art: v["u"] for art, v in REFERENZ_WOHNGEBAEUDE.items()}
    geometrie = geometrie or {}
    modell = _modellhuelle(geometrie)

    ergebnis: list[dict] = []
    maengel: list[str] = []
    ausgeschlossen: list[dict] = []
    ohne_orientierung: list[str] = []
    ohne_extern = 0

    def verwerfen(eintrag, name, art, grund):
        ausgeschlossen.append({
            "global_id": eintrag.get("global_id"),
            "name": name,
            "ifc_type": eintrag.get("ifc_type") or eintrag.get("type") or "",
            "art": art,
            "grund": grund,
        })

    for eintrag in bauteile or []:
        typ = eintrag.get("ifc_type") or eintrag.get("type") or ""
        art = IFC_ARTEN.get(typ)
        name = eintrag.get("name") or typ or "Bauteil"
        psets = eintrag.get("psets") or {}

        if not art:
            continue  # kein Hüllbauteiltyp — gar nicht erst zur Debatte

        box = geometrie.get(eintrag.get("global_id"))

        if nur_extern:
            extern = _feldwert(psets, FELD_EXTERN)
            if extern is not True:
                if extern is None:
                    ohne_extern += 1
                    verwerfen(eintrag, name, art, "ohne IsExternal im Modell")
                else:
                    verwerfen(eintrag, name, art, "IsExternal = falsch — Innenbauteil")
                continue

        # Erst jetzt, wo das Bauteil als Hülle feststeht, lohnt die Frage, was
        # für eine Hülle es ist: eine Platte kann Dach, Bodenplatte oder
        # auskragende Decke sein, und die drei haben verschiedene
        # Temperaturkorrekturfaktoren.
        art_bemerkung = ""
        if typ in ("IfcSlab", "IfcSlabStandardCase") and box and modell:
            art, art_bemerkung = _platte_einordnen(box, modell)

        flaeche = _als_zahl(_feldwert(psets, FELD_FLAECHE))
        if not flaeche or flaeche <= 0:
            maengel.append(f"{name}: keine Fläche im Modell — übersprungen")
            verwerfen(eintrag, name, art, "keine Fläche in den Property-Sets")
            continue

        u_wert = _als_zahl(_feldwert(psets, FELD_U_WERT))
        bemerkungen = [art_bemerkung] if art_bemerkung else []
        if not u_wert or u_wert <= 0:
            u_wert = vorgabe_u.get(art, 0.28)
            bemerkungen.append("U-Wert nicht im Modell — Vorgabewert der Bauteilart")

        bauteil = {
            "name": name,
            "art": art,
            "flaeche_m2": round(flaeche, 3),
            "u_w_m2k": round(u_wert, 3),
            "global_id": eintrag.get("global_id"),
            "bemerkung": " · ".join(bemerkungen),
        }

        if art in ("fenster", "dachfenster"):
            g = _als_zahl(_feldwert(psets, FELD_G_WERT))
            bauteil["g_wert"] = round(g, 2) if g and 0 < g <= 1 else 0.60

            richtung, hinweis = (None, "")
            if box and modell:
                richtung, hinweis = _orientierung_aus_box(box, modell)
            if richtung == "horizontal":
                bauteil["art"] = "dachfenster"
            if richtung:
                bauteil["orientierung"] = richtung
                if hinweis:
                    bauteil["bemerkung"] = " · ".join(
                        [b for b in (bauteil["bemerkung"], hinweis) if b])
            else:
                # Ohne Geometrie oder bei schräg stehender Fassade bleibt es beim
                # mittleren Wert. Ein stillschweigendes „Süd" wäre die bequemste
                # und falscheste Wahl: es verdreifacht die solaren Gewinne
                # gegenüber Nord und macht die Bilanz um zweistellige Prozente
                # zu günstig.
                bauteil["orientierung"] = eintrag.get("orientierung") or "ost"
                ohne_orientierung.append(name)

        ergebnis.append(bauteil)

    if ohne_extern:
        maengel.append(
            f"{_anzahl(ohne_extern, 'Bauteil', 'Bauteile')} ohne `IsExternal` — "
            "nicht als Hülle gewertet. Die Angabe steht im Modell in "
            "`Pset_WallCommon`, `Pset_SlabCommon` usw.; fehlt sie, lässt sich Außen "
            "nicht von Innen unterscheiden. Über „Ausgeschlossene zeigen“ sind die "
            "betroffenen Bauteile im Modell zu sehen."
        )
    if ohne_orientierung:
        maengel.append(
            f"{_anzahl(len(ohne_orientierung), 'transparentes Bauteil', 'transparente Bauteile')} "
            "ohne bestimmbare "
            "Orientierung — vorläufig als Ost angesetzt. Bei achsparallelen Bauten "
            "kommt sie aus der Bauteillage; hier war der Hüllquader dafür zu wenig "
            "flach (gedrehte oder gerundete Fassade). Von Hand je Fenster setzen, "
            "sonst stimmen die solaren Gewinne nicht."
        )
    if not geometrie:
        maengel.append(
            "Ohne Modellgeometrie gerechnet: Plattenart (Dach/Bodenplatte) und "
            "Fensterorientierung konnten nicht aus der Bauteillage bestimmt werden."
        )

    return {"bauteile": ergebnis, "maengel": maengel, "ausgeschlossen": ausgeschlossen}


# ── Eigenständiger Aufruf ──────────────────────────────────────────────────


def _handprobe_modellauswertung() -> int:  # pragma: no cover — Handprobe
    """
    Prüft die Ableitungen aus der Modellgeometrie ohne IFC-Datei und ohne Server.

    Geprüft wird, was still falsch werden kann: eine Himmelsrichtung, eine als
    Dach durchgehende Bodenplatte, eine Innenwand in der Hülle, ein
    beheiztes Volumen aus dem falschen der beiden Wege. Keins davon wirft eine
    Ausnahme, alle vier verschieben das Ergebnis um zweistellige Prozente.

    Aufruf: `python3 -m ileen.energie --pruefen`
    """
    fehler = 0

    def pruefe(name, ist, soll):
        nonlocal fehler
        ok = ist == soll
        if not ok:
            fehler += 1
        print(f"{'✓' if ok else '✗'} {name}" + ("" if ok else f"   ist {ist!r}, soll {soll!r}"))

    modell = {"lo": [-10, -5, 0], "hi": [10, 5, 8], "mitte": [0, 0, 4]}
    print("── Orientierung aus der Bauteillage " + "─" * 25)
    for soll, box in (
        ("ost",  {"lo": [9.8, -1, 1], "hi": [10.0, 1, 3]}),
        ("west", {"lo": [-10.0, -1, 1], "hi": [-9.8, 1, 3]}),
        ("nord", {"lo": [-1, 4.8, 1], "hi": [1, 5.0, 3]}),
        ("sued", {"lo": [-1, -5.0, 1], "hi": [1, -4.8, 3]}),
        ("horizontal", {"lo": [-1, -1, 7.9], "hi": [1, 1, 8.0]}),
    ):
        pruefe(f"Fenster nach {soll}", _orientierung_aus_box(box, modell)[0], soll)
    pruefe("Schräg stehendes Fenster wird nicht geraten",
           _orientierung_aus_box({"lo": [0, 0, 1], "hi": [1.5, 1.4, 3]}, modell)[0], None)

    print("\n── Plattenart aus der Höhenlage " + "─" * 29)
    for soll, box in (
        ("dach", {"lo": [-10, -5, 7.6], "hi": [10, 5, 8.0]}),
        ("boden_erdreich", {"lo": [-10, -5, 0.0], "hi": [10, 5, 0.4]}),
        ("decke_unbeheizt", {"lo": [-10, -5, 3.8], "hi": [10, 5, 4.0]}),
    ):
        pruefe(f"Platte als {soll}", _platte_einordnen(box, modell)[0], soll)

    print("\n── IsExternal entscheidet " + "─" * 35)
    huelle = huelle_aus_bauteilen([
        {"global_id": "W1", "ifc_type": "IfcWall", "name": "Außenwand",
         "psets": {"P": {"IsExternal": True, "ThermalTransmittance": 0.2},
                   "Q": {"NetSideArea": 45.0}}},
        {"global_id": "W2", "ifc_type": "IfcWall", "name": "Zimmerwand",
         "psets": {"P": {"IsExternal": False}, "Q": {"NetSideArea": 22.0}}},
        {"global_id": "T1", "ifc_type": "IfcDoor", "name": "Innentür",
         "psets": {"P": {"IsExternal": False}, "Q": {"Area": 2.0}}},
        {"global_id": "F1", "ifc_type": "IfcWindow", "name": "Fenster",
         "psets": {"P": {"IsExternal": True, "GlazingAreaFraction": 0.7},
                   "Q": {"Area": 12.0}}},
    ], geometrie={"W1": {"lo": [9.5, -5, 0], "hi": [10, 5, 8]},
                  "F1": {"lo": [9.8, -1, 1], "hi": [10.0, 1, 3]}})
    pruefe("Nur die Außenbauteile bleiben",
           sorted(b["global_id"] for b in huelle["bauteile"]), ["F1", "W1"])
    pruefe("Auch eine Innentür fliegt heraus",
           sorted(a["global_id"] for a in huelle["ausgeschlossen"]), ["T1", "W2"])
    # Die Falle von 2026-08: `GlazingAreaFraction` enthält `area` und wurde vor
    # der exakten Vorrunde als Fensterfläche gelesen — 0,7 m² statt 12 m².
    pruefe("Der Glasflächenanteil gilt nicht als Fläche",
           [b["flaeche_m2"] for b in huelle["bauteile"] if b["global_id"] == "F1"], [12.0])

    print("\n── Beheiztes Volumen " + "─" * 40)
    raeume = [{"name": "0.1", "long_name": "Wohnen", "volumen_m3": 120.0, "flaeche_m2": 48.0},
              {"name": "0.2", "long_name": "Balkon", "volumen_m3": 20.0, "flaeche_m2": 8.0}]
    geschosse = [{"name": "EG", "flaeche_m2": 60.0, "hoehe_m": 3.0}]
    mit_raeumen = volumen_aus_geometrie(raeume, geschosse)
    pruefe("Räume haben Vorrang vor den Geschossen", mit_raeumen["quelle"], "raeume")
    pruefe("Der Balkon zählt nicht zum beheizten Volumen",
           mit_raeumen["beheiztes_volumen_m3"], round(120.0 / NETTO_ZU_BRUTTO, 1))
    pruefe("A_N ist 0,32 · V_e nach GEG § 20", mit_raeumen["nutzflaeche_m2"],
           round(0.32 * mit_raeumen["beheiztes_volumen_m3"], 1))
    ohne_raeume = volumen_aus_geometrie([], geschosse)
    pruefe("Ohne Räume gilt Deckenfläche × Geschosshöhe",
           (ohne_raeume["quelle"], ohne_raeume["beheiztes_volumen_m3"]), ("geschosse", 180.0))
    pruefe("Ohne beides wird nichts erfunden",
           volumen_aus_geometrie([], [])["beheiztes_volumen_m3"], None)

    print("\n" + ("Alle Prüfungen bestanden." if not fehler
                  else f"{fehler} Prüfung(en) fehlgeschlagen."))
    return fehler


if __name__ == "__main__":  # pragma: no cover — Handprobe
    import json
    import sys

    if "--pruefen" in sys.argv:
        raise SystemExit(1 if _handprobe_modellauswertung() else 0)

    beispiel = {
        "titel": "Beispiel — Einfamilienhaus",
        "bauteile": [
            {"name": "Außenwand", "art": "aussenwand", "flaeche_m2": 210.0, "u_w_m2k": 0.20},
            {"name": "Dach", "art": "dach", "flaeche_m2": 120.0, "u_w_m2k": 0.16},
            {"name": "Bodenplatte", "art": "boden_erdreich", "flaeche_m2": 100.0, "u_w_m2k": 0.25},
            {"name": "Fenster Süd", "art": "fenster", "flaeche_m2": 22.0,
             "u_w_m2k": 0.95, "g_wert": 0.55, "orientierung": "sued"},
            {"name": "Fenster Ost", "art": "fenster", "flaeche_m2": 8.0,
             "u_w_m2k": 0.95, "g_wert": 0.55, "orientierung": "ost"},
            {"name": "Fenster West", "art": "fenster", "flaeche_m2": 8.0,
             "u_w_m2k": 0.95, "g_wert": 0.55, "orientierung": "west"},
            {"name": "Fenster Nord", "art": "fenster", "flaeche_m2": 6.0,
             "u_w_m2k": 0.95, "g_wert": 0.55, "orientierung": "nord"},
            {"name": "Haustür", "art": "tuer", "flaeche_m2": 2.5, "u_w_m2k": 1.20},
        ],
    }
    ziel = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/geg-probe")
    ergebnis = rechne(beispiel, ziel, Annahmen(
        beheiztes_volumen_m3=650.0,
        erzeuger="waermepumpe_luft",
        lueftung_wrg=0.8,
    ), melden=lambda a, t: print(f"  {a:5.0%}  {t}"))
    print(json.dumps({k: v for k, v in ergebnis.items()
                      if k in ("geometrie", "heizwaerme", "anlage", "nachweis")},
                     indent=2, ensure_ascii=False))
