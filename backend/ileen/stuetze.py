"""
Stützen und bewehrte Wandstreifen: Knicknachweis nach Theorie II. Ordnung.

Das Gegenstück zu `wand` für den Fall, dass der vereinfachte Nachweis nicht
mehr trägt — und der einzige Weg für Stützen, deren Ausmitte planmäßig groß ist.

## Nennkrümmungsverfahren, EC2 5.8.8

Die Verformung der Stütze vergrößert die Ausmitte, die vergrößerte Ausmitte
vergrößert das Moment, das Moment vergrößert die Verformung. Statt diesen
Kreis iterativ zu schließen, schätzt 5.8.8 die Endkrümmung ab und rechnet
daraus eine zusätzliche Ausmitte:

    e_2 = (1/r) · l_0² / c        mit  c = π² ≈ 10
    1/r = K_r · K_φ · ε_yd / (0,45 · d)

    M_Ed = N_Ed · (e_0 + e_i + e_2)

`K_r` berücksichtigt, dass eine hoch ausgenutzte Stütze weniger krümmt als
eine schwach belastete, und hängt selbst vom Bewehrungsgrad ab — daher die
Iteration in `nachweis()`. `K_φ` erfasst das Kriechen.

## Warum die Querschnittstragfähigkeit numerisch integriert wird

Für N und M zugleich gibt es keine geschlossene Lösung wie bei reiner Biegung.
Der übliche Weg in der Praxis ist ein Interaktionsdiagramm aus der Tafel; hier
wird stattdessen die Dehnungsebene gesucht, die N_Rd = N_Ed erfüllt, und das
zugehörige M_Rd durch Integration über Streifen bestimmt. Das kostet
Millisekunden, kommt ohne Tafelwerte aus und gilt auch für Querschnitte, die
in keiner Tafel stehen.

Betonkennlinie ist das Parabel-Rechteck-Diagramm (EC2 3.1.7(1)), Stahl
bilinear mit horizontalem oberem Ast — die sichere Wahl, weil sie die
Verfestigung nicht ausnutzt.

## Grenzen

Einachsige Biegung. Kein Knicken um die schwache Achse bei ausmittiger Last um
die starke, keine zweiachsige Interaktion nach 5.8.9, kein Brandfall. Für
Regelgeschosse mit vorwiegend zentrischer Last ist das der Fall, der zählt;
eine Eckstütze mit Biegung aus zwei Richtungen ist es nicht.
"""

from __future__ import annotations

import math

import numpy as np

from . import beton as bt

#: Dehnungsgrenzen des Betons, EC2 Tab. 3.1 für Klassen bis C50/60.
EPS_C2 = 2.0e-3
EPS_CU2 = 3.5e-3
#: Exponent der Parabel im Parabel-Rechteck-Diagramm (n = 2 bis C50/60).
N_PARABEL = 2.0
#: Größte Stahldehnung im Bemessungsdiagramm mit horizontalem Ast.
EPS_UD = 25.0e-3


# ── Werkstoffgesetze ──────────────────────────────────────────────────────


def sigma_c(eps: np.ndarray, c: bt.Beton) -> np.ndarray:
    """
    Betondruckspannung in kN/m² zur Stauchung `eps` (Stauchung positiv).

    Zug wird zu null gesetzt: der Beton reißt, und die Zugfestigkeit im
    Grenzzustand der Tragfähigkeit anzusetzen wäre unzulässig.
    """
    eps = np.asarray(eps, dtype=float)
    spannung = np.zeros_like(eps)

    parabel = (eps > 0.0) & (eps < EPS_C2)
    spannung[parabel] = c.f_cd * (1.0 - (1.0 - eps[parabel] / EPS_C2) ** N_PARABEL)

    plateau = (eps >= EPS_C2) & (eps <= EPS_CU2 + 1e-12)
    spannung[plateau] = c.f_cd
    return spannung


def sigma_s(eps: np.ndarray, s: bt.Stahl) -> np.ndarray:
    """Stahlspannung in kN/m², bilinear mit horizontalem Ast. Zug positiv."""
    eps = np.asarray(eps, dtype=float)
    return np.clip(eps * s.E_s_MNm2 * 1000.0, -s.f_yd, s.f_yd)


# ── Querschnittstragfähigkeit ─────────────────────────────────────────────


