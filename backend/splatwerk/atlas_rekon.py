"""
Atlas-Rekonstruktion: aus Kameras und Tiefen von ``images2PosedRGBD`` ein Modell für Brush.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Reine Rechnung, ohne Netz und ohne COLMAP — geprüft in ``tests/test_splat_atlas.py``.
Der Worker (Verfahren „atlas") ruft sie zwischen dem Auftrag an World Labs und dem
Training auf. Die Stellen, an denen es still schiefgehen kann:

**Das Raster.** Atlas gibt Bild, Tiefe und Intrinsik auf ``targetResolution`` zurück.
Wie es dorthin kommt, steht nirgends — gemessen am ersten echten Lauf (2026-10-21,
iPhone 17 Pro, 1200×1600 hochgeladen, Raster 960×1280):

* Atlas nimmt die **mittleren ~75,4 % je Achse** des hochgeladenen Bildes und skaliert sie
  auf das Raster: ein Zoom um 1,33, und die Intrinsik gilt für diesen Ausschnitt
  (fx ≈ 1200 statt 850 px). Bei allen neun Hochformatbildern gleich (± 0,1 %).
* Ein Bild, dessen Seitenverhältnis **nicht** zum Raster passt, wird **verzerrt**, nicht
  beschnitten (Querformat im Hochformat-Auftrag: × 1,24 waagerecht, × 0,71 senkrecht).
  Kamera und Tiefe dazu sind unbrauchbar, die Konfidenz fast null.

Daraus folgt der Weg: hochgeladen wird schon im Seitenverhältnis des Rasters
(:func:`vorrahmen`), und wo Atlas' Bild im hochgeladenen liegt, wird **je Bild gemessen**
(:func:`ausschnitt_messen`, SIFT), nicht angenommen. Mit der Abbildung
``p_hoch = a·p_atlas + b`` (Ecken-Koordinaten) wird die Intrinsik zurückgerechnet::

    fx = a_x · fx_t        cx = a_x · cx_t + b_x + x0      (ebenso y; x0, y0 = Vorrahmen)

Ein Bild ohne genug Struktur zum Messen bekommt den Anteil der übrigen
(:func:`ausschnitt_anteil`); ein verzerrt zurückgegebenes (:func:`isotrop`) fliegt raus.

**Die Kamera.** Atlas liefert Kamera → Welt, Quaternion XYZW, ``rub`` (Blick −Z) in
einer schwerkraftgerichteten Welt mit Y oben. COLMAP (und damit Brush) will Welt →
Kamera, Quaternion WXYZ, Kamera ``rdf`` (Blick +Z). Zwischen beiden liegt
``diag(1, −1, −1)`` auf der Kameraseite.

**Die Tiefe.** z-Tiefe entlang der Blickrichtung (nicht Strahllänge), in Einheiten
der Szene — Atlas schätzt metrisch. Pixelmitten liegen bei ``u + 0,5``: der
Ursprung (0, 0) ist die linke obere *Ecke*. Rückprojektion je Pixel, mit drei
Filtern, ohne die ein dichtes Startmodell schlechter ist als ein dünnes: Konfidenz,
Tiefensprünge (ein Pixel auf der Kante einer Wand liegt sonst als „fliegender
Punkt" zwischen Wand und Hintergrund) und Ferne (Himmel und Horizont).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from splatwerk import colmap_modell, georef

#: RUB ↔ RDF auf der Kameraseite: x bleibt, y und z kehren um.
_FLIP = np.diag([1.0, -1.0, -1.0])


# ── Raster ──────────────────────────────────────────────────────────────────

def zielraster(groessen: list[tuple[int, int]], kante: int = 1280) -> tuple[int, int]:
    """Das Raster für ``targetResolution``: Seitenverhältnis der Mehrheit, längste Kante ``kante``.

    Beide Seiten gerade (Mitte eines Pixels liegt dann auf einer halben Zahl, wie in
    der Intrinsik von Atlas). Ein Handy macht 4:3 hoch oder quer, eine Drohne 4:3 oder
    16:9 — die Mehrheit bekommt den reinen Maßstab, die anderen werden beschnitten.
    """
    gruppen: dict[float, list[float]] = {}
    for w, h in groessen:
        gruppen.setdefault(round(w / h, 2), []).append(w / h)
    # Gruppiert wird gerundet, gerechnet exakt: 4032/3024 auf 1,33 gerundet ergäbe 962 statt 960.
    seite = float(np.median(max(gruppen.values(), key=lambda v: (len(v), v[0])))) if gruppen else 4 / 3
    if seite >= 1:
        wt, ht = kante, kante / seite
    else:
        wt, ht = kante * seite, kante
    return int(round(wt / 2) * 2), int(round(ht / 2) * 2)


def vorrahmen(w: int, h: int, wt: int, ht: int) -> tuple[int, int, int, int]:
    """(x0, y0, b, h) — der mittige Ausschnitt des eigenen Bildes im Seitenverhältnis des Rasters.

    Ohne Skalierung, nur beschnitten: hochgeladen wird dieser Ausschnitt, damit Atlas nichts
    verzerren muss. Passt das Bild schon (±0,5 %), ist es das ganze Bild.
    """
    ziel = wt / ht
    if abs(w / h - ziel) <= 0.005 * ziel:
        return 0, 0, w, h
    if w / h > ziel:
        b = int(round(h * ziel))
        return (w - b) // 2, 0, b, h
    hh = int(round(w / ziel))
    return 0, (h - hh) // 2, w, hh


def ausschnitt_messen(hoch: np.ndarray, atlas: np.ndarray, *, merkmale: int = 4000) -> dict | None:
    """Wo liegt Atlas' Bild im hochgeladenen? Achsparallel: ``p_hoch = a·p_atlas + b`` je Achse.

    Ecken-Koordinaten (Pixelmitte bei u + 0,5), wie die Intrinsik. SIFT, dann RANSAC über eine
    allgemeine Affinität — die Schräganteile müssen dabei verschwinden, sonst ist es keine
    Beschneidung —, dann je Achse ausgeglichen über die Inlier. ``None``, wenn das Bild zu
    wenig Struktur hat (weiße Wand, Himmel) oder die Lage nicht eindeutig ist.
    """
    import cv2

    def grau(a):
        return cv2.cvtColor(a, cv2.COLOR_RGB2GRAY) if a.ndim == 3 else a

    sift = cv2.SIFT_create(merkmale)
    kh, dh = sift.detectAndCompute(grau(hoch), None)
    ka, da = sift.detectAndCompute(grau(atlas), None)
    if dh is None or da is None or len(kh) < 12 or len(ka) < 12:
        return None
    paare = [p[0] for p in cv2.BFMatcher().knnMatch(da, dh, k=2)
             if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
    if len(paare) < 12:
        return None
    # OpenCV setzt die Pixelmitte auf ganze Zahlen; +0,5 macht Ecken-Koordinaten daraus.
    pa = np.float64([ka[m.queryIdx].pt for m in paare]) + 0.5
    ph = np.float64([kh[m.trainIdx].pt for m in paare]) + 0.5
    m, drin = cv2.estimateAffine2D(pa, ph, method=cv2.RANSAC, ransacReprojThreshold=2.0)
    if m is None:
        return None
    drin = drin.ravel().astype(bool)
    skala = float(np.sqrt(abs(np.linalg.det(m[:, :2]))))
    if drin.sum() < 12 or drin.sum() < 0.25 * len(paare) or \
            max(abs(m[0, 1]), abs(m[1, 0])) > 0.01 * skala:
        return None
    ax, bx = np.polyfit(pa[drin, 0], ph[drin, 0], 1)
    ay, by = np.polyfit(pa[drin, 1], ph[drin, 1], 1)
    rest = np.hypot(ax * pa[drin, 0] + bx - ph[drin, 0], ay * pa[drin, 1] + by - ph[drin, 1])
    return {"ax": float(ax), "bx": float(bx), "ay": float(ay), "by": float(by),
            "inlier": int(drin.sum()), "paare": len(paare), "rest_px": round(float(np.median(rest)), 3)}


def isotrop(abb: dict, toleranz: float = 0.02) -> bool:
    """Gleicher Maßstab auf beiden Achsen? Sonst hat Atlas das Bild verzerrt."""
    return abs(abb["ax"] / abb["ay"] - 1.0) <= toleranz


def ausschnitt_anteil(messungen: list[tuple[dict, int, int]], wt: int, ht: int) -> tuple[float, float] | None:
    """Welchen Anteil des hochgeladenen Bildes (je Achse) Atlas nimmt — Median der isotropen Messungen.

    ``messungen``: (Abbildung, Breite, Höhe des hochgeladenen Bildes).
    """
    anteile = [(a["ax"] * wt / w, a["ay"] * ht / h) for a, w, h in messungen if a and isotrop(a)]
    if not anteile:
        return None
    return float(np.median([x for x, _ in anteile])), float(np.median([y for _, y in anteile]))


def ausschnitt_nach_anteil(anteil: tuple[float, float], w: int, h: int, wt: int, ht: int) -> dict:
    """Die Abbildung eines mittigen Ausschnitts mit diesem Anteil — für Bilder, die sich nicht messen ließen."""
    ax, ay = anteil[0] * w / wt, anteil[1] * h / ht
    return {"ax": ax, "bx": (w - ax * wt) / 2.0, "ay": ay, "by": (h - ay * ht) / 2.0}


def abbildung_auf_quelle(abb: dict, x0: float, y0: float) -> dict:
    """Abbildung Raster → hochgeladenes Bild um den Vorrahmen erweitert: Raster → eigenes Bild."""
    return {**abb, "bx": abb["bx"] + x0, "by": abb["by"] + y0}


def intrinsik_auf_quelle(intr: dict, abb: dict, w: int, h: int) -> dict:
    """Atlas-Intrinsik (Raster) → Intrinsik des eigenen Bildes w×h über die Abbildung ``p = a·p_t + b``."""
    return {"fx": intr["fx"] * abb["ax"], "fy": intr["fy"] * abb["ay"],
            "cx": intr["cx"] * abb["ax"] + abb["bx"], "cy": intr["cy"] * abb["ay"] + abb["by"],
            "width": w, "height": h}


# ── Kameras ─────────────────────────────────────────────────────────────────

def drehung_aus_quaternion(q) -> np.ndarray:
    """XYZW → Drehmatrix."""
    x, y, z, w = (np.asarray(q, dtype=float) / np.linalg.norm(q))
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def kamera_rub(kamera: dict) -> tuple[np.ndarray, np.ndarray]:
    """Atlas-Kamera → (Zentrum, Drehung Kamera → Welt mit den Spalten rechts, oben, hinten)."""
    e = kamera["extrinsics"]
    r = drehung_aus_quaternion(e["quaternion"])
    if (e.get("coordinateSystem") or e.get("coordinate_system") or "rub") == "rdf":
        r = r @ _FLIP
    return np.asarray(e["position"], dtype=float), r


def colmap_pose(zentrum: np.ndarray, r_rub: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(q WXYZ, t) für ``images.txt``: Welt → Kamera, Kamera rdf."""
    r_w2c = (r_rub @ _FLIP).T
    return colmap_modell.matrix_nach_quaternion(r_w2c), -r_w2c @ zentrum


