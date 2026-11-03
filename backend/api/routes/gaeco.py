"""
gaeco: ein Modell in gaecos Graphen übertragen.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

    POST /gaeco/export/{job_id}     {use_case_id}  →  Stand (läuft im Hintergrund)
    GET  /gaeco/export/{job_id}                    →  Stand des letzten Exports, samt Übernahme durch gaeco
    GET  /gaeco/stand                              →  Broker, Guideline-Index, alle Exporte
    GET  /gaeco/id/{global_id}                     →  die gaeco-Instanzkennung einer GlobalId
    GET  /gaeco/detail/{job_id}                    →  Detailgraph des Modells in Gruppen (für SPIDER)

Aufgerufen wird das vom gaeco-Modul (`gaeco/modul/`), Knopf „Nach gaeco
übertragen". Die Rechnung steht in `ileen/gaeco_export.py`; hier liegen nur
Ablauf und Stand.

Wer darf übertragen
===================
gaecos Import-Verbraucher prüft keine Anmeldung — wer an den Broker kommt,
schreibt in den Graphen. Diese Route ist deshalb die Tür, und sie fragt
**gaeco selbst**: Der Aufruf muss das gaeco-Token des Moduls mitbringen
(`Authorization: Bearer …`), und mit genau diesem Token wird
`GET {usecase-server}/api/UseCases` gestellt. Nur wenn gaeco antwortet und
der Ziel-UseCase in der Antwort steht, geht der Export hinaus.

Die Regel ist damit: **Wer den UseCase in gaeco sehen darf, darf in ihn
übertragen.** Signatur, Ablauf und Zielgruppe des Tokens prüft gaeco; iLEEN
braucht dafür weder eine JWT-Bibliothek noch Keycloaks Schlüssel. Ohne das
wäre der Weg in gaecos Graphen für jeden offen, der das iLEEN-Backend
erreicht — iLEEN selbst hat keine Anmeldung.

Gesendet ist nicht übernommen
=============================
`zustand: fertig` heißt nur: die Nachricht liegt im Broker. Ob gaeco sie
verarbeitet hat, steht in `gaeco` (wartet → in_arbeit → uebernommen, oder
nicht_abonniert) — abgelesen am bestätigten Offset von gaecos
Verbrauchergruppe (`gaeco_export.lesestand()`). Bei 23 000 Bauteilen dauert
das gut zehn Minuten.

`ILEEN_GAECO_OHNE_ANMELDUNG=1` schaltet die Prüfung ab — nur für einen
Rechner, auf dem Backend und gaeco ausschließlich lokal laufen.

Ein Export zur Zeit (`asyncio.Semaphore(1)`): das Öffnen eines großen IFC
kostet Gigabytes, und zwei nebeneinander wären nicht schneller.
"""

import asyncio
import json
import logging
import os
import re
import time
import urllib.request
import uuid
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from api.routes import plan as planroute
from ileen import gaeco_detail, gaeco_export, gaeco_liegenschaften

logger = logging.getLogger(__name__)

router = APIRouter()

BROKER = os.environ.get("ILEEN_KAFKA_BROKER", "")
# Der UseCase-Dienst im Netz gaeco-local — nicht die Browser-Adresse.
USECASE_DIENST = os.environ.get("ILEEN_GAECO_USECASE_DIENST", "http://usecase-server:80").rstrip("/")
OHNE_ANMELDUNG = os.environ.get("ILEEN_GAECO_OHNE_ANMELDUNG", "") in ("1", "true", "ja")


def _usecases_mit(token: str) -> list[dict]:
    anfrage = urllib.request.Request(f"{USECASE_DIENST}/api/UseCases",
                                     headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    with urllib.request.urlopen(anfrage, timeout=10) as antwort:
        return json.loads(antwort.read() or b"[]")


async def _anmeldung_pruefen(authorization: str | None, use_case_id: str):
    """gaeco entscheiden lassen, ob dieser Aufruf in diesen UseCase darf."""
    if OHNE_ANMELDUNG:
        return
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="gaeco-Token fehlt (Authorization: Bearer …).")
    token = authorization[7:].strip()
    try:
        sichtbar = await asyncio.to_thread(_usecases_mit, token)
    except HTTPError as e:
        if e.code in (401, 403):
            raise HTTPException(status_code=401, detail="gaeco hat das Token abgewiesen.")
        raise HTTPException(status_code=502, detail=f"gaeco UseCase-Dienst: HTTP {e.code}")
    except (URLError, TimeoutError, OSError) as e:
        raise HTTPException(status_code=503, detail=f"gaeco UseCase-Dienst nicht erreichbar ({USECASE_DIENST}): {e}")
    if not any(str(u.get("id")) == use_case_id for u in (sichtbar or [])):
        raise HTTPException(status_code=403, detail="Dieser UseCase ist für das Token in gaeco nicht sichtbar.")

