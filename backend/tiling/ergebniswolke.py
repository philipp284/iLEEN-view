"""
Ergebnisfelder einer Statikrechnung als Punktwolke im 3D-Viewer.

Die Bilder eines FE-Laufs sind Draufsichten: richtig für einen Bericht,
unbrauchbar, um zu sehen, welche Decke in welchem Geschoss stark beansprucht
ist. Dieses Modul legt die Werte dorthin, wo das Bauwerk steht — als PNTS-Tile,
das im Viewer über dem IFC-Tileset liegt und dessen Farbe das gewählte Feld
zeigt.

## Warum PNTS und nicht ein farbiges Mesh

Ein Ergebnisfeld ist Punktdaten: ein Wert je Elementmitte oder Knoten, und
genau diese Streuung soll sichtbar bleiben. Ein Mesh müsste dazwischen
interpolieren und würde die Netzstruktur verwischen — die man sehen will, weil
sie sagt, wie fein gerechnet wurde. PNTS ist außerdem das Format, das der
Viewer ohnehin lädt (`pointcloud.js` erkennt es selbst) und das ohne
zusätzliche Extension auskommt.

Die Punktgröße ist nicht Teil des Formats, sondern eine Viewer-Einstellung —
`pointCloudShading.attenuation` sorgt dafür, dass die Wolke aus der Nähe
körnig, aus der Ferne geschlossen wirkt.

## Die Verortung ist der heikle Teil

Die FE-Rechnung läuft in der Zeichenebene: x und y wie im Grundriss, z von der
Plattenunterkante nach oben. Das Tileset des IFC-Modells steht dagegen im
tile-lokalen System, das um den Modellschwerpunkt zentriert ist.

Die Umrechnung ist einfacher, als sie klingt, und das ist kein Zufall: im
Grundriss ist die Abbildung von 3D in die Zeichenebene die Identität in x und y
(`section._plane` setzt nur die z-Verschiebung). Es bleibt also

    x_tile = x_plan,   y_tile = y_plan,   z_tile = z_unterkante + z_plan

und `z_unterkante` kommt aus der Hüllbox der Slab, nicht aus der Schnitthöhe —
die liegt fünf Zentimeter unter der Oberkante und wäre um die Plattendicke
daneben.

**Das Placement muss das des Quellmodells sein.** Ein eigenes Default-Placement
setzte die Wolke an den konfigurierten Referenzpunkt statt an das Gebäude; sie
läge dann irgendwo in der Nähe, und der Fehler fiele erst auf, wenn jemand
hineinzoomt.

## Eine Farbe ohne Legende ist ein Ornament

Die Wolke ist erst dann ein Werkzeug, wenn zu jeder Farbe der Wert steht, für
den sie steht. `aufbauen()` gibt deshalb nicht nur ein Protokoll zurück,
sondern legt neben `tile.pnts` eine `skala.json` ab: die Stufen mit ihren
Grenzen, die Einheit, die tatsächlichen Extremwerte und die Ausdehnung im
tile-lokalen System. Der Viewer zeichnet daraus die Legende und kann einen
angeklickten Punkt der richtigen Wolke zuordnen, ohne die Rechnung zu kennen.

**Diskrete Stufen statt stetigem Verlauf** — jedenfalls bei der Durchbiegung.
Ein stetiger Verlauf zeigt die Form der Biegefläche, aber man kann ihm keinen
Wert ablesen: zwischen zwei ähnlichen Blautönen liegt womöglich ein Millimeter
oder ein Zehntel. Sechzehn abgesetzte Farben machen aus der Fläche ein
Höhenlinienbild — die Grenze zwischen zwei Stufen ist eine Isolinie, und die
Legende sagt, welcher Wert dort steht. Für Momente bleibt der stetige
divergente Verlauf richtig, weil dort die Lage der Nulllinie zählt und nicht
der Zahlenwert.
"""

from __future__ import annotations

import json
import logging
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import georef

