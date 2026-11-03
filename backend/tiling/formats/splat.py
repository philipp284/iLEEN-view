"""
3D Gaussian Splatting PLY → 3D Tiles mit echtem Splat-Rendering.

**Was sich geändert hat.** Vorher wurden nur die Gauß-Zentren als PNTS-Punktwolke
exportiert — sichtbar war eine Punktwolke, kein Splat-Modell: keine Ellipsoide,
keine Ausrichtung, keine Deckkraft, kein alphakorrektes Blending. CesiumJS
rendert Splats seit 1.130 nativ, allerdings ausschließlich über glTF-Tiles mit
den Extensions `KHR_gaussian_splatting` und
`KHR_gaussian_splatting_compression_spz_2` (siehe `tiling/spz.py`, warum der
SPZ-Container dabei nicht optional ist).

**Aufbau des Tilesets.** Statt eines einzelnen Tiles entsteht ein Octree mit
ADD-Verfeinerung: jeder Knoten trägt eine Zufallsauswahl der Splats seines
Teilbaums, die Kinder ergänzen die restlichen. Damit kommt jeder Splat genau
einmal vor, aus der Ferne lädt nur die grobe Auswahl, und beim Heranfliegen
kommt Detail hinzu. Ein einzelnes Tile mit Millionen Splats würde CesiumJS
zwar laden, aber am Stück — und oberhalb von rund 14 Mio. Splats sprengt es
zusätzlich das WASM-Speicherlimit des SPZ-Decoders.

Jeder Knoten bekommt seinen eigenen Ursprung (`transform`), weil das
24-Bit-Festkomma von SPZ nur ±2048 m um den Tile-Ursprung abdeckt.
"""

import json
import logging
import os
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tiling import spz
from tiling.georef import (
    bounding_box, build_tileset, make_tile, recenter, write_placement,
)
from tiling.gltf import splat_glb

logger = logging.getLogger(__name__)

# Obergrenze für die Gesamtszene. Mit der LOD-Hierarchie lädt CesiumJS zwar nur
# die sichtbaren Tiles, alle geladenen Splats liegen aber gemeinsam sortiert im
# GPU-Speicher — irgendwo muss die Grenze sein. 0 schaltet sie ab.
_MAX_POINTS = int(os.getenv("SPLAT_MAX_POINTS", "6000000"))

# Splats je Tile. Klein genug für zügiges Nachladen, groß genug, dass der
# Overhead je Tile (SPZ-Header, glTF-JSON, HTTP) nicht ins Gewicht fällt.
_TILE_POINTS = int(os.getenv("SPLAT_TILE_POINTS", "250000"))

# Größte zugelassene Splat-Halbachse, als Anteil der Szenenausdehnung.
# 3DGS-Trainings hinterlassen regelmäßig einige wenige riesige Gaußverteilungen
# — Hintergrund, Himmel, Fehlanpassungen. Sie sind halbtransparent und ziehen
# als helle Schlieren quer durchs Bild, weil sie aus jeder Blickrichtung fast
# den ganzen Bildschirm überdecken. Bei einem Testmodell waren es 3 % der
# Splats, die das Objekt praktisch unkenntlich machten.
# 0 schaltet den Filter ab.
_MAX_SCALE_RATIO = float(os.getenv("SPLAT_MAX_SCALE_RATIO", "0.05"))

# Zweite, von der Szenengeometrie unabhängige Grenze: ein Vielfaches der
# *typischen* Splat-Größe. Nötig, weil ein Anteil der Szenenausdehnung dort
# versagt, wo die Szene selbst überwiegend aus weit verstreuten Ausreißern
# besteht — dann ist jede Grenze großzügig, die sich aus ihr ableitet.
# Verworfen wird, was eine der beiden Grenzen reißt. 0 schaltet sie ab.
_MAX_SCALE_MEDIANS = float(os.getenv("SPLAT_MAX_SCALE_MEDIANS", "8"))

_MAX_DEPTH = 10
_SH_C0 = 0.28209479177387814


