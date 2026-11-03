"""
Ordnet IFC-Oberflächenstile (`IfcSurfaceStyle.Name`) einer Texturkategorie zu.

Reine String-Funktion, unabhängig von ifcopenshell — die IFC-seitige Auflösung
(`geometry.materials[i]` → Eltern-`IfcSurfaceStyle` → `.Name`) passiert in
`tiling/formats/ifc.py`, hier wird nur der bereits aufgelöste Name klassifiziert.

**Längstes Keyword gewinnt.** Materialnamen aus Revit/Allplan/ArchiCAD sind
zusammengesetzt ("Stahlbeton - Ortbeton C30/37", "Metall Aluminium, matt"), und
das spezifischere Wort ist fast immer das längere: "stahlbeton" (10) schlägt
"stahl" (5), "dachziegel" (10) schlägt "ziegel" (6), "edelstahl" (9) schlägt
"stahl" (5). Das ersetzt die frühere, fehleranfällige Abhängigkeit von der
Reihenfolge der Kategorien. Bei gleich langen Treffern entscheidet die
Reihenfolge in `_CATEGORY_KEYWORDS` (Einfügereihenfolge des dicts).

Nicht jeder Stil soll eine Textur bekommen: Farbanstriche, generische/Default-
Stile und Glas bleiben bewusst einfarbig (siehe Deny-Liste) — sie zu texturieren
wäre entweder falsch (ein "Farbe, blau hell"-Stil ist buchstäblich ein Anstrich,
keine Materialoberfläche) oder es gibt keine sinnvolle Zuordnung (generische
"IFC Oberfläche (n)"/"Material ID: x"-Stile ohne erkennbaren Materialbezug).
Die Deny-Liste wird *vor* den Kategorien geprüft und ist damit absolut — außer
ein Treffer aus der Kategorie-Liste ist länger als der Deny-Treffer, denn
"Betonfarbe" ist ein Anstrich, "Farbbeton" aber ein Beton.
"""

from tiling.textures import CATEGORIES

# Vor den Kategorien geprüft: Stile, die einfarbig bleiben sollen.
_DENY_PATTERNS = [
    # Anstriche und reine Farbangaben — eine Farbe ist keine Materialoberfläche.
    "default",
    "farbe",
    "farba",  # pl
    "anstrich",
    "lack",
    "kolor",  # pl
    "ral ",
    # Generische Exporter-Platzhalter ohne Materialbezug.
    "material id",
    "ifc oberflache",
    "ifc surface",
    "ifc baustoff",
    "projektspezifisch",
    "installation",  # "Installationszone" — sonst greift `stal` (pl Stahl)
    "bauteil",
    "rfa_material",
    "pen_material",
    "builtinmat",
    "labmat",
    "unbenannt",
    "unnamed",
    # Nicht sichtbare Schichten: Sperren, Folien, Luftschichten.
    "luftschicht",
    "powietrze",  # pl Luft
    "folie",
    "membran",
    "dampfsperre",
    "dampfbremse",
    "paroizolacja",  # pl Dampfsperre
    "unsichtbar",
    "invisible",
    # Transparente Stile: Textur wäre falsch, hier gilt die Stilfarbe.
    "glas",
    "glass",
    "szklo",  # pl
    "spiegel",
    "mirror",
]

