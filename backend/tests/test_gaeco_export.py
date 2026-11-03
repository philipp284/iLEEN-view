"""
Prüfstein für den Export nach gaeco — **ohne Broker und ohne gaeco**.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Was hier still schiefginge, und woran es geprüft wird:

1. **Die Kennung.** `uuid5(NAMESPACE_DNS, GlobalId)` muss auf beiden Seiten
   dieselbe sein — hier und in `gaeco/modul/assets/kennung.js`. Beide Tests
   prüfen gegen dieselben festen Werte (`KENNUNGEN` unten und in
   `gaeco/tests/test-kennung.mjs`).
2. **Der Graph.** Ein Modell, das dieser Test selbst baut: Projekt bis Raum,
   eine Wand mit Fenster in einer Öffnung, ein Proxy, dazu je ein Element,
   das nicht hinausdarf (Aussparung, virtuelles Element, Anmerkung). Geprüft
   werden Knoten, Klassen, Eigenschaften und Kanten.
3. **Die Nachricht.** Genau ein JSON-Objekt, einzeilig — ein Array quittiert
   gaecos Verbraucher mit `JsonException … Path: $`.
4. **Die Teilung.** Wird ein Modell zu groß, muss jeder Knoten genau einmal
   und jede Kante genau einmal hinausgehen, und zwar nie vor ihren Knoten.

Ausführen:  python3 tests/test_gaeco_export.py
"""

import json
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ifcopenshell  # noqa: E402
import ifcopenshell.api  # noqa: E402
import ifcopenshell.guid  # noqa: E402

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
    return bedingung


def gleich(ist, soll, was):
    return pruefe(ist == soll, was, ist, soll)


# Dieselben Paare stehen in gaeco/tests/test-kennung.mjs.
KENNUNGEN = {
    "2O2Fr$t4X7Zf8NOew3FLOH": "0691f9ca-8201-51b9-8246-f8040111c37a",
    "3vB2YO$MX4xv5uCqZZG05x": "ff52d7c8-e659-5547-8225-b372a2b56192",
    "0LV8Pr0ZT5Ix6iH2sWYV_3": "378582c5-6dc0-57ee-9ca4-95693437ff99",
}

print("1 · Kennung")
for gid, soll in KENNUNGEN.items():
    gleich(ge.instanz_id(gid), soll, f"instanz_id({gid}) — fester Wert, derselbe wie in kennung.js")
    gleich(soll, str(uuid.uuid5(uuid.NAMESPACE_DNS, gid)), "  … und das ist uuid5(NAMESPACE_DNS, GlobalId)")
gleich(ge.topic("212f766f-7a53-4197-b4e5-95fbb7e9a85c"),
       "ekkodale.gaeco.instance.public.212f766f-7a53-4197-b4e5-95fbb7e9a85c.gaecoImport",
       "Topic folgt gaecos Muster …public.<useCase>.gaecoImport")


# ── Ein Modell bauen ────────────────────────────────────────────────────────

def modell():
    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    projekt = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="Prüfprojekt")
    ifcopenshell.api.run("unit.assign_unit", f)
    site = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSite", name="Grundstück")
    bau = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Haus")
    eg = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="EG")
    raum = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSpace", name="0.01")
    raum.LongName = "Büro"
    ifcopenshell.api.run("aggregate.assign_object", f, products=[site], relating_object=projekt)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[bau], relating_object=site)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[eg], relating_object=bau)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[raum], relating_object=eg)

    wand = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWallStandardCase", name="AW 01")
    wand.ObjectType = "Außenwand 36,5"
    pset = ifcopenshell.api.run("pset.add_pset", f, product=wand, name="Pset_WallCommon")
    ifcopenshell.api.run("pset.edit_pset", f, pset=pset,
                         properties={"IsExternal": True, "LoadBearing": True, "Reference": "AW",
                                     "ThermalTransmittance": 0.21})
    eigen = ifcopenshell.api.run("pset.add_pset", f, product=wand, name="Hersteller_Daten")
    ifcopenshell.api.run("pset.edit_pset", f, pset=eigen, properties={"IsExternal": False, "Fabrikat": "X"})

    fenster = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWindow", name="F 01")
    oeffnung = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcOpeningElement", name="Öffnung")
    f.create_entity("IfcRelVoidsElement", GlobalId=ifcopenshell.guid.new(),
                    RelatingBuildingElement=wand, RelatedOpeningElement=oeffnung)
    f.create_entity("IfcRelFillsElement", GlobalId=ifcopenshell.guid.new(),
                    RelatingOpeningElement=oeffnung, RelatedBuildingElement=fenster)

    proxy = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingElementProxy", name="Sonderteil")
    virtuell = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcVirtualElement", name="Raumgrenze")
    notiz = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcAnnotation", name="Text")
    ifcopenshell.api.run("spatial.assign_container", f, products=[wand, fenster, proxy, virtuell, oeffnung],
                         relating_structure=eg)
    return f, dict(projekt=projekt, site=site, bau=bau, eg=eg, raum=raum, wand=wand,
                   fenster=fenster, proxy=proxy, oeffnung=oeffnung, virtuell=virtuell, notiz=notiz)


