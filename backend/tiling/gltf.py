"""
Minimaler GLB-Writer für die beiden Tile-Inhalte, die dieses Backend erzeugt.

Warum von Hand statt über trimesh: für B3DM brauchen wir ein `_BATCHID` je
Vertex (ohne das gibt es keine anklickbaren Bauteile), für Splats einen
Primitive im Modus POINTS mit den Extensions `KHR_gaussian_splatting` und
`KHR_gaussian_splatting_compression_spz_2`. Beides gibt der trimesh-Export nicht
her. Der zweite Grund ist Speicher: `mesh_glb()` schreibt direkt aus numpy-Arrays
in den Puffer, ohne dass ein 500-MB-Modell vorher als Trimesh-Objektgraph im RAM
liegen muss.

**Hochachse.** Beide Writer setzen die Modellmatrix des einzigen Knotens auf
`Z_UP_TO_Y_UP`. CesiumJS rechnet glTF-Inhalte grundsätzlich von Y-up nach Z-up
zurück; die Knotenmatrix hebt das exakt auf, sodass die Daten im Tile in dem
Z-up-System bleiben, in dem CAD, BIM und `root.transform` ohnehin denken. Für
Splats ist die Matrix zusätzlich Pflicht und nicht bloß Bequemlichkeit:
`GaussianSplatPrimitive.transformTile()` liest `content.worldTransform`
ungeprüft, und der Wert ist genau diese Knotenmatrix — fehlt sie, ist er
`undefined` und das Tile stirbt beim ersten Frame.
"""

import json
import struct

import numpy as np

from tiling.georef import Z_UP_TO_Y_UP, to_column_major
from tiling.textures import (
    CATEGORIES,
    load_basecolor_bytes,
    load_normal_bytes,
    load_orm_bytes,
)

_GLB_MAGIC = 0x46546C67
_CHUNK_JSON = 0x4E4F534A
_CHUNK_BIN = 0x004E4942

# glTF-Konstanten
FLOAT = 5126
UNSIGNED_BYTE = 5121
UNSIGNED_SHORT = 5123
UNSIGNED_INT = 5125
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
MODE_POINTS = 0
MODE_TRIANGLES = 4
_WRAP_REPEAT = 10497
_FILTER_LINEAR = 9729
_FILTER_LINEAR_MIPMAP_LINEAR = 9987
_MIME_JPEG = "image/jpeg"

_NODE_MATRIX = to_column_major(Z_UP_TO_Y_UP)

_SPLAT_EXT = "KHR_gaussian_splatting"
_SPLAT_SPZ_EXT = "KHR_gaussian_splatting_compression_spz_2"


