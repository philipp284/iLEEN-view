"""
Prüfstein für den Detailgraphen (SPIDER) — **ohne Broker, ohne gaeco, ohne Server**.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Ein Modell, das dieser Test selbst baut: Projekt bis Raum, 150 Wände in zwei Typen, 4 Fenster
im Raum, ein Wandelement mit 130 Teilen, ein Bauteil ohne Geschoss. Geprüft wird, was beim
Gliedern still schiefgehen würde:

1. Jeder Knoten hängt an **genau einem** Elternknoten, es gibt eine Wurzel, keinen Zyklus.
2. Kein Elternknoten hat mehr als `max_gruppe` Kinder — Aufklappen zeigt nie Tausende.
3. Kein Bauteil geht verloren oder kommt doppelt vor; die Zahl an der Gruppe stimmt.
4. Die Kennung ist `uuid5(GlobalId)` — dieselbe wie beim Export nach gaeco.
5. Gruppenkennungen sind deterministisch (zweimal gerechnet = gleich).
6. Teile hängen an ihrem Elternbauteil, nicht am Geschoss.

Ausführen:  python3 tests/test_gaeco_detail.py
"""

import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ifcopenshell  # noqa: E402
import ifcopenshell.api  # noqa: E402

from ileen import gaeco_detail as gd  # noqa: E402
from ileen import gaeco_export as ge  # noqa: E402

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


def gleich(ist, soll, was):
    pruefe(ist == soll, was, ist, soll)


def api(f, aufruf, **kw):
    return ifcopenshell.api.run(aufruf, f, **kw)


def modell():
    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    projekt = api(f, "root.create_entity", ifc_class="IfcProject", name="Prüfprojekt")
    api(f, "unit.assign_unit")
    site = api(f, "root.create_entity", ifc_class="IfcSite", name="Grundstück")
    bau = api(f, "root.create_entity", ifc_class="IfcBuilding", name="Haus")
    eg = api(f, "root.create_entity", ifc_class="IfcBuildingStorey", name="EG")
    raum = api(f, "root.create_entity", ifc_class="IfcSpace", name="0.01")
    api(f, "aggregate.assign_object", products=[site], relating_object=projekt)
    api(f, "aggregate.assign_object", products=[bau], relating_object=site)
    api(f, "aggregate.assign_object", products=[eg], relating_object=bau)
    api(f, "aggregate.assign_object", products=[raum], relating_object=eg)

    typ_a = api(f, "root.create_entity", ifc_class="IfcWallType", name="Außenwand 36")
    typ_b = api(f, "root.create_entity", ifc_class="IfcWallType", name="Innenwand 12")
    waende = []
    for i in range(150):
        w = api(f, "root.create_entity", ifc_class="IfcWall", name=f"W{i:03d}")
        api(f, "type.assign_type", related_objects=[w], relating_type=typ_a if i % 3 else typ_b)
        waende.append(w)
    fenster = [api(f, "root.create_entity", ifc_class="IfcWindow", name=f"F{i}") for i in range(4)]
    api(f, "spatial.assign_container", products=waende, relating_structure=eg)
    api(f, "spatial.assign_container", products=fenster, relating_structure=raum)

    elem = api(f, "root.create_entity", ifc_class="IfcWall", name="Fertigteilwand")
    api(f, "spatial.assign_container", products=[elem], relating_structure=eg)
    teile = [api(f, "root.create_entity", ifc_class="IfcBuildingElementPart", name=f"T{i:03d}") for i in range(130)]
    api(f, "aggregate.assign_object", products=teile, relating_object=elem)

    lose = api(f, "root.create_entity", ifc_class="IfcBuildingElementProxy", name="Ohne Geschoss")
    return f, dict(projekt=projekt, eg=eg, raum=raum, waende=waende, fenster=fenster,
                   elem=elem, teile=teile, lose=lose)


