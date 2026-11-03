"""
Welche Bauteile tragen — und woher diese Auskunft stammt.

Bis September 2026 hing die Frage an einem einzigen Property:
`Pset_WallCommon.LoadBearing`. Das ist die richtige Quelle, wo sie gepflegt
ist — und sie ist es in den wenigsten Modellen. Ein Architekturmodell aus
Revit, ArchiCAD oder Allplan führt sie oft gar nicht; dann war *jede* Wand ein
Auflager, die Gipskartonwand vor dem Aufzugsschacht eingeschlossen, und die
Decke lag auf einem Wald aus Lagern, der sie steifer machte, als sie ist.

Dieses Modul dreht die Reihenfolge um: gefragt wird zuerst das **Material**,
denn das steht in fast jedem Modell — es muss dort stehen, sonst ließe sich
das Bauteil nicht darstellen.

## Die Regel

* Eine Wand aus **Mauerwerk oder Stahlbeton** trägt.
* **Jede Stütze** trägt, unabhängig vom Material.
* Alles Übrige trägt nicht und geht nur als Last ein (Trennwandzuschlag).

Die Regel ist bewusst grob. Eine nichttragende Mauerwerkswand gibt es — sie
wird dann als Auflager angesetzt, das keines ist, und die Decke spannt
scheinbar kürzer. Der umgekehrte Fehler ist teurer: eine übersehene tragende
Wand nimmt der Decke ihr Auflager, und die Spannweite wächst. Wo die Regel
danebenliegt, korrigiert ein Eingriff `bauteil_tragend` (`eingriffe.py`) — und
der ist im Bericht sichtbar, während eine stille Fehleinschätzung es nicht ist.

## In welcher Reihenfolge gefragt wird

Von der genauesten Auskunft zur gröbsten. Jede Stufe, die etwas sagt, beendet
die Suche; was sie gesagt hat, steht als `quelle` im Bericht.

| # | Quelle | Warum an dieser Stelle |
|---|---|---|
| 1 | `IfcMaterialLayer.IsLoadBearing` | Eine Aussage des Modellierers über **genau diese Schicht** — genauer geht es nicht |
| 2 | `Pset_WallCommon.LoadBearing` | Eine Aussage über das Bauteil; richtig, wo gepflegt |
| 3 | Materialschichten | Trägt eine Schicht ein tragendes Material, trägt die Wand |
| 4 | Materialname des Bauteils | Bei einschaligen Bauteilen die einzige Angabe |
| 5 | Rolle | Stützen und Fundamente tragen, auch wenn niemand es hinschreibt |

Stufe 3 fragt **alle** Schichten, nicht die dickste. Bei 17,5 cm
Kalksandstein plus 20 cm Dämmung ist die dickste Schicht die Dämmung; eine
Erkennung, die nur sie ansieht, erklärt eine tragende Außenwand für
nichttragend — und eine Wand weniger fällt in einem Grundriss mit achtzig
Wänden niemandem auf.

## Warum Namen gedeutet werden und nicht Kennwerte

Naheliegend wäre, über die Rohdichte oder die Festigkeitsklasse zu gehen.
Beides steht in `IfcMaterialProperties`, und beides ist in Architekturmodellen
so gut wie nie gefüllt. Der **Name** ist gefüllt, weil er in der Legende
auftaucht. Er ist Freitext, deshalb wird hier auf Wortstämme geprüft und nicht
auf Gleichheit — „STB C25/30", „Stahlbeton_tragend" und „Beton, bewehrt"
sollen dasselbe ergeben.
"""

from __future__ import annotations

import re
import unicodedata