@dataclass(frozen=True)
class _Optionen:
    """
    Stellschrauben aus #8 (Splat-Leistung). Die Felder hier sind die
    Voreinstellung des *Datentyps* (= Stand vor #8, damit `_TileWriter` ohne
    Optionen unverändert arbeitet); was der Tiler tatsächlich nimmt, steht in
    `_optionen()`. Messungen: frontend/tests/splat-bench/ergebnisse/.
    """

    # Ausdehnung eines Splats im Hüllkasten: k·σ der größten Halbachse. 0 heißt
    # nur Mittelpunkte — dann ragen die Randsplats aus dem Kasten, und Cesium
    # verwirft ein Tile, dessen Inhalt noch ins Bild reicht.
    box_sigma: float = 0.0
    # Splats je Tile in Z-Ordnung (Morton) statt in Zufallsreihenfolge.
    morton: bool = False
    # Höchster SH-Grad, der mitgeschrieben wird (0 = nur Grundfarbe).
    sh_grad: int = 0
    # tileset.json ohne Einrückung.
    json_kompakt: bool = False


def _optionen() -> _Optionen:
    # Voreinstellungen seit #8: was dort gemessen und behalten wurde. Der
    # Stand davor ist die Variante `baseline` in tiling/splat_varianten.json.
    return _Optionen(
        box_sigma=float(os.getenv("SPLAT_BOX_SIGMA", "3")),
        morton=os.getenv("SPLAT_MORTON", "1") == "1",
        sh_grad=int(os.getenv("SPLAT_SH_GRAD", "0")),
        json_kompakt=os.getenv("SPLAT_JSON_KOMPAKT", "1") == "1",
    )


_HEADER_SIZE = 28

_GLTF_EXTENSIONS = [
    "KHR_gaussian_splatting",
    "KHR_gaussian_splatting_compression_spz_2",
]


