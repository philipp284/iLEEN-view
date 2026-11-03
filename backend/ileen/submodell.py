"""
Die Identität eines Submodells: welcher Teil des Bauwerks wird hier gerechnet.

Das Gesamtsystem wird einmal durchgerechnet, von der obersten Decke bis zur
gebetteten Bodenplatte. Dabei entsteht je Deckenfeld ein **Submodell** — ein
für sich rechenbarer Ausschnitt mit eigener Geometrie, eigenen Lasten, eigenem
Rechenstand und eigener Zeichnung. Submodelle werden nie von Hand angelegt;
sie fallen beim Aufbau des Gesamtsystems an.

    Gesamtsystem
      ├── submodell.DG
      ├── submodell.OG2.1      ← Bauteil West
      ├── submodell.OG2.2      ← Bauteil Ost
      ├── submodell.OG1
      ├── submodell.EG
      ├── submodell.UG1
      └── submodell.FUND       ← Bodenplatte, elastisch gebettet

## Warum der Name normalisiert wird und nicht aus dem IFC durchgereicht

`IfcBuildingStorey.Name` ist Freitext. Dieselbe Etage heißt in drei Modellen
„2.OG", „2. Obergeschoss" und „OG_02"; in einem vierten steht dort „Ebene 3".
Ein Submodellname, der das durchreicht, ist als Schlüssel unbrauchbar: er
ändert sich mit dem Modellexport, und ein Rechenstand von gestern findet seinen
Ausschnitt nicht wieder.

Normalisiert wird deshalb auf ein Kürzel — `OG2`, `EG`, `UG1`, `DG`, `FUND` —,
und die Reihenfolge im Bauwerk folgt daraus ohne Zutun. Der ursprüngliche
IFC-Name geht nicht verloren; er wandert als `quelle` mit und steht in jeder
Anzeige daneben.

**Die Zahl kommt aus dem Namen, nicht aus einem Zähler.** Ein Index über die
sortierte Geschossliste wäre bequem und falsch: fehlt in einem Modell das
Untergeschoss, rutschte alles darüber um eine Stelle, und `submodell.OG2`
bezeichnete plötzlich das erste Obergeschoss. Der Rechenstand von gestern hinge
dann an der falschen Etage — still, weil der Name ja existiert.

## Warum die Feldnummer nach der Lage vergeben wird

Ein Geschoss hat so viele Deckenfelder, wie das Gebäude Abschnitte hat (siehe
`kette.deckenplatten()`). Jedes davon wird ein eigenes Submodell und bekommt
eine Nummer angehängt — aber nicht die Reihenfolge, in der der Schnitt die
Figuren zurückgibt. Die hängt an Netzweite und Schnitthöhe, und eine andere
Netzweite hieße: dieselbe Nummer trifft die andere Platte.

Geordnet wird deshalb nach der Lage des Umrisses: aufsteigend nach `x_min`, bei
Gleichstand nach `y_min`. Das ist eine Eigenschaft des Bauwerks und ändert sich
nur, wenn sich das Bauwerk ändert.

Hat ein Geschoss genau ein Feld, entfällt die Nummer: `submodell.EG`, nicht
`submodell.EG.1`.
"""

from __future__ import annotations

import re
import unicodedata

#: Vorsilbe jedes Submodellnamens. Sie steht im Baum, in der Zeichnung und im
#: Speicherpfad, damit ein Name nie mit einer Geschossbezeichnung des IFC
#: verwechselt werden kann.
VORSILBE = "submodell"

#: Kürzel der Bodenplatte. Sie ist kein Geschoss im Sinne des IFC — sie liegt
#: unter dem untersten —, bekommt aber ein eigenes Submodell, weil sie als
#: einzige elastisch gebettet gerechnet wird.
FUNDAMENT = "FUND"

#: Rang eines Kürzels im Bauwerk, von oben nach unten gelesen: je kleiner die
#: Zahl, desto weiter oben. Die Kette rechnet in dieser Reihenfolge, der Baum
#: zeigt sie so an.
_RANG_DACH = -1000
_RANG_FUND = 1000


