"""
Registry der Texturkategorien: Bildpfade, PBR-Faktoren und Herkunft je Kategorie.

Das ist die *einzige* Stelle, an der eine Kategorie definiert wird — alles
andere leitet sich daraus ab:

* `tiling/materials.py::classify_material()` ordnet IFC-Stilnamen einem
  Kategorie-Schlüssel aus `CATEGORIES` zu,
* `scripts/fetch_textures.py` lädt anhand von `source`/`slug` die Bilddateien
  und legt sie unter `tiling/textures/library/<category>/` ab,
* `api/routes/materials.py` liefert `label`/`group` an den
  Textur-Zuordnungsassistenten im Asset-Manager.

Eine neue Kategorie braucht deshalb nur einen Eintrag hier, passende Keywords
in `materials.py` und einen Lauf von `scripts/fetch_textures.py`.

Bilddateien je Kategorie (512px JPEG, im B3DM eingebettet):

    basecolor.jpg   sRGB-Albedo
    normal.jpg      Normal-Map, OpenGL-Konvention (+Y = oben)
    orm.jpg         optional: R = Ambient Occlusion, G = Roughness, B = Metallic

`orm.jpg` ist optional, weil nicht jede Quelle alle drei Kanäle mitbringt.
Fehlt sie, gelten `roughness_factor`/`metallic_factor` als Konstanten über die
ganze Fläche — das Verhalten vor Einführung der ORM-Maps. Ist sie vorhanden,
werden die Faktoren zu Multiplikatoren auf die Texturwerte (so definiert es
die glTF-2.0-Spezifikation), weshalb sie dann in der Regel auf 1.0 stehen.
"""

import functools
from dataclasses import dataclass
from pathlib import Path

_LIBRARY_DIR = Path(__file__).resolve().parent / "textures" / "library"

# Quellen der Bilddateien — beide CC0, siehe SOURCE.md je Kategorie.
POLYHAVEN = "polyhaven"
AMBIENTCG = "ambientcg"


@dataclass(frozen=True)
class CategoryTexture:
    label: str  # Anzeigename im Zuordnungsassistenten
    group: str  # Gruppierung im Assistenten (Rohbau, Ausbau, ...)
    source: str  # POLYHAVEN | AMBIENTCG
    slug: str  # Asset-Kennung bei der Quelle
    tile_size_m: float  # Meter Weltgröße je Texturwiederholung (UV-Skalierung)
    roughness_factor: float
    metallic_factor: float


# Gruppen in der Reihenfolge, in der sie im Assistenten erscheinen.
GROUPS = ("Rohbau", "Fassade & Dach", "Ausbau", "Boden", "Metall", "Außenanlagen")

