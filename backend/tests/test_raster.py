"""
Prüfstein für das Raster des Plattennetzes — Lagerachsen, Lagerknoten, Drehung.

Ein Lager fing früher alle Knoten im Suchradius 0,6 Δ: je nach Lage der
Wandachse zwischen zwei Knotenreihen eine Reihe oder zwei. Zwei Reihen halten
die Decke wie eine Teileinspannung, und das Ergebnis hing an der Netzweite
(Flachdach H1: Δ 0,10 → 94 % der Navier-Durchbiegung, Δ 0,08 → 35 %). Seit
Oktober 2026 liegen Rasterlinien auf den Lagerachsen (`plate._rasterlinien`),
jedes Lager hält je Spalte genau eine Reihe (`plate.lagerknoten`), und das
Raster dreht mit dem Gebäude (`plate.hauptrichtung`).

Ohne Solver — nur Geometrie und Netz.

Ausführen:  python3 tests/test_raster.py
"""

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import plate  # noqa: E402

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


def drehen(punkte, grad):
    w = math.radians(grad)
    c, s = math.cos(w), math.sin(w)
    return [[c * x - s * y, s * x + c * y] for x, y in punkte]


def modell(grad=0.0, oeffnungen=(), unterzug=None):
    """10 × 8 m, 20 cm, vier Wandachsen 0,12 m innen (KS 24), gedreht um `grad`."""
    umriss = [[-5, -4], [5, -4], [5, 4], [-5, 4]]
    lager = [
        ("A1", [[-5, -3.88], [5, -3.88]]), ("A2", [[-5, 3.88], [5, 3.88]]),
        ("A3", [[-4.88, -3.76], [-4.88, 3.76]]), ("A4", [[4.88, -3.76], [4.88, 3.76]]),
    ]
    daten = {
        "schema": "ileen.plan.fem/1.0", "plan": {"geschoss": "EG"},
        "system": [{"id": "P1", "umriss": drehen(umriss, grad),
                    "oeffnungen": [drehen(o, grad) for o in oeffnungen],
                    "dicke_m": 0.20,
                    "material": {"name": "C25/30", "E_kNm2": 31e6, "nu": 0.2,
                                 "wichte_kNm3": 25.0}}],
        "auflager": [{"id": i, "typ": "linie", "art": "gelenkig", "bauteile": [i],
                      "polylinie": drehen(z, grad), "breite_m": 0.24} for i, z in lager],
        "lastfaelle": [], "lasten": [],
    }
    if unterzug:
        daten["unterzuege"] = [{"id": "U1", "polylinie": drehen(unterzug, grad),
                                "breite_m": 0.30, "hoehe_m": 0.50, "richtung": "unten"}]
    return plate.Modell(daten)


def grundflaeche(netz):
    mitten = netz.points[netz.cells].mean(axis=1)
    oben = mitten[:, 2] >= plate.oberste_lage_z(netz) - 1e-9
    return float(plate.zellflaechen(netz)[oben].sum())


# ── 1. Rasterlinien auf den Lagerachsen ────────────────────────────────────

print("\nRasterlinien auf Lagerachsen, Rändern, Öffnungen, Unterzugflanken")
for groesse in (0.5, 0.25, 0.08):
    netz = plate.vernetze(modell(oeffnungen=[[[0, 0], [1.3, 0], [1.3, 1.1], [0, 1.1]]],
                                 unterzug=[[-5, -1.0], [5, -1.0]]), groesse=groesse)
    xs = np.unique(np.round(netz.points[:, 0], 6))
    ys = np.unique(np.round(netz.points[:, 1], 6))
    noetig_x = [-5, -4.88, 0, 1.3, 4.88, 5]
    noetig_y = [-4, -3.88, -1.15, -0.85, 0, 1.1, 3.88, 4]
    pruefe(all(np.min(np.abs(xs - v)) < 1e-6 for v in noetig_x)
           and all(np.min(np.abs(ys - v)) < 1e-6 for v in noetig_y),
           f"Δ {groesse}: Linien auf Achsen, Rändern, Öffnung, Stegflanken",
           (sorted(set(np.round(xs, 3)) & set(noetig_x)), sorted(set(np.round(ys, 3)) & set(noetig_y))))
    pruefe(max(np.diff(xs).max(), np.diff(ys).max()) <= groesse * 1.05 + 1e-9,
           f"Δ {groesse}: keine Zelle breiter als die Netzweite (+5 %)",
           float(max(np.diff(xs).max(), np.diff(ys).max())))
    pruefe(abs(grundflaeche(netz) - (80.0 - 1.43)) < 1e-6,
           f"Δ {groesse}: Netzfläche exakt (80 − 1,43 m²)", grundflaeche(netz))