#: Zusammensetzungen, die einen fremden Wortstamm enthalten und trotzdem etwas
#: anderes bedeuten. Sie werden **vor** allen anderen geprüft.
#:
#: Der Grund ist die deutsche Wortbildung. „Zementestrich" enthält „estrich"
#: mitten im Wort, ohne Trenner — eine Suche mit Wortgrenze findet ihn nicht.
#: Also wird als Teilstring gesucht. Damit fängt aber „beton" auch das
#: „Gasbeton", und eine 24er Porenbetonwand wäre plötzlich eine
#: Stahlbetonwand: dieselbe Wand, dreifache Wichte, dreifache Tragfähigkeit.
#:
#: Die Liste ist der Preis dafür. Sie ist kurz, weil es nur wenige solcher
#: Wörter gibt, und sie ist explizit, weil jede Regel, die das automatisch
#: lösen wollte, an einem der Fälle scheitert.
SONDERFAELLE: tuple[tuple[str, str], ...] = (
    ("gasbeton", "mauerwerk"),         # Porenbeton, keine Stahlbetonwand
    ("porenbeton", "mauerwerk"),
    ("leichtbeton", "mauerwerk"),      # Hohlblock, kein Konstruktionsbeton
    ("bimsbeton", "mauerwerk"),
    ("blaehbeton", "mauerwerk"),
    ("betonwerkstein", "leichtbau"),   # ein Bodenbelag
    ("betonstein", "leichtbau"),
    ("betonpflaster", "leichtbau"),
    ("holzwolle", "daemmung"),         # Leichtbauplatte, kein Konstruktionsholz
    ("holzfaserdaemm", "daemmung"),
    ("estrich", "leichtbau"),          # „Betonestrich" trägt nicht
    ("screed", "leichtbau"),           # Revit: „Concrete, Sand/Cement Screed"
    ("concrete masonry", "mauerwerk"), # Revit: Betonsteine (CMU), kein Ortbeton
    ("concrete block", "mauerwerk"),
)

#: Wortstämme je Materialklasse, in Ersatzschreibung und klein.
#:
#: Reihenfolge zählt: geprüft wird von oben nach unten, der erste Treffer
#: gewinnt. `daemmung` steht deshalb **vor** `mauerwerk` — eine
#: „Mineralwolle-Dämmung zwischen Ziegel" enthält beides, und tragend ist sie
#: nicht.
MATERIALKLASSEN: list[tuple[str, tuple[str, ...]]] = [
    ("daemmung", (
        "daemmung", "daemmstoff", "mineralwolle", "steinwolle", "glaswolle",
        "eps", "xps", "pur", "pir", "resol", "perimeterdaemmung", "waermedaemm",
        "isolierung", "insulation", "thermal",
    )),
    ("stahlbeton", (
        "stahlbeton", "stb", "beton", "concrete", "c12/15", "c16/20", "c20/25",
        "c25/30", "c30/37", "c35/45", "c40/50", "c45/55", "c50/60",
        "ortbeton", "fertigteil", "elementdecke", "filigran",
    )),
    ("mauerwerk", (
        "mauerwerk", "mauer", "masonry", "ziegel", "brick", "klinker",
        "kalksandstein", "ks", "ksv", "porenbeton", "ytong", "gasbeton",
        "leichtbeton", "hlz", "hochlochziegel", "vollziegel", "naturstein",
        "bruchstein", "bimsstein", "blaehton",
    )),
    ("holz", (
        "holz", "timber", "wood", "brettschicht", "bsh", "kvh", "konstruktions",
        "furnierschicht", "bsp", "brettsperrholz", "clt", "fichte", "kiefer",
        "laerche", "eiche", "osb", "sperrholz",
        # Festigkeitsklassen nach EN 338 (Voll- und Laubholz) und EN 14080
        # (Brettschichtholz). Sie stehen hier aus demselben Grund wie
        # „c25/30“ bei Stahlbeton: ein Träger heißt im Modell oft nur nach
        # seiner Klasse, „GL24h“ ohne das Wort Brettschichtholz davor. Ohne
        # diese Stämme fiele er auf „kein Werkstoff erkannt“ zurück und würde
        # mit 25 kN/m³ gerechnet — als wäre er aus Beton.
        #
        # Verwechslungsfrei gegenüber Beton, weil die Betonklassen nach
        # EN 206 immer zwei Zahlen führen („C30/37“) und in der Liste oben
        # stehen: „C30/37“ trifft dort, bevor „c30“ hier geprüft wird.
        # Nacktes „C30“ ist damit eindeutig Nadelholz.
        "c14", "c16", "c18", "c20", "c22", "c24", "c27", "c30", "c35", "c40",
        "c45", "c50",
        "d18", "d24", "d27", "d30", "d35", "d40", "d50", "d60", "d70",
        "gl20", "gl22", "gl24", "gl26", "gl28", "gl30", "gl32",
    )),
    ("stahl", (
        "stahl", "steel", "s235", "s355", "baustahl", "profilstahl", "guss",
        "aluminium", "alu",
    )),
    ("leichtbau", (
        "gipskarton", "gipsfaser", "gk", "gkb", "gkf", "trockenbau", "rigips",
        "fermacell", "staenderwerk", "vorsatzschale", "plasterboard", "gypsum",
        "glas", "glass", "kunststoff", "folie", "abdichtung", "putz", "estrich",
        "belag", "anstrich", "luft", "air", "hohlraum",
    )),
]