class _BufferBuilder:
    """Sammelt bufferViews und hält den Binärpuffer 4-Byte-ausgerichtet."""

    def __init__(self):
        self._parts: list[bytes] = []
        self._length = 0
        self.views: list[dict] = []

    def add(self, data: bytes, target: int | None = None) -> int:
        pad = (4 - self._length % 4) % 4
        if pad:
            self._parts.append(b"\x00" * pad)
            self._length += pad

        view = {"buffer": 0, "byteOffset": self._length, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        self.views.append(view)

        self._parts.append(data)
        self._length += len(data)
        return len(self.views) - 1

    def build(self) -> bytes:
        return b"".join(self._parts)


def _pack_glb(gltf: dict, binary: bytes) -> bytes:
    """Setzt JSON- und BIN-Chunk zu einem GLB zusammen (beide 4-Byte-gepadded)."""
    json_chunk = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    binary += b"\x00" * ((4 - len(binary) % 4) % 4)

    total = 12 + 8 + len(json_chunk) + 8 + len(binary)
    return b"".join(
        (
            struct.pack("<III", _GLB_MAGIC, 2, total),
            struct.pack("<II", len(json_chunk), _CHUNK_JSON),
            json_chunk,
            struct.pack("<II", len(binary), _CHUNK_BIN),
            binary,
        )
    )


def mesh_glb(
    positions: np.ndarray,
    colors: np.ndarray,
    indices: np.ndarray,
    normals: np.ndarray | None = None,
    batch_ids: np.ndarray | None = None,
    name: str = "mesh",
) -> bytes:
    """
    Dreiecksnetz → GLB mit PBR-Material, Vertexfarben und optionalen Batch-IDs.

    * `positions` (n, 3) float32 in Z-up-Tile-Koordinaten
    * `colors` (n, 4) uint8 RGBA
    * `indices` (m, 3) oder flach, Integer
    * `normals` (n, 3) — ohne sie schaltet CesiumJS auf `LightingModel.UNLIT`
      um und stellt das Modell ohne jede Beleuchtung dar
    * `batch_ids` (n,) Integer — Index des Bauteils innerhalb dieses Tiles;
      wird als `_BATCHID` geschrieben, worüber CesiumJS die Batch Table
      auflöst und `Cesium3DTileFeature` erzeugt.

    Das Material ist bewusst nicht-metallisch und matt gesetzt: das
    glTF-Default-Material hat `metallicFactor` 1.0, und vollmetallisch heißt in
    CesiumJS diffus = 0 — das Modell erschiene rein weiß, egal wie korrekt
    `COLOR_0` ist.
    """
    positions = np.ascontiguousarray(positions, dtype=np.float32)
    colors = np.ascontiguousarray(colors, dtype=np.uint8)
    indices = np.ascontiguousarray(indices).ravel()
    vertex_count = len(positions)

    if colors.shape != (vertex_count, 4):
        raise ValueError(f"colors muss ({vertex_count}, 4) sein, ist {colors.shape}.")

    index_type, index_dtype = (
        (UNSIGNED_SHORT, np.uint16) if vertex_count <= 0xFFFF else (UNSIGNED_INT, np.uint32)
    )
    indices = indices.astype(index_dtype, copy=False)

    buffers = _BufferBuilder()
    accessors: list[dict] = []
    attributes: dict[str, int] = {}

    lo = positions.min(axis=0) if vertex_count else np.zeros(3, dtype=np.float32)
    hi = positions.max(axis=0) if vertex_count else np.zeros(3, dtype=np.float32)

    attributes["POSITION"] = len(accessors)
    accessors.append(
        {
            "bufferView": buffers.add(positions.tobytes(), ARRAY_BUFFER),
            "componentType": FLOAT,
            "count": vertex_count,
            "type": "VEC3",
            "min": [float(v) for v in lo],
            "max": [float(v) for v in hi],
        }
    )

    if normals is not None:
        normals = np.ascontiguousarray(normals, dtype=np.float32)
        if normals.shape != (vertex_count, 3):
            raise ValueError(f"normals muss ({vertex_count}, 3) sein, ist {normals.shape}.")
        attributes["NORMAL"] = len(accessors)
        accessors.append(
            {
                "bufferView": buffers.add(normals.tobytes(), ARRAY_BUFFER),
                "componentType": FLOAT,
                "count": vertex_count,
                "type": "VEC3",
            }
        )

    attributes["COLOR_0"] = len(accessors)
    accessors.append(
        {
            "bufferView": buffers.add(colors.tobytes(), ARRAY_BUFFER),
            "componentType": UNSIGNED_BYTE,
            "count": vertex_count,
            "type": "VEC4",
            "normalized": True,
        }
    )

    if batch_ids is not None:
        # FLOAT, obwohl UNSIGNED_SHORT für die üblichen Tile-Größen reichen
        # würde: glTF verlangt für Vertexattribute eine 4-Byte-Ausrichtung je
        # Element, und ein 2-Byte-Skalar erfüllt das nur mit ausdrücklichem
        # byteStride 4 — dann ist nichts gespart. float32 stellt Ganzzahlen bis
        # 2²⁴ exakt dar, weit jenseits der Batches je Tile.
        batch_ids = np.asarray(batch_ids)
        if len(batch_ids) != vertex_count:
            raise ValueError("batch_ids muss je Vertex einen Wert haben.")
        packed = np.ascontiguousarray(batch_ids, dtype=np.float32)
        attributes["_BATCHID"] = len(accessors)
        accessors.append(
            {
                "bufferView": buffers.add(packed.tobytes(), ARRAY_BUFFER),
                "componentType": FLOAT,
                "count": vertex_count,
                "type": "SCALAR",
            }
        )

    indices_accessor = len(accessors)
    accessors.append(
        {
            "bufferView": buffers.add(indices.tobytes(), ELEMENT_ARRAY_BUFFER),
            "componentType": index_type,
            "count": len(indices),
            "type": "SCALAR",
        }
    )

    # BLEND nur, wenn wirklich Transparenz vorkommt — die sortierte Extra-Passage
    # kostet in Cesium Leistung und erzeugt Artefakte an Kanten.
    translucent = bool((colors[:, 3] < 255).any())

    gltf = {
        "asset": {"version": "2.0", "generator": "CesiumBackend"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "matrix": _NODE_MATRIX, "name": name}],
        "meshes": [
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": attributes,
                        "indices": indices_accessor,
                        "material": 0,
                        "mode": MODE_TRIANGLES,
                    }
                ],
            }
        ],
        "materials": [
            {
                "name": name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
                "doubleSided": True,
                "alphaMode": "BLEND" if translucent else "OPAQUE",
            }
        ],
        "accessors": accessors,
        "bufferViews": buffers.views,
        "buffers": [{"byteLength": 0}],
    }

    binary = buffers.build()
    gltf["buffers"][0]["byteLength"] = len(binary)
    return _pack_glb(gltf, binary)


