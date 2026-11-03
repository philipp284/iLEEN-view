"""
Baut aus den Segmentierungsdaten ein Blender-Modell und exportiert es als GLB.

Wird von pipeline.py gerufen:  blender -b --python blender_bau.py -- <ordner>

Jedes erkannte Objekt wird ein eigenes Blender-Objekt in einer nach Gewerk
sortierten Collection — kein Monolith. Das Gelände trägt das Orthophoto als
Textur; damit sieht man im Modell noch, woher es kommt.

Wichtig für die Weitergabe: der Export läuft mit `export_yup=False`. Die
Mesh-Pipeline des iLEEN-Backends erwartet Z-up und dreht selbst nach Y-up —
ein Y-up-Export käme dort um 90° gekippt an.
"""

import json
import math
import os
import sys

import bpy
import numpy as np

# Absolut, nicht relativ: die gespeicherte .blend merkt sich den Pfad zur
# Orthophoto-Textur. Relativ notiert findet sie das Bild nur wieder, solange
# jemand aus demselben Verzeichnis heraus startet — sonst rendert das Gelände
# magenta.
ORDNER = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else ".")


def P(*teile):
    return os.path.join(ORDNER, *teile)


bpy.ops.wm.read_factory_settings(use_empty=True)
szene = bpy.context.scene
szene.unit_settings.system = "METRIC"
szene.unit_settings.length_unit = "METERS"

SAMMLUNG = {}
for name in ["Gelaende", "Verkehr", "Bauwerke", "Baustelle", "Vegetation", "Fahrzeuge"]:
    c = bpy.data.collections.new(name)
    szene.collection.children.link(c)
    SAMMLUNG[name] = c


def material(name, rgba, rauheit=0.85, metall=0.0):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rauheit
    b.inputs["Metallic"].default_value = metall
    m.diffuse_color = rgba
    return m


