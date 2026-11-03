"""
IFC4-Ausgabe — ein Bauteil je erkanntem Objekt, georeferenziert.

Warum IFC neben dem GLB: die Tiling-Pipeline legt für ein IFC jedes Bauteil
einzeln ab und schreibt eine Batch Table mit GlobalId, Typ, Name und Geschoss.
Die Bauteile bleiben im Viewer anklickbar und auswertbar — das GLB kommt als
ein einziges Mesh an.

Klassenwahl: Gelände, Aushub und Vegetation sind IfcGeographicElement, alles
Gebaute IfcBuildingElementProxy. Baukörper aus einer Punktwolke sind ehrlich
LOD1 — das steht so im Pset, damit niemand die Kubatur für eine Planung hält.
"""

import json
import logging
import math
from pathlib import Path

import ifcopenshell
import ifcopenshell.guid as guid
import numpy as np

logger = logging.getLogger(__name__)


def bauen(ordner, netzdaten: dict, geo: dict | None = None,
          projekt: str = "Scan2BIM-Rekonstruktion") -> dict:
    """Schreibt `modell.ifc` und `bbox_ifc.json`, gibt die Zählung zurück."""
    ORDNER = Path(ordner)
    PROJEKT = projekt

    f = ifcopenshell.file(schema="IFC4")
    BESITZER = None


    def G():
        return guid.new()


    def punkt(x, y, z=0.0):
        return f.createIfcCartesianPoint((float(x), float(y), float(z)))


    def richtung(x, y, z):
        return f.createIfcDirection((float(x), float(y), float(z)))


    def achsen(o=(0, 0, 0), z=(0, 0, 1), x=(1, 0, 0)):
        return f.createIfcAxis2Placement3D(punkt(*o), richtung(*z), richtung(*x))


    def einheit(art, name):
        return f.createIfcSIUnit(None, art, None, name)


    einheiten = f.createIfcUnitAssignment([
        einheit("LENGTHUNIT", "METRE"), einheit("AREAUNIT", "SQUARE_METRE"),
        einheit("VOLUMEUNIT", "CUBIC_METRE"),
        f.createIfcSIUnit(None, "PLANEANGLEUNIT", None, "RADIAN")])

    kontext = f.createIfcGeometricRepresentationContext(
        None, "Model", 3, 1e-5, achsen(), richtung(0.0, 1.0, 0.0))
    koerper = f.createIfcGeometricRepresentationSubContext(
        "Body", "Model", None, None, None, None, kontext, None, "MODEL_VIEW", None)

    projekt = f.createIfcProject(
        G(), BESITZER, PROJEKT,
        "Aus einer Punktwolke automatisch rekonstruiert (scan2bim/pipeline.py)",
        None, None, None, [kontext], einheiten)

    if geo:
        crs = f.createIfcProjectedCRS(
            "EPSG:25832", "ETRS89 / UTM zone 32N", "ETRS89", "DHHN2016",
            "UTM zone 32N", None, f.createIfcSIUnit(None, "LENGTHUNIT", None, "METRE"))
        f.createIfcMapConversion(kontext, crs, float(geo["utm_ost"]), float(geo["utm_nord"]),
                                 float(geo["nullpunkt"]["hoehe"]), float(geo["x_abszisse"]),
                                 float(geo["x_ordinate"]), 1.0)


    def platzierung(bezug=None, o=(0, 0, 0)):
        return f.createIfcLocalPlacement(bezug, achsen(o))


    site_pl = platzierung()
    site = f.createIfcSite(G(), BESITZER, PROJEKT, None, None, site_pl, None, None,
                           "ELEMENT", None, None,
                           float(geo["nullpunkt"]["hoehe"]) if geo else None, None, None)
    f.createIfcRelAggregates(G(), BESITZER, None, None, projekt, [site])
    bau_pl = platzierung(site_pl)
    gebaeude = f.createIfcBuilding(G(), BESITZER, "Bestandsbebauung", None, None, bau_pl,
                                   None, None, "ELEMENT", None, None, None)
    f.createIfcRelAggregates(G(), BESITZER, None, None, site, [gebaeude])
    geschoss_pl = platzierung(bau_pl)
    geschoss = f.createIfcBuildingStorey(G(), BESITZER, "Geländeebene", None, None,
                                         geschoss_pl, None, None, "ELEMENT", 0.0)
    f.createIfcRelAggregates(G(), BESITZER, None, None, gebaeude, [geschoss])

    STIL = {}
    for name, rgb in [("Gelaende", (0.55, 0.48, 0.38)), ("Baugrube", (0.62, 0.47, 0.30)),
                      ("Verkehr", (0.28, 0.28, 0.30)), ("Gebaeude", (0.72, 0.70, 0.66)),
                      ("Zaun", (0.78, 0.79, 0.82)), ("Stamm", (0.25, 0.16, 0.09)),
                      ("Krone", (0.18, 0.38, 0.12)), ("Fahrzeug", (0.55, 0.56, 0.60)),
                      ("Container", (0.85, 0.52, 0.12)), ("Ausstattung", (0.62, 0.62, 0.64)),
                      ("Maschine", (0.92, 0.66, 0.05))]:
        farbe = f.createIfcColourRgb(None, *[float(v) for v in rgb])
        darstellung = f.createIfcSurfaceStyleRendering(
            farbe, 0.0, None, None, None, None,
            f.createIfcNormalisedRatioMeasure(0.32), f.createIfcSpecularExponent(12.0), "NOTDEFINED")
        STIL[name] = f.createIfcSurfaceStyle(name, "BOTH", [darstellung])


    def einfaerben(element, name):
        f.createIfcStyledItem(element, [STIL[name]], None)


    def gestalt(teile):
        art = ("Tessellation" if teile[0].is_a("IfcTriangulatedFaceSet")
               else "CSG" if teile[0].is_a("IfcCsgSolid") else "SweptSolid")
        return f.createIfcProductDefinitionShape(
            None, None, [f.createIfcShapeRepresentation(koerper, "Body", art, teile)])


    def merkmale(element, name, werte):
        eigenschaften = []
        for schluessel, wert in werte.items():
            if isinstance(wert, bool):
                v = f.createIfcBoolean(wert)
            elif isinstance(wert, (int, float)):
                v = f.createIfcReal(float(wert))
            else:
                v = f.createIfcLabel(str(wert))
            eigenschaften.append(f.createIfcPropertySingleValue(schluessel, None, v, None))
        satz = f.createIfcPropertySet(G(), BESITZER, name, None, eigenschaften)
        f.createIfcRelDefinesByProperties(G(), BESITZER, None, None, [element], satz)


    def netzkoerper(V, F, stil):
        liste = f.createIfcCartesianPointList3D([[float(c) for c in v] for v in V])
        dreiecke = []
        for flaeche in F:
            if len(flaeche) == 3:
                dreiecke.append([int(flaeche[0]) + 1, int(flaeche[1]) + 1, int(flaeche[2]) + 1])
            else:
                for k in range(1, len(flaeche) - 1):
                    dreiecke.append([int(flaeche[0]) + 1, int(flaeche[k]) + 1, int(flaeche[k + 1]) + 1])
        element = f.createIfcTriangulatedFaceSet(liste, None, True, dreiecke, None)
        einfaerben(element, stil)
        return element


    def extrusion(ring, z0, hoehe, stil):
        ring = [tuple(p) for p in ring]
        if ring[0] == ring[-1]:
            ring = ring[:-1]
        if len(ring) < 3:
            return None
        # Umlaufsinn festlegen: IFC verlangt eine gegen den Uhrzeigersinn
        # umlaufende Außenkontur, sonst zeigt die Normale nach innen.
        flaeche2 = sum((ring[(i + 1) % len(ring)][0] - ring[i][0]) *
                       (ring[(i + 1) % len(ring)][1] + ring[i][1]) for i in range(len(ring)))
        if flaeche2 > 0:
            ring = ring[::-1]
        linie = f.createIfcPolyline([punkt(x, y) for x, y in ring] + [punkt(*ring[0])])
        profil = f.createIfcArbitraryClosedProfileDef("AREA", None, linie)
        element = f.createIfcExtrudedAreaSolid(profil, achsen((0, 0, z0)), richtung(0, 0, 1),
                                               float(max(hoehe, 0.05)))
        einfaerben(element, stil)
        return element


    def kugel(mitte, radius, stil):
        element = f.createIfcCsgSolid(f.createIfcSphere(achsen(mitte), float(radius)))
        einfaerben(element, stil)
        return element


    am_site, am_geschoss = [], []
    kennzahlen = json.loads((ORDNER / "kennzahlen.json").read_text()) \
        if (ORDNER / "kennzahlen.json").exists() else {}

    N = netzdaten
    V = N["V"]
    for schluessel, (name, stil, typ) in {
            "Gelaende_Umgebung": ("Gelände", "Gelaende", "TERRAIN"),
            "Gelaende_Baugrube": ("Baugrube (Aushub)", "Baugrube", "USERDEFINED"),
            "Verkehrsflaeche": ("Verkehrsfläche", "Verkehr", "USERDEFINED")}.items():
        F = N["F_" + schluessel]
        if len(F) == 0:
            continue
        genutzt = np.unique(F)
        neu = -np.ones(len(V), np.int64)
        neu[genutzt] = np.arange(len(genutzt))
        element = f.createIfcGeographicElement(
            G(), BESITZER, name, None, None, platzierung(site_pl),
            gestalt([netzkoerper(V[genutzt], neu[F], stil)]), None, typ)
        if typ == "USERDEFINED":
            element.ObjectType = name
        am_site.append(element)
        werte = {"Quelle": "Punktwolke", "Verfahren": "Rasterung 0,20 m + progressiver Bodenfilter"}
        if schluessel == "Gelaende_Baugrube" and kennzahlen:
            werte.update({"Aushubvolumen_m3": round(kennzahlen.get("aushub_m3", 0)),
                          "Max_Tiefe_m": round(kennzahlen.get("max_tiefe_m", 0), 2),
                          "Flaeche_m2": round(kennzahlen.get("grube_m2", 0))})
        merkmale(element, "Pset_Bestandsaufnahme", werte)

    E = json.loads((ORDNER / "elemente.json").read_text())

    for i, g in enumerate(E["Gebaeude"], 1):
        fest = extrusion(g["ring"], g["z_fuss"] - 0.3, g["hoehe"] + 0.3, "Gebaeude")
        if fest is None:
            continue
        element = f.createIfcBuildingElementProxy(
            G(), BESITZER, "Bestandsgebäude %02d" % i, "Baukörper LOD1 aus Punktwolke",
            None, platzierung(geschoss_pl), gestalt([fest]), None, "ELEMENT")
        am_geschoss.append(element)
        merkmale(element, "Pset_Bestandsaufnahme",
                 {"Grundflaeche_m2": round(g["flaeche"], 1), "Hoehe_m": round(g["hoehe"], 2),
                  "Detaillierungsgrad": "LOD1 (Baukörper)", "Quelle": "Punktwolke"})

    FELD = 3.5
    nummer = 0
    for abschnitt in E["Bauzaun"]:
        pfad = [np.array(c) for c in abschnitt["pfad"]]
        for a, b in zip(pfad[:-1], pfad[1:]):
            strecke = b - a
            laenge = np.linalg.norm(strecke)
            if laenge < 1e-6:
                continue
            richtungsvektor = strecke / laenge
            s = 0.0
            while s + FELD <= laenge:
                p1, p2 = a + richtungsvektor * s, a + richtungsvektor * (s + FELD)
                s += FELD
                nummer += 1
                quer = np.array([-(p2 - p1)[1], (p2 - p1)[0]]) / FELD * 0.045
                ring = [(p1[0] + quer[0], p1[1] + quer[1]), (p2[0] + quer[0], p2[1] + quer[1]),
                        (p2[0] - quer[0], p2[1] - quer[1]), (p1[0] - quer[0], p1[1] - quer[1])]
                fest = extrusion(ring, abschnitt["z_fuss"] + 0.12, abschnitt["hoehe"], "Zaun")
                element = f.createIfcBuildingElementProxy(
                    G(), BESITZER, "Bauzaunfeld %03d" % nummer, "Mobiler Bauzaun", None,
                    platzierung(site_pl), gestalt([fest]), None, "ELEMENT")
                element.ObjectType = "Bauzaun"
                am_site.append(element)
                merkmale(element, "Pset_Baustelleneinrichtung",
                         {"Feldbreite_m": FELD, "Hoehe_m": round(abschnitt["hoehe"], 2),
                          "Art": "mobiler Bauzaun mit Betonfuß"})

    for i, baum in enumerate(E["Baeume"], 1):
        hoehe = baum["hoehe"]
        radius = max(baum["radius"], 0.9)
        stammhoehe = max(hoehe * 0.32, 1.0)
        r_stamm = max(radius * 0.10, 0.10)
        kreis = [(baum["x"] + r_stamm * math.cos(t), baum["y"] + r_stamm * math.sin(t))
                 for t in np.linspace(0, 2 * math.pi, 10)[:-1]]
        element = f.createIfcGeographicElement(
            G(), BESITZER, "Baum %02d" % i, None, None, platzierung(site_pl),
            gestalt([extrusion(kreis, baum["z"], stammhoehe, "Stamm"),
                     kugel((baum["x"], baum["y"], baum["z"] + stammhoehe + (hoehe - stammhoehe) * 0.5),
                           radius, "Krone")]), None, "USERDEFINED")
        element.ObjectType = "Vegetation"
        am_site.append(element)
        merkmale(element, "Pset_Vegetation",
                 {"Baumhoehe_m": round(hoehe, 1), "Kronenradius_m": round(radius, 1),
                  "Kronenflaeche_m2": round(baum["flaeche"], 1)})

    ART = {"Fahrzeug": ("Fahrzeug", "Fahrzeug"), "Container": ("Baucontainer", "Container"),
           "Ausstattung": ("Baustellenausstattung", "Ausstattung"),
           "Kleinteil": ("Kleinteil", "Ausstattung"), "Baumaschine": ("Baumaschine", "Maschine")}
    gezaehlt = {}
    for box in E["Boxen"]:
        name, stil = ART[box["klasse"]]
        gezaehlt[box["klasse"]] = gezaehlt.get(box["klasse"], 0) + 1
        fest = extrusion([tuple(c) for c in box["ecken"][:4]], box["z_fuss"] - 0.05,
                         box["hoehe"] + 0.05, stil)
        if fest is None:
            continue
        element = f.createIfcBuildingElementProxy(
            G(), BESITZER, "%s %02d" % (name, gezaehlt[box["klasse"]]), name, None,
            platzierung(site_pl), gestalt([fest]), None, "ELEMENT")
        element.ObjectType = name
        am_site.append(element)
        merkmale(element, "Pset_Bestandsaufnahme",
                 {"Hoehe_m": round(box["hoehe"], 2), "Klasse": name,
                  "In_Baugrube": bool(box.get("in_grube", False))})

    for elemente, bereich in ((am_site, site), (am_geschoss, geschoss)):
        if elemente:
            f.createIfcRelContainedInSpatialStructure(G(), BESITZER, None, None, elemente, bereich)

    merkmale(site, "Pset_Bestandsaufnahme",
             {"Verfahren": "scan2bim/pipeline.py", "Rasterweite_m": 0.20,
              "Georeferenz": "EPSG:25832 aus 3D-Tiles-Transformation" if geo else "lokal"})

    f.write(str(ORDNER / "modell.ifc"))

    # Bounding Box für die Platzierung — dieselbe Rechnung wie im Backend (recenter).
    import ifcopenshell.geom as geom  # noqa: E402

    einstellungen = geom.settings()
    try:
        einstellungen.set("use-world-coords", True)
    except Exception:
        einstellungen.set(einstellungen.USE_WORLD_COORDS, True)
    lauf = geom.iterator(einstellungen, f)
    lo = np.full(3, 1e18)
    hi = np.full(3, -1e18)
    anzahl = 0
    if lauf.initialize():
        while True:
            v = np.array(lauf.get().geometry.verts).reshape(-1, 3)
            lo = np.minimum(lo, v.min(0))
            hi = np.maximum(hi, v.max(0))
            anzahl += 1
            if not lauf.next():
                break
    json.dump(dict(lo=lo.tolist(), hi=hi.tolist()), open(ORDNER / "bbox_ifc.json", "w"))
    groesse = (ORDNER / "modell.ifc").stat().st_size
    logger.info("IFC: %d Bauteile, %.1f MB", anzahl, groesse / 1e6)
    return dict(bauteile=int(anzahl), bytes=int(groesse),
                am_site=len(am_site), am_geschoss=len(am_geschoss))
