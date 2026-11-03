"""
Sortierte Ansicht: Bauteile eines Typs freigestellt nebeneinander auf einer Ebene.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Wie die Asset-Ansicht in Autodesk Tandem: alle Türen des Hauses stehen in Reihen
nebeneinander, nach Typ und Größe geordnet, jede aufrecht und mit der Breitseite
nach vorn. Man sieht auf einen Blick, wie viele es gibt, welche Typen und welche
Ausreißer.

```
IFC ─ Iterator (nur die gewählten Typen) ─ Auslagerungsdatei
        │ Typname, Geschoss                   │  Geometrie je Bauteil
        ▼                                     ▼
   Gruppen + Sortierung           Grundrissdrehung (kleinstes Rechteck)
        └──────────── Anordnung in Reihen ────┘
                          │
              neue Auslagerungsdatei, Octree, B3DM
                          │
        tileset.json + layout.json + properties.sqlite
```

**Warum ein eigenes Tileset und kein Shader.** Die Geometrie der Kacheln liegt
gebatcht auf der GPU; im Browser lässt sich ein einzelnes Bauteil weder greifen
noch verschieben (siehe `frontend/explosion.js`). Ein Shader, der je Bauteil
verschöbe, bräuchte die Batch-IDs als Schlüssel in einer Tabelle — und die
zählen je Kachel neu. Wer die Bauteile wirklich nebeneinander legen will, legt
sie nebeneinander: einmal im Backend, mit derselben Geometrie, denselben
GlobalIds und derselben `properties.sqlite` wie das Original. Ein Klick auf eine
Tür zeigt deshalb dieselben Eigenschaften wie im Haus.

**Es ist dieselbe Geometrie.** Gedreht und verschoben wird starr; Dreiecke,
Farben, Texturbereiche und Normalen bleiben, wie der Tiler sie geschrieben hat.
Gedreht wird nur um die Hochachse (die Drehung gegen die Hochachse ist, was ein
Bauteil im Haus *ist*), jedes Bauteil steht danach mit seiner Unterkante auf
der Ebene — ein Fenster in 90 cm Brüstungshöhe schwebt nicht.

**Die Drehung ist das kleinste umschließende Rechteck des Grundrisses**, nicht
die Hauptachse der Punkte. Die Hauptachse der Eckpunkte hängt davon ab, wo die
Eckpunkte liegen: ein Türblatt mit Zarge und Beschlag ist an der Zarge dichter
besetzt und kippt. Das Rechteck kleinster Fläche liegt immer an einer Kante der
konvexen Hülle und ist damit eindeutig. Danach liegt die lange Seite in x —
eine Tür steht breit vor dem Betrachter, ein Träger liegt der Länge nach.

Was fehlt: die Vorderseite. Das Rechteck sagt, wie die Tür liegt, nicht wo vorn
ist; eine Drehung um 180° ist gleichwertig und wird nicht entschieden.
"""

import json
import logging
import re
import tempfile
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

# Wie Typen in der Oberfläche heißen. Was hier fehlt, erscheint ohne „Ifc".
TYP_BEZEICHNUNG = {
    "IfcDoor": "Türen",
    "IfcWindow": "Fenster",
    "IfcColumn": "Stützen",
    "IfcBeam": "Träger",
    "IfcMember": "Stäbe",
    "IfcWall": "Wände",
    "IfcWallStandardCase": "Wände",
    "IfcSlab": "Decken und Platten",
    "IfcPlate": "Bleche und Platten",
    "IfcRoof": "Dächer",
    "IfcStair": "Treppen",
    "IfcStairFlight": "Treppenläufe",
    "IfcRamp": "Rampen",
    "IfcRailing": "Geländer",
    "IfcCovering": "Bekleidungen",
    "IfcCurtainWall": "Vorhangfassaden",
    "IfcFooting": "Fundamente",
    "IfcPile": "Pfähle",
    "IfcFurnishingElement": "Möbel",
    "IfcFurniture": "Möbel",
    "IfcSanitaryTerminal": "Sanitärobjekte",
    "IfcLightFixture": "Leuchten",
    "IfcFlowTerminal": "TGA-Endgeräte",
    "IfcFlowSegment": "Leitungen",
    "IfcFlowFitting": "Formstücke",
    "IfcDistributionElement": "TGA-Elemente",
    "IfcBuildingElementProxy": "Allgemeine Bauteile",
    "IfcTransportElement": "Aufzüge",
}