def tile_splat(src: Path, out_dir: Path):
    """Liest ein 3DGS-PLY und schreibt ein Gaussian-Splat-Tileset."""
    logger.info(f"3DGS-Splat Tiling: {src.name}")
    opt = _optionen()
    splats = _load_splat(src, sh_grad=opt.sh_grad)

    if splats.get("log_scales") is None:
        # PLY mit Splat-Farben, aber ohne Kovarianz (z.B. beschnittene Exporte).
        # Als Splat nicht darstellbar — dann lieber eine ehrliche Punktwolke.
        logger.warning(
            "PLY enthält keine scale_*/rot_*-Eigenschaften — kein vollständiges "
            "3DGS-Modell. Fallback auf PNTS-Punktwolke."
        )
        return _tile_as_points(splats, out_dir)

    splats = _drop_oversized(splats)

    count = len(splats["xyz"])
    if _MAX_POINTS > 0 and count > _MAX_POINTS:
        rng = np.random.default_rng(seed=42)
        keep = np.sort(rng.choice(count, size=_MAX_POINTS, replace=False))
        splats = {k: v[keep] for k, v in splats.items() if isinstance(v, np.ndarray)}
        logger.info(f"Auf {_MAX_POINTS} von {count} Splats reduziert (SPLAT_MAX_POINTS)")

    xyz, quelloffset = recenter(splats["xyz"].astype(np.float64))
    splats["xyz"] = xyz
    lo, hi = xyz.min(axis=0), xyz.max(axis=0)
    # Ursprung des Wurzelknotens vor dem Auslichten festhalten: von ihm hängt
    # ab, wo das Modell relativ zur Verortung liegt (siehe unten). Entfernte
    # Ausreißer dürfen das Modell nicht verschieben.
    wurzel = (lo + hi) / 2.0
    splats = _auslichten(splats)
    xyz = splats["xyz"]

    if os.getenv("SPLAT_LOD", "hlod") == "hlod":
        from tiling.splat_hlod import HlodSchreiber, hlod_optionen

        sh = splats.get("sh")
        writer = HlodSchreiber(out_dir, splats, hlod_optionen(),
                               0 if sh is None else spz.sh_grad_von(sh.shape[1]),
                               _morton_ordnung)
        root = writer.baue(np.arange(len(xyz)), 0, np.zeros(3), ursprung=wurzel)[0]
        # Die Translation der Wurzel verwirft build_tileset() ohnehin; der Inhalt
        # ist relativ zu `wurzel` geschrieben, wie beim ADD-Octree.
        root.pop("transform", None)
        for e in writer.ebenen.values():
            weiten = [w for w in e.pop("weite") if w > 0]
            e["rasterweite_m"] = round(float(np.median(weiten)), 4) if weiten else 0.0
        logger.info(f"HLOD-Ebenen: {writer.ebenen}")
    else:
        writer = _TileWriter(out_dir, splats, opt)
        indices = np.arange(len(xyz))
        root = writer.build(indices, depth=0, parent_origin=np.zeros(3))

    # `build_tileset()` setzt den Wurzel-`transform` auf die ENU-Matrix und
    # verwirft dabei die Verschiebung auf die Mitte des Wurzelkastens. Der
    # Inhalt liegt dadurch um diese Mitte versetzt — dieselbe Konvention wie
    # beim IFC-Octree („Render-System", frontend/CLAUDE.md). Sie bleibt, damit
    # bestehende Verortungen stimmen; wer Splat-Koordinaten in das Tileset
    # umrechnet, liest den Versatz hier ab.
    root.setdefault("extras", {})["ileen_splat"] = {
        "modellversatz": [float(-v) for v in wurzel],
        # Der Betrag, den `recenter()` von den Quellkoordinaten abgezogen hat. Mit dem
        # Modellversatz ergibt er den Punkt der Quelldatei, an dem die Verortung hängt
        # (`quelloffset − modellversatz`): ohne ihn ließe sich eine Platzierung, die aus den
        # Quellkoordinaten berechnet wurde — Laserscan mit CRS, Foto-Rekonstruktion mit GPS —
        # nicht auf diesen Referenzpunkt zurückführen. Siehe `splatwerk/uebernahme.py`.
        "quelloffset": [float(v) for v in quelloffset],
        "sh_grad": writer.sh_grad,
        # Aufbau und Zahl der Originalsplats: `tiling/splat_neu.py` erkennt
        # daran, welche Assets noch den alten Aufbau haben und ob ein
        # Neu-Tiling dieselbe Auswahl trifft (= dieselbe Verortung).
        "lod": os.getenv("SPLAT_LOD", "hlod"),
        "splats": int(len(xyz)),
    }
    tileset = build_tileset(
        root,
        geometric_error=max(float(np.linalg.norm(hi - lo)), 1.0),
        gltf_extensions=_GLTF_EXTENSIONS,
    )
    (out_dir / "tileset.json").write_text(json.dumps(tileset, indent=2))
    write_placement(out_dir)
    if opt.json_kompakt:
        pfad = out_dir / "tileset.json"
        pfad.write_text(json.dumps(json.loads(pfad.read_text()), separators=(",", ":")))
    logger.info(
        f"Gaussian-Splat-Tileset: {len(xyz)} Splats in {writer.tiles} Tiles → "
        f"{out_dir}/tileset.json"
    )


# ── Octree ───────────────────────────────────────────────────────────────────


