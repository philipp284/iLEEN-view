"""
Lastabtrag über alle Geschosse — und die Verknüpfung der Ergebnisse mit dem IFC.

Die Statikroute (`fem.py`) rechnet *eine* Decke und legt Bericht und Bilder
unter einer `result_id` ab. Danach ist die Rechnung fertig und die Verbindung
zum Bauwerk endet an der Unterkante der Platte: welche Wand die Auflagerkraft
trägt, steht zwar in `auflager[].bauteile`, aber nirgends, wo man später
danach fragen könnte.

Diese Route schließt beides. Sie rechnet das ganze Haus von oben nach unten und
schreibt das Ergebnis **an die Bauteile** — je GlobalId ein Konto mit dem, was
ankommt, was das Bauteil selbst wiegt, was es weitergibt und ob es das trägt.

    POST   /assets/{job_id}/tragwerk/lastabtrag       Kette starten
    GET    /assets/{job_id}/tragwerk                  alle Läufe
    GET    /assets/{job_id}/tragwerk/{lauf_id}        Stand und Gesamtergebnis
    GET    …/{lauf_id}/bauteile                       alle Konten
    GET    …/{lauf_id}/bauteil/{gid}                  ein Bauteil
    GET    …/{lauf_id}/geschoss/{deckenfeld}          FE-Bericht eines Deckenfelds
    GET    …/{lauf_id}/bild/{deckenfeld}/{name}       ein Ergebnisbild
    GET    …/{lauf_id}/felder/{deckenfeld}            welche Größen darstellbar sind
    GET    …/{lauf_id}/wolke/{deckenfeld}/{groesse}/tileset.json
    POST   …/{lauf_id}/ifc                            angereicherte IFC
    DELETE /assets/{job_id}/tragwerk/{lauf_id}

**`{deckenfeld}` ist nicht dasselbe wie ein Geschossname.** Ein Geschoss kann
mehrere Deckenfelder haben — bei einem Gebäude aus zwei Baukörpern sind es
zwei, und jedes wird für sich gerechnet. Der Schlüssel ist der Geschossname für
das erste Feld und `"EG (2)"`, `"EG (3)"` für die weiteren; welche es gibt,
steht in `ergebnis.felder` des Laufs. Der Pfadabschnitt heißt aus historischen
Gründen weiterhin `geschoss`.

Das Wort „Feld" ist dabei doppelt belegt und wird hier durchgehend
unterschieden: ein **Deckenfeld** ist ein Stück Bauwerk, eine **Größe**
(`{groesse}`) ist eine Ergebniskarte wie `moment_x` oder `durchbiegung`.

**Warum ein eigener Bucket und nicht der von `fem`.** Ein FEM-Lauf gehört zu
einer Zeichnung, ein Lastabtrag zum Bauwerk. Sie haben verschiedene
Lebensdauern: eine Decke wird zwanzigmal neu gerechnet, während der Lastabtrag
einmal steht — und umgekehrt macht eine geänderte Nutzungsannahme jeden
Lastabtrag ungültig, ohne dass die einzelnen Deckenrechnungen falsch würden.

**Die Kette läuft lange.** Je Geschoss eine FE-Rechnung, also Minuten bis
Viertelstunden für ein Mehrfamilienhaus. Sie läuft deshalb als
Hintergrundaufgabe mit Fortschrittsmeldung, und wie in `fem.py` serialisiert —
JAX belegt für jede Zerlegung mehrere Gigabyte.
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

BUCKET = "tragwerk"

# Wie in `fem.py`: eine Rechnung zur Zeit. Hier wiegt es schwerer, weil ein
# Lauf mehrere Zerlegungen hintereinander macht.
_schlange = asyncio.Semaphore(1)
LAEUFE: dict[str, dict] = {}


class LastabtragAnfrage(BaseModel):
    """Was die Kette wissen muss, was nicht im Modell steht."""

    beton: str | None = Field(None, description="Betongüte, Standard C25/30")
    nutzlast_kategorie: str | None = Field(
        None, description="Nach DIN EN 1991-1-1/NA, Standard A2 (Wohnen)")
    ausbaulast_kNm2: float | None = Field(None, description="Standard 1,5 kN/m²")
    dicke_m: float | None = Field(
        None, description="Deckendicke; ohne Angabe aus Property-Set oder Hüllbox")
    nur_tragende: bool = Field(
        True, description="Wände mit LoadBearing = False nicht als Auflager ansetzen")
    halterung: str | None = Field(
        None, description="Wandhalterung: zweiseitig | eingespannt_unten | "
                          "beidseitig_eingespannt | kragend")
    oeffnungsanteil: float = Field(
        0.0, ge=0.0, le=0.9,
        description="Pauschaler Abzug für Fenster und Türen am Wandeigengewicht")
    geschosse: list[str] | None = Field(
        None, description="Nur diese Geschosse rechnen; sonst alle")
    elementgroesse_m: float | None = Field(None, description="Netzweite je Decke")
    bilder: bool = Field(True, description="Ergebnisbilder je Geschoss ablegen")
    bettung_kNm3: float | None = Field(
        None, gt=0.0,
        description="Bettungsmodul der Bodenplatte (Winkler). Ohne Angabe "
                    "20 000 kN/m³ — mitteldicht gelagerter Sand/Kies. Die "
                    "Spanne reicht von 5 000 (weicher Ton) bis über 100 000 "
                    "(Fels); die Sohlspannung folgt dem Wert fast linear.")
    bodenplatte_dicke_m: float | None = Field(
        None, gt=0.0,
        description="Dicke der Bodenplatte; ohne Angabe gemessen. Getrennt von "
                    "`dicke_m`: eine Sohlplatte ist regelmäßig dicker als eine "
                    "Geschossdecke, und die Dicke geht kubisch in die "
                    "Steifigkeit ein.")
    nutzlast_je_raum: dict[str, str] | None = Field(
        None, description="GlobalId des Raums → Nutzlastkategorie; sticht die "
                          "Deutung aus der Raumnutzung")


class TragwerkLauf(BaseModel):
    lauf_id: str
    job_id: str
    status: str = "queued"           # queued | running | done | failed
    anteil: float = 0.0
    text: str = ""
    gestartet: str = ""
    beendet: str | None = None
    fehler: str | None = None
    geschosse_gerechnet: int = 0
    geschosse_gesamt: int = 0
    bauteile: int = 0
    gruendungslast_kN: float | None = None
    erhalten: bool | None = None
    nachweise_offen: int = 0
    eingriffe: int = 0


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat()


def _praefix(job_id: str, lauf_id: str) -> str:
    return f"{job_id}/{lauf_id}"


def _ensure_bucket() -> None:
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
        logger.warning("Tragwerk %s: Status nicht speicherbar (%s)", lauf_id, fehler)
    return eintrag


def _status_lesen(job_id: str, lauf_id: str) -> dict | None:
    """
    Der Stand eines Laufs — erst der laufende Prozess, dann die Ablage.

    **Verwaiste Läufe werden dabei erkannt.** `LAEUFE` lebt im Prozessspeicher,
    `status.json` in MinIO. Ein Lauf, der in der Ablage auf „running" steht,
    aber im Speicher fehlt, wurde von einem *anderen* Prozess begonnen — er ist
    einem Neustart, einem Absturz oder einem `docker compose up --build` zum
    Opfer gefallen. Weiterrechnen wird er nicht mehr.

    Ohne diese Prüfung bliebe er für immer „running": das Panel zeigte ewigen
    Fortschritt, die Warteschlange sähe belegt aus, und niemand käme auf die
    Idee, dass die Rechnung längst nicht mehr existiert. Genau das geschah hier
    — ein Lauf stand anderthalb Stunden auf 50 %, während sein Prozess seit
    einem Neubau nicht mehr lief.
    """
    eintrag = LAEUFE.get(lauf_id)
    if eintrag is not None and eintrag.get("job_id") == job_id:
        return eintrag
    try:
        abgelegt = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/status.json")
    except S3Error:
        return None

    if abgelegt.get("status") in ("queued", "running"):
        abgelegt = {
            **abgelegt,
            "status": "failed",
            "beendet": _jetzt(),
            "text": "abgebrochen",
            "fehler": (
                f"Der Lauf wurde bei {round(float(abgelegt.get('anteil') or 0) * 100)} % "
                f"unterbrochen — der rechnende Prozess existiert nicht mehr "
                f"(Neustart des Backends oder Absturz). Zuletzt: "
                f"{abgelegt.get('text') or 'ohne Angabe'}. Neu starten."),
        }
        # Den korrigierten Stand zurückschreiben, damit die Liste nicht bei
        # jedem Abruf neu urteilen muss und der Lauf nicht wieder auftaucht.
        try:
            put_json(BUCKET, f"{_praefix(job_id, lauf_id)}/status.json", abgelegt)
        except Exception as fehler:  # noqa: BLE001
            logger.warning("Tragwerk %s: verwaister Status nicht schreibbar (%s)",
                           lauf_id, fehler)
    return abgelegt


# ── Das statische System: die Eingriffe ────────────────────────────────────
#
# Neben den Läufen, nicht in ihnen. Ein Lauf ist ein Ergebnis und vergeht; die
# Eingriffe sind der Stand der Entscheidungen und bleiben. Der Unterstrich im
# Schlüssel hält sie aus der Laufliste heraus, die alles unter `{job}/` als
# Lauf liest.

EINGRIFFSSCHLUESSEL = "_eingriffe.json"


def eingriffe_lesen(job_id: str) -> list[dict]:
    """
    Die Eingriffe am statischen System dieses Modells.

    Eine flache Liste, keine Versionsverwaltung. Ein Eingriff ist eine
    Entscheidung des Tragwerksplaners — „diese Wand trägt nicht" —, und sie
    gilt oder gilt nicht. Ob die Zahlen daneben noch zu ihr passen, beantwortet
    nicht ein Merkmal am Eingriff, sondern der Eingabe-Hash des Submodells.
    """
    _ensure_bucket()
    try:
        bestand = get_json(BUCKET, f"{job_id}/{EINGRIFFSSCHLUESSEL}")
    except S3Error:
        return []
    if isinstance(bestand, dict):
        return list(bestand.get("eingriffe") or [])
    return list(bestand or [])


def eingriffe_schreiben(job_id: str, liste: list[dict]) -> list[dict]:
    _ensure_bucket()
    put_json(BUCKET, f"{job_id}/{EINGRIFFSSCHLUESSEL}",
             {"eingriffe": liste, "stand": _jetzt()})
    return liste


def nutzlast_stand(job_id: str) -> dict:
    """
    Was der nächste Lastabtrag an Nutzlast je Raum ansetzen wird — ohne zu rechnen.

    Für die Raumansicht: sie zeigt die Kategorie, mit der die Statik rechnet,
    und die hängt an drei Dingen außerhalb des Raumnamens:

    * **Eingriffe** `nutzlast_raum` — von Hand gesetzt, gelten sofort.
    * **Die Vorgabe der Annahmen** — was der Lastabtrag für Räume ansetzt,
      deren Nutzung er nicht erkennt. Sie steht im jüngsten Lauf; ohne
      Angabe dort gilt A2, wie in `tragwerksmodell.statikmodell()`.
    * Gibt es keinen Lauf, gibt es auch keine Vorgabe — dann sagt die
      Raumansicht „Vorgabe der Annahmen" ohne Zahl, statt eine zu raten.

    @returns `{eingriffe: {gid: {kategorie, nr}}, vorgabe: {kategorie, lauf, stand} | None}`
    """
    eingriffe = {}
    for e in eingriffe_lesen(job_id):
        if e.get("art") == "nutzlast_raum" and e.get("bauteil"):
            eingriffe[e["bauteil"]] = {"kategorie": (e.get("wert") or {}).get("kategorie"),
                                       "nr": e.get("nr")}

    juengster = None
    try:
        objekte = list(get_minio().list_objects(BUCKET, prefix=f"{job_id}/", recursive=False))
    except Exception:  # noqa: BLE001 — ohne Ablage keine Vorgabe, aber eine Raumliste
        objekte = []
    for objekt in objekte:
        lauf_id = objekt.object_name.rstrip("/").split("/")[-1]
        if lauf_id.startswith("_"):
            continue
        eintrag = _status_lesen(job_id, lauf_id)
        if not eintrag or eintrag.get("status") != "done":
            continue
        if juengster is None or (eintrag.get("gestartet") or "") > (juengster.get("gestartet") or ""):
            juengster = eintrag
    vorgabe = None
    if juengster:
        annahmen = juengster.get("annahmen") or {}
        vorgabe = {"kategorie": annahmen.get("nutzlast_kategorie") or "A2",
                   "lauf": juengster.get("lauf_id"), "stand": juengster.get("gestartet")}
    return {"eingriffe": eingriffe, "vorgabe": vorgabe}


# ── Der Bestand der Submodelle ─────────────────────────────────────────────
#
# Eine Datei je Modell, nicht je Lauf: sie beschreibt den **Zustand**, nicht
# ein Ergebnis. Ein Lauf vergeht, die Frage „was ist aktuell" bleibt.

SUBMODELLSCHLUESSEL = "_submodelle.json"


def submodelle_lesen(job_id: str) -> dict:
    """
    Submodellname → `{art, hash, rechnung: {id, hash, status, stand}}`.

    Der Bestand wächst mit den Läufen: jeder trägt für die Submodelle, die er
    gerechnet hat, seinen Hash und seine Kennung ein. Was er nicht angefasst
    hat, bleibt stehen — das ist die Grundlage der inkrementellen Rechnung.
    """
    _ensure_bucket()
    try:
        bestand = get_json(BUCKET, f"{job_id}/{SUBMODELLSCHLUESSEL}")
    except S3Error:
        return {}
    return bestand.get("submodelle", {}) if isinstance(bestand, dict) else {}


def submodelle_schreiben(job_id: str, bestand: dict) -> dict:
    _ensure_bucket()
    put_json(BUCKET, f"{job_id}/{SUBMODELLSCHLUESSEL}",
             {"submodelle": bestand, "stand": _jetzt()})
    return bestand


def _als_lauf(eintrag: dict) -> TragwerkLauf:
    bekannt = set(TragwerkLauf.model_fields)
    return TragwerkLauf(**{k: v for k, v in eintrag.items() if k in bekannt})


# ── Endpunkte ──────────────────────────────────────────────────────────────


@router.post("/{job_id}/tragwerk/lastabtrag", response_model=TragwerkLauf,
             tags=["Tragwerk"])
async def lastabtrag_starten(job_id: str, anfrage: LastabtragAnfrage,
                             hintergrund: BackgroundTasks):
    """
    Rechnet das ganze Gebäude von oben nach unten durch.

    Geprüft wird hier nur, was ohne Rechnung zu prüfen ist: dass es das Modell
    gibt und dass es Geschosse hat. Alles Weitere meldet der Lauf über seinen
    Status — ein Geschoss ohne rechenbare Decke soll die Kette nicht mit einem
    HTTP-Fehler beenden, sondern übersprungen und im Bericht vermerkt werden.
    """
    return await lauf_einreihen(job_id, anfrage, hintergrund)


async def lauf_einreihen(job_id: str, anfrage: LastabtragAnfrage,
                         hintergrund: BackgroundTasks) -> TragwerkLauf:
    """
    Einen Lauf anlegen und in den Hintergrund geben.

    Als eigene Funktion, weil ein Lauf aus zwei Anlässen entsteht: weil jemand
    ihn startet — und weil ein Eingriff das System geändert hat und die
    Lastverteilung damit veraltet ist. Beide sollen denselben Weg gehen, sonst
    driften Prüfung und Buchführung.
    """
    from api.routes import plan as planroute
    from tiling import section

    src = await asyncio.to_thread(planroute._local_source, job_id)
    try:
        geschosse = await asyncio.to_thread(section.storeys, src, job_id)
    except ValueError as fehler:
        raise HTTPException(status_code=422, detail=str(fehler))
    if not geschosse:
        raise HTTPException(
            status_code=422,
            detail=f"Modell '{job_id}' hat keine IfcBuildingStorey mit Höhenangabe — "
                   f"ohne Geschosse gibt es keine Reihenfolge, in der gerechnet wird.")

    eingriffe = eingriffe_lesen(job_id)

    lauf_id = uuid.uuid4().hex[:12]
    _ensure_bucket()
    eintrag = _status_schreiben(
        job_id, lauf_id, status="queued", anteil=0.0, text="eingereiht",
        gestartet=_jetzt(), beendet=None, fehler=None,
        geschosse_gesamt=len(geschosse), geschosse_gerechnet=0, bauteile=0,
        eingriffe=len(eingriffe),
        annahmen=anfrage.model_dump(exclude_none=True))

    hintergrund.add_task(_lauf_starten, job_id=job_id, lauf_id=lauf_id,
                         anfrage=anfrage)
    return _als_lauf(eintrag)


@router.get("/{job_id}/tragwerk/uebersicht", tags=["Tragwerk"])
async def uebersicht(job_id: str):
    """
    Der Baum des FE-Browsers: Gesamtsystem und alle Submodelle mit Zustand.

    **Hier wird nicht gerechnet.** Die Antwort kommt aus zwei kleinen Dateien
    — dem Zustandsbestand und den Eingriffen —, nicht aus den Rechenständen.
    Ein Browser, der beim Öffnen die Berichte von acht Submodellen lädt, um
    einen Baum zu zeigen, braucht dafür Sekunden; hier sind es Millisekunden.

    Der Zustand je Knoten ist `aktuell` · `veraltet` · `nie gerechnet` ·
    `fehlerhaft`, und er entsteht aus dem Vergleich zweier Hashes — nicht aus
    einem Merkmal, das jemand setzen müsste. Siehe `ileen/stand.py`.
    """
    from ileen import stand as sd
    from ileen import submodell as sm

    bestand = submodelle_lesen(job_id)
    propagiert = sd.propagiere(bestand)
    knoten = []
    for name, eintrag in propagiert.items():
        kurz, feld = sm.zerlegen(name)
        knoten.append({
            "submodell": name,
            "kuerzel": kurz,
            "feld": feld,
            "rang": sm.rang(kurz),
            "art": eintrag.get("art") or sd.GESCHOSS,
            "geschoss": eintrag.get("geschoss"),
            "platte": eintrag.get("platte"),
            "zustand": eintrag["zustand"],
            "grund": eintrag.get("grund") or "",
            "hat_plan": bool(eintrag.get("hat_plan")),
            "rechnung": eintrag.get("rechnung") or {},
        })
    # Von oben nach unten, wie die Kette rechnet; Nebenrechnungen ans Ende.
    knoten.sort(key=lambda k: (k["art"] != sd.GESCHOSS, k["rang"],
                               k["feld"] or 0))

    return {
        "job_id": job_id,
        "gesamt": sd.gesamtzustand(propagiert),
        "submodelle": knoten,
        "zu_rechnen": sd.zu_rechnen(propagiert),
        "eingriffe": len(eingriffe_lesen(job_id)),
    }


@router.get("/{job_id}/tragwerk/submodell/{submodell}/rechnungen",
            tags=["Tragwerk"])
async def rechenstaende(job_id: str, submodell: str):
    """
    Alle Rechenstände eines Submodells, jüngster zuerst.

    **Der aktuellste ist der gültige**, und er ist der einzige, der als solcher
    markiert wird. Ältere sind hier abrufbar — anschauen, vergleichen, löschen.
    Sie zu behalten kostet fast nichts und beantwortet die Frage, die nach
    jeder Änderung kommt: was war vorher?
    """
    _ensure_bucket()
    bestand = submodelle_lesen(job_id)
    eintrag = bestand.get(submodell)
    aktuell = ((eintrag or {}).get("rechnung") or {}).get("id")

    staende = []
    for objekt in get_minio().list_objects(BUCKET, prefix=f"{job_id}/",
                                           recursive=False):
        lauf_id = objekt.object_name.rstrip("/").split("/")[-1]
        if lauf_id.startswith("_"):
            continue
        try:
            bericht = get_json(
                BUCKET,
                f"{_praefix(job_id, lauf_id)}/geschosse/{_sicher(submodell)}.json")
        except S3Error:
            continue        # dieser Lauf hat dieses Submodell nicht gerechnet
        status = _status_lesen(job_id, lauf_id) or {}
        plan_daten = (bericht.get("modell") or {}).get("plan") or {}
        staende.append({
            "lauf_id": lauf_id,
            "aktuell": lauf_id == aktuell,
            "gestartet": status.get("gestartet"),
            "beendet": status.get("beendet"),
            "eingabe_hash": plan_daten.get("eingabe_hash"),
            "gilt_noch": (plan_daten.get("eingabe_hash")
                          == (eintrag or {}).get("hash")),
            "annahmen": status.get("annahmen") or {},
            "hat_plan": True,
        })
    staende.sort(key=lambda s: (s["beendet"] or s["gestartet"] or ""),
                 reverse=True)
    return {"submodell": submodell, "aktuell": aktuell, "staende": staende}


@router.get("/{job_id}/tragwerk", response_model=list[TragwerkLauf], tags=["Tragwerk"])
async def laeufe(job_id: str):
    """Alle Lastabträge dieses Modells, jüngste zuerst."""
    _ensure_bucket()
    ergebnis: list[TragwerkLauf] = []
    for objekt in get_minio().list_objects(BUCKET, prefix=f"{job_id}/", recursive=False):
        lauf_id = objekt.object_name.rstrip("/").split("/")[-1]
        if lauf_id.startswith("_"):
            continue        # `_eingriffe.json` ist kein Lauf
        eintrag = _status_lesen(job_id, lauf_id)
        if eintrag:
            ergebnis.append(_als_lauf(eintrag))
    ergebnis.sort(key=lambda e: e.gestartet, reverse=True)
    return ergebnis


@router.get("/{job_id}/tragwerk/{lauf_id}", tags=["Tragwerk"])
async def lauf(job_id: str, lauf_id: str):
    """Stand und — sobald fertig — Bilanz, Gründungslasten und Geschossübersicht."""
    eintrag = _status_lesen(job_id, lauf_id)
    if eintrag is None:
        raise HTTPException(status_code=404, detail=f"Lauf '{lauf_id}' gibt es nicht.")

    antwort = dict(eintrag)
    if eintrag.get("status") == "done":
        try:
            antwort["ergebnis"] = get_json(
                BUCKET, f"{_praefix(job_id, lauf_id)}/uebersicht.json")
        except S3Error:
            logger.warning("Tragwerk %s: Übersicht fehlt trotz Status 'done'", lauf_id)
    return antwort


@router.get("/{job_id}/tragwerk/{lauf_id}/bauteile", tags=["Tragwerk"])
async def bauteile(job_id: str, lauf_id: str, rolle: str | None = None,
                   geschoss: str | None = None, nur_kritisch: bool = False):
    """
    Die Bauteilkonten — das eigentliche Ergebnis der Kette.

    Je Bauteil und Geschoss ein Eintrag: was ankommt (nach Lastfall getrennt),
    was es wiegt, was es weitergibt, und der Nachweis. Über `rolle`,
    `geschoss` und `nur_kritisch` filterbar, weil ein Mehrfamilienhaus
    schnell mehrere hundert Konten hat.
    """
    try:
        daten = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bauteile.json")
    except S3Error:
        raise HTTPException(status_code=404,
                            detail=f"Für Lauf '{lauf_id}' gibt es keine Bauteilkonten.")

    konten = daten.get("konten", [])
    if rolle:
        konten = [k for k in konten if k.get("rolle") == rolle]
    if geschoss:
        konten = [k for k in konten if (k.get("geschoss") or "").lower() == geschoss.lower()]
    if nur_kritisch:
        konten = [k for k in konten if _kritisch(k)]
    konten.sort(key=lambda k: k.get("bemessung", {}).get("N_Ed_kN", 0), reverse=True)
    return {"job_id": job_id, "lauf_id": lauf_id, "anzahl": len(konten),
            "konten": konten}


@router.get("/{job_id}/tragwerk/{lauf_id}/bauteil/{global_id}", tags=["Tragwerk"])
async def bauteil(job_id: str, lauf_id: str, global_id: str):
    """
    Alle Konten eines Bauteils — der Weg vom Klick im Viewer zum Ergebnis.

    Ein Bauteil kann mehrere Konten haben, wenn dieselbe `IfcWall` über mehrere
    Geschosse läuft. Zurück kommen alle, nach Geschoss geordnet.
    """
    try:
        daten = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bauteile.json")
    except S3Error:
        raise HTTPException(status_code=404,
                            detail=f"Für Lauf '{lauf_id}' gibt es keine Bauteilkonten.")

    treffer = [k for k in daten.get("konten", []) if k.get("global_id") == global_id]
    if not treffer:
        raise HTTPException(
            status_code=404,
            detail=f"Bauteil '{global_id}' kommt im Lastabtrag '{lauf_id}' nicht vor. "
                   f"Es trägt entweder nicht oder wurde als nichttragend verworfen.")
    return {"global_id": global_id, "konten": treffer}


@router.get("/{job_id}/tragwerk/{lauf_id}/geschoss/{name}", tags=["Tragwerk"])
async def geschossbericht(job_id: str, lauf_id: str, name: str):
    """
    Der vollständige FE-Bericht **eines Deckenfelds**.

    `name` ist der Feldschlüssel, nicht zwingend der Geschossname: hat ein
    Geschoss mehrere Felder, heißen sie „EG", „EG (2)" und so fort. Die Liste
    steht in `ergebnis.felder` des Laufs.
    """
    try:
        return get_json(BUCKET,
                        f"{_praefix(job_id, lauf_id)}/geschosse/{_sicher(name)}.json")
    except S3Error:
        raise HTTPException(status_code=404,
                            detail=f"Für Geschoss '{name}' gibt es keinen Bericht.")


@router.get("/{job_id}/tragwerk/{lauf_id}/zeichnung/{name}", tags=["Tragwerk"])
async def zeichnung(job_id: str, lauf_id: str, name: str, teil: str = "beide"):
    """
    Die Schnittzeichnung eines Deckenfelds — Grundlage der erzeugten Planblätter.

    **Warum geschnitten und nicht abgelegt.** Der Lauf hat diese Zeichnung
    bereits erzeugt, aber sie mitzuspeichern hieße, je Deckenfeld zwei
    Grundrisse mit zusammen einigen Megabyte in den Speicher zu legen — bei
    neun Feldern über fünfzig Megabyte für einen Lauf, dessen übrige Ausgabe
    zusammen ein Zehntel davon wiegt. Stattdessen merkt sich der Lauf die
    **Schnittlage** (`modell.plan.schnittlage`, ein paar Bytes) und hier wird
    damit neu geschnitten. Das ist bitgleich dieselbe Zeichnung, und der
    Section-Cache (`/tmp/section`, eigenes Volume) macht den zweiten Aufruf
    schnell.

    Zwei Schnitte, weil ein Positionsplan beides braucht: `decke` liegt in der
    Plattenmitte und zeigt die Deckenfelder — das ist der Schalplan. `waende`
    liegt auf halber Wandhöhe des Geschosses darunter und zeigt den Grundriss,
    auf dem die Decke aufliegt. Ohne ihn schwebte der Positionsplan über einem
    leeren Blatt.

    Der Signaturkatalog kommt einmal für beide mit; er ist für jeden Schnitt
    derselbe und würde die Antwort sonst verdoppeln.
    """
    from tiling import section

    try:
        eintrag = get_json(
            BUCKET, f"{_praefix(job_id, lauf_id)}/geschosse/{_sicher(name)}.json")
    except S3Error:
        raise HTTPException(status_code=404,
                            detail=f"Für Geschoss '{name}' gibt es keinen Bericht.")

    lage = ((eintrag.get("modell") or {}).get("plan") or {}).get("schnittlage")
    if not lage:
        raise HTTPException(
            status_code=409,
            detail=f"Der Lauf '{lauf_id}' hat für '{name}' keine Schnittlage "
                   f"vermerkt — er stammt aus der Zeit vor den erzeugten "
                   f"Planblättern. Ein neuer Lastabtrag legt sie an.")

    from api.routes import plan as planroute
    src = planroute._local_source(job_id)

    def schneiden(hoehe: float) -> dict:
        zeichnung = section.cut(
            src, job_id,
            section.Box(center=tuple(lage["center"]), size=tuple(lage["size"])),
            "grundriss", float(hoehe), with_views=False, with_rooms=True)
        return {
            "job_id": job_id,
            "mode": "grundriss",
            "figures": [vars(f) for f in zeichnung.figures],
            "rooms": [vars(r) for r in zeichnung.rooms],
            "bounds": list(zeichnung.bounds),
            "plane_origin": list(zeichnung.plane_origin),
        }

    antwort: dict = {
        "feld": name,
        "geschoss": eintrag.get("geschoss"),
        "platte": eintrag.get("platte"),
        "job_id": job_id,
        "signaturen": section.catalog(),
        "schnittlage": lage,
    }
    if teil in ("beide", "decke"):
        antwort["decke"] = await asyncio.to_thread(schneiden, lage["hoehe_decke"])
    if teil in ("beide", "waende"):
        antwort["waende"] = await asyncio.to_thread(schneiden, lage["hoehe_waende"])
    return antwort


@router.get("/{job_id}/tragwerk/{lauf_id}/plan/{submodell}", tags=["Tragwerk"])
async def geschossplan(job_id: str, lauf_id: str, submodell: str):
    """
    Der Geschossplan eines Submodells als SVG.

    Er entsteht mit der Rechnung und liegt beim Submodell — abrufbar ist er
    hier über den Lauf, weil ein Plan zu genau einem Rechenstand gehört. Wer
    den aktuellen will, fragt den Lauf, der als aktuell geführt wird.
    """
    _ensure_bucket()
    try:
        daten = get_bytes(
            BUCKET, f"{_praefix(job_id, lauf_id)}/zeichnungen/{_sicher(submodell)}.svg")
    except S3Error:
        raise HTTPException(
            status_code=404,
            detail=f"Für '{submodell}' gibt es in Lauf {lauf_id} keinen Plan. "
                   f"Läufe von vor September 2026 haben keine; ein neuer "
                   f"Lastabtrag legt ihn an.")
    return Response(content=daten, media_type="image/svg+xml")


@router.get("/{job_id}/tragwerk/{lauf_id}/bild/{geschoss}/{name}", tags=["Tragwerk"])
async def bild(job_id: str, lauf_id: str, geschoss: str, name: str):
    """Ein Ergebnisbild einer Geschossdecke als PNG."""
    sicher = Path(name).name
    if sicher != name or not sicher.endswith(".png"):
        raise HTTPException(status_code=400, detail="Ungültiger Bildname.")
    try:
        daten = get_bytes(
            BUCKET,
            f"{_praefix(job_id, lauf_id)}/bilder/{_sicher(geschoss)}/{sicher}")
    except S3Error:
        raise HTTPException(status_code=404, detail=f"Bild '{sicher}' gibt es nicht.")
    return Response(content=daten, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/{job_id}/tragwerk/{lauf_id}/felder/{geschoss}", tags=["Tragwerk"])
async def felder(job_id: str, lauf_id: str, geschoss: str):
    """
    Welche Ergebnisgrößen dieses Deckenfeld räumlich darstellen kann.

    `geschoss` ist der Feldschlüssel (siehe `geschossbericht`), zurück kommen
    die darstellbaren Größen — Momente, Durchbiegung, erforderliche Bewehrung.
    """
    from tiling import ergebniswolke

    pfad = await asyncio.to_thread(_felder_holen, job_id, lauf_id, geschoss)
    if pfad is None:
        raise HTTPException(
            status_code=404,
            detail=f"Für das Deckenfeld '{geschoss}' gibt es keine Ergebnisgrößen. "
                   f"Entweder ist der Schlüssel falsch — bei mehreren Feldern je "
                   f"Geschoss heißt das zweite '{geschoss} (2)', die Liste steht in "
                   f"ergebnis.felder — oder der Lauf ist älter als die Ergebnisfelder.")
    return {"deckenfeld": geschoss,
            "felder": await asyncio.to_thread(ergebniswolke.verfuegbare_felder, pfad)}


@router.get("/{job_id}/tragwerk/{lauf_id}/wolke/{geschoss}/{feld}/tileset.json",
            tags=["Tragwerk"])
async def wolke_tileset(job_id: str, lauf_id: str, geschoss: str, feld: str,
                        ueberhoehung: float = 0.0, stufen: int | None = None,
                        verlauf: str | None = None):
    """
    Eine Ergebnisgröße eines Deckenfelds als 3D-Tileset.

    Der Viewer lädt diese URL wie jedes andere Tileset; `tile.pnts` und
    `skala.json` löst er relativ dazu auf, weshalb alle drei Endpunkte
    denselben Pfadstamm haben müssen. Erzeugt wird die Wolke beim ersten Abruf
    und danach aus dem Speicher bedient — sie hängt an einem abgeschlossenen
    Lauf und ändert sich nicht mehr.

    `ueberhoehung` trägt die Durchbiegung als Relief auf: 0 legt die Wolke flach
    in die Deckenebene, 100 macht aus 8 mm Durchbiegung 80 cm sichtbaren
    Versatz. Für die Anschauung nützlich, für die Verortung irreführend —
    deshalb standardmäßig aus.

    `stufen` und `verlauf` übersteuern die Farbgebung des Feldes: 16 abgesetzte
    Regenbogenstufen machen aus der Durchbiegungsfläche ein Höhenlinienbild, 0
    schaltet auf den stetigen Verlauf zurück. Beide gehen in den Speicherpfad
    ein — dieselbe Größe in zwei Farbgebungen sind zwei Wolken.
    """
    daten = await asyncio.to_thread(
        _wolke_holen, job_id, lauf_id, geschoss, feld, ueberhoehung,
        "tileset.json", stufen, verlauf)
    return Response(content=daten, media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/{job_id}/tragwerk/{lauf_id}/wolke/{geschoss}/{feld}/tile.pnts",
            tags=["Tragwerk"])
async def wolke_tile(job_id: str, lauf_id: str, geschoss: str, feld: str,
                     ueberhoehung: float = 0.0, stufen: int | None = None,
                     verlauf: str | None = None):
    """Der Punktdatenblock zum Tileset."""
    daten = await asyncio.to_thread(
        _wolke_holen, job_id, lauf_id, geschoss, feld, ueberhoehung,
        "tile.pnts", stufen, verlauf)
    return Response(content=daten, media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/{job_id}/tragwerk/{lauf_id}/wolke/{geschoss}/{feld}/skala.json",
            tags=["Tragwerk"])
async def wolke_skala(job_id: str, lauf_id: str, geschoss: str, feld: str,
                      ueberhoehung: float = 0.0, stufen: int | None = None,
                      verlauf: str | None = None):
    """
    Die Legende zur Wolke: Farbstufen mit ihren Grenzen, Einheit, Extremwerte.

    Ohne sie ist die eingefärbte Wolke ein Ornament — man sieht, *wo* es viel
    ist, aber nicht *wieviel*. Die Antwort ist genau die `skala.json`, die
    neben `tile.pnts` liegt, und stammt damit aus demselben Lauf wie die
    Farben; eine zweite Berechnung könnte auseinanderlaufen.

    Die Ausdehnung darin (`ausdehnung.x`, `.y`, `.z_ebene`) ist tile-lokal und
    dient dem Viewer dazu, einen angeklickten Punkt der richtigen Wolke
    zuzuordnen, wenn mehrere Geschosse übereinanderliegen.
    """
    daten = await asyncio.to_thread(
        _wolke_holen, job_id, lauf_id, geschoss, feld, ueberhoehung,
        "skala.json", stufen, verlauf)
    return Response(content=daten, media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"})


@router.get("/{job_id}/tragwerk/{lauf_id}/punkt/{geschoss}", tags=["Tragwerk"])
async def punkt(job_id: str, lauf_id: str, geschoss: str, x: float, y: float):
    """
    Alle Ergebnisgrößen an einer Stelle der Decke — der Klick in die Punktwolke.

    `x` und `y` sind die Koordinaten der Zeichenebene, also dieselben, in denen
    die Wolke liegt; der Viewer rechnet den angeklickten Weltpunkt über die
    Tileset-Transformation dorthin zurück. Zurück kommen Durchbiegung, Momente,
    Biegerandspannungen und die erforderliche Bewehrung oben wie unten, je
    Gruppe geordnet, dazu der Abstand zum nächsten Rasterpunkt.

    Verschiebungen sitzen auf den Knoten, Schnittgrößen in den Elementmitten —
    beide Abstände stehen deshalb einzeln in der Antwort.
    """
    from tiling import ergebniswolke

    pfad = await asyncio.to_thread(_felder_holen, job_id, lauf_id, geschoss)
    if pfad is None:
        raise HTTPException(
            status_code=404,
            detail=f"Für das Deckenfeld '{geschoss}' gibt es keine Ergebnisgrößen.")
    ergebnis = await asyncio.to_thread(ergebniswolke.werte_am_ort, pfad, x, y)
    return {"deckenfeld": geschoss, **ergebnis}


@router.post("/{job_id}/tragwerk/{lauf_id}/ifc", tags=["Tragwerk"])
async def ifc_export(job_id: str, lauf_id: str):
    """
    Eine IFC-Datei mit den Lastabtragsergebnissen an den Bauteilen.

    Dieselbe Geometrie und dieselben GlobalIds wie das Original, dazu je
    tragendem Bauteil ein `Pset_iLEEN_Lastabtrag` mit N_Ed, Ausnutzung und
    Herkunft der Last. Damit sind die Ergebnisse auch außerhalb von iLEEN
    lesbar — in jedem Viewer, jeder Prüfsoftware.

    Das Schreiben dauert bei großen Modellen so lange wie das Lesen, deshalb im
    Threadpool. Die fertige Datei bleibt im Speicher liegen und wird beim
    zweiten Aufruf unverändert ausgeliefert.
    """
    eintrag = _status_lesen(job_id, lauf_id)
    if eintrag is None:
        raise HTTPException(status_code=404, detail=f"Lauf '{lauf_id}' gibt es nicht.")
    if eintrag.get("status") != "done":
        raise HTTPException(
            status_code=409,
            detail=f"Der Lastabtrag ist {eintrag.get('status')} — erst nach "
                   f"Abschluss gibt es Ergebnisse zum Schreiben.")
    return await asyncio.to_thread(_ifc_bauen, job_id, lauf_id)


@router.get("/{job_id}/tragwerk/{lauf_id}/ifc", tags=["Tragwerk"])
async def ifc_holen(job_id: str, lauf_id: str):
    """Die zuvor erzeugte IFC-Datei herunterladen."""
    try:
        daten = get_bytes(BUCKET, f"{_praefix(job_id, lauf_id)}/lastabtrag.ifc")
    except S3Error:
        raise HTTPException(
            status_code=404,
            detail="Noch keine IFC erzeugt — zuerst POST auf denselben Pfad.")
    return Response(
        content=daten, media_type="application/x-step",
        headers={"Content-Disposition": f'attachment; filename="lastabtrag-{lauf_id}.ifc"'})


@router.delete("/{job_id}/tragwerk/{lauf_id}", tags=["Tragwerk"])
async def lauf_loeschen(job_id: str, lauf_id: str):
    eintrag = _status_lesen(job_id, lauf_id)
    if eintrag is None:
        raise HTTPException(status_code=404, detail=f"Lauf '{lauf_id}' gibt es nicht.")
    if eintrag.get("status") in ("queued", "running"):
        raise HTTPException(status_code=409, detail="Der Lastabtrag läuft noch.")
    purge(job_id, lauf_id)
    return {"geloescht": lauf_id}


def purge(job_id: str, lauf_id: str | None = None) -> None:
    """Einen Lauf oder alle eines Modells entfernen — beim Löschen des Assets."""
    from storage.minio_client import delete_prefix

    praefix = f"{job_id}/{lauf_id}" if lauf_id else f"{job_id}/"
    try:
        delete_prefix(BUCKET, praefix)
    except Exception as fehler:  # noqa: BLE001
        logger.warning("Tragwerk: %s nicht löschbar (%s)", praefix, fehler)
    for kennung in [k for k, v in LAEUFE.items()
                    if v.get("job_id") == job_id and (lauf_id is None or k == lauf_id)]:
        LAEUFE.pop(kennung, None)


def _sicher(name: str) -> str:
    """Geschossnamen wie „2. OG" als Dateinamen — ohne Pfadanteile."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:60] or "ohne"


