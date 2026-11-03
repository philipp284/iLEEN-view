"""
Laserscan → 3D Gaussian Splatting, ohne Training.

Jeder Punkt wird zu einem flachen, flächenausgerichteten Gaussian („Surfel“). Das
Ergebnis ist metrisch exakt und entsteht in Sekunden bis Minuten statt Stunden —
dafür enthält es keine blickabhängige Farbe und schließt keine Lücken. Eine
Punktwolke trägt, egal wie genau, keine Bildinformation; wer die braucht, trainiert
aus Fotos (`worker.py`).

Portiert aus `~/Projekte/Scan23dgs/scan2gs.py`, derselbe Rechenweg und dieselben
Voreinstellungen (Surfels aus lokaler PCA, `scale_factor` 0,5, `flatness` 0,1,
Deckkraft 0,98). Geändert hat sich, **wie** gerechnet wird:

* **Kein Open3D.** Voxel-Mittelung, statistischer Ausreißerfilter und lokale PCA
  waren die drei Stellen, an denen das Original Open3D brauchte. Das Backend-Image
  hat es nicht, und es wäre das größte Paket darin. Alle drei sind hier NumPy/SciPy;
  der kNN-Aufruf ist **einer** für beides (Ausreißer und PCA), nicht zwei.
* **Gestreamt.** Das Original lädt die ganze Wolke. Ein 5-mm-Scan mit 300 Mio.
  Punkten hat im Speicher nichts zu suchen: gelesen wird in Blöcken, jeder Block
  wird sofort auf ein Voxelraster reduziert.
* **Voxelgröße automatisch.** Ohne Vorgabe wird so lange vergröbert, bis nicht
  mehr als `max_splats` übrig sind. Das Original rechnete mit einer festen Größe
  oder gar keiner und scheiterte dann an der Datei, nicht an der Einstellung.
* **Z-up im Header.** `Vertical axis: z` steht als Kommentar in der PLY. Der
  Splat-Handler (`tiling/formats/splat.py`) dreht bei `y` die Szene; Laserscans
  sind aber immer Z-up, und ohne den Kommentar bliebe es der Raterei überlassen.

Format (Kerbl et al. 2023, identisch zu `Scan23dgs`): `f_dc = (rgb − 0,5)/C0`,
`scale = log σ` (Meter), `opacity = logit α`, Quaternion `(w, x, y, z)`.

Koordinaten-Offset: Scans liegen in Landeskoordinaten (10⁵–10⁶ m), und float32
verliert dort Zentimeter. Die Wolke wird auf ihren Schwerpunkt zentriert; der
Versatz steht im Ergebnis (`offset_xyz`) und gehört zwingend zur Datei.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

import numpy as np

logger = logging.getLogger(__name__)

C0 = 0.28209479177387814  # Y_0^0, Konstante der 0. SH-Ordnung

# Punkte je gelesenem Block. Groß genug, dass der Schleifenaufwand nichts kostet,
# klein genug, dass ein Block samt Zwischenfeldern unter einem Gigabyte bleibt.
_BLOCK = 4_000_000

# Wie viel größer als das Ziel die reduzierte Wolke zwischendurch werden darf,
# bevor die Voxel vergröbert werden. Verhindert, dass ein riesiger Scan erst
# komplett bei der feinen Voxelgröße landet und dann erst dünner wird.
_PUFFER = 2.5

# Startvoxel, wenn der Aufrufer keinen vorgibt. Ein Zentimeter ist die Auflösung,
# ab der ein Surfel im Viewer ohnehin nicht mehr unterscheidbar ist; vergröbert
# wird bei Bedarf.
_VOXEL_START = 0.01


@dataclass
class Optionen:
    """Stellschrauben. Die Voreinstellungen sind die des Original-Notebooks."""

    voxel_m: float | None = None     # None = automatisch (siehe `max_splats`)
    max_splats: int = 6_000_000      # Obergrenze, bis zu der die Voxel vergröbert werden
    ausreisser: bool = True          # statistischer Ausreißerfilter
    k: int = 16                      # Nachbarn für Ausreißer, Normale und PCA
    modus: str = "pca"               # "pca" (anisotrope Surfels) | "scheibe" (runde)
    scale_factor: float = 0.5        # pca: σ_tangential = f · √Eigenwert
    radius_factor: float = 0.7       # scheibe: σ_tangential = f · mittlerer kNN-Abstand
    flatness: float = 0.1            # σ_normal = f · σ_tangential
    opacity: float = 0.98
    std_ratio: float = 2.5           # Ausreißer: mittlerer kNN-Abstand > Mittel + f · Streuung
    sh_grad: int = 0                 # 0 = kompakt; 3 = f_rest als Nullen für fremde Werkzeuge


# ── Laden ────────────────────────────────────────────────────────────────────


class _Quelle:
    """Eine Punktwolke als Folge von Blöcken, mit den Grenzen vorab."""

    def __init__(self, pfad: Path):
        self.pfad = pfad
        self.suffix = pfad.suffix.lower()
        self.anzahl = 0
        self.mins = self.maxs = None
        self.hat_farbe = False
        self.hat_normalen = False
        self._inten_grenzen: tuple[float, float] | None = None
        self._vorbereiten()

    # -- Vorbereitung: Grenzen und Merkmale ohne die Punkte zu halten

    def _vorbereiten(self):
        if self.suffix in (".las", ".laz"):
            import laspy

            with laspy.open(self.pfad) as r:
                h = r.header
                self.anzahl = int(h.point_count)
                self.mins, self.maxs = np.array(h.mins, float), np.array(h.maxs, float)
                dims = set(h.point_format.dimension_names)
            self.hat_normalen = any({a, b, c} <= dims for a, b, c in _NORMALEN_LAS)
            self.hat_farbe = {"red", "green", "blue"} <= dims or "intensity" in dims
        elif self.suffix == ".ply":
            self._ply = _lese_ply(self.pfad)
            xyz = self._ply[0]
            self.anzahl = len(xyz)
            self.mins, self.maxs = xyz.min(axis=0), xyz.max(axis=0)
            self.hat_farbe = self._ply[1] is not None
            self.hat_normalen = self._ply[2] is not None
        elif self.suffix in (".xyz", ".pts", ".txt"):
            lo = np.full(3, np.inf)
            hi = np.full(3, -np.inf)
            n = 0
            for xyz, rgb, _ in self._text_bloecke():
                lo, hi, n = np.minimum(lo, xyz.min(axis=0)), np.maximum(hi, xyz.max(axis=0)), n + len(xyz)
                self.hat_farbe = self.hat_farbe or rgb is not None
            self.anzahl, self.mins, self.maxs = n, lo, hi
        else:
            raise ValueError(f"Punktwolken-Format '{self.suffix}' wird nicht gelesen.")
        if self.anzahl == 0:
            raise ValueError("Die Datei enthält keine Punkte.")

    # -- Blöcke

    def bloecke(self) -> Iterator[tuple[np.ndarray, np.ndarray | None, np.ndarray | None]]:
        if self.suffix in (".las", ".laz"):
            yield from self._las_bloecke()
        elif self.suffix == ".ply":
            xyz, rgb, nrm = self._ply
            for i in range(0, len(xyz), _BLOCK):
                yield (xyz[i:i + _BLOCK],
                       None if rgb is None else rgb[i:i + _BLOCK],
                       None if nrm is None else nrm[i:i + _BLOCK])
        else:
            yield from self._text_bloecke()

    def _las_bloecke(self):
        import laspy

        with laspy.open(self.pfad) as r:
            dims = set(r.header.point_format.dimension_names)
            namen = next(((a, b, c) for a, b, c in _NORMALEN_LAS if {a, b, c} <= dims), None)
            for pts in r.chunk_iterator(_BLOCK):
                xyz = np.column_stack([pts.x, pts.y, pts.z]).astype(np.float64)
                rgb = None
                if {"red", "green", "blue"} <= dims:
                    roh = np.column_stack([pts.red, pts.green, pts.blue]).astype(np.float32)
                    if roh.max() > roh.min():
                        rgb = roh / (65535.0 if roh.max() > 255 else 255.0)
                if rgb is None and "intensity" in dims:
                    rgb = self._intensitaet(np.asarray(pts.intensity, dtype=np.float32))
                nrm = None
                if namen:
                    nrm = np.column_stack([pts[namen[0]], pts[namen[1]], pts[namen[2]]]).astype(np.float32)
                yield xyz, rgb, nrm

    def _intensitaet(self, inten: np.ndarray) -> np.ndarray | None:
        """Intensität → Grau. Die Grenzen kommen vom ersten Block und gelten für alle,
        sonst bekäme jeder Block sein eigenes Grau und die Nahtstellen sichtbare Kanten."""
        if self._inten_grenzen is None:
            lo, hi = np.percentile(inten, [2, 98])
            self._inten_grenzen = (float(lo), float(hi))
        lo, hi = self._inten_grenzen
        if hi <= lo:
            return None
        g = np.clip((inten - lo) / (hi - lo), 0, 1)
        return np.repeat(g[:, None], 3, axis=1)

    def _text_bloecke(self):
        """XYZ/PTS/TXT: Spalten x y z [Intensität] [r g b]. PTS beginnt mit der Punktzahl."""
        import itertools

        with self.pfad.open("r") as f:
            erste = f.readline()
            if not erste.strip().replace(".", "").isdigit():
                f.seek(0)
            while True:
                zeilen = list(itertools.islice(f, _BLOCK))
                if not zeilen:
                    return
                a = np.loadtxt(zeilen, dtype=np.float64, ndmin=2)
                xyz, rgb = a[:, :3], None
                if a.shape[1] >= 6:
                    farbe = a[:, -3:]
                    rgb = (farbe / (255.0 if farbe.max() > 1.0 else 1.0)).astype(np.float32)
                elif a.shape[1] == 4:
                    rgb = self._intensitaet(a[:, 3].astype(np.float32))
                yield xyz, rgb, None


_NORMALEN_LAS = (("NormalX", "NormalY", "NormalZ"), ("nx", "ny", "nz"), ("normal_x", "normal_y", "normal_z"))


def _lese_ply(pfad: Path):
    """Punktwolken-PLY (x y z, optional red/green/blue, nx/ny/nz) → Arrays."""
    from plyfile import PlyData

    el = PlyData.read(str(pfad))["vertex"]
    namen = set(el.data.dtype.names or ())
    xyz = np.column_stack([el["x"], el["y"], el["z"]]).astype(np.float64)
    rgb = None
    if {"red", "green", "blue"} <= namen:
        roh = np.column_stack([el["red"], el["green"], el["blue"]]).astype(np.float32)
        rgb = roh / (255.0 if roh.max() > 1.0 else 1.0)
    nrm = None
    if {"nx", "ny", "nz"} <= namen:
        nrm = np.column_stack([el["nx"], el["ny"], el["nz"]]).astype(np.float32)
        if not np.any(nrm):
            nrm = None
    return xyz, rgb, nrm


# ── Voxelraster ──────────────────────────────────────────────────────────────


class _Raster:
    """
    Voxel-Mittelung mit wachsender Zellgröße.

    Gehalten werden nur Summen je Zelle (Position, Farbe, Normale, Anzahl) — der
    Mittelwert entsteht erst am Ende. Wird die Zellgröße vergröbert, werden die
    bestehenden Zellen aus ihren Mittelpunkten neu eingeordnet; das ist nicht
    ganz dasselbe wie von Anfang an grob zu rastern, aber auf Voxelgröße genau.
    """

    def __init__(self, voxel: float, mins: np.ndarray, hat_farbe: bool, hat_normalen: bool):
        self.voxel = voxel
        self.mins = mins
        self.farbe = hat_farbe
        self.normale = hat_normalen
        self._leer()

    def _leer(self):
        self.schluessel = np.empty(0, np.int64)
        self.pos = np.empty((0, 3))
        self.rgb = np.empty((0, 3))
        self.nrm = np.empty((0, 3))
        self.n = np.empty(0)

    def _keys(self, xyz: np.ndarray) -> np.ndarray:
        i = np.floor((xyz - self.mins) / self.voxel).astype(np.int64)
        # Obergrenzen je Achse: Ein Schlüssel passt in int64, solange das Produkt
        # der Ausdehnungen unter 9·10¹⁸ bleibt — 2 Mio. Zellen je Achse reichen.
        return (i[:, 0] * _DIM + i[:, 1]) * _DIM + i[:, 2]

    def _verdichten(self, keys, pos, rgb, nrm, n):
        uniq, inv = np.unique(keys, return_inverse=True)
        m = len(uniq)
        out = [uniq,
               np.stack([np.bincount(inv, pos[:, a], m) for a in range(3)], axis=1)]
        out.append(np.stack([np.bincount(inv, rgb[:, a], m) for a in range(3)], axis=1) if self.farbe
                   else np.empty((m, 3)))
        out.append(np.stack([np.bincount(inv, nrm[:, a], m) for a in range(3)], axis=1) if self.normale
                   else np.empty((m, 3)))
        out.append(np.bincount(inv, n, m))
        return out

    def hinzu(self, xyz, rgb, nrm):
        n = np.ones(len(xyz))
        k, p, c, nn, cnt = self._verdichten(
            self._keys(xyz), xyz, rgb if rgb is not None else np.empty((len(xyz), 3)),
            nrm if nrm is not None else np.empty((len(xyz), 3)), n)
        self.schluessel = np.concatenate([self.schluessel, k])
        self.pos = np.vstack([self.pos, p])
        self.rgb = np.vstack([self.rgb, c])
        self.nrm = np.vstack([self.nrm, nn])
        self.n = np.concatenate([self.n, cnt])
        self._zusammenfuehren()

    def _zusammenfuehren(self):
        """Gleiche Zellen aus verschiedenen Blöcken zusammenlegen."""
        if len(self.schluessel) == 0:
            return
        k, p, c, nn, cnt = self._verdichten(self.schluessel, self.pos, self.rgb, self.nrm, self.n)
        self.schluessel, self.pos, self.rgb, self.nrm, self.n = k, p, c, nn, cnt

    def vergroebern(self, neu: float):
        """Zellen auf größere Voxel umlegen (aus ihren Mittelpunkten)."""
        mittel = self.pos / self.n[:, None]
        self.voxel = neu
        k, p, c, nn, cnt = self._verdichten(
            self._keys(mittel), self.pos, self.rgb, self.nrm, self.n)
        self.schluessel, self.pos, self.rgb, self.nrm, self.n = k, p, c, nn, cnt

    def punkte(self):
        n = self.n[:, None]
        pos = self.pos / n
        rgb = (self.rgb / n).astype(np.float32) if self.farbe else None
        nrm = None
        if self.normale:
            nrm = self.nrm / n
            laenge = np.linalg.norm(nrm, axis=1, keepdims=True)
            nrm = (nrm / np.maximum(laenge, 1e-12)).astype(np.float32)
        return pos, rgb, nrm

    def __len__(self):
        return len(self.schluessel)


_DIM = 2_097_152  # 2^21 Zellen je Achse


# ── Lokale Geometrie ─────────────────────────────────────────────────────────


def _nachbarn(xyz: np.ndarray, k: int, fortschritt: Callable[[float], None] | None = None):
    """
    Die k nächsten Nachbarn jedes Punkts — **ein** Aufruf für Ausreißerfilter und PCA.

    Gibt `(index (N, k) int32, mittlerer Abstand über k (N,), mittlerer Abstand über 8 (N,))`
    zurück. Blockweise, damit die Abstandsmatrix (N·k·8 Byte) nicht auf einmal im
    Speicher steht; die Indizes sind int32 und bleiben liegen (6 Mio. Punkte, k = 16:
    400 MB), weil die PCA sie danach noch einmal braucht.
    """
    from scipy.spatial import cKDTree

    n = len(xyz)
    baum = cKDTree(xyz)
    idx = np.empty((n, k), np.int32)
    md_k = np.empty(n, np.float32)
    md_8 = np.empty(n, np.float32)
    block = 400_000
    for a in range(0, n, block):
        d, i = baum.query(xyz[a:a + block], k=k + 1, workers=-1)
        idx[a:a + block] = i[:, 1:]                 # Spalte 0 ist der Punkt selbst
        md_k[a:a + block] = d[:, 1:].mean(axis=1)
        md_8[a:a + block] = d[:, 1:min(9, k + 1)].mean(axis=1)
        if fortschritt:
            fortschritt(min(1.0, (a + block) / n))
    return idx, md_k, md_8


def _pca(xyz: np.ndarray, idx: np.ndarray, selbst: np.ndarray | None = None):
    """
    Lokale Hauptachsen aus den Nachbarn: `(Eigenwerte (N,3) aufsteigend, Eigenvektoren (N,3,3))`.
    Spalte 0 der Eigenvektoren ist die Normale (kleinste Varianz). `selbst` sind die
    Indizes der Punkte, zu denen die Zeilen von `idx` gehören (Standard: 0…N−1).
    """
    n = len(idx)                       # eine Zeile je Punkt, für den Surfels entstehen
    ew = np.empty((n, 3))
    ev = np.empty((n, 3, 3))
    block = 250_000
    for a in range(0, n, block):
        # Der Punkt selbst gehört zu seiner Nachbarschaft: Open3Ds `estimate_covariances`
        # zählt ihn mit, und das Original rechnet damit. k = 16 heißt dort 16 Punkte
        # *einschließlich* seiner selbst — ohne ihn lägen die Surfels 6 % zu groß.
        eigene = (selbst if selbst is not None else np.arange(n))[a:a + block]
        nb = xyz[np.concatenate([eigene[:, None], idx[a:a + block, :-1]], axis=1)]   # (B, k, 3)
        nb = nb - nb.mean(axis=1, keepdims=True)
        cov = np.einsum("bki,bkj->bij", nb, nb) / nb.shape[1]
        w, v = np.linalg.eigh(cov)
        ew[a:a + block], ev[a:a + block] = np.maximum(w, 0.0), v
    return ew, ev


def _quaternionen(r: np.ndarray) -> np.ndarray:
    """Drehmatrizen (N,3,3) → Quaternionen (N,4) als (w, x, y, z)."""
    n = r.shape[0]
    q = np.empty((n, 4))
    m00, m01, m02 = r[:, 0, 0], r[:, 0, 1], r[:, 0, 2]
    m10, m11, m12 = r[:, 1, 0], r[:, 1, 1], r[:, 1, 2]
    m20, m21, m22 = r[:, 2, 0], r[:, 2, 1], r[:, 2, 2]
    spur = m00 + m11 + m22
    c0 = spur > 0
    c1 = ~c0 & (m00 >= m11) & (m00 >= m22)
    c2 = ~c0 & ~c1 & (m11 >= m22)
    c3 = ~c0 & ~c1 & ~c2

    s = np.sqrt(np.maximum(spur[c0] + 1.0, 0)) * 2
    q[c0] = np.column_stack([s / 4, (m21[c0] - m12[c0]) / s, (m02[c0] - m20[c0]) / s, (m10[c0] - m01[c0]) / s])
    s = np.sqrt(np.maximum(1.0 + m00[c1] - m11[c1] - m22[c1], 0)) * 2
    q[c1] = np.column_stack([(m21[c1] - m12[c1]) / s, s / 4, (m01[c1] + m10[c1]) / s, (m02[c1] + m20[c1]) / s])
    s = np.sqrt(np.maximum(1.0 - m00[c2] + m11[c2] - m22[c2], 0)) * 2
    q[c2] = np.column_stack([(m02[c2] - m20[c2]) / s, (m01[c2] + m10[c2]) / s, s / 4, (m12[c2] + m21[c2]) / s])
    s = np.sqrt(np.maximum(1.0 - m00[c3] - m11[c3] + m22[c3], 0)) * 2
    q[c3] = np.column_stack([(m10[c3] - m01[c3]) / s, (m02[c3] + m20[c3]) / s, (m12[c3] + m21[c3]) / s, s / 4])
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def surfels_aus_pca(ew: np.ndarray, ev: np.ndarray, scale_factor: float = 0.5,
                    flatness: float = 0.1, max_stretch: float = 3.0):
    """
    Anisotrope Surfels: länglich an Kanten und Leitungen, rund auf Flächen.

    σ_tangential = scale_factor · √Eigenwert der beiden Tangentialachsen, gekappt auf
    `max_stretch` × Median (unterdrückt gestreckte Splats an Rändern),
    σ_normal = flatness · kleinere Tangentialachse.
    """
    r = ev[:, :, [2, 1, 0]]                       # Spalten: größte Tangente, zweite, Normale
    neg = np.linalg.det(r) < 0
    r[neg, :, 2] *= -1.0                          # eigh garantiert keine rechtshändige Basis
    quat = _quaternionen(r)
    s_t = scale_factor * np.sqrt(ew[:, [2, 1]])
    cap = max_stretch * max(float(np.median(s_t[:, 0])), 1e-9)
    s_t = np.clip(s_t, 1e-6, cap)
    return quat, np.column_stack([s_t, np.maximum(flatness * s_t[:, 1], 1e-6)])


def surfels_aus_normalen(nrm: np.ndarray, mittlerer_abstand: np.ndarray,
                         radius_factor: float = 0.7, flatness: float = 0.1):
    """Runde Scheiben senkrecht zur Normale: σ_tangential = f · lokaler Punktabstand."""
    n = nrm / np.linalg.norm(nrm, axis=1, keepdims=True)
    a = np.zeros_like(n)
    nutze_x = np.abs(n[:, 0]) < 0.9
    a[nutze_x, 0] = 1.0
    a[~nutze_x, 1] = 1.0
    t1 = np.cross(a, n)
    t1 /= np.linalg.norm(t1, axis=1, keepdims=True)
    t2 = np.cross(n, t1)
    quat = _quaternionen(np.stack([t1, t2, n], axis=2))
    s_t = radius_factor * mittlerer_abstand
    return quat, np.column_stack([s_t, s_t, np.maximum(flatness * s_t, 1e-6)])


# ── Ausgabe ──────────────────────────────────────────────────────────────────


def schreibe_ply(pfad: Path, xyz, quat, scales, opacity, rgb=None, nrm=None, sh_grad: int = 0) -> int:
    """Standard-3DGS-PLY, binary little endian, float32. Header meldet Z als Hochachse."""
    from plyfile import PlyData, PlyElement

    n = len(xyz)
    if rgb is None:
        rgb = np.full((n, 3), 0.5, dtype=np.float32)
    f_dc = (rgb - 0.5) / C0
    n_rest = 3 * ((sh_grad + 1) ** 2 - 1)
    namen = (["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
             + [f"f_rest_{i}" for i in range(n_rest)]
             + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    d = np.zeros(n, dtype=[(a, "f4") for a in namen])
    d["x"], d["y"], d["z"] = xyz.T.astype(np.float32)
    if nrm is not None:
        d["nx"], d["ny"], d["nz"] = nrm.T.astype(np.float32)
    for i in range(3):
        d[f"f_dc_{i}"] = f_dc[:, i]
        d[f"scale_{i}"] = np.log(scales[:, i])
    op = np.clip(np.broadcast_to(np.asarray(opacity, np.float64), (n,)), 1e-6, 1 - 1e-6)
    d["opacity"] = np.log(op / (1.0 - op))
    for i in range(4):
        d[f"rot_{i}"] = quat[:, i]
    PlyData([PlyElement.describe(d, "vertex")],
            comments=["Exported from iLEEN scan2gs", "Vertical axis: z", f"SH degree: {sh_grad}"]
            ).write(str(pfad))
    return Path(pfad).stat().st_size


# ── Ablauf ───────────────────────────────────────────────────────────────────


def konvertiere(quelle: Path, ziel: Path, opt: Optionen | None = None,
                fortschritt: Callable[[str, float], None] | None = None) -> dict:
    """
    Punktwolke `quelle` (LAS/LAZ/XYZ/PTS/PLY) → 3DGS-PLY `ziel`.

    Gibt einen Bericht zurück: Punkte vorher/nachher, Voxelgröße, Ausreißer,
    `offset_xyz` (Weltkoordinate = lokal + Versatz), Grenzen im lokalen System und
    ob die Quelle Farbe hatte. `fortschritt(stufe, anteil)` darf None sein.
    """
    opt = opt or Optionen()
    meld = fortschritt or (lambda *_: None)
    quelle, ziel = Path(quelle), Path(ziel)

    q = _Quelle(quelle)
    logger.info(f"scan2gs: {quelle.name}, {q.anzahl:,} Punkte, Farbe={q.hat_farbe}, Normalen={q.hat_normalen}")

    voxel = opt.voxel_m or _VOXEL_START
    raster = _Raster(voxel, q.mins - 1e-6, q.hat_farbe, q.hat_normalen)
    gelesen = 0
    for xyz, rgb, nrm in q.bloecke():
        raster.hinzu(xyz, rgb, nrm)
        gelesen += len(xyz)
        # Automatik: wächst die reduzierte Wolke über den Puffer, gröber rastern.
        while opt.voxel_m is None and len(raster) > opt.max_splats * _PUFFER:
            neu = raster.voxel * max(1.25, math.sqrt(len(raster) / (opt.max_splats * _PUFFER)))
            logger.info(f"scan2gs: {len(raster):,} Zellen bei {raster.voxel * 1000:.1f} mm → {neu * 1000:.1f} mm")
            raster.vergroebern(neu)
        meld("voxel", min(1.0, gelesen / q.anzahl))

    if opt.voxel_m is None:
        while len(raster) > opt.max_splats:
            neu = raster.voxel * max(1.05, math.sqrt(len(raster) / opt.max_splats) * 1.05)
            raster.vergroebern(neu)
    pos, rgb, nrm = raster.punkte()
    nach_voxel = len(pos)
    logger.info(f"scan2gs: Voxel {raster.voxel * 1000:.1f} mm → {nach_voxel:,} Punkte")
    if nach_voxel < opt.k + 2:
        raise ValueError(f"Nach dem Rastern bleiben nur {nach_voxel} Punkte — zu wenig für Surfels.")

    offset = pos.mean(axis=0)
    xyz = pos - offset                                   # float64, um den Schwerpunkt

    idx, md_k, md_8 = _nachbarn(xyz, opt.k, lambda a: meld("nachbarn", a))

    keep = np.ones(nach_voxel, bool)
    if opt.ausreisser:
        grenze = float(md_k.mean() + opt.std_ratio * md_k.std())
        keep = md_k <= grenze
        logger.info(f"scan2gs: {int((~keep).sum()):,} Ausreißer (mittlerer Abstand > {grenze * 1000:.1f} mm)")
    xyz_k, md8_k = xyz[keep], md_8[keep]
    rgb_k = rgb[keep] if rgb is not None else None
    nrm_k = nrm[keep] if nrm is not None else None

    meld("surfels", 0.0)
    if opt.modus == "scheibe" and nrm_k is not None:
        quat, scales = surfels_aus_normalen(nrm_k, md8_k, opt.radius_factor, opt.flatness)
    else:
        ew, ev = _pca(xyz, idx[keep], np.flatnonzero(keep))  # Nachbarn dürfen Ausreißer sein: sie liegen in `xyz`
        quat, scales = surfels_aus_pca(ew, ev, opt.scale_factor, opt.flatness)
    meld("surfels", 1.0)

    groesse = schreibe_ply(ziel, xyz_k, quat, scales, opt.opacity, rgb_k, nrm_k, opt.sh_grad)
    bericht = {
        "quelle": quelle.name,
        "punkte_gelesen": int(q.anzahl),
        "voxel_m": round(float(raster.voxel), 5),
        "punkte_nach_voxel": int(nach_voxel),
        "ausreisser": int((~keep).sum()),
        "splats": int(len(xyz_k)),
        "bytes": int(groesse),
        "offset_xyz": [float(v) for v in offset],
        "lokal_lo": [float(v) for v in xyz_k.min(axis=0)],
        "lokal_hi": [float(v) for v in xyz_k.max(axis=0)],
        "mit_farbe": bool(q.hat_farbe),
        "sigma_median_mm": round(float(np.median(scales[:, 0])) * 1000, 2),
        "modus": opt.modus if (opt.modus != "scheibe" or nrm_k is not None) else "pca",
    }
    logger.info(f"scan2gs: {bericht['splats']:,} Surfels, σ_t {bericht['sigma_median_mm']} mm, "
                f"{groesse / 1e6:.0f} MB → {ziel.name}")
    return bericht


def schreibe_versatz(pfad: Path, offset) -> None:
    """Sidecar wie im Original: Weltkoordinate = lokale Koordinate + offset_xyz."""
    Path(pfad).write_text(json.dumps(
        {"offset_xyz": [float(v) for v in offset],
         "hint": "Weltkoordinate = lokale Koordinate + offset_xyz"}, indent=2))