#: Klassen, aus denen eine Wand tragend ist. Der Auftrag nennt genau diese
#: beiden; Holz und Stahl tragen selbstverständlich auch, aber ein Holzständer
#: als Linienlager einer Stahlbetondecke ist im Hochbau die Ausnahme und wäre
#: hier häufiger falsch als richtig. Wo es zutrifft, sagt es ein Eingriff.
TRAGENDE_KLASSEN = frozenset({"mauerwerk", "stahlbeton"})

_UMLAUTE = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
                          "Ä": "ae", "Ö": "oe", "Ü": "ue"})


def _entfalten(text: str) -> str:
    """Kleinbuchstaben in Ersatzschreibung, Umlaute vor der Zerlegung ersetzt."""
    ersetzt = str(text or "").translate(_UMLAUTE).lower()
    roh = unicodedata.normalize("NFKD", ersetzt)
    return "".join(z for z in roh if not unicodedata.combining(z))


def materialklasse(name: str | None) -> str | None:
    """
    Materialname → Klasse (`stahlbeton`, `mauerwerk`, `holz`, …) oder `None`.

    Geprüft wird auf Wortstämme als Teilstring, nicht auf Gleichheit: der Name
    ist Freitext, und „STB C25/30", „Stahlbeton_tragend" und „Beton, bewehrt"
    sollen dasselbe ergeben. Teilstring und nicht Wortgrenze, weil das Deutsche
    zusammenschreibt — „Zementestrich", „Stahlbetondecke", „Mauerwerksschale".

    Zwei Stufen, in dieser Reihenfolge:

    1. `SONDERFAELLE` — Zusammensetzungen, die einen fremden Stamm enthalten
       („Gasbeton" ist Mauerwerk, nicht Stahlbeton)
    2. `MATERIALKLASSEN` von oben nach unten, erster Treffer gewinnt

    Kurze Stämme wie `ks` und `gk` würden als nackter Teilstring zu viel
    fangen — „Werkstoff" enthält „ks". Für sie gilt deshalb die Wortgrenze auf
    beiden Seiten; das entscheidet `_kurz()`.
    """
    if not name:
        return None
    t = _entfalten(name)

    for stamm, klasse in SONDERFAELLE:
        if stamm in t:
            return klasse

    for klasse, stamme in MATERIALKLASSEN:
        for stamm in stamme:
            if _kurz(stamm):
                # Zwei Buchstaben als Teilstring fangen halbe Wörterbücher:
                # „ks" steckt in „Werkstoff", „gk" in nichts Gutem. Für sie
                # gilt die Wortgrenze auf beiden Seiten.
                if re.search(rf"(?:^|[^a-z]){re.escape(stamm)}(?:[^a-z]|$)", t):
                    return klasse
            elif stamm in t:
                return klasse
    return None


