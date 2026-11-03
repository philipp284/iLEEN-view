"""
Prüfstein für die raumweisen Nutzlasten und den Trennwandzuschlag.

Bis September 2026 bekam jedes Geschoss **eine** Nutzlast, gleichmäßig über die
ganze Decke. Ein Geschoss mit Büro (2,0 kN/m²), Archiv (5,0) und Treppenhaus
(3,0) hat drei, und die Stelle mit dem Archiv ist genau die Stelle, an der die
Decke bemessen wird.

Zwei Dinge entscheiden über die Richtigkeit, und beide werden hier geprüft:

1. **Die Deutung.** „Aktenlager" ist ein Archiv (5,0), kein Abstellraum (2,0) —
   ein Faktor zweieinhalb, der an der Reihenfolge der Schlüsselwörter hängt.
2. **Die Bilanz.** Die Summe der Teilflächen muss die Systemfläche sein. Fehlt
   eine Fläche, fehlt ihre Last — und zwar unsichtbar: die Rechnung läuft
   durch, und die Gleichgewichtsprobe stimmt, weil sie prüft, ob die
   Auflagerkräfte zur *angesetzten* Last passen.

Ausführen:  python3 tests/test_raumlasten.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import raumlasten as rl  # noqa: E402
from ileen import tragwerksmodell as tm  # noqa: E402

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


# ── 1. Nutzung → Kategorie ──────────────────────────────────────────────────

print("\nRaumnutzung wird zur Nutzlastkategorie")

for nutzung, kategorie, q in [
    ("Büro", "B1", 2.0),
    ("Büro 2.14", "B1", 2.0),
    ("Großraumbüro", "B1", 2.0),
    ("Wohnzimmer", "A2", 1.5),
    ("Schlafen", "A2", 1.5),
    ("Bad", "A2", 1.5),
    ("Treppenhaus", "T1", 3.0),
    ("Archiv", "E1.1", 5.0),
    ("Abstellraum", "A3", 2.0),
    ("Tiefgarage", "F", 2.5),
    ("Hörsaal", "C2", 4.0),
    ("Klassenraum", "C1", 3.0),
    ("Balkon", "Z", 4.0),
    ("Verkaufsfläche", "D1", 5.0),
]:
    erkannt = rl.kategorie_von(nutzung)
    wert = rl.nutzlast(erkannt)[0]
    pruefe(erkannt == kategorie and wert == q,
           f"{nutzung!r} → {kategorie} = {q} kN/m²", (erkannt, wert), (kategorie, q))

print("\nDie Fälle, in denen die Reihenfolge entscheidet")
# „Aktenlager" enthält „lager" (A3, 2,0) und ist doch ein Archiv (E1.1, 5,0).
# Stünde A3 vor E1.1, käme die Decke um den Faktor zweieinhalb zu leicht heraus.
gleich(rl.kategorie_von("Aktenlager"), "E1.1", "Aktenlager ist ein Archiv")
gleich(rl.kategorie_von("Lagerraum"), "A3", "ein bloßer Lagerraum bleibt A3")
# „Treppenhaus" enthält „haus"; „Serverraum" ist Technik und nicht Wohnen.
gleich(rl.kategorie_von("Treppenhaus"), "T1", "Treppenhaus ist T1")
gleich(rl.kategorie_von("Serverraum"), "B2", "Serverraum ist B2")

print("\nDer LongName gewinnt, die Nummer hilft aus")
gleich(rl.kategorie_von("Büro", "1.OG.04"), "B1", "LongName trägt die Nutzung")
gleich(rl.kategorie_von(None, "04 Archiv"), "E1.1",
       "ohne LongName wird der Name gelesen")
gleich(rl.kategorie_von(None, "1.OG.04"), None,
       "eine reine Raumnummer ergibt nichts — und wird nicht geraten")


# ── 2. Die Zuordnung je Raum ────────────────────────────────────────────────

print("\nZuordnung mit Herkunft")

raeume = [
    {"global_id": "R1", "name": "01", "long_name": "Büro",
     "grundriss": [rechteck(0, 0, 5, 4)]},
    {"global_id": "R2", "name": "02", "long_name": "Archiv",
     "grundriss": [rechteck(5, 0, 8, 4)]},
    {"global_id": "R3", "name": "03", "long_name": "Zwischenzone",
     "grundriss": [rechteck(8, 0, 10, 4)]},
]
zuordnung = rl.raumlasten(raeume, vorgabe="A2")
gleich([z["kategorie"] for z in zuordnung], ["B1", "E1.1", "A2"],
       "drei Räume, drei Kategorien")
gleich(zuordnung[2]["herkunft"], "Vorgabe — keine Nutzung im Modell erkennbar",
       "und der unerkannte sagt, dass er die Vorgabe hat")

print("\nDie Zuordnung lässt sich überschreiben")
# „Lager" kann ein Abstellraum (1,5) oder ein Lagerraum mit Regalen (7,5)
# sein — ein Faktor fünf. Das entscheidet ein Mensch, nicht ein Namensvergleich.
geaendert = rl.raumlasten(raeume, vorgabe="A2", ueberschrieben={"R1": "E2.1"})
gleich(geaendert[0]["q_k_kNm2"], 7.5, "der gesetzte Wert sticht die Deutung")
gleich(geaendert[0]["herkunft"], "von Hand gesetzt (Eingriff am System)", "und sagt es")

print("\nEine unbekannte Kategorie verhindert keinen Lauf")
kaputt = rl.raumlasten(raeume, vorgabe="A2", ueberschrieben={"R1": "GIBTSNICHT"})
gleich(kaputt[0]["kategorie"], "A2",
       "ein Tippfehler fällt auf die Vorgabe zurück statt abzubrechen")


# ── 3. Die Bilanz: alle Teilflächen ergeben die Systemfläche ────────────────

print("\nDie Summe der Lastflächen ist die Systemfläche")

umriss = rechteck(0, 0, 10, 4)          # 40 m²
flaechen, protokoll = tm._nutzlastflaechen(
    raeume, umriss, [], "A2", 1.5, {})


def polygonflaeche(punkte):
    n = len(punkte)
    return abs(sum(punkte[i][0] * punkte[(i + 1) % n][1]
                   - punkte[(i + 1) % n][0] * punkte[i][1]
                   for i in range(n))) / 2.0


summe = sum(polygonflaeche(f["polygon"]) for f in flaechen)
pruefe(abs(summe - 40.0) < 0.01,
       f"drei Räume decken die 40 m² vollständig ab ({summe:.2f} m²)",
       round(summe, 2), 40.0)

# Die Last, die tatsächlich ankommt: Σ q · A. Von Hand: 20·2,0 + 12·5,0 + 8·1,5
von_hand = 5 * 4 * 2.0 + 3 * 4 * 5.0 + 2 * 4 * 1.5
gerechnet = sum(f["q_k_kNm2"] * polygonflaeche(f["polygon"]) for f in flaechen)
pruefe(abs(gerechnet - von_hand) < 0.1,
       f"und tragen zusammen {von_hand:.0f} kN Nutzlast "
       f"(gerechnet {gerechnet:.1f})", round(gerechnet, 1), von_hand)

# Pauschal mit A2 wären es 40 · 1,5 = 60 kN. Der Unterschied ist der Punkt.
pruefe(abs(gerechnet - 40 * 1.5) > 40.0,
       f"pauschal wären es 60 kN — das Archiv macht {gerechnet - 60:.0f} kN aus",
       round(gerechnet, 1), "deutlich mehr als 60")

print("\nWas kein Raum abdeckt, bekommt die Vorgabe")
# Nur ein Raum auf einer großen Decke: der Rest darf nicht lastfrei bleiben.
teil, prot = tm._nutzlastflaechen(
    [raeume[1]], rechteck(0, 0, 10, 4), [], "A2", 1.5, {})
summe = sum(polygonflaeche(f["polygon"]) for f in teil)
pruefe(abs(summe - 40.0) < 0.01,
       f"ein Raum von 12 m² auf 40 m² — die Restfläche schließt die Lücke "
       f"({summe:.2f} m²)", round(summe, 2), 40.0)
# Sie zerfällt dabei in zwei Stücke — links und rechts des Archivs. Das ist
# richtig so: eine Lastfläche muss zusammenhängend sein, sonst kann sie kein
# Polygon sein.
rest = [f for f in teil if f["name"] == "Restfläche"]
rest_flaeche = sum(polygonflaeche(f["polygon"]) for f in rest)
pruefe(len(rest) == 2 and abs(rest_flaeche - 28.0) < 0.01,
       f"die Restfläche zerfällt in zwei Stücke von zusammen 28 m² "
       f"({rest_flaeche:.2f} m²)", (len(rest), round(rest_flaeche, 2)), (2, 28.0))

print("\nÖffnungen tragen keine Nutzlast")
mit_loch, prot_loch = tm._nutzlastflaechen(
    [], rechteck(0, 0, 10, 4), [rechteck(4, 1, 6, 3)], "A2", 1.5, {})
# Die Lastfläche trägt das Loch als inneren Ring. Für die **Rechnung** genügte
# schon der Außenring — über einer Öffnung hat das Netz keine Elemente, und
# eine Flächenlast trifft dort nichts. Für den **Plan** genügt er nicht: dort
# läge sonst eine Nutzlastschraffur über dem Treppenauge.
netto = sum(polygonflaeche(f["polygon"])
            - sum(polygonflaeche(l) for l in (f.get("loecher") or []))
            for f in mit_loch)
pruefe(abs(netto - 36.0) < 0.01,
       f"ein Treppenauge von 4 m² fehlt in der Lastfläche ({netto:.2f} m²)",
       round(netto, 2), 36.0)
pruefe(any(f.get("loecher") for f in mit_loch),
       "und es steht als Loch an der Lastfläche, nicht nur in der Bilanz")
pruefe(abs(prot_loch[0]["flaeche_m2"] - 36.0) < 0.01,
       f"das Protokoll weist 36 m² aus ({prot_loch[0]['flaeche_m2']} m²)",
       prot_loch[0]["flaeche_m2"], 36.0)

print("\nÜberlappende Räume tragen die Last nur einmal")
# Zwei Räume, die sich um 2 × 4 m überschneiden — grob abgegrenzte Modelle
# liefern das. Aufeinandergelegt käme dort die Nutzlast doppelt an.
ueberlappt = [
    {"global_id": "R1", "name": "01", "long_name": "Büro",
     "grundriss": [rechteck(0, 0, 6, 4)]},
    {"global_id": "R2", "name": "02", "long_name": "Archiv",
     "grundriss": [rechteck(4, 0, 10, 4)]},
]
felder, _ = tm._nutzlastflaechen(ueberlappt, umriss, [], "A2", 1.5, {})
summe = sum(polygonflaeche(f["polygon"]) for f in felder)
pruefe(abs(summe - 40.0) < 0.01,
       f"die Summe bleibt 40 m², nicht 48 ({summe:.2f} m²)",
       round(summe, 2), 40.0)


# ── 4. Trennwandzuschlag ────────────────────────────────────────────────────

print("\nTrennwandzuschlag nach DIN EN 1991-1-1/NA 6.3.1.2 (8)")

leer = rl.trennwandzuschlag([], 100.0)
gleich(leer["q_kNm2"], 0.0, "ohne nichttragende Wände kein Zuschlag")

# Eine leichte Gipskartonwand: 10 m lang, 2,75 m hoch, 12,5 cm dick.
# 0,125 · 2,75 · 9 = 3,09 kN/m Wandlast → über der Stufentabelle? Nein:
# 3,09 > 3,0, also knapp darüber. Mit 10 cm Dicke: 2,48 kN/m → Stufe 1,2.
leicht = rl.trennwandzuschlag(
    [{"laenge_m": 10.0, "hoehe_m": 2.75, "dicke_gesamt_m": 0.10,
      "materialklasse": "leichtbau"}], 100.0)
pruefe(leicht["stufe"] == 1.2,
       f"2,48 kN/m Wandlast → Stufe 1,2 kN/m² "
       f"({leicht['wandlast_kN_je_m']} kN/m)", leicht["stufe"], 1.2)
gleich(leicht["waende"], 1, "eine Wand gezählt")

print("\nÜber 3,0 kN/m verlangt die Norm eine Einzellast — das sagt der Hinweis")
schwer = rl.trennwandzuschlag(
    [{"laenge_m": 10.0, "hoehe_m": 3.0, "dicke_gesamt_m": 0.24,
      "materialklasse": "mauerwerk"}], 100.0)
pruefe(schwer["stufe"] is None,
       f"10,08 kN/m liegt über der Tabelle ({schwer['wandlast_kN_je_m']} kN/m)",
       schwer["stufe"], None)
pruefe("Einzellast" in schwer["hinweis"],
       "und der Hinweis sagt, dass ein Mensch entscheiden muss")
pruefe(schwer["q_kNm2"] > 0.0,
       f"angesetzt wird trotzdem etwas ({schwer['q_kNm2']} kN/m²) — "
       f"eine Wand, die weder trägt noch wiegt, gibt es nicht")

print("\nViele Wände auf wenig Fläche: der gerechnete Wert gilt")
# Zehn leichte Wände auf 50 m². Die Stufe wäre 1,2; gerechnet sind es mehr,
# und die Stufe ersetzt die Abschätzung der Wandlast, nicht die Bilanz.
viele = rl.trennwandzuschlag(
    [{"laenge_m": 10.0, "hoehe_m": 2.75, "dicke_gesamt_m": 0.10,
      "materialklasse": "leichtbau"}] * 10, 50.0)
pruefe(viele["q_kNm2"] > 1.2,
       f"gerechnet {viele['q_kNm2']} kN/m² > Stufe 1,2 — der größere gilt",
       viele["q_kNm2"], "> 1,2")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
