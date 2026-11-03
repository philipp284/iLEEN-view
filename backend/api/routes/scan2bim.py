"""
Aus einer Punktwolke ein Bauwerksmodell machen — angestoßen aus dem Viewer.

    POST   /assets/{job_id}/scan2bim              rekonstruieren → {lauf_id}
    GET    /assets/{job_id}/scan2bim              alle Läufe dieses Modells
    GET    /assets/{job_id}/scan2bim/{lauf_id}    Status und Bericht
    DELETE /assets/{job_id}/scan2bim/{lauf_id}

Die `job_id` ist die der Punktwolke — und damit zugleich die Quelle der
Georeferenz: aus dem `transform` ihres Tilesets fällt die Lage des Ergebnisses
exakt an, statt geschätzt zu werden. Ein aus dem Viewer angestoßener Lauf
liefert deshalb ein Modell, das ohne Nacharbeit deckungsgleich auf seiner
Wolke liegt. Das ist der eigentliche Grund, warum dieser Weg im Backend sitzt
und nicht in einem Skript daneben.

## Das Ergebnis sind zwei neue Assets

Der Lauf legt ein IFC und ein GLB an — beide gehen durch dieselbe
Tiling-Pipeline wie ein Upload und erscheinen als eigenständige Modelle in der
Liste. Sie werden nicht an den Lauf gehängt, weil sie den Lauf überdauern: wer
das Ergebnis behalten und die Zwischenstände wegwerfen will, soll das können.

## Eine Rechnung zur Zeit

Wie bei `fem.py` und `volumen.py`, aus demselben Grund: die Zellstatistik hält
die gesamte Punktwolke im Speicher — bei hundert Millionen Punkten sind das
mehrere Gigabyte. Zwei gleichzeitige Läufe wären nicht schneller, sondern
beide vom Speicher bedroht.
"""

import asyncio
import logging
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field, model_validator

from storage.minio_client import get_json, get_minio, put_json

logger = logging.getLogger(__name__)

router = APIRouter()

BUCKET = "scan2bim"
_QUELLEN = {".las", ".laz"}

_schlange = asyncio.Semaphore(1)


class Scan2BimAnfrage(BaseModel):
    """Was der Viewer schickt, wenn eine Punktwolke rekonstruiert werden soll."""

    projekt: str | None = Field(
        None, description="Name der erzeugten Modelle; sonst der Dateiname der Wolke")

    netz: str = Field(
        "adaptiv", pattern="^(adaptiv|fest)$",
        description="Geländenetz: 'adaptiv' setzt Stützpunkte nach Bedarf, "
                    "'fest' legt ein regelmäßiges Gitter")
    maschenweite_m: float = Field(
        1.0, gt=0.05, le=25.0,
        description="Nur bei netz='fest': Kantenlänge der Maschen")
    toleranz_m: float = Field(
        0.15, gt=0.005, le=5.0,
        description="Nur bei netz='adaptiv': größte zugelassene Höhenabweichung "
                    "des Netzes vom gerasterten Gelände")
    max_stuetzpunkte: int = Field(
        60000, ge=500, le=400000,
        description="Obergrenze für das adaptive Netz — greift, bevor eine zu "
                    "scharfe Toleranz das Modell unbrauchbar groß macht")

    ablegen: bool = Field(
        True, description="Ergebnisse als neue Modelle ins Backend übernehmen")

    @model_validator(mode="after")
    def _warnen_bei_feinem_netz(self):
        # Eine Toleranz unter zwei Zentimetern verlangt mehr Stützpunkte, als
        # das 20-cm-Raster überhaupt hergibt — das Netz würde die Rasterung
        # nachbilden, nicht das Gelände. Lieber hier sagen als hinterher.
        if self.netz == "adaptiv" and self.toleranz_m < 0.02:
            raise ValueError(
                f"Toleranz {self.toleranz_m} m ist feiner als die Rasterweite von "
                f"0,20 m hergibt. Ab etwa 0,05 m bildet das Netz das Raster nach "
                f"statt das Gelände.")
        return self


class Scan2BimLauf(BaseModel):
    lauf_id: str
    job_id: str
    titel: str
    status: str                      # queued | running | done | failed
    anteil: float = 0.0
    text: str = ""
    gestartet: str
    beendet: str | None = None
    fehler: str | None = None
    ergebnis_jobs: dict[str, str] = Field(default_factory=dict)


class Scan2BimErgebnis(Scan2BimLauf):
    bericht: dict | None = None


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_bucket():
    minio = get_minio()
    if not minio.bucket_exists(BUCKET):
        minio.make_bucket(BUCKET)


