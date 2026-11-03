"""
Lokale Geländereferenz: Höhenraster aus einem im Backend hochgeladenen Asset.

Der Copernicus-DEM-Aufruf in `elevation.py` liefert nur eine Näherung (90 m
Rasterweite, Oberflächenmodell statt echtem Boden — siehe CLAUDE.md). Wer ein
eigenes Geländemodell hat (IFC, Mesh oder Punktwolke), kann es wie jedes
andere Modell hochladen, im Asset-Manager exakt verorten und dann per
`set_reference()` als Geländereferenz markieren. Ab da liefert `sample_ellipsoid()`
für "über Gelände"-Platzierungen die Höhe aus diesem Modell statt aus dem DEM —
und weil beide Wege in `elevation.ground_ellipsoid()` zusammenlaufen, bleibt der
externe Dienst als Fallback außerhalb der Abdeckung dieses Rasters bestehen.

Ablauf beim Markieren (`build_height_grid()`):

    Quelldatei (uploads-Bucket) → Geometrie laden (IfcOpenShell/trimesh/laspy)
        → `georef.recenter()` (dieselbe Konvention wie beim Tiling)
        → `georef.placement_transform()` der aktuellen Platzierung → ECEF
        → `georef.ecef_to_geodetic()` → (lon, lat, Höhe über Ellipsoid)
        → in ein lon/lat-Raster gebinnt (Mittelwert je Zelle)

Für Mesh- und IFC-Quellen ist das exakt: beide haben `base_transform=None`
(siehe `tiling/formats/mesh.py`, `tiling/formats/ifc.py`), die Weltposition
eines Vertex ist also schlicht `placement_transform() @ recenter(vertex)`.
Für Punktwolken gilt dieselbe Rechnung: py3dtiles legt den Ursprung auf den
Datenschwerpunkt statt auf die Grundflächenmitte, aber dieser Ursprung *ist*
der Referenzpunkt der Platzierung — bei einer Wolke mit CRS steht dann kein
`base_transform` mehr dazwischen. Ein `adjustable: false` weist dieses Modul
weiterhin ab; es bliebe für Daten, die schon in ECEF vorliegen und deren
Weltposition sich hier nicht nachrechnen lässt.

Rasterauflösung ist in Metern (`TERRAIN_GRID_RESOLUTION_M`), umgerechnet in
Grad — für die kleinen, lokalen Ausdehnungen eines Geländemodells (typisch
< 1 km) ist die Krümmungsabweichung dabei ohne Belang.
"""

import io
import logging
import math
import os
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from minio.error import S3Error

from storage.minio_client import delete_prefix, get_bytes, get_json, get_minio, put_bytes, put_json
from tiling import georef

logger = logging.getLogger(__name__)

_TILES_BUCKET = "tiles"
_UPLOADS_BUCKET = "uploads"
_REF_KEY = "_terrain/reference.json"
_GRID_META_KEY = "_terrain/grid_meta.json"
_GRID_DATA_KEY = "_terrain/grid_heights.npy"

# Obergrenze an Punkten, die eingelesen werden — größere Mengen werden zufällig
# ausgedünnt. 4 Mio. Punkte sind für ein Raster im Meterbereich reichlich, auch
# für Geländemodelle über mehrere hundert Meter Kantenlänge.
_MAX_POINTS = int(os.getenv("TERRAIN_GRID_MAX_POINTS", "4000000"))

# Zellgröße in Metern. 2 m ist ein vernünftiger Standard für Campus-Maßstab —
# feiner bringt für die Platzierung anderer Modelle keinen Zusatznutzen, gröber
# verschluckt Böschungen und Stufen.
_DEFAULT_RESOLUTION_M = float(os.getenv("TERRAIN_GRID_RESOLUTION_M", "2.0"))

# Deckelt Speicher- und Rechenaufwand, falls jemand versehentlich ein sehr
# großflächiges Modell markiert; die Auflösung weicht dann automatisch gröber
# aus, statt Fläche wegzuschneiden.
_MAX_GRID_DIM = 2000

_MESH_SUFFIXES = {".obj", ".stl", ".gltf", ".glb"}
_POINTCLOUD_SUFFIXES = {".las", ".laz", ".xyz", ".pts", ".ply"}

