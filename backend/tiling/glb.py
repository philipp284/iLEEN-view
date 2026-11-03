"""
Mesh → GLB mit explizitem PBR-Material.

**Warum das nötig ist.** trimesh schreibt Vertexfarben aus `ColorVisuals`
zwar als `COLOR_0`-Attribut ins glTF, legt dabei aber überhaupt kein Material
an — das Primitive bleibt ohne `material`-Index. glTF schreibt für diesen Fall
das Default-Material vor, und das hat `metallicFactor = 1.0`.

In CesiumJS bedeutet vollmetallisch: der diffuse Anteil ist
`baseColor * (1 - metallic)` = 0. Übrig bleibt nur die Spiegelung des
Image-Based-Lightings, das bei Cesium aus dem hellen Himmel kommt. Das Modell
erscheint dadurch einheitlich weiß — völlig unabhängig davon, ob `COLOR_0`
korrekt gesetzt ist. Genau dieser Effekt hat die IFC-Farben verschluckt,
nachdem die Extraktion aus IfcOpenShell längst funktionierte. Deshalb bleiben
Meshes mit Vertexfarben matt — nur wirklich texturlose Geometrie ohne jede
Farbinformation bekommt den metallischen Standard.

`TextureVisuals` ist der einzige trimesh-Pfad, der beides exportiert:
`visual.material` wird zum glTF-Material, `visual.vertex_attributes["color"]`
zu `COLOR_0`. Beides multipliziert sich in Cesium zur sichtbaren Farbe.
"""

import logging

import numpy as np

logger = logging.getLogger(__name__)

# Farbige Meshes (Vertexfarben, z.B. PLY-Punktwolken) bleiben matt: BIM-
# Oberflächen sollen ihre eigene Farbe zeigen, nicht die des Himmels.
_COLORED_METALLIC = 0.0
_COLORED_ROUGHNESS = 1.0

# Komplett texturlose Geometrie (kein Material, keine Vertexfarben) bekommt
# einen Stahl-artigen PBR-Standardlook statt der bisherigen matten Grundfarbe.
_BARE_METALLIC = 0.9
_BARE_ROUGHNESS = 0.35
_BARE_BASE_COLOR = [140, 140, 140, 255]

# Doppelseitig in beiden Fällen, weil CAD-Exporte die Face-Orientierung
# regelmäßig nicht konsistent halten — sonst verschwinden Wände beim Umrunden.


def _vertex_colors(mesh) -> np.ndarray | None:
    """Vertexfarben als (n, 4) uint8, unabhängig davon, ob sie je Vertex oder
    je Face gesetzt wurden. `None`, wenn das Mesh keine Farben trägt."""
    visual = mesh.visual
    if getattr(visual, "kind", None) in ("vertex", "face"):
        colors = np.asarray(visual.vertex_colors, dtype=np.uint8)
    else:
        colors = getattr(visual, "vertex_attributes", {}).get("color")
        if colors is None:
            return None
        colors = np.asarray(colors, dtype=np.uint8)

    if len(colors) != len(mesh.vertices):
        logger.warning(
            f"Farbanzahl ({len(colors)}) passt nicht zur Vertexanzahl "
            f"({len(mesh.vertices)}) — Farben verworfen."
        )
        return None
    return colors


def mesh_to_glb(mesh, name: str = "surface") -> bytes:
    """
    Exportiert ein trimesh-Mesh als GLB mit garantiert vorhandenem Material.

    Bringt das Mesh bereits ein Material mit (z.B. GLB/GLTF-Quelldateien oder
    OBJ mit MTL), bleibt dieses unangetastet. Trägt es Vertexfarben (z.B. eine
    farbige PLY-Punktwolke), wird ein neutrales, mattes PBR-Material gesetzt,
    unter dem die Farben sichtbar bleiben. Hat es weder Material noch
    Vertexfarben (z.B. ein nacktes OBJ ohne MTL), bekommt es stattdessen einen
    metallischen PBR-Standardlook.
    """
    import trimesh

    if getattr(mesh.visual, "material", None) is not None:
        return mesh.export(file_type="glb")

    colors = _vertex_colors(mesh)

    # Transparenz nur einschalten, wenn sie wirklich vorkommt — BLEND kostet
    # in Cesium eine sortierte Extra-Passage und erzeugt Artefakte an Kanten.
    has_alpha = colors is not None and bool((colors[:, 3] < 255).any())

    if colors is not None:
        base_color = [255, 255, 255, 255]
        metallic, roughness = _COLORED_METALLIC, _COLORED_ROUGHNESS
    else:
        base_color = _BARE_BASE_COLOR
        metallic, roughness = _BARE_METALLIC, _BARE_ROUGHNESS

    material = trimesh.visual.material.PBRMaterial(
        name=name,
        baseColorFactor=base_color,
        metallicFactor=metallic,
        roughnessFactor=roughness,
        doubleSided=True,
        alphaMode="BLEND" if has_alpha else "OPAQUE",
    )

    mesh.visual = trimesh.visual.TextureVisuals(material=material)
    if colors is not None:
        mesh.visual.vertex_attributes["color"] = colors

    return mesh.export(file_type="glb")
