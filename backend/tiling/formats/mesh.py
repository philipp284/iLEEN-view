"""
Mesh → 3D Tiles (B3DM) via trimesh → GLB → B3DM-Wrapper.
Unterstützt: OBJ, STL, GLTF, GLB, PLY (als Mesh).
"""

import json
import logging
from pathlib import Path

import numpy as np

from tiling.b3dm import glb_to_b3dm
from tiling.georef import Z_UP_TO_Y_UP, build_tileset, make_tile, recenter, write_placement
from tiling.glb import mesh_to_glb

logger = logging.getLogger(__name__)


def tile_mesh(src: Path, out_dir: Path):
    """Konvertiert ein Mesh in ein minimales, georeferenziertes 3D-Tiles-Tileset."""
    import trimesh

    logger.info(f"Lade Mesh: {src.name}")
    mesh = trimesh.load(str(src), force="mesh")

    if mesh.vertices is None or len(mesh.vertices) == 0:
        raise RuntimeError(f"Keine Geometrie in '{src.name}' gefunden.")
    tile_mesh_objekt(mesh, out_dir, src.stem)


def tile_mesh_objekt(mesh, out_dir: Path, name: str) -> np.ndarray:
    """
    Ein schon geladenes trimesh-Mesh kacheln — gibt den Zentrierversatz zurück.

    Getrennt von `tile_mesh`, weil das Mesh aus einem Splat (`ileen/atlas_mesh.py`)
    nicht über eine Datei laufen soll (der Umweg über GLB verlöre nichts, kostete aber
    eine zweite Kodierung der Textur) und seinen Versatz braucht: es bekommt die
    Platzierung des Splats plus genau diesen Versatz als `base_transform`.
    """
    # Auf lokalen Ursprung zentrieren (noch im Z-up-System der Quelldaten)
    vertices, versatz = recenter(np.asarray(mesh.vertices, dtype=np.float64))
    mesh.vertices = vertices

    lo, hi = vertices.min(axis=0), vertices.max(axis=0)
    center = ((lo + hi) / 2.0).tolist()
    half = ((hi - lo) / 2.0).tolist()
    diagonal = float(np.linalg.norm(hi - lo))

    # Z-up → Y-up, damit Cesiums Rückrotation für B3DM-Inhalte aufgeht
    mesh.apply_transform(Z_UP_TO_Y_UP)

    (out_dir / "tile.b3dm").write_bytes(glb_to_b3dm(mesh_to_glb(mesh, name=name)))

    tileset = build_tileset(
        make_tile(center=center, half=half, geometric_error=0.0, content_uri="tile.b3dm"),
        geometric_error=max(diagonal, 1.0),
    )
    (out_dir / "tileset.json").write_text(json.dumps(tileset, indent=2))
    write_placement(out_dir)
    logger.info(
        f"Mesh-Tileset erstellt: {len(vertices)} Vertices, "
        f"{len(mesh.faces)} Faces → {out_dir}/tileset.json"
    )
    return versatz
