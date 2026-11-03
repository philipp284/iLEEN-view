"""
GLB-Ausgabe ohne Blender — jedes Objekt eine eigene benannte Geometrie.

Das Modell besteht aus Quadern, Extrusionen, Zylindern, Kugeln und einem
texturierten Geländenetz. Dafür braucht es keine 3D-Suite: `trimesh` baut die
Körper, setzt PBR-Materialien und schreibt die Szene als GLB, in dem jede
Geometrie ihren Namen behält.

Blender bleibt trotzdem sinnvoll — aber für das, wofür es gemacht ist: das
Nacharbeiten von Hand an der `.blend`. `blender_bau.py` macht das weiterhin.

Eine Einschränkung, die man kennen muss: das Backend tilt Meshes über
`trimesh.load(force="mesh")` und verschmilzt dabei alles zu einer einzigen
Geometrie. Im Viewer ist das GLB also ein Block — die Bauteilstruktur trägt
das IFC. Das GLB ist hier der texturierte Anblick, nichts weiter.
"""

import json
import logging
import math
from pathlib import Path

import numpy as np
import trimesh

logger = logging.getLogger(__name__)

FELDBREITE_M = 3.5

# Farbe, Rauheit, Metallanteil je Klasse.
STOFFE = {
    "Gelaende": ((140, 123, 97), 0.95, 0.0),
    "Bestandsgebaeude": ((184, 179, 168), 0.80, 0.0),
    "Bauzaun_Gitter": ((199, 201, 209), 0.45, 0.80),
    "Bauzaun_Pfosten": ((179, 181, 189), 0.45, 0.80),
    "Bauzaun_Fuss": ((158, 41, 31), 0.85, 0.0),
    "Baumstamm": ((64, 41, 23), 0.95, 0.0),
    "Baumkrone": ((46, 97, 31), 0.95, 0.0),
    "Fahrzeug": ((140, 143, 153), 0.35, 0.60),
    "Container": ((217, 133, 31), 0.60, 0.30),
    "Baustellenausstattung": ((158, 158, 163), 0.70, 0.20),
    "Kleinteil": ((128, 128, 128), 0.80, 0.0),
    "Baumaschine": ((235, 168, 13), 0.50, 0.35),
}
KLASSE_ZU_STOFF = {"Fahrzeug": "Fahrzeug", "Container": "Container",
                   "Ausstattung": "Baustellenausstattung", "Kleinteil": "Kleinteil",
                   "Baumaschine": "Baumaschine"}


def _stoff(name):
    farbe, rauheit, metall = STOFFE[name]
    return trimesh.visual.material.PBRMaterial(
        name=name, baseColorFactor=[*farbe, 255],
        roughnessFactor=rauheit, metallicFactor=metall)


def _koerper(ecken_xy, z0, z1):
    """Prismatischer Körper über einem geschlossenen Grundriss."""
    ring = [tuple(p) for p in ecken_xy]
    if len(ring) > 1 and ring[0] == ring[-1]:
        ring = ring[:-1]
    n = len(ring)
    if n < 3:
        return None
    # Umlaufsinn festlegen, damit die Mantelnormalen nach außen zeigen.
    flaeche2 = sum((ring[(i + 1) % n][0] - ring[i][0]) * (ring[(i + 1) % n][1] + ring[i][1])
                   for i in range(n))
    if flaeche2 > 0:
        ring = ring[::-1]

    punkte = np.array([[p[0], p[1], z0] for p in ring] +
                      [[p[0], p[1], z1] for p in ring], np.float64)
    dreiecke = []
    for k in range(n):
        j = (k + 1) % n
        dreiecke += [[k, j, n + j], [k, n + j, n + k]]
    # Deckel und Boden über eine Fächertriangulation. Für die hier auftretenden
    # Grundrisse — Rechtecke und leicht vereinfachte Umrisse — trägt das; ein
    # stark einspringender Umriss bekäme überlappende Dreiecke, was bei einem
    # Baukörper aus einer Punktwolke nicht vorkommt.
    for k in range(1, n - 1):
        dreiecke.append([0, k + 1, k])                   # Boden, nach unten
        dreiecke.append([n, n + k, n + k + 1])           # Deckel, nach oben
    return trimesh.Trimesh(vertices=punkte, faces=np.array(dreiecke), process=False)


def _benennen(szene, name, netz, stoffname):
    netz.visual = trimesh.visual.TextureVisuals(material=_stoff(stoffname))
    szene.add_geometry(netz, geom_name=name, node_name=name)


