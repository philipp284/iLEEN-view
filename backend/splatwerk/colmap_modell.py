"""
COLMAP-Modell lesen (Textformat) — nur das, was die Georeferenzierung braucht.

Das Textformat statt `images.bin`: COLMAP 3.12 hat Rigs und Frames eingeführt,
und ob `images.bin` dort noch die Pose je Bild trägt oder sie über die Frames
läuft, ist eine Format-Eigenheit, auf die man sich nicht verlassen will.
`colmap model_converter --output_type TXT` schreibt `images.txt` in der seit
Jahren stabilen Form, unabhängig davon, wie das Modell intern gespeichert ist.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np


def quaternion_nach_matrix(q) -> np.ndarray:
    """COLMAP-Quaternion (w, x, y, z) → Drehmatrix (Welt → Kamera)."""
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def lese_bilder_txt(pfad: Path) -> list[dict]:
    """
    `images.txt` → je registriertem Bild `name`, `zentrum`, `rechts`, `oben`, `blick`, `r`.

    Alle Vektoren im Weltrahmen; `r` ist die Drehung Welt → Kamera (ein Kameravektor `v`
    liegt im Weltrahmen bei `r.T @ v`). Zeilenpaare: Pose, dann die 2D-Punkte (die hier
    nicht gebraucht werden und bei großen Modellen den Hauptteil der Datei bilden).
    """
    # Leere Zeilen zählen mit: ein Bild ohne 2D-Punkte hat eine *leere* zweite Zeile (so schreibt
    # COLMAP, und so schreibt der Atlas-Weg sein Modell). Wer sie herausfiltert, paart danach
    # Kopf- mit Punktzeilen und liest jede zweite Kamera falsch.
    zeilen = [z for z in Path(pfad).read_text().splitlines() if not z.startswith("#")]
    koepfe, i = [], 0
    while i < len(zeilen):
        if not zeilen[i].strip():
            i += 1
            continue
        koepfe.append(zeilen[i])
        i += 2
    bilder = []
    for kopf in koepfe:
        teile = kopf.split()
        if len(teile) < 10:
            continue
        q = np.array([float(v) for v in teile[1:5]])
        t = np.array([float(v) for v in teile[5:8]])
        r = quaternion_nach_matrix(q)  # Welt → Kamera
        bilder.append({
            "id": int(teile[0]),
            "name": " ".join(teile[9:]),
            "zentrum": -r.T @ t,
            "rechts": r[0, :].copy(),   # Kamera-x (Bild rechts) im Weltrahmen
            "oben": -r[1, :],           # Kamera-y zeigt nach unten
            "blick": r[2, :].copy(),
            "r": r,
        })
    return bilder


def lese_punkte_txt(pfad: Path, min_spur: int = 3, max_fehler: float = 2.0, max_punkte: int = 400_000) -> list[dict]:
    """
    `points3D.txt` → je Punkt `xyz`, `fehler` (mittlerer Reprojektionsfehler, px) und `bilder`
    (die Kennungen der Bilder, die ihn sehen). Es bleiben nur Punkte mit einer Spur von mindestens
    `min_spur` Bildern und einem Fehler unter `max_fehler`: das sind die, auf die man sich
    verlassen kann — kurze Spuren und große Fehler sind der Ausschuss der Triangulation.
    """
    punkte = []
    with Path(pfad).open() as f:
        for z in f:
            if z.startswith("#") or not z.strip():
                continue
            t = z.split()
            if len(t) < 8 + 2 * min_spur:
                continue
            fehler = float(t[7])
            if fehler > max_fehler:
                continue
            punkte.append({"xyz": np.array([float(t[1]), float(t[2]), float(t[3])]), "fehler": fehler,
                           "bilder": [int(v) for v in t[8::2]]})
            if len(punkte) >= max_punkte:
                break
    return punkte


def typischer_abstand(txt: Path) -> float | None:
    """
    Median über alle Beobachtungen: wie weit steht die Kamera von dem Punkt, den sie sieht
    (in den Einheiten des Modells). Grundlage für einen Maßstab, wenn nichts Messbares da ist.
    """
    punkte = lese_punkte_txt(Path(txt) / "points3D.txt")
    if len(punkte) < 50:
        return None
    zentren = {b["id"]: b["zentrum"] for b in lese_bilder_txt(Path(txt) / "images.txt")}
    d = [float(np.linalg.norm(p["xyz"] - zentren[i])) for p in punkte for i in p["bilder"] if i in zentren]
    return float(np.median(d)) if d else None


def matrix_nach_quaternion(r: np.ndarray) -> np.ndarray:
    """Drehmatrix → Quaternion (w, x, y, z), w ≥ 0."""
    spur = float(np.trace(r))
    if spur > 0:
        s = 0.5 / np.sqrt(spur + 1.0)
        q = np.array([0.25 / s, (r[2, 1] - r[1, 2]) * s, (r[0, 2] - r[2, 0]) * s, (r[1, 0] - r[0, 1]) * s])
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = 2.0 * np.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2])
        q = np.array([(r[2, 1] - r[1, 2]) / s, 0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s])
    elif r[1, 1] > r[2, 2]:
        s = 2.0 * np.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2])
        q = np.array([(r[0, 2] - r[2, 0]) / s, (r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s])
    else:
        s = 2.0 * np.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1])
        q = np.array([(r[1, 0] - r[0, 1]) / s, (r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s])
    q = q / np.linalg.norm(q)
    return q if q[0] >= 0 else -q


def schreibe_sim3(pfad: Path, matrix) -> None:
    """
    Ähnlichkeitstransformation für `colmap model_transformer --transform_path`.

    Das Format ist **eine Zeile**: `Maßstab qw qx qy qz tx ty tz` — nicht die 3×4- oder
    4×4-Matrix, die man erwartet. Gelernt am Ergebnis von `model_aligner --transform_path`,
    denn die Matrixform wird von COLMAP stillschweigend falsch gelesen: statt eines
    Fehlers kommen NaN-Posen aus dem Transformer. `matrix` ist 4×4 mit eingerechnetem
    Maßstab (so liefert sie `georef.ausrichtung`).
    """
    m = np.asarray(matrix, dtype=np.float64)
    a = m[:3, :3]
    s = float(np.cbrt(np.linalg.det(a)))
    if not np.isfinite(s) or s <= 0:
        raise ValueError(f"Transformation hat keinen positiven Maßstab (det^(1/3) = {s}).")
    q = matrix_nach_quaternion(a / s)
    t = m[:3, 3]
    Path(pfad).write_text(" ".join(f"{v:.12g}" for v in (s, *q, *t)) + "\n")