# Keywords je Kategorie, klein geschrieben und ohne Umlaute (`_normalize()`
# transliteriert beide Seiten). Deutsche Begriffe zuerst, weil die Modelle
# überwiegend aus deutschsprachigen BIM-Tools kommen; englische als Ergänzung.
_CATEGORY_KEYWORDS: dict[str, list[str]] = {
    # ── Rohbau ────────────────────────────────────────────────────────────────
    "concrete": [
        "beton konstrukcyjny", "stahlbeton", "ortbeton", "transportbeton",
        "magerbeton", "farbbeton", "zelbet", "beton", "concrete",
        "c20/25", "c25/30", "c30/37", "c35/45", "reinforced concrete",
    ],
    "concrete_smooth": [
        "beton architektoniczny", "sichtbeton", "betonfertigteil", "fertigteil",
        "halbfertigteil", "elementdecke", "filigrandecke", "prefabrykat",
        "precast", "fair-faced",
    ],
    "concrete_rough": [
        "waschbeton", "besenstrich", "exposed aggregate", "schalungsbeton", "brettschalung",
    ],
    "concrete_block": [
        "betonhohlblockstein", "hohlblockstein", "betonhohlblock", "schalungsstein",
        "hohlblock", "pustak betonowy", "hollow block", "concrete block",
    ],
    "screed": [
        "calciumsulfatestrich", "anhydritestrich", "zementestrich", "heizestrich",
        "estrich", "jastrych", "wylewka", "screed",
    ],
    "brick": [
        "bloczki ceramiczne", "pustak ceramiczny", "hochlochziegel", "vollziegel",
        "mauerziegel", "backstein", "mauerwerk", "poroton", "ziegel", "cegla",
        "brick", "masonry", "blockwork",
    ],
    "brick_clinker": [
        "cegla klinkierowa", "vormauerziegel", "sichtmauerwerk", "verblendmauerwerk",
        "verblender", "klinkier", "klinker", "riemchen", "clinker", "facing brick",
    ],
    # Kalksandstein ist grau-weiß, Porenbeton weiß — beide liefen früher auf
    # `brick` und damit auf eine rote Tonziegelwand.
    "limestone_brick": [
        "bloczki silikatowe", "kalksandvollstein", "kalksandstein", "ks-stein",
        "silikat", "sand-lime",
    ],
    "aerated_concrete": [
        "beton komorkowy", "porenbetonstein", "aerated concrete", "porenbeton",
        "gasbeton", "ytong", "hebel", "beton komorkow",
    ],
    "sandstone": [
        "kamien naturalny", "naturwerkstein", "muschelkalk", "piaskowiec",
        "naturstein", "sandstein", "kalkstein", "schiefergestein",
        "natural stone", "sandstone", "limestone",
    ],
    "stone_wall": [
        "bruchsteinmauerwerk", "natursteinmauerwerk", "schichtenmauerwerk",
        "mur kamienny", "bruchstein", "feldstein", "rubble masonry", "stone wall",
    ],
    "rammed_earth": [
        "lehmbaustein", "stampflehm", "lehmstein", "lehmbau", "lehm",
        "rammed earth", "adobe", "glina",
    ],
    # Hartschaum: geschlossenzellig, weiß-glatt.
    "insulation": [
        "warmedammverbundsystem", "plyty styropianowe", "perimeterdammung",
        "warmedammung", "polistyren", "hartschaum", "polystyrol", "styropian",
        "styropor", "styrodur", "dammstoff", "dammung", "insulation", "izolacja",
        "pur-dammung", "pir-dammung", "pu-schaum", "wdvs", "eps", "xps",
    ],
    # Faserdämmstoffe: im Schnitt sofort vom Hartschaum zu unterscheiden.
    "insulation_mineral": [
        "mineralfaserdammung", "zellulosedammung", "steinwolleplatte",
        "welna mineralna", "einblasdammung", "schlackenwolle", "welna szklana",
        "mineralwolle", "mineralfaser", "mineral wool", "steinwolle",
        "glass wool", "glaswolle", "zellulose", "celuloza", "rockwool", "isover",
    ],
    # ── Fassade & Dach ────────────────────────────────────────────────────────
    "plaster": [
        "tynk wewnetrzny", "kalkzementputz", "gladz gipsowa", "spachtelung",
        "innenputz", "glattputz", "gipsputz", "kalkputz", "stuck", "putz",
        "tynk", "plaster", "skim coat",
    ],
    "plaster_rough": [
        "tynk szlachetny", "tynk zewnetrzny", "strukturputz", "silikatputz",
        "aussenputz", "kratzputz", "reibeputz", "edelputz", "rauputz",
        "render", "stucco",
    ],
    "clay_plaster": [
        "lehmunterputz", "tynk gliniany", "lehmoberputz", "clay plaster", "lehmputz",
    ],
    "roof_tiles": [
        "dachowka ceramiczna", "frankfurter pfanne", "tondachziegel",
        "biberschwanz", "dachpfanne", "dachziegel", "ziegeldach", "dachowka",
        "roof tile", "clay tile",
    ],
    "roof_tiles_concrete": [
        "dachowka betonowa", "concrete roof tile", "betondachstein",
        "betonpfanne", "dachstein",
    ],
    "roof_slate": [
        "schieferdeckung", "naturschiefer", "schiefer", "slate", "lupek",
    ],
    "roof_green": [
        "extensivbegrunung", "intensivbegrunung", "dachbegrunung", "zielony dach",
        "grundach", "green roof", "sedum",
    ],
    "bitumen": [
        "papa termozgrzewalna", "dachabdichtung", "papa bitumiczna", "bitumenbahn",
        "schweissbahn", "asphaltbahn", "teerpappe", "dachpappe", "dachbahn",
        "bitumen", "roofing felt", "bituminous",
    ],
    "facade_panel": [
        "okladzina elewacyjna", "faserzementplatte", "fassadenpaneel",
        "fassadenplatte", "vorhangfassade", "faserzement", "alucobond",
        "eternit", "cladding", "facade panel", "rainscreen",
    ],
    "hpl_panel": [
        "schichtstoffplatte", "kompaktplatte", "max exterior", "hpl-platte",
        "resopal", "trespa", "hpl",
    ],
    "solar_panel": [
        "kolektor sloneczny", "photovoltaikmodul", "solarkollektor",
        "photovoltaik", "solarthermie", "fotowoltaika", "solarmodul",
        "solarpanel", "pv-modul", "solar",
    ],
    # ── Ausbau ────────────────────────────────────────────────────────────────
    "gypsum": [
        "gipskartonplatte", "gipsfaserplatte", "plyta gipsowo", "karton-gips",
        "gipskarton", "gipsplatte", "trockenbau", "plasterboard", "fermacell",
        "plyta g-k", "plyta gk", "drywall", "rigips", "gypsum", "gips",
        "gkb", "gkf",
    ],
    "wallpaper": [
        "raufasertapete", "vliestapete", "wallpaper", "raufaser", "tapete", "tapeta",
    ],
    "ceiling_acoustic": [
        "mineralfaserplatte", "abgehangte decke", "suspended ceiling",
        "akustikplatte", "akustikdecke", "deckenplatte", "rasterdecke",
        "ceiling tile", "acoustic", "akustik",
    ],
    "wood": [
        "konstruktionsvollholz", "drewno konstrukcyjne", "brettschichtholz",
        "drewno szalunkowe", "nadelholz", "douglasie", "vollholz", "bauholz",
        "modrzew", "drewno", "fichte", "kiefer", "larche", "swierk", "sosna",
        "tanne", "timber", "spruce", "glulam", "holz", "wood",
    ],
    "wood_oak": [
        "nussbaum", "furnier", "debowy", "debowe", "eiche", "buche", "esche",
        "ahorn", "kirsche", "veneer", "walnut", "beech", "maple", "oak",
    ],
    "wood_planks": [
        "holzverkleidung", "rhombusleiste", "stulpschalung", "holzschalung",
        "holzlattung", "deskowanie", "holzfassade", "boden-deckel",
        "weatherboard", "planks", "siding",
    ],
    "plywood": [
        "furnierschichtholz", "dreischichtplatte", "plyta wiorowa",
        "holzwerkstoff", "particle board", "spanplatte", "sperrholz", "multiplex", "chipboard",
        "plywood", "sklejka", "plyta osb", "osb", "mdf",
    ],
    # "holzwolle" (9) muss "holz" (4) schlagen — eine Leichtbauplatte ist kein
    # gehobeltes Vollholz.
    "wood_wool": [
        "holzwolle-leichtbauplatte", "holzwolledammplatte", "holzwolleplatte",
        "holzwolle", "heraklith", "wood wool",
    ],
    "cork": [
        "korkparkett", "korkboden", "korek", "kork", "cork",
    ],
    # Bewusst kein bloßes "stoff": das steckt in Dämmstoff, Kunststoff,
    # Baustoff und Werkstoff.
    "fabric": [
        "textilbespannung", "polsterstoff", "vorhangstoff", "moebelstoff",
        "upholstery", "gardine", "tkanina", "textile", "textil", "polster",
        "gewebe", "fabric", "filz",
    ],
    "leather": [
        "kunstleder", "leather", "leder", "skora",
    ],
    "plastic": [
        "polycarbonat", "polyethylen", "polyurethan", "kunststoff", "tworzywo",
        "plastik", "plastic", "pe-hd", "pmma", "pvc",
    ],
    # ── Boden ─────────────────────────────────────────────────────────────────
    "wood_parquet": [
        "fertigparkett", "stabparkett", "dielenboden", "fischgrat", "parkett",
        "parkiet", "parquet", "hardwood floor",
    ],
    "laminate": [
        "panele podlogowe", "laminatboden", "designbelag", "klickvinyl",
        "vinyldiele", "vinylboden", "laminate", "laminat", "lvt",
    ],
    "linoleum": [
        "kunststoffbelag", "marmoleum", "pvc-belag", "linoleum", "vinyl", "lino",
    ],
    "rubber": [
        "gummigranulat", "kautschukbelag", "noppenboden", "kautschuk",
        "neopren", "gummi", "rubber", "epdm", "guma",
    ],
    "carpet": [
        "wykladzina dywanowa", "teppichboden", "textilbelag", "nadelvlies",
        "teppich", "carpet", "dywan", "rug",
    ],
    "epoxy_floor": [
        "epoxidharzbeschichtung", "bodenbeschichtung", "posadzka zywiczna",
        "hartstoffestrich", "industrieboden", "reaktionsharz", "epoxidharz",
        "epoxid", "epoxy",
    ],
    "tiles_ceramic": [
        "plytki podlogowe", "feinsteinzeug", "bodenfliese", "steinzeug",
        "keramik", "fliesen", "plytki", "fliese", "kachel", "porcelain",
        "ceramic", "gres", "tile",
    ],
    "tiles_wall": [
        "plytki scienne", "wandfliese", "metrofliese", "subway tile", "wall tile",
    ],
    "tiles_mosaic": [
        "mosaikfliese", "glasmosaik", "mozaika", "mosaik", "mosaic",
    ],
    "terracotta": [
        "terrakottafliese", "terrakotta", "terracotta", "tonfliese", "cotto",
    ],
    "terrazzo": [
        "betonwerkstein", "kunststein", "terrazzo", "cast stone",
    ],
    "marble": [
        "marmor", "marmur", "carrara", "marble",
    ],
    "travertine": [
        "travertinplatte", "travertine", "travertin", "trawertyn",
    ],
    "granite": [
        "granit", "quarzit", "basalt", "gneis", "granite", "quartzite",
    ],
    # ── Metall ────────────────────────────────────────────────────────────────
    "metal": [
        "stal konstrukcyjna", "blacha ocynkowana", "profilstahl", "schwarzstahl",
        "baustahl", "stahlbau", "verzinkt", "blacha", "metall",
        "stahl", "eisen", "steel", "metal", "iron", "stal", "s235", "s355",
    ],
    "steel_brushed": [
        # "chrome"/"chromstahl" müssen länger sein als "steel" (5), sonst
        # gewinnt bei "Steel, Chrome Plated" die Kategorie `metal` — beide
        # Treffer wären sonst gleich lang und die dict-Reihenfolge entschiede.
        "stal nierdzewna", "chrome plated", "nierdzewna", "chromstahl",
        "edelstahl", "geburstet", "stainless", "brushed", "chrome", "chrom",
        "inox", "niro", "v2a", "v4a",
    ],
    # Der Lack ist ein Dielektrikum — deshalb `metallic = 0.0` in der Registry.
    "metal_painted": [
        "pulverbeschichtung", "pulverbeschichtet", "farba proszkowa",
        "stahl lackiert", "powder coated", "pulverbeschicht", "malowana",
        "lackiert",
    ],
    "aluminium": [
        "profile aluminiowe", "aluminiowe", "aluminium", "eloxiert", "aluminum",
        "anodized", "alu-",
    ],
    "copper": [
        "kupferblech", "messing", "bronze", "kupfer", "copper",
        # "Cooper" steht als Stilname so im GESTAMP-Modell.
        "cooper", "brass", "miedz",
    ],
    "zinc": [
        "titanzinkblech", "titanzink", "zinkblech", "zink", "zinc", "cynk",
    ],
    "cast_iron": [
        "sphaeroguss", "gusseisen", "cast iron", "grauguss", "zeliwo",
    ],
    "metal_corrugated": [
        "blacha trapezowa", "sandwichpaneel", "trapezoidal sheet", "blacha falista",
        "trapezblech", "profilblech", "blechprofil", "corrugated", "wellblech",
    ],
    "metal_standing_seam": [
        "winkelstehfalz", "doppelstehfalz", "standing seam", "wickelfalz",
        "falzblech", "stehfalz",
    ],
    "metal_perforated": [
        "blacha perforowana", "streckmetall", "perforiert", "perforated",
        "lochblech",
    ],
    "metal_grating": [
        "krata pomostowa", "gitterrost", "rostgitter", "gitterost", "grating",
        "walkway", "gitter",
    ],
    "metal_diamond": [
        "diamond plate", "tranenblech", "riffelblech", "warzenblech", "tread plate",
    ],
    "metal_rusty": [
        "wetterfester stahl", "weathering steel", "cortenstahl", "cor-ten",
        "corten", "patina", "rusty", "rost",
    ],
    # ── Außenanlagen ──────────────────────────────────────────────────────────
    "asphalt": [
        "nawierzchnia asfaltowa", "fahrbahnbelag", "asphaltbeton", "gussasphalt",
        "asphalt", "asfalt", "tarmac",
    ],
    "paving": [
        "verbundpflaster", "betonpflaster", "pflasterstein", "kostka brukowa",
        "gehwegplatte", "betonstein", "pflaster", "paving",
    ],
    "cobblestone": [
        "natursteinpflaster", "kopfsteinpflaster", "kostka kamienna",
        "cobblestone", "kopfstein", "cobble",
    ],
    "wood_deck": [
        "terrassendiele", "taras drewniany", "holzterrasse", "wpc-diele",
        "holzdeck", "terrasse", "decking", "wpc",
    ],
    "gravel": [
        "schottertragschicht", "frostschutzschicht", "crushed stone",
        "drainschicht", "kiesbett", "kruszywo", "schotter", "splitt",
        "gravel", "kies", "zwir",
    ],
    "sand": [
        "sandschicht", "spielsand", "quarzsand", "sandbett", "piasek", "sand",
    ],
    "soil": [
        "gelandeoberflache", "mutterboden", "erdaushub", "erdreich", "topsoil",
        "subsoil", "aushub", "ziemia", "humus", "earth", "gleba", "grunt", "erde",
    ],
    "mulch": [
        "hackschnitzel", "pflanzflache", "rindenmulch", "pflanzbeet", "mulch",
    ],
    "grass": [
        "grunflache", "begrunung", "trawnik", "rasen", "wiese", "grass",
        "trawa", "lawn", "turf", "gras",
    ],
}