datei, o = modell()
index = ge.GuidelineIndex.laden(Path(__file__).resolve().parent.parent / "data/gaeco/ifc_guideline_index.json")
if index.klassen is None:
    # Ohne erzeugten Index ein kleiner Ersatz — wie die echte Guideline ohne
    # IfcWallStandardCase, damit die Obertyp-Regel geprüft wird.
    index = ge.GuidelineIndex(
        {"IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace", "IfcWall",
         "IfcWindow", "IfcBuildingElementProxy"},
        dict(ge.ATTRIBUTE, IsExternal="Is External", LoadBearing="Load Bearing",
             ThermalTransmittance="Thermal Transmittance"),
        quelle="Ersatz im Test")
print(f"\n2 · Graph (Guideline-Index: {index.quelle})")

g = ge.graph_aus_ifc(datei, index)
nach_gid = {k.code: k for k in g.knoten}

gleich(sorted(nach_gid), sorted(x.GlobalId for k, x in o.items()
                                if k not in ("oeffnung", "virtuell", "notiz")),
       "Knoten: Projekt bis Raum, Wand, Fenster, Proxy — ohne Öffnung, virtuelles Element, Anmerkung")
gleich([k.ifc_typ for k in g.knoten[:5]],
       ["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace"],
       "die räumliche Struktur steht vorn (sie muss vor ihren Kanten in gaeco sein)")

wand = nach_gid[o["wand"].GlobalId]
gleich(wand.klasse, ge.IFC_KLASSEN + "IfcWall", "IfcWallStandardCase → IfcWall (Obertyp, den die Guideline kennt)")
gleich(wand.id, ge.instanz_id(o["wand"].GlobalId), "Knoten-Id ist uuid5 der GlobalId")
gleich(wand.code, o["wand"].GlobalId, "Code ist die GlobalId (sie steht damit im Instanznamen)")
gleich(wand.eigenschaften.get("Global ID"), o["wand"].GlobalId, "Attribut GlobalId → „Global ID“")
gleich(wand.eigenschaften.get("Name"), "AW 01", "Attribut Name")
gleich(wand.eigenschaften.get("Object Type"), "Außenwand 36,5", "Attribut ObjectType → „Object Type“")
gleich(wand.eigenschaften.get("Is External"), "true",
       "Pset_WallCommon gewinnt gegen das Herstellerset (beide führen IsExternal)")
gleich(wand.eigenschaften.get("Load Bearing"), "true", "bool als Zeichenkette „true“")
gleich(wand.eigenschaften.get("Thermal Transmittance"), "0.21", "Zahl als Zeichenkette")
pruefe("Fabrikat" not in wand.eigenschaften and "Reference" not in wand.eigenschaften,
       "was die Guideline nicht kennt, geht nicht hinaus")
pruefe(all(isinstance(v, str) for k in g.knoten for v in k.eigenschaften.values()),
       "alle Werte sind Zeichenketten")
pruefe(any("IfcWallStandardCase → IfcWall" in h for h in g.hinweise),
       "die Ersetzung steht in den Hinweisen")


def id_von(name):
    return ge.instanz_id(o[name].GlobalId)


kanten = {(k.subjekt, k.praedikat, k.objekt) for k in g.kanten}
for oben, unten in (("projekt", "site"), ("site", "bau"), ("bau", "eg"), ("eg", "raum")):
    pruefe((id_von(oben), ge.AGGREGIERT, id_von(unten)) in kanten, f"aggregates {oben} → {unten}")