class _TileWriter:
    """Baut den Octree und schreibt je Knoten ein GLB mit SPZ-Inhalt."""

    def __init__(self, out_dir: Path, splats: dict, opt: _Optionen | None = None):
        self.out_dir = out_dir
        self.splats = splats
        self.opt = opt or _Optionen()
        self.tiles = 0
        self._rng = np.random.default_rng(seed=42)
        sh = splats.get("sh")
        self.sh_grad = 0 if sh is None else spz.sh_grad_von(sh.shape[1])
        # Radius je Splat für den Hüllkasten, nur wenn er gebraucht wird
        self._radius = (
            self.opt.box_sigma * np.exp(splats["log_scales"].max(axis=1).astype(np.float64))
            if self.opt.box_sigma > 0 else None
        )

    def build(self, indices: np.ndarray, depth: int, parent_origin: np.ndarray) -> dict:
        xyz = self.splats["xyz"]
        points = xyz[indices]
        lo, hi = points.min(axis=0), points.max(axis=0)
        origin = (lo + hi) / 2.0
        half = np.maximum((hi - lo) / 2.0, 1e-3)
        size = float(np.max(hi - lo))

        if len(indices) <= _TILE_POINTS or depth >= _MAX_DEPTH:
            own, rest = indices, np.empty(0, dtype=indices.dtype)
        else:
            shuffled = self._rng.permutation(indices)
            own, rest = shuffled[:_TILE_POINTS], shuffled[_TILE_POINTS:]

        uri = self._write_tile(own, origin)

        children = [
            self.build(part, depth + 1, origin)
            for part in _split_octants(xyz, rest, origin)
        ]

        # Der geometrische Fehler eines Knotens ist der mittlere Splat-Abstand
        # seiner eigenen Auswahl: so grob ist die Darstellung, solange nicht
        # verfeinert wird. Blätter haben nichts mehr nachzuladen — also 0.
        # Ein gemessener Nachbarabstand statt dieser Schätzung war in #8
        # gemessen: 50–70× kleiner, dadurch fast nie verfeinert, SSIM bis 0,35.
        # Der Grund: bei ADD mit Zufallsauswahl ist der Fehler nicht der
        # Abstand zweier Splats, sondern die fehlende Deckung — und die
        # verfehlt jeder Abstand, weil die Splats ihre Originalgröße behalten.
        ge = size / max(len(own), 1) ** (1 / 3) if children else 0.0

        tile = make_tile(
            center=(0.0, 0.0, 0.0),
            half=half,
            geometric_error=ge,
            content_uri=uri,
            children=children,
            translation=origin - parent_origin,
        )
        if self._radius is not None:
            tile["boundingVolume"] = self._huelle(indices, origin)
        return tile

    def _huelle(self, indices: np.ndarray, origin: np.ndarray) -> dict:
        """
        Hüllkasten über den ganzen Teilbaum, relativ zum Knotenursprung.

        Über den Teilbaum und nicht nur den eigenen Inhalt: bei ADD rendert
        Cesium einen Knoten und seine Kinder zusammen und verwirft den ganzen
        Ast, wenn der Kasten des Knotens aus dem Bild fällt. Mit σ-Radius
        umschließt der Kasten die Splats selbst, nicht nur ihre Mitten.
        """
        p = self.splats["xyz"][indices] - origin
        r = self._radius[indices]
        lo = (p - r[:, None]).min(axis=0)
        hi = (p + r[:, None]).max(axis=0)
        return bounding_box((lo + hi) / 2.0, np.maximum((hi - lo) / 2.0, 1e-3))

    def _write_tile(self, indices: np.ndarray, origin: np.ndarray) -> str:
        local = (self.splats["xyz"][indices] - origin).astype(np.float32)
        if self.opt.morton:
            ordnung = _morton_ordnung(local)
            indices, local = indices[ordnung], local[ordnung]
        sh = self.splats.get("sh")
        blob = spz.encode(
            local,
            self.splats["log_scales"][indices],
            self.splats["quat_xyzw"][indices],
            self.splats["opacity"][indices],
            self.splats["sh_dc"][indices],
            sh=None if sh is None else sh[indices],
        )
        name = f"tile_{self.tiles}.glb"
        (self.out_dir / name).write_bytes(
            splat_glb(blob, len(indices), local.min(axis=0), local.max(axis=0),
                      sh_grad=self.sh_grad)
        )
        self.tiles += 1
        return name


def _morton_ordnung(lokal: np.ndarray) -> np.ndarray:
    """
    Reihenfolge nach Z-Kurve über 3 × 10 Bit.

    Benachbarte Splats liegen danach auch im Speicher nebeneinander. Das hilft
    gzip im SPZ-Container (ähnliche Positions-, Farb- und Skalenbytes stehen
    zusammen) und der Speicherlokalität beim Sortieren und Zeichnen.
    """
    lo, hi = lokal.min(axis=0), lokal.max(axis=0)
    q = ((lokal - lo) / np.maximum(hi - lo, 1e-9) * 1023).astype(np.uint32)

    def spreizen(v):
        v = v & 0x3FF
        v = (v | (v << 16)) & 0x030000FF
        v = (v | (v << 8)) & 0x0300F00F
        v = (v | (v << 4)) & 0x030C30C3
        v = (v | (v << 2)) & 0x09249249
        return v

    code = spreizen(q[:, 0]) | (spreizen(q[:, 1]) << 1) | (spreizen(q[:, 2]) << 2)
    return np.argsort(code, kind="stable")


