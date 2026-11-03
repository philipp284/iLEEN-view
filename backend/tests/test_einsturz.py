"""
Prüfstein für das Andocken einer Einsturzrechnung (ileen/einsturz.py).

Eine Einsturzrechnung liegt im System der Studie, die Kacheln im tile-lokalen
System des IFC-Tilings. Der Bezug wird über gemeinsame Bauteile gemessen, und
dieser Prüfstein baut genau das nach — mit echten Kacheln aus den Encodern
des Tilings (`tiling/gltf.py`, `tiling/b3dm.py`), nicht mit einer Attrappe:

1. Die Hüllboxen je GlobalId kommen aus einer B3DM-Kachel richtig heraus —
   samt der Achsdrehung, die der GLB-Writer vorwegnimmt und CesiumJS wieder
   aufhebt, und samt der Translation eines Kindknotens.
2. Die Verschiebung zwischen beiden Systemen wird exakt gefunden.
3. Bauteile, deren Box in der Rechnung anders zugeschnitten ist, verfälschen
   das Ergebnis nicht.
4. Ein gedrehtes System wird abgelehnt, statt schief angedockt.
5. Ein Paket zu einem anderen Modell wird abgelehnt.

Ausführen:  python3 tests/test_einsturz.py
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import einsturz as ei  # noqa: E402
from tiling.b3dm import glb_to_b3dm  # noqa: E402
from tiling.gltf import mesh_glb  # noqa: E402

_gut = True


def pruefe(bedingung, was, ist=None, soll=None):
    global _gut
    if bedingung:
        print(f"  ok    {was}")
    else:
        _gut = False
        print(f"  FEHLT {was}")
        if ist is not None or soll is not None:
            print(f"        ist  {ist!r}")
            print(f"        soll {soll!r}")
    return bedingung


def quader(lo, hi):
    """Acht Ecken und zwölf Dreiecke eines achsparallelen Quaders."""
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    p = np.array([[x, y, z] for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)], np.float32)
    f = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
                  [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]], np.uint32)
    return p, f


def kachel(bauteile):
    """bauteile: [(gid, lo, hi)] im tile-lokalen System → B3DM-Bytes."""
    P, F, B = [], [], []
    for k, (_, lo, hi) in enumerate(bauteile):
        p, f = quader(lo, hi)
        F.append(f + sum(len(x) for x in P)); P.append(p); B.append(np.full(len(p), k, np.float32))
    p = np.concatenate(P); f = np.concatenate(F)
    glb = mesh_glb(p, np.full((len(p), 4), 200, np.uint8), f.reshape(-1), batch_ids=np.concatenate(B))
    return glb_to_b3dm(glb, len(bauteile), {"GlobalId": [g for g, _, _ in bauteile]})


# Bauwerk im System der Studie: eine Wand, eine Stütze, eine Decke
STUDIE = [
    ("0wand000000000000000001", (-5.0, -0.12, 0.0), (5.0, 0.12, 3.0)),
    ("0stuetze00000000000002", (3.0, 2.0, 0.0), (3.3, 2.3, 3.0)),
    ("0decke000000000000003", (-5.0, -3.0, 3.0), (5.0, 3.0, 3.25)),
]
VERSATZ = np.array([12.345, -6.789, -1.4878])   # Studie → tile-lokal

# ── 1. Hüllboxen aus einer echten Kachel ────────────────────────────────────

print("\nHüllboxen je GlobalId aus einer B3DM-Kachel")
kind_t = np.array([2.0, 3.0, 0.5])              # Translation des Kindknotens
tile_lokal = [(g, tuple(np.add(lo, VERSATZ) - kind_t), tuple(np.add(hi, VERSATZ) - kind_t)) for g, lo, hi in STUDIE]
roh = kachel(tile_lokal)
tileset = {
    "asset": {"version": "1.0"},
    "root": {"transform": list(np.eye(4).reshape(-1)), "boundingVolume": {"box": [0] * 12},
             "children": [{"transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, *kind_t, 1],
                           "boundingVolume": {"box": [0] * 12}, "content": {"uri": "t.b3dm"}}]},
}
boxen = ei.tileset_boxen(tileset, lambda uri: roh)
pruefe(len(boxen) == 3, "drei Bauteile gefunden", len(boxen), 3)
for g, lo, hi in STUDIE:
    b = boxen.get(g)
    pruefe(b is not None and np.allclose(b[0], np.add(lo, VERSATZ), atol=1e-5)
           and np.allclose(b[1], np.add(hi, VERSATZ), atol=1e-5),
           f"{g[:8]}: Box samt Kindtranslation und Achsdrehung",
           None if b is None else (b[0].round(4).tolist(), b[1].round(4).tolist()),
           (np.add(lo, VERSATZ).round(4).tolist(), np.add(hi, VERSATZ).round(4).tolist()))

# ── 2. Verschiebung ─────────────────────────────────────────────────────────

print("\nBezug aus den Ankern")
anker = [{"gid": g, "lo": list(lo), "hi": list(hi)} for g, lo, hi in STUDIE]
bezug = ei.bezug_rechnen(anker, boxen)
pruefe(np.allclose(bezug["verschiebung"], VERSATZ, atol=1e-5), "Verschiebung exakt",
       bezug["verschiebung"], VERSATZ.round(6).tolist())
pruefe(bezug["streuung_m"] < 1e-4, "Streuung unter 0,1 mm", bezug["streuung_m"])
pruefe(bezug["gemeinsame_bauteile"] == 3, "drei gemeinsame Bauteile", bezug["gemeinsame_bauteile"])

# ── 3. Anders zugeschnittene Bauteile ───────────────────────────────────────

print("\nEin in der Rechnung verlängertes Bauteil zählt nicht mit")
anker_x = anker + [{"gid": "0stuetze00000000000002", "lo": [3.0, 2.0, -0.4], "hi": [3.3, 2.3, 3.0]}]
anker_x = [a for a in anker_x if a["gid"] != "0stuetze00000000000002"][:2] + [anker_x[-1]]
b2 = ei.bezug_rechnen(anker_x, boxen)
pruefe(np.allclose(b2["verschiebung"], VERSATZ, atol=1e-5), "Verschiebung unverändert",
       b2["verschiebung"], VERSATZ.round(6).tolist())
pruefe(b2["zur_probe"] == 2, "nur die beiden stimmigen zur Probe", b2["zur_probe"])

# ── 4. Gedrehtes System ─────────────────────────────────────────────────────

print("\nGedrehtes System wird abgelehnt")
dreh = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], float)
anker_d = [{"gid": g, "lo": list(np.minimum(dreh @ lo, dreh @ hi)), "hi": list(np.maximum(dreh @ lo, dreh @ hi))}
           for g, lo, hi in ((g, np.array(lo), np.array(hi)) for g, lo, hi in STUDIE)]
try:
    ei.bezug_rechnen(anker_d, boxen)
    pruefe(False, "ValueError erwartet")
except ValueError as fehler:
    pruefe("Streuung" in str(fehler), "mit der gemessenen Streuung abgelehnt", str(fehler)[:80])

# ── 5. Anderes Modell ───────────────────────────────────────────────────────

print("\nPaket zu einem anderen Modell")
try:
    ei.bezug_rechnen([{"gid": "fremd", "lo": [0, 0, 0], "hi": [1, 1, 1]}], boxen)
    pruefe(False, "ValueError erwartet")
except ValueError as fehler:
    pruefe("anderen Modell" in str(fehler), "abgelehnt: kaum gemeinsame Bauteile", str(fehler)[:80])

print("\n" + ("Alles in Ordnung." if _gut else "FEHLER — siehe oben."))
sys.exit(0 if _gut else 1)
