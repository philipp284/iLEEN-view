"""
Prüfstein für Steildächer im Lastabtrag (`ileen/dach.py`).

Ein Pfettendach von Hand gebaut — Sparren, Fuß- und Firstpfetten, Stiele,
Kniestock — als Hüllboxen mit Stabachse, wie `section.bauteilform()` sie
liefert. Geprüft werden der Durchlaufträger gegen Handrechnungen, die Lager je
Sparren, die Einzugsbreiten, die Summen je Lastfall und die Aufteilung der
Firstpfette auf die Stiele.

Ausführen:  python3 tests/test_dach.py
"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import dach  # noqa: E402

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


print("\nDurchlaufträger gegen Handrechnungen")
r = dach.durchlauftraeger(4.0, [0, 4], q=1.0)
pruefe(nah(r[0], 2.0) and nah(r[1], 2.0), "Einfeldträger: qL/2", r)
r = dach.durchlauftraeger(10.0, [0, 5, 10], q=1.0)
pruefe(nah(r[0], 1.875) and nah(r[1], 6.25) and nah(r[2], 1.875),
       "Zweifeldträger: 3/8 · 10/8 · 3/8 qL", r)
r = dach.durchlauftraeger(15.0, [0, 5, 10, 15], q=1.0)
pruefe(nah(r[0], 2.0) and nah(r[1], 5.5), "Dreifeldträger: 0,4 · 1,1 qL", r)
r = dach.durchlauftraeger(4.5, [0.62, 4.5], q=1.0)
pruefe(nah(r[1], 4.5 * (2.25 - 0.62) / 3.88), "Kragarm an der Traufe (Sparren)", r)
r = dach.durchlauftraeger(4.0, [0, 4], punktlasten=[(1.0, 10.0)])
pruefe(nah(r[0], 7.5) and nah(r[1], 2.5), "Einzellast: Hebelgesetz", r)
pruefe(dach.durchlauftraeger(3.0, [], q=1.0) is None, "ohne Lager: None")
pruefe(nah(dach.durchlauftraeger(3.0, [1.0], q=2.0)[0], 6.0),
       "ein Lager trägt alles (Sparrendach: First ohne Pfette)")
pruefe(nah(dach.mu1(25), 0.8) and nah(dach.mu1(45), 0.4) and nah(dach.mu1(70), 0.0),
       "μ₁ nach DIN EN 1991-1-3: 0,8 bis 30°, linear auf 0 bei 60°")
# Prüfhaus H6 gedreht: die Sparren beider Seiten treffen die Firstpfette 5 µm
# auseinander. Mit einem 5-µm-Element trugen die Lager ein Siebtel der Last.
lasten = [(0.04 + i * 0.8267 + d, 1.0) for i in range(13) for d in (0.0, 5e-6)]
r = dach.durchlauftraeger(10.000084, [0.12, 5.0, 9.88], q=0.192, punktlasten=lasten)
pruefe(abs(sum(r) - (26.0 + 0.192 * 10.000084)) < 1e-5 and abs(r[0] - r[2]) < 0.05,
       "Lasten 5 µm auseinander, Länge nicht auf Millimeter: Gleichgewicht hält", r)


# ── Ein Pfettendach von Hand ──────────────────────────────────────────────

def stabbox(name, a, b, breite, hoehe, typ="IfcBeam", material="Nadelholz C24"):
    a, b = list(map(float, a)), list(map(float, b))
    d = [b[i] - a[i] for i in range(3)]
    plan = math.hypot(d[0], d[1])
    winkel = math.degrees(math.atan2(d[1], d[0])) % 180.0
    lo = [min(a[i], b[i]) - (breite if i < 2 else hoehe) / 2 for i in range(3)]
    hi = [max(a[i], b[i]) + (breite if i < 2 else hoehe) / 2 for i in range(3)]
    return {"lo": lo, "hi": hi, "ifc_type": typ, "name": name, "material": material,
            "achse": [a, b], "querschnitt_m": sorted([breite, hoehe]),
            "volumen_m3": breite * hoehe * math.dist(a, b),
            "grundriss": {"winkel_grad": winkel, "laenge_m": plan, "breite_m": breite,
                          "mitte": [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]}}


def wandbox(name, x0, y0, x1, y1, z0, z1):
    return {"lo": [x0, y0, z0], "hi": [x1, y1, z1], "ifc_type": "IfcWall", "name": name,
            "material": "Kalksandstein"}


L, B, alpha = 10.0, 8.0, math.radians(40.0)
z_fuss = 0.66                                   # Oberkante Fußpfette
z_first = z_fuss + 3.88 * math.tan(alpha)
boxen = {
    "KS": wandbox("Kniestock Süd", 0, 0, L, 0.24, 0.0, 0.50),
    "KN": wandbox("Kniestock Nord", 0, B - 0.24, L, B, 0.0, 0.50),
    "FS": stabbox("Fußpfette Süd", (0, 0.12, 0.58), (L, 0.12, 0.58), 0.14, 0.16),
    "FN": stabbox("Fußpfette Nord", (0, B - 0.12, 0.58), (L, B - 0.12, 0.58), 0.14, 0.16),
    "FP": stabbox("Firstpfette", (0, B / 2, z_first - 0.12), (L, B / 2, z_first - 0.12),
                  0.16, 0.24, material="Brettschichtholz GL24h"),
}
for nr, x in enumerate((0.12, 5.0, 9.88)):
    boxen[f"ST{nr}"] = {"lo": [x - 0.07, B / 2 - 0.07, 0.0], "hi": [x + 0.07, B / 2 + 0.07,
                                                                  z_first - 0.24],
                        "ifc_type": "IfcColumn", "name": f"Stiel {nr}",
                        "material": "Nadelholz C24",
                        "grundriss": {"winkel_grad": 0, "laenge_m": 0.14, "breite_m": 0.14,
                                      "mitte": [x, B / 2]}}
teilung = (L - 0.08) / 12
sa, ca = math.sin(alpha), math.cos(alpha)
for i in range(13):
    x = 0.04 + i * teilung
    for seite, y_f in ((1, 0.12), (-1, B - 0.12)):
        def unter(y):
            return z_fuss + seite * (y - y_f) * math.tan(alpha)
        y_e = y_f - seite * 0.62
        p0 = (x, y_e - seite * 0.10 * sa, unter(y_e) + 0.10 * ca)
        p1 = (x, B / 2 - seite * 0.10 * sa, unter(B / 2) + 0.10 * ca)
        boxen[f"SP{i}{seite}"] = stabbox(f"Sparren {i}{'S' if seite > 0 else 'N'}", p0, p1,
                                         0.08, 0.20)

print("\nPfettendach: Sparren auf Fuß- und Firstpfette, Pfette auf drei Stielen")
erg = dach.dachlasten(boxen, z_von=-1.0, z_bis=None, annahmen={})
pruefe(erg["sparren"] == 26 and erg["traeger"] == 3, "26 Sparren, drei Pfetten gerechnet",
       (erg["sparren"], erg["traeger"]))
sp = next(p for p in erg["protokoll"] if p["name"] == "Sparren 3S")
pruefe([l[2] for l in sp["lager"]] == ["FS", "FP"], "ein Sparren liegt auf Fuß- und Firstpfette",
       sp["lager"])

plan = 4.5
flaeche_je_seite = 10.0 * plan / ca          # Einzug 11·Teilung + 2·(Teilung/2 + 4 cm) = 10 m
soll_aus = 2 * flaeche_je_seite * 1.0
soll_s = 2 * 10.0 * plan * dach.mu1(40.0) * 0.85
pruefe(abs(erg["kN_je_fall"]["AUS"] - soll_aus) < 0.05,
       "Dachaufbau 1,0 kN/m² über die Dachfläche", erg["kN_je_fall"]["AUS"], soll_aus)
pruefe(abs(erg["kN_je_fall"]["S"] - soll_s) < 0.05,
       "Schnee μ₁(40°)·s_k über die Grundfläche", erg["kN_je_fall"]["S"], soll_s)

summe = {}
for l in erg["lasten"]:
    summe[l["lastfall"]] = summe.get(l["lastfall"], 0.0) + l["wert"]
pruefe(all(abs(summe.get(f, 0.0) - v) < 1e-3 for f, v in erg["kN_je_fall"].items()),
       "was hineingeht, kommt unten an — je Lastfall", summe, erg["kN_je_fall"])
ziele = {l["bezug"] for l in erg["lasten"]}
pruefe(ziele == {"KS", "KN", "ST0", "ST1", "ST2"},
       "die Last endet auf den Traufwänden und den drei Stielen", sorted(ziele))
stiele = {k: sum(l["wert"] for l in erg["lasten"] if l["bezug"] == k) for k in ("ST0", "ST1", "ST2")}
anteil = stiele["ST1"] / sum(stiele.values())
pruefe(0.59 < anteil < 0.63 and abs(stiele["ST0"] - stiele["ST2"]) < 1e-6,
       "der mittlere Stiel trägt wie im Zweifeldträger rund 10/16 der Firstpfette",
       round(anteil, 4))
traufe = sum(l["wert"] for l in erg["lasten"] if l["bezug"] in ("KS", "KN") and l["lastfall"] == "AUS")
soll_traufe = soll_aus * (1 - (plan / 2 - 0.684) / (4.482 - 0.684))
pruefe(abs(traufe - soll_traufe) / soll_traufe < 0.02,
       "die Traufwände tragen den Fußanteil der Sparren (Kragträger mit Überstand)",
       traufe, soll_traufe)

print("\nOhne Pfette: das Dach liegt auf nichts — es geht an der Stabmitte nach unten")
nackt = {k: v for k, v in boxen.items() if k.startswith("SP0")}
erg2 = dach.dachlasten(nackt, z_von=-1.0, z_bis=None, annahmen={})
pruefe(erg2["hinweise"] and all(l["bezug"].startswith("SP0") for l in erg2["lasten"]),
       "ein Sparren ohne Lager wird gemeldet und verliert nichts", erg2["hinweise"][:1])

print("\nAlle Prüfungen bestanden." if _gut else "\nEs gab Fehler.")
sys.exit(0 if _gut else 1)
