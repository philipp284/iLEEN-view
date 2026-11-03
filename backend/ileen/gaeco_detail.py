"""
iLEEN → SPIDER: der Detailgraph eines IFC-Modells, gegliedert in Gruppen.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Warum es das gibt
=================
gaeco ist die Verknüpfungsschicht, nicht die Ablage des Modells: ein Voll-Export
legte 38 000 Instanzen an, und gaecos Graph-Endpunkt (`GET /{uc}/Instances/graph`)
scheiterte daran. Im Graphen von gaeco bleibt deshalb das Betriebsprofil
(`gaeco_export`). Wer **jedes** Bauteil sehen will, bekommt es hier — als
Baum aus Gruppen, den SPIDER aufklappt, Ebene für Ebene:

    Projekt → Grundstück → Gebäude → Geschoss → Raum
                                        └─ Wände (2 525)
                                             └─ Basiswand: Außen 36 cm (400)
                                                  └─ Teil 1 … Teil 7
                                                       └─ Wand → Bauteilteile …

Nichts hiervon geht nach gaeco. Dieselbe Kennung `uuid5(GlobalId)` verbindet beide
Seiten: ein Bauteil, das auch in gaeco liegt, ist für SPIDER derselbe Knoten, an dem
nun zusätzlich die Gruppe hängt.

Die Regeln der Gliederung
=========================
* Räumliche Elemente hängen wie im IFC (`aggregates`, Geschoss → Raum ebenso).
* Ein Bauteil hängt an seinem **Elternbauteil**, wenn es Teil von ihm ist
  (IfcRelAggregates/IfcRelNests — die `IfcBuildingElementPart` einer Wand), sonst
  an seinem **Raum bzw. Geschoss** (IfcRelContainedInSpatialStructure), sonst an
  einer Gruppe „Ohne Zuordnung“ unter dem Gebäude.
* Hat ein Elternknoten höchstens `MAX_GRUPPE` Kinder, hängen sie direkt daran
  (`containsElement`, bei Teilen `teil`). Sind es mehr, wird gruppiert: erst nach
  IFC-Klasse, dann nach Typname, dann in Stücke nach Name — so lange, bis keine Ebene
  mehr als `MAX_GRUPPE` Kinder hat. Aufklappen zeigt also nie Tausende Knoten auf
  einmal, und die Tiefe ist beliebig.
* Gruppenkennungen sind deterministisch (`uuid5` aus Elternkennung und Schlüssel):
  Neuladen ändert nichts an ihnen.

Reine Rechnung — kein Netz, kein Broker.
"""

from __future__ import annotations

import uuid
from collections import defaultdict

from ileen import gaeco_export as ge

MAX_GRUPPE = 60

# Wie die Kante im Detailgraphen heißt. SPIDER setzt daraus das Prädikat.
KANTE_AGGREGIERT = "aggregates"       # gaecos Ontologie, räumliche Struktur
KANTE_ENTHAELT = "containsElement"    # gaecos Ontologie, Raum/Geschoss → Bauteil
KANTE_GRUPPE = "gruppe"               # Gruppe → Kind
KANTE_TEIL = "teil"                   # Bauteil → Teil des Bauteils

NAMEN = {
    "IfcWall": "Wände", "IfcWallStandardCase": "Wände", "IfcSlab": "Decken und Platten",
    "IfcColumn": "Stützen", "IfcBeam": "Träger", "IfcDoor": "Türen", "IfcWindow": "Fenster",
    "IfcBuildingElementPart": "Bauteilteile", "IfcFurniture": "Möbel",
    "IfcFlowSegment": "Leitungssegmente", "IfcFlowFitting": "Formstücke",
    "IfcFlowTerminal": "Auslässe", "IfcPlate": "Platten und Bleche", "IfcCovering": "Beläge",
    "IfcCurtainWall": "Vorhangfassaden", "IfcStair": "Treppen", "IfcStairFlight": "Treppenläufe",
    "IfcRoof": "Dächer", "IfcBuildingElementProxy": "Sonstige Bauteile", "IfcMember": "Stäbe",
    "IfcRailing": "Geländer", "IfcFooting": "Fundamente", "IfcPile": "Pfähle",
    "IfcRamp": "Rampen", "IfcRampFlight": "Rampenläufe", "IfcSanitaryTerminal": "Sanitärobjekte",
    "IfcLightFixture": "Leuchten", "IfcDistributionElement": "TGA-Elemente",
    "IfcTransportElement": "Transportanlagen", "IfcDiscreteAccessory": "Zubehör",
    "IfcFastener": "Verbindungsmittel", "IfcMechanicalFastener": "Verbindungsmittel",
}