_STAENDE: dict[str, dict] = {}
_OFFSETS: dict[str, dict[int, int]] = {}      # je Export: Partition → letzter gesendeter Offset
_SPERRE = asyncio.Semaphore(1)
_INDEX: dict = {"index": None, "mtime": None}


class ExportAuftrag(BaseModel):
    use_case_id: str
    mit_psets: bool = True
    # „betrieb": Struktur, Räume und TGA — gaeco ist die Verknüpfungsschicht, nicht die Ablage
    # des Modells. „voll" überträgt jedes Bauteil und ist für große Modelle nicht bedienbar.
    profil: str = "betrieb"
    zusaetzlich: list[str] = []     # weitere IFC-Klassen zum Betriebsprofil, z. B. IfcDoor


def _index() -> gaeco_export.GuidelineIndex:
    """Den Guideline-Index laden — einmal, und neu, wenn die Datei sich ändert."""
    pfad = gaeco_export.INDEX_PFAD
    mtime = pfad.stat().st_mtime if pfad.exists() else None
    if _INDEX["index"] is None or _INDEX["mtime"] != mtime:
        _INDEX["index"] = gaeco_export.GuidelineIndex.laden(pfad)
        _INDEX["mtime"] = mtime
    return _INDEX["index"]


async def _exportieren(job_id: str, auftrag: ExportAuftrag):
    stand = _STAENDE[job_id]
    try:
        async with _SPERRE:
            stand.update(zustand="laeuft", schritt="IFC-Quelle holen")
            src = await asyncio.to_thread(planroute._local_source, job_id)
            index = _index()

            def rechnen():
                import ifcopenshell
                datei = ifcopenshell.open(str(src))
                graph = gaeco_export.graph_aus_ifc(datei, index, mit_psets=auftrag.mit_psets,
                                                   profil=auftrag.profil,
                                                   zusaetzlich=tuple(auftrag.zusaetzlich))
                return graph, gaeco_export.nachrichten(graph, auftrag.use_case_id)

            stand["schritt"] = "Graph bilden"
            graph, teile = await asyncio.to_thread(rechnen)
            stand.update(
                schritt="an gaeco senden", knoten=len(graph.knoten), kanten=len(graph.kanten),
                nachrichten=len(teile), hinweise=graph.hinweise[:200],
                guideline=index.quelle,
            )
            ergebnis = await gaeco_export.senden(teile, auftrag.use_case_id, BROKER)
            _OFFSETS[job_id] = ergebnis["offsets"]
            stand.update(zustand="fertig", schritt="", topic=ergebnis["topic"],
                         bytes=ergebnis["bytes"], ende=time.time(), gaeco="wartet")
            logger.info(f"[{job_id}] nach gaeco: {len(graph.knoten)} Knoten, "
                        f"{len(graph.kanten)} Kanten, {len(teile)} Nachricht(en) → {ergebnis['topic']}")
    except HTTPException as e:
        stand.update(zustand="fehler", fehler=str(e.detail), ende=time.time())
    except Exception as e:
        logger.exception(f"[{job_id}] gaeco-Export gescheitert")
        stand.update(zustand="fehler", fehler=f"{type(e).__name__}: {e}", ende=time.time())


@router.post("/export/{job_id}")
async def export_starten(job_id: str, auftrag: ExportAuftrag,
                         authorization: str | None = Header(default=None)):
    """Ein IFC-Modell als Instanzgraph in den UseCase übertragen."""
    try:
        uuid.UUID(auftrag.use_case_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="use_case_id ist keine UUID")
    if auftrag.profil not in gaeco_export.PROFILE:
        raise HTTPException(status_code=422, detail=f"profil muss eines von {gaeco_export.PROFILE} sein")
    if not all(re.fullmatch(r"Ifc[A-Za-z0-9]+", k) for k in auftrag.zusaetzlich):
        raise HTTPException(status_code=422, detail="zusaetzlich nennt IFC-Klassen wie IfcDoor")
    await _anmeldung_pruefen(authorization, auftrag.use_case_id)
    if not BROKER:
        raise HTTPException(
            status_code=503,
            detail="Kein Kafka-Broker eingestellt (ILEEN_KAFKA_BROKER). gaeco starten und das "
                   "Backend im Netz gaeco-local betreiben — siehe GAECO-INTEGRATION.md.")
    jetzt = _STAENDE.get(job_id)
    if jetzt and jetzt.get("zustand") in ("wartet", "laeuft"):
        raise HTTPException(status_code=409, detail="Für dieses Modell läuft bereits ein Export.")
    _STAENDE[job_id] = {
        "job_id": job_id, "use_case_id": auftrag.use_case_id, "zustand": "wartet",
        "profil": auftrag.profil,
        "schritt": "", "beginn": time.time(), "topic": gaeco_export.topic(auftrag.use_case_id),
    }
    asyncio.create_task(_exportieren(job_id, auftrag))
    return _STAENDE[job_id]



