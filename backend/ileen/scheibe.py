"""
Die Decke als Scheibe: Wind, Schiefstellung, Schub und Zug in der Ebene.

**Wozu.** Eine Geschossdecke trägt zweierlei. Senkrecht zu ihrer Ebene ist sie
eine Platte und biegt sich — das rechnet `plate`. In ihrer Ebene ist sie eine
Scheibe: sie sammelt die Windlasten, die auf die Fassade drücken, und verteilt
sie auf die aussteifenden Wände. Diese zweite Aufgabe wird in der Vorbemessung
gern übersprungen, weil „die Decke ja steif genug ist". Steif ist sie, aber
nicht beliebig: zwischen zwei weit auseinanderstehenden Wänden wirkt sie als
tiefer Träger mit erheblichem Schub, an einspringenden Ecken und neben
Deckenöffnungen konzentriert er sich, und die Zugkraft im Randgurt braucht
Bewehrung, die dort sonst niemand hinlegt.

**Das Modell.** Dasselbe HEX8-Netz wie bei der Platte, aber mit anderen
Randbedingungen und Lasten:

| | Platte | Scheibe |
|---|---|---|
| Last | senkrecht, kN/m² | in der Ebene, kN/m am Rand |
| Auflager | u_z an allen Lagerlinien | zusätzlich u in Wandrichtung |
| Ergebnis | m_x, m_y, m_xy | n_x, n_y, n_xy |
| Bemessung | Biegebewehrung | Netzbewehrung, Anhang F |

Getrennt gerechnet wird, weil beide Systeme verschiedene Lager haben — und
weil die Membranwirkung, die entstünde, wenn man die Platte in ihrer Ebene
festhält, das Biegeergebnis um eine Größenordnung verfälschen würde (siehe
`plate.randbedingungen`). Zusammengeführt wird erst bei der Bemessung: Moment
und Normalkraft am selben Querschnitt, `beton.biegebemessung(m, d, …, n_Ed=n)`.

**Eine Wand ist eine Scheibe.** Sie hält in ihrer eigenen Ebene und quer dazu
so gut wie nicht. Genau so werden die Auflager hier angesetzt: eine Wand in
x-Richtung hält u_x, eine in y-Richtung u_y. Wer alle Wände in alle Richtungen
festhält, bekommt eine Decke ohne Schub und ein Ergebnis, das nichts bedeutet.
"""

from __future__ import annotations

import numpy as np

from . import plate
from .plate import Modell, Netz, _ring, abstand_zu_polylinie, innen

# ──────────────────────────────────────────────────────────────────────────
# Windlasten nach DIN EN 1991-1-4 mit Nationalem Anhang
# ──────────────────────────────────────────────────────────────────────────

#: Vereinfachter Böengeschwindigkeitsdruck q_p in kN/m² für das Binnenland
#: (DIN EN 1991-1-4/NA, Tab. NA.B.3), nach Windzone und Gebäudehöhe.
#: Küstennähe und Inseln liegen deutlich darüber — dort q_p unmittelbar angeben.
STAUDRUCK_BINNENLAND = {
    1: [(10.0, 0.50), (18.0, 0.65), (25.0, 0.75)],
    2: [(10.0, 0.65), (18.0, 0.80), (25.0, 0.90)],
    3: [(10.0, 0.80), (18.0, 0.95), (25.0, 1.10)],
    4: [(10.0, 0.95), (18.0, 1.15), (25.0, 1.30)],
}

#: Außendruckbeiwerte vertikaler Wände, EC1-1-4 Tab. 7.1 für h/d ≤ 1.
C_PE_LUV = 0.80
C_PE_LEE = -0.50
C_PE_SEITE = -0.80


def staudruck_kNm2(windzone: int = 2, hoehe_m: float = 10.0) -> float:
    """
    q_p für das vereinfachte Verfahren, Binnenland.

    Der Sprung an den Höhengrenzen 10 m und 18 m ist keine Ungenauigkeit,
    sondern die Tabelle: das vereinfachte Verfahren setzt über die ganze
    Gebäudehöhe *einen* Druck an, damit man nicht geschossweise rechnen muss.
    Über 25 m verlangt der NA das genaue Verfahren — dann q_p direkt übergeben.
    """
    stufen = STAUDRUCK_BINNENLAND[int(windzone)]
    for grenze, wert in stufen:
        if hoehe_m <= grenze:
            return wert
    raise ValueError(f"h = {hoehe_m} m übersteigt 25 m — vereinfachtes Verfahren "
                     "nicht anwendbar, q_p aus dem genauen Verfahren übergeben")


