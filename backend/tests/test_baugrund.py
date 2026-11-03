"""
Prüfstein für das Baugrundmodell im Backend — ohne Server, ohne MinIO, ohne Ollama.

Geprüft wird, was zwischen der Datei und dem Modell still falsch wird:

* GGU-CONNECT .GROUND: drei Kopfzeilen je Tabelle, UTF-8 mit BOM, Lage im
  Landessystem, die Zuordnung Schicht → Modellschicht als GUID-Folge OHNE
  Trenner (mit führenden Kommas), Kennwerte als „(min,wert,max)" mit Einheit
  aus der Definitionstabelle, Grundwasserart, Schnitte, zwei Gliederungen
* die Aufbereitung einer KI-Lesung: Zahlen als Text mit Komma, falsche
  Reihenfolge, Lücken, Schichten der Dicke null, unplausible Ansatzhöhe

    python3 tests/test_baugrund.py
"""

import csv
import io
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen.baugrund_ground import GroundFehler, ground_lesen  # noqa: E402
from ileen.baugrund_lesen import aufbereiten  # noqa: E402

fehler = 0


def pruefe(name, ok, zusatz=""):
    global fehler
    print(("✓ " if ok else "✗ ") + name + ("" if ok or not zusatz else f"  → {zusatz}"))
    if not ok:
        fehler += 1


