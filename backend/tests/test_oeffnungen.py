"""
Prüfstein für Deckenöffnungen — Treppenauge, Schächte, Aussparungen.

Eine Öffnung ist ein **echtes Loch im Netz**, keine abgeminderte Steifigkeit.
Der Unterschied ist nicht akademisch: eine Decke mit einem Treppenauge spannt
dort nicht, ein Ersatzmodell mit weichem Material spannt doch — nur schlechter,
und die Momente daneben stimmen dann nicht.

Bis September 2026 nahm `statikmodell()` nur `rings[0]` und warf die inneren
Ringe weg. Die Decke wurde über dem Treppenauge durchgerechnet, als läge dort
Beton: zu viel Fläche, zu viel Eigengewicht, zu kleine Momente an den Rändern
der Öffnung.

Geprüft wird ohne Solver — nur Geometrie und Netz. Was hier schiefgeht, geht
in jeder Rechnung schief, die darauf aufbaut.

Ausführen:  python3 tests/test_oeffnungen.py
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import plate  # noqa: E402
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


def nah(a, b, tol=1e-6):
    return abs(a - b) <= tol


def rechteck(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def modell_mit(oeffnungen, groesse=0.25):
    """Eine 12 × 8-m-Decke, 20 cm dick, mit den angegebenen Öffnungen."""
    return plate.Modell({
        "schema": "ileen.plan.fem/1.0",
        "plan": {"geschoss": "EG"},
        "netz": {"elementgroesse_m": groesse, "lagen_ueber_dicke": 2},
        "system": [{
            "id": "P1",
            "umriss": rechteck(0, 0, 12, 8),
            "oeffnungen": oeffnungen,
            "dicke_m": 0.20,
            "material": {"name": "C25/30", "E_kNm2": 31e6, "nu": 0.2,
                         "wichte_kNm3": 25.0},
        }],
        "auflager": [
            {"id": "A1", "typ": "linie", "art": "gelenkig", "bauteile": ["W1"],
             "polylinie": [[0, 0], [12, 0]]},
            {"id": "A2", "typ": "linie", "art": "gelenkig", "bauteile": ["W2"],
             "polylinie": [[0, 8], [12, 8]]},
        ],
        "lastfaelle": [{"id": "AUS", "name": "Ausbau", "art": "G",
                        "gamma": 1.35, "psi0": 1.0, "psi2": 1.0}],
        "lasten": [],
    })


# ── 1. Das Loch ist im Netz ─────────────────────────────────────────────────

print("\nDas Treppenauge ist ein Loch im Netz")

ohne = plate.vernetze(modell_mit([]))
# Ein Treppenauge von 4 × 2 m — die Größe eines zweiläufigen Treppenhauses.
auge = rechteck(4, 3, 8, 5)
mit = plate.vernetze(modell_mit([auge]))

pruefe(mit.n_elemente < ohne.n_elemente,
       f"weniger Elemente mit Öffnung ({mit.n_elemente} statt {ohne.n_elemente})",
       mit.n_elemente, f"< {ohne.n_elemente}")

# 4 × 2 = 8 m² von 96 m². Bei 0,25 m Netzweite und zwei Lagen sind das
# 8 / 0,0625 × 2 = 256 Elemente.
fehlend = ohne.n_elemente - mit.n_elemente
pruefe(fehlend == 256,
       f"genau die Elemente der Öffnung fehlen ({fehlend})", fehlend, 256)

# Und kein Knoten sitzt mehr mitten im Auge. Der Rand gehört noch dazu.
innere = np.array([[5.0, 3.5], [6.0, 4.0], [7.0, 4.5]])
pruefe(not mit.auf_platte(innere).any(),
       "kein Punkt im Treppenauge zählt als Deckenfläche",
       mit.auf_platte(innere).tolist(), "alle False")

daneben = np.array([[2.0, 4.0], [10.0, 4.0], [6.0, 1.0], [6.0, 7.0]])
pruefe(mit.auf_platte(daneben).all(),
       "die Fläche daneben zählt weiterhin",
       mit.auf_platte(daneben).tolist(), "alle True")


# ── 2. Mehrere Öffnungen ────────────────────────────────────────────────────

print("\nMehrere Öffnungen: Treppenauge und zwei Schächte")

schacht_a = rechteck(1, 1, 1.8, 1.8)      # 0,64 m²
schacht_b = rechteck(10.2, 6.2, 11, 7)    # 0,64 m²
viele = plate.vernetze(modell_mit([auge, schacht_a, schacht_b]))

pruefe(len(viele.loecher) == 3, "alle drei Öffnungen stehen im Netz",
       len(viele.loecher), 3)
# 8 + 0,64 + 0,64 = 9,28 m². Gemessen wird die Fläche, nicht die Zahl der
# Elemente: seit die Öffnungskanten Rasterlinien sind (`plate._rasterlinien()`),
# teilen die Schachtkanten bei 1,8 und 10,2 m das Raster neu, und das Netz hat
# mehr Elemente — aber das Loch hat genau seine Fläche.
def grundflaeche(netz):
    mitten = netz.points[netz.cells].mean(axis=1)
    oben = mitten[:, 2] >= plate.oberste_lage_z(netz) - 1e-9
    return float(plate.zellflaechen(netz)[oben].sum())


fehlend_m2 = grundflaeche(ohne) - grundflaeche(viele)
pruefe(abs(fehlend_m2 - 9.28) < 1e-6,
       f"die Netzfläche fehlt genau um die Öffnungen ({fehlend_m2:.4f} m² für "
       f"9,28 m²)", fehlend_m2, 9.28)

pruefe(not viele.auf_platte(np.array([[1.4, 1.4], [10.6, 6.6]])).any(),
       "auch die kleinen Schächte sind Löcher")


# ── 3. Lasten fallen nicht ins Loch ─────────────────────────────────────────

print("\nEine Linienlast über dem Treppenauge gibt dort nichts ab")

# Eine Wand, die quer über die Decke läuft — mitten durch das Auge.
laenge_ohne = plate._wirksame_laenge(
    np.array([[0.0, 4.0], [12.0, 4.0]]), ohne, ohne.groesse)
laenge_mit = plate._wirksame_laenge(
    np.array([[0.0, 4.0], [12.0, 4.0]]), mit, mit.groesse)

pruefe(nah(laenge_ohne, 12.0, 0.05),
       f"ohne Öffnung trägt die ganze Länge ({laenge_ohne:.2f} m)",
       round(laenge_ohne, 2), 12.0)
pruefe(nah(laenge_mit, 8.0, 0.05),
       f"mit Öffnung nur 8,00 m — die 4 m über dem Auge fallen weg "
       f"({laenge_mit:.2f} m)", round(laenge_mit, 2), 8.0)


# ── 4. Die Öffnungen kommen aus dem IFC-Schnitt ─────────────────────────────

print("\nDie inneren Ringe des Schnitts werden zu Öffnungen")

# So kommt eine geschnittene Decke mit Treppenauge zurück: Außenring plus
# Innenring. Welcher ein Loch ist, entscheidet die Verschachtelungstiefe.
gruppen = tm.ringgruppen([rechteck(0, 0, 12, 8), auge])
pruefe(len(gruppen) == 1, "eine Fläche", len(gruppen), 1)
pruefe(gruppen[0]["loecher"] == 1, "mit einem Loch", gruppen[0]["loecher"], 1)
pruefe(nah(gruppen[0]["flaeche_m2"], 96.0 - 8.0, 1e-6),
       "die Fläche ist um die Öffnung vermindert (88,00 m²)",
       gruppen[0]["flaeche_m2"], 88.0)
pruefe(len(gruppen[0]["ringe"]) == 2,
       "Außenring und Lochring wandern beide mit", len(gruppen[0]["ringe"]), 2)

print("\nEin Loch im Loch ist wieder Decke")
# Ein Schacht mit Innenschale: vier ineinanderliegende Ringe. Die Tiefe
# entscheidet — sonst zählte der innerste Ring als zweite Öffnung, und die
# Fläche käme doppelt abgezogen heraus.
verschachtelt = tm.ringgruppen([
    rechteck(0, 0, 12, 8),        # Tiefe 0 — die Decke
    rechteck(4, 3, 8, 5),         # Tiefe 1 — das Auge
    rechteck(4.5, 3.5, 7.5, 4.5),  # Tiefe 2 — eine Insel darin
])
flaechen = [round(g["flaeche_m2"], 3) for g in verschachtelt]
pruefe(len(verschachtelt) == 2,
       "zwei Flächen: die Decke und die Insel im Auge", len(verschachtelt), 2)
pruefe(nah(verschachtelt[0]["flaeche_m2"], 88.0, 1e-6),
       f"die Decke bleibt bei 88,00 m² — die Insel wird nicht doppelt "
       f"abgezogen", flaechen, [88.0, 3.0])


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