def _kanten(polygon: np.ndarray):
    """Randkanten mit Länge und nach außen zeigender Normale."""
    ring = _ring(polygon)
    a = ring
    b = np.roll(ring, -1, axis=0)
    richtung = b - a
    laenge = np.linalg.norm(richtung, axis=1)
    sicher = np.where(laenge < 1e-12, 1.0, laenge)
    t = richtung / sicher[:, None]

    # Umlaufsinn bestimmen: bei positiver Fläche (Gegenuhrzeigersinn) ist
    # (t_y, −t_x) die äußere Normale, sonst ihr Negatives. Ohne diese Prüfung
    # zeigt der Winddruck bei im Uhrzeigersinn gezeichneten Umrissen nach
    # innen — und die Decke wird zusammengedrückt statt angeblasen.
    flaeche2 = np.dot(ring[:, 0], np.roll(ring[:, 1], -1)) - np.dot(ring[:, 1], np.roll(ring[:, 0], -1))
    vorzeichen = 1.0 if flaeche2 > 0 else -1.0
    n = vorzeichen * np.stack([t[:, 1], -t[:, 0]], axis=1)
    return a, b, laenge, n


def windkanten(netz: Netz, richtung, q_p_kNm2: float, einzugshoehe_m: float,
               seitensog: bool = False) -> list[dict]:
    """
    Die Windlast auf den Deckenrand, kantenweise in kN/m.

    Jede Randkante wird nach ihrer Lage zum Wind eingeordnet:

    | n·e | Zone | c_pe | Kraftrichtung |
    |---|---|---|---|
    | < −0,3 | Luv (D) | +0,80 | nach innen, −n |
    | > +0,3 | Lee (E) | −0,50 | nach außen, +n |
    | sonst | Seite (A–C) | −0,80 | nach außen, +n (nur mit `seitensog`) |

    Der Winddruck wirkt immer senkrecht auf die Wand, nicht in Windrichtung —
    bei einem rechteckigen Grundriss ist das dasselbe, bei einem schrägen oder
    gefalteten nicht, und dort entstehen die Torsionsmomente, die man in der
    Deckenscheibe sehen will.

    Der Seitensog bleibt standardmäßig außen vor: bei symmetrischem Grundriss
    hebt er sich auf, bei unsymmetrischem verdreht er die Scheibe. Wer die
    Verdrehung untersucht, schaltet ihn zu — für die Bemessung der Wände in
    Windrichtung ist er ohne Belang.

    `einzugshoehe_m` ist die halbe Geschosshöhe darüber plus die halbe
    darunter: die Fassade trägt ihre Windlast je zur Hälfte an die Decke über
    und unter sich ab.
    """
    e = np.asarray(richtung, dtype=float)[:2]
    e = e / max(float(np.linalg.norm(e)), 1e-12)

    a, b, laenge, n = _kanten(netz.polygon)
    kosinus = n @ e

    lasten = []
    for i in range(len(a)):
        if laenge[i] < 1e-9:
            continue
        if kosinus[i] < -0.3:
            wert, wirkung = C_PE_LUV, -n[i]
        elif kosinus[i] > 0.3:
            wert, wirkung = abs(C_PE_LEE), +n[i]
        elif seitensog:
            wert, wirkung = abs(C_PE_SEITE), +n[i]
        else:
            continue
        w = q_p_kNm2 * wert * einzugshoehe_m
        lasten.append({
            "von": a[i], "bis": b[i], "laenge_m": float(laenge[i]),
            "w_kNm": float(w), "richtung": wirkung,
            "zone": "Luv" if kosinus[i] < -0.3 else ("Lee" if kosinus[i] > 0.3 else "Seite"),
            "kraft_kN": float(w * laenge[i]),
        })
    return lasten


