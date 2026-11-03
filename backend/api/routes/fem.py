"""
Statik aus dem Zeichenmodus: eine Decke rechnen und die Ergebnisse ablegen.

Der Reiter *Plan* im Viewer erzeugt aus einem Grundriss ein statisches System —
Systemfläche, Auflager, Lasten, Positionen. Bisher endete das mit einem
Download, den ein Notebook wieder aufnahm. Diese Route schließt den Kreis: das
Modell geht an den Server, `ileen.rechnung` rechnet es durch, und Bilder,
Bericht und Nachweise liegen danach unter der `job_id` des Modells, aus dem der
Plan gezeichnet wurde.

**Warum die Ergebnisse am Asset hängen und nicht am Plan.** Ein Blatt ist eine
Sicht auf ein Bauwerk, kein eigenes Ding — dasselbe Geschoss wird als Aufsicht
und als Untersicht gezeichnet, in zwei Maßstäben, mit und ohne Räume. Die
Rechnung gehört zum Bauwerk. Wer im Viewer ein Modell auswählt, sieht deshalb
genau dessen Rechnungen und nicht die des Nachbargebäudes; der Plantitel steht
als Feld daneben, damit sich innerhalb eines Modells nach Geschoss sortieren
lässt.

    POST   /assets/{job_id}/fem                      Modell rechnen → {result_id}
    GET    /assets/{job_id}/fem                       alle Rechnungen dieses Modells
    GET    /assets/{job_id}/fem/{result_id}           Status, Bericht, Bildliste
    GET    /assets/{job_id}/fem/{result_id}/bild/{n}  ein Bild als PNG
    GET    /assets/{job_id}/fem/{result_id}/modell    die gerechnete Eingabe
    DELETE /assets/{job_id}/fem/{result_id}

Die Rechnung läuft als Hintergrundaufgabe in einem Thread: sie dauert je nach
Netz zwischen zwanzig Sekunden und einigen Minuten, und solange darf der Server
keine anderen Anfragen liegen lassen. JAX selbst ist nicht nebenläufig, deshalb
wird zusätzlich serialisiert — zwei gleichzeitige Zerlegungen brächten den
Container an seine Speichergrenze, statt beide schneller fertig zu haben.
"""

import asyncio
import logging
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import Response
from minio.error import S3Error
from pydantic import BaseModel, Field

from storage.minio_client import get_bytes, get_json, get_minio, json_bytes, put_bytes, put_json

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "fem"

# Nur eine Rechnung zur Zeit. JAX belegt für die Zerlegung mehrere Gigabyte und
# hält den Prozess ohnehin an einem Kern fest; zwei parallele Läufe wären nicht
# schneller, sondern nur beide vom Speicher bedroht.
_schlange = asyncio.Semaphore(1)

# Fortschritt im Prozessspeicher — wie in `upload.py` und aus demselben Grund
# nur für den Einzelworker-Betrieb gedacht. Der dauerhafte Stand steht in
# `status.json` neben den Ergebnissen und überlebt einen Neustart.
LAEUFE: dict[str, dict] = {}


class FemAnfrage(BaseModel):
    """Das Statikmodell aus dem Zeichenmodus, dazu was der Plan nicht enthält."""

    modell: dict = Field(..., description="Inhalt einer …_FEM.json (ileen.plan.fem/1.x)")
    annahmen: dict | None = Field(
        None,
        description=("Windzone, Gebäudehöhe, Geschosshöhe, Geschosse darüber, "
                     "Expositionsklasse, Bewehrungsdurchmesser, Kriechzahl, "
                     "Elementgröße, Lagen — siehe ileen.rechnung.Annahmen"),
    )
    titel: str | None = Field(None, description="Anzeigename; sonst der Plantitel")


class FemLauf(BaseModel):
    result_id: str
    job_id: str
    titel: str
    status: str                       # queued | running | done | failed
    anteil: float = 0.0
    text: str = ""
    gestartet: str
    beendet: str | None = None
    fehler: str | None = None
    # Kurzfassung für die Liste, damit das Panel nicht jeden Bericht laden muss
    nachweis_max: float | None = None
    nachweise_offen: list[str] = []
    bilder: int = 0
    plan: dict = {}


