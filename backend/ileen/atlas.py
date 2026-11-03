"""
World Labs Atlas (Marble 2) — der Client hinter ``api/routes/atlas.py``.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Atlas erzeugt Bilder einer Szene, die zur Geometrie passen: ``atlasChisel``
nimmt je Ansicht eine Tiefenkarte und eine Kamera — ein Graubild, ein
Blockmodell — und malt dazu ein fotorealistisches Bild, über mehrere
Ansichten hinweg in sich stimmig. Ein IFC- oder Bauplaner-Modell im Viewer
ist genau so ein Blockmodell. Der Viewer liefert Tiefe und Kamera
(``frontend/atlas.js``), hier wird daraus eine Anfrage.

## Woher der Schlüssel kommt

Aus der Datei der World-Labs-CLI, nie aus dem Browser — siehe
``splatwerk/worldlabs.py``, den gemeinsamen Client für Container und Worker.

## Warum die Tiefe als EXR und nicht als Log-PNG

Die API nimmt beides. Die PNG-Form (``logDepthAsset`` mit ``zMin``/``zMax``)
ist in der Doku nur dem Namen nach beschrieben — welche Kurve, 8 oder 16 Bit,
bleibt offen. Das EXR ist eindeutig: lineare z-Tiefe entlang der
Blickrichtung in Welteinheiten (hier Meter), Zeile 0 oben. ``exr_schreiben``
(``splatwerk/worldlabs.py``) schreibt es ohne Zusatzpaket: unkomprimiert, ein
Kanal ``Y``, float32.
"""

from __future__ import annotations

import math

import numpy as np

# Der Client selbst (Schlüssel, HTTP, Assets, Operationen, EXR) liegt in
# ``splatwerk/worldlabs.py``: der Worker auf dem Mac braucht ihn auch, und das
# Paket ``ileen`` zieht beim Import JAX herein.
from splatwerk.worldlabs import (  # noqa: F401 — Namen für api/routes/atlas.py
    API_ORIGIN, AtlasFehler, anfrage, asset_hochladen, asset_lesen, aufgabe_einreichen, exr_lesen,
    exr_schreiben, fehler_der_operation, operation_warten, pruefen, schluessel, schluessel_datei,
)

#: Das Raster, das ``atlasChisel`` für jede Kamera und jede Tiefenkarte verlangt.
BREITE, HOEHE = 1280, 720


# ── Tiefenkarten ────────────────────────────────────────────────────────────

def tiefe_aufbereiten(roh: bytes, himmel_m: float) -> tuple[np.ndarray, dict]:
    """Rohkörper aus dem Viewer (float32, 1280×720, Zeile 0 oben, 0 = kein Treffer)
    → Tiefenkarte für Atlas und eine kleine Statistik.

    Pixel ohne Geometrie (Himmel) bekommen ``himmel_m``: weit weg, aber
    endlich — ``atlasChisel`` normiert die Szene über Perzentile der Disparität,
    ein ferner Himmel stört das nicht, ein ``inf`` womöglich schon.
    """
    if len(roh) != BREITE * HOEHE * 4:
        raise ValueError(f"Tiefe muss {BREITE}×{HOEHE} float32 sein ({BREITE * HOEHE * 4} Bytes), "
                         f"gekommen sind {len(roh)}")
    t = np.frombuffer(roh, dtype="<f4").reshape(HOEHE, BREITE).astype(np.float32)
    leer = ~np.isfinite(t) | (t <= 0)
    gueltig = t[~leer]
    stat = {"himmel_anteil": round(float(leer.mean()), 4), "himmel_m": himmel_m}
    if gueltig.size:
        q = np.percentile(gueltig, [1, 50, 99])
        stat.update(min=round(float(gueltig.min()), 3), p1=round(float(q[0]), 3),
                    median=round(float(q[1]), 3), p99=round(float(q[2]), 3), max=round(float(gueltig.max()), 3))
    t = np.where(leer, np.float32(himmel_m), np.minimum(t, np.float32(himmel_m)))
    return t, stat