def imperfektion(vertikallast_kN: float, richtung, hoehe_m: float,
                 geschosse: int = 1) -> dict:
    """
    Horizontale Ersatzlast aus der Schiefstellung, EC2 5.2.

        θ_i = θ_0·α_h·α_m,   θ_0 = 1/200,
        α_h = 2/√l ≤ 1,0,    α_m = √(0,5·(1 + 1/m))

    Kein Bauwerk steht lotrecht. Die Norm ersetzt die unvermeidliche
    Schiefstellung durch eine horizontale Kraft H = θ_i·N, und sie ist keine
    Formalie: sie wächst mit der Vertikallast, während der Wind nur mit der
    Fassadenfläche wächst. Bei einem gedrungenen, schwer belasteten Gebäude —
    Lager, Bibliothek, Parkdeck — überholt sie den Wind, und in der
    Deckenscheibe wirkt sie anders als er: als Flächenlast über die ganze
    Decke statt als Randlast an der Fassade.

    `vertikallast_kN` ist die Summe der Vertikallasten *über* der betrachteten
    Decke, nicht die dieser einen Decke — die Schiefstellung wirkt auf die
    ganze darüberstehende Masse.
    """
    theta_0 = 1.0 / 200.0
    alpha_h = min(2.0 / np.sqrt(max(hoehe_m, 1e-6)), 1.0)
    alpha_m = np.sqrt(0.5 * (1.0 + 1.0 / max(geschosse, 1)))
    theta = theta_0 * alpha_h * alpha_m

    e = np.asarray(richtung, dtype=float)[:2]
    e = e / max(float(np.linalg.norm(e)), 1e-12)
    H = theta * abs(vertikallast_kN)
    return {"theta_i": float(theta), "alpha_h": float(alpha_h), "alpha_m": float(alpha_m),
            "H_kN": float(H), "richtung": e}


# ──────────────────────────────────────────────────────────────────────────
# Lasten als Volumenkraftfeld
# ──────────────────────────────────────────────────────────────────────────


def randlastfeld(netz: Netz, lasten: list[dict], streifen: float | None = None) -> np.ndarray:
    """
    Randlinienlasten als Volumenkraft in kN/m³, (n_elemente, 3).

    Verschmiert wie die Linienlasten der Platte und aus demselben Grund: eine
    Last auf einer Kante des Volumenmodells wäre eine Singularität. Die
    Intensität ergibt sich aus der Gesamtkraft geteilt durch das *tatsächlich*
    getroffene Volumen — damit ist die Resultierende unabhängig davon, wie
    viele Elementreihen der Suchradius erwischt.
    """
    # Der Suchradius bekommt einen Zuschlag von 20 %, und zwar aus einem
    # handfesten Grund: die Mitte der äußersten Elementreihe liegt *exakt* eine
    # halbe Elementbreite von der Randkante entfernt. Mit radius = Δ/2
    # entscheidet dann die letzte Stelle der Fließkommazahl darüber, ob eine
    # ganze Kantenlast angesetzt wird oder verschwindet — und sie verschwindet
    # still, weil die Rechnung weiterläuft. Der Zuschlag greift immer dieselbe
    # eine Reihe, und die Resultierende bleibt ohnehin erhalten, weil die
    # Intensität aus der Zahl der getroffenen Elemente folgt.
    breite = float(streifen or netz.groesse)
    radius = breite * 0.6
    mitten = netz.points[netz.cells].mean(axis=1)
    # Das *tatsächliche* Volumen je Element, nicht `groesse² · dicke/lagen`:
    # dx und dy des Rasters gehen um bis zu ein halbes Prozent auseinander,
    # und die Windlast käme um genau diesen Betrag zu klein an — still, weil
    # die Gleichgewichtsprobe den angesetzten Lastvektor bestätigt und nicht
    # den gewollten. Siehe `plate.zellflaechen()`.
    volumen = plate.zellvolumen(netz)

    f = np.zeros((len(netz.cells), 3), dtype=float)
    for last in lasten:
        linie = np.stack([np.asarray(last["von"], dtype=float),
                          np.asarray(last["bis"], dtype=float)])
        maske = abstand_zu_polylinie(mitten[:, :2], linie) <= radius
        if not maske.any():
            continue
        kraft = float(last["w_kNm"]) * float(last["laenge_m"])          # kN
        intensitaet = kraft / float(volumen[maske].sum())                # kN/m³
        richtung = np.asarray(last["richtung"], dtype=float)
        f[maske, 0] += intensitaet * richtung[0]
        f[maske, 1] += intensitaet * richtung[1]
    return f


