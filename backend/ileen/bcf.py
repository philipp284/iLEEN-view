"""
BCF 2.1 lesen und schreiben — ohne Server, ohne Datenbank.

Ein BCF-Paket ist ein ZIP mit einer `bcf.version` und je Thema einem Ordner,
benannt nach dessen GUID:

    bcf.version
    <Thema-GUID>/markup.bcf        Thema, Kommentare, Verweise auf Ansichten
    <Thema-GUID>/viewpoint.bcfv    Kamera und betroffene Bauteile (IfcGuid)
    <Thema-GUID>/snapshot.png      Bild der Szene

Warum das hier und nicht im Frontend
====================================
`frontend/bcf-export.js` schreibt seit jeher Pakete aus dem, was gerade im
Browser liegt. Das bleibt der schnelle Weg für „einmal rausgeben". Sobald
Themen aber **verwaltet** werden — mit Verlauf, Kommentaren, mehreren
Bearbeitenden, Import fremder Pakete — muss dieselbe Umwandlung auch dort
laufen, wo die Daten liegen: im Backend. Zwei Wege, die dasselbe Format
schreiben, sind zwei Gelegenheiten, sich zu unterscheiden; deshalb ist dieser
hier der maßgebliche, und er kann als einziger auch **lesen**.

Das Zwischenformat
==================
Zwischen Datenbank und ZIP steht ein schlichtes dict, das „Thema" heißt und
bewusst nah an BCF bleibt:

    {
      "guid": str,                  # Thema-GUID
      "titel": str,
      "beschreibung": str,
      "typ": "Issue" | "Info" | ...,
      "status": "Open" | "InProgress" | "Closed" | "ReOpened",
      "prioritaet": "Low" | "Normal" | "High",
      "autor": str, "erstellt": iso8601, "geaendert": iso8601,
      "zugewiesen": str | None, "faellig": iso8601 | None,
      "marken": [str],              # BCF <Labels>
      "kommentare": [{guid, zeit, autor, text, ansicht_guid}],
      "ansichten": [{guid, kamera, komponenten, bild (bytes), bild_typ}],
    }

`kamera` ist `{"art": "perspektiv"|"ortho", "position": {x,y,z},
"richtung": {x,y,z}, "oben": {x,y,z}, "sichtfeld": float, "hoehe": float}`,
`komponenten` eine Liste `{"ifc_guid": str, "modell": str|None,
"ausgewaehlt": bool, "sichtbar": bool}`.

Koordinaten
===========
BCF-Kameras stehen im **Projektsystem** der BIM-Software, nicht in ECEF. Wer
hier eine Kamera hineingibt, hat sie bereits umgerechnet (das tut der Viewer
in `bcf-export.js` über `root.computedTransform` des ersten Modells). Dieses
Modul rechnet nichts um — es schreibt und liest nur, was ihm gegeben wird.
Eine stillschweigende Umrechnung an dieser Stelle wäre der sicherste Weg, aus
einem Paket, das in Solibri passt, eines zu machen, das um den Erdradius
daneben liegt.
"""

from __future__ import annotations

import io
import re
import uuid
import zipfile
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

# ── Feste Werte des Formats ──────────────────────────────────────────────────

TYPEN = ("Issue", "Info", "Error", "Warning", "Request", "Clash", "Comment",
         "Inspection", "Fault", "Remark")
STATUS = ("Open", "InProgress", "Closed", "ReOpened")
PRIORITAETEN = ("Low", "Normal", "High", "Critical")

_GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                   r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def neue_guid() -> str:
    return str(uuid.uuid4())


def ist_guid(wert: str | None) -> bool:
    return bool(wert and _GUID.match(str(wert)))


