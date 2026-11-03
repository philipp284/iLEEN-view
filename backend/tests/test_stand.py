"""
Prüfstein für Eingabe-Hash und Veraltungs-Propagierung.

Die Frage, um die es geht: *Gilt die Zahl, die ich sehe, für das System, das ich
sehe?* Bis September 2026 beantwortete sie ein Merkmal, das jemand setzen
musste. Jetzt beantwortet sie ein Hash über die Eingabe — und der kann nicht
vergessen werden.

Zwei Eigenschaften entscheiden über die Brauchbarkeit, und sie ziehen in
entgegengesetzte Richtungen:

1. **Empfindlich genug.** Jede Änderung, die die Rechnung ändert, muss den Hash
   ändern. Sonst gilt ein Ergebnis für ein System, das es nicht mehr gibt.
2. **Ruhig genug.** Was die Rechnung *nicht* ändert — die Reihenfolge des
   Schnitts, ein Zeitstempel, eine Lagerkennung —, darf ihn nicht ändern. Eine
   Warnung, die bei jedem Lauf erscheint, wird ignoriert, und das ist die
   schlimmste Eigenschaft einer Warnung.

Ausführen:  python3 tests/test_stand.py
"""

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import stand as st  # noqa: E402

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


def modell():
    return {
        "plan": {"geschoss": "EG", "submodell": "submodell.EG"},
        "system": [{
            "id": "P1",
            "umriss": [[0, 0], [10, 0], [10, 8], [0, 8]],
            "oeffnungen": [[[4, 3], [6, 3], [6, 5], [4, 5]]],
            "dicke_m": 0.22,
            "bettung_kNm3": None,
            "material": {"name": "C25/30", "E_kNm2": 31e6, "nu": 0.2,
                         "wichte_kNm3": 25.0},
        }],
        "auflager": [
            {"id": "A1", "typ": "linie", "art": "gelenkig", "bauteile": ["W1"],
             "polylinie": [[0, 0], [10, 0]], "_laenge": 10.0},
            {"id": "A2", "typ": "linie", "art": "gelenkig", "bauteile": ["W2"],
             "polylinie": [[0, 8], [10, 8]], "_laenge": 10.0},
        ],
        "lastfaelle": [
            {"id": "AUS", "name": "Ausbau", "art": "G", "gamma": 1.35,
             "psi0": 1.0, "psi2": 1.0},
        ],
        "lasten": [
            {"id": "L1", "typ": "flaeche", "lastfall": "AUS", "wert": 1.5,
             "polygon": [[0, 0], [10, 0], [10, 8], [0, 8]]},
        ],
        "unterzuege": [],
    }


# ── 1. Empfindlich: was die Rechnung ändert, ändert den Hash ────────────────

print("\nWas die Rechnung ändert, ändert den Hash")

grund = st.hash_der_eingabe(modell())

for was, aendern in [
    ("die Deckendicke", lambda m: m["system"][0].__setitem__("dicke_m", 0.24)),
    ("den Umriss", lambda m: m["system"][0]["umriss"].append([0, 4])),
    ("eine Öffnung", lambda m: m["system"][0]["oeffnungen"][0][0].__setitem__(0, 4.5)),
    ("die Betongüte", lambda m: m["system"][0]["material"].__setitem__("E_kNm2", 33e6)),
    ("die Bettung", lambda m: m["system"][0].__setitem__("bettung_kNm3", 20000.0)),
    ("eine Lagerart", lambda m: m["auflager"][0].__setitem__("art", "eingespannt")),
    ("eine Lagerlage", lambda m: m["auflager"][0]["polylinie"][1].__setitem__(0, 9.0)),
    ("eine Flächenlast", lambda m: m["lasten"][0].__setitem__("wert", 2.5)),
    ("einen Teilsicherheitsbeiwert",
     lambda m: m["lastfaelle"][0].__setitem__("gamma", 1.5)),
]:
    m = modell()
    aendern(m)
    pruefe(st.hash_der_eingabe(m) != grund, f"{was} ändern")

print("\nEin Lager entfernen ändert ihn")
m = modell()
m["auflager"].pop()
pruefe(st.hash_der_eingabe(m) != grund, "ein Auflager weniger")

print("\nEin Eingriff ändert ihn — auch ohne Änderung am Modell")
mit = st.hash_der_eingabe(modell(), eingriffe=[
    {"nr": 1, "art": "lager_entfernen", "bauteil": "W2", "wert": {}}])
