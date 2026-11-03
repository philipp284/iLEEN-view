"""
Die Raumansicht zurück ins IFC: `Pset_iLEEN_Raum` je `IfcSpace`.

Was die Raumansicht über einen Raum weiß, steht bisher nur im Browser: die
Raumklasse (oft von Hand zugeordnet), das Anforderungsprofil, die Nutzlast der
Statik, die TGA-Kennwerte. Wer das Modell weitergibt, gibt es nicht mit — und
wer es neu einliest, ordnet von vorn zu. Dieses Modul schreibt eine Kopie der
Quelldatei, in der jeder Raum es trägt.

## Zwei Sätze: Wert und Herkunft

    Pset_iLEEN_Raum          Raumklasse = buero, Nutzlast_kNm2 = 2.0, …
    Pset_iLEEN_RaumHerkunft  Nutzlast_kNm2 = "statik: B1 · DIN EN 1991-1-1/NA …"

Ein Richtwert aus dem Katalog sieht im IFC genauso aus wie eine Angabe der
Fachplanung — eine Zahl. Damit er beim nächsten Einlesen nicht als
Planungsangabe zurückkommt, steht neben jedem Wert, woher er stammt, und
`raumdaten.merkmale()` liest beides wieder zusammen.

## Einheit im Namen, nicht im Typ

`IfcPlanarForceMeasure` für eine Nutzlast wäre der formal richtige Typ — und
liest sich in einer Datei ohne eigene Krafteinheit als **Pascal**: 2,0 kN/m²
kämen als 2 N/m² an. Dasselbe gilt für Temperatur (SI: Kelvin) und Leistung.
Die Werte stehen deshalb als `IfcReal` mit der Einheit im Namen
(`Nutzlast_kNm2`, `Heizlast_W`, `Raumtemperatur_C`). Das liest jedes Werkzeug
richtig, ohne die Einheitenzuweisung der Datei zu kennen.

## Normsätze: nur füllen, nie überschreiben

Auf Wunsch (`normsaetze=True`) werden zusätzlich die IFC-Normsätze befüllt,
damit fremde Software die Angaben findet: `Pset_SpaceOccupancyRequirements`,
`Pset_SpaceLightingRequirements`, `Pset_SpaceThermalRequirements`,
`Pset_SpaceFireSafetyRequirements`, `Pset_SpaceCommon.HandicapAccessible` und
eine DIN-277-Klassifikation. **Nur wo nichts steht**, und nie in einem
Property-Set, das sich mehrere Räume teilen — ArchiCAD und Revit legen gleiche
Sätze gern einmal an und hängen sie an viele Objekte; eine Ergänzung dort
schriebe in alle.

Die Temperatur geht dort in der Einheit der Datei hinein
(`IfcThermodynamicTemperatureMeasure`): °C, wenn die Datei Celsius vereinbart,
sonst Kelvin — der IFC-Standard.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from .raumdaten import ILEEN_FELDER as FELDER, ILEEN_PSET, ILEEN_PSET_HERKUNFT

logger = logging.getLogger(__name__)

# Die Namen stehen in `raumdaten`, weil dort auch zurückgelesen wird — eine
# Stelle für beide Richtungen.
PSET = ILEEN_PSET
PSET_HERKUNFT = ILEEN_PSET_HERKUNFT

_IFCTYP = {"zahl": "IfcReal", "bool": "IfcBoolean", "text": "IfcLabel",
           "kennung": "IfcIdentifier", "langtext": "IfcText"}

_NAME_OK = re.compile(r"^[A-Za-z0-9_]{1,64}$")


def _wert(art: str, roh):
    """Python-Wert für den IFC-Typ — oder None, wenn er nicht passt."""
    if roh is None or roh == "":
        return None
    if art == "bool":
        return bool(roh)
    if art == "zahl":
        try:
            z = float(roh)
        except (TypeError, ValueError):
            return None
        return z if z == z and abs(z) != float("inf") else None
    text = str(roh).strip()
    if not text:
        return None
    # IfcLabel und IfcIdentifier tragen höchstens 255 Zeichen.
    return text if art == "langtext" else text[:255]


def _besitzer(datei):
    vorhanden = datei.by_type("IfcOwnerHistory")
    return vorhanden[0] if vorhanden else None


def _pset(datei, objekt, name: str, eigenschaften: list, beschreibung: str | None, besitzer):
    import ifcopenshell.guid
    pset = datei.create_entity(
        "IfcPropertySet", GlobalId=ifcopenshell.guid.new(), OwnerHistory=besitzer,
        Name=name, Description=beschreibung, HasProperties=eigenschaften)
    datei.create_entity(
        "IfcRelDefinesByProperties", GlobalId=ifcopenshell.guid.new(), OwnerHistory=besitzer,
        RelatedObjects=[objekt], RelatingPropertyDefinition=pset)
    return pset


def _vorhandene_psets(objekt) -> dict:
    """Name → (Property-Set, Anzahl der Objekte, an denen es hängt)."""
    ergebnis = {}
    for rel in getattr(objekt, "IsDefinedBy", None) or []:
        if not rel.is_a("IfcRelDefinesByProperties"):
            continue
        definition = rel.RelatingPropertyDefinition
        if definition and definition.is_a("IfcPropertySet"):
            ergebnis[definition.Name] = (definition, len(rel.RelatedObjects or []))
    return ergebnis


def _alte_ileen_saetze_entfernen(datei, objekt) -> int:
    """
    Ein früherer Export am selben Raum wird ersetzt, nicht verdoppelt.

    Wer eine angereicherte Datei wieder einliest und neu exportiert, hätte
    sonst zwei `Pset_iLEEN_Raum` am Raum — nach IFC unzulässig, und welcher
    gilt, entschiede der Viewer.
    """
    weg = 0
    for rel in list(getattr(objekt, "IsDefinedBy", None) or []):
        if not rel.is_a("IfcRelDefinesByProperties"):
            continue
        definition = rel.RelatingPropertyDefinition
        if not definition or definition.Name not in (PSET, PSET_HERKUNFT):
            continue
        if len(rel.RelatedObjects or []) > 1:
            rel.RelatedObjects = [o for o in rel.RelatedObjects if o != objekt]
        else:
            for eigenschaft in list(definition.HasProperties or []):
                datei.remove(eigenschaft)
            datei.remove(definition)
            datei.remove(rel)
        weg += 1
    return weg


def _temperatur_in_dateieinheit(datei, celsius: float) -> float:
    """°C in die Temperatureinheit der Datei — Celsius, wenn vereinbart, sonst Kelvin (SI)."""
    try:
        for zuweisung in datei.by_type("IfcUnitAssignment"):
            for einheit in zuweisung.Units or []:
                if getattr(einheit, "UnitType", None) == "THERMODYNAMICTEMPERATUREUNIT":
                    if getattr(einheit, "Name", None) == "DEGREE_CELSIUS":
                        return celsius
                    if "FAHRENHEIT" in str(getattr(einheit, "Name", "")).upper():
                        return celsius * 9 / 5 + 32
    except Exception:  # noqa: BLE001
        pass
    return celsius + 273.15


#: Normsatz → [(Property, IFC-Typ, Kriterium, Umrechnung)]
NORMSAETZE = {
    "Pset_SpaceOccupancyRequirements": [
        ("OccupancyType", "IfcLabel", "klasse_bezeichnung", None),
        ("OccupancyNumber", "IfcCountMeasure", "personen", "ganzzahl"),
    ],
    "Pset_SpaceLightingRequirements": [
        ("Illuminance", "IfcIlluminanceMeasure", "lux", None),
    ],
    "Pset_SpaceThermalRequirements": [
        ("SpaceTemperatureMin", "IfcThermodynamicTemperatureMeasure", "temperatur", "temperatur"),
    ],
    "Pset_SpaceFireSafetyRequirements": [
        ("FireExit", "IfcBoolean", "fluchtweg", None),
    ],
    "Pset_SpaceCommon": [
        ("HandicapAccessible", "IfcBoolean", "barrierefrei", None),
    ],
}


def _normsaetze_fuellen(datei, objekt, werte: dict, bezeichnung: str | None,
                        besitzer, protokoll: dict) -> None:
    """Normsätze ergänzen, wo sie fehlen — siehe Moduldoku."""
    vorhanden = _vorhandene_psets(objekt)
    quelle = {k: (v or {}).get("wert") for k, v in werte.items()}
    quelle["klasse_bezeichnung"] = bezeichnung
    for satz, felder in NORMSAETZE.items():
        neu = []
        for prop, typ, kriterium, umrechnung in felder:
            wert = quelle.get(kriterium)
            if wert is None or wert == "":
                continue
            if umrechnung == "ganzzahl":
                wert = int(round(float(wert)))
            elif umrechnung == "temperatur":
                wert = _temperatur_in_dateieinheit(datei, float(wert))
            elif typ == "IfcBoolean":
                wert = bool(wert)
            elif typ not in ("IfcLabel",):
                wert = float(wert)
            neu.append((prop, typ, wert))
        if not neu:
            continue
        if satz in vorhanden:
            pset, geteilt = vorhanden[satz]
            schon = {p.Name for p in pset.HasProperties or []}
            fehlend = [n for n in neu if n[0] not in schon]
            if not fehlend:
                continue
            if geteilt > 1:
                protokoll["normsaetze_geteilt_uebersprungen"] += 1
                continue
            pset.HasProperties = list(pset.HasProperties or []) + [
                datei.create_entity("IfcPropertySingleValue", Name=p,
                                    NominalValue=datei.create_entity(t, w)) for p, t, w in fehlend]
            protokoll["normsaetze_ergaenzt"] += len(fehlend)
        else:
            _pset(datei, objekt, satz, [
                datei.create_entity("IfcPropertySingleValue", Name=p,
                                    NominalValue=datei.create_entity(t, w)) for p, t, w in neu],
                None, besitzer)
            protokoll["normsaetze_ergaenzt"] += len(neu)


def _din277_klassifizieren(datei, objekt, gruppe: str, bezeichnung: str | None,
                           system_cache: dict, besitzer, protokoll: dict) -> None:
    """Eine DIN-277-Klassifikation anhängen, wenn der Raum noch keine nach DIN 277 trägt."""
    import ifcopenshell.guid
    import ifcopenshell.util.classification as uc

    try:
        for ref in uc.get_references(objekt) or []:
            system = uc.get_classification(ref)
            text = " ".join(str(x or "") for x in (getattr(system, "Name", None),
                                                   getattr(ref, "Identification", None),
                                                   getattr(ref, "ItemReference", None)))
            if "277" in text or re.search(r"\b(NUF|VF|TF)\b", text):
                return
    except Exception:  # noqa: BLE001
        pass
    if "system" not in system_cache:
        attribute = {"Name": "DIN 277", "Edition": "2021"}
        if datei.schema == "IFC2X3":
            attribute.update({"Source": "DIN", "Edition": "2021"})
        system_cache["system"] = datei.create_entity("IfcClassification", **attribute)
    feld = "ItemReference" if datei.schema == "IFC2X3" else "Identification"
    verweis = datei.create_entity("IfcClassificationReference", **{
        feld: gruppe, "Name": bezeichnung, "ReferencedSource": system_cache["system"]})
    datei.create_entity("IfcRelAssociatesClassification", GlobalId=ifcopenshell.guid.new(),
                        OwnerHistory=besitzer, RelatedObjects=[objekt],
                        RelatingClassification=verweis)
    protokoll["din277_klassifiziert"] += 1


def anreichern(quelle: Path, ziel: Path, raeume: dict[str, dict], *,
               normsaetze: bool = False, titel: str = "iLEEN Raumansicht") -> dict:
    """
    Die Quelldatei um `Pset_iLEEN_Raum` je Raum ergänzen und als `ziel` schreiben.

    @param raeume  GlobalId → `{klasse, klasse_bezeichnung, werte: {kriterium:
                   {wert, quelle_art, quelle_text}}}` — so, wie die Raumansicht
                   sie zusammengeführt hat
    @param normsaetze  zusätzlich leere IFC-Normsätze und die DIN-277-
                   Klassifikation füllen
    @returns Protokoll
    """
    import ifcopenshell

    datei = ifcopenshell.open(str(quelle))
    besitzer = _besitzer(datei)
    protokoll = {"raeume": 0, "werte": 0, "nicht_gefunden": [], "ersetzt": 0,
                 "normsaetze_ergaenzt": 0, "normsaetze_geteilt_uebersprungen": 0,
                 "din277_klassifiziert": 0}
    system_cache: dict = {}
    stempel = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    for gid, raum in (raeume or {}).items():
        try:
            objekt = datei.by_guid(gid)
        except RuntimeError:
            protokoll["nicht_gefunden"].append(gid)
            continue
        if not objekt.is_a("IfcSpace"):
            protokoll["nicht_gefunden"].append(gid)
            continue

        werte = dict(raum.get("werte") or {})
        if raum.get("klasse"):
            werte["klasse"] = {"wert": raum["klasse"], "quelle_art": raum.get("klasse_herkunft") or "hand",
                               "quelle_text": raum.get("klasse_bezeichnung")}

        eigenschaften, herkunft = [], []
        for kriterium, name, art, _ in FELDER:
            eintrag = werte.get(kriterium)
            if not isinstance(eintrag, dict) or not _NAME_OK.match(name):
                continue
            wert = _wert(art, eintrag.get("wert"))
            if wert is None:
                continue
            eigenschaften.append(datei.create_entity(
                "IfcPropertySingleValue", Name=name,
                NominalValue=datei.create_entity(_IFCTYP[art], wert)))
            text = f"{eintrag.get('quelle_art') or '?'}: {eintrag.get('quelle_text') or ''}".strip()
            herkunft.append(datei.create_entity(
                "IfcPropertySingleValue", Name=name,
                NominalValue=datei.create_entity("IfcText", text)))
        if raum.get("klasse_bezeichnung"):
            eigenschaften.append(datei.create_entity(
                "IfcPropertySingleValue", Name="Raumklasse_Bezeichnung",
                NominalValue=datei.create_entity("IfcLabel", str(raum["klasse_bezeichnung"])[:255])))
        if not eigenschaften:
            continue

        protokoll["ersetzt"] += _alte_ileen_saetze_entfernen(datei, objekt)
        _pset(datei, objekt, PSET, eigenschaften,
              f"iLEEN Raumansicht {stempel} — Richtwerte und Planungsangaben, Herkunft je Wert "
              f"in {PSET_HERKUNFT}", besitzer)
        _pset(datei, objekt, PSET_HERKUNFT, herkunft,
              "Woher jeder Wert in Pset_iLEEN_Raum stammt: ifc | statik | katalog | abgeleitet | hand",
              besitzer)
        protokoll["raeume"] += 1
        protokoll["werte"] += len(eigenschaften)

        if normsaetze:
            _normsaetze_fuellen(datei, objekt, werte, raum.get("klasse_bezeichnung"), besitzer, protokoll)
            din = (werte.get("din277") or {}).get("wert")
            if din:
                _din277_klassifizieren(datei, objekt, str(din).split(" · ")[0],
                                       (werte.get("din277") or {}).get("bezeichnung"),
                                       system_cache, besitzer, protokoll)

    try:
        beschreibung = datei.header.file_description
        vorhanden = [t for t in (beschreibung.description or []) if "iLEEN Raumansicht" not in t]
        beschreibung.description = tuple(vorhanden + [
            f"{titel} — {protokoll['raeume']} Räume mit {PSET} ({stempel}). Richtwerte sind als "
            f"solche in {PSET_HERKUNFT} gekennzeichnet."])
    except Exception as fehler:  # noqa: BLE001 — der Export ist wichtiger als sein Kopf
        logger.warning("IFC-Kopfzeile nicht ergänzbar (%s)", fehler)

    ziel.parent.mkdir(parents=True, exist_ok=True)
    datei.write(str(ziel))
    protokoll["bytes"] = ziel.stat().st_size if ziel.exists() else 0
    logger.info("Raum-IFC: %s Räume, %s Werte, Normsätze %s → %s",
                protokoll["raeume"], protokoll["werte"], protokoll["normsaetze_ergaenzt"], ziel)
    return protokoll
