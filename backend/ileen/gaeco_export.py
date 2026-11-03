"""
iLEEN → gaeco: ein IFC-Modell als Instanzgraph in gaeco ablegen.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Der Weg
=======
gaecos InstanceService liest jedes Topic nach dem Muster
`^.*\\..*\\..*\\.public\\..*\\.gaecoImport$` (GraphDataModelConsumer). Eine
Nachricht ist **ein** GraphDataModel — Knoten in `GraphMetadata`, Kanten als
Turtle in `GraphData`. Über REST ginge das nicht: dort vergibt der Dienst die
Kennung selbst, und freie Attribute verwirft er (am Stack geprüft, siehe
GAECO-INTEGRATION.md, Abschnitt 3).

Über Kafka wird die vorgegebene `Id` übernommen. Damit ist die Zuordnung rein
rechnerisch und braucht keine Tabelle:

    Id = uuid5(NAMESPACE_DNS, IFC-GlobalId)

Dieselbe Rechnung steht im gaeco-Modul (`gaeco/modul/assets/kennung.js`) —
wer eine Seite ändert, ändert beide.

Was übertragen wird
===================
Knoten: Projekt, Grundstück, Gebäude, Geschosse, Räume und jedes Bauteil
(`IfcElement`) außer Aussparungen, virtuellen Elementen, Anmerkungen und
Rastern. Kanten aus gaecos IFC-Relationsontologie
(`demodata/IFC/ifc4x3-gaeco-relations.ttl`):

    aggregates        IfcRelAggregates zwischen räumlichen Elementen
    containsElement   IfcRelContainedInSpatialStructure
    hasFillingElement Wand → Tür/Fenster (über IfcRelVoids/IfcRelFills)

Eigenschaften: die Attribute (Name, Description, ObjectType, Tag, LongName,
GlobalId) und die Property-Sets. gaecos IFC-Guideline führt Properties unter
**Klarnamen** — „Is External", „Load Bearing" — und flach, ohne den Namen des
Property-Sets; die Kennung dahinter endet auf `IsExternal`. Der
`GuidelineIndex` bildet das eine aufs andere ab. Was die Guideline nicht kennt,
würde gaeco ohnehin verwerfen; es geht deshalb gar nicht erst hinaus.

Ohne Index (die Guideline-Datei liegt nicht vor) gehen nur die sechs
Attribute mit, deren Klarnamen fest sind — das Modell ist dann im Graphen,
aber ohne Property-Sets.

Klassen: `…/ifc/4.3/class/<IfcTyp>`. Kennt die Guideline einen Typ nicht —
etwa `IfcWallStandardCase` aus IFC2x3 —, gilt der nächste Obertyp aus dem
IFC-Schema, den sie kennt.

Was offen ist
=============
Zerfällt ein Modell in mehrere Nachrichten (über `NACHRICHT_MAX`), stehen
Kanten zu Knoten aus einer früheren Nachricht. Dass gaeco sie dann der
vorhandenen Instanz zuordnet, ist **nicht am Stack geprüft** — eine Nachricht
reicht für alle Modelle der Werkstatt bis auf das Campusmodell. Der Stand
meldet die Zahl der Nachrichten mit, damit es auffällt.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

NAMENSRAUM = uuid.NAMESPACE_DNS
IFC_KLASSEN = "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/"
GAECO_ONTOLOGIE = "https://gaeco.ekkodale.com/ontology/"
AGGREGIERT = GAECO_ONTOLOGIE + "aggregates"
ENTHAELT = GAECO_ONTOLOGIE + "containsElement"
FUELLT = GAECO_ONTOLOGIE + "hasFillingElement"
INSTANZEN = "http://example.org/instances/"

TOPIC_MUSTER = "ekkodale.gaeco.instance.public.{use_case}.gaecoImport"

# Der Broker nimmt 50 MB je Nachricht (KAFKA_MESSAGE_MAX_BYTES in gaecos
# .env). Gezählt wird hier das unkomprimierte JSON; gesendet wird gzip — die
# Grenze hat also reichlich Luft, und der Verbraucher muss die Nachricht
# trotzdem am Stück verdauen.
NACHRICHT_MAX = int(os.environ.get("ILEEN_GAECO_NACHRICHT_MAX", str(40 * 1024 * 1024)))

INDEX_PFAD = Path(os.environ.get("ILEEN_GAECO_GUIDELINE_INDEX", "/data/gaeco/ifc_guideline_index.json"))

# Die Verbrauchergruppe von gaecos instance-server (appsettings:
# Kafka.Consumers.GraphDataModel.ConsumerGroup). An ihrem bestätigten Offset
# lässt sich ablesen, ob gaeco eine Nachricht übernommen hat.
GAECO_GRUPPE = os.environ.get("ILEEN_GAECO_VERBRAUCHERGRUPPE", "instance-service-group")

# Volumen, die keine Bauteile sind (dieselbe Liste wie IFC_EXCLUDE_TYPES des
# Tilings, ohne IfcSpace — Räume sind hier Knoten, keine Geometrie).
AUSGESCHLOSSEN = ("IfcOpeningElement", "IfcVirtualElement", "IfcAnnotation", "IfcGrid")
RAEUMLICH = ("IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace")
# Wer in gaecos Ontologie `aggregates` als Subjekt führen darf (rdfs:domain).
AGGREGIERER = ("IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey")

# Das Betriebsprofil: gaeco ist die Verknüpfungsschicht des Betriebs, nicht die
# Ablage des Modells. Ein Campusmodell mit 22 000 Bauteilen braucht dort 11 min
# und lässt sich in gaeco nicht mehr bedienen (UseCases sind Sichtfenster auf
# *einen* Graphen, Cypher filtert nur auf `name`). Übertragen wird deshalb die
# räumliche Struktur samt Räumen und das, woran im Betrieb etwas hängt: Anlagen
# und Fühler der TGA, Aufzüge. Wände, Decken, Fenster und Leitungsstücke bleiben
# im IFC; der Schlüssel `uuid5(GlobalId)` ist rein rechnerisch, ein Bauteil kann
# also jederzeit nachgereicht werden, sobald etwas daran hängt (`zusaetzlich`).
# „raeume": nur die räumliche Struktur samt IfcSpace, kein einziges Bauteil — der kleine
# Graph, den gaecos Graph-Ansicht noch lädt (der Campus: rund 500 Räume statt 22 000 Knoten).
PROFILE = ("raeume", "betrieb", "voll")
BETRIEB_KLASSEN = ("IfcDistributionElement", "IfcTransportElement")
# Leitungsstücke sind Meterware: Hunderte je Strang, und nichts im Betrieb hängt
# an einem einzelnen Rohr — an der Pumpe, die es speist, schon.
BETRIEB_AUSGELASSEN = ("IfcFlowSegment", "IfcFlowFitting", "IfcDistributionChamberElement")

# Die Attribute mit festem Klarnamen in der IFC-Guideline — sie tragen auch
# ohne Index.
ATTRIBUTE = {
    "GlobalId": "Global ID",
    "Name": "Name",
    "Description": "Description",
    "ObjectType": "Object Type",
    "Tag": "Tag",
    "LongName": "Long Name",
}


def instanz_id(global_id: str) -> str:
    """Die gaeco-Instanzkennung eines IFC-Objekts."""
    return str(uuid.uuid5(NAMENSRAUM, global_id))


def topic(use_case_id: str) -> str:
    return TOPIC_MUSTER.format(use_case=use_case_id)


# ── Was gaecos IFC-Guideline kennt ───────────────────────────────────────────

class GuidelineIndex:
    """
    Klassen und Property-Namen der IFC-Guideline, aus der 311-MB-Datei
    verdichtet auf ein paar hundert Kilobyte (`scripts/gaeco_guideline_index.py`).

    `eigenschaften` bildet das Ende der Property-Kennung auf den Klarnamen ab:
    `IsExternal` → `Is External`. Dass die Klarnamen nicht aus der Kennung
    erraten werden können, zeigt die Guideline selbst: aus
    `FunctionalUnitReference` wird dort „Function Al Unit Reference".
    """

    def __init__(self, klassen: set[str] | None, eigenschaften: dict[str, str], quelle: str = ""):
        self.klassen = klassen
        self.eigenschaften = eigenschaften
        self.quelle = quelle

    @classmethod
    def ohne(cls) -> "GuidelineIndex":
        return cls(None, dict(ATTRIBUTE), quelle="(ohne Index — nur Attribute)")

    @classmethod
    def laden(cls, pfad: Path | None = None) -> "GuidelineIndex":
        pfad = Path(pfad or INDEX_PFAD)
        if not pfad.exists():
            return cls.ohne()
        daten = json.loads(pfad.read_text(encoding="utf-8"))
        eigenschaften = dict(ATTRIBUTE)
        eigenschaften.update(daten.get("eigenschaften") or {})
        return cls(set(daten.get("klassen") or []), eigenschaften, quelle=str(pfad))

    @staticmethod
    def aus_guideline(pfad: Path) -> dict:
        """
        Den Index aus einer `.guideline`-Datei bauen (JSON mit `$id`/`$ref`,
        wie gaecos Guideline-Editor sie schreibt). Liefert das Dict, das
        `laden()` liest.
        """
        with open(pfad, encoding="utf-8-sig") as f:
            daten = json.load(f)
        nach_id: dict[str, dict] = {}

        def sammeln(o):
            if isinstance(o, dict):
                if "$id" in o:
                    nach_id[o["$id"]] = o
                for v in o.values():
                    sammeln(v)
            elif isinstance(o, list):
                for v in o:
                    sammeln(v)

        sammeln(daten)

        def aufloesen(o):
            if isinstance(o, dict) and "$ref" in o:
                return nach_id.get(o["$ref"], {})
            return o or {}

        klassen: set[str] = set()
        eigenschaften: dict[str, str] = {}
        for o in nach_id.values():
            kennung = o.get("Identifier")
            if not (isinstance(kennung, str) and kennung.startswith(IFC_KLASSEN)):
                continue
            if "ClassificationProperties" not in o:
                continue
            klassen.add(kennung[len(IFC_KLASSEN):])
            werte = (o.get("ClassificationProperties") or {}).get("$values", [])
            for zuordnung in werte:
                zuordnung = aufloesen(zuordnung)
                prop = aufloesen(aufloesen(zuordnung.get("PropertyAssignment")).get("Property"))
                k, name = prop.get("Identifier"), prop.get("Name")
                if isinstance(k, str) and isinstance(name, str) and "/prop/" in k:
                    eigenschaften.setdefault(k.rsplit("/", 1)[-1], name)
        return {
            "quelle": Path(pfad).name,
            "klassen": sorted(klassen),
            "eigenschaften": dict(sorted(eigenschaften.items())),
        }

    def klasse(self, ifc_typ: str, schema=None) -> str | None:
        """Der Klassentyp in gaeco, oder None, wenn kein Obertyp bekannt ist."""
        if self.klassen is None:
            for endung in ("StandardCase", "ElementedCase"):
                if ifc_typ.endswith(endung) and len(ifc_typ) > len(endung) + 3:
                    ifc_typ = ifc_typ[: -len(endung)]
            return IFC_KLASSEN + ifc_typ
        typ = ifc_typ
        while typ:
            if typ in self.klassen:
                return IFC_KLASSEN + typ
            typ = _obertyp(schema, typ)
        return None

    def eigenschaft(self, schluessel: str) -> str | None:
        return self.eigenschaften.get(schluessel)


def _obertyp(schema, typ: str) -> str | None:
    if schema is None:
        return None
    try:
        obertyp = schema.declaration_by_name(typ).supertype()
    except Exception:
        return None
    return obertyp.name() if obertyp else None


# ── Der Graph ────────────────────────────────────────────────────────────────

@dataclass
class Knoten:
    id: str
    klasse: str
    code: str
    ifc_typ: str
    eigenschaften: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Kante:
    subjekt: str
    praedikat: str
    objekt: str


@dataclass
class Graph:
    knoten: list[Knoten]
    kanten: list[Kante]
    hinweise: list[str]
    klassen_ersetzt: dict[str, str]

    @property
    def zahlen(self) -> dict:
        return {"knoten": len(self.knoten), "kanten": len(self.kanten)}


def _als_text(wert) -> str | None:
    """gaeco erwartet Zeichenketten; ein bool als JSON-Literal könnte die
    ganze Nachricht beim Deserialisieren scheitern lassen."""
    if wert is None or wert == "":
        return None
    if isinstance(wert, bool):
        return "true" if wert else "false"
    if isinstance(wert, float):
        return "%.10g" % wert
    if isinstance(wert, (int, str)):
        return str(wert)
    if hasattr(wert, "wrappedValue"):
        return _als_text(wert.wrappedValue)
    try:
        return json.dumps(wert, ensure_ascii=False, default=str)
    except Exception:
        return str(wert)


def _pset_rang(name: str) -> tuple:
    """Standard-Psets zuerst: bei gleichem Property-Namen in zwei Sets gilt
    `Pset_WallCommon.IsExternal` vor einem herstellereigenen „IsExternal"."""
    if name.startswith("Pset_"):
        return (0, name)
    if name.startswith("Qto_"):
        return (1, name)
    return (2, name)