class LiegenschaftModell(BaseModel):
    schluessel: str
    name: str
    job_id: str
    ort: str | None = None
    land: str | None = None


class LiegenschaftenAuftrag(BaseModel):
    use_case_id: str
    portfolio_schluessel: str = "hsm-liegenschaften"
    portfolio_name: str = "Liegenschaften"
    modelle: list[LiegenschaftModell]


@router.post("/liegenschaften")
async def liegenschaften_senden(auftrag: LiegenschaftenAuftrag,
                                authorization: str | None = Header(default=None)):
    """IFC-Modelle als IBPDI-Portfolio (Portfolio, Gebäude, Adresse, Geschosse, Räume) nach gaeco."""
    try:
        uuid.UUID(auftrag.use_case_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="use_case_id ist keine UUID")
    await _anmeldung_pruefen(authorization, auftrag.use_case_id)
    if not BROKER:
        raise HTTPException(status_code=503, detail="Kein Kafka-Broker eingestellt (ILEEN_KAFKA_BROKER).")

    def rechnen():
        import ifcopenshell
        modelle = []
        for m in auftrag.modelle:
            ort = json.loads(urllib.request.urlopen(
                f"http://localhost:8100/assets/{m.job_id}/placement", timeout=30).read())
            modelle.append({**m.model_dump(), "lat": ort["lat"], "lon": ort["lon"],
                            "datei": ifcopenshell.open(str(planroute._local_source(m.job_id)))})
        graph = gaeco_liegenschaften.graph_liegenschaften(
            {"schluessel": auftrag.portfolio_schluessel, "name": auftrag.portfolio_name}, modelle)
        return graph, gaeco_export.nachrichten(graph, auftrag.use_case_id)

    graph, teile = await asyncio.to_thread(rechnen)
    ergebnis = await gaeco_export.senden(teile, auftrag.use_case_id, BROKER)
    klassen: dict[str, int] = {}
    for k in graph.knoten:
        klassen[k.ifc_typ] = klassen.get(k.ifc_typ, 0) + 1
    logger.info(f"Liegenschaften nach gaeco: {len(graph.knoten)} Knoten, {len(graph.kanten)} Kanten")
    return {"knoten": len(graph.knoten), "kanten": len(graph.kanten), "klassen": klassen,
            "hinweise": graph.hinweise, "topic": ergebnis["topic"], "offsets": ergebnis["offsets"]}

@router.get("/aufraeumen/{job_id}")
async def aufraeumen_liste(job_id: str, profil: str = "betrieb", zusaetzlich: str = ""):
    """
    Die gaeco-Kennungen, die ein früherer Voll-Export angelegt hat und das Profil
    nicht will (siehe `gaeco_export.ueberzaehlige`). Rechnet nur, löscht nichts:
    gelöscht wird in gaeco, mit dem Token dessen, der es darf
    (`gaeco/aufraeumen.py`).
    """
    if profil not in gaeco_export.PROFILE:
        raise HTTPException(status_code=422, detail=f"profil muss eines von {gaeco_export.PROFILE} sein")
    klassen = tuple(k for k in zusaetzlich.split(",") if k)
    if not all(re.fullmatch(r"Ifc[A-Za-z0-9]+", k) for k in klassen):
        raise HTTPException(status_code=422, detail="zusaetzlich nennt IFC-Klassen wie IfcDoor, durch Komma getrennt")
    src = await asyncio.to_thread(planroute._local_source, job_id)
    index = _index()

    def rechnen():
        import ifcopenshell
        return gaeco_export.ueberzaehlige(ifcopenshell.open(str(src)), index, profil, klassen)

    ergebnis = await asyncio.to_thread(rechnen)
    return {"job_id": job_id, "guideline": index.quelle, **ergebnis}


_DETAIL: dict[str, tuple[float, bytes]] = {}     # job → (mtime der Quelle, fertiges JSON)


