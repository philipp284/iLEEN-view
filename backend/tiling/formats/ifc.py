"""
IFC → 3D Tiles via IfcOpenShell (Python-only, kein IfcConvert-Binary nötig).

```
IFC → IfcOpenShell-Iterator → Auslagerungsdatei ─┐
        │ (Metadaten + Property-Sets)            │
        ▼                                        ▼
   properties.sqlite                  Octree über die Bauteile
                                               │
                                     je Knoten ein B3DM mit
                                     _BATCHID + Batch Table
```

**Warum nicht mehr ein einziges Tile.** Die frühere Fassung hat alle Bauteile zu
einem Mesh verschmolzen und daraus *ein* B3DM geschrieben. Bei einem 200-MB-IFC
waren das 358 MB in einem Stück, bei den 529 MB des Campus-Modells BA1-2 lief
schon das Zusammenführen im RAM aus dem Ruder — sämtliche Bauteile lagen dabei
gleichzeitig als Trimesh-Objekte vor, jedes mit eigener Farbtabelle.

Zwei Dinge lösen das:

1. **Auslagerung.** Der Geometrie-Iterator schreibt jedes Bauteil sofort als
   rohe float32/uint8-Blöcke in eine temporäre Datei. Im Speicher bleibt nur ein
   Verzeichnis mit Bounding Box und Byte-Offsets — rund hundert Byte je Bauteil
   statt einiger Kilobyte.

2. **Octree mit ADD-Verfeinerung.** Jedes Bauteil landet auf der Ebene, die zu
   seiner Größe passt: Wände, Decken und Dach im Wurzeltile, Beschläge und
   Möblierung weit unten. Beim Zoomen kommt Detail hinzu, statt dass 358 MB am
   Stück geladen werden. Weil jedes Bauteil genau einmal vorkommt, bleibt die
   Geometrie dabei vollständig — anders als bei REPLACE, wo jede Ebene den
   gesamten Inhalt ihrer Kinder noch einmal enthalten müsste.

**Anklickbare Bauteile.** Jedes Tile trägt ein `_BATCHID` je Vertex und eine
Batch Table mit GlobalId, Typ, Name und Geschoss. CesiumJS macht daraus
`Cesium3DTileFeature`-Objekte; die vollständigen Property-Sets liegen daneben in
`properties.sqlite` (siehe `semantic/properties.py`).
"""

import json
import logging
import math
import multiprocessing
import os
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from semantic.properties import PROPERTIES_FILE, PropertyWriter
from tiling.b3dm import glb_to_b3dm
from tiling.georef import build_tileset, make_tile, write_placement
from tiling.gltf import mesh_glb, mesh_glb_textured
from tiling.materials import classify_material, farbzuordnung, suggest_category
from tiling import stilindex
from tiling.textures import CATEGORIES as TEXTURE_CATEGORIES

logger = logging.getLogger(__name__)

# Fallback für Elemente ohne lesbaren Stil — neutrales Betongrau statt Weiß,
# damit unstilisierte Bauteile im Modell erkennbar bleiben.
_DEFAULT_RGBA = np.array([180, 180, 180, 255], dtype=np.uint8)

# Obergrenze je Tile. 150k Dreiecke sind rund 5–8 MB B3DM — groß genug, dass
# der Overhead je Anfrage nicht ins Gewicht fällt, klein genug für zügiges
# Nachladen über eine normale Leitung.
_TILE_TRIANGLES = int(os.getenv("IFC_TILE_TRIANGLES", "150000"))

# Tiefer als das lohnt sich nicht: bei jeder Ebene halbiert sich die Kantenlänge,
# nach 8 Ebenen ist ein 200-m-Campus bei 80 cm angekommen.
_MAX_DEPTH = int(os.getenv("IFC_MAX_DEPTH", "8"))

_EXTRACT_PSETS = os.getenv("IFC_EXTRACT_PSETS", "true").lower() not in ("0", "false", "no")

# Ordnet erkannte Materialkategorien (Beton/Metall/Gips/Holz/Linoleum) echten
# PBR-Fototexturen zu, statt sie flach einzufärben. Abschaltbar für schnelle
# A/B-Vergleiche und als Rollback-Hebel — bei false ist die Ausgabe wieder
# byte-identisch zum Verhalten vor der Textur-Unterstützung.
_TEXTURES_ENABLED = os.getenv("IFC_TEXTURES_ENABLED", "true").lower() not in ("0", "false", "no")

# Bericht über die Oberflächenstile der Datei, neben der tileset.json abgelegt.
# Grundlage des Zuordnungsassistenten im Asset-Manager (api/routes/materials.py).
MATERIALS_FILE = "materials.json"
# Bauteil → Oberflächenstil, für den Materialmodus im Asset-Manager.
# Beim Tiling geschrieben, weil die IFC-Datei hier ohnehin offen ist;
# für Altbestand baut `api/routes/materials.py` ihn nach.
MATERIAL_INDEX_FILE = "material_index.json"

# Verschweißte Vertices sind rund dreimal sparsamer, weil Nachbardreiecke sich
# ihre Ecken teilen — dafür gibt es nur eine gemittelte Normale je Punkt, und
# eine Wand aus vier Eckpunkten wird dadurch weich schattiert wie ein Zylinder.
# Ohne Welding liefert IfcOpenShell echte Flächennormalen (scharfe Kanten), bei
# etwa dreifacher Datenmenge. Voreinstellung ist der sparsame Weg.
_WELD = os.getenv("IFC_WELD_VERTICES", "true").lower() not in ("0", "false", "no")

# Threads für die Geometrieerzeugung. Jeder kostet Arbeitsspeicher; bei einem
# 500-MB-Modell liegt die Spitze mit vier Threads bereits bei mehreren GB.
_JOBS = int(os.getenv("IFC_JOBS", "0")) or max(1, min(4, multiprocessing.cpu_count()))

