"""
Einsturzsimulationen an ein Modell andocken.

Eine Einsturzrechnung entsteht außerhalb von iLEEN (Starrkörper-Feder-Modell,
Stunden auf der GPU) und kommt als Paket im Format „ileen-einsturz“ herein:
fertige Dreiecke je Starrkörper, Bewegung je Bild, Schädigung je Körper. Ihr
Koordinatensystem ist das der Rechnung — beim LUX etwa „IFC minus
Gebäudemitte“. iLEEN zeigt die Kacheln aber in einem anderen: dem
tile-lokalen System des IFC-Tilings, das das Modell zentriert hat.

## Der Bezug kommt aus gemeinsamen Bauteilen, nicht aus einem Offset

Naheliegend wäre, die Zentrierung des Tilings nachzurechnen. Das geht schief,
und zwar lautlos: Der Tiler legt die Mitte des Octree-Wurzelknotens in die
Vertices, schreibt deren Translation aber nicht in die Wurzelkachel (siehe
CLAUDE.md, „IFC-Platzierung“); das Elementverzeichnis zentriert über eine
andere Bauteilmenge. Beim LUX weichen beide Ausdehnungen um sechs Meter
voneinander ab.

Deshalb wird gemessen statt gerechnet. Das Paket bringt **Anker** mit: die
Hüllbox jedes IFC-Bauteils, aus dem es gebaut ist, im System der Rechnung,
samt GlobalId. Hier werden die Kacheln gelesen, je GlobalId die Hüllbox im
tile-lokalen System gebildet und beide verglichen. Die Verschiebung ist der
Median der Differenzen; ihre Streuung ist die Probe. Beim LUX stimmen 845
Bauteile auf unter einen Mikrometer überein.

Eine Drehung wird nicht angesetzt. Liefe die Rechnung in einem gedrehten
System, streuten die Differenzen über Meter, und das Andocken bricht mit
dieser Zahl ab, statt ein schiefes Ergebnis abzulegen.
"""

from __future__ import annotations

import json
import math
import struct
from typing import Callable

import numpy as np

# Streuung, ab der ein Bezug nicht mehr als Verschiebung gelten kann
STREUUNG_MAX_M = 0.005

_KOMPONENTEN = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16,
                5125: np.uint32, 5126: np.float32}
_ANZAHL = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

# glTF ist y-oben, 3D Tiles z-oben; CesiumJS dreht jedes Kachelmodell so
_Y_NACH_Z = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=np.float64)


def _matrix(spaltenweise) -> np.ndarray:
    return np.array(spaltenweise, dtype=np.float64).reshape(4, 4).T


def _accessor(gltf: dict, binaer: bytes, index: int) -> np.ndarray:
    a = gltf["accessors"][index]
    sicht = gltf["bufferViews"][a["bufferView"]]
    typ = np.dtype(_KOMPONENTEN[a["componentType"]])
    n = _ANZAHL[a["type"]]
    start = sicht.get("byteOffset", 0) + a.get("byteOffset", 0)
    schritt = sicht.get("byteStride") or typ.itemsize * n
    werte = np.ndarray((a["count"], n), dtype=typ, buffer=binaer, offset=start,
                       strides=(schritt, typ.itemsize))
    return werte.astype(np.float64)


def _knotenmatrix(knoten: dict) -> np.ndarray:
    if "matrix" in knoten:
        return _matrix(knoten["matrix"])
    m = np.eye(4)
    if "scale" in knoten:
        m = np.diag([*knoten["scale"], 1.0]) @ m
    if "rotation" in knoten:
        x, y, z, w = knoten["rotation"]
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        rm = np.eye(4); rm[:3, :3] = r
        m = rm @ m
    if "translation" in knoten:
        t = np.eye(4); t[:3, 3] = knoten["translation"]
        m = t @ m
    return m