def bauen(ordner: Path, netzdaten: dict) -> dict:
    """Schreibt `modell.glb` und `bbox_glb.json`, gibt die Zählung zurück."""
    ordner = Path(ordner)
    szene = trimesh.Scene()
    gezaehlt = {}

    # ── Gelände mit Orthophoto
    from PIL import Image
    bild = Image.open(ordner / "ortho.png").convert("RGB")
    V, UV = netzdaten["V"], netzdaten["UV"]
    for schluessel in ("Gelaende_Umgebung", "Gelaende_Baugrube", "Verkehrsflaeche"):
        F = netzdaten["F_" + schluessel]
        if len(F) == 0:
            continue
        genutzt = np.unique(F)
        neu = -np.ones(len(V), np.int64)
        neu[genutzt] = np.arange(len(genutzt))
        teil = trimesh.Trimesh(vertices=V[genutzt].astype(np.float64),
                               faces=neu[F], process=False)
        teil.visual = trimesh.visual.TextureVisuals(
            uv=UV[genutzt],
            material=trimesh.visual.material.PBRMaterial(
                name="Orthophoto", baseColorTexture=bild, roughnessFactor=0.95,
                metallicFactor=0.0))
        szene.add_geometry(teil, geom_name=schluessel, node_name=schluessel)
        gezaehlt[schluessel] = int(len(F))

    E = json.loads((ordner / "elemente.json").read_text())

    for i, g in enumerate(E["Gebaeude"], 1):
        koerper = _koerper(g["ring"], g["z_fuss"] - 0.3, g["z_fuss"] + g["hoehe"])
        if koerper is not None:
            _benennen(szene, "Gebaeude_%02d" % i, koerper, "Bestandsgebaeude")
    gezaehlt["Gebaeude"] = len(E["Gebaeude"])

    nummer = 0
    for abschnitt in E["Bauzaun"]:
        pfad = [np.array(c) for c in abschnitt["pfad"]]
        z_fuss, hoehe = abschnitt["z_fuss"], abschnitt["hoehe"]
        for a, b in zip(pfad[:-1], pfad[1:]):
            strecke = b - a
            laenge = float(np.linalg.norm(strecke))
            if laenge < 1e-6:
                continue
            richtung = strecke / laenge
            s = 0.0
            while s + FELDBREITE_M <= laenge:
                p1, p2 = a + richtung * s, a + richtung * (s + FELDBREITE_M)
                s += FELDBREITE_M
                nummer += 1
                quer = np.array([-richtung[1], richtung[0]]) * 0.045
                feld = [(p1[0] + quer[0], p1[1] + quer[1]), (p2[0] + quer[0], p2[1] + quer[1]),
                        (p2[0] - quer[0], p2[1] - quer[1]), (p1[0] - quer[0], p1[1] - quer[1])]
                k = _koerper(feld, z_fuss + 0.12, z_fuss + hoehe)
                if k is not None:
                    _benennen(szene, "Bauzaunfeld_%03d" % nummer, k, "Bauzaun_Gitter")
                for j, punkt in enumerate((p1, p2)):
                    pfosten = [(punkt[0] - 0.05, punkt[1] - 0.05), (punkt[0] + 0.05, punkt[1] - 0.05),
                               (punkt[0] + 0.05, punkt[1] + 0.05), (punkt[0] - 0.05, punkt[1] + 0.05)]
                    k = _koerper(pfosten, z_fuss + 0.12, z_fuss + hoehe + 0.05)
                    if k is not None:
                        _benennen(szene, "Bauzaunpfosten_%03d_%d" % (nummer, j), k, "Bauzaun_Pfosten")
                    fuss = [(punkt[0] - 0.35, punkt[1] - 0.12), (punkt[0] + 0.35, punkt[1] - 0.12),
                            (punkt[0] + 0.35, punkt[1] + 0.12), (punkt[0] - 0.35, punkt[1] + 0.12)]
                    k = _koerper(fuss, z_fuss, z_fuss + 0.14)
                    if k is not None:
                        _benennen(szene, "Bauzaunfuss_%03d_%d" % (nummer, j), k, "Bauzaun_Fuss")
    gezaehlt["Bauzaunfelder"] = nummer

    for i, baum in enumerate(E["Baeume"], 1):
        hoehe = baum["hoehe"]
        radius = max(baum["radius"], 0.9)
        stammhoehe = max(hoehe * 0.32, 1.0)
        stamm = trimesh.creation.cylinder(radius=max(radius * 0.10, 0.10),
                                          height=stammhoehe, sections=8)
        stamm.apply_translation([baum["x"], baum["y"], baum["z"] + stammhoehe / 2])
        _benennen(szene, "Baum_%02d_Stamm" % i, stamm, "Baumstamm")
        krone = trimesh.creation.icosphere(subdivisions=2, radius=radius)
        krone.apply_scale([1.0, 1.0, max((hoehe - stammhoehe) / (2 * radius), 0.5)])
        krone.apply_translation([baum["x"], baum["y"],
                                 baum["z"] + stammhoehe + (hoehe - stammhoehe) * 0.5])
        _benennen(szene, "Baum_%02d_Krone" % i, krone, "Baumkrone")
    gezaehlt["Baeume"] = len(E["Baeume"])

    je_klasse = {}
    for box in E["Boxen"]:
        klasse = box["klasse"]
        je_klasse[klasse] = je_klasse.get(klasse, 0) + 1
        k = _koerper(box["ecken"][:4], box["z_fuss"] - 0.05, box["z_fuss"] + box["hoehe"])
        if k is not None:
            _benennen(szene, "%s_%02d" % (klasse, je_klasse[klasse]), k,
                      KLASSE_ZU_STOFF[klasse])
    gezaehlt.update(je_klasse)

    ziel = ordner / "modell.glb"
    ziel.write_bytes(trimesh.exchange.gltf.export_glb(szene, include_normals=True))

    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for geometrie in szene.geometry.values():
        lo = np.minimum(lo, geometrie.vertices.min(axis=0))
        hi = np.maximum(hi, geometrie.vertices.max(axis=0))
    (ordner / "bbox_glb.json").write_text(json.dumps(dict(lo=lo.tolist(), hi=hi.tolist())))

    gezaehlt["objekte"] = len(szene.geometry)
    logger.info("GLB: %d Objekte, %.1f MB", len(szene.geometry), ziel.stat().st_size / 1e6)
    return gezaehlt