class FemErgebnis(FemLauf):
    bericht: dict | None = None


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat()


def _praefix(job_id: str, result_id: str) -> str:
    return f"{job_id}/{result_id}"


def _status_schreiben(job_id: str, result_id: str, **felder) -> dict:
    """
    Fortschritt festhalten — im Speicher und in MinIO.

    Zweigleisig, weil beide Wege verschiedene Fragen beantworten: der
    Speicherstand wird während des Laufs im Sekundentakt abgefragt und darf
    dabei nicht jedes Mal über das Netz gehen; die Datei beantwortet, was aus
    einem Lauf von gestern geworden ist.
    """
    eintrag = LAEUFE.setdefault(result_id, {"result_id": result_id, "job_id": job_id})
    eintrag.update(felder)
    eintrag["aktualisiert"] = _jetzt()
    try:
        put_json(BUCKET, f"{_praefix(job_id, result_id)}/status.json", eintrag)
    except Exception as fehler:  # noqa: BLE001 — der Lauf ist wichtiger als sein Protokoll
        logger.warning("FEM %s: Status nicht speicherbar (%s)", result_id, fehler)
    return eintrag


def _status_lesen(job_id: str, result_id: str) -> dict | None:
    """Erst der laufende Prozess, dann die Ablage."""
    eintrag = LAEUFE.get(result_id)
    if eintrag is not None and eintrag.get("job_id") == job_id:
        return eintrag
    try:
        return get_json(BUCKET, f"{_praefix(job_id, result_id)}/status.json")
    except S3Error:
        return None


def _als_lauf(eintrag: dict) -> FemLauf:
    bekannt = set(FemLauf.model_fields)
    return FemLauf(**{k: v for k, v in eintrag.items() if k in bekannt})


# ── Endpunkte ──────────────────────────────────────────────────────────────


@router.post("/{job_id}/fem", response_model=FemLauf, tags=["FEM"])
async def rechnung_starten(job_id: str, anfrage: FemAnfrage,
                           hintergrund: BackgroundTasks):
    """
    Nimmt ein Statikmodell an und stößt die Rechnung an.

    Geprüft wird hier nur, was ohne Rechnung zu prüfen ist — Schema,
    Systemfläche, Auflager. Alles Weitere meldet der Lauf über seinen Status;
    ein Modell, dessen Netz zu groß gerät, soll den Zeichenmodus nicht mit
    einem HTTP-Fehler überraschen, sondern mit einem Satz, der sagt, welche
    Elementgröße stattdessen ginge.
    """
    modell = anfrage.modell or {}
    schema = str(modell.get("schema", ""))
    if not schema.startswith("ileen.plan.fem/"):
        raise HTTPException(
            status_code=400,
            detail=f"Kein iLEEN-Statikexport (schema = {schema!r}). Im Zeichenmodus "
                   f"über FEM das Modell erzeugen.")
    if not modell.get("system"):
        raise HTTPException(
            status_code=400,
            detail="Keine Systemfläche im Modell — im Zeichenmodus mit dem Werkzeug ⬠ "
                   "den Umriss der Platte festlegen.")
    if not modell.get("auflager"):
        raise HTTPException(
            status_code=400,
            detail="Keine Auflager im Modell — mit dem Werkzeug △ die Lager auf den "
                   "Wandachsen setzen, sonst ist das System kinematisch.")

    result_id = uuid.uuid4().hex[:12]
    plan = modell.get("plan", {}) or {}
    titel = anfrage.titel or plan.get("titel") or "Zeichnung"

    _ensure_bucket()
    put_json(BUCKET, f"{_praefix(job_id, result_id)}/modell.json", modell)

    eintrag = _status_schreiben(
        job_id, result_id,
        titel=titel, status="queued", anteil=0.0,
        text="eingereiht", gestartet=_jetzt(), beendet=None, fehler=None,
        nachweis_max=None, nachweise_offen=[], bilder=0,
        plan={k: plan.get(k) for k in ("titel", "modell", "mode", "ansicht", "massstab")},
        annahmen=anfrage.annahmen or {},
    )

    hintergrund.add_task(_rechnen, job_id=job_id, result_id=result_id,
                         modell=modell, annahmen=anfrage.annahmen or {})
    return _als_lauf(eintrag)


