"""
Raumdaten aus dem IFC: was ein `IfcSpace` über sich selbst sagt.

Die Raumansicht im Viewer zeigt je Raum ein Anforderungsprofil — Nutzlast,
Anschlussleistung, Lüftung, Schallschutz, Brandschutz. Bisher kam das
ausschließlich aus einem Katalog, an den der Raum über seinen Namen gehängt
wurde. Das ist der richtige Rückfall, aber nicht die erste Wahl: Steht im
Modell, dass der Raum 500 lx braucht oder eine Normheizlast von 1,2 kW hat,
dann hat das ein Fachplaner hineingeschrieben, und es sticht jeden Richtwert.

    IFC (Pset)          →  Merkmal          →  Viewer
    Pset_SpaceLighting  →  beleuchtung_lx   →  „500 lx · IFC"
    Requirements.
    Illuminance

## Warum Kandidatenlisten und nicht die Normnamen

Die Normnamen (`Pset_SpaceThermalRequirements.SpaceTemperatureMin`) führt
kaum eine Datei aus der Praxis. Geprüft an den Modellen im Backend:

| Erzeuger | wo die Nutzung steht | wo die TGA-Angaben stehen |
|---|---|---|
| ArchiCAD | `Pset_SpaceCommon.Category` („Büroarbeit"), `ArchiCADProperties.Raumkategoriecode` („02 NUF") | — |
| Revit | `Identity Data.Name` | `Energy Analysis.Specified Power Load per area` u. a. |
| HSM-Campus (eigene Psets) | `HSM_Raumdaten.Nutzung_Plantext` | — |

Gesucht wird deshalb je Merkmal über eine Liste regulärer Ausdrücke auf dem
normalisierten Schlüssel `pset.eigenschaft` — Normname zuerst, dann die
bekannten Erzeugernamen, dann deutsche Freitextnamen. Der erste Treffer mit
einem verwertbaren Wert gewinnt, und **der Pfad, aus dem er kam, geht mit**:
Wer im Viewer „500 lx · IFC" sieht, soll nachsehen können, wo das stand.

## Einheiten

`ifcopenshell.util.element.get_psets` liefert Zahlen ohne Einheit. Für die
Normsätze gilt SI (IFC-Standardeinheiten); daraus folgen zwei Umrechnungen,
und beide haben eine Plausibilitätsgrenze, weil Erzeuger sich nicht daran
halten:

* **Temperatur.** IFC rechnet in Kelvin. Werte über 150 werden als Kelvin
  gelesen, darunter als °C — eine Raumtemperatur von 150 °C gibt es nicht,
  eine von 150 K auch nicht.
* **Volumenstrom.** IFC rechnet in m³/s, Planer in m³/h. Ein Raum mit 5 m³/s
  Zuluft wäre ein Hangar; Werte darunter werden als m³/s gelesen und mal
  3600 genommen, Werte darüber gelten als schon in m³/h.

Freitext-Eigenschaften (`HSM_Raumdaten.Zuluft`) werden nicht umgerechnet:
Wer seine eigene Eigenschaft anlegt, schreibt sie in seiner Einheit.

## Was hier nicht passiert

Die **Nutzlastkategorie der Statik** wird hier nicht gedeutet, auch wenn das
Modell eine führt. Sie kommt aus `raumlasten.kategorie_von()` — genau der
Funktion, die auch der Lastabtrag aufruft. Eine zweite Deutung an dieser
Stelle könnte der Viewer anders anzeigen, als die Statik rechnet. Eine
Nutzlast aus dem IFC steht deshalb als eigenes Merkmal daneben
(`nutzlast_knm2`), und der Viewer weist auf einen Widerspruch hin, statt ihn
aufzulösen.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

_UMLAUTE = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
                          "Ä": "ae", "Ö": "oe", "Ü": "ue"})


def schluessel(text: str) -> str:
    """
    `Pset_SpaceCommon.Category` → `pset_spacecommon.category`.

    Kleinschreibung, Umlaute ausgeschrieben, alles außer Buchstaben, Ziffern,
    Punkt und Unterstrich entfernt. Der Punkt trennt Satz und Eigenschaft und
    muss deshalb stehen bleiben; Leerzeichen fallen weg, damit Revits
    „Energy Analysis.Area per Person" als `energyanalysis.areaperperson`
    ankommt.
    """
    t = str(text or "").translate(_UMLAUTE).lower()
    t = "".join(z for z in unicodedata.normalize("NFKD", t) if not unicodedata.combining(z))
    return re.sub(r"[^a-z0-9._]", "", t)


@dataclass(frozen=True)
class Merkmal:
    key: str
    art: str                       # "text" | "zahl" | "bool"
    muster: tuple[str, ...]        # reguläre Ausdrücke auf `schluessel(pset.eigenschaft)`
    einheit: str = ""
    umrechnung: str | None = None  # "temperatur" | "volumenstrom"
    null_ist_leer: bool = True     # 0 heißt bei Revit „nicht gesetzt"


#: Die Merkmale in der Reihenfolge, in der der Viewer sie zeigt. Innerhalb
#: eines Merkmals entscheidet die Reihenfolge der Muster: Normname vor
#: Erzeugername vor Freitext.
MERKMALE: tuple[Merkmal, ...] = (
    Merkmal("nutzung", "text", (
        r"^pset_spaceoccupancyrequirements\.occupancytype$",
        r"^pset_spacecommon\.category$",
        r"^pset_spacecommon\.occupancytype$",
        r"\.(raum)?nutzung(_?plantext|_?text|_?bezeichnung)?$",
        r"\.raumkategoriename$",
        r"\.occupancytype$",
    )),
    Merkmal("din277", "text", (
        r"\.raumkategoriecode$",
        r"din_?277",
        r"\.nutzungsart$",
        r"\.flaechenart$",
        r"\.flaechenkategorie$",
    )),
    Merkmal("aussen", "bool", (r"^pset_spacecommon\.isexternal$",)),
    Merkmal("barrierefrei", "bool", (
        r"^pset_spacecommon\.handicapaccessible$",
        r"\.barrierefrei(heit)?$",
    )),
    Merkmal("oeffentlich", "bool", (r"^pset_spacecommon\.publiclyaccessible$",)),
    Merkmal("personen", "zahl", (
        r"^pset_spaceoccupancyrequirements\.occupancynumber$",
        r"^pset_spaceoccupancyrequirements\.occupancynumberpeak$",
        r"^energyanalysis\.numberofpeople$",
        r"\.(personen|personenzahl|personenanzahl|belegung)$",
    ), "Pers."),
    Merkmal("flaeche_je_person", "zahl", (
        r"^pset_spaceoccupancyrequirements\.areaperoccupant$",
        r"^energyanalysis\.areaperperson$",
    ), "m²/Pers."),
    Merkmal("beleuchtung_lx", "zahl", (
        r"^pset_spacelightingrequirements\.illuminance$",
        r"\.illuminance$",
        r"\.beleuchtungsstaerke(_?lx)?$",
    ), "lx"),
    Merkmal("licht_w_m2", "zahl", (
        r"^energyanalysis\.specifiedlightingloadperarea$",
        r"^energyanalysis\.actuallightingloadperarea$",
        r"\.beleuchtungsleistung.*(m2|qm)$",
    ), "W/m²"),
    Merkmal("elektro_w_m2", "zahl", (
        r"^energyanalysis\.specifiedpowerloadperarea$",
        r"^energyanalysis\.actualpowerloadperarea$",
        r"\.(elektro|anschluss|strom)leistung.*(m2|qm)$",
    ), "W/m²"),
    Merkmal("elektro_kw", "zahl", (
        r"\.(elektro|anschluss)leistung(_?kw)?$",
    ), "kW"),
    Merkmal("luftwechsel_1h", "zahl", (
        r"^pset_spacethermalrequirements\.mechanicalventilationrate$",
        r"\.luftwechsel(rate|zahl)?$",
    ), "1/h"),
    Merkmal("zuluft_m3h", "zahl", (
        r"^pset_spacethermaldesign\.ventilationairflowrate$",
        r"^pset_airsidesysteminformation\.totalairflow$",
        r"\.(zuluft|aussenluft|luftmenge)(_?m3h|volumenstrom)?$",
    ), "m³/h", umrechnung="volumenstrom"),
    Merkmal("abluft_m3h", "zahl", (
        r"^pset_spacethermaldesign\.exhaustairflowrate$",
        r"\.abluft(_?m3h|volumenstrom)?$",
    ), "m³/h", umrechnung="volumenstrom"),
    Merkmal("temp_min_c", "zahl", (
        r"^pset_spacethermalrequirements\.spacetemperaturewintermin$",
        r"^pset_spacethermalrequirements\.spacetemperaturemin$",
        r"\.(soll|norminnen|norm|raum)temperatur(_?winter|_?heizen|_?min)?$",
    ), "°C", umrechnung="temperatur"),
    Merkmal("temp_max_c", "zahl", (
        r"^pset_spacethermalrequirements\.spacetemperaturesummermax$",
        r"^pset_spacethermalrequirements\.spacetemperaturemax$",
        r"\.temperatur_?(sommer|kuehlen|max)$",
    ), "°C", umrechnung="temperatur"),
    Merkmal("heizlast_w", "zahl", (
        r"^pset_spacethermaldesign\.totalheatloss$",
        r"\.(norm)?heizlast(_?w)?$",
    ), "W"),
    Merkmal("kuehllast_w", "zahl", (
        r"^pset_spacethermaldesign\.totalheatgain$",
        r"^pset_spacethermaldesign\.totalsensibleheatgain$",
        r"\.kuehllast(_?w)?$",
    ), "W"),
    Merkmal("brandschutz", "text", (
        r"^pset_spacefiresafetyrequirements\.fireriskfactor$",
        r"\.feuerwiderstand(sklasse|sdauer)?$",
        r"\.brandschutz(klasse|anforderung)?$",
        r"\.fireresistance(rating)?$",
    )),
    Merkmal("fluchtweg", "bool", (
        r"^pset_spacefiresafetyrequirements\.fireexit$",
        r"\.(flucht|rettungs)weg$",
    )),
    Merkmal("sprinkler", "bool", (
        r"^pset_spacefiresafetyrequirements\.sprinklerprotection$",
        r"\.sprinkler(ung)?$",
    )),
    Merkmal("schallschutz", "text", (
        r"\.schallschutz(stufe|klasse|anforderung)?$",
        r"\.acousticrating$",
        r"\.(erf)?schalldaemm(mass|ung)?$",
    )),
    Merkmal("nutzlast_knm2", "zahl", (
        r"\.(nutzlast|verkehrslast|liveload)(_?knm2|_?kn)?$",
    ), "kN/m²"),
    Merkmal("nutzlast_kategorie", "text", (
        r"\.(nutzlast|last|nutzungs)kategorie(_?ec1|_?din1991)?$",
    )),
    Merkmal("bodenbelag", "text", (
        r"^pset_spacecoveringrequirements\.floorcovering$",
        r"^pset_spacecommon\.floorcovering$",
        r"\.(bodenbelag|fussboden|bodenaufbau)(_?plan)?$",
    )),
    Merkmal("deckenbekleidung", "text", (
        r"^pset_spacecoveringrequirements\.ceilingcovering$",
        r"^pset_spacecommon\.ceilingcovering$",
        r"\.(deckenbelag|deckenbekleidung|unterdecke|decke_?plan)$",
    )),
    Merkmal("wandbekleidung", "text", (
        r"^pset_spacecoveringrequirements\.wallcovering$",
        r"^pset_spacecommon\.wallcovering$",
        r"\.(wandbelag|wandbekleidung|wandoberflaeche)(_?plan)?$",
    )),
    Merkmal("rutschhemmung", "text", (
        r"\.rutschhemmung$", r"\.rutschfestigkeit$", r"\.slipresistance$",
    )),
    Merkmal("wasser", "bool", (
        r"\.(wasser|sanitaer)anschluss$",
    )),
)

_KOMPILIERT = [(m, [re.compile(p) for p in m.muster]) for m in MERKMALE]

# ── Was iLEEN selbst ins IFC schreibt (`raum_ifc.py`) ────────────────────

ILEEN_PSET = "Pset_iLEEN_Raum"
ILEEN_PSET_HERKUNFT = "Pset_iLEEN_RaumHerkunft"

#: Kriterium der Raumansicht → (Property-Name, Art, Merkmal beim Zurücklesen).
#:
#: Die eine Stelle, an der die Namen stehen: der Viewer schickt seine Werte
#: unter dem Kriterium (`raum-merkmale.js`), `raum_ifc.py` schreibt sie unter
#: diesem Namen, und `merkmale()` liest sie hierüber wieder ein. Die Einheit
#: steht im Namen und nicht im IFC-Typ — siehe `raum_ifc.py`.
ILEEN_FELDER: list[tuple[str, str, str, str | None]] = [
    ("klasse",       "Raumklasse",              "kennung", "ileen_klasse"),
    ("zone",         "Nutzungsbereich",         "text",    None),
    ("din277",       "DIN277",                  "text",    "din277"),
    ("nutzlast_kat", "Nutzlastkategorie",       "text",    "nutzlast_kategorie"),
    ("nutzlast",     "Nutzlast_kNm2",           "zahl",    "nutzlast_knm2"),
    ("elektro",      "Elektro_W_m2",            "zahl",    "elektro_w_m2"),
    ("elektro_kw",   "Elektro_kW",              "zahl",    "elektro_kw"),
    ("lux",          "Beleuchtungsstaerke_lx",  "zahl",    "beleuchtung_lx"),
    ("luft",         "Aussenluft_m3_hm2",       "zahl",    None),
    ("luft_m3h",     "Aussenluft_m3_h",         "zahl",    "zuluft_m3h"),
    ("abluft",       "MechanischeAbluft",       "bool",    None),
    ("wasser",       "Wasseranschluss",         "bool",    "wasser"),
    ("temperatur",   "Raumtemperatur_C",        "zahl",    "temp_min_c"),
    ("heizlast",     "Heizlast_W",              "zahl",    "heizlast_w"),
    ("schall",       "Schallschutz_dB",         "zahl",    "schallschutz"),
    ("feucht",       "Feuchtraum",              "bool",    None),
    ("brand",        "Feuerwiderstand",         "text",    "brandschutz"),
    ("fluchtweg",    "Rettungsweg",             "bool",    "fluchtweg"),
    ("rutsch",       "Rutschhemmung",           "text",    "rutschhemmung"),
    ("bodenbelag",   "Bodenbelag",              "text",    "bodenbelag"),
    ("barrierefrei", "Barrierefrei",            "bool",    "barrierefrei"),
    ("personen",     "Personen",                "zahl",    "personen"),
    ("befunde",      "Pruefbefunde",            "langtext", None),
]

#: Herkünfte, die beim Zurücklesen **nicht** als IFC-Angabe gelten. Ein
#: Richtwert aus dem Katalog, einmal exportiert, sähe sonst beim nächsten
#: Einlesen aus wie eine Planungsangabe — und stäche den Katalog, aus dem er
#: stammt. Die Raumansicht rechnet ihn ohnehin aus der Klasse neu.
_NICHT_ZURUECK = {"katalog", "abgeleitet"}


def _ileen_merkmale(psets: dict[str, dict], schon: dict[str, dict]) -> dict[str, dict]:
    """Was `Pset_iLEEN_Raum` beiträgt — nur, wo die übrigen Psets nichts sagen."""
    werte = (psets or {}).get(ILEEN_PSET) or {}
    herkunft = (psets or {}).get(ILEEN_PSET_HERKUNFT) or {}
    if not werte:
        return {}
    ergebnis: dict[str, dict] = {}
    for _kriterium, name, art, merkmal in ILEEN_FELDER:
        if not merkmal or name not in werte or _ist_leer(werte[name]):
            continue
        text = str(herkunft.get(name) or "")
        quelle_art = text.split(":", 1)[0].strip().lower() if ":" in text else ""
        if quelle_art in _NICHT_ZURUECK:
            continue
        if merkmal in schon and merkmal != "ileen_klasse":
            continue
        wert = werte[name]
        if art == "bool":
            wert = _wahrheit(wert)
        elif art == "zahl":
            wert = _zahl(wert)
        if wert is None:
            continue
        ergebnis[merkmal] = {"wert": wert, "quelle": f"{ILEEN_PSET}.{name}",
                             "herkunft": quelle_art or None,
                             **({"herkunft_text": text} if text else {})}
    return ergebnis

#: Werte, die ein Erzeuger schreibt, wenn er nichts weiß. ArchiCAD füllt
#: `Raumkategoriename` mit „0", Revit seine Lasten mit „<Default>".
_LEER = {"", "0", "-", "--", "—", "none", "null", "n/a", "na", "<default>",
         "<none>", "nicht verknuepft", "nicht verknüpft", "unbekannt", "undefined"}


def _ist_leer(wert) -> bool:
    if wert is None:
        return True
    if isinstance(wert, str):
        t = wert.strip().lower()
        # ArchiCAD schreibt in unbelegte Stempelfelder den Feldnamen in
        # spitzen Klammern („<Fertigboden>"), Revit „<By Category>".
        return t in _LEER or bool(re.fullmatch(r"<[^<>]*>", t))
    if isinstance(wert, float) and not math.isfinite(wert):
        return True
    return False


def _zahl(wert) -> float | None:
    """Zahl aus einem Pset-Wert, auch aus „500 lx" oder „7,5"."""
    if isinstance(wert, bool):
        return None
    if isinstance(wert, (int, float)):
        return float(wert) if math.isfinite(float(wert)) else None
    m = re.search(r"-?\d+(?:[.,]\d+)?", str(wert))
    return float(m.group(0).replace(",", ".")) if m else None


def _wahrheit(wert) -> bool | None:
    if isinstance(wert, bool):
        return wert
    if isinstance(wert, (int, float)):
        return bool(wert)
    t = schluessel(wert)
    if t in ("true", "ja", "yes", "wahr", "1", "x", ".t."):
        return True
    if t in ("false", "nein", "no", "falsch", "0", ".f."):
        return False
    return None


def _umrechnen(m: Merkmal, zahl: float, normsatz: bool) -> float:
    if m.umrechnung == "temperatur" and zahl > 150:
        return zahl - 273.15
    if m.umrechnung == "volumenstrom" and normsatz and zahl < 5:
        return zahl * 3600.0
    return zahl


def _wert(m: Merkmal, roh, normsatz: bool) -> tuple[object, bool]:
    """
    Der verwertbare Wert eines Treffers und ob er umgerechnet wurde.

    `(None, False)` heißt: dieser Treffer taugt nicht, weiter suchen. Ein
    leeres Feld beim Normnamen soll den Freitextnamen dahinter nicht
    verdecken.
    """
    if _ist_leer(roh):
        return None, False
    if m.art == "bool":
        return _wahrheit(roh), False
    if m.art == "zahl":
        z = _zahl(roh)
        if z is None or (m.null_ist_leer and z == 0):
            return None, False
        u = _umrechnen(m, z, normsatz)
        return round(u, 3), abs(u - z) > 1e-9
    # Als Text gelesen: auch eine Zahl muss durch die Leerprüfung — ArchiCAD
    # führt `Raumkategoriename` im GoOP-Modell als Ganzzahl 0.
    text = ", ".join(str(v) for v in roh) if isinstance(roh, (list, tuple)) else str(roh)
    if _ist_leer(text):
        return None, False
    return text.strip(), False


def merkmale(psets: dict[str, dict]) -> dict[str, dict]:
    """
    Aus den Psets eines Raums die Merkmale, jedes mit seiner Fundstelle.

    @param psets  `{"Pset_SpaceCommon": {"Category": "Büroarbeit", …}, …}` —
                  die Form von `ifcopenshell.util.element.get_psets`
    @returns      `{"nutzung": {"wert": "Büroarbeit",
                                "quelle": "Pset_SpaceCommon.Category"}, …}`;
                  ein umgerechneter Wert trägt zusätzlich `roh`
    """
    flach: list[tuple[str, str, object]] = []
    for satz, werte in (psets or {}).items():
        if not isinstance(werte, dict):
            continue
        for name, roh in werte.items():
            if name == "id":
                continue
            flach.append((schluessel(f"{satz}.{name}"), f"{satz}.{name}", roh))

    ergebnis: dict[str, dict] = {}
    # Was iLEEN selbst geschrieben hat, zählt nicht als Fundstelle der
    # Normnamen — sonst fände `\.nutzlastkategorie$` die eigene Ausgabe vor
    # der Angabe des Planers.
    flach = [f for f in flach if not f[1].startswith((ILEEN_PSET + ".", ILEEN_PSET_HERKUNFT + "."))]
    for m, muster in _KOMPILIERT:
        for re_ in muster:
            treffer = None
            for norm, pfad, roh in flach:
                if not re_.search(norm):
                    continue
                normsatz = norm.startswith("pset_")
                wert, umgerechnet = _wert(m, roh, normsatz)
                if wert is None:
                    continue
                treffer = {"wert": wert, "quelle": pfad}
                if umgerechnet:
                    treffer["roh"] = json_wert(roh)
                if m.einheit:
                    treffer["einheit"] = m.einheit
                break
            if treffer:
                ergebnis[m.key] = treffer
                break
    ergebnis.update(_ileen_merkmale(psets, ergebnis))
    return ergebnis


# ── DIN 277 ──────────────────────────────────────────────────────────────

#: Die Nutzungsgruppen der DIN 277 (Netto-Raumfläche). NUF 1–7 ist die
#: Nutzungsfläche, TF 8 die Technikfläche, VF 9 die Verkehrsfläche.
DIN277: dict[str, str] = {
    "NUF": "Nutzungsfläche, Gruppe nicht angegeben",
    "NUF 1": "Wohnen und Aufenthalt",
    "NUF 2": "Büroarbeit",
    "NUF 3": "Produktion, Hand- und Maschinenarbeit, Forschung und Entwicklung",
    "NUF 4": "Lagern, Verteilen und Verkaufen",
    "NUF 5": "Bildung, Unterricht und Kultur",
    "NUF 6": "Heilen und Pflegen",
    "NUF 7": "Sonstige Nutzungen",
    "TF 8": "Technische Anlagen",
    "VF 9": "Verkehrserschließung und -sicherung",
}


def din277_gruppe(text: str | None) -> str | None:
    """
    „02 NUF" → „NUF 2", „VF" → „VF 9", „NF 2.1" → „NUF 2", „TF" → „TF 8".

    Die Schreibweisen gehen weit auseinander: ArchiCAD schreibt den Code vor
    die Gruppe („02 NUF"), ältere Pläne nach DIN 277-2:2005 „NF 2.1" mit
    Untergruppe, manche nur die Gruppe ohne Ziffer. TF und VF sind auch ohne
    Ziffer eindeutig. NUF ohne Ziffer bleibt „NUF" — welche der sieben
    Gruppen gemeint ist, steht nicht da, dass es Nutzungsfläche ist, schon.
    Im GoOP-Modell ist das bei 184 von 269 Räumen der Fall.
    """
    if not text:
        return None
    t = str(text).upper().replace(",", ".")
    art = re.search(r"\b(NUF|NF|TF|VF)\b", t)
    ziffer = re.search(r"\b0?([1-9])(?:\.\d+)?\b", t)
    if art:
        a = art.group(1)
        if a == "TF":
            return "TF 8"
        if a == "VF":
            return "VF 9"
        if ziffer and 1 <= int(ziffer.group(1)) <= 7:
            return f"NUF {int(ziffer.group(1))}"
        return "NUF"
    # Nur eine Ziffer: die Gruppennummer selbst („2.1 Büroräume").
    if ziffer:
        n = int(ziffer.group(1))
        if n <= 7:
            return f"NUF {n}"
        return "TF 8" if n == 8 else "VF 9"
    return None


def din277_aus(merkmale: dict, klassifikation: list[dict]) -> dict | None:
    """
    Die DIN-277-Gruppe eines Raums, mit Fundstelle — oder None.

    Erst ein Klassifikationsverweis, dessen System nach DIN 277 aussieht: der
    ist ausdrücklich als Flächenart gemeint. Dann das Merkmal `din277` aus den
    Psets („02 NUF"). Ein Verweis auf ein fremdes System (Uniclass „SL_20_15")
    wird nicht gedeutet — eine Ziffer darin ist keine Nutzungsgruppe.

    ArchiCAD schreibt die Raumkategorie als Verweis **ohne System**
    (`IfcClassificationReference` „02 NUF" / „Büroarbeit", ohne
    `ReferencedSource`). Ein solcher Verweis gilt, wenn seine Kennung das
    Flächenkürzel selbst trägt (NUF, NF, TF, VF) — dann ist er unverwechselbar.
    """
    for ref in klassifikation or []:
        system = schluessel(ref.get("system") or "")
        kennung = ref.get("kennung")
        ohne_system = not system and re.search(r"\b(NUF|NF|TF|VF)\b", str(kennung or "").upper())
        if "277" not in system and not ohne_system:
            continue
        for text in (kennung, ref.get("name")):
            gruppe = din277_gruppe(text)
            if gruppe:
                herkunft = ref.get("system") or "ohne System"
                return {"wert": gruppe, "quelle": f"Klassifikation {herkunft}: {text}"}
    eintrag = (merkmale or {}).get("din277")
    if eintrag:
        gruppe = din277_gruppe(eintrag.get("wert"))
        if gruppe:
            return {"wert": gruppe, "quelle": eintrag.get("quelle")}
    return None


# ── Psets für die Anzeige ────────────────────────────────────────────────

#: Sätze, die vor allem die Beschriftung im Plan beschreiben: ArchiCADs
#: `AC_Pset_Raumstempel_DIN_24` führt im GoOP-Modell 809 Eigenschaften je
#: Raum — Stift, Schriftart, Zeilenfolge, Abstände je Maßstab. Mittendrin
#: stehen aber echte Raumdaten, die es sonst nirgends gibt: Bodenbelag,
#: Deckenbelag, Wandbelag, Raumhöhe, Stärke des Bodenaufbaus. Der Satz wird
#: deshalb nicht verworfen, sondern Eigenschaft für Eigenschaft gesiebt.
_STEMPELSATZ = re.compile(r"raumstempel|roomstamp|zone_?stamp", re.I)

#: Was in einem Stempelsatz Layout ist. Die Schalter und Stifte tragen ihren
#: internen Namen in Klammern, und der beginnt immer klein („Bodenbelag
#: zeigen (bShowFloor_50)", „(penTitle_50)"); ein Kürzel in Großbuchstaben
#: wie „Berechnete Fläche (NRF)" ist dagegen Inhalt. Der Rest verrät sich am
#: Wort.
_STEMPEL_LAYOUT = re.compile(
    r"\((?-i:[a-z])\w*\)$|\(\w*_\d+\w*\)$|stift|schrift|font|textstil|marker|zeile|"
    r"position|distanz|abstand|winkel|schraffur|kürzel|kuerzel|titel$|zeigen|"
    r"preis|währung|waehrung|maßstab|massstab|eigener text|kreis temp|"
    r"zeichenbreite|ausrichtung|dwg-export|^id$", re.I)


def json_wert(wert):
    """Ein Pset-Wert, wie er in eine JSON-Antwort passt."""
    if wert is None or isinstance(wert, (bool, int, str)):
        return wert
    if isinstance(wert, float):
        return round(wert, 6) if math.isfinite(wert) else None
    if isinstance(wert, (list, tuple)):
        return [json_wert(v) for v in wert]
    return str(wert)


def psets_bereinigen(psets: dict[str, dict]) -> dict[str, dict]:
    """Psets ohne `id`, Stempelsätze ohne Layout, Werte JSON-tauglich."""
    sauber: dict[str, dict] = {}
    for satz, werte in (psets or {}).items():
        if not isinstance(werte, dict):
            continue
        stempel = bool(_STEMPELSATZ.search(satz))
        eintraege = {k: json_wert(v) for k, v in werte.items()
                     if k != "id" and not (stempel and _STEMPEL_LAYOUT.search(k))}
        if eintraege:
            sauber[satz] = eintraege
    return sauber
