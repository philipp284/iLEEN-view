"""
PDF → SVG für den Zeichenmodus „Plan": eine hochgeladene Planvorlage
(Bestandsplan, Scan, Fremdplanung) wird seitenweise als Vektor-SVG
zurückgegeben und im Viewer als kalibrierbarer Blatt-Hintergrund unterlegt
(siehe plan-pdf.js).

**Warum pdf2svg und kein Rasterbild.** Ein Bestandsplan wird beim Bemaßen bis
auf Anschlussdetails hineingezoomt; ein Rasterbild würde dabei in Pixeln
zerfallen. pdf2svg (poppler + cairo) hält Linien und Text als Vektor, die
Vorlage bleibt in jedem Maßstab scharf — genau wie die Schnittfiguren aus
`tiling/section.py`, mit denen sie im selben Blatt zusammenkommt.

**Warum PyMuPDF zusätzlich.** `pdf2svg` selbst nennt keine Seitengröße; ohne
sie ließe sich die Vorlage nicht einmal grob maßstäblich einpassen, bevor der
Nutzer kalibriert. `page_size_mm()` liest nur die MediaBox — das ist eine
Kopfzeile der Datei, kein Rendern, und deshalb kein Grund, PyMuPDF auch für die
eigentliche Umwandlung zu benutzen.
"""

import logging
import subprocess
import tempfile
from pathlib import Path

import pymupdf
from fastapi import HTTPException

logger = logging.getLogger(__name__)

_PT_TO_MM = 25.4 / 72.0
_TIMEOUT_S = 60


def page_count(path: Path) -> int:
    with pymupdf.open(path) as doc:
        return doc.page_count


def page_size_mm(path: Path, page: int) -> tuple[float, float]:
    """Breite und Höhe der Seite in Millimetern, aus der MediaBox."""
    with pymupdf.open(path) as doc:
        _pruefe_seite(doc.page_count, page)
        rect = doc[page - 1].rect
    return rect.width * _PT_TO_MM, rect.height * _PT_TO_MM


def to_svg(path: Path, page: int) -> str:
    """
    Wandelt eine einzelne Seite in SVG-Quelltext.

    `pdf2svg` schreibt nur in eine Datei, nie nach stdout — deshalb der Umweg
    über ein Temp-Verzeichnis, das mit der Funktion wieder verschwindet.
    Blockierend (poppler/cairo); im Router hinter `asyncio.to_thread`.
    """
    with tempfile.TemporaryDirectory() as tmp:
        ziel = Path(tmp) / "seite.svg"
        try:
            ergebnis = subprocess.run(
                ["pdf2svg", str(path), str(ziel), str(page)],
                capture_output=True,
                text=True,
                timeout=_TIMEOUT_S,
            )
        except FileNotFoundError:
            raise HTTPException(
                status_code=500,
                detail="pdf2svg ist im Container nicht installiert.",
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(
                status_code=504, detail="Die Umwandlung der PDF-Seite hat zu lange gedauert."
            )

        if ergebnis.returncode != 0 or not ziel.exists():
            logger.warning("pdf2svg fehlgeschlagen (Seite %s): %s", page, ergebnis.stderr.strip())
            raise HTTPException(
                status_code=422,
                detail="pdf2svg konnte diese Seite nicht umwandeln — ist die Datei beschädigt "
                "oder passwortgeschützt?",
            )
        return ziel.read_text(encoding="utf-8")


def _pruefe_seite(seiten: int, seite: int) -> None:
    if not (1 <= seite <= seiten):
        raise HTTPException(
            status_code=422,
            detail=f"Die Datei hat {seiten} Seite(n), Seite {seite} existiert nicht.",
        )