logger = logging.getLogger(__name__)

_HEADER_SIZE = 28

#: Standardzahl der Farbstufen, wenn ein Feld quantisiert dargestellt wird.
STUFEN_STANDARD = 16


@dataclass(frozen=True)
class Feld:
    """
    Eine darstellbare Ergebnisgröße.

    `symmetrisch` entscheidet über die Farbskala und ist keine Schönheitsfrage:
    bei einem Moment bedeutet das Vorzeichen, auf welcher Seite die Bewehrung
    liegt. Eine Skala, die von min bis max läuft, legt die Farbmitte irgendwohin
    und macht Feld- und Stützbereich ununterscheidbar.

    `stufen` = 0 heißt stetiger Verlauf, sonst so viele abgesetzte Farben.

    `ableitung` benennt eine Größe, die nicht in der `felder.npz` steht,
    sondern aus einer anderen entsteht — bisher nur die Biegerandspannung aus
    dem Moment und der Plattendicke.
    """

    schluessel: str          # Name in der felder.npz
    raster: str              # "knoten" | "element"
    beschriftung: str        # ohne Einheit, die steht daneben
    einheit: str
    verlauf: str             # regenbogen[_r] | divergent | warm | kalt
    symmetrisch: bool
    stufen: int
    gruppe: str
    ableitung: str | None = None
    # Für die Kreuztabelle der Punktabfrage: x/y und oben/unten. Ohne sie
    # müsste das Frontend die Beschriftung nach „_x" und „oben" durchsuchen —
    # eine Kopplung an Wortlaute, die beim ersten Umbenennen bricht.
    richtung: str | None = None
    lage: str | None = None

    @property
    def titel(self) -> str:
        return f"{self.beschriftung} [{self.einheit}]" if self.einheit else self.beschriftung


#: Welche Felder darstellbar sind.
#:
#: Die Durchbiegung läuft auf einem **umgekehrten** Regenbogen: eine Senkung ist
#: negativ, und ohne Umkehr bekäme die stärkste Senkung die kälteste Farbe. Rot
#: steht hier wie in jedem FE-Programm für „am meisten".
FELDER: dict[str, Feld] = {
    "durchbiegung": Feld(
        "w_qs", "knoten", "Durchbiegung w (quasi-ständig)", "mm",
        "regenbogen_r", False, STUFEN_STANDARD, "Verformung"),
    "durchbiegung_gzt": Feld(
        "w_gzt", "knoten", "Durchbiegung w (GZT)", "mm",
        "regenbogen_r", False, STUFEN_STANDARD, "Verformung"),

    "moment_x": Feld("m_x", "element", "m_x", "kNm/m", "divergent", True, 0,
                     "Momente", richtung="x"),
    "moment_y": Feld("m_y", "element", "m_y", "kNm/m", "divergent", True, 0,
                     "Momente", richtung="y"),
    "moment_xy": Feld("m_xy", "element", "m_xy", "kNm/m", "divergent", True, 0, "Momente"),
    "moment_x_max": Feld("m_x_max", "element", "m_x Einhüllende max", "kNm/m",
                         "divergent", True, 0, "Momente"),
    "moment_x_min": Feld("m_x_min", "element", "m_x Einhüllende min", "kNm/m",
                         "divergent", True, 0, "Momente"),
    "moment_y_max": Feld("m_y_max", "element", "m_y Einhüllende max", "kNm/m",
                         "divergent", True, 0, "Momente"),
    "moment_y_min": Feld("m_y_min", "element", "m_y Einhüllende min", "kNm/m",
                         "divergent", True, 0, "Momente"),

    # Biegerandspannung im ungerissenen Querschnitt — ein Anhaltswert, keine
    # Stahlbetonspannung. Siehe `_biegespannung()`.
    "spannung_x": Feld("m_x", "element", "σ_x Biegerand (Zustand I)", "N/mm²",
                       "divergent", True, 0, "Biegerandspannung",
                       ableitung="biegespannung", richtung="x"),
    "spannung_y": Feld("m_y", "element", "σ_y Biegerand (Zustand I)", "N/mm²",
                       "divergent", True, 0, "Biegerandspannung",
                       ableitung="biegespannung", richtung="y"),

    "bewehrung_x_unten": Feld("a_s_a_sx_unten", "element", "a_sx unten", "cm²/m",
                              "warm", False, 0, "Bewehrung", richtung="x", lage="unten"),
    "bewehrung_x_oben": Feld("a_s_a_sx_oben", "element", "a_sx oben", "cm²/m",
                             "warm", False, 0, "Bewehrung", richtung="x", lage="oben"),
    "bewehrung_y_unten": Feld("a_s_a_sy_unten", "element", "a_sy unten", "cm²/m",
                              "warm", False, 0, "Bewehrung", richtung="y", lage="unten"),
    "bewehrung_y_oben": Feld("a_s_a_sy_oben", "element", "a_sy oben", "cm²/m",
                             "warm", False, 0, "Bewehrung", richtung="y", lage="oben"),
}


