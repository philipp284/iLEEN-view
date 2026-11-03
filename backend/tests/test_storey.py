"""
Prüfstein für `_storey_of` — die Geschosszuordnung.

Ohne IFC-Datei: Die Funktion fragt nur zwei Dinge ab (`get_container` und
`Decomposes`), und beide lassen sich mit Attrappen nachstellen. Das ist auch
der Punkt — die Regel selbst ist die Aussage, nicht eine bestimmte Datei.

Hintergrund: Bauteile hängen über `IfcRelContainedInSpatialStructure` am
Geschoss, Räume dagegen über `IfcRelAggregates` (`Decomposes`). Wer nur den
ersten Weg geht, bekommt bei **jedem** Raum `None` — im Viewer landen dann alle
Räume in einem Sammelgeschoss und der Geschossfilter ist wirkungslos.

Ausführen:  python3 tests/test_storey.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tiling.section import _storey_of  # noqa: E402


class Entity:
    """Minimale IFC-Attrappe: kennt ihren Typ, Namen und ihre Zerlegung."""

    def __init__(self, typ, name=None, decomposes=()):
        self._typ = typ
        self.Name = name
        self.Decomposes = list(decomposes)

    def is_a(self, typ=None):
        return self._typ if typ is None else self._typ == typ


class Rel:
    def __init__(self, relating):
        self.RelatingObject = relating


class Util:
    """`ifcopenshell.util.element`-Ersatz mit einstellbarem Container."""

    def __init__(self, container=None, wirft=False):
        self._container = container
        self._wirft = wirft

    def get_container(self, element):
        if self._wirft:
            raise RuntimeError("kaputte Datei")
        return self._container


fehler = 0


def pruefe(name, ist, soll):
    global fehler
    ok = ist == soll
    print(f"{'✓' if ok else '✗'} {name}" + ("" if ok else f"  → {ist!r} statt {soll!r}"))
    if not ok:
        fehler += 1


# 1 · Der gewohnte Weg: Bauteil hängt über ContainedInSpatialStructure.
wand = Entity("IfcWall", "Außenwand")
pruefe("Bauteil über den Container",
       _storey_of(Util(Entity("IfcBuildingStorey", "EG")), wand), "EG")

# 2 · Der Raumweg: kein Container, dafür Decomposes → Geschoss.
#     Genau dieser Fall stand vorher auf None.
eg = Entity("IfcBuildingStorey", "EG-OK FFB")
raum = Entity("IfcSpace", "1", decomposes=[Rel(eg)])
pruefe("Raum über Decomposes", _storey_of(Util(None), raum), "EG-OK FFB")

# 3 · Über zwei Stufen: Raum in einer Raumgruppe, die im Geschoss liegt.
gruppe = Entity("IfcSpace", "Wohnung 1", decomposes=[Rel(eg)])
teilraum = Entity("IfcSpace", "1.1", decomposes=[Rel(gruppe)])
pruefe("Raum über zwei Stufen", _storey_of(Util(None), teilraum), "EG-OK FFB")

# 4 · Der Container gewinnt, wenn es ihn gibt — er ist die direktere Aussage.
beides = Entity("IfcSpace", "9", decomposes=[Rel(eg)])
pruefe("Container hat Vorrang",
       _storey_of(Util(Entity("IfcBuildingStorey", "1.OG")), beides), "1.OG")

# 5 · Nichts zu finden: weder Container noch Zerlegung.
pruefe("ohne beides None", _storey_of(Util(None), Entity("IfcSpace", "x")), None)

# 6 · Die Kette endet am Gebäude statt am Geschoss — kein Geschossname da.
bau = Entity("IfcBuilding", "Haus")
freiraum = Entity("IfcSpace", "Hof", decomposes=[Rel(bau)])
pruefe("Kette ohne Geschoss ergibt None", _storey_of(Util(None), freiraum), None)

# 7 · Ein zyklisch fehlerhaftes Modell darf nicht endlos laufen.
a = Entity("IfcSpace", "A")
b = Entity("IfcSpace", "B", decomposes=[Rel(a)])
a.Decomposes = [Rel(b)]
pruefe("Zyklus bricht ab", _storey_of(Util(None), a), None)

# 8 · Wirft `get_container`, wird trotzdem der zweite Weg versucht — vorher
#     verschluckte das `except` beide Wege auf einmal.
pruefe("Ausnahme fällt auf Decomposes zurück",
       _storey_of(Util(wirft=True), raum), "EG-OK FFB")

print("\nAlle Prüfungen bestanden." if not fehler else f"\n{fehler} Prüfung(en) fehlgeschlagen")
sys.exit(1 if fehler else 0)