def _klassenname(ifc_typ: str) -> str:
    return NAMEN.get(ifc_typ) or (ifc_typ[3:] if ifc_typ.startswith("Ifc") else ifc_typ)


def _schema(ifc_datei):
    import ifcopenshell
    for name in (getattr(ifc_datei, "schema_identifier", None), getattr(ifc_datei, "schema", None)):
        try:
            return ifcopenshell.ifcopenshell_wrapper.schema_by_name(name)
        except Exception:
            continue
    return None


def _kuerzen(s: str, n: int = 22) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def detail_graph(ifc_datei, index: "ge.GuidelineIndex | None" = None,
                 max_gruppe: int = MAX_GRUPPE) -> dict:
    """
    Der gegliederte Detailgraph.

        { knoten: [{id, name, klasse, klasseId, art, n?}],
          kanten: [[eltern, kind, art]],            # art: siehe KANTE_*
          zahlen: {...}, hinweise: [...] }

    `art` eines Knotens: `raum` (Projekt … Raum), `bauteil` oder `gruppe`.
    `n` einer Gruppe: wie viele Bauteile darunter hängen, über alle Ebenen.
    """
    index = index or ge.GuidelineIndex.ohne()
    schema = _schema(ifc_datei)
    hinweise: list[str] = []

    # ── Knoten: räumliche Elemente und Bauteile ──────────────────────────────
    info: dict[int, dict] = {}              # IFC-Schrittnummer → Knoten
    elemente: list = []

    def aufnehmen(objekt, art: str):
        gid = getattr(objekt, "GlobalId", None)
        if not gid or objekt.id() in info:
            return
        typ = objekt.is_a()
        klasse_id = index.klasse(typ, schema) or (ge.IFC_KLASSEN + typ)
        name = (getattr(objekt, "Name", None) or getattr(objekt, "Tag", None) or "").strip()
        info[objekt.id()] = {
            "id": ge.instanz_id(gid), "name": name or _klassenname(typ),
            "klasse": klasse_id[len(ge.IFC_KLASSEN):] if klasse_id.startswith(ge.IFC_KLASSEN) else typ,
            "klasseId": klasse_id, "art": art, "_typ": typ, "_hat_name": bool(name),
        }
        if art == "bauteil":
            elemente.append(objekt)

    for typ in ge.RAEUMLICH:
        for o in ifc_datei.by_type(typ):
            aufnehmen(o, "raum")
    for o in ifc_datei.by_type("IfcElement"):
        if not any(o.is_a(t) for t in ge.AUSGESCHLOSSEN):
            aufnehmen(o, "bauteil")

    # ── Zuordnung: Elternknoten je Knoten ────────────────────────────────────
    eltern: dict[int, tuple[int, str]] = {}    # Kind → (Elternnummer, Kantenart)

    def zerlegt(rel, oben):
        if oben is None or oben.id() not in info:
            return
        for teil in (getattr(rel, "RelatedObjects", None) or ()):
            if teil.id() not in info or teil.id() in eltern or teil.id() == oben.id():
                continue
            if info[teil.id()]["art"] == "raum":
                eltern[teil.id()] = (oben.id(), KANTE_AGGREGIERT)
            elif info[oben.id()]["art"] == "bauteil":
                eltern[teil.id()] = (oben.id(), KANTE_TEIL)

    for rel in ifc_datei.by_type("IfcRelAggregates"):
        zerlegt(rel, rel.RelatingObject)
    try:
        verschachtelt = ifc_datei.by_type("IfcRelNests")      # erst ab IFC4
    except Exception:
        verschachtelt = []
    for rel in verschachtelt:
        zerlegt(rel, rel.RelatingObject)
    for rel in ifc_datei.by_type("IfcRelContainedInSpatialStructure"):
        oben = rel.RelatingStructure
        if oben is None or oben.id() not in info:
            continue
        for e in rel.RelatedElements or ():
            if e.id() in info and e.id() not in eltern:
                eltern[e.id()] = (oben.id(), KANTE_ENTHAELT)

    typnamen: dict[int, str] = {}
    for rel in ifc_datei.by_type("IfcRelDefinesByType"):
        t = rel.RelatingType
        n = (getattr(t, "Name", None) or "").strip() if t is not None else ""
        for o in rel.RelatedObjects or ():
            if n:
                typnamen[o.id()] = n

    # ── Auffangknoten für Bauteile ohne Eltern ───────────────────────────────
    wurzeln = [i for i, k in info.items() if k["art"] == "raum" and i not in eltern]
    gebaeude = [i for i in wurzeln if info[i]["_typ"] == "IfcBuilding"] or \
               [i for i, k in info.items() if k["_typ"] == "IfcBuilding"] or wurzeln
    heimat = gebaeude[0] if gebaeude else None
    if heimat is None and info:
        heimat = next(iter(info))

    kinder: dict[int | str, list[tuple[int, str]]] = defaultdict(list)
    waise = 0
    for i, k in info.items():
        if i in eltern:
            kinder[eltern[i][0]].append((i, eltern[i][1]))
        elif k["art"] == "bauteil" and heimat is not None:
            kinder[("ohne", heimat)].append((i, KANTE_ENTHAELT))
            waise += 1
    if waise:
        hinweise.append(f"{waise} Bauteile ohne Raum, Geschoss oder Elternbauteil — unter „Ohne Zuordnung“")

    # ── Gliedern ─────────────────────────────────────────────────────────────
    knoten_aus: list[dict] = []
    kanten_aus: list[list[str]] = []
    gruppen_n: dict[str, int] = {}

    def knoten_ausgeben(i: int):
        k = info[i]
        eintrag = {"id": k["id"], "name": k["name"], "klasse": k["klasse"], "art": k["art"]}
        if k["klasseId"] != ge.IFC_KLASSEN + k["klasse"]:      # sonst rechnet SPIDER sie selbst
            eintrag["klasseId"] = k["klasseId"]
        knoten_aus.append(eintrag)

    def gruppe(eltern_id: str, schluessel: str, name: str, n: int, klasse: str) -> str:
        gid = str(uuid.uuid5(ge.NAMENSRAUM, f"gruppe:{eltern_id}:{schluessel}"))
        knoten_aus.append({"id": gid, "name": f"{name} ({n})", "klasse": klasse,
                           "art": "gruppe", "n": n})
        gruppen_n[gid] = n
        return gid

    # Rekursionstiefe ist die Tiefe des IFC-Baums, nicht seine Größe.
    zaehl_cache: dict[int, int] = {}

    def anzahl(i: int) -> int:
        if i not in zaehl_cache:
            zaehl_cache[i] = (1 if info[i]["art"] == "bauteil" else 0) + sum(anzahl(c) for c, _ in kinder.get(i, ()))
        return zaehl_cache[i]

    def anhaengen(eltern_id: str, posten: list[tuple[int, str]], ebenen: list):
        """Posten (Kind, Kantenart) an einen Elternknoten hängen, gruppiert wenn es zu viele sind."""
        if len(posten) <= max_gruppe:
            for i, art in posten:
                kanten_aus.append([eltern_id, info[i]["id"], art])
                ausfuehren(i)
            return
        while ebenen:
            name_von, benennung, klasse = ebenen.pop(0)
            teile: dict[str, list] = defaultdict(list)
            for p in posten:
                teile[name_von(p[0])].append(p)
            if len(teile) <= 1:
                continue
            for schluessel, liste in sorted(teile.items(), key=lambda kv: (-len(kv[1]), kv[0])):
                n = sum(anzahl(i) for i, _ in liste)
                g = gruppe(eltern_id, f"{klasse}:{schluessel}", benennung(schluessel), n, klasse)
                kanten_aus.append([eltern_id, g, KANTE_GRUPPE])
                anhaengen(g, liste, list(ebenen))
            return
        stuecke(eltern_id, posten)

    def stuecke(eltern_id: str, posten: list[tuple[int, str]]):
        """Letzte Ebene: nach Name sortiert in Stücke zu höchstens `max_gruppe` Kindern."""
        geordnet = sorted(posten, key=lambda p: (info[p[0]]["name"].lower(), info[p[0]]["id"]))
        if len(geordnet) <= max_gruppe:
            for i, art in geordnet:
                kanten_aus.append([eltern_id, info[i]["id"], art])
                ausfuehren(i)
            return
        # So viele Stücke, dass auch ihre Zahl nicht über das Maß geht — bei Bedarf mehrstufig.
        breite = max_gruppe
        while len(geordnet) > breite * max_gruppe:
            breite *= max_gruppe
        for start in range(0, len(geordnet), breite):
            teil = geordnet[start:start + breite]
            n = sum(anzahl(i) for i, _ in teil)
            von, bis = _kuerzen(info[teil[0][0]]["name"], 16), _kuerzen(info[teil[-1][0]]["name"], 16)
            bezeichnung = f"{von} … {bis}" if von != bis else f"Nr. {start + 1}–{start + len(teil)}"
            g = gruppe(eltern_id, f"stueck:{start}", bezeichnung, n, "Stück")
            kanten_aus.append([eltern_id, g, KANTE_GRUPPE])
            if len(teil) <= max_gruppe:
                for i, art in teil:
                    kanten_aus.append([g, info[i]["id"], art])
                    ausfuehren(i)
            else:
                stuecke(g, teil)

    ebenen_vorgabe = [
        (lambda i: info[i]["_typ"], _klassenname, "Klasse"),
        (lambda i: typnamen.get(i) or "ohne Typ", lambda s: s, "Typ"),
    ]
    gesehen: set[int] = set()

    def ausfuehren(i: int):
        if i in gesehen:
            return
        gesehen.add(i)
        knoten_ausgeben(i)
        posten = kinder.get(i, [])
        if posten:
            anhaengen(info[i]["id"], posten, list(ebenen_vorgabe))

    # Wurzeln: alles, was räumlich ist und nirgends hängt (Projekt, ggf. weitere).
    for i in wurzeln:
        ausfuehren(i)
    if heimat is not None and ("ohne", heimat) in kinder:
        ohne = kinder[("ohne", heimat)]
        g = gruppe(info[heimat]["id"], "ohne-zuordnung", "Ohne Zuordnung", sum(anzahl(i) for i, _ in ohne), "Gruppe")
        kanten_aus.append([info[heimat]["id"], g, KANTE_GRUPPE])
        anhaengen(g, ohne, list(ebenen_vorgabe))
    # Zyklen im IFC (sollte es nicht geben): was nicht erreicht wurde, wenigstens zeigen.
    uebrig = [i for i in info if i not in gesehen]
    if uebrig:
        hinweise.append(f"{len(uebrig)} Knoten nicht erreichbar (Zyklus im IFC?) — ohne Eltern angehängt")
        for i in uebrig:
            ausfuehren(i)

    # Was von einer Gruppe ausgeht, heißt „gruppe“ — gleich, was das Kind im IFC ist.
    for kante in kanten_aus:
        if kante[0] in gruppen_n:
            kante[2] = KANTE_GRUPPE

    zahlen = {
        "knoten": len(knoten_aus), "kanten": len(kanten_aus),
        "bauteile": sum(1 for k in knoten_aus if k["art"] == "bauteil"),
        "gruppen": sum(1 for k in knoten_aus if k["art"] == "gruppe"),
        "max_gruppe": max_gruppe,
    }
    return {"knoten": knoten_aus, "kanten": kanten_aus, "zahlen": zahlen, "hinweise": hinweise}
