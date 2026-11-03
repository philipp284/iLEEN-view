"""
Tragende Wände: Knicknachweis und Ausnutzung unter der Last von oben.

Der Baustein, der bisher fehlte. `plate` rechnet die Decke und liefert die
Auflagerkraft je Meter; was die Wand darunter damit anfängt, stand nirgends —
der Lastabtrag endete an der Unterkante der Platte.

## Welches Verfahren

Für die Wände des Hochbaus ist der **unbewehrte Nachweis nach EC2 12.6.5.2**
der Regelfall und zugleich der schärfere: eine 24-cm-Wand mit 2,75 m Höhe
erreicht λ ≈ 40, und die Traglast fällt über den Beiwert Φ um rund ein Fünftel
gegenüber der zentrischen Druckfestigkeit. Konstruktive Bewehrung ändert daran
nichts — sie darf erst angerechnet werden, wenn sie nach 9.6 als tragende
Wandbewehrung ausgeführt und verbügelt ist.

    N_Rd = b · h_w · f_cd,pl · Φ

    Φ = 1,14 · (1 − 2·e_tot/h_w) − 0,02 · l_0/h_w   ≤   1 − 2·e_tot/h_w

Reicht das nicht, wird auf den **bewehrten Nachweis** umgeschaltet: derselbe
Querschnitt, aber als Stütze der Breite 1 m nach EC2 5.8.8 gerechnet
(`stuetze.nachweis`). Das ist keine Verlegenheitslösung, sondern der Weg, den
die Norm vorsieht — und er sagt zugleich, wieviel Bewehrung nötig wäre.

## Die Ausmitte ist die eigentliche Größe

Nicht die Normalkraft entscheidet über den Ausnutzungsgrad, sondern wo sie
angreift. Drei Anteile:

* **e_0 — planmäßig.** Eine einseitig aufgelagerte Decke setzt ihre
  Auflagerkraft nicht in der Wandachse ab. Ohne bessere Kenntnis wird sie nach
  EC2 12.6.1 mit dem Mindestwert h_w/30 ≥ 20 mm angesetzt; wer die Lage der
  Decke kennt, gibt `ausmitte_m` vor.
* **e_i — Imperfektion.** l_0/400, die unvermeidliche Schiefstellung.
* **Kriechen** bleibt außen vor: nach 12.6.5.2 darf es bei λ ≤ 86 und
  vorwiegend ständiger Last vernachlässigt werden.

## Was hier nicht geprüft wird

Kein Nachweis auf Schub in der Wandebene (das ist `scheibe`), keine
Aussteifung, kein Brandfall, keine Teilflächenpressung unter konzentrierten
Lasten. Und keine Prüfung, ob die Wand überhaupt gebaut werden kann — eine
rechnerisch tragfähige 8-cm-Wand über 3 m ist ein Rechenergebnis.
"""

from __future__ import annotations

import math

from . import beton as bt


#: Beiwert β für die Knicklänge l_0 = β · l_w nach EC2 12.6.5.1 bzw. 5.8.3.2.
#: Zweiseitig gehalten (oben und unten durch Decken) ist der Regelfall im
#: Geschossbau. „eingespannt" setzt eine biegesteife Verbindung voraus, die im
#: Ortbeton nur mit durchlaufender Bewehrung entsteht — im Zweifel bei 1,0
#: bleiben, das ist der Wert, der ohne Zusatzannahme gilt.
HALTERUNG = {
    "zweiseitig": 1.00,
    "eingespannt_unten": 0.85,
    "beidseitig_eingespannt": 0.70,
    "kragend": 2.00,
}

#: α_cc,pl für unbewehrten Beton nach DIN EN 1992-1-1/NA, 12.3.1.
ALPHA_CC_PL = 0.70

#: Schlankheitsgrenze für den unbewehrten Nachweis, EC2/NA 12.6.5.1.
LAMBDA_GRENZE = 86.0