# ── Farbskalen ────────────────────────────────────────────────────────────

#: Die Verläufe als Stützstellen (Anteil, RGB 0…1); dazwischen wird linear
#: interpoliert. Als Tabelle statt als Formel, weil ein Regenbogen sich nicht
#: sinnvoll aus drei Geraden ergibt und die Stützstellen genau die Farben sind,
#: die in der Legende erscheinen sollen.
_STUETZSTELLEN: dict[str, list[tuple[float, tuple[float, float, float]]]] = {
    # Blau · Weiß · Rot, Mitte fest bei null. Für Momente, bei denen das
    # Vorzeichen die Bewehrungslage bestimmt.
    "divergent": [
        (0.00, (0.13, 0.28, 0.72)),
        (0.25, (0.42, 0.62, 0.88)),
        (0.50, (0.97, 0.97, 0.97)),
        (0.75, (0.92, 0.52, 0.40)),
        (1.00, (0.70, 0.09, 0.15)),
    ],
    # Hell nach dunkelrot. Für Größen, die nur positiv sind und bei denen
    # „viel" schlecht ist (Bewehrung).
    "warm": [
        (0.00, (1.00, 0.97, 0.87)),
        (0.35, (0.99, 0.80, 0.45)),
        (0.70, (0.93, 0.42, 0.19)),
        (1.00, (0.55, 0.05, 0.06)),
    ],
    # Hell nach dunkelblau. Für Verformungen, wenn kein Regenbogen gewollt ist.
    "kalt": [
        (0.00, (0.94, 0.97, 1.00)),
        (0.40, (0.55, 0.77, 0.92)),
        (0.75, (0.20, 0.46, 0.74)),
        (1.00, (0.03, 0.19, 0.42)),
    ],
    # Der klassische Regenbogen: Violett · Blau · Cyan · Grün · Gelb · Orange ·
    # Rot. Wissenschaftlich verrufen, weil er in stetiger Form Helligkeits-
    # sprünge erfindet — genau deshalb ist er in **abgesetzten Stufen** gut:
    # jede Stufe ist von ihrer Nachbarin sicher unterscheidbar, und mehr
    # verlangt eine Höhenlinienkarte nicht.
    "regenbogen": [
        (0.000, (0.29, 0.00, 0.51)),
        (0.143, (0.15, 0.15, 0.85)),
        (0.286, (0.00, 0.55, 0.95)),
        (0.429, (0.00, 0.80, 0.75)),
        (0.571, (0.35, 0.85, 0.20)),
        (0.714, (0.95, 0.90, 0.10)),
        (0.857, (0.98, 0.55, 0.05)),
        (1.000, (0.80, 0.05, 0.05)),
    ],
}


