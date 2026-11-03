"""
Prüfstein für den Atlas-Client (`ileen/atlas.py`) — ohne Netz und ohne Schlüssel.

Was still schiefgehen kann und hier deshalb geprüft wird: ein EXR, dessen
Zeilen in falscher Reihenfolge stehen (das Bild läge kopfüber zur Kamera, und
Atlas meldete keinen Fehler, sondern malte ein falsches Haus); ein Himmel, der
als 0 oder inf hinausgeht; eine Anfrage, die nur für einen Teil der Ansichten
Tiefe trägt; ein Schlüssel, der unter dem falschen Dateinamen gesucht wird
(dann sähe der Container nie, dass man sich angemeldet hat).

Ausführen:  python3 tests/test_atlas.py [--exr <datei>]
            --exr schreibt zusätzlich ein Prüf-EXR für den Gegenleser in
            frontend/tests/atlas/ (Three.js EXRLoader).
"""

import hashlib
import importlib.util
import os
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Direkt laden statt über `ileen/__init__`: das zieht JAX herein.
_spec = importlib.util.spec_from_file_location(
    "atlas", Path(__file__).resolve().parent.parent / "ileen" / "atlas.py")
A = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(A)
from splatwerk import worldlabs as W  # noqa: E402 — der gemeinsame Client

fehler = 0


def pruefe(name, ok, zusatz=""):
    global fehler
    print(("✓ " if ok else "✗ ") + name + ("" if ok or not zusatz else f"  → {zusatz}"))
    if not ok:
        fehler += 1


def kamera(x=0.0, z=0.0):
    return {"extrinsics": {"position": [x, 1.6, z], "quaternion": [0, 0, 0, 1], "coordinateSystem": "rub"},
            "intrinsics": {"fx": 900, "fy": 900, "cx": 640, "cy": 360, "width": 1280, "height": 720}}


# ── EXR ─────────────────────────────────────────────────────────────────────

h, w = A.HOEHE, A.BREITE
yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
# Oben nah, unten fern, links/rechts verschieden — jede Spiegelung fiele auf.
probe = (1.0 + yy * 0.01 + xx * 0.0001).astype(np.float32)
exr = A.exr_schreiben(probe)

pruefe("EXR beginnt mit der OpenEXR-Kennung", struct.unpack_from("<i", exr, 0)[0] == 20000630)
pruefe("EXR-Version 2, Einzelteil, Scanline", struct.unpack_from("<i", exr, 4)[0] == 2)
pruefe("EXR-Größe = Kopf + Offsets + Zeilen", len(exr) > h * (8 + 8 + w * 4))
zurueck = A.exr_lesen(exr)
pruefe("EXR verlustfrei zurückgelesen (float32)", zurueck.dtype == np.float32 and np.array_equal(zurueck, probe))
pruefe("Zeile 0 ist oben", abs(float(zurueck[0, 0]) - 1.0) < 1e-6 and float(zurueck[-1, 0]) > 8.0)
pruefe("Spalte 0 ist links", float(zurueck[0, -1]) > float(zurueck[0, 0]))
pruefe("Kanalname steht im Kopf", b"channels\0chlist\0" in exr[:200] and b"Y\0" in exr[:200])

# ── Tiefe aufbereiten ───────────────────────────────────────────────────────

roh = probe.copy()
roh[:100, :] = 0.0                 # Himmel oben
roh[100, :10] = np.nan             # kaputte Werte
tiefe, stat = A.tiefe_aufbereiten(roh.astype("<f4").tobytes(), 10000.0)
pruefe("Himmel bekommt die Himmelstiefe, nicht 0", float(tiefe[0, 0]) == 10000.0)
pruefe("NaN bekommt die Himmelstiefe", float(tiefe[100, 0]) == 10000.0)
pruefe("Keine 0, kein inf in der Tiefe", bool(np.isfinite(tiefe).all() and (tiefe > 0).all()))
pruefe("Himmelsanteil gezählt", abs(stat["himmel_anteil"] - (100 * w + 10) / (h * w)) < 1e-3, stat)
pruefe("Statistik ohne Himmel", stat["min"] >= 1.0 and stat["max"] < 20, stat)
try:
    A.tiefe_aufbereiten(b"\0" * 100, 10000.0)
    pruefe("Falsche Größe abgelehnt", False)
except ValueError:
    pruefe("Falsche Größe abgelehnt", True)

png = A.tiefe_vorschau_png(tiefe, 10000.0)
pruefe("Vorschau ist ein PNG", png[:4] == b"\x89PNG")

# ── Kameras ─────────────────────────────────────────────────────────────────

k = A.kamera_pruefen(kamera(), "Probe")
pruefe("Gültige Kamera angenommen", k["intrinsics"]["width"] == 1280 and k["extrinsics"]["coordinateSystem"] == "rub")
for name, kaputt in (("falsches Raster", {**kamera(), "intrinsics": {**kamera()["intrinsics"], "width": 1920}}),
                     ("Quaternion nicht normiert", {**kamera(), "extrinsics": {**kamera()["extrinsics"],
                                                                                "quaternion": [0, 0, 0, 3]}}),
                     ("NaN in der Lage", {**kamera(), "extrinsics": {**kamera()["extrinsics"],
                                                                      "position": [0, float("nan"), 0]}}),
                     ("fehlende Intrinsik", {"extrinsics": kamera()["extrinsics"]})):
    try:
        A.kamera_pruefen(kaputt, "Probe")
        pruefe(f"Kamera abgelehnt: {name}", False)
    except ValueError:
        pruefe(f"Kamera abgelehnt: {name}", True)