def imperfektionsfeld(netz: Netz, H_kN: float, richtung) -> np.ndarray:
    """
    Die Ersatzlast aus Schiefstellung, gleichmäßig über die Deckenfläche.

    Sie ist eine Massenkraft und wird deshalb auch so verteilt — im Gegensatz
    zum Wind, der über die Fassade am Rand ankommt. Der Unterschied ist für die
    Wandkräfte klein, für den Schubverlauf in der Scheibe nicht: eine
    Flächenlast baut den Schub allmählich auf, eine Randlast auf einen Schlag.

    Verteilt wird über das echte Netzvolumen (`plate.zellvolumen()`). Der
    Streifen eines Unterzugs bringt zusätzliche Elemente mit; würde man mit
    „Zellenzahl mal Sollzellgröße" rechnen, käme H am Ende doppelt daneben —
    einmal über die Rasterweite, einmal über die Zusatzlagen.
    """
    e = np.asarray(richtung, dtype=float)[:2]
    e = e / max(float(np.linalg.norm(e)), 1e-12)
    volumen = float(plate.zellvolumen(netz).sum())

    f = np.zeros((len(netz.cells), 3), dtype=float)
    f[:, 0] = H_kN / volumen * e[0]
    f[:, 1] = H_kN / volumen * e[1]
    return f


# ──────────────────────────────────────────────────────────────────────────
# Aussteifung
# ──────────────────────────────────────────────────────────────────────────


def wandrichtungen(modell: Modell) -> list[dict]:
    """
    Die Linienauflager mit ihrer Achsrichtung — die möglichen Aussteifungswände.

    `achse` ist 0 für eine überwiegend in x verlaufende Wand (sie hält u_x) und
    1 für eine in y. Schräge Wände werden auf die nähere Achse gerundet und
    vermerkt: JAX-FEM kennt nur achsweise Dirichlet-Bedingungen, eine
    schiefwinklige Bindung bräuchte eine Koordinatentransformation des
    Gleichungssystems.

    **Die Richtung wird je Segment bestimmt, nicht aus Start- und Endpunkt der
    ganzen Linie.** Ein Auflager zeichnet oft mehrere Wände in einem Zug nach —
    eine Hausecke etwa als eine Polylinie über die Außenwand und die
    anschließende Giebelwand. Aus Start- und Endpunkt allein verschwindet die
    kürzere der beiden Wände in der insgesamt vorherrschenden Richtung der
    längeren, und der Aussteifungsprüfung fehlt eine Achse, obwohl das Gebäude
    sie hat — genau das Symptom, das ein Grundriss mit Wänden auf allen vier
    Seiten sonst zeigt: „alle aussteifenden Wände halten in x, in y ist das
    Geschoss nicht ausgesteift."
    """
    ergebnis = []
    for lager in modell.auflager:
        if lager["typ"] != "linie":
            continue
        linie = np.asarray(lager["polylinie"], dtype=float)
        mehrteilig = len(linie) > 2
        for i in range(len(linie) - 1):
            a, b = linie[i], linie[i + 1]
            richtung = b - a
            laenge = float(np.linalg.norm(richtung))
            if laenge < 1e-9:
                continue
            einheit = richtung / laenge
            achse = 0 if abs(einheit[0]) >= abs(einheit[1]) else 1
            schraeg = min(abs(einheit[0]), abs(einheit[1])) > 0.25
            kennung = f"{lager['id']}.{i + 1}" if mehrteilig else lager["id"]
            ergebnis.append({"id": kennung, "achse": achse, "laenge_m": laenge,
                             "richtung": einheit, "schraeg": schraeg,
                             "polylinie": np.stack([a, b])})
    return ergebnis