def _eigenschaften(objekt, index: GuidelineIndex, psets: dict | None) -> dict[str, str]:
    aus: dict[str, str] = {}
    for attribut in ATTRIBUTE:
        wert = getattr(objekt, attribut, None) if hasattr(objekt, attribut) else None
        name = index.eigenschaft(attribut)
        text = _als_text(wert)
        if name and text is not None:
            aus[name] = text
    for pset_name in sorted(psets or {}, key=_pset_rang):
        werte = psets[pset_name]
        if not isinstance(werte, dict):
            continue
        for schluessel, wert in werte.items():
            if schluessel == "id":
                continue
            name = index.eigenschaft(schluessel)
            if not name or name in aus:
                continue
            text = _als_text(wert)
            if text is not None:
                aus[name] = text
    return aus


def graph_aus_ifc(ifc_datei, index: GuidelineIndex | None = None, mit_psets: bool = True,
                  profil: str = "voll", zusaetzlich: tuple[str, ...] = ()) -> Graph:
    """
    Den Instanzgraphen eines geöffneten IFC-Modells bilden. Reine Rechnung —
    kein Netz, kein Broker; `tests/test_gaeco_export.py` prüft sie an einem
    Modell, das er selbst baut.

    `profil="betrieb"` nimmt nur die räumliche Struktur und die Betriebs-
    elemente (`BETRIEB_KLASSEN` ohne `BETRIEB_AUSGELASSEN`); `zusaetzlich`
    nennt weitere IFC-Klassen (mitsamt Untertypen), etwa `IfcDoor`. Kanten
    entstehen nur zwischen Knoten, die dabei sind — ein Profil kürzt also den
    Graphen, ohne dass irgendwo eine Kante ins Leere zeigt.
    """
    if profil not in PROFILE:
        raise ValueError(f"unbekanntes Profil {profil!r}, erlaubt: {', '.join(PROFILE)}")
    import ifcopenshell
    import ifcopenshell.util.element as ifc_element

    index = index or GuidelineIndex.ohne()
    try:
        schema = ifcopenshell.ifcopenshell_wrapper.schema_by_name(ifc_datei.schema_identifier)
    except Exception:
        try:
            schema = ifcopenshell.ifcopenshell_wrapper.schema_by_name(ifc_datei.schema)
        except Exception:
            schema = None

    hinweise: list[str] = []
    ersetzt: dict[str, str] = {}
    unbekannt: dict[str, int] = {}
    knoten: dict[str, Knoten] = {}

    def aufnehmen(objekt):
        gid = getattr(objekt, "GlobalId", None)
        if not gid or gid in knoten:
            return
        typ = objekt.is_a()
        klasse = index.klasse(typ, schema)
        if klasse is None:
            unbekannt[typ] = unbekannt.get(typ, 0) + 1
            return
        gaeco_typ = klasse[len(IFC_KLASSEN):]
        if gaeco_typ != typ:
            ersetzt[typ] = gaeco_typ
        psets = None
        if mit_psets:
            try:
                psets = ifc_element.get_psets(objekt)
            except Exception as e:  # ein kaputtes Pset soll das Modell nicht kosten
                hinweise.append(f"{gid}: Property-Sets nicht lesbar ({e})")
        knoten[gid] = Knoten(
            id=instanz_id(gid), klasse=klasse, code=gid, ifc_typ=typ,
            eigenschaften=_eigenschaften(objekt, index, psets),
        )

    for typ in RAEUMLICH:
        for objekt in ifc_datei.by_type(typ):
            aufnehmen(objekt)
    alle = [o for o in ifc_datei.by_type("IfcElement")
            if not any(o.is_a(t) for t in AUSGESCHLOSSEN)]
    if profil == "voll":
        gewaehlt = alle
    elif profil == "raeume":
        # nur was ausdrücklich genannt ist (`zusaetzlich`), sonst keine Bauteile
        gewaehlt = [o for o in alle if any(o.is_a(t) for t in zusaetzlich)]
    else:
        # Was ausdrücklich genannt ist, gilt auch dann, wenn ein Obertyp ausgelassen wird.
        gewaehlt = [o for o in alle
                    if any(o.is_a(t) for t in zusaetzlich)
                    or (any(o.is_a(t) for t in BETRIEB_KLASSEN)
                        and not any(o.is_a(t) for t in BETRIEB_AUSGELASSEN))]
        weg: dict[str, int] = {}
        gewaehlt_ids = {o.id() for o in gewaehlt}
        for o in alle:
            if o.id() not in gewaehlt_ids:
                weg[o.is_a()] = weg.get(o.is_a(), 0) + 1
        zusatz = f" (zusätzlich: {', '.join(zusaetzlich)})" if zusaetzlich else ""
        hinweise.append(
            f"Profil {profil}{zusatz}: {len(gewaehlt)} von {len(alle)} Bauteilen übernommen; im IFC "
            "geblieben: " + ", ".join(f"{n}× {t}" for t, n in sorted(weg.items(), key=lambda x: -x[1])[:6]))
    for objekt in gewaehlt:
        aufnehmen(objekt)

    kanten: list[Kante] = []
    gesehen: set[Kante] = set()

    def verbinden(subjekt, praedikat, objekt):
        a = knoten.get(getattr(subjekt, "GlobalId", None))
        b = knoten.get(getattr(objekt, "GlobalId", None))
        if not a or not b or a is b:
            return
        kante = Kante(a.id, praedikat, b.id)
        if kante not in gesehen:
            gesehen.add(kante)
            kanten.append(kante)

    for rel in ifc_datei.by_type("IfcRelAggregates"):
        oben = rel.RelatingObject
        if not oben or not any(oben.is_a(t) for t in AGGREGIERER):
            continue
        for teil in rel.RelatedObjects or ():
            if any(teil.is_a(t) for t in RAEUMLICH[1:]):
                verbinden(oben, AGGREGIERT, teil)

    for rel in ifc_datei.by_type("IfcRelContainedInSpatialStructure"):
        for element in rel.RelatedElements or ():
            verbinden(rel.RelatingStructure, ENTHAELT, element)

    for rel in ifc_datei.by_type("IfcRelFillsElement"):
        oeffnung, fuellung = rel.RelatingOpeningElement, rel.RelatedBuildingElement
        for leer in getattr(oeffnung, "VoidsElements", None) or ():
            verbinden(leer.RelatingBuildingElement, FUELLT, fuellung)

    for typ, anzahl in sorted(unbekannt.items(), key=lambda x: -x[1]):
        hinweise.append(f"{anzahl}× {typ}: keine Klasse in der gaeco-Guideline — nicht übertragen")
    # Knoten ohne jede Kante sind im Graphen nur über die Suche zu finden.
    # Meist sind es Teile eines Bauteils (IfcBuildingElementPart in einer
    # Wand): IfcRelAggregates zwischen Bauteilen kennt gaecos Ontologie nicht
    # (rdfs:domain von `aggregates` sind nur räumliche Elemente).
    verbunden = {k.subjekt for k in kanten} | {k.objekt for k in kanten}
    lose: dict[str, int] = {}
    for k in knoten.values():
        if k.id not in verbunden and k.ifc_typ != "IfcProject":
            lose[k.ifc_typ] = lose.get(k.ifc_typ, 0) + 1
    for typ, anzahl in sorted(lose.items(), key=lambda x: -x[1])[:10]:
        hinweise.append(f"{anzahl}× {typ} ohne Beziehung im Graphen (weder enthalten noch zerlegt)")
    for alt, neu in sorted(ersetzt.items()):
        hinweise.append(f"{alt} → {neu} (die Guideline kennt nur den Obertyp)")

    geordnet = sorted(knoten.values(), key=lambda k: (k.ifc_typ not in RAEUMLICH,
                                                     RAEUMLICH.index(k.ifc_typ) if k.ifc_typ in RAEUMLICH else 0))
    return Graph(knoten=geordnet, kanten=kanten, hinweise=hinweise, klassen_ersetzt=ersetzt)