# ── 2. Eine Knotenreihe je Lager ───────────────────────────────────────────

print("\nJedes Lager hält genau eine Knotenreihe, auf seiner Achse")
for groesse in (0.5, 0.25, 0.1, 0.08):
    m = modell()
    netz = plate.vernetze(m, groesse=groesse)
    unten = plate.unterseiten_knoten(netz)
    for lager in m.auflager:
        maske = plate.lagerknoten(netz, lager) & unten
        quer = 1 if lager["id"] in ("A1", "A2") else 0
        lagen = np.unique(np.round(netz.points[maske, quer], 6))
        soll = lager["polylinie"][0][quer]
        if not pruefe(len(lagen) == 1 and abs(lagen[0] - soll) < 1e-6,
                      f"Δ {groesse}: {lager['id']} eine Reihe bei {soll}", lagen.tolist(), [soll]):
            break

print("\nDie tragende Breite fängt eine Platte, die an der Wandinnenseite endet")
m2 = modell()
m2.daten["system"][0]["umriss"] = [[-4.70, -4], [5, -4], [5, 4], [-4.70, 4]]
netz2 = plate.vernetze(m2, groesse=0.25)
a3b = next(a for a in m2.auflager if a["id"] == "A3")
pruefe(not plate.lagerknoten(netz2, {**a3b, "breite_m": 0.0}).any(),
       "ohne Breite: Achse 18 cm neben dem Rand (> 0,6 Δ), nichts gefangen")
gefangen = plate.lagerknoten(netz2, {**a3b, "breite_m": 0.40})
pruefe(gefangen.any() and np.allclose(netz2.points[gefangen, 0], -4.70),
       "mit 40 cm Wand: die Randreihe 18 cm neben der Achse trägt",
       np.unique(np.round(netz2.points[gefangen, 0], 3)).tolist(), [-4.7])

# ── 3. Das Raster dreht mit dem Gebäude ────────────────────────────────────

print("\nDas Raster dreht mit dem Gebäude")
for grad in (0.0, 33.0, -17.0, 90.0):
    m = modell(grad)
    erwartet = ((grad + 45) % 90) - 45
    pruefe(abs(math.degrees(plate.hauptrichtung(m, plate._ring(m.platte()["umriss"])))
               - erwartet) < 1e-6,
           f"{grad:+.0f}°: Hauptrichtung {erwartet:+.0f}°")
gerade = plate.vernetze(modell(0.0), groesse=0.25)
gedreht = plate.vernetze(modell(33.0), groesse=0.25)
pruefe(gerade.n_elemente == gedreht.n_elemente and gerade.n_knoten == gedreht.n_knoten,
       "gedreht: dieselbe Zahl Elemente und Knoten", (gedreht.n_elemente, gerade.n_elemente))
pruefe(abs(grundflaeche(gedreht) - 80.0) < 1e-6, "gedreht: Fläche exakt 80 m²",
       grundflaeche(gedreht))
zurueck = np.asarray(drehen(gedreht.points[:, :2].tolist(), -33.0))
pruefe(np.allclose(np.sort(np.round(zurueck, 6), axis=0), np.sort(np.round(gerade.points[:, :2], 6), axis=0),
                   atol=1e-6),
       "gedreht: die Knoten sind die geraden, gedreht")
m33 = modell(33.0)
unten = plate.unterseiten_knoten(gedreht)
zahl = [int((plate.lagerknoten(gedreht, a) & unten).sum()) for a in m33.auflager]
zahl0 = [int((plate.lagerknoten(gerade, a) & plate.unterseiten_knoten(gerade)).sum())
         for a in modell().auflager]
pruefe(zahl == zahl0, "gedreht: jedes Lager hält dieselben Knoten", zahl, zahl0)

# ── 4. Momente in Gebäudeachsen ────────────────────────────────────────────

print("\nDrehung der Momente in die Achsen des Rasters")
a, b, c = plate.ins_raster(np.array([1.0]), np.array([2.0]), np.array([0.5]), math.pi / 2)
pruefe(np.allclose([a[0], b[0], c[0]], [2.0, 1.0, -0.5]), "90°: m_x und m_y tauschen",
       [a[0], b[0], c[0]])
mx, my, mxy = np.array([3.0]), np.array([-1.0]), np.array([0.7])
a, b, c = plate.ins_raster(mx, my, mxy, math.radians(33))
pruefe(abs((a + b)[0] - 2.0) < 1e-12 and abs((a * b - c * c)[0] - (mx * my - mxy * mxy)[0]) < 1e-12,
       "Spur und Determinante bleiben")
a1, b1 = plate.rasterlinie(gedreht, [0.0, 0.0], 0)
pruefe(abs(math.degrees(math.atan2(b1[1] - a1[1], b1[0] - a1[0])) - 33.0) < 1e-6,
       "Schnittlinie läuft unter 33°", (a1, b1))