def _farbe(verlauf: str, t: np.ndarray) -> np.ndarray:
    """Anteile 0…1 auf RGB abbilden. Suffix `_r` kehrt den Verlauf um."""
    name = verlauf[:-2] if verlauf.endswith("_r") else verlauf
    stuetzen = _STUETZSTELLEN.get(name) or _STUETZSTELLEN["kalt"]
    if verlauf.endswith("_r"):
        t = 1.0 - t

    anteile = np.array([s[0] for s in stuetzen])
    kanaele = np.array([s[1] for s in stuetzen])
    return np.stack([np.interp(t, anteile, kanaele[:, k]) for k in range(3)], axis=1)


def _hex(rgb) -> str:
    return "#{:02x}{:02x}{:02x}".format(
        *(int(round(float(c) * 255)) for c in np.clip(rgb, 0, 1)))


def _rampe(werte: np.ndarray, verlauf: str, symmetrisch: bool,
           stufen: int = 0) -> tuple[np.ndarray, dict]:
    """
    Werte auf RGB abbilden und die Legende dazu bauen.

    Die Grenzen sind das 2-%- und 98-%-Quantil, nicht Minimum und Maximum: eine
    einzelne Spannungsspitze am Auflagerrand — rechnerisch unvermeidlich, siehe
    `plate._anteile` — zöge sonst die ganze Skala zusammen und ließe die Fläche
    einfarbig erscheinen. Werte außerhalb bleiben grau; sie verschwinden also
    nicht, bestimmen die Skala aber auch nicht.

    Bei `stufen > 0` bekommt jeder Wert die Farbe seiner Stufenmitte. Aus dem
    Verlauf wird damit eine Treppe, deren Kanten Isolinien sind.
    """
    endlich = np.isfinite(werte)
    leer = {"min": 0.0, "max": 0.0, "skala_von": 0.0, "skala_bis": 0.0,
            "ausserhalb": 0, "stufen": []}
    if not endlich.any():
        return np.full((len(werte), 3), 0.5), leer

    gueltig = werte[endlich]
    lo, hi = (float(v) for v in np.percentile(gueltig, [2, 98]))
    if symmetrisch:
        grenze = max(abs(lo), abs(hi), 1e-9)
        lo, hi = -grenze, grenze
    if hi - lo < 1e-12:
        hi = lo + 1.0

    t = np.clip((werte - lo) / (hi - lo), 0.0, 1.0)
    t = np.where(endlich, t, 0.5)

    if stufen > 0:
        # Auf die Stufenmitte rasten. `min` fängt den Wert t = 1 ab, der sonst
        # in eine Stufe oberhalb der letzten fiele.
        index = np.minimum((t * stufen).astype(int), stufen - 1)
        t_farbe = (index + 0.5) / stufen
    else:
        t_farbe = t

    rgb = _farbe(verlauf, t_farbe)

    # Werte außerhalb der Quantilgrenzen grau, damit eine Spitze sichtbar
    # bleibt, ohne die Skala zu bestimmen.
    ausserhalb = endlich & ((werte < lo - 1e-9) | (werte > hi + 1e-9))
    rgb[ausserhalb] = np.array([0.25, 0.25, 0.28])
    rgb[~endlich] = np.array([0.6, 0.6, 0.6])

    return np.clip(rgb, 0, 1), {
        "min": float(np.nanmin(gueltig)), "max": float(np.nanmax(gueltig)),
        "skala_von": lo, "skala_bis": hi,
        "ausserhalb": int(ausserhalb.sum()),
        "stufen": _legendenstufen(lo, hi, verlauf, stufen, werte[endlich]),
    }


