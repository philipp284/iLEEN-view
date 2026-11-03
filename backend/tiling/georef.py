"""
Georeferenzierung für 3D Tiles.

Zwei Probleme, die jedes Tileset betreffen, das aus lokal koordinierten
CAD/BIM-Daten entsteht:

1. **Verortung.** 3D-Tiles-Koordinaten sind ECEF (erdzentriert). Ein IFC- oder
   OBJ-Modell mit Koordinaten um (0,0,0) läge damit im Erdmittelpunkt. Die
   `root.transform`-Matrix bildet das lokale ENU-System (East-North-Up) auf
   ECEF ab — identisch zu `Cesium.Transforms.eastNorthUpToFixedFrame()`.

2. **Hochachse.** glTF ist per Spezifikation Y-up, 3D Tiles ist Z-up. CesiumJS
   rotiert glTF-Inhalte in B3DM deshalb automatisch Y-up→Z-up. CAD/BIM-Daten
   sind aber bereits Z-up, würden also auf der Seite liegen. `Z_UP_TO_Y_UP`
   nimmt diese Rotation vorweg, sodass Cesiums Rückrotation sie exakt aufhebt.

Beim Tiling schreibt jeder Handler zusätzlich eine `placement.json` neben die
`tileset.json`. Sie hält fest, mit welchem Referenzpunkt verortet wurde und
welcher Rest-Transform vom Handler selbst stammt (`base_transform`) — nur so
lässt sich die Position später über die API verschieben, ohne neu zu tilen.

Die Höhe darf dabei über Gelände oder über NHN angegeben werden; `elevation.py`
löst das in die ellipsoidische Höhe auf, die der Transform braucht.
"""

import json
import logging
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from tiling import elevation

logger = logging.getLogger(__name__)

PLACEMENT_FILE = "placement.json"

# WGS84-Ellipsoid
_WGS84_A = 6378137.0
_WGS84_F = 1.0 / 298.257223563
_WGS84_E2 = 2.0 * _WGS84_F - _WGS84_F * _WGS84_F

# Default-Referenzpunkt: Hochschule Mainz, Campus Holzstraße.
# Über TILESET_ORIGIN_LON/LAT/HEIGHT überschreibbar.
_DEFAULT_LON = 8.2599
_DEFAULT_LAT = 49.9929
_DEFAULT_HEIGHT = 90.0

# Z-up (CAD/BIM) → Y-up (glTF): Rotation um -90° um die X-Achse, (x,y,z) → (x,z,-y).
# CesiumJS wendet auf B3DM-Inhalte die Gegenrotation an, Netto ergibt das die Identität.
Z_UP_TO_Y_UP = np.array(
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, -1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ],
    dtype=np.float64,
)


def origin_from_env() -> tuple[float, float, float]:
    """
    Referenzpunkt (lon, lat, height) aus der Umgebung. Die Höhe ist in dem
    Bezug gemeint, den `TILESET_ORIGIN_HEIGHT_REFERENCE` angibt.
    """
    return (
        float(os.getenv("TILESET_ORIGIN_LON", _DEFAULT_LON)),
        float(os.getenv("TILESET_ORIGIN_LAT", _DEFAULT_LAT)),
        float(os.getenv("TILESET_ORIGIN_HEIGHT", _DEFAULT_HEIGHT)),
    )


def geodetic_to_ecef(lon: float, lat: float, height: float) -> tuple[float, float, float]:
    """WGS84 geodätisch (Grad) → ECEF-Meter."""
    lon_r, lat_r = math.radians(lon), math.radians(lat)
    sin_lat, cos_lat = math.sin(lat_r), math.cos(lat_r)
    n = _WGS84_A / math.sqrt(1.0 - _WGS84_E2 * sin_lat * sin_lat)
    return (
        (n + height) * cos_lat * math.cos(lon_r),
        (n + height) * cos_lat * math.sin(lon_r),
        (n * (1.0 - _WGS84_E2) + height) * sin_lat,
    )


