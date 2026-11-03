"""
Prüfstein für den Atlas-Weg der Splat-Pipeline — die reine Rechnung, ohne Netz.

    python3 tests/test_splat_atlas.py

Was still schiefgehen kann und hier deshalb geprüft wird:

* der Ausschnitt, den Atlas nimmt: gemessen statt angenommen (mittlere 75,4 %, am echten
  Lauf so gefunden), ein verzerrt zurückgegebenes Bild fällt auf, eine weiße Wand liefert
  keine Messung statt einer geratenen;
* die Intrinsik danach (ein Punkt muss im eigenen Bild dort landen, wo Atlas ihn im
  Raster sieht — sonst trainiert der Trainer mit falschem Bildwinkel);
* die Umrechnung RUB → COLMAP (Projektion über beide Wege gleich, Zentren zurücklesbar);
* die Rückprojektion der Tiefe (eine Ebene bleibt eben, eine Kante wirft keine
  fliegenden Punkte, Pixelmitten bei u + 0,5);
* das Zusammensetzen zweier Teile (bekannte Ähnlichkeit wird gefunden, auch wenn die
  gemeinsamen Kameras auf einer Linie stehen);
* der Rückweg des Meshes (Lage gemessen, Z oben, relativ zum Anker des Splats).
"""

import importlib.util
import math
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from splatwerk import atlas_rekon as R  # noqa: E402
from splatwerk import colmap_modell  # noqa: E402

fehler = 0


def pruefe(name, ok, zusatz=""):
    global fehler
    print(("✓ " if ok else "✗ ") + name + ("" if ok or zusatz == "" else f"  → {zusatz}"))
    if not ok:
        fehler += 1


def drehung(achse, winkel):
    a = np.asarray(achse, float) / np.linalg.norm(achse)
    k = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(winkel) * k + (1 - math.cos(winkel)) * k @ k


def quat_xyzw(r):
    w, x, y, z = colmap_modell.matrix_nach_quaternion(r)
    return [x, y, z, w]


# ── Raster ──────────────────────────────────────────────────────────────────

pruefe("Raster: Mehrheit 4:3 quer → 1280×960", R.zielraster([(4032, 3024)] * 5 + [(3024, 4032)] * 2) == (1280, 960))
pruefe("Raster: Mehrheit hoch → 960×1280", R.zielraster([(3024, 4032)] * 3 + [(4032, 3024)]) == (960, 1280))
pruefe("Raster: 16:9 → 1280×720", R.zielraster([(1920, 1080)]) == (1280, 720))

pruefe("Vorrahmen: passt schon → ganzes Bild", R.vorrahmen(1200, 1600, 960, 1280) == (0, 0, 1200, 1600))
pruefe("Vorrahmen: 4032×3024 in 1280×960 → ganzes Bild", R.vorrahmen(4032, 3024, 1280, 960) == (0, 0, 4032, 3024))
pruefe("Vorrahmen: quer im Hochformat-Raster → mittiger 3:4-Streifen",
       R.vorrahmen(1600, 1200, 960, 1280) == (350, 0, 900, 1200), R.vorrahmen(1600, 1200, 960, 1280))
pruefe("Vorrahmen: 4:3 in 16:9 → oben und unten weg", R.vorrahmen(1600, 1200, 1280, 720) == (0, 150, 1600, 900))