def _kritisch(konto: dict) -> bool:
    """Ein Konto gilt als kritisch, wenn ein Nachweis nicht aufgeht."""
    nachweis = konto.get("nachweis") or {}
    if nachweis.get("erfuellt") is False:
        return True
    for schluessel in ("ausnutzung", "ausnutzung_querschnitt"):
        wert = nachweis.get(schluessel)
        if isinstance(wert, (int, float)) and wert > 0.9:
            return True
    return False


# ── Der Lauf ───────────────────────────────────────────────────────────────


async def _lauf_starten(job_id: str, lauf_id: str, anfrage: LastabtragAnfrage) -> None:
    async with _schlange:
        _status_schreiben(job_id, lauf_id, status="running", anteil=0.01,
                          text="Lastabtrag beginnt")
        try:
            await asyncio.to_thread(_rechnen, job_id, lauf_id, anfrage)
        except Exception as fehler:  # noqa: BLE001 — der Fehler gehört in den Status
            logger.error("Tragwerk %s: fehlgeschlagen (%s)", lauf_id, fehler,
                         exc_info=True)
            _status_schreiben(job_id, lauf_id, status="failed", beendet=_jetzt(),
                              text="fehlgeschlagen", fehler=str(fehler))


def _zugang_bauen(job_id: str, arbeit: Path, ablage: dict, annahmen: dict):
    """
    Die Kette an dieses Backend anschließen.

    `kette.Zugang` kennt weder MinIO noch IfcOpenShell — es fragt über
    Rückrufe. Hier werden sie mit den vorhandenen Bausteinen gefüllt: der
    Schnitt über `tiling.section`, die Property-Sets über die
    Eigenschaftsdatenbank, die Rechnung über `ileen.rechnung`.
    """
    from api.routes import elements as elementroute
    from api.routes import plan as planroute
    from ileen import kette
    from tiling import section

    src = planroute._local_source(job_id)
    _, verzeichnis = section.build_index(src, job_id)

    # Typ und Name gehören mit in die Boxen: die Kette sucht darin die
    # tatsächliche Deckenplatte je Geschoss, und dafür muss sie eine `IfcSlab`
    # von einem Treppenpodest unterscheiden können.
    boxen = {e["global_id"]: {"lo": list(e["lo"]), "hi": list(e["hi"]),
                              "ifc_type": e.get("ifc_type"), "name": e.get("name"),
                              "storey": e.get("storey"),
                              # Für die Tragwerkserkennung: das Material und —
                              # wichtiger — alle Schichten. Bei einer Außenwand
                              # aus 17,5 KS + 20 Dämmung ist die dickste
                              # Schicht die Dämmung, und `material` nennt nur
                              # die. Siehe `ileen/tragend.py`.
                              "material": e.get("material"),
                              "materialschichten": e.get("materialschichten") or []}
             for e in verzeichnis}
    # Volumen und Grundrissrechteck jedes Bauteils aus seinem Netz — für die
    # Eigengewichte und für gedreht liegende Balkenlagen. Ein eigener
    # Durchlauf, einmal je Modell; scheitert er, rechnet die Kette mit den
    # Schnitten und Hüllboxen wie bisher.
    try:
        for gid, form in section.bauteilform(src, job_id).items():
            if gid in boxen:
                if form.get("volumen_m3"):
                    boxen[gid]["volumen_m3"] = form["volumen_m3"]
                if form.get("grundriss"):
                    boxen[gid]["grundriss"] = form["grundriss"]
                if form.get("achse"):
                    boxen[gid]["achse"] = form["achse"]
                    boxen[gid]["querschnitt_m"] = form.get("querschnitt_m")
    except Exception as fehler:  # noqa: BLE001
        logger.warning("[%s] Bauteilform nicht verfügbar (%s)", job_id, fehler)
    # Die Gebäudehülle aus dem Elementverzeichnis: großzügiger und
    # verlässlicher als aus den Räumen, weil auch Bauteile ohne Raumbezug
    # darin stehen.
    huelle = {
        "lo": [min(e["lo"][i] for e in verzeichnis) - 1.0 for i in range(3)],
        "hi": [max(e["hi"][i] for e in verzeichnis) + 1.0 for i in range(3)],
    }

    psets = {}
    try:
        psets = {e["global_id"]: e.get("psets") or {}
                 for e in elementroute.alle_bauteile(job_id)}
    except Exception as fehler:  # noqa: BLE001
        # Ohne Property-Sets fehlt `LoadBearing` — dann zählt jede Wand als
        # Auflager. Das ist eine Verschlechterung, kein Abbruchgrund.
        logger.warning("[%s] Property-Sets nicht lesbar (%s) — LoadBearing "
                       "bleibt unbekannt", job_id, fehler)

    def schnitt(box, mode, cut_height):
        zeichnung = section.cut(
            src, job_id,
            section.Box(center=tuple(box["center"]), size=tuple(box["size"])),
            mode, cut_height, with_views=False, with_rooms=False)
        return {
            "figures": [vars(f) for f in zeichnung.figures],
            "plane_origin": list(zeichnung.plane_origin),
            "bounds": list(zeichnung.bounds),
        }

    def rechne(modell, _annahmen, melden):
        from ileen import rechnung as rechenwerk

        # **Der Schlüssel ist der Submodellname, nicht das Geschoss.**
        # Ein Geschoss kann mehrere Deckenfelder haben — bei einem Gebäude aus
        # zwei Baukörpern sind es zwei. Mit dem Geschossnamen als Schlüssel
        # überschriebe das zweite Feld Bericht, Bilder und Ergebnisfelder des
        # ersten, und der Lauf lieferte am Ende die halbe Wahrheit.
        #
        # Gebildet wird der Name in `kette._platte_rechnen()` und hier nur
        # gelesen: er hängt an der Lage der Platte im Bauwerk, und die kennt
        # diese Funktion nicht.
        geschoss = modell["plan"].get("geschoss", "ohne")
        submodellname = modell["plan"].get("submodell") or geschoss
        berichte = ablage.setdefault("berichte", {})
        schluessel = submodellname

        ziel = arbeit / _sicher(schluessel)
        ziel.mkdir(parents=True, exist_ok=True)
        bericht = rechenwerk.rechne(
            modell, ziel, rechenwerk.Annahmen.aus(
                {"elementgroesse_m": annahmen.get("elementgroesse_m")}
                if annahmen.get("elementgroesse_m") else {}),
            lambda a, t: melden(a, t))
        # **Der Plan entsteht mit der Rechnung, nicht auf Knopfdruck.** Wer ein
        # Haus durchrechnet, will die Blätter — nicht die Erinnerung daran, sie
        # noch erzeugen zu müssen. Er kostet Millisekunden gegenüber einer
        # FE-Rechnung von Minuten.
        #
        # Scheitert er, ist das kein Grund, den Lauf zu verlieren: die Zahlen
        # sind gerechnet, nur das Blatt fehlt.
        grundriss = None
        try:
            from ileen import plan_svg
            grundriss = plan_svg.plan(modell)
        except Exception as fehler:  # noqa: BLE001
            logger.warning("[%s] Plan für %s misslungen (%s)",
                           job_id, submodellname, fehler)

        berichte[schluessel] = {
            "bericht": bericht, "verzeichnis": ziel, "modell": modell,
            "geschoss": geschoss, "submodell": submodellname,
            "platte": (modell.get("system") or [{}])[0].get("bezug"),
            "grundriss_svg": grundriss,
        }
        return bericht

    # **Die Räume mit ihrer Grundrissfigur.** Sie tragen die Nutzung, aus der
    # die raumweisen Nutzlasten entstehen. Scheitert das Raumverzeichnis, ist
    # das kein Abbruchgrund: die Kette fällt dann auf die Vorgabekategorie über
    # das ganze Geschoss zurück — das ist der Stand vor September 2026 und
    # steht als Hinweis im Bericht.
    raeume: list[dict] = []
    try:
        raeume = section.raumkennwerte(src, job_id, mit_grundriss=True)
    except Exception as fehler:  # noqa: BLE001
        logger.warning("[%s] Raumverzeichnis nicht lesbar (%s) — die Nutzlast "
                       "bleibt die Vorgabekategorie", job_id, fehler)

    # Teile mehrschichtiger Bauteile (ArchiCAD): die Kette sieht das Bauteil.
    try:
        eltern = section.bauteil_eltern(src, job_id)
    except Exception as fehler:  # noqa: BLE001
        logger.warning("[%s] Bauteilteile nicht lesbar (%s)", job_id, fehler)
        eltern = {}
    return kette.Zugang(
        eltern=eltern,
        schnitt=schnitt,
        raeume=raeume,
        geschosse=[{"name": g["name"], "boden": g["hoehe"],
                    "decke": None, "bauteile": g.get("bauteile")}
                   for g in section.storeys(src, job_id)],
        psets=psets, boxen=boxen, huelle=huelle, rechne=rechne,
        job_id=job_id, modellname=job_id)