def ecef_to_geodetic(points: np.ndarray) -> np.ndarray:
    """
    ECEF-Meter → WGS84 geodätisch, vektorisiert für ein (N,3)-Array.

    Gibt ein (N,3)-Array [lon°, lat°, height_ellipsoid] zurück. Iterativ statt
    geschlossen (Bowring/Vermeille): fünf Schritte konvergieren für Punkte nahe
    der Erdoberfläche auf Millimeter, und die Formel bleibt lesbar. Wird nur
    beim Aufbau des lokalen Geländerasters gebraucht (`tiling/terrain.py`),
    nicht auf dem heißen Pfad.
    """
    x, y, z = points[:, 0], points[:, 1], points[:, 2]
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)

    lat = np.arctan2(z, p * (1.0 - _WGS84_E2))
    for _ in range(5):
        sin_lat = np.sin(lat)
        n = _WGS84_A / np.sqrt(1.0 - _WGS84_E2 * sin_lat * sin_lat)
        height = p / np.cos(lat) - n
        lat = np.arctan2(z, p * (1.0 - _WGS84_E2 * n / (n + height)))

    sin_lat = np.sin(lat)
    n = _WGS84_A / np.sqrt(1.0 - _WGS84_E2 * sin_lat * sin_lat)
    height = p / np.cos(lat) - n
    return np.column_stack([np.degrees(lon), np.degrees(lat), height])


def enu_transform(lon: float, lat: float, height: float) -> list[float]:
    """
    4x4 ENU→ECEF-Matrix als column-major Liste — das Format, das
    `root.transform` im tileset.json erwartet.
    """
    lon_r, lat_r = math.radians(lon), math.radians(lat)
    sin_lon, cos_lon = math.sin(lon_r), math.cos(lon_r)
    sin_lat, cos_lat = math.sin(lat_r), math.cos(lat_r)

    east = (-sin_lon, cos_lon, 0.0)
    north = (-sin_lat * cos_lon, -sin_lat * sin_lon, cos_lat)
    up = (cos_lat * cos_lon, cos_lat * sin_lon, sin_lat)
    ox, oy, oz = geodetic_to_ecef(lon, lat, height)

    # column-major: Spalten sind East, North, Up, Translation
    return [
        east[0], east[1], east[2], 0.0,
        north[0], north[1], north[2], 0.0,
        up[0], up[1], up[2], 0.0,
        ox, oy, oz, 1.0,
    ]


def default_transform() -> list[float]:
    """
    ENU→ECEF-Matrix für den konfigurierten Referenzpunkt.

    Die Höhe wird über `elevation` aufgelöst, damit `tileset.json` und
    `placement.json` denselben Bezug haben — sonst läge das frisch getilete
    Modell bis zum ersten Verorten auf der falschen Höhe.
    """
    lon, lat, height = origin_from_env()
    resolved = elevation.to_ellipsoid(height, elevation.default_reference(), lon, lat)
    return enu_transform(lon, lat, resolved)


def to_matrix(column_major: list[float]) -> np.ndarray:
    """column-major 16er-Liste (Format von `root.transform`) → 4x4-Matrix."""
    return np.array(column_major, dtype=np.float64).reshape(4, 4).T


def to_column_major(matrix: np.ndarray) -> list[float]:
    """4x4-Matrix → column-major 16er-Liste."""
    return matrix.T.reshape(16).tolist()


def orientation_matrix(
    heading: float = 0.0, pitch: float = 0.0, roll: float = 0.0, scale: float = 1.0
) -> np.ndarray:
    """
    Rotation und Skalierung im lokalen ENU-System (X=Ost, Y=Nord, Z=Oben).

    * `heading` — Drehung um die Hochachse im Uhrzeigersinn (Kompasssinn):
      bei 90° zeigt die vormalige Nordseite des Modells nach Osten.
    * `pitch`   — Kippen um die Ost-Achse, positiv hebt die Nordseite an.
    * `roll`    — Kippen um die Nord-Achse, positiv senkt die Ostseite.

    Alle Winkel in Grad, angewandt in der Reihenfolge Heading · Pitch · Roll.
    Gedreht wird um den lokalen Ursprung — für Mesh-Modelle also um die
    XY-Mitte der Grundfläche, weil `recenter()` sie dorthin gelegt hat.
    """
    h, p, r = (math.radians(a) for a in (heading, pitch, roll))

    rz = np.array(
        [[math.cos(h), math.sin(h), 0.0], [-math.sin(h), math.cos(h), 0.0], [0.0, 0.0, 1.0]]
    )
    rx = np.array(
        [[1.0, 0.0, 0.0], [0.0, math.cos(p), -math.sin(p)], [0.0, math.sin(p), math.cos(p)]]
    )
    ry = np.array(
        [[math.cos(r), 0.0, math.sin(r)], [0.0, 1.0, 0.0], [-math.sin(r), 0.0, math.cos(r)]]
    )

    matrix = np.eye(4)
    matrix[:3, :3] = (rz @ rx @ ry) * scale
    return matrix


