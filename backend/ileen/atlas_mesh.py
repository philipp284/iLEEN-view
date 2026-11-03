"""
Mesh aus einem Gaussian Splat — World Labs ``splats2Mesh``, als eigenes Asset genau dort, wo der Splat liegt.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Der Weg (``api/routes/atlas.py`` → ``mesh_*``)::

    Splat-PLY (uploads/)  ──  Z oben, Quellrahmen (bei Foto-Splats: ENU der Rekonstruktion)
        │  um die Mitte verschoben, nach Y oben gedreht, als SPZ gepackt     (splat_aufbereiten)
        ▼
    splats2Mesh  ──  Ansichtspunkte: die echten Aufnahmeorte, sonst automatisch oder von außen
        │  GLB mit Texturatlas, im Rahmen des SPZ
        ▼
    zurück nach Z oben und in den Quellrahmen, relativ zum Anker des Splats  (mesh_zurueck)
        ▼
    eigenes Mesh-Asset: Platzierung des Splats + Zentrierversatz als base_transform

**Warum die Platzierung des Splats und nicht eine eigene.** Mesh und Splat sollen
deckungsgleich liegen — auch nachdem jemand den Splat im Asset-Manager verschoben
oder den Höhenbezug „über Gelände" im Viewer gegen ein anderes Terrain aufgelöst hat
(``terrain-align.js``). Mit derselben Platzierung (Länge, Breite, Höhe, Bezug,
Drehung, Maßstab) gelten für beide dieselben Regeln; der Unterschied steckt allein
im ``base_transform`` — dem Versatz, den die Kachelung des Meshes abzieht.

**Welche Achse oben ist, wird gemessen, nicht angenommen.** ``splats2Mesh`` spricht
von „Three.js-Koordinaten" (Y oben); ob das zurückgegebene GLB dieselben Koordinaten
trägt wie das SPZ oder um X gekippt ist, prüft :func:`lage_waehlen` an der Hüllbox:
genommen wird die Lage, deren Box sich am besten mit der des Splats deckt.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

#: Je Stufe: Auflösung des Gitters der impliziten Fläche (Zweierpotenz, über die längste
#: Seite), Obergrenze der Dreiecke, Kante des Texturatlas.
QUALITAET = {
    "schnell":  {"resolution": 512,  "targetFaces": 300_000,   "textureSize": 4096},
    "standard": {"resolution": 1024, "targetFaces": 800_000,   "textureSize": 4096},
    "hoch":     {"resolution": 2048, "targetFaces": 2_000_000, "textureSize": 8192},
}
ANSICHTEN = ("aufnahme", "auto", "aussen")
MAX_ANKER = 64

#: Z oben → Y oben: (x, y, z) → (x, z, −y); als Quaternion −90° um X (XYZW).
_ZUP_NACH_YUP = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
_Q_ZUP_NACH_YUP = np.array([-math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)])
#: Mögliche Lage des zurückgegebenen Meshes im Rahmen des SPZ — die vier Drehungen um 180°
#: um eine Achse. Am ersten echten Lauf (2026-10-21) war es `um_x_gekippt` (y und z umgekehrt).
_LAGEN = {"wie_spz": np.eye(3), "um_x_gekippt": np.diag([1.0, -1.0, -1.0]),
          "um_y_gedreht": np.diag([-1.0, 1.0, -1.0]), "um_z_gedreht": np.diag([-1.0, -1.0, 1.0])}
#: So viele deckende Splats merkt sich die Aufbereitung, um die Lage des Meshes zu messen.
KERNPUNKTE = 12000


def splat_aufbereiten(ply: Path) -> dict:
    """Splat-PLY → SPZ in Three.js-Lage (Y oben, um die Mitte), dazu Mitte und Kernbox.

    Die Mitte ist die der 1–99-%-Box, nicht der Hüllbox: Trainings lassen Ausreißer
    hunderte Meter neben dem Gegenstand zurück, und SPZ fasst nur ±2048 m um den Ursprung.
    """
    from tiling import spz
    from tiling.formats.splat import _load_splat, _rotate_quats

    d = _load_splat(Path(ply), sh_grad=0)
    if d.get("log_scales") is None:
        raise ValueError("Die PLY ist kein vollständiger Gaussian Splat (Skalen und Drehungen fehlen).")
    xyz = np.asarray(d["xyz"], dtype=np.float64)
    lo, hi = np.percentile(xyz, [1, 99], axis=0)
    mitte = (lo + hi) / 2.0
    yup = (xyz - mitte) @ _ZUP_NACH_YUP.T
    drin = np.all(np.abs(yup) < 0.98 * spz.POSITION_LIMIT_M, axis=1)
    if not drin.all():
        logger.info("splats2Mesh: %d Ausreißer jenseits ±2 km verworfen", int((~drin).sum()))
    quat = _rotate_quats(np.asarray(d["quat_xyzw"])[drin], _Q_ZUP_NACH_YUP)
    daten = spz.encode(yup[drin], np.asarray(d["log_scales"])[drin], quat,
                       np.asarray(d["opacity"])[drin], np.asarray(d["sh_dc"])[drin])
    alpha = 1.0 / (1.0 + np.exp(-np.asarray(d["opacity"], dtype=np.float64)[drin]))
    kern = yup[drin][alpha > 0.3] if (alpha > 0.3).sum() >= 100 else yup[drin]
    k_lo, k_hi = np.percentile(kern, [2, 98], axis=0)
    wahl = np.random.default_rng(0).choice(len(kern), min(KERNPUNKTE, len(kern)), replace=False)
    return {"spz": daten, "mitte": mitte, "kern_lo": k_lo, "kern_hi": k_hi, "anzahl": int(drin.sum()),
            "kernpunkte": np.round(kern[np.sort(wahl)], 4)}


def anker(zentren_quelle: np.ndarray | None, mitte: np.ndarray, n: int = MAX_ANKER) -> list[list[float]]:
    """Aufnahmeorte (Quellrahmen) → höchstens ``n`` Ansichtspunkte im SPZ-Rahmen, gleichmäßig verteilt."""
    if zentren_quelle is None or len(zentren_quelle) == 0:
        return []
    p = (np.asarray(zentren_quelle, dtype=np.float64) - mitte) @ _ZUP_NACH_YUP.T
    wahl = [0]
    abstand = np.linalg.norm(p - p[0], axis=1)
    while len(wahl) < min(n, len(p)):
        k = int(np.argmax(abstand))
        if abstand[k] <= 1e-6:
            break
        wahl.append(k)
        abstand = np.minimum(abstand, np.linalg.norm(p - p[k], axis=1))
    return [[round(float(v), 4) for v in p[k]] for k in wahl]


def anfrage(spz_asset: str, aufb: dict, qualitaet: str, ansicht: str, anker_punkte: list,
            zuschnitt: bool) -> dict:
    """Der Körper für ``POST /api/v2/tasks:splats2Mesh``."""
    q = QUALITAET.get(qualitaet, QUALITAET["standard"])
    if ansicht == "aufnahme" and len(anker_punkte) >= 1:
        kameras = {"strategy": "manual_anchors", "anchors": anker_punkte}
    elif ansicht == "aussen":
        kameras = {"strategy": "exterior_sphere"}
    else:
        kameras = {"strategy": "auto_anchors", "oriented": False}
    koerper = {"splatAsset": {"assetId": spz_asset}, "cameras": kameras, "textureMode": "image_texture",
               "textureSize": q["textureSize"], "targetFaces": q["targetFaces"],
               "advancedOptions": {"resolution": q["resolution"]}}
    if zuschnitt:
        lo, hi = np.asarray(aufb["kern_lo"]), np.asarray(aufb["kern_hi"])
        halb = np.maximum((hi - lo) / 2.0 * 1.15, 0.05)
        koerper["orientedBoundingBox"] = {"center": [round(float(v), 4) for v in (lo + hi) / 2.0],
                                          "orientation": [0.0, 0.0, 0.0, 1.0],
                                          "halfExtents": [round(float(v), 4) for v in halb]}
    return koerper


def lage_waehlen(ecken_lo: np.ndarray, ecken_hi: np.ndarray, kern_lo: np.ndarray, kern_hi: np.ndarray) -> tuple[str, float]:
    """Rückfall ohne Kernpunkte: welche Lage deckt die Hüllbox des Splats? (Name, Überdeckung 0…1).

    Nur ein Notbehelf: bei einer fast symmetrischen Szene (ein Sideboard vor einer Wand) deckt
    die verkehrte Lage die Box ebenso — am ersten echten Lauf 0,81 für die falsche.
    """
    beste = ("wie_spz", -1.0)
    for name, r in _LAGEN.items():
        a = np.stack([ecken_lo, ecken_hi]) @ r.T
        lo, hi = a.min(axis=0), a.max(axis=0)
        schnitt = np.prod(np.clip(np.minimum(hi, kern_hi) - np.maximum(lo, kern_lo), 0, None))
        vereinigt = np.prod(hi - lo) + np.prod(kern_hi - kern_lo) - schnitt
        iou = float(schnitt / vereinigt) if vereinigt > 0 else 0.0
        if iou > beste[1]:
            beste = (name, iou)
    return beste


def lage_messen(mesh_punkte: np.ndarray, kernpunkte: np.ndarray) -> dict:
    """Welche Lage legt das Mesh auf die Splats? Gemessen am Abstand Mesh-Punkt → nächster deckender Splat.

    Rückgabe ``{lage, abstand_m, je_lage: {Name: Median-Abstand}}``. Eindeutig, wenn die beste Lage
    deutlich näher liegt als die zweitbeste — am ersten echten Lauf 11 mm gegen 90 mm.
    """
    from scipy.spatial import cKDTree

    baum = cKDTree(np.asarray(kernpunkte, dtype=np.float64))
    v = np.asarray(mesh_punkte, dtype=np.float64)
    if len(v) > 30000:
        v = v[np.random.default_rng(0).choice(len(v), 30000, replace=False)]
    je = {name: float(np.median(baum.query(v @ r.T)[0])) for name, r in _LAGEN.items()}
    beste = min(je, key=je.get)
    return {"lage": beste, "abstand_m": je[beste], "je_lage": je}


def mesh_zurueck(glb: bytes, aufb: dict, anker_splat: np.ndarray):
    """GLB von World Labs → trimesh-Mesh im Quellrahmen (Z oben), relativ zum Anker des Splats.

    Rückgabe ``(mesh, bericht)``. Ein Mesh, kein Szenenbaum: die Kachelung erwartet eines.
    """
    import io

    import trimesh

    geladen = trimesh.load(io.BytesIO(glb), file_type="glb", force="mesh")
    if geladen.vertices is None or len(geladen.vertices) == 0:
        raise ValueError("World Labs hat ein leeres Mesh zurückgegeben.")
    v = np.asarray(geladen.vertices, dtype=np.float64)
    lo, hi = np.percentile(v, [1, 99], axis=0)
    ausdehnung = float(np.linalg.norm(np.asarray(aufb["kern_hi"]) - np.asarray(aufb["kern_lo"])))
    bericht = {}
    if aufb.get("kernpunkte"):
        gemessen = lage_messen(v, np.asarray(aufb["kernpunkte"]))
        lage = gemessen["lage"]
        zweit = sorted(gemessen["je_lage"].values())[1]
        bericht.update(lage=lage, abstand_mm=round(gemessen["abstand_m"] * 1000, 1),
                       je_lage_mm={k: round(x * 1000, 1) for k, x in gemessen["je_lage"].items()})
        if gemessen["abstand_m"] > 0.02 * ausdehnung or zweit < 2.0 * gemessen["abstand_m"]:
            bericht["hinweis"] = (f"Die Lage des Meshes ist nicht eindeutig ({gemessen['abstand_m'] * 1000:.0f} mm "
                                  f"gegen {zweit * 1000:.0f} mm) — im Viewer prüfen.")
    else:
        lage, iou = lage_waehlen(lo, hi, np.asarray(aufb["kern_lo"]), np.asarray(aufb["kern_hi"]))
        bericht.update(lage=lage, deckung=round(iou, 3),
                       hinweis="Lage nur über die Hüllbox geschätzt (Aufbereitung ohne Kernpunkte) — im Viewer prüfen.")
    m = np.eye(4)
    m[:3, :3] = _ZUP_NACH_YUP.T @ _LAGEN[lage]          # SPZ-Rahmen → Z oben
    m[:3, 3] = np.asarray(aufb["mitte"]) - np.asarray(anker_splat, dtype=np.float64)
    geladen.apply_transform(m)
    bericht.update(dreiecke=int(len(geladen.faces)), punkte=int(len(geladen.vertices)),
                   textur=type(getattr(geladen, "visual", None)).__name__)
    mat = getattr(getattr(geladen, "visual", None), "material", None)
    if mat is not None and getattr(mat, "emissiveTexture", None) is not None:
        # World Labs legt die Textur zusätzlich als Emission an (Faktor 1). Cesium rendert ein Mesh
        # ohne Normalen unbeleuchtet und addiert die Emission — die Farben liefen ins Weiß. Ohne sie
        # zeigt das Mesh die Fotofarben, und die Textur steckt nur einmal in der Kachel.
        mat.emissiveTexture = None
        mat.emissiveFactor = None
        bericht["emission_entfernt"] = True
    return geladen, bericht


def platzierung_fuer_mesh(splat_platzierung: dict, versatz) -> dict:
    """Platzierung des Splats, dazu der Zentrierversatz des Meshes als ``base_transform``."""
    from tiling.georef import to_column_major, to_matrix

    p = dict(splat_platzierung)
    basis = to_matrix(p["base_transform"]) if p.get("base_transform") else np.eye(4)
    t = np.eye(4)
    t[:3, 3] = np.asarray(versatz, dtype=np.float64)
    p["base_transform"] = to_column_major(basis @ t)
    return p
