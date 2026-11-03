"""
Geländenetz aus dem Höhenraster — regelmäßig oder adaptiv.

Zwei Wege, dieselbe Fläche zu vernetzen:

* **fest** — ein regelmäßiges Gitter mit vorgegebener Maschenweite. Vorhersehbar
  in Größe und Laufzeit, und dort richtig, wo das Ergebnis weiterverarbeitet
  wird (Raster-Export, Volumenvergleich Zelle für Zelle).

* **adaptiv** — ein TIN, das nur so viele Stützpunkte setzt, wie die
  Geländeform verlangt: dicht an Böschungen, Grubenkanten und Bordsteinen,
  dünn auf ebenen Flächen. Das ist der Weg, den Vermessung und Tiefbau seit
  jeher gehen, und er ist der Geometrie angemessen — ein 1-m-Gitter zerlegt
  eine ebene Asphaltfläche in Tausende gleich große Dreiecke, die alle
  dasselbe aussagen, und rundet zugleich die Grubenkante weg, auf die es
  ankommt.

Das adaptive Netz entsteht nach dem klassischen Verfahren der *greedy
insertion* (Garland/Heckbert 1995): Beginne mit den vier Ecken, interpoliere
das Gelände über die Triangulation, suche den Rasterpunkt mit der größten
Höhenabweichung, setze dort einen Stützpunkt, wiederhole. Abgebrochen wird,
sobald überall die Toleranz eingehalten ist — die Punktzahl ist damit
Ergebnis, nicht Vorgabe.
"""

import logging

import numpy as np
import scipy.ndimage as ndi
from scipy.spatial import Delaunay

logger = logging.getLogger(__name__)

# Je Runde werden mehrere Punkte auf einmal gesetzt statt einer. Eine
# Triangulation je Stützpunkt wäre bei einigen zehntausend Punkten nicht mehr
# zu bezahlen; ein Mindestabstand zwischen den Punkten einer Runde verhindert,
# dass eine einzige scharfe Kante die ganze Runde für sich verbraucht.
PUNKTE_JE_RUNDE = 0.06        # Anteil der bisherigen Punktzahl
MINDESTPUNKTE_JE_RUNDE = 24


def _dreiecke_beschneiden(punkte_xy, dreiecke, maske, x0, y0, res, hilfspunkte=0):
    """
    Dreiecke verwerfen, die über nicht erfasste Bereiche spannen.

    Eine Delaunay-Triangulation füllt immer die konvexe Hülle — bei einer
    ausgefransten Punktwolke also auch die Buchten dazwischen. Zwei Kriterien
    trennen das ab:

    1. **Hilfspunkte des Startnetzes.** Die ersten `hilfspunkte` Stützpunkte
       sind die aufgeweiteten Ecken; sie liegen außerhalb der Wolke. Jedes
       Dreieck, das einen von ihnen berührt, reicht vom Rand ins Nichts.
    2. **Abtastung gegen die Belegungsmaske**, dicht genug, dass auch eine
       schmale Lücke einen Treffer bekommt. Eine Prüfung nur an Schwerpunkt und
       Kantenmitten übersieht lange, schmale Dreiecke — genau die, die eine
       Bucht überspannen.

    Eine Grenze für die Kantenlänge wäre der einfachere Weg, aber der falsche:
    sie würde große Dreiecke auch dort wegnehmen, wo eine ebene Brachfläche
    tatsächlich erfasst ist, und Löcher in gültiges Gelände reißen.
    """
    ecken = punkte_xy[dreiecke]                       # (n, 3, 2)
    behalten = np.ones(len(dreiecke), bool)
    if hilfspunkte:
        behalten &= ~(dreiecke < hilfspunkte).any(axis=1)

    proben = [ecken.mean(axis=1)]
    for a, b in ((0, 1), (1, 2), (2, 0)):
        for t in np.linspace(0.1, 0.9, 9):
            proben.append(ecken[:, a] * (1 - t) + ecken[:, b] * t)

    hoehe, breite = maske.shape
    for p in proben:
        spalte = np.clip(((p[:, 0] - x0) / res).astype(np.int32), 0, breite - 1)
        zeile = np.clip(((p[:, 1] - y0) / res).astype(np.int32), 0, hoehe - 1)
        behalten &= maske[zeile, spalte]
    return behalten


