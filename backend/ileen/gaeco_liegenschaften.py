"""
Liegenschaften: IFC-Modelle als IBPDI-Portfolio in gaeco.

© 2026 Philipp Schäfer — PolyForm Noncommercial 1.0.0 (siehe LICENSE.md)
SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

Ein Portfolio, je Modell ein Gebäude (Building) mit Adresse (Address, Koordinaten aus
der iLEEN-Platzierung), dessen Geschossen (Floor) und Räumen (Space):

    Portfolio ─portfolioHasBuilding→ Building ─buildingHasFloor→ Floor ─floorHasSpace→ Space
    Address   ─addressHasBuilding →  Building

Das sind gaecos eigene IBPDI-Klassen (Schema https://ibpdi.org/ontology/2.0/), keine
IFC-Klassen — so verwaltet man Liegenschaften, nicht Bauteile. Die Kennungen tragen den
Namensraum-Zusatz `ibpdi:`, damit sie nicht mit den IFC-Instanzen (`uuid5(GlobalId)`)
zusammenfallen. `BuildingCode` trägt die iLEEN-Modellkennung (job_id): daran findet die
Karte das Modell zur Liegenschaft.

Der Anzeigename einer Instanz bildet gaeco aus „<Code> <Name>“: Portfolio und Gebäude haben
deshalb keinen Code (der Name steht allein), die Adresse trägt ihren Namen als Code (sie hat
keine Name-Eigenschaft), Geschosse und Räume die IFC-GlobalId (wie im IFC-Export).
"""

from __future__ import annotations

import uuid

from .gaeco_export import Graph, Kante, Knoten, NAMENSRAUM

IBPDI = "https://ibpdi.org/ontology/2.0/"
PRAEDIKAT = {
    "portfolio": IBPDI + "portfolioHasBuilding",
    "adresse": IBPDI + "addressHasBuilding",
    "geschoss": IBPDI + "buildingHasFloor",
    "raum": IBPDI + "floorHasSpace",
}
# Die IBPDI-Klassen, auf die der UseCase Rechte braucht (Eigenschaften: siehe gaeco/liegenschaften.py)
KLASSEN = ("Portfolio", "Building", "Address", "Floor", "Space")


def kennung(*teile: str) -> str:
    return str(uuid.uuid5(NAMENSRAUM, "ibpdi:" + ":".join(teile)))


def _text(wert) -> str | None:
    if wert is None or wert == "":
        return None
    return str(wert)


def graph_liegenschaften(portfolio: dict, modelle: list[dict]) -> Graph:
    """
    `portfolio`: {"schluessel", "name"}.
    `modelle`:   je Liegenschaft {"schluessel", "name", "job_id", "datei" (geöffnetes IFC),
                  "lat", "lon", "ort", "land"}.
    """
    import ifcopenshell.util.element as el

    knoten: list[Knoten] = []
    kanten: list[Kante] = []
    hinweise: list[str] = []

    pid = kennung("portfolio", portfolio["schluessel"])
    knoten.append(Knoten(pid, IBPDI + "Portfolio", "", "Portfolio", {
        "Name": portfolio["name"], "PortfolioCode": portfolio["schluessel"], "Type": "Liegenschaften",
    }))

    for m in modelle:
        bid = kennung("building", m["job_id"])
        aid = kennung("address", m["job_id"])
        knoten.append(Knoten(bid, IBPDI + "Building", "", "Building", {
            "Name": m["name"], "BuildingCode": m["job_id"],
        }))
        adresse = {"City": m.get("ort"), "Country": m.get("land"),
                   "DeprecatedLatitude": f"{m['lat']:.7f}", "DeprecatedLongitude": f"{m['lon']:.7f}"}
        knoten.append(Knoten(aid, IBPDI + "Address", m["name"] + " — Lage", "Address",
                             {k: v for k, v in adresse.items() if v}))
        kanten.append(Kante(pid, PRAEDIKAT["portfolio"], bid))
        kanten.append(Kante(aid, PRAEDIKAT["adresse"], bid))

        ifc = m["datei"]
        geschosse = sorted(ifc.by_type("IfcBuildingStorey"), key=lambda s: float(s.Elevation or 0))
        nummer = {}
        for i, s in enumerate(geschosse):
            fid = kennung("floor", s.GlobalId)
            nummer[s.id()] = fid
            knoten.append(Knoten(fid, IBPDI + "Floor", s.GlobalId, "Floor", {
                k: v for k, v in {"Name": _text(s.LongName) or _text(s.Name) or f"Geschoss {i}",
                                  "FloorCode": s.GlobalId, "FloorNumber": str(i)}.items() if v}))
            kanten.append(Kante(bid, PRAEDIKAT["geschoss"], fid))

        ohne = 0
        for r in ifc.by_type("IfcSpace"):
            oben = el.get_aggregate(r) or el.get_container(r)
            fid = nummer.get(oben.id()) if oben is not None else None
            if fid is None:
                ohne += 1
                continue
            rid = kennung("space", r.GlobalId)
            knoten.append(Knoten(rid, IBPDI + "Space", r.GlobalId, "Space", {
                k: v for k, v in {"Name": _text(r.LongName) or _text(r.Name) or r.GlobalId,
                                  "SpaceCode": r.GlobalId, "SpaceNumber": _text(r.Name),
                                  "Type": _text(r.ObjectType)}.items() if v}))
            kanten.append(Kante(fid, PRAEDIKAT["raum"], rid))
        if ohne:
            hinweise.append(f"{m['name']}: {ohne} Räume ohne Geschoss nicht übernommen")

    return Graph(knoten=knoten, kanten=kanten, hinweise=hinweise, klassen_ersetzt={})
