"""
Die Ergebnisse des Lastabtrags zurück in die IFC-Datei schreiben.

Der Store im Backend (`api/routes/tragwerk.py`) ist das Arbeitsformat: schnell,
filterbar, im Viewer beim Klick abrufbar. Er lebt aber im Backend, und ein
Tragwerksplaner, der die Ergebnisse in seinem eigenen Werkzeug sehen will,
kommt nicht an ihn heran. Dieses Modul erzeugt deshalb eine **angereicherte
IFC-Datei**: dieselbe Geometrie, dieselben GlobalIds, dazu je tragendem Bauteil
ein Property-Set mit dem, was der Lastabtrag ergeben hat.

## Warum Property-Sets und nicht IfcStructuralAnalysisModel

IFC kennt mit `IfcStructuralAnalysisModel` und seinen Kurven-, Flächen- und
Punktverbindungen ein vollständiges Tragwerksmodell. Es wäre die formal
richtige Ablage — und praktisch nutzlos: kaum ein Werkzeug im Hochbau liest es,
und wer es liest, erwartet darin ein *Stabwerk* samt Idealisierung, nicht
Ergebniswerte an Bauteilen.

Ein `IfcPropertySet` an der Wand liest dagegen jeder Viewer, jede Prüfsoftware
und jede Mengenermittlung. Es steht dort, wo man es sucht: beim Anklicken des
Bauteils. Die Ergebnisse sind damit dort dokumentiert, wo sie hingehören, und
die Frage nach der formalen Reinheit hat einen praktischen Sieger.

`Qto_`-Mengensätze bleiben unberührt — sie sind für Massen reserviert, nicht
für Rechenergebnisse.

## Was geschrieben wird

Ein Property-Set `Pset_iLEEN_Lastabtrag` je Bauteil und Geschoss:

    Geschoss              IfcLabel     in welchem Geschoss dieses Konto gilt
    NEd                   IfcForceMeasure       Bemessungswert, kN
    NEdJeMeter            IfcPlanarForceMeasure Bemessungswert je Meter, kN/m
    NCharakteristisch     IfcForceMeasure       ohne Sicherheitsbeiwerte
    AnteilStaendig        IfcForceMeasure
    AnteilVeraenderlich   IfcForceMeasure
    EigengewichtBauteil   IfcForceMeasure
    Ausnutzung            IfcRatioMeasure
    NachweisErfuellt      IfcBoolean
    Nachweisverfahren     IfcText
    Schlankheit           IfcRatioMeasure       λ, nur bei Wand und Stütze
    Herkunft              IfcText      welche Decken beigetragen haben

Alle Kräfte als Betrag, Druck positiv — wie im ganzen Lastabtrag.

**Die Datei ist eine Ableitung, kein Ersatz.** Sie trägt einen Hinweis im
Dateikopf, dass die Werte aus einer Vorbemessung stammen; wer sie
weiterverwendet, soll das lesen können, ohne diese Dokumentation zu kennen.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

PSET_NAME = "Pset_iLEEN_Lastabtrag"

#: Property-Name → (IFC-Typ, Einheit im Klartext). Die Reihenfolge ist die,
#: in der die Eigenschaften im Viewer erscheinen.
FELDER: list[tuple[str, str, str]] = [
    ("Geschoss", "IfcLabel", ""),
    ("Rolle", "IfcLabel", ""),
    # Vertikallast — nur bei Wänden, Stützen und Fundamenten
    ("NEd", "IfcForceMeasure", "kN"),
    ("NEdJeMeter", "IfcPlanarForceMeasure", "kN/m"),
    ("NCharakteristisch", "IfcForceMeasure", "kN"),
    ("AnteilStaendig", "IfcForceMeasure", "kN"),
    ("AnteilVeraenderlich", "IfcForceMeasure", "kN"),
    ("EigengewichtBauteil", "IfcForceMeasure", "kN"),
    # Biegung — nur bei Decken
    ("Flaeche", "IfcAreaMeasure", "m²"),
    ("Dicke", "IfcLengthMeasure", "m"),
    ("DickeQuelle", "IfcText", ""),
    ("Durchbiegung", "IfcLengthMeasure", "mm"),
    ("DurchbiegungGrenzwert", "IfcLengthMeasure", "mm"),
    # Für alle
    ("Ausnutzung", "IfcRatioMeasure", ""),
    ("NachweisErfuellt", "IfcBoolean", ""),
    ("NachweiseOffen", "IfcText", ""),
    ("Nachweisverfahren", "IfcText", ""),
    ("Schlankheit", "IfcRatioMeasure", ""),
    ("DickeTragend", "IfcLengthMeasure", "m"),
    ("Herkunft", "IfcText", ""),
]


def eigenschaften(konto: dict) -> dict:
    """Ein Bauteilkonto auf die Property-Namen abbilden."""
    bem = konto.get("bemessung") or {}
    nachweis = konto.get("nachweis") or {}
    geo = konto.get("geometrie") or {}

    # Die aussagekräftige Ausnutzung hängt am Nachweisverfahren: bei der
    # bemessenen Stütze ist M_Ed/M_Rd konstruktionsbedingt 1,0, und die
    # Rangfolge steckt im Bewehrungsgrad. Siehe `stuetze.nachweis`.
    ausnutzung = nachweis.get("ausnutzung")
    if nachweis.get("bemessen"):
        ausnutzung = nachweis.get("ausnutzung_querschnitt", ausnutzung)

    herkunft = ", ".join(sorted({
        f"{p.get('quelle_name') or p.get('quelle')}"
        for p in konto.get("eingang", []) if p.get("quelle_art", "").startswith("decke")
    })) or "—"

    werte = {
        "Geschoss": konto.get("geschoss") or "",
        "Rolle": konto.get("rolle") or "",
        "Ausnutzung": ausnutzung,
        "NachweisErfuellt": nachweis.get("erfuellt"),
        "Nachweisverfahren": nachweis.get("verfahren") or nachweis.get("art") or "",
    }

    # **Eine Decke bekommt keine Normalkraftfelder.** Sie trägt Biegung; ihre
    # Vertikallast ist per Definition null, weil sie ihre Last an die Auflager
    # abgibt statt sie weiterzuleiten. Ein `NEd = 0,0` am Deckenbauteil sähe
    # aber aus wie „unbelastet" und wäre die irreführendste Zahl der ganzen
    # Datei — gerade weil sie technisch stimmt.
    if konto.get("rolle") == "decke":
        werte.update({
            "Flaeche": geo.get("flaeche_m2"),
            "Dicke": geo.get("dicke_m"),
            "DickeQuelle": geo.get("dicke_quelle") or "",
            "Durchbiegung": nachweis.get("durchbiegung_mm"),
            "DurchbiegungGrenzwert": nachweis.get("durchbiegung_grenzwert_mm"),
            "NachweiseOffen": ", ".join(nachweis.get("offen") or []),
            "Herkunft": "FE-Rechnung dieser Platte",
        })
    else:
        werte.update({
            "NEd": bem.get("N_Ed_kN"),
            "NEdJeMeter": konto.get("N_Ed_je_m_kNm"),
            "NCharakteristisch": bem.get("N_k_kN"),
            "AnteilStaendig": bem.get("staendig_kN"),
            "AnteilVeraenderlich": bem.get("veraenderlich_kN"),
            "EigengewichtBauteil": konto.get("eigengewicht_kN"),
            "Schlankheit": nachweis.get("lambda"),
            "DickeTragend": geo.get("dicke_tragend_m"),
            "Herkunft": herkunft,
        })

    return {k: v for k, v in werte.items() if v is not None and v != ""}


def anreichern(quelle: Path, ziel: Path, konten: list[dict],
               titel: str = "iLEEN Lastabtrag") -> dict:
    """
    Die Quelldatei um die Lastabtragsergebnisse ergänzen und als `ziel` schreiben.

    @param konten  die Bauteilkonten, wie `kette.rechne_kette()` sie liefert
    @returns Protokoll: geschrieben, nicht gefunden, Dateigröße
    """
    import ifcopenshell
    import ifcopenshell.guid

    datei = ifcopenshell.open(str(quelle))
    einheit = _einheitenfaktor(datei)

    # Mehrere Konten je Bauteil sind der Regelfall bei durchlaufenden Wänden.
    # Jedes bekommt ein eigenes Property-Set, unterschieden durch das Geschoss
    # im Namen — ein zweites Pset gleichen Namens am selben Bauteil wäre nach
    # IFC unzulässig und würde von Viewern beliebig aufgelöst.
    je_bauteil: dict[str, list[dict]] = {}
    for konto in konten:
        gid = konto.get("global_id")
        if gid:
            je_bauteil.setdefault(gid, []).append(konto)

    geschrieben = 0
    ohne_bauteil: list[str] = []
    besitzer = _besitzer(datei)

    for gid, liste in je_bauteil.items():
        try:
            bauteil = datei.by_guid(gid)
        except RuntimeError:
            ohne_bauteil.append(gid)
            continue

        for konto in liste:
            werte = eigenschaften(konto)
            if not werte:
                continue
            name = PSET_NAME
            if len(liste) > 1 and konto.get("geschoss"):
                name = f"{PSET_NAME}_{konto['geschoss']}"

            eigenschaftsliste = []
            for feldname, typ, _ in FELDER:
                if feldname not in werte:
                    continue
                eigenschaftsliste.append(datei.create_entity(
                    "IfcPropertySingleValue",
                    Name=feldname,
                    NominalValue=datei.create_entity(typ, _wert(werte[feldname], typ)),
                ))
            if not eigenschaftsliste:
                continue

            pset = datei.create_entity(
                "IfcPropertySet",
                GlobalId=ifcopenshell.guid.new(),
                OwnerHistory=besitzer,
                Name=name,
                Description="Vorbemessung iLEEN — kein Standsicherheitsnachweis",
                HasProperties=eigenschaftsliste,
            )
            datei.create_entity(
                "IfcRelDefinesByProperties",
                GlobalId=ifcopenshell.guid.new(),
                OwnerHistory=besitzer,
                Name=name,
                RelatedObjects=[bauteil],
                RelatingPropertyDefinition=pset,
            )
            geschrieben += 1

    _kopfzeile(datei, titel, geschrieben)
    ziel.parent.mkdir(parents=True, exist_ok=True)
    datei.write(str(ziel))

    protokoll = {
        "datei": str(ziel),
        "bytes": ziel.stat().st_size if ziel.exists() else 0,
        "psets_geschrieben": geschrieben,
        "bauteile_angereichert": len(je_bauteil) - len(ohne_bauteil),
        "nicht_gefunden": ohne_bauteil,
        "einheitenfaktor": einheit,
    }
    logger.info("IFC-Export: %s Property-Sets an %s Bauteilen → %s",
                geschrieben, protokoll["bauteile_angereichert"], ziel)
    return protokoll


def _wert(wert, typ: str):
    """Python-Wert in die Form bringen, die der IFC-Typ verlangt."""
    if typ == "IfcBoolean":
        return bool(wert)
    if typ in ("IfcLabel", "IfcText"):
        return str(wert)
    try:
        return float(wert)
    except (TypeError, ValueError):
        return 0.0


def _besitzer(datei):
    """
    Eine vorhandene `IfcOwnerHistory` wiederverwenden.

    Eine neue anzulegen hieße, Person, Organisation und Anwendung zu erfinden;
    die vorhandene ist inhaltlich richtiger — die Datei stammt ja von dort. In
    IFC4 ist `OwnerHistory` an `IfcRoot` ohnehin optional, deshalb ist `None`
    kein Fehler, sondern der zulässige Fall für Dateien, die keine führen.
    """
    vorhanden = datei.by_type("IfcOwnerHistory")
    return vorhanden[0] if vorhanden else None


def _einheitenfaktor(datei) -> float:
    """Längeneinheit der Datei in Metern — nur zur Protokollierung."""
    try:
        for kontext in datei.by_type("IfcUnitAssignment"):
            for einheit in kontext.Units:
                if getattr(einheit, "UnitType", None) == "LENGTHUNIT":
                    praefix = getattr(einheit, "Prefix", None)
                    return {"MILLI": 0.001, "CENTI": 0.01, "DECI": 0.1}.get(praefix, 1.0)
    except Exception:  # noqa: BLE001
        pass
    return 1.0


def _kopfzeile(datei, titel: str, anzahl: int) -> None:
    """
    Den Dateikopf um einen Hinweis auf die Herkunft ergänzen.

    Wer diese Datei später in die Hand bekommt, soll ohne Rückfrage erkennen,
    dass die Statikwerte darin aus einer automatischen Vorbemessung stammen und
    kein Nachweis sind. Der `description`-Eintrag im `FILE_DESCRIPTION` ist die
    Stelle, die jedes Werkzeug anzeigt.
    """
    # `datei.header` und nicht `datei.wrapped_data.header`: Letzteres ist in
    # ifcopenshell 0.8 eine Methode, und der zurückgegebene `IfcSpfHeader`
    # kennt `file_description` gar nicht — der Zugriff scheiterte still, und
    # der Hinweis fehlte in genau den Dateien, die ihn brauchen.
    stempel = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    hinweis = (f"{titel} — {anzahl} Property-Sets aus automatischer "
               f"Vorbemessung (iLEEN, {stempel}). Kein Standsicherheitsnachweis.")
    try:
        beschreibung = datei.header.file_description
        vorhanden = [t for t in (beschreibung.description or []) if "iLEEN" not in t]
        beschreibung.description = tuple(vorhanden + [hinweis])
    except Exception as fehler:  # noqa: BLE001 — der Export ist wichtiger als sein Kopf
        logger.warning("IFC-Kopfzeile nicht ergänzbar (%s)", fehler)
