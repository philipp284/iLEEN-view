"""
Die Warteschlange des Splat-Trainings — ein Verzeichnis, kein Dienst.

    data/training/
      eingang/                 Hotfolder: ZIP, Ordner, Bilder, Videos hineinziehen
      worker.json              Lebenszeichen des Workers (Host)
      <auftrag>/
        auftrag.json           Name, Optionen, Dateien — unveränderlich
        status.json            wartet · laeuft · trainiert · uebernehme · fertig · fehler · abgebrochen
        abbruch                Marke: wer sie anlegt, bricht den Auftrag ab
        log.txt                alles, was COLMAP und Brush gesagt haben
        eingang/ roh/ bilder/ colmap/ train/ brush/ atlas/
        ergebnis.ply  georef.json

Der Container (`cesium-api`) und der Worker auf dem Mac reden **nur** über diese
Dateien. Das ist keine Sparsamkeit, sondern der Grund, warum es hält: Der Worker
braucht die Metal-GPU, die Docker Desktop nicht durchreicht, und ein Netzwerkaufruf
von dort in den Container (oder zurück) wäre ein Weg mehr, der ausfallen kann. Eine
Datei überlebt den Neustart beider Seiten.

Wer schreibt was: der Container legt Aufträge an, setzt die Abbruchmarke und
übernimmt `trainiert` → `fertig`; der Worker führt `wartet` → `laeuft` → `trainiert`
aus. Die Statusübergänge überlappen sich nie, deshalb genügt das atomare Ersetzen
der Datei ohne Sperre.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Standard: neben dem Backend. Im Container zeigt `ILEEN_TRAINING_DIR` auf das gemountete Volume.
WURZEL = Path(os.getenv("ILEEN_TRAINING_DIR") or Path(__file__).resolve().parent.parent / "data" / "training")

ENDSTATI = {"fertig", "fehler", "abgebrochen"}
AKTIVE_STATI = {"laedt", "wartet", "laeuft", "trainiert", "uebernehme"}

# Qualitätsstufen. `schritte` ist die Zahl der Trainingsschritte von Spirula Studio, `aufloesung` die
# längste Bildkante beim Training, `bild_max` die längste Bildkante für COLMAP und die
# aufbereiteten Bilder, `max_splats` die Obergrenze, `video_bilder` die Zahl der Bilder,
# die aus einem Video gezogen werden. Alles Voreinstellungen — überschreibbar je Auftrag.
QUALITAET = {
    "schnell":  {"schritte": 6000,  "aufloesung": 1280, "bild_max": 1600, "max_splats": 1_500_000, "video_bilder": 120},
    "standard": {"schritte": 30000, "aufloesung": 1920, "bild_max": 2400, "max_splats": 4_000_000, "video_bilder": 200},
    "hoch":     {"schritte": 45000, "aufloesung": 2560, "bild_max": 3200, "max_splats": 8_000_000, "video_bilder": 300},
}

#: Wie aus Bildern Kameras werden. `colmap`: lokal, Merkmale + Bündelausgleich (der alte Weg).
#: `atlas`: World Labs schätzt Kameras und dichte Tiefe (`images2PosedRGBD`), trainiert wird
#: danach lokal wie bisher. Beide enden in derselben Übernahme.
VERFAHREN = {
    "colmap": "COLMAP (lokal)",
    "atlas": "World Labs Atlas",
}

BILD_ENDUNGEN = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".heif", ".webp", ".bmp"}
VIDEO_ENDUNGEN = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}


def jetzt() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def verzeichnis(auftrag_id: str) -> Path:
    # Die Kennung kommt aus einer URL: nur UUIDs zulassen, sonst wäre `../` ein Weg aus dem Volume.
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", auftrag_id):
        raise ValueError(f"Ungültige Auftragskennung: {auftrag_id!r}")
    return WURZEL / auftrag_id


def sauberer_name(name: str, ersatz: str = "datei") -> str:
    """Dateiname ohne Pfadanteile und Steuerzeichen — Uploads tragen beliebige Namen."""
    name = Path(name.replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f]", "", name).strip().lstrip(".")
    return name[:180] or ersatz


def sauberer_pfad(name: str, ersatz: str = "datei") -> str:
    """
    Relativer Pfad aus einem Upload-Namen: die Ordnerstruktur bleibt, `..` und Laufwerke nicht.

    Aufnahme-Apps legen zusammengehörige Dateien in einen Ordner (`PhotoSeries_…/wide_….jpg`
    samt `splatpack.json`); ginge der Ordner verloren, fände das Paket seine Begleitdateien nicht.
    """
    teile = [sauberer_name(t) for t in name.replace("\\", "/").split("/") if t not in ("", ".", "..")]
    return "/".join(teile[-6:]) or ersatz


def neu(name: str, qualitaet: str = "standard", optionen: dict | None = None,
        auftrag_id: str | None = None, status: str = "wartet") -> dict:
    """
    Legt einen Auftrag an und gibt `auftrag.json` zurück. Dateien kommen danach in `eingang/`.

    `status="laedt"` für Uploads: der Worker nimmt nur `wartet` auf, ein halb übertragener
    Auftrag darf ihm nicht in die Hände fallen.
    """
    if qualitaet not in QUALITAET:
        raise ValueError(f"Unbekannte Qualität '{qualitaet}'. Erlaubt: {', '.join(QUALITAET)}")
    if (optionen or {}).get("verfahren", "colmap") not in VERFAHREN:
        raise ValueError(f"Unbekanntes Verfahren '{optionen['verfahren']}'. Erlaubt: {', '.join(VERFAHREN)}")
    auftrag_id = auftrag_id or str(uuid.uuid4())
    ordner = verzeichnis(auftrag_id)
    (ordner / "eingang").mkdir(parents=True, exist_ok=True)
    opt = {**QUALITAET[qualitaet], **(optionen or {}), "qualitaet": qualitaet}
    auftrag = {"id": auftrag_id, "name": (name or "Splat").strip()[:120], "erstellt": jetzt(), "optionen": opt}
    (ordner / "auftrag.json").write_text(json.dumps(auftrag, indent=2, ensure_ascii=False))
    schreibe(auftrag_id, status=status, stufe=status, anteil=0.0,
             meldung="Wartet auf den Worker." if status == "wartet" else "Dateien werden empfangen…",
             erstellt=auftrag["erstellt"])
    return auftrag


def lese(auftrag_id: str) -> dict | None:
    """`auftrag.json` + `status.json` zusammengeführt, oder None."""
    try:
        ordner = verzeichnis(auftrag_id)
        auftrag = json.loads((ordner / "auftrag.json").read_text())
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    try:
        status = json.loads((ordner / "status.json").read_text())
    except (OSError, json.JSONDecodeError):
        status = {"status": "wartet", "stufe": "wartet", "anteil": 0.0, "meldung": ""}
    return {**auftrag, **status, "id": auftrag_id}


def schreibe(auftrag_id: str, **felder) -> dict:
    """Ergänzt `status.json` um `felder` — atomar (Schreiben in eine Nebendatei, dann Ersetzen)."""
    ordner = verzeichnis(auftrag_id)
    pfad = ordner / "status.json"
    try:
        aktuell = json.loads(pfad.read_text())
    except (OSError, json.JSONDecodeError):
        aktuell = {}
    aktuell.update(felder)
    aktuell["aktualisiert"] = jetzt()
    tmp = pfad.with_suffix(".tmp")
    tmp.write_text(json.dumps(aktuell, indent=2, ensure_ascii=False))
    os.replace(tmp, pfad)
    return aktuell


def alle() -> list[dict]:
    """Alle Aufträge, neueste zuerst."""
    if not WURZEL.exists():
        return []
    liste = []
    for ordner in WURZEL.iterdir():
        if ordner.is_dir() and (ordner / "auftrag.json").exists():
            a = lese(ordner.name)
            if a:
                liste.append(a)
    liste.sort(key=lambda a: a.get("erstellt", ""), reverse=True)
    return liste


def anhaengen(auftrag_id: str, text: str) -> None:
    """Eine Zeile ins Protokoll des Auftrags."""
    with (verzeichnis(auftrag_id) / "log.txt").open("a", encoding="utf-8") as f:
        f.write(text.rstrip("\n") + "\n")


def log_ende(auftrag_id: str, zeilen: int = 40) -> str:
    pfad = verzeichnis(auftrag_id) / "log.txt"
    if not pfad.exists():
        return ""
    with pfad.open("rb") as f:
        f.seek(0, os.SEEK_END)
        groesse = f.tell()
        f.seek(max(0, groesse - 64 * 1024))
        roh = f.read().decode("utf-8", "replace")
    return "\n".join(roh.splitlines()[-zeilen:])


def abbruch_anfordern(auftrag_id: str) -> None:
    (verzeichnis(auftrag_id) / "abbruch").write_text(jetzt())


def abbruch_angefordert(auftrag_id: str) -> bool:
    return (verzeichnis(auftrag_id) / "abbruch").exists()


def entfernen(auftrag_id: str) -> None:
    shutil.rmtree(verzeichnis(auftrag_id), ignore_errors=True)


def aufraeumen_nach_fertig(auftrag_id: str) -> None:
    """
    Gibt den großen, ersetzbaren Teil frei, sobald der Splat im Backend liegt.

    Geblieben sind `bilder/` (zum Neu-Trainieren), das ausgerichtete Modell, `georef.json`,
    das Protokoll und `ergebnis.ply`. Weg sind die Originale (liegen noch beim Absender),
    die entpackten Rohbilder, die entzerrten Trainingsbilder und die COLMAP-Datenbank,
    die schnell mehrere Gigabyte wiegt.
    """
    ordner = verzeichnis(auftrag_id)
    for name in ("eingang", "roh", "train", "brush"):
        shutil.rmtree(ordner / name, ignore_errors=True)
    for datei in (ordner / "colmap").glob("database.db*"):
        datei.unlink(missing_ok=True)
    # Atlas-Weg: Tiefen, Konfidenzen und Startpunkte sind im Splat aufgegangen. Antworten und
    # Zustand (wenige kB) bleiben — sie sagen, welche Operationen bei World Labs bezahlt wurden.
    for muster in ("*.exr", "*.png", "bild_*", "modell.npz"):
        for datei in (ordner / "atlas").glob(muster):
            datei.unlink(missing_ok=True)
    punkte = ordner / "colmap" / "txt_ausgerichtet" / "points3D.txt"
    if punkte.exists() and punkte.stat().st_size > 20 * 1024 * 1024:
        punkte.unlink()       # dichte Startpunkte, Dutzende MB; das Mesh braucht nur die Kameras
    (ordner / "eingang").mkdir(exist_ok=True)


# ── Lebenszeichen des Workers ────────────────────────────────────────────────

LEBENSZEICHEN_S = 20


_MELDESPERRE = threading.Lock()


def worker_melden(**felder) -> None:
    """Schreibt das Lebenszeichen. Von mehreren Fäden aufgerufen (Hauptschleife und Herzschlag)."""
    WURZEL.mkdir(parents=True, exist_ok=True)
    pfad = WURZEL / "worker.json"
    with _MELDESPERRE:
        tmp = pfad.with_suffix(".tmp")
        tmp.write_text(json.dumps({**felder, "zeit": time.time(), "zeit_text": jetzt()}, indent=2))
        os.replace(tmp, pfad)


def worker_stand() -> dict:
    """`{aktiv, ...}` — aktiv, wenn das Lebenszeichen jünger als `LEBENSZEICHEN_S` ist."""
    try:
        d = json.loads((WURZEL / "worker.json").read_text())
    except (OSError, json.JSONDecodeError):
        return {"aktiv": False, "grund": "Der Worker hat sich noch nie gemeldet."}
    alter = time.time() - float(d.get("zeit", 0))
    d["aktiv"] = alter < LEBENSZEICHEN_S
    d["alter_s"] = round(alter, 1)
    if not d["aktiv"]:
        d["grund"] = f"Letztes Lebenszeichen vor {alter / 60:.0f} Minuten."
    return d