for teil in ("wand", "fenster", "proxy"):
    pruefe((id_von("eg"), ge.ENTHAELT, id_von(teil)) in kanten, f"containsElement EG → {teil}")
pruefe((id_von("wand"), ge.FUELLT, id_von("fenster")) in kanten, "hasFillingElement Wand → Fenster (über die Öffnung)")
gleich(len(g.kanten), 4 + 3 + 1, "keine Kante zu einem ausgeschlossenen Element, keine doppelt")


print("\n3 · Nachricht")
teile = ge.nachrichten(g, "212f766f-7a53-4197-b4e5-95fbb7e9a85c")
gleich(len(teile), 1, "ein kleines Modell ist eine Nachricht")
roh = teile[0].decode("utf-8")
pruefe("\n" not in roh, "einzeilig")
n = json.loads(roh)
pruefe(isinstance(n, dict), "genau ein Objekt, kein Array")
gleich(sorted(n), sorted(["GraphTemplate", "GraphData", "AccessRights", "Guidelines", "UseCase", "GraphMetadata"]),
       "die Felder des GraphDataModel")
gleich(n["UseCase"]["Id"], "212f766f-7a53-4197-b4e5-95fbb7e9a85c", "UseCase.Id")
gleich(len(n["GraphMetadata"]), len(g.knoten), "alle Knoten in GraphMetadata")
gleich(sorted(n["GraphMetadata"][0]), ["ClassType", "Code", "Id", "PropertiesValues"], "Felder je Knoten")
tripel = [z for z in n["GraphData"].splitlines() if z.startswith("inst:")]
gleich(len(tripel), len(g.kanten), "jede Kante eine Turtle-Zeile")
pruefe(all(z.endswith(".") and z.count("inst:") == 2 for z in tripel), "Turtle: inst:<id> <prädikat> inst:<id>.")


print("\n4 · Teilung")
klein = ge.nachrichten(g, "212f766f-7a53-4197-b4e5-95fbb7e9a85c", max_bytes=1600)
pruefe(len(klein) > 2, f"mit kleiner Grenze mehrere Nachrichten ({len(klein)})")
gesehen_knoten, gesehen_kanten, vorher = [], [], set()
reihenfolge_gut = True
for teil in klein:
    m = json.loads(teil)
    jetzt = {x["Id"] for x in m["GraphMetadata"]}
    gesehen_knoten += list(jetzt)
    for z in m["GraphData"].splitlines():
        if not z.startswith("inst:"):
            continue
        teile_z = z.rstrip(".").split()
        s, p, ob = teile_z[0][5:], teile_z[1], teile_z[2][5:]
        gesehen_kanten.append((s, p.strip("<>"), ob))
        if not ({s, ob} <= (vorher | jetzt)):
            reihenfolge_gut = False
    vorher |= jetzt
gleich(sorted(gesehen_knoten), sorted(k.id for k in g.knoten), "jeder Knoten genau einmal")
gleich(sorted(gesehen_kanten), sorted(kanten), "jede Kante genau einmal")
pruefe(reihenfolge_gut, "keine Kante vor ihren beiden Knoten")


print("\n5 · Ohne Index")
ohne = ge.graph_aus_ifc(datei, ge.GuidelineIndex.ohne())
w = {k.code: k for k in ohne.knoten}[o["wand"].GlobalId]
gleich(w.klasse, ge.IFC_KLASSEN + "IfcWall", "StandardCase wird auch ohne Index abgeschnitten")
gleich(sorted(w.eigenschaften), sorted(["Global ID", "Name", "Object Type"]),
       "nur die Attribute mit festem Klarnamen")


print("\n6 · Betriebsprofil")
d6, o6 = modell()
tga = {}
for name, klasse in (("pumpe", "IfcPump"), ("rohr", "IfcPipeSegment"), ("fuehler", "IfcSensor"),
                     ("tuer", "IfcDoor"), ("aufzug", "IfcTransportElement")):
    tga[name] = ifcopenshell.api.run("root.create_entity", d6, ifc_class=klasse, name=name)
