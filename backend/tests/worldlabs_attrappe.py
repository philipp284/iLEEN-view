"""
Eine World-Labs-Attrappe für den Probelauf ohne Schlüssel und ohne Kosten.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

    python3 tests/worldlabs_attrappe.py --vorlage data/training/<auftrag> [--port 8765]

Spricht die Teile der Developer API, die iLEEN benutzt (Assets inline und über
Upload-Adresse, Lese-Adressen, Operationen mit ``:wait``), und beantwortet zwei Aufgaben:

``images2PosedRGBD``
    Kameras und Tiefen aus einer **echten COLMAP-Rekonstruktion** (``--vorlage``: ein
    fertiger Auftrag mit ``colmap/txt_ausgerichtet``), aber in einer anderen Welt: um die
    Hochachse gedreht, verschoben, mit Maßstab 0,37 — so wie Atlas eine eigene,
    schwerkraftgerichtete Welt ohne Norden und ohne Meter zurückgäbe. Die Pipeline muss
    die Verortung also selbst wieder über das GPS der Bilder finden; das Ergebnis lässt
    sich gegen die Vorlage halten. Das Bild kommt zurück wie beim echten Atlas: die mittleren
    75,4 % je Achse, aufs Raster gezogen (bei anderem Seitenverhältnis verzerrt), die
    Intrinsik passend dazu. Tiefen sind die projizierten Punkte der Vorlage
    (dünn, 3×3 Pixel je Punkt), gespeichert als ZIP-komprimiertes Halb-Float-EXR, wenn
    OpenCV da ist — so wird auch der EXR-Leser geprüft.

``splats2Mesh``
    Würfel an 3 000 deckenden Splat-Positionen des hochgeladenen SPZ, im Rahmen des SPZ.
    Liegen sie im Viewer auf dem Splat, stimmt der ganze Rückweg.

Bilder werden über den Anzeigenamen zugeordnet (``ileen-<auftrag>-00012.jpg`` →
``00012.jpg`` der Vorlage); der neue Auftrag muss also dieselben Originale haben.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import io
import json
import math
import os
import struct
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from splatwerk import atlas_rekon, colmap_modell  # noqa: E402
from splatwerk import worldlabs as W  # noqa: E402

ASSETS: dict[str, dict] = {}
OPS: dict[str, dict] = {}
VORLAGE: Path | None = None
BASIS = ""

# Die „Atlas-Welt": ENU (Z oben) → Y oben, dann 63° um Y, Maßstab 0,37, verschoben.
_ZY = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
_W = math.radians(63.0)
_GIER = np.array([[math.cos(_W), 0.0, math.sin(_W)], [0.0, 1.0, 0.0], [-math.sin(_W), 0.0, math.cos(_W)]])
WELT_S = 0.37
WELT_R = _GIER @ _ZY
WELT_T = np.array([4.0, -1.5, 9.0])
#: Anteil je Achse, den Atlas vom hochgeladenen Bild nimmt (gemessen am 2026-10-21, siehe atlas_rekon).
ANTEIL = 0.754
_FLIP = np.diag([1.0, -1.0, -1.0])


def _in_welt(p):
    return WELT_S * (np.asarray(p) @ WELT_R.T) + WELT_T


def _quaternion_xyzw(r: np.ndarray) -> list[float]:
    w, x, y, z = colmap_modell.matrix_nach_quaternion(r)
    return [float(x), float(y), float(z), float(w)]


def _asset_neu(daten: bytes, name: str, mime: str) -> str:
    kennung = "asset_" + uuid.uuid4().hex[:24]
    ASSETS[kennung] = {"daten": daten, "name": name, "mime": mime}
    return kennung


def _asset_antwort(kennung: str) -> dict:
    return {"assetId": kennung, "url": f"{BASIS}/dateien/{kennung}"}


# ── images2PosedRGBD ───────────────────────────────────────────────────────

def _vorlage():
    txt = VORLAGE / "colmap" / "txt_ausgerichtet"
    bilder = {b["name"]: b for b in colmap_modell.lese_bilder_txt(txt / "images.txt")}
    kameras = {}
    for z in (txt / "cameras.txt").read_text().splitlines():
        if z and not z.startswith("#"):
            t = z.split()
            # Parameter (f, cx, cy, …), dahinter Breite und Höhe des Bildes, zu dem sie gehören
            kameras[t[0]] = [float(v) for v in t[4:]] + [int(t[2]), int(t[3])]
    kamera_je_bild = {}
    for z in [z for z in (txt / "images.txt").read_text().splitlines() if z and not z.startswith("#")][0::2]:
        t = z.split()
        kamera_je_bild[" ".join(t[9:])] = kameras[t[8]]
    punkte = np.array([[float(v) for v in z.split()[1:4]] for z in (txt / "points3D.txt").read_text().splitlines()
                       if z and not z.startswith("#")])
    return bilder, kamera_je_bild, punkte


def images2posed(koerper: dict) -> dict:
    from PIL import Image

    wt, ht = koerper.get("targetResolution") or [1280, 720]
    bilder, kamparam, punkte = _vorlage()
    welt_punkte = _in_welt(punkte)
    frames = []
    for f in koerper["frames"]:
        a = ASSETS[f["imageAsset"]["assetId"]]
        datei = a["name"].split("-")[-1]
        b = bilder[datei]
        with Image.open(io.BytesIO(a["daten"])) as im:
            eigen = np.asarray(im.convert("RGB"))
        h, w = eigen.shape[:2]
        fpx, cx, cy = kamparam[datei][0], kamparam[datei][1], kamparam[datei][2]
        # Hochgeladen ist womöglich ein mittiger Vorrahmen des Vorlagenbilds: Hauptpunkt mitschieben.
        cx -= (kamparam[datei][-2] - w) // 2
        cy -= (kamparam[datei][-1] - h) // 2
        # Wie das echte Atlas: die mittleren ANTEIL je Achse, aufs Raster gezogen — bei anderem
        # Seitenverhältnis verzerrt. p_hoch = a·p_raster + b.
        ax, ay = ANTEIL * w / wt, ANTEIL * h / ht
        bx, by = (w - ax * wt) / 2.0, (h - ay * ht) / 2.0
        intr = {"fx": fpx / ax, "fy": fpx / ay, "cx": (cx - bx) / ax, "cy": (cy - by) / ay, "width": wt, "height": ht}
        # COLMAP: r Welt→Kamera (rdf). Atlas: Kamera→Welt (rub) in der Atlas-Welt.
        r_c2w_rub = WELT_R @ b["r"].T @ _FLIP
        zentrum = _in_welt(b["zentrum"])
        # Tiefe: Punkte der Vorlage in diese Kamera projiziert, 3×3 Pixel je Punkt, z-Puffer
        kam = (welt_punkte - zentrum) @ (r_c2w_rub @ _FLIP)       # rdf-Koordinaten
        vorn = kam[:, 2] > 1e-3
        k = kam[vorn]
        u = intr["fx"] * k[:, 0] / k[:, 2] + intr["cx"]
        v = intr["fy"] * k[:, 1] / k[:, 2] + intr["cy"]
        tiefe = np.full((ht, wt), np.inf, np.float32)
        for du in (-1, 0, 1):
            for dv in (-1, 0, 1):
                ui, vi = np.floor(u).astype(int) + du, np.floor(v).astype(int) + dv
                drin = (ui >= 0) & (ui < wt) & (vi >= 0) & (vi < ht)
                np.minimum.at(tiefe, (vi[drin], ui[drin]), k[drin, 2].astype(np.float32))
        konf = np.where(np.isfinite(tiefe), 255, 0).astype(np.uint8)
        tiefe[~np.isfinite(tiefe)] = 0.0
        exr = _exr(tiefe)
        puffer = io.BytesIO()
        Image.fromarray(konf, "L").save(puffer, "PNG")
        bild = io.BytesIO()
        Image.fromarray(eigen).resize((wt, ht), Image.LANCZOS, box=(bx, by, bx + ax * wt, by + ay * ht)).save(bild, "PNG")
        frames.append({
            "imageAsset": _asset_antwort(_asset_neu(bild.getvalue(), f"{datei}.png", "image/png")),
            "camera": {"extrinsics": {"position": zentrum.tolist(), "quaternion": _quaternion_xyzw(r_c2w_rub),
                                      "coordinateSystem": "rub"}, "intrinsics": intr},
            "depth": {"depthAsset": _asset_antwort(_asset_neu(exr, f"{datei}.exr", "image/x-exr")),
                      "confidenceAsset": _asset_antwort(_asset_neu(puffer.getvalue(), f"{datei}.konf.png", "image/png"))},
        })
    return {"frames": frames, "poseRefinementAccepted": True if koerper.get("refinePoses") else None}


def _exr(tiefe: np.ndarray) -> bytes:
    """ZIP-komprimiert in halber Genauigkeit über OpenCV, sonst unkomprimiert."""
    try:
        os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
        import cv2
        ok, puffer = cv2.imencode(".exr", tiefe, [cv2.IMWRITE_EXR_TYPE, cv2.IMWRITE_EXR_TYPE_HALF,
                                                  cv2.IMWRITE_EXR_COMPRESSION, 3])
        if ok:
            return puffer.tobytes()
    except ImportError:
        pass
    return W.exr_schreiben(tiefe)


# ── splats2Mesh ────────────────────────────────────────────────────────────

def _spz_lesen(daten: bytes):
    roh = gzip.decompress(daten)
    magic, version, n, sh, bits = struct.unpack_from("<IIIBB", roh, 0)
    assert magic == 0x5053474E, "kein SPZ"
    p = 16
    pos = np.frombuffer(roh, np.uint8, n * 9, p).reshape(n, 3, 3).astype(np.int32)
    werte = pos[..., 0] | (pos[..., 1] << 8) | (pos[..., 2] << 16)
    werte = np.where(werte & 0x800000, werte - (1 << 24), werte)
    p += n * 9
    alpha = np.frombuffer(roh, np.uint8, n, p) / 255.0
    return werte / float(1 << bits), alpha


def splats2mesh(koerper: dict) -> dict:
    import trimesh

    xyz, alpha = _spz_lesen(ASSETS[koerper["splatAsset"]["assetId"]]["daten"])
    kandidaten = np.nonzero(alpha > 0.5)[0]
    wahl = np.random.default_rng(3).choice(kandidaten, min(3000, len(kandidaten)), replace=False)
    lo, hi = np.percentile(xyz[kandidaten], [2, 98], axis=0)
    kante = float(np.linalg.norm(hi - lo)) / 300.0
    wuerfel = []
    farben = []
    for i in wahl:
        m = trimesh.creation.box(extents=[kante] * 3)
        m.apply_translation(xyz[i])
        wuerfel.append(m)
        farben.append(np.tile([[220, 80, 40, 255]], (len(m.vertices), 1)))
    gesamt = trimesh.util.concatenate(wuerfel)
    gesamt.visual.vertex_colors = np.vstack(farben)
    glb = gesamt.export(file_type="glb")
    return {"mesh": _asset_antwort(_asset_neu(glb, "mesh.glb", "model/gltf-binary")),
            "anchorPositions": (koerper.get("cameras") or {}).get("anchors")}


AUFGABEN = {"images2PosedRGBD": images2posed, "splats2Mesh": splats2mesh}


# ── HTTP ───────────────────────────────────────────────────────────────────

class Bearbeiter(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[attrappe] " + fmt % args + "\n")

    def _json(self, obj, status=200):
        roh = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(roh)))
        self.end_headers()
        self.wfile.write(roh)

    def _koerper(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_GET(self):
        if self.path.startswith("/dateien/"):
            a = ASSETS.get(self.path.rsplit("/", 1)[1])
            if not a:
                return self._json({"detail": "unbekannt"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", a["mime"])
            self.send_header("Content-Length", str(len(a["daten"])))
            self.end_headers()
            self.wfile.write(a["daten"])
            return
        if self.path.startswith("/api/v2/assets"):
            return self._json({"assets": []})
        self._json({"detail": "unbekannt"}, 404)

    def do_PUT(self):
        if self.path.startswith("/hochladen/"):
            ASSETS[self.path.rsplit("/", 1)[1]]["daten"] = self._koerper()
            return self._json({})
        self._json({"detail": "unbekannt"}, 404)

    def do_POST(self):
        if self.headers.get("WLT-Api-Key") is None and not self.path.startswith("/hochladen"):
            return self._json({"detail": "kein Schlüssel"}, 401)
        p = self.path.split("?")[0]
        roh = self._koerper()
        if p == "/api/v2/assets":
            a = json.loads(roh)["asset"]
            b64 = a.get("base64")
            if b64:
                kopf, _, rest = b64.partition(",") if b64.startswith("data:") else ("", "", b64)
                mime = kopf[5:].split(";")[0] if kopf else "application/octet-stream"
                return self._json({"id": _asset_neu(base64.b64decode(rest), a.get("displayName") or "", mime),
                                   "state": "READY"})
            return self._json({"id": _asset_neu(b"", a.get("displayName") or "", "application/octet-stream"),
                               "state": "CREATED"})
        if p.endswith(":createUploadUrl"):
            kennung = p.split("/")[-1].split(":")[0]
            return self._json({"uploadUrl": f"{BASIS}/hochladen/{kennung}", "method": "PUT", "headers": {},
                               "expiresAt": "2099-01-01T00:00:00Z"})
        if p.endswith(":completeUpload"):
            return self._json({"id": p.split("/")[-1].split(":")[0], "state": "READY"})
        if p.endswith(":createReadUrl"):
            kennung = p.split("/")[-1].split(":")[0]
            return self._json({"readUrl": f"{BASIS}/dateien/{kennung}", "expiresAt": "2099-01-01T00:00:00Z"})
        if p.startswith("/api/v2/tasks:"):
            aufgabe = p.split(":", 1)[1]
            if aufgabe not in AUFGABEN:
                return self._json({"detail": "Not Found"}, 404)
            schluessel = self.headers.get("Idempotency-Key") or uuid.uuid4().hex
            for op in OPS.values():
                if op["schluessel"] == schluessel:
                    return self._json(op["oeffentlich"], 201)
            kennung = "op_" + uuid.uuid4().hex[:20]
            try:
                antwort, fehler = AUFGABEN[aufgabe](json.loads(roh)), None
            except Exception as e:  # noqa: BLE001
                antwort, fehler = None, {"code": 3, "message": f"Attrappe: {e}"}
            OPS[kennung] = {"schluessel": schluessel, "antwort": antwort, "fehler": fehler, "abfragen": 0,
                            "oeffentlich": {"id": kennung, "done": False, "error": None, "response": None,
                                            "metadata": {"task": aufgabe}, "name": f"operations/{kennung}",
                                            "ownerId": "attrappe"}}
            return self._json(OPS[kennung]["oeffentlich"], 201)
        if p.startswith("/api/v2/operations/") and p.endswith(":wait"):
            op = OPS.get(p.split("/")[-1].split(":")[0])
            if not op:
                return self._json({"detail": "unbekannt"}, 404)
            op["abfragen"] += 1
            o = dict(op["oeffentlich"])
            if op["abfragen"] < 2:
                o["metadata"] = {**o["metadata"], "state": "RUNNING", "phase": "rechnet", "progressPercent": 50}
                return self._json(o)
            o.update(done=True, response=op["antwort"], error=op["fehler"])
            return self._json(o)
        self._json({"detail": "unbekannt"}, 404)


def main():
    global VORLAGE, BASIS
    ap = argparse.ArgumentParser()
    ap.add_argument("--vorlage", required=True)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--basis", default=None, help="Adresse, unter der Dateien abrufbar sind (Container: host.docker.internal)")
    a = ap.parse_args()
    VORLAGE = Path(a.vorlage)
    BASIS = a.basis or f"http://127.0.0.1:{a.port}"
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Bearbeiter)
    print(f"Attrappe auf :{a.port}, Vorlage {VORLAGE.name}, Dateien unter {BASIS}", flush=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
