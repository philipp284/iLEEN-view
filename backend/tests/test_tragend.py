"""
Prüfstein für die Tragwerkserkennung.

Die Frage „trägt diese Wand" entscheidet, ob die Decke dort ein Auflager
bekommt. Beide Fehlerrichtungen sind teuer und beide sind still:

* Eine übersehene tragende Wand nimmt der Decke ihr Auflager — die Spannweite
  wächst, die Momente wachsen, und im Grundriss mit achtzig Wänden fällt die
  eine fehlende niemandem auf.
* Eine irrtümlich tragende Trennwand macht die Decke steifer, als sie ist.

Geprüft wird deshalb an den Fällen, bei denen es schiefgeht:

1. Die Außenwand, deren **dickste** Schicht die Dämmung ist.
2. Materialnamen, die einander enthalten („Gasbeton" ist Mauerwerk, nicht
   Stahlbeton; „Betonwerkstein" ist ein Belag).
3. Die Reihenfolge der Quellen — eine gepflegte Angabe sticht eine geratene.
4. Stützen, die unabhängig vom Material tragen.

Ausführen:  python3 tests/test_tragend.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import tragend as tr  # noqa: E402

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
    return bedingung


def gleich(ist, soll, was):
    return pruefe(ist == soll, was, ist, soll)


def schicht(name, dicke=0.0, gesetzt=None):
    return {"name": name, "dicke_m": dicke, "tragend_gesetzt": gesetzt}


# ── 1. Materialklassen ──────────────────────────────────────────────────────

print("\nMaterialklassen aus Freitext")

for name, soll in [
    ("Stahlbeton", "stahlbeton"),
    ("STB C25/30", "stahlbeton"),
    ("Beton, bewehrt", "stahlbeton"),
    ("Ortbeton C30/37", "stahlbeton"),
    ("Concrete", "stahlbeton"),
    ("Mauerwerk", "mauerwerk"),
    ("Kalksandstein 17,5", "mauerwerk"),
    ("Hochlochziegel", "mauerwerk"),
    ("Klinker-Verblendschale", "mauerwerk"),
    ("Porenbeton PP2", "mauerwerk"),
    ("Mineralwolle 035", "daemmung"),
    ("EPS 032", "daemmung"),
    ("Wärmedämmung", "daemmung"),
    ("Gipskarton 12,5 mm", "leichtbau"),
    ("Trockenbau-Ständerwerk", "leichtbau"),
    ("Zementestrich", "leichtbau"),
    ("Brettschichtholz GL24h", "holz"),
    ("Baustahl S235", "stahl"),
    ("Irgendwas Unbekanntes", None),
    (None, None),
]:
    gleich(tr.materialklasse(name), soll, f"{name!r} → {soll}")

print("\nNamen, die einander enthalten")
# „Gasbeton" ist Porenbeton und damit Mauerwerk. Stünde „beton" vor
# „gasbeton", käme Stahlbeton heraus — und eine 24er Porenbetonwand wäre
# plötzlich eine Stahlbetonwand.
gleich(tr.materialklasse("Gasbeton"), "mauerwerk", "Gasbeton ist Mauerwerk")
gleich(tr.materialklasse("Porenbeton"), "mauerwerk", "Porenbeton ist Mauerwerk")
gleich(tr.materialklasse("Leichtbeton-Hohlblock"), "mauerwerk",
       "Leichtbeton ist Mauerwerk")
# Dämmung steht vor Mauerwerk: eine „Mineralwolle zwischen Ziegel" trägt nicht.
gleich(tr.materialklasse("Mineralwolle zwischen Ziegel"), "daemmung",
       "Dämmung gewinnt gegen Ziegel im selben Namen")


# ── 2. Die Außenwand, deren dickste Schicht die Dämmung ist ─────────────────

print("\nDie Falle: die dickste Schicht ist die Dämmung")

aussenwand = [
    schicht("Kalksandstein", 0.175),
    schicht("Mineralwolle 035", 0.200),
    schicht("Klinker", 0.115),
]
erg = tr.beurteile(rolle="wand", material="Mineralwolle 035",
                   materialschichten=aussenwand)
pruefe(erg["tragend"] is True,
       "17,5 KS + 20 Dämmung + 11,5 Klinker trägt", erg["tragend"], True)
gleich(erg["quelle"], "Materialschicht", "erkannt an der Schicht")
gleich(erg["tragende_schicht"]["name"], "Kalksandstein",
       "die tragende Schicht ist der Kalksandstein, nicht die Dämmung")

# Ohne die Schichten — nur mit dem Namen der dicksten — käme das Gegenteil
# heraus. Genau das war der Zustand vor diesem Modul.
nur_dickste = tr.beurteile(rolle="wand", material="Mineralwolle 035")
pruefe(nur_dickste["tragend"] is False,
       "dieselbe Wand nur über die dickste Schicht: nicht tragend "
       "(der Fehler, gegen den die Schichten gelesen werden)",
       nur_dickste["tragend"], False)

print("\nZwei tragende Schichten: die dickste gilt")
zweischalig = [schicht("Kalksandstein", 0.115), schicht("Stahlbeton", 0.200)]
erg = tr.beurteile(rolle="wand", materialschichten=zweischalig)
gleich(erg["tragende_schicht"]["name"], "Stahlbeton",
       "auf der dickeren tragenden Schicht liegt die Decke auf")


# ── 3. Reihenfolge der Quellen ──────────────────────────────────────────────

print("\nReihenfolge: die gepflegte Angabe sticht die gedeutete")

# IsLoadBearing an der Schicht ist die genaueste Auskunft — sie sticht sogar
# ein anderslautendes Pset.
erg = tr.beurteile(
    rolle="wand",
    psets={"Pset_WallCommon": {"LoadBearing": False}},
    materialschichten=[schicht("Gipskarton", 0.0125, gesetzt=True)])
pruefe(erg["tragend"] is True,
       "IsLoadBearing an der Schicht sticht das Pset", erg["tragend"], True)
gleich(erg["quelle"], "IfcMaterialLayer.IsLoadBearing", "und sagt es")

# Das Pset sticht die Materialdeutung: eine ausdrücklich nichttragende
# Mauerwerkswand ist nichttragend.
erg = tr.beurteile(rolle="wand",
                   psets={"Pset_WallCommon": {"LoadBearing": False}},
                   material="Kalksandstein",
                   materialschichten=[schicht("Kalksandstein", 0.115)])
pruefe(erg["tragend"] is False,
       "eine ausdrücklich nichttragende Mauerwerkswand trägt nicht",
       erg["tragend"], False)
gleich(erg["quelle"], "Pset.LoadBearing", "und sagt, woher das kommt")

# Ohne jede Angabe: keine Entscheidung, kein Raten.
erg = tr.beurteile(rolle="wand")
pruefe(erg["tragend"] is None,
       "ohne jede Angabe bleibt es unentschieden", erg["tragend"], None)
gleich(erg["quelle"], "keine Angabe im Modell", "und das steht im Bericht")

print("\nDie Werte, wie sie in IFC-Dateien wirklich stehen")
for wert, soll in [(True, True), ("True", True), (".T.", True), ("1", True),
                   (False, False), ("False", False), (".F.", False), ("0", False)]:
    erg = tr.beurteile(rolle="wand", psets={"P": {"LoadBearing": wert}})
    gleich(erg["tragend"], soll, f"LoadBearing = {wert!r}")

print("\nFlach abgelegte Properties werden auch gefunden")
erg = tr.beurteile(rolle="wand", psets={"LoadBearing": True})
pruefe(erg["tragend"] is True, "Pset ohne Set-Ebene", erg["tragend"], True)


# ── 4. Stützen tragen immer ─────────────────────────────────────────────────

print("\nJede Stütze trägt, unabhängig vom Material")

for material in ("Baustahl S235", "Brettschichtholz GL24h", "Stahlbeton", None):
    erg = tr.beurteile(rolle="stuetze", material=material)
    pruefe(erg["tragend"] is True, f"Stütze aus {material}", erg["tragend"], True)

# Auch gegen ein Pset, das etwas anderes sagt: eine Stütze, die nicht trägt,
# ist keine Stütze.
erg = tr.beurteile(rolle="stuetze", psets={"P": {"LoadBearing": False}},
                   material="Stahlbeton")
pruefe(erg["tragend"] is True,
       "auch gegen ein Pset, das das Gegenteil behauptet", erg["tragend"], True)

erg = tr.beurteile(rolle="fundament", material="Stahlbeton")
pruefe(erg["tragend"] is True, "ein Fundament trägt", erg["tragend"], True)


# ── 5. Wände, die nicht tragen ──────────────────────────────────────────────

print("\nWas nicht trägt")

for name in ("Gipskarton 12,5 mm", "Trockenbau-Ständerwerk", "Glas"):
    erg = tr.beurteile(rolle="wand", material=name,
                       materialschichten=[schicht(name, 0.125)])
    pruefe(erg["tragend"] is False, f"{name} trägt nicht", erg["tragend"], False)

print("\nEine Wand aus Holz trägt hier nicht — bewusst")
# Holz trägt selbstverständlich. Ein Holzständer als Linienlager einer
# Stahlbetondecke ist im Hochbau aber die Ausnahme; wo es zutrifft, sagt es
# ein Eingriff `bauteil_tragend`, und der ist im Bericht sichtbar.
erg = tr.beurteile(rolle="wand", material="Konstruktionsvollholz",
                   materialschichten=[schicht("Konstruktionsvollholz", 0.16)])
pruefe(erg["tragend"] is False,
       "Holzwand gilt als nichttragend (per Eingriff korrigierbar)",
       erg["tragend"], False)


# ── 6. Was nach Tragwerk klingt und keines ist ──────────────────────────────

print("\nFassadenglieder gehören nicht ins Tragwerk")

from ileen import lastabtrag as la  # noqa: E402

# An `Ifc4_SampleHouse.ifc` gemessen: 20 `IfcMember` (Pfosten und Riegel einer
# Vorhangfassade) und 6 `IfcPlate` (die Glasfüllungen). Als `stuetze` und
# `decke` geführt, und mit der Regel „jede Stütze trägt" darauf losgelassen,
# wurde daraus ein Tragwerk aus 3-cm-Pfosten: acht Konten mit zusammen 0,5 kN
# Eigengewicht, während die drei Ziegelwände daneben standen und keines führten.
for typ in ("IfcMember", "IfcPlate", "IfcCurtainWall"):
    gleich(la.rolle_von(typ), "sonstiges", f"{typ} ist kein Tragwerk")

print("\nWas trägt, bleibt")
for typ, rolle in [("IfcColumn", "stuetze"), ("IfcWall", "wand"),
                   ("IfcWallStandardCase", "wand"), ("IfcSlab", "decke"),
                   ("IfcRoof", "decke"), ("IfcBeam", "unterzug"),
                   ("IfcFooting", "fundament"), ("IfcPile", "fundament")]:
    gleich(la.rolle_von(typ), rolle, f"{typ} → {rolle}")

print("\nUnbekannte Klassen mit passendem Präfix zählen weiterhin")
gleich(la.rolle_von("IfcSlabStandardCase"), "decke",
       "ältere Werkzeuge führen IfcSlabStandardCase")


print("\nSchichtwichte: die Oberfläche ist nicht der Körper")
from ileen import tragwerksmodell as tm  # noqa: E402
gleich(tr.schichtwichte("Ortbeton - bewehrt Verputzt"), 25.0,
       "„Ortbeton - bewehrt Verputzt“ ist Beton (VA3), nicht Putz")
gleich(tr.schichtwichte("Verputz"), 18.0, "„Verputz“ allein bleibt Putz")
gleich(tr.schichtwichte("Ziegel verputzt"), 14.0, "„Ziegel verputzt“ ist Ziegel")
staender = [{"name": "Holz - OSB", "dicke_m": 0.015}, {"name": "Luftschicht", "dicke_m": 0.16},
            {"name": "Holz - OSB", "dicke_m": 0.015}]
gleich(la.mittlere_schichtwichte(staender), 0.789, "mittlere Wichte einer Ständerwand ohne Ständer")
stummel = tm.wandaufbau({"tragend": True, "klasse": "leichtbau_unbekannt"},
                        {"materialschichten": staender},
                        {"dicke_gesamt_m": 0.10, "dicke_tragend_m": 0.10}, "wand")
gleich((stummel["wichte_kNm3"], stummel["aus_modell"]), (0.789, True),
       "ein Wandende, dessen Schnitt nicht zur Schichtsumme passt, wiegt wie sein Aufbau, "
       "nicht 25 kN/m³")

print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