def _dehnungsebene(zeta: float, h: float, d1: float):
    """
    Die Dehnungsebene zum bezogenen Nulllinienabstand ζ = x/h.

    Durchfahren werden alle drei Bereiche des Bemessungsdiagramms:

    * ζ ≤ ζ_1 — die Zugbewehrung erreicht ihre Grenzdehnung zuerst, der
      Querschnitt dreht um diesen Punkt.
    * ζ_1 < ζ ≤ 1 — der Druckrand erreicht ε_cu2, der übliche Biegefall.
    * ζ > 1 — der ganze Querschnitt ist überdrückt; die Ebene dreht um den
      Punkt C bei 3/7·h vom Druckrand mit ε = ε_c2. Das ist der Bereich, in
      dem eine Stütze bemessen wird.

    @returns (eps_oben, eps_unten) — Stauchung positiv, Druckrand ist „oben"
    """
    d = h - d1
    # Grenze zwischen Bereich 1 und 2: dort gilt beides gleichzeitig.
    zeta_1 = (EPS_CU2 / (EPS_CU2 + EPS_UD)) * (d / h)

    if zeta <= zeta_1:
        # Die Zugbewehrung erreicht ε_ud zuerst; die Ebene dreht um sie.
        # Nulllinie bei x, Dehnung dort null, bei z = d ist ε = −ε_ud.
        x = zeta * h
        if abs(d - x) < 1e-9:
            return 0.0, -EPS_UD
        steigung = -EPS_UD / (d - x)         # dε/dz, z von der Druckkante aus
        return steigung * (0.0 - x), steigung * (h - x)

    if zeta <= 1.0:
        x = zeta * h
        # Druckrand fest auf ε_cu2 (als positive Stauchung: +EPS_CU2)
        steigung = EPS_CU2 / x               # Dehnung fällt von oben linear
        return EPS_CU2, EPS_CU2 - steigung * h

    # Vollständig überdrückt: Drehpunkt C
    z_c = (1.0 - EPS_C2 / EPS_CU2) * h       # = 3/7·h bei ε_c2/ε_cu2 = 2/3,5
    x = zeta * h
    # Nulllinie bei x, Dehnung 0 dort; durch C mit ε_c2
    if abs(x - z_c) < 1e-9:
        return EPS_C2, EPS_C2
    steigung = EPS_C2 / (x - z_c)
    return steigung * (x - 0.0), steigung * (x - h)


def querschnitt(N_Ed_kN: float, breite_m: float, hoehe_m: float, d1_m: float,
                a_s_gesamt_cm2: float, c: bt.Beton, s: bt.Stahl = bt.B500B,
                streifen: int = 60) -> dict:
    """
    Das aufnehmbare Moment M_Rd bei gegebener Normalkraft und Bewehrung.

    Symmetrische Bewehrung, je die Hälfte an jedem Rand — die Regelausführung
    bei Stützen, und die einzige, die ohne Kenntnis der Momentenrichtung
    sinnvoll ist.

    Gesucht wird die Dehnungsebene, für die N_Rd(ζ) = N_Ed gilt; N_Rd wächst
    über ζ monoton, deshalb genügt eine Bisektion. Das zugehörige M_Rd ist
    dann die Tragfähigkeit.

    @param N_Ed_kN  Druck positiv
    @returns dict mit M_Rd_kNm, zeta, eps_oben, eps_unten
    """
    h, b, d1 = float(hoehe_m), float(breite_m), float(d1_m)
    if h <= 1e-6 or b <= 1e-6:
        raise ValueError(f"Querschnitt {b:.3f} × {h:.3f} m hat keine Fläche.")
    a_s = a_s_gesamt_cm2 * 1e-4 / 2.0        # je Rand, in m²
    d = h - d1

    # Betonstreifen: Mitte und Fläche
    z = (np.arange(streifen) + 0.5) * h / streifen
    flaeche = b * h / streifen

    def kraefte(zeta: float):
        eps_o, eps_u = _dehnungsebene(zeta, h, d1)
        # Lineare Interpolation der Stauchung über die Höhe
        eps = eps_o + (eps_u - eps_o) * (z / h)
        f_c = sigma_c(eps, c) * flaeche              # kN, Druck positiv
        eps_s2 = eps_o + (eps_u - eps_o) * (d1 / h)  # oben, am Druckrand
        eps_s1 = eps_o + (eps_u - eps_o) * (d / h)   # unten
        # sigma_s erwartet Zug positiv → Vorzeichen drehen
        f_s2 = -sigma_s(-eps_s2, s) * a_s
        f_s1 = -sigma_s(-eps_s1, s) * a_s
        N = float(f_c.sum() + f_s2 + f_s1)
        # Momente um die Querschnittsmitte, Druck oben ergibt positives M
        M = float((f_c * (h / 2.0 - z)).sum()
                  + f_s2 * (h / 2.0 - d1) + f_s1 * (h / 2.0 - d))
        return N, M, eps_o, eps_u

    # Bisektion über ζ. Die obere Grenze muss weit gefasst sein: die Ebene
    # nähert sich der gleichmäßigen Stauchung ε_c2 erst asymptotisch, und bei
    # ζ = 25 liegt der zugabgewandte Rand noch bei 1,95 ‰ statt 2,0 ‰ — die
    # zentrische Traglast käme dann um knapp 2 % zu klein heraus. Bei ζ = 500
    # ist der Rest kleiner als jede Rundung im Ergebnis.
    lo, hi = -0.5, 500.0
    N_lo, _, _, _ = kraefte(lo)
    N_hi, _, _, _ = kraefte(hi)

    if N_Ed_kN >= N_hi:
        # Mehr Druck, als der Querschnitt aufnimmt — M_Rd = 0, durchgefallen.
        N, M, eps_o, eps_u = kraefte(hi)
        return {"M_Rd_kNm": 0.0, "N_Rd_max_kN": round(N, 1), "zeta": hi,
                "eps_oben": eps_o, "eps_unten": eps_u, "ueberschritten": True}

    for _ in range(80):
        mid = 0.5 * (lo + hi)
        N_mid, _, _, _ = kraefte(mid)
        if N_mid < N_Ed_kN:
            lo = mid
        else:
            hi = mid

    N, M, eps_o, eps_u = kraefte(0.5 * (lo + hi))
    return {
        "M_Rd_kNm": round(abs(M), 2),
        "N_Rd_kN": round(N, 1),
        "N_Rd_max_kN": round(N_hi, 1),
        "zeta": round(0.5 * (lo + hi), 4),
        "eps_oben": round(eps_o * 1000, 2),
        "eps_unten": round(eps_u * 1000, 2),
        "ueberschritten": False,
    }