# Nur Kategorien, die es auch in der Registry gibt — schützt davor, dass ein
# Tippfehler hier still eine Kategorie erzeugt, für die keine Bilder existieren.
_UNKNOWN = set(_CATEGORY_KEYWORDS) - set(CATEGORIES)
if _UNKNOWN:
    raise RuntimeError(
        f"Keywords für unbekannte Kategorien: {', '.join(sorted(_UNKNOWN))} — "
        "fehlt ein Eintrag in tiling/textures.py?"
    )

# Deutsche Umlaute *und* polnische Diakritika: das GESTAMP-Modell ist komplett
# polnisch benannt ("Wełna mineralna", "Cegła", "Żelbet monolityczny"), und ohne
# Transliteration fiel davon kein einziges Material in eine Kategorie.
_UMLAUTS = str.maketrans(
    {
        "ä": "a", "ö": "o", "ü": "u", "ß": "s", "é": "e", "è": "e",
        "ą": "a", "ć": "c", "ę": "e", "ł": "l", "ń": "n",
        "ó": "o", "ś": "s", "ź": "z", "ż": "z",
    }
)


def _normalize(text: str) -> str:
    """Kleinschreibung ohne Umlaute — Exporte transliterieren uneinheitlich."""
    return text.strip().lower().translate(_UMLAUTS)


