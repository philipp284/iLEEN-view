"""
Prüfstein für den Geschossplan.

Zwei Eigenschaften entscheiden über die Brauchbarkeit eines erzeugten Plans:

1. **Determinismus.** Gleiche Rechnung, gleiches SVG — Byte für Byte. Ohne das
   sind zwei Stände nicht vergleichbar: ein `diff` zeigte die Sortierung eines
   Wörterbuchs statt der Änderung, die man sucht.
2. **Vollständigkeit.** Was in die Rechnung eingeht, muss auf dem Blatt stehen.
   Ein Plan, auf dem eine Last fehlt, ist schlimmer als keiner — er sieht aus,
   als wäre er vollständig.

Ausführen:  python3 tests/test_plan_svg.py
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import plan_svg  # noqa: E402

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


def rechteck(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


#: Ein Geschoss, an dem alles vorkommt, was ein Plan zeigen muss: ein
#: Treppenauge, drei Räume mit verschiedenen Nutzlasten, vier Linienlager,
#: eine Stütze, Wandfußkräfte aus dem Geschoss darüber.
def beispiel():
    return {
        "plan": {"job_id": "test", "titel": "Decke über 1.OG",
                 "modell": "Bürohaus", "geschoss": "1.OG",
                 "submodell": "submodell.OG1", "eingabe_hash": "a1b2c3d4e5f60718",
                 "art": "geschoss"},
        "system": [{
            "id": "P1",
            "umriss": rechteck(0, 0, 16, 10),
            "oeffnungen": [rechteck(6.5, 4, 9.5, 6)],
            "dicke_m": 0.22,
            "flaeche_m2": 154.0,
            "bettung_kNm3": None,
            "material": {"name": "C25/30", "E_kNm2": 31e6, "nu": 0.2,
                         "wichte_kNm3": 25.0},
        }],
        "auflager": [
            {"id": "A1", "typ": "linie", "art": "gelenkig", "bauteile": ["W1"],
             "polylinie": [[0, 0], [16, 0]], "_laenge": 16.0},
            {"id": "A2", "typ": "linie", "art": "gelenkig", "bauteile": ["W2"],
             "polylinie": [[16, 0], [16, 10]], "_laenge": 10.0},
            {"id": "A3", "typ": "linie", "art": "gelenkig", "bauteile": ["W3"],
             "polylinie": [[16, 10], [0, 10]], "_laenge": 16.0},
            {"id": "A4", "typ": "linie", "art": "gelenkig", "bauteile": ["W4"],
             "polylinie": [[0, 10], [0, 0]], "_laenge": 10.0},
            {"id": "A5", "typ": "punkt", "art": "gelenkig", "bauteile": ["S1"],
             "p": [8.0, 2.0], "_laenge": 0.0},
        ],
        "lastfaelle": [
            {"id": "AUS", "name": "Ausbaulast", "art": "G", "gamma": 1.35,
             "psi0": 1.0, "psi2": 1.0},
            {"id": "NUTZ", "name": "Nutzlast", "art": "Q", "gamma": 1.5,
             "psi0": 0.7, "psi2": 0.3},
            {"id": "ABG", "name": "Aus dem Geschoss darüber", "art": "G",
             "gamma": 1.35, "psi0": 1.0, "psi2": 1.0},
        ],
        "lasten": [
            # Über die ganze Fläche — kein Ort im Bild.
            {"id": "L1", "typ": "flaeche", "lastfall": "AUS", "wert": 1.5,
             "einheit": "kN/m2", "polygon": rechteck(0, 0, 16, 10),
             "loecher": [rechteck(6.5, 4, 9.5, 6)]},
            {"id": "L2", "typ": "flaeche", "lastfall": "AUS", "wert": 0.8,
             "einheit": "kN/m2", "name": "Trennwandzuschlag",
             "polygon": rechteck(0, 0, 16, 10),
             "loecher": [rechteck(6.5, 4, 9.5, 6)]},
            # Raumweise — die haben einen Ort.
            {"id": "L3", "typ": "flaeche", "lastfall": "NUTZ", "wert": 2.0,
             "einheit": "kN/m2", "name": "Büro Nord", "nutzung": "Büro",
             "kategorie": "B1", "polygon": rechteck(0, 0, 6, 10)},
            {"id": "L4", "typ": "flaeche", "lastfall": "NUTZ", "wert": 5.0,
             "einheit": "kN/m2", "name": "Archiv", "nutzung": "Archiv",
             "kategorie": "E1.1", "polygon": rechteck(10, 0, 16, 10)},
            {"id": "L5", "typ": "flaeche", "lastfall": "NUTZ", "wert": 3.0,
             "einheit": "kN/m2", "name": "Treppenhaus", "nutzung": "Treppenhaus",
             "kategorie": "T1", "polygon": rechteck(6, 0, 10, 10),
             "loecher": [rechteck(6.5, 4, 9.5, 6)]},
        ] + [
            # Wandfußkräfte von oben: je Lastfall eine eigene Last auf
            # derselben Achse — im Bild eine Reihe, in der Legende drei.
            {"id": f"W{i}", "typ": "linie", "lastfall": fall, "wert": wert,
             "einheit": "kN/m", "polylinie": [[0, 0], [16, 0]],
             "bezug": "W1-OG", "herkunft": "Wandfuß Außenwand Süd (2.OG)"}
            for i, (fall, wert) in enumerate(
                [("ABG", 24.5), ("ABG", 5.2), ("NUTZ", 7.5)], start=1)
        ],
        "unterzuege": [],
    }


# ── 1. Determinismus ────────────────────────────────────────────────────────

print("\nGleiche Rechnung, gleiches SVG")

a = plan_svg.plan(beispiel())
b = plan_svg.plan(beispiel())
pruefe(a == b, f"zweimal erzeugt, bitgleich ({len(a)} Zeichen)",
       len(a), len(b))

print("\nEine andere Reihenfolge der Eingabe ändert nichts")
# Der Schnitt gibt Auflager und Lasten in beliebiger Reihenfolge zurück. Ein
# Plan, der darauf reagiert, macht jeden Vergleich zweier Stände wertlos.
m = beispiel()
m["auflager"].reverse()
m["lasten"].reverse()
pruefe(plan_svg.plan(m) == a, "umgekehrte Auflager- und Lastreihenfolge")

print("\nAndere Lagerkennungen ändern nichts")
m = beispiel()
for i, lager in enumerate(m["auflager"]):
    lager["id"] = f"A{50 + i}"
pruefe(plan_svg.plan(m) == a, "A50…A54 statt A1…A5")

print("\nKein Zeitstempel im Blatt")
# Er stünde in jeder Fassung anders und machte den Vergleich unmöglich.
pruefe(not re.search(r"\d{4}-\d{2}-\d{2}", a),
       "kein Datum im SVG",
       re.findall(r"\d{4}-\d{2}-\d{2}", a), "[]")

print("\nEine echte Änderung ändert das Blatt")
m = beispiel()
m["lasten"][3]["wert"] = 7.5
pruefe(plan_svg.plan(m) != a, "eine andere Nutzlast im Archiv")


# ── 2. Vollständigkeit ──────────────────────────────────────────────────────

print("\nWas gerechnet wurde, steht auf dem Blatt")

gleich(a.count("<svg"), 1, "ein SVG-Dokument")
pruefe('viewBox="0 0 420 297"' in a, "A3 quer, maßstäblich")
pruefe("submodell.OG1" in a, "der Submodellname steht im Kopf")
pruefe("a1b2c3d4e5f60718" in a,
       "und der Eingabe-Hash — daran erkennt man später, ob ein "
       "ausgedrucktes Blatt noch gilt")

print("\nDie Lasten")
for wert, was in [("2", "Büro 2,0"), ("5", "Archiv 5,0"), ("3", "Treppenhaus 3,0")]:
    pruefe(f">{wert} kN/m²<" in a, f"{was} kN/m² steht im Bild")
pruefe("Büro Nord" in a and "Archiv" in a and "Treppenhaus" in a,
       "die Raumnamen stehen dabei")
pruefe("Trennwandzuschlag" in a,
       "der Trennwandzuschlag steht in der Legende")
pruefe("Über die ganze Fläche" in a,
       "und ist als flächendeckend ausgewiesen, nicht als Schraffur")
pruefe("2.3 kN/m²" in a,
       "mit der Summe der flächendeckenden Lasten (1,5 + 0,8)")

print("\nDie Linienlasten sind gebündelt")
# Drei Lastfälle auf derselben Wandachse ergeben eine Reihe im Bild, nicht drei
# übereinander — sonst ist keine davon lesbar.
# Eine Beschriftung im Bild, eine Zeile in der Legende — nicht drei Reihen
# übereinander auf derselben Achse, von denen keine lesbar wäre.
gleich(a.count("kN/m<"), 1,
       "eine Beschriftung im Bild für drei Lastfälle — nicht drei Reihen "
       "übereinander, von denen keine lesbar wäre")
pruefe("37.2 kN/m" in a, "und sie trägt die Summe (24,5 + 5,2 + 7,5)")
pruefe("Lastfälle ABG · NUTZ" in a,
       "die Legende nennt die Lastfälle, aus denen die Summe besteht")
pruefe("1 Wandachse(n) mit Last von oben" in a,
       "und zählt Achsen, nicht Lastfälle")

print("\nGeometrie und Symbole")
pruefe("fill-rule=\"evenodd\"" in a,
       "der Umriss trägt seine Öffnung als Loch, nicht als weiße Fläche")
pruefe("Öffnung" in a, "und die Legende nennt sie")
pruefe("Linienlager" in a and "Punktlager" in a,
       "Linien- und Punktlager stehen in der Legende")
pruefe("4 Linienlager" in a, "vier Wände")
pruefe("1 Punktlager" in a, "eine Stütze")

print("\nMaßstab, Legende, Nordpfeil")
# 16 m bei 1:50 sind 320 mm und passen auf die 334 mm Zeichenfläche des A3.
# Der größte passende Maßstab gewinnt: ein Plan soll das Blatt füllen.
pruefe("M 1:50" in a, "Maßstab 1:50 für 16 × 10 m auf A3")
pruefe("Legende" in a, "Legende vorhanden")
pruefe("Systemfläche 154 m²" in a, "mit der Systemfläche")
pruefe("Dicke 22 cm" in a, "und der Deckendicke")
pruefe("C25/30" in a, "und der Betongüte")
pruefe(">N<" in a, "Nordpfeil")

print("\nDie Bettung steht drauf, wenn es eine gibt")
m = beispiel()
m["system"][0]["bettung_kNm3"] = 20000.0
pruefe("Winkler" in plan_svg.plan(m), "Bettung in der Legende")
pruefe("Winkler" not in a, "und nicht, wenn keine da ist")


# ── 3. Maßstab und Blattwahl ────────────────────────────────────────────────

print("\nDer Maßstab füllt das Blatt")

gleich(plan_svg.massstab_waehlen(16, 10, (346, 271)), 50,
       "16 × 10 m auf A3-Zeichenfläche → 1:50")
gleich(plan_svg.massstab_waehlen(80, 40, (346, 271)), 250,
       "80 × 40 m → 1:250")
gleich(plan_svg.massstab_waehlen(4, 3, (346, 271)), 20,
       "4 × 3 m → 1:20, nicht 1:500")

print("\nAndere Blattformate")
for format in ("A4", "A3", "A2", "A1", "A0"):
    svg = plan_svg.plan(beispiel(), format=format)
    breite = plan_svg.FORMATE[format][0]
    pruefe(f'viewBox="0 0 {plan_svg._z(breite)}' in svg,
           f"{format} quer, {breite:.0f} mm breit")


# ── 4. Fremder Text kommt aus dem IFC ───────────────────────────────────────

print("\nBauteilnamen werden maskiert")
m = beispiel()
m["lasten"][2]["name"] = 'Büro <script>alert("x")</script>'
svg = plan_svg.plan(m)
pruefe("<script>" not in svg,
       "ein Raumname aus dem IFC kann kein Markup einschleusen")
pruefe("&lt;script&gt;" in svg, "er steht als Text da")


print("\nOhne Systemumriss kein Plan")
m = beispiel()
m["system"][0]["umriss"] = []
try:
    plan_svg.plan(m)
    pruefe(False, "ein Modell ohne Systemfläche wird abgewiesen")
except ValueError as fehler:
    pruefe("Systemumriss" in str(fehler),
           f"ein Modell ohne Systemfläche wird abgewiesen: {fehler}")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