def _decken_ergaenzen(geschosse: list, huelle: dict) -> list:
    """
    Jedem Geschoss seine Deckenhöhe geben.

    `IfcBuildingStorey` trägt nur die Fußbodenhöhe. Die Decke ist der Fußboden
    des nächsten Geschosses; beim obersten die Oberkante des Modells. Eine
    Annahme, aber die einzige, die ohne Geschosshöhen aus dem IFC auskommt —
    und die Kette braucht sie, weil ihre beiden Schnitte je Geschoss genau
    zwischen diesen beiden Höhen liegen.
    """
    sortiert = sorted(geschosse, key=lambda g: float(g["boden"]))
    for i, g in enumerate(sortiert):
        g["decke"] = (float(sortiert[i + 1]["boden"]) if i + 1 < len(sortiert)
                      else float(huelle["hi"][2]) - 1.0)
    return sortiert


def _rechnen(job_id: str, lauf_id: str, anfrage: LastabtragAnfrage) -> None:
    """Der Lauf selbst, in einem Thread."""
    from ileen import kette

    arbeit = Path(tempfile.mkdtemp(prefix=f"tragwerk-{lauf_id}-"))
    ablage: dict = {}
    annahmen = anfrage.model_dump(exclude_none=True)

    try:
        zugang = _zugang_bauen(job_id, arbeit, ablage, annahmen)
        zugang.geschosse = _decken_ergaenzen(zugang.geschosse, zugang.huelle)

        def melden(anteil: float, text: str) -> None:
            _status_schreiben(job_id, lauf_id, status="running",
                              anteil=round(float(anteil), 3), text=text)

        eingriffe = eingriffe_lesen(job_id)
        ergebnis = kette.rechne_kette(zugang, annahmen, melden, eingriffe=eingriffe)

        praefix = _praefix(job_id, lauf_id)

        # Berichte und Bilder je Geschoss — getrennt abgelegt, weil ein
        # einzelner Deckenbericht mehrere hundert Kilobyte hat und niemand
        # alle zugleich braucht.
        for name, eintrag in ablage.get("berichte", {}).items():
            # Der Plan liegt beim Submodell, nicht beim Lauf: er gehört zu
            # dem Ausschnitt, den er zeigt, und überlebt damit das Aufräumen
            # alter Rechenstände.
            if eintrag.get("grundriss_svg"):
                put_bytes(
                    BUCKET,
                    f"{job_id}/{_sicher(name)}/zeichnungen/grundriss.svg",
                    eintrag["grundriss_svg"].encode("utf-8"),
                    content_type="image/svg+xml")
                put_bytes(
                    BUCKET, f"{praefix}/zeichnungen/{_sicher(name)}.svg",
                    eintrag["grundriss_svg"].encode("utf-8"),
                    content_type="image/svg+xml")
            put_bytes(BUCKET, f"{praefix}/geschosse/{_sicher(name)}.json",
                      json_bytes({"feld": name, "geschoss": eintrag["geschoss"],
                                  "submodell": eintrag.get("submodell"),
                                  "platte": eintrag.get("platte"),
                                  "modell": eintrag["modell"],
                                  "bericht": eintrag["bericht"]}, indent=None),
                      content_type="application/json")
            if anfrage.bilder:
                for datei in sorted(Path(eintrag["verzeichnis"]).glob("*.png")):
                    put_bytes(BUCKET,
                              f"{praefix}/bilder/{_sicher(name)}/{datei.name}",
                              datei.read_bytes(), content_type="image/png")
            # Die Rohfelder für die Ergebniswolke. Binär und deutlich kleiner
            # als die Bilder, aber nur nützlich, wenn sie den Lauf überleben.
            npz = Path(eintrag["verzeichnis"]) / "felder.npz"
            if npz.exists():
                put_bytes(BUCKET, f"{praefix}/felder/{_sicher(name)}.npz",
                          npz.read_bytes(), content_type="application/octet-stream")

        # Die Konten als eigene Datei: sie ist das, was der Viewer beim Klick
        # auf ein Bauteil braucht, und soll nicht hinter den Deckenberichten
        # herunterzuladen sein.
        put_bytes(BUCKET, f"{praefix}/bauteile.json",
                  json_bytes({"konten": ergebnis["konten"],
                              "nach_bauteil": ergebnis["nach_bauteil"]}, indent=None),
                  content_type="application/json")

        # Wo die Platte jedes Geschosses liegt — die Ergebniswolke braucht es,
        # um in der Decke zu erscheinen statt auf Höhe null. Die Schnitthöhe
        # taugt dafür nicht: sie liegt fünf Zentimeter unter der Oberkante.
        unterkanten = {}
        for name, eintrag in ablage.get("berichte", {}).items():
            box = zugang.boxen.get(eintrag.get("platte"))
            if box:
                unterkanten[name] = float(box["lo"][2])

        uebersicht = {
            "geschosse": [{k: v for k, v in g.items() if k != "bericht"}
                          for g in ergebnis["geschosse"]],
            "plattenunterkanten": unterkanten,
            "bilanz": ergebnis["bilanz"],
            "gruendung": ergebnis["gruendung"],
            "lastfall_arten": ergebnis["lastfall_arten"],
            "hinweise": ergebnis["hinweise"],
            "eingriffe": ergebnis["eingriffe"],
            "eingriffsprotokoll": ergebnis["eingriffsprotokoll"],
            "bilder": {name: sorted(p.name for p in Path(e["verzeichnis"]).glob("*.png"))
                       for name, e in ablage.get("berichte", {}).items()}
                      if anfrage.bilder else {},
            # Welcher Schlüssel zu welchem Geschoss und welcher Platte gehört —
            # die Adressierung für Berichte, Bilder und Ergebniswolken.
            "felder": [{"schluessel": name, "geschoss": e["geschoss"],
                        "submodell": e.get("submodell"),
                        "platte": e.get("platte"),
                        "flaeche_m2": (e["modell"].get("system") or [{}])[0]
                                      .get("flaeche_m2")}
                       for name, e in ablage.get("berichte", {}).items()],
        }
        put_bytes(BUCKET, f"{praefix}/uebersicht.json",
                  json_bytes(uebersicht),
                  content_type="application/json")

        # ── Den Zustandsbestand fortschreiben ────────────────────────────
        #
        # Für jedes Submodell, das dieser Lauf gerechnet hat: sein Hash und
        # seine Kennung. Was er nicht angefasst hat, bleibt stehen — genau
        # darauf beruht die inkrementelle Rechnung.
        bestand = submodelle_lesen(job_id)
        for eintrag in ablage.get("berichte", {}).values():
            name = eintrag.get("submodell")
            if not name:
                continue
            hash_wert = ((eintrag.get("modell") or {}).get("plan") or {}).get(
                "eingabe_hash")
            bestand[name] = {
                "art": ((eintrag.get("modell") or {}).get("plan") or {}).get(
                    "art") or "geschoss",
                "hash": hash_wert,
                "geschoss": eintrag.get("geschoss"),
                "platte": eintrag.get("platte"),
                "hat_plan": bool(eintrag.get("grundriss_svg")),
                "rechnung": {"id": lauf_id, "hash": hash_wert,
                             "status": "fertig", "stand": _jetzt()},
            }
        submodelle_schreiben(job_id, bestand)

        offen = sum(1 for k in ergebnis["konten"]
                    if (k.get("nachweis") or {}).get("erfuellt") is False)
        gerechnet = sum(1 for g in ergebnis["geschosse"] if g["status"] == "gerechnet")
        _status_schreiben(
            job_id, lauf_id, status="done", anteil=1.0, beendet=_jetzt(),
            text=f"{gerechnet} Geschosse, {len(ergebnis['konten'])} Bauteile",
            geschosse_gerechnet=gerechnet,
            bauteile=len(ergebnis["konten"]),
            gruendungslast_kN=ergebnis["gruendung"]["summe_kN"],
            erhalten=ergebnis["bilanz"]["erhalten"],
            nachweise_offen=offen, eingriffe=len(eingriffe))
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)