# Typen, die nicht ins Bild gehören. IfcOpeningElement ist der wichtigste Fall:
# das sind Aussparungsvolumen — die Wand hat ihr Loch bereits, und zusätzlich
# steckt der Negativkörper als massiver Quader darin. Im Campus-Modell sind das
# 2583 Stück, sichtbar als Platten quer durch die Fassade. IfcSpace (Raumvolumen)
# und IfcAnnotation (Bemaßung, Text) sind aus demselben Grund draußen.
_EXCLUDE_TYPES = [
    t.strip()
    for t in os.getenv(
        "IFC_EXCLUDE_TYPES",
        "IfcOpeningElement,IfcSpace,IfcVirtualElement,IfcAnnotation,IfcGrid",
    ).split(",")
    if t.strip()
]


def tile_ifc(src: Path, out_dir: Path, material_overrides: dict | None = None):
    """
    `material_overrides` ({IfcSurfaceStyle-Name: Texturkategorie}) kommt aus dem
    Zuordnungsassistenten und ersetzt für die genannten Stile die automatische
    Materialerkennung. Ein leerer Wert heißt ausdrücklich „keine Textur".
    """
    try:
        import ifcopenshell
        import ifcopenshell.geom
    except ImportError as e:
        raise RuntimeError(f"ifcopenshell nicht installiert: {e}")

    logger.info(f"IFC laden: {src.name} ({src.stat().st_size / 1e6:.0f} MB)")
    ifc_file = ifcopenshell.open(str(src))

    if _TEXTURES_ENABLED:
        _write_material_report(ifc_file, out_dir, material_overrides)

    # Die Auslagerungsdatei darf nicht in out_dir liegen — von dort würde sie
    # mit in den tiles-Bucket hochgeladen.
    with tempfile.TemporaryDirectory(prefix="ifc_tiling_") as tmp:
        store = _GeometryStore(Path(tmp) / "geometry.bin")
        try:
            elements, offset = _extract(
                ifcopenshell, ifc_file, store, out_dir, material_overrides
            )
            if not elements:
                raise RuntimeError("Keine Geometrie in der IFC-Datei gefunden.")
            store.seal()
            _write_tiles(elements, store, out_dir, offset)
        finally:
            store.close()


