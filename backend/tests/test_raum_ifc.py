"""
Prüfstein für das Zurückschreiben der Raumansicht ins IFC (`ileen/raum_ifc.py`).

Geprüft wird, was still schiefgehen kann:

* **Herkunft.** Jeder Wert in `Pset_iLEEN_Raum` hat seinen Eintrag in
  `Pset_iLEEN_RaumHerkunft` — sonst sähe ein Katalogrichtwert im IFC aus wie
  eine Angabe der Fachplanung.
* **Rundlauf.** Die angereicherte Datei, wieder gelesen, bringt die Raumklasse
  und die Planungsangaben zurück — Katalogwerte **nicht**.
* **Normsätze: nur füllen.** Was schon steht, bleibt; ein Satz, den sich
  mehrere Räume teilen, wird nicht angefasst.
* **Kein Doppel.** Ein zweiter Export ersetzt den ersten, statt einen zweiten
  `Pset_iLEEN_Raum` an den Raum zu hängen.
* **Temperatur in der Einheit der Datei** — Kelvin ohne Vereinbarung, °C mit.

Ausführen:  python3 tests/test_raum_ifc.py   (braucht ifcopenshell)
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ifcopenshell  # noqa: E402
import ifcopenshell.api  # noqa: E402
import ifcopenshell.util.element as ue  # noqa: E402

from ileen import raum_ifc, raumdaten  # noqa: E402

_gut = True


def pruefe(bedingung, was, ist=None):
    global _gut
    print(f"  {'ok   ' if bedingung else 'FEHLT'} {was}" + ("" if bedingung or ist is None else f"\n        ist {ist!r}"))
    _gut &= bool(bedingung)


def modell(schema: str, celsius: bool) -> tuple[Path, list[str]]:
    """Ein Projekt mit drei Räumen; zwei teilen sich einen Pset_SpaceThermalRequirements."""
    f = ifcopenshell.api.run("project.create_file", version=schema)
    if schema == "IFC2X3":
        # IFC2X3 verlangt eine OwnerHistory an jedem IfcRoot; ifcopenshell.api
        # legt sie selbst an, braucht dafür aber Nutzer und Anwendung.
        import ifcopenshell.api.owner.settings as besitz
        person = f.create_entity("IfcPerson", FamilyName="Prüf")
        org = f.create_entity("IfcOrganization", Name="HS Mainz")
        po = f.create_entity("IfcPersonAndOrganization", ThePerson=person, TheOrganization=org)
        app = f.create_entity("IfcApplication", ApplicationDeveloper=org, Version="1",
                              ApplicationFullName="Prüf", ApplicationIdentifier="pruef")
        besitz.get_user = lambda _f: po
        besitz.get_application = lambda _f: app
    projekt = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="Prüf")
    ifcopenshell.api.run("unit.assign_unit", f)
    if celsius:
        grad = f.create_entity("IfcSIUnit", UnitType="THERMODYNAMICTEMPERATUREUNIT", Name="DEGREE_CELSIUS")
        zuweisung = f.by_type("IfcUnitAssignment")[0]
        zuweisung.Units = list(zuweisung.Units) + [grad]
    gebaeude = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="Haus")
    geschoss = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="EG")
    ifcopenshell.api.run("aggregate.assign_object", f, products=[gebaeude], relating_object=projekt)
    ifcopenshell.api.run("aggregate.assign_object", f, products=[geschoss], relating_object=gebaeude)
    raeume = []
    for name in ("Büro", "Archiv", "Flur"):
        r = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcSpace", name=name)
        ifcopenshell.api.run("aggregate.assign_object", f, products=[r], relating_object=geschoss)
        raeume.append(r)
    # Büro hat schon eine Beleuchtungsstärke vom Planer: 750 lx — darf nicht überschrieben werden.
    pset = ifcopenshell.api.run("pset.add_pset", f, product=raeume[0], name="Pset_SpaceLightingRequirements")
    ifcopenshell.api.run("pset.edit_pset", f, pset=pset, properties={"Illuminance": 750.0})
    # Archiv und Flur teilen sich einen Thermosatz (so legen ArchiCAD und Revit gern an).
    geteilt = ifcopenshell.api.run("pset.add_pset", f, product=raeume[1], name="Pset_SpaceThermalRequirements")
    ifcopenshell.api.run("pset.edit_pset", f, pset=geteilt, properties={"SpaceTemperatureMax": 26.0})
    rel = [r for r in f.by_type("IfcRelDefinesByProperties") if r.RelatingPropertyDefinition == geteilt][0]
    rel.RelatedObjects = list(rel.RelatedObjects) + [raeume[2]]
    pfad = Path(tempfile.mkdtemp()) / f"pruef_{schema}.ifc"
    f.write(str(pfad))
    return pfad, [r.GlobalId for r in raeume]


def werte(klasse, bez, herkunft, **w):
    return {"klasse": klasse, "klasse_bezeichnung": bez, "klasse_herkunft": herkunft,
            "werte": {k: {"wert": v[0], "quelle_art": v[1], "quelle_text": v[2]} for k, v in w.items()}}


for schema, celsius in (("IFC4", False), ("IFC2X3", True)):
    print(f"\n{schema} ({'°C vereinbart' if celsius else 'ohne Temperatureinheit → Kelvin'})")
    quelle, gids = modell(schema, celsius)
    raeume = {
        gids[0]: werte("buero", "Büro- und Arbeitsraum", "regel",
                       lux=(500, "katalog", "Raumklasse Büro · EN 12464-1"),
                       elektro=(25, "katalog", "Raumklasse Büro"),
                       nutzlast_kat=("B1", "statik", "raumlasten.kategorie_von"),
                       nutzlast=(2.0, "statik", "B1 · DIN EN 1991-1-1/NA"),
                       temperatur=(20, "katalog", "DIN/TS 12831-1"),
                       personen=(2.4, "abgeleitet", "24 m² ÷ 10 m²/Pers."),
                       din277=("NUF 2", "abgeleitet", "Hauptgruppe aus der Raumklasse"),
                       befunde=("Steigstrang fehlt in 6 m Umkreis", "pruefung", "Raumansicht")),
        gids[1]: werte("archiv", "Archiv Registratur und Tresor", "hand",
                       nutzlast_kat=("E1.1", "hand", "Eingriff Nr. 3"),
                       temperatur=(15, "katalog", "DIN/TS 12831-1"),
                       bodenbelag=("Linoleum", "ifc", "Pset_SpaceCommon.FloorCovering")),
        "GIBT-ES-NICHT": werte("flur", "Flur", "regel"),
    }
    ziel = quelle.with_name("angereichert.ifc")
    proto = raum_ifc.anreichern(quelle, ziel, raeume, normsaetze=True)
    pruefe(proto["raeume"] == 2 and proto["nicht_gefunden"] == ["GIBT-ES-NICHT"],
           "zwei Räume geschrieben, unbekannte GlobalId gemeldet", proto)

    f = ifcopenshell.open(str(ziel))
    buero, archiv, flur = (f.by_guid(g) for g in gids)
    p = ue.get_psets(buero)
    satz, herkunft = p.get(raum_ifc.PSET, {}), p.get(raum_ifc.PSET_HERKUNFT, {})
    pruefe(satz.get("Raumklasse") == "buero" and satz.get("Raumklasse_Bezeichnung") == "Büro- und Arbeitsraum",
           "Raumklasse als Kennung und Bezeichnung", satz)
    pruefe(satz.get("Nutzlast_kNm2") == 2.0 and satz.get("Nutzlastkategorie") == "B1", "Nutzlast mit Einheit im Namen", satz)
    namen_ohne_herkunft = [n for n in satz if n not in herkunft and n not in ("id", "Raumklasse_Bezeichnung")]
    pruefe(not namen_ohne_herkunft, "jeder Wert hat eine Herkunft", namen_ohne_herkunft)
    pruefe(herkunft.get("Beleuchtungsstaerke_lx", "").startswith("katalog:"), "Katalog als Katalog markiert", herkunft)
    pruefe("Steigstrang" in (satz.get("Pruefbefunde") or ""), "Prüfbefunde als Text")

    # Normsätze: die 750 lx des Planers bleiben, die Temperatur kommt dazu.
    pruefe(p["Pset_SpaceLightingRequirements"]["Illuminance"] == 750.0, "vorhandene Beleuchtungsstärke nicht überschrieben",
           p["Pset_SpaceLightingRequirements"])
    t = p.get("Pset_SpaceThermalRequirements", {}).get("SpaceTemperatureMin")
    soll = 20.0 if celsius else 293.15
    pruefe(t is not None and abs(t - soll) < 1e-6, f"Temperatur in der Einheit der Datei ({soll})", t)
    pruefe(p.get("Pset_SpaceOccupancyRequirements", {}).get("OccupancyNumber") == 2,
           "Personen als ganze Zahl im Normsatz", p.get("Pset_SpaceOccupancyRequirements"))
    pa = ue.get_psets(archiv)
    pruefe("SpaceTemperatureMin" not in pa["Pset_SpaceThermalRequirements"],
           "geteilter Thermosatz nicht angefasst", pa["Pset_SpaceThermalRequirements"])
    pruefe(proto["normsaetze_geteilt_uebersprungen"] >= 1, "und das steht im Protokoll", proto)
    pruefe(proto["din277_klassifiziert"] == 1, "DIN-277-Klassifikation am Büro", proto)

    # Rundlauf: zurücklesen wie das Backend es tut
    m = raumdaten.merkmale(ue.get_psets(buero))
    pruefe(m.get("ileen_klasse", {}).get("wert") == "buero", "Raumklasse kommt zurück", m.get("ileen_klasse"))
    pruefe("elektro_w_m2" not in m and "beleuchtung_lx" not in m or m.get("beleuchtung_lx", {}).get("quelle", "").startswith("Pset_SpaceLighting"),
           "Katalogwerte kommen nicht als IFC-Angabe zurück", {k: v.get("quelle") for k, v in m.items()})
    pruefe(m.get("nutzlast_kategorie", {}).get("wert") == "B1" and m["nutzlast_kategorie"].get("herkunft") == "statik",
           "Statikangabe kommt mit Herkunft zurück", m.get("nutzlast_kategorie"))
    ma = raumdaten.merkmale(ue.get_psets(archiv))
    pruefe(ma.get("ileen_klasse", {}).get("herkunft") == "hand", "Handzuordnung bleibt Hand", ma.get("ileen_klasse"))
    pruefe(ma.get("bodenbelag", {}).get("wert") == "Linoleum", "IFC-Angabe kommt zurück", ma.get("bodenbelag"))

    # Zweiter Export auf die angereicherte Datei: ersetzt, verdoppelt nicht
    zweite = ziel.with_name("zweimal.ifc")
    proto2 = raum_ifc.anreichern(ziel, zweite, raeume, normsaetze=False)
    f2 = ifcopenshell.open(str(zweite))
    zahl = sum(1 for r in f2.by_guid(gids[0]).IsDefinedBy
               if r.is_a("IfcRelDefinesByProperties") and r.RelatingPropertyDefinition.Name == raum_ifc.PSET)
    pruefe(zahl == 1 and proto2["ersetzt"] == 4, "zweiter Export ersetzt (je Raum zwei Sätze)", (zahl, proto2["ersetzt"]))

print("\n" + ("Alle Prüfungen bestanden." if _gut else "Es gibt Fehlschläge."))
sys.exit(0 if _gut else 1)