#: Wichten von **Schichten** eines Aufbaus, kN/m³ — Richtwerte nach
#: DIN EN 1991-1-1 Anhang A und den üblichen Rohdichteklassen im Mauerwerk.
#:
#: Feiner als `MATERIALKLASSEN`, weil die Klassen nach dem Tragen fragen und
#: nicht nach dem Gewicht: „leichtbau" fasst Gipskarton (9) und Putz (18)
#: zusammen, „mauerwerk" Porenbeton (7) und Kalksandstein (18). Für das
#: Eigengewicht ist das ein Faktor zwei bis drei.
#:
#: Erster Treffer gewinnt, deshalb stehen die besonderen Stämme vor den
#: allgemeinen: „holzfaserdaemm" vor „holz", „gipsfaser" vor „gips",
#: „porenbeton" vor „beton", „kalksandstein" vor „sandstein", „plasterboard"
#: vor „plaster".
SCHICHTWICHTEN: tuple[tuple[tuple[str, ...], float], ...] = (
    (("luftschicht", "hinterlueftung", "luft", "hohlraum", "air"), 0.0),
    (("holzfaserdaemm", "holzweichfaser", "holzfaser"), 2.0),
    (("holzwolle",), 4.0),
    (("schaumglas",), 1.5),
    (("daemmung", "daemmstoff", "mineralwolle", "steinwolle", "glaswolle", "eps",
      "xps", "pur", "pir", "resol", "waermedaemm", "isolierung", "insulation",
      "zellulose", "hanf", "flachs", "kork"), 1.0),
    (("staender", "riegelwerk"), 1.5),          # Ständer mit Dämmung dazwischen
    (("porenbeton", "gasbeton", "ytong", "aac"), 7.0),
    (("leichtbeton", "bims", "blaehton", "liapor"), 10.0),
    (("kalksandstein", "ks", "ksl", "ksv"), 18.0),
    (("hochlochziegel", "hlz", "leichtziegel", "poroton", "planziegel", "unipor"), 12.0),
    (("klinker", "vollziegel", "vormauer"), 18.0),
    (("ziegel", "brick"), 14.0),
    (("naturstein", "bruchstein", "sandstein", "granit", "kalkstein", "basalt"), 26.0),
    (("mauerwerk", "mauer", "masonry"), 18.0),
    (("estrich", "screed"), 22.0),
    (("gipsfaser", "fermacell"), 12.0),
    (("plasterboard", "gipskarton", "gkb", "gkf", "gkfi", "gk", "rigips",
      "trockenbau", "drywall"), 9.0),
    (("gipsputz",), 12.0),
    (("putz", "plaster", "render", "stucco"), 18.0),
    (("gips", "gypsum"), 12.0),
    (("stahlbeton", "beton", "concrete", "stb", "ortbeton", "fertigteil",
      "elementdecke", "filigran", "c12/15", "c16/20", "c20/25", "c25/30", "c30/37",
      "c35/45", "c40/50", "c45/55", "c50/60"), 25.0),
    (("brettsperrholz", "bsp", "clt", "brettschicht", "bsh", "glulam", "kvh",
      "holz", "timber", "wood", "fichte", "kiefer", "tanne", "laerche", "douglasie",
      "osb", "spanplatte", "sperrholz", "mdf", "lvl", "furnierschicht",
      "gl24", "gl28", "gl30", "c24"), 5.0),
    (("stahl", "steel", "s235", "s355"), 78.5),
    (("aluminium", "alu"), 27.0),
    (("glas", "glass", "verglasung"), 25.0),
    (("fliese", "keramik", "feinsteinzeug"), 20.0),
    (("bitumen", "abdichtung", "dachbahn"), 11.0),
    (("folie", "dampfbremse", "dampfsperre", "membran", "vlies"), 10.0),
    (("parkett", "dielen", "laminat"), 7.0),
    (("linoleum", "teppich", "belag"), 12.0),
    (("kunststoff", "pvc", "pe", "pp"), 10.0),
)


def schichtwichte(name: str | None) -> float | None:
    """
    Wichte einer Schicht aus ihrem Namen, kN/m³ — oder `None`, wenn unbekannt.

    Dieselbe Suche wie `materialklasse()` (Teilstring, kurze Stämme mit
    Wortgrenze), aber über `SCHICHTWICHTEN`.
    """
    if not name:
        return None
    t = _entfalten(name)
    # „Verputzt" nennt die Oberfläche, nicht den Körper: „Ortbeton - bewehrt
    # Verputzt" ist eine Betonwand (VA3) und wog als Putz 18 statt 25 kN/m³.
    # Nur wenn sonst nichts erkannt wird, ist es Putz.
    ohne_oberflaeche = re.sub(r"verputzt?", " ", t)
    if ohne_oberflaeche != t:
        w = _schichtwichte_text(ohne_oberflaeche)
        if w is not None:
            return w
    return _schichtwichte_text(t)


def _schichtwichte_text(t: str) -> float | None:
    for stamme, wichte in SCHICHTWICHTEN:
        for stamm in stamme:
            if _kurz(stamm):
                if re.search(rf"(?:^|[^a-z]){re.escape(stamm)}(?:[^a-z]|$)", t):
                    return wichte
            elif stamm in t:
                return wichte
    return None


def _kurz(stamm: str) -> bool:
    """
    Ein Stamm, der als nackter Teilstring zu viel fängt.

    Nur reine Buchstabenfolgen bis drei Zeichen: „ks" steckt in „Werkstoff",
    „gk" in allerlei. Ein Stamm mit Trenner oder Ziffer („c25/30", „s235") ist
    für sich schon eindeutig genug und würde von der beidseitigen Wortgrenze
    nur behindert — hinter „ks-" folgt nie eine Grenze, sondern das nächste
    Wort.
    """
    return stamm.isalpha() and len(stamm) <= 3