def b3dm_boxen(roh: bytes, kachel: np.ndarray, y_oben: bool = True) -> dict[str, tuple]:
    """
    Hüllbox je GlobalId aus einer B3DM-Kachel, im System über der Kachel.

    `kachel` ist die aufgelaufene Transformation der Kachel ohne die der
    Wurzel — also genau das System, das `root.transform` auf die Erde setzt.
    """
    _, _, _, ftj, ftb, btj, btb = struct.unpack("<4sIIIIII", roh[:28])
    ft = json.loads(roh[28:28 + ftj] or b"{}")
    bt = json.loads(roh[28 + ftj + ftb:28 + ftj + ftb + btj] or b"{}")
    ids = bt.get("GlobalId")
    if not ids:
        return {}
    glb = roh[28 + ftj + ftb + btj + btb:]
    jl = struct.unpack("<I", glb[12:16])[0]
    gltf = json.loads(glb[20:20 + jl])
    binaer = glb[20 + jl + 8:]

    basis = kachel.copy()
    if "RTC_CENTER" in ft:
        t = np.eye(4); t[:3, 3] = ft["RTC_CENTER"]
        basis = basis @ t
    if y_oben:
        basis = basis @ _Y_NACH_Z

    boxen: dict[str, list] = {}

    def knoten_ablaufen(i: int, eltern: np.ndarray):
        k = gltf["nodes"][i]
        m = eltern @ _knotenmatrix(k)
        if "mesh" in k:
            gesehen = set()
            for prim in gltf["meshes"][k["mesh"]]["primitives"]:
                att = prim["attributes"]
                if "_BATCHID" not in att:
                    continue
                paar = (att["POSITION"], att["_BATCHID"])
                if paar in gesehen:
                    continue
                gesehen.add(paar)
                p = _accessor(gltf, binaer, att["POSITION"])
                p = p @ m[:3, :3].T + m[:3, 3]
                b = _accessor(gltf, binaer, att["_BATCHID"])[:, 0].astype(np.int64)
                for bid in np.unique(b):
                    if not 0 <= bid < len(ids):
                        continue
                    q = p[b == bid]
                    lo, hi = q.min(axis=0), q.max(axis=0)
                    alt = boxen.get(ids[bid])
                    boxen[ids[bid]] = [lo, hi] if alt is None else [np.minimum(alt[0], lo), np.maximum(alt[1], hi)]
        for kind in k.get("children", []):
            knoten_ablaufen(kind, m)

    szene = gltf["scenes"][gltf.get("scene", 0)] if gltf.get("scenes") else {"nodes": range(len(gltf["nodes"]))}
    for i in szene["nodes"]:
        knoten_ablaufen(i, basis)
    return {g: (b[0], b[1]) for g, b in boxen.items()}


def tileset_boxen(tileset: dict, lesen: Callable[[str], bytes]) -> dict[str, tuple]:
    """Alle Kacheln eines Tilesets ablaufen und die Hüllboxen je GlobalId zusammenführen."""
    y_oben = (tileset.get("asset", {}).get("gltfUpAxis", "Y") or "Y").upper() == "Y"
    boxen: dict[str, tuple] = {}

    def ablaufen(knoten: dict, m: np.ndarray, wurzel: bool):
        if not wurzel and "transform" in knoten:
            m = m @ _matrix(knoten["transform"])
        uri = (knoten.get("content") or {}).get("uri") or (knoten.get("content") or {}).get("url")
        if uri and uri.endswith(".b3dm"):
            for g, (lo, hi) in b3dm_boxen(lesen(uri), m, y_oben).items():
                alt = boxen.get(g)
                boxen[g] = (lo, hi) if alt is None else (np.minimum(alt[0], lo), np.maximum(alt[1], hi))
        for kind in knoten.get("children", []):
            ablaufen(kind, m, False)

    ablaufen(tileset["root"], np.eye(4), True)
    return boxen


