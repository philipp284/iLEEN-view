"""
Welches Bauteil trägt welchen Oberflächenstil — und welche Farbe hat der.

Der Zuordnungsassistent arbeitet auf Stilnamen; im Modell klickt man aber auf
ein **Bauteil**. Zwischen beidem fehlte die Brücke: die Batch Table der Tiles
führt GlobalId, Typ, Name und Geschoss, aber keinen Stil — die Texturierung
passiert eine Ebene tiefer, je Material-Chunk innerhalb eines Bauteils.

Dieses Modul baut die Brücke aus der IFC-Datei: GlobalId → Stilnamen, dazu je
Stil seine Diffusfarbe. Damit lässt sich eine Textur im Viewer auf ein Bauteil
ziehen, und die Zuordnung landet dort, wo sie hingehört — beim Stil, also bei
allen Bauteilen, die ihn tragen.

**Ohne Geometrie.** Es wird nur der Entitätsgraph gelesen, kein Körper
tesselliert. Am 554-MB-Campusmodell kostet der Index 1,7 s gegenüber 15 s für
das Öffnen der Datei allein — eine volle Geometrie-Iteration wären dagegen
Minuten.

Zwei Wege führen im IFC vom Bauteil zum Stil, und beide kommen vor:

1. **direkt** — ein `IfcStyledItem` hängt am Geometrie-Item des Bauteils.
   So exportiert ArchiCAD (IFC4, `IfcPolygonalFaceSet`).
2. **über das Material** — der Stil hängt an der Darstellung eines
   `IfcMaterial`, das dem Bauteil zugeordnet ist. So exportieren Revit und
   Allplan regelmäßig.
"""

import logging

logger = logging.getLogger(__name__)

# Tiefenschranke für verschachtelte Abbildungen (`IfcMappedItem` auf eine
# Repräsentation, die selbst wieder abbildet). Drei Ebenen hat noch kein
# Exporteur überschritten; die Schranke ist gegen zyklische Dateien.
_MAX_TIEFE = 3


def surface_styles(assignment) -> list:
    """
    Die `IfcSurfaceStyle` hinter einem Eintrag in `IfcStyledItem.Styles`.

    **Die Falle:** IFC2x3 schiebt eine `IfcPresentationStyleAssignment`
    dazwischen, IFC4 verweist direkt auf den Stil. Der naheliegende Griff
    `getattr(a, "Styles", None) or [a]` fängt beide Fälle scheinbar ab — und
    ist bei IFC4 still falsch, denn ein `IfcSurfaceStyle` **hat** selbst ein
    Attribut `Styles`: die Liste seiner Rendering-Angaben. Der Ausdruck
    liefert dann `[IfcSurfaceStyleRendering]`, und die anschließende Prüfung
    `is_a("IfcSurfaceStyle")` verwirft alles. Unterschieden wird deshalb über
    den Typ, nicht über das Vorhandensein des Attributs.
    """
    if assignment is None:
        return []
    if assignment.is_a("IfcPresentationStyleAssignment"):
        return [s for s in (assignment.Styles or []) if s is not None and s.is_a("IfcSurfaceStyle")]
    return [assignment] if assignment.is_a("IfcSurfaceStyle") else []


def stil_farbe(stil) -> tuple[str | None, float]:
    """Diffusfarbe eines Stils als `#rrggbb` und seine Transparenz (0 = deckend)."""
    for eintrag in (stil.Styles or []):
        if not (eintrag.is_a("IfcSurfaceStyleRendering") or eintrag.is_a("IfcSurfaceStyleShading")):
            continue
        c = eintrag.SurfaceColour
        if c is None:
            continue
        transparenz = getattr(eintrag, "Transparency", None)
        # NaN kommt in Exporten vor und überlebt jeden Vergleich als False —
        # deshalb gegen sich selbst prüfen statt gegen einen Grenzwert.
        if transparenz is None or transparenz != transparenz:
            transparenz = 0.0
        return "#%02x%02x%02x" % (
            round(max(0.0, min(1.0, c.Red)) * 255),
            round(max(0.0, min(1.0, c.Green)) * 255),
            round(max(0.0, min(1.0, c.Blue)) * 255),
        ), float(transparenz)
    return None, 0.0


def _items(representation, tiefe: int = 0) -> list:
    """Alle Geometrie-Items einer Repräsentation, abgebildete eingeschlossen."""
    gefunden = []
    for item in (representation.Items or []):
        gefunden.append(item)
        if item.is_a("IfcMappedItem") and tiefe < _MAX_TIEFE:
            quelle = item.MappingSource
            if quelle is not None and quelle.MappedRepresentation is not None:
                gefunden += _items(quelle.MappedRepresentation, tiefe + 1)
    return gefunden


def _materialien(zuordnung, tiefe: int = 0) -> list:
    """Die `IfcMaterial` hinter einer Materialzuordnung, gleich welcher Bauart."""
    m = zuordnung
    if m is None or tiefe > _MAX_TIEFE:
        return []
    if m.is_a("IfcMaterial"):
        return [m]
    if m.is_a("IfcMaterialLayerSetUsage"):
        return _materialien(m.ForLayerSet, tiefe + 1)
    if m.is_a("IfcMaterialLayerSet"):
        return [l.Material for l in (m.MaterialLayers or []) if l.Material]
    if m.is_a("IfcMaterialLayer"):
        return [m.Material] if m.Material else []
    if m.is_a("IfcMaterialConstituentSet"):
        return [c.Material for c in (m.MaterialConstituents or []) if c.Material]
    if m.is_a("IfcMaterialProfileSetUsage"):
        return _materialien(m.ForProfileSet, tiefe + 1)
    if m.is_a("IfcMaterialProfileSet"):
        return [p.Material for p in (m.MaterialProfiles or []) if p.Material]
    if m.is_a("IfcMaterialList"):
        return [x for x in (m.Materials or []) if x]
    return []


