"""
Bauteile aus dem IFC-Modell in das Volumenmodell holen.

Die Brücke zwischen dem, was im Viewer angeklickt wird, und dem, was
`volumen.py` rechnen kann. Drei Dinge sind dabei zu erledigen:

1. **Geometrie** — das Dreiecksnetz des Bauteils, im tile-lokalen System.
2. **Werkstoff** — aus dem, was das IFC über das Material sagt, eine
   Festigkeitsklasse machen.
3. **Faserrichtung** — bei Holz aus der Gestalt, siehe `Bauteil.faserrichtung()`.

## Das Koordinatensystem ist die Stelle, an der es schiefgeht

`section.build_index()` liefert neben dem Elementverzeichnis den
**Zentrierungs-Offset** des Modells: dieselbe Größe, um die das Tiling die
Geometrie verschoben hat, damit ein Modell in UTM-Koordinaten nicht die
float32-Genauigkeit der Kacheln aufbraucht. Wer ihn vergisst, bekommt ein
richtig gerechnetes Ergebnis an einer Stelle, die hunderte Kilometer neben
dem Gebäude liegt — und merkt es erst, wenn die Wolke im Viewer nicht
auftaucht.

Deshalb wird der Offset hier **immer** abgezogen, und das Ergebnis liegt im
selben System wie das Tileset des Modells. Die Punktwolke bekommt später
dessen Placement und liegt damit genau im Bauteil.

## Der Werkstoff ist geraten, bis jemand widerspricht

`IfcMaterial.Name` ist Freitext. Dort steht „Beton C25/30", „Concrete,
Cast-in-Place", „STB", „Holz", „GL24h", „Nadelholz S10" oder auch der
Firmenname eines Fertigteilwerks. Eine Zuordnung nach Schlüsselwörtern trifft
das meiste und niemals alles — genau wie bei der Texturzuordnung in
`tiling/materials.py`, und mit derselben Konsequenz: sie ist ein **Vorschlag**
mit einer Begründung, und der Aufrufer kann sie überschreiben.

**Die Festigkeitsklasse wird nicht erfunden.** Steht im Namen „C30/37", wird
C30/37 genommen. Steht dort nur „Beton", wird C25/30 angenommen — und dieser
Umstand steht in der Begründung, damit er im Bericht auftaucht. Eine
angenommene Festigkeit, die als gemessene erscheint, ist schlimmer als gar
keine.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import numpy as np

from . import volumen as vo
from . import werkstoff as wk

logger = logging.getLogger(__name__)

#: Ohne Angabe. Bewusst nicht die stärkste Klasse — eine zu hohe Annahme
#: liegt auf der unsicheren Seite.
VORGABE = {"beton": "C25/30", "holz": "C24", "stahl": "S235"}

_BETON = re.compile(r"\bC\s?(\d{2})\s?/\s?(\d{2})\b", re.I)
_STAHL = re.compile(r"\bS\s?(235|275|355|460)\b", re.I)
_BSH = re.compile(r"\bGL\s?(24|28|32)\s?([hc])\b", re.I)
_VOLLHOLZ = re.compile(r"\b(C\s?(?:24|30)|D\s?30)\b", re.I)

_WORTE = {
    "beton": ("beton", "concrete", "stahlbeton", "stb", "ortbeton", "béton",
              "reinforced", "estrich", "cast-in-place"),
    "holz": ("holz", "wood", "timber", "brettschicht", "bsh", "kvh", "glulam",
             "nadelholz", "fichte", "lärche", "laerche", "bois", "clt",
             "brettsperrholz", "furnierschicht"),
    "stahl": ("stahl", "steel", "acier", "profil", "hea", "heb", "ipe", "walz"),
}

#: Wenn das Material nichts hergibt: was der IFC-Typ nahelegt. Eine schwache
#: Vermutung, die als solche gekennzeichnet wird.
_NACH_TYP = {
    "IfcBeam": "beton", "IfcColumn": "beton", "IfcSlab": "beton",
    "IfcWall": "beton", "IfcWallStandardCase": "beton", "IfcFooting": "beton",
    "IfcMember": "stahl", "IfcPlate": "stahl",
}


def werkstoff_raten(material: str | None, ifc_typ: str = "",
                    schichten: list | None = None) -> tuple[wk.Werkstoff, str]:
    """
    Aus einem IFC-Materialnamen eine Festigkeitsklasse machen.

    @returns (Werkstoff, Begründung — wörtlich für den Bericht)

    Zuerst wird nach einer **Klassenbezeichnung** gesucht (C25/30, S355,
    GL28h): steht sie da, ist die Sache entschieden und die Begründung nennt
    die Fundstelle. Erst danach entscheiden Schlüsselwörter über die Familie,
    und die Klasse wird zur Annahme.

    Die Reihenfolge ist wichtig und nicht beliebig: „Holz C24" enthält sowohl
    ein Holz-Schlüsselwort als auch etwas, das wie eine Betonklasse aussieht,
    wenn man C24 mit C20/25 verwechselt. Deshalb wird die Betonklasse nur bei
    vollständiger Schreibweise mit Schrägstrich erkannt.
    """
    text = " ".join(str(t) for t in ([material] + list(schichten or [])) if t).strip()
    unten = text.lower()

    if (treffer := _BSH.search(text)):
        name = f"GL{treffer.group(1)}{treffer.group(2).lower()}"
        if name in wk.WERKSTOFFE:
            return wk.werkstoff(name), f"Klasse aus dem Materialnamen „{text}“"
    if (treffer := _STAHL.search(text)):
        return wk.werkstoff(f"S{treffer.group(1)}"), f"Klasse aus dem Materialnamen „{text}“"
    if (treffer := _BETON.search(text)):
        name = f"C{treffer.group(1)}/{treffer.group(2)}"
        if name in wk.WERKSTOFFE:
            return wk.werkstoff(name), f"Klasse aus dem Materialnamen „{text}“"
    if any(w in unten for w in _WORTE["holz"]) and (treffer := _VOLLHOLZ.search(text)):
        name = treffer.group(1).replace(" ", "").upper()
        if name in wk.WERKSTOFFE:
            return wk.werkstoff(name), f"Klasse aus dem Materialnamen „{text}“"

    for familie, worte in _WORTE.items():
        if any(w in unten for w in worte):
            gewaehlt = VORGABE[familie]
            # Brettschichtholz ist kein Vollholz: gleiche Familie, andere Norm,
            # andere Festigkeiten und ein anderer Teilsicherheitsbeiwert. Wer
            # „BSH“ schreibt und C24 gerechnet bekommt, rechnet das falsche
            # Bauteil — bei GL24h liegt f_m,k gleich, f_t,0,k aber um ein
            # Drittel höher.
            if familie == "holz" and any(w in unten for w in (
                    "brettschicht", "bsh", "glulam", "leimholz", "bs holz")):
                gewaehlt = "GL24h"
            return wk.werkstoff(gewaehlt), (
                f"„{text}“ deutet auf {familie}; Festigkeitsklasse {gewaehlt} "
                f"angenommen, da im Modell keine genannt ist")

    familie = _NACH_TYP.get(ifc_typ)
    if familie:
        gewaehlt = VORGABE[familie]
        return wk.werkstoff(gewaehlt), (
            f"kein verwertbares Material im Modell{f' („{text}“)' if text else ''}; "
            f"nach {ifc_typ} {gewaehlt} angenommen — bitte prüfen")

    gewaehlt = VORGABE["beton"]
    return wk.werkstoff(gewaehlt), (
        f"weder Material noch Bauteiltyp geben einen Werkstoff her; "
        f"{gewaehlt} angenommen — bitte prüfen")


def bauteile_laden(quelle: Path, job_id: str, global_ids: list[str],
                   werkstoffe: dict[str, str] | None = None,
                   fasern: dict[str, list] | None = None) -> tuple[list, np.ndarray, list]:
    """
    Die gewählten Bauteile als `volumen.Bauteil` — Geometrie im tile-lokalen System.

    @param quelle      die IFC-Datei
    @param job_id      Asset-Kennung; steuert den Cache des Elementverzeichnisses
    @param global_ids  Auswahl aus dem Viewer
    @param werkstoffe  {GlobalId: Werkstoffname} — überschreibt die Vermutung
    @param fasern      {GlobalId: [x,y,z]} — überschreibt die Faserrichtung
    @returns (Bauteile, Offset, Hinweise)

    **Die Geometrie wird einzeln erzeugt, nicht über den Iterator.** Der
    Iterator ist der schnelle Weg durch *alle* Bauteile; hier sind es fünf.
    `create_shape` je Bauteil ist dafür der kürzere Weg und erspart es, ein
    ganzes Gebäude zu triangulieren, um drei Balken zu bekommen.
    """
    import ifcopenshell
    import ifcopenshell.geom

    from tiling.section import _make_settings, build_index

    offset, index = build_index(Path(quelle), job_id)
    nach_id = {e["global_id"]: e for e in index}

    datei = ifcopenshell.open(str(quelle))
    settings = _make_settings(ifcopenshell)

    bauteile, hinweise = [], []
    for gid in global_ids:
        eintrag = nach_id.get(gid)
        if eintrag is None:
            hinweise.append(f"{gid}: im Modell nicht gefunden — übergangen.")
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, datei.by_id(eintrag["id"]))
        except Exception as fehler:                       # noqa: BLE001
            hinweise.append(f"{gid}: keine Geometrie ({fehler}) — übergangen.")
            continue

        verts = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3) - offset
        faces = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
        if not len(verts) or not len(faces):
            hinweise.append(f"{gid}: leere Geometrie — übergangen.")
            continue

        vorgabe = (werkstoffe or {}).get(gid)
        if vorgabe:
            stoff, grund = wk.werkstoff(vorgabe), "im Viewer gewählt"
        else:
            stoff, grund = werkstoff_raten(
                eintrag.get("material"), eintrag.get("ifc_type", ""),
                eintrag.get("materialschichten"))
            hinweise.append(f"{eintrag.get('name') or gid}: {stoff.name} — {grund}.")

        bauteile.append(vo.Bauteil(
            global_id=gid,
            name=eintrag.get("name") or gid,
            ifc_typ=eintrag.get("ifc_type", ""),
            werkstoff=stoff,
            verts=verts, faces=faces,
            faser=(fasern or {}).get(gid),
            merkmale={
                "geschoss": eintrag.get("storey") or "",
                "material_ifc": eintrag.get("material") or "",
                "werkstoff_herkunft": grund,
            }))

    if not bauteile:
        raise ValueError(
            "Keines der gewählten Bauteile hat verwertbare Geometrie. "
            + (" ".join(hinweise) if hinweise else ""))
    return bauteile, offset, hinweise