# ── Nachweis mit Theorie II. Ordnung ──────────────────────────────────────


def schlankheit(l_0_m: float, breite_m: float, hoehe_m: float) -> float:
    """λ = l_0/i für den Rechteckquerschnitt, Knicken um die schwache Achse."""
    dicke = min(breite_m, hoehe_m)
    return math.sqrt(12.0) * l_0_m / dicke if dicke > 1e-9 else float("inf")


def grenzschlankheit(n: float, e01_zu_e02: float = 1.0, phi_ef: float = 2.0,
                     omega: float = 0.1) -> float:
    """
    λ_lim nach DIN EN 1992-1-1/NA, 5.8.3.1 — unterhalb davon entfällt Th. II.

        λ_lim = 25 · (2 − e_01/e_02)   für n ≥ 0,41
        λ_lim = 16 / √n                sonst

    Die Fassung des NA ist einfacher als die des Grundtextes und leicht auf der
    sicheren Seite; sie kommt ohne A, B, C aus und braucht deshalb weder die
    Kriechzahl noch den Bewehrungsgrad, die beide zu diesem Zeitpunkt noch
    nicht feststehen.
    """
    if n >= 0.41:
        return 25.0 * (2.0 - e01_zu_e02)
    return 16.0 / math.sqrt(max(n, 1e-6))