def _text(wert) -> bool | None:
    """`True`/`False`/`None` aus dem, was in einem IFC-Property stehen kann."""
    if wert is None:
        return None
    if isinstance(wert, bool):
        return wert
    text = str(wert).strip().lower()
    if text in ("true", "t", ".t.", "1", "yes", "ja"):
        return True
    if text in ("false", "f", ".f.", "0", "no", "nein"):
        return False
    return None


def werkstoffklasse(material: str | None,
                    schichten: list[dict] | None = None) -> str | None:
    """
    Woraus das Bauteil ist — die Klasse des **tragenden** Werkstoffs.

    `materialklasse()` allein beantwortet das nicht: übergeben wird ihr der
    Materialname des Bauteils, und der ist bei einem mehrschichtigen Aufbau
    die dickste Schicht. Bei 17,5 cm Kalksandstein hinter 20 cm Dämmung ist
    das die Dämmung — die Wand hieße „Dämmung“ und wöge entsprechend nichts.

    Dieselbe Überlegung wie in `beurteile()` Schritt 4, aber als eigene Frage:
    *ob* ein Bauteil trägt, sagt oft das Pset; *woraus* es ist, sagen nur die
    Schichten. Wer beides aus derselben Quelle zieht, bekommt eine davon falsch.
    """
    kandidaten = [l for l in (schichten or [])
                  if materialklasse(l.get("name")) in TRAGENDE_KLASSEN]
    if kandidaten:
        beste = max(kandidaten, key=lambda l: float(l.get("dicke_m") or 0.0))
        return materialklasse(beste.get("name"))
    # Keine tragende Schicht erkannt: die dickste Schicht ist die beste
    # verbliebene Auskunft — bei einer einschichtigen Holz- oder Betonwand ist
    # sie ohnehin die einzige.
    return materialklasse(material)


def pset_gepflegt(werte: list) -> tuple[bool, str | None]:
    """
    Ist `LoadBearing` in diesem Modell gepflegt — oder nur ein Vorgabewert?

    **Der Fall, der das nötig macht.** Revit schreibt `Pset_WallCommon.
    LoadBearing = False` an jede Wand, deren Haken „Tragend" niemand gesetzt
    hat — und in einem Architekturmodell setzt ihn niemand. Am
    `Ifc4_SampleHouse` standen so alle fünf Wände auf `False`, darunter drei
    aus Mauerwerk, auf denen die Dachdecke liegt; die Kette verwarf sie, die
    Decke hatte kein einziges Auflager und fiel samt ihrer Last aus der
    Rechnung.

    Ein Merkmal, das bei **jedem** Bauteil denselben Wert trägt, unterscheidet
    nichts. Gepflegt ist es erst, wenn es beide Werte kennt — oder wenn es
    ausdrücklich `True` sagt (ein reines Tragwerksmodell darf durchweg `True`
    führen). Steht es überall auf `False`, entscheidet das Material; das ist
    dieselbe Reihenfolge wie bei einem Modell ganz ohne Pset.

    @param werte  `LoadBearing` je Wand (`True`/`False`/`None`)
    @returns (gepflegt, Hinweis für den Bericht oder None)
    """
    wahr = sum(1 for w in werte if w is True)
    falsch = sum(1 for w in werte if w is False)
    if falsch >= 2 and wahr == 0:
        return False, (
            f"Pset_WallCommon.LoadBearing steht bei allen {falsch} Wänden auf False — "
            f"als nicht gepflegt gewertet (ein Vorgabewert des Autorenwerkzeugs). "
            f"Ob eine Wand trägt, entscheidet deshalb ihr Material.")
    return True, None