# Die Zahlenwerte sind Erfahrungswerte für Architekturvisualisierung, keine
# gemessenen Materialkennwerte. `tile_size_m` ist der wichtigste davon: zu klein
# und die Textur flimmert aus der Ferne, zu groß und eine Wand zeigt einen
# einzigen verwaschenen Ausschnitt. Faustregel: die Weltgröße des Musters, das
# man aus 3 m Abstand als Wiederholung erkennen würde.
CATEGORIES: dict[str, CategoryTexture] = {
    # ── Rohbau ────────────────────────────────────────────────────────────────
    "concrete": CategoryTexture(
        "Beton (Ortbeton)", "Rohbau", POLYHAVEN, "concrete_wall_008", 2.5, 1.0, 0.0
    ),
    "concrete_smooth": CategoryTexture(
        "Sichtbeton / Fertigteil", "Rohbau", POLYHAVEN, "concrete_panels", 3.0, 1.0, 0.0
    ),
    "concrete_rough": CategoryTexture(
        "Beton rau / Waschbeton", "Rohbau", POLYHAVEN, "concrete_floor_02", 2.0, 1.0, 0.0
    ),
    "concrete_block": CategoryTexture(
        "Hohlblockstein / Schalungsstein", "Rohbau", POLYHAVEN, "concrete_brick_wall_001", 2.5, 1.0, 0.0
    ),
    "screed": CategoryTexture(
        "Estrich", "Rohbau", POLYHAVEN, "concrete_floor_worn_02", 3.0, 1.0, 0.0
    ),
    "brick": CategoryTexture(
        "Ziegelmauerwerk", "Rohbau", POLYHAVEN, "brick_wall_006", 2.0, 1.0, 0.0
    ),
    "brick_clinker": CategoryTexture(
        "Klinker / Verblender", "Rohbau", POLYHAVEN, "brown_brick_02", 2.0, 1.0, 0.0
    ),
    # Kalksandstein und Porenbeton liefen bis v0.3 beide auf `brick` und damit
    # auf eine rote Tonziegelwand — beide sind aber grau bzw. weiß, und in
    # deutschen Modellen sind sie die häufigsten Mauerwerksbaustoffe überhaupt.
    "limestone_brick": CategoryTexture(
        "Kalksandstein", "Rohbau", AMBIENTCG, "Bricks060", 2.0, 1.0, 0.0
    ),
    "aerated_concrete": CategoryTexture(
        "Porenbeton (Ytong)", "Rohbau", AMBIENTCG, "Bricks038", 2.0, 1.0, 0.0
    ),
    "sandstone": CategoryTexture(
        "Naturstein / Sandstein", "Rohbau", POLYHAVEN, "red_sandstone_wall", 3.0, 1.0, 0.0
    ),
    "stone_wall": CategoryTexture(
        "Bruchsteinmauerwerk", "Rohbau", POLYHAVEN, "stacked_stone_wall", 3.0, 1.0, 0.0
    ),
    "rammed_earth": CategoryTexture(
        "Stampflehm / Lehmbau", "Rohbau", POLYHAVEN, "clay_block_wall", 3.0, 1.0, 0.0
    ),
    "insulation": CategoryTexture(
        "Dämmung EPS/XPS (Hartschaum)", "Rohbau", AMBIENTCG, "Styrofoam004", 1.5, 1.0, 0.0
    ),
    # Mineralwolle ist im Schnitt sofort von Hartschaum zu unterscheiden — faserig
    # statt geschlossenzellig. Es gibt bei keiner der beiden CC0-Quellen eine
    # echte Dämmwollenaufnahme; `Fabric034` (grauer Filz) ist der nächstliegende
    # Ersatz und trifft die Faserstruktur, nicht die Farbe der Marke.
    "insulation_mineral": CategoryTexture(
        "Dämmung Mineralwolle (faserig)", "Rohbau", AMBIENTCG, "Fabric034", 1.5, 1.0, 0.0
    ),
    # ── Fassade & Dach ────────────────────────────────────────────────────────
    "plaster": CategoryTexture(
        "Innenputz / Anstrich", "Fassade & Dach", POLYHAVEN, "plastered_wall_02", 3.0, 1.0, 0.0
    ),
    "plaster_rough": CategoryTexture(
        "Außenputz / Rauputz", "Fassade & Dach", POLYHAVEN, "grey_plaster_03", 2.5, 1.0, 0.0
    ),
    "clay_plaster": CategoryTexture(
        "Lehmputz", "Fassade & Dach", POLYHAVEN, "clay_plaster", 2.5, 1.0, 0.0
    ),
    "roof_tiles": CategoryTexture(
        "Dachziegel (Ton)", "Fassade & Dach", POLYHAVEN, "clay_roof_tiles_02", 1.5, 1.0, 0.0
    ),
    "roof_tiles_concrete": CategoryTexture(
        "Betondachstein", "Fassade & Dach", AMBIENTCG, "RoofingTiles015A", 1.5, 1.0, 0.0
    ),
    "roof_slate": CategoryTexture(
        "Schiefer", "Fassade & Dach", POLYHAVEN, "roof_slates_03", 1.5, 1.0, 0.0
    ),
    "roof_green": CategoryTexture(
        "Dachbegrünung / Sedum", "Fassade & Dach", AMBIENTCG, "Grass007", 3.0, 1.0, 0.0
    ),
    "bitumen": CategoryTexture(
        "Bitumen / Dachbahn", "Fassade & Dach", POLYHAVEN, "bitumen", 2.0, 1.0, 0.0
    ),
    "facade_panel": CategoryTexture(
        "Fassadenplatte (Faserzement)", "Fassade & Dach", POLYHAVEN, "rectangular_facade_tiles", 2.0, 1.0, 0.0
    ),
    "hpl_panel": CategoryTexture(
        "HPL-/Schichtstoffplatte", "Fassade & Dach", AMBIENTCG, "Plastic011", 2.0, 1.0, 0.0
    ),
    "solar_panel": CategoryTexture(
        "PV-Modul / Solarthermie", "Fassade & Dach", AMBIENTCG, "SolarPanel003", 1.6, 1.0, 0.0
    ),
    # ── Ausbau ────────────────────────────────────────────────────────────────
    "gypsum": CategoryTexture(
        "Gipskarton / Gipsplatte", "Ausbau", POLYHAVEN, "white_plaster_02", 2.5, 1.0, 0.0
    ),
    "wallpaper": CategoryTexture(
        "Raufasertapete", "Ausbau", AMBIENTCG, "Wallpaper001A", 2.5, 1.0, 0.0
    ),
    "ceiling_acoustic": CategoryTexture(
        "Akustik-/Rasterdecke", "Ausbau", POLYHAVEN, "ceiling_interior", 1.2, 1.0, 0.0
    ),
    "wood": CategoryTexture(
        "Holz (Nadelholz)", "Ausbau", POLYHAVEN, "fine_grained_wood", 1.5, 1.0, 0.0
    ),
    "wood_oak": CategoryTexture(
        "Eiche / Furnier", "Ausbau", POLYHAVEN, "oak_veneer_01", 1.5, 1.0, 0.0
    ),
    "wood_planks": CategoryTexture(
        "Holzschalung / Fassade", "Ausbau", POLYHAVEN, "brown_planks_09", 2.0, 1.0, 0.0
    ),
    "plywood": CategoryTexture(
        "Sperrholz / OSB", "Ausbau", POLYHAVEN, "plywood", 2.0, 1.0, 0.0
    ),
    # Holzwolle-Leichtbauplatte (Heraklith): grobe, verpresste Späne. `WoodChips002`
    # ist loses Hackgut und damit gröber als die Platte, trifft aber als einziges
    # CC0-Asset die Spanstruktur; bis v0.3 lief das Material auf `wood` und sah
    # damit aus wie gehobeltes Vollholz.
    "wood_wool": CategoryTexture(
        "Holzwolle-Leichtbauplatte", "Ausbau", AMBIENTCG, "WoodChips002", 1.2, 1.0, 0.0
    ),
    "cork": CategoryTexture(
        "Kork", "Ausbau", AMBIENTCG, "Cork002", 1.5, 1.0, 0.0
    ),
    "fabric": CategoryTexture(
        "Textil / Polsterstoff", "Ausbau", POLYHAVEN, "poly_wool_herringbone", 1.0, 1.0, 0.0
    ),
    "leather": CategoryTexture(
        "Leder", "Ausbau", POLYHAVEN, "brown_leather", 1.0, 1.0, 0.0
    ),
    "plastic": CategoryTexture(
        "Kunststoff (PE/PVC)", "Ausbau", AMBIENTCG, "Plastic010", 1.0, 1.0, 0.0
    ),
    # ── Boden ─────────────────────────────────────────────────────────────────
    "wood_parquet": CategoryTexture(
        "Parkett", "Boden", POLYHAVEN, "herringbone_parquet", 2.0, 1.0, 0.0
    ),
    "laminate": CategoryTexture(
        "Laminat / Designbelag (LVT)", "Boden", POLYHAVEN, "laminate_floor_02", 2.0, 1.0, 0.0
    ),
    "linoleum": CategoryTexture(
        "Linoleum", "Boden", POLYHAVEN, "linoleum_brown", 2.0, 1.0, 0.0
    ),
    "rubber": CategoryTexture(
        "Kautschuk / Gummi", "Boden", AMBIENTCG, "Rubber002", 1.5, 1.0, 0.0
    ),
    "carpet": CategoryTexture(
        "Teppich", "Boden", POLYHAVEN, "dirty_carpet", 2.0, 1.0, 0.0
    ),
    "epoxy_floor": CategoryTexture(
        "Industrieboden (beschichtet)", "Boden", AMBIENTCG, "Concrete016", 3.0, 1.0, 0.0
    ),
    "tiles_ceramic": CategoryTexture(
        "Bodenfliese (keramisch)", "Boden", POLYHAVEN, "interior_tiles", 1.5, 1.0, 0.0
    ),
    "tiles_wall": CategoryTexture(
        "Wandfliese (weiß)", "Boden", AMBIENTCG, "Tiles008", 1.0, 1.0, 0.0
    ),
    "tiles_mosaic": CategoryTexture(
        "Mosaikfliese", "Boden", AMBIENTCG, "Tiles071", 0.6, 1.0, 0.0
    ),
    "terracotta": CategoryTexture(
        "Terrakotta / Tonfliese", "Boden", POLYHAVEN, "terracotta_floor_tiles", 1.5, 1.0, 0.0
    ),
    "terrazzo": CategoryTexture(
        "Terrazzo", "Boden", POLYHAVEN, "terrazzo_tiles", 2.0, 1.0, 0.0
    ),
    "marble": CategoryTexture(
        "Marmor", "Boden", POLYHAVEN, "marble_01", 3.0, 1.0, 0.0
    ),
    "travertine": CategoryTexture(
        "Travertin", "Boden", AMBIENTCG, "Travertine001", 2.0, 1.0, 0.0
    ),
    "granite": CategoryTexture(
        "Granit", "Boden", POLYHAVEN, "granite_tile_03", 2.0, 1.0, 0.0
    ),
    # ── Metall ────────────────────────────────────────────────────────────────
    # Poly Haven hat für Architekturmetalle fast nur verwitterte Sets; die
    # sauberen Grundmetalle kommen deshalb von ambientCG.
    "metal": CategoryTexture(
        "Stahl", "Metall", AMBIENTCG, "Metal032", 1.5, 1.0, 1.0
    ),
    "steel_brushed": CategoryTexture(
        "Edelstahl gebürstet", "Metall", AMBIENTCG, "Metal009", 1.0, 1.0, 1.0
    ),
    # Pulverbeschichtet ist die einzige Metallkategorie mit `metallic = 0.0`: die
    # Lackschicht ist ein Dielektrikum, das Blech darunter spiegelt nicht mehr.
    "metal_painted": CategoryTexture(
        "Stahl lackiert / pulverbeschichtet", "Metall", AMBIENTCG, "Metal028", 2.0, 1.0, 0.0
    ),
    "aluminium": CategoryTexture(
        "Aluminium", "Metall", AMBIENTCG, "Metal050A", 1.0, 1.0, 1.0
    ),
    "copper": CategoryTexture(
        "Kupfer / Messing", "Metall", AMBIENTCG, "Metal035", 1.5, 1.0, 1.0
    ),
    "zinc": CategoryTexture(
        "Titanzink", "Metall", AMBIENTCG, "Metal031", 1.5, 1.0, 1.0
    ),
    "cast_iron": CategoryTexture(
        "Gusseisen", "Metall", AMBIENTCG, "Metal046A", 1.5, 1.0, 1.0
    ),
    "metal_corrugated": CategoryTexture(
        "Trapez-/Wellblech", "Metall", POLYHAVEN, "box_profile_metal_sheet", 2.0, 1.0, 1.0
    ),
    # Stehfalz gibt es bei keiner der beiden Quellen; `CorrugatedSteel009` ist
    # ein feingeripptes Industrieblech und liegt der schmalen Falzteilung näher
    # als das grobe Trapezprofil von `metal_corrugated`.
    "metal_standing_seam": CategoryTexture(
        "Stehfalz / Falzblech", "Metall", AMBIENTCG, "CorrugatedSteel009", 1.5, 1.0, 1.0
    ),
    "metal_perforated": CategoryTexture(
        "Lochblech / Streckmetall", "Metall", AMBIENTCG, "SheetMetal002", 1.0, 1.0, 1.0
    ),
    # Ein Gitterrost ist zur Hälfte Loch, die Textur hat aber keine Alphamaske —
    # die Zwischenräume sind gemalt, nicht durchsichtig. Aus der Nähe fällt das
    # auf; über einem Podest oder einer Treppe, wo darunter ohnehin Schatten
    # steht, trägt es. Ein Alphakanal hieße `BLEND` im Material und damit eine
    # Sortierpflicht für das ganze Tile.
    "metal_grating": CategoryTexture(
        "Gitterrost", "Metall", AMBIENTCG, "MetalWalkway012", 1.0, 1.0, 1.0
    ),
    "metal_diamond": CategoryTexture(
        "Riffelblech / Tränenblech", "Metall", AMBIENTCG, "DiamondPlate001", 1.2, 1.0, 1.0
    ),
    "metal_rusty": CategoryTexture(
        "Cortenstahl / Rost", "Metall", POLYHAVEN, "rust_coarse_01", 2.0, 1.0, 0.0
    ),
    # ── Außenanlagen ──────────────────────────────────────────────────────────
    "asphalt": CategoryTexture(
        "Asphalt", "Außenanlagen", POLYHAVEN, "asphalt_02", 4.0, 1.0, 0.0
    ),
    "paving": CategoryTexture(
        "Pflaster / Betonstein", "Außenanlagen", POLYHAVEN, "rectangular_paving", 3.0, 1.0, 0.0
    ),
    "cobblestone": CategoryTexture(
        "Kopfsteinpflaster", "Außenanlagen", POLYHAVEN, "cobblestone_03", 2.5, 1.0, 0.0
    ),
    "wood_deck": CategoryTexture(
        "Holzterrasse / WPC-Diele", "Außenanlagen", POLYHAVEN, "wood_floor_deck", 2.0, 1.0, 0.0
    ),
    "gravel": CategoryTexture(
        "Kies / Schotter", "Außenanlagen", POLYHAVEN, "gravel", 3.0, 1.0, 0.0
    ),
    "sand": CategoryTexture(
        "Sand / Sandbett", "Außenanlagen", POLYHAVEN, "sand_01", 3.0, 1.0, 0.0
    ),
    "soil": CategoryTexture(
        "Erdreich", "Außenanlagen", POLYHAVEN, "brown_mud_dry", 4.0, 1.0, 0.0
    ),
    "mulch": CategoryTexture(
        "Rindenmulch / Pflanzfläche", "Außenanlagen", POLYHAVEN, "wood_chip_path", 2.5, 1.0, 0.0
    ),
    "grass": CategoryTexture(
        "Rasen / Grünfläche", "Außenanlagen", POLYHAVEN, "sparse_grass", 4.0, 1.0, 0.0
    ),
}