# Voreinstellung der Anordnung in Metern.
ABSTAND = 0.8          # zwischen zwei Bauteilen einer Reihe
ZEILENBREITE = 60.0    # danach beginnt eine neue Reihe derselben Gruppe
ZEILENABSTAND = 1.6    # zwischen zwei Reihen
GRUPPENABSTAND = 4.5   # zwischen zwei Gruppen
MIN_TIEFE = 0.4        # eine Tür ist 10 cm tief — die Reihe soll es nicht sein
MAX_ELEMENTE = 3000    # mehr zeichnet keine Übersicht mehr

GRUPPEN = ("typname", "typ", "geschoss")
SORTIERUNGEN = ("breite", "hoehe", "name", "geschoss")


def bezeichnung(ifc_type: str) -> str:
    return TYP_BEZEICHNUNG.get(ifc_type) or (ifc_type[3:] if ifc_type.startswith("Ifc") else ifc_type)


# ── Rechnung ohne IFC und ohne Auslagerungsdatei ─────────────────────────────


def obb_winkel(xy: np.ndarray) -> float:
    """
    Winkel (Bogenmaß) der langen Seite des kleinsten umschließenden Rechtecks.

    Zurück kommt θ so, dass die Drehung um −θ die lange Seite in die x-Achse legt.
    Ein Grundriss ohne Fläche (alle Punkte auf einer Geraden) liefert die
    Richtung der Geraden; ein Punkt oder leere Eingabe 0.
    """
    pts = np.unique(np.round(np.asarray(xy, dtype=np.float64), 3), axis=0)
    if len(pts) < 2:
        return 0.0
    if len(pts) > 20000:
        pts = pts[:: len(pts) // 20000 + 1]

    try:
        from scipy.spatial import ConvexHull

        huelle = pts[ConvexHull(pts).vertices]
    except Exception:
        # Alle Punkte auf einer Geraden (qhull verweigert) oder zu wenige: die
        # Gerade selbst ist die einzige Richtung, die es gibt.
        d = pts.max(axis=0) - pts.min(axis=0)
        return float(np.arctan2(d[1], d[0])) if d.any() else 0.0

    kanten = np.roll(huelle, -1, axis=0) - huelle
    winkel = np.arctan2(kanten[:, 1], kanten[:, 0])
    c, s = np.cos(winkel), np.sin(winkel)
    # x' = x·c + y·s,  y' = −x·s + y·c — für jede Kante der Hülle eine Spalte.
    xs = huelle[:, 0:1] * c[None, :] + huelle[:, 1:2] * s[None, :]
    ys = -huelle[:, 0:1] * s[None, :] + huelle[:, 1:2] * c[None, :]
    breite = xs.max(axis=0) - xs.min(axis=0)
    tiefe = ys.max(axis=0) - ys.min(axis=0)
    k = int(np.argmin(breite * tiefe))
    theta = float(winkel[k])
    if tiefe[k] > breite[k] + 1e-9:
        theta += np.pi / 2.0        # die lange Seite soll in x liegen
    return float((theta + np.pi) % (2 * np.pi) - np.pi)


def drehen(punkte: np.ndarray, theta: float) -> np.ndarray:
    """Dreht (n,3) um die Hochachse um −θ; z bleibt."""
    c, s = np.cos(theta), np.sin(theta)
    p = np.asarray(punkte, dtype=np.float64)
    return np.column_stack((p[:, 0] * c + p[:, 1] * s, -p[:, 0] * s + p[:, 1] * c, p[:, 2]))


def anordnen(posten: list[dict], abstand: float = ABSTAND, zeilenbreite: float = ZEILENBREITE,
             zeilenabstand: float = ZEILENABSTAND, gruppenabstand: float = GRUPPENABSTAND):
    """
    Reihen bilden.

    `posten`: je Bauteil `{i, gruppe, titel, sort, b, t, h}` — Breite (x), Tiefe (y)
    und Höhe nach der Drehung; `gruppe` ist der Sortierschlüssel der Gruppe,
    `sort` der innerhalb der Gruppe. Zurück: ({i: (x_min, y_mitte)}, Gruppenliste).

    Eine Gruppe läuft in x, bis die Reihe `zeilenbreite` erreicht; dann beginnt
    die nächste. Reihen und Gruppen stehen in +y hintereinander, die erste vorn
    (wo der Betrachter steht, wenn er nach Norden schaut).
    """
    nach_gruppe: dict = {}
    for p in posten:
        nach_gruppe.setdefault(p["gruppe"], []).append(p)

    pos: dict[int, tuple[float, float]] = {}
    gruppen = []
    y = 0.0
    for schluessel in sorted(nach_gruppe):
        mitglieder = sorted(nach_gruppe[schluessel], key=lambda p: (p["sort"], p["i"]))
        zeilen: list[list[tuple[dict, float]]] = [[]]
        x = 0.0
        for p in mitglieder:
            if zeilen[-1] and x + p["b"] > zeilenbreite:
                zeilen.append([])
                x = 0.0
            zeilen[-1].append((p, x))
            x += p["b"] + abstand

        y_vorn = y
        breite = 0.0
        erste_mitte = None
        for z in zeilen:
            tiefe = max(MIN_TIEFE, max(p["t"] for p, _ in z))
            mitte = y + tiefe / 2.0
            if erste_mitte is None:
                erste_mitte = mitte
            for p, x0 in z:
                pos[p["i"]] = (x0, mitte)
                breite = max(breite, x0 + p["b"])
            y += tiefe + zeilenabstand
        y_hinten = y - zeilenabstand
        gruppen.append({
            "titel": mitglieder[0]["titel"],
            "anzahl": len(mitglieder),
            "zeilen": len(zeilen),
            "x0": 0.0, "x1": round(breite, 3),
            "y0": round(y_vorn, 3), "y1": round(y_hinten, 3),
            "y_erste": round(erste_mitte, 3),
            "hmax": round(max(p["h"] for p in mitglieder), 3),
            "typen": sorted({p.get("typ", "") for p in mitglieder}),
        })
        y += gruppenabstand - zeilenabstand
    return pos, gruppen


# ── Aus dem IFC ──────────────────────────────────────────────────────────────


def typname_von(element) -> str:
    """
    Wie die Planer das Bauteil nennen: der Typ, sonst der Objekttyp, sonst der Name.

    Revit schreibt „Familie:Typ:Kennung" in den Namen; die angehängte Nummer ist
    eine Instanzkennung und würde jede Tür zu ihrer eigenen Gruppe machen.
    """
    import ifcopenshell.util.element as E

    for versuch in (lambda: E.get_type(element), ):
        try:
            typ = versuch()
        except Exception:
            typ = None
        if typ is not None and getattr(typ, "Name", None):
            return _ohne_kennung(typ.Name)
    for feld in ("ObjectType", "Name"):
        wert = getattr(element, feld, None)
        if wert:
            return _ohne_kennung(str(wert))
    return element.is_a()


def _ohne_kennung(name: str) -> str:
    return re.sub(r"[:\s]+\d{4,}$", "", name.strip()) or name.strip()


def geschosse_der(ifc_file) -> dict[str, float]:
    """Geschossname → Elevation (für die Reihenfolge; ohne Angabe ans Ende)."""
    hoehe: dict[str, float] = {}
    for g in ifc_file.by_type("IfcBuildingStorey"):
        name = g.Name or f"#{g.id()}"
        e = getattr(g, "Elevation", None)
        hoehe[name] = float(e) if e is not None else 1e9
    return hoehe


def sortiert_tilen(src: Path, out_dir: Path, typen: list[str], gruppe: str = "typname",
                   sortierung: str = "breite", abstand: float = ABSTAND,
                   zeilenbreite: float = ZEILENBREITE, max_elemente: int = MAX_ELEMENTE) -> dict:
    """
    Aus einer IFC-Datei ein Tileset mit den Bauteilen der gewählten Typen in Reihen.

    Schreibt `tileset.json`, die B3DM-Kacheln, `properties.sqlite` und
    `layout.json` nach `out_dir` und gibt den Bericht zurück (steht auch in
    `layout.json`). Die Platzierung ist die Standardplatzierung; der Aufrufer
    legt die des Originals darüber.
    """
    import ifcopenshell
    import ifcopenshell.geom

    from tiling.formats.ifc import (_Element, _GeometryStore, _extract, _write_tiles)

    if gruppe not in GRUPPEN:
        raise ValueError(f"gruppe: {', '.join(GRUPPEN)}")
    if sortierung not in SORTIERUNGEN:
        raise ValueError(f"sortierung: {', '.join(SORTIERUNGEN)}")
    typen = [t for t in typen if t]
    if not typen:
        raise ValueError("Keine Bauteiltypen gewählt.")

    logger.info(f"Sortierte Ansicht: {src.name}, Typen {typen}, Gruppen nach {gruppe}")
    ifc_file = ifcopenshell.open(str(src))
    schema_typen = []
    for t in typen:
        try:
            ifc_file.by_type(t)
            schema_typen.append(t)
        except Exception:
            logger.info(f"Typ '{t}' im Schema {ifc_file.schema} unbekannt — übersprungen.")
    if not schema_typen:
        raise ValueError(f"Keiner der Typen {typen} gehört zum Schema {ifc_file.schema}.")

    geschoss_hoehe = geschosse_der(ifc_file)

    with tempfile.TemporaryDirectory(prefix="ifc_sortiert_") as tmp:
        quelle = _GeometryStore(Path(tmp) / "geometrie.bin")
        ziel = _GeometryStore(Path(tmp) / "sortiert.bin")
        try:
            elemente, _ = _extract(ifcopenshell, ifc_file, quelle, out_dir, None, include=schema_typen)
            if not elemente:
                raise RuntimeError(
                    "Zu den gewählten Typen gibt es im Modell keine Geometrie "
                    f"({', '.join(schema_typen)}).")
            quelle.seal()
            gefunden = len(elemente)
            abgeschnitten = gefunden > max_elemente
            elemente = elemente[:max_elemente]

            # Durchgang 1: Drehung und Maße nach der Drehung, dazu die Namen.
            posten, dreh = [], []
            for i, e in enumerate(elemente):
                verts = quelle.read(e.record)[0].astype(np.float64)
                theta = obb_winkel(verts[:, :2])
                d = drehen(verts, theta)
                lo, hi = d.min(axis=0), d.max(axis=0)
                dreh.append((theta, lo))
                try:
                    typ_name = typname_von(ifc_file.by_guid(e.guid))
                except Exception:
                    typ_name = e.ifc_type
                etage = e.storey or ""
                rang = geschoss_hoehe.get(etage, 1e9)
                titel_typ = bezeichnung(e.ifc_type)
                if gruppe == "typname":
                    schluessel, titel = (e.ifc_type, typ_name), f"{titel_typ} · {typ_name}"
                elif gruppe == "typ":
                    schluessel, titel = (e.ifc_type, ""), titel_typ
                else:
                    schluessel = (rang, etage, e.ifc_type)
                    titel = f"{etage or 'ohne Geschoss'} · {titel_typ}"
                b, t, h = float(hi[0] - lo[0]), float(hi[1] - lo[1]), float(hi[2] - lo[2])
                sort = {
                    "breite": (round(b, 2), round(h, 2), e.name or ""),
                    "hoehe": (round(h, 2), round(b, 2), e.name or ""),
                    "name": (e.name or "", round(b, 2)),
                    "geschoss": (rang, etage, round(b, 2)),
                }[sortierung]
                posten.append({"i": i, "gruppe": schluessel, "titel": titel, "sort": sort,
                               "b": b, "t": t, "h": h, "typ": e.ifc_type})

            pos, gruppen = anordnen(posten, abstand, zeilenbreite)

            # Durchgang 2: starr drehen, hinstellen, in die neue Auslagerungsdatei.
            neu = []
            for i, e in enumerate(elemente):
                verts, normalen, farben, uvs, indizes = quelle.read(e.record)
                theta, lo = dreh[i]
                x0, ymitte = pos[i]
                d = drehen(verts.astype(np.float64), theta)
                y_el = (d[:, 1].min() + d[:, 1].max()) / 2.0
                d += np.array([x0 - d[:, 0].min(), ymitte - y_el, -d[:, 2].min()])
                n = drehen(normalen.astype(np.float64), theta).astype(np.float32)
                v32 = d.astype(np.float32)
                satz = ziel.append(v32, n, farben, uvs, indizes)
                neu.append(_Element(
                    guid=e.guid, ifc_type=e.ifc_type, name=e.name, storey=e.storey,
                    lo=v32.min(axis=0).astype(np.float64), hi=v32.max(axis=0).astype(np.float64),
                    record=satz, triangles=e.triangles, material_chunks=e.material_chunks))
            ziel.seal()

            # Wie `_recenter`: XY-Mitte und Unterkante der Hülle in den Ursprung.
            lo = np.min([e.lo for e in neu], axis=0)
            hi = np.max([e.hi for e in neu], axis=0)
            versatz = np.array([(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, lo[2]])
            for e in neu:
                e.lo = e.lo - versatz
                e.hi = e.hi - versatz
            _write_tiles(neu, ziel, out_dir, versatz)
        finally:
            quelle.close()
            ziel.close()

    huelle_lo, huelle_hi = lo - versatz, hi - versatz
    bericht = {
        "format": "ileen-sortiert",
        "typen": schema_typen,
        "gruppe": gruppe,
        "sortierung": sortierung,
        "abstand_m": abstand,
        "zeilenbreite_m": zeilenbreite,
        "elemente": len(neu),
        "gefunden": gefunden,
        "abgeschnitten": abgeschnitten,
        # Alles Folgende im lokalen System dieses Tilesets (Hülle: XY-Mitte und
        # Unterkante im Ursprung). Der Viewer rechnet es über die Hüllbox des
        # geladenen Tilesets in die Welt um, nicht über eine nachgerechnete
        # Wurzelverschiebung des Tilers.
        "huelle": {"lo": [round(float(v), 3) for v in huelle_lo],
                   "hi": [round(float(v), 3) for v in huelle_hi]},
        "gruppen": [
            dict(g, x0=g["x0"] - float(versatz[0]), x1=g["x1"] - float(versatz[0]),
                 y0=g["y0"] - float(versatz[1]), y1=g["y1"] - float(versatz[1]),
                 y_erste=g["y_erste"] - float(versatz[1]))
            for g in gruppen
        ],
    }
    for g in bericht["gruppen"]:
        for k in ("x0", "x1", "y0", "y1", "y_erste"):
            g[k] = round(g[k], 3)
    (out_dir / "layout.json").write_text(json.dumps(bericht, ensure_ascii=False, indent=1), encoding="utf-8")
    logger.info(f"Sortierte Ansicht fertig: {len(neu)} Bauteile in {len(gruppen)} Gruppen")
    return bericht