# ── Ergebniswolke und IFC ──────────────────────────────────────────────────


def _felder_holen(job_id: str, lauf_id: str, geschoss: str) -> Path | None:
    """Die `felder.npz` eines Geschosses in eine lokale Datei holen."""
    ziel = Path(tempfile.gettempdir()) / "tragwerk-felder" / job_id / lauf_id
    datei = ziel / f"{_sicher(geschoss)}.npz"
    if datei.exists():
        return datei
    try:
        daten = get_bytes(
            BUCKET, f"{_praefix(job_id, lauf_id)}/felder/{_sicher(geschoss)}.npz")
    except S3Error:
        return None
    ziel.mkdir(parents=True, exist_ok=True)
    # Erst daneben schreiben, dann umbenennen — sonst könnte eine zweite
    # Anfrage die halb geschriebene Datei öffnen.
    vorlaeufig = datei.with_suffix(".part")
    vorlaeufig.write_bytes(daten)
    vorlaeufig.replace(datei)
    return datei


def _wolke_holen(job_id: str, lauf_id: str, geschoss: str, feld: str,
                 ueberhoehung: float, name: str, stufen: int | None = None,
                 verlauf: str | None = None) -> bytes:
    """
    Die Ergebniswolke aus dem Speicher, sonst erzeugen.

    Die Kennung trägt alles, was das Ergebnis verändert. Fehlte darin die
    Stufenzahl, bekäme der zweite Abruf mit anderer Farbgebung die Kacheln des
    ersten zurück — und die Legende dazu, die dann nicht mehr zu den Farben
    passt.
    """
    from tiling import ergebniswolke

    kennung = f"{_sicher(geschoss)}/{_sicher(feld)}"
    if ueberhoehung:
        kennung += f"/u{int(ueberhoehung)}"
    if stufen is not None:
        kennung += f"/s{int(stufen)}"
    if verlauf:
        kennung += f"/v{_sicher(verlauf)}"
    objekt = f"{_praefix(job_id, lauf_id)}/wolken/{kennung}/{name}"
    try:
        return get_bytes(BUCKET, objekt)
    except S3Error:
        pass

    npz = _felder_holen(job_id, lauf_id, geschoss)
    if npz is None:
        raise HTTPException(
            status_code=404,
            detail=f"Für Geschoss '{geschoss}' gibt es keine Ergebnisfelder.")

    try:
        uebersicht = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/uebersicht.json")
    except S3Error:
        uebersicht = {}
    unterkanten = uebersicht.get("plattenunterkanten") or {}

    from api.routes.plan import load_placement
    try:
        placement = load_placement(job_id)
    except Exception:  # noqa: BLE001 — ohne Platzierung bleibt die Wolke metrisch
        placement = None
        logger.warning("[%s] Ergebniswolke ohne Platzierung des Quellmodells", job_id)

    arbeit = Path(tempfile.mkdtemp(prefix="wolke-"))
    try:
        protokoll = ergebniswolke.aufbauen(
            npz, arbeit, feld,
            z_unterkante=float(unterkanten.get(geschoss, 0.0)),
            placement=placement, ueberhoehung=ueberhoehung,
            stufen=stufen, verlauf=verlauf)
        for datei in arbeit.iterdir():
            put_bytes(BUCKET,
                      f"{_praefix(job_id, lauf_id)}/wolken/{kennung}/{datei.name}",
                      datei.read_bytes(),
                      content_type=("application/json" if datei.suffix == ".json"
                                    else "application/octet-stream"))
        logger.info("[%s] Ergebniswolke %s/%s: %s Punkte", job_id, geschoss, feld,
                    protokoll["punkte"])
        return (arbeit / name).read_bytes()
    except ValueError as fehler:
        raise HTTPException(status_code=400, detail=str(fehler))
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)


def _ifc_bauen(job_id: str, lauf_id: str) -> dict:
    """Die angereicherte IFC schreiben und ablegen."""
    from api.routes import plan as planroute
    from ileen import tragwerk_ifc

    try:
        konten = get_json(BUCKET, f"{_praefix(job_id, lauf_id)}/bauteile.json")
    except S3Error:
        raise HTTPException(status_code=404,
                            detail=f"Für Lauf '{lauf_id}' gibt es keine Bauteilkonten.")

    quelle = planroute._local_source(job_id)
    arbeit = Path(tempfile.mkdtemp(prefix=f"ifc-{lauf_id}-"))
    try:
        ziel = arbeit / "lastabtrag.ifc"
        protokoll = tragwerk_ifc.anreichern(
            quelle, ziel, konten.get("konten", []),
            titel=f"iLEEN Lastabtrag {lauf_id}")
        put_bytes(BUCKET, f"{_praefix(job_id, lauf_id)}/lastabtrag.ifc",
                  ziel.read_bytes(), content_type="application/x-step")
        protokoll["url"] = f"/assets/{job_id}/tragwerk/{lauf_id}/ifc"
        protokoll.pop("datei", None)
        return protokoll
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)
