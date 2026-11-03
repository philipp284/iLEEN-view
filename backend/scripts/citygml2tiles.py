"""
CityGML LoD2 (ADV/AAA, Länderabgabe) → 3D Tiles für den Viewer.

Warum überhaupt ein Konverter statt eines Dienstes: NRW liefert seine
LoD2-Gebäude fertig als 3D Tiles aus (`ogc-api.nrw.de/3dg`), Rheinland-Pfalz
nicht — dort gibt es Kachel-Downloads im CityGML-Format, 2 × 2 km je Datei und
rund 90 MB. Ein Browser kann damit nichts anfangen: CityGML ist XML, die
Geometrie steckt in verschachtelten `gml:posList`-Knoten, und die Koordinaten
liegen in ETRS89/UTM32 mit Normalhöhen über NHN.

Dieses Skript rechnet die Kachel einmal um. Ergebnis ist ein `tileset.json` mit
einem `.b3dm` je Kachelquadrant — dasselbe Format, das `LayerManager` schon für
die NRW-Ebene lud, weshalb im Viewer nur die URL zu tauschen war.

    python3 scripts/citygml2tiles.py \
        "/Volumes/…/LoD2_32_444_5536_2_RP.gml" \
        ../frontend/data/rlp-lod2

Drei Festlegungen, an denen das Ergebnis hängt:

**1 · Gerechnet wird gegen den Ellipsoid, nicht gegen NHN.** Die Z-Werte im
CityGML sind Normalhöhen (DHHN2016); Cesium erwartet in `root.transform`
ellipsoidische Höhen. Die Differenz ist die Geoidundulation — in Rheinland-Pfalz
rund 47 m. Ohne die Addition liegt die ganze Kachel 47 m zu tief, und zwar
gleichmäßig, weshalb es im Bild erst auffällt, wenn ein zweites Modell daneben
steht. Die Undulation kommt aus demselben EGM96-Raster, das der Viewer für
seinen Koordinatenpicker benutzt (`frontend/data/egm96-1deg.json`). EGM96 gegen
GCG2016 unterscheidet sich hier um wenige Dezimeter — für eine Kontextkulisse
belanglos, für eine Vermessungsaufgabe nicht.

**2 · Ein Bauteil je Gebäude, nicht je Fläche.** Die Batch-ID ist das Gebäude,
sodass ein Klick im Viewer ALKIS-ID, Funktion, Dachform und Höhe des *Hauses*
liefert. Der Flächentyp (Dach/Wand/Boden) wird zusätzlich als Vertexfarbe
transportiert — dieselbe Einfärbung, die die NRW-Ebene über ihr
`Cesium3DTileStyle` erzeugte, nur ohne den Umweg über ein Attribut, das je Bild
neu ausgewertet werden müsste.

**3 · Vier Quadranten statt eines Tiles.** Ein einzelnes B3DM mit 4700 Gebäuden
wäre ein 20-MB-Download, bevor das erste Haus erscheint. Die Kachel wird deshalb
geviertelt; das reicht bei 2 × 2 km, ein tieferer Baum brächte nichts, weil
ohnehin alles im selben Blickfeld liegt.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tiling.b3dm import glb_to_b3dm            # noqa: E402
from tiling.georef import enu_transform, make_tile  # noqa: E402
from tiling.gltf import mesh_glb               # noqa: E402

NS = {
    "core": "http://www.opengis.net/citygml/1.0",
    "bldg": "http://www.opengis.net/citygml/building/1.0",
    "gml": "http://www.opengis.net/gml",
    "gen": "http://www.opengis.net/citygml/generics/1.0",
}

# Flächentyp → Farbe. Dieselben Werte wie die frühere NRW-Ebene im LayerManager,
# damit die Kulisse nach dem Wechsel des Bundeslands nicht anders aussieht.
SURFACE_COLORS = {
    "RoofSurface":   (0xC0, 0x70, 0x3A),
    "WallSurface":   (0x88, 0x99, 0xAA),
    "GroundSurface": (0x55, 0x66, 0x77),
    "ClosureSurface": (0x99, 0xAA, 0xBB),
}
DEFAULT_COLOR = (0x99, 0xAA, 0xBB)


# ── ETRS89 / UTM 32N → WGS84 ────────────────────────────────────────────────
#
# Von Hand statt über pyproj: die einzige benötigte Umrechnung ist die inverse
# Transversale Mercator nach Krüger, das sind dreißig Zeilen. Eine zusätzliche
# Abhängigkeit (pyproj zieht PROJ mit) für ein Skript, das einmal je Kachel
# läuft, steht dazu in keinem Verhältnis. GRS80 und WGS84 unterscheiden sich in
# der Abplattung erst in der neunten Stelle — der Unterschied liegt unter 1 mm.

_A = 6378137.0                  # große Halbachse GRS80/WGS84
_F = 1.0 / 298.257222101        # Abplattung GRS80
_K0 = 0.9996
_FALSE_EASTING = 500000.0


def utm32_to_wgs84(easting: np.ndarray, northing: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """UTM-Zone-32N-Koordinaten (Meter) → (lon°, lat°)."""
    lon0 = math.radians(9.0)          # Mittelmeridian Zone 32

    e2 = _F * (2 - _F)
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))

    x = easting - _FALSE_EASTING
    m = northing / _K0
    mu = m / (_A * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))

    phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * np.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * np.sin(4 * mu)
        + (151 * e1**3 / 96) * np.sin(6 * mu)
        + (1097 * e1**4 / 512) * np.sin(8 * mu)
    )

    sin_p, cos_p, tan_p = np.sin(phi1), np.cos(phi1), np.tan(phi1)
    ep2 = e2 / (1 - e2)
    c1 = ep2 * cos_p**2
    t1 = tan_p**2
    n1 = _A / np.sqrt(1 - e2 * sin_p**2)
    r1 = _A * (1 - e2) / (1 - e2 * sin_p**2) ** 1.5
    d = x / (n1 * _K0)

    lat = phi1 - (n1 * tan_p / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * ep2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * ep2 - 3 * c1**2) * d**6 / 720
    )
    lon = lon0 + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * ep2 + 24 * t1**2) * d**5 / 120
    ) / cos_p

    return np.degrees(lon), np.degrees(lat)


def geoid_undulation(lon: float, lat: float, grid_path: Path) -> float:
    """
    EGM96-Undulation an einem Punkt, bilinear aus dem 1°-Raster des Viewers.

    Dasselbe Raster, das `frontend/data/egm96-1deg.json` für den
    Koordinatenpicker vorhält — eine zweite Quelle liefe früher oder später
    auseinander.
    """
    data = json.loads(grid_path.read_text())
    grid, res = data["grid"], data["resolution"]

    # Zeile 0 ist 90°N, Spalte 0 ist `lon_start` — dieselbe Ablesung wie
    # `getUndulation()` in frontend/geoid.js.
    row = (90.0 - lat) / res
    col = (lon - data["lon_start"]) / res
    r0, c0 = int(math.floor(row)), int(math.floor(col))
    r1 = min(r0 + 1, data["rows"] - 1)
    c1 = (c0 + 1) % data["cols"]
    fr, fc = row - r0, col - c0

    v0 = grid[r0][c0] + (grid[r0][c1] - grid[r0][c0]) * fc
    v1 = grid[r1][c0] + (grid[r1][c1] - grid[r1][c0]) * fc
    return v0 + (v1 - v0) * fr


# ── Polygontriangulierung ───────────────────────────────────────────────────

def _triangulate(ring: np.ndarray) -> list[tuple[int, int, int]]:
    """
    Ear-Clipping eines ebenen Polygons, projiziert auf seine dominante Ebene.

    Die Flächen einer LoD2-Abgabe sind eben und haben selten mehr als ein
    Dutzend Ecken, aber sie sind nicht durchweg konvex (Gauben, L-Grundrisse).
    Eine Dreiecksfächer-Zerlegung erzeugt dort Dreiecke außerhalb des Polygons —
    im Bild ein Dach, das über die Traufe hinausragt.
    """
    n = len(ring)
    if n < 3:
        return []

    # Normale nach Newell — funktioniert auch bei leicht windschiefen Ringen
    normal = np.zeros(3)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        normal += np.cross(a, b)
    if np.linalg.norm(normal) < 1e-12:
        return []
    normal /= np.linalg.norm(normal)

    # Auf die beiden Achsen projizieren, in denen die Fläche am größten ist
    drop = int(np.argmax(np.abs(normal)))
    keep = [i for i in range(3) if i != drop]
    pts = ring[:, keep]
    # Umlaufsinn im projizierten System vereinheitlichen
    area2 = np.sum(pts[:, 0] * np.roll(pts[:, 1], -1) - np.roll(pts[:, 0], -1) * pts[:, 1])
    order = list(range(n)) if area2 > 0 else list(range(n))[::-1]

    def cross2(o, a, b):
        return ((pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1])
                - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]))

    def inside(p, a, b, c):
        d1, d2, d3 = cross2(a, b, p), cross2(b, c, p), cross2(c, a, p)
        neg = d1 < 0 or d2 < 0 or d3 < 0
        pos = d1 > 0 or d2 > 0 or d3 > 0
        return not (neg and pos)

    tris: list[tuple[int, int, int]] = []
    remaining = order[:]
    guard = 0
    while len(remaining) > 3 and guard < 4 * n:
        guard += 1
        for k in range(len(remaining)):
            a = remaining[k - 1]
            b = remaining[k]
            c = remaining[(k + 1) % len(remaining)]
            if cross2(a, b, c) <= 0:            # kein konvexes Ohr
                continue
            if any(inside(p, a, b, c) for p in remaining if p not in (a, b, c)):
                continue
            tris.append((a, b, c))
            remaining.pop(k)
            break
        else:
            break                                # entartetes Polygon: abbrechen
    if len(remaining) == 3:
        tris.append(tuple(remaining))
    return tris


# ── CityGML einlesen ────────────────────────────────────────────────────────

def _poslist_rings(elem) -> list[np.ndarray]:
    """Alle äußeren Ringe unterhalb eines Elements als (n,3)-Arrays."""
    rings = []
    for pl in elem.iter(f"{{{NS['gml']}}}posList"):
        vals = [float(v) for v in pl.text.split()]
        dim = int(pl.get("srsDimension", "3"))
        if dim != 3 or len(vals) < 12:
            continue
        pts = np.array(vals, dtype=np.float64).reshape(-1, 3)
        if np.allclose(pts[0], pts[-1]):          # geschlossener Ring
            pts = pts[:-1]
        if len(pts) >= 3:
            rings.append(pts)
    return rings


def _text(elem, path: str) -> str | None:
    node = elem.find(path, NS)
    return node.text.strip() if node is not None and node.text else None


def read_buildings(src: Path):
    """
    Gebäude streamend einlesen.

    `iterparse` statt `ET.parse`: die 86-MB-Kachel als vollständiger DOM-Baum
    belegt mehrere Gigabyte. Jedes fertige `bldg:Building` wird ausgewertet und
    sofort aus dem Baum gelöst.
    """
    building_tag = f"{{{NS['bldg']}}}Building"

    # `root` mitführen und leeren: `elem.clear()` gibt zwar den Inhalt des
    # Gebäudes frei, der leere Knoten bleibt aber als Kind am Wurzelelement
    # hängen. Über 4700 Gebäude summiert sich das wieder zu Hunderten MB.
    context = ET.iterparse(str(src), events=("start", "end"))
    _, root = next(context)

    for event, elem in context:
        if event != "end" or elem.tag != building_tag:
            continue

        attrs = {
            "gml_id": elem.get(f"{{{NS['gml']}}}id") or "",
            "function": _text(elem, "bldg:function") or "",
            "roofType": _text(elem, "bldg:roofType") or "",
            "measuredHeight": _text(elem, "bldg:measuredHeight") or "",
            "storeys": _text(elem, "bldg:storeysAboveGround") or "",
        }
        for sa in elem.findall("gen:stringAttribute", NS):
            if sa.get("name") == "Gemeindeschluessel":
                attrs["gemeinde"] = _text(sa, "gen:value") or ""

        # `iter` und nicht `findall`: rund ein Drittel der Gebäude dieser
        # Abgabe hat keine eigenen Begrenzungsflächen, sondern führt seine
        # gesamte Geometrie in `bldg:consistsOfBuildingPart/bldg:BuildingPart`
        # (angebaute Garage, Staffelgeschoss, unterschiedliche Firsthöhen).
        # Mit `findall` auf der Ebene des Gebäudes blieben sie leer und fielen
        # unten stillschweigend heraus — 577 von 4716 Häusern fehlten in der
        # Kulisse, ohne dass irgendwo ein Fehler aufgetreten wäre.
        surfaces: list[tuple[str, np.ndarray]] = []
        for bb in elem.iter(f"{{{NS['bldg']}}}boundedBy"):
            for child in bb:
                kind = child.tag.rsplit("}", 1)[-1]
                for ring in _poslist_rings(child):
                    surfaces.append((kind, ring))

        if surfaces:
            yield attrs, surfaces

        elem.clear()
        root.clear()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="CityGML-Datei (.gml)")
    ap.add_argument("out", type=Path, help="Zielverzeichnis für tileset.json + b3dm")
    ap.add_argument("--geoid", type=Path,
                    default=Path(__file__).resolve().parents[2] / "frontend/data/egm96-1deg.json",
                    help="EGM96-Raster des Viewers")
    ap.add_argument("--split", type=int, default=2,
                    help="Kachel in split × split Quadranten zerlegen (Vorgabe 2)")
    args = ap.parse_args()

    if not args.src.exists():
        print(f"Nicht gefunden: {args.src}", file=sys.stderr)
        return 1

    print(f"Lese {args.src.name} ({args.src.stat().st_size / 1e6:.0f} MB) …")

    buildings = []
    for attrs, surfaces in read_buildings(args.src):
        buildings.append((attrs, surfaces))
        if len(buildings) % 500 == 0:
            print(f"  {len(buildings)} Gebäude …")
    if not buildings:
        print("Keine Gebäude gefunden — ist das eine LoD2-Abgabe?", file=sys.stderr)
        return 1
    print(f"{len(buildings)} Gebäude gelesen.")

    # Bezugspunkt: Mitte der Kachel, Höhe = Ellipsoidhöhe der tiefsten Ecke
    all_e = np.concatenate([r[:, 0] for _a, s in buildings for _k, r in s])
    all_n = np.concatenate([r[:, 1] for _a, s in buildings for _k, r in s])
    all_h = np.concatenate([r[:, 2] for _a, s in buildings for _k, r in s])
    ctr_e, ctr_n = float(all_e.mean()), float(all_n.mean())
    lon0, lat0 = utm32_to_wgs84(np.array([ctr_e]), np.array([ctr_n]))
    lon0, lat0 = float(lon0[0]), float(lat0[0])

    undulation = geoid_undulation(lon0, lat0, args.geoid)
    base_h = float(all_h.min()) + undulation
    print(f"Bezug: {lon0:.6f}° {lat0:.6f}°, NHN→Ellipsoid +{undulation:.2f} m, "
          f"Basis {base_h:.2f} m")

    # ── Gebäude in Quadranten einsortieren ──────────────────────────────
    e_min, e_max = float(all_e.min()), float(all_e.max())
    n_min, n_max = float(all_n.min()), float(all_n.max())
    quadrants: dict[tuple[int, int], list] = defaultdict(list)
    for attrs, surfaces in buildings:
        ce = float(np.mean([r[:, 0].mean() for _k, r in surfaces]))
        cn = float(np.mean([r[:, 1].mean() for _k, r in surfaces]))
        qe = min(int((ce - e_min) / (e_max - e_min + 1e-9) * args.split), args.split - 1)
        qn = min(int((cn - n_min) / (n_max - n_min + 1e-9) * args.split), args.split - 1)
        quadrants[(qe, qn)].append((attrs, surfaces))

    args.out.mkdir(parents=True, exist_ok=True)
    children = []

    for (qe, qn), group in sorted(quadrants.items()):
        positions: list[np.ndarray] = []
        normals: list[np.ndarray] = []
        colors: list[np.ndarray] = []
        batch: list[np.ndarray] = []
        indices: list[np.ndarray] = []
        table: dict[str, list] = defaultdict(list)

        for batch_id, (attrs, surfaces) in enumerate(group):
            for key in ("gml_id", "function", "roofType", "measuredHeight", "storeys"):
                table[key].append(attrs.get(key, ""))

            for kind, ring in surfaces:
                lon, lat = utm32_to_wgs84(ring[:, 0], ring[:, 1])
                # ENU um den Bezugspunkt. Bei 2 km Kachelgröße ist die
                # Erdkrümmung über die Fläche kleiner als 0,1 m — die ebene
                # Näherung über Bogenlängen genügt und spart je Punkt eine
                # vollständige ECEF-Umrechnung.
                mlat = math.radians(lat0)
                east = np.radians(lon - lon0) * 6378137.0 * math.cos(mlat)
                north = np.radians(lat - lat0) * 6356752.3
                up = ring[:, 2] + undulation - base_h
                pts = np.column_stack([east, north, up])

                tris = _triangulate(pts)
                if not tris:
                    continue

                offset = sum(len(p) for p in positions)
                n_vec = np.cross(pts[tris[0][1]] - pts[tris[0][0]],
                                 pts[tris[0][2]] - pts[tris[0][0]])
                norm = np.linalg.norm(n_vec)
                n_vec = n_vec / norm if norm > 1e-12 else np.array([0.0, 0.0, 1.0])

                rgb = SURFACE_COLORS.get(kind, DEFAULT_COLOR)
                positions.append(pts)
                normals.append(np.tile(n_vec, (len(pts), 1)))
                colors.append(np.tile(np.array([*rgb, 255], dtype=np.uint8), (len(pts), 1)))
                batch.append(np.full(len(pts), batch_id))
                indices.append(np.array(tris, dtype=np.int64) + offset)

        if not positions:
            continue

        pos = np.concatenate(positions).astype(np.float32)
        glb = mesh_glb(
            positions=pos,
            colors=np.concatenate(colors),
            indices=np.concatenate(indices),
            normals=np.concatenate(normals).astype(np.float32),
            batch_ids=np.concatenate(batch),
            name=f"rlp-lod2-{qe}{qn}",
        )
        b3dm = glb_to_b3dm(glb, batch_length=len(group), batch_table=dict(table))

        uri = f"q{qe}{qn}.b3dm"
        (args.out / uri).write_bytes(b3dm)

        lo, hi = pos.min(axis=0), pos.max(axis=0)
        children.append(make_tile(
            center=(lo + hi) / 2,
            half=(hi - lo) / 2,
            geometric_error=0.0,
            content_uri=uri,
        ))
        print(f"  {uri}: {len(group)} Gebäude, {len(pos)} Vertices, "
              f"{len(b3dm) / 1e6:.1f} MB")

    lo = np.min([c["boundingVolume"]["box"][:3] for c in children], axis=0)
    hi = np.max([c["boundingVolume"]["box"][:3] for c in children], axis=0)
    span = np.array([
        max(abs(c["boundingVolume"]["box"][0]) + c["boundingVolume"]["box"][3] for c in children),
        max(abs(c["boundingVolume"]["box"][1]) + c["boundingVolume"]["box"][7] for c in children),
        max(abs(c["boundingVolume"]["box"][2]) + c["boundingVolume"]["box"][11] for c in children),
    ])

    tileset = {
        "asset": {"version": "1.0"},
        "geometricError": 500.0,
        "properties": {},
        "root": {
            "transform": enu_transform(lon0, lat0, base_h),
            "boundingVolume": {"box": [
                0.0, 0.0, float(span[2] / 2),
                float(span[0]), 0.0, 0.0,
                0.0, float(span[1]), 0.0,
                0.0, 0.0, float(span[2] / 2),
            ]},
            "geometricError": 200.0,
            "refine": "ADD",
            "children": children,
        },
    }
    (args.out / "tileset.json").write_text(json.dumps(tileset, indent=2))
    print(f"→ {args.out / 'tileset.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