def _write_material_report(ifc_file, out_dir: Path, overrides: dict | None):
    """Legt `materials.json` für den Zuordnungsassistenten neben die Tiles."""
    styles = _style_report(ifc_file, overrides)
    (out_dir / MATERIALS_FILE).write_text(
        json.dumps(
            {
                "styles": styles,
                "overrides": overrides or {},
                "generated_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    textured = sum(1 for s in styles if s["category"])
    logger.info(
        f"Oberflächenstile: {len(styles)} gefunden, {textured} texturiert "
        f"({len(overrides or {})} davon manuell zugeordnet)"
    )

    # Der Stilindex kostet hier rund zwei Sekunden — die Datei ist offen und
    # gelesen wird nur der Entitätsgraph. Nachträglich kostet er das Öffnen
    # der Datei noch einmal, bei einem 554-MB-Modell also eine Viertelminute.
    try:
        index = stilindex.aufbauen(ifc_file)
        (out_dir / MATERIAL_INDEX_FILE).write_text(
            json.dumps(index, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    except Exception as e:
        # Ohne Index fehlt nur der Materialmodus, nicht das Modell.
        logger.warning(f"Stilindex nicht erstellt: {type(e).__name__}: {e}")


# ── Phase 1: Geometrie und Semantik auslesen ─────────────────────────────────


class _Element:
    """Verzeichniseintrag eines Bauteils — die Geometrie liegt in der Datei."""

    __slots__ = (
        "guid",
        "ifc_type",
        "name",
        "storey",
        "lo",
        "hi",
        "record",
        "triangles",
        "material_chunks",
    )

    def __init__(self, guid, ifc_type, name, storey, lo, hi, record, triangles, material_chunks):
        self.guid = guid
        self.ifc_type = ifc_type
        self.name = name
        self.storey = storey
        self.lo = lo
        self.hi = hi
        self.record = record
        self.triangles = triangles
        # Liste aus (Kategorie, Index-Start, Index-Anzahl), relativ zum
        # Index-Array dieses Elements in der _GeometryStore — Kategorie ist
        # `None` für unveränderte Flachfarben-Chunks. Klein (typ. 1–5
        # Einträge/Element), kein RAM-Risiko für große Modelle.
        self.material_chunks = material_chunks

    @property
    def center(self) -> np.ndarray:
        return (self.lo + self.hi) / 2.0

    @property
    def size(self) -> float:
        return float(np.max(self.hi - self.lo))


class _GeometryStore:
    """
    Append-only-Ablage für Bauteilgeometrie.

    Je Bauteil werden Positionen und Normalen (float32), Farben (uint8 RGBA),
    UV-Koordinaten (float32) und Indizes (uint32) hintereinander geschrieben;
    zurückgegeben wird ein Tripel aus Offset und Anzahlen, mit dem sich der
    Block später gezielt zurücklesen lässt.
    """

    def __init__(self, path: Path):
        self._file = path.open("w+b")
        self._offset = 0

    def append(
        self,
        verts: np.ndarray,
        normals: np.ndarray,
        colors: np.ndarray,
        uvs: np.ndarray,
        indices: np.ndarray,
    ) -> tuple:
        record = (self._offset, len(verts), len(indices))
        for block in (verts, normals, colors, uvs, indices):
            data = np.ascontiguousarray(block).tobytes()
            self._file.write(data)
            self._offset += len(data)
        return record

    def seal(self):
        """Puffer leeren — danach darf gelesen werden."""
        self._file.flush()

    def read(self, record: tuple) -> tuple:
        offset, vertex_count, index_count = record
        self._file.seek(offset)
        verts = np.fromfile(self._file, dtype=np.float32, count=vertex_count * 3)
        normals = np.fromfile(self._file, dtype=np.float32, count=vertex_count * 3)
        colors = np.fromfile(self._file, dtype=np.uint8, count=vertex_count * 4)
        uvs = np.fromfile(self._file, dtype=np.float32, count=vertex_count * 2)
        indices = np.fromfile(self._file, dtype=np.uint32, count=index_count)
        return (
            verts.reshape(-1, 3),
            normals.reshape(-1, 3),
            colors.reshape(-1, 4),
            uvs.reshape(-1, 2),
            indices,
        )

    def close(self):
        self._file.close()


def _make_settings(ifcopenshell):
    """
    Geometrie-Settings über beide IfcOpenShell-APIs hinweg.

    Bis 0.7 waren die Optionen Konstanten (`settings.USE_WORLD_COORDS`),
    ab 0.8 sind es String-Keys. Wir versuchen erst die neue Form.
    """
    settings = ifcopenshell.geom.settings()
    for new_key, legacy_attr, value in (
        ("use-world-coords", "USE_WORLD_COORDS", True),
        ("weld-vertices", "WELD_VERTICES", _WELD),
        # Ohne Welding rechnet IfcOpenShell die Normalen selbst mit; mit
        # Welding bleibt das Feld leer und wir mitteln sie hinterher.
        ("no-normals", None, _WELD),
    ):
        try:
            settings.set(new_key, value)
        except Exception:
            legacy = getattr(settings, legacy_attr, None) if legacy_attr else None
            if legacy is None:
                logger.debug(f"Setting '{new_key}' nicht unterstützt, übersprungen.")
                continue
            try:
                settings.set(legacy, value)
            except Exception:
                logger.debug(f"Setting '{new_key}' nicht unterstützt, übersprungen.")
    return settings


def _extract(
    ifcopenshell,
    ifc_file,
    store: _GeometryStore,
    out_dir: Path,
    material_overrides: dict | None = None,
    include: list | None = None,
) -> tuple:
    """
    Iteriert die Geometrie, lagert sie aus und schreibt die Eigenschaften.

    Gibt die Bauteilliste und den Offset zurück, um den die ausgelagerten
    Koordinaten noch zu verschieben sind.

    `include` beschränkt den Durchlauf auf die genannten IFC-Typen (samt
    Untertypen) — für die sortierte Ansicht (`tiling/sortiert.py`), die nur
    Türen oder nur Fenster braucht und dafür nicht das ganze Modell rechnen soll.
    Der Iterator kennt entweder `include` oder `exclude`; mit `include` entfällt
    die Ausschlussliste, die dann nichts mehr auszuschließen hätte.
    """
    import ifcopenshell.util.element

    storeys = _storey_map(ifc_file)
    style_categories = (
        _style_category_map(ifc_file, material_overrides) if _TEXTURES_ENABLED else {}
    )
    # Farbzuordnungen gelten auch bei abgeschalteten Texturen: sie erzeugen
    # keine, sie tauschen nur die Flächenfarbe.
    style_colors = _style_color_map(ifc_file, material_overrides)
    settings = _make_settings(ifcopenshell)
    if include:
        iterator = ifcopenshell.geom.iterator(
            settings, ifc_file, _JOBS, include=list(include)
        )
    else:
        excluded = _excluded_types(ifc_file)
        iterator = ifcopenshell.geom.iterator(
            settings, ifc_file, _JOBS, exclude=excluded or None
        )

    elements: list = []
    triangles = failed = 0
    # Vorläufiger Ursprung: BIM-Modelle liegen oft in Landeskoordinaten
    # (UTM-Rechtswerte um 3,4 Mio). Ohne Abzug verlöre float32 dort jede
    # Präzision. Der endgültige Bezugspunkt steht erst nach dem Durchlauf fest.
    origin: np.ndarray | None = None

    with PropertyWriter(out_dir / PROPERTIES_FILE) as properties:
        # initialize() ist False, wenn die Datei überhaupt keine darstellbare
        # Geometrie enthält — etwa ein reines Mengenmodell ohne Repräsentationen.
        if not iterator.initialize():
            return [], np.zeros(3)
        while True:
            shape = iterator.get()
            geometry = shape.geometry
            verts = np.frombuffer(geometry.verts_buffer, dtype=np.float64).reshape(-1, 3)
            faces = np.frombuffer(geometry.faces_buffer, dtype=np.int32).reshape(-1, 3)

            if len(verts) and len(faces):
                if origin is None:
                    origin = verts.mean(axis=0)
                element = _store_element(
                    store, shape, geometry, verts - origin, faces, storeys,
                    style_categories, style_colors,
                )
                elements.append(element)
                triangles += element.triangles

                if _EXTRACT_PSETS and not _write_properties(
                    properties, ifcopenshell.util.element, ifc_file, shape, element
                ):
                    failed += 1
                if len(elements) % 20000 == 0:
                    logger.info(
                        f"… {len(elements)} Bauteile, {triangles / 1e6:.1f} Mio. Dreiecke"
                    )

            if not iterator.next():
                break

        logger.info(
            f"IFC gelesen: {len(elements)} Bauteile, {triangles / 1e6:.2f} Mio. Dreiecke, "
            f"{properties.count} Eigenschaftssätze"
        )
        if failed:
            logger.warning(
                f"Bei {failed} von {len(elements)} Bauteilen waren die Property-Sets "
                "nicht lesbar — im Viewer bleiben dort nur Typ, Name und Geschoss."
            )

    if not elements:
        return [], np.zeros(3)

    # Ausgelagerte Koordinaten sind relativ zu `origin` — der wird jetzt so
    # verschoben, dass das Modell mit XY-Mitte und Z-Unterkante im Ursprung
    # steht, wie es die Platzierung erwartet.
    return elements, _recenter(elements, origin)


def _store_element(
    store, shape, geometry, verts, faces, storeys, style_categories, style_colors=None
) -> _Element:
    """Färbt/texturiert ein Bauteil, legt es in der Auslagerungsdatei ab und indiziert es."""
    verts32, normals, colors, uvs, indices, material_chunks = _textured_arrays(
        geometry, verts, faces, style_categories, style_colors
    )
    record = store.append(verts32, normals, colors, uvs, indices)
    return _Element(
        guid=shape.guid,
        ifc_type=shape.type,
        name=shape.name or None,
        storey=storeys.get(shape.id),
        lo=verts32.min(axis=0).astype(np.float64),
        hi=verts32.max(axis=0).astype(np.float64),
        record=record,
        triangles=len(indices) // 3,
        material_chunks=material_chunks,
    )


def _tile_size_m(category: str | None) -> float:
    """Meter Weltgröße je Texturwiederholung — irrelevant, aber muss ein
    gültiger Wert sein, wenn `category` None ist (Flachfarben-Chunk)."""
    return TEXTURE_CATEGORIES[category].tile_size_m if category else 1.0


def _project_uv(verts: np.ndarray, normals: np.ndarray, tile_size_m: float) -> np.ndarray:
    """
    Box-/Triplanar-Projektion: je Vertex bestimmt die dominante Normalenachse
    die Projektionsebene (dominant X → (Y,Z), dominant Y → (X,Z), dominant Z →
    (X,Y)), geteilt durch `tile_size_m` ergibt UV in Wiederholungs-Einheiten.
    Der Sampler nutzt REPEAT-Wrapping, UV außerhalb [0,1] ist also normal.

    Bei geschweißten Vertices (Standard) hat ein Vertex an einer Kante
    zwischen zwei unterschiedlich orientierten Flächen nur eine gemittelte
    Normale — die Achsenwahl kann dort für eine der beiden Flächen leicht
    "falsch" sein (sichtbare Naht). Mit `IFC_WELD_VERTICES=false` (echte
    Face-Normalen) verschwindet das vollständig.
    """
    verts = np.asarray(verts, dtype=np.float32)
    normals = np.asarray(normals, dtype=np.float32)
    dominant = np.argmax(np.abs(normals), axis=1)

    uv = np.empty((len(verts), 2), dtype=np.float32)
    for axis, cols in enumerate(((1, 2), (0, 2), (0, 1))):
        mask = dominant == axis
        uv[mask] = verts[mask][:, cols]

    uv /= tile_size_m
    return uv


def _textured_arrays(
    geometry,
    verts: np.ndarray,
    faces: np.ndarray,
    style_categories: dict,
    style_colors: dict | None = None,
) -> tuple:
    """
    Bauteilgeometrie mit Vertexfarben, UV-Koordinaten und Material-Chunk-
    Grenzen je Material.

    `geometry.material_ids` gibt je Dreieck das zuständige Material an. Ein
    Element mit mehreren Stilen — Fenster aus Rahmen und Glas, mehrschichtige
    Wände — bekäme mit einer Elementfarbe die falsche Darstellung.

    Getrennt wird über eigene Vertex-Arrays statt über Face-Farben: durch
    `weld-vertices` teilen sich benachbarte Dreiecke ihre Vertices, und beim
    Umrechnen von Face- auf Vertexfarben würden die Materialien an der Grenze
    ineinanderlaufen.

    `material_chunks` ist eine Liste aus (Kategorie, Index-Start, Index-
    Anzahl) relativ zum zurückgegebenen `indices`-Array — Kategorie ist
    `None` für Chunks, die unverändert einfarbig bleiben (kein Treffer in
    `classify_material()`, z.B. Glas, Farbanstriche, generische Stile).
    """
    # Eine Farbzuordnung aus dem Assistenten schlägt die Farbe des IFC-Stils.
    # Sie greift hier und nicht erst im glTF-Material, weil die Farbe je
    # Material-Chunk in den Vertices steckt — ein Bauteil aus Rahmen und Glas
    # bekäme sonst eine Einheitsfarbe.
    style_colors = style_colors or {}
    palette = [
        style_colors.get(m.instance_id(), _material_rgba(m)) for m in geometry.materials
    ]
    # `instance_id()` zeigt auf die Eltern-IfcSurfaceStyle-Entity (nicht die
    # `.name`-Eigenschaft des Materials selbst, die nur ein synthetischer
    # Platzhalter wie "IfcSurfaceStyleRendering-78499" ist). Elemente ohne
    # zugewiesenen Stil liefern IfcOpenShells `DefaultMaterial` mit
    # instance_id() == 0 — taucht in `style_categories` nie auf, `.get()`
    # liefert dafür korrekt None, ganz ohne Sonderfall.
    material_categories = [style_categories.get(m.instance_id()) for m in geometry.materials]
    ids = np.frombuffer(geometry.material_ids_buffer, dtype=np.int32)
    verts32 = verts.astype(np.float32)
    normals = _normals(geometry, verts, faces)

    if len(palette) <= 1 or len(ids) != len(faces):
        color = palette[0] if palette else _DEFAULT_RGBA
        category = material_categories[0] if material_categories else None
        indices = faces.astype(np.uint32).ravel()
        uv = _project_uv(verts32, normals, _tile_size_m(category))
        return (
            verts32,
            normals,
            np.tile(color, (len(verts32), 1)),
            uv,
            indices,
            [(category, 0, len(indices))],
        )

    chunks_v, chunks_n, chunks_c, chunks_u, chunks_i = [], [], [], [], []
    material_chunks, offset, index_cursor = [], 0, 0
    for material_id in np.unique(ids):
        selection = faces[ids == material_id]
        # Nur die tatsächlich benutzten Vertices übernehmen und die Indizes
        # darauf umschreiben — np.unique liefert beides in einem Durchgang.
        used, remapped = np.unique(selection, return_inverse=True)
        color = palette[material_id] if 0 <= material_id < len(palette) else _DEFAULT_RGBA
        category = (
            material_categories[material_id]
            if 0 <= material_id < len(material_categories)
            else None
        )
        chunk_indices = remapped.astype(np.uint32).ravel() + offset
        chunks_v.append(verts32[used])
        chunks_n.append(normals[used])
        chunks_c.append(np.tile(color, (len(used), 1)))
        chunks_u.append(_project_uv(verts32[used], normals[used], _tile_size_m(category)))
        chunks_i.append(chunk_indices)
        material_chunks.append((category, index_cursor, len(chunk_indices)))
        offset += len(used)
        index_cursor += len(chunk_indices)

    return (
        np.concatenate(chunks_v),
        np.concatenate(chunks_n),
        np.concatenate(chunks_c),
        np.concatenate(chunks_u),
        np.concatenate(chunks_i),
        material_chunks,
    )


def _style_category_map(ifc_file, overrides: dict | None = None) -> dict:
    """
    Entity-ID der IfcSurfaceStyle → Texturkategorie (oder None), einmalig
    vorberechnet — analog zu `_storey_map()`. `geometry.materials[i]` aus dem
    Geometrie-Iterator zeigt über `instance_id()` auf genau diese Entity-ID.

    `overrides` ist die im Zuordnungsassistenten gespeicherte Zuordnung
    ({Stilname: Kategorie}); sie ersticht die automatische Erkennung.
    """
    return {
        style.id(): classify_material(style.Name, overrides)
        for style in ifc_file.by_type("IfcSurfaceStyle")
    }


def _style_color_map(ifc_file, overrides: dict | None = None) -> dict:
    """
    Entity-ID der IfcSurfaceStyle → gewählte Ersatzfarbe (RGB-uint8), für die
    Stile, denen im Assistenten eine Farbe statt einer Textur zugeordnet wurde.

    Getrennt von `_style_category_map()`, weil beides unabhängig ist: eine
    Farbzuordnung liefert keine Kategorie (der Chunk bleibt flach) und eine
    Kategorie keine Farbe. Ein Dict statt eines Tupelpaars hält den Hot-Loop
    frei — es ist fast immer leer und kostet dann nichts.
    """
    if not overrides:
        return {}
    farben = {}
    for style in ifc_file.by_type("IfcSurfaceStyle"):
        rgb = farbzuordnung(style.Name, overrides)
        if rgb is not None:
            farben[style.id()] = np.array([*rgb, 255], dtype=np.uint8)
    return farben


def _style_usage(ifc_file) -> dict[int, int]:
    """
    Entity-ID einer IfcSurfaceStyle → wie oft sie zugewiesen ist.

    Nicht die Zahl der Stil-Entities zählen: die ist fast immer 1 je Name und
    sagt nichts darüber, wie viel Fläche ein Stil im Modell einnimmt. Gezählt
    werden die `IfcStyledItem`, also die tatsächlichen Zuweisungen an
    Geometrie — nur so steht im Assistenten oben, was das Erscheinungsbild
    wirklich bestimmt.

    IFC2x3 schiebt eine `IfcPresentationStyleAssignment` dazwischen, IFC4
    verweist direkt auf den Stil; `stilindex.surface_styles()` deckt beide Wege
    ab — und die Falle darin, dass ein `IfcSurfaceStyle` selbst ein Attribut
    `Styles` hat. Die frühere Fassung hier griff genau daneben und zählte bei
    jeder IFC4-Datei **null**; der Assistent sortierte dann nicht nach
    Häufigkeit, sondern alphabetisch, und die Spalte „412×" fehlte ganz.
    """
    counts: dict[int, int] = {}
    for item in ifc_file.by_type("IfcStyledItem"):
        for assignment in item.Styles or []:
            for style in stilindex.surface_styles(assignment):
                counts[style.id()] = counts.get(style.id(), 0) + 1
    return counts


def _style_report(ifc_file, overrides: dict | None = None) -> list[dict]:
    """
    Die Oberflächenstile der Datei mit Vorschlag, Konfidenz und angewandter
    Kategorie — Datengrundlage des Zuordnungsassistenten im Asset-Manager.

    Wird als `materials.json` neben die tileset.json geschrieben, damit der
    Assistent die Stilliste anzeigen kann, ohne die IFC-Datei ein zweites Mal
    zu öffnen (bei großen Modellen Minuten und mehrere Gigabyte).
    """
    overrides = overrides or {}
    usage = _style_usage(ifc_file)
    seen: dict[str, dict] = {}

    for style in ifc_file.by_type("IfcSurfaceStyle"):
        name = style.Name
        if not name:
            continue
        occurrences = usage.get(style.id(), 0)
        entry = seen.get(name)
        if entry is None:
            suggested, confidence = suggest_category(name)
            override = overrides.get(name)
            farbe, transparenz = stilindex.stil_farbe(style)
            seen[name] = {
                "name": name,
                "farbe": farbe,
                "transparenz": round(transparenz, 3),
                "suggested": suggested,
                "confidence": round(confidence, 2),
                "category": (override if override in TEXTURE_CATEGORIES else None)
                if name in overrides
                else suggested,
                "overridden": name in overrides,
                "occurrences": occurrences,
            }
        else:
            # Gleicher Name, mehrere Stil-Entities (kommt bei zusammengeführten
            # Modellen vor) — die Zuweisungen gehören zusammengezählt.
            entry["occurrences"] += occurrences

    # Häufigste zuerst: im Assistenten stehen damit die Stile oben, die das
    # Erscheinungsbild des Modells tatsächlich bestimmen.
    return sorted(seen.values(), key=lambda s: (-s["occurrences"], s["name"]))


def _normals(geometry, verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """
    Vertexnormalen als float32, notfalls selbst gemittelt.

    Ohne Normalen schaltet CesiumJS die Beleuchtung ab (`LightingModel.UNLIT`)
    und das Modell erscheint als flache Farbfläche ohne jede Plastizität — der
    Attributname ist hier also kein Beiwerk, sondern der Unterschied zwischen
    beleuchtet und unbeleuchtet.

    Bei ausgeschaltetem Welding liefert IfcOpenShell echte Flächennormalen mit.
    Bei eingeschaltetem Welding teilen sich Nachbardreiecke ihre Ecken, und es
    bleibt nur der flächengewichtete Mittelwert — dieselbe weiche Schattierung,
    die trimesh früher erzeugt hat.
    """
    supplied = np.frombuffer(geometry.normals_buffer, dtype=np.float64)
    if len(supplied) == verts.size:
        return supplied.reshape(-1, 3).astype(np.float32)

    triangles = verts[faces]
    # Das Kreuzprodukt ist proportional zur Dreiecksfläche — größere Dreiecke
    # sollen die Normale ihres Eckpunkts stärker prägen, also nicht normieren.
    face_normals = np.cross(
        triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
    )

    accumulated = np.zeros_like(verts)
    for corner in range(3):
        for axis in range(3):
            accumulated[:, axis] += np.bincount(
                faces[:, corner], weights=face_normals[:, axis], minlength=len(verts)
            )

    lengths = np.linalg.norm(accumulated, axis=1, keepdims=True)
    degenerate = lengths[:, 0] <= 1e-12
    accumulated /= np.where(degenerate[:, None], 1.0, lengths)
    # Entartete Dreiecke (Fläche 0) hinterlassen eine Nullnormale; glTF verlangt
    # Einheitslänge, also ersatzweise nach oben zeigen.
    accumulated[degenerate] = (0.0, 0.0, 1.0)
    return accumulated.astype(np.float32)


def _material_rgba(material) -> np.ndarray:
    """
    Diffuse Farbe eines IfcOpenShell-Materials als RGBA-uint8.

    `diffuse` ist ein `colour`-Objekt mit r()/g()/b() als **Methoden** (nicht
    iterierbar, `list(diffuse)` wirft TypeError) und `has_transparency()`
    ebenfalls als Methode — `getattr(mat, "has_transparency", False)` liefert
    sonst das Methodenobjekt selbst, das als bool immer truthy ist.
    `transparency` ist zudem oft NaN, wenn keine gesetzt wurde.

    Fehler werden geloggt statt verschluckt: ein stilles `return None` hat den
    API-Bruch zwischen IfcOpenShell 0.7 und 0.8 seinerzeit unsichtbar gemacht
    und das gesamte Modell farblos gelassen.
    """
    try:
        diffuse = material.diffuse
        alpha = 1.0
        if material.has_transparency():
            transparency = float(material.transparency)
            if not math.isnan(transparency):
                alpha = max(0.0, 1.0 - transparency)
        rgba = np.array(
            [diffuse.r(), diffuse.g(), diffuse.b(), alpha], dtype=np.float64
        )
        return (rgba.clip(0.0, 1.0) * 255).astype(np.uint8)
    except Exception as e:
        logger.warning(f"Materialfarbe nicht lesbar ({type(e).__name__}: {e}) — Grau.")
        return _DEFAULT_RGBA.copy()


def _excluded_types(ifc_file) -> list:
    """
    Auszuschließende Typen, gefiltert auf die, die es im Schema der Datei gibt.

    IFC2X3 und IFC4 kennen nicht dieselben Klassen; ein unbekannter Name lässt
    den Iterator scheitern, statt ihn einfach zu ignorieren.
    """
    available = []
    for ifc_type in _EXCLUDE_TYPES:
        try:
            if ifc_file.by_type(ifc_type):
                available.append(ifc_type)
        except Exception:
            logger.debug(f"Typ '{ifc_type}' im Schema {ifc_file.schema} unbekannt.")
    if available:
        logger.info(f"Vom Tiling ausgenommen: {', '.join(available)}")
    return available


def _storey_map(ifc_file) -> dict:
    """
    Zuordnung Entity-ID → Geschossname.

    Ein Durchlauf über die Beziehungen ist deutlich billiger als
    `get_container()` je Bauteil, das den Baum jedes Mal neu hochläuft.
    `IfcRelAggregates` wird mitgenommen, damit Teile zusammengesetzter Bauteile
    (Fensterelemente, Treppenläufe) das Geschoss ihres Ganzen erben.
    """
    storeys: dict[int, str] = {}
    for rel in ifc_file.by_type("IfcRelContainedInSpatialStructure"):
        structure = rel.RelatingStructure
        if not structure.is_a("IfcBuildingStorey"):
            continue
        name = structure.Name or f"#{structure.id()}"
        for element in rel.RelatedElements:
            storeys[element.id()] = name

    for rel in ifc_file.by_type("IfcRelAggregates"):
        parent = storeys.get(rel.RelatingObject.id())
        if parent:
            for part in rel.RelatedObjects:
                storeys.setdefault(part.id(), parent)
    return storeys


def _write_properties(
    properties: PropertyWriter, util, ifc_file, shape, element: _Element
) -> bool:
    """
    Property-Sets eines Bauteils in die SQLite-Ablage schreiben.

    Das Element kommt über `by_id()` aus der Datei und **nicht** über
    `shape.product`: der Iterator gibt eine `entity_instance` des Wrappers
    zurück, die keine Datei kennt. `get_psets()` scheitert daran mit
    `'NoneType' object has no attribute 'schema'` — ein Fehler, der in einem
    stillen `except` genau so lange unsichtbar bleibt, bis jemand merkt, dass
    kein einziges Bauteil Eigenschaften hat.

    Gibt zurück, ob die Property-Sets gelesen werden konnten.
    """
    product = ifc_file.by_id(shape.id)
    psets, ok = None, True
    try:
        psets = util.get_psets(product)
    except Exception as e:
        logger.debug(f"Psets für {element.guid} nicht lesbar: {type(e).__name__}: {e}")
        ok = False

    properties.add(
        global_id=element.guid,
        ifc_type=element.ifc_type,
        name=element.name,
        object_type=getattr(product, "ObjectType", None),
        description=getattr(product, "Description", None),
        storey=element.storey,
        psets=psets,
    )
    return ok


def _recenter(elements: list, origin: np.ndarray) -> np.ndarray:
    """
    Verschiebt alle Bounding Boxen so, dass die XY-Mitte und die Z-Unterkante
    des Modells im Ursprung liegen — dieselbe Konvention wie `georef.recenter()`,
    nur ohne die Vertices anzufassen. Die Koordinaten selbst werden erst beim
    Schreiben der Tiles verschoben; zurückgegeben wird der dafür nötige Offset.
    """
    lo = np.min([e.lo for e in elements], axis=0)
    hi = np.max([e.hi for e in elements], axis=0)
    shift = np.array([(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, lo[2]])
    for element in elements:
        element.lo = element.lo - shift
        element.hi = element.hi - shift
    logger.info(
        f"Modell zentriert, Offset abgezogen: {(origin + shift).round(3).tolist()} "
        f"(Ausdehnung {(hi - lo).round(1).tolist()} m)"
    )
    return shift


# ── Phase 2: Octree bauen und Tiles schreiben ────────────────────────────────


class _Node:
    """Ein Octree-Knoten mit den Bauteilen, die auf seiner Ebene liegen."""

    __slots__ = ("center", "size", "depth", "elements", "children")

    def __init__(self, center: np.ndarray, size: float, depth: int):
        self.center = center
        self.size = size
        self.depth = depth
        self.elements: list[_Element] = []
        self.children: dict[int, "_Node"] = {}

    def child(self, octant: int) -> "_Node":
        if octant not in self.children:
            step = self.size / 4.0
            offset = np.array(
                [
                    step if octant & 1 else -step,
                    step if octant & 2 else -step,
                    step if octant & 4 else -step,
                ]
            )
            self.children[octant] = _Node(self.center + offset, self.size / 2.0, self.depth + 1)
        return self.children[octant]

    def walk(self):
        yield self
        for child in self.children.values():
            yield from child.walk()


def _build_octree(elements: list) -> _Node:
    """
    Verteilt die Bauteile auf Ebenen — grobe zuerst.

    Die Ebene ergibt sich aus der Größe: ein Bauteil, das halb so groß ist wie
    das Modell, gehört auf Ebene 1, ein zehntel so großes auf Ebene 3. Damit
    steht im Wurzeltile die Tragstruktur und weiter unten die Ausstattung — das
    ist genau die Reihenfolge, in der man ein Gebäude beim Heranfliegen sehen
    will.

    Anschließend wandern übervolle Knoten eine Ebene tiefer, bis kein Tile mehr
    über `_TILE_TRIANGLES` liegt.
    """
    lo = np.min([e.lo for e in elements], axis=0)
    hi = np.max([e.hi for e in elements], axis=0)
    root = _Node(center=(lo + hi) / 2.0, size=max(float(np.max(hi - lo)), 1.0), depth=0)

    for element in elements:
        level = _level_for(element.size, root.size)
        _insert(root, element, level)

    _enforce_budget(root)
    _collapse_small(root)
    return root


def _level_for(element_size: float, root_size: float) -> int:
    """Ebene, auf der ein Knoten etwa so groß ist wie das Bauteil."""
    if element_size <= 0.0:
        return _MAX_DEPTH
    return max(0, min(_MAX_DEPTH, int(math.log2(root_size / element_size))))


def _insert(node: _Node, element: _Element, level: int):
    """Hängt ein Bauteil auf der Zielebene in den Knoten unter seinem Mittelpunkt."""
    while node.depth < level:
        node = node.child(_octant(node.center, element.center))
    node.elements.append(element)


def _octant(center: np.ndarray, point: np.ndarray) -> int:
    return (
        (1 if point[0] >= center[0] else 0)
        | (2 if point[1] >= center[1] else 0)
        | (4 if point[2] >= center[2] else 0)
    )


def _enforce_budget(root: _Node):
    """
    Schiebt Bauteile aus zu vollen Knoten eine Ebene tiefer.

    Zuerst gehen die kleinsten: sie tragen zum Bild aus der Ferne am wenigsten
    bei und sind genau die, die auf einer feineren Ebene ohnehin besser
    aufgehoben sind. Knoten auf der untersten Ebene behalten ihren Überhang —
    dort hilft nur noch, das Modell selbst zu teilen.
    """
    queue = [root]
    while queue:
        node = queue.pop()
        total = sum(e.triangles for e in node.elements)
        if node.depth < _MAX_DEPTH and total > _TILE_TRIANGLES:
            node.elements.sort(key=lambda e: e.size)
            moved = 0
            # Das größte Bauteil bleibt immer hier: sonst rutschte ein einzelnes
            # übergroßes Element endlos nach unten und wäre aus der Ferne weg.
            while total > _TILE_TRIANGLES and moved < len(node.elements) - 1:
                element = node.elements[moved]
                node.child(_octant(node.center, element.center)).elements.append(element)
                total -= element.triangles
                moved += 1
            node.elements = node.elements[moved:]
        queue.extend(node.children.values())


def _collapse_small(node: _Node) -> int:
    """
    Zieht Teilbäume, die zusammen in ein Tile passen, in ihren Wurzelknoten.

    Ohne diesen Schritt zerfällt ein kleines Modell in dutzende Tiles mit je ein
    paar hundert Dreiecken: die Größeneinteilung verteilt die Bauteile über
    viele Ebenen, ganz gleich wie wenig Geometrie insgesamt da ist. Jedes Tile
    kostet aber eine HTTP-Anfrage und einen Draw Call — unterhalb des Budgets
    ist eine Aufteilung reine Verschwendung.

    Gibt die Dreiecksanzahl des Teilbaums zurück.
    """
    total = sum(e.triangles for e in node.elements)
    for child in node.children.values():
        total += _collapse_small(child)

    if total <= _TILE_TRIANGLES and node.children:
        for descendant in node.walk():
            if descendant is not node:
                node.elements.extend(descendant.elements)
        node.children.clear()
    return total


def _write_tiles(
    elements: list, store: _GeometryStore, out_dir: Path, model_offset: np.ndarray
):
    """Schreibt je Octree-Knoten ein B3DM und daraus die tileset.json."""
    root_node = _build_octree(elements)
    counter = [0]
    root_tile, _ = _write_node(
        root_node, store, out_dir, np.zeros(3), model_offset, counter
    )

    lo = np.min([e.lo for e in elements], axis=0)
    hi = np.max([e.hi for e in elements], axis=0)
    tileset = build_tileset(
        root_tile, geometric_error=max(float(np.linalg.norm(hi - lo)), 1.0)
    )
    (out_dir / "tileset.json").write_text(json.dumps(tileset, indent=2))
    write_placement(out_dir)
    logger.info(
        f"IFC-Tiling abgeschlossen: {len(elements)} Bauteile in {counter[0]} Tiles "
        f"→ {out_dir}/tileset.json"
    )


def _write_node(
    node: _Node,
    store: _GeometryStore,
    out_dir: Path,
    parent_origin: np.ndarray,
    model_offset: np.ndarray,
    counter: list,
) -> tuple:
    """
    Schreibt einen Knoten samt Kindern.

    Gibt den Tile-Eintrag und die tatsächliche Ausdehnung des Teilbaums zurück.
    Die Bounding Box muss die Kinder einschließen, sonst verwirft CesiumJS sie
    beim Culling, bevor sie geladen werden — und sie wird bottom-up
    weitergereicht, damit der Baum nicht je Knoten noch einmal durchlaufen wird.
    """
    children, boxes = [], [(e.lo, e.hi) for e in node.elements]
    for child in node.children.values():
        tile, box = _write_node(child, store, out_dir, node.center, model_offset, counter)
        if tile is not None:
            children.append(tile)
            boxes.append(box)

    if not boxes:
        return None, None

    uri = None
    if node.elements:
        uri = f"tile_{counter[0]}.b3dm"
        (out_dir / uri).write_bytes(
            _build_b3dm(node.elements, store, model_offset + node.center)
        )
        counter[0] += 1

    lo = np.min([b[0] for b in boxes], axis=0)
    hi = np.max([b[1] for b in boxes], axis=0)

    # Was bleibt an Fehler, wenn nicht verfeinert wird? Die Kinder tragen
    # Bauteile bis etwa halber Knotengröße — genau das ist die Kantenlänge
    # dessen, was hier noch fehlt.
    tile = make_tile(
        center=(lo + hi) / 2.0 - node.center,
        half=(hi - lo) / 2.0,
        geometric_error=node.size / 2.0 if children else 0.0,
        content_uri=uri,
        children=children,
        translation=node.center - parent_origin,
    )
    return tile, (lo, hi)


def _build_b3dm(elements: list, store: _GeometryStore, offset: np.ndarray) -> bytes:
    """
    Setzt die Bauteile eines Knotens zu einem B3DM mit Batch Table zusammen.

    `offset` ist die Summe aus Modellzentrierung und Tile-Ursprung: die
    ausgelagerten Koordinaten liegen noch relativ zum vorläufigen Bezugspunkt
    aus Phase 1.
    """
    positions, normals, colors, uvs, indices, batch_ids = [], [], [], [], [], []
    category_ranges = defaultdict(list)
    shift = offset.astype(np.float32)
    vertices = 0

    for batch_id, element in enumerate(elements):
        verts, element_normals, element_colors, element_uvs, element_indices = store.read(
            element.record
        )
        positions.append(verts - shift)
        normals.append(element_normals)
        colors.append(element_colors)
        uvs.append(element_uvs)
        indices.append(element_indices + vertices)
        batch_ids.append(np.full(len(verts), batch_id, dtype=np.uint32))
        for category, idx_start, idx_count in element.material_chunks:
            category_ranges[category].append(element_indices[idx_start : idx_start + idx_count] + vertices)
        vertices += len(verts)

    primitives = {category: np.concatenate(ranges) for category, ranges in category_ranges.items()}

    if set(primitives) <= {None}:
        # Kein Element in diesem Knoten hat eine Texturkategorie getroffen —
        # der Normalfall für die meisten Tiles. Exakt der unveränderte,
        # bisherige Pfad, keine TEXCOORD_0/Bild-Daten im Tile.
        glb = mesh_glb(
            positions=np.concatenate(positions),
            normals=np.concatenate(normals),
            colors=np.concatenate(colors),
            indices=np.concatenate(indices),
            batch_ids=np.concatenate(batch_ids),
            name="ifc",
        )
    else:
        glb = mesh_glb_textured(
            positions=np.concatenate(positions),
            normals=np.concatenate(normals),
            colors=np.concatenate(colors),
            uvs=np.concatenate(uvs),
            batch_ids=np.concatenate(batch_ids),
            primitives=primitives,
            name="ifc",
        )
    return glb_to_b3dm(glb, batch_length=len(elements), batch_table=_batch_table(elements))


def _batch_table(elements: list) -> dict:
    """
    Die Spalten, die CesiumJS je Bauteil vorhält.

    Bewusst knapp: die Batch Table steckt in jedem Tile und wird bei jedem
    Nachladen mit übertragen. Alles Weitere kommt bei Bedarf einzeln aus
    `properties.sqlite`.
    """
    return {
        "GlobalId": [e.guid for e in elements],
        "IfcType": [e.ifc_type for e in elements],
        "Name": [e.name or "" for e in elements],
        "Geschoss": [e.storey or "" for e in elements],
    }