def _stile_je_item(ifc_file) -> dict[int, set]:
    """Entity-ID eines Geometrie-Items → Stilnamen, die daran hängen (Weg 1)."""
    zuordnung: dict[int, set] = {}
    for styled in ifc_file.by_type("IfcStyledItem"):
        if styled.Item is None:
            continue
        namen = {
            s.Name
            for a in (styled.Styles or [])
            for s in surface_styles(a)
            if s.Name
        }
        if namen:
            zuordnung.setdefault(styled.Item.id(), set()).update(namen)
    return zuordnung


def _stile_je_material(ifc_file) -> dict[int, set]:
    """Entity-ID eines `IfcMaterial` → Stilnamen seiner Darstellung (Weg 2)."""
    zuordnung: dict[int, set] = {}
    for material in ifc_file.by_type("IfcMaterial"):
        namen = set()
        for darstellung in (getattr(material, "HasRepresentation", None) or []):
            for repr_ in (darstellung.Representations or []):
                for item in (repr_.Items or []):
                    for a in (getattr(item, "Styles", None) or []):
                        namen |= {s.Name for s in surface_styles(a) if s.Name}
        if namen:
            zuordnung[material.id()] = namen
    return zuordnung


def bauteil_stile(ifc_file) -> dict[str, list[str]]:
    """GlobalId → Stilnamen des Bauteils, beide Wege zusammengeführt."""
    je_item = _stile_je_item(ifc_file)
    je_material = _stile_je_material(ifc_file)

    ergebnis: dict[str, list[str]] = {}
    for produkt in ifc_file.by_type("IfcProduct"):
        guid = getattr(produkt, "GlobalId", None)
        if not guid:
            continue
        namen = set()

        darstellung = getattr(produkt, "Representation", None)
        if darstellung is not None:
            for repr_ in (darstellung.Representations or []):
                for item in _items(repr_):
                    namen |= je_item.get(item.id(), set())

        if je_material:
            for rel in (getattr(produkt, "HasAssociations", None) or []):
                if rel.is_a("IfcRelAssociatesMaterial"):
                    for material in _materialien(rel.RelatingMaterial):
                        namen |= je_material.get(material.id(), set())

        if namen:
            ergebnis[guid] = sorted(namen)
    return ergebnis


def stil_verwendung(ifc_file) -> dict[str, int]:
    """
    Stilname → Zahl seiner Zuweisungen an Geometrie (`IfcStyledItem`).

    Nicht die Zahl der Stil-Entities zählen: die ist fast immer 1 je Name und
    sagt nichts darüber, wie viel Fläche ein Stil im Modell einnimmt.
    """
    anzahl: dict[str, int] = {}
    for styled in ifc_file.by_type("IfcStyledItem"):
        for a in (styled.Styles or []):
            for s in surface_styles(a):
                if s.Name:
                    anzahl[s.Name] = anzahl.get(s.Name, 0) + 1
    return anzahl


def aufbauen(ifc_file) -> dict:
    """
    Der vollständige Index, wie ihn die API ausliefert.

    Die Bauteile verweisen über **Indizes** in die Stilliste statt über Namen:
    bei 34 000 Bauteilen mit Namen wie „Metall Aluminium matt dunkler" wäre die
    Datei doppelt so groß, und sie geht als Ganzes über die Leitung, weil der
    Viewer beim Ziehen über die Szene keine Rückfrage stellen darf.
    """
    zuordnung = bauteil_stile(ifc_file)
    verwendung = stil_verwendung(ifc_file)

    farben: dict[str, tuple[str | None, float]] = {}
    for stil in ifc_file.by_type("IfcSurfaceStyle"):
        if stil.Name and stil.Name not in farben:
            farben[stil.Name] = stil_farbe(stil)

    bauteile_je_stil: dict[str, int] = {}
    for namen in zuordnung.values():
        for name in namen:
            bauteile_je_stil[name] = bauteile_je_stil.get(name, 0) + 1

    namen_sortiert = sorted(
        set(farben) | set(verwendung) | set(bauteile_je_stil),
        key=lambda n: (-bauteile_je_stil.get(n, 0), -verwendung.get(n, 0), n),
    )
    position = {name: i for i, name in enumerate(namen_sortiert)}

    styles = []
    for name in namen_sortiert:
        farbe, transparenz = farben.get(name, (None, 0.0))
        styles.append({
            "name": name,
            "farbe": farbe,
            "transparenz": round(transparenz, 3),
            "zuweisungen": verwendung.get(name, 0),
            "bauteile": bauteile_je_stil.get(name, 0),
        })

    elemente = {guid: [position[n] for n in namen if n in position]
                for guid, namen in zuordnung.items()}

    logger.info(
        f"Stilindex: {len(styles)} Stile, {len(elemente)} Bauteile zugeordnet"
    )
    return {"styles": styles, "elemente": elemente}
