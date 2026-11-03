"""
Splat-Training: Fotos oder ein ZIP hochladen, ein verorteter Gaussian Splat kommt heraus.

Die Route rechnet nichts. Sie legt Aufträge in die Warteschlange (`splatwerk/auftrag.py`,
ein Verzeichnis), die der Worker auf dem Mac abarbeitet — COLMAP und Brush brauchen die
Metal-GPU, die Docker Desktop nicht durchreicht. Dazu kommt die zweite Hälfte: sobald der
Worker `trainiert` meldet, nimmt eine Schleife im Container den Splat in die Kachel-
Pipeline auf und verortet ihn (`splatwerk/uebernahme.py`).

    POST   /splat-training                   Dateien (Bilder, Videos, ZIP) + Name, Qualität, Verfahren, Mesh
    GET    /splat-training                   Worker-Zustand und alle Aufträge
    GET    /splat-training/{id}              ein Auftrag mit Protokollende
    GET    /splat-training/{id}/log          das ganze Protokoll
    POST   /splat-training/{id}/abbrechen
    POST   /splat-training/{id}/wiederholen  nach Fehler oder Abbruch erneut einreihen
    DELETE /splat-training/{id}              Auftrag samt Dateien entfernen (nicht das Asset)
"""

import asyncio
import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

from splatwerk import auftrag as A

logger = logging.getLogger(__name__)

router = APIRouter()

_CHUNK = 8 * 1024 * 1024
# Begleitdateien (JSON, CSV) gehören zu Aufnahmepaketen von Aufnahme-Apps (`splatwerk/splatpack.py`).
# Allein sind sie nichts wert; ohne mindestens ein Medium wird der Upload abgelehnt.
_BEGLEIT = {".json", ".csv", ".ndjson"}
_MEDIEN = A.BILD_ENDUNGEN | A.VIDEO_ENDUNGEN | {".zip"}
_ERLAUBT = _MEDIEN | _BEGLEIT


def _kurz(a: dict) -> dict:
    """Auftrag ohne die Dinge, die eine Liste nur aufblähen (Bericht der Stufen, Dateiliste)."""
    return {k: v for k, v in a.items() if k not in ("bericht", "fertig_stufen")}


def _hole(auftrag_id: str) -> dict:
    try:
        a = A.lese(auftrag_id)
    except ValueError:
        a = None
    if a is None:
        raise HTTPException(status_code=404, detail=f"Auftrag '{auftrag_id}' unbekannt.")
    return a