def mesh_glb_textured(
    positions: np.ndarray,
    normals: np.ndarray,
    colors: np.ndarray,
    uvs: np.ndarray,
    batch_ids: np.ndarray,
    primitives: dict,
    name: str = "ifc",
) -> bytes:
    """
    Wie `mesh_glb()`, aber mit mehreren Primitives — eines je Materialkategorie,
    die in diesem Tile tatsächlich vorkommt (Schlüssel `None` = unveränderter
    Flachfarben-Rest, identisch zu `mesh_glb()`s einzigem Material), plus je
    Kategorie einem eingebetteten BaseColor-/Normal-Bild.

    `primitives` ist ein Dict Kategorie → Index-Array (in den gemeinsamen
    Vertexpuffer); alle Attribut-Accessoren (POSITION/NORMAL/COLOR_0/
    TEXCOORD_0/_BATCHID) werden einmal gebaut und von allen Primitives geteilt
    — nur die Index-Accessoren und ggf. Bilder/Materialien sind je Primitive
    eigenständig. Nur die hier tatsächlich referenzierten Kategorien werden
    eingebettet: das begrenzt das Tile-Wachstum auf das, was das Tile wirklich
    braucht, statt global alle Kategorien in jedes Tile zu packen.

    Bilder werden als `bufferView` mit `mimeType` eingebettet (kein externes
    `uri`) — Pflicht für in sich geschlossene B3DM-Tiles.
    """
    positions = np.ascontiguousarray(positions, dtype=np.float32)
    normals = np.ascontiguousarray(normals, dtype=np.float32)
    colors = np.ascontiguousarray(colors, dtype=np.uint8)
    uvs = np.ascontiguousarray(uvs, dtype=np.float32)
    vertex_count = len(positions)

    index_type, index_dtype = (
        (UNSIGNED_SHORT, np.uint16) if vertex_count <= 0xFFFF else (UNSIGNED_INT, np.uint32)
    )

    buffers = _BufferBuilder()
    accessors: list[dict] = []

    lo = positions.min(axis=0) if vertex_count else np.zeros(3, dtype=np.float32)
    hi = positions.max(axis=0) if vertex_count else np.zeros(3, dtype=np.float32)

    shared: dict[str, int] = {}
    shared["POSITION"] = len(accessors)
    accessors.append(
        {
            "bufferView": buffers.add(positions.tobytes(), ARRAY_BUFFER),
            "componentType": FLOAT,
            "count": vertex_count,
            "type": "VEC3",
            "min": [float(v) for v in lo],
            "max": [float(v) for v in hi],
        }
    )
    shared["NORMAL"] = len(accessors)
    accessors.append(
        {
            "bufferView": buffers.add(normals.tobytes(), ARRAY_BUFFER),
            "componentType": FLOAT,
            "count": vertex_count,
            "type": "VEC3",
        }
    )
    shared["COLOR_0"] = len(accessors)
    accessors.append(
        {
            "bufferView": buffers.add(colors.tobytes(), ARRAY_BUFFER),
            "componentType": UNSIGNED_BYTE,
            "count": vertex_count,
            "type": "VEC4",
            "normalized": True,
        }
    )
    shared["TEXCOORD_0"] = len(accessors)
    accessors.append(
        {
            "bufferView": buffers.add(uvs.tobytes(), ARRAY_BUFFER),
            "componentType": FLOAT,
            "count": vertex_count,
            "type": "VEC2",
        }
    )
    packed_batch_ids = np.ascontiguousarray(batch_ids, dtype=np.float32)
    shared["_BATCHID"] = len(accessors)
    accessors.append(
        {
            "bufferView": buffers.add(packed_batch_ids.tobytes(), ARRAY_BUFFER),
            "componentType": FLOAT,
            "count": vertex_count,
            "type": "SCALAR",
        }
    )

    materials: list[dict] = []
    images: list[dict] = []
    textures: list[dict] = []
    samplers: list[dict] = [
        {
            "wrapS": _WRAP_REPEAT,
            "wrapT": _WRAP_REPEAT,
            "magFilter": _FILTER_LINEAR,
            "minFilter": _FILTER_LINEAR_MIPMAP_LINEAR,
        }
    ]
    mesh_primitives: list[dict] = []

    # None zuletzt, texturierte Kategorien alphabetisch — nur für eine
    # deterministische, reproduzierbare Tile-Ausgabe, keine funktionale Rolle.
    for category in sorted(primitives, key=lambda c: (c is None, c or "")):
        indices = np.ascontiguousarray(primitives[category], dtype=index_dtype)
        index_accessor = len(accessors)
        accessors.append(
            {
                "bufferView": buffers.add(indices.tobytes(), ELEMENT_ARRAY_BUFFER),
                "componentType": index_type,
                "count": len(indices),
                "type": "SCALAR",
            }
        )

        # Nur je Primitive prüfen statt über das ganze Tile — sonst würde ein
        # transparentes Glaselement in einem Tile ein unbeteiligtes opakes
        # Beton-/Metallmaterial im selben Tile mit in BLEND zwingen.
        translucent = bool((colors[np.unique(indices), 3] < 255).any())
        attributes = {
            "POSITION": shared["POSITION"],
            "NORMAL": shared["NORMAL"],
            "COLOR_0": shared["COLOR_0"],
            "_BATCHID": shared["_BATCHID"],
        }

        if category is None:
            material_index = len(materials)
            materials.append(
                {
                    "name": name,
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                        "metallicFactor": 0.0,
                        "roughnessFactor": 1.0,
                    },
                    "doubleSided": True,
                    "alphaMode": "BLEND" if translucent else "OPAQUE",
                }
            )
        else:
            attributes["TEXCOORD_0"] = shared["TEXCOORD_0"]
            props = CATEGORIES[category]

            images.append(
                {"bufferView": buffers.add(load_basecolor_bytes(category)), "mimeType": _MIME_JPEG}
            )
            textures.append({"source": len(images) - 1, "sampler": 0})
            basecolor_texture = len(textures) - 1

            images.append(
                {"bufferView": buffers.add(load_normal_bytes(category)), "mimeType": _MIME_JPEG}
            )
            textures.append({"source": len(images) - 1, "sampler": 0})
            normal_texture = len(textures) - 1

            material = {
                "name": f"{name}-{category}",
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": basecolor_texture, "texCoord": 0},
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": props.metallic_factor,
                    "roughnessFactor": props.roughness_factor,
                },
                "normalTexture": {"index": normal_texture, "texCoord": 0},
                "doubleSided": True,
                "alphaMode": "BLEND" if translucent else "OPAQUE",
            }

            # Ortsaufgelöste Rauheit statt eines Werts für die ganze Fläche: ein
            # Betonboden ist in den Vertiefungen matter als auf den Graten, eine
            # verwitterte Metallfassade rostig-matt neben blank. Ohne diese Map
            # bleibt jedes Material gleichmäßig glänzend und wirkt wie Plastik.
            #
            # Ein Bild, zwei Rollen: glTF liest Roughness aus dem Grün- und
            # Metallic aus dem Blaukanal der `metallicRoughnessTexture`, der
            # Rotkanal ist dort unbenutzt — als `occlusionTexture` referenziert
            # liefert genau dieser Kanal die Verschattung. Die Faktoren oben
            # bleiben gültig, sie wirken laut Spezifikation multiplikativ.
            orm_bytes = load_orm_bytes(category)
            if orm_bytes is not None:
                images.append({"bufferView": buffers.add(orm_bytes), "mimeType": _MIME_JPEG})
                textures.append({"source": len(images) - 1, "sampler": 0})
                orm_texture = len(textures) - 1
                material["pbrMetallicRoughness"]["metallicRoughnessTexture"] = {
                    "index": orm_texture,
                    "texCoord": 0,
                }
                material["occlusionTexture"] = {"index": orm_texture, "texCoord": 0}

            material_index = len(materials)
            materials.append(material)

        mesh_primitives.append(
            {
                "attributes": attributes,
                "indices": index_accessor,
                "material": material_index,
                "mode": MODE_TRIANGLES,
            }
        )

    gltf = {
        "asset": {"version": "2.0", "generator": "CesiumBackend"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "matrix": _NODE_MATRIX, "name": name}],
        "meshes": [{"name": name, "primitives": mesh_primitives}],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffers.views,
        "buffers": [{"byteLength": 0}],
    }
    if images:
        gltf["images"] = images
        gltf["textures"] = textures
        gltf["samplers"] = samplers

    binary = buffers.build()
    gltf["buffers"][0]["byteLength"] = len(binary)
    return _pack_glb(gltf, binary)


