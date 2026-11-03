"""
SOG-Export: 3DGS-PLY → „Spatially Ordered Gaussians“ (PlayCanvas).

SOG ist ein gebündeltes Archiv aus WebP-Texturen, in denen Position, Rotation, Skala
und Farbe nach Raumordnung abgelegt sind — typisch ein Zehntel der PLY-Größe, und das
Format, das SuperSplat, PlayCanvas und `splides` direkt laden. Gerechnet wird mit dem
Werkzeug der PlayCanvas-Leute selbst (`@playcanvas/splat-transform`); das Format
selbst nachzubauen hieße, einen k-Means-Kodierer und die Textur-Anordnung zu pflegen,
die sich mit jeder Version verschieben.

**Ausrichtung.** Die Welt der Splat-Werkzeuge ist die von COLMAP: x rechts, y unten,
z nach vorn. Ein georeferenzierter Splat von hier ist dagegen Z-up (Ost, Nord, Oben).
Würde man ihn unverändert exportieren, läge er in SuperSplat auf der Seite. Deshalb
wird bei `ausrichtung="auto"` eine PLY, die `Vertical axis: z` meldet (alles, was
`splatwerk` erzeugt), vor dem Export um −90° um x gedreht:

    (x, y, z)_ENU  →  (x, −z, y)_COLMAP

Gemessen an einer Probe: Positionen stimmen, die Splat-Orientierungen drehen mit
(Normalen der Bodenflächen zeigen danach entlang −y). Eine PLY ohne Hochachsen-
Angabe — alles, was von fremden Trainern kommt — bleibt unberührt: sie liegt schon
in dem Rahmen, den die Werkzeuge erwarten.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from pathlib import Path

from splatwerk import plyhilfe

logger = logging.getLogger(__name__)

# Eine Z-up-Szene in die Welt der Splat-Werkzeuge (y unten) legen — siehe Kopf.
DREHUNG_ZUP_NACH_COLMAP = "-90,0,0"

# Reihenfolge der Fundorte: Umgebung, Container, PATH, Entwicklungsrechner.
_FUNDORTE = (
    "/opt/splat-transform/node_modules/.bin/splat-transform",
    str(Path.home() / "Projekte/splides/node_modules/.bin/splat-transform"),
)


class SogFehler(RuntimeError):
    """Der Export ist gescheitert; die Meldung ist für Menschen gedacht."""


def finde_werkzeug() -> str | None:
    """Pfad zu `splat-transform` oder None."""
    fest = os.getenv("SPLAT_TRANSFORM_BIN")
    if fest and Path(fest).exists():
        return fest
    for kandidat in _FUNDORTE:
        if Path(kandidat).exists():
            return kandidat
    return shutil.which("splat-transform")


def exportiere(quelle: Path, ziel: Path, ausrichtung: str = "auto",
               sh_grad: int | None = None, sh_iterationen: int | None = None,
               zeitlimit_s: int = 3600) -> dict:
    """
    `quelle` (3DGS-PLY) → `ziel` (.sog).

    `ausrichtung`: ``auto`` (Z-up-PLY drehen, sonst unverändert), ``colmap`` (immer
    Z-up → y unten drehen), ``unveraendert``. `sh_grad` 0–3 schneidet höhere SH-Bänder ab
    (kleinere Datei, weniger blickabhängige Farbe). `sh_iterationen` ist die Güte
    der SH-Kompression (Werkzeugvorgabe 10).

    Gibt `{bytes, gedreht, hochachse, splats, sekunden}` zurück.
    """
    import time

    werkzeug = finde_werkzeug()
    if werkzeug is None:
        raise SogFehler("Das Werkzeug 'splat-transform' ist nicht installiert "
                        "(@playcanvas/splat-transform, Node ≥ 22). Im Container steckt es im Image.")
    kopf = plyhilfe.lese_kopf(quelle)
    if not plyhilfe.ist_3dgs(kopf):
        raise SogFehler("Die Quelle ist kein Gaussian Splat (Skala/Rotation/Farbe fehlen).")
    achse = plyhilfe.hochachse(kopf)
    drehen = ausrichtung == "colmap" or (ausrichtung == "auto" and achse == "z")
    if ausrichtung not in ("auto", "colmap", "unveraendert"):
        raise SogFehler(f"Unbekannte Ausrichtung '{ausrichtung}'.")

    ziel.parent.mkdir(parents=True, exist_ok=True)
    # `-w`: überschreiben. `-g cpu`: im Container gibt es keine GPU, und auf dem Host
    # ist die Verdichtung der Farbtabellen auf der CPU für die Größen hier schnell genug.
    # `-q`: nur Fehler, sonst füllt der Fortschrittsbalken das Protokoll.
    cmd = [werkzeug, str(quelle)]
    if sh_grad is not None:
        cmd += ["-H", str(max(0, min(3, sh_grad)))]
    if drehen:
        cmd += ["-r", DREHUNG_ZUP_NACH_COLMAP]
    cmd += [str(ziel), "-w", "-g", "cpu", "-q"]
    if sh_iterationen is not None:
        cmd += ["-i", str(sh_iterationen)]

    logger.info(f"SOG-Export: {quelle.name} ({kopf['anzahl']:,} Splats, Hochachse {achse or '?'}"
                f"{', gedreht' if drehen else ''})")
    t0 = time.time()
    try:
        lauf = subprocess.run(cmd, capture_output=True, text=True, timeout=zeitlimit_s)
    except subprocess.TimeoutExpired:
        ziel.unlink(missing_ok=True)
        raise SogFehler(f"Der Export brauchte länger als {zeitlimit_s // 60} Minuten und wurde abgebrochen.")
    if lauf.returncode != 0 or not ziel.exists():
        ziel.unlink(missing_ok=True)
        ende = (lauf.stderr or lauf.stdout or "").strip().splitlines()[-3:]
        raise SogFehler("splat-transform ist gescheitert: " + " / ".join(ende))
    return {
        "bytes": ziel.stat().st_size,
        "gedreht": drehen,
        "hochachse": achse,
        "splats": kopf["anzahl"],
        "sekunden": round(time.time() - t0, 1),
    }