@router.get("/{job_id}/fem", response_model=list[FemLauf], tags=["FEM"])
async def rechnungen(job_id: str):
    """Alle Rechnungen dieses Modells, jüngste zuerst."""
    _ensure_bucket()
    ergebnis: list[FemLauf] = []
    minio = get_minio()
    # `list_objects` mit Trennzeichen liefert die Ergebnisordner, ohne jede
    # einzelne PNG-Datei aufzuzählen — bei dreißig Bildern je Lauf ist das der
    # Unterschied zwischen einer Antwort und einer Liste von tausend Objekten.
    for objekt in minio.list_objects(BUCKET, prefix=f"{job_id}/", recursive=False):
        result_id = objekt.object_name.rstrip("/").split("/")[-1]
        eintrag = _status_lesen(job_id, result_id)
        if eintrag:
            ergebnis.append(_als_lauf(eintrag))
    ergebnis.sort(key=lambda e: e.gestartet, reverse=True)
    return ergebnis


@router.get("/{job_id}/fem/{result_id}", response_model=FemErgebnis, tags=["FEM"])
async def rechnung(job_id: str, result_id: str):
    """Status und — sobald fertig — der vollständige Bericht."""
    eintrag = _status_lesen(job_id, result_id)
    if eintrag is None:
        raise HTTPException(status_code=404, detail=f"Rechnung '{result_id}' gibt es nicht.")

    bericht = None
    if eintrag.get("status") == "done":
        try:
            bericht = get_json(BUCKET, f"{_praefix(job_id, result_id)}/bericht.json")
        except S3Error:
            logger.warning("FEM %s: Bericht fehlt trotz Status 'done'", result_id)

    bekannt = set(FemErgebnis.model_fields)
    return FemErgebnis(**{k: v for k, v in eintrag.items() if k in bekannt},
                       bericht=bericht)


