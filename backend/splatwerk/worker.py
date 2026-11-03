#!/usr/bin/env python3
"""
Splatwerk-Worker — Fotos hinein, verorteter Gaussian Splat heraus. Läuft auf dem Mac-Host.

Warum nicht im Container: COLMAP und Spirula Studio brauchen die Metal-GPU des Macs. Docker Desktop
reicht sie nicht durch, ein Spirula im Linux-Container liefe über Software-Vulkan und wäre
unbrauchbar langsam. Deshalb liegt nur die *Warteschlange* im Container (`auftrag.py`),
die Arbeit hier.

Der Weg eines Auftrags:

    entpacken      ZIP/Ordner/Bilder/Videos → eine Liste von Medien
    vorbereiten    HEIC → JPEG, aufrecht drehen, verkleinern, GPS und Brennweite aus EXIF
                   lesen; Videos → Einzelbilder (ffmpeg)
    merkmale       COLMAP feature_extractor (SIFT auf der CPU)
    abgleich       COLMAP: alle Paare (≤ 250 Bilder) oder GPS-/Reihenfolge-Nachbarn
    rekonstruktion COLMAP mapper → größtes Teilmodell
    ausrichtung    Kameras ↔ GPS → Ähnlichkeitstransformation → Modell nach ENU (Z oben)
    entzerren      COLMAP image_undistorter (der Trainer bekommt verzeichnungsfreie Pinhole-Bilder)
    training       Spirula Studio (`spirula train`), headless — mit Option „fenster“ zusätzlich
                   sein Trainings-Viewer in einem eigenen Fenster
    abschluss      ergebnis.ply, Hochachsen-Kommentar eintragen

Verfahren „atlas" (Auftragsoption ``verfahren``) ersetzt die COLMAP-Stufen durch World Labs:

    atlas_posen       Bilder hochladen, ``images2PosedRGBD`` → Kameras, Tiefe, Konfidenz je Bild
    atlas_modell      Teile zusammenführen, Tiefe → dichte Startpunkte (``atlas_rekon.py``)
    atlas_ausrichtung wie ``ausrichtung``, aber ohne COLMAP: Modell → ENU, ``train/`` schreiben

Training und Abschluss sind für beide Verfahren dieselben.

Danach setzt der Container (`api/routes/splattraining.py`) die PLY in die Kachel-Pipeline
und verortet sie. Alle Stufen sind wiederholbar: bricht der Worker ab, macht der nächste
Lauf bei der ersten nicht abgeschlossenen Stufe weiter.

Aufruf:
    python3 splatwerk/worker.py                          Dauerbetrieb (launchd)
    python3 splatwerk/worker.py einmal                   Warteschlange abarbeiten, dann beenden
    python3 splatwerk/worker.py anlegen Fotos/ a.zip     Auftrag aus der Kommandozeile (--fenster: Training im Spirula-Fenster)
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from splatwerk import auftrag as A  # noqa: E402
from splatwerk import atlas_rekon, colmap_modell, georef, iphone, plyhilfe, splatpack  # noqa: E402

# ── Werkzeuge ─────────────────────────────────────────────────────────────────


def _finde(name: str, env: str, *fest) -> str | None:
    wert = os.getenv(env)
    if wert and Path(wert).exists():
        return wert
    for f in fest:
        if Path(f).exists():
            return str(f)
    return shutil.which(name)


SPIRULA = _finde("spirula", "SPIRULA_BIN",
                 Path.home() / "Projekte/spirula-studio-app/Spirula Studio.app/Contents/MacOS/spirula",
                 "/Applications/Spirula Studio.app/Contents/MacOS/spirula")
COLMAP = _finde("colmap", "COLMAP_BIN", "/opt/homebrew/bin/colmap", "/usr/local/bin/colmap")
FFMPEG = _finde("ffmpeg", "FFMPEG_BIN", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg")
CAFFEINATE = "/usr/bin/caffeinate" if Path("/usr/bin/caffeinate").exists() else None
FFPROBE = _finde("ffprobe", "FFPROBE_BIN", "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe")

#: Der Trainings-Viewer von Spirula (Option „fenster“) wird in einem eigenen Chrome-Fenster ohne
#: Adressleiste geöffnet; ohne Chrome geht die Adresse an den Standardbrowser.
CHROME_APP = Path("/Applications/Google Chrome.app")
#: Erster Port, den der Viewer versucht (Spirulas eigene Vorgabe).
VIEWER_PORT = int(os.getenv("SPIRULA_VIEWER_PORT", "7007"))

# Ab dieser Bildzahl wird nicht mehr jedes Paar abgeglichen. Die CPU-Variante von SIFT
# braucht für ein Paar etwa so lange wie die GPU-Variante für zehn; bei 250 Bildern sind
# das 31 000 Paare, bei 1000 schon eine halbe Million.
MAX_BILDER_ALLE_PAARE = 250
MAX_BILDER_VIDEO_ALLE_PAARE = 60

# Ohne messbaren Maßstab (Innenräume, kleine Gegenstände: das GPS ist Rauschen) wird angenommen, dass die
# Kameras im Mittel einen Meter von dem entfernt standen, was sie sehen. Eine Handaufnahme liegt meist
# zwischen 0,3 und 3 m — die Annahme verfehlt also höchstens um etwa den Faktor drei, statt um den
# Faktor zwanzig, den COLMAPs beliebige Einheiten leicht ergeben.
ANGENOMMENER_ABSTAND_M = 1.0

STUFEN = [  # Name, Anzeigetext, Gewicht im Gesamtfortschritt
    ("entpacken", "Dateien entpacken", 0.02),
    ("vorbereiten", "Bilder aufbereiten", 0.08),
    ("merkmale", "Merkmale finden (COLMAP)", 0.12),
    ("abgleich", "Bilder abgleichen (COLMAP)", 0.18),
    ("rekonstruktion", "Kameras rekonstruieren (COLMAP)", 0.15),
    ("ausrichtung", "Auf die Welt ausrichten", 0.02),
    ("entzerren", "Bilder entzerren", 0.03),
    ("training", "Splat trainieren (Spirula Studio)", 0.38),
    ("abschluss", "Ergebnis ablegen", 0.02),
]
# Verfahren „atlas": Kameras und dichte Tiefe von World Labs statt COLMAP. Das Training bekommt
# mehr Gewicht, weil die Rekonstruktion selbst bei World Labs läuft und Minuten statt Stunden dauert.
STUFEN_ATLAS = [
    ("entpacken", "Dateien entpacken", 0.02),
    ("vorbereiten", "Bilder aufbereiten", 0.08),
    ("atlas_posen", "Kameras und Tiefe schätzen (World Labs Atlas)", 0.30),
    ("atlas_modell", "Startmodell aus der Tiefe bauen", 0.06),
    ("atlas_ausrichtung", "Auf die Welt ausrichten", 0.02),
    ("training", "Splat trainieren (Spirula Studio)", 0.50),
    ("abschluss", "Ergebnis ablegen", 0.02),
]
_TEXT = {n: t for n, t, _ in STUFEN + STUFEN_ATLAS}


def stufen_fuer(opt: dict) -> list[tuple[str, str, float]]:
    """Die Stufen eines Auftrags. Aufträge von vor dem Atlas-Weg tragen kein `verfahren`: COLMAP."""
    return STUFEN_ATLAS if opt.get("verfahren") == "atlas" else STUFEN


class Abgebrochen(Exception):
    pass


class Fehler(Exception):
    """Der Auftrag ist gescheitert; der Text ist für Menschen geschrieben."""


# ── Hilfen ────────────────────────────────────────────────────────────────────

_LAERM = re.compile(r"Loaded COLMAP image|Tuning |cubecl_runtime|Processed file|^\s*$")


def lauf(auftrag_id: str, cmd: list, *, cwd=None, env=None, zeile=None, nice: int = 0,
         was: str = "", anzeige: str | None = None, fertig=None) -> None:
    """
    Startet ein Programm, schreibt seine Ausgabe ins Protokoll und bricht es auf Wunsch ab.

    Die Abbruchmarke wird von einem eigenen Faden geprüft: ein Trainer meldet sich minutenlang
    nicht, ein Lesen der Ausgabe allein käme nie dazu, nachzusehen.

    `fertig` ist eine Bedingung für Programme, die nach getaner Arbeit nicht von selbst enden
    (ein Trainer mit Fenster, der offen bleibt): wird sie wahr, wird das Programm beendet und der Lauf gilt als gelungen.
    """
    cmd = [str(c) for c in cmd]
    if nice:
        cmd = ["nice", "-n", str(nice), *cmd]
    A.anhaengen(auftrag_id, "$ " + (anzeige or " ".join(cmd)))
    if CAFFEINATE:
        # Ein Auftrag dauert Minuten bis Stunden; ein Laptop, der mitten im Training einschläft (auf
        # Akku nach einer Minute Leerlauf), hält ihn an. `-i` verhindert nur den Ruhezustand im
        # Leerlauf — den Bildschirm lässt es ausgehen, und der Deckel gewinnt weiterhin.
        cmd = [CAFFEINATE, "-i", *cmd]
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, start_new_session=True)
    stopp = threading.Event()
    beendet_von_mir = threading.Event()

    def wache():
        while not stopp.wait(1.0):
            if fertig and proc.poll() is None and fertig():
                time.sleep(2.0)   # die Ergebnisdatei ist ganz geschrieben
                beendet_von_mir.set()
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                return
            if A.abbruch_angefordert(auftrag_id) and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                return

    faden = threading.Thread(target=wache, daemon=True)
    faden.start()
    letzte: list[str] = []
    try:
        for z in proc.stdout:
            z = z.rstrip("\n")
            if zeile:
                zeile(z)
            if not _LAERM.search(z):
                A.anhaengen(auftrag_id, z)
            if z.strip():
                letzte = (letzte + [z])[-6:]
        rc = proc.wait()
    finally:
        stopp.set()
    if A.abbruch_angefordert(auftrag_id):
        raise Abgebrochen()
    if rc != 0 and not beendet_von_mir.is_set():
        raise Fehler(f"{was or Path(cmd[0]).name} ist mit Code {rc} beendet. "
                     + " | ".join(l.strip()[:200] for l in letzte[-3:]))


def pruefe_abbruch(auftrag_id: str) -> None:
    if A.abbruch_angefordert(auftrag_id):
        raise Abgebrochen()


class Stand:
    """Setzt Stufe und Gesamtfortschritt; `bruch` ist der Anteil der laufenden Stufe."""

    def __init__(self, auftrag_id: str, stufen=None):
        self.id = auftrag_id
        self._start = {}
        summe = 0.0
        for n, _, g in (stufen or STUFEN):
            self._start[n] = (summe, g)
            summe += g
        self._letzt = 0.0

    def stufe(self, name: str, meldung: str | None = None, bruch: float = 0.0):
        start, g = self._start[name]
        A.schreibe(self.id, status="laeuft", stufe=name, anteil=round(start + g * bruch, 4),
                   meldung=meldung or _TEXT[name])

    def bruch(self, name: str, bruch: float, meldung: str | None = None):
        # Nicht öfter als einmal je 0,7 s schreiben: COLMAP meldet dutzende Zeilen je Sekunde.
        jetzt = time.time()
        if jetzt - self._letzt < 0.7 and bruch < 0.999:
            return
        self._letzt = jetzt
        self.stufe(name, meldung, max(0.0, min(1.0, bruch)))


# ── 1. Entpacken ──────────────────────────────────────────────────────────────


def _ignoriert(p: Path) -> bool:
    return any(t.startswith(".") or t == "__MACOSX" for t in p.parts) or p.name.lower() == "thumbs.db"


def _entpacke_zip(zpfad: Path, ziel: Path) -> int:
    """ZIP entpacken. Pfade, die aus dem Ziel hinausführen (`../`), werden verworfen."""
    n = 0
    basis = ziel.resolve()
    with zipfile.ZipFile(zpfad) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = Path(info.filename)
            if _ignoriert(rel):
                continue
            out = (ziel / zpfad.stem / rel).resolve()
            if basis not in out.parents:
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, out.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            n += 1
    return n


def entpacken(job: str, ordner: Path) -> dict:
    roh = ordner / "roh"
    shutil.rmtree(roh, ignore_errors=True)
    roh.mkdir()
    for quelle in sorted((ordner / "eingang").rglob("*")):
        if not quelle.is_file() or _ignoriert(quelle.relative_to(ordner / "eingang")):
            continue
        pruefe_abbruch(job)
        if quelle.suffix.lower() == ".zip":
            _entpacke_zip(quelle, roh)
        elif quelle.suffix.lower() in A.BILD_ENDUNGEN | A.VIDEO_ENDUNGEN | splatpack.BEGLEIT_ENDUNGEN:
            ziel = roh / quelle.relative_to(ordner / "eingang")
            ziel.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(quelle, ziel)          # keine zweite Kopie auf der Platte
            except OSError:
                shutil.copy2(quelle, ziel)
    bilder = [p for p in roh.rglob("*") if p.is_file() and p.suffix.lower() in A.BILD_ENDUNGEN and not _ignoriert(p.relative_to(roh))]
    videos = [p for p in roh.rglob("*") if p.is_file() and p.suffix.lower() in A.VIDEO_ENDUNGEN and not _ignoriert(p.relative_to(roh))]
    if not bilder and not videos:
        raise Fehler("Im Upload steckt kein Bild und kein Video (erwartet: JPG, PNG, HEIC, TIF, MP4, MOV).")
    A.anhaengen(job, f"{len(bilder)} Bilder, {len(videos)} Videos gefunden.")
    pakete = splatpack.finde_pakete(roh)
    for p in pakete:
        A.anhaengen(job, f"Aufnahmepaket erkannt: {p.beschreibung} ({p.ordner.name})")
    return {"bilder": len(bilder), "videos": len(videos), "pakete": [p.beschreibung for p in pakete]}


# ── 2. Vorbereiten ────────────────────────────────────────────────────────────


def _heif_anmelden() -> bool:
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
        return True
    except ImportError:
        return False


def _video_info(video: Path) -> dict:
    """Dauer, Bildzahl, Bildrate und die Ortsangabe im Container (Apple: `…location.ISO6709`)."""
    info = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                           "format=duration:format_tags:stream=nb_frames,avg_frame_rate,duration",
                           "-of", "json", str(video)], capture_output=True, text=True)
    try:
        roh = json.loads(info.stdout or "{}")
    except json.JSONDecodeError:
        roh = {}
    fmt = roh.get("format") or {}
    strom = (roh.get("streams") or [{}])[0]
    dauer = float(fmt.get("duration") or strom.get("duration") or 0) or 10.0
    try:
        z, n = (strom.get("avg_frame_rate") or "30/1").split("/")
        fps = float(z) / float(n)
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    bilder = int(strom["nb_frames"]) if str(strom.get("nb_frames", "")).isdigit() else int(round(dauer * fps))
    ort = None
    for k, v in (fmt.get("tags") or {}).items():
        if "location" in k.lower() and not k.lower().endswith("eng"):
            ort = georef.iso6709(v)
            if ort:
                break
    return {"dauer": dauer, "fps": fps, "bilder": bilder, "ort": ort}


# Kantenlänge, auf die jedes Videobild zum Bewerten verkleinert wird. Quadratisch und verzerrt:
# bewertet wird nur, welches Bild eines Zeitfensters das schärfste ist, nicht die Schärfe an sich.
_BEWERTUNG_KANTE = 384
MAX_VIDEOBILDER_JE_SEKUNDE = 5.0


def _video_auswahl(job: str, video: Path, anzahl: int, gesamt: int, melde) -> tuple[list[int], int]:
    """
    Wählt aus einem Video `anzahl` Bilder: je Zeitfenster das schärfste.

    Gleichmäßig in der Zeit zu wählen (wie `-vf fps=…`) trifft bei einem Rundgang mit dem
    Telefon in der Hand ebenso oft ein verwackeltes wie ein scharfes Bild — und COLMAP
    scheitert zuerst an den verwackelten. Das Video wird deshalb einmal klein dekodiert und
    nach Gradientenstärke bewertet. Gibt `(Bildnummern, tatsächliche Gesamtzahl)` zurück.
    """
    kante = _BEWERTUNG_KANTE
    groesse = kante * kante
    punkte: list[float] = []
    proc = subprocess.Popen([FFMPEG, "-v", "error", "-i", str(video), "-vf", f"scale={kante}:{kante},format=gray",
                             "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while True:
            roh = proc.stdout.read(groesse)
            if len(roh) < groesse:
                break
            f = np.frombuffer(roh, dtype=np.uint8).reshape(kante, kante).astype(np.float32)
            punkte.append(float(np.abs(f[:, 1:] - f[:, :-1]).mean() + np.abs(f[1:, :] - f[:-1, :]).mean()))
            if len(punkte) % 150 == 0:
                pruefe_abbruch(job)
                melde(len(punkte) / max(gesamt, 1))
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
    n = len(punkte)
    if n == 0:
        raise Fehler(f"{video.name}: ffmpeg konnte keine Bilder lesen.")
    anzahl = max(1, min(anzahl, n))
    grenzen = np.linspace(0, n, anzahl + 1).astype(int)
    auswahl = [int(a + np.argmax(punkte[a:b])) for a, b in zip(grenzen[:-1], grenzen[1:]) if b > a]
    return auswahl, n


def _bildnummern_ausdruck(idx: list[int]) -> str:
    """
    `select`-Ausdruck, der genau die Bildnummern `idx` durchlässt.

    Als Summe `eq(n,a)+eq(n,b)+…` wäre er links-verschachtelt, und ffmpegs Ausdrucksparser
    erlaubt nur rund 100 Ebenen — bei 120 Bildern scheitert `select` mit „Cannot allocate
    memory“, einer Meldung, die mit dem Speicher nichts zu tun hat. Halbieren hält die Tiefe
    bei log₂(N).
    """
    if len(idx) == 1:
        return f"eq(n,{idx[0]})"
    mitte = len(idx) // 2
    return f"({_bildnummern_ausdruck(idx[:mitte])}+{_bildnummern_ausdruck(idx[mitte:])})"


def _video_bilder(job: str, video: Path, ziel: Path, anzahl: int, bild_max: int, melde,
                  info: "splatpack.VideoInfo | None" = None) -> list[dict]:
    """
    Einzelbilder aus einem Video, je als Quellbeschreibung für `vorbereiten`.

    Mit Aufnahmepaket (`info`) kommen Zeit und Ort je Bild aus dessen Tabellen; sonst gilt die
    eine Ortsangabe des Containers für alle. Jedes Video ist eine eigene Kamera.
    """
    if not FFMPEG or not FFPROBE:
        raise Fehler("ffmpeg fehlt (brew install ffmpeg) — Videos können nicht zerlegt werden.")
    v = _video_info(video)
    anzahl = int(min(anzahl, max(8, v["dauer"] * MAX_VIDEOBILDER_JE_SEKUNDE)))
    gesamt_erwartet = info.anzahl if info and info.anzahl else v["bilder"]
    idx, n = _video_auswahl(job, video, anzahl, gesamt_erwartet, lambda b: melde(0.8 * b))
    ziel.mkdir(parents=True, exist_ok=True)
    for alt in ziel.glob("*.jpg"):
        alt.unlink()
    ausdruck = _bildnummern_ausdruck(idx)
    lauf(job, [FFMPEG, "-y", "-v", "error", "-i", video, "-vf",
               f"select='{ausdruck}',scale=w='min({bild_max},iw)':h='min({bild_max},ih)':force_original_aspect_ratio=decrease",
               "-fps_mode", "passthrough", "-qscale:v", "2", "-start_number", "0", ziel / "%05d.jpg"],
         was="ffmpeg", anzeige=f"ffmpeg … {video.name} → {len(idx)} Bilder (je Zeitfenster das schärfste)")
    dateien = sorted(ziel.glob("*.jpg"))
    if len(dateien) < len(idx):
        A.anhaengen(job, f"Hinweis: ffmpeg lieferte {len(dateien)} statt {len(idx)} Bilder — der Rest fehlt am Ende.")
        idx = idx[:len(dateien)]
    melde(1.0)

    zeiten = info.zeiten if info and info.zeiten is not None and len(info.zeiten) == n else None
    if info and info.zeiten is not None and zeiten is None:
        A.anhaengen(job, f"Hinweis: {video.name} hat {n} Bilder, die App meldet {len(info.zeiten)} — Zeiten werden gedehnt.")
    quellen = []
    for pfad, i in zip(dateien, idx):
        if info is not None:
            if zeiten is not None:
                t = float(zeiten[i])
            elif info.zeiten is not None:
                t = float(info.zeiten[min(int(i * len(info.zeiten) / n), len(info.zeiten) - 1)])
            else:
                t = None
            ort = info.ort_bei(t) if t is not None else None
        else:
            t, ort = None, v["ort"]
        quellen.append({"pfad": pfad, "gps": ort, "zeit_unix": t, "strom": info.strom if info else video.stem,
                        "kamera": f"video:{info.strom if info else video.stem}",
                        "fov": info.fov_grad if info else None, "extra": None})
    A.anhaengen(job, f"{video.name}: {v['dauer']:.0f} s, {n} Bilder → {len(quellen)} ausgewählt"
                     + (f", Position je Bild aus der Aufnahmespur" if info and info.spur else ""))
    return quellen


def _bereite_bild(q: dict, ziel: Path, bild_max: int) -> dict:
    from PIL import Image, ImageOps

    pfad, extra = q["pfad"], q.get("extra")
    with Image.open(pfad) as im:
        exif = im.getexif()
        ifd = exif.get_ifd(0x8769)
        # Die Messung der Aufnahme-App zuerst: sie trägt Genauigkeit und (beim Video) den Ort je Bild.
        gps = q.get("gps") or georef.exif_gps(exif)
        make, model = exif.get(0x010F), exif.get(0x0110)
        zeit = ifd.get(0x9003) or exif.get(0x0132)
        brenn35 = ifd.get(0xA405)
        brenn_mm = ifd.get(0x920A)
        orientierung = exif.get(0x0112)
        linse = str(ifd.get(0xA434) or "")
        # Schwerkraft vor dem Aufrichten lesen: sie hängt an der EXIF-Orientierung des Rohbildes.
        beschleunigung = (iphone.aus_begleitdatei(extra["meta"]) if extra else None)
        if beschleunigung is None:
            beschleunigung = iphone.aus_exif(exif)
        bild = ImageOps.exif_transpose(im).convert("RGB")      # aufrecht, ohne Orientierungs-Tag
    schwerkraft = iphone.hoch_im_bild(beschleunigung, orientierung, "front" not in linse.lower())
    bild.thumbnail((bild_max, bild_max), Image.LANCZOS)
    neu = Image.Exif()
    if make:
        neu[0x010F] = str(make)
    if model:
        neu[0x0110] = str(model)
    if brenn35:
        try:
            neu.get_ifd(0x8769)[0xA405] = int(brenn35)
        except (TypeError, ValueError):
            pass
    bild.save(ziel, quality=92, exif=neu)

    # Eine Kamera je Optik: gleiche Größe, gleiches Gerät, gleiche Brennweite. Ein Telefon mit
    # Weitwinkel und Ultraweit hat zwei Brennweiten bei gleicher Größe — die in eine Kamera zu
    # zwingen verzerrt die Rekonstruktion, für jedes Bild eine eigene zu führen verschenkt Halt.
    kamera = q.get("kamera") or "|".join(str(x) for x in (
        bild.width, bild.height, make, model, brenn35, round(float(brenn_mm), 2) if brenn_mm else None,
        (extra or {}).get("strom")))
    f_px = None
    if q.get("fov"):
        f_px = splatpack.brennweite_aus_sichtfeld(q["fov"], max(bild.width, bild.height))
    return {"datei": ziel.name, "original": pfad.name, "gps": gps, "kamera": kamera,
            "make": str(make) if make else None, "model": str(model) if model else None,
            "zeit": str(zeit) if zeit else None, "zeit_unix": q.get("zeit_unix"), "brenn35": brenn35,
            "strom": q.get("strom"), "schwerkraft": schwerkraft, "f_px": f_px,
            "breite": bild.width, "hoehe": bild.height}


def _sortiere(quellen: list[dict], exif_zeiten: list[str | None]) -> list[dict]:
    """
    Aufnahmereihenfolge — sie bestimmt, welche Bilder der sequenzielle Abgleich für Nachbarn hält.

    Nach der Zeit der Aufnahme-App (auf Bruchteile von Sekunden), sonst nach EXIF-Zeit, sonst nach
    Namen. Beide Objektive einer Auslösung tragen dieselbe Zeit; bei Gleichstand entscheidet der
    Name des Stroms, damit die Reihenfolge reproduzierbar bleibt.
    """
    n = len(quellen)
    if n and all(q.get("zeit_unix") is not None for q in quellen):
        return sorted(quellen, key=lambda q: (q["zeit_unix"], str(q.get("strom") or ""), str(q["pfad"])))
    if n and all(exif_zeiten):
        return [quellen[k] for k in sorted(range(n), key=lambda k: (exif_zeiten[k], str(quellen[k]["pfad"])))]
    return quellen


# Ein Anteil der Bilder darf als verwackelt aussortiert werden — nicht mehr: sind die meisten
# schlecht, ist das Aussortieren der Fehler, nicht die Hilfe.
MAX_ANTEIL_AUSSORTIERT = 0.3


def vorbereiten(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    roh, bilder_ordner = ordner / "roh", ordner / "bilder"
    shutil.rmtree(bilder_ordner, ignore_errors=True)
    bilder_ordner.mkdir()
    heif = _heif_anmelden()
    pakete = splatpack.finde_pakete(roh)
    index = splatpack.Index(pakete)

    videos = [p for p in sorted(roh.rglob("*")) if p.is_file() and not _ignoriert(p.relative_to(roh))
              and p.suffix.lower() in A.VIDEO_ENDUNGEN and "_frames" not in p.parts]
    quellen: list[dict] = []
    aussortiert = 0
    for p in sorted(roh.rglob("*")):
        if not p.is_file() or _ignoriert(p.relative_to(roh)):
            continue
        if p.suffix.lower() in A.BILD_ENDUNGEN and "_frames" not in p.parts:
            if p.suffix.lower() in (".heic", ".heif") and not heif:
                raise Fehler("HEIC-Bilder gefunden, aber 'pillow-heif' fehlt (pip3 install pillow-heif).")
            ex = index.bild(p)
            quellen.append({"pfad": p, "gps": ex["gps"] if ex else None, "extra": ex,
                            "zeit_unix": ex["zeit_unix"] if ex else None, "strom": ex["strom"] if ex else None})
    # Verwackelte Bilder, die die Aufnahme-App selbst als `poor` eingestuft hat
    schlecht = [q for q in quellen if q["extra"] and q["extra"]["unscharf"]]
    if schlecht and len(schlecht) <= MAX_ANTEIL_AUSSORTIERT * len(quellen) and len(quellen) - len(schlecht) >= 8:
        quellen = [q for q in quellen if q not in schlecht]
        aussortiert = len(schlecht)
        A.anhaengen(job, f"{aussortiert} von {aussortiert + len(quellen)} Bildern aussortiert: laut Aufnahme-App verwackelt.")

    # Videos zuerst bewerten und zerlegen. Das ist der langsame Teil, er bekommt den ersten Teil der Balken.
    anteil_video = 0.6 if videos else 0.0
    for k, v in enumerate(videos):
        info = index.video(v)
        je_video = int(opt["video_bilder"] * (0.6 if info else 1.0))
        stand.stufe("vorbereiten", f"{v.name}: Bilder bewerten…", anteil_video * k / len(videos))

        def melde(b, k=k, name=v.name):
            stand.bruch("vorbereiten", anteil_video * (k + b) / len(videos), f"{name}: Bilder bewerten und herausziehen…")

        quellen += _video_bilder(job, v, roh / "_frames" / f"{k:02d}_{v.stem}",
                                 je_video, int(opt["bild_max"]), melde, info)
    if len(quellen) < 8:
        raise Fehler(f"Nur {len(quellen)} Bilder — für eine Rekonstruktion braucht es mindestens 8, "
                     "besser 40 und mehr mit gut überlappenden Ansichten.")
    if len(quellen) > 600:
        A.anhaengen(job, f"Hinweis: {len(quellen)} Bilder — COLMAP rechnet auf der CPU, das dauert.")

    def anteil(x: float) -> float:
        return anteil_video + (1.0 - anteil_video) * x

    vorab = []
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for k, meta in enumerate(pool.map(lambda q: _lies_zeit(q["pfad"]), quellen)):
            vorab.append(meta)
            stand.bruch("vorbereiten", anteil(0.1 * (k + 1) / len(quellen)))
            pruefe_abbruch(job)
    quellen = _sortiere(quellen, vorab)

    def arbeit(i_q):
        i, q = i_q
        return _bereite_bild(q, bilder_ordner / f"{i:05d}.jpg", int(opt["bild_max"]))

    meta = []
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        for k, m in enumerate(pool.map(arbeit, enumerate(quellen))):
            meta.append(m)
            stand.bruch("vorbereiten", anteil(0.1 + 0.9 * (k + 1) / len(quellen)))
            pruefe_abbruch(job)
    (ordner / "bilder.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False, default=float))

    mit_gps = sum(1 for m in meta if m["gps"])
    mit_schwere = sum(1 for m in meta if m["schwerkraft"])
    kameras = {}
    for m in meta:
        kameras[m["kamera"]] = kameras.get(m["kamera"], 0) + 1
    A.anhaengen(job, f"{len(meta)} Bilder aufbereitet, {mit_gps} mit GPS, {mit_schwere} mit Schwerkraftmessung, "
                     f"{len(kameras)} Kamera{'s' if len(kameras) != 1 else ''}.")
    if videos or len(meta) > 0:
        # Die entpackten Originale (bei Videos mehrere Gigabyte) werden nicht mehr gebraucht.
        shutil.rmtree(roh, ignore_errors=True)
    return {"anzahl": len(meta), "mit_gps": mit_gps, "mit_schwerkraft": mit_schwere, "kameras": len(kameras),
            "aussortiert": aussortiert, "pakete": [p.beschreibung for p in pakete],
            "groessen": sorted({(m["breite"], m["hoehe"]) for m in meta})[:4]}


def _lies_zeit(pfad: Path) -> str | None:
    from PIL import Image
    try:
        with Image.open(pfad) as im:
            ex = im.getexif()
            return ex.get_ifd(0x8769).get(0x9003) or ex.get(0x0132)
    except Exception:
        return None



# ── 3. COLMAP ─────────────────────────────────────────────────────────────────


def _colmap(job: str, *args, zeile=None, was: str = "COLMAP"):
    if not COLMAP:
        raise Fehler("COLMAP fehlt (brew install colmap).")
    lauf(job, [COLMAP, *args], zeile=zeile, nice=5, was=was)


def merkmale(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    meta = json.loads((ordner / "bilder.json").read_text())
    colmap = ordner / "colmap"
    shutil.rmtree(colmap, ignore_errors=True)
    colmap.mkdir()
    # Eine COLMAP-Kamera je Optik (`kamera` aus `vorbereiten`): jede Gruppe läuft für sich in
    # dieselbe Datenbank, `single_camera` gilt dann je Lauf. Eine Brennweite aus dem Sichtfeld
    # der Aufnahme (Video) wird als Startwert mitgegeben; Fotos bringen sie über das EXIF.
    gruppen: dict[str, list[dict]] = {}
    for m in meta:
        gruppen.setdefault(m["kamera"], []).append(m)
    n = len(meta)
    erledigt = 0
    for k, bilder in enumerate(gruppen.values()):
        liste = colmap / f"kamera_{k}.txt"
        liste.write_text("".join(f"{m['datei']}\n" for m in bilder))
        zusatz = []
        f_px = [m["f_px"] for m in bilder if m.get("f_px")]
        if f_px:
            zusatz = ["--ImageReader.camera_params",
                      f"{float(np.median(f_px)):.2f},{bilder[0]['breite'] / 2:.1f},{bilder[0]['hoehe'] / 2:.1f},0"]

        def fortschritt(z, basis=erledigt):
            mt = re.search(r"Processed file \[(\d+)/(\d+)\]", z)
            if mt:
                stand.bruch("merkmale", (basis + int(mt.group(1))) / max(n, 1))

        _colmap(job, "feature_extractor", "--database_path", colmap / "database.db",
                "--image_path", ordner / "bilder", "--image_list_path", liste,
                "--ImageReader.camera_model", "SIMPLE_RADIAL",
                "--ImageReader.single_camera", "1", *zusatz,
                "--SiftExtraction.use_gpu", "0",
                "--SiftExtraction.max_image_size", opt["bild_max"],
                "--SiftExtraction.max_num_features", 8192,
                zeile=fortschritt, was="COLMAP feature_extractor")
        erledigt += len(bilder)
    return {"bilder": n, "kameras": len(gruppen), "eine_kamera": len(gruppen) == 1}


def _miniaturen(ordner: Path, meta: list[dict], kante: int = 24) -> np.ndarray:
    """Je Bild ein winziges, normiertes Graubild — Grundlage des Schleifenschlusses."""
    from PIL import Image

    def laden(m):
        with Image.open(ordner / "bilder" / m["datei"]) as im:
            im.draft("L", (kante * 4, kante * 4))
            v = np.asarray(im.convert("L").resize((kante, kante), Image.BILINEAR), dtype=np.float32).ravel()
        v = v - v.mean()
        return v / (np.linalg.norm(v) + 1e-6)

    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        return np.stack(list(pool.map(laden, meta)))


def _paare(meta: list[dict], nachbarn_reihe: int = 10, nachbarn_gps: int = 25, radius_m: float = 150.0,
           ordner: Path | None = None, nachbarn_schleife: int = 4, schleife_abstand: int = 30) -> list[tuple[str, str]]:
    """
    Bildpaare für den Abgleich bei vielen Bildern.

    * Nachbarn in der Aufnahmereihenfolge **je Kamera** — fängt Videos und Rundgänge ab,
    * die zeitlich benachbarten Bilder der jeweils anderen Kamera (beide Objektive lösen
      gemeinsam aus, dieselbe Ansicht in zwei Brennweiten),
    * die räumlich nächsten laut GPS, **wenn das GPS etwas auflöst**: streuen die Positionen
      nicht deutlich über die Messgenauigkeit hinaus, wären es Zufallspaare,
    * die ähnlichsten Bilder weit entfernt in der Reihenfolge (Schleifenschluss: wer einen
      Gegenstand umrundet, sieht am Ende wieder den Anfang) — über Miniaturbilder, die COLMAP
      anschließend ohnehin geometrisch prüft.
    """
    n = len(meta)
    paare = set()
    kameras: dict[str, list[int]] = {}
    for i, m in enumerate(meta):
        kameras.setdefault(m.get("kamera"), []).append(i)
    for liste in kameras.values():
        for a, i in enumerate(liste):
            for d in range(1, nachbarn_reihe + 1):
                if a + d < len(liste):
                    paare.add((i, liste[a + d]))
    if len(kameras) > 1:
        for i in range(n):
            for d in range(1, 5):
                if i + d < n and meta[i + d].get("kamera") != meta[i].get("kamera"):
                    paare.add((i, i + d))
    idx = [i for i, m in enumerate(meta) if m["gps"]]
    if len(idx) > 3:
        lat0 = float(np.median([meta[i]["gps"]["lat"] for i in idx]))
        lon0 = float(np.median([meta[i]["gps"]["lon"] for i in idx]))
        enu = georef.nach_enu([meta[i]["gps"]["lat"] for i in idx], [meta[i]["gps"]["lon"] for i in idx],
                              0.0, lat0, lon0, 0.0)[:, :2]
        genau = [meta[i]["gps"].get("genauigkeit_m") for i in idx if meta[i]["gps"].get("genauigkeit_m")]
        ausdehnung = float(np.linalg.norm(enu.max(axis=0) - enu.min(axis=0)))
        if ausdehnung >= 3.0 * (float(np.median(genau)) if genau else 5.0):
            for a, i in enumerate(idx):
                d = np.linalg.norm(enu - enu[a], axis=1)
                for b in np.argsort(d)[1:nachbarn_gps + 1]:
                    if d[b] <= radius_m:
                        j = idx[int(b)]
                        paare.add((min(i, j), max(i, j)))
    if ordner is not None and n > 2 * schleife_abstand:
        try:
            mini = _miniaturen(ordner, meta)
            aehnlich = mini @ mini.T
            for i in range(n):
                zeile = aehnlich[i].copy()
                zeile[max(0, i - schleife_abstand):i + schleife_abstand + 1] = -2.0
                for j in np.argsort(zeile)[::-1][:nachbarn_schleife]:
                    if zeile[j] > -1.5:
                        paare.add((min(i, int(j)), max(i, int(j))))
        except OSError:
            pass
    return [(meta[i]["datei"], meta[j]["datei"]) for i, j in sorted(paare)]


def abgleich(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    meta = json.loads((ordner / "bilder.json").read_text())
    colmap = ordner / "colmap"

    def fortschritt(z):
        # „Matching block [2/5, 3/5]“ (alle Paare) oder „Matching image [17/230]“ (Liste)
        m = re.search(r"Matching .*?\[(\d+)/(\d+)(?:, (\d+)/(\d+))?\]", z)
        if m:
            a, b = int(m.group(1)), max(int(m.group(2)), 1)
            bruch = ((a - 1) * b + int(m.group(3))) / (b * max(int(m.group(4)), 1)) if m.group(3) else a / b
            stand.bruch("abgleich", bruch)

    # Eine Videofolge hat eine Reihenfolge, und die ist Wissen: 144 Bilder aus zwei Videos wären 10 000
    # Paare, von denen die meisten nichts gemeinsam haben. Fotos ohne Reihenfolge (Rundgang mit dem
    # Handy) bleiben bis 250 Bildern beim vollständigen Abgleich, der keine Verbindung übersieht.
    aus_video = any(str(m.get("kamera", "")).startswith("video:") for m in meta)
    if len(meta) <= MAX_BILDER_ALLE_PAARE and not (aus_video and len(meta) > MAX_BILDER_VIDEO_ALLE_PAARE):
        _colmap(job, "exhaustive_matcher", "--database_path", colmap / "database.db",
                "--SiftMatching.use_gpu", "0", zeile=fortschritt, was="COLMAP exhaustive_matcher")
        return {"verfahren": "alle Paare", "paare": len(meta) * (len(meta) - 1) // 2}
    paare = _paare(meta, ordner=ordner)
    liste = colmap / "paare.txt"
    liste.write_text("".join(f"{a} {b}\n" for a, b in paare))
    A.anhaengen(job, f"{len(meta)} Bilder → {len(paare)} Paare (Reihenfolge je Kamera, andere Kamera, GPS, Schleifenschluss).")
    _colmap(job, "matches_importer", "--database_path", colmap / "database.db",
            "--match_list_path", liste, "--match_type", "pairs", "--SiftMatching.use_gpu", "0",
            zeile=fortschritt, was="COLMAP matches_importer")
    return {"verfahren": "Nachbarn", "paare": len(paare)}


def _zaehle_bilder(txt: Path) -> int:
    try:
        return sum(1 for z in (txt / "images.txt").read_text().splitlines()
                   if z and not z.startswith("#")) // 2
    except OSError:
        return 0


def rekonstruktion(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    meta = json.loads((ordner / "bilder.json").read_text())
    n = len(meta)
    colmap = ordner / "colmap"
    sparse = colmap / "sparse"
    shutil.rmtree(sparse, ignore_errors=True)
    sparse.mkdir()

    def fortschritt(z):
        m = re.search(r"Registering image #\d+ \((\d+)\)", z)
        if m:
            stand.bruch("rekonstruktion", int(m.group(1)) / n)

    _colmap(job, "mapper", "--database_path", colmap / "database.db", "--image_path", ordner / "bilder",
            "--output_path", sparse, zeile=fortschritt, was="COLMAP mapper")

    beste, beste_n = None, 0
    for modell in sorted(p for p in sparse.iterdir() if p.is_dir()):
        txt = colmap / f"txt_{modell.name}"
        shutil.rmtree(txt, ignore_errors=True)
        txt.mkdir()
        _colmap(job, "model_converter", "--input_path", modell, "--output_path", txt, "--output_type", "TXT")
        z = _zaehle_bilder(txt)
        A.anhaengen(job, f"Teilmodell {modell.name}: {z} von {n} Bildern registriert.")
        if z > beste_n:
            beste, beste_n = modell, z
    mindest = max(5, int(0.25 * n))
    if beste is None or beste_n < mindest:
        raise Fehler(f"Nur {beste_n} von {n} Bildern ließen sich zueinander verorten (mindestens {mindest} nötig). "
                     "Meist fehlt Überlappung: jedes Detail sollte auf mindestens drei Bildern aus "
                     "unterschiedlichen Blickwinkeln zu sehen sein. Unscharfe oder spiegelnde Flächen helfen nicht.")
    (colmap / "bestes.json").write_text(json.dumps({"modell": beste.name, "registriert": beste_n, "bilder": n}))
    return {"registriert": beste_n, "bilder": n, "teilmodelle": len(list(sparse.iterdir()))}


# ── 4. Ausrichten ─────────────────────────────────────────────────────────────


def ausrichtung(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    colmap = ordner / "colmap"
    bestes = json.loads((colmap / "bestes.json").read_text())
    meta = {m["datei"]: m for m in json.loads((ordner / "bilder.json").read_text())}
    bilder = colmap_modell.lese_bilder_txt(colmap / f"txt_{bestes['modell']}" / "images.txt")
    gps = [(meta.get(b["name"]) or {}).get("gps") for b in bilder]
    drohne = np.mean(["dji" in str((meta.get(b["name"]) or {}).get("make") or "").lower() for b in bilder]) > 0.5

    # Schwerkraft aus dem Gerät, je Bild vom aufrechten Kamerarahmen in den Weltrahmen der Rekonstruktion
    schwere = np.full((len(bilder), 3), np.nan)
    for k, b in enumerate(bilder):
        v = (meta.get(b["name"]) or {}).get("schwerkraft")
        if v:
            schwere[k] = b["r"].T @ np.asarray(v, dtype=float)
    # Kein Maßstab aus dem GPS? Dann nicht in beliebigen COLMAP-Einheiten ausliefern (das Modell wäre
    # zwanzigmal zu groß oder zu klein), sondern mit dem Aufnahmeabstand als Anhaltspunkt — und als Schätzung.
    abstand = colmap_modell.typischer_abstand(colmap / f"txt_{bestes['modell']}")
    vorgabe = ANGENOMMENER_ABSTAND_M / abstand if abstand else 1.0
    erg = georef.ausrichtung(np.array([b["zentrum"] for b in bilder]), np.array([b["rechts"] for b in bilder]),
                             np.array([b["oben"] for b in bilder]), gps, drohne=bool(drohne), schwerkraft=schwere,
                             massstab_vorgabe=vorgabe)
    erg["typischer_abstand_einheiten"] = abstand
    erg["modell_bilder"] = len(bilder)
    erg["drohne"] = bool(drohne)
    (ordner / "georef.json").write_text(json.dumps(erg, indent=2, ensure_ascii=False, default=float))
    for h in erg["hinweise"]:
        A.anhaengen(job, f"Hinweis: {h}")
    g = erg.get("hochachse_guete") or {}
    A.anhaengen(job, f"Hochachse aus {'der Schwerkraftmessung des Geräts' if erg.get('hochachse_quelle') == 'geraet' else 'den Kameras' if erg.get('hochachse_quelle') else 'Annahme'}"
                     + (f" (Streuung {g['streuung_grad']}°, {g['n']} Bilder)" if g.get("streuung_grad") is not None else "")
                     + (f"; gegen die Kameralage {erg['abweichung_schwerkraft_kameras_deg']}° Abweichung"
                        if erg.get("abweichung_schwerkraft_kameras_deg") is not None else ""))
    A.anhaengen(job, f"Ausrichtung: {erg['modus']}, Maßstab {erg.get('massstab', 1):.4f}, "
                     f"RMS {erg['rms_m']} m, {erg['inlier']} Inlier, GPS-Bilder {erg['mit_gps']}/{erg['bilder']}")

    sim = colmap / "sim3.txt"
    colmap_modell.schreibe_sim3(sim, erg["matrix"])
    ziel = colmap / "ausgerichtet"
    shutil.rmtree(ziel, ignore_errors=True)
    ziel.mkdir()
    _colmap(job, "model_transformer", "--input_path", colmap / "sparse" / bestes["modell"],
            "--output_path", ziel, "--transform_path", sim, was="COLMAP model_transformer")

    # Gegenprobe: stehen die Kameras dort, wo die Matrix sie hinschieben sollte? Ein Format- oder
    # Vorzeichenfehler im Transformer fiele sonst erst als schief stehender Splat auf.
    txt = colmap / "txt_ausgerichtet"
    shutil.rmtree(txt, ignore_errors=True)
    txt.mkdir()
    _colmap(job, "model_converter", "--input_path", ziel, "--output_path", txt, "--output_type", "TXT")
    neu = {b["name"]: b["zentrum"] for b in colmap_modell.lese_bilder_txt(txt / "images.txt")}
    m = np.array(erg["matrix"])
    abw = max(float(np.linalg.norm(m[:3, :3] @ b["zentrum"] + m[:3, 3] - neu[b["name"]])) for b in bilder if b["name"] in neu)
    if not np.isfinite(abw) or abw > 1e-3 * max(1.0, erg.get("massstab", 1.0)):
        raise Fehler(f"Das ausgerichtete Modell weicht von der berechneten Transformation ab ({abw:.4g}).")
    # Unterkante der Szene aus den sicheren Punkten der Rekonstruktion (Spur ≥ 3, Fehler < 2 px), nicht aus
    # dem Splat: Trainer lassen Ausreißer zurück, die die Hüllbox um zehn und mehr Meter nach unten dehnen.
    unten = [p["xyz"][2] for p in colmap_modell.lese_punkte_txt(txt / "points3D.txt")]
    if len(unten) >= 100:
        erg["boden_z_enu"] = float(np.percentile(unten, 1.0))
        (ordner / "georef.json").write_text(json.dumps(erg, indent=2, ensure_ascii=False, default=float))
    return {k: erg.get(k) for k in ("modus", "massstab_bekannt", "drehung_bekannt", "rms_m", "inlier", "mit_gps",
                                    "hinweise", "hochachse_quelle", "abweichung_schwerkraft_kameras_deg")}


def entzerren(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    ziel = ordner / "train"
    shutil.rmtree(ziel, ignore_errors=True)
    # Der Trainer liest die Verzeichnisform `sparse/0`; der Entzerrer schreibt `sparse/` flach.
    _colmap(job, "image_undistorter", "--image_path", ordner / "bilder",
            "--input_path", ordner / "colmap" / "ausgerichtet", "--output_path", ziel,
            "--output_type", "COLMAP", "--max_image_size", opt["bild_max"], was="COLMAP image_undistorter")
    flach = ziel / "sparse"
    if flach.exists() and not (flach / "0").exists():
        tmp = ziel / "_sparse"
        flach.rename(tmp)
        flach.mkdir()
        tmp.rename(flach / "0")
    return {}


# ── 4b. World Labs Atlas statt COLMAP ─────────────────────────────────────────
#
# Ein Auftrag an `images2PosedRGBD` schätzt für alle Bilder gemeinsam Kameras, Tiefe und
# Konfidenz. Das trägt auch dort, wo COLMAP aufgibt: wenig Überlappung, glatte Wände,
# spiegelnde Flächen, ein Dutzend Bilder. Bezahlt wird je Auftrag; was schon hochgeladen,
# eingereicht oder abgeholt ist, steht in `atlas/zustand.json` und wird bei einem Neustart
# des Workers nicht noch einmal gemacht (und nicht noch einmal bezahlt).

#: Höchstens so viele Bilder je Auftrag an World Labs. Mehr werden in überlappende Teile
#: zerlegt und über die gemeinsamen Bilder zusammengesetzt (`atlas_rekon.teil_einpassen`).
ATLAS_MAX_BILDER = int(os.getenv("ATLAS_MAX_BILDER", "100"))
ATLAS_UEBERLAPPUNG = int(os.getenv("ATLAS_UEBERLAPPUNG", "20"))
#: Längste Kante des Rasters, auf dem Atlas Tiefe und Kamera zurückgibt.
ATLAS_RASTER = int(os.getenv("ATLAS_RASTER", "1280"))
#: Obergrenze der Startpunkte für den Trainer. Mehr hilft dem Training kaum und kostet Speicher.
ATLAS_STARTPUNKTE = int(os.getenv("ATLAS_STARTPUNKTE", "800000"))


def _teile(n: int, gross: int, ueber: int) -> list[list[int]]:
    """Bildnummern in überlappenden Teilen zu höchstens `gross`, in Aufnahmereihenfolge."""
    if n <= gross:
        return [list(range(n))]
    ueber = max(4, min(ueber, gross // 2))
    teile, a = [], 0
    while True:
        b = min(n, a + gross)
        teile.append(list(range(a, b)))
        if b >= n:
            return teile
        a = b - ueber


def _atlas_zustand(ordner: Path) -> tuple[Path, dict]:
    pfad = ordner / "atlas" / "zustand.json"
    try:
        return pfad, json.loads(pfad.read_text())
    except (OSError, json.JSONDecodeError):
        return pfad, {}


def _atlas_sichern(pfad: Path, zst: dict) -> None:
    tmp = pfad.with_suffix(".tmp")
    tmp.write_text(json.dumps(zst, indent=1))
    os.replace(tmp, pfad)


def _atlas(job: str, koroutine):
    """Eine World-Labs-Koroutine ausführen — Fehler werden zu Fehler/Abgebrochen des Workers."""
    import asyncio

    from splatwerk import worldlabs as W
    try:
        return W.ausfuehren(koroutine)
    except asyncio.CancelledError:
        raise Abgebrochen()
    except W.AtlasFehler as e:
        raise Fehler(e.meldung) from e


def _vorgerahmt(pfad: Path, box: tuple[int, int, int, int]) -> bytes:
    """Das Bild, beschnitten auf den Vorrahmen — oder unverändert, wenn er das ganze Bild ist."""
    import io

    from PIL import Image
    x0, y0, b, h = box
    with Image.open(pfad) as im:
        if (x0, y0, b, h) == (0, 0, im.width, im.height):
            return pfad.read_bytes()
        puffer = io.BytesIO()
        im.convert("RGB").crop((x0, y0, x0 + b, y0 + h)).save(puffer, "JPEG", quality=95)
        return puffer.getvalue()


async def _atlas_hochladen(job: str, ordner: Path, bilder: list[dict], rahmen: dict, melde) -> list[str]:
    """Lädt die Bilder hoch — jedes im Seitenverhältnis des Rasters (``rahmen``: Datei → Vorrahmen).

    Atlas verzerrt ein Bild, das nicht ins Raster passt, statt es zu beschneiden (siehe
    ``atlas_rekon``, „Das Raster"); deshalb wird hier beschnitten.
    """
    import asyncio

    from splatwerk import worldlabs as W
    sperre = asyncio.Semaphore(6)
    fertig = [0]

    async def eins(m):
        async with sperre:
            if A.abbruch_angefordert(job):
                raise asyncio.CancelledError()
            daten = await asyncio.to_thread(_vorgerahmt, ordner / "bilder" / m["datei"], tuple(rahmen[m["datei"]]))
            kennung = await W.asset_hochladen(daten, "image/jpeg", f"ileen-{job[:8]}-{m['datei']}")
            fertig[0] += 1
            melde(fertig[0] / len(bilder))
            return kennung

    return list(await asyncio.gather(*(eins(m) for m in bilder)))


async def _atlas_abholen(frames: list[dict], ziel: Path, k: int, melde) -> None:
    import asyncio

    from splatwerk import worldlabs as W
    sperre = asyncio.Semaphore(6)
    fertig = [0]

    async def eins(j, f):
        async with sperre:
            d = f.get("depth") or {}
            tiefe = d.get("depthAsset")
            if not tiefe:
                raise W.AtlasFehler(502, f"Atlas hat für Bild {j + 1} keine Tiefe geliefert")
            (ziel / f"tiefe_{k}_{j}.exr").write_bytes(await W.asset_lesen(tiefe))
            if d.get("confidenceAsset"):
                (ziel / f"konf_{k}_{j}.png").write_bytes(await W.asset_lesen(d["confidenceAsset"]))
            if f.get("imageAsset"):
                # Das Bild, zu dem Tiefe und Kamera gehören: daran wird gemessen, welchen Ausschnitt
                # Atlas genommen hat, und es färbt die Startpunkte pixelgenau.
                (ziel / f"bild_{k}_{j}").write_bytes(await W.asset_lesen(f["imageAsset"]))
            fertig[0] += 1
            melde(fertig[0] / len(frames))

    await asyncio.gather(*(eins(j, f) for j, f in enumerate(frames)))


def atlas_posen(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    from splatwerk import worldlabs as W

    meta = json.loads((ordner / "bilder.json").read_text())
    n = len(meta)
    if not W.schluessel()[0]:
        raise Fehler("Kein World-Labs-Schlüssel auf diesem Rechner. Einmal im eigenen Terminal "
                     "`worldlabs auth login` ausführen, dann den Auftrag wiederholen.")
    wt, ht = atlas_rekon.zielraster([(m["breite"], m["hoehe"]) for m in meta], ATLAS_RASTER)
    (ordner / "atlas").mkdir(exist_ok=True)
    pfad, zst = _atlas_zustand(ordner)
    teile = _teile(n, ATLAS_MAX_BILDER, ATLAS_UEBERLAPPUNG)
    if zst.get("raster") != [wt, ht] or zst.get("teile") != teile or zst.get("dateien") != [m["datei"] for m in meta]:
        zst = {"raster": [wt, ht], "teile": teile, "dateien": [m["datei"] for m in meta], "teil": {}}
        _atlas_sichern(pfad, zst)
    if "vorrahmen" not in zst and not any(t.get("assets") for t in zst["teil"].values()):
        # Nur, solange nichts hochgeladen ist: der Vorrahmen muss zu dem passen, was Atlas gesehen hat.
        zst["vorrahmen"] = {m["datei"]: list(atlas_rekon.vorrahmen(m["breite"], m["hoehe"], wt, ht)) for m in meta}
        _atlas_sichern(pfad, zst)
    rahmen = zst.get("vorrahmen") or {m["datei"]: [0, 0, m["breite"], m["hoehe"]] for m in meta}
    beschnitten = sum(1 for m in meta if tuple(rahmen[m["datei"]]) != (0, 0, m["breite"], m["hoehe"]))
    A.anhaengen(job, f"Atlas: {n} Bilder in {len(teile)} Auftrag/Aufträgen, Raster {wt}×{ht}"
                     + (f", {beschnitten} auf dessen Seitenverhältnis beschnitten." if beschnitten else "."))

    for k, idx in enumerate(teile):
        tz = zst["teil"].setdefault(str(k), {})
        if tz.get("fertig"):
            continue
        anteil0, breite = k / len(teile), 1.0 / len(teile)

        def melde(b, text, anteil0=anteil0, breite=breite):
            stand.bruch("atlas_posen", anteil0 + breite * b, text)

        if not tz.get("assets"):
            tz["assets"] = _atlas(job, _atlas_hochladen(job, ordner, [meta[i] for i in idx], rahmen,
                                                        lambda b: melde(0.15 * b, f"Bilder an World Labs ({int(b * 100)} %)")))
            _atlas_sichern(pfad, zst)
        if not tz.get("operation"):
            koerper = {"frames": [{"imageAsset": {"assetId": a}} for a in tz["assets"]],
                       "targetResolution": [wt, ht], "refinePoses": len(idx) >= 2,
                       "canonicalizeToFirstFrame": False}
            tz["versuch"] = int(tz.get("versuch") or 0) + 1
            op = _atlas(job, W.aufgabe_einreichen("images2PosedRGBD", koerper,
                                                  f"ileen-splat-{job}-{k}-{tz['versuch']}"))
            tz["operation"] = op.get("id")
            _atlas_sichern(pfad, zst)
            A.anhaengen(job, f"Atlas-Auftrag {k + 1}/{len(teile)} eingereicht: {tz['operation']}")

        def stand_op(op):
            meta_op = op.get("metadata") or {}
            p = meta_op.get("progressPercent")
            text = "Atlas rechnet" + (f" — {meta_op.get('phase')}" if meta_op.get("phase") else "")
            melde(0.15 + 0.7 * (float(p) / 100.0 if isinstance(p, (int, float)) else 0.3), text)

        op = _atlas(job, W.operation_warten(tz["operation"], bei_stand=stand_op, frist_s=4 * 3600,
                                            abbruch=lambda: A.abbruch_angefordert(job)))
        fehler = W.fehler_der_operation(op)
        if fehler:
            tz.pop("operation", None)       # beim Wiederholen neu einreichen, die Bilder bleiben hochgeladen
            _atlas_sichern(pfad, zst)
            raise Fehler(fehler)
        antwort = op.get("response") or {}
        (ordner / "atlas" / f"antwort_{k}.json").write_text(json.dumps(antwort, indent=1))
        frames = antwort.get("frames") or []
        if len(frames) != len(idx):
            raise Fehler(f"Atlas gab {len(frames)} statt {len(idx)} Bilder zurück.")
        _atlas(job, _atlas_abholen(frames, ordner / "atlas", k,
                                   lambda b: melde(0.85 + 0.15 * b, f"Tiefen abholen ({int(b * 100)} %)")))
        tz["fertig"] = True
        tz["posen_verfeinert"] = antwort.get("poseRefinementAccepted")
        _atlas_sichern(pfad, zst)
        if antwort.get("poseRefinementAccepted") is False:
            A.anhaengen(job, f"Atlas-Teil {k + 1}: Verfeinerung der Kameras verworfen (zu weit von der Schätzung).")
    return {"bilder": n, "teile": len(teile), "raster": [wt, ht],
            "verfeinert": [zst["teil"][str(k)].get("posen_verfeinert") for k in range(len(teile))]}


def _lade_rgb(pfad: Path) -> np.ndarray:
    from PIL import Image
    with Image.open(pfad) as im:
        return np.asarray(im.convert("RGB"))


def atlas_modell(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    from splatwerk import worldlabs as W

    meta = json.loads((ordner / "bilder.json").read_text())
    at = ordner / "atlas"
    _, zst = _atlas_zustand(ordner)
    teile, (wt, ht) = zst["teile"], zst["raster"]
    kam: dict[int, dict] = {}
    passung = []
    for k, idx in enumerate(teile):
        frames = json.loads((at / f"antwort_{k}.json").read_text())["frames"]
        roh = []
        for j, f in enumerate(frames):
            c, r = atlas_rekon.kamera_rub(f["camera"])
            roh.append((c, r, f["camera"]["intrinsics"]))
        s, rot, t = 1.0, np.eye(3), np.zeros(3)
        if k > 0:
            gemeinsam = [(j, i) for j, i in enumerate(idx) if i in kam]
            if len(gemeinsam) < 3:
                raise Fehler(f"Atlas-Teil {k + 1} teilt nur {len(gemeinsam)} Bilder mit den vorigen — zu wenig zum Zusammensetzen.")
            ca = np.array([kam[i]["zentrum"] for _, i in gemeinsam])
            ba = np.array([-kam[i]["r_rub"][:, 2] for _, i in gemeinsam])
            cb = np.array([roh[j][0] for j, _ in gemeinsam])
            bb = np.array([-roh[j][1][:, 2] for j, _ in gemeinsam])
            abstand = float(np.median([np.median(W.exr_lesen((at / f"tiefe_{k}_{j}.exr").read_bytes()))
                                       for j, _ in gemeinsam[:5]]))
            s, rot, t, rms = atlas_rekon.teil_einpassen(ca, ba, cb, bb, abstand)
            passung.append({"teil": k + 1, "gemeinsam": len(gemeinsam), "massstab": round(s, 4), "rms": round(rms, 4)})
            A.anhaengen(job, f"Atlas-Teil {k + 1} eingepasst: {len(gemeinsam)} gemeinsame Bilder, Maßstab {s:.4f}, "
                             f"Restfehler {rms:.3f} (bei Blickweite {abstand:.2f}).")
            if rms > 0.1 * abstand:
                A.anhaengen(job, f"Hinweis: Teil {k + 1} passt nur grob zu den vorigen — Nähte im Splat möglich.")
        for j, i in enumerate(idx):
            if i in kam:
                continue
            c, r, intr = roh[j]
            kam[i] = {"zentrum": s * rot @ c + t, "r_rub": rot @ r, "intr_t": intr, "skala": s,
                      "tiefe": at / f"tiefe_{k}_{j}.exr", "konf": at / f"konf_{k}_{j}.png",
                      "bild": at / f"bild_{k}_{j}", "bild_asset": frames[j].get("imageAsset")}
        stand.bruch("atlas_modell", 0.1 * (k + 1) / len(teile), "Teile zusammensetzen…")

    ausschnitt = _atlas_ausschnitte(job, ordner, meta, kam, zst, wt, ht, stand)

    # Dichte Startpunkte aus den Tiefen
    reihe = sorted(kam)
    schritt = int(min(8, max(1, math.ceil(math.sqrt(wt * ht * len(reihe) / (3.0 * ATLAS_STARTPUNKTE))))))
    alle_p, alle_c, alle_w, mediane, brennweiten = [], [], [], [], []
    for z, i in enumerate(reihe):
        pruefe_abbruch(job)
        b = kam[i]
        tiefe = W.exr_lesen(b["tiefe"].read_bytes()) * b["skala"]
        if tiefe.shape != (ht, wt):
            raise Fehler(f"Tiefe von Bild {i + 1} hat {tiefe.shape[1]}×{tiefe.shape[0]} statt {wt}×{ht}.")
        konf = _lade_rgb(b["konf"])[..., 0] if b["konf"].exists() else None
        farbe = _farbe_im_raster(ordner / "bilder" / meta[i]["datei"], b, wt, ht)
        p, c, g = atlas_rekon.punkte_aus_tiefe(tiefe, farbe, b["intr_t"], b["zentrum"], b["r_rub"], konf, schritt)
        alle_p.append(p)
        alle_c.append(c)
        alle_w.append(g)
        gut = tiefe[np.isfinite(tiefe) & (tiefe > 0)]
        if gut.size:
            mediane.append(float(np.median(gut)))
        brennweiten.append(float(b["intr_t"]["fx"]))
        stand.bruch("atlas_modell", 0.2 + 0.75 * (z + 1) / len(reihe), f"Tiefe → Punkte ({z + 1}/{len(reihe)})")
    p = np.concatenate(alle_p) if alle_p else np.zeros((0, 3))
    c = np.concatenate(alle_c) if alle_c else np.zeros((0, 3), np.uint8)
    g = np.concatenate(alle_w) if alle_w else np.zeros(0)
    voxel = atlas_rekon.voxelgroesse(float(np.median(mediane)) if mediane else float("nan"),
                                     float(np.median(brennweiten)) if brennweiten else 0.0)
    p, c = atlas_rekon.ausduennen(p, c, g, voxel, ATLAS_STARTPUNKTE)
    if len(p) < 1000:
        raise Fehler(f"Aus den Tiefen von Atlas blieben nur {len(p)} sichere Punkte — die Aufnahme trägt nicht.")
    np.savez_compressed(at / "modell.npz",
                        namen=np.array([meta[i]["datei"] for i in reihe]),
                        zentren=np.array([kam[i]["zentrum"] for i in reihe]),
                        drehungen=np.array([kam[i]["r_rub"] for i in reihe]),
                        intrinsik=np.array([[*(lambda k: (k["fx"], k["fy"], k["cx"], k["cy"], k["width"], k["height"]))(
                            atlas_rekon.intrinsik_auf_quelle(kam[i]["intr_t"], kam[i]["abb"],
                                                             meta[i]["breite"], meta[i]["hoehe"]))]
                            for i in reihe]),
                        punkte=p.astype(np.float32), farben=c.astype(np.uint8))
    A.anhaengen(job, f"Startmodell: {f'{len(p):,}'.replace(',', '.')} Punkte aus {len(reihe)} Tiefen "
                     f"(jedes {schritt}. Pixel, Voxel {voxel:.4f}).")
    return {"punkte": int(len(p)), "voxel": round(voxel, 5), "schritt": schritt, "teile": passung,
            "ausschnitt": ausschnitt}


#: Anteil je Achse, den Atlas vom hochgeladenen Bild nimmt — gemessen am ersten echten Lauf
#: (2026-10-21, iPhone 17 Pro, 9 Bilder, ±0,1 %). Gilt nur, wenn sich kein einziges Bild messen lässt.
ATLAS_ANTEIL_ERFAHRUNG = (0.754, 0.754)


def _atlas_ausschnitte(job: str, ordner: Path, meta: list[dict], kam: dict, zst: dict, wt: int, ht: int,
                       stand: Stand) -> dict:
    """Misst je Bild, welchen Ausschnitt des hochgeladenen Bildes Atlas genommen hat (``kam[i]["abb"]``).

    Setzt die Abbildung Raster → eigenes Bild (samt Vorrahmen). Bilder, die Atlas verzerrt
    zurückgegeben hat, fliegen aus ``kam``: ihre Kamera und Tiefe taugen nicht.
    """
    from splatwerk import worldlabs as W

    rahmen = zst.get("vorrahmen") or {}
    gemessen: dict[int, dict | None] = {}
    for z, i in enumerate(sorted(kam)):
        pruefe_abbruch(job)
        b = kam[i]
        m = meta[i]
        b["vorrahmen"] = tuple(rahmen.get(m["datei"]) or (0, 0, m["breite"], m["hoehe"]))
        if not b["bild"].exists() and b.get("bild_asset"):
            # Aufträge von vor dieser Fassung haben nur das erste Bild je Teil geholt.
            try:
                b["bild"].write_bytes(_atlas(job, W.asset_lesen(b["bild_asset"])))
            except Fehler as e:
                A.anhaengen(job, f"Hinweis: Bild {i + 1} von Atlas nicht ladbar ({e}).")
        abb = None
        if b["bild"].exists():
            x0, y0, bw, bh = b["vorrahmen"]
            hoch = _lade_rgb(ordner / "bilder" / m["datei"])[y0:y0 + bh, x0:x0 + bw]
            try:
                abb = atlas_rekon.ausschnitt_messen(hoch, _lade_rgb(b["bild"]))
            except Exception as e:  # noqa: BLE001 — eine Messung darf den Auftrag nicht kosten
                A.anhaengen(job, f"Hinweis: Ausschnitt von Bild {i + 1} nicht messbar ({e}).")
        gemessen[i] = abb
        stand.bruch("atlas_modell", 0.1 + 0.1 * (z + 1) / len(kam), f"Ausschnitt messen ({z + 1}/{len(kam)})")

    anteil = atlas_rekon.ausschnitt_anteil(
        [(a, kam[i]["vorrahmen"][2], kam[i]["vorrahmen"][3]) for i, a in gemessen.items() if a], wt, ht)
    quelle = "gemessen"
    if anteil is None:
        anteil, quelle = ATLAS_ANTEIL_ERFAHRUNG, "erfahrung"
        A.anhaengen(job, "Hinweis: Kein Bild ließ sich gegen Atlas' Ausschnitt messen — es gilt der Erfahrungswert "
                         f"{anteil[0] * 100:.1f} % je Achse. Die Kameras können gegen die Trainingsbilder versetzt sein.")
    verzerrt, geschaetzt = [], []
    for i, abb in gemessen.items():
        x0, y0, bw, bh = kam[i]["vorrahmen"]
        # Hochgeladen in anderem Seitenverhältnis als das Raster: Atlas hat verzerrt, gemessen oder nicht.
        passt = abs((bw / bh) / (wt / ht) - 1.0) <= 0.005
        if not passt or (abb is not None and not atlas_rekon.isotrop(abb)):
            verzerrt.append(i)
            continue
        if abb is None:
            geschaetzt.append(i)
            abb = atlas_rekon.ausschnitt_nach_anteil(anteil, bw, bh, wt, ht)
        kam[i]["abb"] = atlas_rekon.abbildung_auf_quelle(abb, x0, y0)
    for i in verzerrt:
        kam.pop(i)
    if not kam:
        raise Fehler("Atlas hat jedes Bild verzerrt zurückgegeben — keine Kamera ist brauchbar.")

    gut = [a for a in gemessen.values() if a and atlas_rekon.isotrop(a)]
    rest = float(np.median([a["rest_px"] for a in gut])) if gut else None
    A.anhaengen(job, f"Atlas-Ausschnitt: die mittleren {anteil[0] * 100:.1f} % × {anteil[1] * 100:.1f} % je Bild, "
                     f"an {len(gut)} von {len(gemessen)} Bildern gemessen"
                     + (f" (Restfehler {rest:.2f} px)" if rest is not None else "")
                     + (f", {len(geschaetzt)} geschätzt" if geschaetzt else "") + ".")
    if verzerrt:
        A.anhaengen(job, f"Hinweis: Atlas hat {len(verzerrt)} Bild(er) verzerrt zurückgegeben "
                         f"({', '.join(meta[i].get('original') or meta[i]['datei'] for i in verzerrt)}) — "
                         "ohne Kamera, nicht im Training.")
    return {"anteil": [round(anteil[0], 5), round(anteil[1], 5)], "quelle": quelle, "gemessen": len(gut),
            "geschaetzt": [meta[i]["datei"] for i in geschaetzt], "verzerrt": [meta[i]["datei"] for i in verzerrt],
            "rest_px": rest}


def _farbe_im_raster(quelle: Path, b: dict, wt: int, ht: int) -> np.ndarray:
    """Farben im Raster der Tiefe: Atlas' eigenes Bild (pixelgenau), sonst das eigene über die Abbildung."""
    from PIL import Image

    if b["bild"].exists():
        bild = _lade_rgb(b["bild"])
        if bild.shape[:2] == (ht, wt):
            return bild
        return np.asarray(Image.fromarray(bild).resize((wt, ht), Image.LANCZOS))
    a = b["abb"]
    box = (a["bx"], a["by"], a["bx"] + a["ax"] * wt, a["by"] + a["ay"] * ht)
    with Image.open(quelle) as im:
        return np.asarray(im.convert("RGB").resize((wt, ht), Image.LANCZOS, box=box))


def atlas_ausrichtung(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    d = np.load(ordner / "atlas" / "modell.npz")
    namen = [str(x) for x in d["namen"]]
    meta = {m["datei"]: m for m in json.loads((ordner / "bilder.json").read_text())}
    zentren, drehungen, intrinsik = d["zentren"], d["drehungen"], d["intrinsik"]
    gps = [(meta.get(n) or {}).get("gps") for n in namen]
    drohne = np.mean(["dji" in str((meta.get(n) or {}).get("make") or "").lower() for n in namen]) > 0.5
    # Schwerkraft: die Messung des Geräts, wo es eine gibt — sonst die Lotrichtung, die Atlas
    # selbst geschätzt hat (die Rekonstruktion ist schwerkraftgerichtet, Y oben).
    schwere = np.full((len(namen), 3), np.nan)
    for k, n in enumerate(namen):
        v = (meta.get(n) or {}).get("schwerkraft")
        if v:
            schwere[k] = (drehungen[k] @ np.diag([1.0, -1.0, -1.0])) @ np.asarray(v, dtype=float)
    aus_geraet = int(np.isfinite(schwere).all(axis=1).sum()) >= 3
    if not aus_geraet:
        schwere[:] = [0.0, 1.0, 0.0]
    erg = georef.ausrichtung(zentren, drehungen[:, :, 0], drehungen[:, :, 1], gps, drohne=bool(drohne),
                             schwerkraft=schwere, massstab_vorgabe=1.0)
    if not aus_geraet and erg.get("hochachse_quelle") == "geraet":
        erg["hochachse_quelle"] = "atlas"
    erg["verfahren"] = "atlas"
    if not erg.get("massstab_bekannt"):
        erg["massstab_quelle"] = "atlas"
        erg["hinweise"] = [h for h in erg["hinweise"] if "Maßstab im Asset-Manager einstellen" not in h
                           and "Maßstab geschätzt" not in h]
        erg["hinweise"].append("Ohne tragendes GPS kommt der Maßstab aus der Tiefenschätzung von Atlas (metrisch "
                               "geschätzt, auf einige Prozent) — ein bekanntes Maß im Positionsformular macht ihn genau.")
    bilder = [{"name": n, "zentrum": zentren[k], "r_rub": drehungen[k],
               "intr": dict(zip(("fx", "fy", "cx", "cy", "width", "height"), intrinsik[k]))} for k, n in enumerate(namen)]
    neu, punkte = atlas_rekon.transformiere(bilder, d["punkte"].astype(np.float64), erg["matrix"])
    if len(punkte) >= 100:
        erg["boden_z_enu"] = float(np.percentile(punkte[:, 2], 1.0))
    erg["modell_bilder"] = len(namen)
    erg["drohne"] = bool(drohne)
    (ordner / "georef.json").write_text(json.dumps(erg, indent=2, ensure_ascii=False, default=float))
    for h in erg["hinweise"]:
        A.anhaengen(job, f"Hinweis: {h}")
    A.anhaengen(job, f"Ausrichtung: {erg['modus']}, Maßstab {erg.get('massstab', 1):.4f}, RMS {erg['rms_m']} m, "
                     f"{erg['inlier']} Inlier, GPS-Bilder {erg['mit_gps']}/{erg['bilder']}, Hochachse aus "
                     f"{ {'geraet': 'der Schwerkraftmessung des Geräts', 'atlas': 'Atlas (schwerkraftgerichtet)', 'kameras': 'den Kameras'}.get(erg.get('hochachse_quelle'), 'Annahme') }")

    colmap = ordner / "colmap"
    shutil.rmtree(colmap / "txt_ausgerichtet", ignore_errors=True)
    atlas_rekon.schreibe_modell(colmap / "txt_ausgerichtet", neu, punkte, d["farben"])
    # Der Trainer liest `train/images` + `train/sparse/0`; Atlas kennt keine Verzeichnung, entzerrt wird nichts.
    train = ordner / "train"
    shutil.rmtree(train, ignore_errors=True)
    (train / "images").mkdir(parents=True)
    for n in namen:
        try:
            os.link(ordner / "bilder" / n, train / "images" / n)
        except OSError:
            shutil.copy2(ordner / "bilder" / n, train / "images" / n)
    shutil.copytree(colmap / "txt_ausgerichtet", train / "sparse" / "0")
    return {k: erg.get(k) for k in ("modus", "massstab_bekannt", "drehung_bekannt", "rms_m", "inlier", "mit_gps",
                                    "hinweise", "hochachse_quelle", "abweichung_schwerkraft_kameras_deg", "massstab_quelle")}


# ── 5. Training ───────────────────────────────────────────────────────────────


def _aufloesungsteiler(bilder: Path, ziel: int) -> float:
    """
    Der Teiler für `--train-resolution-divisor`, damit die längste Bildkante höchstens `ziel` Pixel hat.

    Brush kannte `--max-resolution`, Spirula nur einen Teiler (er darf gebrochen sein: der Parser rechnet
    `floor(Seite / Teiler)`). Gemessen wird an den Bildern selbst, nicht an der Qualitätsstufe — der
    Entzerrer liefert höchstens `bild_max`, Atlas-Bilder und Videos können kleiner sein. 0 heißt: nicht
    verkleinern.
    """
    from PIL import Image

    laengste = 0
    for p in sorted(bilder.iterdir())[:8]:
        try:
            with Image.open(p) as bild:
                laengste = max(laengste, *bild.size)
        except OSError:
            continue
    return round(laengste / ziel, 4) if laengste > ziel * 1.02 else 0.0


def _szenenradius(ordner: Path) -> float:
    """
    Der Abstand von 90 % der Modellpunkte zu ihrem Median, in Metern (Rückfall: 10) — wie weit der
    Viewer zurücktreten muss, um die Szene zu sehen. Ohne Spurfilter: die Atlas-Punkte haben keine
    Spur und blieben sonst alle auf der Strecke.
    """
    try:
        punkte = np.array([p["xyz"] for p in
                           colmap_modell.lese_punkte_txt(ordner / "colmap" / "txt_ausgerichtet" / "points3D.txt",
                                                         min_spur=0, max_fehler=float("inf"), max_punkte=10**7)], dtype=float)
        if len(punkte) < 10:
            return 10.0
        return max(1.0, float(np.percentile(np.linalg.norm(punkte - np.median(punkte, 0), axis=1), 90)))
    except (OSError, ValueError, KeyError):
        return 10.0


def _freier_port(erster: int) -> int:
    """Der erste freie TCP-Port ab `erster` — der Viewer von Spirula bricht bei belegtem Port nicht ab, er schweigt."""
    for port in range(erster, erster + 50):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise Fehler(f"Kein freier Port für den Trainings-Viewer ab {erster}.")


def _cdp(ws_url: str, methode: str, params: dict | None = None, zeit: float = 15.0) -> dict:
    """
    Ein Befehl an Chrome über das DevTools-Protokoll. Der WebSocket ist von Hand geschrieben: der Worker
    läuft mit der Systempython und soll dafür kein Paket brauchen. Nur der Weg hin und eine Antwort zurück.
    """
    u = urlparse(ws_url)
    with socket.create_connection((u.hostname, u.port), timeout=zeit) as s:
        schluessel = base64.b64encode(os.urandom(16)).decode()
        s.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                   f"Connection: Upgrade\r\nSec-WebSocket-Key: {schluessel}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        puffer = b""
        while b"\r\n\r\n" not in puffer:
            teil = s.recv(4096)
            if not teil:
                raise OSError("DevTools: Verbindung geschlossen")
            puffer += teil
        kopf, puffer = puffer.split(b"\r\n\r\n", 1)
        if b" 101 " not in kopf.split(b"\r\n", 1)[0] + b" ":
            raise OSError("DevTools: " + kopf.split(b"\r\n", 1)[0].decode("ascii", "replace"))
        nutz = json.dumps({"id": 1, "method": methode, "params": params or {}}).encode()
        maske = os.urandom(4)
        laenge = len(nutz)
        rahmen = bytes([0x81]) + (bytes([0x80 | laenge]) if laenge < 126 else
                                  bytes([0x80 | 126]) + laenge.to_bytes(2, "big") if laenge < 65536 else
                                  bytes([0x80 | 127]) + laenge.to_bytes(8, "big"))
        s.sendall(rahmen + maske + bytes(b ^ maske[i % 4] for i, b in enumerate(nutz)))

        def lesen(n: int) -> bytes:
            nonlocal puffer
            while len(puffer) < n:
                teil = s.recv(1 << 16)
                if not teil:
                    raise OSError("DevTools: Verbindung geschlossen")
                puffer += teil
            aus, puffer = puffer[:n], puffer[n:]
            return aus

        nachricht = b""
        while True:
            b0, b1 = lesen(2)
            n = b1 & 0x7F
            n = int.from_bytes(lesen(2), "big") if n == 126 else int.from_bytes(lesen(8), "big") if n == 127 else n
            daten = lesen(n)                       # Frames vom Server sind nicht maskiert
            if b0 & 0x0F in (0, 1):                # Text, gegebenenfalls in Teilen
                nachricht += daten
                if b0 & 0x80:
                    antwort = json.loads(nachricht)
                    nachricht = b""
                    if antwort.get("id") == 1:
                        if "error" in antwort:
                            raise OSError(f"DevTools: {antwort['error']}")
                        return antwort.get("result", {})


#: Die Startansicht des Spirula-Viewers: er zentriert auf die **Kameramitte**, bei einer Drohnenaufnahme also
#: auf leere Luft, und stellt die Kamera eine Einheit entfernt auf — in Metern, wie die Szene hier liegt, mitten
#: zwischen die Splats. Gewählt wird die Mitte der Punktwolke, der Abstand ist ihr Radius (`_szenenradius`).
_STARTANSICHT_JS = """(async () => {
  for (let i = 0; i < 100 && !(Scene.modes && Scene.modes.length); i++) await new Promise(r => setTimeout(r, 100));
  const i = Scene.modes.findIndex(m => m.name === 'point-median');
  if (i < 0) return 'ohne Szenenmitte';
  Scene.mode = i;
  document.getElementById('center-mode').value = String(i);
  cam.reset();
  cam.pos = v3.add(cam.target, v3.scale(v3.sub(cam.pos, cam.target), __ABSTAND__));
  Viewer.requestRender();
  return 'ok';
})()"""


def _fenster_einrichten(profil: Path, viewer_port: int, abstand: float) -> str:
    """Stellt die Startansicht des Viewer-Fensters ein (siehe `_STARTANSICHT_JS`). Gibt 'ok' oder den Grund zurück."""
    datei = profil / "DevToolsActivePort"
    for _ in range(60):                            # Chrome schreibt den Port beim Start
        if datei.exists() and datei.read_text().split():
            break
        time.sleep(0.5)
    else:
        return "Chrome meldet keinen DevTools-Port"
    port = int(datei.read_text().split()[0])
    for _ in range(40):                            # die Seite lädt erst
        seiten = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5).read())
        ziel = next((x for x in seiten if x.get("type") == "page" and f":{viewer_port}/" in x.get("url", "")), None)
        if ziel:
            r = _cdp(ziel["webSocketDebuggerUrl"], "Runtime.evaluate",
                     {"expression": _STARTANSICHT_JS.replace("__ABSTAND__", f"{abstand:.3f}"),
                      "awaitPromise": True, "returnByValue": True})
            return str(r.get("result", {}).get("value", r))
        time.sleep(0.5)
    return "Seite des Viewers nicht gefunden"