def _legendenstufen(lo: float, hi: float, verlauf: str, stufen: int,
                    werte: np.ndarray) -> list[dict]:
    """
    Die Legende als Liste von Stufen — Grenzen, Farbe, wie viele Punkte darin.

    Auch der stetige Verlauf bekommt Stufen, dann eben zwölf gleichmäßige.
    Andernfalls müsste der Viewer den Farbverlauf ein zweites Mal
    implementieren, um den Balken zu zeichnen; so ist die Legende überall
    dieselbe Datenstruktur und stimmt mit der Wolke per Konstruktion überein.
    """
    n = stufen if stufen > 0 else 12
    grenzen = np.linspace(lo, hi, n + 1)
    # Die Zählung ist die halbe Auskunft: eine Stufe, in der drei Punkte
    # liegen, ist eine Spitze; eine mit dreitausend ist die Regel.
    index = np.clip(((werte - lo) / max(hi - lo, 1e-12) * n).astype(int), 0, n - 1)
    anzahl = np.bincount(index, minlength=n)

    ergebnis = []
    for k in range(n):
        t_farbe = (k + 0.5) / n if stufen > 0 else k / max(n - 1, 1)
        ergebnis.append({
            "von": float(grenzen[k]),
            "bis": float(grenzen[k + 1]),
            "farbe": _hex(_farbe(verlauf, np.array([t_farbe]))[0]),
            "punkte": int(anzahl[k]),
        })
    return ergebnis


# ── Werte aus der npz ─────────────────────────────────────────────────────


def _laden(felder: Path | dict):
    return np.load(felder) if isinstance(felder, (str, Path)) else felder


def _dicke(daten) -> float:
    return float(np.asarray(daten["dicke_m"]).ravel()[0])


def _elementgroesse(daten, standard: float = 0.4) -> float:
    """Die Netzweite; ältere Läufe führen sie nicht mit."""
    schluessel = set(daten.files if hasattr(daten, "files") else daten.keys())
    if "elementgroesse_m" not in schluessel:
        return standard
    return float(np.asarray(daten["elementgroesse_m"]).ravel()[0])


def _biegespannung(moment: np.ndarray, dicke: float) -> np.ndarray:
    """
    Randspannung aus dem Plattenmoment, ungerissener Querschnitt.

        σ = m / W    mit    W = h² / 6   je Meter Plattenbreite

    Das Moment steht in kNm/m, die Spannung soll in N/mm² herauskommen:
    kN/m² sind 10⁻³ N/mm², daher der Faktor 1e-3.

    **Das ist Zustand I und damit nur ein Anhaltswert.** Sobald der Beton
    reißt — bei üblichen Decken schon unter Gebrauchslast —, wandert die
    Zugkraft in den Stahl, und die wirkliche Betonspannung liegt anders. Die
    Größe steht hier, weil sie die Frage „wie stark ist der Querschnitt
    beansprucht" ohne Bewehrungsannahme beantwortet; bemessen wird mit den
    Momenten, nicht mit ihr.
    """
    return moment * 6.0 / max(dicke, 1e-6) ** 2 * 1e-3


def _werte(daten, feld: Feld) -> np.ndarray:
    """Die Werte eines Feldes, abgeleitete eingerechnet."""
    roh = np.asarray(daten[feld.schluessel], dtype=float).ravel()
    if feld.ableitung == "biegespannung":
        return _biegespannung(roh, _dicke(daten))
    return roh


def _vorhanden(daten, feld: Feld) -> bool:
    schluessel = set(daten.files if hasattr(daten, "files") else daten.keys())
    return feld.schluessel in schluessel


# ── PNTS ──────────────────────────────────────────────────────────────────