def beurteile(*, rolle: str, psets: dict | None = None,
              material: str | None = None,
              materialschichten: list[dict] | None = None,
              pset_vertrauen: bool = True) -> dict:
    """
    Trägt dieses Bauteil — und woher weiß man das?

    @param rolle              `wand` · `stuetze` · `decke` · `fundament` · …
    @param psets              Property-Sets des Bauteils
    @param material           Materialname des Bauteils (dickste Schicht)
    @param materialschichten  alle Schichten, aus `section.materialschichten_of()`
    @param pset_vertrauen     False, wenn `LoadBearing` im Modell nicht gepflegt
                              ist (`pset_gepflegt()`); dann zählt Stufe 3 nicht
    @returns `{tragend: bool|None, quelle: str, klasse: str|None,
               tragende_schicht: dict|None}`

    `tragend = None` heißt „nicht zu entscheiden" und ist keine Verlegenheit:
    der Unterschied zwischen „ausdrücklich nichttragend" und „keine Angabe"
    gehört in den Bericht. Wer fehlende Angaben als `False` liest, verliert
    stillschweigend Wände; wer sie als `True` liest, erklärt jede Trennwand zum
    Auflager.
    """
    schichten = list(materialschichten or [])

    # ── 1. Alle Stützen tragen ───────────────────────────────────────────
    #
    # Ganz oben und ohne Materialfrage: der Auftrag sagt es ausdrücklich, und
    # eine Stütze, die nicht trägt, ist keine Stütze. Fundamente ebenso.
    if rolle in ("stuetze", "fundament"):
        return {"tragend": True, "quelle": f"Rolle „{rolle}“ trägt immer",
                "klasse": materialklasse(material), "tragende_schicht": None}

    # ── 2. IsLoadBearing an der Schicht ──────────────────────────────────
    #
    # Die genaueste Auskunft, die es gibt: eine Aussage des Modellierers über
    # genau diese Schicht. Sie sticht alles Weitere.
    for lage in schichten:
        gesetzt = _text(lage.get("tragend_gesetzt"))
        if gesetzt is True:
            return {"tragend": True,
                    "quelle": "IfcMaterialLayer.IsLoadBearing",
                    "klasse": materialklasse(lage.get("name")),
                    "tragende_schicht": lage}
    if schichten and all(_text(l.get("tragend_gesetzt")) is False for l in schichten):
        return {"tragend": False, "quelle": "IfcMaterialLayer.IsLoadBearing",
                "klasse": werkstoffklasse(material, schichten),
                "tragende_schicht": None}

    # ── 3. Pset_WallCommon.LoadBearing ───────────────────────────────────
    for schluessel in (("LoadBearing", "IsLoadBearing", "Loadbearing")
                       if pset_vertrauen else ()):
        wert = _pset_wert(psets, schluessel)
        gesetzt = _text(wert)
        if gesetzt is not None:
            # Das Pset sagt, *ob* sie trägt. Woraus sie ist, sagen die
            # Schichten — sonst erbt eine tragende Wand die Klasse ihrer
            # Dämmung und wird mit deren Wichte gerechnet.
            return {"tragend": gesetzt, "quelle": f"Pset.{schluessel}",
                    "klasse": werkstoffklasse(material, schichten),
                    "tragende_schicht": None}

    # ── 4. Die Materialschichten ─────────────────────────────────────────
    #
    # **Alle** Schichten, nicht die dickste: bei 17,5 cm Kalksandstein plus
    # 20 cm Dämmung ist die dickste die Dämmung. Trägt *eine* Schicht ein
    # tragendes Material, trägt die Wand — und zwar auf dieser Schicht.
    kandidaten = [l for l in schichten
                  if materialklasse(l.get("name")) in TRAGENDE_KLASSEN]
    if kandidaten:
        # Unter mehreren tragenden Schichten die dickste: auf ihr liegt die
        # Decke auf, und mit ihrer Dicke wird der Knicknachweis geführt.
        beste = max(kandidaten, key=lambda l: float(l.get("dicke_m") or 0.0))
        return {"tragend": True, "quelle": "Materialschicht",
                "klasse": materialklasse(beste.get("name")),
                "tragende_schicht": beste}
    if schichten and any(l.get("name") for l in schichten):
        return {"tragend": False, "quelle": "Materialschichten",
                "klasse": materialklasse(material), "tragende_schicht": None}

    # ── 5. Der Materialname des Bauteils ─────────────────────────────────
    klasse = materialklasse(material)
    if klasse is not None:
        return {"tragend": klasse in TRAGENDE_KLASSEN, "quelle": "Materialname",
                "klasse": klasse, "tragende_schicht": None}

    # ── 6. Nichts zu holen ───────────────────────────────────────────────
    return {"tragend": None, "quelle": "keine Angabe im Modell",
            "klasse": None, "tragende_schicht": None}


def _pset_wert(psets: dict | None, schluessel: str):
    """Ein Property über alle Property-Sets hinweg suchen, Groß/klein egal."""
    if not psets:
        return None
    gesucht = schluessel.lower()
    for satz in psets.values():
        if not isinstance(satz, dict):
            continue
        for name, wert in satz.items():
            if str(name).lower() == gesucht:
                return wert
    # Manche Modelle legen die Properties flach ab, ohne Pset-Ebene.
    for name, wert in psets.items():
        if str(name).lower() == gesucht:
            return wert
    return None