def pruefe_baum(d, max_gruppe):
    knoten = {k["id"]: k for k in d["knoten"]}
    gleich(len(knoten), len(d["knoten"]), "jede Knotenkennung kommt genau einmal vor")
    eltern = defaultdict(list)
    kinder = defaultdict(list)
    for a, b, art in d["kanten"]:
        eltern[b].append(a)
        kinder[a].append(b)
    pruefe(all(len(v) == 1 for v in eltern.values()), "jeder Knoten hat höchstens einen Elternknoten",
           Counter(len(v) for v in eltern.values()))
    wurzeln = [i for i in knoten if i not in eltern]
    gleich(len(wurzeln), 1, "genau eine Wurzel")
    gleich(knoten[wurzeln[0]]["klasse"], "IfcProject", "… und sie ist das Projekt")
    pruefe(all(a in knoten and b in knoten for a, b, _ in d["kanten"]), "keine Kante zeigt ins Leere")
    gesehen, stapel = set(), [wurzeln[0]]
    while stapel:
        i = stapel.pop()
        gesehen.add(i)
        stapel.extend(kinder.get(i, ()))
    gleich(len(gesehen), len(knoten), "alle Knoten sind von der Wurzel aus erreichbar (kein Zyklus, keine Insel)")
    pruefe(all(len(v) <= max_gruppe for v in kinder.values()),
           f"kein Elternknoten hat mehr als {max_gruppe} Kinder", max(len(v) for v in kinder.values()), max_gruppe)
    return knoten, eltern, kinder


print("1 · Gliederung")
datei, o = modell()
d = gd.detail_graph(datei, ge.GuidelineIndex.ohne(), max_gruppe=40)
knoten, eltern, kinder = pruefe_baum(d, 40)

bauteile = [k for k in d["knoten"] if k["art"] == "bauteil"]
gleich(len(bauteile), 150 + 4 + 1 + 130 + 1, "kein Bauteil geht verloren oder kommt doppelt vor")

print("\n2 · Kennung und Zuordnung")
gid = o["waende"][0].GlobalId
pruefe(ge.instanz_id(gid) in knoten, "Kennung ist uuid5(NAMESPACE_DNS, GlobalId) — wie beim Export")
teil_id = ge.instanz_id(o["teile"][0].GlobalId)
elem_id = ge.instanz_id(o["elem"].GlobalId)


def vorfahren(i):
    kette = []
    while i in eltern:
        i = eltern[i][0]
        kette.append(i)
    return kette


pruefe(elem_id in vorfahren(teil_id), "ein Teil hängt unter seinem Elternbauteil")
pruefe(ge.instanz_id(o["eg"].GlobalId) not in {x for x in eltern[teil_id]},
       "… und nicht direkt am Geschoss")
gruppen = [k for k in d["knoten"] if k["art"] == "gruppe"]
pruefe(any("Wände" in g["name"] for g in gruppen), "150 Wände werden nach Klasse gruppiert („Wände“)")
pruefe(any("Außenwand 36" in g["name"] for g in gruppen), "… dann nach Typname („Außenwand 36“)")
for g in gruppen:
    unter = 0
    stapel = [g["id"]]
    while stapel:
        i = stapel.pop()
        for c in kinder.get(i, ()):
            unter += 1 if knoten[c]["art"] == "bauteil" else 0
            stapel.append(c)
    if unter != g["n"]:
        pruefe(False, f"Zahl an der Gruppe „{g['name']}“ stimmt", g["n"], unter)
        break
else:
    pruefe(True, "die Zahl an jeder Gruppe ist die der Bauteile darunter (alle Ebenen)")
pruefe(any(g["name"].startswith("Ohne Zuordnung") for g in gruppen), "Bauteil ohne Geschoss → Gruppe „Ohne Zuordnung“")
fenster_eltern = {eltern[ge.instanz_id(w.GlobalId)][0] for w in o["fenster"]}
gleich(fenster_eltern, {ge.instanz_id(o["raum"].GlobalId)}, "wenige Bauteile hängen direkt am Raum, ohne Gruppe")

print("\n3 · Deterministisch")
d2 = gd.detail_graph(datei, ge.GuidelineIndex.ohne(), max_gruppe=40)
gleich(d2["kanten"], d["kanten"], "dasselbe Modell zweimal gerechnet: dieselben Kanten, dieselben Gruppenkennungen")
gleich(d2["knoten"], d["knoten"], "… und dieselben Knoten in derselben Reihenfolge")

print("\n4 · Eine Obergrenze nach Wahl")
for m in (8, 60, 200):
    pruefe_baum(gd.detail_graph(modell()[0], ge.GuidelineIndex.ohne(), max_gruppe=m), m)

print("\nALLES GUT" if _gut else "\nFEHLER")
sys.exit(0 if _gut else 1)
