"""
Aus einem IFC-Geschoss wird ein Statikmodell — im Backend, für die ganze Kette.

Bisher stand diese Ableitung als JavaScript im MCP-Server (`mcp/src/statik-
modell.js`) und war damit nur von dort erreichbar. Der geschossweise Lastabtrag
braucht sie im Backend: er baut je Geschoss ein Modell, rechnet es, nimmt die
Auflagerkräfte und baut damit das Modell des Geschosses darunter. Über HTTP
gegen den eigenen Server zu gehen wäre möglich, aber jeder Durchgang liefe
dann durch die Serialisierung eines vollständigen Schnitts.

## Was abgeleitet und was angenommen wird

Getrennt ausgewiesen, weil der Unterschied im Bericht nachweisrelevant ist:

| | Quelle |
|---|---|
| Deckenumriss | Schnitt durch die `IfcSlab` |
| Deckendicke | Hüllbox der Slab, ersatzweise Property-Set |
| Lage der Wände | Schnitt auf Wandhöhe des Geschosses darunter |
| Wanddicke | Querschnittsfläche und Umfang der Schnittfigur |
| tragend / nichttragend | Material, Materialschichten, Pset — `tragend.py` |
| Betongüte, Ausbau-, Nutzlast | **angenommen** |

## Die Wanddicke ist zweimal etwas anderes

Eine mehrschichtige Außenwand — Verblender, Dämmung, Hintermauerwerk — kommt
als drei Ringe zurück. Für das **Eigengewicht** zählt die Summe aller Schichten,
denn das ist die Masse, die tatsächlich auf der Decke darunter steht. Für den
**Knicknachweis** zählt sie gerade nicht: tragend ist die dickste Einzelschicht,
und wer stattdessen 43 cm einsetzt, wo 17,5 cm tragen, rechnet die Wand um den
Faktor sechs zu steif (die Steifigkeit geht mit t³).

`wandquerschnitt()` gibt deshalb beide Zahlen zurück und benennt sie
verschieden. Die Zuordnung „dickste Schicht = tragende Schicht" trifft bei den
üblichen Aufbauten zu; bei einer 20-cm-Dämmung vor 17,5 cm Mauerwerk trifft sie
nicht, und dann steht die Annahme wenigstens im Protokoll.

## Ein Lager je Wand, in der Wandachse

Eine Wand ergibt **ein** Linienlager, und es liegt auf ihrer Achse — nicht
zwei auf ihren beiden Flächen. Der Unterschied ist nicht kosmetisch: zwei
Lager im Abstand der Wanddicke halten die Decke gegen Verdrehen, die Platte
ist dort eingespannt statt frei drehbar gelagert, und das Stützmoment über
einer 24er Wand fällt entsprechend zu groß aus. Die Achse baut `wandachse()`.

Eine Wand, die eine Tür in zwei Abschnitte teilt, hat zwei Achsen — das sind
zwei Wandstücke, keine zwei Lager derselben Wand.

Stützen laufen über `schwerpunkt()` als Punktlager. Sie über Kanten zu suchen
funktionierte nie: alle vier Kanten einer 30er Stütze sind kürzer als die
Mindestlänge, und sie fielen aus dem Modell, ehe der Punktlagerzweig erreicht
war.

## Vorbemessung

Die Auflager entstehen aus Wandquerschnitten, nicht aus einem Tragwerksmodell.
Welche Wand trägt, entscheidet seit September 2026 `ileen/tragend.py` — zuerst
über das Material, dann über das Property-Set; die Reihenfolge und ihre
Begründung stehen dort. Ein Standsicherheitsnachweis ist das nicht und darf
nicht als solcher ausgegeben werden.

Was daran nicht stimmt, lässt sich nachträglich richtigstellen: `system.py`
nimmt Eingriffe am abgeleiteten System entgegen — ein Lager entfernen, seine
Art ändern, eines hinzufügen —, und die Kette rechnet damit neu.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

from .lastabtrag import (aufbau_wand, mittlere_schichtwichte, pset_zahl, rolle_von,
                         wichte_tragend)
from . import raumlasten as rl
from .tragend import beurteile
from .tragend import materialklasse as materialklasse_von

#: Betongüten wie im Zeichenmodus (`plan-loads.js` MATERIALIEN).
BETON = {
    "C20/25": {"E_Nmm2": 30000, "nu": 0.2, "wichte": 25},
    "C25/30": {"E_Nmm2": 31000, "nu": 0.2, "wichte": 25},
    "C30/37": {"E_Nmm2": 33000, "nu": 0.2, "wichte": 25},
    "C35/45": {"E_Nmm2": 34000, "nu": 0.2, "wichte": 25},
}

#: Nutzlasten nach DIN EN 1991-1-1/NA, Tabelle 6.1DE.
NUTZLASTEN = {
    "A2": (1.5, "Wohn- und Aufenthaltsräume"),
    "A3": (2.0, "Wohnen, Decken mit ausreichender Querverteilung"),
    "B1": (2.0, "Büroflächen"),
    "C1": (3.0, "Flächen mit Tischen"),
    "C3": (5.0, "Frei begehbare Flächen"),
    "D1": (4.0, "Verkaufsräume"),
    "E1": (5.0, "Lagerflächen"),
}

# ── Dach ──────────────────────────────────────────────────────────────────
#
# **Ein Dach ist keine Wohnung.** Bis Oktober 2026 bekam die oberste Decke
# dieselbe Nutzlast wie jede andere — A2, 1,5 kN/m², aus den Räumen des
# obersten Geschosses, die *unter* ihr liegen — und dazu die Ausbaulast
# eines Estrichs. Auf einem Flachdach liegen aber Dachaufbau und Schnee, und
# betreten wird es nur zur Wartung.

#: Kategorie H nach DIN EN 1991-1-1/NA, Tab. 6.10DE: nicht begehbares Dach,
#: Neigung unter 20°. Sie wird **nicht** gleichzeitig mit Schnee angesetzt
#: (EN 1991-1-1, 3.3.2 (1)) — deshalb gibt es auf dem Dach einen
#: veränderlichen Lastfall, und er trägt den größeren der beiden Werte.
DACH_NUTZLAST_H = 1.0
#: Schnee am Boden: Zone 2 bis 285 m ü. NN (DIN EN 1991-1-3/NA), der
#: verbreitetste Wert in Deutschland. Eine Annahme — der Ort setzt ihn.
SCHNEE_SK_VORGABE = 0.85
#: Formbeiwert μ₁ für Dachneigungen bis 30° (DIN EN 1991-1-3, Tab. 5.2).
MU1_FLACHDACH = 0.8
#: Flachdach mit Abdichtung, Dämmung und Kies bzw. extensiver Begrünung.
DACHAUFBAU_VORGABE = 1.5

#: Die beiden veränderlichen Einwirkungen eines Dachs. **Sie bleiben beim
#: Lastabtrag eigene Lastfälle**, anders als die Nutzlast eines Geschosses:
#: Schnee ist eine andere Einwirkung als die Nutzlast darunter, mit eigenem
#: ψ₀ (0,5 bis 1 000 m ü. NN) und ψ₂ = 0 — in den Nutzlastfall gemischt,
#: stünde er mit ψ₂ = 0,3 quasi-ständig in jeder Wand.
LASTFAELLE_DACH = {
    "S": {"id": "S", "name": "Schnee", "art": "Q", "gamma": 1.5,
          "psi0": 0.5, "psi1": 0.2, "psi2": 0.0},
    "H": {"id": "H", "name": "Nutzlast Dach (Kat. H)", "art": "Q", "gamma": 1.5,
          "psi0": 0.0, "psi1": 0.0, "psi2": 0.0},
}


def dachlast(annahmen: dict | None = None) -> tuple[dict, float, str]:
    """Der veränderliche Lastfall eines Dachs: max(Kat. H, μ₁·s_k)."""
    annahmen = annahmen or {}
    sk = float(annahmen.get("schnee_sk_kNm2") or SCHNEE_SK_VORGABE)
    s = MU1_FLACHDACH * sk
    if s >= DACH_NUTZLAST_H:
        return (dict(LASTFAELLE_DACH["S"]), round(s, 3),
                f"Schnee s = μ₁·s_k = {MU1_FLACHDACH}·{sk:.2f} = {s:.2f} kN/m² "
                f"(maßgebend gegenüber Kat. H {DACH_NUTZLAST_H:.1f})")
    return (dict(LASTFAELLE_DACH["H"]), DACH_NUTZLAST_H,
            f"Kategorie H {DACH_NUTZLAST_H:.1f} kN/m² (maßgebend gegenüber Schnee "
            f"μ₁·s_k = {s:.2f}; beide nicht gleichzeitig, EN 1991-1-1 3.3.2)")


# ── Geometrie ─────────────────────────────────────────────────────────────


def flaeche(punkte) -> float:
    """Fläche eines Polygons (Gauß'sche Trapezformel), Vorzeichen egal."""
    s = 0.0
    n = len(punkte)
    for i in range(n):
        x1, y1 = punkte[i]
        x2, y2 = punkte[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def umfang(punkte) -> float:
    """Umfang eines geschlossenen Polygonzugs."""
    s = 0.0
    n = len(punkte)
    for i in range(n):
        x1, y1 = punkte[i]
        x2, y2 = punkte[(i + 1) % n]
        s += math.hypot(x2 - x1, y2 - y1)
    return s


def banddicke(a: float, u: float) -> float:
    """
    Dicke eines langen dünnen Bandes aus Fläche und Umfang.

    Für ein Rechteck L × t gilt A = L·t und U = 2(L+t); Auflösen nach t ergibt

        t = U/4 − √((U/4)² − A)

    Das ist exakt für gerade Wandstücke **und** für umlaufende Wandbänder, bei
    denen der Ring aus Außen- und Innenkante besteht — dort ist U ≈ 2·U_mittel
    und A ≈ U_mittel·t, und die Formel trifft ebenfalls. Genau das ist der
    Fall, an dem die naive Rechnung „Fläche durch längste Kante" scheitert:
    bei einer umlaufenden Außenwand ist die längste Kante ein beliebiges
    Teilstück, und die Dicke käme um ein Vielfaches zu groß heraus.

    Wird die Wurzel negativ — bei einer gedrungenen Figur, die kein Band ist —,
    bleibt der Mittelwert A/(U/2) als Notbehelf.
    """
    q = u / 4.0
    d = q * q - a
    return q - math.sqrt(d) if d >= 0 else (a / (u / 2.0) if u > 1e-9 else 0.0)


def punkt_in_polygon(punkt, polygon) -> bool:
    """Strahlverfahren — genügt hier, die Ringe sind einfach und geschlossen."""
    x, y = punkt
    drin = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-30) + xi:
            drin = not drin
        j = i
    return drin


def ringgruppen(rings) -> list[dict]:
    """
    Ringe zu Flächen mit Löchern gruppieren.

    **Der Fall, der das nötig macht.** Eine umlaufende Außenwand kommt aus dem
    Schnitt als *zwei* Ringe zurück: der äußere Gebäudeumriss und der innere
    als Loch. Beide sind für sich genommen gedrungene Rechtecke, und die
    Bandformel auf einen davon angewandt liefert die halbe Gebäudebreite als
    „Wanddicke" — bei einem 10 × 8-m-Haus also 8 m statt 24 cm. Erst die
    Differenz ist das Band: Fläche außen minus Fläche innen, Umfang außen plus
    Umfang innen.

    Maßgebend ist die **Verschachtelungstiefe**, nicht bloß „liegt in einem
    größeren Ring". Eine Betonwand mit vorgesetzter Dämmung, beide umlaufend,
    ergibt vier ineinanderliegende Ringe: Dämmung außen (Tiefe 0), Dämmung
    innen (1), Beton außen (2), Beton innen (3). Wer alle drei inneren als
    Löcher des äußersten zählt, zieht 232 m² von 87 m² ab und bekommt eine
    negative Fläche. Richtig ist: gerade Tiefe beginnt eine neue Fläche,
    ungerade Tiefe ist ein Loch der Fläche unmittelbar darüber.

    Der Elter eines Rings ist der *kleinste* ihn umschließende Ring — der Test
    über einen einzelnen Punkt genügt, weil sich Schnittringe desselben
    Bauteils nicht überschneiden.

    Nebeneinanderliegende Ringe — die Schichten eines geraden Wandaufbaus —
    haben alle die Tiefe 0 und bleiben getrennte Flächen. Das ist der
    Unterschied, auf den es ankommt: Schichten addieren sich in der Dicke, ein
    Loch nicht.
    """
    kandidaten = []
    for ring in rings or []:
        if not ring or len(ring) < 3:
            continue
        a = flaeche(ring)
        if a < 1e-9:
            continue
        kandidaten.append({"ring": ring, "a": a, "u": umfang(ring),
                           "tiefe": 0, "loecher": []})
    if not kandidaten:
        return []

    # Größte zuerst — der Elter eines Rings ist immer schon eingeordnet.
    kandidaten.sort(key=lambda k: k["a"], reverse=True)
    for i, k in enumerate(kandidaten):
        probe = k["ring"][0]
        # Der kleinste umschließende der bereits eingeordneten Ringe.
        umschliessend = [v for v in kandidaten[:i]
                         if punkt_in_polygon(probe, v["ring"])]
        if not umschliessend:
            continue
        elter = min(umschliessend, key=lambda v: v["a"])
        k["tiefe"] = elter["tiefe"] + 1
        if k["tiefe"] % 2 == 1:
            elter["loecher"].append(k)

    return [{"flaeche_m2": k["a"] - sum(l["a"] for l in k["loecher"]),
             "umfang_m": k["u"] + sum(l["u"] for l in k["loecher"]),
             "loecher": len(k["loecher"]),
             # Die Ringe selbst wandern mit: `wandachse()` braucht die
             # Geometrie *einer* Schicht, nicht nur deren Kennzahlen.
             "ringe": [k["ring"]] + [l["ring"] for l in k["loecher"]]}
            for k in kandidaten if k["tiefe"] % 2 == 0]


def wandquerschnitt(rings) -> dict:
    """
    Dicke, Länge und Fläche eines geschnittenen Wandquerschnitts.

    @returns dict mit
        `dicke_tragend_m`  dickste Einzelschicht — für den Knicknachweis
        `dicke_gesamt_m`   Summe aller Schichten — für das Eigengewicht
        `flaeche_m2`       Gesamtquerschnittsfläche (netto, ohne Löcher)
        `laenge_m`         Länge der Wand, aus Fläche und Gesamtdicke
        `schichten`        Dicke je Schicht, absteigend
    """
    teile = []
    flaeche_gesamt = 0.0
    loecher = 0
    for gruppe in ringgruppen(rings):
        a, u = gruppe["flaeche_m2"], gruppe["umfang_m"]
        if a < 1e-6 or u < 1e-6:
            continue
        t = banddicke(a, u)
        if t < 1e-6:
            continue
        flaeche_gesamt += a
        loecher += gruppe["loecher"]
        teile.append({"t": t, "l": a / t})

    if not teile:
        return {"dicke_tragend_m": 0.0, "dicke_gesamt_m": 0.0, "flaeche_m2": 0.0,
                "laenge_m": 0.0, "schichten": [], "mehrschichtig": False,
                "geschlossen": False}

    # **Schichten oder Abschnitte?** Zwei Teilflächen können zweierlei sein:
    # Schichten desselben Aufbaus, die quer nebeneinanderliegen und sich in der
    # Dicke addieren — oder Abschnitte derselben Wand, die eine Tür trennt und
    # deren Längen sich addieren. Die Unterscheidung ist nicht kosmetisch: im
    # ersten Fall ist die Wand 43 cm dick und 5 m lang, im zweiten 24 cm dick
    # und 10 m lang, und ein Nachweis mit der jeweils falschen Zahl ist wertlos.
    #
    # Unterschieden wird an der Dicke: Abschnitte derselben Wand sind gleich
    # dick, Schichten eines Aufbaus in aller Regel nicht (11,5 Verblender,
    # 14 Dämmung, 17,5 Mauerwerk). Teile innerhalb von 15 % gelten deshalb als
    # Abschnitte und werden in der Länge zusammengezählt, alles Übrige als
    # Schicht.
    #
    # Die Grenze dieser Regel: ein Aufbau aus zwei gleich dicken Schichten
    # (11,5 + 11,5) wird als zwei Abschnitte gelesen. Die Querschnittsfläche —
    # und damit das Eigengewicht — bleibt in jedem Fall richtig, weil sie
    # unabhängig von dieser Deutung aus den Ringen kommt; falsch würde nur die
    # Aufteilung in Länge und Dicke.
    teile.sort(key=lambda x: x["t"], reverse=True)
    cluster: list[dict] = []
    for teil in teile:
        passend = next((c for c in cluster
                        if abs(c["t"] - teil["t"]) <= 0.15 * max(c["t"], teil["t"])), None)
        if passend:
            passend["l"] += teil["l"]
            passend["n"] += 1
        else:
            cluster.append({"t": teil["t"], "l": teil["l"], "n": 1})

    schichten = [round(c["t"], 4) for c in cluster]
    gesamt = sum(c["t"] for c in cluster)
    # Die Länge ist die der **tragenden** Schicht, nicht die längste. Bei einer
    # umlaufenden Wand mit außenliegender Dämmung hat die Dämmschale den
    # größeren Mittelumfang — 36,4 m gegenüber 35,0 m der Betonschale. Für die
    # Linienlast, mit der die tragende Schicht nachgewiesen wird, zählt deren
    # eigene Länge; `cluster` ist nach Dicke sortiert, das erste Element ist
    # also die tragende Schicht.
    laenge = cluster[0]["l"]

    return {
        "dicke_tragend_m": round(cluster[0]["t"], 4),
        "dicke_gesamt_m": round(gesamt, 4),
        "flaeche_m2": round(flaeche_gesamt, 4),
        "laenge_m": round(laenge, 3),
        "schichten": schichten,
        "mehrschichtig": len(cluster) > 1,
        "geschlossen": loecher > 0,
        "abschnitte": max(c["n"] for c in cluster),
    }


def _ring_vereinfachen(ring, toleranz: float = 0.005) -> list:
    """
    Doppelte und kollineare Zwischenpunkte eines Rings entfernen.

    Ein Schnitt knapp unter der Decke liefert eine Wand über Fenstern als ein
    Rechteck — aber mit einem Punkt an jeder Stelle, an der unten eine Öffnung
    beginnt oder endet (SampleHouse: 26 Punkte auf vier Kanten). Die Kanten
    dazwischen sind kürzer als die Mindestlänge, und `auflagerlinien()` brach
    den Zug an ihnen ab: die Achse wurde ein Stück der Wand, an der falschen
    Fläche.
    """
    punkte = [list(p) for p in ring or []]
    if len(punkte) > 1 and math.hypot(punkte[0][0] - punkte[-1][0],
                                      punkte[0][1] - punkte[-1][1]) < 1e-9:
        punkte = punkte[:-1]
    geaendert = True
    while geaendert and len(punkte) > 3:
        geaendert = False
        n = len(punkte)
        for i in range(n):
            a, b, c = punkte[i - 1], punkte[i], punkte[(i + 1) % n]
            if math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9:
                del punkte[i]
                geaendert = True
                break
            q, d = _punkt_auf_strecke(b, a, c)
            if d < toleranz and min(math.hypot(q[0] - a[0], q[1] - a[1]),
                                    math.hypot(q[0] - c[0], q[1] - c[1])) > 1e-9:
                del punkte[i]
                geaendert = True
                break
    return punkte


def auflagerlinien(rings, mindest_laenge: float = 0.8) -> list[dict]:
    """
    Die tragenden Kantenzüge einer Wandfigur — die Vorstufe der Achse.

    Nicht mehr die Auflager selbst: `wandachse()` mittelt aus diesen Zügen die
    Wandachse, und die ist das Lager. Hier entsteht nur der Rohstoff dafür —
    je Wandfläche ein zusammenhängender Zug.

    **Warum nicht die Wandachse.** Eine geschnittene Wand kommt nicht als ein
    Rechteck zurück, sondern als mehrere Ringe — einer je Schicht des Aufbaus.
    `rings[0]` ist eine einzelne Schicht, und „Fläche durch Länge" ergäbe deren
    Dicke statt der Wanddicke. Bei einer umlaufenden Außenwand mit Öffnungen
    kommt zusätzlich ein Polygon mit vielen Ecken heraus, dessen längste Kante
    nur einen Bruchteil der Wandlänge misst.

    **Was stattdessen zählt.** Die Decke liegt auf der Wandfläche auf, nicht auf
    einer gedachten Achse. Genommen werden deshalb alle hinreichend langen
    Kanten aller Ringe, aufeinanderfolgende zu einem Zug verbunden — damit aus
    einer umlaufenden Außenwand ein durchgehendes Linienlager wird und nicht
    ein Dutzend Stummel.
    """
    linien = []
    for ring in rings or []:
        ring = _ring_vereinfachen(ring)
        if not ring or len(ring) < 3:
            continue
        zug: list = []
        n = len(ring)
        for i in range(n):
            a = ring[i]
            b = ring[(i + 1) % n]
            if math.hypot(b[0] - a[0], b[1] - a[1]) >= mindest_laenge:
                if not zug:
                    zug.append(list(a))
                zug.append(list(b))
            else:
                if len(zug) >= 2:
                    linien.append(zug)
                zug = []
        if len(zug) >= 2:
            linien.append(zug)

    ergebnis = []
    for punkte in linien:
        laenge = sum(math.hypot(punkte[i + 1][0] - punkte[i][0],
                                punkte[i + 1][1] - punkte[i][1])
                     for i in range(len(punkte) - 1))
        ergebnis.append({"punkte": punkte, "laenge": laenge})
    return ergebnis


def schwerpunkt(rings) -> list[float] | None:
    """
    Der Flächenschwerpunkt einer Schnittfigur — der Ort einer Stütze.

    Über das Flächenintegral, nicht als Mittel der Eckpunkte: eine Figur mit
    dicht gesetzten Punkten an einer Seite — jede aus einem Bogen entstandene
    Rundstütze — zöge den Punktmittelwert dorthin.
    """
    ring = next((r for r in (rings or []) if r and len(r) >= 3), None)
    if ring is None:
        return None
    a = cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        kreuz = x1 * y2 - x2 * y1
        a += kreuz
        cx += (x1 + x2) * kreuz
        cy += (y1 + y2) * kreuz
    if abs(a) < 1e-12:
        return [round(sum(p[0] for p in ring) / n, 4),
                round(sum(p[1] for p in ring) / n, 4)]
    return [round(cx / (3.0 * a), 4), round(cy / (3.0 * a), 4)]


def _punkt_auf_strecke(p, a, b):
    """Der nächste Punkt der Strecke a–b zu p, samt Abstand."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    laenge2 = dx * dx + dy * dy
    if laenge2 < 1e-18:
        return list(a), math.hypot(p[0] - a[0], p[1] - a[1])
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / laenge2
    t = max(0.0, min(1.0, t))
    q = [a[0] + t * dx, a[1] + t * dy]
    return q, math.hypot(p[0] - q[0], p[1] - q[1])


def _gegenpunkt(p, zuege, nah: float, fern: float):
    """
    Der nächste Punkt auf der **gegenüberliegenden** Wandfläche.

    Das Abstandsfenster ist der ganze Trick. Ohne es fände die Suche den
    kollinearen Nachbarn derselben Fläche im Abstand null — ein Kantenzug wird
    an jeder kurzen Kante getrennt, und ein Wandende teilt die lange Kante in
    zwei Stücke, die sich gegenseitig „gegenüberliegen" würden. Gesucht ist
    darum nur, was ungefähr eine Wanddicke entfernt liegt.
    """
    bester, abstand = None, None
    for zug in zuege:
        for i in range(len(zug) - 1):
            q, d = _punkt_auf_strecke(p, zug[i], zug[i + 1])
            if d < nah or d > fern:
                continue
            if abstand is None or d < abstand:
                bester, abstand = q, d
    return bester


def wandachse(rings, mindest_laenge: float = 0.8) -> list[dict]:
    """
    Die Achse einer Wand — **ein** Linienlager, nicht zwei.

    **Warum das die Auflagerlinien ersetzt.** `auflagerlinien()` gibt jede
    hinreichend lange Kante zurück; eine gerade Wand hat davon zwei — die
    beiden Wandflächen —, und beide wurden als eigenes Linienlager angesetzt.
    Das ist geometrisch die Wand und statisch etwas anderes: zwei Lager im
    Abstand der Wanddicke halten die Decke gegen Verdrehen, die Platte ist
    dort eingespannt statt frei drehbar gelagert, und das Stützmoment über
    einer 24er Wand fällt entsprechend zu groß aus. Eine Wand trägt als eine
    Linie, und diese Linie ist ihre Achse.

    **Wie die Achse entsteht.** Aus der tragenden Schicht — bei einem
    mehrschaligen Aufbau der Ringgruppe mit der größten Banddicke, denn auf
    ihr liegt die Decke auf. Deren längster Kantenzug führt, und zu jedem
    seiner Punkte wird der nächste Punkt der gegenüberliegenden Fläche
    gesucht; die Mitte beider ist ein Achspunkt. Das trifft die gerade Wand
    ebenso wie die umlaufende Außenwand, deren Innen- und Außenring auf diese
    Weise zu einem umlaufenden Achszug verschmelzen — auch über Ecken, wo die
    Mitte zwischen Außen- und Innenecke gerade die Achsecke ist.

    Findet ein Punkt keine Gegenfläche — bei einer Wand, deren zweite Fläche
    von Öffnungen zerlegt ist —, wird er um die mittlere Versetzung der
    übrigen Punkte verschoben. Findet *kein* Punkt eine, wird der ganze Zug um
    die halbe Dicke zum Schwerpunkt der Figur hin versetzt.

    @returns Liste mit in aller Regel genau einem `{punkte, laenge}`
    """
    bewertet = [(banddicke(g["flaeche_m2"], g["umfang_m"]), g)
                for g in ringgruppen(rings)
                if g["flaeche_m2"] > 1e-6 and g["umfang_m"] > 1e-6]
    bewertet = [(t, g) for t, g in bewertet if t > 1e-6]
    if not bewertet:
        return []
    # **Schichten sind eine Wand, Abschnitte sind mehrere.** Dieselbe
    # Unterscheidung wie in `wandquerschnitt()`, und aus demselben Grund: eine
    # Tür teilt die Wand in zwei gleich dicke Stücke, die beide tragen und
    # beide ein Lager brauchen — ein Aufbau aus drei verschieden dicken
    # Schichten ist dagegen eine Wand mit einer Achse. Maßgebend ist die
    # dickste Schicht; alles, was innerhalb von 15 % ebenso dick ist, gilt als
    # weiterer Abschnitt derselben Schicht.
    dicke = max(t for t, _ in bewertet)
    abschnitte = [g for t, g in bewertet if abs(t - dicke) <= 0.15 * dicke]

    ergebnis = []
    for gruppe in abschnitte:
        eine = _achse_einer_gruppe(gruppe, dicke, mindest_laenge)
        if eine:
            ergebnis.append(eine)
    return ergebnis


def _achse_einer_gruppe(gruppe, dicke: float, mindest_laenge: float) -> dict | None:
    """Die Achse eines zusammenhängenden Wandabschnitts."""
    zuege = auflagerlinien(gruppe["ringe"], mindest_laenge)
    if not zuege:
        return None
    zuege.sort(key=lambda z: z["laenge"], reverse=True)
    leit = zuege[0]["punkte"]
    gegen = [z["punkte"] for z in zuege[1:]]

    versatz: list[list[float] | None] = []
    for p in leit:
        q = _gegenpunkt(p, gegen, 0.35 * dicke, 3.0 * dicke)
        versatz.append([(q[0] - p[0]) / 2.0, (q[1] - p[1]) / 2.0] if q else None)

    gefunden = [v for v in versatz if v is not None]
    if gefunden:
        mittel = [sum(v[0] for v in gefunden) / len(gefunden),
                  sum(v[1] for v in gefunden) / len(gefunden)]
    else:
        mittel = _versatz_zum_schwerpunkt(leit, gruppe["ringe"], dicke)

    punkte: list[list[float]] = []
    for p, v in zip(leit, versatz):
        w = v if v is not None else mittel
        neu = [round(p[0] + w[0], 4), round(p[1] + w[1], 4)]
        if punkte and math.hypot(neu[0] - punkte[-1][0], neu[1] - punkte[-1][1]) < 1e-4:
            continue
        punkte.append(neu)
    if len(punkte) < 2:
        return None

    laenge = sum(math.hypot(punkte[i + 1][0] - punkte[i][0],
                            punkte[i + 1][1] - punkte[i][1])
                 for i in range(len(punkte) - 1))
    if laenge < 1e-6:
        return None
    return {"punkte": punkte, "laenge": laenge}


def _versatz_zum_schwerpunkt(leit, ringe, dicke: float) -> list[float]:
    """
    Halbe Dicke quer zum Kantenzug, zur Figur hin.

    Der Notfall für den Zug ohne Gegenfläche. Die Richtung entscheidet der
    Schwerpunkt: er liegt innerhalb des Querschnitts, die Kante auf seinem
    Rand — die Senkrechte, die zu ihm zeigt, weist ins Wandinnere.
    """
    mitte = schwerpunkt(ringe) or [0.0, 0.0]
    a, b = leit[0], leit[-1] if len(leit) > 1 else leit[0]
    dx, dy = b[0] - a[0], b[1] - a[1]
    laenge = math.hypot(dx, dy)
    if laenge < 1e-9:
        return [0.0, 0.0]
    nx, ny = -dy / laenge, dx / laenge
    zx = mitte[0] - (a[0] + b[0]) / 2.0
    zy = mitte[1] - (a[1] + b[1]) / 2.0
    if nx * zx + ny * zy < 0:
        nx, ny = -nx, -ny
    return [nx * dicke / 2.0, ny * dicke / 2.0]


# ── Modellbau ─────────────────────────────────────────────────────────────


#: Wie weit zwei Achsenden auseinanderliegen dürfen, um noch als dieselbe
#: Wand zu gelten. Fünf Zentimeter: das deckt Rundungen und Fugen ab, aber
#: keine Öffnung — siehe `lager_zusammenfuehren()`.
STOSS_TOLERANZ_M = 0.05

#: Wie stark zwei Achsen an der Stoßstelle von der Geraden abweichen dürfen.
STOSS_WINKEL_GRAD = 5.0


def _richtung(a, b) -> tuple[float, float] | None:
    """Einheitsvektor von a nach b, oder None bei Länge null."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    laenge = math.hypot(dx, dy)
    if laenge < 1e-9:
        return None
    return (dx / laenge, dy / laenge)


def _kollinear(r1, r2, grad: float) -> bool:
    """Zeigen zwei Einheitsvektoren in dieselbe Richtung (bis auf `grad`)?"""
    if r1 is None or r2 is None:
        return False
    # Nur dieselbe Richtung, nicht die entgegengesetzte: die Polylinien werden
    # vor dem Vergleich so gedreht, dass A auf B zuläuft. Ließe man −1 zu,
    # verschmölze eine Wand mit sich selbst zurücklaufend.
    return math.cos(math.radians(grad)) <= (r1[0] * r2[0] + r1[1] * r2[1])


def lager_zusammenfuehren(auflager: list[dict], *,
                          toleranz_m: float = STOSS_TOLERANZ_M,
                          winkel_grad: float = STOSS_WINKEL_GRAD) -> list[dict]:
    """
    Linienlager verschmelzen, die geometrisch eine durchgehende Wand sind.

    **Warum das nötig ist.** Ob eine 12 m lange Wand im IFC ein Bauteil ist
    oder fünf, entscheidet das Autorenwerkzeug und die Arbeitsweise des
    Modellierers — nicht die Statik. Revit legt an jeder Raumgrenze ein neues
    Wandobjekt an, ArchiCAD an jedem Materialwechsel. Aus fünf Bauteilen wurden
    hier bisher fünf Lager, und das ist statisch etwas anderes als eines:
    kurze, steife Lager ziehen Kraft an, benachbarte heben ab. Der
    Zwanganteil, den `kette._lagerguete()` misst, stammt zu einem guten Teil
    aus dieser Zerstückelung.

    **Verschmolzen wird nur, was aneinanderstößt.** Die Toleranz ist fünf
    Zentimeter — sie deckt Rundungen und Fugen ab, nicht aber eine Öffnung.
    Eine Tür teilt die Wand weiterhin in zwei Abschnitte mit je eigenem Lager.
    Das ist konservativ und bewusst: über einer Tür trägt ein Sturz, und der
    trägt anders als die Wand daneben. Ein Modellierungszufall ist die
    Zerstückelung, eine Tür ist es nicht.

    **Die Kraftaufteilung wandert mit.** Ein verschmolzenes Lager trägt
    `bauteil_anteile` — GlobalId → Achslänge. Ohne das teilte
    `lastabtrag.aus_auflagerbilanz()` die Auflagerkraft gleichmäßig auf alle
    beteiligten Bauteile, und ein 2-m-Stück bekäme so viel wie ein 12-m-Stück.

    Punktlager bleiben unberührt: eine Stütze ist eine Stütze.

    @returns dieselbe Liste, verschmolzene Einträge zusammengefasst, `id` neu
             durchnummeriert
    """
    linien = [a for a in auflager if a.get("typ") == "linie" and a.get("polylinie")]
    andere = [a for a in auflager if a not in linien]

    # Jede Linie bekommt ihre Anteilstabelle, auch wenn sie allein bleibt —
    # sonst müsste jeder Leser zwei Fälle unterscheiden.
    for a in linien:
        if "bauteil_anteile" not in a:
            a["bauteil_anteile"] = {gid: float(a.get("_laenge") or 0.0)
                                    for gid in (a.get("bauteile") or []) if gid}

    verschmolzen = True
    while verschmolzen:
        verschmolzen = False
        for i in range(len(linien)):
            for j in range(len(linien)):
                if i == j:
                    continue
                vereint = _stossen(linien[i], linien[j], toleranz_m, winkel_grad)
                if vereint is None:
                    continue
                linien[i] = vereint
                linien.pop(j)
                verschmolzen = True
                break
            if verschmolzen:
                break

    # Die Kennungen neu vergeben: `A1`, `A2`, … zählen die Lager des fertigen
    # Systems, und nach dem Verschmelzen sind es andere.
    ergebnis = andere + linien
    for nr, eintrag in enumerate(ergebnis, start=1):
        if not str(eintrag.get("id", "")).startswith("E"):
            eintrag["id"] = f"A{nr}"
    return ergebnis


def _stossen(a: dict, b: dict, toleranz_m: float, winkel_grad: float) -> dict | None:
    """
    Stoßen zwei Lagerlinien geradlinig aneinander? Dann das vereinte zurück.

    Geprüft werden alle vier Enden-Paarungen; die Polylinien werden dafür so
    gedreht, dass a auf b zuläuft. Eine Ecke — zwei Wände im rechten Winkel —
    scheitert an der Winkelprüfung und bleibt zwei Lager, wie es richtig ist.
    """
    # Art und Federsteifigkeit müssen übereinstimmen: ein gelenkiges und ein
    # eingespanntes Lager zu einem zu machen wäre eine stille Entscheidung
    # darüber, welches von beiden gilt.
    if (a.get("art") != b.get("art")
            or a.get("federsteifigkeit_kNm2") != b.get("federsteifigkeit_kNm2")):
        return None

    pa, pb = list(a["polylinie"]), list(b["polylinie"])
    if len(pa) < 2 or len(pb) < 2:
        return None

    for a_umdrehen in (False, True):
        for b_umdrehen in (False, True):
            za = list(reversed(pa)) if a_umdrehen else pa
            zb = list(reversed(pb)) if b_umdrehen else pb
            if math.dist(za[-1], zb[0]) > toleranz_m:
                continue
            if not _kollinear(_richtung(za[-2], za[-1]),
                              _richtung(zb[0], zb[1]), winkel_grad):
                continue
            # Der doppelte Stoßpunkt fällt weg; er ist derselbe Ort.
            punkte = za + zb[1:]
            anteile = dict(a.get("bauteil_anteile") or {})
            for gid, laenge in (b.get("bauteil_anteile") or {}).items():
                anteile[gid] = anteile.get(gid, 0.0) + laenge
            vereint = dict(a)
            vereint["polylinie"] = punkte
            vereint["_laenge"] = round(
                sum(math.dist(punkte[k], punkte[k + 1])
                    for k in range(len(punkte) - 1)), 3)
            vereint["bauteile"] = sorted({*(a.get("bauteile") or []),
                                          *(b.get("bauteile") or [])})
            vereint["bauteil_anteile"] = anteile
            if a.get("breite_m") or b.get("breite_m"):
                vereint["breite_m"] = max(float(a.get("breite_m") or 0.0),
                                          float(b.get("breite_m") or 0.0))
            return vereint
    return None


def _nutzlastflaechen(raeume, umriss, oeffnungen, vorgabe: str,
                      vorgabe_wert: float,
                      ueberschrieben: dict) -> tuple[list[dict], list[dict]]:
    """
    Die Nutzlastflächen einer Decke: je Raum eine, plus die Restfläche.

    **Warum eine Restfläche.** Die Räume decken den Deckenumriss nie
    vollständig ab — Wandquerschnitte liegen dazwischen, Schächte haben keinen
    IfcSpace, und in vielen Modellen sind Nebenflächen gar nicht als Raum
    geführt. Ohne die Restfläche fehlte dort jede Nutzlast, und der Fehlbetrag
    wäre unsichtbar: die Rechnung liefe durch, die Erhaltungsprobe stimmte (sie
    prüft, ob die Auflagerkräfte zur *angesetzten* Last passen), und nur die
    Bemessung fiele zu günstig aus.

    Die Restfläche ist deshalb `Umriss − Öffnungen − alle Raumflächen` und
    bekommt die Vorgabekategorie. Die Summe aller Teilflächen ist damit genau
    die Systemfläche.

    **Warum die Räume voneinander abgezogen werden.** Zwei Raumfiguren können
    sich überlappen — bei einem Raum, der über zwei Geschosse geht, oder wenn
    ein Modell Räume grob abgegrenzt hat. Aufeinandergelegt käme dort die
    Nutzlast doppelt an. Jeder Raum wird deshalb um die bereits vergebenen
    Flächen vermindert; der erste in der Liste gewinnt, und weil sortiert wird,
    ist das der größte.

    @returns (Flächen für das Modell, Protokoll für den Bericht)
    """
    from shapely.geometry import MultiPolygon, Polygon
    from shapely.ops import unary_union

    def figur(ringe_aussen, loecher=()):
        try:
            p = Polygon(ringe_aussen, [l for l in loecher if len(l) >= 3])
            return p if p.is_valid else p.buffer(0)
        except Exception:
            return None

    decke_flaeche = figur(umriss, oeffnungen)
    if decke_flaeche is None or decke_flaeche.is_empty:
        # Ohne verwertbaren Umriss bleibt es bei der pauschalen Nutzlast. Das
        # ist der alte Zustand und hier der einzig mögliche.
        return ([{"polygon": umriss, "kategorie": vorgabe,
                  "q_k_kNm2": vorgabe_wert, "name": None, "nutzung": None,
                  "global_id": "", "herkunft": "Vorgabe — Umriss nicht verwertbar"}],
                [])

    zuordnung = rl.raumlasten(raeume or [], vorgabe=vorgabe,
                              ueberschrieben=ueberschrieben)
    # Größte zuerst: bei einer Überlappung soll der größere Raum seine Fläche
    # behalten und der kleinere den Rest bekommen — nicht umgekehrt, sonst
    # zerschnitte ein Schacht das Zimmer, in dem er steht.
    zuordnung.sort(key=lambda z: -(figur(z["polygon"], z["loecher"]).area
                                   if z["polygon"] else 0.0))

    flaechen: list[dict] = []
    protokoll: list[dict] = []
    vergeben = None

    for eintrag in zuordnung:
        if eintrag["ohne_geometrie"]:
            protokoll.append({**{k: v for k, v in eintrag.items()
                                 if k not in ("polygon", "loecher")},
                              "flaeche_m2": 0.0,
                              "hinweis": "Ohne Grundrissfigur — die Fläche "
                                         "dieses Raums läuft in der Restfläche "
                                         "mit der Vorgabekategorie."})
            continue

        form = figur(eintrag["polygon"], eintrag["loecher"])
        if form is None or form.is_empty:
            continue
        # Auf die Decke beschneiden: ein Raum kann über die gerechnete Platte
        # hinausragen, wenn das Geschoss aus zwei Baukörpern besteht.
        form = form.intersection(decke_flaeche)
        if vergeben is not None:
            form = form.difference(vergeben)
        if form.is_empty or form.area < 1e-6:
            continue
        vergeben = form if vergeben is None else unary_union([vergeben, form])

        teile = form.geoms if isinstance(form, MultiPolygon) else [form]
        for teil in teile:
            if not isinstance(teil, Polygon) or teil.area < 1e-6:
                continue
            flaechen.append({
                **{k: v for k, v in eintrag.items() if k != "loecher"},
                "polygon": [[round(x, 4), round(y, 4)]
                            for x, y in teil.exterior.coords],
                # **Die Löcher gehören an die Last, obwohl `plate` sie nicht
                # liest.** Für die Rechnung genügt der Außenring: über einer
                # Öffnung hat das Netz keine Elemente (siehe `vernetze()`), und
                # eine Flächenlast trifft dort nichts. Für die **Zeichnung**
                # genügt er nicht — sonst läge im Plan eine Nutzlastschraffur
                # über dem Treppenauge, und der Plan behauptete etwas, was die
                # Rechnung nicht tut.
                "loecher": [[[round(x, 4), round(y, 4)] for x, y in ring.coords]
                            for ring in teil.interiors],
            })
        protokoll.append({**{k: v for k, v in eintrag.items()
                             if k not in ("polygon", "loecher")},
                          "flaeche_m2": round(form.area, 2)})

    rest = decke_flaeche if vergeben is None else decke_flaeche.difference(vergeben)
    if not rest.is_empty and rest.area > 1e-6:
        teile = rest.geoms if isinstance(rest, MultiPolygon) else [rest]
        for teil in teile:
            if not isinstance(teil, Polygon) or teil.area < 1e-6:
                continue
            flaechen.append({
                "polygon": [[round(x, 4), round(y, 4)]
                            for x, y in teil.exterior.coords],
                "loecher": [[[round(x, 4), round(y, 4)] for x, y in ring.coords]
                            for ring in teil.interiors],
                "kategorie": vorgabe, "q_k_kNm2": vorgabe_wert,
                "name": "Restfläche", "nutzung": None, "global_id": "",
                "herkunft": "Vorgabe — nicht von einem Raum abgedeckt",
            })
        protokoll.append({
            "global_id": "", "name": "Restfläche", "nutzung": None,
            "kategorie": vorgabe, "q_k_kNm2": vorgabe_wert,
            "herkunft": "Vorgabe — nicht von einem Raum abgedeckt",
            "flaeche_m2": round(rest.area, 2),
        })

    return flaechen, protokoll


#: Größte Querschnittsfläche eines Ständers, m² (16/24 cm = 0,038).
STAENDER_HOECHSTFLAECHE_M2 = 0.06


def staender_in_waenden(waende: dict, *, boxen: dict, psets: dict,
                        tragend_vorgabe: dict | None = None, pset_vertrauen: bool = True,
                        bereich: tuple | None = None) -> dict[str, str]:
    """
    Stützen, die Ständer einer tragenden Wand sind — Ständer-GlobalId → Wand-GlobalId.

    Holzbau-Berechnungsmodelle führen die Ständer einer Holzständerwand als
    eigene `IfcColumn` neben der Wand (VA3: 214 Ständer 16/8 in 33 Wänden).
    Trägt die Wand selbst (`LoadBearing`), lag die Decke auf der Wandachse
    **und** auf jedem Ständer daneben: doppelt gelagert, die Kraft zufällig
    zwischen Wand und Ständern verteilt, 19 von 81 Lagern hoben ab. Ein Ständer
    ist ein Teil der Wand — er wird kein eigenes Lager, sein Gewicht geht an
    sie.

    Ständer: Holz oder Stahl (oder ohne Werkstoff bis 0,03 m²), höchstens
    `STAENDER_HOECHSTFLAECHE_M2`, Schwerpunkt im Querschnitt einer tragenden
    Wand — und mindestens zwei in derselben Wand. Eine einzelne Stütze in einer
    Wand (Stahlstütze im Mauerwerk) bleibt ein Punktlager.

    @param bereich  (lo, hi) in xy — Wände außerhalb zählen nicht
    """
    from collections import Counter

    from shapely.geometry import Point, Polygon
    from shapely.ops import unary_union

    from .tragend import materialklasse

    flaechen, kandidaten = [], []
    for w in waende.get("figures", []):
        if w.get("kind") != "schnitt" or not w.get("global_id"):
            continue
        rolle = rolle_von(w.get("ifc_type") or "")
        ringe = [r for r in (w.get("rings") or []) if r and len(r) >= 3]
        if not ringe:
            continue
        if rolle == "wand":
            urteil = wand_beurteilen(w, boxen=boxen, psets=psets,
                                     tragend_vorgabe=tragend_vorgabe,
                                     pset_vertrauen=pset_vertrauen)
            if urteil["tragend"] is False:
                continue
            try:
                figur = unary_union([Polygon(r).buffer(0) for r in ringe]).buffer(0.02)
            except Exception:  # noqa: BLE001
                continue
            if bereich is not None:
                (lo, hi) = bereich
                mitte = figur.centroid
                if not (lo[0] - 0.6 <= mitte.x <= hi[0] + 0.6 and lo[1] - 0.6 <= mitte.y <= hi[1] + 0.6):
                    continue
            flaechen.append((w["global_id"], figur))
        elif rolle == "stuetze":
            flaeche = float(wandquerschnitt(ringe).get("flaeche_m2") or 0.0)
            box = boxen.get(w["global_id"]) or {}
            klasse = materialklasse(w.get("material") or box.get("material"))
            if flaeche > STAENDER_HOECHSTFLAECHE_M2:
                continue
            if klasse not in ("holz", "stahl") and not (klasse is None and flaeche <= 0.03):
                continue
            ort = schwerpunkt(ringe)
            if ort is not None:
                kandidaten.append((w["global_id"], Point(ort)))
    zuordnung = {}
    for sgid, ort in kandidaten:
        for wgid, figur in flaechen:
            if figur.contains(ort):
                zuordnung[sgid] = wgid
                break
    je_wand = Counter(zuordnung.values())
    return {sgid: wgid for sgid, wgid in zuordnung.items() if je_wand[wgid] >= 2}


def wand_beurteilen(w: dict, *, boxen: dict, psets: dict,
                    tragend_vorgabe: dict | None = None,
                    pset_vertrauen: bool = True) -> dict:
    """
    Trägt diese geschnittene Wand oder Stütze — die eine Stelle, die das sagt.

    Herausgelöst aus `statikmodell()`, weil die Kette dieselbe Frage auch für
    die Wände des Geschosses **darüber** stellt: die nichttragenden stehen als
    Trennwandzuschlag auf der Decke, die gerade gerechnet wird. Zwei
    Fassungen derselben Entscheidung liefen beim ersten neuen Merkmal
    auseinander.

    @returns {global_id, rolle, tragend, quelle, klasse}
    """
    gid = w.get("global_id", "")
    rolle = rolle_von(w.get("ifc_type") or "")
    box_w = boxen.get(gid) or {}
    urteil = beurteile(rolle=rolle, psets=psets.get(gid),
                       material=box_w.get("material"),
                       materialschichten=box_w.get("materialschichten"),
                       pset_vertrauen=pset_vertrauen)
    tragend, quelle = urteil["tragend"], urteil["quelle"]
    if tragend_vorgabe and gid in tragend_vorgabe:
        tragend, quelle = bool(tragend_vorgabe[gid]), "Eingriff am System"
    return {"global_id": gid, "rolle": rolle, "tragend": tragend,
            "quelle": quelle, "klasse": urteil["klasse"]}


def wandaufbau(urteil: dict, box: dict | None, quer: dict, rolle: str) -> dict:
    """
    Wichte und tragende Dicke eines geschnittenen Bauteils.

    Bei Wänden aus den Materialschichten, wo sie zum Körper passen
    (`lastabtrag.aufbau_wand`), sonst aus dem Werkstoff: tragende Bauteile nach
    `lastabtrag.WICHTEN_TRAGEND`, nichttragende nach `raumlasten.WICHTEN`.
    Stützen haben keinen Schichtaufbau.

    @returns {wichte_kNm3, aus_modell, quelle, dicke_tragend_m, aufbau}
    """
    klasse = urteil.get("klasse")
    if urteil.get("tragend") is False:
        ersatz = rl.WICHTEN.get(klasse or "", rl.WICHTE_UNBEKANNT)
        aus_modell = (klasse or "") in rl.WICHTEN
    else:
        ersatz, aus_modell = wichte_tragend(klasse, rolle)
    dicke_t = float(quer.get("dicke_tragend_m") or 0.0)
    if rolle != "wand":
        return {"wichte_kNm3": ersatz, "aus_modell": aus_modell, "quelle": None,
                "dicke_tragend_m": dicke_t, "aufbau": []}
    if not aus_modell:
        # Kein Werkstoff erkannt, aber ein Aufbau bekannt: dessen mittlere
        # Wichte statt 25 kN/m³. Sie gilt für jedes Stück dieser Wand, auch
        # für ein Wandende, dessen Schnitt nicht zur Schichtsumme passt (VA3:
        # Holzständerwand-Stummel 0,35 × 0,10 m wogen als Beton).
        mittel = mittlere_schichtwichte((box or {}).get("materialschichten"))
        if mittel is not None:
            ersatz, aus_modell = mittel, True
    ergebnis = aufbau_wand((box or {}).get("materialschichten"),
                           dicke_gesamt_m=float(quer.get("dicke_gesamt_m") or 0.0),
                           dicke_tragend_m=dicke_t, ersatz_kNm3=ersatz)
    return {**ergebnis, "aus_modell": aus_modell or ergebnis["aus_schichten"]}


def waende_im_schnitt(waende: dict, *, boxen: dict, psets: dict,
                      geschosshoehe: float, annahmen: dict | None = None) -> list[dict]:
    """
    Alle Wände und Stützen eines Schnitts, beurteilt und vermessen.

    Für die Kette, nicht für die Rechnung einer Platte: sie braucht die Wände
    eines Geschosses unabhängig davon, welche Platte über ihnen liegt —
    nichttragende als Trennwandzuschlag der Decke darunter, tragende ohne
    Decke darüber (ein Dachgeschoss unter einem Holzdach) als Eigengewicht,
    das nach unten weitergeht.

    @returns je Bauteil {global_id, name, ifc_type, rolle, tragend, quelle,
             klasse, ringe, laenge_m, hoehe_m, dicke_gesamt_m, achsen, punkt}
    """
    annahmen = annahmen or {}
    ergebnis = []
    for w in waende.get("figures", []):
        if w.get("kind") != "schnitt":
            continue
        rolle = rolle_von(w.get("ifc_type") or "")
        if rolle not in ("wand", "stuetze"):
            continue
        urteil = wand_beurteilen(
            w, boxen=boxen, psets=psets,
            tragend_vorgabe=annahmen.get("_tragend_vorgabe"),
            pset_vertrauen=annahmen.get("_pset_vertrauen", True))
        gid = urteil["global_id"]
        box = boxen.get(gid) or {}
        hoehe = ((float(box["hi"][2]) - float(box["lo"][2]))
                 if box.get("hi") else geschosshoehe)
        if not (0.3 <= hoehe <= 12.0):
            hoehe = geschosshoehe
        quer = wandquerschnitt(w.get("rings"))
        aufbau = wandaufbau(urteil, box, quer, rolle)
        ergebnis.append({
            **urteil, "name": w.get("name"), "ifc_type": w.get("ifc_type"),
            # Unter beiden Namen: `raumlasten.trennwandzuschlag()` liest
            # `materialklasse` — mit nur `klasse` lief jede Trennwand aus dem
            # Geschoss darüber mit der Ersatzwichte 12 statt 9 kN/m³.
            "materialklasse": urteil["klasse"],
            "ringe": w.get("rings") or [],
            "laenge_m": quer.get("laenge_m") or 0.0,
            "hoehe_m": round(hoehe, 3),
            "dicke_gesamt_m": quer.get("dicke_gesamt_m") or 0.0,
            "dicke_tragend_m": aufbau["dicke_tragend_m"],
            "wichte_kNm3": aufbau["wichte_kNm3"],
            "wichte_aus_modell": aufbau["aus_modell"],
            "wichte_quelle": aufbau["quelle"],
            "aufbau": aufbau["aufbau"],
            "volumen_m3": w.get("volumen_m3"),
            "flaeche_m2": quer.get("flaeche_m2") or 0.0,
            "achsen": ([] if rolle == "stuetze" else
                       [a["punkte"] for a in wandachse(
                           w.get("rings"), float(annahmen.get("mindestlaenge_m", 0.8)))]),
            "punkt": schwerpunkt(w.get("rings")) if rolle == "stuetze" else None,
        })
    return ergebnis


def _aufbau_eintrag(aufbau: dict) -> dict:
    """Was aus `wandaufbau()` ins Wandprotokoll geht."""
    eintrag = {"dicke_tragend_m": aufbau["dicke_tragend_m"],
               "wichte_kNm3": aufbau["wichte_kNm3"],
               "wichte_aus_modell": aufbau["aus_modell"],
               "wichte_quelle": aufbau["quelle"],
               "aufbau": aufbau["aufbau"]}
    if len(aufbau["aufbau"]) > 1:
        eintrag["mehrschichtig"] = True
    return eintrag


def _gerade_zusammenfassen(punkte, grad: float = 1.0) -> list:
    """
    Zwischenpunkte auf einer Geraden weglassen.

    `unterzug.finde()` zerlegt einen Polygonzug an jedem Punkt in Segmente —
    richtig an einem Knick, falsch auf der Geraden: ein durchlaufender Balken
    würde als zwei Einfeldträger bemessen.
    """
    p = [list(map(float, q)) for q in punkte]
    if len(p) <= 2:
        return p
    raus = [p[0]]
    for i in range(1, len(p) - 1):
        a, b, c = raus[-1], p[i], p[i + 1]
        w1 = math.atan2(b[1] - a[1], b[0] - a[0])
        w2 = math.atan2(c[1] - b[1], c[0] - b[0])
        d = abs((w2 - w1 + math.pi) % (2 * math.pi) - math.pi)
        if d > math.radians(grad):
            raus.append(b)
    raus.append(p[-1])
    return raus


def _balkenwerkstoff(box: dict) -> dict:
    """
    Wichte und Steifigkeit eines Unterzugs aus seinem Material.

    Die Wichte geht ins Eigengewicht des Stegs (`plate.vernetze()`): ein
    Holzbalken unter einer Ersatzplatte wiegt 5, ein Stahlträger 78,5 kN/m³ —
    nicht, was die Platte wiegt. Der E-Modul gilt für die Rippe einer
    orthotropen Ersatzplatte (`plate.werkstofftabelle()`); unter einer
    Betonplatte rechnet die Rippe weiter mit dem Beton der Platte.
    """
    from .tragend import schichtwichte, werkstoffklasse
    from .werkstoff import WERKSTOFFE
    material = box.get("material")
    klasse = werkstoffklasse(material, box.get("materialschichten"))
    wichte = schichtwichte(material) or {"stahl": 78.5, "holz": 5.0}.get(klasse or "", 25.0)
    if klasse == "holz":
        holz = next((w for k, w in WERKSTOFFE.items()
                     if w.familie == "holz" and k.lower() in str(material or "").lower()),
                    WERKSTOFFE["C24"])
        E, nu = holz.E_1, 0.3
    elif klasse == "stahl":
        E, nu = WERKSTOFFE["S235"].E_1, 0.3
    else:
        E, nu = WERKSTOFFE["C25/30"].E_1, 0.2
    return {"wichte_kNm3": round(float(wichte), 3),
            "material": {"name": material, "E_kNm2": float(E), "nu": nu}}


def unterzuege_im_schnitt(schnitt: dict | None, *, umriss, dicke: float,
                          unterkante: float, boxen: dict,
                          mindestlaenge: float = 0.8) -> tuple[list[dict], list[str]]:
    """
    Die Unterzüge unter einer Platte — als Plattenbalken für das FE-Modell.

    **Bis Oktober 2026 war ein Unterzug nie Teil der Rechnung.** Der FE-Kern
    kann ihn (`plate.vernetze()` legt Stegzellen unter die Platte, die Lager
    greifen an der tiefsten Knotenreihe, `unterzug.py` bemisst ihn als
    Plattenbalken), aber die Kette gab ihm keinen: ein Skelettbau mit Unterzügen
    spannte seine Decken von Stütze zu Stütze, als gäbe es die Balken nicht.

    Geschnitten wird knapp unter der Plattenunterseite (`kette`); getroffen
    werden die Stege. Je Bauteil die Achse wie bei einer Wand (`wandachse`), die
    Stegbreite aus dem Querschnitt, die Gesamthöhe = Plattendicke + Steg bis zur
    Unterkante des Balkens (Hüllbox). Ein Balken, dessen Unterkante nicht unter
    der Platte liegt (in der Platte, ein Überzug), wird nicht genommen.

    @param unterkante  Unterseite der Platte, Höhe im System der Hüllboxen
    @returns (unterzuege im Format von `ileen.plan.fem`, hinweise)
    """
    from shapely.geometry import LineString, Polygon
    hinweise: list[str] = []
    if not schnitt:
        return [], hinweise
    try:
        platte = Polygon(umriss).buffer(0.30)
    except Exception:  # noqa: BLE001
        return [], hinweise
    ergebnis: list[dict] = []
    for f in schnitt.get("figures", []):
        if f.get("kind") != "schnitt" or rolle_von(f.get("ifc_type") or "") != "unterzug":
            continue
        gid = f.get("global_id", "")
        box = boxen.get(gid) or {}
        if not box.get("lo"):
            continue
        steg = float(unterkante) - float(box["lo"][2])
        if steg < 0.05:
            continue
        quer = wandquerschnitt(f.get("rings"))
        breite = float(quer.get("dicke_tragend_m") or 0.0)
        if not (0.06 <= breite <= 2.0):
            hinweise.append(f"Unterzug {f.get('name') or gid}: Stegbreite {breite:.2f} m "
                            f"nicht lesbar — nicht abgebildet.")
            continue
        for achse in wandachse(f.get("rings"), mindestlaenge):
            punkte = _gerade_zusammenfassen(achse["punkte"])
            linie = LineString(punkte)
            if not platte.contains(linie.interpolate(0.5, normalized=True)):
                continue
            ergebnis.append({
                "id": f"U{len(ergebnis) + 1}",
                "polylinie": [[round(float(x), 4), round(float(y), 4)] for x, y in punkte],
                "breite_m": round(breite, 3),
                "hoehe_m": round(float(dicke) + steg, 3),
                "richtung": "unten",
                "bezug": gid,
                "name": f.get("name"),
                **_balkenwerkstoff(box),
            })
    if ergebnis:
        hinweise.append(f"{len(ergebnis)} Unterzug/Unterzüge aus dem IFC als Plattenbalken "
                        f"(Steg unter der Platte).")
    return ergebnis, hinweise


def eingetragene_lasten(modell: dict) -> dict[str, float]:
    """
    Was die Flächenlasten und das Eigengewicht einer Platte **neu** eintragen,
    je Lastfall — geometrisch, unabhängig vom Netz.

    **Warum nicht Fläche × Σ Lastwerte.** So rechnete die Kette bis Oktober
    2026: `flaeche · (d·γ + Σ wert)`. Das stimmt, solange es eine
    Nutzlastfläche über die ganze Decke gibt. Mit raumweisen Nutzlasten sind
    es zehn Polygone, jedes mit seinem Wert — die Summe der Werte mal die
    ganze Fläche ist dann das Zehnfache, und die Erhaltungsprobe verglich
    zwei Zahlen, von denen eine nichts bedeutete.

    Linien- und Einzellasten aus dem Geschoss darüber zählen nicht: sie sind
    nicht neu, sie wandern nur weiter.
    """
    from shapely.geometry import Polygon
    sysf = modell["system"][0]

    def figur(aussen, loecher=()):
        try:
            p = Polygon(aussen, [l for l in loecher or [] if len(l) >= 3])
            return p if p.is_valid else p.buffer(0)
        except Exception:  # noqa: BLE001
            return None

    decke = figur(sysf["umriss"], sysf.get("oeffnungen"))
    if decke is None or decke.is_empty:
        return {}
    lastflaechen_festhalten(modell)
    wichte = float(sysf["material"]["wichte_kNm3"])
    summe = {"EG": decke.area * float(sysf["dicke_m"]) * wichte}
    # Der Steg eines Unterzugs gehört zum Eigengewicht der Platte — so rechnet
    # ihn das Netz (`plate.vernetze()`, Gewicht aus dem wahren Querschnitt).
    from shapely.geometry import LineString
    for uz in modell.get("unterzuege") or []:
        steg = float(uz["hoehe_m"]) - float(sysf["dicke_m"])
        if steg <= 1e-6 or len(uz.get("polylinie") or []) < 2:
            continue
        laenge = LineString(uz["polylinie"]).intersection(decke).length
        summe["EG"] += (laenge * float(uz["breite_m"]) * steg
                        * float(uz.get("wichte_kNm3") or wichte))
    for last in modell.get("lasten", []):
        if last.get("typ") != "flaeche" or not last.get("flaeche_m2"):
            continue
        fall = last["lastfall"]
        summe[fall] = summe.get(fall, 0.0) + float(last["flaeche_m2"]) * float(last["wert"])
    return summe


def lastflaechen_festhalten(modell: dict) -> None:
    """
    Schreibt an jede Flächenlast, wie viel Platte sie bedeckt (`flaeche_m2`).

    **Das Netz hält damit die Gesamtlast ein.** Eine Zelle gehört zur Last,
    wenn ihr Mittelpunkt darin liegt; am schrägen oder runden Rand ist die
    Summe der Zellen etwas anderes als die Figur. Bei Lucys runden Dachfeldern
    trug das Netz 0,2–0,4 % mehr, als die Fläche hergibt, und das
    Kassenbuch des Geschosses ging um diesen Betrag nicht auf. `plate._anteile()`
    rechnet die Intensität deshalb wie bei Linienlasten: Kraft durch die
    tatsächlich getroffene Zellfläche. Dieselbe Zahl ist die Grundlage von
    `eingetragene_lasten()` — beide Seiten des Kassenbuchs sehen eine Fläche.
    """
    from shapely.geometry import Polygon
    sysf = modell["system"][0]

    def figur(aussen, loecher=()):
        try:
            p = Polygon(aussen, [l for l in loecher or [] if len(l) >= 3])
            return p if p.is_valid else p.buffer(0)
        except Exception:  # noqa: BLE001
            return None

    decke = figur(sysf["umriss"], sysf.get("oeffnungen"))
    if decke is None or decke.is_empty:
        return
    for last in modell.get("lasten", []):
        if last.get("typ") != "flaeche":
            continue
        p = figur(last["polygon"], last.get("loecher"))
        last["flaeche_m2"] = (round(float(p.intersection(decke).area), 6)
                              if p is not None and not p.is_empty else 0.0)


def statikmodell(decke: dict, waende: dict, *, job_id: str, modellname: str,
                 geschoss: dict, boxen: dict | None = None,
                 psets: dict | None = None, annahmen: dict | None = None,
                 linienlasten: list[dict] | None = None,
                 platte_gid: str | None = None,
                 raeume: list[dict] | None = None,
                 trennwaende: list[dict] | None = None,
                 dach: bool = False,
                 unterzuege: dict | None = None,
                 kronen: dict | None = None) -> dict:
    """
    Deckenfiguren + Wandfiguren → `ileen.plan.fem/1.0`-Modell.

    @param decke        Antwort eines Schnitts durch die Deckenplatte (dict)
    @param waende       Antwort eines Schnitts auf Wandhöhe des Geschosses darunter
    @param boxen        GlobalId → {lo, hi} aus dem Elementverzeichnis, für die
                        Deckendicke und die Wandhöhe
    @param psets        GlobalId → Property-Sets, für `LoadBearing` und Dicken
    @param linienlasten Lasten aus dem Geschoss darüber, bereits als
                        `{polylinie, wert, lastfall}` — der Lastabtrag
    @param platte_gid   GlobalId der Platte, die gerechnet werden soll. Ohne
                        Angabe die flächengrößte des Schnitts.
    @param raeume       Räume, die **auf** dieser Decke stehen, mit `grundriss`
                        (aus `section.raumkennwerte(mit_grundriss=True)`) —
                        daraus werden die raumweisen Nutzlasten. Ohne sie fällt
                        die Nutzlast auf die Vorgabekategorie über die ganze
                        Decke zurück, wie vor September 2026.
    @param trennwaende  nichttragende Wände, die **auf** dieser Decke stehen
                        (aus dem Schnitt des Geschosses darüber, siehe
                        `waende_im_schnitt()`). `None` heißt: wie bis Oktober
                        2026 die nichttragenden Wände des eigenen
                        Auflagerschnitts — das sind die Wände *unter* der
                        Decke, und der Zuschlag stand ein Geschoss zu hoch.
    @param dach         nichts steht auf dieser Decke — weder Raum noch Wand
                        noch eine höhere Decke. Statt Ausbau- und Nutzlast
                        tragen Dachaufbau und max(Kat. H, Schnee), siehe
                        `dachlast()`.
    @param unterzuege   Antwort eines Schnitts knapp unter der Platte — die
                        Stege der Unterzüge (`unterzuege_im_schnitt()`)
    @param kronen       derselbe Schnitt für die Wände: ihre Lagerlinie kommt
                        von dort, wo die Decke aufliegt — über Fenstern
                        geschlossen (Sturz). Querschnitt, Länge und Nachweis
                        bleiben beim Schnitt `waende`.
    @returns {modell, protokoll}
    """
    annahmen = dict(annahmen or {})
    boxen = boxen or {}
    psets = psets or {}
    raeume = raeume or []

    guete = annahmen.get("beton") or "C25/30"
    kennwerte = BETON.get(guete, BETON["C25/30"])
    kategorie = annahmen.get("nutzlast_kategorie") or "A2"
    nutz_wert, nutz_text = NUTZLASTEN.get(kategorie, NUTZLASTEN["A2"])
    ausbau = float(annahmen.get("ausbaulast_kNm2", 1.5))
    nur_tragende = bool(annahmen.get("nur_tragende", True))
    #: GlobalId → tragend, aus den Eingriffen am System (`ileen.eingriffe`).
    tragend_vorgabe = annahmen.get("_tragend_vorgabe") or {}

    # ── Die Platte: die größte geschnittene Slab-Figur ───────────────────
    kandidaten = []
    for f in decke.get("figures", []):
        if f.get("kind") != "schnitt":
            continue
        typ = f.get("ifc_type") or ""
        if rolle_von(typ) not in ("decke", "fundament"):
            continue
        ringe = f.get("rings") or []
        if not ringe:
            continue
        kandidaten.append((flaeche(ringe[0]), f))
    kandidaten.sort(key=lambda x: x[0], reverse=True)

    if not kandidaten:
        klassen = sorted({f.get("ifc_type") for f in decke.get("figures", [])} - {None})
        raise ValueError(
            f"Im Geschoss \"{geschoss['name']}\" wurde keine Deckenplatte geschnitten. "
            f"Gefundene Klassen: {', '.join(klassen) or 'keine'}. "
            f"Trägt das Geschoss eine IfcSlab?")

    # **Welche Platte gerechnet wird, entscheidet der Aufrufer.** Ohne Angabe
    # die flächengrößte — das war die einzige Wahl der ersten Fassung und der
    # Grund, warum bei einem Gebäude aus zwei Baukörpern der halbe Bau
    # unbemerkt fehlte. Der Lastabtrag gibt deshalb die GlobalId der Platte vor,
    # die er meint, und rechnet sie alle nacheinander.
    if platte_gid:
        treffer = next((f for _, f in kandidaten
                        if f.get("global_id") == platte_gid), None)
        if treffer is None:
            raise ValueError(
                f"Die Platte '{platte_gid}' erscheint im Schnitt von "
                f"\"{geschoss['name']}\" nicht. Geschnitten wurden "
                f"{len(kandidaten)} Slabs: "
                f"{', '.join((f.get('name') or f.get('global_id') or '?') for _, f in kandidaten[:6])}. "
                f"Liegt die Schnittebene in dieser Platte?")
        platte = treffer
    else:
        platte = kandidaten[0][1]
    umriss = platte["rings"][0]
    platte_gid = platte.get("global_id", "")

    # **Die inneren Ringe sind die Öffnungen** — Treppenauge, Schächte,
    # Aussparungen. Der Schnitt liefert sie längst mit; bis September 2026 nahm
    # `statikmodell()` nur `rings[0]` und warf sie weg, und die Decke wurde
    # über dem Treppenauge durchgerechnet, als läge dort Beton.
    #
    # Welcher Ring ein Loch ist, entscheidet die Verschachtelungstiefe und
    # nicht die Reihenfolge: `ringgruppen()` führt dieselbe Unterscheidung
    # schon für die Wandquerschnitte. Gerade Tiefe beginnt eine Fläche,
    # ungerade ist ein Loch darin. Ein Schacht mit einer Innenschale hätte
    # sonst ein Loch im Loch — also wieder Decke —, und das wäre als
    # Öffnung gezählt worden.
    oeffnungen = []
    gruppen = ringgruppen(platte.get("rings") or [])
    # Die Gruppe, deren Außenring der Umriss ist. Bei einer Platte ist das die
    # flächengrößte; über die Identität des Rings gesucht statt über die
    # Fläche, weil `umriss` weiter unten das Maß für alles ist und die beiden
    # nicht auseinanderlaufen dürfen.
    eigene = next((g for g in gruppen if g["ringe"] and g["ringe"][0] is umriss),
                  gruppen[0] if gruppen else None)
    if eigene:
        oeffnungen = [ring for ring in eigene["ringe"][1:] if len(ring) >= 3]

    # ── Deckendicke ──────────────────────────────────────────────────────
    #
    # Die empfindlichste Zahl der ganzen Rechnung: sie geht mit der dritten
    # Potenz in die Steifigkeit ein. Deshalb drei Quellen in dieser Reihenfolge
    # — Vorgabe, Property-Set, Hüllbox — und die benutzte steht im Protokoll.
    dicke = annahmen.get("dicke_m")
    # Wer die Dicke setzt, sagt auch, woher sie stammt. Die Kette misst sie an
    # der Hüllbox der gefundenen Platte und reicht sie über `dicke_m` herein —
    # das Protokoll dürfte sie dann nicht als „vorgegeben" ausweisen, denn
    # genau die Unterscheidung zwischen gemessen und gesetzt ist der Zweck
    # dieses Felds.
    dicke_quelle = annahmen.get("dicke_quelle") or "vorgegeben"
    if dicke is None:
        aus_pset = pset_zahl(psets.get(platte_gid), "Width", "Depth",
                             "NominalThickness", "Thickness")
        if aus_pset and 0.05 <= aus_pset <= 1.5:
            dicke, dicke_quelle = aus_pset, "Property-Set"
        elif aus_pset and 50 <= aus_pset <= 1500:
            # Manche Modelle führen die Dicke in Millimetern.
            dicke, dicke_quelle = aus_pset / 1000.0, "Property-Set (mm)"
    if dicke is None:
        box = boxen.get(platte_gid)
        if box:
            hoehe = float(box["hi"][2]) - float(box["lo"][2])
            if 0.05 <= hoehe <= 1.5:
                dicke, dicke_quelle = round(hoehe, 3), "Hüllbox der Slab"
    if dicke is None:
        dicke, dicke_quelle = 0.20, "angenommen (0,20 m)"

    # ── Auflager: die Wände unter der Decke ──────────────────────────────
    geschosshoehe = float(geschoss.get("decke", 0)) - float(geschoss.get("boden", 0))
    auflager: list[dict] = []
    wandprotokoll: list[dict] = []
    verworfen: list[str] = []
    #: Die nichttragenden Wände mit ihrer Geometrie — Grundlage des
    #: Trennwandzuschlags. Bis September 2026 wurde hier nur der Name
    #: gesammelt; die Wand fiel damit restlos aus der Rechnung, obwohl sie
    #: nach DIN EN 1991-1-1/NA 6.3.1.2 (8) als Flächenlast anzusetzen ist.
    nichttragende: list[dict] = []

    # Nur Wände unter *dieser* Platte. Bei einem Gebäude aus zwei Baukörpern
    # liefert derselbe Schnitt auch die Wände des anderen; als Auflager
    # angesetzt lägen sie außerhalb des Systemumrisses, das System wäre
    # scheinbar reich gelagert und tatsächlich kinematisch.
    umriss_lo = [min(p[0] for p in umriss), min(p[1] for p in umriss)]
    umriss_hi = [max(p[0] for p in umriss), max(p[1] for p in umriss)]
    ausserhalb = 0
    kronenfiguren = {f.get("global_id"): f for f in (kronen or {}).get("figures", [])
                     if f.get("kind") == "schnitt" and f.get("global_id")
                     and rolle_von(f.get("ifc_type") or "") == "wand"}
    ueber_sturz: list[str] = []
    fuss_achsen: dict[str, list] = {}
    staender = staender_in_waenden(
        waende, boxen=boxen, psets=psets, tragend_vorgabe=tragend_vorgabe,
        pset_vertrauen=annahmen.get("_pset_vertrauen", True),
        bereich=(umriss_lo, umriss_hi)) if nur_tragende else {}
    staender_je_wand: dict[str, dict] = {}

    for w in waende.get("figures", []):
        if w.get("kind") != "schnitt":
            continue
        typ = w.get("ifc_type") or ""
        rolle = rolle_von(typ)
        if rolle not in ("wand", "stuetze"):
            continue

        ringe = w.get("rings") or []
        if ringe and ringe[0]:
            schwer = [sum(p[0] for p in ringe[0]) / len(ringe[0]),
                      sum(p[1] for p in ringe[0]) / len(ringe[0])]
            # Eine halbe Wanddicke Zugabe: eine Außenwand steht mit ihrem
            # Schwerpunkt knapp außerhalb der Deckenkante.
            if not (umriss_lo[0] - 0.6 <= schwer[0] <= umriss_hi[0] + 0.6
                    and umriss_lo[1] - 0.6 <= schwer[1] <= umriss_hi[1] + 0.6):
                ausserhalb += 1
                continue

        gid = w.get("global_id", "")
        if gid in staender:
            # Ein Ständer der Wand: kein eigenes Lager, sein Gewicht trägt sie.
            box_s = boxen.get(gid) or {}
            wichte_s, _ = wichte_tragend(
                materialklasse_von(w.get("material") or box_s.get("material")), "stuetze")
            volumen_s = float(box_s.get("volumen_m3") or 0.0)
            if volumen_s <= 0.0 and box_s.get("hi"):
                volumen_s = (float(wandquerschnitt(w.get("rings")).get("flaeche_m2") or 0.0)
                             * (float(box_s["hi"][2]) - float(box_s["lo"][2])))
            if box_s.get("hi"):
                hoehe_s = float(box_s["hi"][2]) - float(box_s["lo"][2])
                im_geschoss = (min(float(box_s["hi"][2]), float(geschoss.get("decke", 1e9)))
                               - max(float(box_s["lo"][2]), float(geschoss.get("boden", -1e9))))
                if hoehe_s > 1e-6:
                    volumen_s *= max(0.0, min(1.0, im_geschoss / hoehe_s))
            eintrag_s = staender_je_wand.setdefault(staender[gid], {"gids": [], "kN": 0.0})
            eintrag_s["gids"].append(gid)
            eintrag_s["kN"] += volumen_s * wichte_s
            continue
        # **Zuerst das Material, dann das Property-Set.** Die Reihenfolge und
        # ihre Begründung stehen in `ileen/tragend.py`; hier steht nur, dass
        # die Auskunft mitsamt ihrer Herkunft in den Bericht wandert. Eine
        # Erkennung, die nicht sagt, woraus sie schließt, ist im Zweifelsfall
        # nicht nachzuvollziehen.
        #
        # Ein Eingriff am System sticht alles. Er ist die Aussage eines
        # Menschen über dasselbe Bauteil, und er ist die einzige Art Eingriff,
        # die hier statt weiter unten wirken muss: eine verworfene Wand steht
        # im fertigen Modell nirgends mehr.
        urteil = wand_beurteilen(w, boxen=boxen, psets=psets,
                                 tragend_vorgabe=tragend_vorgabe,
                                 pset_vertrauen=annahmen.get("_pset_vertrauen", True))
        tragend = urteil["tragend"]
        tragend_quelle = urteil["quelle"]
        materialklasse = urteil["klasse"]
        if nur_tragende and tragend is False:
            verworfen.append(w.get("name") or gid)
            # Sie trägt nicht — aber sie wiegt. Geometrie mitnehmen, sonst
            # fehlt ihr Gewicht in der Rechnung vollständig.
            box_nt = boxen.get(gid) or {}
            hoehe_nt = ((float(box_nt["hi"][2]) - float(box_nt["lo"][2]))
                        if box_nt.get("hi") else geschosshoehe)
            if not (0.3 <= hoehe_nt <= 12.0):
                hoehe_nt = geschosshoehe
            quer_nt = wandquerschnitt(w.get("rings"))
            nichttragende.append({
                "global_id": gid, "name": w.get("name"),
                "laenge_m": quer_nt.get("laenge_m") or 0.0,
                "hoehe_m": round(hoehe_nt, 3),
                "dicke_gesamt_m": quer_nt.get("dicke_gesamt_m") or 0.0,
                "materialklasse": materialklasse,
                "wichte_kNm3": wandaufbau(urteil, box_nt, quer_nt, rolle)["wichte_kNm3"],
            })
            continue

        quer = wandquerschnitt(w.get("rings"))
        mindest = float(annahmen.get("mindestlaenge_m", 0.8))

        # **Eine Stütze hat keine lange Kante.** Sie ist der Grund, warum
        # Stützen bis hierher gar nicht als Auflager auftauchten: eine 30er
        # Stütze hat vier Kanten von 0,30 m, alle kürzer als die
        # Mindestlänge, `auflagerlinien()` gab nichts zurück und das `continue`
        # darunter warf sie hinaus, ehe der Zweig für Punktlager erreicht war.
        # Sie wird deshalb gar nicht erst über Kanten gesucht, sondern über
        # ihren Schwerpunkt.
        if rolle == "stuetze":
            ort = schwerpunkt(w.get("rings"))
            lager = ([{"typ": "punkt", "p": ort, "_laenge": 0.0}]
                     if ort is not None else [])
        else:
            achsen = wandachse(w.get("rings"), mindest)
            krone = kronenfiguren.get(gid)
            if krone is not None:
                oben = wandachse(krone.get("rings"), mindest)
                if (sum(a["laenge"] for a in oben)
                        > sum(a["laenge"] for a in achsen) + 0.05):
                    # Die Fußkraft geht weiter durch die Pfeiler: unter einer
                    # Tür steht keine Wand auf der Decke darunter.
                    fuss_achsen[gid] = [a["punkte"] for a in achsen]
                    achsen = oben
                    ueber_sturz.append(w.get("name") or gid)
            lager = [{"typ": "linie", "polylinie": achse["punkte"],
                      "_laenge": round(achse["laenge"], 3)}
                     for achse in achsen]
        if not lager:
            continue

        # Wandhöhe: aus der Hüllbox, sonst die Geschosshöhe.
        box = boxen.get(gid)
        hoehe = (float(box["hi"][2]) - float(box["lo"][2])) if box else geschosshoehe
        if not (0.3 <= hoehe <= 12.0):
            hoehe = geschosshoehe

        erste = len(auflager)
        for eintrag in lager:
            auflager.append({
                "id": f"A{len(auflager) + 1}",
                "art": annahmen.get("auflagerart") or "gelenkig",
                "federsteifigkeit_kNm2": None,
                "bauteile": [gid],
                **eintrag,
            })

        wandprotokoll.append({
            "global_id": gid,
            "name": w.get("name"),
            "ifc_type": typ,
            "rolle": rolle,
            "tragend": tragend,
            "tragend_quelle": tragend_quelle,
            "materialklasse": materialklasse,
            "lager": [a["id"] for a in auflager[erste:]],
            "laenge_lager_m": round(sum(a["_laenge"] for a in auflager[erste:]), 2),
            # Die eigenen Achsen, wie sie **vor** dem Zusammenführen lagen —
            # entlang dieser gibt die Kette die Fußkraft weiter.
            "achsen": [a["polylinie"] for a in auflager[erste:] if "polylinie" in a],
            **({"fuss_achsen": fuss_achsen[gid]} if gid in fuss_achsen else {}),
            "punkt": next((a["p"] for a in auflager[erste:] if "p" in a), None),
            "hoehe_m": round(hoehe, 3),
            "material": w.get("material"),
            "volumen_m3": w.get("volumen_m3"),
            **quer,
            **_aufbau_eintrag(wandaufbau(urteil, box, quer, rolle)),
        })
        # **Die tragende Breite gehört zum Lager.** Eine Decke liegt auf der
        # ganzen Wanddicke auf, nicht auf ihrer Achse: endet sie an der
        # Innenseite (Balkenlage an einer Betonwand, LPH 4), trägt die Wand sie
        # trotzdem. `plate.lagerknoten()` fängt damit mindestens die halbe
        # Breite, `kette.durchleiten()` nimmt sie als Lagerfläche.
        zeile = wandprotokoll[-1]
        breite = (math.sqrt(float(zeile.get("flaeche_m2") or 0.0)) if rolle == "stuetze"
                  else float(zeile.get("dicke_tragend_m") or zeile.get("dicke_gesamt_m") or 0.0))
        for eintrag_lager in auflager[erste:]:
            eintrag_lager["breite_m"] = round(breite, 4)

    # **Erst jetzt zusammenführen, nicht schon in der Schleife.** Zwei
    # Wandstücke, die eine durchgehende Wand bilden, kommen als zwei Bauteile
    # aus dem Schnitt und werden hier zu einem Lager — sonst entstünden Lager
    # aus Modellierungszufällen, und kurze steife Lager ziehen Kraft an.
    vorher = len(auflager)
    auflager = lager_zusammenfuehren(auflager)
    zusammengefuehrt = vorher - len(auflager)
    # Die Kennungen haben sich dabei geändert; das Wandprotokoll verweist auf
    # die alten. Es wird deshalb neu verknüpft — über die GlobalId, die als
    # einzige die Neuvergabe überlebt.
    lager_je_bauteil: dict[str, list[str]] = {}
    for eintrag in auflager:
        for gid_ in (eintrag.get("bauteile") or []):
            lager_je_bauteil.setdefault(gid_, []).append(eintrag["id"])
    for zeile in wandprotokoll:
        zeile["lager"] = lager_je_bauteil.get(zeile["global_id"], [])
        if zeile["global_id"] in staender_je_wand:
            zeile["staender"] = sorted(staender_je_wand[zeile["global_id"]]["gids"])
            zeile["staender_kN"] = round(staender_je_wand[zeile["global_id"]]["kN"], 3)

    # **Eine gebettete Platte braucht keine Auflager.** Sie ist der einzige
    # Fall, in dem ein System ohne Lager nicht kinematisch ist: der Boden hält
    # sie flächig. Für alles andere ist ein System ohne Auflager ein Fehler,
    # und zwar einer, den man sofort sehen soll — eine Rechnung, die trotzdem
    # anläuft, liefert Verschiebungen in Kilometern.
    gebettet = bool(annahmen.get("bettung_kNm3"))
    if not auflager and not gebettet:
        grund = (f" — {len(verworfen)} Wände wurden als nichttragend verworfen"
                 if verworfen else "")
        raise ValueError(
            f"Unter der Decke von \"{geschoss['name']}\" wurden keine Auflager "
            f"gefunden{grund}. Ohne Auflager ist das System kinematisch.")

    # **Netto, nicht brutto.** Über einer Öffnung liegt kein Beton. Die Zahl
    # geht in die Bilanz der Kette ein (`kette._platte_rechnen()` rechnet
    # daraus Eigengewicht und Flächenlasten), und mit der Bruttofläche käme
    # dort mehr Last an, als das FE-Netz trägt — die Erhaltungsprobe schlüge
    # an, ohne zu sagen, warum.
    flaeche_m2 = round(flaeche(umriss) - sum(flaeche(o) for o in oeffnungen), 3)

    # ── Unterzüge unter der Platte ───────────────────────────────────────
    uz_liste, uz_hinweise = unterzuege_im_schnitt(
        unterzuege, umriss=umriss, dicke=dicke,
        unterkante=float(geschoss["decke"]), boxen=boxen,
        mindestlaenge=float(annahmen.get("mindestlaenge_m", 0.8)))

    # ── Lastfälle und Lasten ─────────────────────────────────────────────
    if dach:
        ausbau = float(annahmen.get("dachaufbau_kNm2") or DACHAUFBAU_VORGABE)
    # **Was das Modell als Schicht führt, gilt vor der Annahme.** Estrich,
    # Dämmung, Abdichtung, Kies als Schichten der Platte (`kette._plattenaufbau`)
    # ersetzen die angenommene Ausbau- bzw. Dachaufbaulast; die Annahme füllt
    # nur, wo das Modell nichts sagt.
    aufbau_modell = annahmen.get("_aufbau_modell")
    if aufbau_modell is not None:
        ausbau = float(aufbau_modell["wert"])
    lastfaelle = [
        {"id": "EG", "name": "Eigengewicht", "art": "G", "gamma": 1.35, "psi0": 1.0, "psi2": 1.0},
        {"id": "AUS", "name": "Dachaufbau" if dach else "Ausbaulast", "art": "G",
         "gamma": 1.35, "psi0": 1.0, "psi2": 1.0},
    ]
    lasten = [
        {"id": "L1", "typ": "flaeche", "lastfall": "AUS", "wert": ausbau,
         "einheit": "kN/m2", "richtung": [0, 0, -1], "polygon": umriss, "bezug": None,
         "name": "Dachaufbau" if dach else "Ausbaulast",
         "herkunft": (f"aus dem Schichtaufbau der Platte: {aufbau_modell['quelle']}"
                      if aufbau_modell is not None else
                      "Annahme Flachdach (Abdichtung, Dämmung, Kies)" if dach
                      and not annahmen.get("dachaufbau_kNm2") else None)},
    ]
    nutz_protokoll: list[dict] = []
    zuschlag = {"q_kNm2": 0.0, "hinweis": "", "wandlast_kNm": 0.0}

    if dach:
        # ── Dach: Dachaufbau und max(Kat. H, Schnee) ─────────────────────
        #
        # Nicht die Räume des obersten Geschosses: die liegen *unter* dem
        # Dach. Und kein Trennwandzuschlag: auf einem Dach steht keine Wand.
        fall, wert, text = dachlast(annahmen)
        lastfaelle.append(fall)
        lasten.append({
            "id": "L2", "typ": "flaeche", "lastfall": fall["id"], "wert": wert,
            "einheit": "kN/m2", "richtung": [0, 0, -1], "polygon": umriss,
            "loecher": oeffnungen, "bezug": None, "name": fall["name"],
            "herkunft": text,
        })
        kategorie, nutz_wert, nutz_text = fall["id"], wert, fall["name"]
    else:
        lastfaelle.append({"id": "NUTZ", "name": f"Nutzlast {kategorie}", "art": "Q",
                           "gamma": 1.5, "psi0": 0.7, "psi2": 0.3})

        # ── Nutzlast: raumweise, nicht pauschal ──────────────────────────
        #
        # Ein Geschoss mit Büro (2,0), Archiv (5,0) und Treppenhaus (3,0) hat
        # drei Flächenlasten, und die Stelle mit dem Archiv ist genau die
        # Stelle, an der die Decke bemessen wird. Eine Kategorie über das
        # ganze Geschoss ist für ein Wohnhaus vertretbar und für alles andere
        # eine andere Rechnung.
        #
        # `_nutzlastflaechen()` liefert je Raum ein Polygon mit seiner
        # Kategorie und für alles, was zu keinem Raum gehört — Wandflächen,
        # Schächte, Bereiche ohne IfcSpace —, die Restfläche mit der
        # Vorgabekategorie. Die Summe der Teilflächen ist damit der
        # Deckenumriss, und die Lastbilanz geht auf.
        nutzflaechen, nutz_protokoll = _nutzlastflaechen(
            raeume, umriss, oeffnungen, kategorie, nutz_wert,
            annahmen.get("nutzlast_je_raum") or {})
        for nr, feld in enumerate(nutzflaechen, start=2):
            lasten.append({
                "id": f"L{nr}", "typ": "flaeche", "lastfall": "NUTZ",
                "wert": feld["q_k_kNm2"], "einheit": "kN/m2",
                "richtung": [0, 0, -1], "polygon": feld["polygon"],
                "loecher": feld.get("loecher") or [],
                "kategorie": feld["kategorie"], "bezug": feld.get("global_id") or None,
                "name": feld.get("name"), "nutzung": feld.get("nutzung"),
                "herkunft": feld.get("herkunft"),
            })

        # ── Trennwandzuschlag ────────────────────────────────────────────
        #
        # Aus den nichttragenden Wänden, verschmiert über die Decke.
        # Verschmiert nicht aus Bequemlichkeit: DIN EN 1991-1-1/NA 6.3.1.2 (8)
        # verlangt es, weil eine Trennwand versetzt werden kann und die Decke
        # für den ungünstigsten Stellplatz tragen muss.
        #
        # **Die Wände, die auf der Decke stehen**, nicht die darunter. Bis
        # Oktober 2026 kamen sie aus dem eigenen Auflagerschnitt — also aus
        # dem Geschoss unter der Decke —, und die Trennwände jedes Geschosses
        # lagen eine Decke zu hoch: auf dem Dach die des obersten Geschosses,
        # auf der Bodenplatte keine.
        zuschlag = rl.trennwandzuschlag(
            nichttragende if trennwaende is None else trennwaende, flaeche_m2)
        if zuschlag["q_kNm2"] > 0.0:
            lasten.append({
                "id": f"L{len(lasten) + 1}", "typ": "flaeche", "lastfall": "AUS",
                "wert": zuschlag["q_kNm2"], "einheit": "kN/m2",
                "richtung": [0, 0, -1], "polygon": umriss, "bezug": None,
                "name": "Trennwandzuschlag", "herkunft": zuschlag["hinweis"],
            })

    # ── Die Lasten aus dem Geschoss darüber ──────────────────────────────
    #
    # Sie tragen **eigene Kennungen** (`ABG`, `ABQ`) und nicht die der
    # Lastfälle, aus denen sie stammen. Zwei Gründe:
    #
    # 1. `EG` ist in `plate` die feste Kennung des Plattengewichts. Eine Last
    #    mit diesem Lastfall überschreibt es (siehe `plate.einzelfelder`) —
    #    das Plattengewicht einer 718-m²-Decke, 4 667 kN, verschwand dadurch
    #    spurlos aus der Rechnung.
    # 2. Jeden Lastfall jedes Geschosses einzeln weiterzuführen ließe die Zahl
    #    der Lastfälle mit jedem Geschoss wachsen, und `plate.kombinationen()`
    #    baut je veränderlichem Lastfall eine eigene Leitkombination — bei
    #    sechs Geschossen wären das über ein Dutzend Lösungen für einen
    #    Unterschied, den keine Bemessung sieht.
    #
    # **Der ständige Anteil bekommt einen eigenen Lastfall, der veränderliche
    # nicht.** Das ist kein Schönheitsfehler, sondern der Unterschied zwischen
    # richtig und doppelt abgemindert:
    #
    # Nach DIN EN 1990, Gl. 6.10, geht genau *eine* veränderliche Einwirkung
    # voll ein, alle weiteren mit ψ₀. Die Nutzlast aus dem Geschoss darüber ist
    # aber keine zweite, unabhängige Einwirkung — es ist dieselbe Nutzlast
    # derselben Kategorie, nur ein Stockwerk höher. Als eigener Lastfall
    # geführt, würde sie gegen die Nutzlast dieses Geschosses mit ψ₀ = 0,7
    # abgemindert, zusätzlich zur Abminderung über die Geschosszahl (α_n) —
    # zweimal dasselbe Argument, und der Lastabtrag käme systematisch zu leicht
    # heraus.
    #
    # Sie fließt deshalb in den vorhandenen Nutzlastfall ein und addiert sich
    # dort. Die Abminderung über die Geschosse macht allein `lastabtrag.
    # bemessungswert()` mit α_n, an der Stelle, an der ein Nachweis geführt wird.
    #
    # Der ständige Anteil darf dagegen nicht in `EG`: das ist in `plate` die
    # feste Kennung des Plattengewichts, und eine Last darauf überschreibt es
    # (siehe `plate.einzelfelder`) — bei einer 718-m²-Decke verschwanden so
    # 4 667 kN spurlos aus der Rechnung.
    ABTRAG_G = {"id": "ABG", "name": "Lastabtrag ständig", "art": "G",
                "gamma": 1.35, "psi0": 1.0, "psi2": 1.0}
    ABTRAG_NUTZ = {"id": "NUTZ", "name": "Nutzlast (Lastabtrag)", "art": "Q",
                   "gamma": 1.5, "psi0": 0.7, "psi2": 0.3}

    bekannte = {f["id"] for f in lastfaelle}
    for i, last in enumerate(linienlasten or [], start=1):
        staendig = last.get("art", "G") == "G"
        # Schnee und Dachnutzlast bleiben, was sie sind (siehe
        # `LASTFAELLE_DACH`); jede andere veränderliche Last von oben ist
        # Nutzlast derselben Art und fließt in den Nutzlastfall.
        if staendig:
            fall = ABTRAG_G
        elif last.get("lastfall") in LASTFAELLE_DACH:
            fall = LASTFAELLE_DACH[last["lastfall"]]
        else:
            fall = next((f for f in lastfaelle if f["id"] == "NUTZ"), ABTRAG_NUTZ)
        if fall["id"] not in bekannte:
            lastfaelle.append(dict(fall))
            bekannte.add(fall["id"])
        eintrag = {
            "id": f"W{i}", "lastfall": fall["id"],
            "wert": round(float(last["wert"]), 3),
            "richtung": [0, 0, -1],
            "bezug": last.get("bezug"),
            "herkunft": last.get("herkunft", "Lastabtrag aus dem Geschoss darüber"),
            "aus_lastfall": last.get("lastfall"),
        }
        if last.get("typ") == "punkt":
            eintrag.update({"typ": "punkt", "p": last["p"], "einheit": "kN"})
        else:
            eintrag.update({"typ": "linie", "polylinie": last["polylinie"],
                            "einheit": "kN/m"})
        lasten.append(eintrag)

    modell = {
        "schema": "ileen.plan.fem/1.0",
        "erzeugt": datetime.now(timezone.utc).isoformat(),
        "einheiten": {"laenge": "m", "kraft": "kN", "flaechenlast": "kN/m2",
                      "spannung": "kN/m2"},
        "plan": {
            "job_id": job_id,
            "titel": f"Decke über {geschoss['name']}",
            "modell": modellname,
            "mode": "grundriss",
            "ansicht": "aufsicht",
            "massstab": 100,
            "ebene_ursprung": decke.get("plane_origin"),
            "bounds": decke.get("bounds"),
            "geschoss": geschoss["name"],
        },
        "system": [{
            "id": "P1",
            "umriss": umriss,
            "oeffnungen": oeffnungen,
            "flaeche_m2": flaeche_m2,
            "dicke_m": dicke,
            # Eine Holzbalkendecke bringt ihren Werkstoff mit (orthotrope
            # Ersatzplatte, `kette.ersatzplatte_werkstoff()`).
            "material": annahmen.get("_ersatzplatte") or {
                "name": guete,
                "E_kNm2": kennwerte["E_Nmm2"] * 1000,
                "nu": kennwerte["nu"],
                "wichte_kNm3": kennwerte["wichte"],
            },
            "bezug": platte_gid,
            "bodengebettet": bool(annahmen.get("bodengebettet", False)),
            "bettung_kNm3": annahmen.get("bettung_kNm3"),
        }],
        "lastfaelle": lastfaelle,
        "lasten": lasten,
        "auflager": [{k: v for k, v in a.items() if not k.startswith("_")}
                     for a in auflager],
        "unterzuege": uz_liste,
        "positionen": [],
        "bauteile": [],
        "raeume": nutz_protokoll,
        "hinweise": [
            "Aus dem IFC abgeleitet, nicht im Zeichenmodus gezeichnet.",
            f"Deckendicke {dicke*100:.0f} cm — {dicke_quelle}.",
            f"Auflager: {len(auflager)} aus {len(wandprotokoll)} Bauteilen"
            + (f", {len(verworfen)} nichttragende" if verworfen else "")
            + (f", {ausserhalb} außerhalb dieser Platte" if ausserhalb else "")
            + " verworfen." if (verworfen or ausserhalb) else ".",
            *( [f"{len(linienlasten)} Linienlasten aus dem Lastabtrag des Geschosses darüber."]
               if linienlasten else [] ),
            *uz_hinweise,
            *([f"{sum(len(v['gids']) for v in staender_je_wand.values())} Ständer in "
               f"{len(staender_je_wand)} tragenden Wänden gehören zu ihrer Wand — kein "
               f"eigenes Lager, ihr Gewicht trägt die Wand."]
              if staender_je_wand else []),
            *([f"{len(ueber_sturz)} Wand/Wände tragen über Öffnungen hinweg (Sturz): "
               f"Lager aus dem Schnitt knapp unter der Decke — "
               + ", ".join(sorted(ueber_sturz)[:6]) + (" …" if len(ueber_sturz) > 6 else "")]
              if ueber_sturz else []),
            "Vorbemessung. Kein Standsicherheitsnachweis.",
        ],
    }

    protokoll = {
        "platte": {"global_id": platte_gid, "name": platte.get("name"),
                   "flaeche_m2": flaeche_m2, "material_ifc": platte.get("material")},
        "dicke_m": dicke,
        "dicke_quelle": dicke_quelle,
        "beton": guete,
        "geschosshoehe_m": round(geschosshoehe, 3),
        "waende": wandprotokoll,
        "auflager_gesamt_m": round(sum(a["_laenge"] for a in auflager), 1),
        "lager_zusammengefuehrt": zusammengefuehrt,
        "auflager_anzahl": len(auflager),
        "lager_ueber_sturz": sorted(ueber_sturz),
        "verworfen_nichttragend": verworfen,
        "trennwandzuschlag": zuschlag,
        "nutzlastflaechen": nutz_protokoll,
        "verworfen_ausserhalb": ausserhalb,
        "dach": dach,
        "lasten": {"ausbau_kNm2": ausbau, "nutzlast_kNm2": nutz_wert,
                   "kategorie": f"{kategorie} — {nutz_text}"},
        "lastabtrag_linien": len(linienlasten or []),
    }
    modell["plan"]["dach"] = dach
    return {"modell": modell, "protokoll": protokoll}