def jetzt() -> str:
    """Zeitstempel, wie BCF ihn will: ISO 8601 mit Zone."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _zeit(wert) -> str:
    if not wert:
        return jetzt()
    text = str(wert)
    # Ein „Z" am Ende ist gültig, `fromisoformat` kennt es erst ab 3.11 —
    # und ein Zeitstempel ohne Zone lässt BCF-Leser raten.
    try:
        d = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return jetzt()
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.isoformat(timespec="seconds").replace("+00:00", "Z")


def in_liste(wert, erlaubt, standard):
    if not wert:
        return standard
    for e in erlaubt:
        if str(wert).lower() == e.lower():
            return e
    return standard


# ── Schreiben ────────────────────────────────────────────────────────────────

def _el(eltern, name, text=None, **attr):
    k = ET.SubElement(eltern, name, {a: str(v) for a, v in attr.items() if v is not None})
    if text is not None:
        k.text = str(text)
    return k


def _xml(wurzel: ET.Element) -> bytes:
    # `xml_declaration` erst ab 3.8 in `tostring` — und BCF-Leser sind heikel,
    # wenn sie fehlt.
    return ET.tostring(wurzel, encoding="utf-8", xml_declaration=True)


def markup_xml(thema: dict) -> bytes:
    """Das `markup.bcf` eines Themas: Kopf, Marken, Kommentare, Ansichten."""
    wurzel = ET.Element("Markup")
    t = _el(wurzel, "Topic",
            Guid=thema.get("guid") or neue_guid(),
            TopicType=in_liste(thema.get("typ"), TYPEN, "Issue"),
            TopicStatus=in_liste(thema.get("status"), STATUS, "Open"))
    _el(t, "Title", thema.get("titel") or "(ohne Titel)")
    _el(t, "Priority", in_liste(thema.get("prioritaet"), PRIORITAETEN, "Normal"))
    _el(t, "CreationDate", _zeit(thema.get("erstellt")))
    _el(t, "CreationAuthor", thema.get("autor") or "iLEEN")
    if thema.get("geaendert"):
        _el(t, "ModifiedDate", _zeit(thema["geaendert"]))
        _el(t, "ModifiedAuthor", thema.get("bearbeiter") or thema.get("autor") or "iLEEN")
    if thema.get("zugewiesen"):
        _el(t, "AssignedTo", thema["zugewiesen"])
    if thema.get("faellig"):
        _el(t, "DueDate", _zeit(thema["faellig"]))
    for marke in thema.get("marken") or []:
        _el(t, "Labels", marke)
    if thema.get("beschreibung"):
        _el(t, "Description", thema["beschreibung"])

    for k in thema.get("kommentare") or []:
        c = _el(wurzel, "Comment", Guid=k.get("guid") or neue_guid())
        _el(c, "Date", _zeit(k.get("zeit")))
        _el(c, "Author", k.get("autor") or "iLEEN")
        _el(c, "Comment", k.get("text") or "")
        if k.get("ansicht_guid"):
            _el(c, "Viewpoint", None, Guid=k["ansicht_guid"])

    for a in thema.get("ansichten") or []:
        v = _el(wurzel, "Viewpoints", Guid=a.get("guid") or neue_guid())
        _el(v, "Viewpoint", _bcfv_name(a))
        if a.get("bild"):
            _el(v, "Snapshot", _bild_name(a))

    return _xml(wurzel)


def _bcfv_name(ansicht: dict) -> str:
    return f"viewpoint_{ansicht.get('guid', 'x')[:8]}.bcfv"


def _bild_name(ansicht: dict) -> str:
    endung = "jpg" if (ansicht.get("bild_typ") or "").endswith("jpeg") else "png"
    return f"snapshot_{ansicht.get('guid', 'x')[:8]}.{endung}"


def _vektor(eltern, name, v):
    if not v:
        return
    k = ET.SubElement(eltern, name)
    for achse, schluessel in (("X", "x"), ("Y", "y"), ("Z", "z")):
        _el(k, achse, f"{float(v.get(schluessel, 0.0)):.6f}")


def viewpoint_xml(ansicht: dict) -> bytes:
    """Das `viewpoint.bcfv`: Bauteilauswahl und Kamera."""
    wurzel = ET.Element("VisualizationInfo", Guid=ansicht.get("guid") or neue_guid())

    komponenten = ansicht.get("komponenten") or []
    if komponenten:
        c = _el(wurzel, "Components")
        auswahl = [k for k in komponenten if k.get("ausgewaehlt", True)]
        if auswahl:
            sel = _el(c, "Selection")
            for k in auswahl:
                comp = _el(sel, "Component", IfcGuid=k.get("ifc_guid"))
                if k.get("modell"):
                    _el(comp, "OriginatingSystem", k["modell"])
        _el(c, "Visibility", None, DefaultVisibility="true")

    kamera = ansicht.get("kamera") or {}
    if kamera.get("position"):
        art = "OrthogonalCamera" if kamera.get("art") == "ortho" else "PerspectiveCamera"
        k = _el(wurzel, art)
        _vektor(k, "CameraViewPoint", kamera.get("position"))
        _vektor(k, "CameraDirection", kamera.get("richtung"))
        _vektor(k, "CameraUpVector", kamera.get("oben"))
        if art == "PerspectiveCamera":
            _el(k, "FieldOfView", f"{max(1.0, min(179.0, float(kamera.get('sichtfeld') or 60))):.1f}")
        else:
            _el(k, "ViewToWorldScale", f"{float(kamera.get('hoehe') or 10):.6f}")

    return _xml(wurzel)


def paket_schreiben(themen: list[dict]) -> bytes:
    """Themen → fertiges `.bcfzip` als Bytes."""
    puffer = io.BytesIO()
    with zipfile.ZipFile(puffer, "w", zipfile.ZIP_DEFLATED) as zip_datei:
        version = ET.Element("Version", VersionId="2.1")
        _el(version, "DetailedVersion", "2.1")
        zip_datei.writestr("bcf.version", _xml(version))

        for thema in themen:
            guid = thema.get("guid") or neue_guid()
            zip_datei.writestr(f"{guid}/markup.bcf", markup_xml({**thema, "guid": guid}))
            for a in thema.get("ansichten") or []:
                zip_datei.writestr(f"{guid}/{_bcfv_name(a)}", viewpoint_xml(a))
                if a.get("bild"):
                    zip_datei.writestr(f"{guid}/{_bild_name(a)}", a["bild"])
    return puffer.getvalue()


# ── Lesen ────────────────────────────────────────────────────────────────────

def _text(knoten, pfad, standard=None):
    if knoten is None:
        return standard
    k = knoten.find(pfad)
    return k.text.strip() if (k is not None and k.text) else standard


def _punkt(knoten, pfad):
    k = knoten.find(pfad) if knoten is not None else None
    if k is None:
        return None
    def z(name):
        v = _text(k, name)
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0
    return {"x": z("X"), "y": z("Y"), "z": z("Z")}


def viewpoint_lesen(daten: bytes, guid: str | None = None) -> dict:
    """Ein `.bcfv` → Ansicht im Zwischenformat."""
    wurzel = ET.fromstring(daten)
    ansicht = {"guid": wurzel.get("Guid") or guid or neue_guid(),
               "kamera": None, "komponenten": []}

    for comp in wurzel.findall(".//Components/Selection/Component"):
        ifc_guid = comp.get("IfcGuid")
        if ifc_guid:
            ansicht["komponenten"].append({
                "ifc_guid": ifc_guid,
                "modell": _text(comp, "OriginatingSystem"),
                "ausgewaehlt": True,
                "sichtbar": True,
            })

    for art, name in (("perspektiv", "PerspectiveCamera"), ("ortho", "OrthogonalCamera")):
        k = wurzel.find(name)
        if k is None:
            continue
        kamera = {
            "art": art,
            "position": _punkt(k, "CameraViewPoint"),
            "richtung": _punkt(k, "CameraDirection"),
            "oben": _punkt(k, "CameraUpVector"),
        }
        try:
            kamera["sichtfeld"] = float(_text(k, "FieldOfView") or 60.0)
        except ValueError:
            kamera["sichtfeld"] = 60.0
        try:
            kamera["hoehe"] = float(_text(k, "ViewToWorldScale") or 0.0)
        except ValueError:
            kamera["hoehe"] = 0.0
        ansicht["kamera"] = kamera
        break

    return ansicht


def markup_lesen(daten: bytes) -> dict:
    """Ein `markup.bcf` → Thema ohne Ansichtsdateien (die kommen aus dem ZIP)."""
    wurzel = ET.fromstring(daten)
    t = wurzel.find("Topic")
    if t is None:
        raise ValueError("markup.bcf ohne <Topic>")

    thema = {
        "guid": t.get("Guid") or neue_guid(),
        "typ": in_liste(t.get("TopicType"), TYPEN, "Issue"),
        "status": in_liste(t.get("TopicStatus"), STATUS, "Open"),
        "titel": _text(t, "Title", "(ohne Titel)"),
        "prioritaet": in_liste(_text(t, "Priority"), PRIORITAETEN, "Normal"),
        "erstellt": _zeit(_text(t, "CreationDate")),
        "autor": _text(t, "CreationAuthor", "unbekannt"),
        "geaendert": _text(t, "ModifiedDate"),
        "bearbeiter": _text(t, "ModifiedAuthor"),
        "zugewiesen": _text(t, "AssignedTo"),
        "faellig": _text(t, "DueDate"),
        "beschreibung": _text(t, "Description", ""),
        "marken": [m.text.strip() for m in t.findall("Labels") if m.text],
        "kommentare": [],
        "ansichten": [],
        # Welche Ansichtsdatei zu welcher GUID gehört, steht nur im Markup —
        # ohne diese Zuordnung wäre ein Kommentar später nicht mehr mit seiner
        # Ansicht zu verbinden.
        "_ansicht_dateien": [],
    }

    for c in wurzel.findall("Comment"):
        v = c.find("Viewpoint")
        thema["kommentare"].append({
            "guid": c.get("Guid") or neue_guid(),
            "zeit": _zeit(_text(c, "Date")),
            "autor": _text(c, "Author", "unbekannt"),
            "text": _text(c, "Comment", ""),
            "ansicht_guid": v.get("Guid") if v is not None else None,
        })

    for v in wurzel.findall("Viewpoints"):
        thema["_ansicht_dateien"].append({
            "guid": v.get("Guid") or neue_guid(),
            "datei": _text(v, "Viewpoint"),
            "bild": _text(v, "Snapshot"),
        })

    return thema


def paket_lesen(daten: bytes) -> list[dict]:
    """
    Ein `.bcfzip` → Themen im Zwischenformat.

    Fehlerhafte Themen werden **übersprungen, nicht geraten**: ein Paket aus
    fremder Software enthält gern einen Ordner ohne Markup oder ein `.bcfv`
    mit einem Namensraum, den niemand erwartet hat. Ein einzelnes kaputtes
    Thema darf den Import der übrigen hundert nicht verhindern.
    """
    themen = []
    with zipfile.ZipFile(io.BytesIO(daten)) as zip_datei:
        namen = zip_datei.namelist()
        markups = [n for n in namen if n.lower().endswith("markup.bcf")]

        for markup in markups:
            ordner = markup.rsplit("/", 1)[0] if "/" in markup else ""
            try:
                thema = markup_lesen(_ohne_namensraum(zip_datei.read(markup)))
            except Exception:
                continue

            for verweis in thema.pop("_ansicht_dateien", []):
                ansicht = {"guid": verweis["guid"], "kamera": None, "komponenten": []}
                pfad = f"{ordner}/{verweis['datei']}" if ordner and verweis.get("datei") else verweis.get("datei")
                if pfad and pfad in namen:
                    try:
                        ansicht = viewpoint_lesen(_ohne_namensraum(zip_datei.read(pfad)), verweis["guid"])
                    except Exception:
                        pass
                bildpfad = f"{ordner}/{verweis['bild']}" if ordner and verweis.get("bild") else verweis.get("bild")
                if bildpfad and bildpfad in namen:
                    ansicht["bild"] = zip_datei.read(bildpfad)
                    ansicht["bild_typ"] = "image/jpeg" if bildpfad.lower().endswith((".jpg", ".jpeg")) else "image/png"
                thema["ansichten"].append(ansicht)

            themen.append(thema)
    return themen


def _ohne_namensraum(daten: bytes) -> bytes:
    """
    BCF kennt keinen Namensraum, manche Werkzeuge schreiben trotzdem einen.

    `ElementTree` sucht dann nach `{…}Topic` statt `Topic`, und jedes `find()`
    in diesem Modul liefe ins Leere — beim Import aus Revit wäre schlicht
    nichts angekommen. Billiger als jeden Pfad mit Platzhaltern zu schreiben:
    die Deklaration einmal entfernen.
    """
    return re.sub(rb'\sxmlns(:\w+)?="[^"]*"', b"", daten, count=8)
