"""
Bauteile aus dem Modell räumlich nachrechnen — Auswahl im Viewer, Wolke zurück.

Der Weg, den diese Route bedient, ist der kürzeste, den ein Tragwerksplaner
sich vorstellen kann: **im Viewer ein paar Bauteile anklicken, rechnen lassen,
das Ergebnis liegt als farbige Punktwolke im Bauteil.** Kein Export, kein
Modellaufbau, keine Idealisierung von Hand.

    POST   /assets/{job_id}/volumen                        rechnen → {lauf_id}
    GET    /assets/{job_id}/volumen                        alle Läufe
    GET    /assets/{job_id}/volumen/{lauf_id}              Status und Bericht
    GET    /assets/{job_id}/volumen/{lauf_id}/felder       darstellbare Größen
    GET    …/{lauf_id}/wolke/{feld}/tileset.json           3D-Tileset
    GET    …/{lauf_id}/wolke/{feld}/tile.pnts              Punkte samt Werten
    GET    …/{lauf_id}/wolke/{feld}/skala.json             Legende und Bauteiltabelle
    GET    …/{lauf_id}/punkt?x=&y=&z=                      Werte an einer Stelle
    GET    …/{lauf_id}/schnittgroessen/{bauteil}           N, V, M entlang der Achse
    DELETE /assets/{job_id}/volumen/{lauf_id}
    GET    /volumen/werkstoffe                             die Werkstoffbibliothek

## Warum der Lauf am Asset hängt und nicht an der Auswahl

Dieselbe Überlegung wie bei den Deckenrechnungen in `fem.py`: eine Auswahl von
Bauteilen ist kein Ding, das man wiederfindet — sie entsteht mit einem Klick
und ist mit dem nächsten anders. Das Bauwerk bleibt. Deshalb liegt der Lauf
unter der `job_id` des Modells, und welche Bauteile darin steckten, steht als
Liste im Bericht.

## Die Wolke entsteht beim Abruf, nicht beim Lauf

Gerechnet wird einmal; gefärbt wird so oft, wie jemand ein anderes Feld
sehen will. Die Rechnung legt deshalb nur die `punkte.npz` ab — alle Werte an
allen Punkten —, und jede Wolke wird beim ersten Abruf daraus gebaut und
danach aus dem Speicher bedient. Zwanzig Größen im Voraus zu tilen hieße,
neunzehn davon umsonst zu erzeugen.

## Eine Rechnung zur Zeit

Wie in `fem.py`, und aus demselben Grund: JAX belegt für die Zerlegung
mehrere Gigabyte und hält den Prozess an einem Kern fest. Zwei gleichzeitige
Läufe wären nicht schneller, sondern beide vom Speicher bedroht.
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

from storage.minio_client import (get_bytes, get_json, get_minio, put_bytes,
                                  put_json)

logger = logging.getLogger(__name__)

router = APIRouter()
bibliothek_router = APIRouter()

BUCKET = "volumen"
_UPLOADS = "uploads"

_schlange = asyncio.Semaphore(1)
LAEUFE: dict[str, dict] = {}


# ── Datenmodelle ──────────────────────────────────────────────────────────


class VolumenAnfrage(BaseModel):
    """Was der Viewer schickt, wenn Bauteile gerechnet werden sollen."""

    global_ids: list[str] = Field(..., min_length=1,
                                  description="Die im Viewer gewählten Bauteile")
    werkstoffe: dict[str, str] = Field(
        default_factory=dict,
        description="{GlobalId: Werkstoffname} — überschreibt die Erkennung aus dem IFC")
    fasern: dict[str, list[float]] = Field(
        default_factory=dict,
        description="{GlobalId: [x,y,z]} — Faserrichtung, wenn nicht aus der Gestalt")
    elementgroesse_m: float = Field(
        0.05, gt=0.005, le=1.0,
        description="Kantenlänge der Voxel; kleiner = genauer und langsamer")
    nutzlast_kNm2: float = Field(
        0.0, ge=0.0, description="veränderliche Flächenlast von oben")
    psi_2: float = Field(0.3, ge=0.0, le=1.0,
                         description="Kombinationsbeiwert der Nutzlast, quasi-ständig")
    titel: str | None = None


class VolumenLauf(BaseModel):
    lauf_id: str
    job_id: str
    titel: str
    status: str                       # queued | running | done | failed
    anteil: float = 0.0
    text: str = ""
    gestartet: str
    beendet: str | None = None
    fehler: str | None = None
    bauteile: int = 0
    elemente: int = 0
    eta_max: float | None = None
    w_max_mm: float | None = None


class VolumenErgebnis(VolumenLauf):
    bericht: dict | None = None


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat()


def _praefix(job_id: str, lauf_id: str) -> str:
    return f"{job_id}/{lauf_id}"


def _sicher(text: str) -> str:
    """
    Ein Pfadstück ohne Pfad.

    Feldnamen stammen aus unserer eigenen Liste, landen aber in einem
    Objektnamen — und ein Aufrufer, der `..` schickt, würde damit auf einen
    Nachbarordner des Buckets zeigen. Trennzeichen fallen weg, und was
    danach nur noch aus Punkten besteht, wird verworfen statt durchgereicht.
    """
    rein = "".join(c for c in str(text) if c.isalnum() or c in "-_.")[:64]
    return rein if rein.strip(".") else "feld"


def _ensure_bucket():
    minio = get_minio()
    if not minio.bucket_exists(BUCKET):
        minio.make_bucket(BUCKET)


def _status_schreiben(job_id: str, lauf_id: str, **felder) -> dict:
    eintrag = LAEUFE.setdefault(lauf_id, {"lauf_id": lauf_id, "job_id": job_id})
    eintrag.update(felder)
    eintrag["aktualisiert"] = _jetzt()
    try:
        put_json(BUCKET, f"{_praefix(job_id, lauf_id)}/status.json", eintrag)
    except Exception as fehler:  # noqa: BLE001 — der Lauf ist wichtiger als sein Protokoll
        logger.warning("Volumen %s: Status nicht speicherbar (%s)", lauf_id, fehler)
    return eintrag


def _status_lesen(job_id: str, lauf_id: str) -> dict | None:
    eintrag = LAEUFE.get(lauf_id)
    if eintrag is not None and eintrag.get("job_id") == job_id:
        return eintrag
    try:
        return get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/status.json")
    except S3Error:
        return None


def _als_lauf(eintrag: dict) -> VolumenLauf:
    bekannt = set(VolumenLauf.model_fields)
    return VolumenLauf(**{k: v for k, v in eintrag.items() if k in bekannt})


def _quelldatei(job_id: str) -> str:
    objekte = list(get_minio().list_objects(_UPLOADS, prefix=f"{job_id}/", recursive=True))
    if not objekte:
        raise HTTPException(
            status_code=404,
            detail=f"Keine Quelldatei für '{job_id}' — sie wurde gelöscht oder nie hochgeladen.")
    return objekte[0].object_name


# ── Die Rechnung im Hintergrund ───────────────────────────────────────────


async def _rechnen(job_id: str, lauf_id: str, anfrage: VolumenAnfrage):
    """
    Bauteile laden, vernetzen, lösen, ablegen.

    Läuft in einem Thread, weil eine Volumenrechnung je nach Netz zwischen
    zehn Sekunden und einigen Minuten dauert und der Server in dieser Zeit
    weiter antworten muss. Die Semaphore davor sorgt dafür, dass trotzdem nur
    eine Zerlegung gleichzeitig Speicher belegt.
    """
    async with _schlange:
        _status_schreiben(job_id, lauf_id, status="running", anteil=0.05,
                          text="Bauteile werden geladen")
        try:
            await asyncio.to_thread(_rechnen_blockierend, job_id, lauf_id, anfrage)
        except Exception as fehler:  # noqa: BLE001 — jeder Fehler gehört in den Status
            logger.exception("Volumenrechnung %s fehlgeschlagen", lauf_id)
            _status_schreiben(job_id, lauf_id, status="failed", beendet=_jetzt(),
                              anteil=1.0, text="fehlgeschlagen", fehler=str(fehler))


def _rechnen_blockierend(job_id: str, lauf_id: str, anfrage: VolumenAnfrage):
    import numpy as np

    from ileen import volumen as vo
    from ileen import volumen_ifc
    from tiling import volumenwolke

    arbeit = Path(tempfile.mkdtemp(prefix="volumen-"))
    try:
        objekt = _quelldatei(job_id)
        if not objekt.lower().endswith((".ifc", ".ifcxml", ".ifczip")):
            raise ValueError(
                "Bauteile räumlich nachrechnen geht nur an einem IFC-Modell — "
                f"diese Quelle ist '{Path(objekt).name}'.")
        quelle = arbeit / Path(objekt).name
        quelle.write_bytes(get_bytes(_UPLOADS, objekt))

        _status_schreiben(job_id, lauf_id, anteil=0.15, text="Geometrie wird ausgelesen")
        bauteile, offset, hinweise = volumen_ifc.bauteile_laden(
            quelle, job_id, anfrage.global_ids,
            werkstoffe=anfrage.werkstoffe,
            fasern={k: v for k, v in anfrage.fasern.items()})

        _status_schreiben(job_id, lauf_id, anteil=0.3, text="Netz wird aufgebaut",
                          bauteile=len(bauteile))
        netz = vo.vernetze(bauteile, anfrage.elementgroesse_m)

        _status_schreiben(job_id, lauf_id, anteil=0.45,
                          text=f"{netz.n_elemente} Elemente werden gelöst",
                          elemente=netz.n_elemente)
        ergebnis = vo.rechne(netz, nutzlast_kNm2=anfrage.nutzlast_kNm2 or None,
                             psi_2=anfrage.psi_2)
        ergebnis.hinweise = hinweise + list(ergebnis.hinweise)

        _status_schreiben(job_id, lauf_id, anteil=0.8, text="Ergebnisse werden abgelegt")
        punkte = volumenwolke.felder_aus_ergebnis(ergebnis)
        npz = arbeit / "punkte.npz"
        np.savez_compressed(npz, xyz=punkte["xyz"], bauteil=punkte["bauteil"],
                            **punkte["werte"])
        put_bytes(BUCKET, f"{_praefix(job_id, lauf_id)}/punkte.npz", npz.read_bytes(),
                  "application/octet-stream")

        kennwerte = ergebnis.kennwerte()
        schnitte = {}
        for index, b in enumerate(netz.bauteile):
            try:
                sg = vo.schnittgroessen(netz, ergebnis.u["GZT"], index)
            except Exception as fehler:  # noqa: BLE001
                logger.warning("Schnittgrößen für %s: %s", b.global_id, fehler)
                continue
            schnitte[b.global_id] = {
                k: [round(float(v), 4) for v in sg[k]]
                for k in ("s", "N", "V", "M", "A", "z_s")}
            schnitte[b.global_id].update(
                achse=[round(float(v), 4) for v in sg["achse"]],
                gestalt=sg["gestalt"], schlankheit=sg["schlankheit"],
                laenge=round(float(sg["laenge"]), 4),
                M_max=round(float(np.abs(sg["M"]).max()), 3),
                V_max=round(float(np.abs(sg["V"]).max()), 3),
                N_max=round(float(np.abs(sg["N"]).max()), 3))

        bericht = {
            "lauf_id": lauf_id, "job_id": job_id,
            "kennwerte": kennwerte,
            "bauteile": punkte["tabelle"],
            "lager": ergebnis.lager,
            "lastfaelle": [{"name": lf.name, "art": lf.art} for lf in ergebnis.lastfaelle],
            "proben": ergebnis.proben,
            "hinweise": ergebnis.hinweise,
            "schnittgroessen": schnitte,
            "felder": [{"schluessel": k, "min": round(float(np.nanmin(v)), 6),
                        "max": round(float(np.nanmax(v)), 6)}
                       for k, v in punkte["werte"].items()],
            "annahmen": {
                "elementgroesse_m": anfrage.elementgroesse_m,
                "nutzlast_kNm2": anfrage.nutzlast_kNm2,
                "psi_2": anfrage.psi_2,
                "offset": [round(float(v), 4) for v in offset],
            },
        }
        put_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bericht.json", bericht)

        _status_schreiben(
            job_id, lauf_id, status="done", anteil=1.0, text="fertig",
            beendet=_jetzt(), elemente=netz.n_elemente, bauteile=len(bauteile),
            eta_max=round(float(kennwerte["eta_max"]), 4),
            w_max_mm=round(float(kennwerte["w_max_mm"]), 4))
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)


# ── Endpunkte ─────────────────────────────────────────────────────────────


@router.post("/{job_id}/volumen", response_model=VolumenLauf, tags=["Volumen"])
async def rechnung_starten(job_id: str, anfrage: VolumenAnfrage,
                           hintergrund: BackgroundTasks):
    """
    Die gewählten Bauteile räumlich nachrechnen.

    Geprüft wird hier nur, was ohne Geometrie zu prüfen ist. Ob die Bauteile
    zusammenhängen, ob das Netz zu groß gerät, ob ein Werkstoff geraten werden
    musste — all das meldet der Lauf über seinen Bericht. Ein Modell mit
    ungünstiger Auswahl soll den Viewer nicht mit einem HTTP-Fehler
    überraschen, sondern mit einem Satz, der sagt, was zu tun wäre.
    """
    if len(anfrage.global_ids) > 50:
        raise HTTPException(
            status_code=400,
            detail=f"{len(anfrage.global_ids)} Bauteile auf einmal — das wird ein "
                   f"Netz, das keine sinnvolle Rechenzeit mehr hat. Bis etwa zehn "
                   f"Bauteile ist der Weg gedacht.")
    unbekannt = [w for w in anfrage.werkstoffe.values() if not _kennt_werkstoff(w)]
    if unbekannt:
        raise HTTPException(
            status_code=400,
            detail=f"Unbekannte Werkstoffe: {', '.join(unbekannt)}. "
                   f"Die Liste steht unter /volumen/werkstoffe.")

    lauf_id = uuid.uuid4().hex[:12]
    _ensure_bucket()
    eintrag = _status_schreiben(
        job_id, lauf_id,
        titel=anfrage.titel or f"{len(anfrage.global_ids)} Bauteil(e)",
        status="queued", anteil=0.0, text="eingereiht", gestartet=_jetzt(),
        beendet=None, fehler=None, bauteile=len(anfrage.global_ids), elemente=0)
    put_json(BUCKET, f"{_praefix(job_id, lauf_id)}/anfrage.json", anfrage.model_dump())

    hintergrund.add_task(_rechnen, job_id=job_id, lauf_id=lauf_id, anfrage=anfrage)
    return _als_lauf(eintrag)


def _kennt_werkstoff(name: str) -> bool:
    from ileen import werkstoff as wk
    try:
        wk.werkstoff(name)
        return True
    except KeyError:
        return False


@router.get("/{job_id}/volumen", response_model=list[VolumenLauf], tags=["Volumen"])
async def rechnungen(job_id: str):
    """Alle Volumenrechnungen dieses Modells, jüngste zuerst."""
    _ensure_bucket()
    ergebnis: list[VolumenLauf] = []
    for objekt in get_minio().list_objects(BUCKET, prefix=f"{job_id}/", recursive=False):
        lauf_id = objekt.object_name.rstrip("/").split("/")[-1]
        eintrag = _status_lesen(job_id, lauf_id)
        if eintrag:
            ergebnis.append(_als_lauf(eintrag))
    ergebnis.sort(key=lambda e: e.gestartet, reverse=True)
    return ergebnis


@router.get("/{job_id}/volumen/{lauf_id}", response_model=VolumenErgebnis, tags=["Volumen"])
async def rechnung(job_id: str, lauf_id: str):
    """Status und — sobald fertig — der vollständige Bericht."""
    eintrag = _status_lesen(job_id, lauf_id)
    if eintrag is None:
        raise HTTPException(status_code=404, detail=f"Lauf '{lauf_id}' gibt es nicht.")
    bericht = None
    if eintrag.get("status") == "done":
        try:
            bericht = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bericht.json")
        except S3Error:
            logger.warning("Volumen %s: Bericht fehlt trotz Status 'done'", lauf_id)
    bekannt = set(VolumenErgebnis.model_fields)
    return VolumenErgebnis(**{k: v for k, v in eintrag.items() if k in bekannt},
                           bericht=bericht)


@router.get("/{job_id}/volumen/{lauf_id}/felder", tags=["Volumen"])
async def felder(job_id: str, lauf_id: str):
    """
    Welche Größen dieser Lauf darstellen kann — für die Feldauswahl im Panel.

    Kommt aus dem Bericht und nicht aus der Punktdatei: die Liste wird bei
    jedem Öffnen des Panels gebraucht, und dafür ein paar Megabyte
    Punktdaten zu laden wäre Verschwendung.
    """
    from tiling.volumenwolke import FELDER

    try:
        bericht = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bericht.json")
    except S3Error:
        raise HTTPException(status_code=404,
                            detail=f"Für Lauf '{lauf_id}' gibt es keine Ergebnisse.")
    ergebnis = []
    for eintrag in bericht.get("felder", []):
        k = eintrag["schluessel"]
        beschriftung, einheit, _v, _s, _st, gruppe = FELDER.get(
            k, (k, "–", "warm", False, 0, "Nachweisanteile"))
        ergebnis.append({**eintrag, "beschriftung": beschriftung,
                         "einheit": einheit, "gruppe": gruppe})
    return {"lauf_id": lauf_id, "felder": ergebnis,
            "bauteile": bericht.get("bauteile", [])}


# ── Die Wolke ─────────────────────────────────────────────────────────────


def _punkte_holen(job_id: str, lauf_id: str) -> Path:
    """Die `punkte.npz` in ein temporäres Verzeichnis holen."""
    ziel = Path(tempfile.mkdtemp(prefix="volumen-npz-")) / "punkte.npz"
    try:
        ziel.write_bytes(get_bytes(BUCKET, f"{_praefix(job_id, lauf_id)}/punkte.npz"))
    except S3Error:
        shutil.rmtree(ziel.parent, ignore_errors=True)
        raise HTTPException(
            status_code=404,
            detail=f"Für Lauf '{lauf_id}' liegen keine Punktdaten vor — die "
                   f"Rechnung läuft noch oder ist fehlgeschlagen.")
    return ziel


def _wolke_holen(job_id: str, lauf_id: str, feld: str, name: str,
                 stufen: int | None = None, verlauf: str | None = None,
                 verformt: float = 0.0) -> bytes:
    """
    Die Wolke aus dem Speicher, sonst erzeugen.

    Die Kennung trägt alles, was das Ergebnis verändert — Feld, Stufenzahl,
    Verlauf, Überhöhung. Fehlte darin die Stufenzahl, bekäme der zweite Abruf
    mit anderer Farbgebung die Kacheln des ersten und die Legende des
    zweiten; die Farben stimmten dann mit ihrer eigenen Beschriftung nicht
    mehr überein.
    """
    import numpy as np

    from tiling import volumenwolke

    kennung = _sicher(feld)
    if stufen is not None:
        kennung += f"_s{int(stufen)}"
    if verlauf:
        kennung += f"_v{_sicher(verlauf)}"
    if verformt:
        kennung += f"_d{int(verformt)}"
    objekt = f"{_praefix(job_id, lauf_id)}/wolken/{kennung}/{name}"
    try:
        return get_bytes(BUCKET, objekt)
    except S3Error:
        pass

    try:
        bericht = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bericht.json")
    except S3Error:
        bericht = {}

    from api.routes.placement import load_placement
    try:
        placement = load_placement(job_id)
    except Exception:  # noqa: BLE001 — ohne Platzierung bleibt die Wolke metrisch
        placement = None
        logger.warning("[%s] Volumenwolke ohne Platzierung des Quellmodells", job_id)

    npz = _punkte_holen(job_id, lauf_id)
    arbeit = Path(tempfile.mkdtemp(prefix="volumenwolke-"))
    try:
        daten = np.load(npz)
        werte = {k: daten[k] for k in daten.files if k not in ("xyz", "bauteil")}
        punkte = {
            "xyz": daten["xyz"], "werte": werte, "bauteil": daten["bauteil"],
            "tabelle": bericht.get("bauteile", []),
            "kombination": "GZT",
            "elementgroesse_m": (bericht.get("annahmen") or {}).get("elementgroesse_m"),
        }
        volumenwolke.aufbauen(punkte, arbeit, feld=feld, placement=placement,
                              stufen=stufen, verlauf=verlauf, verformt=verformt)
        for datei in ("tile.pnts", "tileset.json", "skala.json"):
            put_bytes(BUCKET, f"{_praefix(job_id, lauf_id)}/wolken/{kennung}/{datei}",
                      (arbeit / datei).read_bytes(),
                      "application/octet-stream" if datei.endswith(".pnts")
                      else "application/json")
        return (arbeit / name).read_bytes()
    except ValueError as fehler:
        raise HTTPException(status_code=400, detail=str(fehler))
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)
        shutil.rmtree(npz.parent, ignore_errors=True)


@router.get("/{job_id}/volumen/{lauf_id}/wolke/{feld}/tileset.json", tags=["Volumen"])
async def wolke_tileset(job_id: str, lauf_id: str, feld: str,
                        stufen: int | None = None, verlauf: str | None = None,
                        verformt: float = 0.0):
    """
    Eine Ergebnisgröße als 3D-Tileset.

    Der Viewer lädt diese URL wie jedes andere Tileset; `tile.pnts` und
    `skala.json` löst er relativ dazu auf — deshalb haben alle drei Endpunkte
    denselben Pfadstamm.
    """
    daten = await asyncio.to_thread(_wolke_holen, job_id, lauf_id, feld,
                                    "tileset.json", stufen, verlauf, verformt)
    return Response(content=daten, media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/{job_id}/volumen/{lauf_id}/wolke/{feld}/tile.pnts", tags=["Volumen"])
async def wolke_tile(job_id: str, lauf_id: str, feld: str,
                     stufen: int | None = None, verlauf: str | None = None,
                     verformt: float = 0.0):
    """
    Die Punkte samt aller Werte.

    Die Kachel trägt in ihrer Batch-Table **jede** gerechnete Größe je Punkt,
    nicht nur die dargestellte. Ein Klick im Viewer liefert damit den ganzen
    Spannungszustand, ohne dass der Server noch einmal gefragt werden muss.
    """
    daten = await asyncio.to_thread(_wolke_holen, job_id, lauf_id, feld,
                                    "tile.pnts", stufen, verlauf, verformt)
    return Response(content=daten, media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/{job_id}/volumen/{lauf_id}/wolke/{feld}/skala.json", tags=["Volumen"])
async def wolke_skala(job_id: str, lauf_id: str, feld: str,
                      stufen: int | None = None, verlauf: str | None = None,
                      verformt: float = 0.0):
    """Legende, Wertebereich, Bauteiltabelle und die Liste aller Größen."""
    daten = await asyncio.to_thread(_wolke_holen, job_id, lauf_id, feld,
                                    "skala.json", stufen, verlauf, verformt)
    return Response(content=daten, media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/{job_id}/volumen/{lauf_id}/punkt", tags=["Volumen"])
async def punkt(job_id: str, lauf_id: str, x: float, y: float, z: float,
                radius: float | None = None):
    """
    Alle Werte am nächstgelegenen Punkt — der Klick in die Wolke.

    `x`, `y`, `z` sind tile-lokale Koordinaten, also dieselben, in denen die
    Wolke liegt; der Viewer rechnet den angeklickten Weltpunkt über die
    Tileset-Transformation dorthin zurück.

    Der Weg über die Batch-Table ist der schnellere und der Regelfall. Diesen
    hier braucht es, wenn `scene.pick()` danebentrifft — bei kleinen Punkten,
    eingeschaltetem Eye-Dome-Lighting oder einem halbtransparenten Bauteil
    davor —, `scene.pickPosition()` aber sehr wohl einen Ort liefert.
    """
    from tiling import volumenwolke

    npz = _punkte_holen(job_id, lauf_id)
    try:
        treffer = await asyncio.to_thread(volumenwolke.punkt_abfragen, npz,
                                          (x, y, z), radius)
    finally:
        shutil.rmtree(npz.parent, ignore_errors=True)
    if treffer is None:
        raise HTTPException(
            status_code=404,
            detail=f"Kein Ergebnispunkt innerhalb von {radius} m um diese Stelle.")

    try:
        bericht = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bericht.json")
        tabelle = bericht.get("bauteile", [])
        treffer["bauteil_info"] = next(
            (b for b in tabelle if b.get("index") == treffer["bauteil"]), None)
    except S3Error:
        pass
    return treffer


@router.get("/{job_id}/volumen/{lauf_id}/schnittgroessen/{global_id}", tags=["Volumen"])
async def schnittgroessen(job_id: str, lauf_id: str, global_id: str):
    """
    N, V und M entlang der Achse eines Bauteils.

    Die Brücke vom Kontinuum zurück zum Stabwerk: aus dem Spannungsfeld
    integriert, in denselben Größen, mit denen EC2, EC3 und EC5 nachweisen.
    Der Verlauf ist zugleich die Probe — V ist die Ableitung von M.
    """
    try:
        bericht = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bericht.json")
    except S3Error:
        raise HTTPException(status_code=404,
                            detail=f"Für Lauf '{lauf_id}' gibt es keine Ergebnisse.")
    schnitte = bericht.get("schnittgroessen", {})
    if global_id not in schnitte:
        raise HTTPException(
            status_code=404,
            detail=f"Für Bauteil '{global_id}' gibt es keine Schnittgrößen. "
                   f"Gerechnet wurden: {', '.join(schnitte) or 'keine'}.")
    return {"global_id": global_id, **schnitte[global_id]}


@router.delete("/{job_id}/volumen/{lauf_id}", tags=["Volumen"])
async def loeschen(job_id: str, lauf_id: str):
    """Einen Lauf samt Wolken entfernen."""
    minio = get_minio()
    entfernt = 0
    for objekt in minio.list_objects(BUCKET, prefix=f"{_praefix(job_id, lauf_id)}/",
                                     recursive=True):
        minio.remove_object(BUCKET, objekt.object_name)
        entfernt += 1
    LAEUFE.pop(lauf_id, None)
    if not entfernt:
        raise HTTPException(status_code=404, detail=f"Lauf '{lauf_id}' gibt es nicht.")
    return {"lauf_id": lauf_id, "entfernt": entfernt}


# ── Die Werkstoffbibliothek ───────────────────────────────────────────────


@bibliothek_router.get("/werkstoffe", tags=["Volumen"])
async def werkstoffe():
    """
    Alles, was gerechnet werden kann — für die Auswahl im Panel.

    Neben Namen und Familie kommen die Kennwerte mit, die auf der Oberfläche
    stehen sollen: Steifigkeit längs und quer, Wichte, Bemessungsfestigkeit.
    Bei Holz ist der Unterschied zwischen E_0 und E_90 der Grund, warum die
    Faserrichtung abgefragt wird — wer die Zahlen nebeneinander sieht,
    versteht die Frage ohne weitere Erklärung.
    """
    from ileen import werkstoff as wk

    liste = []
    for name, w in wk.WERKSTOFFE.items():
        liste.append({
            "name": name, "familie": w.familie,
            "E_0_MNm2": round(w.E_1 / wk.MPA, 0),
            "E_90_MNm2": round(w.E_2 / wk.MPA, 0),
            "G_MNm2": round(w.G_12 / wk.MPA, 0),
            "nu": w.nu_12,
            "wichte_kNm3": round(w.rho_kNm3, 2),
            "isotrop": w.isotrop,
            "f_d_MNm2": round((w.f_yd or w.f_md or w.f_cd or 0.0) / wk.MPA, 2),
            "gamma_M": w.gamma_M, "k_mod": w.k_mod,
            "hinweis": w.hinweis,
        })
    return {"werkstoffe": liste,
            "familien": sorted({w["familie"] for w in liste})}