_METERS_PER_DEGREE = 111_320.0

# In-Prozess-Cache: das Raster ändert sich nur, wenn jemand die Geländereferenz
# neu setzt — ein Re-Check des Zeigers alle paar Sekunden reicht, ein Vollabruf
# bei jeder Höhenabfrage wäre unnötiges MinIO-Hin-und-Her.
_CACHE_TTL_S = 30.0
_cache: dict | None = None
_cache_checked_at = 0.0


# ── Referenz setzen ───────────────────────────────────────────────────────────


def build_height_grid(job_id: str, resolution_m: float | None = None) -> dict:
    """
    Baut das Höhenraster aus dem Job und macht ihn zur aktiven Geländereferenz.

    Läuft synchron (blockierend) — der Aufrufer sollte das über
    `asyncio.to_thread()` von der Event-Loop fernhalten, siehe `api/routes/geo.py`.
    """
    placement = _load_placement(job_id)
    if not placement.get("adjustable", True):
        raise ValueError(
            "Dieses Asset ist über sein eigenes CRS georeferenziert (ECEF) und "
            "kann nicht als Geländereferenz dienen — bitte ein Modell markieren, "
            "das im Asset-Manager per Länge/Breite/Höhe verortet ist."
        )

    src_path, filename = _download_source(job_id)
    try:
        points = _extract_points(src_path)
    finally:
        shutil.rmtree(src_path.parent, ignore_errors=True)

    points = _subsample(points, _MAX_POINTS)
    local, _ = georef.recenter(points)

    matrix = georef.to_matrix(georef.placement_transform(placement))
    homogeneous = np.column_stack([local, np.ones(len(local))])
    ecef = (matrix @ homogeneous.T).T[:, :3]
    geodetic = georef.ecef_to_geodetic(ecef)

    meta, heights = _rasterize(geodetic, resolution_m or _DEFAULT_RESOLUTION_M)
    updated_at = datetime.now(timezone.utc).isoformat()
    meta.update(
        {
            "job_id": job_id,
            "source_filename": filename,
            "point_count": int(len(points)),
            "updated_at": updated_at,
        }
    )

    buffer = io.BytesIO()
    np.save(buffer, heights.astype(np.float32))
    put_bytes(_TILES_BUCKET, _GRID_DATA_KEY, buffer.getvalue())
    put_json(_TILES_BUCKET, _GRID_META_KEY, meta)
    put_json(_TILES_BUCKET, _REF_KEY, {"job_id": job_id, "updated_at": updated_at})

    _invalidate_cache()
    logger.info(
        f"[{job_id}] Geländereferenz aufgebaut: {meta['rows']}x{meta['cols']} Zellen "
        f"à {meta['resolution_m']:.1f} m, {meta['filled_cells']} gefüllt, "
        f"aus {meta['point_count']} Punkten."
    )
    return meta


def clear_reference():
    """Entfernt die Geländereferenz — `ground_ellipsoid()` fällt wieder auf das DEM zurück."""
    delete_prefix(_TILES_BUCKET, "_terrain/")
    _invalidate_cache()


def reference_info() -> dict | None:
    """Metadaten der aktiven Geländereferenz, `None` wenn keine gesetzt ist."""
    grid = _load_grid()
    return dict(grid["meta"]) if grid else None


# ── Höhenabfrage ──────────────────────────────────────────────────────────────


def sample_ellipsoid(lon: float, lat: float) -> float | None:
    """
    Ellipsoidische Geländehöhe aus dem lokalen Raster, `None` ohne Referenz
    oder außerhalb ihrer Abdeckung — dann übernimmt `elevation.py` das DEM.

    Nächste-Zelle statt bilinear: bei 1–2 m Zellgröße liegt der Unterschied
    unter dem, was die Platzierung ohnehin nur auf Meter genau eingibt, und
    NaN-Nachbarn (Lücken im Raster) müssten sonst gesondert behandelt werden.
    """
    grid = _load_grid()
    if grid is None:
        return None
    meta, heights = grid["meta"], grid["heights"]
    col = int(round((lon - meta["lon_min"]) / meta["lon_step"]))
    row = int(round((lat - meta["lat_min"]) / meta["lat_step"]))
    if not (0 <= row < meta["rows"] and 0 <= col < meta["cols"]):
        return None
    value = heights[row, col]
    return None if np.isnan(value) else float(value)