def nachweis(N_Ed_kN: float, M_Ed_kNm: float, breite_m: float,
             hoehe_querschnitt_m: float, l_0_m: float,
             beton_: bt.Beton | str = "C25/30", stahl: bt.Stahl = bt.B500B,
             d1_m: float | None = None, phi_ef: float = 2.0,
             mindestbewehrung_anteil: float | None = None,
             hoechstbewehrung_anteil: float = 0.09) -> dict:
    """
    Stütze unter N und M: erforderliche Bewehrung und Ausnutzung.

    Der Ablauf folgt 5.8.8 und schließt die einzige echte Rückkopplung durch
    Iteration: `K_r` hängt vom mechanischen Bewehrungsgrad ω ab, ω vom
    Ergebnis. Zwölf Durchgänge genügen dafür immer; sie kosten nichts, weil die
    Querschnittsintegration selbst schon konvergiert ist.

    @param M_Ed_kNm  planmäßiges Moment aus dem Anschluss, ohne Imperfektion
    @param phi_ef    effektive Kriechzahl; 2,0 ist der übliche Ansatz im Hochbau
    @returns dict mit a_s_gesamt_cm2, ausnutzung, lambda, e_2_m, M_Ed_II_kNm
    """
    c = bt.beton(beton_) if isinstance(beton_, str) else beton_
    b, h = float(breite_m), float(hoehe_querschnitt_m)
    if d1_m is None:
        # Randabstand: Betondeckung + Bügel + halber Längsstab. Bei einer
        # Stütze rund 5,8 cm — bei einer 10-cm-Wand wäre das über die Hälfte
        # des Querschnitts. Dort entfallen die Bügel, die Deckung ist kleiner
        # und die Stäbe dünner, also mit der Bauteildicke skalieren und bei
        # 2,5 cm abfangen (Deckung XC1 plus halber 6-mm-Stab).
        d1_m = min(max(0.05, 0.04 + 0.008), max(0.025, h / 5.0))

    # **Ohne Querschnitt kein Nachweis.** Ein Bauteil, dessen Abmessungen aus
    # dem IFC nicht ableitbar waren, kommt hier mit b oder h nahe null an; die
    # Dehnungsebene teilt dann durch die Bauteilhöhe, und der Lauf scheiterte
    # an einer nichtssagenden „float division by zero". Lieber eine Meldung,
    # die sagt, was fehlt.
    if h <= 2.5 * d1_m or b <= 0.01:
        raise ValueError(
            f"Querschnitt {b*100:.1f} × {h*100:.1f} cm ist für einen Nachweis zu klein — "
            f"allein die Randabstände nähmen {2*d1_m*100:.1f} cm der Höhe ein. "
            f"Abmessungen aus dem Modell nicht brauchbar.")
    d = h - d1_m
    A_c = b * h
    N_Ed = abs(float(N_Ed_kN))

    hinweise: list[str] = []
    lam = schlankheit(l_0_m, b, h)
    n_bezogen = N_Ed / (A_c * c.f_cd) if A_c > 1e-9 else float("inf")

    # Imperfektion: θ_i = 1/200 · α_h, α_h = 2/√l ≤ 1 (EC2 5.2)
    alpha_h = min(1.0, 2.0 / math.sqrt(max(l_0_m, 1e-6)))
    theta_i = alpha_h / 200.0
    e_i = theta_i * l_0_m / 2.0

    e_0 = abs(M_Ed_kNm) / N_Ed if N_Ed > 1e-6 else 0.0
    # Mindestausmitte nach 6.1(4): e_0 ≥ h/30 ≥ 20 mm
    e_0 = max(e_0, h / 30.0, 0.020)

    lam_lim = grenzschlankheit(n_bezogen)
    zweite_ordnung = lam > lam_lim

    a_s_min = (mindestbewehrung_anteil if mindestbewehrung_anteil is not None
               else max(0.15 * N_Ed / (stahl.f_yd) / A_c, 0.003)) * A_c * 1e4
    # EC2 9.5.2: A_s,min = max(0,15·N_Ed/f_yd ; 0,003·A_c)
    a_s_min = max(a_s_min, 0.0)
    a_s_max = hoechstbewehrung_anteil * A_c * 1e4

    a_s = a_s_min
    e_2 = 0.0
    K_r = 1.0
    for _ in range(12):
        if zweite_ordnung:
            # Nennkrümmung, 5.8.8.3
            omega = a_s * 1e-4 * stahl.f_yd / (A_c * c.f_cd)
            n_u = 1.0 + omega
            n_bal = 0.4
            K_r = min(1.0, max((n_u - n_bezogen) / max(n_u - n_bal, 1e-6), 0.0))
            beta_k = 0.35 + c.f_ck_MNm2 / 200.0 - lam / 150.0
            K_phi = max(1.0, 1.0 + beta_k * phi_ef)
            eps_yd = stahl.f_yd_MNm2 / stahl.E_s_MNm2
            krummung = K_r * K_phi * eps_yd / (0.45 * d)
            e_2 = krummung * l_0_m ** 2 / 10.0
        else:
            e_2 = 0.0

        e_tot = e_0 + e_i + e_2
        M_Ed_II = N_Ed * e_tot

        # Erforderliche Bewehrung: die kleinste, für die M_Rd ≥ M_Ed_II gilt.
        erf = _bewehrung_suchen(N_Ed, M_Ed_II, b, h, d1_m, c, stahl, a_s_min, a_s_max)
        if abs(erf - a_s) < 0.02 * max(a_s, 1.0):
            a_s = erf
            break
        a_s = erf

    e_tot = e_0 + e_i + e_2
    M_Ed_II = N_Ed * e_tot
    q = querschnitt(N_Ed, b, h, d1_m, a_s, c, stahl)
    M_Rd = q["M_Rd_kNm"]
    ausnutzung = M_Ed_II / M_Rd if M_Rd > 1e-6 else float("inf")

    if a_s >= a_s_max - 1e-6:
        hinweise.append(
            f"Bewehrungsgrad an der Höchstgrenze ({hoechstbewehrung_anteil*100:.0f} % A_c "
            f"= {a_s_max:.1f} cm²) — der Querschnitt ist zu klein.")
    if q.get("ueberschritten"):
        hinweise.append(
            f"N_Ed = {N_Ed:.0f} kN übersteigt die zentrische Traglast des Querschnitts "
            f"({q['N_Rd_max_kN']:.0f} kN). Nicht nachweisbar.")
    if not zweite_ordnung:
        hinweise.append(
            f"λ = {lam:.0f} ≤ λ_lim = {lam_lim:.0f} — Theorie II. Ordnung entfällt "
            f"(EC2/NA 5.8.3.1).")
    if lam > 200:
        hinweise.append(f"λ = {lam:.0f} > 200 — außerhalb des Anwendungsbereichs von 5.8.8.")

    # **Welche Zahl sagt, wie kritisch die Stütze ist.** `ausnutzung` = M_Ed/M_Rd
    # ist nach einer Bemessung immer ≈ 1,0 — die Bewehrung wurde ja gerade so
    # gewählt, dass es aufgeht. Sie beantwortet „geht es auf", nicht „wie eng".
    #
    # Die Rangfolge liefert `ausnutzung_querschnitt` = A_s,erf / A_s,max. Diese
    # Größe wächst monoton mit der Last, über den Punkt hinweg, an dem die
    # Mindestbewehrung nicht mehr reicht, und trennt die reichlich bemessene
    # Stütze (0,3 %) von der, die kurz vor dem Ausscheiden steht (8,5 %). Beide
    # zeigten unter `ausnutzung` dieselbe 1,0.
    #
    # Bewusst keine der beiden zu einer einzigen Kennzahl verrechnet: die
    # Skalen schließen am Übergang nicht aneinander an, und eine verkettete
    # Zahl fiele dort, wo die Last steigt.
    bemessen = a_s > a_s_min * 1.001
    ausnutzung_quer = a_s / a_s_max if a_s_max > 1e-9 else None

    return {
        "verfahren": "EC2 5.8.8, Nennkrümmung",
        "bemessen": bemessen,
        "ausnutzung_querschnitt": round(ausnutzung_quer, 3) if ausnutzung_quer else None,
        "N_Ed_kN": round(N_Ed, 1),
        "M_Ed_I_kNm": round(N_Ed * e_0, 2),
        "M_Ed_II_kNm": round(M_Ed_II, 2),
        "M_Rd_kNm": M_Rd,
        "ausnutzung": round(ausnutzung, 3) if math.isfinite(ausnutzung) else None,
        "erfuellt": bool(ausnutzung <= 1.0 and not q.get("ueberschritten")
                         and a_s < a_s_max - 1e-6),
        "a_s_gesamt_cm2": round(a_s, 2),
        "a_s_min_cm2": round(a_s_min, 2),
        "bewehrungsgrad": round(a_s * 1e-4 / A_c, 4),
        "lambda": round(lam, 1),
        "lambda_lim": round(lam_lim, 1),
        "theorie_II": zweite_ordnung,
        "l_0_m": round(l_0_m, 3),
        "e_0_m": round(e_0, 4),
        "e_i_m": round(e_i, 4),
        "e_2_m": round(e_2, 4),
        "K_r": round(K_r, 3),
        "n_bezogen": round(n_bezogen, 3),
        "querschnitt_m": [round(b, 3), round(h, 3)],
        "beton": c.name,
        "hinweise": hinweise,
    }


def _bewehrung_suchen(N_Ed: float, M_Ed: float, b: float, h: float, d1: float,
                      c: bt.Beton, s: bt.Stahl, a_s_min: float,
                      a_s_max: float) -> float:
    """Kleinste symmetrische Bewehrung mit M_Rd ≥ M_Ed. Bisektion über A_s."""
    if querschnitt(N_Ed, b, h, d1, a_s_min, c, s)["M_Rd_kNm"] >= M_Ed:
        return a_s_min
    lo, hi = a_s_min, a_s_max
    if querschnitt(N_Ed, b, h, d1, hi, c, s)["M_Rd_kNm"] < M_Ed:
        return a_s_max
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if querschnitt(N_Ed, b, h, d1, mid, c, s)["M_Rd_kNm"] < M_Ed:
            lo = mid
        else:
            hi = mid
    return hi
