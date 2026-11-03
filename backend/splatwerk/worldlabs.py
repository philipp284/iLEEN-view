"""
World Labs Developer API (Atlas, Marble 2) — der eine Client für Worker und Container.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Hier und nicht in ``ileen/``, weil beide Seiten ihn brauchen: der Container für
``atlasChisel`` und ``splats2Mesh`` (``api/routes/atlas.py``), der Worker auf dem
Mac für ``images2PosedRGBD`` (``splatwerk/worker.py``, Verfahren „atlas"). Das
Paket ``ileen`` zieht beim Import JAX herein, das der Worker nicht hat; dieses
Modul braucht nur ``httpx`` und ``numpy``.

## Der Schlüssel

Nie aus dem Browser, nie aus dem Repo. ``worldlabs auth login`` (World-Labs-CLI)
legt ihn als Klartextdatei ab, je API-Adresse eine:
``~/.config/worldlabs/credentials/<sha256(origin)>.key``. Auf dem Mac liest der
Worker sie dort, im Container hängt das Verzeichnis nur lesend unter
``/run/worldlabs`` (``WORLDLABS_CREDENTIALS_DIR``). Gelesen wird bei jedem
Aufruf — eine Anmeldung wirkt ohne Neustart. ``WLT_API_KEY`` geht vor, wie bei
der CLI.

## Die Schnittstelle

``https://api.atlas-beta.worldlabs.ai/api/v2``, Kopfzeile ``WLT-Api-Key``.
Aufgaben sind lange laufende Operationen: ``POST /tasks:<name>`` mit
``Idempotency-Key`` → ``POST /operations/{id}:wait`` (blockiert bis 30 s). Assets
bis 10 MiB gehen inline als ``data:``-URL, größere über eine signierte
Upload-Adresse. Ergebnis-URLs verfallen; dann ``:createReadUrl``.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import math
import os
import random
import struct
import zlib
from pathlib import Path

import httpx
import numpy as np

logger = logging.getLogger(__name__)

API_ORIGIN = os.environ.get("WORLDLABS_API_ORIGIN", "https://api.atlas-beta.worldlabs.ai").rstrip("/")


def _schluessel_dir() -> Path:
    if os.environ.get("WORLDLABS_CREDENTIALS_DIR"):
        return Path(os.environ["WORLDLABS_CREDENTIALS_DIR"])
    basis = os.environ.get("WORLDLABS_CONFIG_DIR") or (Path.home() / ".config" / "worldlabs")
    return Path(basis) / "credentials"


SCHLUESSEL_DIR = _schluessel_dir()

#: Inline-Assets dürfen dekodiert höchstens 10 MiB groß sein; darüber geht es
#: über eine signierte Upload-Adresse.
_INLINE_MAX = 9 * 1024 * 1024

#: Diese Antworten sind vorübergehend und werden mit demselben
#: Idempotenzschlüssel wiederholt (siehe „Errors and retries" der Doku).
_WIEDERHOLEN = {429, 500, 502, 503, 504}


class AtlasFehler(Exception):
    """Ein Fehler, den man dem Menschen vor dem Bildschirm sagen kann."""

    def __init__(self, status: int, meldung: str, roh=None):
        super().__init__(meldung)
        self.status = status
        self.meldung = meldung
        self.roh = roh


# ── Schlüssel ───────────────────────────────────────────────────────────────

def schluessel_datei() -> Path:
    """Die Datei, in die ``worldlabs auth login`` den Schlüssel schreibt."""
    return SCHLUESSEL_DIR / (hashlib.sha256(API_ORIGIN.encode()).hexdigest() + ".key")


def schluessel() -> tuple[str | None, str | None]:
    """(Schlüssel, Quelle) — Quelle ist ``umgebung``, ``datei`` oder None."""
    wert = (os.environ.get("WLT_API_KEY") or "").strip()
    if wert:
        return wert, "umgebung"
    try:
        wert = schluessel_datei().read_text(encoding="utf-8").strip()
    except OSError:
        return None, None
    return (wert, "datei") if wert else (None, None)


# ── Fehlermeldungen ─────────────────────────────────────────────────────────

def _detail(antwort: httpx.Response):
    try:
        koerper = antwort.json()
    except ValueError:
        return antwort.text[:400], None
    if isinstance(koerper, dict):
        d = koerper.get("detail") if "detail" in koerper else koerper.get("message")
        if isinstance(d, list):
            # FastAPI/pydantic: [{loc: [...], msg: "..."}] — bei einer Beta-Schnittstelle
            # die wichtigste Auskunft überhaupt.
            teile = []
            for e in d[:6]:
                if isinstance(e, dict):
                    ort = ".".join(str(x) for x in (e.get("loc") or [])[1:])
                    teile.append(f"{ort}: {e.get('msg')}" if ort else str(e.get("msg")))
            d = "; ".join(teile)
        return (str(d) if d else str(koerper)[:400]), koerper.get("code")
    return str(koerper)[:400], None


def _meldung(status: int, detail: str, code, pfad: str) -> str:
    if status in (401, 403):
        return ("World Labs lehnt den Schlüssel ab. Rechte nötig: tasks.create, operations.read, "
                "assets.create, assets.read." + (f" ({detail})" if detail else ""))
    if status == 402:
        if code == "SPEND_LIMIT_EXCEEDED":
            return "Monatliches Ausgabenlimit erreicht — im World-Labs-Konto unter Billing anheben."
        return "Kein Guthaben mehr im World-Labs-Konto (Credits aufladen)."
    if status == 404 and "/tasks:" in pfad:
        return f"Diese Aufgabe ist für dein Konto nicht freigeschaltet ({pfad.split(':')[-1]})."
    if status == 429:
        if code == "CONCURRENCY_LIMIT_EXCEEDED":
            return "Zu viele laufende Aufträge dieser Art — bitte warten, bis einer fertig ist."
        return "World Labs bremst gerade (zu viele Anfragen) — gleich noch einmal."
    if status == 422:
        return f"World Labs nimmt die Anfrage nicht an: {detail}"
    return f"World Labs antwortet {status}: {detail}"


# ── HTTP ────────────────────────────────────────────────────────────────────

async def anfrage(methode: str, pfad: str, *, json=None, params=None, kopf=None,
                  frist_s: float = 60.0, wiederholen: bool = True):
    """Eine Anfrage an die Developer API, mit Wiederholung bei 429/5xx.

    Für Task-Einreichungen gehört der Idempotenzschlüssel in ``kopf`` — die
    Wiederholung schickt denselben Schlüssel und denselben Körper, so entsteht
    nie ein zweiter, bezahlter Auftrag.
    """
    wert, _ = schluessel()
    if not wert:
        raise AtlasFehler(401, "Kein World-Labs-Schlüssel. Einmal im eigenen Terminal `worldlabs auth login` "
                               "ausführen.")
    kopfzeilen = {"WLT-Api-Key": wert, **(kopf or {})}
    antwort = None
    async with httpx.AsyncClient(base_url=API_ORIGIN, timeout=frist_s) as client:
        for versuch in range(4):
            try:
                antwort = await client.request(methode, pfad, json=json, params=params, headers=kopfzeilen)
            except httpx.TransportError as e:
                if not wiederholen or versuch == 3:
                    raise AtlasFehler(503, f"World Labs nicht erreichbar: {e}") from e
                await asyncio.sleep(_pause(None, versuch))
                continue
            if antwort.status_code in _WIEDERHOLEN and wiederholen and versuch < 3:
                await asyncio.sleep(_pause(antwort, versuch))
                continue
            break
    if antwort.status_code >= 400:
        detail, code = _detail(antwort)
        logger.warning("World Labs %s %s → %s %s", methode, pfad, antwort.status_code, detail)
        raise AtlasFehler(antwort.status_code, _meldung(antwort.status_code, detail, code, pfad), detail)
    return antwort.json() if antwort.content else None


def _pause(antwort: httpx.Response | None, versuch: int) -> float:
    basis = 2.0 ** versuch * (0.5 + random.random() / 2)
    if antwort is not None:
        wert = (antwort.headers.get("retry-after") or "").strip()
        if wert.isdigit():
            return max(basis, float(wert))
    return basis


# ── Assets ──────────────────────────────────────────────────────────────────

async def asset_hochladen(daten: bytes, mime: str, name: str) -> str:
    """Legt ein Asset im Projekt an und gibt seine Kennung (``asset_…``) zurück."""
    if len(daten) <= _INLINE_MAX:
        roh = base64.b64encode(daten).decode("ascii")
        antwort = await anfrage("POST", "/api/v2/assets",
                                json={"asset": {"displayName": name, "base64": f"data:{mime};base64,{roh}"}},
                                frist_s=180)
        return _asset_id(antwort)
    angelegt = await anfrage("POST", "/api/v2/assets", json={"asset": {"displayName": name}})
    kennung = _asset_id(angelegt)
    schein = await anfrage("POST", f"/api/v2/assets/{kennung}:createUploadUrl",
                           json={"contentType": mime, "contentLength": len(daten)})
    async with httpx.AsyncClient(timeout=1800) as client:
        # Ohne API-Schlüssel: die Adresse ist selbst die Berechtigung.
        r = await client.request(schein.get("method") or "PUT", schein["uploadUrl"],
                                 content=daten, headers=schein.get("headers") or {})
    if r.status_code >= 400:
        raise AtlasFehler(r.status_code, f"Hochladen von {name} gescheitert ({r.status_code})")
    await anfrage("POST", f"/api/v2/assets/{kennung}:completeUpload", json={"sizeBytes": len(daten)})
    return kennung


def _asset_id(antwort: dict) -> str:
    kennung = (antwort or {}).get("id") or ((antwort or {}).get("name") or "").split("/")[-1]
    if not kennung:
        raise AtlasFehler(502, f"Asset ohne Kennung zurückbekommen: {str(antwort)[:200]}")
    return kennung


async def asset_lesen(asset: dict) -> bytes:
    """Lädt ein Ergebnis-Asset ({assetId, url} oder {base64}). Eine verfallene URL wird neu ausgestellt."""
    if (asset or {}).get("base64"):
        roh = asset["base64"]
        return base64.b64decode(roh.split(",", 1)[1] if roh.startswith("data:") else roh)
    url = (asset or {}).get("url")
    async with httpx.AsyncClient(timeout=600, follow_redirects=True) as client:
        if url:
            r = await client.get(url)
            if r.status_code < 400:
                return r.content
        kennung = (asset or {}).get("assetId")
        if not kennung:
            raise AtlasFehler(502, "Ergebnis ohne Asset-Kennung")
        frisch = await anfrage("POST", f"/api/v2/assets/{kennung}:createReadUrl")
        r = await client.get(frisch["readUrl"])
        if r.status_code >= 400:
            raise AtlasFehler(r.status_code, f"Ergebnis {kennung} nicht ladbar ({r.status_code})")
        return r.content


# ── Aufgaben und Operationen ────────────────────────────────────────────────

async def aufgabe_einreichen(aufgabe: str, koerper: dict, idempotenz: str) -> dict:
    return await anfrage("POST", f"/api/v2/tasks:{aufgabe}", json=koerper,
                         kopf={"Idempotency-Key": idempotenz}, frist_s=180)


async def operation_warten(kennung: str, bei_stand=None, frist_s: float = 3600.0, abbruch=None) -> dict:
    """Wartet, bis eine Operation fertig ist. ``:wait`` blockiert serverseitig bis 30 s.

    ``bei_stand(operation)`` bekommt jeden Zwischenstand — ``metadata`` trägt, wo
    vorhanden, ``state``, ``phase`` und ``progressPercent``. ``abbruch()`` → True
    beendet das Warten (die Aufgabe bei World Labs läuft weiter).
    """
    beginn = asyncio.get_running_loop().time()
    fehlversuche = 0
    while True:
        if abbruch and abbruch():
            raise asyncio.CancelledError()
        try:
            op = await anfrage("POST", f"/api/v2/operations/{kennung}:wait",
                               json={"timeoutSecs": 30}, frist_s=75)
            fehlversuche = 0
        except AtlasFehler as e:
            # Ein Gateway-Aussetzer beim Warten ist kein Fehlschlag der Aufgabe.
            fehlversuche += 1
            if e.status not in (502, 503, 504) or fehlversuche > 5:
                raise
            await asyncio.sleep(5)
            continue
        if bei_stand:
            try:
                bei_stand(op)
            except Exception:  # noqa: BLE001 — ein Anzeigefehler darf das Warten nicht beenden
                logger.exception("World Labs: Zwischenstand nicht verarbeitet")
        if op.get("done"):
            return op
        if asyncio.get_running_loop().time() - beginn > frist_s:
            raise AtlasFehler(504, f"Operation {kennung} läuft nach {int(frist_s)} s noch — "
                                   "sie arbeitet weiter, der Stand lässt sich später abholen.")
        await asyncio.sleep(1)


def fehler_der_operation(op: dict) -> str | None:
    """Text des Fehlers einer fertigen Operation, oder None."""
    if not op.get("error"):
        return None
    e = op["error"] or {}
    return f"World Labs meldet: {e.get('message') or e}"


async def pruefen() -> dict:
    """Ist ein Schlüssel da, und nimmt World Labs ihn an? (wie ``worldlabs auth status``)"""
    wert, quelle = schluessel()
    stand = {"origin": API_ORIGIN, "schluessel": bool(wert), "quelle": quelle,
             "datei": str(schluessel_datei()), "gueltig": None, "meldung": None}
    if not wert:
        stand["meldung"] = "Kein Schlüssel. Im eigenen Terminal `worldlabs auth login` ausführen."
        return stand
    try:
        await anfrage("GET", "/api/v2/assets", params={"pageSize": 1}, frist_s=30, wiederholen=False)
        stand["gueltig"] = True
    except AtlasFehler as e:
        stand["gueltig"] = False
        stand["meldung"] = e.meldung
    return stand


# ── OpenEXR ─────────────────────────────────────────────────────────────────

def exr_schreiben(tiefe: np.ndarray, kanal: str = "Y") -> bytes:
    """Ein einkanaliges, unkomprimiertes OpenEXR (float32, Zeile 0 oben).

    Der Kanal heißt ``Y``: so liest der Three.js-``EXRLoader`` — den World Labs
    in der Doku selbst zum Lesen seiner Tiefen nimmt — ein einkanaliges Bild;
    ein Kanal ``R`` allein gilt ihm als „unsupported data channels".

    Aufbau nach der OpenEXR-Dateiformatbeschreibung: Kennung und Version,
    Kopf aus Attributen (Name, Typ, Größe, Wert), Offsettabelle mit einem
    Eintrag je Zeile, dann die Zeilenblöcke (y, Länge, Pixel). ``INCREASING_Y``
    heißt: der erste Block ist die oberste Bildzeile — das ist die Ordnung der
    Kameraintrinsik, und die API verlangt sie so.
    """
    a = np.ascontiguousarray(tiefe, dtype="<f4")
    if a.ndim != 2:
        raise ValueError("Tiefe muss zweidimensional sein")
    h, w = a.shape

    def attr(name: str, typ: str, wert: bytes) -> bytes:
        return name.encode() + b"\0" + typ.encode() + b"\0" + struct.pack("<i", len(wert)) + wert

    kanaele = kanal.encode() + b"\0" + struct.pack("<i", 2) + b"\0\0\0\0" + struct.pack("<ii", 1, 1) + b"\0"
    fenster = struct.pack("<iiii", 0, 0, w - 1, h - 1)
    kopf = (struct.pack("<i", 20000630) + struct.pack("<i", 2)
            + attr("channels", "chlist", kanaele)
            + attr("compression", "compression", b"\0")
            + attr("dataWindow", "box2i", fenster)
            + attr("displayWindow", "box2i", fenster)
            + attr("lineOrder", "lineOrder", b"\0")
            + attr("pixelAspectRatio", "float", struct.pack("<f", 1.0))
            + attr("screenWindowCenter", "v2f", struct.pack("<ff", 0.0, 0.0))
            + attr("screenWindowWidth", "float", struct.pack("<f", 1.0))
            + b"\0")
    zeile = w * 4
    block = 8 + zeile
    beginn = len(kopf) + 8 * h
    offsets = struct.pack(f"<{h}Q", *(beginn + y * block for y in range(h)))
    teile = [kopf, offsets]
    for y in range(h):
        teile.append(struct.pack("<ii", y, zeile))
        teile.append(a[y].tobytes())
    return b"".join(teile)


#: Kompression (Kennung im Kopf) → Zeilen je Block. Gelesen werden die vier ohne
#: Wavelet: keine, RLE, ZIPS, ZIP. PIZ, PXR24, B44 und DWA geht über OpenCV.
_EXR_ZEILEN = {0: 1, 1: 1, 2: 1, 3: 16}
_EXR_TYPEN = {0: ("<u4", 4), 1: ("<f2", 2), 2: ("<f4", 4)}


def _exr_entpacken(roh: bytes, art: int, laenge: int) -> bytes:
    """Ein Block → rohe Bytes. RLE und ZIP teilen Vorhersage und Byte-Umordnung."""
    if art == 0 or len(roh) == laenge:
        # Bringt die Kompression nichts, schreibt OpenEXR den Block unkomprimiert.
        return roh
    if art in (2, 3):
        t = zlib.decompress(roh)
    elif art == 1:
        aus = bytearray()
        i = 0
        while i < len(roh):
            n = struct.unpack_from("<b", roh, i)[0]
            i += 1
            if n < 0:
                aus += roh[i:i - n]
                i -= n
            else:
                aus += bytes([roh[i]]) * (n + 1)
                i += 1
        t = bytes(aus)
    else:
        raise ValueError(f"EXR-Kompression {art}")
    d = np.frombuffer(t, dtype=np.uint8).astype(np.int64)
    if len(d) > 1:
        d[1:] -= 128
    d = (np.cumsum(d) & 0xFF).astype(np.uint8)
    halb = (len(d) + 1) // 2
    aus = np.empty_like(d)
    aus[0::2] = d[:halb]
    aus[1::2] = d[halb:]
    return aus.tobytes()


def exr_lesen(daten: bytes, kanal: str | None = None) -> np.ndarray:
    """Ein OpenEXR (Scanline, ein Teil) → float32 (H, W), Zeile 0 oben.

    Einkanalig: dieser Kanal, gleich wie er heißt. Mehrkanalig: ``kanal``, sonst
    der erste von R, Y, Z, depth (die Reihenfolge des Werkzeugs von World Labs).
    Kompressionen ohne Wavelet liest dieser Code selbst; für PIZ, DWA & Co. greift
    OpenCV (``OPENCV_IO_ENABLE_OPENEXR``), das der Worker auf dem Mac hat.
    """
    if struct.unpack_from("<i", daten, 0)[0] != 20000630:
        raise ValueError("kein OpenEXR")
    if struct.unpack_from("<i", daten, 4)[0] & 0x1A00:
        return _exr_opencv(daten)        # gekachelt (0x200), deep (0x800) oder mehrteilig (0x1000)
    p = 8
    attrs = {}
    while daten[p] != 0:
        ende = daten.index(b"\0", p)
        name = daten[p:ende].decode()
        p = daten.index(b"\0", ende + 1) + 1
        groesse = struct.unpack_from("<i", daten, p)[0]
        p += 4
        attrs[name] = daten[p:p + groesse]
        p += groesse
    p += 1
    art = attrs["compression"][0]
    if art not in _EXR_ZEILEN:
        return _exr_opencv(daten)
    x0, y0, x1, y1 = struct.unpack("<iiii", attrs["dataWindow"])
    w, h = x1 - x0 + 1, y1 - y0 + 1
    kanaele = []
    roh = attrs["channels"]
    q = 0
    while roh[q] != 0:
        ende = roh.index(b"\0", q)
        typ = struct.unpack_from("<i", roh, ende + 1)[0]
        kanaele.append((roh[q:ende].decode(), typ))
        q = ende + 1 + 16
    kanaele.sort(key=lambda k: k[0].encode())
    namen = [k[0] for k in kanaele]
    if kanal and kanal in namen:
        wahl = namen.index(kanal)
    elif len(kanaele) == 1:
        wahl = 0
    else:
        wahl = next((namen.index(n) for n in ("R", "Y", "Z", "depth", "Depth") if n in namen), None)
        if wahl is None:
            raise ValueError(f"EXR-Kanäle nicht eindeutig: {namen}")
    zeilen_je_block = _EXR_ZEILEN[art]
    bloecke = math.ceil(h / zeilen_je_block)
    offsets = struct.unpack_from(f"<{bloecke}Q", daten, p)
    je_zeile = [w * _EXR_TYPEN[t][1] for _, t in kanaele]
    zeile_bytes = sum(je_zeile)
    aus = np.empty((h, w), dtype=np.float32)
    dtyp = _EXR_TYPEN[kanaele[wahl][1]][0]
    vor = sum(je_zeile[:wahl])
    for off in offsets:
        y, n = struct.unpack_from("<ii", daten, off)
        zeilen = min(zeilen_je_block, y1 + 1 - y)
        block = _exr_entpacken(daten[off + 8:off + 8 + n], art, zeilen * zeile_bytes)
        for k in range(zeilen):
            start = k * zeile_bytes + vor
            aus[y - y0 + k] = np.frombuffer(block, dtype=dtyp, count=w, offset=start).astype(np.float32)
    return aus


def _exr_opencv(daten: bytes) -> np.ndarray:
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    try:
        import cv2
    except ImportError as e:
        raise ValueError("Diese EXR-Kompression liest nur OpenCV (pip3 install opencv-python)") from e
    bild = cv2.imdecode(np.frombuffer(daten, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if bild is None:
        raise ValueError("OpenCV kann das EXR nicht lesen")
    if bild.ndim == 3:
        bild = bild[..., 2]        # OpenCV ordnet BGR: Index 2 ist R
    return bild.astype(np.float32)


def ausfuehren(koroutine):
    """Für den Worker (synchron): eine Koroutine in einer eigenen Ereignisschleife."""
    return asyncio.run(koroutine)