def splat_glb(
    spz_blob: bytes, count: int, bbox_min, bbox_max, name: str = "splats", sh_grad: int = 0
) -> bytes:
    """
    SPZ-Blob → GLB nach `KHR_gaussian_splatting` mit SPZ-Kompression.

    Die Accessoren tragen **keinen** `bufferView`: die Attributdaten entstehen
    erst beim Dekodieren des SPZ-Blocks. Sie beschreiben nur Anzahl und Typ —
    und die Typen müssen exakt zu dem passen, was der Decoder liefert
    (`finalizeSpzAttribute` legt das typed array blind mit dem im Accessor
    deklarierten `componentType` über den Speicher): POSITION, SCALE und
    ROTATION als FLOAT, COLOR_0 als normalisiertes UNSIGNED_BYTE.

    Der SPZ-Block muss **bufferView 0** sein — CesiumJS' `GltfSpzLoader` lädt
    diesen Index fest verdrahtet, ohne die Angabe in der Extension zu lesen.
    """
    buffers = _BufferBuilder()
    spz_view = buffers.add(spz_blob)
    assert spz_view == 0, "SPZ muss bufferView 0 sein — CesiumJS lädt ihn fest."

    accessors = [
        {
            "componentType": FLOAT,
            "count": count,
            "type": "VEC3",
            "min": [float(v) for v in bbox_min],
            "max": [float(v) for v in bbox_max],
        },
        {"componentType": UNSIGNED_BYTE, "count": count, "type": "VEC4", "normalized": True},
        {"componentType": FLOAT, "count": count, "type": "VEC3"},
        {"componentType": FLOAT, "count": count, "type": "VEC4"},
    ]
    # `_SCALE`/`_ROTATION` statt der extensionspräfigierten Namen
    # `KHR_gaussian_splatting:SCALE`: CesiumJS akzeptiert beide Schreibweisen,
    # aber nur die Unterstrich-Form ist gültiges glTF 2.0 — der Doppelpunkt
    # verstößt gegen die Namensregel für anwendungsspezifische Semantiken und
    # lässt jedes Tile am offiziellen Validator scheitern.
    attributes = {"POSITION": 0, "COLOR_0": 1, "_SCALE": 2, "_ROTATION": 3}

    # Höhere SH-Ordnungen: je Koeffizient ein VEC3-Accessor ohne bufferView,
    # benannt nach KHR_gaussian_splatting (`SH_DEGREE_l_COEF_n`, n = 0…2l).
    # CesiumJS liest den Grad allein aus der Zahl dieser Attribute (3, 8, 15)
    # und den Präfix aus dem ersten — Unterstrich wie bei `_SCALE`.
    for grad in range(1, sh_grad + 1):
        for koef in range(2 * grad + 1):
            attributes[f"_SH_DEGREE_{grad}_COEF_{koef}"] = len(accessors)
            accessors.append({"componentType": FLOAT, "count": count, "type": "VEC3"})

    gltf = {
        "asset": {"version": "2.0", "generator": "CesiumBackend"},
        "extensionsUsed": [_SPLAT_EXT, _SPLAT_SPZ_EXT],
        "extensionsRequired": [_SPLAT_EXT, _SPLAT_SPZ_EXT],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "matrix": _NODE_MATRIX, "name": name}],
        "meshes": [
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": attributes,
                        "mode": MODE_POINTS,
                        "extensions": {
                            _SPLAT_EXT: {
                                "extensions": {
                                    _SPLAT_SPZ_EXT: {
                                        "bufferView": spz_view,
                                        "attributes": attributes,
                                    }
                                }
                            }
                        },
                    }
                ],
            }
        ],
        "accessors": accessors,
        "bufferViews": buffers.views,
        "buffers": [{"byteLength": len(spz_blob)}],
    }

    binary = buffers.build()
    gltf["buffers"][0]["byteLength"] = len(binary)
    return _pack_glb(gltf, binary)