def knicklaenge_m(hoehe_m: float, halterung: str = "zweiseitig",
                  laenge_m: float | None = None, quersteifen: int = 0) -> dict:
    """
    Knicklänge l_0 einer Wand.

    Die Querhalterung durch anschließende Wände ist der Punkt, an dem sich
    Rechnung und Wirklichkeit am weitesten auseinanderbewegen: eine drei- oder
    vierseitig gehaltene Wandscheibe knickt deutlich später als die zweiseitig
    gehaltene, und EC2 12.6.5.1 rechnet das über einen zusätzlichen Beiwert an.
    Vorausgesetzt ist dabei, dass die Querwand kraftschlüssig anschließt und
    selbst nicht ausweicht — im IFC steht davon nichts. `quersteifen` bleibt
    deshalb standardmäßig 0, und wer sie ansetzt, tut das ausdrücklich.

    @param quersteifen  0 = nur oben/unten, 1 = eine Querwand, 2 = beide Ränder
    """
    beta = HALTERUNG.get(halterung, 1.0)
    l_0 = beta * max(hoehe_m, 0.0)
    hinweis = ""

    if quersteifen and laenge_m and laenge_m > 1e-6:
        b = laenge_m if quersteifen >= 2 else 2.0 * laenge_m
        if quersteifen >= 2 and b < hoehe_m:
            # Sehr kurze, beidseitig gehaltene Scheibe: die Norm lässt hier
            # l_0 = b/2 zu — die Wand kippt dann eher um die schwache Achse
            # zwischen den Querwänden als über die Höhe.
            beta_quer = b / (2.0 * hoehe_m)
        else:
            beta_quer = 1.0 / (1.0 + (beta * hoehe_m / (3.0 * b)) ** 2)
        l_0 = beta * beta_quer * hoehe_m
        hinweis = (f"{quersteifen}-fach quergehalten, β_quer = {beta_quer:.2f} "
                   f"(EC2 12.6.5.1) — setzt kraftschlüssigen Anschluss voraus")

    return {"l_0_m": round(l_0, 3), "beta": beta, "hinweis": hinweis}


def schlankheit(l_0_m: float, dicke_m: float) -> float:
    """λ = l_0/i mit i = h_w/√12 für den Rechteckquerschnitt."""
    if dicke_m <= 1e-6:
        return float("inf")
    return math.sqrt(12.0) * l_0_m / dicke_m