# Sammelbegriffe: Wörter, die nur die Warengruppe nennen und deshalb in
# zusammengesetzten Namen regelmäßig *neben* dem eigentlichen Material stehen —
# "Metall Chrom", "Kunststoff Linoleum", "Izolacja - Celuloza". Nach der
# Längenregel gewönnen sie dort, weil "metall" (6) länger ist als "chrom" (5);
# das Ergebnis wäre durchweg die gröbere Kategorie. Sie werden deshalb erst
# geprüft, wenn kein anderes Keyword gegriffen hat — "Kunststoff PE weiss" landet
# so weiterhin bei `plastic`, "Kunststoff Linoleum" aber bei `linoleum`.
_GENERIC_KEYWORDS = frozenset({"metall", "metal", "kunststoff", "izolacja"})


def _best_match(normalized: str, patterns: dict[str, list[str]]) -> tuple[str | None, int]:
    """Kategorie mit dem längsten enthaltenen Keyword, plus dessen Länge."""
    best, best_len = None, 0
    fallback, fallback_len = None, 0
    for category, keywords in patterns.items():
        for keyword in keywords:
            if keyword not in normalized:
                continue
            if keyword in _GENERIC_KEYWORDS:
                if len(keyword) > fallback_len:
                    fallback, fallback_len = category, len(keyword)
            elif len(keyword) > best_len:
                best, best_len = category, len(keyword)
    return (best, best_len) if best else (fallback, fallback_len)


