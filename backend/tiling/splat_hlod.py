"""
Gaussian-Splat-Octree mit zusammengeführten Eltern (HLOD, `refine: REPLACE`).

**Was sich gegenüber dem ADD-Octree ändert.** Dort trägt jeder Knoten eine
Zufallsauswahl aus seinem Teilbaum, die Kinder ergänzen den Rest. Jeder Splat
behält seine Originalgröße — aus der Ferne sieht man also wenige kleine
Splats mit Lücken dazwischen statt einer gröberen, aber geschlossenen Fläche.
Gemessen (#8, Phase 0): SSIM 0,87 bei der Zitadelle „fern", 0,93 bei der
Kirche.

Hier liegen die Originale nur in den Blättern. Jeder Elternknoten trägt eine
**Zusammenfassung** seiner Kinder: räumlich benachbarte Splats werden zu einem
größeren verschmolzen, der ihre Masse, Ausdehnung, Deckkraft und Farbe
fortschreibt. Der Elternknoten *ersetzt* seine Kinder (REPLACE), statt sich
zu ihnen zu addieren — aus der Ferne liegen damit nicht Eltern und Kinder
übereinander, sondern nur die Eltern.

**Das Zusammenführen (Moment-Matching).** Je Zelle eines Rasters, dessen
Weite so gewählt ist, dass ungefähr die Zielanzahl Zellen belegt ist:

    w_i  = α_i · s_a,i · s_b,i                 Gewicht (Deckkraft × Fläche)
    μ    = Σ w_i x_i / Σ w_i                   Mittelpunkt
    Σ    = Σ w_i (Σ_i + (x_i − μ)(x_i − μ)ᵀ) / Σ w_i − 0     Kovarianz
    α    = min(0,999; Σ α_i A_i / A)           Deckkraft, A = π s_a s_b
    f_dc = Σ w_i f_dc,i / Σ w_i                Farbe (und höhere SH ebenso)

Die Kovarianz enthält neben den Einzelkovarianzen die Streuung der
Mittelpunkte — der zusammengeführte Splat überdeckt damit, was seine Teile
überdeckt haben. Aus Σ werden über die Eigenzerlegung Drehung und Skalen.

**Gewicht Fläche statt Volumen.** Scans und 3DGS-Modelle von Bauwerken
bestehen überwiegend aus flachen Splats (Achsenverhältnisse von 1:100 sind
normal). Ihr Volumen hängt an der dünnsten Achse und ist praktisch
Zufall — mit Volumen gewichtet bestimmen die wenigen dicken Splats die Farbe
einer Wand. Die Fläche der beiden größten Achsen ist das, was man sieht.

**Deckkraft über die Fläche.** Ein zusammengeführter Splat ist größer als
jeder seiner Teile. Hätte er die mittlere Deckkraft, wäre eine Wand aus der
Ferne durchscheinend; mit dem Produkt `1 − Π(1 − α_i)` wäre jeder
Zusammenschluss sofort deckend, auch wenn seine Teile nur einen Bruchteil der
Fläche bedeckten. Σ α_i A_i / A ist die bedeckte Fläche.

**Geometrischer Fehler.** Was beim Zusammenführen verloren geht, ist Detail
unterhalb der Rasterweite. Sie ist deshalb der geometrische Fehler des
Elternknotens; Blätter haben 0. Je Ebene wächst sie um etwa die Wurzel des
Reduktionsfaktors (Flächen: Anzahl ~ 1/Weite²).
"""

import logging
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tiling import spz
from tiling.georef import bounding_box, make_tile
from tiling.gltf import splat_glb

logger = logging.getLogger(__name__)

_MAX_TIEFE = 14


@dataclass(frozen=True)
class HlodOptionen:
    # Splats je Blatt (und Obergrenze je Elternknoten)
    tile_punkte: int = 100_000
    # Reduktion je Ebene: ein Elternknoten trägt ~1/faktor seiner Kinder
    faktor: float = 4.0
    # Faktor auf die Rasterweite als geometrischer Fehler
    ge_faktor: float = 1.0
    box_sigma: float = 3.0
    morton: bool = True