@router.get("/{job_id}/fem/{result_id}/bild/{name}", tags=["FEM"])
async def bild(job_id: str, result_id: str, name: str):
    """Ein Ergebnisbild als PNG."""
    # Der Name kommt aus der Bildliste des Berichts, also aus unserer eigenen
    # Ausgabe — trotzdem geprüft: ein Pfadanteil darin würde sonst ein
    # beliebiges Objekt des Buckets ausliefern.
    sicher = Path(name).name
    if sicher != name or not sicher.endswith(".png"):
        raise HTTPException(status_code=400, detail="Ungültiger Bildname.")
    try:
        daten = get_bytes(BUCKET, f"{_praefix(job_id, result_id)}/bilder/{sicher}")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Bild '{sicher}' gibt es nicht.")
    # Ein fertiger Lauf ändert sich nicht mehr: die Bilder dürfen dauerhaft im
    # Browsercache bleiben, sonst lädt jedes Blättern in der Galerie neu.
    return Response(content=daten, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/{job_id}/fem/{result_id}/modell", tags=["FEM"])
async def modell(job_id: str, result_id: str):
    """Die gerechnete Eingabe — für den Vergleich, wenn ein Ergebnis überrascht."""
    try:
        return get_json(BUCKET, f"{_praefix(job_id, result_id)}/modell.json")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Rechnung '{result_id}' gibt es nicht.")


@router.delete("/{job_id}/fem/{result_id}", tags=["FEM"])
async def rechnung_loeschen(job_id: str, result_id: str):
    eintrag = _status_lesen(job_id, result_id)
    if eintrag is None:
        raise HTTPException(status_code=404, detail=f"Rechnung '{result_id}' gibt es nicht.")
    if eintrag.get("status") in ("queued", "running"):
        raise HTTPException(status_code=409, detail="Die Rechnung läuft noch.")
    purge(job_id, result_id)
    return {"geloescht": result_id}


# ── Aufräumen ──────────────────────────────────────────────────────────────


def purge(job_id: str, result_id: str | None = None) -> None:
    """
    Entfernt eine Rechnung oder alle eines Modells.

    Wird beim Löschen eines Assets mit aufgerufen (`assets.delete_asset`) —
    sonst bleiben die Bilder einer Decke liegen, deren Bauwerk längst weg ist.
    """
    from storage.minio_client import delete_prefix

    praefix = f"{job_id}/{result_id}" if result_id else f"{job_id}/"
    try:
        delete_prefix(BUCKET, praefix)
    except Exception as fehler:  # noqa: BLE001
        logger.warning("FEM: %s nicht löschbar (%s)", praefix, fehler)
    for kennung in [k for k, v in LAEUFE.items()
                    if v.get("job_id") == job_id and (result_id is None or k == result_id)]:
        LAEUFE.pop(kennung, None)


def _ensure_bucket() -> None:
    minio = get_minio()
    if not minio.bucket_exists(BUCKET):
        minio.make_bucket(BUCKET)


# ── Der Lauf ───────────────────────────────────────────────────────────────


async def _rechnen(job_id: str, result_id: str, modell: dict, annahmen: dict) -> None:
    async with _schlange:
        _status_schreiben(job_id, result_id, status="running", anteil=0.01,
                          text="Rechnung beginnt")
        try:
            await asyncio.to_thread(_lauf, job_id, result_id, modell, annahmen)
        except Exception as fehler:  # noqa: BLE001 — der Fehler gehört in den Status
            logger.error("FEM %s: fehlgeschlagen (%s)", result_id, fehler, exc_info=True)
            _status_schreiben(job_id, result_id, status="failed", beendet=_jetzt(),
                              text="fehlgeschlagen", fehler=str(fehler))


def _lauf(job_id: str, result_id: str, modell: dict, annahmen: dict) -> None:
    """
    Der eigentliche Rechenlauf, in einem Thread.

    `ileen.rechnung` wird erst hier importiert: JAX braucht beim ersten Import
    mehrere Sekunden und ein paar hundert Megabyte. Ein Backend, aus dem
    niemand rechnet, soll das nicht bezahlen — und der Importfehler eines
    fehlenden JAX darf nicht den Serverstart verhindern, sondern gehört als
    Meldung in den Status dieses einen Laufs.
    """
    from ileen import rechnung as rechenwerk

    # Die Bilder entstehen lokal und wandern danach als Block nach MinIO: ein
    # Einzelupload je Figur wäre dreißig Netzwerkrunden mitten im Rechenlauf.
    arbeit = Path(tempfile.mkdtemp(prefix=f"fem-{result_id}-"))
    try:
        def melden(anteil: float, text: str) -> None:
            _status_schreiben(job_id, result_id, status="running",
                              anteil=round(float(anteil), 3), text=text)

        try:
            bericht = rechenwerk.rechne(
                modell, arbeit, rechenwerk.Annahmen.aus(annahmen), melden)
        except rechenwerk.Abbruch as grund:
            # Kein Fehler des Servers, sondern eine Eigenschaft der Eingabe —
            # der Satz ist für den Menschen im Zeichenmodus geschrieben.
            _status_schreiben(job_id, result_id, status="failed", beendet=_jetzt(),
                              text="nicht rechenbar", fehler=str(grund))
            return

        praefix = _praefix(job_id, result_id)
        for datei in sorted(arbeit.glob("*.png")):
            put_bytes(BUCKET, f"{praefix}/bilder/{datei.name}",
                      datei.read_bytes(), content_type="image/png")

        # `json_bytes` fängt numpy-Skalare ab, die aus den Rechenmodulen
        # durchkommen, und ebenso NaN — json kennt beides nicht, und eine ganze
        # Rechnung an einer np.float64 scheitern zu lassen wäre absurd.
        put_bytes(BUCKET, f"{praefix}/bericht.json",
                  json_bytes(bericht),
                  content_type="application/json")

        nachweise = bericht.get("nachweise", {}) or {}
        _status_schreiben(
            job_id, result_id, status="done", anteil=1.0, beendet=_jetzt(),
            text=f"{len(bericht.get('bilder', []))} Bilder, "
                 f"{len(nachweise)} Nachweise",
            nachweis_max=round(max(nachweise.values()), 3) if nachweise else None,
            nachweise_offen=bericht.get("nachweise_offen", []),
            bilder=len(bericht.get("bilder", [])))
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)
