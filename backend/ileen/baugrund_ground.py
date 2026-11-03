"""
Baugrundmodell aus GGU-CONNECT (.GROUND) lesen.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Eine .GROUND-Datei ist ein ZIP mit einer Steuerdatei (``fachmodell_baugrund.xml``)
und CSV-Tabellen, je Tabelle drei Kopfzeilen::

    "BOREHOLE";"1"                         Tabellenart, Version
    "BASE_ID";"BASE_NAME";…                Spaltennamen
    "guid";"ustring";…                     Datentypen

Gelesen wird, was das Baugrundmodell in iLEEN braucht:

* **Aufschlüsse** (BOREHOLE) mit Ansatzpunkt im Lagesystem der Datei (EPSG,
  meist 25832) und Ansatzhöhe in m NHN, Datum, Endteufe, Art (KRB, BK, …)
* **Schichten** je Aufschluss (BOREHOLELAYER): von/bis, Petrographie als
  Kurzzeichen (``Mu``, ``U``, ``^fe``), Stratigraphie, Genese
* **Gliederungen** (GroundModel): jede ist eine Einteilung in Modellschichten
  — das Baugrundschichtenmodell ebenso wie die Homogenbereiche der
  Erdarbeiten. Die Zuordnung Schicht → Modellschicht steht in GROUNDLAYER
  (``GROUNDLAYER_BOREHOLELAYERS``, eine Folge von GUIDs ohne Trenner)
* **Kennwerte** je Modellschicht (PROPERTYVALUE, ``(min,wert,max)``) samt
  Einheit aus der Definitionstabelle — so, wie sie dastehen, nicht umgerechnet
* **Grundwasser** je Aufschluss und **Schnitte** (Folge von Aufschlüssen)

Das DGM der Datei steht nicht im ZIP (``<DTM source=…>`` zeigt auf eine
LandXML-Datei daneben); die Oberkante nimmt der Viewer aus seinem Gelände.

Rein, ohne Server: ``ground_lesen(zip_bytes) → dict``.
"""

from __future__ import annotations

import csv
import io
import re
import xml.etree.ElementTree as ET
import zipfile

GUID = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")

#: Kennwerte, die das Modell selbst benutzt (Erdbau, Anzeige) — nach dem Namen
#: in der Datei. Alles Übrige bleibt unter seinem Namen erhalten.
KENNWERTE = [
    (re.compile(r"wichte.*auftrieb", re.I), "gamma_a"),
    (re.compile(r"wichte", re.I), "gamma"),
    (re.compile(r"reibungswinkel", re.I), "phi"),
    (re.compile(r"undrän|undrain", re.I), "cu"),
    (re.compile(r"kohäsion|kohaesion", re.I), "c"),
    (re.compile(r"steifemodul", re.I), "Es"),
    (re.compile(r"durchlässig|durchlaessig", re.I), "kf"),
    (re.compile(r"spitzenwiderstand|cpt", re.I), "qc"),
]


class GroundFehler(ValueError):
    pass


def _tabelle(zf: zipfile.ZipFile, name: str | None) -> list[dict]:
    """Eine CSV-Tabelle als Liste von Zeilen (dict); fehlt sie, leer."""
    if not name:
        return []
    treffer = [n for n in zf.namelist() if n.lower() == name.lower()]
    if not treffer:
        return []
    roh = zf.read(treffer[0])
    for kodierung in ("utf-8-sig", "cp1252"):
        try:
            text = roh.decode(kodierung)
            break
        except UnicodeDecodeError:
            continue
    zeilen = list(csv.reader(io.StringIO(text), delimiter=";", quotechar='"'))
    if len(zeilen) < 3:
        return []
    kopf = zeilen[1]
    return [dict(zip(kopf, z)) for z in zeilen[3:] if any(f.strip() for f in z)]


def _zahl(text, vorgabe=None):
    if text is None:
        return vorgabe
    t = str(text).strip().replace(",", ".")
    if not t:
        return vorgabe
    try:
        return float(t)
    except ValueError:
        return vorgabe


def _farbe(farben: dict, ref: str | None) -> str | None:
    f = farben.get((ref or "").strip())
    if not f:
        return None
    return "#{:02x}{:02x}{:02x}".format(*f)