@router.post("")
async def anlegen(
    files: list[UploadFile] = File(..., description="Bilder, Videos oder ZIP-Archive — Ordnerpfade im Dateinamen bleiben erhalten"),
    name: str = Form(""),
    qualitaet: str = Form("standard"),
    verfahren: str = Form("colmap", description="colmap (lokal) oder atlas (World Labs: Kameras + Tiefe)"),
    mesh: bool = Form(False, description="danach ein Mesh über World Labs splats2Mesh"),
    mesh_ansicht: str = Form("aufnahme", description="aufnahme · auto · aussen"),
    fenster: bool = Form(False, description="Das Fenster von Spirula Studio mit dem Trainingsstand öffnen (auf dem Mac)"),
):
    if qualitaet not in A.QUALITAET:
        raise HTTPException(status_code=422, detail=f"Qualität '{qualitaet}' unbekannt. Erlaubt: {', '.join(A.QUALITAET)}")
    if verfahren not in A.VERFAHREN:
        raise HTTPException(status_code=422, detail=f"Verfahren '{verfahren}' unbekannt. Erlaubt: {', '.join(A.VERFAHREN)}")
    if verfahren == "atlas" or mesh:
        # Vor dem Hochladen von Gigabytes: ohne Schlüssel scheitert der Auftrag ohnehin.
        from splatwerk import worldlabs as W
        if not W.schluessel()[0]:
            raise HTTPException(status_code=412, detail="Kein World-Labs-Schlüssel — einmal im eigenen Terminal "
                                                        "`worldlabs auth login` ausführen, dann erneut senden.")
    angenommen = [f for f in files if f.filename and Path(f.filename).suffix.lower() in _ERLAUBT]
    medien = [f for f in angenommen if Path(f.filename).suffix.lower() in _MEDIEN]
    if not medien:
        raise HTTPException(status_code=415, detail="Kein brauchbares Bild, Video oder ZIP dabei "
                                                    "(erwartet: JPG, PNG, HEIC, TIF, MP4, MOV, ZIP).")
    oberste = {A.sauberer_pfad(f.filename).split("/")[0] for f in angenommen if "/" in A.sauberer_pfad(f.filename)}
    if len(medien) == 1:
        standardname = Path(medien[0].filename).stem
    elif len(oberste) == 1:
        standardname = oberste.pop()                      # ein Ordner: sein Name
    else:
        standardname = f"{len(medien)} Fotos"
    # Der Worker nimmt nur `wartet` auf. Bis das letzte Byte da ist, heißt der Auftrag `laedt`.
    auftrag = A.neu(name.strip() or standardname, qualitaet, status="laedt",
                    optionen={"verfahren": verfahren, "mesh": bool(mesh), "fenster": bool(fenster),
                              "mesh_ansicht": mesh_ansicht if mesh_ansicht in ("aufnahme", "auto", "aussen") else "aufnahme"})
    ziel = A.verzeichnis(auftrag["id"]) / "eingang"

    summe, belegt = 0, set()
    try:
        for f in angenommen:
            roh = A.sauberer_pfad(f.filename)
            stamm, endung = (Path(roh).parent / Path(roh).stem).as_posix().lstrip("./"), Path(roh).suffix
            n, zielname = 1, roh
            while zielname.lower() in belegt:          # gleichnamige Dateien am selben Ort
                n += 1
                zielname = f"{stamm}_{n}{endung}"
            belegt.add(zielname.lower())
            (ziel / zielname).parent.mkdir(parents=True, exist_ok=True)
            with (ziel / zielname).open("wb") as out:
                while chunk := await f.read(_CHUNK):
                    out.write(chunk)
                    summe += len(chunk)
    except Exception:
        shutil.rmtree(A.verzeichnis(auftrag["id"]), ignore_errors=True)
        raise
    if summe == 0:
        shutil.rmtree(A.verzeichnis(auftrag["id"]), ignore_errors=True)
        raise HTTPException(status_code=400, detail="Die Dateien sind leer.")

    A.schreibe(auftrag["id"], status="wartet", stufe="wartet", meldung="Wartet auf den Worker.",
               dateien=len(angenommen), bytes=summe)
    logger.info(f"[{auftrag['id'][:8]}] Splat-Training angelegt: {len(angenommen)} Datei(en), "
                f"{summe / 1e6:.1f} MB, Qualität {qualitaet}, Verfahren {verfahren}{', Mesh' if mesh else ''}")
    return _kurz(A.lese(auftrag["id"]))


@router.get("")
async def liste():
    return {"worker": A.worker_stand(), "auftraege": [_kurz(a) for a in A.alle()]}


@router.get("/{auftrag_id}")
async def eines(auftrag_id: str):
    a = _hole(auftrag_id)
    return {**_kurz(a), "stufen": a.get("fertig_stufen") or [], "bericht": a.get("bericht") or {},
            "log": A.log_ende(auftrag_id, 30)}


@router.get("/{auftrag_id}/log", response_class=PlainTextResponse)
async def log(auftrag_id: str):
    _hole(auftrag_id)
    pfad = A.verzeichnis(auftrag_id) / "log.txt"
    return pfad.read_text(encoding="utf-8", errors="replace") if pfad.exists() else ""