@router.get("/detail/{job_id}")
async def detail(job_id: str, max_gruppe: int = gaeco_detail.MAX_GRUPPE):
    """
    Der Detailgraph eines Modells — jedes Bauteil, gegliedert in Gruppen mit beliebig vielen
    Ebenen (`ileen/gaeco_detail.py`). Er geht **nicht** nach gaeco: gaeco hält das Betriebsprofil,
    SPIDER legt beides über die gemeinsame Kennung `uuid5(GlobalId)` übereinander.

    Rein lesend, ohne gaeco-Token: das Modell gehört iLEEN, und die Antwort enthält nur,
    was die Bauteilliste des Viewers ohnehin zeigt. Das Ergebnis liegt im Speicher, bis sich die
    Quelldatei ändert — die Rechnung ist schnell, das Öffnen eines großen IFC nicht.
    """
    if not 8 <= max_gruppe <= 500:
        raise HTTPException(status_code=422, detail="max_gruppe muss zwischen 8 und 500 liegen")
    src = await asyncio.to_thread(planroute._local_source, job_id)
    stand = src.stat().st_mtime
    schluessel = f"{job_id}:{max_gruppe}"
    gemerkt = _DETAIL.get(schluessel)
    if gemerkt and gemerkt[0] == stand:
        return Response(content=gemerkt[1], media_type="application/json")
    index = _index()

    def rechnen() -> bytes:
        import ifcopenshell
        graph = gaeco_detail.detail_graph(ifcopenshell.open(str(src)), index, max_gruppe)
        graph["job_id"] = job_id
        return json.dumps(graph, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    async with _SPERRE:       # das Öffnen eines großen IFC kostet Gigabytes — nicht neben einem Export
        koerper = await asyncio.to_thread(rechnen)
    _DETAIL[schluessel] = (stand, koerper)
    return Response(content=koerper, media_type="application/json")


NICHT_ABONNIERT = ("gaecos instance-server liest dieses Topic nicht — er legt sein Abonnement nur beim "
                   "Start fest. Abhilfe: python3 gaeco/einrichten.py (legt das Topic an und startet "
                   "ihn neu) oder in ~/Projekte/gaeco: docker compose restart instance-server.")


async def _gaeco_nachsehen(job_id: str, stand: dict):
    """Fragt höchstens alle zwei Sekunden beim Broker nach, ob gaeco übernommen hat."""
    if stand.get("zustand") != "fertig" or stand.get("gaeco") == "uebernommen" or job_id not in _OFFSETS:
        return
    if time.time() - stand.get("_gefragt", 0) < 2:
        return
    stand["_gefragt"] = time.time()
    try:
        lage = await gaeco_export.lesestand(stand["use_case_id"], _OFFSETS[job_id], BROKER)
    except Exception as e:
        stand.update(gaeco="unbekannt", gaeco_hinweis=f"Broker nicht befragbar: {e}")
        return
    if lage["uebernommen"]:
        stand.update(gaeco="uebernommen", gaeco_hinweis=None, gaeco_ende=time.time())
    elif not lage["abonniert"]:
        stand.update(gaeco="nicht_abonniert", gaeco_hinweis=NICHT_ABONNIERT)
    else:
        stand.update(gaeco="in_arbeit", gaeco_hinweis=None)


@router.get("/export/{job_id}")
async def export_stand(job_id: str):
    """
    Stand des Exports. Nach `zustand: fertig` (gesendet) folgt `gaeco`:
    `wartet` → `in_arbeit` → `uebernommen`, oder `nicht_abonniert` mit Hinweis.
    """
    stand = _STAENDE.get(job_id)
    if not stand:
        raise HTTPException(status_code=404, detail="Für dieses Modell lief noch kein Export.")
    await _gaeco_nachsehen(job_id, stand)
    return {k: v for k, v in stand.items() if not k.startswith("_")}


@router.get("/stand")
async def stand():
    index = _index()
    return {
        "broker": BROKER or None,
        "anmeldung": "aus" if OHNE_ANMELDUNG else f"über gaeco ({USECASE_DIENST})",
        "guideline_index": index.quelle,
        "klassen": len(index.klassen) if index.klassen is not None else None,
        "eigenschaften": len(index.eigenschaften),
        "exporte": [{k: v for k, v in s.items() if not k.startswith("_")} for s in _STAENDE.values()],
    }


@router.get("/id/{global_id}")
async def kennung(global_id: str):
    """Die Regel als Dienst — für Werkzeuge, die kein UUIDv5 rechnen können."""
    return {"global_id": global_id, "instanz_id": gaeco_export.instanz_id(global_id)}