def tabelle(art, kopf, typen, zeilen):
    puffer = io.StringIO()
    w = csv.writer(puffer, delimiter=";", quotechar='"', quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    w.writerow([art, "1"])
    w.writerow(kopf)
    w.writerow(typen)
    for z in zeilen:
        w.writerow(z)
    return ("﻿" + puffer.getvalue()).encode("utf-8")


G = {  # feste GUIDs
    "b1": "11111111-1111-1111-1111-111111111111", "b2": "22222222-2222-2222-2222-222222222222",
    "l1": "AAAAAAA1-0000-0000-0000-000000000001", "l2": "AAAAAAA1-0000-0000-0000-000000000002",
    "l3": "AAAAAAA1-0000-0000-0000-000000000003", "l4": "AAAAAAA1-0000-0000-0000-000000000004",
    "l5": "AAAAAAA1-0000-0000-0000-000000000005",
    "t1": "BBBBBBB1-0000-0000-0000-000000000001", "t2": "BBBBBBB1-0000-0000-0000-000000000002",
    "t3": "BBBBBBB1-0000-0000-0000-000000000003",
    "e1": "CCCCCCC1-0000-0000-0000-000000000001", "e2": "CCCCCCC1-0000-0000-0000-000000000002",
    "c1": "DDDDDDD1-0000-0000-0000-000000000001", "c2": "DDDDDDD1-0000-0000-0000-000000000002",
    "p1": "EEEEEEE1-0000-0000-0000-000000000001", "w1": "FFFFFFF1-0000-0000-0000-000000000001",
}


def ground_bauen(lokal=False):
    ox, oy = (404984.47, 5662689.02)
    x1, y1 = (0.0, 0.0) if lokal else (ox, oy)
    x2, y2 = (25.0, 4.0) if lokal else (ox + 25.0, oy + 4.0)
    steuer = f"""<?xml version="1.0" encoding="utf-8"?>
<Ground version="2212">
  <Description><Creator name="" date="19.09.2024"/><Application name="GGU-CONNECT" version="1.17.0"/>
    <Project name="Prüfprojekt" id="X"/></Description>
  <Settings colors="farben.csv" soilpropertyDefinitions="Bodenwerte_Definition.csv">
    <CoordinateReferenceSystem epsg="25832" projectOrigin="{ox},{oy},0"/>
  </Settings>
  <DTM margin="12.5" constructionType="MeshFromFile" source="dgm.xml"/>
  <Boreholes definition="Aufschluesse.csv" layers="Aufschluss_Bereiche.csv"/>
  <GroundWater definition="Grundwasser_Definition.csv" levels="Grundwasser_Staende.csv"/>
  <GroundModel name="Baugrundschichtenmodell-{G['t1']}" id="{G['t1']}" definition="BS_Definition.csv" layers="BS_Bereiche.csv" parameters="BS_Eigenschaften.csv"/>
  <GroundModel name="Erdarbeiten-{G['e1']}" id="{G['e1']}" definition="E_Definition.csv" layers="E_Bereiche.csv"/>
  <Sections definition="Schnitte.csv"/>
</Ground>"""
    dateien = {
        "fachmodell_baugrund.xml": steuer.encode(),
        "farben.csv": tabelle("COLOR", ["BASE_ID", "BASE_NAME", "COLOR_RED", "COLOR_GREEN", "COLOR_BLUE", "COLOR_ALPHA"],
                              ["guid", "ustring", "int", "int", "int", "int"],
                              [[G["c1"], "Sand", "242", "207", "91", "255"], [G["c2"], "Ton", "156", "132", "196", "255"]]),
        "Bodenwerte_Definition.csv": tabelle("PROPERTYDEFINITION", ["BASE_ID", "BASE_NAME", "BASE_INFO", "PROPERTYDEFINITION_DATATYPE", "PROPERTYDEFINITION_UNIT", "SOILPROPERTYTYPE_ISCUSTOM", "PROPERTYDEFINITION_GUIDELINESINFO"],
                                             ["guid"] * 7, [[G["p1"], "Reibungswinkel", "", "float", "[°]", "false", "DIN 18137"]]),
        "Aufschluesse.csv": tabelle("BOREHOLE", ["BASE_ID", "BASE_NAME", "BASE_INFO", "GEOSYSTEM_EPSG", "POINTOBJECT_SITE_X", "POINTOBJECT_SITE_Y", "POINTOBJECT_HEIGHT_Z", "BOREHOLE_DATE", "BOREHOLE_DEPTH", "BOREHOLE_TYPE"],
                                    ["guid"] * 10,
                                    [[G["b1"], "KRB 1", "", "25832", f"{x1:.6f}", f"{y1:.6f}", "389.83", "25.07.2024", "6.00", "KRB"],
                                     [G["b2"], "KRB 2", "", "25832", f"{x2:.6f}", f"{y2:.6f}", "390.01", "25.07.2024", "5.00", "KRB"]]),
        "Aufschluss_Bereiche.csv": tabelle("BOREHOLELAYER", ["BASE_ID", "BASE_NAME", "BASE_INFO", "BOREHOLELAYER_BOREHOLE", "BOREHOLELAYER_DEPTHFROM", "BOREHOLELAYER_DEPTHTO", "BOREHOLELAYER_PETROGRAPHY", "BOREHOLELAYER_STRATIGRAPHY", "BOREHOLELAYER_GENESIS", "BOREHOLELAYER_EXPLORATIONCOLOR", "BOREHOLELAYER_REPRESENTATIONCOLOR"],
                                           ["guid"] * 11,
                                           [[G["l3"], "KRB 1 - 2", "", G["b1"], "2.50", "6.00", "T", "", "", "grau", G["c2"]],   # absichtlich zuerst
                                            [G["l1"], "KRB 1 - 0", "", G["b1"], "0.00", "1.20", "mS, fs", "Holozän", "fluviatil", "", G["c1"]],
                                            [G["l2"], "KRB 1 - 1", "", G["b1"], "1.20", "2.50", "mS", "", "", "", G["c1"]],
                                            [G["l4"], "KRB 2 - 0", "", G["b2"], "0.00", "3.00", "S", "", "", "", G["c1"]],
                                            [G["l5"], "KRB 2 - 1", "", G["b2"], "3.00", "5.00", "T", "", "", "", G["c2"]]]),
        "Grundwasser_Definition.csv": tabelle("GROUNDWATERTYPE", ["BASE_ID", "BASE_NAME", "BASE_INFO", "GROUNDWATERTYPE_REPRESENTATIONCOLOR"],
                                              ["guid"] * 4, [[G["w1"], "Ruhewasserspiegel", "", G["c1"]]]),
        "Grundwasser_Staende.csv": tabelle("GROUNDWATERLEVEL", ["BASE_ID", "GROUNDWATERLEVEL_BOREHOLE", "GROUNDWATERLEVEL_INCIDENCE", "GROUNDWATERLEVEL_TYPE", "GROUNDWATERLEVEL_DEPTH", "GROUNDWATERLEVEL_DATE"],
                                           ["guid"] * 6, [["x", G["b1"], "0", G["w1"], "2.10", "25.07.2024"]]),
        "BS_Definition.csv": tabelle("GROUNDTYPE", ["BASE_ID", "BASE_NAME", "BASE_INFO", "GROUNDTYPE_HEIGHTRELATIVE", "GROUNDTYPE_REPRESENTATIONCOLOR"],
                                     ["guid"] * 5, [[G["t1"], "1 - Sand", "", "", G["c1"]], [G["t2"], "2 - Ton", "", "", G["c2"]]]),
        # Die Folge von GUIDs ohne Trenner und mit führenden Kommas — so steht es bei GGU
        "BS_Bereiche.csv": tabelle("GROUNDLAYER", ["BASE_ID", "BASE_NAME", "GROUNDLAYER_BOREHOLE", "GROUNDLAYER_BOREHOLELAYERS", "GROUNDLAYER_DEPTHFROM", "GROUNDLAYER_DEPTHTO", "GROUNDLAYER_TYPE", "GROUNDLAYER_INFLUENCERADIUS", "GROUNDLAYER_INFLUENCEAREA"],
                                   ["guid"] * 9,
                                   [["g1", "KRB 1 - 0", G["b1"], "," + G["l1"] + G["l2"], "0.00", "2.50", G["t1"], "", ""],
                                    ["g2", "KRB 1 - 1", G["b1"], G["l3"], "2.50", "6.00", G["t2"], "", ""],
                                    ["g3", "KRB 2 - 0", G["b2"], G["l4"].lower(), "0.00", "3.00", G["t1"], "", ""],
                                    ["g4", "KRB 2 - 1", G["b2"], G["l5"], "3.00", "5.00", G["t2"], "", ""]]),
        "BS_Eigenschaften.csv": tabelle("PROPERTYVALUE", ["BASE_ID", "BASE_NAME", "BASE_INFO", "PROPERTYVALUE_OBJECT", "PROPERTYVALUE_PROPERTYDEFINITION", "PROPERTYVALUE_VALUE", "PROPERTYVALUE_CARDINALITY"],
                                        ["guid"] * 7, [["v1", "Reibungswinkel", "", G["t1"], G["p1"], "(30,32.5,35)", "ValueMinMax"]]),
        "E_Definition.csv": tabelle("GROUNDTYPE", ["BASE_ID", "BASE_NAME", "BASE_INFO", "GROUNDTYPE_HEIGHTRELATIVE", "GROUNDTYPE_REPRESENTATIONCOLOR"],
                                    ["guid"] * 5, [[G["e2"], "Erd1 - Erd1 - Boden", "", "", G["c1"]]]),
        "E_Bereiche.csv": tabelle("GROUNDLAYER", ["BASE_ID", "BASE_NAME", "GROUNDLAYER_BOREHOLE", "GROUNDLAYER_BOREHOLELAYERS", "GROUNDLAYER_DEPTHFROM", "GROUNDLAYER_DEPTHTO", "GROUNDLAYER_TYPE", "GROUNDLAYER_INFLUENCERADIUS", "GROUNDLAYER_INFLUENCEAREA"],
                                  ["guid"] * 9, [["h1", "x", G["b1"], ",,," + G["l1"] + G["l2"] + G["l3"], "0", "6", G["e2"], "", ""]]),
        "Schnitte.csv": tabelle("GROUNDSECTION", ["BASE_ID", "BASE_Name", "GROUNDSECTION_BOREHOLES"], ["guid"] * 3,
                                [["s1", "Schnitt A", G["b1"] + "," + G["b2"]]]),
    }
    puffer = io.BytesIO()
    with zipfile.ZipFile(puffer, "w") as zf:
        for n, d in dateien.items():
            zf.writestr(n, d)
    return puffer.getvalue()


def utm_stub(ost, nord, epsg):
    # lineare Attrappe: 1 m = 1e-5 °, damit die Lage ohne pyproj prüfbar ist
    return (7.0 + (ost - 404984.47) * 1e-5, 51.0 + (nord - 5662689.02) * 1e-5)


print("── .GROUND lesen ──")
m = ground_lesen(ground_bauen(), utm_nach_grad=utm_stub)
pruefe("Format und Name", m["format"] == "ileen-baugrund" and m["name"] == "Prüfprojekt", m["name"])
pruefe("zwei Aufschlüsse", len(m["aufschluesse"]) == 2)
a1, a2 = m["aufschluesse"]
pruefe("Ansatzhöhe in m NHN", a1["z"] == 389.83 and a2["z"] == 390.01)
pruefe("Lage im Landessystem → Grad", abs(a2["lon"] - 7.00025) < 1e-9 and abs(a2["lat"] - 51.00004) < 1e-9, (a2["lon"], a2["lat"]))
pruefe("Rechts-/Hochwert bleiben erhalten", a2["utm"] == {"epsg": 25832, "ost": 404984.47 + 25.0, "nord": 5662689.02 + 4.0})
pruefe("Schichten nach Tiefe sortiert (in der Datei nicht)", [s["von"] for s in a1["schichten"]] == [0.0, 1.2, 2.5])
pruefe("Kurzzeichen und Text", a1["schichten"][0]["kurz"] == "mS, fs" and a1["schichten"][0]["text"] == "Holozän, fluviatil")
pruefe("Farbe aus der Farbtabelle", a1["schichten"][2]["farbe"] == "#9c84c4")
gl = m["gliederungen"]
pruefe("zwei Gliederungen", [g["name"] for g in gl] == ["Baugrundschichtenmodell", "Erdarbeiten"], [g["name"] for g in gl])
ms = {s["guid"]: s for s in gl[0]["schichten"]}
pruefe("Modellschicht: Name ohne Nummer, Kürzel daneben", ms[G["t1"]]["name"] == "Sand" and ms[G["t1"]]["kuerzel"] == "1")
pruefe("„Erd1 - Erd1 - Boden“ → Boden", gl[1]["schichten"][0]["name"] == "Boden")
pruefe("Zuordnung aus GUID-Folge ohne Trenner",
       [s.get("schicht") for s in a1["schichten"]] == [ms[G["t1"]]["id"], ms[G["t1"]]["id"], ms[G["t2"]]["id"]],
       [s.get("schicht") for s in a1["schichten"]])
pruefe("Kleinschreibung der GUID schadet nicht", a2["schichten"][0].get("schicht") == ms[G["t1"]]["id"])
pruefe("Zuordnung auch für die zweite Gliederung",
       all(s["zuordnung"].get(gl[1]["id"]) == gl[1]["schichten"][0]["id"] for s in a1["schichten"]))
pruefe("aus dem Import ist die Zuordnung fest", all(s.get("schichtFest") for s in a1["schichten"]))
phi = ms[G["t1"]]["kennwerte"].get("phi")
pruefe("Kennwert (min,wert,max) mit Einheit und Norm", phi == {"min": 30.0, "wert": 32.5, "max": 35.0, "name": "Reibungswinkel", "einheit": "°", "norm": "DIN 18137"}, phi)
pruefe("Grundwasser: Ruhewasser erkannt", a1["wasser"] == [{"tiefe": 2.1, "art": "ruhe", "bezeichnung": "Ruhewasserspiegel", "datum": "25.07.2024"}], a1["wasser"])
pruefe("Schnitt mit Aufschlusskennungen", m["schnitte"] == [{"name": "Schnitt A", "ids": [a1["id"], a2["id"]]}], m["schnitte"])
pruefe("Rand des DGM als Modellrand", m["einstellungen"]["rand"] == 12.5)

m2 = ground_lesen(ground_bauen(lokal=True), utm_nach_grad=utm_stub)
pruefe("Lokale Koordinaten hängen am Projektursprung", abs(m2["aufschluesse"][1]["lon"] - 7.00025) < 1e-9)

try:
    ground_lesen(b"kein zip")
    pruefe("Kein ZIP wird abgelehnt", False)
except GroundFehler:
    pruefe("Kein ZIP wird abgelehnt", True)

# pyproj, wenn vorhanden: ein bekannter Punkt
try:
    import pyproj  # noqa: F401
    m3 = ground_lesen(ground_bauen())
    a = m3["aufschluesse"][0]
    pruefe("pyproj: UTM 32 → WGS84 (Kierspe, KRB 1)", abs(a["lon"] - 7.642742) < 2e-6 and abs(a["lat"] - 51.107802) < 2e-6, (a["lon"], a["lat"]))
except ImportError:
    print("  (pyproj fehlt — Lageprüfung mit echter Umrechnung übersprungen)")

print("── KI-Lesung aufbereiten ──")
r = aufbereiten({
    "name": " BS 7 ", "art": "BS", "ansatzhoehe_m_nhn": "86,20", "endteufe_m": 6.0, "grundwasser_m": "3,1",
    "bildart": "profil",
    "schichten": [
        {"von_m": 1.2, "bis_m": 2.9, "kurzzeichen": "mS, gs", "beschreibung": "Mittelsand"},
        {"von_m": 0.0, "bis_m": 0.4, "kurzzeichen": "Mu", "beschreibung": "Oberboden"},
        {"von_m": 0.4, "bis_m": 1.25, "kurzzeichen": "fS", "beschreibung": "Feinsand"},
        {"von_m": 2.9, "bis_m": 2.9, "kurzzeichen": "x", "beschreibung": "nichts"},
        {"von_m": 3.0, "bis_m": "6,00", "kurzzeichen": "T", "beschreibung": "Ton"},
    ]})
pruefe("sortiert und lückenlos", [(s["von"], s["bis"]) for s in r["schichten"]] == [(0.0, 0.4), (0.4, 1.25), (1.25, 2.9), (2.9, 6.0)],
       [(s["von"], s["bis"]) for s in r["schichten"]])
pruefe("Zahl mit Komma gelesen", r["ansatzhoehe"] == 86.2 and r["grundwasser"] == 3.1)
pruefe("Name ohne Leerraum", r["name"] == "BS 7")
pruefe("Hinweise nennen Sortierung, Dicke null und Lücke",
       any("sortiert" in h for h in r["hinweise"]) and any("keine Dicke" in h for h in r["hinweise"]) and any("Lücke" in h for h in r["hinweise"]),
       r["hinweise"])
r2 = aufbereiten({"ansatzhoehe_m_nhn": 99999, "schichten": [{"von_m": 0, "bis_m": 2, "kurzzeichen": "S", "beschreibung": ""}], "endteufe_m": None})
pruefe("unplausible Ansatzhöhe entfällt", r2["ansatzhoehe"] is None and any("plausible" in h for h in r2["hinweise"]))
pruefe("Endteufe ohne Angabe = letzte Unterkante", r2["endteufe"] == 2.0)

r3 = aufbereiten({"name": "BS 7", "ansatzhoehe": "86,20 m NHN", "endteufe": "6,00",
                  "grundwasser": "Nicht beschriftet, Wasserstand bei ca. 3,10 m markiert",
                  "schichten": [{"unterkante": "0,40", "kurzzeichen": "Mu", "beschreibung": "Oberboden"},
                                {"unterkante": "1,20", "kurzzeichen": "fS, ms, u'", "beschreibung": "Feinsand"},
                                {"unterkante": "6,00", "kurzzeichen": "T, u", "beschreibung": "Ton"}]})
pruefe("Textform (wie gedruckt): Unterkanten, Ansatzhöhe, Wasser aus Prosa",
       [(s["von"], s["bis"]) for s in r3["schichten"]] == [(0.0, 0.4), (0.4, 1.2), (1.2, 6.0)]
       and r3["ansatzhoehe"] == 86.2 and r3["grundwasser"] == 3.1 and not r3["hinweise"], (r3["schichten"], r3["hinweise"]))

# Echte Datei, wenn vorhanden
KIERSPE = Path.home() / "Library/CloudStorage/OneDrive-HochschuleMainz-UniversityofAppliedSciences/03_Tragwerkslabor/03_Ausstattung/Software/GGU/Projekte/kierspe.GROUND"
if KIERSPE.exists():
    print("── Kierspe (GGU-Demoprojekt) ──")
    k = ground_lesen(KIERSPE.read_bytes())
    pruefe("6 Aufschlüsse, 2 Gliederungen, 2 Schnitte",
           len(k["aufschluesse"]) == 6 and len(k["gliederungen"]) == 2 and len(k["schnitte"]) == 2)
    alle = [s for a in k["aufschluesse"] for s in a["schichten"]]
    pruefe("jede Schicht ist dem Schichtenmodell zugeordnet", all(s.get("schicht") for s in alle),
           sum(1 for s in alle if not s.get("schicht")))
else:
    print("  (Kierspe-Datei nicht vorhanden — übersprungen)")

print()
print("Alles in Ordnung." if not fehler else f"{fehler} Fehler.")
sys.exit(1 if fehler else 0)