def pruefe_aussteifung(waende: list[dict], toleranz: float = 0.05):
    """
    Die drei Bedingungen an eine Aussteifung — und was passiert, wenn eine fehlt.

    Ein Geschoss ist ausgesteift, wenn die Wandscheiben

    1. in **beiden** Richtungen halten,
    2. mindestens **drei** an der Zahl sind,
    3. und sich ihre Achsen **nicht in einem Punkt schneiden**.

    Die dritte Bedingung ist die, die man übersieht. Zwei Wände über Eck sehen
    nach einer soliden Aussteifung aus, aber das Geschoss kann sich um ihren
    Schnittpunkt drehen: die eine Wand hält nichts gegen eine Bewegung entlang
    ihrer Achse, die andere ebenso wenig, und eine Drehung um den Schnittpunkt
    bewegt jeden Punkt beider Achsen genau in dieser freien Richtung.

    Im Rechenmodell fällt das nicht als Fehlermeldung auf, sondern als
    Ergebnis: die Steifigkeitsmatrix bleibt formal lösbar, die Verschiebungen
    laufen ins Absurde, und die Membrankräfte kommen sechsstellig heraus. Wer
    das für ein Zahlenproblem hält, verfeinert das Netz — und bekommt dasselbe
    noch einmal.

    @raises ValueError wenn die Aussteifung unvollständig ist
    """
    in_x = [w for w in waende if w["achse"] == 0]
    in_y = [w for w in waende if w["achse"] == 1]

    if not in_x or not in_y:
        fehlt = "x" if not in_x else "y"
        raise ValueError(f"Alle aussteifenden Wände halten in derselben Richtung — "
                         f"in {fehlt} ist das Geschoss nicht ausgesteift.")

    # Achslage der Wände: x-haltende liegen auf y = konstant, y-haltende auf x.
    achsen_y = {round(float(w["polylinie"][0][1]), 3) for w in in_x}
    achsen_x = {round(float(w["polylinie"][0][0]), 3) for w in in_y}
    if len(achsen_y) == 1 and len(achsen_x) == 1:
        raise ValueError(
            f"Die Wandachsen schneiden sich in einem Punkt "
            f"({next(iter(achsen_x))} | {next(iter(achsen_y))}) — das Geschoss "
            "kann sich um ihn drehen und ist damit nicht ausgesteift. Eine dritte "
            "Wand außerhalb dieses Punktes aufnehmen.")
    if len(waende) < 3:
        raise ValueError("Weniger als drei Wandscheiben — für eine Aussteifung "
                         "in der Ebene sind drei nötig.")


def randbedingungen(modell: Modell, netz: Netz, aussteifend: list[str] | None = None,
                    toleranz: float | None = None):
    """
    Randbedingungen des Scheibensystems.

    Gehalten wird
    * u_z an allen Lagerlinien — die Decke liegt auf den Wänden,
    * u_x oder u_y an den aussteifenden Wänden, je nach ihrer Achsrichtung.

    `aussteifend` ist die Liste der Auflager-IDs, die als Scheiben wirken.
    Ohne Angabe zählen alle Linienauflager — realistisch für Wandbauten, und
    ein guter Ausgangspunkt: welche Wand wie viel Kraft übernimmt, steht danach
    in der Auflagerbilanz, und daraus sieht man, welche man weglassen kann.

    **Das System ist meist hochgradig überbestimmt.** Das ist kein Mangel: bei
    starrer Deckenscheibe verteilt sich die Windlast nach den Steifigkeiten der
    Wände, und genau das rechnet das Modell — nur eben mit unendlich steifen
    Wänden. Eine Wand mit endlicher Steifigkeit bekäme weniger. Die Rechnung
    liegt für die einzelne Wand also auf der sicheren Seite, solange man nicht
    versucht, aus ihr die Verformung des Gebäudes abzulesen.
    """
    tol = float(toleranz or max(netz.groesse * 0.6, 1e-3))
    # `plate.unterseiten_knoten()` statt eines globalen Minimums: unter einem
    # Unterzug (siehe `plate.vernetze()`) liegt die tatsächliche Unterseite
    # lokal tiefer.
    unten = plate.unterseiten_knoten(netz)
    xy = netz.points[:, :2]

    fest_z = np.zeros(len(netz.points), dtype=bool)
    fest_x = np.zeros(len(netz.points), dtype=bool)
    fest_y = np.zeros(len(netz.points), dtype=bool)

    gewaehlt = []
    for wand in wandrichtungen(modell):
        if aussteifend is not None and wand["id"] not in aussteifend:
            continue
        nahe = abstand_zu_polylinie(xy, wand["polylinie"]) <= tol
        if wand["achse"] == 0:
            fest_x |= nahe
        else:
            fest_y |= nahe
        if wand["schraeg"]:
            plate._merken(modell, f"Aussteifende Wand {wand['id']} verläuft schräg — "
                                  "sie wird auf die nächstgelegene Achse gerundet")
        gewaehlt.append(wand)

    for lager in modell.auflager:
        if lager["typ"] == "punkt":
            nahe = np.linalg.norm(xy - np.asarray(lager["p"], dtype=float), axis=1) <= tol
        else:
            nahe = abstand_zu_polylinie(xy, np.asarray(lager["polylinie"], dtype=float)) <= tol
        fest_z |= nahe & unten

    if not gewaehlt:
        raise ValueError("Keine aussteifende Wand — die Scheibe wäre nicht gehalten. "
                         "Im Plan Linienauflager auf den Wandachsen setzen.")
    pruefe_aussteifung(gewaehlt)

    def macher(maske):
        treffer = netz.points[maske]

        def ort(punkt):
            import jax.numpy as jnp
            return jnp.any(jnp.all(jnp.abs(jnp.asarray(treffer) - punkt) < 1e-8, axis=1))
        return ort

    def null(_punkt):
        return 0.0

    orte, richtungen, werte = [], [], []
    for maske, achse in ((fest_x, 0), (fest_y, 1), (fest_z, 2)):
        if maske.any():
            orte.append(macher(maske))
            richtungen.append(achse)
            werte.append(null)

    bericht = {
        "wände": [w["id"] for w in gewaehlt],
        "in_x_haltend": int(fest_x.sum()), "in_y_haltend": int(fest_y.sum()),
        "senkung_gehalten": int(fest_z.sum()), "toleranz": tol,
    }
    return [orte, richtungen, werte], bericht


