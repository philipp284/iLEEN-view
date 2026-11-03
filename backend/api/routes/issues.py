"""
Themenverwaltung — Notizen, Messungen und BCF-Issues an einer Stelle.

    GET    /issues                        Liste, filterbar
    POST   /issues                        anlegen (auch aus dem Viewer)
    GET    /issues/zahlen                 Überblick für die Oberfläche
    GET    /issues/bcf                    alles (oder gefiltert) als .bcfzip
    POST   /issues/bcf                    ein .bcfzip einlesen
    GET    /issues/bericht                HTML-Bericht
    GET    /issues/{guid}                 ein Thema samt Verlauf
    PATCH  /issues/{guid}                 ändern → neue Version
    DELETE /issues/{guid}                 weich löschen (?endgueltig=true räumt)
    POST   /issues/{guid}/kommentare      kommentieren
    GET    /issues/{guid}/versionen       Verlauf
    GET    /issues/{guid}/versionen/{n}   ein Stand mit vollem Abbild
    POST   /issues/{guid}/zuruecksetzen/{n}
    POST   /issues/{guid}/ansichten       Kamera + Bauteile + Schnappschuss
    GET    /issues/{guid}/ansichten/{a}/bild
    GET    /issues/{guid}/bcf             ein einzelnes Thema als Paket

**Die Reihenfolge der Routen ist Teil der Zusicherung.** `/issues/bcf` steht
vor `/issues/{guid}`, sonst liest FastAPI „bcf" als GUID und antwortet mit 404
auf einen Export, der nie beim Exporteur ankommt.

Warum das Backend und nicht weiter der localStorage
===================================================
Der Viewer konnte Notizen schon immer anlegen und als BCF ausgeben — aber nur
für sich: kein zweiter Rechner sah sie, kein Verlauf, kein Import. Themen sind
das, worüber auf einer Baustelle gesprochen wird; sie gehören dorthin, wo mehr
als ein Browser hinkommt.

**Diese Ablage ist der Zwischenschritt.** Die Datenhaltung soll nach gaeco
wandern, angebunden über Kafka. Dieser Router ruft deshalb ausschließlich
`ileen.issues_db` auf und kennt weder SQL noch Dateipfade; wer die Ablage
tauscht, tauscht genau ein Modul.
"""

import logging

from fastapi import APIRouter, Body, File, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse, Response

from ileen import issues_bericht, issues_db

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Liste und Anlegen ────────────────────────────────────────────────────────

@router.get("", include_in_schema=True)
@router.get("/", include_in_schema=False)
def themen_liste(
    status: str | None = Query(None, description="Open | InProgress | Closed | ReOpened"),
    typ: str | None = Query(None, description="Issue | Info | Clash | …"),
    ifc_guid: str | None = Query(None, description="nur Themen zu diesem Bauteil"),
    modell: str | None = None,
    suche: str | None = None,
    quelle: str | None = Query(None, description="viewer | bcf-import | …"),
    mit_geloeschten: bool = False,
    grenze: int = Query(1000, ge=1, le=5000),
):
    themen = issues_db.liste(status=status, typ=typ, ifc_guid=ifc_guid, modell=modell,
                             suche=suche, quelle=quelle, mit_geloeschten=mit_geloeschten,
                             grenze=grenze)
    return {"anzahl": len(themen), "themen": themen}


@router.post("", include_in_schema=True, status_code=201)
@router.post("/", include_in_schema=False, status_code=201)
def thema_anlegen(daten: dict = Body(...)):
    """
    Ein Thema anlegen. Der Viewer schickt hier seine Notiz hinein — mit
    derselben GUID, unter der sie dort schon liegt.
    """
    autor = daten.get("autor") or "iLEEN"
    quelle = daten.get("quelle") or "viewer"
    return issues_db.anlegen(daten, autor=autor, quelle=quelle)


@router.get("/zahlen")
def zahlen():
    return issues_db.zahlen()


# ── BCF (vor `/{guid}`, siehe Modulkopf) ─────────────────────────────────────