def hlod_optionen() -> HlodOptionen:
    return HlodOptionen(
        # Eigener Name statt SPLAT_TILE_POINTS: der gilt für den ADD-Octree und
        # steht in bestehenden .env-Dateien auf 250 000 — für HLOD gemessen zu
        # groß (mehr und längere Ruckler beim Nachladen, #8 Phase 2).
        tile_punkte=int(os.getenv("SPLAT_HLOD_TILE_POINTS", "100000")),
        faktor=float(os.getenv("SPLAT_MERGE_FAKTOR", "4")),
        ge_faktor=float(os.getenv("SPLAT_HLOD_GE_FAKTOR", "1")),
        box_sigma=float(os.getenv("SPLAT_BOX_SIGMA", "3")),
        morton=os.getenv("SPLAT_MORTON", "1") == "1",
    )


_FELDER = ("xyz", "log_scales", "quat_xyzw", "opacity", "sh_dc", "sh")


def _teil(splats: dict, idx: np.ndarray) -> dict:
    return {k: splats[k][idx] for k in _FELDER if splats.get(k) is not None}


def _verbinde(teile: list) -> dict:
    return {k: np.concatenate([t[k] for t in teile]) for k in teile[0]}


# ── Zusammenführen ───────────────────────────────────────────────────────────


def _rotationen(q_xyzw: np.ndarray) -> np.ndarray:
    """Quaternionen (x, y, z, w) → Drehmatrizen (N, 3, 3)."""
    q = q_xyzw.astype(np.float64)
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    x, y, z, w = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
        np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
        np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1),
    ], axis=1)


def _quaternionen(r: np.ndarray) -> np.ndarray:
    """Drehmatrizen (N, 3, 3) mit det = +1 → Quaternionen (x, y, z, w), w ≥ 0."""
    m00, m11, m22 = r[:, 0, 0], r[:, 1, 1], r[:, 2, 2]
    w = np.sqrt(np.maximum(0.0, 1 + m00 + m11 + m22)) / 2
    x = np.sqrt(np.maximum(0.0, 1 + m00 - m11 - m22)) / 2
    y = np.sqrt(np.maximum(0.0, 1 - m00 + m11 - m22)) / 2
    z = np.sqrt(np.maximum(0.0, 1 - m00 - m11 + m22)) / 2
    x = np.copysign(x, r[:, 2, 1] - r[:, 1, 2])
    y = np.copysign(y, r[:, 0, 2] - r[:, 2, 0])
    z = np.copysign(z, r[:, 1, 0] - r[:, 0, 1])
    q = np.stack([x, y, z, w], axis=1)
    return q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)


def _zellen(xyz: np.ndarray, weite: float) -> tuple[np.ndarray, int]:
    """Zellnummer je Splat im Raster der Weite `weite` → (Nummer, Anzahl)."""
    g = np.floor((xyz - xyz.min(axis=0)) / weite).astype(np.int64)
    schluessel = (g[:, 0] << 42) | (g[:, 1] << 21) | g[:, 2]
    _, nummer = np.unique(schluessel, return_inverse=True)
    return nummer, int(nummer.max()) + 1


def _rasterweite(xyz: np.ndarray, ziel: int) -> tuple[float, np.ndarray, int]:
    """
    Rasterweite, bei der ungefähr `ziel` Zellen belegt sind.

    Startwert aus der Annahme einer Fläche (Belegung ~ 1/Weite²), danach
    höchstens acht Korrekturschritte mit derselben Annahme. Bei räumlich
    verteilten Splats (Laub) wächst die Belegung schneller als 1/Weite² —
    die Schleife fängt das mit ab.
    """
    ausdehnung = np.maximum(xyz.max(axis=0) - xyz.min(axis=0), 1e-6)
    flaeche = sorted(ausdehnung)[1] * sorted(ausdehnung)[2]
    # Untergrenze: höchstens 2^20 Zellen je Achse, sonst laufen die Schlüssel über
    kleinste = float(ausdehnung.max()) / (1 << 20)
    weite = max(math.sqrt(flaeche / max(ziel, 1)), kleinste)
    nummer, n = _zellen(xyz, weite)
    for _ in range(24):
        if abs(n - ziel) <= 0.1 * ziel or (n <= ziel and ziel < 10):
            break
        # zu viele Zellen: mindestens um 20 % vergröbern, sonst kriecht die
        # Schleife bei linienförmigen Splatsätzen (Belegung ~ 1/Weite)
        faktor = math.sqrt(n / ziel)
        faktor = max(faktor, 1.2) if n > ziel else min(faktor, 0.95)
        weite = max(weite * faktor, kleinste)
        nummer, n = _zellen(xyz, weite)
    return weite, nummer, n