# ──────────────────────────────────────────────────────────────────────────
# Auswertung
# ──────────────────────────────────────────────────────────────────────────


def membrankraefte(loesung: np.ndarray, netz: Netz, E: float, nu: float) -> dict:
    """
    Membrankräfte n_x, n_y, n_xy in kN je Meter, Zug positiv.

    Integriert wird über die Dicke — das ist die Definition: n = ∫σ dz, als
    Summe über die Elementlagen also n = Σσ_k·Δz. Der linear veränderliche
    Anteil über die Höhe ist die Plattenbiegung und gehört nicht hierher; er
    fällt beim Aufsummieren von selbst heraus, solange die Lagen symmetrisch
    zur Mittelebene liegen.

    **Nicht „Mittelwert mal Plattendicke".** Für die ebene Platte ist das
    dasselbe, im Streifen eines Unterzugs nicht: dort hat die Säule fünf statt
    zwei Lagen, der Mittelwert wird über alle fünf gebildet und anschließend
    mit der Dicke der *Grundplatte* multipliziert. Die Membrankraft käme
    dadurch um das Verhältnis der Lagenzahlen zu klein heraus — im
    Beispielunterzug (h = 55 cm bei d = 22 cm) um den Faktor 2,5, und zwar
    genau dort, wo die Scheibe ihre Zugkraft konzentriert: der Unterzug ist
    der Gurt des tiefen Trägers.

    `hoehe_m` gibt die tatsächliche Querschnittshöhe je Säule mit zurück —
    daraus wird die Spannung, und nur mit ihr ist die Ausnutzung der
    Druckstrebe im Balkenstreifen richtig.

    @returns dict mit `xy`, `n_x`, `n_y`, `n_xy`, dazu `n_1`, `n_2`, `phi`
             (Hauptkräfte und ihre Richtung), `hoehe_m` und `sigma_max_MNm2`
    """
    mitten, sigma = plate.spannungen(loesung, netz, E, nu)
    schluessel = np.round(mitten[:, :2], 6)
    _, index, umkehr = np.unique(schluessel, axis=0, return_index=True, return_inverse=True)
    umkehr = umkehr.ravel()
    dz = plate.lagenhoehe(netz)

    anzahl = np.zeros(len(index))
    np.add.at(anzahl, umkehr, 1.0)
    hoehe = anzahl * dz                       # tatsächliche Höhe der Säule

    def integriere(komponente):
        summe = np.zeros(len(index))
        np.add.at(summe, umkehr, komponente)
        return summe * dz

    n_x, n_y, n_xy = (integriere(sigma[:, 0, 0]), integriere(sigma[:, 1, 1]),
                      integriere(sigma[:, 0, 1]))
    mitte = (n_x + n_y) / 2.0
    spanne = np.sqrt(((n_x - n_y) / 2.0) ** 2 + n_xy ** 2)

    return {
        "xy": mitten[index][:, :2],
        "n_x": n_x, "n_y": n_y, "n_xy": n_xy,
        "n_1": mitte + spanne, "n_2": mitte - spanne,
        "phi": 0.5 * np.arctan2(2.0 * n_xy, n_x - n_y),
        "hoehe_m": hoehe,
        "sigma_max_MNm2": (mitte + spanne) / np.maximum(hoehe, 1e-9) / 1000.0,
        "im_balken": plate.balkenmaske(netz, umkehr, len(index)),
    }