def _fenster_oeffnen(url: str, profil: Path, viewer_port: int | None = None, abstand: float = 10.0) -> None:
    """
    Öffnet den Trainings-Viewer in einem eigenen Fenster auf dem Desktop (Chrome ohne Adressleiste).

    Mit **eigenem Profilordner**, und das ist der Kern: so ist es eine eigene Chrome-Instanz, die
    `_fenster_schliessen` am Ende gezielt beenden kann, ohne das Chrome des Nutzers anzufassen. Der
    Viewer schaltet bei Serverende seine Navigation ab („Disconnected. Retrying…“); ein Fenster, das
    nach dem Training offen bliebe, sähe eingefroren aus. Das Fenster zu schließen hält das Training
    nicht an.

    Die Instanz öffnet einen DevTools-Port (nur auf 127.0.0.1, nur für die Dauer des Trainings, nur dieses
    Fenster); darüber stellt `_fenster_einrichten` die Startansicht ein, damit nicht Schwarz zu sehen ist.
    """
    try:
        if CHROME_APP.exists():
            cmd = ["open", "-na", str(CHROME_APP), "--args", f"--user-data-dir={profil}", "--no-first-run",
                   "--no-default-browser-check", "--remote-debugging-port=0", f"--app={url}", "--window-size=1400,900"]
        else:
            cmd = ["open", url]    # Standardbrowser: lässt sich nicht gezielt schließen
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if viewer_port and CHROME_APP.exists():
            def einrichten():
                try:
                    _fenster_einrichten(profil, viewer_port, abstand)
                except Exception:
                    pass           # die Startansicht ist Komfort; das Fenster bleibt benutzbar
            threading.Thread(target=einrichten, daemon=True).start()
    except OSError:
        pass   # kein Fenster ist kein Grund, ein Training zu verlieren