# ── Anfragekörper ───────────────────────────────────────────────────────────

ks = [kamera(0), kamera(1.5)]
b = A.chisel_koerper(prompt="  Holzhaus am Waldrand  ", kameras=ks, tiefen=["asset_a", "asset_b"], quellen=[],
                     seed=7, voxel=0.1)
pruefe("Prompt getrimmt", b["prompt"] == "Holzhaus am Waldrand")
pruefe("Eine Tiefe je Zielkamera, in Reihenfolge",
       [f["depth"]["depthAsset"]["assetId"] for f in b["contextFrames"]] == ["asset_a", "asset_b"]
       and b["contextFrames"][1]["camera"] is ks[1])
pruefe("Kontextframes tragen kein Bild, keine Maske (Chisel lehnt sie ab)",
       all(set(f) == {"camera", "depth"} for f in b["contextFrames"]))
pruefe("Seed als modelParameters", b["modelParameters"] == {"seed": 7})
pruefe("Voxel mit Weltraster", b["voxelSize"] == 0.1 and b["voxelGridOrientation"] == "world")
pruefe("Ohne Wunsch keine Tiefe zurück", "returnDepth" not in b)

b = A.chisel_koerper(prompt="x", kameras=ks, tiefen=["a", "b"], quellen=[("bild_a", ks[0])], return_depth=True)
pruefe("Farbvorgabe als sourceFrames", b["sourceFrames"] == [{"imageAsset": {"assetId": "bild_a"}, "camera": ks[0]}])
pruefe("Tiefe zurück bei zwei Standorten", b.get("returnDepth") is True)

for name, kwargs in (
        ("leerer Prompt", dict(prompt="  ", kameras=ks, tiefen=["a", "b"], quellen=[])),
        ("Tiefe nur für einen Teil", dict(prompt="x", kameras=ks, tiefen=["a", None], quellen=[])),
        ("33 Ansichten", dict(prompt="x", kameras=[kamera()] * 33, tiefen=["a"] * 33, quellen=[])),
        ("Rollout über 64", dict(prompt="x", kameras=[kamera(i) for i in range(30)], tiefen=["a"] * 30,
                                 quellen=[("b", kamera())] * 5)),
        ("Tiefe zurück ohne Basislinie", dict(prompt="x", kameras=[kamera(), kamera()], tiefen=["a", "b"],
                                              quellen=[], return_depth=True))):
    try:
        A.chisel_koerper(**kwargs)
        pruefe(f"Anfrage abgelehnt: {name}", False)
    except ValueError:
        pruefe(f"Anfrage abgelehnt: {name}", True)

# ── Schlüssel ───────────────────────────────────────────────────────────────

with tempfile.TemporaryDirectory() as d:
    W.SCHLUESSEL_DIR = Path(d)
    alt = os.environ.pop("WLT_API_KEY", None)
    try:
        pruefe("Ohne Datei kein Schlüssel", W.schluessel() == (None, None))
        name = hashlib.sha256(b"https://api.atlas-beta.worldlabs.ai").hexdigest() + ".key"
        pruefe("Dateiname wie in der CLI (sha256 der Adresse)", W.schluessel_datei().name == name,
               W.schluessel_datei().name)
        (Path(d) / name).write_text("wl_probe\n", encoding="utf-8")
        pruefe("Schlüssel aus der Datei, ohne Zeilenende", W.schluessel() == ("wl_probe", "datei"))
        os.environ["WLT_API_KEY"] = " wl_umgebung "
        pruefe("Umgebung geht vor", W.schluessel() == ("wl_umgebung", "umgebung"))
    finally:
        os.environ.pop("WLT_API_KEY", None)
        if alt is not None:
            os.environ["WLT_API_KEY"] = alt

# ── Fehlermeldungen ─────────────────────────────────────────────────────────

pruefe("402 nennt das Guthaben", "Guthaben" in W._meldung(402, "", "CREDITS_UNAVAILABLE", "/api/v2/tasks:atlasChisel"))
pruefe("402 nennt das Limit", "Ausgabenlimit" in W._meldung(402, "", "SPEND_LIMIT_EXCEEDED", "/x"))
pruefe("404 an einer Aufgabe heißt: nicht freigeschaltet",
       "atlasChisel" in W._meldung(404, "Not Found", None, "/api/v2/tasks:atlasChisel"))

if "--exr" in sys.argv:
    ziel = Path(sys.argv[sys.argv.index("--exr") + 1])
    ziel.write_bytes(exr)
    print(f"Prüf-EXR geschrieben: {ziel}")

print(f"\n{fehler} Prüfung(en) fehlgeschlagen" if fehler else "\nAlle Prüfungen bestanden.")
sys.exit(1 if fehler else 0)