def _pnts(xyz: np.ndarray, farben: np.ndarray) -> bytes:
    """
    PNTS-Binary (3D Tiles Point Cloud), gleichlautend mit `formats/splat.py`.

    Hier eigenständig, weil `splat.py` beim Import die SPZ-Kodierung und deren
    Abhängigkeiten mitzieht — für eine Ergebniswolke ist das unnötiger Ballast
    in einem Codepfad, der ohnehin nur ein paar hunderttausend Punkte schreibt.
    """
    positionen = np.ascontiguousarray(xyz, dtype="<f4").tobytes()
    rgb = (farben * 255.0).clip(0, 255).astype(np.uint8).tobytes()

    kopf = json.dumps({
        "POINTS_LENGTH": len(xyz),
        "POSITION": {"byteOffset": 0},
        "RGB": {"byteOffset": len(positionen)},
    }).encode("utf-8")

    # Der Binärblock muss auf einer 8-Byte-Grenze beginnen — der 28-Byte-Header
    # zählt mit, sonst liest Cesium die Float-Positionen unaligned.
    kopf += b" " * ((8 - (_HEADER_SIZE + len(kopf)) % 8) % 8)
    binaer = positionen + rgb
    binaer += b"\x00" * ((8 - len(binaer) % 8) % 8)

    return (b"pnts" + struct.pack("<I", 1)
            + struct.pack("<I", _HEADER_SIZE + len(kopf) + len(binaer))
            + struct.pack("<I", len(kopf)) + struct.pack("<I", len(binaer))
            + struct.pack("<I", 0) + struct.pack("<I", 0)
            + kopf + binaer)


# ── Aufbau ────────────────────────────────────────────────────────────────


def aufbauen(felder: Path | dict, ziel: Path, feld: str = "moment_x",
             z_unterkante: float = 0.0, placement: dict | None = None,
             ueberhoehung: float = 0.0, stufen: int | None = None,
             verlauf: str | None = None) -> dict:
    """
    Aus einer `felder.npz` ein PNTS-Tileset bauen.

    @param felder        Pfad zur npz oder ein bereits geladenes Mapping
    @param ziel          Verzeichnis; erhält `tile.pnts`, `tileset.json`,
                         `skala.json`, `placement.json`
    @param feld          Schlüssel aus `FELDER`
    @param z_unterkante  Höhe der Plattenunterkante im tile-lokalen System
    @param placement     Platzierung des Quellmodells; ohne sie der Standardpunkt
    @param ueberhoehung  Faktor, mit dem die Durchbiegung als Relief aufgetragen
                         wird. 0 = flach in der Plattenebene.
    @param stufen        Zahl der Farbstufen; None = die des Feldes, 0 = stetig
    @param verlauf       Farbverlauf; None = der des Feldes
    @returns Protokoll mit Punktzahl, Wertebereich, Legende und Dateigröße
    """
    if feld not in FELDER:
        raise ValueError(
            f"Feld '{feld}' gibt es nicht. Verfügbar: {', '.join(sorted(FELDER))}")

    daten = _laden(felder)
    beschreibung = FELDER[feld]

    if not _vorhanden(daten, beschreibung):
        moeglich = [k for k, f in FELDER.items() if _vorhanden(daten, f)]
        raise ValueError(
            f"'{beschreibung.schluessel}' steht nicht in den Ergebnisfeldern dieses "
            f"Laufs. Vorhanden: {', '.join(sorted(moeglich)) or 'keine'}")

    werte = _werte(daten, beschreibung)
    xy = np.asarray(
        daten["xy_knoten" if beschreibung.raster == "knoten" else "xy_element"],
        dtype=float)
    if len(xy) != len(werte):
        raise ValueError(
            f"Feld '{feld}' hat {len(werte)} Werte, das Raster "
            f"'{beschreibung.raster}' aber {len(xy)} Orte — die Rechnung passt "
            f"nicht zu diesen Feldern.")

    dicke = _dicke(daten)
    weite = _elementgroesse(daten)

    # z: die Plattenmittelebene. Die Wolke soll in der Decke liegen, nicht auf
    # ihr — sonst verdeckt sie den Fußboden des Geschosses darüber.
    z_ebene = z_unterkante + dicke / 2.0
    z = np.full(len(xy), z_ebene)
    if ueberhoehung and "w_qs" in daten and beschreibung.raster == "knoten":
        z = z + np.asarray(daten["w_qs"], dtype=float) / 1000.0 * ueberhoehung

    gewaehlter_verlauf = verlauf or beschreibung.verlauf
    gewaehlte_stufen = beschreibung.stufen if stufen is None else max(int(stufen), 0)

    farben, bereich = _rampe(werte, gewaehlter_verlauf, beschreibung.symmetrisch,
                             gewaehlte_stufen)
    xyz = np.stack([xy[:, 0], xy[:, 1], z], axis=1)

    ziel.mkdir(parents=True, exist_ok=True)
    (ziel / "tile.pnts").write_bytes(_pnts(xyz, farben))

    lo, hi = xyz.min(axis=0), xyz.max(axis=0)
    tileset = georef.build_tileset(
        georef.make_tile(
            center=((lo + hi) / 2.0).tolist(),
            half=((hi - lo) / 2.0 + 0.05).tolist(),
            geometric_error=0.0,
            content_uri="tile.pnts",
        ),
        geometric_error=max(float(np.linalg.norm(hi - lo)), 1.0),
    )
    # Die Platzierung des Quellmodells übernehmen, sonst steht die Wolke am
    # konfigurierten Referenzpunkt statt am Gebäude.
    if placement:
        georef.apply_placement(tileset, placement)
    (ziel / "tileset.json").write_text(json.dumps(tileset, indent=2))
    if placement:
        (ziel / georef.PLACEMENT_FILE).write_text(json.dumps(placement, indent=2))
    else:
        georef.write_placement(ziel)

    stufenliste = bereich.pop("stufen", [])
    protokoll = {
        "feld": feld,
        "beschriftung": beschreibung.titel,
        "kurz": beschreibung.beschriftung,
        "einheit": beschreibung.einheit,
        "gruppe": beschreibung.gruppe,
        "punkte": int(len(xyz)),
        "raster": beschreibung.raster,
        "bytes": (ziel / "tile.pnts").stat().st_size,
        "farbverlauf": gewaehlter_verlauf,
        "farbstufen": gewaehlte_stufen,
        "symmetrisch": beschreibung.symmetrisch,
        "dicke_m": round(dicke, 4),
        "elementgroesse_m": round(weite, 4),
        "ueberhoehung": float(ueberhoehung),
        **{k: round(v, 4) if isinstance(v, float) else v for k, v in bereich.items()},
    }

    # Die Legende geht neben die Kacheln, nicht nur in die Antwort: der Viewer
    # lädt das Tileset über Cesium und sieht das Protokoll dieses Aufrufs nie.
    skala = dict(protokoll)
    skala["stufen"] = [
        {**s, "von": round(s["von"], 4), "bis": round(s["bis"], 4)} for s in stufenliste]
    skala["ausdehnung"] = {
        "x": [round(float(lo[0]), 4), round(float(hi[0]), 4)],
        "y": [round(float(lo[1]), 4), round(float(hi[1]), 4)],
        "z_ebene": round(float(z_ebene), 4),
    }
    (ziel / "skala.json").write_text(json.dumps(skala, indent=2, ensure_ascii=False))

    logger.info("Ergebniswolke %s: %s Punkte, %s … %s, %s Stufen → %s",
                feld, len(xyz), protokoll.get("min"), protokoll.get("max"),
                gewaehlte_stufen or "stetig", ziel)
    return protokoll