def _zuordnen(schwerpunkte, grube, strasse, x0, y0, res):
    """Jedes Dreieck bekommt seine Fläche: Baugrube, Verkehr oder Gelände."""
    hoehe, breite = grube.shape
    spalte = np.clip(((schwerpunkte[:, 0] - x0) / res).astype(np.int32), 0, breite - 1)
    zeile = np.clip(((schwerpunkte[:, 1] - y0) / res).astype(np.int32), 0, hoehe - 1)
    ist_grube = grube[zeile, spalte]
    ist_strasse = strasse[zeile, spalte] & ~ist_grube
    return ist_grube, ist_strasse


def festes_gitter(boden, maske, grube, strasse, meta, maschenweite_m):
    """Regelmäßiges Gitter, jede Masche in zwei Dreiecke geteilt."""
    x0, y0, res, breite, hoehe = meta
    breite, hoehe = int(breite), int(hoehe)
    schritt = max(1, int(round(maschenweite_m / res)))

    z = ndi.gaussian_filter(boden[::schritt, ::schritt], 0.8)
    m = maske[::schritt, ::schritt]
    g = grube[::schritt, ::schritt]
    s = strasse[::schritt, ::schritt]
    zh, zb = z.shape

    X = x0 + np.arange(zb) * res * schritt
    Y = y0 + np.arange(zh) * res * schritt
    xx, yy = np.meshgrid(X, Y)
    punkte = np.c_[xx.ravel(), yy.ravel(), z.ravel()].astype(np.float32)

    idx = np.arange(zh * zb).reshape(zh, zb)
    a, b = idx[:-1, :-1], idx[:-1, 1:]
    c, d = idx[1:, 1:], idx[1:, :-1]
    # Zwei Dreiecke je Masche — ein Viereck aus vier Geländehöhen ist im
    # Allgemeinen windschief und als ebene Fläche nicht darstellbar.
    dreiecke = np.concatenate([np.stack([a, b, c], -1).reshape(-1, 3),
                               np.stack([a, c, d], -1).reshape(-1, 3)])
    gueltig = (m[:-1, :-1] & m[:-1, 1:] & m[1:, 1:] & m[1:, :-1]).ravel()
    gueltig = np.concatenate([gueltig, gueltig])
    ist_grube = (g[:-1, :-1] | g[:-1, 1:] | g[1:, 1:] | g[1:, :-1]).ravel()
    ist_grube = np.concatenate([ist_grube, ist_grube])
    ist_strasse = (s[:-1, :-1] & s[:-1, 1:] & s[1:, 1:] & s[1:, :-1]).ravel()
    ist_strasse = np.concatenate([ist_strasse, ist_strasse]) & ~ist_grube

    dreiecke = dreiecke[gueltig]
    return punkte, dreiecke, ist_grube[gueltig], ist_strasse[gueltig], None