def bezug_rechnen(anker: list[dict], boxen: dict[str, tuple]) -> dict:
    """
    Verschiebung vom System der Rechnung in das tile-lokale System.

    Gibt den Bezug samt Probe zurück; wirft `ValueError`, wenn die Anker nicht
    zu einer reinen Verschiebung passen.
    """
    d = []
    for a in anker:
        b = boxen.get(a["gid"])
        if b is None:
            continue
        d.append(np.concatenate([b[0] - np.asarray(a["lo"]), b[1] - np.asarray(a["hi"])]))
    if len(d) < 3:
        raise ValueError(
            f"Nur {len(d)} von {len(anker)} Ankerbauteilen stehen im Tileset — das Paket gehört "
            "vermutlich zu einem anderen Modell.")
    d = np.array(d)
    # Bauteile, deren Box in der Rechnung anders zugeschnitten ist (Durchdringungen gekappt, Anschlüsse
    # verlängert), haben unten und oben verschiedene Differenzen – sie zählen nicht mit. Aber nur, solange
    # die stimmigen die Mehrheit sind: bei einem gedrehten System bleiben gerade die drehsymmetrischen
    # Boxen stimmig (eine quadratische Stütze), und die trügen eine falsche Verschiebung ohne Streuung.
    # Sind sie in der Minderheit, müssen alle herhalten, und die Streuungsprobe entscheidet.
    gleich = np.all(np.abs(d[:, :3] - d[:, 3:]) < 1e-3, axis=1)
    gut = d[gleich] if gleich.sum() >= max(1, 0.5 * len(d)) else d
    alle = np.concatenate([gut[:, :3], gut[:, 3:]])
    verschiebung = np.median(alle, axis=0)
    streuung = float(np.max(np.percentile(alle, 95, axis=0) - np.percentile(alle, 5, axis=0)))
    if streuung > STREUUNG_MAX_M:
        raise ValueError(
            f"Die Anker passen nicht zu einer Verschiebung: Streuung {streuung * 1000:.1f} mm "
            f"über {len(gut)} Bauteile. Ist das System der Rechnung gegen das IFC gedreht?")
    return {
        "verschiebung": [round(float(v), 6) for v in verschiebung],
        "gemeinsame_bauteile": int(len(d)),
        "zur_probe": int(len(gut)),
        "streuung_m": round(streuung, 7),
        "system": "tile-lokal (unter root.transform)",
    }


def wurzelbox(tileset: dict) -> list[float] | None:
    """Hüllbox der Wurzel — ändert sie sich, wurde neu getilet und der Bezug ist veraltet."""
    box = (tileset.get("root", {}).get("boundingVolume") or {}).get("box")
    return [round(float(v), 4) for v in box] if box else None


# ── Das Format: Referenz-Schreiber ─────────────────────────────────────────────
#
# Die Studien schreiben ihre Pakete selbst (etwa `Statik-LUX/kollaps/stb/export_ileen.py`), weil sie
# unabhängig von iLEEN bleiben sollen. Hier steht die Fassung, gegen die `frontend/einsturz.js` geprüft
# wird (tests/einsturz/test-einsturz.js): weicht ein Exporter davon ab, ist er es, der falsch liegt.
#
#   Blob       gzip( uint32 Kopflänge + JSON-Kopf {name: [dtype, offset, shape], "_": {…}}
#                    + auf 8 Byte ausgerichtete Arrays )
#   Bewegung   u (3) und Drehvektor θ (3) je Körper und Bild als int16, s = sign(x)·√(|x|/X)·32767
#              (u: X = 40 m, θ: X = π), entlang der Bilder differenziert, Bytes nach Ebenen getrennt
#   Lage       p' = R(q) · (p − x0) + x0 + u     für jede Ecke p des Körpers mit Referenzpunkt x0

U_MAX_M = 40.0

# Wortschatz der Codes in `info` (je Ecke: Werkstoff, Profil, Flächenart, Seite) und in `mat`/`prof` je Körper.
# Nach Werkstoff und Profil wählt der Shader in frontend/einsturz.js Farbe und Oberfläche. Braucht eine Studie
# etwas Neues, bekommt es hier eine neue Nummer und dort einen Zweig – nie eine zweite Bedeutung einer alten
# (so kamen Linoleum und Kies der OPL zu 17/18 statt zu den Teppich- und Bitumencodes 9/10 des LUX).
WERKSTOFFE = {0: "Beton", 1: "Gipskarton", 2: "Ziegelmauerwerk", 3: "WDVS", 4: "Glas", 5: "Stahl",
              6: "Fassadenrahmen", 7: "Paneel", 8: "Holz"}
