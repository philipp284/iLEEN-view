"""
Splat-Dateien in das Backend übernehmen und dort verorten — die Seite im Container.

Zwei Wege führen hierher, beide enden in derselben Kachel-Pipeline (`tiling.pipeline`):

* ein im Worker trainierter Splat aus Fotos (`uebernehme_training`), verortet über die
  Georeferenzierung der Bilder,
* ein aus einem Laserscan umgerechneter Splat (`verorte_scan`), verortet über das CRS
  des LAS-Kopfes.

**Wo hängt die Verortung?** `tile_splat()` zentriert die Quellkoordinaten auf die Mitte
der Hüllbox (XY) und die Unterkante (Z) und schreibt den Inhalt relativ zur Mitte des
Wurzelkastens; die Platzierung (`root.transform`) gilt dann für **diese Mitte**, nicht
für den Quellursprung (`root.extras.ileen_splat`, „Render-System“). Wer eine Position
aus den Quellkoordinaten kennt — GPS, CRS —, muss sie daher auf die Hüllboxmitte
umrechnen, sonst liegt das Modell um die halbe Ausdehnung daneben:

    Verortungspunkt (Quellkoordinaten) = quelloffset − modellversatz

`quelloffset` und `modellversatz` schreibt `tile_splat()` seit dieser Erweiterung in die
Extras der `tileset.json`.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

import numpy as np

from splatwerk import auftrag as A
from splatwerk import georef as G

logger = logging.getLogger(__name__)


def ankerpunkt(tileset: dict) -> tuple[np.ndarray, float]:
    """
    `(Verortungspunkt in Quellkoordinaten, Abstand Modell-Unterkante → Verortungspunkt)`.

    Wirft `ValueError`, wenn das Tileset kein Splat-Tileset ist (z. B. der Punktwolken-
    Fallback für PLYs ohne Kovarianz) oder von vor dieser Erweiterung stammt.
    """
    extras = ((tileset.get("root") or {}).get("extras") or {}).get("ileen_splat")
    if not extras or "quelloffset" not in extras:
        raise ValueError("Das Tileset trägt keinen Quelloffset (zu alt oder kein Splat) — "
                         "ein neu hochgeladenes Asset ist nötig.")
    versatz = np.array(extras["modellversatz"], dtype=np.float64)
    offset = np.array(extras["quelloffset"], dtype=np.float64)
    return offset - versatz, float(-versatz[2])


def _setze(job_id: str, felder: dict) -> dict:
    """Schreibt Platzierungsfelder in `placement.json` und `tileset.json` — wie `PUT …/placement`."""
    from datetime import datetime, timezone

    from api.routes.placement import _apply, load_placement
    from tiling import elevation

    platzierung = load_placement(job_id)
    platzierung.update(felder)
    platzierung["height_ellipsoid"] = elevation.to_ellipsoid(
        platzierung["height"], platzierung["height_reference"], platzierung["lon"], platzierung["lat"])
    platzierung["updated_at"] = datetime.now(timezone.utc).isoformat()
    _apply(job_id, platzierung)
    return platzierung


def unterkante_fuer(punkt, unterkante_huellbox: float, geo: dict) -> float:
    """
    Abstand vom Verortungspunkt zur Unterkante, auf der der Splat stehen soll — die Höhe, die
    der Verortungspunkt über dem Gelände bekommt.

    Die Hüllbox hängt an den Ausreißern des Trainings: Brush lässt Splats weit außerhalb des
    Gegenstands zurück (bei einem Buddha auf einer Kommode 18 m tiefer und 11 m höher), ihre Mitte
    liegt dann neben dem Gegenstand, unter seinem Boden sogar. Steht in `georef.json` eine
    Unterkante aus den sicheren Punkten der Rekonstruktion (`boden_z_enu`), gilt sie. Der Wert darf
    negativ sein: der Verortungspunkt steckt dann im Boden, der Splat steht trotzdem darauf.
    """
    boden = geo.get("boden_z_enu")
    if boden is not None and np.isfinite(float(boden)):
        return float(punkt[2]) - float(boden)
    return float(unterkante_huellbox)


def verorte_foto_splat(job_id: str, geo: dict) -> dict:
    """
    Verortet einen aus Fotos trainierten Splat. `geo` ist `georef.json` der Rekonstruktion.

    Mit GPS-Ursprung: Länge, Breite und Höhe des Verortungspunkts aus dem ENU-System der
    Rekonstruktion. Ohne: Position bleibt am Referenzpunkt der Installation, die Unterkante
    steht aufs Gelände — ein Modell, das zur Hälfte im Boden steckt, wäre das Gegenteil
    von „fertig“.
    """
    from storage.minio_client import get_json

    tileset = get_json("tiles", f"{job_id}/tileset.json")
    punkt, unterkante = ankerpunkt(tileset)
    felder = G.platzierung_aus_punkt(geo, punkt, unterkante_fuer(punkt, unterkante, geo))
    if not felder:
        felder = {"height": unterkante, "height_reference": "terrain"}
    logger.info(f"[{job_id}] Foto-Splat verortet: {felder}")
    return _setze(job_id, felder)


def verorte_scan_splat(job_id: str, crs, offset_xyz) -> dict:
    """
    Verortet einen aus einem Laserscan umgerechneten Splat.

    `offset_xyz` ist der Schwerpunktversatz von `scan2gs` (Weltkoordinate = lokal + Versatz),
    `crs` das CRS des LAS-Kopfes oder None. Mit CRS wie bei einer Punktwolke: Meridian-
    konvergenz als `heading`, Punktmaßstab als `scale`, Höhe in m ü. NHN.
    """
    from storage.minio_client import get_json
    from tiling.georef import placement_from_projected

    tileset = get_json("tiles", f"{job_id}/tileset.json")
    punkt, unterkante = ankerpunkt(tileset)
    if crs is None:
        felder = {"height": unterkante, "height_reference": "terrain"}
    else:
        welt = np.asarray(offset_xyz, dtype=np.float64) + punkt
        p = placement_from_projected(crs, float(welt[0]), float(welt[1]), float(welt[2]))
        felder = {k: p[k] for k in ("lon", "lat", "height", "height_reference", "heading", "scale")}
    return _setze(job_id, felder)


def uebernehme_training(auftrag_id: str) -> None:
    """
    Nimmt einen fertig trainierten Auftrag (`trainiert`) ins Backend auf: kacheln, verorten,
    benennen. Die Auftragskennung ist zugleich die Asset-Kennung (`job_id`) — dadurch
    braucht es keine Zuordnungstabelle.
    """
    import json

    from api.routes.upload import JOBS
    from storage.minio_client import get_minio, put_json
    from tiling.pipeline import run_tiling

    a = A.lese(auftrag_id)
    ordner = A.verzeichnis(auftrag_id)
    ply = ordner / "ergebnis.ply"
    if not ply.exists():
        raise FileNotFoundError("ergebnis.ply fehlt im Auftragsordner.")
    geo = json.loads((ordner / "georef.json").read_text())
    name = a["name"]
    dateiname = A.sauberer_name(name, "splat") + ".ply"

    A.schreibe(auftrag_id, status="uebernehme", stufe="uebernahme", anteil=1.0,
               meldung="Splat wird gekachelt (Octree, SPZ)…")
    get_minio().fput_object("uploads", f"{auftrag_id}/{dateiname}", str(ply), content_type="application/octet-stream")
    tiles_dir = None
    try:
        tiles_dir = run_tiling(ply, auftrag_id)
        A.schreibe(auftrag_id, meldung="Splat wird verortet…")
        platzierung = verorte_foto_splat(auftrag_id, geo)
        put_json("tiles", f"{auftrag_id}/meta.json", {"display_name": name})
    finally:
        if tiles_dir is not None:
            shutil.rmtree(tiles_dir, ignore_errors=True)

    JOBS[auftrag_id] = {"job_id": auftrag_id, "filename": dateiname, "status": "done",
                        "message": "Aus Fotos trainiert.", "tileset_url": f"/tiles/{auftrag_id}/tileset.json",
                        "updated_at": A.jetzt()}
    A.schreibe(auftrag_id, status="fertig", stufe="fertig", anteil=1.0,
               meldung="Fertig — der Splat steht im Viewer.",
               asset={"job_id": auftrag_id, "tileset_url": f"/tiles/{auftrag_id}/tileset.json"},
               platzierung={k: platzierung.get(k) for k in ("lon", "lat", "height", "height_reference")})
    A.aufraeumen_nach_fertig(auftrag_id)