def nachweis(N_Ed_je_m_kN: float, dicke_m: float, hoehe_m: float,
             beton_: bt.Beton | str = "C25/30", ausmitte_m: float | None = None,
             halterung: str = "zweiseitig", laenge_m: float | None = None,
             quersteifen: int = 0, M_Ed_je_m_kNm: float = 0.0) -> dict:
    """
    Tragfähigkeitsnachweis einer unbewehrten Stahlbetonwand, je Meter Wandlänge.

    @param N_Ed_je_m_kN  Bemessungswert der Normalkraft je Meter, Druck positiv
    @param M_Ed_je_m_kNm zusätzliches Moment aus der Decke, falls bekannt
    @returns dict mit N_Rd_je_m_kN, ausnutzung, lambda, phi, e_tot_m, hinweisen
    """
    c = bt.beton(beton_) if isinstance(beton_, str) else beton_
    # f_cd,pl statt f_cd: unbewehrter Beton bekommt den kleineren
    # Dauerstandsbeiwert. Das ist der Unterschied zwischen 14,2 und 11,7 MN/m²
    # bei C25/30 und geht voll in die Traglast ein.
    f_cd_pl = ALPHA_CC_PL * c.f_ck_MNm2 / c.gamma_c

    k = knicklaenge_m(hoehe_m, halterung, laenge_m, quersteifen)
    l_0 = k["l_0_m"]
    lam = schlankheit(l_0, dicke_m)

    N_Ed = abs(float(N_Ed_je_m_kN))

    # Ausmitten. Die planmäßige wird nach unten auf den Mindestwert der Norm
    # begrenzt — eine Wand ohne jede Ausmitte gibt es nicht.
    e_min = max(dicke_m / 30.0, 0.020)
    e_0 = float(ausmitte_m) if ausmitte_m is not None else 0.0
    if M_Ed_je_m_kNm and N_Ed > 1e-6:
        e_0 = max(e_0, abs(M_Ed_je_m_kNm) / N_Ed)
    e_0 = max(e_0, e_min)
    e_i = l_0 / 400.0
    e_tot = e_0 + e_i

    hinweise: list[str] = []
    if k["hinweis"]:
        hinweise.append(k["hinweis"])

    # Φ nach EC2 12.6.5.2. Der zweite Term ist die Knickabminderung, der erste
    # die Wirkung der Ausmitte auf den überdrückten Restquerschnitt.
    rest = 1.0 - 2.0 * e_tot / dicke_m if dicke_m > 1e-6 else 0.0
    phi = min(1.14 * rest - 0.02 * l_0 / dicke_m, rest) if dicke_m > 1e-6 else 0.0

    tragfaehig = True
    if rest <= 0.0:
        hinweise.append(
            f"Die Ausmitte e_tot = {e_tot*1000:.0f} mm erreicht die halbe Wanddicke "
            f"({dicke_m*500:.0f} mm) — der Querschnitt klafft vollständig auf. "
            f"Unbewehrt nicht nachweisbar.")
        tragfaehig = False
        phi = 0.0
    if lam > LAMBDA_GRENZE:
        hinweise.append(
            f"λ = {lam:.0f} > {LAMBDA_GRENZE:.0f} — jenseits des Anwendungsbereichs des "
            f"vereinfachten Verfahrens (EC2/NA 12.6.5.1). Bewehrter Nachweis nötig.")
        tragfaehig = False

    phi = max(phi, 0.0)
    # b = 1 m, deshalb ist N_Rd unmittelbar die Traglast je Meter.
    N_Rd = 1.0 * dicke_m * f_cd_pl * 1000.0 * phi

    ausnutzung = N_Ed / N_Rd if N_Rd > 1e-9 else float("inf")

    return {
        "verfahren": "unbewehrt, EC2 12.6.5.2",
        "N_Ed_je_m_kN": round(N_Ed, 1),
        "N_Rd_je_m_kN": round(N_Rd, 1),
        "ausnutzung": round(ausnutzung, 3) if math.isfinite(ausnutzung) else None,
        "erfuellt": bool(tragfaehig and ausnutzung <= 1.0),
        "lambda": round(lam, 1),
        "l_0_m": l_0,
        "phi": round(phi, 3),
        "e_0_m": round(e_0, 4),
        "e_i_m": round(e_i, 4),
        "e_tot_m": round(e_tot, 4),
        "f_cd_pl_MNm2": round(f_cd_pl, 2),
        "dicke_m": dicke_m,
        "hoehe_m": hoehe_m,
        "beton": c.name,
        "hinweise": hinweise,
    }


def nachweis_mit_bewehrung(N_Ed_je_m_kN: float, dicke_m: float, hoehe_m: float,
                           beton_: bt.Beton | str = "C25/30", **kwargs) -> dict:
    """
    Erst unbewehrt, und wenn das nicht reicht, als 1 m breite Stütze.

    Der Weg, den ein Tragwerksplaner geht: das einfache Verfahren zuerst, weil
    es ohne Bewehrungsannahme auskommt und in neun von zehn Fällen genügt. Erst
    wenn es nicht aufgeht, lohnt der Aufwand des genaueren — und der liefert
    dann auch gleich die erforderliche Bewehrung.
    """
    erst = nachweis(N_Ed_je_m_kN, dicke_m, hoehe_m, beton_, **kwargs)
    if erst["erfuellt"]:
        return erst

    from . import stuetze as st

    k = knicklaenge_m(hoehe_m, kwargs.get("halterung", "zweiseitig"),
                      kwargs.get("laenge_m"), kwargs.get("quersteifen", 0))
    genauer = st.nachweis(
        N_Ed_kN=abs(float(N_Ed_je_m_kN)),
        M_Ed_kNm=abs(float(kwargs.get("M_Ed_je_m_kNm", 0.0))),
        breite_m=1.0, hoehe_querschnitt_m=dicke_m,
        l_0_m=k["l_0_m"], beton_=beton_,
        mindestbewehrung_anteil=0.0015,   # EC2 9.6.2/NA: 0,15 % A_c für Wände
    )
    genauer["verfahren"] = "bewehrt, EC2 5.8.8 (Wand als 1-m-Streifen)"
    genauer["unbewehrt"] = erst
    genauer["hinweise"] = [
        "Unbewehrt nicht nachweisbar — als bewehrte Wand gerechnet.",
        *erst["hinweise"], *genauer.get("hinweise", []),
    ]
    genauer["a_s_je_m_cm2"] = genauer.get("a_s_gesamt_cm2")
    return genauer
