"""
Was die Räume eines Modells über sich sagen — Psets, Klassifikation, Zonen.

Das Raumverzeichnis in `section._room_index()` führt je Raum die Geometrie:
Hüllquader, Grundrissfigur, Netzvolumen. Was der Raum *ist* — welche Nutzung
der Planer eingetragen hat, ob er barrierefrei sein muss, welche Heizlast die
TGA gerechnet hat —, steht dort nicht. Es steht in den Property-Sets, und die
Bauteildatenbank (`properties.sqlite`) kennt keine Räume, weil das Tiling
`IfcSpace` gar nicht erst anfasst.

**Ein eigener Cache und kein neues Feld im Raumverzeichnis.** Das
Raumverzeichnis braucht einen Geometrielauf über alle Räume, und an ihm hängen
Lastabtrag und GEG-Bilanz. Eine neue Formatversion dort hieße, bei jedem
Modell die Geometrie neu zu rechnen, nur um ein paar Texte dazuzulegen. Die
Semantik braucht keine Geometrie — nur `ifcopenshell.open()` und den
Entitätsgraphen — und bekommt deshalb ihre eigene Datei mit ihrer eigenen
Versionsnummer.

**Gedeutet wird in `ileen/raumdaten.py`,** hier wird nur gelesen. So bleibt die
Deutung ohne IFC-Datei prüfbar (`tests/test_raumdaten.py`).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from tiling.section import _CACHE_DIR, build_lock

logger = logging.getLogger(__name__)


def _cache_pfad(job_id: str) -> Path:
    # Die Zahl im Namen ist eine Formatversion, wie bei `rooms4`. Ein neuer
    # Name liest das Modell einmal neu, statt einen Datensatz zu liefern, dem
    # Felder fehlen, die der Viewer inzwischen erwartet.
    #
    #   1 — Psets, Merkmale, Klassifikation, Zonen, PredefinedType
    #   2 — `Pset_iLEEN_Raum` wird zurückgelesen (Raumklasse, Planungsangaben,
    #       Katalogwerte ausgenommen); Bodenbelag in der Feldtabelle
    return _CACHE_DIR / f"{job_id}.raumsem2.json"


def purge_cache(job_id: str):
    """Beim Löschen eines Assets — auch die Vorgängerfassungen der Datei."""
    for version in ("raumsem1", "raumsem2"):
        (_CACHE_DIR / f"{job_id}.{version}.json").unlink(missing_ok=True)


def raumsemantik(src: Path, job_id: str) -> dict[str, dict]:
    """
    GlobalId → `{psets, merkmale, ifc}` für jeden `IfcSpace` des Modells.

    Der erste Aufruf öffnet die IFC-Datei (bei großen Modellen einige
    Sekunden), jeder weitere liest die Cachedatei. Dieselbe Sperre wie beim
    Raumverzeichnis: der Viewer fragt `/rooms` und das Planpanel `/storeys`
    beim Öffnen eines Modells gleichzeitig ab.
    """
    cached = _cache_pfad(job_id)
    treffer = _lesen(cached)
    if treffer is not None:
        return treffer
    with build_lock(cached):
        treffer = _lesen(cached)
        if treffer is not None:
            return treffer
        daten = _aufbauen(src)
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        teil = cached.with_suffix(".part")
        teil.write_text(json.dumps(daten, ensure_ascii=False), encoding="utf-8")
        teil.replace(cached)
        logger.info(f"[{job_id}] Raumsemantik: {len(daten)} Räume")
        return daten


def _lesen(cached: Path):
    if not cached.exists():
        return None
    try:
        return json.loads(cached.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # Eine halb geschriebene oder beschädigte Datei wird neu aufgebaut,
        # statt den Viewer mit einem Fehler stehen zu lassen.
        return None


def _klassifikation(util_classification, element) -> list[dict]:
    """
    Die Klassifikationsverweise eines Raums — DIN 277, Uniclass, OmniClass.

    IFC4 nennt die Kennung `Identification`, IFC2x3 `ItemReference`. Das System
    (`IfcClassification.Name`) steht am Ende der Verweiskette und sagt erst,
    wie „2.1" zu lesen ist.
    """
    ergebnis: list[dict] = []
    try:
        verweise = util_classification.get_references(element)
    except Exception:
        return ergebnis
    for ref in verweise or []:
        kennung = getattr(ref, "Identification", None) or getattr(ref, "ItemReference", None)
        system = None
        try:
            quelle = util_classification.get_classification(ref)
            system = getattr(quelle, "Name", None) if quelle else None
        except Exception:
            pass
        ergebnis.append({"kennung": kennung, "name": getattr(ref, "Name", None),
                         "system": system})
    ergebnis.sort(key=lambda k: (str(k.get("system") or ""), str(k.get("kennung") or "")))
    return ergebnis


def _zonen(element) -> list[dict]:
    """
    Die `IfcZone`, zu denen ein Raum gehört — Brandabschnitt, Wohnung, Mietbereich.

    Zonen hängen über `IfcRelAssignsToGroup` am Raum, nicht über eine
    Eigenschaft. Welche Art Zone es ist, steht in `ObjectType` (IFC2x3 und 4)
    oder `LongName` (nur IFC4); beides ist Freitext.
    """
    ergebnis: list[dict] = []
    for rel in getattr(element, "HasAssignments", None) or []:
        try:
            if not rel.is_a("IfcRelAssignsToGroup"):
                continue
            gruppe = rel.RelatingGroup
            if not gruppe or not gruppe.is_a("IfcZone"):
                continue
        except Exception:
            continue
        ergebnis.append({
            "global_id": getattr(gruppe, "GlobalId", None),
            "name": getattr(gruppe, "Name", None),
            "art": getattr(gruppe, "ObjectType", None) or getattr(gruppe, "LongName", None),
        })
    ergebnis.sort(key=lambda z: (str(z.get("art") or ""), str(z.get("name") or "")))
    return ergebnis


def _aufbauen(src: Path) -> dict[str, dict]:
    import ifcopenshell
    import ifcopenshell.util.classification as util_classification
    import ifcopenshell.util.element as util_element

    from ileen import raumdaten

    ifc_file = ifcopenshell.open(str(src))
    try:
        raeume = ifc_file.by_type("IfcSpace")
    except Exception:
        raeume = []

    daten: dict[str, dict] = {}
    for raum in raeume:
        gid = getattr(raum, "GlobalId", None)
        if not gid:
            continue
        try:
            psets = util_element.get_psets(raum)
        except Exception as e:
            logger.warning(f"Raum {gid}: Psets nicht lesbar ({e})")
            psets = {}

        klassifikation = _klassifikation(util_classification, raum)
        merkmale = raumdaten.merkmale(psets)
        gruppe = raumdaten.din277_aus(merkmale, klassifikation)
        if gruppe:
            merkmale["din277_gruppe"] = gruppe

        daten[gid] = {
            "psets": raumdaten.psets_bereinigen(psets),
            "merkmale": merkmale,
            "ifc": {
                # IFC4 führt `PredefinedType` (SPACE, PARKING, INTERNAL, …),
                # IFC2x3 nur `InteriorOrExteriorSpace`.
                "predefined_type": (getattr(raum, "PredefinedType", None)
                                    or getattr(raum, "InteriorOrExteriorSpace", None)),
                "object_type": getattr(raum, "ObjectType", None),
                "description": getattr(raum, "Description", None),
                "klassifikation": klassifikation,
                "zonen": _zonen(raum),
            },
        }
    return daten