def placement_matrix(
    lon: float,
    lat: float,
    height: float,
    heading: float = 0.0,
    pitch: float = 0.0,
    roll: float = 0.0,
    scale: float = 1.0,
) -> np.ndarray:
    """Vollständige Platzierung: ENU am Referenzpunkt, darin Drehung + Maßstab."""
    return to_matrix(enu_transform(lon, lat, height)) @ orientation_matrix(
        heading, pitch, roll, scale
    )


def recenter(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Zentriert Koordinaten auf den lokalen Ursprung: XY auf die Mitte der
    Bounding Box, Z auf deren Unterkante (Modell steht auf dem Boden).

    Nötig, weil BIM-Modelle oft in Landeskoordinaten liegen (z.B. UTM mit
    Rechtswerten um 3.4 Mio) — ohne Zentrierung läge das Modell hunderte
    Kilometer vom Referenzpunkt entfernt und float32 verlöre jede Präzision.

    Gibt die zentrierten Punkte und den abgezogenen Offset zurück.
    """
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    offset = np.array([(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, lo[2]])
    if np.linalg.norm(offset) > 1.0:
        logger.info(f"Modell zentriert, Offset abgezogen: {offset.tolist()}")
    return points - offset, offset


def resolve_height(placement: dict) -> float:
    """
    Ellipsoidische Höhe einer Platzierung — der einzige Wert, den der Transform
    verwenden darf.

    Der eingegebene Wert kann über Gelände oder über NHN gemeint sein; das
    Ergebnis wird in `height_ellipsoid` mitgeschrieben, damit die Matrix später
    ohne DEM-Abfrage exakt reproduzierbar bleibt.
    """
    reference = placement.get("height_reference", elevation.ELLIPSOID)
    if reference == elevation.ELLIPSOID:
        return placement["height"]

    cached = placement.get("height_ellipsoid")
    if cached is not None:
        return float(cached)

    return elevation.to_ellipsoid(
        placement["height"], reference, placement["lon"], placement["lat"]
    )


def make_placement(
    lon: float,
    lat: float,
    height: float,
    height_reference: str,
    heading: float = 0.0,
    pitch: float = 0.0,
    roll: float = 0.0,
    scale: float = 1.0,
    base_transform: list[float] | None = None,
    adjustable: bool = True,
) -> dict:
    """Eine Platzierung mit aufgelöster Ellipsoidhöhe."""
    placement = {
        "lon": lon,
        "lat": lat,
        "height": height,
        "height_reference": height_reference,
        "heading": heading,
        "pitch": pitch,
        "roll": roll,
        "scale": scale,
        "adjustable": adjustable,
        "base_transform": base_transform,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    placement["height_ellipsoid"] = elevation.to_ellipsoid(
        height, height_reference, lon, lat
    )
    return placement


def default_placement(
    base_transform: list[float] | None = None, adjustable: bool = True
) -> dict:
    """Platzierung am konfigurierten Referenzpunkt, ohne Drehung und Maßstab."""
    lon, lat, height = origin_from_env()
    return make_placement(
        lon,
        lat,
        height,
        elevation.default_reference(),
        base_transform=base_transform,
        adjustable=adjustable,
    )


def placement_from_projected(crs, x: float, y: float, z: float) -> dict:
    """
    Platzierung für Daten in einem projizierten CRS (UTM, Gauß-Krüger, …),
    deren lokaler Ursprung auf (x, y, z) dieses CRS liegt.

    Der Weg über die Platzierung statt über eine punktweise Umprojektion nach
    ECEF hat einen Grund: nur so bleibt das Tileset im UI verschiebbar und die
    Höhe über `height_reference` gegen das Gelände auflösbar — beides braucht
    man, weil ein Scan selten exakt auf dem Terrain sitzt, das der Viewer zeigt.

    Zwei Größen unterscheiden ein projiziertes Gitter vom lokalen ENU-System am
    selben Punkt, beide holt `pyproj` exakt für diesen Ort:

    * **Meridiankonvergenz** — Gitternord weicht von geografisch Nord ab, in
      UTM-Zone 32 am Mittelrhein rund ein Grad. Über 400 m Ausdehnung sind das
      schon sieben Meter Versatz an den Rändern; sie geht als `heading` ein.
    * **Punktmaßstab** — eine UTM-Strecke ist am Rand der Zone bis 0,4 ‰ kürzer
      als in der Natur; `scale` rechnet das zurück.

    Was bleibt, ist die Erdkrümmung: eine Ebene statt einer Kugelkappe, über
    500 m Ausdehnung einige Millimeter an den Rändern — unter dem Rauschen
    jedes Laserscans.

    Die Höhe wird als Höhe über NHN gelesen. Deutsche Scans liefern
    Gebrauchshöhen (DHHN); der vertikale Bezug steht im LAS-Header aber nur,
    wenn ein Compound-CRS mitgegeben wurde, und stimmt dann mit dieser Annahme
    überein.
    """
    from pyproj import CRS, Proj, Transformer

    crs = CRS.from_user_input(crs)
    lon, lat = Transformer.from_crs(crs, CRS.from_epsg(4326), always_xy=True).transform(x, y)

    factors = Proj(crs).get_factors(lon, lat)
    heading = float(factors.meridian_convergence)
    scale = 1.0 / float(factors.parallel_scale)

    logger.info(
        f"Verortet über {crs.to_string()}: {lon:.6f}/{lat:.6f}, {z:.2f} m ü. NHN, "
        f"Konvergenz {heading:+.4f}°, Maßstab {scale:.6f}"
    )
    return make_placement(lon, lat, z, elevation.MSL, heading=heading, scale=scale)


def placement_transform(placement: dict) -> list[float]:
    """
    `root.transform` aus einer Platzierung.

    `base_transform` ist der Anteil, den der Handler selbst gesetzt hat — bei
    py3dtiles etwa die Verschiebung auf den Datenschwerpunkt. Er bleibt beim
    Verschieben unangetastet und wird von der Platzierung nur vormultipliziert.
    """
    matrix = placement_matrix(
        placement["lon"],
        placement["lat"],
        resolve_height(placement),
        placement.get("heading", 0.0),
        placement.get("pitch", 0.0),
        placement.get("roll", 0.0),
        placement.get("scale", 1.0),
    )
    base = placement.get("base_transform")
    if base:
        matrix = matrix @ to_matrix(base)
    return to_column_major(matrix)


def placement_extras(placement: dict) -> dict:
    """
    Der Teil der Platzierung, der in `root.extras.ileen` der tileset.json
    gehört — was ein Viewer wissen muss, um die Verortung zu *interpretieren*.

    Der `root.transform` allein sagt nur, wo das Modell liegt, nicht wie diese
    Position gemeint war. Genau daran scheiterte die Höhe im Frontend: das
    Backend löst „0 m über Gelände" gegen Copernicus GLO-90 auf, CesiumJS zeigt
    aber Cesium World Terrain — dieselbe Stelle, andere Geländehöhe, das Modell
    schwebt oder versinkt um die Differenz. Mit diesen Feldern kann der Viewer
    die Auflösung gegen *sein* Terrain wiederholen (`terrain-align.js`).

    Bewusst in der tileset.json und nicht nur über `GET /assets/{id}/placement`:
    So funktioniert es auch, wenn die Tiles direkt aus dem öffentlichen
    MinIO-Bucket geladen werden, ohne dass die API erreichbar ist.
    """
    return {
        "lon": placement["lon"],
        "lat": placement["lat"],
        "height": placement["height"],
        "heightReference": placement.get("height_reference", elevation.ELLIPSOID),
        "heightEllipsoid": resolve_height(placement),
        "geoidUndulation": elevation.geoid_undulation(),
        "adjustable": placement.get("adjustable", True),
    }


def apply_placement(tileset: dict, placement: dict) -> dict:
    """
    Setzt `root.transform` und `root.extras.ileen` einer tileset.json aus einer
    Platzierung. Einzige Stelle, an der beides zusammen geschrieben wird — sonst
    laufen Matrix und Metadaten auseinander.
    """
    root = tileset.setdefault("root", {})
    root["transform"] = placement_transform(placement)
    root.setdefault("extras", {})["ileen"] = placement_extras(placement)
    return tileset


def write_placement(
    out_dir: Path,
    base_transform: list[float] | None = None,
    adjustable: bool = True,
    placement: dict | None = None,
) -> dict:
    """
    Legt `placement.json` neben die `tileset.json` und ergänzt deren
    `root.extras.ileen`, falls die Datei schon geschrieben wurde.

    `adjustable=False` für Daten, die bereits echt georeferenziert sind: deren
    Koordinaten sind schon ECEF, ein nachträglicher ENU-Transform würde sie von
    ihrer wahren Position wegschieben.

    `placement` übergibt eine fertige Platzierung — etwa die aus dem CRS einer
    Punktwolke abgeleitete —, statt den Referenzpunkt aus der Umgebung zu nehmen.
    """
    if placement is None:
        placement = default_placement(base_transform, adjustable)
    (out_dir / PLACEMENT_FILE).write_text(json.dumps(placement, indent=2))

    # Die Handler schreiben die tileset.json vor bzw. nach diesem Aufruf
    # (py3dtiles erzeugt sie sogar selbst). Ist sie schon da, bekommt sie die
    # Extras direkt; sonst erledigt das der Aufrufer über `apply_placement()`.
    tileset_path = out_dir / "tileset.json"
    if tileset_path.is_file():
        tileset = json.loads(tileset_path.read_text())
        tileset.setdefault("root", {}).setdefault("extras", {})["ileen"] = placement_extras(
            placement
        )
        tileset_path.write_text(json.dumps(tileset, indent=2))

    return placement


def bounding_box(center, half) -> dict:
    """
    `boundingVolume` als achsparalleler Kasten.

    3D Tiles beschreibt ihn als Mittelpunkt plus drei Halbachsenvektoren —
    für achsparallele Kästen sind das die halben Kantenlängen auf der Diagonale.
    """
    cx, cy, cz = (float(v) for v in center)
    hx, hy, hz = (max(float(v), 1e-6) for v in half)
    return {
        "box": [
            cx, cy, cz,
            hx, 0.0, 0.0,
            0.0, hy, 0.0,
            0.0, 0.0, hz,
        ]
    }


def make_tile(
    center,
    half,
    geometric_error: float,
    content_uri: str | None = None,
    children: list[dict] | None = None,
    translation=None,
) -> dict:
    """
    Ein Knoten im Tile-Baum.

    `translation` verschiebt das lokale System dieses Knotens gegenüber dem
    seines Elternknotens; `center` und `half` sind dann bereits in diesem
    verschobenen System zu verstehen. Zwei Gründe dafür: float32-Präzision
    (Vertexkoordinaten bleiben klein) und das 24-Bit-Festkomma von SPZ, das
    nur ±2048 m um den Tile-Ursprung abdeckt.

    `refine` steht durchgängig auf ADD: jedes Bauteil bzw. jeder Splat kommt im
    Baum genau einmal vor, grobe Ebenen zeigen die großen Dinge, feinere Ebenen
    ergänzen die kleinen. Bei REPLACE müsste jede Ebene den vollständigen Inhalt
    ihrer Kinder noch einmal enthalten.
    """
    tile: dict = {
        "boundingVolume": bounding_box(center, half),
        "geometricError": float(geometric_error),
        "refine": "ADD",
    }
    if translation is not None and any(abs(float(v)) > 1e-9 for v in translation):
        matrix = np.eye(4)
        matrix[:3, 3] = [float(v) for v in translation]
        tile["transform"] = to_column_major(matrix)
    if content_uri is not None:
        tile["content"] = {"uri": content_uri}
    if children:
        tile["children"] = children
    return tile


def build_tileset(
    root: dict, geometric_error: float, gltf_extensions: list[str] | None = None
) -> dict:
    """
    Verpackt einen Tile-Baum zu einer `tileset.json` mit georeferenziertem
    `root.transform`.

    `gltf_extensions` meldet glTF-Extensions an, die die Tile-Inhalte benötigen.
    Für Gaussian Splats ist das keine Formalie: CesiumJS entscheidet **allein
    anhand dieser Liste**, ob ein `.glb`-Tile als `GaussianSplat3DTileContent`
    oder als gewöhnliches Modell geladen wird — und verlangt dafür beide
    Splat-Extensions in `extensionsRequired`.
    """
    root["transform"] = default_transform()
    tileset = {
        "asset": {"version": "1.1" if gltf_extensions else "1.0"},
        "geometricError": float(geometric_error),
        "root": root,
    }
    if gltf_extensions:
        tileset["extensionsUsed"] = ["3DTILES_content_gltf"]
        tileset["extensionsRequired"] = ["3DTILES_content_gltf"]
        tileset["extensions"] = {
            "3DTILES_content_gltf": {
                "extensionsUsed": list(gltf_extensions),
                "extensionsRequired": list(gltf_extensions),
            }
        }
    return tileset
