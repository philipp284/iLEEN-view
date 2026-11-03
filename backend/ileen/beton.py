"""
Stahlbetonbemessung für Platten und Scheiben nach DIN EN 1992-1-1.

Was hier gerechnet wird und was nicht:

| Nachweis | Fundstelle EC2 | hier |
|---|---|---|
| Biegung mit Längskraft | 6.1 | Spannungsblock, dimensionslos |
| Querkraft ohne Bewehrung | 6.2.2 | v_Rd,c mit ρ_l aus der Feldbewehrung |
| Durchstanzen | 6.4 | Rundschnitt 2d, β nach NA |
| Netzbewehrung aus Scheibenkräften | Anhang F | Baumann/Druckstrebe 45° |
| Mindest- und Höchstbewehrung | 9.2.1.1, 9.3.1.1 | ja |
| Rissbreite | 7.3.3 | ohne direkte Berechnung, Tab. 7.3N |
| Verankerung, Zugkraftdeckung | 8.4, 9.2.1.3 | l_bd, Versatzmaß a_l = d |
| Verformung im Zustand II | 7.4.3 | **nein** — siehe `plate.durchbiegung` |
| Ermüdung, Brand, Erdbeben | — | nein |

**Einheiten.** Wie im ganzen Paket: Längen in m, Kräfte in kN, daraus
Spannungen in kN/m². Nur zwei Größen fallen aus der Reihe, weil die Norm sie so
schreibt und jeder Tragwerksplaner sie so liest: Betonfestigkeiten in MN/m²
(= N/mm²) und Bewehrungsquerschnitte in cm²/m. Beide sind an den Funktionsnamen
und Rückgabefeldern markiert (`_MNm2`, `_cm2`).

**Vektorisiert.** Alle Bemessungsfunktionen nehmen Skalare *oder* numpy-Arrays.
Damit lässt sich ein ganzes Momentenfeld in einem Aufruf bemessen — das ist die
übliche Anwendung, wenn die Momente aus einer FE-Rechnung kommen.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# ──────────────────────────────────────────────────────────────────────────
# Baustoffe
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Beton:
    """
    Betonfestigkeitsklasse mit den abgeleiteten Rechenwerten.

    `alpha_cc = 0,85` ist der Dauerstandsbeiwert des deutschen Nationalen
    Anhangs. Der Grundwert der Norm ist 1,0; wer nach EC2 ohne NA rechnet,
    setzt ihn beim Anlegen um. Das ändert die erforderliche Bewehrung um
    rund 5 %.
    """

    name: str
    f_ck_MNm2: float
    gamma_c: float = 1.5
    alpha_cc: float = 0.85

    @property
    def f_cd_MNm2(self) -> float:
        return self.alpha_cc * self.f_ck_MNm2 / self.gamma_c

    @property
    def f_cd(self) -> float:
        """Bemessungswert der Druckfestigkeit in kN/m² — die Rechengröße."""
        return self.f_cd_MNm2 * 1000.0

    @property
    def f_ctm_MNm2(self) -> float:
        """Mittlere Zugfestigkeit, EC2 Tab. 3.1 (bis C50/60)."""
        return 0.30 * self.f_ck_MNm2 ** (2.0 / 3.0)

    @property
    def f_ctd_MNm2(self) -> float:
        """Bemessungswert der Zugfestigkeit — 5-%-Quantil durch γ_c."""
        return 0.7 * self.f_ctm_MNm2 / self.gamma_c

    @property
    def E_cm_MNm2(self) -> float:
        return 22000.0 * ((self.f_ck_MNm2 + 8.0) / 10.0) ** 0.3

    @property
    def nu_druckstrebe(self) -> float:
        """Abminderung der Druckfestigkeit im gerissenen Zustand, EC2 6.2.2(6)."""
        return 0.6 * (1.0 - self.f_ck_MNm2 / 250.0)

    def __str__(self) -> str:
        return (f"{self.name}: f_ck = {self.f_ck_MNm2:.0f}, f_cd = {self.f_cd_MNm2:.2f}, "
                f"f_ctm = {self.f_ctm_MNm2:.2f} MN/m²")


@dataclass(frozen=True)
class Stahl:
    """Betonstahl. B500B ist der Regelfall im Hochbau."""

    name: str = "B500B"
    f_yk_MNm2: float = 500.0
    gamma_s: float = 1.15
    E_s_MNm2: float = 200000.0

    @property
    def f_yd_MNm2(self) -> float:
        return self.f_yk_MNm2 / self.gamma_s

    @property
    def f_yd(self) -> float:
        """kN/m² — 435 000 für B500B."""
        return self.f_yd_MNm2 * 1000.0


#: Die im Hochbau gebräuchlichen Klassen. Höhere brauchen andere Formeln
#: (η ≠ 1, λ ≠ 0,8) und sind deshalb bewusst nicht dabei.
BETONKLASSEN = {name: Beton(name, f_ck) for name, f_ck in [
    ("C20/25", 20.0), ("C25/30", 25.0), ("C30/37", 30.0),
    ("C35/45", 35.0), ("C40/50", 40.0), ("C45/55", 45.0), ("C50/60", 50.0)]}

B500B = Stahl()


def beton(name: str | Beton) -> Beton:
    """Klasse aus dem Namen — akzeptiert auch ein fertiges `Beton`-Objekt."""
    if isinstance(name, Beton):
        return name
    schluessel = str(name).strip().upper().replace(" ", "")
    if schluessel in BETONKLASSEN:
        return BETONKLASSEN[schluessel]
    raise KeyError(f"Betonklasse '{name}' unbekannt: {list(BETONKLASSEN)}")


# ──────────────────────────────────────────────────────────────────────────
# Betondeckung und Nutzhöhe
# ──────────────────────────────────────────────────────────────────────────


#: Mindestbetondeckung c_min,dur in mm nach EC2 Tab. 4.4N/NA für Betonstahl,
#: dazu das Vorhaltemaß Δc_dev = 10 mm (bzw. 15 mm bei XC4 und aufwärts).
EXPOSITION = {
    "XC1": (10, 10, "trocken oder ständig nass — Innenbauteil"),
    "XC2": (20, 15, "nass, selten trocken — Gründung"),
    "XC3": (20, 15, "mäßige Feuchte — Innenbauteil hoher Luftfeuchte, Außen ohne Regen"),
    "XC4": (25, 15, "wechselnd nass und trocken — bewitterte Außenbauteile"),
    "XD1": (40, 15, "mäßige Feuchte, Chloride"),
    "XF1": (25, 15, "Frost ohne Taumittel, bewittert"),
}


def betondeckung_mm(expositionsklasse: str = "XC1", durchmesser_mm: float = 10.0) -> float:
    """
    c_nom = max(c_min,dur, c_min,b) + Δc_dev in mm.

    `c_min,b` ist der Verbundanteil und entspricht dem Stabdurchmesser: die
    Deckung darf nie kleiner sein als der Stab, den sie umschließt. Bei den
    dünnen Stäben einer Deckenbewehrung ist die Dauerhaftigkeit maßgebend, bei
    Ø 20 und XC1 kippt es.
    """
    klasse = expositionsklasse.strip().upper()
    if klasse not in EXPOSITION:
        raise KeyError(f"Expositionsklasse '{expositionsklasse}' unbekannt: {list(EXPOSITION)}")
    c_min_dur, delta, _ = EXPOSITION[klasse]
    return float(max(c_min_dur, durchmesser_mm) + delta)


def nutzhoehen(h: float, c_nom_mm: float = 20.0, durchmesser_mm: float = 10.0) -> tuple[float, float]:
    """
    Statische Nutzhöhen der beiden Bewehrungsrichtungen in m.

    Die zwei Lagen einer Plattenbewehrung liegen übereinander, nicht
    nebeneinander: die äußere (meist die der größeren Spannweite) hat den
    vollen Hebel, die innere einen Stabdurchmesser weniger. Bei einer 18 cm
    dicken Platte mit Ø 10 sind das 6 % Unterschied im Hebel — genau in der
    Größenordnung, in der man sonst über die dritte Nachkommastelle des
    Beiwerts streitet.

    @returns (d_außen, d_innen) in m
    """
    c = c_nom_mm / 1000.0
    phi = durchmesser_mm / 1000.0
    return h - c - phi / 2.0, h - c - 1.5 * phi


# ──────────────────────────────────────────────────────────────────────────
# Biegebemessung
# ──────────────────────────────────────────────────────────────────────────


#: Grenze der Druckzonenhöhe. ξ = x/d ≤ 0,45 sichert bei B500 die
#: Rotationsfähigkeit; darüber wäre die Platte beim Versagen spröde.
XI_GRENZ = 0.45
#: Zugehöriges Grenzmoment, dimensionslos: μ = λξ(1 − λξ/2) mit λ = 0,8.
MU_GRENZ = 0.8 * XI_GRENZ * (1.0 - 0.8 * XI_GRENZ / 2.0)


def biegebemessung(m_Ed, d: float, beton_: Beton, stahl: Stahl = B500B,
                   b: float = 1.0, n_Ed=0.0, h: float | None = None,
                   d_2: float | None = None) -> dict:
    """
    Erforderliche Biegezugbewehrung in cm²/m, dimensionslos gerechnet.

    **Verfahren.** Spannungsblock nach EC2 3.1.7(3) mit λ = 0,8 und η = 1,0,
    also die Rechteckverteilung über 80 % der Druckzone. Damit wird

        μ_Eds = M_Eds / (b·d²·f_cd),   ζ = λx/d = 1 − √(1 − 2μ),
        z = d(1 − ζ/2),                a_s = ζ·b·d·f_cd / f_yd

    Das ist geschlossen lösbar, während das Parabel-Rechteck-Diagramm eine
    Tabelle oder Iteration braucht; die Bewehrung fällt dabei um weniger als
    2 % anders aus. Wer die Tabellenwerte (kd- oder ω-Verfahren) gewohnt ist,
    findet sie in `ω = ζ` und `ξ = ζ/0,8` wieder.

    **Längskraft.** `n_Ed` ist die Normalkraft in der Plattenebene, Zug positiv
    — bei der Deckenscheibe unter Wind kommt sie aus `scheibe.membrankraefte()`.
    Bemessen wird auf das Moment um die Zugbewehrung,

        M_Eds = M_Ed − N_Ed·z_s1     mit z_s1 = d − h/2,

    und die Normalkraft anschließend wieder abgezogen:
    A_s = (M_Eds/z + N_Ed)/f_yd. Zug vergrößert die Bewehrung, Druck verkleinert
    sie. Ohne diesen Weg würde man Moment und Normalkraft getrennt bemessen und
    die Bewehrung stumpf addieren — das liegt auf der sicheren Seite, kostet
    bei nennenswerter Normalkraft aber spürbar Stahl.

    **Druckbewehrung.** Übersteigt μ_Eds den Grenzwert 0,296, ist die Druckzone
    zu hoch und die Platte würde spröde versagen. Dann wird der Überschuss über
    ein Bewehrungspaar abgedeckt (`a_s2_cm2` > 0) und das im Feld `hinweis`
    vermerkt. Bei einer Decke ist das fast immer ein Zeichen dafür, dass sie zu
    dünn ist — Druckbewehrung in einer Platte ist unwirtschaftlich und im
    Einbau lästig.

    @param m_Ed  Bemessungsmoment in kNm/m, positiv = Zug auf der Seite von `d`
    @param d     statische Nutzhöhe in m
    @param n_Ed  Normalkraft in kN/m, Zug positiv
    @param d_2   Randabstand der Druckbewehrung in m (nur bei μ > μ_lim nötig)
    @returns dict mit `a_s_cm2`, `mu`, `xi`, `z_m`, `a_s2_cm2`, `hinweis`
    """
    m_Ed = np.asarray(m_Ed, dtype=float)
    n_Ed = np.asarray(n_Ed, dtype=float) * np.ones_like(m_Ed)
    # Hebelarm der Normalkraft, bezogen auf die Zugbewehrung. Ohne Angabe der
    # Bauteildicke wird sie aus d zurückgerechnet (Deckung + halber Stab
    # ≈ 3 cm) — für Deckenplatten genau genug.
    h_bauteil = float(h) if h is not None else float(d) + 0.03
    z_s1 = d - h_bauteil / 2.0

    vorzeichen = np.where(m_Ed < 0, -1.0, 1.0)
    m_betrag = np.abs(m_Ed)
    m_Eds = m_betrag - vorzeichen * n_Ed * z_s1
    m_Eds = np.maximum(m_Eds, 0.0)

    f_cd, f_yd = beton_.f_cd, stahl.f_yd
    mu = m_Eds / (b * d ** 2 * f_cd)

    # Über μ = 0,5 hat die Gleichung keine reelle Lösung — der Querschnitt
    # trägt das Moment auch mit beliebiger Bewehrung nicht mehr.
    unmoeglich = mu > 0.49
    mu_rechnen = np.minimum(mu, MU_GRENZ)
    zeta = 1.0 - np.sqrt(np.maximum(1.0 - 2.0 * mu_rechnen, 0.0))
    z = d * (1.0 - zeta / 2.0)
    xi = zeta / 0.8

    # Über dem Grenzmoment wird der Überschuss von einem Bewehrungspaar
    # getragen: unten zusätzlicher Zug, oben Druckbewehrung im Abstand d₂.
    d2 = float(d_2 if d_2 is not None else 0.05)
    m_lim = MU_GRENZ * b * d ** 2 * f_cd
    ueberschuss = np.maximum(m_Eds - m_lim, 0.0)
    a_s2 = ueberschuss / np.maximum(d - d2, 1e-9) / f_yd

    a_s = (np.minimum(m_Eds, m_lim) / np.maximum(z, 1e-9)
           + ueberschuss / np.maximum(d - d2, 1e-9)
           + vorzeichen * n_Ed) / f_yd                       # m²/m
    a_s = np.maximum(a_s, 0.0)

    hinweise = []
    if np.any(ueberschuss > 0):
        hinweise.append(f"μ > {MU_GRENZ:.3f} an {int(np.sum(ueberschuss > 0))} Stellen — "
                        "Druckbewehrung angesetzt, Platte ist dort zu dünn")
    if np.any(unmoeglich):
        hinweise.append("μ > 0,49 — Querschnitt trägt das Moment nicht, Dicke erhöhen")

    return {
        "a_s_cm2": np.asarray(a_s * 1e4),        # m²/m → cm²/m
        "a_s2_cm2": np.asarray(a_s2 * 1e4),
        "mu": np.asarray(mu),
        "xi": np.asarray(xi),
        "z_m": np.asarray(z),
        "hinweis": " · ".join(hinweise),
    }


def mindestbewehrung_cm2(h: float, d: float, beton_: Beton, stahl: Stahl = B500B,
                         b: float = 1.0) -> float:
    """
    Mindestbewehrung gegen sprödes Versagen, EC2 9.2.1.1(1) in cm²/m.

    A_s,min = max(0,26·f_ctm/f_yk·b·d ; 0,0013·b·d). Sie stellt sicher, dass die
    Bewehrung beim Aufreißen des Betons nicht sofort fließt — der Querschnitt
    muss nach dem ersten Riss mehr tragen als davor.
    """
    aus_zugfestigkeit = 0.26 * beton_.f_ctm_MNm2 / stahl.f_yk_MNm2 * b * d
    return float(max(aus_zugfestigkeit, 0.0013 * b * d) * 1e4)


def hoechstbewehrung_cm2(h: float, b: float = 1.0) -> float:
    """A_s,max = 0,04·A_c, EC2 9.2.1.1(3) — außerhalb von Stoßbereichen."""
    return float(0.04 * b * h * 1e4)


def hoechstabstand_mm(h: float, richtung: str = "haupt", maximalbereich: bool = True) -> float:
    """
    Größter zulässiger Stababstand einer Plattenbewehrung, EC2 9.3.1.1(3).

    In Bereichen mit dem größten Moment und unter Einzellasten gilt der engere
    Wert — dort wird die Bewehrung gebraucht, und ein weit gespreiztes Netz
    verteilt die Risse nicht mehr.
    """
    hm = h * 1000.0
    if richtung.startswith("haupt"):
        return min(2.0 * hm, 250.0) if maximalbereich else min(3.0 * hm, 400.0)
    return min(3.0 * hm, 400.0) if maximalbereich else min(3.5 * hm, 450.0)


# ──────────────────────────────────────────────────────────────────────────
# Querkraft
# ──────────────────────────────────────────────────────────────────────────


def querkraftwiderstand(d: float, a_sl_cm2, beton_: Beton, sigma_cp_MNm2=0.0,
                        b: float = 1.0, C_Rdc: float = 0.15 / 1.5) -> dict:
    """
    v_Rd,c einer Platte ohne Querkraftbewehrung in kN/m, EC2 6.2.2(1).

        v_Rd,c = [C_Rd,c·k·(100·ρ_l·f_ck)^(1/3) + 0,12·σ_cp]·b·d
        v_min  = 0,035·k^(3/2)·√f_ck   (Untergrenze)

    `C_Rd,c = 0,15/γ_c` ist der Wert des deutschen Nationalen Anhangs; der
    Grundwert der Norm ist 0,18/γ_c und liegt 20 % höher. Wer ohne NA rechnet,
    übergibt ihn.

    **Der Maßstabsfaktor k = 1 + √(200/d) ist der Grund, warum dünne Platten
    verhältnismäßig viel Querkraft tragen** — bei d = 15 cm ist k = 2,0 (Kappung),
    bei d = 50 cm nur noch 1,63. Und ρ_l ist der Längsbewehrungsgrad *an der
    betrachteten Stelle*: die Querkrafttragfähigkeit hängt an der Biegebewehrung,
    die dort verankert ist. Deshalb gehört dieser Nachweis hinter die
    Biegebemessung und nicht davor.

    @param a_sl_cm2  vorhandene Längsbewehrung in cm²/m (verankert, gestaffelt)
    @param sigma_cp_MNm2  Betondruckspannung aus Normalkraft, Druck positiv
    """
    a_sl = np.asarray(a_sl_cm2, dtype=float) * 1e-4          # cm²/m → m²/m
    k = min(1.0 + np.sqrt(200.0 / (d * 1000.0)), 2.0)
    rho = np.minimum(a_sl / (b * d), 0.02)
    sigma_cp = np.asarray(sigma_cp_MNm2, dtype=float)

    grund = C_Rdc * k * (100.0 * rho * beton_.f_ck_MNm2) ** (1.0 / 3.0)
    minimum = 0.035 * k ** 1.5 * np.sqrt(beton_.f_ck_MNm2)
    v_Rd_MNm2 = np.maximum(grund, minimum) + 0.12 * sigma_cp

    return {
        "v_Rd_c_kNm": np.asarray(v_Rd_MNm2 * b * d * 1000.0),
        "k": float(k),
        "rho_l": np.asarray(rho),
        "minimum_maßgebend": np.asarray(grund < minimum),
    }


def querkraftbewehrung(V_Ed_kN, b_w: float, d: float, beton_: Beton,
                       stahl: Stahl = B500B, h: float | None = None,
                       sigma_cd_MNm2=0.0, cot_theta_max: float = 3.0) -> dict:
    """
    Bügelbewehrung eines Balkens nach EC2 6.2.3 mit dem deutschen NA.

    **Warum ein Balken anders nachgewiesen wird als eine Platte.** Eine Platte
    ohne Bügel trägt ihre Querkraft über die Rissverzahnung; `querkraftwiderstand()`
    gibt dafür v_Rd,c. Ein Unterzug schafft das fast nie — sein Steg ist schmal
    und v_Ed groß —, und dann gilt nicht mehr „Widerstand des Betons", sondern
    das **Fachwerkmodell**: der ganze Wert V_Ed wird von Bügeln getragen, der
    Betonanteil fällt vollständig weg. Wer die beiden Wege addiert, rechnet die
    Tragfähigkeit doppelt.

    Der Neigungswinkel der Druckstrebe ist dabei die eigentliche
    Entwurfsgröße. Der NA lässt ihn zwischen 45° (cot θ = 1) und 18,4°
    (cot θ = 3) wandern:

        cot θ ≤ (1,2 + 1,4·σ_cd/f_cd) / (1 − V_Rd,cc/V_Ed) ,
        V_Rd,cc = 0,5·0,48·f_ck^⅓·(1 − 1,2·σ_cd/f_cd)·b_w·z

    Eine flache Druckstrebe (großes cot θ) spart Bügel und belastet die
    Betondruckstrebe stärker — deshalb steht V_Rd,max daneben. Gerechnet wird
    mit dem größten zulässigen cot θ, also der wirtschaftlichen Wahl; wo
    V_Rd,max damit nicht reicht, wird θ so weit aufgerichtet, bis es passt.

    @param V_Ed_kN  Bemessungsquerkraft in kN (Betrag), skalar oder Feld
    @param b_w      Stegbreite in m
    @param d        Nutzhöhe in m
    @param h        Bauteilhöhe in m — nur für den Höchstabstand der Bügel
    @param sigma_cd_MNm2  mittlere Längsdruckspannung, Druck positiv
    @returns dict mit `a_sw_cm2_je_m` (zweischnittig, cm²/m Balkenlänge),
             `cot_theta`, `V_Rd_max_kN`, `ausnutzung_druckstrebe`,
             `a_sw_min_cm2_je_m`, `s_max_mm`, `hinweis`
    """
    V_Ed = np.abs(np.asarray(V_Ed_kN, dtype=float))
    z = 0.9 * d
    f_cd = beton_.f_cd_MNm2
    sigma_cd = np.asarray(sigma_cd_MNm2, dtype=float) * np.ones_like(V_Ed)

    # V_Rd,cc — der Anteil, den das Fachwerk der Rissreibung zurechnet. Er ist
    # *kein* Traganteil, der zu den Bügeln addiert würde, sondern geht nur in
    # die zulässige Druckstrebenneigung ein.
    V_Rd_cc = (0.5 * 0.48 * beton_.f_ck_MNm2 ** (1.0 / 3.0)
               * (1.0 - 1.2 * sigma_cd / f_cd) * b_w * z * 1000.0)
    nenner = np.clip(1.0 - V_Rd_cc / np.maximum(V_Ed, 1e-9), 0.05, 1.0)
    cot = np.clip((1.2 + 1.4 * sigma_cd / f_cd) / nenner, 1.0, cot_theta_max)

    # ν₁ = 0,75 nach NA (statt 0,6·(1 − f_ck/250) der Norm) für Bügel aus B500.
    nu_1 = 0.75
    def v_rd_max(cot_wert):
        return b_w * z * nu_1 * f_cd / (cot_wert + 1.0 / cot_wert) * 1000.0

    # Reicht die Druckstrebe bei diesem cot θ nicht, wird θ aufgerichtet —
    # V_Rd,max ist bei cot θ = 1 (45°) am größten.
    zu_flach = v_rd_max(cot) < V_Ed
    cot = np.where(zu_flach, 1.0, cot)
    V_Rd_max = v_rd_max(cot)

    f_ywd = stahl.f_yd_MNm2
    a_sw = V_Ed / (z * f_ywd * cot) * 1e4 / 1000.0        # m²/m → cm²/m

    # Mindestbewehrung ρ_w,min = 0,16·f_ctm/f_yk, EC2/NA 9.2.2(5)
    rho_w_min = 0.16 * beton_.f_ctm_MNm2 / stahl.f_yk_MNm2
    a_sw_min = rho_w_min * b_w * 1e4                        # cm²/m

    # Höchstabstand nach EC2/NA 9.2.2(6), gestaffelt nach der Ausnutzung der
    # Druckstrebe: je höher sie ausgenutzt ist, desto enger müssen die Bügel
    # stehen, damit die Strebe überhaupt eingespannt ist.
    hoehe = float(h if h is not None else d / 0.9)
    ausnutzung = V_Ed / np.maximum(V_Rd_max, 1e-9)
    s_max = np.where(ausnutzung <= 0.30, np.minimum(0.7 * hoehe * 1000.0, 300.0),
                     np.where(ausnutzung <= 0.60, np.minimum(0.5 * hoehe * 1000.0, 300.0),
                              np.minimum(0.25 * hoehe * 1000.0, 200.0)))

    hinweise = []
    if np.any(zu_flach):
        hinweise.append("Druckstrebe zu flach — θ auf 45° aufgerichtet")
    if np.any(V_Ed > V_Rd_max * 1.0001):
        hinweise.append("V_Ed > V_Rd,max auch bei 45° — Steg verbreitern oder Beton erhöhen")

    return {
        "a_sw_cm2_je_m": np.maximum(np.asarray(a_sw), a_sw_min),
        "a_sw_erf_cm2_je_m": np.asarray(a_sw),
        "a_sw_min_cm2_je_m": float(a_sw_min),
        "cot_theta": np.asarray(cot),
        "theta_grad": np.degrees(np.arctan(1.0 / np.asarray(cot))),
        "V_Rd_max_kN": np.asarray(V_Rd_max),
        "V_Rd_cc_kN": np.asarray(V_Rd_cc),
        "ausnutzung_druckstrebe": np.asarray(ausnutzung),
        "z_m": z,
        "s_max_mm": np.asarray(s_max),
        "hinweis": " · ".join(hinweise),
    }


def waehle_buegel(a_sw_erf_cm2_je_m: float, s_max_mm: float = 300.0,
                  schnitte: int = 2, durchmesser: list[int] | None = None) -> dict:
    """
    Ø und Abstand eines Bügels für eine erforderliche Bügelbewehrung.

    `schnitte` ist die Zahl der Bügelschenkel, die den Riss kreuzen — bei einem
    gewöhnlichen geschlossenen Bügel zwei. Gesucht wird wie bei `waehle_stab()`
    der kleinste Überschuss, weil eng gesetzte dünne Bügel den Steg besser
    umschnüren als weit gesetzte dicke.
    """
    beste = None
    for phi in (durchmesser or [8, 10, 12]):
        einzel = np.pi * (phi / 10.0) ** 2 / 4.0                   # cm² je Schenkel
        for s in [250, 200, 150, 125, 100, 75]:
            if s > s_max_mm:
                continue
            vorhanden = einzel * schnitte * 1000.0 / s              # cm²/m
            if vorhanden < a_sw_erf_cm2_je_m:
                continue
            ueberschuss = vorhanden - a_sw_erf_cm2_je_m
            if beste is None or ueberschuss < beste["ueberschuss"] - 1e-9:
                beste = {"durchmesser_mm": phi, "abstand_mm": s, "schnitte": schnitte,
                         "a_sw_cm2_je_m": vorhanden, "ueberschuss": ueberschuss}
    if beste is None:
        phi = (durchmesser or [8, 10, 12])[-1]
        einzel = np.pi * (phi / 10.0) ** 2 / 4.0
        s = min(75.0, s_max_mm)
        beste = {"durchmesser_mm": phi, "abstand_mm": s, "schnitte": schnitte,
                 "a_sw_cm2_je_m": einzel * schnitte * 1000.0 / s, "ueberschuss": 0.0,
                 "hinweis": "auch der engste Bügel reicht nicht — vierschnittig oder Steg breiter"}
    beste["bezeichnung"] = f"Ø{beste['durchmesser_mm']}/{beste['abstand_mm']:.0f}"
    return beste


def plattenbalken(m_Ed, d: float, beton_: Beton, b_druck: float, h_druckgurt: float,
                  b_steg: float, stahl: Stahl = B500B, d_2: float = 0.05,
                  n_Ed=0.0, h: float | None = None) -> dict:
    """
    Biegebemessung eines T-Querschnitts — Bewehrung in cm² (nicht je Meter).

    **Der Unterschied zur Platte ist die Druckzone, nicht die Zugzone.** Ein
    Unterzug im Feld hat die Platte über sich: die Druckzone liegt im breiten
    Gurt, und solange sie darin bleibt (x ≤ h_f), ist die Bemessung dieselbe
    Rechteckbemessung wie bei der Platte, nur mit b = b_eff statt 1 m. Über der
    Stütze kehrt sich das um — dort ist die Platte gezogen, gedrückt wird der
    schmale Steg, und die Bewehrung fällt deutlich größer aus. Wer beides mit
    b_eff rechnet, unterschätzt die Stützbewehrung erheblich.

    Reicht der Gurt nicht (x > h_f), wird der Querschnitt zerlegt: die
    überstehenden Gurtteile tragen

        M_Gurt = (b_druck − b_steg)·h_f·f_cd·(d − h_f/2),

    der Rest wird als Rechteck b_steg bemessen und beides addiert. Das ist das
    übliche Verfahren und liegt leicht auf der sicheren Seite, weil der
    Spannungsblock im Gurt bis zu dessen Unterkante angesetzt wird.

    `n_Ed` ist die Längskraft am selben Querschnitt (Zug positiv), beim
    Unterzug also der Gurtanteil aus der Deckenscheibe. Sie wird wie in
    `biegebemessung()` über M_Eds = M_Ed − N_Ed·z_s1 berücksichtigt und danach
    wieder abgezogen.

    @param b_druck      Breite der gedrückten Zone am gedrückten Rand (b_eff)
    @param h_druckgurt  Dicke dieses breiten Bereichs; 0 = reiner Rechteckquerschnitt
    @param b_steg       Breite darunter (b_w)
    @param n_Ed         Längskraft in kN, Zug positiv
    @returns dict wie `biegebemessung()`, aber `a_s_cm2` **absolut in cm²**
    """
    m_roh = np.asarray(m_Ed, dtype=float)
    n_Ed = np.asarray(n_Ed, dtype=float) * np.ones_like(m_roh)
    h_bauteil = float(h) if h is not None else float(d) + 0.05
    z_s1 = d - h_bauteil / 2.0
    vorzeichen = np.where(m_roh < 0, -1.0, 1.0)
    m_Ed = np.maximum(np.abs(m_roh) - vorzeichen * n_Ed * z_s1, 0.0)

    f_cd, f_yd = beton_.f_cd, stahl.f_yd
    b_1 = float(max(b_druck, b_steg))
    h_f = float(max(h_druckgurt, 0.0))

    def rechteck(m, b):
        mu = m / (b * d ** 2 * f_cd)
        mu_r = np.minimum(mu, MU_GRENZ)
        zeta = 1.0 - np.sqrt(np.maximum(1.0 - 2.0 * mu_r, 0.0))
        z = d * (1.0 - zeta / 2.0)
        ueberschuss = np.maximum(m - MU_GRENZ * b * d ** 2 * f_cd, 0.0)
        a_s = (np.minimum(m, MU_GRENZ * b * d ** 2 * f_cd) / np.maximum(z, 1e-9)
               + ueberschuss / max(d - d_2, 1e-9)) / f_yd
        return mu, zeta, z, a_s, ueberschuss / max(d - d_2, 1e-9) / f_yd

    mu, zeta, z, a_s, a_s2 = rechteck(m_Ed, b_1)
    x = zeta * d / 0.8

    # Wo die Druckzone aus dem Gurt herausläuft, wird zerlegt.
    ausserhalb = (h_f > 1e-9) & (x > h_f) & (b_1 > b_steg + 1e-9)
    if np.any(ausserhalb):
        m_gurt = (b_1 - b_steg) * h_f * f_cd * (d - h_f / 2.0)
        m_rest = np.maximum(m_Ed - m_gurt, 0.0)
        _, zeta_w, z_w, a_s_w, a_s2_w = rechteck(m_rest, b_steg)
        a_s_t = a_s_w + m_gurt / max(d - h_f / 2.0, 1e-9) / f_yd
        a_s = np.where(ausserhalb, a_s_t, a_s)
        a_s2 = np.where(ausserhalb, a_s2_w, a_s2)
        x = np.where(ausserhalb, zeta_w * d / 0.8, x)
        mu = np.where(ausserhalb, m_rest / (b_steg * d ** 2 * f_cd), mu)

    hinweise = []
    if np.any(ausserhalb):
        hinweise.append(f"Druckzone reicht an {int(np.sum(ausserhalb))} Stellen unter den "
                        "Gurt — als T-Querschnitt zerlegt")
    if np.any(mu > MU_GRENZ + 1e-9):
        hinweise.append(f"μ > {MU_GRENZ:.3f} — Druckbewehrung angesetzt, Querschnitt zu klein")

    a_s = a_s + vorzeichen * n_Ed / f_yd
    return {
        "a_s_cm2": np.asarray(np.maximum(a_s, 0.0) * 1e4),
        "a_s2_cm2": np.asarray(np.maximum(a_s2, 0.0) * 1e4),
        "mu": np.asarray(mu), "x_m": np.asarray(x), "z_m": np.asarray(z),
        "xi": np.asarray(x / d),
        "im_gurt": np.asarray(~np.asarray(ausserhalb) | (h_f <= 1e-9)),
        "hinweis": " · ".join(hinweise),
    }


# ──────────────────────────────────────────────────────────────────────────
# Bewehrungsführung im Querschnitt: Stablagen
# ──────────────────────────────────────────────────────────────────────────

#: Größtkorn der Gesteinskörnung in mm. 16 mm ist der Regelfall im Hochbau und
#: geht über EC2 8.2 in den lichten Mindestabstand ein — und damit in die Zahl
#: der Stäbe, die nebeneinander in einen Steg gehen. Bei 32 mm Korn sind es in
#: einem 30er Steg statt sieben Ø 14 nur noch fünf.
#:
#: Alle Funktionen hier lesen die Konstante zur **Aufrufzeit** (Parameter
#: `groesstkorn_mm=None`); ein `beton.GROESSTKORN_MM = 32` wirkt deshalb sofort
#: auf die ganze Rechnung. Stünde sie als Default in der Signatur, wäre sie beim
#: Import festgeschrieben und eine spätere Änderung bliebe wirkungslos.
GROESSTKORN_MM = 16.0


def mindestabstand_mm(ds_mm: float, groesstkorn_mm: float | None = None) -> float:
    """
    Lichter Mindestabstand paralleler Stäbe, waagerecht wie lotrecht,
    EC2 8.2 (2) mit NA(D): s_min = max(k₁·Ø; d_g + k₂; 20 mm), k₁ = 1,0, k₂ = 5 mm.

    Der Größtkornterm ist der, den man beim Zählen von Hand übergeht: bei Ø 12
    und 16 mm Größtkorn ist nicht der Stab maßgebend, sondern das Korn, das
    zwischen zwei Stäbe fallen muss.
    """
    korn = GROESSTKORN_MM if groesstkorn_mm is None else groesstkorn_mm
    return float(max(ds_mm, korn + 5.0, 20.0))


def randabstand_m(c_nom_mm: float = 25.0, buegel_mm: float = 8.0,
                  ds_mm: float = 16.0) -> float:
    """Achsabstand des äußersten Längsstabes vom Betonrand: c_nom + Ø_Bügel + Ø/2."""
    return float((c_nom_mm + buegel_mm + ds_mm / 2.0) / 1000.0)


def staebe_je_lage(b_w: float, ds_mm: float, c_nom_mm: float = 25.0,
                   buegel_mm: float = 8.0,
                   groesstkorn_mm: float | None = None) -> int:
    """
    Wie viele Stäbe Ø nebeneinander in den Steg passen.

    n Stäbe auf der Achsspanne L haben den Achsabstand L/(n−1), also den
    lichten Abstand L/(n−1) − Ø ≥ s_min  ⇔  n ≤ L/(Ø + s_min) + 1. Die Spanne
    ist die zwischen den Achsen der beiden Eckstäbe, nicht die lichte
    Bügelweite — sonst zählt man einen halben Stabdurchmesser doppelt.
    """
    spanne = max(b_w - 2.0 * randabstand_m(c_nom_mm, buegel_mm, ds_mm), 0.0) * 1000.0
    s_min = mindestabstand_mm(ds_mm, groesstkorn_mm)
    return max(1, int(np.floor(spanne / (ds_mm + s_min) + 1e-9)) + 1)


def lagenaufteilung(n: int, n_je_lage: int, lagen_max: int = 2) -> list[int]:
    """
    n Stäbe auf möglichst wenige Lagen verteilen.

    Gleichmäßig, und die äußere Lage bekommt nie weniger Stäbe als die
    darüberliegende — so bleibt der innere Hebelarm größtmöglich. Reicht
    `lagen_max` nicht aus, wird trotzdem verteilt; die Prüfung in
    `stablagen()` meldet das als „passt nicht".
    """
    if n <= 0:
        return []
    lagen = min(max(int(np.ceil(n / max(n_je_lage, 1))), 1), max(lagen_max, 1))
    grund, rest = divmod(int(n), lagen)
    return [grund + (1 if i < rest else 0) for i in range(lagen)]


def _y_positionen(n: int, spanne: float, raster: np.ndarray | None = None) -> np.ndarray:
    """
    Stabachsen einer Lage, symmetrisch zur Querschnittsmitte.

    Die äußerste Lage wird über die volle Spanne verteilt; jede weitere
    übernimmt Positionen aus deren Raster, damit die Stäbe lotrecht
    übereinander stehen und die Rüttelgassen durchgehen (EC2 8.2 (4)).
    """
    if n <= 0:
        return np.zeros(0)
    if n == 1:
        return np.zeros(1)
    if raster is None or len(raster) < n:
        return np.linspace(-spanne / 2.0, spanne / 2.0, n)
    m = len(raster)
    return np.asarray([raster[int(round(i * (m - 1) / (n - 1)))] for i in range(n)])


def stablagen(n: int, b_w: float, h: float, ds_mm: float, seite: str = "unten",
              c_nom_mm: float = 25.0, buegel_mm: float = 8.0,
              groesstkorn_mm: float | None = None, lagen_max: int = 2) -> dict:
    """
    Das Stabbild einer Bewehrungsgruppe: Lagen, Stabachsen, Schwerpunkt, Prüfung.

    Für die Bemessung genügt der Schwerpunkt der Bewehrung — er bestimmt die
    Nutzhöhe. Für die Zeichnung, den Abstandsnachweis nach EC2 8.2 und die
    Frage, ob die gewählte Bewehrung überhaupt in den Steg geht, braucht es die
    Lage jedes einzelnen Stabes. Beides entsteht hier aus derselben Beschreibung:

        Randbedingungen + Stabzahl  →  Lagen  →  Stabachsen

    Passen die Stäbe nicht nebeneinander, wird eine zweite (dritte) Lage
    angeordnet. **Das kostet Nutzhöhe** — `d_m` ist deshalb nicht h − Randabstand,
    sondern h − Schwerpunktabstand, und genau dieser Wert gehört zurück in die
    Biegebemessung.

    Koordinaten: y waagerecht, Mitte des Steges bei y = 0; z von der Unterkante
    des Querschnitts nach oben. `seite` sagt, an welchem Rand die Gruppe liegt.

    @param n     Stabzahl der Gruppe (Grundbewehrung und Zulagen zusammen)
    @param b_w   Breite, über die verteilt werden darf (beim Balken der Steg)
    @param h     Querschnittshöhe
    @returns dict mit `lagen`, `staebe`, `d_m`, `schwerpunkt_m`, `passt`, `hinweis`
    """
    ds = float(ds_mm)
    n = int(max(n, 0))
    s_min = mindestabstand_mm(ds, groesstkorn_mm)
    rand = randabstand_m(c_nom_mm, buegel_mm, ds)
    spanne = max(b_w - 2.0 * rand, 0.0)
    je_lage = staebe_je_lage(b_w, ds, c_nom_mm, buegel_mm, groesstkorn_mm)
    einzel_cm2 = np.pi * (ds / 10.0) ** 2 / 4.0
    unten = seite != "oben"
    d_lage = (ds + s_min) / 1000.0                      # Achsabstand der Lagen

    verteilung = lagenaufteilung(n, je_lage, lagen_max)
    lagen, staebe, raster = [], [], None
    for k, n_k in enumerate(verteilung):
        ys = _y_positionen(n_k, spanne, raster)
        if k == 0:
            raster = ys
        z = rand + k * d_lage if unten else h - rand - k * d_lage
        licht = (float(np.min(np.diff(ys))) * 1000.0 - ds) if n_k > 1 else float("inf")
        lagen.append({"index": k, "n": int(n_k), "z_m": float(z),
                      "y_m": [float(y) for y in ys],
                      "s_licht_mm": licht,
                      "a_s_cm2": float(n_k * einzel_cm2)})
        # Legordnung: äußerste Lage zuerst, darin von der Bügelecke nach innen.
        # Danach wird unterschieden, welcher Stab durchläuft und welcher Zulage
        # ist — die durchlaufenden liegen außen, wo der Bügel sie hält.
        aussen_nach_innen = sorted(range(n_k), key=lambda i: -abs(ys[i]))
        for rang, i in enumerate(aussen_nach_innen):
            staebe.append({"y_m": float(ys[i]), "z_m": float(z), "lage": k,
                           "rang": len(staebe), "ds_mm": ds})

    schwerpunkt = (sum(l["n"] * (l["z_m"] if unten else h - l["z_m"]) for l in lagen)
                   / max(n, 1)) if lagen else rand

    pruefungen = []
    for l in lagen:
        if l["n"] > 1:
            pruefungen.append({
                "ort": f"Lage {l['index'] + 1}, waagerecht",
                "vorhanden_mm": l["s_licht_mm"], "erforderlich_mm": s_min,
                "erfuellt": l["s_licht_mm"] >= s_min - 1e-9})
    if len(lagen) > 1:
        dz = abs(lagen[1]["z_m"] - lagen[0]["z_m"]) * 1000.0 - ds
        pruefungen.append({"ort": "zwischen den Lagen, lotrecht",
                           "vorhanden_mm": dz, "erforderlich_mm": s_min,
                           "erfuellt": dz >= s_min - 1e-9})

    hinweise = []
    if len(lagen) > 1:
        hinweise.append(f"{n} Ø {ds:.0f} in {len(lagen)} Lagen — je Lage passen "
                        f"{je_lage} Stäbe in b = {b_w:.2f} m; d sinkt auf "
                        f"{(h - schwerpunkt) * 100:.1f} cm")
    if n > je_lage * max(lagen_max, 1):
        hinweise.append(f"{n} Ø {ds:.0f} passen auch in {lagen_max} Lagen nicht "
                        f"(je Lage {je_lage}) — Steg verbreitern oder Bündel wählen")
    if any(not p["erfuellt"] for p in pruefungen):
        eng = min(pruefungen, key=lambda p: p["vorhanden_mm"])
        hinweise.append(f"lichter Stababstand {eng['vorhanden_mm']:.0f} mm < "
                        f"s_min = {s_min:.0f} mm ({eng['ort']})")

    return {
        "n": n, "ds_mm": ds, "seite": seite, "a_s_cm2": float(n * einzel_cm2),
        "je_lage": je_lage, "lagen": lagen, "staebe": staebe,
        "b_verteil_m": float(b_w), "spanne_m": float(spanne),
        "randabstand_m": float(rand), "schwerpunkt_m": float(schwerpunkt),
        "d_m": float(h - schwerpunkt), "s_min_mm": s_min,
        "pruefungen": pruefungen,
        "passt": bool(all(p["erfuellt"] for p in pruefungen)
                      and n <= je_lage * max(lagen_max, 1)),
        "hinweis": " · ".join(hinweise),
    }


def waehle_staebe(a_s_erf_cm2: float, b_w: float, c_nom_mm: float = 25.0,
                  buegel_mm: float = 8.0, durchmesser: list[int] | None = None,
                  lagen_max: int = 2,
                  groesstkorn_mm: float | None = None) -> dict:
    """
    Stabwahl für einen Balken: n Stäbe Ø d, absolut in cm².

    Anders als bei der Platte ist der Stababstand hier keine Vorgabe, sondern
    eine **Folge**: in den Steg passen nur so viele Stäbe nebeneinander, wie
    Betondeckung, Bügel und der lichte Mindestabstand (EC2 8.2:
    max(Ø; 20 mm)) zulassen. Passt die Bewehrung nicht in eine Lage, wird eine
    zweite angeordnet — mit dem Hinweis, dass die Nutzhöhe dadurch sinkt.

    **Eine Lage schlägt den kleineren Überschuss.** Nur nach dem Überschuss zu
    wählen führt regelmäßig zu vielen dünnen Stäben in zwei Lagen — für
    19,9 cm² etwa 11 Ø 14 statt 6 Ø 20. Die zweite Lage kostet aber Nutzhöhe,
    und die geht direkt in die Bewehrungsmenge zurück. Deshalb gewinnt zuerst
    die geringere Lagenzahl, dann der kleinere Überschuss, dann die kleinere
    Stabzahl.
    """
    if a_s_erf_cm2 <= 1e-9:
        return {"n": 0, "durchmesser_mm": 0, "a_s_cm2": 0.0, "lagen": 0,
                "bezeichnung": "—", "ueberschuss": 0.0}

    beste = None
    for phi in (durchmesser or [10, 12, 14, 16, 20, 25]):
        einzel = np.pi * (phi / 10.0) ** 2 / 4.0                     # cm²
        # Derselbe Mindestabstand wie im Stabbild (`stablagen()`), sonst wählt
        # die Bemessung eine Bewehrung, die das Bild anschließend nicht legen kann.
        n_je_lage = staebe_je_lage(b_w, phi, c_nom_mm, buegel_mm, groesstkorn_mm)
        if n_je_lage < 2:
            continue
        n_max = n_je_lage * lagen_max
        n = int(np.ceil(a_s_erf_cm2 / einzel))
        if n < 2:
            n = 2
        if n > n_max:
            continue
        vorhanden = n * einzel
        ueberschuss = vorhanden - a_s_erf_cm2
        lagen = int(np.ceil(n / n_je_lage))
        schluessel = (lagen, round(ueberschuss, 6), n)
        if beste is None or schluessel < beste["_schluessel"]:
            beste = {"n": n, "durchmesser_mm": phi, "a_s_cm2": vorhanden,
                     "lagen": lagen, "n_je_lage": n_je_lage,
                     "ueberschuss": ueberschuss, "_schluessel": schluessel}
    if beste is None:
        phi = (durchmesser or [10, 12, 14, 16, 20, 25])[-1]
        einzel = np.pi * (phi / 10.0) ** 2 / 4.0
        n = max(2, int(np.ceil(a_s_erf_cm2 / einzel)))
        beste = {"n": n, "durchmesser_mm": phi, "a_s_cm2": n * einzel, "lagen": 3,
                 "n_je_lage": 2, "ueberschuss": 0.0, "_schluessel": (3, 0.0, n),
                 "hinweis": "Bewehrung passt nicht in zwei Lagen — Steg verbreitern"}
    beste.pop("_schluessel", None)
    beste["bezeichnung"] = f"{beste['n']} Ø {beste['durchmesser_mm']}"
    if beste["lagen"] > 1:
        beste["bezeichnung"] += f" ({beste['lagen']} Lagen)"
    return beste


def durchstanzen(V_Ed_kN: float, d: float, beton_: Beton, stuetze_m: tuple[float, float] | float,
                 rho_l: float = 0.005, beta: float = 1.10, rund: bool = False) -> dict:
    """
    Durchstanznachweis im kritischen Rundschnitt, EC2 6.4.

    Der Rundschnitt liegt im Abstand 2d von der Lastfläche; sein Umfang u_1 ist
    beim Rechteck `2(c_x + c_y) + 2π·2d`, beim Kreis `π(D + 4d)`. β = 1,10 ist
    der Wert des NA für die Innenstütze ohne Ausmitte — Rand- und Eckstützen
    liegen bei 1,4 bzw. 1,5, und dort wird der Nachweis meist maßgebend.

    Zusätzlich wird die Druckstrebe am Stützenanschnitt geprüft
    (v_Ed,u0 ≤ 0,5·ν·f_cd): reißt die, hilft auch Durchstanzbewehrung nicht mehr.
    """
    if rund:
        durchmesser = float(stuetze_m if np.isscalar(stuetze_m) else stuetze_m[0])
        u_0 = np.pi * durchmesser
        u_1 = np.pi * (durchmesser + 4.0 * d)
    else:
        c_x, c_y = (stuetze_m, stuetze_m) if np.isscalar(stuetze_m) else stuetze_m
        u_0 = 2.0 * (c_x + c_y)
        u_1 = 2.0 * (c_x + c_y) + 2.0 * np.pi * 2.0 * d

    v_Ed = beta * V_Ed_kN / (u_1 * d)                 # kN/m²
    v_Ed_u0 = beta * V_Ed_kN / (u_0 * d)
    k = min(1.0 + np.sqrt(200.0 / (d * 1000.0)), 2.0)
    rho = min(float(rho_l), 0.02)
    v_Rd_c = max(0.15 / 1.5 * k * (100.0 * rho * beton_.f_ck_MNm2) ** (1.0 / 3.0),
                 0.035 * k ** 1.5 * np.sqrt(beton_.f_ck_MNm2)) * 1000.0
    v_Rd_max = 0.5 * beton_.nu_druckstrebe * beton_.f_cd

    return {
        "u_1_m": float(u_1), "u_0_m": float(u_0),
        "v_Ed_kNm2": float(v_Ed), "v_Rd_c_kNm2": float(v_Rd_c),
        "ausnutzung": float(v_Ed / v_Rd_c),
        "ausnutzung_druckstrebe": float(v_Ed_u0 / v_Rd_max),
        "bewehrung_noetig": bool(v_Ed > v_Rd_c),
    }


# ──────────────────────────────────────────────────────────────────────────
# Bewehrungswahl: Matten, Stäbe, Staffelung
# ──────────────────────────────────────────────────────────────────────────


#: Lagermatten nach DIN 488-4, Querschnitt in cm²/m (längs, quer).
MATTEN = {
    "Q188A": (1.88, 1.88), "Q257A": (2.57, 2.57), "Q335A": (3.35, 3.35),
    "Q378A": (3.78, 3.78), "Q424A": (4.24, 4.24), "Q513A": (5.13, 5.13),
    "Q524A": (5.24, 5.24), "Q636A": (6.36, 6.36),
}

#: Stabdurchmesser und Abstände, aus denen Zulagen gewählt werden.
DURCHMESSER_MM = [6, 8, 10, 12, 14, 16, 20]
ABSTAENDE_MM = [250, 200, 150, 125, 100]


def stabquerschnitt_cm2(durchmesser_mm: float, abstand_mm: float) -> float:
    """Querschnitt einer Stablage in cm²/m."""
    return np.pi * (durchmesser_mm / 10.0) ** 2 / 4.0 * (1000.0 / abstand_mm)


def waehle_matte(a_s_erf_cm2: float) -> tuple[str, float]:
    """Kleinste Lagermatte, die den Wert deckt — sonst die größte."""
    for name, (laengs, _) in MATTEN.items():
        if laengs >= a_s_erf_cm2:
            return name, laengs
    letzte = list(MATTEN)[-1]
    return letzte, MATTEN[letzte][0]


def waehle_stab(a_s_erf_cm2: float, hoechstabstand_mm: float = 250.0,
                durchmesser: list[int] | None = None) -> dict:
    """
    Ø und Abstand für eine erforderliche Bewehrung.

    Gesucht wird die Wahl mit dem kleinsten Überschuss — nicht der dickste Stab,
    der passt: enge dünne Stäbe verteilen die Risse besser und sind bei Platten
    die Regel. Bei Gleichstand gewinnt der kleinere Durchmesser.
    """
    beste = None
    for phi in (durchmesser or DURCHMESSER_MM):
        for s in ABSTAENDE_MM:
            if s > hoechstabstand_mm:
                continue
            vorhanden = stabquerschnitt_cm2(phi, s)
            if vorhanden < a_s_erf_cm2:
                continue
            ueberschuss = vorhanden - a_s_erf_cm2
            if beste is None or ueberschuss < beste["ueberschuss"] - 1e-9:
                beste = {"durchmesser_mm": phi, "abstand_mm": s,
                         "a_s_cm2": vorhanden, "ueberschuss": ueberschuss}
    if beste is None:
        phi = (durchmesser or DURCHMESSER_MM)[-1]
        beste = {"durchmesser_mm": phi, "abstand_mm": ABSTAENDE_MM[-1],
                 "a_s_cm2": stabquerschnitt_cm2(phi, ABSTAENDE_MM[-1]), "ueberschuss": 0.0}
        beste["hinweis"] = "Bewehrung passt nicht in eine Lage — zweite Lage oder dickere Platte"
    return beste


def verankerungslaenge_m(durchmesser_mm: float, beton_: Beton, stahl: Stahl = B500B,
                         ausnutzung: float = 1.0, guter_verbund: bool = True) -> dict:
    """
    Verankerungslänge l_bd eines geraden Stabes, EC2 8.4.

        f_bd = 2,25·η₁·η₂·f_ctd,      l_b,rqd = (Ø/4)·(σ_sd/f_bd)
        l_bd = α·l_b,rqd ≥ max(0,3·l_b,rqd; 10Ø; 100 mm)

    η₁ = 1,0 bei gutem Verbund (untere Lage, stehend betoniert), 0,7 sonst —
    die obere Bewehrung einer dicken Platte liegt im schlechten Verbundbereich
    und braucht 43 % mehr Länge. `ausnutzung` = a_s,erf/a_s,vorh senkt σ_sd:
    was nicht ausgenutzt wird, muss auch nicht verankert werden.
    """
    eta_1 = 1.0 if guter_verbund else 0.7
    f_bd = 2.25 * eta_1 * beton_.f_ctd_MNm2
    sigma_sd = stahl.f_yd_MNm2 * float(np.clip(ausnutzung, 0.0, 1.0))
    l_b_rqd = durchmesser_mm / 4.0 * sigma_sd / f_bd / 1000.0        # mm → m
    l_bd = max(l_b_rqd, 0.3 * l_b_rqd, 10.0 * durchmesser_mm / 1000.0, 0.10)
    return {"f_bd_MNm2": f_bd, "l_b_rqd_m": l_b_rqd, "l_bd_m": l_bd}


def versatzmass_m(d: float) -> float:
    """
    Versatzmaß a_l, EC2 9.2.1.3(2).

    Bei Bauteilen ohne Querkraftbewehrung ist a_l = d. Der Grund ist das
    Fachwerkmodell: die geneigte Druckstrebe lenkt die Zugkraft um, die
    Bewehrung muss die Zugkraft der Stelle x schon bei x ± a_l besitzen. Wer
    die Staffelung ohne Versatzmaß zeichnet, endet die Zulage genau dort, wo
    sie noch gebraucht wird — der klassische Fehler in der Zugkraftdeckung.
    """
    return float(d)


def moment_widerstand_kNm(a_s_cm2, d: float, beton_: Beton, stahl: Stahl = B500B,
                          b: float = 1.0):
    """
    Aufnehmbares Moment einer gegebenen Bewehrung in kNm/m — die Umkehrung
    der Biegebemessung, Grundlage jeder Zugkraftdeckungslinie.

        ζ = ω = A_s·f_yd/(b·d·f_cd),   m_Rd = A_s·f_yd·d·(1 − ζ/2)
    """
    a_s = np.asarray(a_s_cm2, dtype=float) * 1e-4
    omega = a_s * stahl.f_yd / (b * d * beton_.f_cd)
    omega = np.minimum(omega, 0.8 * XI_GRENZ)      # nicht über die Duktilitätsgrenze
    return np.asarray(a_s * stahl.f_yd * d * (1.0 - omega / 2.0))


@dataclass
class Lage:
    """Eine Bewehrungslage: Grundbewehrung plus benannte Zulagen."""

    name: str
    grund_cm2: float
    grund_bezeichnung: str
    zulagen: list[dict]

    def summe_cm2(self) -> float:
        return self.grund_cm2 + sum(z["a_s_cm2"] for z in self.zulagen)


def staffelung(x, a_s_erf_cm2, d: float, beton_: Beton, stahl: Stahl = B500B,
               grund_cm2: float | None = None, a_s_min_cm2: float = 0.0,
               durchmesser_mm: float = 10.0, guter_verbund: bool = True,
               b: float = 1.0, wahl=None, grund_wahl=None) -> dict:
    """
    Gestaffelte Bewehrung entlang eines Schnitts.

    **Was gestaffelt heißt.** Die erforderliche Bewehrung folgt dem
    Momentenverlauf; ausgeführt wird sie in wenigen Stufen: eine durchlaufende
    Grundbewehrung und darüber Zulagen, die nur dort liegen, wo sie gebraucht
    werden. Die Länge einer Zulage ergibt sich nicht aus dem Bereich, in dem
    a_s,erf die Grundbewehrung übersteigt, sondern aus diesem Bereich

        beidseitig verlängert um  a_l (Versatzmaß)  +  l_bd (Verankerung).

    Das Versatzmaß bildet die Umlenkung der Zugkraft an der geneigten
    Druckstrebe ab, die Verankerungslänge das Einleiten der Kraft in den Beton.
    Beides zu vergessen ist der häufigste Fehler an dieser Stelle, und er ist
    im fertigen Bauteil nicht mehr zu erkennen.

    **Die Rechnung geht rückwärts.** Nicht „welche Bewehrung brauche ich", sondern
    „wo deckt die gewählte Bewehrung das Moment" — deshalb wird für jede Stufe
    das aufnehmbare Moment `m_Rd` bestimmt und mit dem Verlauf verglichen. Das
    Ergebnis ist die Zugkraftdeckungslinie, die man in jeder Schalungszeichnung
    findet.

    **Platte und Balken durchlaufen dasselbe Verfahren.** Der Unterschied
    steckt allein in der Einheit und in der Wahl: bei der Platte ist a_s eine
    Größe je Meter und die Grundbewehrung eine Matte, beim Unterzug ist a_s
    absolut in cm² und gelegt werden ganze Stäbe. Deshalb sind `wahl` und
    `grund_wahl` austauschbar; `b` ist die Breite, mit der das aufnehmbare
    Moment gerechnet wird (1 m bei der Platte, b_eff beim Balken).

    @param x  Koordinate entlang des Schnitts in m (aufsteigend)
    @param a_s_erf_cm2  erforderliche Bewehrung an diesen Stellen
    @param grund_cm2  Grundbewehrung; ohne Angabe wird die kleinste Matte
                      gewählt, die Mindestbewehrung und Median deckt
    @param b     Breite für `moment_widerstand_kNm()` in m
    @param wahl  `a_s_erf → dict(a_s_cm2, durchmesser_mm, bezeichnung)` für die
                 Zulagen; ohne Angabe die Stabwahl der Platte
    @param grund_wahl  `a_s_min → (bezeichnung, a_s_cm2)` für die
                 Grundbewehrung; ohne Angabe die Mattenwahl
    @returns dict mit `grund`, `zulagen` (Liste mit Anfang/Ende/Länge) und
             `m_Rd_verlauf` für die Zeichnung
    """
    x = np.asarray(x, dtype=float)
    # NaN kommt aus `plate.entlang()`, wo der Schnitt die Platte verlässt —
    # dort ist nichts zu bewehren, also null Bedarf und keine Zulage.
    a_s_erf = np.nan_to_num(np.asarray(a_s_erf_cm2, dtype=float), nan=0.0)
    a_s_erf = np.maximum(a_s_erf, 0.0)

    if grund_cm2 is None:
        # Kleinste Matte, die die Mindestbewehrung deckt. Das ist die übliche
        # Wahl: das Grundnetz liegt ohnehin über die ganze Decke und muss dort
        # nur die Mindestbewehrung sein — alles darüber wird gezielt zugelegt,
        # wo das Moment es verlangt. Eine Grundbewehrung nach dem Mittelwert
        # des Bedarfs wäre teurer und würde die Staffelung verschleiern.
        name, grund_cm2 = (grund_wahl or waehle_matte)(a_s_min_cm2)
    else:
        name = f"{grund_cm2:.2f} cm²" + ("/m" if abs(b - 1.0) < 1e-9 else "")

    a_l = versatzmass_m(d)

    zulagen = []
    rest = a_s_erf - grund_cm2
    ueber = rest > 1e-6
    if np.any(ueber):
        # Zusammenhängende Bereiche, in denen die Grundbewehrung nicht reicht.
        kanten = np.diff(ueber.astype(int))
        starts = list(np.flatnonzero(kanten == 1) + 1)
        enden = list(np.flatnonzero(kanten == -1) + 1)
        if ueber[0]:
            starts.insert(0, 0)
        if ueber[-1]:
            enden.append(len(ueber))

        # `von`/`bis` statt `a`/`b`: `b` ist hier die Bauteilbreite.
        for i, (i_von, i_bis) in enumerate(zip(starts, enden), start=1):
            bedarf = float(rest[i_von:i_bis].max())
            # Zulagen kommen als Stabstahl, und unter Ø 8 legt sie niemand;
            # die Auswahl bleibt deshalb auf die üblichen Durchmesser begrenzt,
            # statt auf den einen der Grundbewehrung festgelegt zu sein.
            if wahl is not None:
                gewaehlt = wahl(bedarf)
            else:
                gewaehlt = waehle_stab(bedarf, hoechstabstand_mm=250.0,
                                       durchmesser=([int(durchmesser_mm)] if durchmesser_mm
                                                    else [8, 10, 12, 14, 16]))
                gewaehlt = {**gewaehlt,
                            "bezeichnung": f"Ø{gewaehlt['durchmesser_mm']}/{gewaehlt['abstand_mm']}"}
            l_bd = verankerungslaenge_m(gewaehlt["durchmesser_mm"], beton_, stahl,
                                        ausnutzung=bedarf / max(gewaehlt["a_s_cm2"], 1e-9),
                                        guter_verbund=guter_verbund)["l_bd_m"]
            von = float(x[i_von]) - a_l - l_bd
            bis = float(x[min(i_bis, len(x) - 1)]) + a_l + l_bd
            zulagen.append({
                "nr": i,
                "von_m": max(von, float(x[0])), "bis_m": min(bis, float(x[-1])),
                "roh_von_m": float(x[i_von]), "roh_bis_m": float(x[min(i_bis, len(x) - 1)]),
                "laenge_m": min(bis, float(x[-1])) - max(von, float(x[0])),
                "a_s_cm2": gewaehlt["a_s_cm2"],
                "bezeichnung": gewaehlt["bezeichnung"],
                "durchmesser_mm": gewaehlt["durchmesser_mm"],
                # Stabzahl nur beim Balken belegt; die Platte legt Matten und
                # zählt keine Stäbe. Der Aufrufer prüft damit, ob Grundlage und
                # Zulage zusammen noch in den Steg passen.
                "n": gewaehlt.get("n"),
                "versatzmass_m": a_l, "l_bd_m": l_bd,
                "bedarf_cm2": bedarf,
            })

    # Überlappende Zulagen zusammenfassen. Zwei Bereiche, die nach dem
    # Verlängern um Versatzmaß und Verankerungslänge ineinanderlaufen, werden
    # auf der Baustelle als *ein* Stab gelegt — und rechnerisch wäre die
    # Überlagerung sonst doppelt gezählt.
    zusammengefasst: list[dict] = []
    for zulage in zulagen:
        if zusammengefasst and zulage["von_m"] <= zusammengefasst[-1]["bis_m"]:
            vorher = zusammengefasst[-1]
            vorher["bis_m"] = max(vorher["bis_m"], zulage["bis_m"])
            vorher["roh_bis_m"] = max(vorher["roh_bis_m"], zulage["roh_bis_m"])
            vorher["laenge_m"] = vorher["bis_m"] - vorher["von_m"]
            if zulage["bedarf_cm2"] > vorher["bedarf_cm2"]:
                for schluessel in ("bedarf_cm2", "a_s_cm2", "bezeichnung", "l_bd_m"):
                    vorher[schluessel] = zulage[schluessel]
        else:
            zusammengefasst.append(zulage)
    zulagen = zusammengefasst
    for nummer, zulage in enumerate(zulagen, start=1):
        zulage["nr"] = nummer

    # Zugkraftdeckung: welches Moment trägt die Bewehrung an jeder Stelle?
    vorhanden = np.full_like(x, grund_cm2, dtype=float)
    for z in zulagen:
        innerhalb = (x >= z["von_m"]) & (x <= z["bis_m"])
        vorhanden = vorhanden + np.where(innerhalb, z["a_s_cm2"], 0.0)

    return {
        "grund_cm2": float(grund_cm2), "grund_bezeichnung": name,
        "zulagen": zulagen,
        "a_s_vorhanden_cm2": vorhanden,
        "m_Rd_kNm": moment_widerstand_kNm(vorhanden, d, beton_, stahl, b=b),
        "versatzmass_m": a_l,
        "breite_m": float(b),
    }


# ──────────────────────────────────────────────────────────────────────────
# Scheibe: Netzbewehrung aus n_x, n_y, n_xy
# ──────────────────────────────────────────────────────────────────────────


def scheibenbewehrung(n_x, n_y, n_xy, beton_: Beton, dicke: float,
                      stahl: Stahl = B500B) -> dict:
    """
    Orthogonale Netzbewehrung für einen ebenen Spannungszustand, EC2 Anhang F.

    Die Deckenscheibe unter Wind steht unter n_x, n_y und n_xy in kN/m (Zug
    positiv). Bewehrt wird orthogonal in x und y; die Schubkraft n_xy wird über
    eine unter 45° geneigte Betondruckstrebe abgetragen, deren Umlenkung beide
    Bewehrungsrichtungen belastet:

        n_sx = n_x + |n_xy| ,  n_sy = n_y + |n_xy| ,  n_c = −2|n_xy|

    Das ist der Regelfall. Ist eine der beiden Richtungen so stark überdrückt,
    dass sie den Schub allein aufnimmt (n_x < −|n_xy|), entfällt dort die
    Bewehrung und die Druckstrebe stellt sich flacher — dafür der zweite Zweig
    mit n_c = n_x(1 + (n_xy/n_x)²). Sind beide Richtungen überdrückt, wird gar
    nicht bewehrt und nur der Beton nachgewiesen.

    **Der Betonnachweis ist der, den man vergisst.** Die Bewehrung ist meist
    unkritisch, die Druckstrebe nicht: sie darf ν·f_cd nicht überschreiten,
    ν = 0,6(1 − f_ck/250). Über einer Öffnung oder an einer einspringenden Ecke
    wird das schnell eng — und dort hilft mehr Bewehrung nichts.

    @returns dict mit `a_sx_cm2`, `a_sy_cm2` (je Bauteil, nicht je Lage),
             `sigma_c_MNm2`, `ausnutzung_druckstrebe`
    """
    n_x = np.asarray(n_x, dtype=float)
    n_y = np.asarray(n_y, dtype=float)
    n_xy = np.asarray(n_xy, dtype=float)
    betrag = np.abs(n_xy)

    n_sx = n_x + betrag
    n_sy = n_y + betrag
    n_c = -2.0 * betrag

    # Zweig 2: x überdrückt, keine Bewehrung in x nötig
    x_frei = n_x < -betrag
    sicher_x = np.where(np.abs(n_x) < 1e-9, -1e-9, n_x)
    n_sy = np.where(x_frei, n_y - n_xy ** 2 / sicher_x, n_sy)
    n_c = np.where(x_frei, n_x * (1.0 + (n_xy / sicher_x) ** 2), n_c)
    n_sx = np.where(x_frei, 0.0, n_sx)

    # Zweig 3: y überdrückt
    y_frei = (~x_frei) & (n_y < -betrag)
    sicher_y = np.where(np.abs(n_y) < 1e-9, -1e-9, n_y)
    n_sx = np.where(y_frei, n_x - n_xy ** 2 / sicher_y, n_sx)
    n_c = np.where(y_frei, n_y * (1.0 + (n_xy / sicher_y) ** 2), n_c)
    n_sy = np.where(y_frei, 0.0, n_sy)

    a_sx = np.maximum(n_sx, 0.0) / stahl.f_yd * 1e4      # cm²/m
    a_sy = np.maximum(n_sy, 0.0) / stahl.f_yd * 1e4

    sigma_c = np.minimum(n_c, 0.0) / dicke / 1000.0      # kN/m² → MN/m², Druck negativ
    zulaessig = beton_.nu_druckstrebe * beton_.f_cd_MNm2

    return {
        "a_sx_cm2": np.asarray(a_sx), "a_sy_cm2": np.asarray(a_sy),
        "n_sx_kNm": np.asarray(n_sx), "n_sy_kNm": np.asarray(n_sy),
        "sigma_c_MNm2": np.asarray(sigma_c),
        "sigma_c_zul_MNm2": float(zulaessig),
        "ausnutzung_druckstrebe": np.asarray(np.abs(sigma_c) / zulaessig),
    }


def ringanker_kN(laenge_m: float, geschosse: int = 1) -> float:
    """
    Mindestzugkraft des Ringankers, EC2 9.10.2.2 mit DIN-NA.

    F_tie,per = max(l_i·10 kN/m; 70 kN) je Geschossdecke. Der Ringanker hat mit
    der Windscheibe nichts zu tun — er sichert den Zusammenhalt des Gebäudes
    beim außergewöhnlichen Ereignis. Er wird hier mitgeführt, weil er die
    Randbewehrung der Decke oft bestimmt und dann die Scheibenbewehrung am Rand
    ohnehin abdeckt.
    """
    return float(max(laenge_m * 10.0, 70.0))


# ──────────────────────────────────────────────────────────────────────────
# Gebrauchstauglichkeit
# ──────────────────────────────────────────────────────────────────────────


#: EC2 Tab. 7.3N — Höchstwerte der Stababstände in mm für w_k = 0,3 mm,
#: abhängig von der Stahlspannung σ_s in MN/m² unter quasi-ständiger Last.
_RISS_SIGMA = np.array([160.0, 200.0, 240.0, 280.0, 320.0, 360.0])
_RISS_ABSTAND = np.array([300.0, 250.0, 200.0, 150.0, 100.0, 50.0])


def rissnachweis(sigma_s_MNm2, abstand_mm: float) -> dict:
    """
    Rissbreitenbegrenzung ohne direkte Berechnung, EC2 7.3.3.

    Der Nachweis ist eine Tabellenabfrage: zu jeder Stahlspannung unter
    quasi-ständiger Last gehört ein größter Stababstand. Er gilt für w_k =
    0,3 mm, den Regelwert für Innenbauteile (XC1) und bewehrte Außenbauteile.

    **σ_s ist nicht f_yd.** Unter der quasi-ständigen Kombination steht die
    Bewehrung weit unter ihrer Bemessungsspannung; brauchbar abgeschätzt wird
    sie mit σ_s ≈ f_yd · (M_qs/M_Ed) · (a_s,erf/a_s,vorh). Wer stattdessen mit
    435 MN/m² in die Tabelle geht, landet unter 50 mm Stababstand und hält den
    Nachweis für unerfüllbar.
    """
    sigma = np.asarray(sigma_s_MNm2, dtype=float)
    zulaessig = np.interp(sigma, _RISS_SIGMA, _RISS_ABSTAND,
                          left=_RISS_ABSTAND[0], right=0.0)
    return {
        "abstand_zul_mm": np.asarray(zulaessig),
        "erfuellt": np.asarray(abstand_mm <= zulaessig),
        "ausnutzung": np.asarray(abstand_mm / np.maximum(zulaessig, 1e-9)),
    }


def zustand_II(w_elastisch_mm, m_qs_kNm, a_s_cm2, h: float, d: float,
               beton_: Beton, stahl: Stahl = B500B, kriechzahl: float = 2.0,
               b: float = 1.0) -> dict:
    """
    Durchbiegung des gerissenen, kriechenden Querschnitts aus der elastischen.

    **Die FE-Rechnung liefert den ungerissenen Wert und der ist zu klein** —
    meist um den Faktor drei bis fünf. Ihn als Nachweis zu führen ist der
    häufigste Fehler beim Gebrauchstauglichkeitsnachweis von Stahlbeton.

    Gerechnet wird nach EC2 7.4.3 mit dem Verteilungsbeiwert

        ζ = 1 − β·(M_cr/M_qs)²      (β = 0,5 bei Dauerlast),

    der zwischen ungerissenem und vollständig gerissenem Zustand mischt:

        w = w_I · [ (1 − ζ) + ζ·I_I/I_II ] · (1 + φ)

    Das Kriechen geht über E_c,eff = E_cm/(1 + φ) ein und verdreifacht die
    Verformung fast; φ = 2,0 ist der Regelwert für Innenbauteile bei
    Belastungsbeginn nach 28 Tagen.

    Die Rechnung ist eine Abschätzung am Querschnitt mit dem größten Moment,
    keine Integration der Krümmung über die Platte — dafür bräuchte es eine
    zweite FE-Rechnung mit ortsabhängiger Steifigkeit. Für die Frage, ob l/250
    eingehalten wird, reicht sie; wo es knapp wird, ist die genauere Rechnung
    fällig.
    """
    m_qs = float(np.max(np.abs(m_qs_kNm)))
    a_s = float(np.max(a_s_cm2)) * 1e-4

    m_cr = beton_.f_ctm_MNm2 * 1000.0 * b * h ** 2 / 6.0        # kNm/m
    alpha_e = stahl.E_s_MNm2 / (beton_.E_cm_MNm2 / (1.0 + kriechzahl))

    # Gerissener Querschnitt: Nulllinie aus dem Momentengleichgewicht der
    # ideellen Fläche, b·x²/2 = α_e·A_s·(d − x).
    p = alpha_e * a_s / b
    x = -p + np.sqrt(p ** 2 + 2.0 * p * d)
    I_II = b * x ** 3 / 3.0 + alpha_e * a_s * (d - x) ** 2
    I_I = b * h ** 3 / 12.0

    gerissen = m_qs > m_cr
    zeta = max(0.0, 1.0 - 0.5 * (m_cr / max(m_qs, 1e-9)) ** 2) if gerissen else 0.0
    faktor_riss = (1.0 - zeta) + zeta * I_I / max(I_II, 1e-12)
    faktor = faktor_riss * (1.0 + kriechzahl)

    return {
        "w_mm": float(np.asarray(w_elastisch_mm) * faktor),
        "faktor": float(faktor), "zeta": float(zeta),
        "m_cr_kNm": float(m_cr), "gerissen": bool(gerissen),
        "I_I_zu_I_II": float(I_I / max(I_II, 1e-12)),
        "x_m": float(x), "alpha_e": float(alpha_e),
    }


def stahlspannung_MNm2(m_qs_kNm, a_s_vorh_cm2, d: float, stahl: Stahl = B500B):
    """
    Stahlspannung im Zustand II, vereinfacht mit z ≈ 0,9·d.

    Für die Rissbreitenbegrenzung reicht das: die Spannung hängt fast
    ausschließlich am Verhältnis M/A_s, der Hebelarm ändert sich zwischen
    schwacher und starker Bewehrung nur um wenige Prozent.
    """
    a_s = np.asarray(a_s_vorh_cm2, dtype=float) * 1e-4
    return np.asarray(np.abs(m_qs_kNm) / (0.9 * d * np.maximum(a_s, 1e-9)) / 1000.0)