def zusammenfuehren(teil: dict, ziel: int) -> tuple[dict, float]:
    """Führt einen Splatsatz auf ungefähr `ziel` Splats zusammen → (Satz, Rasterweite)."""
    xyz = teil["xyz"].astype(np.float64)
    if len(xyz) <= ziel:
        return teil, 0.0
    weite, zelle, n = _rasterweite(xyz, ziel)

    s = np.exp(teil["log_scales"].astype(np.float64))
    s_sort = np.sort(s, axis=1)
    flaeche = s_sort[:, 1] * s_sort[:, 2]
    alpha = 1.0 / (1.0 + np.exp(-teil["opacity"].astype(np.float64)))
    w = np.maximum(alpha * flaeche, 1e-30)
    W = np.bincount(zelle, w, n)

    def mittel(v):
        return np.bincount(zelle, w * v, n) / W

    mu = np.stack([mittel(xyz[:, a]) for a in range(3)], axis=1)

    rot = _rotationen(teil["quat_xyzw"])
    kov_i = np.einsum("nij,nj,nkj->nik", rot, s * s, rot)
    # zweites Moment um den Zellmittelpunkt: Σ_i + (x_i − μ)(x_i − μ)ᵀ
    d = xyz - mu[zelle]
    kov = np.zeros((n, 3, 3))
    for a in range(3):
        for b in range(a, 3):
            m = mittel(kov_i[:, a, b] + d[:, a] * d[:, b])
            kov[:, a, b] = m
            kov[:, b, a] = m

    eigen, vektoren = np.linalg.eigh(kov)
    skalen = np.sqrt(np.maximum(eigen, 1e-12))
    vorzeichen = np.sign(np.linalg.det(vektoren))
    vektoren[:, :, 2] *= vorzeichen[:, None]

    # Deckkraft: bedeckte Fläche der Teile durch die Fläche des Ganzen
    bedeckt = np.bincount(zelle, alpha * np.pi * flaeche, n)
    a_neu = np.pi * skalen[:, 1] * skalen[:, 2]
    alpha_neu = np.clip(bedeckt / np.maximum(a_neu, 1e-30), 1e-4, 0.999)

    ergebnis = {
        "xyz": mu,
        "log_scales": np.log(skalen).astype(np.float32),
        "quat_xyzw": _quaternionen(vektoren).astype(np.float32),
        "opacity": np.log(alpha_neu / (1 - alpha_neu)).astype(np.float32),
        "sh_dc": np.stack([mittel(teil["sh_dc"][:, c].astype(np.float64)) for c in range(3)],
                          axis=1).astype(np.float32),
    }
    if teil.get("sh") is not None:
        sh = teil["sh"].astype(np.float64)
        ergebnis["sh"] = np.stack(
            [np.stack([mittel(sh[:, k, c]) for c in range(3)], axis=-1) for k in range(sh.shape[1])],
            axis=1,
        ).astype(np.float32)
    return ergebnis, weite


# ── Octree ───────────────────────────────────────────────────────────────────


def _oktanten(xyz: np.ndarray, idx: np.ndarray, mitte: np.ndarray) -> list:
    p = xyz[idx]
    o = ((p[:, 0] >= mitte[0]).astype(np.uint8)
         | ((p[:, 1] >= mitte[1]).astype(np.uint8) << 1)
         | ((p[:, 2] >= mitte[2]).astype(np.uint8) << 2))
    return [idx[o == k] for k in range(8) if np.any(o == k)]