PROFILE = {0: "Wand, Sichtbeton mit Tafelstößen", 1: "Decke", 2: "Dach", 3: "GK-Wand", 4: "Mauerwerk", 5: "WDVS",
           6: "Stütze rund", 7: "Unterzug", 8: "Treppe", 9: "Fußbodenaufbau Teppich", 10: "Dachaufbau Bitumen",
           11: "EG-Fußboden Teppich", 12: "Spannbeton-TT", 13: "Annahme", 14: "Mauerwerk Annahme",
           15: "Stahlpfosten RAL 7016", 16: "Stütze eckig", 17: "Fußbodenaufbau Linoleum", 18: "Dachaufbau Kies",
           19: "EG-Fußboden Linoleum", 20: "Walzprofil grundiert", 21: "Kran signalgelb", 22: "Vollholz",
           23: "Brettschichtholz", 24: "Rundstahl"}
# Flächenart (info[2]): Oberfläche, Bruchfläche zum Nachbarkörper, Oberseite Aufbau, Seite Aufbau, Fuge zu einem
# anderen Bauteil. Seite (info[3]): 0 Deckel des Prismas (Wandfläche, Stirnfläche eines Stabs), 1 Mantel.
FLAECHEN = {0: "Oberfläche", 1: "Bruchfläche", 2: "Oberseite Aufbau", 3: "Seite Aufbau", 4: "Fuge zum Bauteil"}
# Was die vier Spalten von `schaden` bedeuten, sagt das Paket in `schadensarten` (null = kommt nicht vor).
# Ohne Angabe gilt Stahlbeton.
SCHADENSARTEN_STB = {"riss": "Riss", "fliess": "Bewehrung fließt", "druck": "Beton zerdrückt",
                     "reiss": "Bewehrung gerissen"}


def blob(arrays: dict, kopf_extra: dict | None = None) -> bytes:
    import gzip
    kopf, teile, off = {}, [], 0
    for name, a in arrays.items():
        a = np.ascontiguousarray(a)
        pad = (-off) % 8
        if pad:
            teile.append(b"\0" * pad); off += pad
        kopf[name] = [str(a.dtype), off, list(a.shape)]
        teile.append(a.tobytes()); off += a.nbytes
    if kopf_extra:
        kopf["_"] = kopf_extra
    kj = json.dumps(kopf, ensure_ascii=False, separators=(",", ":")).encode()
    kj += b" " * ((-(4 + len(kj))) % 8)
    return gzip.compress(np.uint32(len(kj)).tobytes() + kj + b"".join(teile), 6)


def kodieren(x: np.ndarray, X: float) -> np.ndarray:
    return np.clip(np.round(np.sign(x) * np.sqrt(np.abs(x) / X) * 32767), -32767, 32767).astype(np.int16)


def drehvektor(Q: np.ndarray) -> np.ndarray:
    """Quaternion (w, x, y, z) → Drehvektor (Achse · Winkel)."""
    Q = Q / np.linalg.norm(Q, axis=-1, keepdims=True)
    Q = np.where(Q[..., :1] < 0, -Q, Q)
    s = np.linalg.norm(Q[..., 1:], axis=-1, keepdims=True)
    ang = 2 * np.arctan2(s, Q[..., :1])
    return np.where(s > 1e-12, Q[..., 1:] / np.maximum(s, 1e-30) * ang, 2 * Q[..., 1:])


def bewegung(U: np.ndarray, Q: np.ndarray) -> dict:
    """U (F, NB, 3) in m, Q (F, NB, 4) als (w, x, y, z) → die beiden Byte-Ebenen lo, hi."""
    F, NB = U.shape[:2]
    S = np.concatenate([kodieren(U, U_MAX_M), kodieren(drehvektor(Q), math.pi)], -1).astype(np.int32)
    d = np.diff(S, axis=0, prepend=np.zeros((1, NB, 6), np.int32))
    d = ((d + 32768) % 65536 - 32768).astype(np.int16)
    by = d.view(np.uint8).reshape(F, NB, 6, 2)
    return {"lo": np.ascontiguousarray(by[..., 0]), "hi": np.ascontiguousarray(by[..., 1])}