def _load_grid() -> dict | None:
    global _cache, _cache_checked_at
    now = time.monotonic()
    if _cache is not None and (now - _cache_checked_at) < _CACHE_TTL_S:
        return _cache
    _cache_checked_at = now

    try:
        pointer = get_json(_TILES_BUCKET, _REF_KEY)
    except S3Error:
        _cache = None
        return None

    if _cache is not None and _cache["pointer"].get("updated_at") == pointer.get("updated_at"):
        return _cache

    try:
        meta = get_json(_TILES_BUCKET, _GRID_META_KEY)
        heights = np.load(io.BytesIO(get_bytes(_TILES_BUCKET, _GRID_DATA_KEY)))
    except S3Error:
        logger.warning("Geländereferenz gesetzt, aber Rasterdaten fehlen — ignoriere sie.")
        _cache = None
        return None

    _cache = {"pointer": pointer, "meta": meta, "heights": heights}
    return _cache


def _invalidate_cache():
    global _cache, _cache_checked_at
    _cache = None
    _cache_checked_at = 0.0


# ── Platzierung & Quelldatei ──────────────────────────────────────────────────


def _load_placement(job_id: str) -> dict:
    try:
        return get_json(_TILES_BUCKET, f"{job_id}/{georef.PLACEMENT_FILE}")
    except S3Error:
        raise ValueError(
            f"Job '{job_id}' hat noch keine gespeicherte Position — einmal im "
            "Asset-Manager auswählen und 'Speichern' klicken, dann erneut versuchen."
        )


def _download_source(job_id: str) -> tuple[Path, str]:
    minio = get_minio()
    object_name = filename = None
    for obj in minio.list_objects(_UPLOADS_BUCKET, prefix=f"{job_id}/", recursive=True):
        object_name = obj.object_name
        filename = object_name.rsplit("/", 1)[-1]
        break
    if object_name is None:
        raise ValueError(f"Keine Quelldatei für Job '{job_id}' im uploads-Bucket gefunden.")

    tmp_dir = Path(tempfile.mkdtemp(prefix="terrain_"))
    dst = tmp_dir / filename
    minio.fget_object(_UPLOADS_BUCKET, object_name, str(dst))
    return dst, filename


# ── Geometrie-Extraktion ──────────────────────────────────────────────────────


def _extract_points(path: Path) -> np.ndarray:
    suffix = path.suffix.lower()
    if suffix == ".ifc":
        return _extract_ifc_points(path)
    if suffix in _MESH_SUFFIXES:
        return _extract_mesh_points(path)
    if suffix in _POINTCLOUD_SUFFIXES:
        return _extract_pointcloud_points(path)
    raise ValueError(f"Format '{suffix}' eignet sich nicht als Geländereferenz.")


def _extract_ifc_points(path: Path) -> np.ndarray:
    import ifcopenshell
    import ifcopenshell.geom

    from tiling.formats.ifc import _excluded_types

    ifc_file = ifcopenshell.open(str(path))
    settings = ifcopenshell.geom.settings()
    try:
        settings.set("use-world-coords", True)
    except Exception:
        settings.set(settings.USE_WORLD_COORDS, True)

    jobs = max(1, min(4, os.cpu_count() or 1))
    iterator = ifcopenshell.geom.iterator(
        settings, ifc_file, jobs, exclude=_excluded_types(ifc_file) or None
    )

    chunks: list[np.ndarray] = []
    if iterator.initialize():
        while True:
            verts = np.frombuffer(
                iterator.get().geometry.verts_buffer, dtype=np.float64
            ).reshape(-1, 3)
            if len(verts):
                chunks.append(verts)
            if not iterator.next():
                break

    if not chunks:
        raise ValueError(f"Keine Geometrie in '{path.name}' gefunden.")
    return np.concatenate(chunks, axis=0)


def _extract_mesh_points(path: Path) -> np.ndarray:
    import trimesh

    mesh = trimesh.load(str(path), force="mesh")
    if mesh.vertices is None or len(mesh.vertices) == 0:
        raise ValueError(f"Keine Geometrie in '{path.name}' gefunden.")
    return np.asarray(mesh.vertices, dtype=np.float64)