def _status_schreiben(job_id: str, lauf_id: str, **felder) -> dict:
    vorher = _status_lesen(job_id, lauf_id) or {}
    eintrag = {**vorher, "job_id": job_id, "lauf_id": lauf_id, **felder}
    put_json(BUCKET, f"{job_id}/{lauf_id}/status.json", eintrag)
    return eintrag


def _status_lesen(job_id: str, lauf_id: str) -> dict | None:
    try:
        return get_json(BUCKET, f"{job_id}/{lauf_id}/status.json")
    except Exception:
        return None


def _quelle_holen(job_id: str, ziel: Path) -> Path:
    """Die Quelldatei der Punktwolke aus dem uploads-Bucket auf die Platte."""
    minio = get_minio()
    treffer = [o.object_name for o in minio.list_objects("uploads", prefix=f"{job_id}/",
                                                         recursive=True)]
    wolken = [n for n in treffer if Path(n).suffix.lower() in _QUELLEN]
    if not wolken:
        raise RuntimeError(
            f"Zu diesem Modell liegt keine LAS/LAZ-Quelldatei im Upload-Speicher. "
            f"Gefunden: {[Path(n).name for n in treffer] or 'nichts'}.")
    quelle = ziel / Path(wolken[0]).name
    minio.fget_object("uploads", wolken[0], str(quelle))
    return quelle


async def _rechnen(job_id: str, lauf_id: str, anfrage: Scan2BimAnfrage):
    async with _schlange:
        try:
            _status_schreiben(job_id, lauf_id, status="running", anteil=0.0,
                              text="Quelldatei holen")
            await asyncio.to_thread(_rechnen_blockierend, job_id, lauf_id, anfrage)
        except Exception as fehler:                       # noqa: BLE001
            logger.error("[%s/%s] Scan2BIM fehlgeschlagen: %s", job_id, lauf_id,
                         fehler, exc_info=True)
            _status_schreiben(job_id, lauf_id, status="failed", beendet=_jetzt(),
                              fehler=str(fehler)[:500], text="abgebrochen")


def _rechnen_blockierend(job_id: str, lauf_id: str, anfrage: Scan2BimAnfrage):
    from scan2bim import lauf as s2b

    arbeit = Path(tempfile.mkdtemp(prefix=f"scan2bim-{lauf_id}-"))
    try:
        quelle = _quelle_holen(job_id, arbeit)
        titel = anfrage.projekt or Path(quelle).stem

        def melden(anteil: float, text: str):
            _status_schreiben(job_id, lauf_id, status="running",
                              anteil=round(float(anteil), 3), text=text)

        einstellungen = s2b.Einstellungen(
            projekt=titel, netz_modus=anfrage.netz,
            maschenweite_m=anfrage.maschenweite_m, toleranz_m=anfrage.toleranz_m,
            max_stuetzpunkte=anfrage.max_stuetzpunkte,
            referenz_tileset=_tileset_dokument(job_id))
        ergebnis = arbeit / "ergebnis"
        bericht = s2b.ausfuehren(quelle, ergebnis, einstellungen, melden=melden)

        jobs = {}
        if anfrage.ablegen:
            melden(0.99, "Ergebnisse ablegen")
            for datei, art in (("modell.ifc", "ifc"), ("modell.glb", "glb")):
                pfad = ergebnis / datei
                if not pfad.exists():
                    continue
                jobs[art.upper()] = _als_asset_ablegen(
                    pfad, f"{titel} ({art.upper()})", s2b.platzierung(ergebnis, art))
            bericht["ergebnis_jobs"] = jobs

        put_json(BUCKET, f"{job_id}/{lauf_id}/bericht.json", bericht)
        _status_schreiben(job_id, lauf_id, status="done", anteil=1.0, text="fertig",
                          beendet=_jetzt(), ergebnis_jobs=jobs)
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)


def _tileset_dokument(job_id: str) -> dict | None:
    """Das Tileset der Quellwolke — Grundlage der Georeferenz."""
    try:
        return get_json("tiles", f"{job_id}/tileset.json")
    except Exception:
        logger.warning("[%s] Kein Tileset gefunden — Ergebnis bleibt ohne Georeferenz.",
                       job_id)
        return None