class HlodSchreiber:
    def __init__(self, out_dir: Path, splats: dict, opt: HlodOptionen, sh_grad: int,
                 morton_ordnung):
        self.out_dir = out_dir
        self.splats = splats
        self.opt = opt
        self.sh_grad = sh_grad
        self.morton_ordnung = morton_ordnung
        self.tiles = 0
        self.ebenen: dict = {}

    def baue(self, idx: np.ndarray, tiefe: int, eltern_ursprung: np.ndarray,
             ursprung: np.ndarray | None = None) -> tuple[dict, dict, np.ndarray, np.ndarray]:
        """→ (Tile, Inhalt, Kasten-lo, Kasten-hi); Kasten in Modellkoordinaten."""
        xyz = self.splats["xyz"]
        p = xyz[idx]
        lo_c, hi_c = p.min(axis=0), p.max(axis=0)
        if ursprung is None:
            ursprung = (lo_c + hi_c) / 2.0

        if len(idx) <= self.opt.tile_punkte or tiefe >= _MAX_TIEFE:
            inhalt = _teil(self.splats, idx)
            kinder, weite = [], 0.0
            lo, hi = self._kasten(inhalt)
        else:
            teile = _oktanten(xyz, idx, (lo_c + hi_c) / 2.0)
            if len(teile) == 1:
                # alle in einem Oktanten: am Median teilen statt endlos abzusteigen
                a = int(np.argmax(hi_c - lo_c))
                m = np.median(p[:, a])
                teile = [t for t in (idx[p[:, a] < m], idx[p[:, a] >= m]) if len(t)]
            ergebnisse = [self.baue(t, tiefe + 1, ursprung) for t in teile]
            kinder = [e[0] for e in ergebnisse]
            gesamt = _verbinde([e[1] for e in ergebnisse])
            ziel = min(self.opt.tile_punkte,
                       max(1, int(math.ceil(len(gesamt["xyz"]) / self.opt.faktor))))
            inhalt, weite = zusammenfuehren(gesamt, ziel)
            lo = np.min([e[2] for e in ergebnisse] + [self._kasten(inhalt)[0]], axis=0)
            hi = np.max([e[3] for e in ergebnisse] + [self._kasten(inhalt)[1]], axis=0)

        uri = self._schreibe(inhalt, ursprung)
        ge = self.opt.ge_faktor * weite if kinder else 0.0
        e = self.ebenen.setdefault(tiefe, {"tiles": 0, "splats": 0, "weite": []})
        e["tiles"] += 1
        e["splats"] += len(inhalt["xyz"])
        e["weite"].append(weite)

        tile = make_tile(center=(0, 0, 0), half=(1, 1, 1), geometric_error=ge,
                         content_uri=uri, children=kinder,
                         translation=ursprung - eltern_ursprung)
        tile["refine"] = "REPLACE"
        tile["boundingVolume"] = bounding_box((lo + hi) / 2.0 - ursprung,
                                              np.maximum((hi - lo) / 2.0, 1e-3))
        return tile, inhalt, lo, hi

    def _kasten(self, inhalt: dict):
        r = self.opt.box_sigma * np.exp(inhalt["log_scales"].max(axis=1).astype(np.float64))
        x = inhalt["xyz"]
        return (x - r[:, None]).min(axis=0), (x + r[:, None]).max(axis=0)

    def _schreibe(self, inhalt: dict, ursprung: np.ndarray) -> str:
        lokal = (inhalt["xyz"] - ursprung).astype(np.float32)
        ordnung = self.morton_ordnung(lokal) if self.opt.morton else np.arange(len(lokal))
        lokal = lokal[ordnung]
        sh = inhalt.get("sh")
        blob = spz.encode(
            lokal,
            inhalt["log_scales"][ordnung],
            inhalt["quat_xyzw"][ordnung],
            inhalt["opacity"][ordnung],
            inhalt["sh_dc"][ordnung],
            sh=None if sh is None else sh[ordnung],
        )
        name = f"tile_{self.tiles}.glb"
        (self.out_dir / name).write_bytes(
            splat_glb(blob, len(lokal), lokal.min(axis=0), lokal.max(axis=0),
                      sh_grad=self.sh_grad))
        self.tiles += 1
        return name