pruefe(mit != grund, "ein Eingriff geht in den Hash ein")

print("\nEine andere Netzweite ist eine andere Rechnung")
pruefe(st.hash_der_eingabe(modell(), netzweite=0.25)
       != st.hash_der_eingabe(modell(), netzweite=0.10),
       "0,25 m und 0,10 m ergeben verschiedene Hashes")


# ── 2. Ruhig: was die Rechnung nicht ändert, ändert ihn nicht ───────────────

print("\nWas die Rechnung nicht ändert, ändert ihn nicht")

print("  Die Reihenfolge des Schnitts")
# Zwei Läufe über dasselbe IFC liefern die Auflager womöglich anders geordnet.
# Ein Hash darauf meldete bei jedem Lauf „geändert".
m = modell()
m["auflager"].reverse()
gleich(st.hash_der_eingabe(m), grund, "umgekehrte Auflagerreihenfolge")

m = modell()
m["lasten"] = list(reversed(m["lasten"] + [
    {"id": "L2", "typ": "flaeche", "lastfall": "AUS", "wert": 0.8,
     "polygon": [[0, 0], [5, 0], [5, 4], [0, 4]]}]))
m2 = modell()
m2["lasten"] = m2["lasten"] + [
    {"id": "L2", "typ": "flaeche", "lastfall": "AUS", "wert": 0.8,
     "polygon": [[0, 0], [5, 0], [5, 4], [0, 4]]}]
gleich(st.hash_der_eingabe(m), st.hash_der_eingabe(m2),
       "umgekehrte Lastreihenfolge")

print("  Die Lagerkennungen")
# `A7` wird bei jedem Lauf neu vergeben — eine andere Netzweite, eine Wand
# mehr, und die Nummern verschieben sich.
m = modell()
for i, a in enumerate(m["auflager"]):
    a["id"] = f"A{99 - i}"
gleich(st.hash_der_eingabe(m), grund, "andere Lagerkennungen")

print("  Rundungsrauschen aus der Geometrie")
# Dieselbe Geometrie zweimal geschnitten weicht in der fünfzehnten Stelle ab.
m = modell()
m["system"][0]["umriss"] = [[x + 1e-12, y - 1e-12]
                            for x, y in m["system"][0]["umriss"]]
gleich(st.hash_der_eingabe(m), grund, "Abweichung in der zwölften Stelle")

print("  Zeitstempel und Herkunftstexte")
m = modell()
m["plan"]["gerechnet"] = "2026-09-05T12:00:00Z"
m["lasten"][0]["herkunft"] = "aus der Raumnutzung erkannt"
gleich(st.hash_der_eingabe(m), grund, "Zeitstempel und Herkunft")

print("  Und er ist stabil über Aufrufe hinweg")
gleich(st.hash_der_eingabe(modell()), grund, "zweimal derselbe Hash")
gleich(len(grund), 16, "16 Hexziffern")


# ── 3. Der Zustand eines Submodells ─────────────────────────────────────────

print("\nDer Zustand eines einzelnen Submodells")

gleich(st.zustand(None), st.NIE_GERECHNET, "ohne Eintrag")
gleich(st.zustand({"hash": "a"}), st.NIE_GERECHNET, "ohne Rechnung")
gleich(st.zustand({"hash": "a", "rechnung": {"id": "r1", "hash": "a"}}),
       st.AKTUELL, "gleicher Hash")
gleich(st.zustand({"hash": "b", "rechnung": {"id": "r1", "hash": "a"}}),
       st.VERALTET, "anderer Hash")
gleich(st.zustand({"hash": "a", "rechnung": {"id": "r1", "hash": "a",
                                             "status": "fehlgeschlagen"}}),
       st.FEHLERHAFT, "gescheiterte Rechnung")
gleich(st.zustand({"hash": "a", "rechnung": {"id": "r1"}}),
       st.VERALTET, "ein Stand ohne Hash gilt als veraltet, nicht als gültig")


# ── 4. Die Propagierung nach unten ──────────────────────────────────────────

print("\nEine Änderung in OG2 veraltet alles darunter — und nichts darüber")