# ── Tiefe → Punkte ──────────────────────────────────────────────────────────

def punkte_aus_tiefe(tiefe: np.ndarray, farbe: np.ndarray, intr: dict, zentrum: np.ndarray,
                     r_rub: np.ndarray, konfidenz: np.ndarray | None = None, schritt: int = 2,
                     konf_min: float = 0.5, sprung_max: float = 0.04, fern_faktor: float = 4.0):
    """Rückprojektion einer Tiefenkarte (Raster der Intrinsik) in die Welt.

    Rückgabe ``(punkte (n,3), farben (n,3) uint8, gewicht (n,))``. Gewicht ist die
    Konfidenz geteilt durch die Tiefe — nahe, sichere Punkte gewinnen beim Ausdünnen.
    """
    h, w = tiefe.shape
    z = tiefe.astype(np.float64)
    gut = np.isfinite(z) & (z > 0)
    if konfidenz is not None:
        k = konfidenz.astype(np.float64)
        if k.max() > 1.0:
            k = k / 255.0
        gut &= k >= konf_min
    else:
        k = np.ones_like(z)
    if not gut.any():
        return np.zeros((0, 3)), np.zeros((0, 3), np.uint8), np.zeros(0)
    # Tiefensprünge: relativer Unterschied zu den Nachbarn rechts und unten
    zs = np.where(gut, z, np.nan)
    sprung = np.zeros_like(z)
    with np.errstate(invalid="ignore"):
        sprung[:, :-1] = np.fmax(sprung[:, :-1], np.abs(zs[:, 1:] - zs[:, :-1]) / zs[:, :-1])
        sprung[:, 1:] = np.fmax(sprung[:, 1:], np.abs(zs[:, 1:] - zs[:, :-1]) / zs[:, 1:])
        sprung[:-1, :] = np.fmax(sprung[:-1, :], np.abs(zs[1:, :] - zs[:-1, :]) / zs[:-1, :])
        sprung[1:, :] = np.fmax(sprung[1:, :], np.abs(zs[1:, :] - zs[:-1, :]) / zs[1:, :])
    gut &= ~(np.nan_to_num(sprung, nan=1.0) > sprung_max)
    if gut.any():
        gut &= z <= fern_faktor * float(np.median(z[gut]))
    raster = np.zeros_like(gut)
    raster[schritt // 2::schritt, schritt // 2::schritt] = True
    gut &= raster
    v, u = np.nonzero(gut)
    zz = z[v, u]
    x = ((u + 0.5) - intr["cx"]) / intr["fx"] * zz
    y = ((v + 0.5) - intr["cy"]) / intr["fy"] * zz
    kam = np.stack([x, y, zz], axis=1)                     # rdf
    welt = zentrum + kam @ (r_rub @ _FLIP).T
    return welt, farbe[v, u].astype(np.uint8), k[v, u] / zz


def ausduennen(punkte: np.ndarray, farben: np.ndarray, gewicht: np.ndarray, voxel: float,
               hoechstens: int, zufall: int = 7):
    """Je Voxel der Punkt mit dem höchsten Gewicht; danach höchstens ``hoechstens`` Punkte."""
    if len(punkte) == 0:
        return punkte, farben
    zelle = np.floor(punkte / voxel).astype(np.int64)
    reihen = np.lexsort((-gewicht, zelle[:, 2], zelle[:, 1], zelle[:, 0]))
    zs = zelle[reihen]
    neu = np.ones(len(zs), dtype=bool)
    neu[1:] = np.any(zs[1:] != zs[:-1], axis=1)
    wahl = reihen[neu]
    if len(wahl) > hoechstens:
        wahl = np.random.default_rng(zufall).choice(wahl, hoechstens, replace=False)
    return punkte[wahl], farben[wahl]


# ── Teile zusammenführen ────────────────────────────────────────────────────

def teil_einpassen(zentren_a: np.ndarray, blick_a: np.ndarray, zentren_b: np.ndarray,
                   blick_b: np.ndarray, abstand_b: float):
    """Ähnlichkeit, die Teil B auf Teil A legt — aus den gemeinsamen Bildern.

    Zentren allein reichen nicht, wenn die gemeinsamen Kameras fast auf einer Linie
    stehen (Video, Drohnenbahn): dann ist die Drehung um diese Linie frei. Je Kamera
    kommt deshalb ein zweiter Punkt in Blickrichtung dazu — in B ``abstand_b`` voraus,
    in A dieselbe Strecke in A-Einheiten. Den Maßstab dafür liefern die Zentren schon
    allein (Abstände zwischen Kameras sind auch auf einer Linie messbar).
    """
    va = float(((zentren_a - zentren_a.mean(axis=0)) ** 2).sum())
    vb = float(((zentren_b - zentren_b.mean(axis=0)) ** 2).sum())
    s_vorab = math.sqrt(va / vb) if va > 0 and vb > 0 else 1.0
    a = np.vstack([zentren_a, zentren_a + abstand_b * s_vorab * blick_a])
    b = np.vstack([zentren_b, zentren_b + abstand_b * blick_b])
    s, r, t = georef.umeyama(b, a, skalieren=True)
    rest = np.linalg.norm(s * b @ r.T + t - a, axis=1)
    return s, r, t, float(np.sqrt((rest ** 2).mean()))


# ── COLMAP-Textmodell ───────────────────────────────────────────────────────

def schreibe_modell(ordner: Path, bilder: list[dict], punkte: np.ndarray, farben: np.ndarray) -> None:
    """``cameras.txt``, ``images.txt``, ``points3D.txt`` — eine PINHOLE-Kamera je Bild.

    Die Punkte tragen keine Spur: sie kommen aus der Tiefe, nicht aus einer
    Triangulation. Brush liest sie als Startpositionen und -farben (geprüft);
    COLMAP selbst braucht das Modell im Atlas-Weg nicht.
    """
    ordner = Path(ordner)
    ordner.mkdir(parents=True, exist_ok=True)
    with (ordner / "cameras.txt").open("w") as f:
        f.write("# Camera list with one line of data per camera:\n#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n")
        for i, b in enumerate(bilder, start=1):
            k = b["intr"]
            f.write(f"{i} PINHOLE {int(k['width'])} {int(k['height'])} "
                    f"{k['fx']:.6f} {k['fy']:.6f} {k['cx']:.6f} {k['cy']:.6f}\n")
    with (ordner / "images.txt").open("w") as f:
        f.write("# Image list with two lines of data per image:\n"
                "#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n#   POINTS2D[] as (X, Y, POINT3D_ID)\n")
        for i, b in enumerate(bilder, start=1):
            q, t = colmap_pose(b["zentrum"], b["r_rub"])
            f.write(f"{i} {' '.join(f'{v:.12g}' for v in q)} {' '.join(f'{v:.12g}' for v in t)} {i} {b['name']}\n\n")
    with (ordner / "points3D.txt").open("w") as f:
        f.write("# 3D point list with one line of data per point:\n"
                "#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n")
        zeilen = (f"{i} {p[0]:.5f} {p[1]:.5f} {p[2]:.5f} {c[0]} {c[1]} {c[2]} 0\n"
                  for i, (p, c) in enumerate(zip(punkte, farben), start=1))
        f.writelines(zeilen)


def transformiere(bilder: list[dict], punkte: np.ndarray, matrix) -> tuple[list[dict], np.ndarray]:
    """Ähnlichkeitstransformation (4×4 mit Maßstab) auf Kameras und Punkte."""
    m = np.asarray(matrix, dtype=float)
    a = m[:3, :3]
    s = float(np.cbrt(np.linalg.det(a)))
    rot = a / s
    neu = [{**b, "zentrum": a @ b["zentrum"] + m[:3, 3], "r_rub": rot @ b["r_rub"]} for b in bilder]
    return neu, (punkte @ a.T + m[:3, 3]) if len(punkte) else punkte


def voxelgroesse(tiefen_median: float, f_median: float, pixel: float = 2.0) -> float:
    """Voxel ≈ ``pixel`` Bildpunkte in mittlerer Entfernung — dichter wäre doppelt, gröber verschenkt."""
    if not (math.isfinite(tiefen_median) and tiefen_median > 0 and f_median > 0):
        return 0.01
    return pixel * tiefen_median / f_median