def _auslichten(splats: dict) -> dict:
    """
    Entfernt, was im Bild nichts beiträgt oder stört — jede Grenze einzeln
    abschaltbar, voreingestellt aus.

    * `SPLAT_MIN_OPACITY` — Deckkraft (nach der Sigmoide) darunter. 3DGS-
      Trainings hinterlassen viele fast durchsichtige Splats, die jedes Bild
      sortiert und gezeichnet werden, ohne sichtbar zu sein.
    * `SPLAT_MIN_SCALE` — größte Halbachse in Metern darunter.
    * `SPLAT_FLOATER` — Schwebeteilchen: Abstand zum k-ten Nachbarn
      (`SPLAT_FLOATER_K`, Vorgabe 16) über dem Vielfachen seines Medians.
      Gemessen am eigenen Median, weil die Dichte zwischen Innenraumscan und
      Drohnenflug um Größenordnungen schwankt.
    """
    keep = np.ones(len(splats["xyz"]), dtype=bool)
    gruende = []
    min_op = float(os.getenv("SPLAT_MIN_OPACITY", "0"))
    if min_op > 0:
        alpha = 1.0 / (1.0 + np.exp(-splats["opacity"].astype(np.float64)))
        weg = alpha < min_op
        gruende.append(f"{int(weg.sum())} mit Deckkraft < {min_op}")
        keep &= ~weg
    min_s = float(os.getenv("SPLAT_MIN_SCALE", "0"))
    if min_s > 0:
        weg = np.exp(splats["log_scales"].max(axis=1)) < min_s
        gruende.append(f"{int(weg.sum())} mit Halbachse < {min_s} m")
        keep &= ~weg
    floater = float(os.getenv("SPLAT_FLOATER", "0"))
    if floater > 0:
        from scipy.spatial import cKDTree

        k = int(os.getenv("SPLAT_FLOATER_K", "16"))
        xyz = splats["xyz"]
        abstand, _ = cKDTree(xyz).query(xyz, k=k + 1, workers=-1)
        dk = abstand[:, -1]
        weg = dk > floater * float(np.median(dk))
        gruende.append(f"{int(weg.sum())} Schwebeteilchen (d{k} > {floater}× Median)")
        keep &= ~weg
    if keep.all():
        return splats
    if not keep.any():
        logger.warning("Auslichten hätte alle Splats entfernt — übersprungen.")
        return splats
    logger.info(f"Ausgelichtet: {(~keep).sum()} von {len(keep)} Splats ({', '.join(gruende)})")
    return {k: (v[keep] if isinstance(v, np.ndarray) else v) for k, v in splats.items()}


def _scene_extent(xyz: np.ndarray) -> float:
    """
    Ausdehnung der Szene, gemessen als Diagonale des 1–99-Perzentil-Kastens
    statt der vollen Bounding Box.

    Der Unterschied ist der ganze Punkt: eine Handvoll weit abliegender
    Ausreißer-Splats — genau die, die `_drop_oversized()` loswerden soll —
    bläht die Bounding Box um ein Vielfaches auf. Leitet man die Größengrenze
    aus ihr ab, hebt jeder Ausreißer die Grenze mit an, an der er selbst
    gemessen wird, und der Filter entwaffnet sich selbst. Bei einem
    3DGS-Buddha (Statue ~1 m, verstreute Hintergrundsplats bis 9 m) waren es
    10,6 m Bounding-Box gegenüber 4,4 m tatsächlicher Szene — die Grenze war
    damit um Faktor 2,4 zu weit und ließ die schlimmsten Schlieren durch.
    """
    lo = np.percentile(xyz, 1.0, axis=0)
    hi = np.percentile(xyz, 99.0, axis=0)
    return float(np.linalg.norm(hi - lo))