@router.post("/{auftrag_id}/abbrechen")
async def abbrechen(auftrag_id: str):
    a = _hole(auftrag_id)
    if a["status"] in A.ENDSTATI:
        raise HTTPException(status_code=409, detail=f"Der Auftrag ist schon {a['status']}.")
    A.abbruch_anfordern(auftrag_id)
    if a["status"] in ("wartet", "laedt"):
        # Nimmt der Worker ihn nicht auf, entscheidet niemand sonst — also gleich abschließen.
        A.schreibe(auftrag_id, status="abgebrochen", meldung="Abgebrochen.")
    else:
        A.schreibe(auftrag_id, meldung="Wird abgebrochen…")
    return _kurz(A.lese(auftrag_id))


@router.post("/{auftrag_id}/wiederholen")
async def wiederholen(auftrag_id: str):
    a = _hole(auftrag_id)
    if a["status"] not in ("fehler", "abgebrochen"):
        raise HTTPException(status_code=409, detail="Nur gescheiterte oder abgebrochene Aufträge lassen sich wiederholen.")
    (A.verzeichnis(auftrag_id) / "abbruch").unlink(missing_ok=True)
    if a.get("stufe") == "uebernahme":
        # Das Training war fertig, nur die Übernahme ist gescheitert: nicht neu trainieren.
        A.schreibe(auftrag_id, status="trainiert", stufe="trainiert", meldung="Übernahme wird wiederholt.", fehler=None)
    else:
        A.schreibe(auftrag_id, status="wartet", meldung="Wartet auf den Worker.", fehler=None)
    return _kurz(A.lese(auftrag_id))


@router.delete("/{auftrag_id}", status_code=204)
async def entfernen(auftrag_id: str):
    a = _hole(auftrag_id)
    if a["status"] in ("laeuft", "uebernehme"):
        raise HTTPException(status_code=409, detail="Der Auftrag läuft noch — erst abbrechen.")
    A.entfernen(auftrag_id)


# ── Übernahme ins Backend ────────────────────────────────────────────────────


async def uebernahme_schleife():
    """
    Nimmt trainierte Aufträge in die Kachel-Pipeline auf.

    Eine Schleife im Prozess statt eines Aufrufs vom Worker: der Worker kennt das
    Backend nicht und soll es nicht kennen, und ein `trainiert`, das beim Neustart des
    Containers noch offen war, wird beim Hochfahren einfach wieder aufgegriffen.
    """
    from splatwerk.uebernahme import uebernehme_training

    # Nur diese Schleife setzt `uebernehme`. Steht es beim Start noch irgendwo, wurde der
    # Container mitten in der Übernahme beendet — ohne diese Rückstellung bliebe der Auftrag
    # für immer in einem Zustand, den niemand mehr aufgreift.
    for a in A.alle():
        if a.get("status") == "uebernehme":
            A.schreibe(a["id"], status="trainiert", stufe="trainiert", meldung="Übernahme wird wiederholt.")

    while True:
        try:
            for a in A.alle():
                if a.get("status") != "trainiert":
                    continue
                try:
                    await asyncio.to_thread(uebernehme_training, a["id"])
                    logger.info(f"[{a['id'][:8]}] Splat übernommen.")
                    opt = a.get("optionen") or {}
                    if opt.get("mesh"):
                        # Das Mesh ist ein eigenes Asset mit eigenem Stand (/atlas/mesh/<id>); der
                        # Splat steht schon im Viewer, während World Labs rechnet.
                        from api.routes.atlas import mesh_starten
                        mesh_starten(a["id"], {"qualitaet": opt.get("qualitaet"), "ansicht": opt.get("mesh_ansicht"),
                                               "zuschnitt": True, "name": f"{a['name']} — Mesh (Atlas)"})
                        A.schreibe(a["id"], mesh={"angestossen": A.jetzt()})
                except Exception as e:
                    logger.error(f"[{a['id'][:8]}] Übernahme gescheitert: {e}", exc_info=True)
                    A.schreibe(a["id"], status="fehler", stufe="uebernahme",
                               meldung=f"Übernahme ins Backend gescheitert: {e}", fehler=str(e))
            await asyncio.sleep(3.0)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Übernahmeschleife")
            await asyncio.sleep(10.0)