def haus(geaendert=()):
    """Ein Fünfgeschosser, alles gerechnet; die genannten sind geändert."""
    namen = ["submodell.DG", "submodell.OG2", "submodell.OG1",
             "submodell.EG", "submodell.FUND"]
    return {n: {"art": st.GESCHOSS,
                "hash": "neu" if n in geaendert else "alt",
                "rechnung": {"id": "r1", "hash": "alt", "status": "fertig"}}
            for n in namen}


p = st.propagiere(haus(["submodell.OG2"]))
gleich(p["submodell.DG"]["zustand"], st.AKTUELL,
       "das Dachgeschoss darüber bleibt gültig")
gleich(p["submodell.OG2"]["zustand"], st.VERALTET, "OG2 ist geändert")
for n in ("submodell.OG1", "submodell.EG", "submodell.FUND"):
    gleich(p[n]["zustand"], st.VERALTET, f"{n} veraltet mit")
pruefe("submodell.OG2" in p["submodell.EG"]["grund"],
       "und das EG sagt, woher das kommt", p["submodell.EG"]["grund"],
       "… submodell.OG2 …")

print("\nNach oben läuft nichts")
p = st.propagiere(haus(["submodell.EG"]))
for n in ("submodell.DG", "submodell.OG2", "submodell.OG1"):
    gleich(p[n]["zustand"], st.AKTUELL, f"{n} über dem EG bleibt gültig")
gleich(p["submodell.FUND"]["zustand"], st.VERALTET, "die Gründung veraltet mit")

print("\nOhne Änderung ist alles aktuell")
p = st.propagiere(haus())
pruefe(all(e["zustand"] == st.AKTUELL for e in p.values()),
       "fünf Submodelle, alle aktuell",
       [e["zustand"] for e in p.values()], "alle aktuell")

print("\nEine Nebenrechnung veraltet nichts und veraltet nicht")
mit_neben = haus()
mit_neben["submodell.Unterzug-Achse-C"] = {
    "art": st.NEBENRECHNUNG, "hash": "neu",
    "rechnung": {"id": "r9", "hash": "alt", "status": "fertig"}}
p = st.propagiere(mit_neben)
gleich(p["submodell.Unterzug-Achse-C"]["zustand"], st.VERALTET,
       "die Nebenrechnung ist für sich veraltet")
for n in ("submodell.DG", "submodell.OG2", "submodell.EG", "submodell.FUND"):
    gleich(p[n]["zustand"], st.AKTUELL, f"{n} bleibt davon unberührt")


# ── 5. Das Gesamtsystem ─────────────────────────────────────────────────────

print("\nDer Zustand des Gesamtsystems")

g = st.gesamtzustand(st.propagiere(haus()))
gleich(g["zustand"], st.AKTUELL, "alles aktuell")
gleich(g["gesamt"], 5, "fünf Submodelle in der Kette")

g = st.gesamtzustand(st.propagiere(haus(["submodell.OG2"])))
gleich(g["zustand"], st.VERALTET, "eine Änderung in OG2 macht das Ganze veraltet")
gleich(g["aktuell"], 1, "nur das Dachgeschoss ist noch aktuell")
pruefe("nicht mehr aktuell" in g["grund"],
       f"und die Zeile sagt es im Klartext: {g['grund']!r}")
gleich(g["betroffen"][0], "submodell.OG2",
       "das oberste betroffene steht vorn — dort fängt das Neurechnen an")

print("\nEine Nebenrechnung zieht das Gesamtsystem nicht herunter")
g = st.gesamtzustand(st.propagiere(mit_neben))
gleich(g["zustand"], st.AKTUELL, "die Gesamtstatik bleibt aktuell")


# ── 6. Was neu gerechnet werden muss ────────────────────────────────────────

print("\nInkrementell: nur was veraltet ist")

liste = st.zu_rechnen(st.propagiere(haus(["submodell.OG2"])))
gleich(liste, ["submodell.OG2", "submodell.OG1", "submodell.EG",
               "submodell.FUND"],
       "vier Submodelle, von oben nach unten")
pruefe("submodell.DG" not in liste,
       "das Dachgeschoss wird nicht angefasst")

gleich(st.zu_rechnen(st.propagiere(haus())), [],
       "ohne Änderung ist nichts zu tun")

print("\nNebenrechnungen stehen am Ende")
liste = st.zu_rechnen(st.propagiere(mit_neben))
gleich(liste, ["submodell.Unterzug-Achse-C"],
       "nur sie, und die Gesamtstatik bleibt liegen")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