# ── 5. Bilder aus ungleichem Raster ────────────────────────────────────────

print("\nRasterbild aus ungleich breiten Zellen")
netz = plate.vernetze(modell(), groesse=0.25)
mitten = netz.points[netz.cells].mean(axis=1)
oben = mitten[:, 2] >= plate.oberste_lage_z(netz) - 1e-9
X, Y, Z = plate.auf_raster(mitten[oben, :2], mitten[oben, 0], polygon=netz.polygon)
innen_ = np.isfinite(Z)
pruefe(innen_.mean() > 0.95, "keine Lücken im Bild der Platte", float(innen_.mean()))
pruefe(np.nanmax(np.abs(Z - X)) <= 0.25, "jeder Bildpunkt trägt den Wert der nächsten Zelle",
       float(np.nanmax(np.abs(Z - X))))

# ── 6. Das Netz trägt die Last der Figur, nicht die seiner Zellen ──────────

print("\nRunder Rand: Eigengewicht und Flächenlast wie die Figur (Lucy, 2026-10-26)")


def summen(m, netz):
    felder = plate.einzelfelder(m, netz)
    zelle = plate.zellvolumen(netz)
    return {k: -float((f[:, 2] * zelle).sum()) for k, f in felder.items()}


kreis = [[3.0 * math.cos(t), 3.0 * math.sin(t)]
         for t in np.linspace(0.0, 2.0 * math.pi, 48, endpoint=False)]
flaeche_kreis = 0.5 * abs(sum(a[0] * b[1] - b[0] * a[1]
                              for a, b in zip(kreis, kreis[1:] + kreis[:1])))
halb = [p for p in kreis if p[1] >= -1e-9] + [[-3.0, 0.0]]
flaeche_halb = 0.5 * abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(halb, halb[1:] + halb[:1])))
daten = {
    "schema": "ileen.plan.fem/1.0", "plan": {"geschoss": "EG"},
    "system": [{"id": "P1", "umriss": kreis, "oeffnungen": [], "dicke_m": 0.20,
                "material": {"name": "C25/30", "E_kNm2": 31e6, "nu": 0.2, "wichte_kNm3": 25.0}}],
    "auflager": [{"id": "A1", "typ": "linie", "art": "gelenkig", "bauteile": ["A1"],
                  "polylinie": kreis + kreis[:1], "breite_m": 0.24}],
    "lastfaelle": [{"id": "AUS", "art": "G"}],
    "lasten": [{"id": "L1", "typ": "flaeche", "lastfall": "AUS", "wert": 2.0,
                "polygon": halb, "flaeche_m2": flaeche_halb}],
}
m = plate.Modell(daten)
for weite in (0.5, 0.25):
    netz = plate.vernetze(m, groesse=weite)
    s = summen(m, netz)
    pruefe(abs(s["EG"] - flaeche_kreis * 0.20 * 25.0) < 1e-6,
           f"Δ {weite}: Eigengewicht = Kreisfläche · d · γ ({grundflaeche(netz):.3f} m² Zellen "
           f"für {flaeche_kreis:.3f} m² Figur)", s["EG"], flaeche_kreis * 5.0)
    pruefe(abs(s["AUS"] - flaeche_halb * 2.0) < 1e-6,
           f"Δ {weite}: Flächenlast über die halbe Platte = Halbkreis · q", s["AUS"],
           flaeche_halb * 2.0)
daten["lasten"][0]["polygon"] = [[0.0, 0.0], [0.05, 0.0], [0.05, 0.05], [0.0, 0.05]]
daten["lasten"][0]["flaeche_m2"] = 0.0025
s = summen(plate.Modell(daten), plate.vernetze(plate.Modell(daten), groesse=0.5))
pruefe(abs(s["AUS"] - 0.005) < 1e-9, "eine Lastfläche kleiner als eine Zelle geht nicht verloren",
       s["AUS"], 0.005)

print("\nErsatzplatte ohne Gewicht, Holzunterzug darunter: der Steg wiegt trotzdem")
m = modell(unterzug=[[-4.88, 0.0], [4.88, 0.0]])
m.platte()["material"]["wichte_kNm3"] = 0.0
m.balken[0]["wichte_kNm3"] = 5.0
netz = plate.vernetze(m, groesse=0.25)
s = summen(m, netz)
soll = 0.30 * (0.50 - 0.20) * 9.76 * 5.0
pruefe(abs(s["EG"] - soll) < 1e-6, "Stegeigengewicht b · (h − d) · L · γ des Balkens",
       s["EG"], soll)

print("\nAlle Prüfungen bestanden." if _gut else "\nEs gab Fehler.")
sys.exit(0 if _gut else 1)
