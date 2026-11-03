"""
Unterzüge und Überzüge: Schnittgrößen aus dem Volumenmodell, Bemessung als
Plattenbalken.

**Warum es dieses Modul gibt.** `plate.vernetze()` bildet einen Unterzug seit
jeher geometrisch ab — die betroffenen Rasterspalten bekommen zusätzliche
Elementlagen nach unten (oder beim Überzug nach oben). Damit steht der Balken
im Gleichungssystem und versteift die Decke richtig; die Durchbiegung, die
Momentenverteilung und die Auflagerkräfte stimmen. Was fehlte, war die
**Auswertung**: `plate.schnittgroessen()` kann in diesem Streifen nichts
liefern, weil dort „Moment je Meter Plattenbreite" keine Größe mehr ist, und
setzte deshalb NaN. Der Unterzug war also in der Rechnung, aber nicht im
Ergebnis — kein Moment, keine Querkraft, keine Bewehrung.

Hier kommt beides zurück:

| Schritt | Funktion |
|---|---|
| Balken aus dem Plan herausziehen und auf das Netz beziehen | `finde()` |
| Spannungen über den Querschnitt zu M, N integrieren | `schnittgroessen()` |
| Querkraft aus dem Momentenverlauf, Streckenlast aus der Querkraft | `verlauf()` |
| mitwirkende Plattenbreite nach EC2 5.3.2.1 | `mitwirkende_breite()` |
| Biegung, Querkraft, Staffelung | `bemessung()` |

**Der Kern ist die Integration.** Am Querschnitt s liegt eine Scheibe des
Netzes; jedes ihrer Elemente trägt eine Längsspannung σ_ll und eine
Querschnittsfläche dA = dq·dz bei. Daraus

    N = ∫ σ_ll dA ,   z_s = ∫ z dA / ∫ dA ,   M = −∫ σ_ll·(z − z_s) dA

— die Definition der Schnittgrößen, nicht eine Näherung. Das Vorzeichen ist
das der Platte: positives M bedeutet Zug an der Unterseite.

**Die Breite des Integrationsstreifens ist eine Entscheidung, keine
Naturkonstante.** In einem Kontinuum aus Platte und Steg gibt es keinen
eindeutigen „Balken" — je breiter man integriert, desto mehr Moment schreibt
man ihm zu, und desto weniger bleibt für die Platte daneben. Genommen wird
deshalb die mitwirkende Breite b_eff nach EC2 5.3.2.1, also genau die Breite,
mit der anschließend auch bemessen wird. Damit sind Schnittgröße und
Querschnitt dieselbe Annahme, und die Bemessung ist in sich schlüssig.

Weil das Raster diskret ist, trifft der Streifen b_eff nie genau; ausgewiesen
und für die Bemessung verwendet wird deshalb `breite_ist_m` — die Summe der
tatsächlich einbezogenen Elementbreiten.

**Was hier nicht gerechnet wird.** Torsion (der Randunterzug einer
auskragenden Platte braucht sie), Kippen schlanker Träger, und Balken, die
schräg zum Raster liegen — das Netz ist achsparallel, ein schräger Steg wäre
eine Treppe, und die Integration über eine Treppe ist keine Querschnittsgröße.
Solche Balken werden gemeldet und übersprungen.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import beton as bt
from . import plate
from .plate import Modell, Netz, _merken, abstand_zu_polylinie

#: Grenze, ab der eine Balkenachse als „schräg zum Raster" gilt. Dieselbe
#: Schranke wie in `scheibe.wandrichtungen()`.
SCHRAEG = 0.05


@dataclass
class Balken:
    """Ein gerades Balkensegment, auf das Netz bezogen."""

    id: str
    achse: int                  # 0 = längs x, 1 = längs y
    achslage_m: float           # Querkoordinate der Balkenachse
    von_m: float                # Anfang längs der Achse
    bis_m: float                # Ende
    breite_m: float             # b_w, Stegbreite aus dem Plan
    hoehe_m: float              # Gesamthöhe des Querschnitts
    dicke_m: float              # Dicke der Grundplatte (Gurt)
    richtung: str               # 'unten' = Unterzug, 'oben' = Überzug
    polylinie: np.ndarray = field(default_factory=lambda: np.zeros((2, 2)))

    @property
    def laenge_m(self) -> float:
        return float(self.bis_m - self.von_m)

    @property
    def steg_m(self) -> float:
        """Höhe des über die Platte hinausragenden Teils."""
        return float(self.hoehe_m - self.dicke_m)

    @property
    def art(self) -> str:
        return "Unterzug" if self.richtung != "oben" else "Überzug"

    def __repr__(self) -> str:
        return (f"<{self.art} {self.id}: {'x' if self.achse == 0 else 'y'} "
                f"{self.von_m:.2f}…{self.bis_m:.2f} m bei "
                f"{'y' if self.achse == 0 else 'x'} = {self.achslage_m:.2f}, "
                f"b/h = {self.breite_m:.2f}/{self.hoehe_m:.2f} m>")


def finde(modell: Modell, netz: Netz) -> list[Balken]:
    """
    Die Unterzüge des Plans als Balkensegmente.

    Eine Polylinie mit Knick ist statisch nicht *ein* Balken, sondern zwei —
    genauso, wie `scheibe.wandrichtungen()` eine über Eck gezeichnete
    Auflagerlinie in zwei Wandscheiben zerlegt. Segmente bekommen die Kennung
    `U1.1`, `U1.2`; ein gerader Balken behält seine.

    Übersprungen (und vermerkt) werden Balken, deren Höhe die Plattendicke
    nicht übersteigt — die hat schon `vernetze()` verworfen — und solche, die
    schräg zum Raster liegen.

    **Im System des Rasters.** Bei einem gedrehten Gebäude (`plate.
    hauptrichtung()`) liegen die Unterzüge achsparallel zum Raster, nicht zu
    den Weltachsen; Achse, Lage und Stationen zählen deshalb dort
    (`netz.lokal()`). `polylinie` bleibt in Weltkoordinaten, fürs Zeichnen.
    """
    dicke = float(modell.platte()["dicke_m"])
    ergebnis: list[Balken] = []

    for eintrag in modell.balken:
        welt = np.asarray(eintrag["polylinie"], dtype=float)[:, :2]
        linie = netz.lokal(welt)
        hoehe = float(eintrag["hoehe_m"])
        breite = float(eintrag["breite_m"])
        kennung = str(eintrag.get("id", "U?"))
        if hoehe - dicke <= 1e-6:
            continue                    # `vernetze()` hat das bereits vermerkt

        mehrteilig = len(linie) > 2
        for i in range(len(linie) - 1):
            a, b = linie[i], linie[i + 1]
            richtungsvektor = b - a
            laenge = float(np.linalg.norm(richtungsvektor))
            if laenge < 1e-9:
                continue
            einheit = richtungsvektor / laenge
            achse = 0 if abs(einheit[0]) >= abs(einheit[1]) else 1
            name = f"{kennung}.{i + 1}" if mehrteilig else kennung

            if min(abs(einheit[0]), abs(einheit[1])) > SCHRAEG:
                _merken(modell,
                        f"Unterzug {name} verläuft schräg zum Raster — das Netz bildet "
                        "ihn als Treppe ab, ein Querschnitt ließe sich daraus nicht "
                        "integrieren. Er versteift die Decke, wird aber nicht bemessen.")
                continue

            quer = 1 - achse
            ergebnis.append(Balken(
                id=name, achse=achse,
                achslage_m=float((a[quer] + b[quer]) / 2.0),
                von_m=float(min(a[achse], b[achse])),
                bis_m=float(max(a[achse], b[achse])),
                breite_m=breite, hoehe_m=hoehe, dicke_m=dicke,
                richtung=str(eintrag.get("richtung", "unten")),
                polylinie=np.stack([welt[i], welt[i + 1]]),
            ))
    return ergebnis


# ──────────────────────────────────────────────────────────────────────────
# Schnittgrößen
# ──────────────────────────────────────────────────────────────────────────


def _streifen(netz: Netz, balken: Balken, breite_m: float):
    """
    Die Elemente des Integrationsstreifens, nach Stationen sortiert.

    @returns (maske, station_index, stationen, dq, dz, z_mitte)
    """
    ecken = netz.points[netz.cells]                      # (m, 8, 3)
    # Grundriss im System des Rasters, Höhe unverändert.
    ecken = np.concatenate([netz.lokal(ecken[:, :, :2]), ecken[:, :, 2:]], axis=2)
    mitten = ecken.mean(axis=1)
    laengs, quer = balken.achse, 1 - balken.achse

    dq = ecken[:, :, quer].max(axis=1) - ecken[:, :, quer].min(axis=1)
    halbe = breite_m / 2.0
    innerhalb = (np.abs(mitten[:, quer] - balken.achslage_m) <= halbe) & \
                (mitten[:, laengs] >= balken.von_m - 1e-9) & \
                (mitten[:, laengs] <= balken.bis_m + 1e-9)

    if not innerhalb.any():
        return innerhalb, None, np.zeros(0), dq, plate.lagenhoehe(netz), mitten[:, 2], 0.0

    schluessel = np.round(mitten[innerhalb, laengs], 6)
    stationen, umkehr = np.unique(schluessel, return_inverse=True)

    # Die Breite, die der Streifen tatsächlich erfasst: die Summe der
    # Elementbreiten über die *verschiedenen* Querlagen. Nicht aus
    # Fläche/Höhe zurückgerechnet — im Balkenstreifen sind die Säulen
    # verschieden hoch, und die Division ergäbe eine Mischgröße.
    quer_lagen, erste = np.unique(np.round(mitten[innerhalb, quer], 6), return_index=True)
    breite_ist = float(dq[innerhalb][erste].sum())

    return (innerhalb, umkehr.ravel(), stationen, dq, plate.lagenhoehe(netz),
            mitten[:, 2], breite_ist)


def schnittgroessen(loesung: np.ndarray, netz: Netz, E: float, nu: float,
                    balken: Balken, breite_m: float | None = None) -> dict:
    """
    M, N und die Querschnittswerte des Balkens, Station für Station.

    Integriert wird über den Streifen der Breite `breite_m` (ohne Angabe: die
    Stegbreite) über die volle Höhe der dortigen Netzsäulen — also über Steg
    *und* Gurt, denn beide tragen das Moment gemeinsam.

    **Warum nicht die Spannung an der Unterkante genügt.** Man könnte σ am
    untersten Element ablesen und mit dem Widerstandsmoment multiplizieren.
    Nur ist der Querschnitt ein T, sein Schwerpunkt liegt nicht in halber Höhe,
    und die Elementmitte liegt nicht am Rand — beide Fehler wirken in dieselbe
    Richtung und sind einzeln nicht zu sehen. Die Integration braucht keine
    dieser Annahmen.

    **Und warum die Summe Σσ·z·dA allein nicht reicht.** Sie wertet die
    Spannung in den Elementmitten aus, und die Mittelpunktregel unterschätzt
    ∫z²dz um genau 1/n² — bei zwei Lagen über die Plattendicke also um ein
    Viertel. Gegen eine Kontrollrechnung gemessen fehlten dadurch exakt 25 %
    des Moments, in jeder Netzfeinheit dieselben 25 %: ein Faktor, den keine
    Verfeinerung findet, weil er nicht kleiner wird.

    `plate.schnittgroessen()` löst das für die Platte, indem es den linearen
    Spannungsverlauf im Sinne kleinster Quadrate anpasst und anschließend
    *exakt* integriert. Hier steht dieselbe Rechnung für einen beliebigen
    Querschnitt: aus der Steigung

        b = Σσ·ζ·dA / Σζ²·dA        (ζ = z − z_s, Elementmitten)

    und dem **exakten** Flächenträgheitsmoment des Querschnitts

        I = Σ dA·(ζ² + Δz²/12)      (Steiner je Element, nicht Mittelpunktregel)

    folgt M = −b·I. Für den geradlinigen Anteil — und der trägt das Moment —
    ist das unabhängig von der Lagenzahl exakt.

    @returns dict mit `s` (Stationen in m), `M_kNm`, `N_kN`, `A_m2`, `I_m4`,
             `z_s_m` (Schwerpunkthöhe in Netzkoordinaten), `breite_ist_m`
    """
    breite = float(breite_m if breite_m is not None else balken.breite_m)
    maske, umkehr, stationen, dq, dz, z_mitte, breite_ist = _streifen(netz, balken, breite)
    if umkehr is None:
        raise ValueError(
            f"Unterzug {balken.id}: kein Element im Integrationsstreifen "
            f"(Breite {breite:.3f} m). Liegt die Achse im Systemumriss?")

    _, sigma = plate.spannungen(loesung, netz, E, nu, im_raster=True)
    sigma_ll = sigma[maske, balken.achse, balken.achse]
    dA = dq[maske] * dz
    z = z_mitte[maske]

    n = len(stationen)

    def je_station(werte):
        summe = np.zeros(n)
        np.add.at(summe, umkehr, werte)
        return summe

    # Fläche und Schwerpunkt sind auch über die Elementmitten exakt: ∫z dz über
    # ein Element ist Δz·z_Mitte, ohne Restglied.
    flaeche = je_station(dA)
    z_s = je_station(z * dA) / np.maximum(flaeche, 1e-12)
    zeta = z - z_s[umkehr]

    # I: exakt über Steiner je Element. I_mittelpunkt: dieselbe Größe ohne den
    # Eigenanteil Δz²/12 — genau die Näherung, die in der Steigung steckt und
    # sich deshalb gegen sie wegkürzen muss.
    I_exakt = je_station(dA * (zeta ** 2 + dz ** 2 / 12.0))
    I_mittel = je_station(dA * zeta ** 2)

    N = je_station(sigma_ll * dA)
    steigung = je_station(sigma_ll * zeta * dA) / np.maximum(I_mittel, 1e-18)
    M = -steigung * I_exakt

    return {"s": stationen, "M_kNm": M, "N_kN": N, "A_m2": flaeche,
            "I_m4": I_exakt, "z_s_m": z_s,
            "breite_soll_m": breite, "breite_ist_m": breite_ist,
            "balken": balken.id}


def verlauf(schnitt: dict, glaetten: int = 3) -> dict:
    """
    Querkraft und Streckenlast aus dem Momentenverlauf.

        V = dM/ds ,   q = −dV/ds

    **Derselbe Grund wie bei `plate.querkraefte_aus_momenten()`.** Die
    Schubspannung eines HEX8 ist elementweise konstant, während der wirkliche
    Verlauf parabolisch ist; über zwei bis fünf Lagen bleibt davon zu wenig
    übrig, um daraus einen Bemessungswert zu machen. Das Moment dagegen ist die
    zuverlässigste Größe des Modells, und die Ableitung auf einem gleichmäßigen
    Stationsraster ist eine zentrale Differenz.

    Die Streckenlast ist die zweite Ableitung und entsprechend unruhig; sie
    wird über `glaetten` Stationen gemittelt. Sie ist ein *Kontrollwert* — sie
    zeigt, welche Last der Unterzug der Platte tatsächlich abnimmt, und das ist
    die Zahl, mit der man das Modell gegen eine Handrechnung hält. Bemessen
    wird mit V, nicht mit q.
    """
    s = np.asarray(schnitt["s"], dtype=float)
    M = np.asarray(schnitt["M_kNm"], dtype=float)
    if len(s) < 3:
        null = np.zeros_like(M)
        return {**schnitt, "V_kN": null, "q_kNm": null}

    V = np.gradient(M, s)
    q = -np.gradient(V, s)
    breite = int(glaetten) | 1                      # ungerade, sonst wandert die Mitte
    if breite > 1 and len(q) > breite:
        kern = np.ones(breite) / float(breite)
        q = np.convolve(np.pad(q, breite // 2, mode="edge"), kern, mode="valid")
    return {**schnitt, "V_kN": V, "q_kNm": q}


def durchbiegung(loesung: np.ndarray, netz: Netz, balken: Balken,
                 lager_liste: list[dict], breite_m: float | None = None,
                 grenze: float = 250.0) -> dict:
    """
    Durchbiegung entlang der Balkenachse, an der tatsächlichen Unterseite des Stegs.

    Anders als M und V kommt sie nicht aus der Einhüllenden der
    GZT-Kombinationen, sondern soll auf der **quasi-ständigen** gerechnet
    werden — derselben Kombination, mit der `plate.durchbiegung()` die Platte
    nachweist. Der Grenzwert gilt für den Gebrauchszustand, nicht für die
    Bemessungslast.

    **Der Grenzwert ist keine einzelne Zahl, sondern feldweise konstant.** Bei
    einem Durchlaufträger hat jedes Feld — der Abstand zweier benachbarter
    Auflager, an den Enden ein Kragarm bis zum ersten bzw. letzten — seine
    eigene Spannweite und damit seinen eigenen Grenzwert l_Feld/250, genau wie
    EC2 7.4.1 die Stützweite je Feld bildet, nicht für den ganzen Träger auf
    einmal. Ein punktweiser Grenzwert — Abstand zum nächsten Auflager,
    verdoppelt — klingt naheliegend, erzeugt aber ein Artefakt: unmittelbar
    neben einem Auflager hat die Durchbiegung eine Steigung ungleich null,
    ihr Nenner (der punktweise Abstand) geht aber schneller gegen null als
    ihr Zähler — die Ausnutzung schösse dort über den wahren Wert aus der
    Feldmitte hinaus. Konstant je Feld vermeidet das.

    @returns dict mit `s`, `w_mm`, `grenzwert_mm` und `ausnutzung` — alle drei
             stationsweise, `grenzwert_mm` dabei innerhalb jedes Feldes
             konstant —, dazu `w_max_mm`, `s_max_m`, `grenzwert_bei_max_mm`
             und `ausnutzung_max` am ungünstigsten Punkt.
    """
    breite = float(breite_m if breite_m is not None else balken.breite_m)
    unten = plate.unterseiten_knoten(netz)
    xy = netz.lokal(netz.points[:, :2])
    laengs, quer = balken.achse, 1 - balken.achse

    halbe = breite / 2.0
    innerhalb = unten & \
        (np.abs(xy[:, quer] - balken.achslage_m) <= halbe) & \
        (xy[:, laengs] >= balken.von_m - 1e-9) & \
        (xy[:, laengs] <= balken.bis_m + 1e-9)

    if not innerhalb.any():
        raise ValueError(
            f"Unterzug {balken.id}: kein Knoten an der Unterseite im "
            f"Integrationsstreifen (Breite {breite:.3f} m).")

    schluessel = np.round(xy[innerhalb, laengs], 6)
    stationen, umkehr = np.unique(schluessel, return_inverse=True)
    uz = np.asarray(loesung)[innerhalb, 2]

    n = len(stationen)
    summe = np.zeros(n)
    anzahl = np.zeros(n)
    np.add.at(summe, umkehr, -uz * 1000.0)
    np.add.at(anzahl, umkehr, 1.0)
    w_mm = summe / np.maximum(anzahl, 1.0)

    # Feldgrenzen: Balkenenden plus jedes Auflager dazwischen. Ohne erkannte
    # Auflager bleibt nur ein Feld über die ganze Länge — dieselbe Rückfallregel
    # wie bei `plate.spannweite()` ohne `modell`.
    grenzen = sorted({float(stationen[0]), float(stationen[-1])}
                     | {float(l["s_m"]) for l in (lager_liste or [])})
    grenzwert_mm = np.full(n, (grenzen[-1] - grenzen[0]) / grenze * 1000.0)
    for a, b in zip(grenzen[:-1], grenzen[1:]):
        feldlaenge = b - a
        if feldlaenge < 1e-9:
            continue
        drin = (stationen >= a - 1e-9) & (stationen <= b + 1e-9)
        grenzwert_mm[drin] = feldlaenge / grenze * 1000.0
    ausnutzung = w_mm / np.maximum(grenzwert_mm, 1e-9)

    i = int(np.argmax(ausnutzung))
    return {
        "s": stationen, "w_mm": w_mm,
        "grenzwert_mm": grenzwert_mm, "ausnutzung": ausnutzung,
        "w_max_mm": float(w_mm[i]), "s_max_m": float(stationen[i]),
        "grenzwert_bei_max_mm": float(grenzwert_mm[i]),
        "ausnutzung_max": float(ausnutzung[i]),
    }


def lager(modell: Modell, netz: Netz, balken: Balken, stationen: np.ndarray,
          toleranz: float | None = None) -> list[dict]:
    """
    Wo der Balken aufliegt — Stationen, an denen seine Achse ein Auflager trifft.

    Das ist die Angabe, die das statische System überhaupt erst lesbar macht:
    ohne sie ist die Momentenlinie eine Kurve ohne Stützstellen. Gesucht wird
    mit demselben Suchradius wie in `plate.randbedingungen()`, damit ein Lager,
    das dort Knoten erfasst hat, hier nicht durchfällt.
    """
    tol = float(toleranz or max(netz.groesse * 0.6, 1e-3))
    laengs, quer = balken.achse, 1 - balken.achse

    punkte = np.zeros((len(stationen), 2))
    punkte[:, laengs] = stationen
    punkte[:, quer] = balken.achslage_m

    treffer = []
    for eintrag in modell.auflager:
        if eintrag["typ"] == "punkt":
            ort = netz.lokal(np.asarray(eintrag["p"], dtype=float)[None, :2])[0]
            abstand = np.linalg.norm(punkte - ort, axis=1)
        else:
            abstand = abstand_zu_polylinie(
                punkte, netz.lokal(np.asarray(eintrag["polylinie"], dtype=float)[:, :2]))
        nahe = abstand <= tol
        if not nahe.any():
            continue
        # Zusammenhängende Bereiche zu je einem Lager zusammenfassen.
        kanten = np.diff(nahe.astype(int))
        starts = list(np.flatnonzero(kanten == 1) + 1)
        enden = list(np.flatnonzero(kanten == -1) + 1)
        if nahe[0]:
            starts.insert(0, 0)
        if nahe[-1]:
            enden.append(len(nahe))
        for a, b in zip(starts, enden):
            treffer.append({
                "id": eintrag["id"], "typ": eintrag["typ"],
                "art": eintrag.get("art", "gelenkig"),
                "s_m": float(stationen[a:b].mean()),
                "von_m": float(stationen[a]), "bis_m": float(stationen[b - 1]),
            })
    return sorted(treffer, key=lambda t: t["s_m"])


def felder(s: np.ndarray, M: np.ndarray, mindestanteil: float = 0.08) -> list[dict]:
    """
    Die Felder des Balkens — Abschnitte zwischen den Nullstellen des Moments.

    Ihre Länge ist das l₀ aus EC2 5.3.2.1, aus dem die mitwirkende Breite
    folgt. Die Norm gibt dafür Faustwerte (0,85·l beim Endfeld, 0,70·l beim
    Innenfeld), weil man die Nullstellen im Handverfahren nicht kennt — hier
    stehen sie im Ergebnis, also werden sie benutzt.

    **Kurze Scheinfelder fallen heraus.** Am Auflagerrand wechselt das Moment
    gern zweimal auf wenigen Zentimetern — das ist die Randstörung des
    Volumenmodells, kein Feld. Ohne Filter stünde in der Feldliste ein „Feld"
    von zwei Zentimetern, und weil `rechne()` das *größte* l₀ nimmt, wäre das
    zwar harmlos, in der Ausgabe aber nur verwirrend. `mindestanteil` misst in
    Bruchteilen der Balkenlänge.
    """
    s = np.asarray(s, dtype=float)
    M = np.asarray(M, dtype=float)
    vorzeichen = np.sign(M)
    wechsel = np.flatnonzero(np.diff(vorzeichen) != 0)
    mindest = mindestanteil * float(s[-1] - s[0])

    grenzen = [float(s[0])]
    for i in wechsel:
        if abs(M[i + 1] - M[i]) < 1e-12:
            continue
        anteil = abs(M[i]) / abs(M[i + 1] - M[i])
        stelle = float(s[i] + anteil * (s[i + 1] - s[i]))
        if stelle - grenzen[-1] < mindest:
            continue
        grenzen.append(stelle)
    if len(grenzen) > 1 and float(s[-1]) - grenzen[-1] < mindest:
        grenzen.pop()
    grenzen.append(float(s[-1]))

    ergebnis = []
    for a, b in zip(grenzen[:-1], grenzen[1:]):
        if b - a < 1e-6:
            continue
        drin = (s >= a) & (s <= b)
        ergebnis.append({
            "von_m": a, "bis_m": b, "l_0_m": b - a,
            "vorzeichen": 1 if (M[drin].sum() if drin.any() else 0.0) >= 0 else -1,
        })
    return ergebnis


def mitwirkende_breite(balken: Balken, netz: Netz, l_0_m: float,
                       andere: list[Balken] | None = None) -> dict:
    """
    Mitwirkende Plattenbreite b_eff nach EC2 5.3.2.1.

        b_eff,i = 0,2·b_i + 0,1·l₀  ≤  0,2·l₀  und  ≤ b_i
        b_eff   = Σ b_eff,i + b_w   ≤  b

    **Was b_i ist.** Nicht die halbe Deckenbreite, sondern der Abstand vom
    Stegrand bis zur nächsten Begrenzung: entweder bis zur Mitte des Feldes
    zwischen diesem und dem nächsten Unterzug, oder bis zum Plattenrand. Hier
    wird beides aus dem Netz gemessen — der Umriss steht ohnehin darin, und
    parallel laufende Unterzüge kennt das Modell auch.

    **Ein b_eff für den ganzen Balken.** Die Norm lässt b_eff feldweise
    verschieden zu (Fig. 5.3), und rechnerisch wäre das hier möglich. Es hätte
    aber einen Sprung in der Integrationsbreite zur Folge — und damit einen
    Sprung in der Momentenlinie, der wie ein Rechenfehler aussieht und keiner
    ist. Für eine Vorbemessung wird deshalb das maßgebende (größte) l₀
    genommen und b_eff über die Länge konstant gehalten.
    """
    quer = 1 - balken.achse
    umriss = netz.lokal(netz.polygon)
    rand_min = float(umriss[:, quer].min())
    rand_max = float(umriss[:, quer].max())

    grenzen = {"-": rand_min, "+": rand_max}
    for anderer in (andere or []):
        if anderer is balken or anderer.achse != balken.achse:
            continue
        lage = anderer.achslage_m
        # Zwischen zwei parallelen Unterzügen liegt die Grenze in der Mitte.
        mitte = (lage + balken.achslage_m) / 2.0
        if lage < balken.achslage_m - 1e-9:
            grenzen["-"] = max(grenzen["-"], mitte)
        elif lage > balken.achslage_m + 1e-9:
            grenzen["+"] = min(grenzen["+"], mitte)

    anteile = {}
    for seite, grenze in grenzen.items():
        b_i = max(abs(grenze - balken.achslage_m) - balken.breite_m / 2.0, 0.0)
        anteile[seite] = min(0.2 * b_i + 0.1 * l_0_m, 0.2 * l_0_m, b_i)

    b_eff = balken.breite_m + sum(anteile.values())
    verfuegbar = balken.breite_m + sum(
        max(abs(g - balken.achslage_m) - balken.breite_m / 2.0, 0.0)
        for g in grenzen.values())
    return {
        "b_eff_m": float(min(b_eff, verfuegbar)),
        "b_i_m": {seite: float(max(abs(g - balken.achslage_m) - balken.breite_m / 2.0, 0.0))
                  for seite, g in grenzen.items()},
        "b_eff_i_m": {seite: float(w) for seite, w in anteile.items()},
        "l_0_m": float(l_0_m),
        "verfuegbar_m": float(verfuegbar),
    }


# ──────────────────────────────────────────────────────────────────────────
# Bemessung
# ──────────────────────────────────────────────────────────────────────────


def nutzhoehen(balken: Balken, c_nom_mm: float, buegel_mm: float = 8.0,
               laengs_mm: float = 16.0, bilder: dict | None = None) -> dict:
    """
    Nutzhöhen des Balkens, von der jeweils gedrückten Seite gemessen.

    d = h − c_nom − Ø_Bügel − Ø_längs/2 gilt für beide Seiten; sie
    unterscheiden sich nur, wenn Deckung oder Durchmesser oben und unten
    verschieden sind. Geführt werden trotzdem beide, weil die Feldbewehrung
    unten und die Stützbewehrung oben liegt — und weil beim Überzug oben und
    unten vertauscht sind.

    **Sobald das Stabbild vorliegt, gilt es.** `laengs_mm` ist nur die Annahme
    für den ersten Anlauf — welcher Durchmesser gewählt wird und ob die Stäbe
    in eine oder zwei Lagen gehen, steht erst danach fest. `bilder` sind die
    Stabbilder aus `beton.stablagen()` je Seite; ihr Schwerpunkt tritt dann an
    die Stelle des Randabstands. Bei zweilagiger Bewehrung sind das schnell
    3 cm weniger Nutzhöhe, und die gehen unmittelbar in die Bewehrungsmenge.
    """
    rand = (c_nom_mm + buegel_mm + laengs_mm / 2.0) / 1000.0
    d = {"d_unten_m": float(balken.hoehe_m - rand),
         "d_oben_m": float(balken.hoehe_m - rand),
         "randabstand_m": float(rand),
         "randabstand_unten_m": float(rand), "randabstand_oben_m": float(rand),
         "lagen_unten": 1, "lagen_oben": 1}
    for seite in ("unten", "oben"):
        bild = (bilder or {}).get(seite)
        if not bild or not bild.get("lagen"):
            continue
        d[f"d_{seite}_m"] = float(bild["d_m"])
        d[f"randabstand_{seite}_m"] = float(bild["schwerpunkt_m"])
        d[f"lagen_{seite}"] = len(bild["lagen"])
    return d


def _druckzone(balken: Balken, feldmoment: bool, b_eff: float) -> tuple[float, float, float]:
    """
    Breite und Dicke der gedrückten Zone am gedrückten Rand.

    | | Feldmoment (Zug unten) | Stützmoment (Zug oben) |
    |---|---|---|
    | Unterzug | Druck oben = Gurt, b_eff | Druck unten = Steg, b_w |
    | Überzug  | Druck oben = Steg, b_w   | Druck unten = Gurt, b_eff |

    Diese Tabelle ist der ganze Unterschied zwischen einer Feld- und einer
    Stützbemessung am Plattenbalken — und der Grund, warum die Stützbewehrung
    eines Unterzugs regelmäßig überrascht: dort steht nur der schmale Steg
    unter Druck, nicht die ganze Deckenplatte.
    """
    gurt_oben = balken.richtung != "oben"
    druck_oben = feldmoment
    if druck_oben == gurt_oben:
        return b_eff, balken.dicke_m, balken.breite_m
    return balken.breite_m, 0.0, balken.breite_m


def bemessung(balken: Balken, schnitt: dict, beton_: bt.Beton, b_eff_m: float,
              c_nom_mm: float = 25.0, buegel_mm: float = 8.0, laengs_mm: float = 16.0,
              stahl: bt.Stahl = bt.B500B, n_kN=0.0, bilder: dict | None = None) -> dict:
    """
    Biege- und Querkraftbemessung des Balkens über seine ganze Länge.

    Feld und Stütze werden getrennt geführt, weil sie verschiedene Querschnitte
    sind (siehe `_druckzone()`) und die Bewehrung an verschiedenen Rändern
    liegt. Zurück kommt für jede Station beides — der Verlauf ist die Grundlage
    der Staffelung.

    Die Mindestbewehrung ist die des Balkens nach EC2 9.2.1.1, bezogen auf den
    Steg: A_s,min = max(0,26·f_ctm/f_yk; 0,0013)·b_w·d. Am Plattenbalken mit
    gezogenem Gurt verlangt EC2 zusätzlich, die Bewehrung über b_eff zu
    verteilen — das steht als Hinweis im Ergebnis, weil es die Menge nicht
    ändert, wohl aber die Lage.
    """
    d = nutzhoehen(balken, c_nom_mm, buegel_mm, laengs_mm, bilder)
    M = np.asarray(schnitt["M_kNm"], dtype=float)
    V = np.asarray(schnitt.get("V_kN", np.zeros_like(M)), dtype=float)
    b_ist = float(schnitt.get("breite_ist_m", b_eff_m))

    m_feld = np.maximum(M, 0.0)
    m_stuetze = np.maximum(-M, 0.0)

    b_1f, h_1f, b_2f = _druckzone(balken, True, b_ist)
    b_1s, h_1s, b_2s = _druckzone(balken, False, b_ist)

    unten = bt.plattenbalken(m_feld, d["d_unten_m"], beton_, b_1f, h_1f, b_2f,
                             stahl=stahl, n_Ed=n_kN, h=balken.hoehe_m)
    oben = bt.plattenbalken(m_stuetze, d["d_oben_m"], beton_, b_1s, h_1s, b_2s,
                            stahl=stahl, n_Ed=n_kN, h=balken.hoehe_m)

    a_s_min = max(0.26 * beton_.f_ctm_MNm2 / stahl.f_yk_MNm2, 0.0013) \
        * balken.breite_m * d["d_unten_m"] * 1e4
    a_s_max = 0.04 * balken.breite_m * balken.hoehe_m * 1e4

    quer = bt.querkraftbewehrung(V, balken.breite_m, d["d_unten_m"], beton_,
                                 stahl=stahl, h=balken.hoehe_m)

    hinweise = [h for h in (unten["hinweis"], oben["hinweis"], quer["hinweis"]) if h]
    if np.any(m_stuetze > 1e-6) and balken.richtung != "oben":
        hinweise.append("Stützbewehrung liegt im gezogenen Gurt — nach EC2 9.2.1.2 "
                        "über b_eff verteilen, nicht im Steg bündeln")

    return {
        "s": np.asarray(schnitt["s"], dtype=float),
        "d": d, "b_eff_m": float(b_eff_m), "b_ist_m": b_ist,
        "a_s_unten_cm2": np.maximum(unten["a_s_cm2"], a_s_min),
        "a_s_oben_cm2": np.where(m_stuetze > 1e-6,
                                 np.maximum(oben["a_s_cm2"], a_s_min), a_s_min),
        "a_s_min_cm2": float(a_s_min), "a_s_max_cm2": float(a_s_max),
        "mu_unten": unten["mu"], "mu_oben": oben["mu"],
        "x_unten_m": unten["x_m"], "im_gurt": unten["im_gurt"],
        "querkraft": quer,
        "M_kNm": M, "V_kN": V,
        "hinweis": " · ".join(hinweise),
    }


def staffelung(balken: Balken, bemessen: dict, beton_: bt.Beton, seite: str = "unten",
               c_nom_mm: float = 25.0, buegel_mm: float = 8.0,
               stahl: bt.Stahl = bt.B500B, guter_verbund: bool = True,
               lagen_max: int = 2) -> dict:
    """
    Gestaffelte Längsbewehrung des Balkens — dasselbe Verfahren wie bei der Platte.

    Der Unterschied zu `beton.staffelung()` im Plattenfall steckt allein in der
    Wahl: gelegt werden ganze Stäbe (`beton.waehle_staebe()`), nicht Matten und
    Zulagen je Meter, und das aufnehmbare Moment wird mit b_eff gerechnet. Die
    Grundbewehrung ist die durchlaufende Lage — sie muss mindestens A_s,min
    decken und wird bis zum Auflager durchgeführt.

    Versatzmaß und Verankerungslänge kommen unverändert aus EC2: a_l = z·cot θ/2
    beim Balken *mit* Querkraftbewehrung, hier über den maßgebenden Wert von
    cot θ aus der Querkraftbemessung. Beim Bauteil ohne Bügel wäre a_l = d —
    ein Unterzug hat immer Bügel, deshalb der andere Wert.

    **Die Grundbewehrung ist nicht die Mindestbewehrung.** Bei der Platte ist
    sie es (das Grundnetz liegt ohnehin), beim Balken verlangt EC2 9.2.1.4/NA,
    mindestens ein Viertel der Feldbewehrung bis über das Auflager zu führen —
    sonst reißt der Träger dort auf, wo die Zulage endet. Genommen wird
    deshalb max(A_s,min; 0,25·A_s,Feld). Ohne diese Regel besteht die
    Staffelung aus genau einer Zulage über die ganze Länge, was keine
    Staffelung ist.

    **Am Ende steht ein Stabbild, nicht nur eine Menge.** `bild` ist die
    Anordnung der Stäbe an der ungünstigsten Stelle — Grundbewehrung und
    Zulage zusammen, in so vielen Lagen, wie der Steg verlangt. Erst daraus
    folgt, ob die gewählte Bewehrung überhaupt hineingeht, und mit welcher
    Nutzhöhe zu rechnen ist; `rechne()` bemisst deshalb ein zweites Mal, wenn
    das Bild ein anderes d ergibt als die Annahme des ersten Anlaufs.
    """
    s = bemessen["s"]
    a_s = bemessen[f"a_s_{seite}_cm2"]
    d = bemessen["d"][f"d_{seite}_m"]

    # **Ein Durchmesser für die ganze Lage.** Der Bedarf an der ungünstigsten
    # Stelle bestimmt ihn; Grundbewehrung und Zulagen folgen. Ließe man beide
    # frei wählen, käme regelmäßig „7 Ø 10 durchlaufend + 3 Ø 25 im Feld"
    # heraus — rechnerisch richtig, als Bewehrungsführung unbrauchbar: die
    # Stäbe liegen im selben Bügel, in derselben Lage, und ein Sprung von Ø 10
    # auf Ø 25 macht die Verankerungslängen und die Rissverteilung uneinheitlich.
    spitze = bt.waehle_staebe(float(np.max(a_s)), balken.breite_m, c_nom_mm, buegel_mm,
                              lagen_max=lagen_max)
    nur = [int(spitze["durchmesser_mm"])]

    def waehle(bedarf):
        wahl = bt.waehle_staebe(bedarf, balken.breite_m, c_nom_mm, buegel_mm,
                                durchmesser=nur, lagen_max=lagen_max)
        return {"a_s_cm2": wahl["a_s_cm2"], "durchmesser_mm": wahl["durchmesser_mm"],
                "bezeichnung": wahl["bezeichnung"], "n": wahl["n"]}

    durchlaufend = max(bemessen["a_s_min_cm2"], 0.25 * float(np.max(a_s)))
    grund = bt.waehle_staebe(durchlaufend, balken.breite_m, c_nom_mm, buegel_mm,
                             durchmesser=nur, lagen_max=lagen_max)

    ergebnis = bt.staffelung(
        s, a_s, d, beton_, stahl=stahl,
        grund_cm2=grund["a_s_cm2"], a_s_min_cm2=bemessen["a_s_min_cm2"],
        guter_verbund=guter_verbund, b=bemessen["b_ist_m"], wahl=waehle)

    # Das Versatzmaß eines Balkens mit Bügeln ist z·cot θ/2, nicht d.
    cot = float(np.median(np.atleast_1d(bemessen["querkraft"]["cot_theta"])))
    a_l = float(bemessen["querkraft"]["z_m"] * cot / 2.0)
    verlaengerung = a_l - ergebnis["versatzmass_m"]
    for zulage in ergebnis["zulagen"]:
        zulage["von_m"] = max(zulage["von_m"] - verlaengerung, float(s[0]))
        zulage["bis_m"] = min(zulage["bis_m"] + verlaengerung, float(s[-1]))
        zulage["laenge_m"] = zulage["bis_m"] - zulage["von_m"]
        zulage["versatzmass_m"] = a_l
    ergebnis["versatzmass_m"] = a_l
    ergebnis["cot_theta"] = cot
    ergebnis["grund_bezeichnung"] = grund["bezeichnung"]
    ergebnis["grund_wahl"] = grund

    # Zugkraftdeckung mit den verschobenen Zulagen nachziehen.
    vorhanden = np.full_like(s, ergebnis["grund_cm2"], dtype=float)
    for zulage in ergebnis["zulagen"]:
        drin = (s >= zulage["von_m"]) & (s <= zulage["bis_m"])
        vorhanden = vorhanden + np.where(drin, zulage["a_s_cm2"], 0.0)
    ergebnis["a_s_vorhanden_cm2"] = vorhanden
    ergebnis["m_Rd_kNm"] = bt.moment_widerstand_kNm(
        vorhanden, d, beton_, stahl, b=bemessen["b_ist_m"])

    # Grund- und Zulagestäbe liegen im selben Steg. `waehle_staebe()` wählt
    # jede für sich und weiß nichts von der anderen — erst ihre **Summe** ist
    # das, was der Eisenflechter an der ungünstigsten Stelle nebeneinanderlegen
    # muss. Sie geht deshalb als Ganzes in `beton.stablagen()`: dort entsteht
    # die Lagenaufteilung, der Abstandsnachweis nach EC2 8.2 und der
    # Schwerpunkt, aus dem die tatsächliche Nutzhöhe folgt.
    meiste = grund["n"] + max((z.get("n") or 0 for z in ergebnis["zulagen"]), default=0)
    bild = bt.stablagen(meiste, balken.breite_m, balken.hoehe_m,
                        grund["durchmesser_mm"], seite=seite,
                        c_nom_mm=c_nom_mm, buegel_mm=buegel_mm,
                        lagen_max=lagen_max)
    ergebnis["bild"] = bild
    ergebnis["staebe_je_lage"] = bild["je_lage"]
    ergebnis["staebe_max"] = meiste
    ergebnis["staebe_grund"] = grund["n"]
    ergebnis["lagen"] = len(bild["lagen"])
    ergebnis["a_s_gelegt_cm2"] = bild["a_s_cm2"]
    ergebnis["hinweis"] = bild["hinweis"]
    return ergebnis


def buegelbereiche(bemessen: dict, lager_liste: list[dict]) -> list[dict]:
    """
    Die Bügelbewehrung in wenigen Abschnitten statt als stetiger Verlauf.

    a_sw,erf ist am Auflager am größten und im Feld am kleinsten; ausgeführt
    wird das in zwei bis vier Abschnitten mit festem Bügelabstand. Geteilt wird
    an den Auflagern und in der Mitte zwischen ihnen — das ist die Einteilung,
    die jede Schalungszeichnung zeigt, und sie ist bewusst grob: ein Bügelbild
    mit acht Abschnitten wird auf der Baustelle nicht gebaut.
    """
    s = bemessen["s"]
    quer = bemessen["querkraft"]
    a_sw = np.atleast_1d(quer["a_sw_cm2_je_m"]) * np.ones_like(s)
    s_max = np.atleast_1d(quer["s_max_mm"]) * np.ones_like(s)

    schnitte = sorted({float(s[0]), float(s[-1])}
                      | {l["s_m"] for l in lager_liste}
                      | {float((a["s_m"] + b["s_m"]) / 2.0)
                         for a, b in zip(lager_liste[:-1], lager_liste[1:])})
    if len(schnitte) < 2:
        schnitte = [float(s[0]), float(s[-1])]

    bereiche = []
    for a, b in zip(schnitte[:-1], schnitte[1:]):
        drin = (s >= a - 1e-9) & (s <= b + 1e-9)
        if not drin.any() or b - a < 1e-6:
            continue
        bedarf = float(a_sw[drin].max())
        wahl = bt.waehle_buegel(bedarf, s_max_mm=float(s_max[drin].min()))
        bereiche.append({"von_m": a, "bis_m": b, "laenge_m": b - a,
                         "a_sw_erf_cm2_je_m": bedarf, **wahl})

    # Gleiche Nachbarn zusammenlegen — vier Abschnitte mit demselben Bügel sind
    # kein Bügelbild, sondern ein durchgehender Bereich.
    zusammen: list[dict] = []
    for bereich in bereiche:
        if zusammen and zusammen[-1]["bezeichnung"] == bereich["bezeichnung"]:
            zusammen[-1]["bis_m"] = bereich["bis_m"]
            zusammen[-1]["laenge_m"] = zusammen[-1]["bis_m"] - zusammen[-1]["von_m"]
            zusammen[-1]["a_sw_erf_cm2_je_m"] = max(
                zusammen[-1]["a_sw_erf_cm2_je_m"], bereich["a_sw_erf_cm2_je_m"])
        else:
            zusammen.append(dict(bereich))
    return zusammen


# ──────────────────────────────────────────────────────────────────────────
# Der ganze Weg an einem Stück
# ──────────────────────────────────────────────────────────────────────────


def rechne(modell: Modell, netz: Netz, loesungen: dict[str, np.ndarray],
           E: float, nu: float, beton_: bt.Beton, balken: Balken,
           c_nom_mm: float = 25.0, buegel_mm: float = 8.0, laengs_mm: float = 16.0,
           andere: list[Balken] | None = None, n_kN=0.0,
           scheibenloesung: np.ndarray | None = None,
           quasistaendig: np.ndarray | None = None) -> dict:
    """
    Ein Unterzug von den Verschiebungen bis zur gestaffelten Bewehrung.

    `loesungen` sind die Verschiebungsfelder je GZT-Kombination; eingehüllt
    wird über alle — dieselbe Regel wie bei der Platte, und aus demselben
    Grund: das größte Feldmoment und das größte Stützmoment stammen selten aus
    derselben Kombination.

    Der Ablauf in vier Schritten, jeder für sich nachvollziehbar:

    1. Momentenverlauf über dem **Steg** — nur für die Form, nicht für die
       Bemessung. Daraus die Nullstellen und damit l₀.
    2. b_eff aus l₀ nach EC2 5.3.2.1.
    3. Momentenverlauf noch einmal, jetzt über **b_eff** — das sind die
       Bemessungsschnittgrößen.
    4. Biegung, Querkraft, Staffelung, Bügelbereiche.

    Schritt 1 und 3 unterscheiden sich nur im Integrationsstreifen; die Form
    der Momentenlinie ändert sich dabei kaum, ihre Größe schon.

    `scheibenloesung` ist die Verschiebung aus der Scheibenrechnung (Wind und
    Schiefstellung, `scheibe.py`). Ist sie angegeben, wird über denselben
    Streifen die **Längskraft** integriert und als N_Ed in die Biegebemessung
    gegeben: der Unterzug ist der Gurt des tiefen Trägers, den die Decke unter
    Horizontallast bildet, und in einem Skelettbau mit wenigen aussteifenden
    Wänden ist das kein Nebenwert. Angesetzt wird der Betrag — die Windrichtung
    kehrt sich um, und welches Vorzeichen ein Lastfall hat, ist keine
    Eigenschaft des Bauteils.

    `quasistaendig` ist die Verschiebung aus der quasi-ständigen Kombination —
    dieselbe, mit der `plate.durchbiegung()` die Platte nachweist. Ist sie
    angegeben, steht im Ergebnis zusätzlich `durchbiegung` (siehe
    `durchbiegung()`); ohne sie bleibt das Feld leer, denn die
    GZT-Kombinationen aus `loesungen` sind für einen Verformungsnachweis die
    falsche Last.
    """
    def einhuellen(breite):
        einzeln = {name: verlauf(schnittgroessen(u, netz, E, nu, balken, breite))
                   for name, u in loesungen.items()}
        beliebig = next(iter(einzeln.values()))
        M = plate.einhuellende({k: v["M_kNm"] for k, v in einzeln.items()})
        V = plate.einhuellende({k: v["V_kN"] for k, v in einzeln.items()})
        N = plate.einhuellende({k: v["N_kN"] for k, v in einzeln.items()})
        q = plate.einhuellende({k: v["q_kNm"] for k, v in einzeln.items()})
        return {
            "s": beliebig["s"], "A_m2": beliebig["A_m2"], "z_s_m": beliebig["z_s_m"],
            "breite_ist_m": beliebig["breite_ist_m"], "breite_soll_m": breite,
            "M_max_kNm": M["max"], "M_min_kNm": M["min"],
            "V_kN": np.maximum(np.abs(V["max"]), np.abs(V["min"])),
            "V_max_kN": V["max"], "V_min_kN": V["min"],
            "N_max_kN": N["max"], "N_min_kN": N["min"],
            "q_kNm": q["max"], "einzeln": einzeln,
            "aus_max": M["max_aus"], "aus_min": M["min_aus"],
        }

    vorlauf = einhuellen(balken.breite_m)
    # Für die Nullstellen zählt der Verlauf einer *Kombination*, nicht die
    # Einhüllende: die ist im Feld positiv und an der Stütze negativ zugleich
    # und hätte gar keine Nullstelle mehr.
    fuehrend = max(vorlauf["einzeln"],
                   key=lambda k: np.abs(vorlauf["einzeln"][k]["M_kNm"]).max())
    spannen = felder(vorlauf["s"], vorlauf["einzeln"][fuehrend]["M_kNm"])
    l_0 = max((f["l_0_m"] for f in spannen), default=balken.laenge_m)

    breite = mitwirkende_breite(balken, netz, l_0, andere)
    haupt = einhuellen(breite["b_eff_m"])

    n_gurt = np.abs(np.asarray(n_kN, dtype=float) * np.ones_like(haupt["s"]))
    if scheibenloesung is not None:
        aus_scheibe = schnittgroessen(scheibenloesung, netz, E, nu, balken,
                                      breite["b_eff_m"])
        n_gurt = n_gurt + np.abs(aus_scheibe["N_kN"])
        haupt["N_gurt_kN"] = aus_scheibe["N_kN"]
    n_kN = n_gurt

    schnitt = {"s": haupt["s"], "M_kNm": haupt["M_max_kNm"], "N_kN": haupt["N_max_kN"],
               "V_kN": haupt["V_kN"], "A_m2": haupt["A_m2"], "z_s_m": haupt["z_s_m"],
               "breite_ist_m": haupt["breite_ist_m"]}
    # Feld- und Stützmoment aus verschiedenen Kombinationen: beide werden
    # gebraucht, deshalb wird zweimal bemessen und danach zusammengeführt.
    def bemessen(bilder=None):
        bem_feld = bemessung(balken, {**schnitt, "M_kNm": haupt["M_max_kNm"]},
                             beton_, breite["b_eff_m"], c_nom_mm, buegel_mm, laengs_mm,
                             n_kN=n_kN, bilder=bilder)
        bem_stuetze = bemessung(balken, {**schnitt, "M_kNm": haupt["M_min_kNm"]},
                                beton_, breite["b_eff_m"], c_nom_mm, buegel_mm, laengs_mm,
                                n_kN=n_kN, bilder=bilder)
        b = {**bem_feld, "a_s_oben_cm2": bem_stuetze["a_s_oben_cm2"],
             "mu_oben": bem_stuetze["mu_oben"],
             "M_max_kNm": haupt["M_max_kNm"], "M_min_kNm": haupt["M_min_kNm"]}
        b["hinweis"] = " · ".join(
            h for h in {bem_feld["hinweis"], bem_stuetze["hinweis"]} if h)
        staffel_u = staffelung(balken, b, beton_, "unten", c_nom_mm, buegel_mm)
        staffel_o = (staffelung(balken, b, beton_, "oben", c_nom_mm, buegel_mm,
                                guter_verbund=False)
                     if np.any(haupt["M_min_kNm"] < -1e-6) else None)
        return b, staffel_u, staffel_o

    # **Die Nutzhöhe ist ein Ergebnis, keine Eingabe.** Der erste Anlauf rechnet
    # mit der Annahme „ein Stab Ø 16 in einer Lage"; welcher Durchmesser gewählt
    # wird und ob die Stäbe in zwei Lagen gehen, steht erst nach der Staffelung
    # fest. Beides verschiebt d — bei zwei Lagen um mehrere Zentimeter — und
    # damit die Bewehrungsmenge, die wieder auf die Stabzahl zurückwirkt.
    # Deshalb wird nachgezogen, bis d steht; nach dem zweiten Durchgang ist das
    # praktisch immer der Fall, drei sind die Reißleine.
    bem, staffel_unten, staffel_oben = bemessen()
    for _ in range(2):
        bilder = {"unten": staffel_unten.get("bild"),
                  "oben": staffel_oben.get("bild") if staffel_oben else None}
        d_vorher = (bem["d"]["d_unten_m"], bem["d"]["d_oben_m"])
        neu_bem, neu_u, neu_o = bemessen(bilder)
        bem, staffel_unten, staffel_oben = neu_bem, neu_u, neu_o
        if max(abs(bem["d"]["d_unten_m"] - d_vorher[0]),
               abs(bem["d"]["d_oben_m"] - d_vorher[1])) < 1e-3:
            break

    auflager = lager(modell, netz, balken, haupt["s"])
    ergebnis = {
        "balken": balken,
        "l_0_m": l_0, "felder": spannen, "breite": breite,
        "n_gurt_kN": n_gurt,
        "vorlauf": vorlauf, "schnitt": haupt,
        "bemessung": bem,
        "lager": auflager,
        "staffelung_unten": staffel_unten,
        "staffelung_oben": staffel_oben,
        "buegel": buegelbereiche(bem, auflager),
        "fuehrende_kombination": fuehrend,
    }
    if quasistaendig is not None:
        ergebnis["durchbiegung"] = durchbiegung(quasistaendig, netz, balken, auflager)
    return ergebnis