def material_textur(name, bild):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    baum = m.node_tree
    b = baum.nodes["Principled BSDF"]
    knoten = baum.nodes.new("ShaderNodeTexImage")
    knoten.image = bpy.data.images.load(bild)
    knoten.location = (-400, 200)
    baum.links.new(knoten.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.95
    return m


def objekt(name, ecken, flaechen, mat, sammlung, uv=None):
    netz = bpy.data.meshes.new(name)
    netz.from_pydata([tuple(v) for v in ecken], [], [list(f) for f in flaechen])
    netz.validate()
    netz.update()
    if uv is not None:
        schicht = netz.uv_layers.new(name="UVMap")
        for i, schleife in enumerate(netz.loops):
            schicht.data[i].uv = tuple(uv[schleife.vertex_index])
    o = bpy.data.objects.new(name, netz)
    o.data.materials.append(mat)
    sammlung.objects.link(o)
    for p in netz.polygons:
        p.use_smooth = False
    return o


def quader(mitte_ecken, z0, z1):
    """Sechs Flächen über vier Grundrissecken."""
    v = [(p[0], p[1], z0) for p in mitte_ecken] + [(p[0], p[1], z1) for p in mitte_ecken]
    f = [[0, 1, 2, 3], [7, 6, 5, 4], [4, 5, 1, 0], [5, 6, 2, 1], [6, 7, 3, 2], [7, 4, 0, 3]]
    return v, f


# ── Gelände mit Orthophoto ────────────────────────────────────────────────
N = np.load(P("netz.npz"))
V, UV = N["V"], N["UV"]
textur = material_textur("Orthophoto", P("ortho.png"))
for schluessel, sammlung in [("Gelaende_Umgebung", "Gelaende"),
                             ("Gelaende_Baugrube", "Gelaende"),
                             ("Verkehrsflaeche", "Verkehr")]:
    F = N["F_" + schluessel]
    if len(F) == 0:
        continue
    genutzt = np.unique(F)
    neu = -np.ones(len(V), np.int64)
    neu[genutzt] = np.arange(len(genutzt))
    objekt(schluessel, V[genutzt], neu[F], textur, SAMMLUNG[sammlung], uv=UV[genutzt])
    print("  %-20s %6d Flächen" % (schluessel, len(F)))

E = json.load(open(P("elemente.json")))

# ── Baukörper ─────────────────────────────────────────────────────────────
m_gebaeude = material("Bestandsgebaeude", (0.72, 0.70, 0.66, 1), 0.8)
for i, g in enumerate(E["Gebaeude"], 1):
    ring = [tuple(c) for c in g["ring"]]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    if len(ring) < 3:
        continue
    n = len(ring)
    z0, z1 = g["z_fuss"] - 0.3, g["z_fuss"] + g["hoehe"]
    ecken = [(p[0], p[1], z0) for p in ring] + [(p[0], p[1], z1) for p in ring]
    flaechen = [[k, (k + 1) % n, n + (k + 1) % n, n + k] for k in range(n)]
    flaechen.append(list(range(n - 1, -1, -1)))
    flaechen.append(list(range(n, 2 * n)))
    o = objekt("Gebaeude_%02d" % i, ecken, flaechen, m_gebaeude, SAMMLUNG["Bauwerke"])
    o["Hoehe"] = round(g["hoehe"], 2)
    o["Grundflaeche"] = round(g["flaeche"], 1)
print("  Gebäude: %d" % len(E["Gebaeude"]))

# ── Bauzaun: die Achse in Regelfelder teilen ──────────────────────────────
m_zaun = material("Bauzaun_Gitter", (0.78, 0.79, 0.82, 1), 0.45, 0.80)
m_fuss = material("Bauzaun_Fuss", (0.62, 0.16, 0.12, 1), 0.85)
m_pfosten = material("Bauzaun_Pfosten", (0.70, 0.71, 0.74, 1), 0.45, 0.80)
FELD = 3.5
zaehler = 0
for abschnitt in E["Bauzaun"]:
    pfad = [np.array(c) for c in abschnitt["pfad"]]
    hoehe, z_fuss = abschnitt["hoehe"], abschnitt["z_fuss"]
    felder = []
    for a, b in zip(pfad[:-1], pfad[1:]):
        strecke = b - a
        laenge = np.linalg.norm(strecke)
        if laenge < 1e-6:
            continue
        richtung = strecke / laenge
        s = 0.0
        while s + FELD <= laenge:
            felder.append((a + richtung * s, a + richtung * (s + FELD)))
            s += FELD
    for a, b in felder:
        zaehler += 1
        d = b - a
        laenge = np.linalg.norm(d)
        quer = np.array([-d[1], d[0]]) / laenge * 0.045
        ecken = [(a[0] + quer[0], a[1] + quer[1]), (b[0] + quer[0], b[1] + quer[1]),
                 (b[0] - quer[0], b[1] - quer[1]), (a[0] - quer[0], a[1] - quer[1])]
        v, f = quader(ecken, z_fuss + 0.12, z_fuss + hoehe)
        objekt("Bauzaunfeld_%03d" % zaehler, v, f, m_zaun, SAMMLUNG["Baustelle"])
        for i, punkt in enumerate((a, b)):
            v, f = quader([(punkt[0] - 0.05, punkt[1] - 0.05), (punkt[0] + 0.05, punkt[1] - 0.05),
                           (punkt[0] + 0.05, punkt[1] + 0.05), (punkt[0] - 0.05, punkt[1] + 0.05)],
                          z_fuss + 0.12, z_fuss + hoehe + 0.05)
            objekt("Bauzaunpfosten_%03d_%d" % (zaehler, i), v, f, m_pfosten, SAMMLUNG["Baustelle"])
            v, f = quader([(punkt[0] - 0.35, punkt[1] - 0.12), (punkt[0] + 0.35, punkt[1] - 0.12),
                           (punkt[0] + 0.35, punkt[1] + 0.12), (punkt[0] - 0.35, punkt[1] + 0.12)],
                          z_fuss, z_fuss + 0.14)
            objekt("Bauzaunfuss_%03d_%d" % (zaehler, i), v, f, m_fuss, SAMMLUNG["Baustelle"])
print("  Bauzaunfelder: %d (%.0f m)" % (zaehler, zaehler * FELD))

# ── Bäume ─────────────────────────────────────────────────────────────────
m_stamm = material("Baumstamm", (0.25, 0.16, 0.09, 1), 0.95)
m_krone = material("Baumkrone", (0.18, 0.38, 0.12, 1), 0.95)
for i, baum in enumerate(E["Baeume"], 1):
    hoehe = baum["hoehe"]
    radius = max(baum["radius"], 0.9)
    fuss = baum["z"]
    stammhoehe = max(hoehe * 0.32, 1.0)
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=max(radius * 0.10, 0.10),
                                        depth=stammhoehe,
                                        location=(baum["x"], baum["y"], fuss + stammhoehe / 2))
    stamm = bpy.context.object
    stamm.name = "Baum_%02d_Stamm" % i
    stamm.data.materials.append(m_stamm)
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=2, radius=radius,
        location=(baum["x"], baum["y"], fuss + stammhoehe + (hoehe - stammhoehe) * 0.5))
    krone = bpy.context.object
    krone.name = "Baum_%02d_Krone" % i
    krone.scale = (1.0, 1.0, max((hoehe - stammhoehe) / (2 * radius), 0.5))
    krone.data.materials.append(m_krone)
    krone["Baumhoehe"] = round(hoehe, 1)
    krone["Kronenradius"] = round(radius, 1)
    for o in (stamm, krone):
        for c in list(o.users_collection):
            c.objects.unlink(o)
        SAMMLUNG["Vegetation"].objects.link(o)
