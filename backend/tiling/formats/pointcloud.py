"""
Punktwolken → 3D Tiles (PNTS) via py3dtiles.
Unterstützt: LAS, LAZ, XYZ, PTS, PLY (als Punktwolke).

py3dtiles erzeugt — anders als die Mesh-Handler — eine echte Tile-Hierarchie
mit mehreren LOD-Stufen, weshalb hier nicht selbst gekachelt wird.

Georeferenzierung: Getilet wird immer in den Koordinaten der Quelle; verortet
wird über die `placement.json`. Liegt ein CRS vor (LAS-Header oder
POINTCLOUD_CRS_IN), wird daraus der wahre Standort abgeleitet, sonst landet die
Wolke am konfigurierten Referenzpunkt.

py3dtiles legt den Tileset-Ursprung auf den Schwerpunkt der Daten und trägt den
Weg dorthin als `root.transform` ein. Genau diese Translation war die Ursache
dafür, dass Wolken in Landeskoordinaten im All schwebten und schief standen:
sie steht in Quellkoordinaten (bei UTM Millionen von Metern), und der
ENU-Transform davor gerechnet trägt sie als Ost-Nord-Oben-Versatz um die halbe
Erde. Sie gehört deshalb in die Platzierung, nicht vor sie.
"""

import json
import logging
import os
from pathlib import Path

import numpy as np

from tiling.georef import (
    apply_placement,
    default_placement,
    placement_from_projected,
    to_column_major,
    to_matrix,
    write_placement,
)

logger = logging.getLogger(__name__)

# Bis hierhin dürfen Quellkoordinaten vom Ursprung entfernt liegen, ohne dass es
# nach einer Projektion aussieht. Darüber sind es Landeskoordinaten ohne CRS im
# Header — dann ist der Offset keine Ortsangabe, die man verwenden könnte,
# sondern nur der Grund, warum die Wolke sonst im All läge.
_LOCAL_MAX_OFFSET_M = 1000.0


def tile_pointcloud(src: Path, out_dir: Path):
    """Konvertiert eine Punktwolke in ein 3D-Tiles-PNTS-Tileset."""
    suffix = src.suffix.lower()

    if suffix == ".e57":
        raise ValueError(
            "E57 wird serverseitig nicht unterstützt (pye57 bietet keine "
            "Linux-arm64-Wheels). Bitte vorher nach LAS/LAZ oder PLY "
            "konvertieren, z.B. mit CloudCompare."
        )

    if suffix == ".pts":
        src = _pts_to_xyz(src)

    if suffix not in {".las", ".laz", ".xyz", ".pts", ".ply"}:
        raise ValueError(f"Unbekanntes Punktwolken-Format: {suffix}")

    crs = _source_crs(src)

    try:
        _convert(src, out_dir)
    finally:
        if suffix == ".pts":
            src.unlink(missing_ok=True)

    _georeference(out_dir, crs)


def _pts_to_xyz(src: Path) -> Path:
    """
    PTS → XYZ. Das PTS-Format beginnt mit einer Zeile, die nur die Punktanzahl
    enthält; py3dtiles' XYZ-Reader würde daran scheitern.
    """
    dst = src.parent / (src.stem + "_conv.xyz")
    with src.open("r") as fin, dst.open("w") as fout:
        first = fin.readline()
        # Reine Zahl in Zeile 1 = Punktanzahl, sonst ist es bereits ein Datensatz
        if not first.strip().isdigit():
            fout.write(first)
        for line in fin:
            fout.write(line)
    logger.info(f"PTS nach XYZ konvertiert: {dst.name}")
    return dst