#: Umlaute in ihre Ersatzschreibung. Die Reihenfolge ist wichtig: erst hier
#: ersetzen, dann zerlegen. Andersherum macht `NFKD` aus „ü" ein „u" mit
#: losgelöstem Trema, und „Gründung" käme als „grundung" heraus — ein Muster
#: `gruendung` fände es nicht mehr, und die Bodenplatte hieße „Gr_ndung".
_UMLAUTE = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
                          "Ä": "ae", "Ö": "oe", "Ü": "ue"})


def _entfalten(text: str) -> str:
    """
    Kleinbuchstaben in Ersatzschreibung — „Gründung" und „Gruendung" gleich.

    Beide Schreibweisen kommen in IFC-Dateien vor, je nachdem, welches
    Autorenwerkzeug den Namen vergeben hat.
    """
    ersetzt = str(text or "").translate(_UMLAUTE).lower()
    roh = unicodedata.normalize("NFKD", ersetzt)
    return "".join(z for z in roh if not unicodedata.combining(z))


def _wort(muster: str, text: str) -> bool:
    """
    Steht `muster` im Text als eigenes Wort — Ziffern zählen als Grenze.

    Nackte Teilstrings gehen hier schief, und zwar unauffällig: „Erdgeschoss"
    enthält „dg", „Kellergeschoss" enthält „rg". Eine Suche nach „dg" erklärte
    das Erdgeschoss zum Dachgeschoss, und der Fehler fiele erst auf, wenn die
    Lastkette in der falschen Etage anfängt.

    Ziffern müssen als Grenze durchgehen, weil beide Schreibweisen vorkommen:
    „2.OG" und „OG2".
    """
    return re.search(rf"(?:^|[^a-z])({muster})(?:[^a-z]|$)", text) is not None


def _zahl(text: str) -> int | None:
    """Die erste Zahl im Namen — die Ordnungszahl des Geschosses."""
    treffer = re.search(r"\d+", text)
    return int(treffer.group()) if treffer else None


def kuerzel(name: str) -> str:
    """
    IFC-Geschossname → Kürzel (`OG2`, `EG`, `UG1`, `DG`, `FUND`).

    Wird der Name nicht erkannt, bleibt er als bereinigte Fassung stehen —
    ein Kürzel zu raten wäre schlimmer als eines, das nach dem Modell aussieht.
    """
    t = _entfalten(name)
    n = _zahl(t)

    if _wort(r"fund\w*|gruendung|sohle|bodenplatte|fundamente?", t):
        return FUNDAMENT
    if _wort(r"dg|dach\w*|spitzboden|attika", t):
        return "DG" if n is None else f"DG{n}"
    if _wort(r"ug|kg|keller\w*|unterge\w*|untergeschoss", t):
        return f"UG{n or 1}"
    if _wort(r"eg|erdge\w*|erdgeschoss|parterre", t):
        return "EG"
    if _wort(r"og|oberge\w*|obergeschoss", t):
        return f"OG{n or 1}"
    if _wort(r"zg|zwischenge\w*|mezzanin\w*|galerie", t):
        return "ZG" if n is None else f"ZG{n}"

    bereinigt = re.sub(r"[^A-Za-z0-9]+", "_", str(name or "").strip()).strip("_")
    return bereinigt or "GESCHOSS"


def rang(kuerzel_: str) -> int:
    """
    Ordnung im Bauwerk: kleiner heißt weiter oben.

    Die Kette rechnet von oben nach unten, der Baum zeigt in derselben
    Richtung. Alphabetisch stünde „EG" vor „UG1" und „DG" ganz vorn — also
    genau falsch herum.
    """
    k = str(kuerzel_ or "").upper()
    n = _zahl(k.lower()) or 0
    if k == FUNDAMENT:
        return _RANG_FUND
    if k.startswith("DG"):
        return _RANG_DACH + n
    if k.startswith("OG"):
        return -n
    if k == "EG":
        return 0
    if k.startswith("ZG"):
        return 1
    if k.startswith("UG"):
        return 1 + n
    return 500