print("  Bäume: %d" % len(E["Baeume"]))

# ── Fahrzeuge, Container, Ausstattung, Baumaschinen ───────────────────────
ART = {
    "Fahrzeug": ("Fahrzeug", (0.55, 0.56, 0.60, 1), 0.35, 0.6, "Fahrzeuge"),
    "Container": ("Container", (0.85, 0.52, 0.12, 1), 0.6, 0.3, "Baustelle"),
    "Ausstattung": ("Baustellenausstattung", (0.62, 0.62, 0.64, 1), 0.7, 0.2, "Baustelle"),
    "Kleinteil": ("Kleinteil", (0.5, 0.5, 0.5, 1), 0.8, 0.0, "Baustelle"),
    "Baumaschine": ("Baumaschine", (0.92, 0.66, 0.05, 1), 0.5, 0.35, "Baustelle"),
}
gezaehlt = {}
for box in E["Boxen"]:
    art = box["klasse"]
    name, rgba, rauheit, metall, sammlung = ART[art]
    gezaehlt[art] = gezaehlt.get(art, 0) + 1
    ecken = [tuple(c) for c in box["ecken"][:4]]
    if len(ecken) < 4:
        continue
    v, f = quader(ecken, box["z_fuss"] - 0.05, box["z_fuss"] + box["hoehe"])
    o = objekt("%s_%02d" % (art, gezaehlt[art]), v, f,
               material(name, rgba, rauheit, metall), SAMMLUNG[sammlung])
    o["Hoehe"] = round(box["hoehe"], 2)
for k, v in gezaehlt.items():
    print("  %s: %d" % (k, v))

# ── Export ────────────────────────────────────────────────────────────────
from mathutils import Vector  # noqa: E402

lo = np.full(3, 1e18)
hi = np.full(3, -1e18)
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    for ecke in o.bound_box:
        p = o.matrix_world @ Vector(ecke)
        lo = np.minimum(lo, [p.x, p.y, p.z])
        hi = np.maximum(hi, [p.x, p.y, p.z])
json.dump(dict(lo=lo.tolist(), hi=hi.tolist()), open(P("bbox_glb.json"), "w"))

for o in bpy.data.objects:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=P("modell.glb"), export_format="GLB", export_apply=True,
                          export_yup=False, export_texcoords=True, export_normals=True,
                          export_materials="EXPORT")
bpy.ops.wm.save_as_mainfile(filepath=P("modell.blend"))
print("Objekte gesamt:", len(bpy.data.objects))
print("GLB:", P("modell.glb"), os.path.getsize(P("modell.glb")) // 1024, "KB")