def _drop_oversized(splats: dict) -> dict:
    """
    Entfernt Splats, die im Verhältnis zur Szene absurd groß sind.

    Zwei Grenzen, verworfen wird bei Überschreitung der kleineren:

    * ein Anteil der Szenenausdehnung (`SPLAT_MAX_SCALE_RATIO`) — kein fester
      Meterwert, damit derselbe Filter für eine Buddhafigur und für einen
      Campus-Laserscan taugt;
    * ein Vielfaches der Median-Halbachse (`SPLAT_MAX_SCALE_MEDIANS`) — greift
      auch dann, wenn die Szenenausdehnung selbst schon unbrauchbar ist.

    Gemessen wird an der größten Halbachse. Sie allein bestimmt die Länge des
    Strichs auf dem Bildschirm: die Ausreißer sind fast immer extrem
    anisotrop (Achsenverhältnisse von 1:1000 und mehr sind normal), also
    nadel- statt kugelförmig, und eine solche Nadel überdeckt bei 3σ Länge
    ein Vielfaches der Szene, ohne dabei nennenswert Volumen zu haben.

    Wie viele entfernt wurden, steht im Log — wenn es mehr als ein paar
    Promille sind, lohnt der Blick auf die Quelldatei.
    """
    if splats.get("log_scales") is None:
        return splats

    scales = np.exp(splats["log_scales"].max(axis=1))
    limits = []
    if _MAX_SCALE_RATIO > 0:
        limits.append(_MAX_SCALE_RATIO * _scene_extent(splats["xyz"]))
    if _MAX_SCALE_MEDIANS > 0:
        limits.append(_MAX_SCALE_MEDIANS * float(np.median(scales)))
    if not limits:
        return splats

    limit = min(limits)
    keep = scales <= limit

    dropped = int((~keep).sum())
    if dropped == 0:
        return splats
    if dropped == len(keep):
        # Entartete Grenze (z.B. eine Szene, die fast nur aus den Ausreißern
        # besteht, die sie messen soll) — Filter deaktivieren statt jeden
        # Splat zu verwerfen. Sonst crasht recenter() gleich danach auf einem
        # leeren Array ("zero-size array to reduction operation minimum").
        logger.warning(
            f"Ausreißerfilter hätte alle {len(keep)} Splats verworfen (Grenze "
            f"{limit:.3f} m, größte Halbachse {scales.max():.2f} m) — Filter für "
            "diese Datei deaktiviert."
        )
        return splats

    logger.info(
        f"{dropped} von {len(keep)} Splats ({dropped / len(keep) * 100:.2f} %) mit "
        f"Halbachse über {limit:.3f} m entfernt (größte war {scales.max():.2f} m, "
        f"Median {np.median(scales):.3f} m)"
    )
    return {k: (v[keep] if isinstance(v, np.ndarray) else v) for k, v in splats.items()}


def _split_octants(xyz: np.ndarray, indices: np.ndarray, center: np.ndarray) -> list:
    """Teilt Indizes an der Knotenmitte in die belegten Oktanten auf."""
    if len(indices) == 0:
        return []
    points = xyz[indices]
    # Bitmuster aus den drei Achsenvergleichen — 0…7 je Oktant
    octant = (
        (points[:, 0] >= center[0]).astype(np.uint8)
        | ((points[:, 1] >= center[1]).astype(np.uint8) << 1)
        | ((points[:, 2] >= center[2]).astype(np.uint8) << 2)
    )
    return [indices[octant == o] for o in range(8) if np.any(octant == o)]


# ── PLY lesen ────────────────────────────────────────────────────────────────