def category_dir(category: str) -> Path:
    return _LIBRARY_DIR / category


def available(category: str) -> bool:
    """True, wenn die Bilddateien der Kategorie tatsächlich vorliegen."""
    directory = category_dir(category)
    return (directory / "basecolor.jpg").is_file() and (directory / "normal.jpg").is_file()


def installed_categories() -> list[str]:
    """Kategorien, die deklariert *und* heruntergeladen sind."""
    return [name for name in CATEGORIES if available(name)]


def has_orm(category: str) -> bool:
    """True, wenn eine kombinierte AO/Roughness/Metallic-Map vorliegt."""
    return (category_dir(category) / "orm.jpg").is_file()


@functools.lru_cache(maxsize=None)
def load_basecolor_bytes(category: str) -> bytes:
    """JPEG-Bytes der BaseColor-Textur, gecacht (max. len(CATEGORIES) Einträge)."""
    return (category_dir(category) / "basecolor.jpg").read_bytes()


@functools.lru_cache(maxsize=None)
def load_normal_bytes(category: str) -> bytes:
    """JPEG-Bytes der Normal-Map (OpenGL-Konvention), gecacht."""
    return (category_dir(category) / "normal.jpg").read_bytes()


@functools.lru_cache(maxsize=None)
def load_orm_bytes(category: str) -> bytes | None:
    """JPEG-Bytes der ORM-Map (R=AO, G=Roughness, B=Metallic) oder None."""
    path = category_dir(category) / "orm.jpg"
    return path.read_bytes() if path.is_file() else None