def tiefe_vorschau_png(t: np.ndarray, himmel_m: float) -> bytes:
    """Disparität als Graubild: hell ist nah — wie in der Doku von World Labs."""
    from io import BytesIO

    from PIL import Image

    gueltig = t[t < himmel_m]
    if gueltig.size:
        nah, fern = np.percentile(gueltig, [1, 99])
        nah, fern = max(float(nah), 1e-3), max(float(fern), float(nah) * 1.01)
        d = (1.0 / np.maximum(t, 1e-3) - 1.0 / fern) / (1.0 / nah - 1.0 / fern)
        g = np.clip(d, 0, 1) ** 0.8
    else:
        g = np.zeros_like(t)
    g = np.where(t >= himmel_m, 0.0, 0.12 + 0.88 * g)
    rgb = np.stack([g * 235 + 10, g * 245 + 8, g * 225 + 14], axis=-1).clip(0, 255).astype(np.uint8)
    puffer = BytesIO()
    Image.fromarray(rgb, "RGB").save(puffer, "PNG", optimize=True)
    return puffer.getvalue()


# ── Kameras ─────────────────────────────────────────────────────────────────

def kamera_pruefen(k: dict, wo: str) -> dict:
    """Prüft eine Kamera im Marble-Format und gibt sie bereinigt zurück."""
    try:
        e, i = k["extrinsics"], k["intrinsics"]
        pos = [float(x) for x in e["position"]]
        quat = [float(x) for x in e["quaternion"]]
        intr = {n: float(i[n]) for n in ("fx", "fy", "cx", "cy")}
        breite, hoehe = int(i["width"]), int(i["height"])
    except (KeyError, TypeError, ValueError) as fehler:
        raise ValueError(f"{wo}: Kamera unvollständig ({fehler})") from fehler
    if len(pos) != 3 or len(quat) != 4 or not all(map(math.isfinite, pos + quat + list(intr.values()))):
        raise ValueError(f"{wo}: Kamera mit ungültigen Zahlen")
    if (breite, hoehe) != (BREITE, HOEHE):
        raise ValueError(f"{wo}: Atlas verlangt {BREITE}×{HOEHE}, nicht {breite}×{hoehe}")
    n = math.sqrt(sum(q * q for q in quat))
    if not 0.98 < n < 1.02:
        raise ValueError(f"{wo}: Quaternion nicht normiert (|q| = {n:.3f})")
    system = e.get("coordinateSystem") or "rub"
    if system not in ("rub", "rdf"):
        raise ValueError(f"{wo}: coordinateSystem muss rub oder rdf sein")
    return {"extrinsics": {"position": pos, "quaternion": [q / n for q in quat], "coordinateSystem": system},
            "intrinsics": {**intr, "width": breite, "height": hoehe}}


def chisel_koerper(*, prompt: str, kameras: list[dict], tiefen: list[str | None],
                   quellen: list[tuple[str, dict]], enhance: bool = True, seed: int | None = None,
                   voxel: float | None = None, return_depth: bool = False) -> dict:
    """Der Körper für ``POST /api/v2/tasks:atlasChisel``.

    ``tiefen[i]`` ist die Asset-Kennung der Tiefe zur Kamera ``i`` oder None —
    die API verlangt aber *genau eine* Tiefe je Zielkamera oder gar keine.
    ``quellen`` sind (Bild-Asset, Kamera) für ``sourceFrames``.
    """
    if not prompt.strip():
        raise ValueError("Atlas verlangt eine Beschreibung der Szene (prompt)")
    if not 1 <= len(kameras) <= 32:
        raise ValueError("1 bis 32 Ansichten je Auftrag")
    mit_tiefe = [t for t in tiefen if t]
    if mit_tiefe and len(mit_tiefe) != len(kameras):
        raise ValueError("Entweder jede Ansicht mit Tiefe oder keine")
    if 2 * len(kameras) + len(quellen) > 64:
        raise ValueError(f"{len(kameras)} Ansichten und {len(quellen)} Farbvorgaben passen nicht in einen "
                         "Auftrag (2 × Ansichten + Farbvorgaben ≤ 64)")
    koerper = {"prompt": prompt.strip(), "targetCameras": kameras, "enhancePrompt": bool(enhance)}
    if mit_tiefe:
        koerper["contextFrames"] = [{"camera": k, "depth": {"depthAsset": {"assetId": t}}}
                                    for k, t in zip(kameras, tiefen)]
    if quellen:
        koerper["sourceFrames"] = [{"imageAsset": {"assetId": a}, "camera": k} for a, k in quellen]
    if seed is not None:
        koerper["modelParameters"] = {"seed": int(seed)}
    if voxel:
        koerper["voxelSize"] = float(voxel)
        koerper["voxelGridOrientation"] = "world"
    if return_depth:
        mitten = {tuple(round(x, 4) for x in k["extrinsics"]["position"]) for k in kameras}
        if len(mitten) < 2:
            raise ValueError("Tiefe zurück braucht mindestens zwei Ansichten an verschiedenen Standorten")
        koerper["returnDepth"] = True
    return koerper