def _load_splat(src: Path, sh_grad: int = 0) -> dict:
    """
    Liest die Splat-Attribute aus einem 3DGS-PLY.

    Zurückgegeben werden die Rohgrößen, wie sie in der Datei stehen: `scale_*`
    logarithmisch, `opacity` als Logit, `f_dc_*` als SH-DC-Koeffizient. Genau
    diese Form erwartet der SPZ-Encoder — jede Umrechnung hier wäre eine, die
    dort wieder rückgängig gemacht werden müsste.
    """
    from plyfile import PlyData

    plydata = PlyData.read(str(src))
    el = plydata["vertex"]
    names = set(el.data.dtype.names or ())

    xyz = np.stack([el["x"], el["y"], el["z"]], axis=-1).astype(np.float64)
    result: dict = {"xyz": xyz, "sh_dc": _read_dc(el, names, len(xyz))}

    scale_names = ("scale_0", "scale_1", "scale_2")
    rot_names = ("rot_0", "rot_1", "rot_2", "rot_3")
    if not (names.issuperset(scale_names) and names.issuperset(rot_names)):
        result["log_scales"] = None
        return result

    result["log_scales"] = np.stack(
        [np.asarray(el[n], dtype=np.float32) for n in scale_names], axis=-1
    )
    # 3DGS speichert Quaternionen als (w, x, y, z); glTF und SPZ erwarten
    # (x, y, z, w). Ohne das Umsortieren stehen alle Splats schief im Raum.
    wxyz = np.stack([np.asarray(el[n], dtype=np.float32) for n in rot_names], axis=-1)
    result["quat_xyzw"] = np.roll(wxyz, -1, axis=1)

    result["opacity"] = (
        np.asarray(el["opacity"], dtype=np.float32)
        if "opacity" in names
        # Ohne Opazität ist jeder Splat undurchsichtig: sigmoid(8) ≈ 0,9997
        else np.full(len(xyz), 8.0, dtype=np.float32)
    )

    sh_grad = min(sh_grad, _sh_grad_in(names))
    if sh_grad > 0:
        result["sh"] = _read_sh(el, names, sh_grad)

    if _is_y_up(plydata):
        # Manche Trainer (Brush, INRIA-Ableger) vermerken die Hochachse im
        # Header. Y-up → Z-up ist eine Drehung um +90° um X, (x, y, z) → (x, -z, y),
        # damit das Modell im ENU-System aufrecht steht statt auf der Seite zu liegen.
        logger.info("PLY-Header meldet Y als Hochachse — nach Z-up gedreht.")
        result["xyz"] = np.stack([xyz[:, 0], -xyz[:, 2], xyz[:, 1]], axis=-1)
        # Dieselbe Drehung als Quaternion auf die Splat-Ausrichtung. Die Skalen
        # bleiben unangetastet: sie gelten im lokalen System des Splats, das die
        # Quaternion vollständig beschreibt — Σ = R·S·Sᵀ·Rᵀ wird unter einer
        # globalen Drehung zu (R_neu·R)·S·Sᵀ·(…)ᵀ, S ändert sich dabei nicht.
        result["quat_xyzw"] = _rotate_quats(
            result["quat_xyzw"], np.array([0.70710678, 0.0, 0.0, 0.70710678])
        )
        if "sh" in result:
            # Die SH-Bänder müssten mitgedreht werden (Wigner-D je Grad) —
            # ungedreht zeigten die Glanzlichter in die falsche Richtung.
            logger.warning("Y-up-PLY: höhere SH-Ordnungen verworfen (Drehung nicht umgesetzt).")
            del result["sh"]

    return result


def _sh_grad_in(names: set) -> int:
    """Grad der höheren SH-Ordnungen in der Datei, aus der Zahl der f_rest_*."""
    anzahl = sum(1 for n in names if n.startswith("f_rest_"))
    return {0: 0, 9: 1, 24: 2, 45: 3}.get(anzahl, 0)


def _read_sh(el, names: set, grad: int) -> np.ndarray:
    """
    Höhere SH-Koeffizienten als (N, K, 3), Koeffizient vor Farbkanal.

    Im 3DGS-PLY liegen sie nach Kanal geordnet: `f_rest_0…14` sind die 15
    Koeffizienten von Rot, `15…29` Grün, `30…44` Blau (bei Grad 3). SPZ will je
    Punkt Koeffizient für Koeffizient mit R, G, B dahinter. Ein niedrigerer
    Grad als in der Datei nimmt die ersten K Koeffizienten je Kanal.
    """
    in_datei = {1: 3, 2: 8, 3: 15}[_sh_grad_in(names)]
    k = {1: 3, 2: 8, 3: 15}[grad]
    kanaele = [
        np.stack([np.asarray(el[f"f_rest_{c * in_datei + i}"], dtype=np.float32)
                  for i in range(k)], axis=-1)
        for c in range(3)
    ]
    return np.stack(kanaele, axis=-1)