@router.get("/bcf")
def bcf_export(status: str | None = None, typ: str | None = None,
               ifc_guid: str | None = None, dateiname: str = "ileen-themen"):
    daten = issues_db.paket_bauen(None, status=status, typ=typ, ifc_guid=ifc_guid)
    return Response(
        content=daten, media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{dateiname}.bcfzip"'})


@router.post("/bcf")
async def bcf_import(file: UploadFile = File(..., description=".bcf / .bcfzip"),
                     autor: str = "BCF-Import"):
    roh = await file.read()
    if not roh:
        raise HTTPException(status_code=400, detail="Leere Datei.")
    try:
        bericht = issues_db.paket_einlesen(roh, autor=autor)
    except Exception as fehler:
        logger.exception("BCF-Import gescheitert")
        raise HTTPException(status_code=422,
                            detail=f"Das Paket ließ sich nicht lesen: {fehler}") from fehler
    if not bericht["gesamt"]:
        raise HTTPException(status_code=422,
                            detail="Kein einziges Thema im Paket — ist es wirklich BCF?")
    return bericht


@router.get("/bericht", response_class=HTMLResponse)
def bericht(status: str | None = None, typ: str | None = None,
            ifc_guid: str | None = None, titel: str = "Themen"):
    themen = [issues_db.holen(t["guid"], mit_verlauf=True, mit_bild=True)
              for t in issues_db.liste(status=status, typ=typ, ifc_guid=ifc_guid)]
    hinweis = " · ".join(filter(None, [
        f"Status {status}" if status else "",
        f"Typ {typ}" if typ else "",
        f"Bauteil {ifc_guid}" if ifc_guid else "",
    ]))
    return HTMLResponse(issues_bericht.html_bericht([t for t in themen if t], titel, hinweis))


# ── Einzelnes Thema ──────────────────────────────────────────────────────────

@router.get("/{guid}")
def thema(guid: str, mit_verlauf: bool = True):
    t = issues_db.holen(guid, mit_verlauf=mit_verlauf)
    if not t:
        raise HTTPException(status_code=404, detail="Kein Thema mit dieser GUID.")
    return t


@router.patch("/{guid}")
def thema_aendern(guid: str, daten: dict = Body(...)):
    autor = daten.pop("autor", None) or "iLEEN"
    grund = daten.pop("grund", None)
    t = issues_db.aendern(guid, daten, autor=autor, grund=grund)
    if not t:
        raise HTTPException(status_code=404, detail="Kein Thema mit dieser GUID.")
    return t


@router.delete("/{guid}")
def thema_loeschen(guid: str, autor: str = "iLEEN", endgueltig: bool = False):
    if not issues_db.loeschen(guid, autor=autor, endgueltig=endgueltig):
        raise HTTPException(status_code=404, detail="Kein Thema mit dieser GUID.")
    return {"geloescht": guid, "endgueltig": endgueltig}


@router.get("/{guid}/bcf")
def thema_bcf(guid: str):
    if not issues_db.holen(guid, mit_verlauf=False):
        raise HTTPException(status_code=404, detail="Kein Thema mit dieser GUID.")
    return Response(
        content=issues_db.paket_bauen([guid]), media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="thema-{guid[:8]}.bcfzip"'})


# ── Kommentare, Ansichten, Verlauf ───────────────────────────────────────────

@router.post("/{guid}/kommentare", status_code=201)
def kommentieren(guid: str, daten: dict = Body(...)):
    k = issues_db.kommentieren(guid, daten.get("text") or "",
                               daten.get("autor") or "iLEEN", daten.get("ansicht_guid"))
    if not k:
        raise HTTPException(status_code=404,
                            detail="Kein Thema mit dieser GUID — oder leerer Text.")
    return k


@router.post("/{guid}/ansichten", status_code=201)
def ansicht_anlegen(guid: str, daten: dict = Body(...)):
    """
    Eine Ansicht: Kamera, betroffene Bauteile, Schnappschuss.

    Das Bild kommt als Data-URI, wie `canvas.toDataURL()` es liefert — der
    Viewer hat es ohnehin in dieser Form, und eine multipart-Grenze für ein
    paar hundert Kilobyte Screenshot wäre Aufwand ohne Gegenwert.
    """
    bild, bild_typ = _bild_aus_datauri(daten.get("bild"))
    a = issues_db.ansicht_anlegen(guid, daten.get("kamera"), daten.get("komponenten"),
                                  bild, bild_typ, daten.get("guid"))
    if not a:
        raise HTTPException(status_code=404, detail="Kein Thema mit dieser GUID.")
    return a


@router.get("/{guid}/ansichten/{ansicht_guid}/bild")
def ansicht_bild(guid: str, ansicht_guid: str):
    treffer = issues_db.ansicht_bild(guid, ansicht_guid)
    if not treffer:
        raise HTTPException(status_code=404, detail="Diese Ansicht hat kein Bild.")
    daten, typ = treffer
    return Response(content=daten, media_type=typ,
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/{guid}/versionen")
def versionen(guid: str):
    t = issues_db.holen(guid, mit_verlauf=True)
    if not t:
        raise HTTPException(status_code=404, detail="Kein Thema mit dieser GUID.")
    return {"guid": guid, "stand": t["stand"], "verlauf": t.get("verlauf") or []}


@router.get("/{guid}/versionen/{stand}")
def version(guid: str, stand: int):
    v = issues_db.version(guid, stand)
    if not v:
        raise HTTPException(status_code=404, detail="Diesen Stand gibt es nicht.")
    return v


@router.post("/{guid}/zuruecksetzen/{stand}")
def zuruecksetzen(guid: str, stand: int, autor: str = "iLEEN"):
    t = issues_db.zuruecksetzen(guid, stand, autor=autor)
    if not t:
        raise HTTPException(status_code=404, detail="Diesen Stand gibt es nicht.")
    return t


def _bild_aus_datauri(uri):
    """`data:image/png;base64,…` → (bytes, mimetype). Alles andere ergibt None."""
    if not uri or not isinstance(uri, str) or not uri.startswith("data:"):
        return None, None
    import base64
    try:
        kopf, nutzlast = uri.split(",", 1)
        typ = kopf[5:].split(";")[0] or "image/png"
        return base64.b64decode(nutzlast), typ
    except (ValueError, TypeError):
        return None, None