def wandkraefte(modell: Modell, netz: Netz, reaktionen: np.ndarray,
                aussteifend: list[str] | None = None,
                toleranz: float | None = None) -> list[dict]:
    """
    Die Kräfte, die jede aussteifende Wand aufnimmt — in ihrer Längsrichtung.

    Das ist das eigentliche Ergebnis der Scheibenrechnung: die Wandscheibe
    darunter wird damit bemessen, und die Summe über alle Wände muss die
    angesetzte Horizontallast sein.

    **Die Zuordnung geht nach Richtung, nicht nach Nähe.** An einer
    Gebäudeecke liegt ein Knoten auf zwei Wänden; seine x-Kraft gehört aber
    ausschließlich zu der Wand, die überhaupt in x hält. Teilte man ihn wie
    `plate.auflagerbilanz()` hälftig auf, schriebe man einen Teil der
    Windkraft einer Wand zu, die quer dazu steht — und die Bilanz ginge nicht
    mehr auf. Deshalb wird die x-Komponente nur unter den x-haltenden Wänden
    aufgeteilt und die y-Komponente nur unter den y-haltenden.
    """
    tol = float(toleranz or max(netz.groesse * 0.6, 1e-3))
    xy = netz.points[:, :2]
    R = np.asarray(reaktionen)

    waende = [w for w in wandrichtungen(modell)
              if aussteifend is None or w["id"] in aussteifend]
    masken = [abstand_zu_polylinie(xy, w["polylinie"]) <= tol for w in waende]

    # Wie viele Wände *derselben* Achse greifen auf denselben Knoten zu?
    je_achse = {0: np.zeros(len(xy)), 1: np.zeros(len(xy))}
    for wand, maske in zip(waende, masken):
        je_achse[wand["achse"]] += maske

    ergebnis = []
    for wand, maske in zip(waende, masken):
        achse = wand["achse"]
        teiler = np.where(je_achse[achse] > 0, 1.0 / np.maximum(je_achse[achse], 1), 0.0)
        anteil = maske * teiler
        # Ausgewiesen wird die *gehaltene* Komponente in globaler Richtung, nicht
        # „längs der Wand": das Vorzeichen einer Längsrichtung hinge daran, in
        # welcher Reihenfolge die Polylinie gezeichnet wurde, und zwei parallele
        # Wände bekämen entgegengesetzte Vorzeichen für dieselbe Kraft.
        kraft = float((R[:, achse] * anteil).sum())
        vertikal = float((R[:, 2] * maske / np.maximum(np.where(maske, je_achse[0] + je_achse[1], 1), 1)).sum())
        ergebnis.append({
            "id": wand["id"], "achse": "x" if achse == 0 else "y",
            "laenge_m": wand["laenge_m"],
            "H_kN": kraft,
            "schub_je_m_kNm": kraft / max(wand["laenge_m"], 1e-9),
            "R_z_kN": vertikal,
        })
    return ergebnis


def gesamtkraft(lasten: list[dict]) -> np.ndarray:
    """Resultierende aller Randlasten in kN — die Probe zur Windlast."""
    summe = np.zeros(2)
    for last in lasten:
        summe += float(last["w_kNm"]) * float(last["laenge_m"]) * np.asarray(last["richtung"])[:2]
    return summe


def registriere_lastfall(modell: Modell, kennung: str, name: str, art: str = "W",
                         gamma: float = 1.5, psi0: float = 0.6, psi1: float = 0.2,
                         psi2: float = 0.0, farbe: str = "#16a085") -> dict:
    """
    Einen Lastfall im Modell anmelden, den es im Plan nicht gibt.

    Wind und Schiefstellung werden nicht gezeichnet, sondern gerechnet — für
    `plate.kombinationen()` müssen sie trotzdem als Lastfälle im Modell stehen,
    sonst tauchen sie in keiner Kombination auf. Ein bereits vorhandener
    Lastfall gleicher Kennung wird nicht überschrieben: die Beiwerte aus dem
    Plan haben Vorrang.
    """
    for fall in modell.lastfaelle:
        if fall["id"] == kennung:
            return fall
    fall = {"id": kennung, "name": name, "art": art, "farbe": farbe,
            "gamma": gamma, "psi0": psi0, "psi1": psi1, "psi2": psi2,
            "gerechnet": True}
    modell.daten.setdefault("lastfaelle", []).append(fall)
    return fall