def _extract_pointcloud_points(path: Path) -> np.ndarray:
    suffix = path.suffix.lower()

    if suffix in (".las", ".laz"):
        import laspy

        with laspy.open(str(path)) as reader:
            las = reader.read()
        return np.column_stack([las.x, las.y, las.z]).astype(np.float64)

    if suffix in (".xyz", ".pts"):
        rows: list[list[float]] = []
        with path.open("r") as f:
            first = f.readline()
            # PTS beginnt mit einer Zeile, die nur die Punktanzahl enthält
            # (dieselbe Eigenheit wie in tiling/formats/pointcloud.py).
            if not first.strip().isdigit():
                _append_xyz_row(rows, first)
            for line in f:
                _append_xyz_row(rows, line)
        if not rows:
            raise ValueError(f"Keine Punkte in '{path.name}' gefunden.")
        return np.array(rows, dtype=np.float64)

    if suffix == ".ply":
        from plyfile import PlyData

        vertex = PlyData.read(str(path))["vertex"]
        return np.column_stack(
            [vertex["x"], vertex["y"], vertex["z"]]
        ).astype(np.float64)

    raise ValueError(f"Unbekanntes Punktwolkenformat: {suffix}")


def _append_xyz_row(rows: list, line: str):
    parts = line.split()
    if len(parts) < 3:
        return
    try:
        rows.append([float(parts[0]), float(parts[1]), float(parts[2])])
    except ValueError:
        pass  # Kommentar- oder Kopfzeile — überspringen statt abzubrechen


def _subsample(points: np.ndarray, max_points: int) -> np.ndarray:
    if len(points) <= max_points:
        return points
    rng = np.random.default_rng(0)
    idx = rng.choice(len(points), size=max_points, replace=False)
    logger.info(f"Geländepunkte ausgedünnt: {len(points)} → {max_points}.")
    return points[idx]


# ── Rasterisierung ────────────────────────────────────────────────────────────


def _rasterize(geodetic: np.ndarray, resolution_m: float) -> tuple[dict, np.ndarray]:
    """Mittelt Höhen je Gitterzelle in Lon/Lat-Grad, umgerechnet aus Metern."""
    lon, lat, height = geodetic[:, 0], geodetic[:, 1], geodetic[:, 2]
    lon_min, lon_max = float(lon.min()), float(lon.max())
    lat_min, lat_max = float(lat.min()), float(lat.max())
    mean_lat = float(lat.mean())

    lat_step = resolution_m / _METERS_PER_DEGREE
    lon_step = resolution_m / (_METERS_PER_DEGREE * max(math.cos(math.radians(mean_lat)), 1e-6))

    rows = min(_MAX_GRID_DIM, int(math.ceil((lat_max - lat_min) / lat_step)) + 1)
    cols = min(_MAX_GRID_DIM, int(math.ceil((lon_max - lon_min) / lon_step)) + 1)
    rows, cols = max(rows, 1), max(cols, 1)

    # Deckelung greift nur bei unüblich großer Ausdehnung — dann lieber gröber
    # rastern, als Randflächen des Modells stillschweigend zu verlieren.
    if rows >= _MAX_GRID_DIM:
        lat_step = (lat_max - lat_min) / max(rows - 1, 1)
    if cols >= _MAX_GRID_DIM:
        lon_step = (lon_max - lon_min) / max(cols - 1, 1)

    row_idx = np.clip(((lat - lat_min) / lat_step).astype(np.int64), 0, rows - 1)
    col_idx = np.clip(((lon - lon_min) / lon_step).astype(np.int64), 0, cols - 1)
    flat_idx = row_idx * cols + col_idx

    sums = np.bincount(flat_idx, weights=height, minlength=rows * cols)
    counts = np.bincount(flat_idx, minlength=rows * cols)
    filled = counts > 0

    heights = np.full(rows * cols, np.nan, dtype=np.float64)
    heights[filled] = sums[filled] / counts[filled]
    heights = heights.reshape(rows, cols)

    meta = {
        "lon_min": lon_min,
        "lat_min": lat_min,
        "lon_step": lon_step,
        "lat_step": lat_step,
        "rows": rows,
        "cols": cols,
        "resolution_m": resolution_m,
        "filled_cells": int(filled.sum()),
    }
    return meta, heights