def ueberzaehlige(ifc_datei, index: GuidelineIndex | None = None, profil: str = "betrieb",
                  zusaetzlich: tuple[str, ...] = ()) -> dict:
    """
    Welche Instanzen ein früherer Voll-Export in gaeco hinterlassen hat, die das
    Profil nicht (mehr) will — die Kennungen zum Löschen.

    Nötig, weil gaecos Graph-Endpunkt (`GET /{uc}/Instances/graph`) bei einem
    großen Altbestand nach 55–77 s mit „message was not consumed" scheitert und
    sich der Bestand deshalb nicht auflisten lässt. Die Kennungen sind aber
    `uuid5(GlobalId)` — sie ergeben sich aus dem IFC, ohne gaeco zu fragen.
    Reine Rechnung: dieselbe Guideline-Auswahl wie beim Export, damit nur Knoten
    genannt werden, die der Export auch angelegt hat.
    """
    voll = graph_aus_ifc(ifc_datei, index, mit_psets=False, profil="voll")
    behalten = graph_aus_ifc(ifc_datei, index, mit_psets=False, profil=profil, zusaetzlich=zusaetzlich)
    bleibt = {k.id for k in behalten.knoten}
    weg = [k.id for k in voll.knoten if k.id not in bleibt]
    return {"profil": profil, "voll": len(voll.knoten), "behalten": len(bleibt), "entfernen": weg}