def _als_asset_ablegen(datei: Path, name: str, platzierung: dict | None) -> str:
    """
    Ein Ergebnis wie einen Upload ablegen: Quelldatei sichern, tilen, benennen.

    Bewusst derselbe Weg wie beim Upload und nicht ein eigener — ein Modell aus
    diesem Lauf soll sich in nichts von einem hochgeladenen unterscheiden, auch
    nicht darin, was beim Löschen wieder verschwindet.
    """
    from api.routes import assets, placement as platz_modul
    from tiling.pipeline import run_tiling

    neue_job_id = str(uuid.uuid4())
    get_minio().fput_object("uploads", f"{neue_job_id}/{datei.name}", str(datei))

    tiles_dir = None
    try:
        tiles_dir = run_tiling(datei, neue_job_id)
    finally:
        if tiles_dir is not None:
            shutil.rmtree(tiles_dir, ignore_errors=True)

    if platzierung:
        # Über dieselben Funktionen wie die Placement-Route, damit auch die
        # `root.transform` der tileset.json mitgeschrieben wird — ohne sie läge
        # das Modell am Nullpunkt der Voreinstellung.
        vorhanden = platz_modul.load_placement(neue_job_id)
        vorhanden.update(platzierung)
        platz_modul._apply(neue_job_id, vorhanden)

    try:
        meta = assets._load_meta(neue_job_id)
        meta["display_name"] = name
        put_json("tiles", assets._meta_key(neue_job_id), meta)
    except Exception:
        logger.warning("Name für %s konnte nicht gesetzt werden.", neue_job_id)
    logger.info("Ergebnis abgelegt: %s → %s", name, neue_job_id)
    return neue_job_id


@router.post("/{job_id}/scan2bim", response_model=Scan2BimLauf, tags=["Scan2BIM"])
async def rekonstruktion_starten(job_id: str, anfrage: Scan2BimAnfrage,
                                 hintergrund: BackgroundTasks):
    """
    Eine Punktwolke zu einem Bauwerksmodell rekonstruieren.

    Geprüft wird hier nur, was ohne die Punkte zu prüfen ist. Ob die Wolke
    genug hergibt, ob die Segmentierung etwas findet, ob das Netz die Toleranz
    hält — das meldet der Lauf über seinen Bericht, nicht über einen
    HTTP-Fehler.
    """
    _ensure_bucket()
    lauf_id = uuid.uuid4().hex[:12]
    eintrag = _status_schreiben(
        job_id, lauf_id, titel=anfrage.projekt or job_id[:8], status="queued",
        anteil=0.0, text="eingereiht", gestartet=_jetzt(), beendet=None,
        fehler=None, ergebnis_jobs={})
    put_json(BUCKET, f"{job_id}/{lauf_id}/anfrage.json", anfrage.model_dump())
    hintergrund.add_task(_rechnen, job_id=job_id, lauf_id=lauf_id, anfrage=anfrage)
    return Scan2BimLauf(**eintrag)


@router.get("/{job_id}/scan2bim", response_model=list[Scan2BimLauf], tags=["Scan2BIM"])
async def rekonstruktionen(job_id: str):
    """Alle Rekonstruktionsläufe dieser Punktwolke, jüngste zuerst."""
    _ensure_bucket()
    ergebnis = []
    for objekt in get_minio().list_objects(BUCKET, prefix=f"{job_id}/", recursive=False):
        lauf_id = objekt.object_name.rstrip("/").split("/")[-1]
        eintrag = _status_lesen(job_id, lauf_id)
        if eintrag:
            ergebnis.append(Scan2BimLauf(**eintrag))
    return sorted(ergebnis, key=lambda x: x.gestartet, reverse=True)


@router.get("/{job_id}/scan2bim/{lauf_id}", response_model=Scan2BimErgebnis,
            tags=["Scan2BIM"])
async def rekonstruktion(job_id: str, lauf_id: str):
    """Status eines Laufs, nach dem Ende mit Bericht."""
    eintrag = _status_lesen(job_id, lauf_id)
    if not eintrag:
        raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
    bericht = None
    if eintrag.get("status") == "done":
        try:
            bericht = get_json(BUCKET, f"{job_id}/{lauf_id}/bericht.json")
        except Exception:
            pass
    return Scan2BimErgebnis(**eintrag, bericht=bericht)


@router.delete("/{job_id}/scan2bim/{lauf_id}", tags=["Scan2BIM"])
async def rekonstruktion_loeschen(job_id: str, lauf_id: str):
    """
    Den Lauf entfernen — die erzeugten Modelle bleiben.

    Sie sind eigenständige Assets und werden über die Modellliste gelöscht.
    Ein Lauf, der beim Aufräumen fremde Modelle mitnimmt, wäre eine
    unangenehme Überraschung.
    """
    minio = get_minio()
    gefunden = False
    for objekt in minio.list_objects(BUCKET, prefix=f"{job_id}/{lauf_id}/", recursive=True):
        minio.remove_object(BUCKET, objekt.object_name)
        gefunden = True
    if not gefunden:
        raise HTTPException(status_code=404, detail="Diesen Lauf gibt es nicht.")
    return {"geloescht": lauf_id}