def verfuegbare_felder(felder: Path | dict) -> list[dict]:
    """Welche Felder in dieser Rechnung darstellbar sind."""
    daten = _laden(felder)
    return [
        {"feld": name, "beschriftung": f.titel, "kurz": f.beschriftung,
         "einheit": f.einheit, "raster": f.raster, "gruppe": f.gruppe,
         "stufen": f.stufen, "verlauf": f.verlauf,
         "richtung": f.richtung, "lage": f.lage}
        for name, f in FELDER.items() if _vorhanden(daten, f)
    ]


# ── Punktabfrage ──────────────────────────────────────────────────────────


def werte_am_ort(felder: Path | dict, x: float, y: float) -> dict:
    """
    Alle Ergebnisgrößen an einer Stelle der Platte — für den Klick in die Wolke.

    Eine eingefärbte Wolke zeigt **eine** Größe. Wer auf einen Punkt zeigt,
    will aber alle wissen: wie weit sinkt die Decke hier, welche Momente liegen
    an, wie viel Bewehrung folgt daraus oben und unten. Genau das steht in der
    `felder.npz` — nur auf zwei Rastern, weil Verschiebungen an den Knoten und
    Schnittgrößen in den Elementmitten entstehen.

    Deshalb wird **je Raster getrennt** der nächste Ort gesucht, statt zwischen
    den Rastern zu interpolieren. Der Abstand steht in der Antwort: er sagt,
    wie genau die Auskunft zum angeklickten Punkt gehört, und ist bei einer
    Netzweite von 40 cm typisch ein bis zwanzig Zentimeter.

    Liegt der Punkt weiter als anderthalb Elementweiten neben dem nächsten
    Elementmittelpunkt, ist er außerhalb der Platte — dann kommt `auf_platte:
    false` zurück, und der Viewer sagt es, statt einen Randwert als Auskunft
    auszugeben.
    """
    daten = _laden(felder)
    dicke = _dicke(daten)
    weite = _elementgroesse(daten)

    ziel = np.array([float(x), float(y)])
    orte: dict[str, dict] = {}
    for raster, schluessel in (("knoten", "xy_knoten"), ("element", "xy_element")):
        punkte = np.asarray(daten[schluessel], dtype=float)
        abstaende = np.linalg.norm(punkte - ziel, axis=1)
        index = int(np.argmin(abstaende))
        orte[raster] = {
            "index": index,
            "abstand": float(abstaende[index]),
            "xy": [round(float(punkte[index, 0]), 4), round(float(punkte[index, 1]), 4)],
        }

    auf_platte = orte["element"]["abstand"] <= weite * 1.5

    gruppen: dict[str, list[dict]] = {}
    for name, feld in FELDER.items():
        if not _vorhanden(daten, feld):
            continue
        wert = float(_werte(daten, feld)[orte[feld.raster]["index"]])
        wert = None if not np.isfinite(wert) else round(wert, 4)

        if feld.ableitung == "biegespannung":
            # Die Biegespannung ist an beiden Rändern betragsgleich und im
            # Vorzeichen entgegengesetzt — das ist die ganze Aussage des
            # Zustands I. Sie einmal auszugeben und die Umkehr dem Leser zu
            # überlassen wäre knapper und im Zweifel falsch abgelesen: welcher
            # Rand zieht, ist genau die Frage, die man an einer Momentenkarte
            # hat. Ein positives Plattenmoment zieht unten.
            for lage, faktor in (("unten", 1.0), ("oben", -1.0)):
                gruppen.setdefault(feld.gruppe, []).append({
                    "feld": f"{name}_{lage}",
                    "name": f"σ_{feld.richtung} {lage}",
                    "einheit": feld.einheit,
                    "wert": None if wert is None else round(wert * faktor, 4),
                    "raster": feld.raster,
                    "richtung": feld.richtung,
                    "lage": lage,
                })
            continue

        eintrag = {
            "feld": name,
            "name": feld.beschriftung,
            "einheit": feld.einheit,
            "wert": wert,
            "raster": feld.raster,
        }
        if feld.richtung:
            eintrag["richtung"] = feld.richtung
        if feld.lage:
            eintrag["lage"] = feld.lage
        gruppen.setdefault(feld.gruppe, []).append(eintrag)

    return {
        "ort": {
            "x": round(float(x), 4), "y": round(float(y), 4),
            "auf_platte": bool(auf_platte),
            "abstand_knoten_m": round(orte["knoten"]["abstand"], 4),
            "abstand_element_m": round(orte["element"]["abstand"], 4),
            "xy_knoten": orte["knoten"]["xy"],
            "xy_element": orte["element"]["xy"],
            "dicke_m": round(dicke, 4),
            "elementgroesse_m": round(weite, 4),
        },
        "gruppen": [{"titel": titel, "werte": werte}
                    for titel, werte in gruppen.items()],
    }