def _fenster_schliessen(profil: Path) -> None:
    """Beendet die Chrome-Instanz mit diesem Profilordner — nur diese — und räumt ihn weg."""
    subprocess.run(["pkill", "-TERM", "-f", "--", f"--user-data-dir={profil}"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    time.sleep(1.5)     # Chrome schreibt beim Beenden noch ins Profil
    shutil.rmtree(profil, ignore_errors=True)


def _pruefe_rahmen(lauf_ordner: Path) -> None:
    """
    Liegt der Splat im Rahmen des Eingabemodells? Spirula schreibt die Verschiebung, mit der es
    trainiert hat, nach `scene_transform.json`. Wäre sie nicht die Identität, stünde der Splat nicht
    dort, wohin `ausrichtung` das Modell gelegt hat — und das fiele erst im Viewer auf, als Splat
    irgendwo neben dem Gelände.
    """
    pfad = lauf_ordner / "scene_transform.json"
    if not pfad.exists():
        raise Fehler("Spirula hat keine scene_transform.json geschrieben — die Lage des Splats ist nicht belegt.")
    t = json.loads(pfad.read_text())["train_from_world"]
    drehung = np.array(t["rotation"]["matrix_3x3"], dtype=float)
    if (abs(float(t["scale"]) - 1.0) > 1e-9 or np.abs(np.array(t["translation"], dtype=float)).max() > 1e-6
            or np.abs(drehung - np.eye(3)).max() > 1e-9):
        raise Fehler("Spirula hat die Szene verschoben, gedreht oder skaliert (scene_transform.json ist nicht die "
                     "Identität) — der Splat läge nicht im ENU-Rahmen des Modells.")


def _spirula_splat(lauf_ordner: Path) -> Path | None:
    """Die PLY des letzten Prüfpunkts (`step-<n>.ckpt/splat.ply`) eines Laufs."""
    stand = sorted(lauf_ordner.glob("step-*.ckpt/splat.ply"),
                   key=lambda p: int(re.search(r"step-0*(\d+)", p.parent.name).group(1)))
    return stand[-1] if stand else None


def training(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    if not SPIRULA:
        raise Fehler("Spirula Studio fehlt (erwartet unter ~/Projekte/spirula-studio-app/Spirula Studio.app, "
                     "oder SPIRULA_BIN setzen).")
    schritte = int(opt["schritte"])
    name = "spirula"
    ausgabe = ordner / name
    shutil.rmtree(ausgabe, ignore_errors=True)

    # Spirula meldet je hundert Schritte eine Zeile: „step  101/300 (33%)  splats 20000  [elapsed … | ETA …]“.
    # `--lang en` ist Pflicht: die Ausgabe folgt sonst der Systemsprache.
    schritt_zeile = re.compile(r"step\s+(\d+)/(\d+)\s+\(\s*\d+%\)\s+splats\s+(\d+)")
    fenster = bool(opt.get("fenster")) or os.getenv("SPIRULA_FENSTER") == "1"
    port = _freier_port(VIEWER_PORT) if fenster else None
    profil = ordner / "_fenster"
    abstand = _szenenradius(ordner) if fenster else 10.0
    geoeffnet = []

    def zeile(z):
        m = schritt_zeile.search(z)
        if m:
            stand.bruch("training", int(m.group(1)) / int(m.group(2)),
                        f"Splat trainieren — Schritt {m.group(1)} von {m.group(2)}, "
                        f"{int(m.group(3)):,} Splats".replace(",", "."))
        elif fenster and not geoeffnet and z.startswith("Viewer at"):
            geoeffnet.append(True)     # erst wenn der Viewer lauscht, sonst öffnet sich eine leere Seite
            _fenster_oeffnen(f"http://127.0.0.1:{port}/", profil, port, abstand)

    teiler = _aufloesungsteiler(ordner / "train" / "images", int(opt["aufloesung"]))
    cmd = [SPIRULA, "train", "3dgs", "--data", ordner / "train", "--data-format", "colmap",
           "--colmap-recon-dir", "sparse/0", "--output-dir-prefix", ordner, "--output-dir-name", name,
           "--num-iterations", schritte, "--cap-max", opt["max_splats"],
           # Nur der Prüfpunkt am Ende: bei 4 Mio. Splats ist jeder ein Gigabyte.
           "--steps-per-save", schritte,
           # Die Georeferenzierung steckt im Modell (`ausrichtung`); Spirula darf nichts mehr verschieben.
           "--scene-center", "none",
           # Ohne zurückgehaltene Bilder gibt es nichts zu bewerten — und nichts herunterzuladen.
           "--eval-lpips", 0, "--lang", "en"]
    if teiler:
        cmd += ["--train-resolution-divisor", teiler]
    # Spirula bleibt nach dem Training mit seinem Viewer am Leben, wenn man es lässt; hier endet es mit
    # dem Training, und das Fenster schließt sich mit, wie es Brushs Fenster tat.
    cmd += ["--viewer-port", port, "--keep-viewer-alive", 0] if fenster else ["--disable-viewer", 1]
    try:
        lauf(job, cmd, zeile=zeile, was="Spirula Studio")
    finally:
        if fenster:
            _fenster_schliessen(profil)    # auch bei Abbruch und Fehler — ein totes Fenster hilft niemandem

    if not _spirula_splat(ausgabe):
        raise Fehler("Spirula Studio hat keine Ergebnisdatei geschrieben.")
    _pruefe_rahmen(ausgabe)
    return {"export": _spirula_splat(ausgabe).parent.name, "aufloesungsteiler": teiler, "fenster": fenster}


def abschluss(job: str, ordner: Path, opt: dict, stand: Stand) -> dict:
    ausgabe = ordner / "spirula"
    gefunden = _spirula_splat(ausgabe)
    if not gefunden:
        raise Fehler("Kein Spirula-Ergebnis vorhanden.")
    ziel = ordner / "ergebnis.ply"
    ziel.unlink(missing_ok=True)
    shutil.move(str(gefunden), ziel)
    # Spirula schreibt keinen Hochachsen-Kommentar; trainiert wurde im ENU-Rahmen (Z oben). Der Kachel-
    # Handler nähme ohne Kommentar ohnehin Z-up an, der SOG-Export aber dreht nur PLYs, die es melden.
    eingetragen = plyhilfe.trage_hochachse_ein(ziel, "z")
    kopf = plyhilfe.lese_kopf(ziel)
    if not plyhilfe.ist_3dgs(kopf):
        raise Fehler("Das Ergebnis ist kein gültiger Gaussian Splat.")
    # Die Prüfpunkte (state.tar) wiegen so viel wie der Splat und werden nicht mehr gebraucht;
    # config.json und scene_transform.json bleiben als Nachweis, womit trainiert wurde.
    for punkt in ausgabe.glob("step-*.ckpt"):
        shutil.rmtree(punkt, ignore_errors=True)
    return {"splats": kopf["anzahl"], "bytes": ziel.stat().st_size, "hochachse_eingetragen": eingetragen}


FUNKTIONEN = {
    "entpacken": lambda j, o, opt, s: entpacken(j, o),
    "vorbereiten": vorbereiten, "merkmale": merkmale, "abgleich": abgleich,
    "rekonstruktion": rekonstruktion, "ausrichtung": ausrichtung, "entzerren": entzerren,
    "atlas_posen": atlas_posen, "atlas_modell": atlas_modell, "atlas_ausrichtung": atlas_ausrichtung,
    "training": training, "abschluss": abschluss,
}


# ── Auftrag ausführen ─────────────────────────────────────────────────────────


def bearbeite(job: str) -> None:
    """Führt einen Auftrag von der ersten offenen Stufe bis zum Ende aus."""
    ordner = A.verzeichnis(job)
    auftrag = A.lese(job)
    opt = auftrag["optionen"]
    stufen = stufen_fuer(opt)
    stand = Stand(job, stufen)
    erledigt = list(auftrag.get("fertig_stufen") or [])
    bericht = dict(auftrag.get("bericht") or {})
    t0 = time.time()
    A.schreibe(job, status="laeuft", worker_pid=os.getpid(), fehler=None)
    A.anhaengen(job, f"── Start {A.jetzt()} ({auftrag['name']}, {opt['qualitaet']}, "
                     f"{'World Labs Atlas' if opt.get('verfahren') == 'atlas' else 'COLMAP'}) ──")
    try:
        for name, _, _ in stufen:
            if name in erledigt:
                continue
            pruefe_abbruch(job)
            stand.stufe(name)
            t = time.time()
            bericht[name] = FUNKTIONEN[name](job, ordner, opt, stand) or {}
            bericht[name]["sekunden"] = round(time.time() - t, 1)
            erledigt.append(name)
            A.schreibe(job, fertig_stufen=erledigt, bericht=bericht)
        ab = bericht["abschluss"]
        geo = json.loads((ordner / "georef.json").read_text())
        A.schreibe(job, status="trainiert", stufe="trainiert", anteil=1.0,
                   meldung=f"Training fertig ({ab['splats']:,} Splats). Wird ins Backend übernommen.".replace(",", "."),
                   ergebnis={"splats": ab["splats"], "bytes": ab["bytes"]},
                   georef={k: geo.get(k) for k in ("modus", "massstab_bekannt", "drehung_bekannt", "rms_m",
                                                  "inlier", "mit_gps", "bilder", "hinweise", "ursprung",
                                                  "hochachse_quelle", "massstab_geschaetzt", "massstab_quelle")},
                   sekunden=round(time.time() - t0 + float(auftrag.get("sekunden") or 0), 1))
        A.anhaengen(job, f"── Fertig nach {time.time() - t0:.0f} s ──")
    except Abgebrochen:
        A.schreibe(job, status="abgebrochen", meldung="Abgebrochen.")
        A.anhaengen(job, "── Abgebrochen ──")
    except Fehler as e:
        A.schreibe(job, status="fehler", meldung=str(e), fehler=str(e))
        A.anhaengen(job, f"FEHLER: {e}")
    except Exception as e:  # unvorhergesehen: nicht den Worker mitnehmen
        import traceback
        A.anhaengen(job, traceback.format_exc())
        A.schreibe(job, status="fehler", meldung=f"Unerwarteter Fehler: {type(e).__name__}: {e}", fehler=str(e))


# ── Hotfolder ─────────────────────────────────────────────────────────────────

_beobachtet: dict[str, tuple[int, float]] = {}


def _groesse(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def _ruhig(p: Path, sekunden: float) -> bool:
    """Hat sich die Größe seit `sekunden` nicht geändert? AirDrop und Finder kopieren nicht atomar."""
    try:
        g = _groesse(p)
    except OSError:
        return False
    alt = _beobachtet.get(str(p))
    jetzt = time.time()
    if alt is None or alt[0] != g:
        _beobachtet[str(p)] = (g, jetzt)
        return False
    return jetzt - alt[1] >= sekunden


def hotfolder_pruefen() -> None:
    """
    Aufträge aus `eingang/` anlegen.

    ZIP-Dateien und Ordner sind je ein Auftrag. Lose Bilder und Videos (so kommt ein
    AirDrop mit vielen Fotos an) bilden *einen* Auftrag, sobald sie 15 Sekunden still sind.
    """
    eingang = A.WURZEL / "eingang"
    eingang.mkdir(parents=True, exist_ok=True)
    lose, begleit, fertig = [], [], []
    for p in sorted(eingang.iterdir()):
        if p.name.startswith(".") or p.name.endswith((".part", ".download", ".crdownload", ".tmp")):
            continue
        if p.is_dir() or p.suffix.lower() == ".zip":
            if _ruhig(p, 10) and (p.is_dir() or zipfile.is_zipfile(p)):
                fertig.append(([p], p.stem if p.is_file() else p.name))
        elif p.suffix.lower() in A.BILD_ENDUNGEN | A.VIDEO_ENDUNGEN:
            lose.append(p)
        elif p.suffix.lower() in splatpack.BEGLEIT_ENDUNGEN:
            begleit.append(p)       # Begleitdateien von Aufnahme-Apps — nur zusammen mit Bildern
    # Erst *alle* beobachten, dann prüfen: `all(generator)` bräche beim ersten unruhigen Bild ab, die
    # übrigen kämen erst eines nach dem anderen an die Reihe — bei zwölf Fotos drei Minuten statt 15 s.
    ruhig = [_ruhig(p, 15) for p in lose]
    ruhig_begleit = [_ruhig(p, 15) for p in begleit]
    if lose and all(ruhig) and all(ruhig_begleit):
        fertig.append((lose + begleit, "Fotos " + time.strftime("%d.%m. %H:%M")))
    for pfade, name in fertig:
        auftrag = A.neu(name)
        ziel = A.verzeichnis(auftrag["id"]) / "eingang"
        for p in pfade:
            shutil.move(str(p), str(ziel / p.name))
            _beobachtet.pop(str(p), None)
        A.anhaengen(auftrag["id"], f"Aus dem Eingangsordner übernommen: {', '.join(p.name for p in pfade)[:300]}")
        print(f"[hotfolder] Auftrag {auftrag['id'][:8]} '{name}' angelegt ({len(pfade)} Datei(en)).", flush=True)


# ── Hauptschleife ─────────────────────────────────────────────────────────────


def verwaiste_zuruecksetzen() -> None:
    """Ein Auftrag, der „läuft“, obwohl sein Worker nicht mehr lebt, kommt wieder in die Schlange."""
    for a in A.alle():
        if a.get("status") == "laeuft":
            pid = a.get("worker_pid")
            lebt = False
            if pid:
                try:
                    os.kill(int(pid), 0)
                    lebt = int(pid) != os.getpid()
                except (ProcessLookupError, PermissionError, ValueError):
                    lebt = False
            if not lebt:
                A.schreibe(a["id"], status="wartet", meldung="Wird nach einem Neustart des Workers fortgesetzt.")
                A.anhaengen(a["id"], "Worker neu gestartet — Auftrag wird fortgesetzt.")


def _verwaiste_fenster_schliessen() -> None:
    """
    Trainings-Fenster, deren Training nicht mehr zu dieser Worker-Sitzung gehört, wegräumen.

    Stirbt der Worker mitten im Training (Neustart, Absturz), kommt `_fenster_schliessen` nicht mehr
    dazu; die Chrome-Instanz bliebe als totes Fenster stehen. Erkannt wird sie am Profilordner unter der
    Warteschlange — eine fremde Chrome-Instanz trägt den nicht.
    """
    subprocess.run(["pkill", "-TERM", "-f", "--", f"--user-data-dir={A.WURZEL}/"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    for profil in A.WURZEL.glob("*/_fenster"):
        shutil.rmtree(profil, ignore_errors=True)


def naechster() -> str | None:
    wartende = [a for a in A.alle() if a.get("status") == "wartet"]
    if not wartende:
        return None
    wartende.sort(key=lambda a: a.get("erstellt", ""))
    return wartende[0]["id"]


_ZUSTAND = {"zustand": "bereit", "auftrag": None}
_HEIC = _heif_anmelden()


def melden(zustand: str, auftrag_id: str | None = None):
    _ZUSTAND.update(zustand=zustand, auftrag=auftrag_id)
    A.worker_melden(pid=os.getpid(), zustand=zustand, auftrag=auftrag_id,
                    werkzeuge={"colmap": COLMAP, "spirula": SPIRULA, "ffmpeg": FFMPEG}, heic=_HEIC)


def _herzschlag(stopp: threading.Event):
    """
    Lebenszeichen alle 5 s, **unabhängig von der Arbeit**.

    Die Hauptschleife meldet sich nur zwischen zwei Aufträgen; ein Trainingslauf von einer
    Stunde ließe das Zeichen veralten, und die Oberfläche behauptete „Worker läuft nicht“,
    während er gerade rechnet — der Anlass, diesen Faden zu schreiben.
    """
    while not stopp.wait(5.0):
        melden(_ZUSTAND["zustand"], _ZUSTAND["auftrag"])


def dauerbetrieb(einmal: bool = False):
    A.WURZEL.mkdir(parents=True, exist_ok=True)
    fehlend = [n for n, p in (("COLMAP", COLMAP), ("Spirula Studio", SPIRULA)) if not p]
    if fehlend:
        print(f"Warnung: {', '.join(fehlend)} nicht gefunden — Aufträge scheitern.", flush=True)
    _verwaiste_fenster_schliessen()
    verwaiste_zuruecksetzen()
    print(f"Splatwerk-Worker (pid {os.getpid()}) — Warteschlange {A.WURZEL}", flush=True)
    stopp = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopp.set())
    signal.signal(signal.SIGINT, lambda *_: stopp.set())
    threading.Thread(target=_herzschlag, args=(stopp,), daemon=True).start()
    while not stopp.is_set():
        melden("bereit")
        if not einmal:
            hotfolder_pruefen()
        job = naechster()
        if job:
            melden("arbeitet", job)
            print(f"[{job[:8]}] Start", flush=True)
            bearbeite(job)
            print(f"[{job[:8]}] {A.lese(job)['status']}", flush=True)
            continue
        if einmal:
            return
        stopp.wait(3.0)
    melden("beendet")


def anlegen(pfade: list[str], name: str | None, qualitaet: str, verfahren: str = "colmap", mesh: bool = False,
            fenster: bool = False) -> None:
    """Auftrag aus der Kommandozeile: Dateien und Ordner in einen neuen Auftrag legen."""
    quellen = [Path(p).expanduser() for p in pfade]
    fehlt = [str(q) for q in quellen if not q.exists()]
    if fehlt:
        sys.exit("Nicht gefunden: " + ", ".join(fehlt))
    a = A.neu(name or quellen[0].stem, qualitaet, optionen={"verfahren": verfahren, "mesh": bool(mesh), "fenster": bool(fenster)})
    ziel = A.verzeichnis(a["id"]) / "eingang"
    for q in quellen:
        if q.is_dir():
            for f in q.rglob("*"):
                if f.is_file():
                    (ziel / q.name / f.relative_to(q)).parent.mkdir(parents=True, exist_ok=True)
                    try:
                        os.link(f, ziel / q.name / f.relative_to(q))
                    except OSError:
                        shutil.copy2(f, ziel / q.name / f.relative_to(q))
        else:
            try:
                os.link(q, ziel / q.name)
            except OSError:
                shutil.copy2(q, ziel / q.name)
    print(a["id"])


def main():
    ap = argparse.ArgumentParser(description="Splatwerk-Worker: Fotos → verorteter Gaussian Splat")
    sub = ap.add_subparsers(dest="befehl")
    sub.add_parser("einmal", help="Warteschlange abarbeiten und beenden")
    a = sub.add_parser("anlegen", help="Auftrag aus Dateien oder Ordnern anlegen")
    a.add_argument("pfade", nargs="+")
    a.add_argument("--name")
    a.add_argument("--qualitaet", default="standard", choices=list(A.QUALITAET))
    a.add_argument("--verfahren", default="colmap", choices=list(A.VERFAHREN))
    a.add_argument("--mesh", action="store_true", help="danach ein Mesh über World Labs (splats2Mesh)")
    a.add_argument("--fenster", action="store_true", help="das Training in einem Spirula-Studio-Fenster zeigen")
    args = ap.parse_args()
    if args.befehl == "anlegen":
        anlegen(args.pfade, args.name, args.qualitaet, verfahren=args.verfahren, mesh=args.mesh, fenster=args.fenster)
    else:
        dauerbetrieb(einmal=args.befehl == "einmal")


if __name__ == "__main__":
    main()