# ── Die Nachrichten ──────────────────────────────────────────────────────────

def _turtle(kanten: list[Kante]) -> str:
    zeilen = [f"@prefix inst: <{INSTANZEN}>."]
    zeilen += [f"inst:{k.subjekt} <{k.praedikat}> inst:{k.objekt}." for k in kanten]
    return "\n".join(zeilen) + "\n"


def _nachricht(knoten: list[Knoten], kanten: list[Kante], use_case_id: str) -> dict:
    return {
        "GraphTemplate": f"@prefix inst: <{INSTANZEN}> .\nNode1 hasRelation Node2 .",
        "GraphData": _turtle(kanten),
        "AccessRights": [],
        "Guidelines": [],
        "UseCase": {"Id": use_case_id, "Name": "", "Description": ""},
        "GraphMetadata": [
            {"Id": k.id, "ClassType": k.klasse, "Code": k.code, "PropertiesValues": k.eigenschaften}
            for k in knoten
        ],
    }


def _groesse(obj) -> int:
    return len(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def nachrichten(graph: Graph, use_case_id: str, max_bytes: int = NACHRICHT_MAX) -> list[bytes]:
    """
    Den Graphen in GraphDataModel-Nachrichten fassen, **einzeilig** und je
    genau ein Objekt — ein Array quittiert der Verbraucher mit
    `JsonException … Path: $`.

    Passt alles in eine Nachricht, bleibt es bei einer. Sonst wird nach
    Knoten geteilt, in der Reihenfolge des Graphen (räumliche Struktur
    zuerst), und jede Kante wandert in die Nachricht, in der der **spätere**
    ihrer beiden Knoten steht — der frühere ist dann schon in gaeco.
    """
    def kodieren(obj) -> bytes:
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    ganz = _nachricht(graph.knoten, graph.kanten, use_case_id)
    if _groesse(ganz) <= max_bytes:
        return [kodieren(ganz)]

    platz = {k.id: i for i, k in enumerate(graph.knoten)}
    kanten_bei: dict[int, list[Kante]] = {}
    for kante in graph.kanten:
        spaeter = max(platz.get(kante.subjekt, 0), platz.get(kante.objekt, 0))
        kanten_bei.setdefault(spaeter, []).append(kante)

    teile: list[bytes] = []
    knoten_jetzt: list[Knoten] = []
    kanten_jetzt: list[Kante] = []
    groesse = _groesse(_nachricht([], [], use_case_id))
    for i, k in enumerate(graph.knoten):
        zusatz = _groesse(_nachricht([k], kanten_bei.get(i, []), use_case_id)) - _groesse(_nachricht([], [], use_case_id))
        if knoten_jetzt and groesse + zusatz > max_bytes:
            teile.append(kodieren(_nachricht(knoten_jetzt, kanten_jetzt, use_case_id)))
            knoten_jetzt, kanten_jetzt = [], []
            groesse = _groesse(_nachricht([], [], use_case_id))
        knoten_jetzt.append(k)
        kanten_jetzt.extend(kanten_bei.get(i, []))
        groesse += zusatz
    if knoten_jetzt:
        teile.append(kodieren(_nachricht(knoten_jetzt, kanten_jetzt, use_case_id)))
    return teile


async def senden(teile: list[bytes], use_case_id: str, broker: str) -> dict:
    """Die Nachrichten an gaecos Broker geben. Gibt Topic und Bytes zurück."""
    from aiokafka import AIOKafkaProducer

    if not broker:
        raise RuntimeError("Kein Kafka-Broker eingestellt (ILEEN_KAFKA_BROKER ist leer).")
    ziel = topic(use_case_id)
    groesste = max((len(t) for t in teile), default=0)
    erzeuger = AIOKafkaProducer(
        bootstrap_servers=broker,
        compression_type="gzip",
        # Vorgabe ist 1 MB; die Grenze des Brokers liegt bei 50 MB.
        max_request_size=max(groesste + 1024 * 1024, 1024 * 1024),
        acks="all",
        request_timeout_ms=120000,
    )
    await erzeuger.start()
    letzte: dict[int, int] = {}
    try:
        for teil in teile:
            meta = await erzeuger.send_and_wait(ziel, teil)
            letzte[meta.partition] = max(letzte.get(meta.partition, -1), meta.offset)
    finally:
        await erzeuger.stop()
    return {"topic": ziel, "bytes": sum(len(t) for t in teile), "nachrichten": len(teile),
            "offsets": letzte}


async def lesestand(use_case_id: str, offsets: dict[int, int], broker: str,
                    gruppe: str = GAECO_GRUPPE) -> dict:
    """
    Wie weit gaeco mit den gesendeten Nachrichten ist — gefragt beim Broker,
    nicht bei gaeco (dessen APIs bräuchten ein Token, der Broker nicht).

    * `abonniert`: ob ein Mitglied der Verbrauchergruppe das Topic zugeteilt
      hat. gaecos instance-server legt sein Abonnement **nur beim Start** fest
      (GAECO-INTEGRATION.md, Fallgrube K1); ein später angelegtes Topic bleibt
      sonst still ungelesen.
    * `uebernommen`: ob der bestätigte Offset hinter der letzten gesendeten
      Nachricht steht. Bestätigt wird erst, wenn gaeco Instanzen **und**
      Beziehungen angelegt hat — bei 23 000 Bauteilen gut zehn Minuten.
    """
    from aiokafka.admin import AIOKafkaAdminClient
    from aiokafka.coordinator.protocol import ConsumerProtocolMemberAssignment
    from aiokafka.structs import TopicPartition

    ziel = topic(use_case_id)
    verwalter = AIOKafkaAdminClient(bootstrap_servers=broker, request_timeout_ms=10000)
    await verwalter.start()
    try:
        bestaetigt = await verwalter.list_consumer_group_offsets(
            gruppe, partitions=[TopicPartition(ziel, p) for p in offsets])
        uebernommen = bool(offsets) and all(
            (bestaetigt.get(TopicPartition(ziel, p)) is not None
             and bestaetigt[TopicPartition(ziel, p)].offset > o)
            for p, o in offsets.items())
        abonniert = False
        for antwort in await verwalter.describe_consumer_groups([gruppe]):
            for g in antwort.groups:
                for mitglied in g[5]:
                    try:
                        zuteilung = ConsumerProtocolMemberAssignment.decode(mitglied[-1])
                    except Exception:
                        continue
                    if any(t == ziel for t, _ in zuteilung.assignment):
                        abonniert = True
        return {"abonniert": abonniert or uebernommen, "uebernommen": uebernommen}
    finally:
        await verwalter.close()