def adaptives_tin(boden, maske, grube, strasse, meta, toleranz_m,
                  max_stuetzpunkte=60000, fortschritt=None):
    """
    TIN nach greedy insertion: Stützpunkte nur dort, wo die Form es verlangt.

    `toleranz_m` ist die zugesicherte größte Höhenabweichung des Netzes vom
    gerasterten Gelände. Sie ist eine Genauigkeitsangabe, keine Feinheitsstufe
    — 0,05 m heißt „das Netz weicht nirgends mehr als fünf Zentimeter ab".
    """
    x0, y0, res, breite, hoehe = meta
    breite, hoehe = int(breite), int(hoehe)

    z_raster = ndi.gaussian_filter(np.nan_to_num(boden), 0.8)
    zeilen, spalten = np.nonzero(maske)
    if len(zeilen) < 16:
        raise ValueError("Zu wenige belegte Rasterzellen für ein Geländenetz.")

    # Kandidaten ausdünnen: unter etwa einer Viertelmillion Punkten bleibt die
    # Fehlersuche je Runde im Millisekundenbereich, und feiner als das Raster
    # kann das Netz ohnehin nicht werden.
    schritt = max(1, int(np.ceil(np.sqrt(len(zeilen) / 250_000))))
    if schritt > 1:
        zeilen, spalten = zeilen[::schritt], spalten[::schritt]
    kandidaten = np.c_[x0 + spalten * res, y0 + zeilen * res].astype(np.float64)
    z_soll = z_raster[zeilen, spalten].astype(np.float64)

    # Startnetz: die vier Ecken des belegten Bereichs, dazu die Mitte. Sie
    # liegen selbst meist außerhalb der Wolke, halten aber die Triangulation
    # konvex und werden am Ende mit ihren Dreiecken weggeschnitten.
    #
    # Der Rand wird auf jeder Seite um einen anderen Betrag aufgeweitet. Vier
    # Ecken eines exakten Rechtecks liegen auf einem gemeinsamen Kreis, und für
    # kozirkuläre Punkte gibt es keine eindeutige Delaunay-Triangulation —
    # Qhull bricht dort ab. Die ungleichen Zuschläge brechen diese Symmetrie,
    # ohne eine einzige gemessene Koordinate anzurühren.
    lo, hi = kandidaten.min(0), kandidaten.max(0)
    rand = np.maximum((hi - lo) * 0.01, res * 2)
    x_lo, y_lo = lo - rand * np.array([1.00, 1.07])
    x_hi, y_hi = hi + rand * np.array([1.13, 1.00])
    ecken = np.array([[x_lo, y_lo], [x_hi, y_lo], [x_hi, y_hi], [x_lo, y_hi],
                      [(x_lo + x_hi) / 2, (y_lo + y_hi) / 2]])
    stuetz_xy = ecken.copy()
    stuetz_z = np.full(len(ecken), float(np.median(z_soll)))

    tri = Delaunay(stuetz_xy, incremental=True)
    runde = 0
    while True:
        runde += 1
        simplex = tri.find_simplex(kandidaten)
        drin = simplex >= 0
        z_ist = np.full(len(kandidaten), np.nan)
        if drin.any():
            # Baryzentrische Interpolation über die Transformationsmatrix, die
            # scipy zu jedem Simplex mitliefert — schneller als ein zweiter
            # Interpolator und ohne dessen Speicherkopie.
            s = simplex[drin]
            T = tri.transform[s]
            versatz = kandidaten[drin] - T[:, 2]
            b0 = np.einsum("ijk,ik->ij", T[:, :2], versatz)
            gewicht = np.c_[b0, 1 - b0.sum(axis=1)]
            z_ist[drin] = (stuetz_z[tri.simplices[s]] * gewicht).sum(axis=1)

        fehler = np.where(np.isnan(z_ist), np.inf, np.abs(z_soll - z_ist))
        groesster = float(np.nanmax(np.where(np.isfinite(fehler), fehler, 0.0)))
        offen = fehler > toleranz_m
        if not offen.any() or len(stuetz_xy) >= max_stuetzpunkte:
            break

        # Die schlechtesten Punkte der Runde, mit Mindestabstand zueinander:
        # ohne ihn setzt eine einzige Böschungskante alle neuen Punkte auf sich.
        anzahl = max(MINDESTPUNKTE_JE_RUNDE, int(len(stuetz_xy) * PUNKTE_JE_RUNDE))
        anzahl = min(anzahl, max_stuetzpunkte - len(stuetz_xy), int(offen.sum()))
        rang = np.argsort(-np.where(offen, fehler, -np.inf))[:anzahl * 6]
        mindestabstand = max(res * 2.0, np.sqrt(
            (hi[0] - lo[0]) * (hi[1] - lo[1]) / max(len(stuetz_xy), 1)) * 0.25)
        neu = []
        for k in rang:
            p = kandidaten[k]
            if all(((p - kandidaten[j]) ** 2).sum() > mindestabstand ** 2 for j in neu):
                neu.append(k)
                if len(neu) >= anzahl:
                    break
        if not neu:
            break

        tri.add_points(kandidaten[neu])
        stuetz_xy = np.vstack([stuetz_xy, kandidaten[neu]])
        stuetz_z = np.concatenate([stuetz_z, z_soll[neu]])
        if fortschritt and runde % 5 == 0:
            fortschritt(len(stuetz_xy), groesster)

    tri.close()
    logger.info("Adaptives TIN: %d Stützpunkte, größte Abweichung %.3f m (Toleranz %.3f m)",
                len(stuetz_xy), groesster, toleranz_m)

    dreiecke = tri.simplices.copy()
    behalten = _dreiecke_beschneiden(stuetz_xy, dreiecke, maske, x0, y0, res,
                                     hilfspunkte=len(ecken))
    dreiecke = dreiecke[behalten]
    schwerpunkte = stuetz_xy[dreiecke].mean(axis=1)
    ist_grube, ist_strasse = _zuordnen(schwerpunkte, grube, strasse, x0, y0, res)

    punkte = np.c_[stuetz_xy, stuetz_z].astype(np.float32)
    return punkte, dreiecke, ist_grube, ist_strasse, dict(
        stuetzpunkte=int(len(stuetz_xy)), groesste_abweichung_m=round(groesster, 4),
        toleranz_m=toleranz_m, runden=runde)