def _source_crs(src: Path):
    """
    Das CRS der Quelldatei als `pyproj.CRS`, oder `None`.

    Vorrang hat `POINTCLOUD_CRS_IN` — damit lässt sich eine Datei verorten,
    deren Header schweigt. Sonst wird der LAS/LAZ-Header gelesen: `laspy` wertet
    dort sowohl die GeoTIFF-Keys (LAS < 1.4) als auch den WKT-Eintrag aus.
    XYZ, PTS und PLY tragen kein CRS.

    Nur der waagerechte Anteil wird übernommen. Ein Compound-CRS mit Höhenbezug
    (etwa „UTM 32N + DHHN2016") würde pyproj zu einer Datumsumrechnung mit
    Geoidgitter verleiten, die im Container nicht vorliegt; die Höhe läuft
    stattdessen über `elevation`, wo die Undulation als Konstante gepflegt ist.
    """
    from pyproj import CRS

    forced = os.getenv("POINTCLOUD_CRS_IN") or None
    if forced:
        logger.info(f"CRS aus POINTCLOUD_CRS_IN: {forced}")
        return CRS.from_user_input(forced)

    if src.suffix.lower() not in {".las", ".laz"}:
        return None

    try:
        import laspy

        with laspy.open(str(src)) as f:
            crs = f.header.parse_crs()
    except Exception as e:
        logger.warning(f"CRS aus dem LAS-Header nicht lesbar: {e}")
        return None

    if crs is None:
        logger.info("LAS-Header ohne CRS — Wolke gilt als lokal koordiniert.")
        return None

    horizontal = crs.sub_crs_list[0] if crs.is_compound else crs
    if not horizontal.is_projected:
        # Geografische Koordinaten (Grad) kommen bei Scans praktisch nicht vor
        # und würden als Meter getilet — dann lieber gar nicht verorten.
        logger.warning(f"CRS {horizontal.to_string()} ist nicht projiziert — ignoriert.")
        return None

    logger.info(f"CRS aus dem LAS-Header: {horizontal.to_string()}")
    return horizontal


def _convert(src: Path, out_dir: Path):
    """
    Ruft py3dtiles auf. Das Zielverzeichnis muss leer bzw. überschreibbar sein.

    Bewusst ohne `crs_out`: py3dtiles würde sonst jeden Punkt nach ECEF rechnen
    und das Tileset damit starr verorten. Die Verortung übernimmt `_georeference`
    über die Platzierung, die sich später noch korrigieren lässt.
    """
    from py3dtiles.convert import convert

    convert(
        files=[str(src)],
        outfolder=str(out_dir),
        overwrite=True,
        jobs=max(1, min(4, os.cpu_count() or 1)),
    )


def _georeference(out_dir: Path, crs):
    """
    Verortet das frisch getilete Tileset: die Schwerpunkt-Translation von
    py3dtiles wird zur Platzierung, der Rest der Matrix bleibt `base_transform`.
    """
    tileset_path = out_dir / "tileset.json"
    if not tileset_path.exists():
        logger.warning("py3dtiles hat keine tileset.json erzeugt.")
        return

    tileset = json.loads(tileset_path.read_text())
    root = tileset.setdefault("root", {})

    origin, rest = _split_origin(root.get("transform"))

    if crs is not None:
        placement = placement_from_projected(crs, *origin)
    else:
        placement = None  # Referenzpunkt aus der Umgebung
        if max(abs(origin[0]), abs(origin[1])) > _LOCAL_MAX_OFFSET_M:
            logger.warning(
                f"Quellkoordinaten liegen {origin[0]:.0f}/{origin[1]:.0f} vom Ursprung "
                "entfernt, aber ohne CRS im Header — der Versatz wird verworfen und die "
                "Wolke am Referenzpunkt zentriert. Mit POINTCLOUD_CRS_IN verorten."
            )
        elif any(abs(v) > 1e-9 for v in origin):
            # Echte lokale Koordinaten: der kleine Versatz beschreibt die Lage
            # innerhalb des Projekts und muss erhalten bleiben, sonst rücken
            # mehrere Dateien desselben Aufmaßes übereinander.
            rest = _translation(origin) @ rest

    if placement is None:
        placement = default_placement()
    placement["base_transform"] = None if _is_identity(rest) else to_column_major(rest)

    tileset_path.write_text(json.dumps(apply_placement(tileset, placement), indent=2))
    write_placement(out_dir, placement=placement)


def _split_origin(transform: list[float] | None):
    """
    Zerlegt `root.transform` in seine Translation und den Rest.

    py3dtiles schreibt dort eine reine Verschiebung auf den Datenschwerpunkt;
    der Rest ist dann die Einheitsmatrix. Trotzdem wird er mitgeführt, damit
    eine künftige py3dtiles-Version mit Rotation oder Maßstab nichts verliert.
    """
    if not transform:
        return (0.0, 0.0, 0.0), np.eye(4)

    matrix = to_matrix(transform)
    origin = tuple(float(v) for v in matrix[:3, 3])
    rest = matrix.copy()
    rest[:3, 3] = 0.0
    return origin, rest


def _translation(origin) -> np.ndarray:
    matrix = np.eye(4)
    matrix[:3, 3] = origin
    return matrix


def _is_identity(matrix: np.ndarray) -> bool:
    return bool(np.allclose(matrix, np.eye(4), atol=1e-12))