def kuerzel_alle(namen) -> dict[str, str]:
    """
    Alle Geschossnamen eines Bauwerks auf einmal — mit Auflösung von Doppeln.

    Zwei Geschosse können auf dasselbe Kürzel fallen: „OG" und „1.OG" ergeben
    beide `OG1`. Ein stillschweigend geteilter Schlüssel wäre der schlimmste
    Ausgang — zwei Etagen schrieben in denselben Rechenstand. Das zweite und
    jedes weitere bekommt deshalb ein `_2`, `_3` angehängt, in der Reihenfolge,
    in der die Namen übergeben wurden.

    @param namen  Geschossnamen, bereits in Bauwerksreihenfolge
    @returns      IFC-Name → Kürzel
    """
    ergebnis: dict[str, str] = {}
    vergeben: dict[str, int] = {}
    for name in namen:
        k = kuerzel(name)
        if k in vergeben:
            vergeben[k] += 1
            k = f"{k}_{vergeben[k]}"
        else:
            vergeben[k] = 1
        ergebnis[name] = k
    return ergebnis


def felder_ordnen(platten: list[dict]) -> list[dict]:
    """
    Deckenfelder eines Geschosses in eine Ordnung bringen, die das Bauwerk hat.

    Sortiert nach `x_min`, bei Gleichstand nach `y_min` — beides aus der
    Hüllbox der Platte. Die Reihenfolge des Schnitts taugt nicht: sie hängt an
    Netzweite und Schnitthöhe, und ein Feld, das gestern die `.1` war, wäre
    morgen die `.2`.

    Erwartet je Platte `lo` (untere Ecke der Hüllbox) oder `x_min`/`y_min`.
    Fehlt beides, ordnet die GlobalId — willkürlich, aber wenigstens stabil.
    """
    def schluessel(p: dict):
        lo = p.get("lo")
        if lo and len(lo) >= 2:
            return (0, round(float(lo[0]), 3), round(float(lo[1]), 3), "")
        if p.get("x_min") is not None:
            return (0, round(float(p["x_min"]), 3),
                    round(float(p.get("y_min") or 0.0), 3), "")
        return (1, 0.0, 0.0, str(p.get("global_id") or ""))

    return sorted(platten, key=schluessel)


def name(kuerzel_: str, feld_nr: int | None = None) -> str:
    """
    Der vollständige Submodellname: `submodell.OG2` oder `submodell.OG2.1`.

    Ohne `feld_nr` — das ist der Fall bei genau einem Deckenfeld — entfällt die
    Nummer. Eine `.1`, der nie eine `.2` folgt, wäre nur Ballast in jeder
    Anzeige und in jedem Pfad.
    """
    if feld_nr is None:
        return f"{VORSILBE}.{kuerzel_}"
    return f"{VORSILBE}.{kuerzel_}.{feld_nr}"


def namen_fuer(kuerzel_: str, platten: list[dict]) -> list[tuple[str, dict]]:
    """
    Die Submodelle eines Geschosses: je Deckenfeld eines, in fester Ordnung.

    @returns [(submodellname, platte), …] — bei einem Feld ohne Nummer
    """
    geordnet = felder_ordnen(platten)
    if len(geordnet) == 1:
        return [(name(kuerzel_), geordnet[0])]
    return [(name(kuerzel_, i + 1), p) for i, p in enumerate(geordnet)]


def zerlegen(submodellname: str) -> tuple[str, int | None]:
    """
    `submodell.OG2.1` → `("OG2", 1)`. Die Umkehrung von `name()`.

    Nötig, weil der Name der Schlüssel ist: er steht im Speicherpfad, in der
    Zeichnung und in jedem Verweis. Wer aus ihm das Geschoss braucht — für die
    Reihenfolge, für die Veraltung nach unten —, bekommt es hier.
    """
    text = str(submodellname or "")
    if text.startswith(VORSILBE + "."):
        text = text[len(VORSILBE) + 1:]
    teile = text.split(".")
    if len(teile) >= 2 and teile[-1].isdigit():
        return (".".join(teile[:-1]), int(teile[-1]))
    return (text, None)


def pfad(submodellname: str) -> str:
    """
    Der Ablageort unter dem Modell: `submodelle/OG2` bzw. `submodelle/OG2/1`.

    Die Feldnummer wird eine eigene Ebene und kein Namensteil, damit sich alle
    Felder eines Geschosses mit einem Präfix ansprechen lassen — löschen,
    auflisten, für veraltet erklären.
    """
    kurz, nr = zerlegen(submodellname)
    sicher = re.sub(r"[^A-Za-z0-9_-]+", "_", kurz)
    return f"submodelle/{sicher}" if nr is None else f"submodelle/{sicher}/{nr}"
