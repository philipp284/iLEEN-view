"""
Das statische System ändern — Eingriff für Eingriff.

`tragwerk.py` rechnet, was aus dem IFC abgeleitet wurde. Diese Route ändert,
*was* abgeleitet wurde: welche Wand trägt, wie sie gelagert ist, wo ein Lager
fehlt. Die Fachlogik steht in `ileen/eingriffe.py`; hier steht nur, wie man sie
über HTTP erreicht und wo sie liegt.

    GET    /assets/{job}/tragwerk/eingriffe            alle Eingriffe
    GET    /assets/{job}/tragwerk/eingriffe/arten      Katalog der Eingriffsarten
    POST   /assets/{job}/tragwerk/eingriffe            einen anlegen
    DELETE /assets/{job}/tragwerk/eingriffe/{nr}       einen aufheben

## Der Weg, für den das gebaut ist

    1. Gesamtsystem rechnen   → das abgeleitete System, mit seinen Fehlern
    2. Im FE-Browser in ein Submodell einsteigen
    3. Eingriff               → „diese Wand trägt nicht"
    4. Das Submodell und alles darunter steht auf „veraltet"
    5. Neu rechnen            → **jetzt** gilt die neue Lastverteilung

Schritt 4 ist der Grund, warum es hier keine Versionsverwaltung mehr gibt. Ein
Eingriff ist eine Entscheidung, kein Vorschlag: er gilt, sobald er da ist. Ob
die Zahlen daneben noch zu ihm passen, beantwortet nicht ein Merkmal, das
jemand setzen müsste, sondern der Eingabe-Hash des Submodells — und der kann
nicht vergessen werden.

## Warum ein Eingriff für sich noch keine Zahl ändert

Eine Änderung am System des ersten Obergeschosses ändert die Auflagerkräfte
seiner Decke, damit die Fußkräfte der Wände darunter, damit die Linienlasten
auf die Decke des Erdgeschosses und zuletzt die Gründungslasten. Diese
Fortpflanzung schreibt niemand auf — sie entsteht daraus, dass die Kette in
einem Zug von oben nach unten rechnet und jedes Geschoss aus dem hervorgeht,
was das darüber abgegeben hat. Bis dieser Zug gelaufen ist, sind die
angezeigten Zahlen die alten, und das Submodell sagt das.

## Warum ein Eingriff aufgehoben und nicht bearbeitet wird

Ein bearbeiteter Eingriff wäre zwei Entscheidungen unter einer Nummer. Wer in
einem halben Jahr fragt, warum diese Wand doch trägt, findet dann nur die
letzte Fassung. Aufheben und neu anlegen kostet einen Klick mehr und hält den
Verlauf lesbar.
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.routes.tragwerk import eingriffe_lesen, eingriffe_schreiben
from ileen import eingriffe as eg

logger = logging.getLogger(__name__)

router = APIRouter()


class EingriffAnfrage(BaseModel):
    """Eine Änderung am statischen System."""

    art: str = Field(..., description="; ".join(f"{k}: {v}"
                                                for k, v in eg.EINGRIFFSARTEN.items()))
    bauteil: str | None = Field(
        None, description="GlobalId des Bauteils — der Anker des Eingriffs. "
                          "Nicht die Lagerkennung: die wird bei jedem Lauf neu vergeben.")
    submodell: str | None = Field(
        None, description="Nur in diesem Submodell (`submodell.OG2`). Ohne Angabe "
                          "gilt der Eingriff überall — eine GlobalId gibt es nur "
                          "einmal im Bauwerk.")
    wert: dict | None = Field(None, description="Artabhängig, siehe `art`")
    notiz: str | None = Field(None, description="Warum — steht später im Bericht")


@router.get("/{job_id}/tragwerk/eingriffe/arten", tags=["Tragwerk"])
async def arten(job_id: str):
    """Was ein Eingriff sein kann — der Katalog für die Oberfläche."""
    from ileen.raumlasten import NUTZLASTEN
    return {
        "arten": [{"art": a, "beschreibung": t} for a, t in eg.EINGRIFFSARTEN.items()],
        "lagerarten": list(eg.LAGERARTEN),
        # Die erlaubten Werte von `nutzlast_raum` — dieselbe Tabelle, gegen die
        # der Lastabtrag rechnet, damit die Auswahl im Steckbrief keine
        # Kategorie anbietet, die `pruefe()` dann ablehnt.
        "nutzlastkategorien": [{"kategorie": k, "q_k_kNm2": w, "beschreibung": t}
                               for k, (w, t) in NUTZLASTEN.items()],
    }


@router.get("/{job_id}/tragwerk/eingriffe", tags=["Tragwerk"])
async def liste(job_id: str, submodell: str | None = None):
    """
    Alle Eingriffe dieses Modells.

    Mit `submodell` gefiltert auf die, die dort greifen — das schließt die
    ohne Ortsangabe ein, denn die gelten überall.
    """
    bestand = eingriffe_lesen(job_id)
    if submodell:
        bestand = eg.fuer_submodell(bestand, submodell)
    return {"eingriffe": bestand}


@router.post("/{job_id}/tragwerk/eingriffe", tags=["Tragwerk"], status_code=201)
async def anlegen(job_id: str, anfrage: EingriffAnfrage):
    """
    Einen Eingriff anlegen.

    Geprüft wird sofort und hier: ein unsinniger Eingriff soll mit 422 enden
    und nicht drei Geschosse später im Protokoll eines Laufs auftauchen.
    """
    try:
        geprueft = eg.pruefe(anfrage.model_dump(exclude_none=True))
    except ValueError as fehler:
        raise HTTPException(status_code=422, detail=str(fehler))

    bestand = eingriffe_lesen(job_id)
    # Fortlaufend und nie wiederverwendet: eine aufgehobene Nummer bliebe
    # sonst in einem alten Rechenstand stehen und zeigte dort auf einen
    # anderen Eingriff.
    naechste = max((int(e.get("nr") or 0) for e in bestand), default=0) + 1
    geprueft["nr"] = naechste
    geprueft["angelegt"] = eg.jetzt()
    geprueft["titel"] = eg.titel(geprueft)
    bestand.append(geprueft)
    eingriffe_schreiben(job_id, bestand)
    logger.info("[%s] Eingriff %s: %s", job_id, naechste, geprueft["titel"])
    return geprueft


@router.delete("/{job_id}/tragwerk/eingriffe/{nr}", tags=["Tragwerk"])
async def aufheben(job_id: str, nr: int):
    """Einen Eingriff aufheben. Das System gilt danach wieder wie abgeleitet."""
    bestand = eingriffe_lesen(job_id)
    uebrig = [e for e in bestand if int(e.get("nr") or 0) != nr]
    if len(uebrig) == len(bestand):
        raise HTTPException(
            status_code=404,
            detail=f"Eingriff {nr} gibt es für dieses Modell nicht. Vorhanden: "
                   f"{', '.join(str(e.get('nr')) for e in bestand) or 'keiner'}.")
    eingriffe_schreiben(job_id, uebrig)
    return {"aufgehoben": nr, "verbleibend": len(uebrig)}