# ── Farbzuordnung: eine Fläche einfarbig, aber in gewählter Farbe ───────────

# Eine Zuordnung kann statt einer Texturkategorie auch eine Farbe sein:
# `farbe:#c8a05a`. Damit bekommt ein Stil ein mattes, unifarbenes Material in
# genau dieser Farbe — kein Bild, kein Muster, kein Maßstab.
#
# **Warum das kein Sonderfall im Renderer ist.** Der Flachfarben-Pfad des
# Tilings schreibt ohnehin `metallicFactor 0.0` und `roughnessFactor 1.0`,
# also genau die Kennwerte einer matten, nichtmetallischen Oberfläche. Eine
# Farbzuordnung tauscht deshalb nur die Vertexfarbe des Material-Chunks aus
# und lässt alles Weitere unberührt — sie ist billiger als jede Textur und
# erzeugt kein zusätzliches glTF-Material.
#
# Der Wert steht als Zeichenkette in denselben Overrides wie eine Kategorie,
# weil er dieselbe Frage beantwortet ("was gilt für diesen Stil") und damit
# durch dieselbe Datei, dieselbe Route und dasselbe Re-Tiling läuft.
FARBE_PREFIX = "farbe:"

_HEX = "0123456789abcdefABCDEF"


def ist_farbwert(wert: str | None) -> bool:
    """True für eine gültige Farbzuordnung wie `farbe:#a3b1c2`."""
    return farbe_aus_wert(wert) is not None