ifcopenshell.api.run("spatial.assign_container", d6, products=list(tga.values()), relating_structure=o6["eg"])
index6 = ge.GuidelineIndex(
    (set(index.klassen) if index.klassen is not None else
     {"IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace", "IfcWall", "IfcWindow",
      "IfcBuildingElementProxy"}) | {"IfcPump", "IfcPipeSegment", "IfcSensor", "IfcDoor", "IfcTransportElement"},
    index.eigenschaften, quelle="Prüfung Profil")

voll = ge.graph_aus_ifc(d6, index6, profil="voll")
betrieb = ge.graph_aus_ifc(d6, index6, profil="betrieb")
codes_b = {k.code for k in betrieb.knoten}
gleich({k.ifc_typ for k in betrieb.knoten} - {"IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace"},
       {"IfcPump", "IfcSensor", "IfcTransportElement"},
       "Betrieb: Struktur, Räume und die Anlagen — Pumpe, Fühler, Aufzug")
for name in ("wand", "fenster", "proxy"):
    pruefe(o6[name].GlobalId not in codes_b, f"Betrieb lässt {name} im IFC")
pruefe(tga["rohr"].GlobalId not in codes_b, "Betrieb lässt das Leitungsstück im IFC")
pruefe(len(betrieb.knoten) < len(voll.knoten), f"Betrieb ist kleiner ({len(betrieb.knoten)} < {len(voll.knoten)})")
ids_b = {k.id for k in betrieb.knoten}
pruefe(all(k.subjekt in ids_b and k.objekt in ids_b for k in betrieb.kanten), "keine Kante zeigt aus dem Profil hinaus")
pruefe((ge.instanz_id(o6["eg"].GlobalId), ge.ENTHAELT, ge.instanz_id(tga["pumpe"].GlobalId))
       in {(k.subjekt, k.praedikat, k.objekt) for k in betrieb.kanten}, "containsElement EG → Pumpe bleibt")
gleich({k.id: k.eigenschaften for k in betrieb.knoten if k.code == tga["pumpe"].GlobalId}[ge.instanz_id(tga["pumpe"].GlobalId)]["Name"],
       "pumpe", "Eigenschaften der Anlage gehen mit")
pruefe(any(h.startswith("Profil betrieb") for h in betrieb.hinweise), "der Hinweis nennt, was im IFC blieb")
gleich({k.id for k in voll.knoten} >= ids_b, True, "dieselben Kennungen wie im vollen Profil (nachreichen bleibt möglich)")

mit_tuer = ge.graph_aus_ifc(d6, index6, profil="betrieb", zusaetzlich=("IfcDoor",))
pruefe(tga["tuer"].GlobalId in {k.code for k in mit_tuer.knoten}, "zusaetzlich=IfcDoor nimmt die Tür mit")
pruefe(tga["rohr"].GlobalId not in {k.code for k in mit_tuer.knoten}, "… und nur sie")
mit_rohr = ge.graph_aus_ifc(d6, index6, profil="betrieb", zusaetzlich=("IfcPipeSegment",))
pruefe(tga["rohr"].GlobalId in {k.code for k in mit_rohr.knoten}, "ausdrücklich genannt, kommt auch ein Leitungsstück mit")
weg = ge.ueberzaehlige(d6, index6)
gleich(set(weg["entfernen"]), {k.id for k in voll.knoten} - ids_b, "überzählig = voll minus Betriebsprofil")
gleich((weg["voll"], weg["behalten"], len(weg["entfernen"])), (len(voll.knoten), len(betrieb.knoten), len(voll.knoten) - len(betrieb.knoten)),
       "die Zahlen gehen auf")
pruefe(ge.instanz_id(tga["pumpe"].GlobalId) not in weg["entfernen"] and ge.instanz_id(o6["wand"].GlobalId) in weg["entfernen"],
       "die Pumpe bleibt, die Wand soll weg")
pruefe(ge.instanz_id(tga["tuer"].GlobalId) not in ge.ueberzaehlige(d6, index6, zusaetzlich=("IfcDoor",))["entfernen"],
       "mit zusaetzlich=IfcDoor bleibt auch die Tür")
try:
    ge.graph_aus_ifc(d6, index6, profil="alles")
    pruefe(False, "unbekanntes Profil wird abgelehnt")
except ValueError:
    pruefe(True, "unbekanntes Profil wird abgelehnt")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
