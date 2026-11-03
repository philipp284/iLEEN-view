"""
Ein Scan2BIM-Lauf von Anfang bis Ende.

Diese Datei kennt die Reihenfolge der Stufen und meldet den Fortschritt — sonst
nichts. Gerechnet wird in `kern.py`, vernetzt in `netz.py`, ausgegeben in
`ausgabe_glb.py` und `ausgabe_ifc.py`.

Der Fortschritt geht über einen Rückruf hinaus statt über ein Protokoll: die
HTTP-Route schreibt ihn in ihren Lauf-Status, die Kommandozeile gibt ihn aus.
Beide sehen dieselben Anteile, weil beide denselben Weg gehen.
"""

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import ausgabe_glb, ausgabe_ifc, georef, kern, netz

logger = logging.getLogger(__name__)

# Anteil am Gesamtfortschritt je Stufe. Die Zellstatistik liest die ganze
# Punktwolke und dominiert alles andere — bei hundert Millionen Punkten sind
# das gut zwei Drittel der Laufzeit.
STUFEN = [
    ("punkte", 0.42, "Punkte einlesen und rastern"),
    ("gelaende", 0.10, "Gelände filtern"),
    ("flaechen", 0.06, "Baugrube und Verkehrsflächen"),
    ("objekte", 0.22, "Objekte segmentieren"),
    ("netz", 0.10, "Geländenetz"),
    ("glb", 0.03, "GLB schreiben"),
    ("ifc", 0.07, "IFC schreiben"),
]


@dataclass
class Einstellungen:
    """Was ein Lauf wissen muss, bevor er beginnt."""

    projekt: str = "Scan2BIM-Rekonstruktion"
    netz_modus: str = "adaptiv"          # adaptiv | fest
    maschenweite_m: float = 1.0          # nur fest
    toleranz_m: float = 0.15             # nur adaptiv
    max_stuetzpunkte: int = 60000
    referenz_tileset: str | None = None  # URL des Tilesets der Quellwolke
    bericht: dict = field(default_factory=dict)


def ausfuehren(las: Path, ziel: Path, e: Einstellungen, melden=None) -> dict:
    """
    Rechnet einen vollständigen Lauf und legt die Ergebnisse in `ziel` ab.

    `melden(anteil, text)` wird nach jeder Stufe gerufen; Ausnahmen daraus
    werden nicht abgefangen — wer meldet, soll nicht rechnen.
    """
    las, ziel = Path(las), Path(ziel)
    ziel.mkdir(parents=True, exist_ok=True)
    bericht = {"quelle": las.name, "einstellungen": {
        "netz": e.netz_modus,
        "maschenweite_m": e.maschenweite_m if e.netz_modus == "fest" else None,
        "toleranz_m": e.toleranz_m if e.netz_modus == "adaptiv" else None}}
    erledigt = 0.0

    def fertig(name, text, ergebnis=None):
        nonlocal erledigt
        anteil = dict((s[0], s[1]) for s in STUFEN)[name]
        erledigt += anteil
        if ergebnis is not None:
            bericht[name] = ergebnis
        if melden:
            melden(min(erledigt, 0.99), text)
        return ergebnis

    if melden:
        melden(0.01, "Punkte einlesen und rastern")
    fertig("punkte", "Gelände filtern", kern.zellstatistik(las, ziel))
    fertig("gelaende", "Baugrube und Verkehrsflächen", kern.gelaende(ziel))
    fertig("flaechen", "Objekte segmentieren", kern.flaechen(ziel))
    fertig("objekte", "Geländenetz", kern.objekte(ziel))

    t = np.load(ziel / "gelaende.npz")
    f = np.load(ziel / "flaechen.npz")
    netzdaten = netz.bauen(t["boden"], t["maske"], f["grube"], f["strasse"], t["meta"],
                           modus=e.netz_modus, maschenweite_m=e.maschenweite_m,
                           toleranz_m=e.toleranz_m, max_stuetzpunkte=e.max_stuetzpunkte)
    kennzahlen = netzdaten.pop("kennzahlen")
    np.savez(ziel / "netz.npz", **netzdaten)
    fertig("netz", "GLB schreiben", kennzahlen)

    # Georeferenz vor der Ausgabe: das IFC trägt sie als IfcMapConversion.
    geo = None
    if e.referenz_tileset:
        geo = georef.georeferenz_aus_tileset(
            e.referenz_tileset, json.loads((ziel / "bbox_punkte.json").read_text()))
        (ziel / "georeferenz.json").write_text(json.dumps(geo, indent=1))
        bericht["georeferenz"] = {k: geo[k] for k in ("nullpunkt", "heading", "utm_ost", "utm_nord")}

    fertig("glb", "IFC schreiben", ausgabe_glb.bauen(ziel, netzdaten))
    fertig("ifc", "fertig", ausgabe_ifc.bauen(ziel, netzdaten, geo, e.projekt))

    (ziel / "bericht.json").write_text(json.dumps(bericht, indent=1, ensure_ascii=False))
    if melden:
        melden(1.0, "fertig")
    return bericht


def platzierung(ziel: Path, art: str) -> dict | None:
    """
    Platzierung für ein Ergebnis — für genau den Punkt, den `recenter()` trifft.

    Das Backend zentriert ein Modell beim Ablegen auf die XY-Mitte seiner
    Bounding Box und die Z-Unterkante. Genau dieser Punkt bekommt die
    Weltkoordinate; für den Modellursprung gerechnet läge das Ergebnis um die
    halbe Modellbreite daneben.
    """
    ziel = Path(ziel)
    datei = ziel / f"bbox_{art}.json"
    if not (ziel / "georeferenz.json").exists() or not datei.exists():
        return None
    geo = json.loads((ziel / "georeferenz.json").read_text())
    box = json.loads(datei.read_text())
    lo, hi = np.array(box["lo"]), np.array(box["hi"])
    welt = georef.weltpunkt(geo, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
    return dict(**welt, height_reference="ellipsoid", heading=geo["heading"],
                pitch=0.0, roll=0.0, scale=1.0)
