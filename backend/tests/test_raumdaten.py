"""
Prüfstein für die Raumdaten aus dem IFC (`ileen/raumdaten.py`).

Die Psets unten sind keine erfundenen Beispiele, sondern die Formen, die in den
Modellen im Backend tatsächlich vorkommen (Stand 2026-10):

* ArchiCAD (`OPL_ArchiCAD_ifc2x3.ifc`): Nutzung in `Pset_SpaceCommon.Category`,
  DIN 277 als `ArchiCADProperties.Raumkategoriecode` = „02 NUF", daneben
  `Raumkategoriename` = „0" — ein Wert, der nichts heißt.
* Revit (`Ifc4_SampleHouse.ifc`): TGA-Angaben in `Energy Analysis`, Personen
  als 0,0, wenn nicht gesetzt.
* HSM-Campus: eigenes Pset `HSM_Raumdaten` mit `Nutzung_Plantext`,
  `Bodenbelag_Plan`.

Was still schiefgehen kann und hier deshalb geprüft wird: ein leerer Wert, der
einen brauchbaren dahinter verdeckt; Kelvin als °C gelesen (293 °C
Raumtemperatur); m³/s als m³/h (eine Zuluft von 0,05 m³/h); „0" als Nutzung.

Ausführen:  python3 tests/test_raumdaten.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Direkt laden statt über `ileen/__init__`: das zieht JAX herein, und dieser
# Prüfstein soll ohne die Rechenumgebung laufen.
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "raumdaten", Path(__file__).resolve().parent.parent / "ileen" / "raumdaten.py")
rd = importlib.util.module_from_spec(_spec)
sys.modules["raumdaten"] = rd
_spec.loader.exec_module(rd)

_gut = True


def pruefe(bedingung, was, ist=None, soll=None):
    global _gut
    if bedingung:
        print(f"  ok    {was}")
    else:
        _gut = False
        print(f"  FEHLT {was}")
        if ist is not None or soll is not None:
            print(f"        ist  {ist!r}")
            print(f"        soll {soll!r}")


def wert(m, key):
    return (m.get(key) or {}).get("wert")


print("1 · ArchiCAD")
archicad = {
    "Pset_SpaceCommon": {"Reference": "BÜRO 0.08", "Category": "Büroarbeit", "id": 12},
    "Pset_AirSideSystemInformation": {"Name": "BÜRO"},
    "ArchiCADProperties": {"Raumkategoriename": "0", "Raumkategoriecode": "02 NUF",
                           "Oberfläche": "Farbe, weiß"},
    "AC_Pset_Raumstempel_DIN_25": {"Schriftart 1": "Arial Westlich", "Raumname": "BÜRO"},
}
m = rd.merkmale(archicad)
pruefe(wert(m, "nutzung") == "Büroarbeit", "Nutzung aus Pset_SpaceCommon.Category", wert(m, "nutzung"))
pruefe(m["nutzung"]["quelle"] == "Pset_SpaceCommon.Category", "Fundstelle geht mit", m["nutzung"]["quelle"])
pruefe(wert(m, "din277") == "02 NUF", "DIN 277 roh aus Raumkategoriecode", wert(m, "din277"))
gruppe = rd.din277_aus(m, [])
pruefe(gruppe and gruppe["wert"] == "NUF 2", "„02 NUF“ → NUF 2", gruppe)
pruefe("id" not in str(rd.psets_bereinigen(archicad).get("Pset_SpaceCommon", {}).keys()),
       "`id` fällt aus den Psets")
stempel = rd.psets_bereinigen(archicad).get("AC_Pset_Raumstempel_DIN_25", {})
pruefe("Schriftart 1" not in stempel, "Layout im Stempelsatz fällt weg", stempel)
pruefe(stempel.get("Raumname") == "BÜRO", "Inhalt im Stempelsatz bleibt", stempel)
goop = {"AC_Pset_Raumstempel_DIN_24": {
    "Bodenbelag": "1K Beschichtung", "Deckenbelag": "<Material Deckenbelag>",
    "Bodenbelag zeigen (bShowFloor_50)": True, "Raumname Stift (penTitle_50)": "Elemente+Text",
    "Raumhöhe": 2.6, "Raumhöhe Kürzel": "LH", "X Distanz in 1:100": 0.0,
    "Berechnete Fläche (NRF)": 14.05, "Eigene OK Fertigfußboden (customFloorLevel)": 0.0},
    "ArchiCADProperties": {"Raumkategoriename": 0, "Raumkategoriecode": "NUF"}}
m = rd.merkmale(goop)
pruefe(wert(m, "bodenbelag") == "1K Beschichtung", "Bodenbelag aus dem Stempelsatz", wert(m, "bodenbelag"))
pruefe("deckenbekleidung" not in m, "Platzhalter „<Material Deckenbelag>“ ist leer", m.get("deckenbekleidung"))
pruefe("nutzung" not in m, "Ganzzahl 0 ist keine Nutzung", m.get("nutzung"))
gesiebt = rd.psets_bereinigen(goop)["AC_Pset_Raumstempel_DIN_24"]
pruefe(sorted(gesiebt) == ["Berechnete Fläche (NRF)", "Bodenbelag", "Deckenbelag", "Raumhöhe"],
       "Stempelsatz auf Inhalt gesiebt", sorted(gesiebt))
pruefe("ArchiCADProperties" in rd.psets_bereinigen(archicad), "übrige Sätze bleiben")

print("\n2 · Revit")
revit = {
    "Pset_SpaceCommon": {"Reference": "Living room 1", "IsExternal": False},
    "Energy Analysis": {"Number of People": 0.0, "Area per Person": 28.5714285714286,
                        "Specified Power Load per area": 13.9930835417226,
                        "Specified Lighting Load per area": 10.7639104167097,
                        "Heat Load Values": "<Default>"},
}
m = rd.merkmale(revit)
pruefe("personen" not in m, "0,0 Personen ist „nicht gesetzt“, kein Wert", m.get("personen"))
pruefe(wert(m, "flaeche_je_person") == 28.571, "Fläche je Person", wert(m, "flaeche_je_person"))
pruefe(wert(m, "elektro_w_m2") == 13.993, "Elektro W/m² aus Energy Analysis", wert(m, "elektro_w_m2"))
pruefe(wert(m, "licht_w_m2") == 10.764, "Licht W/m²", wert(m, "licht_w_m2"))
pruefe(wert(m, "aussen") is False, "IsExternal = False bleibt False (nicht leer)", m.get("aussen"))

print("\n3 · Eigene Psets (HSM-Campus)")
hsm = {"HSM_Raumdaten": {"Nutzung_Plantext": "WC H", "Bodenbelag_Plan": "Epoxidharz mittl. B.",
                         "Decke_Plan": "Sichtbeton", "Planflaeche_m2": "7.92"},
       "HSM_Quellen_und_Pruefung": {"Decken_IFC_IDs": "258331"}}
m = rd.merkmale(hsm)
pruefe(wert(m, "nutzung") == "WC H", "Nutzung_Plantext", wert(m, "nutzung"))
pruefe(wert(m, "bodenbelag") == "Epoxidharz mittl. B.", "Bodenbelag_Plan", wert(m, "bodenbelag"))
pruefe(wert(m, "deckenbekleidung") == "Sichtbeton", "Decke_Plan", wert(m, "deckenbekleidung"))

print("\n4 · Normsätze und Einheiten")
norm = {
    "Pset_SpaceThermalRequirements": {"SpaceTemperatureMin": 293.15, "SpaceTemperatureMax": 26.0,
                                      "MechanicalVentilationRate": 2.0},
    "Pset_SpaceThermalDesign": {"VentilationAirFlowrate": 0.05, "ExhaustAirFlowrate": 400.0,
                                "TotalHeatLoss": 1250.0},
    "Pset_SpaceLightingRequirements": {"Illuminance": 500.0},
    "Pset_SpaceOccupancyRequirements": {"OccupancyType": "Büro", "OccupancyNumber": 4},
    "Pset_SpaceFireSafetyRequirements": {"FireRiskFactor": "F30", "FireExit": True},
    "Pset_SpaceCommon": {"HandicapAccessible": "TRUE"},
}
m = rd.merkmale(norm)
pruefe(wert(m, "temp_min_c") == 20.0, "293,15 K → 20 °C", wert(m, "temp_min_c"))
pruefe(m["temp_min_c"].get("roh") == 293.15, "umgerechneter Wert trägt `roh`", m["temp_min_c"])
pruefe(wert(m, "temp_max_c") == 26.0, "26 bleibt °C", wert(m, "temp_max_c"))
pruefe(wert(m, "zuluft_m3h") == 180.0, "0,05 m³/s → 180 m³/h", wert(m, "zuluft_m3h"))
pruefe(wert(m, "abluft_m3h") == 400.0, "400 ist schon m³/h", wert(m, "abluft_m3h"))
pruefe("roh" not in m["abluft_m3h"], "nicht umgerechnet → kein `roh`", m["abluft_m3h"])
pruefe(wert(m, "luftwechsel_1h") == 2.0, "Luftwechsel", wert(m, "luftwechsel_1h"))
pruefe(wert(m, "heizlast_w") == 1250.0, "Heizlast", wert(m, "heizlast_w"))
pruefe(wert(m, "beleuchtung_lx") == 500.0, "Beleuchtungsstärke", wert(m, "beleuchtung_lx"))
pruefe(wert(m, "nutzung") == "Büro", "OccupancyType vor Category", wert(m, "nutzung"))
pruefe(wert(m, "personen") == 4.0, "OccupancyNumber", wert(m, "personen"))
pruefe(wert(m, "brandschutz") == "F30", "FireRiskFactor", wert(m, "brandschutz"))
pruefe(wert(m, "fluchtweg") is True, "FireExit", wert(m, "fluchtweg"))
pruefe(wert(m, "barrierefrei") is True, "„TRUE“ als Text → True", wert(m, "barrierefrei"))

print("\n5 · Leere Werte verdecken nichts")
gemischt = {"Pset_SpaceCommon": {"Category": ""},
            "Raumdaten": {"Nutzung": "Labor"}}
m = rd.merkmale(gemischt)
pruefe(wert(m, "nutzung") == "Labor", "leeres Normfeld → Freitext dahinter", wert(m, "nutzung"))
pruefe(rd.merkmale({"X": {"Raumkategoriename": "0"}}) == {}, "„0“ ist keine Nutzung")

print("\n6 · DIN 277")
faelle = [("02 NUF", "NUF 2"), ("VF", "VF 9"), ("TF 8.4", "TF 8"), ("NF 2.1", "NUF 2"),
          ("NUF 7.4", "NUF 7"), ("2.1 Büroräume", "NUF 2"), ("NUF", "NUF"), ("BGF", None),
          (None, None)]
for text, soll in faelle:
    pruefe(rd.din277_gruppe(text) == soll, f"{text!r} → {soll}", rd.din277_gruppe(text), soll)
klass = [{"system": "DIN 277-1:2016", "kennung": "3.2", "name": "Werkstätten"}]
pruefe(rd.din277_aus({}, klass) == {"wert": "NUF 3", "quelle": "Klassifikation DIN 277-1:2016: 3.2"},
       "Klassifikationsverweis nach DIN 277", rd.din277_aus({}, klass))
archicad_ref = [{"system": None, "kennung": "02 NUF", "name": "Büroarbeit"},
                {"system": "ARCHICAD Klassifizierung", "kennung": "Raum", "name": None}]
pruefe(rd.din277_aus({}, archicad_ref) == {"wert": "NUF 2", "quelle": "Klassifikation ohne System: 02 NUF"},
       "ArchiCAD-Verweis ohne System, Kennung mit Kürzel", rd.din277_aus({}, archicad_ref))
pruefe(rd.din277_aus({}, [{"system": None, "kennung": "2.1", "name": "x"}]) is None,
       "Verweis ohne System und ohne Kürzel wird nicht gedeutet")
fremd = [{"system": "Uniclass 2015", "kennung": "SL_20_15", "name": "Offices"}]
pruefe(rd.din277_aus({}, fremd) is None, "fremdes System wird nicht gedeutet", rd.din277_aus({}, fremd))

print("\n" + ("Alle Prüfungen bestanden." if _gut else "Es gibt Fehlschläge."))
sys.exit(0 if _gut else 1)