def textur(h, w, saat):
    """Ein Bild mit Struktur auf mehreren Skalen — daran findet SIFT, was es in einem Foto fände."""
    from PIL import Image
    rng = np.random.default_rng(saat)
    grob = np.asarray(Image.fromarray((rng.random((h // 24, w // 24, 3)) * 255).astype(np.uint8))
                      .resize((w, h), Image.BICUBIC), dtype=np.float32)
    mittel = np.asarray(Image.fromarray((rng.random((h // 6, w // 6, 3)) * 255).astype(np.uint8))
                        .resize((w, h), Image.BICUBIC), dtype=np.float32)
    return np.clip(0.6 * grob + 0.4 * mittel, 0, 255).astype(np.uint8)


def wie_atlas(bild, wt, ht, anteil=0.754):
    """So gibt das echte Atlas ein Bild zurück: die mittleren 75,4 % je Achse, aufs Raster gezogen."""
    from PIL import Image
    h, w = bild.shape[:2]
    ax, ay = anteil * w / wt, anteil * h / ht
    bx, by = (w - ax * wt) / 2, (h - ay * ht) / 2
    raster = np.asarray(Image.fromarray(bild).resize((wt, ht), Image.LANCZOS, box=(bx, by, bx + ax * wt, by + ay * ht)))
    return raster, {"ax": ax, "bx": bx, "ay": ay, "by": by}


wt, ht = 960, 1280
hoch = textur(1600, 1200, 3)
atlas_bild, soll = wie_atlas(hoch, wt, ht)
abb = R.ausschnitt_messen(hoch, atlas_bild)
pruefe("Ausschnitt gemessen", abb is not None)
if abb:
    pruefe("Ausschnitt: Maßstab auf 0,1 %", abs(abb["ax"] / soll["ax"] - 1) < 1e-3 and abs(abb["ay"] / soll["ay"] - 1) < 1e-3,
           (abb, soll))
    pruefe("Ausschnitt: Lage auf 0,5 px", abs(abb["bx"] - soll["bx"]) < 0.5 and abs(abb["by"] - soll["by"]) < 0.5, (abb, soll))
    pruefe("Ausschnitt: isotrop", R.isotrop(abb))
# Ein Querformat im Hochformat-Raster, nicht vorgerahmt: Atlas verzerrt es — das muss auffallen.
quer = textur(1200, 1600, 4)
verzerrt_bild, soll_q = wie_atlas(quer, wt, ht)
abb_q = R.ausschnitt_messen(quer, verzerrt_bild)
pruefe("Verzerrtes Bild: gemessen und als nicht isotrop erkannt", abb_q is not None and not R.isotrop(abb_q), abb_q)
anteil = R.ausschnitt_anteil([(abb, 1200, 1600), (abb_q, 1600, 1200), (None, 1200, 1600)], wt, ht)
pruefe("Anteil: Median nur über die isotropen", anteil is not None and abs(anteil[0] - 0.754) < 1e-3
       and abs(anteil[1] - 0.754) < 1e-3, anteil)
geschaetzt = R.ausschnitt_nach_anteil((0.754, 0.754), 1200, 1600, wt, ht)
pruefe("Geschätzter Ausschnitt = der von Atlas", all(abs(geschaetzt[k] - soll[k]) < 1e-9 for k in soll), geschaetzt)
pruefe("Weiße Wand: keine Messung statt einer geratenen",
       R.ausschnitt_messen(np.full((1600, 1200, 3), 200, np.uint8), np.full((ht, wt, 3), 200, np.uint8)) is None)

# Die Intrinsik: ein Punkt landet im eigenen Bild dort, wo Atlas ihn im Raster sieht — über Ausschnitt und Vorrahmen.
for (w, h) in [(1200, 1600), (1600, 1200), (3024, 4032)]:
    x0, y0, bw, bh = R.vorrahmen(w, h, wt, ht)
    a = R.abbildung_auf_quelle(R.ausschnitt_nach_anteil((0.754, 0.754), bw, bh, wt, ht), x0, y0)
    intr_t = {"fx": 1198.1, "fy": 1199.6, "cx": 480.0, "cy": 640.0, "width": wt, "height": ht}
    q = R.intrinsik_auf_quelle(intr_t, a, w, h)
    p = np.array([0.3, -0.2, 4.0])
    u_t, v_t = intr_t["fx"] * p[0] / p[2] + intr_t["cx"], intr_t["fy"] * p[1] / p[2] + intr_t["cy"]
    u_q, v_q = q["fx"] * p[0] / p[2] + q["cx"], q["fy"] * p[1] / p[2] + q["cy"]
    pruefe(f"Intrinsik {w}×{h}: Quell-Pixel = a·Raster-Pixel + b (+ Vorrahmen)",
           abs(u_q - (a["ax"] * u_t + a["bx"])) < 1e-9 and abs(v_q - (a["ay"] * v_t + a["by"])) < 1e-9)
    pruefe(f"Intrinsik {w}×{h}: Bildmitte bleibt Bildmitte", abs(q["cx"] - w / 2) < 1e-9 and abs(q["cy"] - h / 2) < 1e-9,
           (q["cx"], q["cy"]))
pruefe("Intrinsik 1200×1600: fx = 1198,1 · 0,9422 (wie am echten Lauf gemessen)",
       abs(R.intrinsik_auf_quelle({"fx": 1198.1, "fy": 1198.1, "cx": 480, "cy": 640},
                                  R.ausschnitt_nach_anteil((0.754, 0.754), 1200, 1600, wt, ht), 1200, 1600)["fx"]
           - 1198.1 * 0.754 * 1200 / 960) < 1e-9)

# ── Kameras ─────────────────────────────────────────────────────────────────

r_rub = drehung([0.2, 1.0, 0.1], 0.8)
c = np.array([3.0, 1.6, -2.0])
kam = {"extrinsics": {"position": c.tolist(), "quaternion": quat_xyzw(r_rub), "coordinateSystem": "rub"}}
zc, rr = R.kamera_rub(kam)
pruefe("RUB-Kamera gelesen", np.allclose(zc, c) and np.allclose(rr, r_rub, atol=1e-12))
kam_rdf = {"extrinsics": {"position": c.tolist(), "quaternion": quat_xyzw(r_rub @ np.diag([1, -1, -1])),
                          "coordinateSystem": "rdf"}}
pruefe("RDF-Kamera derselben Pose liest sich gleich", np.allclose(R.kamera_rub(kam_rdf)[1], r_rub, atol=1e-12))

q, t = R.colmap_pose(c, r_rub)
r_w2c = colmap_modell.quaternion_nach_matrix(q)
P = c + r_rub @ np.array([0.3, 0.2, -4.0])           # 4 m vor der Kamera (RUB: Blick −Z)
pc = r_w2c @ P + t
pruefe("COLMAP-Pose: Punkt vor der Kamera hat z > 0 (rdf)", pc[2] > 0 and abs(pc[2] - 4.0) < 1e-9, pc)
pruefe("COLMAP-Pose: Bild-rechts bleibt rechts, oben wird unten", abs(pc[0] - 0.3) < 1e-9 and abs(pc[1] + 0.2) < 1e-9, pc)

# ── Tiefe → Punkte ──────────────────────────────────────────────────────────

wt, ht = 160, 120
intr = {"fx": 150.0, "fy": 150.0, "cx": 80.0, "cy": 60.0, "width": wt, "height": ht}
# Kamera im Ursprung, Blick −Z (RUB), Ebene z = −5 (also 5 m vor der Kamera)
tiefe = np.full((ht, wt), 5.0, np.float32)
farbe = np.zeros((ht, wt, 3), np.uint8)
p, f, g = R.punkte_aus_tiefe(tiefe, farbe, intr, np.zeros(3), np.eye(3), schritt=1)
pruefe("Ebene: alle Punkte bei z = −5", len(p) == wt * ht and np.allclose(p[:, 2], -5.0), (len(p), p[:3]))
pruefe("Ebene: Pixelmitte (u + 0,5) — Mitte des Bildes liegt auf der Achse",
       np.allclose(np.sort(np.abs(p[:, 0]))[:2], 5.0 * 0.5 / 150.0))
# Kante: links 3 m, rechts 9 m → die Pixel an der Kante fallen weg
tiefe2 = np.full((ht, wt), 3.0, np.float32)
tiefe2[:, wt // 2:] = 9.0
p2, _, _ = R.punkte_aus_tiefe(tiefe2, farbe, intr, np.zeros(3), np.eye(3), schritt=1, fern_faktor=10)
abstaende = -p2[:, 2]
pruefe("Kante: keine fliegenden Punkte zwischen 3 m und 9 m",
       not np.any((abstaende > 3.01) & (abstaende < 8.99)) and len(p2) == wt * ht - 2 * ht, len(p2))
konf = np.full((ht, wt), 255, np.uint8)
konf[:10] = 40
p3, _, _ = R.punkte_aus_tiefe(tiefe, farbe, intr, np.zeros(3), np.eye(3), konfidenz=konf, schritt=1)
pruefe("Konfidenz unter der Schwelle fällt weg", len(p3) == wt * (ht - 10))
fern = tiefe.copy()
fern[:5] = 500.0
p4, _, _ = R.punkte_aus_tiefe(fern, farbe, intr, np.zeros(3), np.eye(3), schritt=1)
pruefe("Ferne (Himmel) fällt weg", np.all(-p4[:, 2] < 6), float(-p4[:, 2].max()))
pa, fa = R.ausduennen(p, f, np.ones(len(p)), 0.2, 10_000)
pruefe("Ausdünnen: höchstens ein Punkt je Voxel", len(np.unique(np.floor(pa / 0.2), axis=0)) == len(pa))

# ── Teile zusammensetzen ────────────────────────────────────────────────────

rng = np.random.default_rng(5)
zentren = np.c_[np.linspace(0, 20, 12), np.full(12, 1.6), np.zeros(12)]      # Kameras auf einer Linie
blick = np.tile([0.0, 0.0, -1.0], (12, 1)) + rng.normal(0, 0.05, (12, 3))
blick /= np.linalg.norm(blick, axis=1, keepdims=True)
s0, r0, t0 = 0.42, drehung([0.1, 1, 0], 1.1), np.array([5.0, -2, 3])
zb = (zentren - t0) @ r0 / s0                  # Teil B: B = R0ᵀ (A − t)/s
bb = blick @ r0
s, r, t, rms = R.teil_einpassen(zentren, blick, zb, bb, 5.0 / s0)
pruefe("Teile: Ähnlichkeit gefunden, auch bei Kameras auf einer Linie",
       abs(s - s0) < 1e-6 and np.allclose(r, r0, atol=1e-6) and rms < 1e-6, (s, rms))

# ── Modell schreiben und zurücklesen ───────────────────────────────────────

bilder = [{"name": f"{i:05d}.jpg", "zentrum": zentren[i], "r_rub": drehung([0, 1, 0], 0.1 * i),
           "intr": {"fx": 900.0, "fy": 900.0, "cx": 800.0, "cy": 600.0, "width": 1600, "height": 1200}} for i in range(4)]
with tempfile.TemporaryDirectory() as d:
    R.schreibe_modell(Path(d), bilder, p[:50], f[:50])
    zurueck = colmap_modell.lese_bilder_txt(Path(d) / "images.txt")
    pruefe("images.txt: Zentren zurückgelesen", all(np.allclose(z["zentrum"], b["zentrum"], atol=1e-9)
                                                    for z, b in zip(zurueck, bilder)))
    pruefe("images.txt: Bild-oben = RUB-y", all(np.allclose(z["oben"], b["r_rub"][:, 1], atol=1e-9)
                                                for z, b in zip(zurueck, bilder)))
    pruefe("points3D.txt: Punkte ohne Spur", sum(1 for z in (Path(d) / "points3D.txt").read_text().splitlines()
                                                  if z and not z.startswith("#")) == 50)
m = np.eye(4)
m[:3, :3] = 2.0 * drehung([0, 0, 1], 0.5)
m[:3, 3] = [1, 2, 3]
neu, pn = R.transformiere(bilder, p[:10], m)
pruefe("Transformation: Zentren und Punkte mit Maßstab, Drehung ohne",
       np.allclose(neu[1]["zentrum"], m[:3, :3] @ bilder[1]["zentrum"] + m[:3, 3])
       and np.allclose(neu[1]["r_rub"] @ neu[1]["r_rub"].T, np.eye(3)) and np.allclose(pn, p[:10] @ m[:3, :3].T + m[:3, 3]))

# ── Mesh-Rückweg (ohne Container) ───────────────────────────────────────────

_spec = importlib.util.spec_from_file_location("atlas_mesh", Path(__file__).resolve().parent.parent / "ileen" / "atlas_mesh.py")
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

mitte = np.array([10.0, 20.0, 3.0])
anker = M.anker(np.array([[10, 20, 30], [12, 20, 30], [10, 25, 31]], float), mitte, n=2)
pruefe("Anker: in Y-oben-Rahmen, höchstens n", len(anker) == 2 and abs(anker[0][1] - 27.0) < 1e-9, anker)
lage, iou = M.lage_waehlen(np.array([-1, -2, -3.0]), np.array([1, 5, 3.0]), np.array([-1, -2, -3.0]), np.array([1, 5, 3.0]))
pruefe("Lage: deckungsgleiche Box → wie SPZ", lage == "wie_spz" and iou > 0.99, (lage, iou))
lage, iou = M.lage_waehlen(np.array([-1, -5, -3.0]), np.array([1, 2, 3.0]), np.array([-1, -2, -3.0]), np.array([1, 5, 3.0]))
pruefe("Lage: an X gespiegelte Box → um X gekippt", lage == "um_x_gekippt" and iou > 0.99, (lage, iou))
# Der Fall vom ersten echten Lauf: Wand mit Bord davor, Hüllbox symmetrisch — die Box kann es nicht
# entscheiden, der Abstand zu den Splats schon.
rng = np.random.default_rng(5)
wand = np.c_[rng.uniform(-1, 1, 4000), rng.uniform(-0.5, 0.5, 4000), np.full(4000, -0.25)]
bord = np.c_[rng.uniform(-1, 1, 2000), np.zeros(2000), rng.uniform(-0.25, 0.25, 2000)]
kern = np.r_[wand, bord]
for name, r in M._LAGEN.items():
    gemessen = M.lage_messen(kern @ r.T, kern)            # Mesh im gedrehten Rahmen; r ist sein eigenes Inverses
    pruefe(f"Lage gemessen: {name}", gemessen["lage"] == name and gemessen["abstand_m"] < 0.02, gemessen)
lo_k, hi_k = kern.min(axis=0), kern.max(axis=0)
pruefe("Lage über die Box allein hier nicht entscheidbar (deshalb gemessen)",
       M.lage_waehlen(lo_k, hi_k, lo_k, hi_k)[1] > 0.99
       and M.lage_waehlen(*np.sort(np.stack([lo_k, hi_k]) @ M._LAGEN["um_x_gekippt"].T, axis=0), lo_k, hi_k)[1] > 0.99)
try:
    import trimesh
    box = trimesh.creation.box(extents=[2, 4, 6])
    box.apply_translation([0, 1, 0])          # im SPZ-Rahmen (Y oben): Mitte bei y = 1
    glb = box.export(file_type="glb")
    aufb = {"mitte": mitte.tolist(), "kern_lo": [-1, -1, -3], "kern_hi": [1, 3, 3]}
    mesh, bericht = M.mesh_zurueck(glb, aufb, anker_splat=np.array([10.0, 20.0, 0.0]))
    lo, hi = mesh.vertices.min(axis=0), mesh.vertices.max(axis=0)
    # Y oben → Z oben: (x, y, z) → (x, −z, y); dann + Mitte − Anker = (0, 0, 3)
    pruefe("Mesh zurück: Z oben, relativ zum Anker des Splats",
           np.allclose(lo, [-1, -3, 3 + 0 - 1], atol=1e-6) and np.allclose(hi, [1, 3, 3 + 3], atol=1e-6), (lo, hi, bericht))
    # Mit Kernpunkten: ein gekippt zurückgegebenes Mesh wird gemessen und richtig gelegt.
    wolke = trimesh.Trimesh(vertices=kern @ M._LAGEN["um_x_gekippt"].T, faces=[[0, 1, 2]] * 10, process=False)
    aufb = {"mitte": [0, 0, 0], "kern_lo": lo_k.tolist(), "kern_hi": hi_k.tolist(), "kernpunkte": kern.tolist()}
    mesh, bericht = M.mesh_zurueck(wolke.export(file_type="glb"), aufb, anker_splat=np.zeros(3))
    # Material wie bei World Labs: dieselbe Textur als Grundfarbe und als Emission (Faktor 1).
    from PIL import Image as _Bild
    textur = _Bild.new("RGB", (8, 8), (200, 160, 120))
    mat = trimesh.visual.material.PBRMaterial(baseColorTexture=textur, emissiveTexture=textur, emissiveFactor=[1, 1, 1])
    farbig = trimesh.Trimesh(vertices=kern[:3] @ M._LAGEN["um_x_gekippt"].T, faces=[[0, 1, 2]], process=False,
                             visual=trimesh.visual.TextureVisuals(uv=[[0, 0], [1, 0], [0, 1]], material=mat))
    m2, b2 = M.mesh_zurueck(farbig.export(file_type="glb"), {**aufb, "kernpunkte": kern.tolist()}, anker_splat=np.zeros(3))
    glb2 = m2.export(file_type="glb")
    import json as _json
    import struct as _struct
    kopf = _json.loads(glb2[20:20 + _struct.unpack("<I", glb2[12:16])[0]])
    pruefe("Mesh zurück: Emission entfernt, Textur einmal",
           b2.get("emission_entfernt") and len(kopf.get("images", [])) == 1
           and "emissiveTexture" not in kopf["materials"][0], kopf.get("materials"))
    pruefe("Mesh zurück: gekippte Lage gemessen und berichtigt",
           bericht["lage"] == "um_x_gekippt" and bericht["abstand_mm"] < 20 and "hinweis" not in bericht
           and np.allclose(mesh.vertices, kern @ M._ZUP_NACH_YUP, atol=1e-5), bericht)
except ImportError:
    print("(trimesh fehlt — Mesh-Rückweg übersprungen)")

print(f"\n{fehler} Prüfung(en) fehlgeschlagen" if fehler else "\nAlle Prüfungen bestanden.")
sys.exit(1 if fehler else 0)