def bauen(boden, maske, grube, strasse, meta, *, modus="adaptiv",
          maschenweite_m=1.0, toleranz_m=0.15, max_stuetzpunkte=60000,
          fortschritt=None):
    """
    Liefert Stützpunkte, Dreiecke je Fläche und die UV-Koordinaten fürs Ortho.

    Rückgabe: dict mit `V`, `UV` und je Fläche `F_<name>`.
    """
    x0, y0, res, breite, hoehe = meta
    breite, hoehe = int(breite), int(hoehe)

    if modus == "fest":
        punkte, dreiecke, ist_grube, ist_strasse, kennzahl = festes_gitter(
            boden, maske, grube, strasse, meta, maschenweite_m)
        kennzahl = dict(maschenweite_m=maschenweite_m)
    elif modus == "adaptiv":
        punkte, dreiecke, ist_grube, ist_strasse, kennzahl = adaptives_tin(
            boden, maske, grube, strasse, meta, toleranz_m,
            max_stuetzpunkte, fortschritt)
    else:
        raise ValueError(f"Unbekannter Netzmodus '{modus}' — erlaubt: fest, adaptiv.")

    # UV aus der Lage im Raster: das Orthophoto deckt genau die Rasterfläche ab.
    uv = np.c_[(punkte[:, 0] - x0) / ((breite - 1) * res),
               (punkte[:, 1] - y0) / ((hoehe - 1) * res)].astype(np.float32)

    ergebnis = {"V": punkte, "UV": uv,
                "F_Gelaende_Baugrube": dreiecke[ist_grube].astype(np.int32),
                "F_Verkehrsflaeche": dreiecke[ist_strasse].astype(np.int32),
                "F_Gelaende_Umgebung": dreiecke[~ist_grube & ~ist_strasse].astype(np.int32)}
    kennzahl["dreiecke"] = int(len(dreiecke))
    kennzahl["modus"] = modus
    ergebnis["kennzahlen"] = kennzahl
    return ergebnis