def farbe_aus_wert(wert: str | None) -> tuple[int, int, int] | None:
    """`farbe:#a3b1c2` → (163, 177, 194); alles andere → None."""
    if not isinstance(wert, str) or not wert.startswith(FARBE_PREFIX):
        return None
    hexwert = wert[len(FARBE_PREFIX):].strip().lstrip("#")
    # Kurzform #abc mitnehmen: sie steht so in jedem Farbwähler-Beispiel und
    # wäre als einziger Schreibweisenfall ein ärgerlicher Fehlschlag.
    if len(hexwert) == 3 and all(c in _HEX for c in hexwert):
        hexwert = "".join(c * 2 for c in hexwert)
    if len(hexwert) != 6 or not all(c in _HEX for c in hexwert):
        return None
    return tuple(int(hexwert[i:i + 2], 16) for i in (0, 2, 4))


def farbzuordnung(
    style_name: str | None, overrides: dict[str, str] | None = None
) -> tuple[int, int, int] | None:
    """Die gewählte Ersatzfarbe eines Stils, oder None."""
    if not style_name or not overrides:
        return None
    wert = overrides.get(style_name)
    if wert is None:
        wert = overrides.get(_normalize(style_name))
    return farbe_aus_wert(wert)


def classify_material(
    style_name: str | None, overrides: dict[str, str] | None = None
) -> str | None:
    """
    Gibt die Texturkategorie für einen IfcSurfaceStyle-Namen zurück, oder
    `None`, wenn der Stil unverändert einfarbig bleiben soll.

    `overrides` ist die im Zuordnungsassistenten gespeicherte Zuordnung eines
    Jobs ({Stilname: Kategorie}). Sie hat Vorrang vor jeder automatischen
    Erkennung; ein leerer Wert bedeutet ausdrücklich "keine Textur" und ist
    damit von "nicht zugeordnet" unterscheidbar.
    """
    if not style_name:
        return None

    if overrides:
        override = overrides.get(style_name)
        if override is None:
            override = overrides.get(_normalize(style_name))
        if override is not None:
            return override if override in CATEGORIES else None

    return suggest_category(style_name)[0]


def suggest_category(style_name: str | None) -> tuple[str | None, float]:
    """
    Automatischer Vorschlag samt Konfidenz (0.0–1.0) für den Assistenten.

    Die Konfidenz ist bewusst grob — sie soll im UI nur zwischen "das passt
    sicher" und "bitte nachsehen" trennen: ein langes, eindeutiges Keyword
    ("gipskartonplatte") ist verlässlicher als ein kurzes, das zufällig in
    einem längeren Wort steckt ("alu-" in "Aluminium-Fensterprofil").
    """
    if not style_name:
        return None, 0.0

    normalized = _normalize(style_name)

    deny_hit = max((p for p in _DENY_PATTERNS if p in normalized), key=len, default=None)
    category, match_len = _best_match(normalized, _CATEGORY_KEYWORDS)

    # Deny gewinnt, außer das Materialkeyword ist spezifischer: "Betonfarbe"
    # ist ein Anstrich, "Farbbeton" ein Beton.
    if deny_hit and (category is None or len(deny_hit) >= match_len):
        return None, 0.0
    if category is None:
        return None, 0.0

    confidence = 0.95 if match_len >= 8 else 0.8 if match_len >= 5 else 0.6
    return category, confidence
