"""
Tiling-Pipeline: Einheitlicher Einstiegspunkt für alle Formate.
Ergebnis: 3D Tiles (tileset.json + *.b3dm / *.pnts) → MinIO tiles-Bucket.
"""

import logging
import tempfile
from pathlib import Path

from tiling.formats.ifc import tile_ifc
from tiling.formats.pointcloud import tile_pointcloud
from tiling.formats.mesh import tile_mesh
from tiling.formats.splat import tile_splat
from storage.minio_client import upload_directory

logger = logging.getLogger(__name__)


def _read_ply_header(src: Path) -> bytes:
    """Liest den PLY-Header bis 'end_header'. 3DGS-Header werden durch die
    45 SH-Rest-Properties leicht 2-3 KB groß, daher großzügig lesen."""
    with src.open("rb") as f:
        head = f.read(16384)
    end = head.find(b"end_header")
    return head[:end] if end != -1 else head


def _detect_ply(src: Path, out_dir: Path):
    """Erkennt ob PLY eine Punktwolke oder ein 3DGS-Splat ist.
    Entscheidend sind die 3DGS-Property-Namen im Header, nicht der Dateiname."""
    header = _read_ply_header(src)
    is_splat = any(
        marker in header
        for marker in (b"f_dc_0", b"sh_0_r", b"scale_0", b"rot_0")
    )
    if is_splat:
        logger.info(f"PLY erkannt als 3DGS-Splat: {src.name}")
        tile_splat(src, out_dir)
    else:
        logger.info(f"PLY erkannt als Punktwolke: {src.name}")
        tile_pointcloud(src, out_dir)


# Format → Handler-Funktion
HANDLERS = {
    ".ifc":  tile_ifc,
    ".las":  tile_pointcloud,
    ".laz":  tile_pointcloud,
    ".e57":  tile_pointcloud,
    ".xyz":  tile_pointcloud,
    ".pts":  tile_pointcloud,
    ".ply":  _detect_ply,
    ".obj":  tile_mesh,
    ".stl":  tile_mesh,
    ".gltf": tile_mesh,
    ".glb":  tile_mesh,
}


def run_tiling(src: Path, job_id: str, material_overrides: dict | None = None) -> Path:
    """
    Verarbeitet eine Quelldatei zu 3D Tiles und lädt das Ergebnis in MinIO hoch.

    Gibt das lokale Ausgabeverzeichnis zurück. Es existiert bis zum Aufräumen
    des Jobs weiter — die semantische Indexierung liest daraus die
    `properties.sqlite`, statt die IFC-Datei ein zweites Mal zu parsen.
    Aufräumen ist Sache der Aufrufer (`upload.py`, `materials.py`).

    `material_overrides` stammt aus dem Textur-Zuordnungsassistenten und gilt
    nur für IFC — die anderen Formate bringen ihre Materialien selbst mit.

    `out_dir` liegt bewusst NICHT unter `src.parent`: die Quelldatei lebt im
    bind-gemounteten Upload-Verzeichnis (`/tmp/uploads`, unter Docker Desktop
    auf Windows über den WSL2/9P-Übersetzer an den Windows-Host gebunden).
    Ein Octree-Tiling schreibt dort hunderte bis tausende kleiner Tile-Dateien
    — genau das Zugriffsmuster, unter dem diese Übersetzungsschicht am
    stärksten einbricht (jede Datei ein Cross-Boundary-Syscall plus ggf.
    Virenscanner). Die Tiles werden ohnehin nur kurz lokal gehalten und direkt
    nach MinIO hochgeladen, dann wieder gelöscht — sie müssen nie auf dem
    Windows-Host sichtbar sein. `tempfile.mkdtemp()` legt sie stattdessen im
    nativen Container-Dateisystem an, genau wie schon die IFC-Auslagerungsdatei
    (`tile_ifc()`) und `_retile_job()` in `materials.py` es für ihr Arbeits-
    verzeichnis tun.
    """
    suffix = src.suffix.lower()
    handler = HANDLERS.get(suffix)
    if handler is None:
        raise ValueError(f"Kein Tiling-Handler für '{suffix}'")

    out_dir = Path(tempfile.mkdtemp(prefix=f"tiles_{job_id[:8]}_"))

    logger.info(f"[{job_id}] Starte Tiling: {src.name} → {suffix}")
    if suffix == ".ifc" and material_overrides:
        handler(src, out_dir, material_overrides=material_overrides)
    else:
        handler(src, out_dir)
    logger.info(f"[{job_id}] Tiling abgeschlossen → {out_dir}")

    # Upload aller Tile-Dateien nach MinIO
    upload_directory(out_dir, bucket="tiles", prefix=job_id)
    logger.info(f"[{job_id}] Upload in MinIO tiles/{job_id}/ abgeschlossen")

    return out_dir