def _wertebereich(text: str):
    """``(30,30,32.5)`` → {min, wert, max}; ein einzelner Wert → {wert}."""
    zahlen = [float(z) for z in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", text or "")]
    if not zahlen:
        return None
    if len(zahlen) >= 3:
        return {"min": zahlen[0], "wert": zahlen[1], "max": zahlen[2]}
    if len(zahlen) == 2:
        return {"min": zahlen[0], "wert": (zahlen[0] + zahlen[1]) / 2, "max": zahlen[1]}
    return {"wert": zahlen[0]}


def _wasserart(name: str) -> str:
    n = (name or "").lower()
    if "ruhe" in n:
        return "ruhe"
    if "bohrende" in n or "endteufe" in n:
        return "bohrende"
    return "angetroffen"


def ground_lesen(daten: bytes, utm_nach_grad=None) -> dict:
    """
    Liest eine .GROUND-Datei und gibt das Baugrundmodell im iLEEN-Format zurück.

    ``utm_nach_grad(ost, nord, epsg) → (lon, lat)``; ohne Angabe über pyproj.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(daten))
    except zipfile.BadZipFile as e:
        raise GroundFehler("Keine .GROUND-Datei (kein ZIP)") from e

    steuer = [n for n in zf.namelist() if n.lower().endswith(".xml")]
    if not steuer:
        raise GroundFehler("Die Datei enthält keine Steuerdatei (fachmodell_baugrund.xml)")
    wurzel = ET.fromstring(zf.read(steuer[0]))

    def attr(pfad, name):
        el = wurzel.find(pfad)
        return el.get(name) if el is not None else None

    projekt = attr("Description/Project", "name") or "Baugrundmodell"
    epsg = int(attr("Settings/CoordinateReferenceSystem", "epsg") or 25832)
    ursprung = [_zahl(x, 0.0) for x in (attr("Settings/CoordinateReferenceSystem", "projectOrigin") or "0,0,0").split(",")]
    farben = {}
    for z in _tabelle(zf, attr("Settings", "colors")):
        farben[z.get("BASE_ID", "").strip()] = (int(_zahl(z.get("COLOR_RED"), 128)), int(_zahl(z.get("COLOR_GREEN"), 128)),
                                                 int(_zahl(z.get("COLOR_BLUE"), 128)))
    definitionen = {z.get("BASE_ID", "").strip(): z for z in _tabelle(zf, attr("Settings", "soilpropertyDefinitions"))}

    if utm_nach_grad is None:
        from pyproj import Transformer
        trans = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)

        def utm_nach_grad(ost, nord, _epsg):
            return trans.transform(ost, nord)

    # ── Aufschlüsse
    bohrungen = _tabelle(zf, attr("Boreholes", "definition"))
    if not bohrungen:
        raise GroundFehler("Die Datei enthält keine Aufschlüsse (BOREHOLE)")
    aufschluesse = {}
    reihe = []
    for b in bohrungen:
        bid = b.get("BASE_ID", "").strip()
        ost, nord = _zahl(b.get("POINTOBJECT_SITE_X"), 0.0), _zahl(b.get("POINTOBJECT_SITE_Y"), 0.0)
        # Lokale Koordinaten (klein) hängen am Projektursprung
        if abs(ost) < 100000 and abs(nord) < 100000:
            ost += ursprung[0]
            nord += ursprung[1]
        lon, lat = utm_nach_grad(ost, nord, epsg)
        a = {
            "id": "a-" + bid.lower()[:8], "guid": bid, "name": b.get("BASE_NAME", "").strip() or bid[:8],
            "art": (b.get("BOREHOLE_TYPE") or "").strip() or "BS",
            "lon": lon, "lat": lat, "z": _zahl(b.get("POINTOBJECT_HEIGHT_Z")), "zQuelle": "import",
            "utm": {"epsg": epsg, "ost": ost, "nord": nord},
            "datum": (b.get("BOREHOLE_DATE") or "").strip() or None,
            "endteufe": _zahl(b.get("BOREHOLE_DEPTH")),
            "bemerkung": (b.get("BASE_INFO") or "").strip() or None,
            "schichten": [], "wasser": [], "bilder": [],
        }
        aufschluesse[bid] = a
        reihe.append(a)

    schicht_nach_guid = {}
    for s in _tabelle(zf, attr("Boreholes", "layers")):
        a = aufschluesse.get((s.get("BOREHOLELAYER_BOREHOLE") or "").strip())
        if not a:
            continue
        sid = s.get("BASE_ID", "").strip()
        text = ", ".join(t for t in ((s.get("BOREHOLELAYER_STRATIGRAPHY") or "").strip(),
                                     (s.get("BOREHOLELAYER_GENESIS") or "").strip(),
                                     (s.get("BOREHOLELAYER_EXPLORATIONCOLOR") or "").strip()) if t)
        schicht = {
            "id": "s-" + sid.lower()[:8], "von": _zahl(s.get("BOREHOLELAYER_DEPTHFROM"), 0.0),
            "bis": _zahl(s.get("BOREHOLELAYER_DEPTHTO"), 0.0),
            "kurz": (s.get("BOREHOLELAYER_PETROGRAPHY") or "").strip(), "text": text,
            "farbe": _farbe(farben, s.get("BOREHOLELAYER_REPRESENTATIONCOLOR")),
            "zuordnung": {},
        }
        a["schichten"].append(schicht)
        schicht_nach_guid[sid] = schicht
    for a in reihe:
        a["schichten"].sort(key=lambda s: (s["von"], s["bis"]))

    # ── Grundwasser
    gw_arten = {z.get("BASE_ID", "").strip(): z.get("BASE_NAME", "") for z in _tabelle(zf, attr("GroundWater", "definition"))}
    for w in _tabelle(zf, attr("GroundWater", "levels")):
        a = aufschluesse.get((w.get("GROUNDWATERLEVEL_BOREHOLE") or "").strip())
        tiefe = _zahl(w.get("GROUNDWATERLEVEL_DEPTH"))
        if a is None or tiefe is None:
            continue
        art_name = gw_arten.get((w.get("GROUNDWATERLEVEL_TYPE") or "").strip(), "")
        a["wasser"].append({"tiefe": tiefe, "art": _wasserart(art_name), "bezeichnung": art_name or None,
                            "datum": (w.get("GROUNDWATERLEVEL_DATE") or "").strip() or None})

    # ── Gliederungen (GroundModel)
    gliederungen = []
    for gm in wurzel.findall("GroundModel"):
        gid = "g-" + (gm.get("id") or gm.get("name") or str(len(gliederungen))).lower()[:8]
        name = re.sub(r"-[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}$", "", gm.get("name") or "Gliederung")
        typen = {}
        schichten = []
        for t in _tabelle(zf, gm.get("definition")):
            tid = t.get("BASE_ID", "").strip()
            roh = (t.get("BASE_NAME") or "").strip()
            # „1 - Auffüllung", „Erd2 - Erd2 - Auffüllung + Schluff" → Kürzel und Name
            teile = [x.strip() for x in roh.split(" - ") if x.strip()]
            kuerzel = teile[0] if len(teile) > 1 else None
            ms = {"id": "ms-" + tid.lower()[:8], "guid": tid, "name": teile[-1] if teile else roh, "kuerzel": kuerzel,
                  "farbe": _farbe(farben, t.get("GROUNDTYPE_REPRESENTATIONCOLOR")) or "#9aa0a6",
                  "boden": None, "kennwerte": {}, "sichtbar": True, "quelle": "import"}
            typen[tid] = ms
            schichten.append(ms)
        for p in _tabelle(zf, gm.get("parameters")):
            ms = typen.get((p.get("PROPERTYVALUE_OBJECT") or "").strip())
            if ms is None:
                continue
            bereich = _wertebereich(p.get("PROPERTYVALUE_VALUE"))
            if bereich is None:
                continue
            definition = definitionen.get((p.get("PROPERTYVALUE_PROPERTYDEFINITION") or "").strip(), {})
            name_k = (p.get("BASE_NAME") or definition.get("BASE_NAME") or "").strip()
            schluessel = next((k for muster, k in KENNWERTE if muster.search(name_k)), name_k)
            bereich["name"] = name_k
            bereich["einheit"] = (definition.get("PROPERTYDEFINITION_UNIT") or "").strip().strip("[]").strip() or None
            bereich["norm"] = (definition.get("PROPERTYDEFINITION_GUIDELINESINFO") or "").strip() or None
            ms["kennwerte"][schluessel] = bereich
        for gl in _tabelle(zf, gm.get("layers")):
            ms = typen.get((gl.get("GROUNDLAYER_TYPE") or "").strip())
            if ms is None:
                continue
            for g in GUID.findall(gl.get("GROUNDLAYER_BOREHOLELAYERS") or ""):
                s = schicht_nach_guid.get(g.upper()) or schicht_nach_guid.get(g)
                if s is not None:
                    s["zuordnung"][gid] = ms["id"]
        gliederungen.append({"id": gid, "name": name, "schichten": schichten})

    # ── Schnitte
    schnitte = []
    for sn in _tabelle(zf, attr("Sections", "definition")):
        ids = [aufschluesse[g]["id"] for g in GUID.findall(sn.get("GROUNDSECTION_BOREHOLES") or "") if g in aufschluesse]
        if len(ids) >= 2:
            schnitte.append({"name": (sn.get("BASE_Name") or sn.get("BASE_NAME") or "Schnitt").strip(), "ids": ids})

    aktiv = gliederungen[0]["id"] if gliederungen else None
    for a in reihe:
        for s in a["schichten"]:
            if aktiv and aktiv in s["zuordnung"]:
                s["schicht"] = s["zuordnung"][aktiv]
                s["schichtFest"] = True

    return {
        "format": "ileen-baugrund", "version": 1, "name": projekt,
        "quelle": {"format": "GGU-CONNECT .GROUND", "anwendung": attr("Description/Application", "name"),
                   "version": attr("Description/Application", "version"), "datum": attr("Description/Creator", "date"),
                   "epsg": epsg, "dgm": attr("DTM", "source")},
        "aufschluesse": reihe,
        "gliederungen": gliederungen,
        "aktiv": aktiv,
        "schichten": gliederungen[0]["schichten"] if gliederungen else [],
        "schnitte": schnitte,
        "einstellungen": {"rand": _zahl(attr("DTM", "margin"), 10.0) or 10.0},
    }
