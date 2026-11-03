"""
Prüfstein für die Submodell-Identität.

Der Name eines Submodells ist sein Schlüssel: er steht im Speicherpfad, an der
Zeichnung und an jedem Rechenstand. Wandert er, findet ein Ergebnis von gestern
seinen Ausschnitt nicht wieder — und zwar still, weil der neue Name ja
existiert. Deshalb wird hier nicht die Schönheit der Kürzel geprüft, sondern
ihre **Stabilität**:

1. Dieselbe Etage bekommt in allen üblichen Schreibweisen dasselbe Kürzel.
2. Ein fehlendes Untergeschoss verschiebt kein Obergeschoss.
3. Die Feldnummer folgt der Lage im Bauwerk, nicht der Reihenfolge des Schnitts.
4. Zwei Etagen teilen sich nie einen Schlüssel.

Ausführen:  python3 tests/test_submodell.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import submodell as sm  # noqa: E402

_gut = True


def pruefe(bedingung, was, ist=None, soll=None):
    global _gut
    if bedingung:
        print(f"  ok    {was}")
    else:
        _gut = False
        print(f"  FEHLT {was}")
        if ist is not None or soll is not None:
            print(f"        ist  {ist!r}")
            print(f"        soll {soll!r}")
    return bedingung


def gleich(ist, soll, was):
    return pruefe(ist == soll, was, ist, soll)


# ── 1. Kürzel aus den Schreibweisen, die in IFC-Dateien wirklich stehen ──────

print("\nKürzel — dieselbe Etage, viele Schreibweisen")

for name, soll in [
    ("2.OG", "OG2"),
    ("2. Obergeschoss", "OG2"),
    ("OG2", "OG2"),
    ("OG_02", "OG2"),
    ("2.Obergeschoss", "OG2"),
    ("1.OG", "OG1"),
    ("Obergeschoss", "OG1"),
    ("EG", "EG"),
    ("Erdgeschoss", "EG"),
    ("00_Erdgeschoss", "EG"),
    ("UG", "UG1"),
    ("1.UG", "UG1"),
    ("2.Untergeschoss", "UG2"),
    ("Kellergeschoss", "UG1"),
    ("KG", "UG1"),
    ("DG", "DG"),
    ("Dachgeschoss", "DG"),
    ("Spitzboden", "DG"),
    ("Bodenplatte", sm.FUNDAMENT),
    ("Gründung", sm.FUNDAMENT),
    ("Fundamente", sm.FUNDAMENT),
    ("Zwischengeschoss", "ZG"),
]:
    gleich(sm.kuerzel(name), soll, f"{name!r} → {soll}")

print("\nDie Fallen der Teilstringsuche")
# „Erdgeschoss" enthält „dg", „Kellergeschoss" enthält „rg" — eine Suche ohne
# Wortgrenzen erklärt das Erdgeschoss zum Dachgeschoss.
gleich(sm.kuerzel("Erdgeschoss"), "EG", "Erdgeschoss enthält 'dg', ist aber EG")
gleich(sm.kuerzel("Kellergeschoss"), "UG1", "Kellergeschoss ist UG1, nicht EG")
gleich(sm.kuerzel("Untergeschoss"), "UG1", "Untergeschoss ist UG1")

print("\nUnbekanntes bleibt stehen, statt geraten zu werden")
gleich(sm.kuerzel("Ebene 3"), "Ebene_3", "'Ebene 3' bleibt als bereinigter Name")
gleich(sm.kuerzel(""), "GESCHOSS", "leerer Name")


# ── 2. Ein fehlendes Geschoss verschiebt nichts ─────────────────────────────

print("\nEin fehlendes Untergeschoss verschiebt kein Obergeschoss")

mit_ug = ["2.OG", "1.OG", "EG", "UG"]
ohne_ug = ["2.OG", "1.OG", "EG"]
a = sm.kuerzel_alle(mit_ug)
b = sm.kuerzel_alle(ohne_ug)
gleich(a["2.OG"], "OG2", "mit UG:  2.OG → OG2")
gleich(b["2.OG"], "OG2", "ohne UG: 2.OG → OG2 (unverändert)")
pruefe(all(a[n] == b[n] for n in ohne_ug),
       "alle gemeinsamen Geschosse behalten ihr Kürzel")


# ── 3. Zwei Etagen teilen sich nie einen Schlüssel ──────────────────────────

print("\nDoppelte Kürzel werden aufgelöst, nicht geteilt")

doppelt = sm.kuerzel_alle(["OG", "1.OG", "EG"])
gleich(doppelt["OG"], "OG1", "das erste bekommt OG1")
gleich(doppelt["1.OG"], "OG1_2", "das zweite bekommt OG1_2")
pruefe(len(set(doppelt.values())) == 3, "drei Geschosse, drei verschiedene Schlüssel",
       sorted(doppelt.values()), "paarweise verschieden")


# ── 4. Reihenfolge im Bauwerk ───────────────────────────────────────────────

print("\nRang — von oben nach unten")

kuerzel = ["EG", "OG2", sm.FUNDAMENT, "UG1", "DG", "OG1"]
geordnet = sorted(kuerzel, key=sm.rang)
gleich(geordnet, ["DG", "OG2", "OG1", "EG", "UG1", sm.FUNDAMENT],
       "Dach, Obergeschosse absteigend, EG, Keller, Gründung")


# ── 5. Feldnummern folgen der Lage, nicht dem Schnitt ───────────────────────

print("\nFeldnummern folgen der Lage im Bauwerk")

# Zwei Baukörper wie im geprüften Modell: West bei x −0,1, Ost bei x 46,8.
west = {"global_id": "W", "lo": [-0.11, 2.0, 6.0]}
ost = {"global_id": "O", "lo": [46.82, 2.0, 6.0]}

# Der Schnitt gibt sie einmal so und einmal so zurück — das Ergebnis darf
# davon nicht abhängen.
a = sm.namen_fuer("OG2", [ost, west])
b = sm.namen_fuer("OG2", [west, ost])
gleich([n for n, _ in a], ["submodell.OG2.1", "submodell.OG2.2"],
       "Reihenfolge des Schnitts A")
gleich([n for n, _ in b], ["submodell.OG2.1", "submodell.OG2.2"],
       "Reihenfolge des Schnitts B")
gleich(dict(a)["submodell.OG2.1"]["global_id"], "W",
       "die .1 ist immer der westliche Baukörper")
gleich(dict(b)["submodell.OG2.1"]["global_id"], "W",
       "auch bei umgekehrter Eingabe")

print("\nEin Feld bekommt keine Nummer")
einzeln = sm.namen_fuer("EG", [west])
gleich([n for n, _ in einzeln], ["submodell.EG"], "genau ein Feld → ohne .1")

print("\nGleiches x entscheidet über y")
unten = {"global_id": "U", "lo": [10.0, 0.0, 3.0]}
oben = {"global_id": "O", "lo": [10.0, 20.0, 3.0]}
gleich([p["global_id"] for p in sm.felder_ordnen([oben, unten])], ["U", "O"],
       "bei gleichem x_min ordnet y_min")


# ── 6. Name und Pfad sind umkehrbar ─────────────────────────────────────────

print("\nName, Zerlegung, Pfad")

gleich(sm.name("OG2"), "submodell.OG2", "Name ohne Feld")
gleich(sm.name("OG2", 2), "submodell.OG2.2", "Name mit Feld")
gleich(sm.zerlegen("submodell.OG2.2"), ("OG2", 2), "Zerlegung mit Feld")
gleich(sm.zerlegen("submodell.EG"), ("EG", None), "Zerlegung ohne Feld")
gleich(sm.zerlegen("EG"), ("EG", None), "Zerlegung ohne Vorsilbe")
gleich(sm.zerlegen("submodell.OG1_2"), ("OG1_2", None),
       "ein aufgelöstes Doppel ist keine Feldnummer")
gleich(sm.pfad("submodell.OG2.2"), "submodelle/OG2/2", "Pfad mit Feld")
gleich(sm.pfad("submodell.EG"), "submodelle/EG", "Pfad ohne Feld")

for n in ["submodell.OG2", "submodell.OG2.3", "submodell.EG", "submodell.FUND"]:
    kurz, nr = sm.zerlegen(n)
    gleich(sm.name(kurz, nr), n, f"zerlegen∘name ist die Identität für {n}")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
