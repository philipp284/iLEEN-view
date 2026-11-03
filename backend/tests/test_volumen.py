"""
Prüfstein für das Volumenmodell: Werkstoffe, Netz, Löser, Auswertung.

Ein Volumenmodell hat eine unangenehme Eigenschaft: **es sieht immer richtig
aus.** Die Biegelinie ist glatt, die Farben verlaufen weich, das Gleichgewicht
stimmt — auch dann, wenn das Ergebnis um vierzig Prozent danebenliegt. Anders
als bei einer Handrechnung gibt es keine Zwischenzahl, an der man stutzt.

Geprüft wird deshalb gegen das, was unabhängig bekannt ist:

1. **Die Werkstoffmatrix** gegen die Lamé-Form (isotrop) und gegen die
   Drehinvarianz. Ein Fehler in C ist ein Fehler in jedem Ergebnis.
2. **Das Netz** gegen das exakte Volumen und gegen die Verbindung mehrerer
   Bauteile — daran hängt, ob eine Auswahl überhaupt ein System ergibt.
3. **Der Löser** gegen die Balkentheorie, an drei Werkstoffen. Der heterogene
   Pfad muss beim isotropen Stoff denselben Wert liefern wie der alte.
4. **Die Schnittgrößen** gegen das statische Gleichgewicht: am Einfeldträger
   ist M = q·l²/8, unabhängig von jeder Steifigkeit — und deshalb der
   schärfste Prüfstein, den es hier gibt.
5. **Die Auflagerbreite**, weil sie die Falle ist, die am teuersten war:
   ein zehn Zentimeter breites Linienlager kostet ein Drittel des
   Feldmoments, und zwar unauffällig.

Ausführen:  python3 tests/test_volumen.py
            (dauert rund eine Minute — es wird wirklich gerechnet)
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

logging.disable(logging.INFO)

from ileen import volumen as vo  # noqa: E402
from ileen import volumen_ifc as vifc  # noqa: E402
from ileen import werkstoff as wk  # noqa: E402

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


def nahe(ist, soll, was, toleranz=0.02):
    """Relativ, nicht absolut: eine Spannung in kN/m² hat sechs Stellen."""
    bezug = max(abs(soll), 1e-12)
    ok = abs(ist - soll) / bezug <= toleranz
    return pruefe(ok, f"{was} ({ist:.4g} gegen {soll:.4g}, "
                      f"{abs(ist - soll) / bezug * 100:.1f} %)")


# ── 1. Werkstoffe ───────────────────────────────────────────────────────────

print("\nWerkstoffmatrix")

C = wk.werkstoff("S235").steifigkeit()
E, nu = wk.werkstoff("S235").E_1, wk.werkstoff("S235").nu_12
lam = E * nu / ((1 + nu) * (1 - 2 * nu))
mu = E / (2 * (1 + nu))
soll = np.zeros((6, 6))
soll[:3, :3] = lam
soll[0, 0] = soll[1, 1] = soll[2, 2] = lam + 2 * mu
soll[3, 3] = soll[4, 4] = soll[5, 5] = mu
pruefe(np.allclose(C, soll, rtol=1e-12), "isotrope Matrix ist die Lamé-Form")
pruefe(np.allclose(wk.drehen(C, [1, 2, 3]), C, atol=1e-6),
       "isotrope Matrix ist drehinvariant")

Ch = wk.werkstoff("C24").steifigkeit()
Cd = wk.drehen(Ch, [0, 1, 0])
nahe(Cd[1, 1], Ch[0, 0], "Drehung um 90° tauscht C11 und C22", 1e-9)
pruefe(Ch[0, 0] / Ch[1, 1] > 20,
       f"Holz ist längs deutlich steifer als quer (Faktor {Ch[0, 0] / Ch[1, 1]:.0f})")

for name in wk.WERKSTOFFE:
    try:
        wk.werkstoff(name).steifigkeit()
    except ValueError as fehler:
        pruefe(False, f"{name} ergibt eine gültige Matrix", str(fehler))
pruefe(True, f"alle {len(wk.WERKSTOFFE)} Werkstoffe sind physikalisch möglich")

print("\nNachweise")
MPA = wk.MPA
zug = np.array([[100 * MPA, 0, 0, 0, 0, 0]])
nahe(float(wk.vergleichsspannung(zug)[0]) / MPA, 100.0, "von Mises bei einachsigem Zug")
schub = np.array([[0, 0, 0, 0, 0, 100 * MPA]])
nahe(float(wk.vergleichsspannung(schub)[0]) / MPA, 100 * np.sqrt(3),
     "von Mises bei reinem Schub ist √3·τ")

holz = wk.werkstoff("C24")
laengs = wk.ausnutzung(holz, np.array([[10 * MPA, 0, 0, 0, 0, 0]]), achse_1=[1, 0, 0])
quer = wk.ausnutzung(holz, np.array([[10 * MPA, 0, 0, 0, 0, 0]]), achse_1=[0, 1, 0])
pruefe(quer["eta"][0] > 40 * laengs["eta"][0],
       f"dieselbe Spannung quer zur Faser ist um Faktor "
       f"{quer['eta'][0] / laengs['eta'][0]:.0f} kritischer")
gleich(laengs["teil"]["laengs_zug"] > 0, np.array([True]),
       "längs zur Faser greift der Längsnachweis")

# ── 2. Netz ─────────────────────────────────────────────────────────────────

print("\nVernetzung")

balken = vo.Bauteil.quader("b", "Balken", "IfcBeam", "GL24h", [0, 0, 0], [6, 0.2, 0.4])
netz = vo.vernetze([balken], 0.05)
nahe(netz.n_elemente * netz.groesse ** 3, 6 * 0.2 * 0.4,
     "das Voxelvolumen trifft das Quadervolumen", 1e-9)
gleich(netz.cells.shape[1], 8, "HEX8 hat acht Knoten je Element")

stuetze = vo.Bauteil.quader("s", "Stütze", "IfcColumn", "C25/30",
                            [0, 0, -3.0], [0.3, 0.3, 0.0])
zusammen = vo.vernetze([balken, stuetze], 0.05)
teile, _ = vo.zusammenhang(zusammen)
gleich(teile, 1, "Balken auf Stütze ist ein zusammenhängendes System")
gleich(len(zusammen.werkstoffe), 2, "zwei Werkstoffe in einem Netz")

fern = vo.Bauteil.quader("f", "fern", "IfcBeam", "C24", [50, 0, 0], [51, 0.2, 0.2])
teile, _ = vo.zusammenhang(vo.vernetze([balken, fern], 0.05))
gleich(teile, 2, "getrennte Bauteile werden als zwei Systeme erkannt")

# Das Raster ist an der Zellgröße ausgerichtet und nicht am ersten Bauteil:
# dieselbe Zelle muss an derselben Stelle liegen, egal wer mitgerechnet wird.
allein = vo.vernetze([balken], 0.05)
mit = vo.vernetze([balken, stuetze], 0.05)
menge_allein = {tuple(np.round(p, 6)) for p in allein.mitten()}
menge_mit = {tuple(np.round(p, 6)) for p in mit.mitten()[mit.bauteil == 0]}
gleich(menge_allein == menge_mit, True,
       "das Netz des Balkens ändert sich nicht, wenn ein zweites Bauteil dazukommt")

print("\nLasten")
last = vo.eigengewicht(netz)
nahe(abs(last[:, 2].sum()) * netz.groesse ** 3, 6 * 0.2 * 0.4 * balken.werkstoff.rho_kNm3,
     "Eigengewicht ist Volumen mal Wichte", 1e-9)
flaeche = vo.flaechenlast(netz, 5.0)
nahe(abs(flaeche[:, 2].sum()) * netz.groesse ** 3, 5.0 * 6 * 0.2,
     "Flächenlast trifft die Grundfläche", 1e-9)

# ── 3. Löser gegen die Balkentheorie ────────────────────────────────────────

print("\nEinfeldträger 5,0 m · 20/40 · nur Eigengewicht")

L, B, H = 5.0, 0.20, 0.40
for name, toleranz_w in (("C25/30", 0.05), ("S235", 0.05), ("GL24h", 0.30)):
    stoff = wk.werkstoff(name)
    bauteil = vo.Bauteil.quader("b", name, "IfcBeam", name, [0, 0, 0], [L, B, H])
    netz = vo.vernetze([bauteil], 0.05)
    ergebnis = vo.rechne(netz, lastfaelle=[
        vo.Lastfall("G", "staendig", vo.eigengewicht(netz))])

    q = stoff.rho_kNm3 * B * H
    I = B * H ** 3 / 12
    G = stoff.G_12
    w_soll = (5 * q * L ** 4 / (384 * stoff.E_1 * I)
              + 5 * q * L ** 2 / (48 * (5 / 6) * G * B * H)) * 1000

    # Die Durchbiegung darf beim Holz abweichen: die lokale Eindrückung am
    # Linienlager quer zur Faser gibt es in der Balkentheorie nicht, und sie
    # ist bei E_90 = 300 N/mm² kein Randeffekt mehr.
    nahe(ergebnis.durchbiegung_mm().max(), w_soll,
         f"{name}: Durchbiegung", toleranz_w)

    sg = vo.schnittgroessen(netz, ergebnis.u["selten"], 0)
    mitte = int(np.argmin(np.abs(sg["s"] - L / 2)))
    nahe(sg["M"][mitte], q * L ** 2 / 8, f"{name}: Feldmoment q·l²/8", 0.02)
    nahe(abs(sg["V"][0]), q * L / 2, f"{name}: Auflagerquerkraft q·l/2", 0.05)

    probe = max(p["abweichung_rel"] for p in ergebnis.proben.values())
    pruefe(probe < 1e-8, f"{name}: Auflagerkräfte gleichen der Last ({probe:.1e})")

# ── 4. Der heterogene Pfad gegen den alten ──────────────────────────────────

print("\nHeterogener Löser gegen den isotropen")

from ileen.loeser import Loeser  # noqa: E402

bauteil = vo.Bauteil.quader("b", "Beton", "IfcBeam", "C25/30", [0, 0, 0], [2.0, 0.2, 0.3])
netz = vo.vernetze([bauteil], 0.05)
lager = [vo.Auflager(lo=[-1, -1, -1], hi=[0.02, 10, 10], typ="fest")]
bc, _ = vo.randbedingungen(netz, lager)
stoff = wk.werkstoff("C25/30")

alt = Loeser(netz, E=stoff.E_1, nu=stoff.nu_12, bc_info=bc)
neu = Loeser(netz, bc_info=bc, C_tabelle=netz.C_tabelle, material=netz.material)
f = vo.eigengewicht(netz)
u_alt, u_neu = alt.loese(f), neu.loese(f)
abweichung = np.abs(u_alt - u_neu).max() / max(np.abs(u_alt).max(), 1e-30)
pruefe(abweichung < 1e-8,
       f"beide Wege liefern dieselbe Lösung (relativ {abweichung:.1e})")

# ── 5. Die Auflagerbreite ───────────────────────────────────────────────────

print("\nAuflagerbreite — die Falle")

bauteil = vo.Bauteil.quader("b", "Beton", "IfcBeam", "C25/30", [0, 0, 0], [L, B, H])
netz = vo.vernetze([bauteil], 0.05)
q = wk.werkstoff("C25/30").rho_kNm3 * B * H

momente = {}
for breite in (0.0, 0.10):
    lager = [vo.Auflager(lo=[-1, -1, -1e-6], hi=[breite, 10, 0.02], typ="gelenkig"),
             vo.Auflager(lo=[L - breite, -1, -1e-6], hi=[L + 1, 10, 0.02], typ="gelenkig")]
    ergebnis = vo.rechne(netz, lastfaelle=[
        vo.Lastfall("G", "staendig", vo.eigengewicht(netz))], auflager=lager)
    sg = vo.schnittgroessen(netz, ergebnis.u["selten"], 0)
    momente[breite] = sg["M"][int(np.argmin(np.abs(sg["s"] - L / 2)))]

nahe(momente[0.0], q * L ** 2 / 8, "Linienlager: Feldmoment stimmt", 0.02)
pruefe(momente[0.10] < 0.75 * momente[0.0],
       f"10 cm Lagerbreite senken das Feldmoment spürbar "
       f"({momente[0.10] / momente[0.0] * 100:.0f} % — deshalb ist das "
       f"Standardlager eine Knotenreihe breit)")

auto = vo.auflager_automatisch(netz)
bc_auto, protokoll = vo.randbedingungen(netz, auto)
gleich(protokoll["gelenkig"], 2 * (int(round(B / netz.groesse)) + 1),
       "das automatische Lager hält genau eine Knotenreihe je Auflager")

print("\nSteht es oder liegt es?")

# Die Frage entscheidet, ob die Fußpunkte gehalten werden oder die Enden —
# und sie falsch zu beantworten ist teuer: ein Geschossausschnitt, der an
# zwei Kanten statt auf seinen Wandfüßen lagert, ist ein anderes Tragwerk.
# Geprüft an den Fällen, bei denen die naheliegende Regel („höher als breit")
# danebengreift.
for beschreibung, teile, soll in [
    ("Einfeldbalken 5,0 × 0,20 × 0,40",
     [vo.Bauteil.quader("b", "B", "IfcBeam", "C25/30", [0, 0, 0], [5, 0.2, 0.4])],
     "gelenkig"),
    # Höher als das Doppelte seiner Breite — und liegt trotzdem.
    ("schmaler Balken 5,0 × 0,20 × 0,50",
     [vo.Bauteil.quader("b", "B", "IfcBeam", "C25/30", [0, 0, 0], [5, 0.2, 0.5])],
     "gelenkig"),
    ("einzelne Stütze 0,30 × 0,30 × 3,0",
     [vo.Bauteil.quader("s", "S", "IfcColumn", "C25/30", [0, 0, 0], [0.3, 0.3, 3])],
     "fest"),
    ("Balken auf zwei Stützen",
     [vo.Bauteil.quader("b", "B", "IfcBeam", "GL28h", [0, 0, 3], [5, 0.2, 3.4]),
      vo.Bauteil.quader("s1", "S1", "IfcColumn", "C25/30", [0, 0, 0], [0.3, 0.3, 3]),
      vo.Bauteil.quader("s2", "S2", "IfcColumn", "C25/30", [4.7, 0, 0], [5, 0.3, 3])],
     "fest"),
    # Viel breiter als hoch — und steht trotzdem auf den Wandfüßen.
    ("Geschoss: zwei Wände, Stütze, Decke",
     [vo.Bauteil.quader("w1", "W1", "IfcWall", "C25/30", [0, 0, 0], [4, 0.2, 2.8]),
      vo.Bauteil.quader("w2", "W2", "IfcWall", "C25/30", [0, 3.8, 0], [4, 4, 2.8]),
      vo.Bauteil.quader("st", "St", "IfcColumn", "C25/30", [1.9, 1.9, 0], [2.1, 2.1, 2.8]),
      vo.Bauteil.quader("d", "D", "IfcSlab", "C30/37", [0, 0, 2.8], [4, 4, 3.0])],
     "fest"),
]:
    lager = vo.auflager_automatisch(vo.vernetze(teile, 0.1))
    gleich(lager[0].typ, soll, beschreibung)

# ── 6. Werkstoff aus dem IFC-Material ───────────────────────────────────────

print("\nWerkstofferkennung aus Freitext")

for material, typ, soll in [
    ("Beton C25/30", "IfcBeam", "C25/30"),
    ("C30/37", "IfcColumn", "C30/37"),
    ("Concrete, Cast-in-Place", "IfcSlab", "C25/30"),
    ("STB", "IfcWall", "C25/30"),
    ("Holz GL28h", "IfcBeam", "GL28h"),
    ("Brettschichtholz", "IfcBeam", "GL24h"),
    ("Nadelholz C24", "IfcMember", "C24"),
    ("Fichte KVH", "IfcBeam", "C24"),
    ("Stahl S355", "IfcColumn", "S355"),
    ("Steel", "IfcMember", "S235"),
    (None, "IfcBeam", "C25/30"),
]:
    stoff, grund = vifc.werkstoff_raten(material, typ)
    gleich(stoff.name, soll, f"{material!r} / {typ} → {soll}")

# Eine geratene Klasse muss sich als geraten zu erkennen geben.
_, grund = vifc.werkstoff_raten("Beton", "IfcBeam")
pruefe("angenommen" in grund, "eine geratene Festigkeitsklasse sagt das auch")
_, grund = vifc.werkstoff_raten("Beton C30/37", "IfcBeam")
pruefe("angenommen" not in grund, "eine gelesene Klasse gibt sich nicht als Annahme aus")

# ── 7. Die Punktwolke ───────────────────────────────────────────────────────

print("\nPunktwolke")

import json  # noqa: E402
import struct  # noqa: E402
import tempfile  # noqa: E402

from tiling import volumenwolke as vw  # noqa: E402

bauteil = vo.Bauteil.quader("b", "Balken", "IfcBeam", "GL24h", [0, 0, 0], [3, 0.2, 0.3])
ergebnis = vo.rechne([bauteil], groesse=0.05, nutzlast_kNm2=3.0)
punkte = vw.felder_aus_ergebnis(ergebnis)
gleich(len(punkte["xyz"]), ergebnis.netz.n_elemente, "ein Punkt je Element")

ziel = Path(tempfile.mkdtemp(prefix="wolkentest-"))
skala = vw.aufbauen(punkte, ziel, feld="eta")

roh = (ziel / "tile.pnts").read_bytes()
magic, version, laenge, ftj, ftb, btj, btb = struct.unpack("<4s6I", roh[:28])
gleich(magic, b"pnts", "die Kachel ist eine PNTS-Kachel")
gleich(laenge, len(roh), "die Längenangabe im Kopf stimmt mit der Datei überein")
feature = json.loads(roh[28:28 + ftj])
# Ohne BATCH_LENGTH legt CesiumJS für eine Punktwolke gar keine Features an;
# die Werte wären dann nur für Stilausdrücke da, und ein Klick auf einen Punkt
# fände nichts. Am fertigen Tileset nachgemessen, siehe volumenwolke._pnts.
gleich(feature.get("BATCH_LENGTH"), skala["punkte"],
       "die Kachel weist jeden Punkt als eigenes Feature aus")
pruefe(feature.get("BATCH_ID", {}).get("byteOffset", 1) % 4 == 0,
       "der BATCH_ID-Block liegt auf seiner Komponentengrenze")
# Der Versatz zählt ab dem Beginn des Feature-Table-*Binärteils*, nicht ab
# dem Dateianfang — der 28-Byte-Kopf und der JSON-Block liegen davor.
_binaer = 28 + ftj + feature["BATCH_ID"]["byteOffset"]
ids = np.frombuffer(roh[_binaer:_binaer + 2 * skala["punkte"]], dtype="<u2")
pruefe(np.array_equal(ids, np.arange(skala["punkte"], dtype="<u2")),
       "die Punktnummern laufen lückenlos von null")

batch = json.loads(roh[28 + ftj + ftb:28 + ftj + ftb + btj])
pruefe(all(e["byteOffset"] % 8 == 0 for e in batch.values()),
       "alle Batch-Table-Blöcke liegen auf 8-Byte-Grenzen")
pruefe("eta" in batch and "sigma_v" in batch and "bauteil" in batch,
       f"die Werte stehen am Punkt ({len(batch)} Größen je Punkt)")

basis = 28 + ftj + ftb + btj
versatz = batch["eta"]["byteOffset"]
aus_kachel = np.frombuffer(roh[basis + versatz:basis + versatz + 4 * skala["punkte"]],
                           dtype="<f4")
pruefe(np.allclose(aus_kachel, punkte["werte"]["eta"], rtol=1e-6),
       "die Werte in der Kachel sind die gerechneten")

treffer = vw.punkt_abfragen(ziel / "punkte.npz", [1.5, 0.1, 0.02])
pruefe(treffer is not None and "eta" in treffer["werte"],
       "die Punktabfrage findet den nächsten Punkt")
pruefe(vw.punkt_abfragen(ziel / "punkte.npz", [100, 100, 100], radius=1.0) is None,
       "außerhalb des Radius gibt es keinen Treffer")

import shutil  # noqa: E402
shutil.rmtree(ziel, ignore_errors=True)


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