def _read_dc(el, names: set, count: int) -> np.ndarray:
    """SH-DC-Koeffizienten; notfalls aus RGB-Bytes zurückgerechnet."""
    if {"f_dc_0", "f_dc_1", "f_dc_2"}.issubset(names):
        channels = ("f_dc_0", "f_dc_1", "f_dc_2")
    elif {"sh_0_r", "sh_0_g", "sh_0_b"}.issubset(names):
        channels = ("sh_0_r", "sh_0_g", "sh_0_b")
    elif {"red", "green", "blue"}.issubset(names):
        rgb = np.stack([el["red"], el["green"], el["blue"]], axis=-1) / 255.0
        return ((rgb - 0.5) / _SH_C0).astype(np.float32)
    else:
        logger.warning("Keine Farbinformation im PLY gefunden, verwende Grau.")
        return np.zeros((count, 3), dtype=np.float32)
    return np.stack([np.asarray(el[c], dtype=np.float32) for c in channels], axis=-1)


def _is_y_up(plydata) -> bool:
    return any(
        "vertical axis: y" in str(c).lower() for c in (plydata.comments or [])
    )


def _rotate_quats(quats: np.ndarray, rotation: np.ndarray) -> np.ndarray:
    """Hamilton-Produkt `rotation * q` für ein Array von (x, y, z, w)-Quaternionen."""
    rx, ry, rz, rw = rotation
    x, y, z, w = quats[:, 0], quats[:, 1], quats[:, 2], quats[:, 3]
    return np.stack(
        [
            rw * x + rx * w + ry * z - rz * y,
            rw * y - rx * z + ry * w + rz * x,
            rw * z + rx * y - ry * x + rz * w,
            rw * w - rx * x - ry * y - rz * z,
        ],
        axis=-1,
    ).astype(np.float32)


# ── Fallback: unvollständige Splat-PLYs als Punktwolke ───────────────────────


def _tile_as_points(splats: dict, out_dir: Path):
    """Nur Zentren und Farbe vorhanden → einzelnes PNTS statt Splat-Tileset."""
    xyz, _ = recenter(splats["xyz"].astype(np.float64))
    xyz = xyz.astype(np.float32)
    colors = (splats["sh_dc"] * _SH_C0 + 0.5).clip(0.0, 1.0).astype(np.float32)

    (out_dir / "tile.pnts").write_bytes(_build_pnts(xyz, colors))

    lo, hi = xyz.min(axis=0), xyz.max(axis=0)
    tileset = build_tileset(
        make_tile(
            center=((lo + hi) / 2.0).tolist(),
            half=((hi - lo) / 2.0).tolist(),
            geometric_error=0.0,
            content_uri="tile.pnts",
        ),
        geometric_error=max(float(np.linalg.norm(hi - lo)), 1.0),
    )
    (out_dir / "tileset.json").write_text(json.dumps(tileset, indent=2))
    write_placement(out_dir)
    logger.info(f"PNTS-Tileset: {len(xyz)} Punkte → {out_dir}/tileset.json")


def _build_pnts(xyz: np.ndarray, colors: np.ndarray) -> bytes:
    """Erstellt ein PNTS-Binary (3D Tiles Point Cloud)."""
    positions_bytes = np.ascontiguousarray(xyz, dtype="<f4").tobytes()
    colors_bytes = (colors * 255.0).clip(0, 255).astype(np.uint8).tobytes()

    feature_table_json = json.dumps(
        {
            "POINTS_LENGTH": len(xyz),
            "POSITION": {"byteOffset": 0},
            "RGB": {"byteOffset": len(positions_bytes)},
        }
    ).encode("utf-8")

    # Der Binärblock muss auf einer 8-Byte-Grenze beginnen — der 28-Byte-Header
    # zählt dabei mit, sonst liest Cesium die Float-Positionen unaligned.
    pad = (8 - (_HEADER_SIZE + len(feature_table_json)) % 8) % 8
    feature_table_json += b" " * pad

    feature_table_binary = positions_bytes + colors_bytes
    feature_table_binary += b"\x00" * ((8 - len(feature_table_binary) % 8) % 8)

    total = _HEADER_SIZE + len(feature_table_json) + len(feature_table_binary)

    return (
        b"pnts"
        + struct.pack("<I", 1)
        + struct.pack("<I", total)
        + struct.pack("<I", len(feature_table_json))
        + struct.pack("<I", len(feature_table_binary))
        + struct.pack("<I", 0)   # batchTableJSONByteLength
        + struct.pack("<I", 0)   # batchTableBinaryByteLength
        + feature_table_json
        + feature_table_binary
    )
