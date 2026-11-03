"""
Werkstoffe für das Volumenmodell: Beton, Holz, Stahl — mit ihrer
Steifigkeitsmatrix und ihrem Spannungsnachweis.

## Warum dieses Modul neben `beton.py` steht

`beton.py` bemisst Stahlbeton: aus einem Moment wird eine Bewehrungsfläche.
Das setzt einen *Querschnitt* voraus und eine Norm, die für diesen Querschnitt
geschrieben ist. Hier geht es eine Ebene tiefer — um den Werkstoff selbst, wie
ihn das Kontinuum sieht:

    Verzerrung  ──[ C ]──▶  Spannung  ──[ Nachweis ]──▶  Ausnutzung

Das ist die Sprache eines Volumenmodells. Ein Balken bekommt hier kein Moment,
sondern einen Spannungszustand an jedem Punkt, und die Frage lautet nicht „wie
viel Bewehrung", sondern „hält der Werkstoff das aus". Beide Ebenen werden
gebraucht: die Bemessung für den Nachweis, das Kontinuum für die Frage, *wo*
im Bauteil es eng wird und wie sich die Beanspruchung verteilt.

## Holz ist der Grund, warum es die Matrix braucht

Beton und Stahl sind isotrop; für sie genügen E und ν, und der bisherige Löser
kommt damit aus. Holz nicht. Längs zur Faser ist Fichte rund 11 000 N/mm²
steif, quer dazu 370 — ein Faktor 30. Wer einen Holzbalken isotrop mit E_0
rechnet, bekommt eine Durchbiegung, die um ein Viertel danebenliegt, und
Querzugspannungen, die es so nicht gibt; wer ihn mit einem Mittelwert rechnet,
bekommt beides falsch.

Deshalb wird die Steifigkeit hier als volle 6×6-Matrix in Voigt-Notation
geführt

    σ = C · ε ,   σ = [σxx σyy σzz τyz τxz τxy] ,  ε = [εxx εyy εzz γyz γxz γxy]

mit den Ingenieurschubverzerrungen γ = 2ε. Für Beton und Stahl ist das
dieselbe Matrix wie die Lamé-Formulierung, nur ausgeschrieben — der Löser
braucht deshalb nur *einen* Weg und nicht zwei.

## Einheiten

Wie im ganzen Paket: Längen in m, Kräfte in kN, Spannungen daher in kN/m².
Die Datenblätter der Normen stehen in N/mm²; die Umrechnung (Faktor 1000)
passiert **einmal** beim Anlegen der Bibliothek, nicht verstreut im Rechenweg.
Nach außen — in Berichten und in der Punktwolke — wird wieder in N/mm²
ausgegeben, weil niemand eine Betonspannung in kN/m² liest.

## Was hier bewusst *nicht* steht

Kein nichtlineares Materialgesetz: kein Reißen, kein Fließen, kein Kriechen.
Die Rechnung ist linear-elastisch, und die Ausnutzung ist deshalb ein
Spannungsvergleich, kein Traglastnachweis. Für Stahl im Gebrauchszustand ist
das exakt, für Holz bis zum Bruch nahezu, für Beton unter Zug ausdrücklich
nicht — dort sagt die Hauptzugspannung, *wo* gerissen wird und wo folglich
Bewehrung hin muss, und die eigentliche Bemessung macht weiter `beton.py`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

#: N/mm² → kN/m². Steht einmal hier, damit die Bibliothek unten in den Zahlen
#: der Norm geschrieben werden kann.
MPA = 1.0e3


# ──────────────────────────────────────────────────────────────────────────
# Werkstoff
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Werkstoff:
    """
    Ein Baustoff mit Steifigkeit, Wichte und Festigkeiten.

    `familie` steuert den Nachweis — `beton`, `holz` oder `stahl` —, denn die
    drei fragen Verschiedenes: Stahl vergleicht die Vergleichsspannung mit der
    Streckgrenze, Holz führt getrennte Nachweise längs, quer und auf Schub,
    Beton unterscheidet Druck (tragfähig) von Zug (reißt).

    Die Steifigkeitskennwerte sind orthotrop angelegt, auch für isotrope
    Stoffe: dann sind `E_2 = E_3 = E_1` und `G = E/(2(1+ν))`, und die Matrix
    kommt exakt auf die Lamé-Form heraus. Ein zweiter Codepfad für „isotrop"
    wäre eine Fehlerquelle ohne Gegenwert.

    Achse 1 ist bei Holz die **Faserrichtung**. Wie sie im Bauteil liegt, weiß
    dieses Modul nicht — das entscheidet die Geometrie (`volumen.py` dreht die
    Matrix in die Balkenachse).
    """

    name: str
    familie: str                    # beton | holz | stahl
    rho_kNm3: float                 # Wichte, für das Eigengewicht

    E_1: float                      # kN/m², längs (bei Holz: parallel zur Faser)
    E_2: float
    E_3: float
    G_12: float
    G_13: float
    G_23: float                     # bei Holz der Rollschubmodul
    nu_12: float
    nu_13: float
    nu_23: float

    #: Festigkeiten, charakteristisch, in kN/m². Welche gesetzt sind, hängt an
    #: der Familie; nicht zutreffende bleiben None.
    f_c_k: float | None = None      # Druck längs (Beton: f_ck, Holz: f_c,0,k)
    f_t_k: float | None = None      # Zug längs (Beton: f_ctm, Holz: f_t,0,k)
    f_m_k: float | None = None      # Biegung (nur Holz)
    f_v_k: float | None = None      # Schub
    f_c_90_k: float | None = None   # Druck quer (nur Holz)
    f_t_90_k: float | None = None   # Zug quer (nur Holz)
    f_y_k: float | None = None      # Streckgrenze (nur Stahl)

    gamma_M: float = 1.0            # Teilsicherheitsbeiwert Widerstandsseite
    k_mod: float = 1.0              # Holz: Modifikationsbeiwert KLED/NKL
    alpha: float = 1.0              # Beton: Dauerstandsbeiwert α_cc

    #: Was in der Anzeige unter dem Namen steht — Festigkeitsklasse, Norm.
    hinweis: str = ""

    # -- Bemessungswerte ------------------------------------------------

    def _bemessung(self, f_k: float | None) -> float | None:
        """f_d = k_mod · α · f_k / γ_M — die drei Beiwerte sind je Familie 1,0."""
        if f_k is None:
            return None
        return self.k_mod * self.alpha * f_k / self.gamma_M

    @property
    def f_cd(self) -> float | None:
        return self._bemessung(self.f_c_k)

    @property
    def f_td(self) -> float | None:
        return self._bemessung(self.f_t_k)

    @property
    def f_md(self) -> float | None:
        return self._bemessung(self.f_m_k)

    @property
    def f_vd(self) -> float | None:
        return self._bemessung(self.f_v_k)

    @property
    def f_yd(self) -> float | None:
        # γ_M0 = 1,0 nach EC3; steht trotzdem im Nenner, damit ein abweichender
        # Beiwert (γ_M1 für Stabilität) sich hier auswirkt und nicht übergangen wird.
        return None if self.f_y_k is None else self.f_y_k / self.gamma_M

    @property
    def isotrop(self) -> bool:
        return (abs(self.E_1 - self.E_2) < 1e-9 and abs(self.E_1 - self.E_3) < 1e-9
                and abs(self.nu_12 - self.nu_13) < 1e-12)

    @property
    def E_mittel(self) -> float:
        """Ein Ersatzwert für Abschätzungen — nie für die Rechnung."""
        return float(self.E_1)

    # -- Steifigkeit ----------------------------------------------------

    def nachgiebigkeit(self) -> np.ndarray:
        """
        Die Nachgiebigkeitsmatrix S (6×6), ε = S·σ.

        Sie wird zuerst aufgestellt und dann invertiert, nicht umgekehrt: die
        Ingenieurkonstanten sind Messgrößen und stehen genau *hier* direkt
        drin. C direkt hinzuschreiben verlangt Terme aus einer Determinante,
        die niemand nachprüft.

        Die Symmetrie S[i,j] = S[j,i] ergibt sich aus ν_ij/E_i = ν_ji/E_j; sie
        wird deshalb nicht geprüft, sondern durch die Konstruktion erzwungen.
        """
        E1, E2, E3 = self.E_1, self.E_2, self.E_3
        S = np.zeros((6, 6))
        S[0, 0], S[1, 1], S[2, 2] = 1.0 / E1, 1.0 / E2, 1.0 / E3
        S[0, 1] = S[1, 0] = -self.nu_12 / E1
        S[0, 2] = S[2, 0] = -self.nu_13 / E1
        S[1, 2] = S[2, 1] = -self.nu_23 / E2
        S[3, 3] = 1.0 / self.G_23
        S[4, 4] = 1.0 / self.G_13
        S[5, 5] = 1.0 / self.G_12
        return S

    def steifigkeit(self) -> np.ndarray:
        """
        Die Steifigkeitsmatrix C (6×6) in kN/m², Achsen 1-2-3 des Werkstoffs.

        Prüft nebenbei, ob der Stoff überhaupt physikalisch möglich ist: eine
        Nachgiebigkeitsmatrix mit einem nicht positiven Eigenwert beschreibt
        ein Material, aus dem man Energie gewinnen könnte. Das passiert bei
        orthotropen Kennwerten schneller, als man denkt — ein ν_12 = 0,4 mit
        E_2/E_1 = 1/30 ist zulässig, ein ν_21 = 0,4 wäre es nicht —, und der
        Löser meldet es sonst erst als unbrauchbares Ergebnis.
        """
        S = self.nachgiebigkeit()
        eigen = np.linalg.eigvalsh(S)
        if eigen.min() <= 0.0:
            raise ValueError(
                f"Werkstoff '{self.name}': die Nachgiebigkeitsmatrix ist nicht "
                f"positiv definit (kleinster Eigenwert {eigen.min():.3e}). "
                f"Prüfe die Querdehnzahlen gegen das Steifigkeitsverhältnis.")
        return np.linalg.inv(S)


def _isotrop(name: str, familie: str, E: float, nu: float, rho: float, **rest) -> Werkstoff:
    """Isotroper Werkstoff — E und ν auf alle Achsen, G aus beiden abgeleitet."""
    G = E / (2.0 * (1.0 + nu))
    return Werkstoff(name=name, familie=familie, rho_kNm3=rho,
                     E_1=E, E_2=E, E_3=E, G_12=G, G_13=G, G_23=G,
                     nu_12=nu, nu_13=nu, nu_23=nu, **rest)


# ──────────────────────────────────────────────────────────────────────────
# Drehung in die Bauteilachsen
# ──────────────────────────────────────────────────────────────────────────


def _rotationsmatrix(achse_1, achse_2=None) -> np.ndarray:
    """
    Orthonormale Basis (3×3, spaltenweise) aus einer vorgegebenen Achse 1.

    Achse 1 ist die Faser- bzw. Längsrichtung. Achse 2 darf mitgegeben werden
    (etwa die Stehrichtung eines Brettschichtträgers); sonst wird sie so
    gewählt, dass sie möglichst waagerecht liegt — für ein Vollholz mit
    zufälliger Jahrringlage ist jede Wahl gleich gut, und eine reproduzierbare
    ist besser als eine zufällige.
    """
    e1 = np.asarray(achse_1, dtype=float)
    n = np.linalg.norm(e1)
    if n < 1e-12:
        raise ValueError("Die Faserrichtung darf nicht der Nullvektor sein.")
    e1 = e1 / n

    if achse_2 is None:
        hilf = np.array([0.0, 0.0, 1.0])
        if abs(float(e1 @ hilf)) > 0.95:          # Achse 1 zeigt selbst nach oben
            hilf = np.array([1.0, 0.0, 0.0])
        e2 = np.cross(hilf, e1)
    else:
        e2 = np.asarray(achse_2, dtype=float)
        e2 = e2 - float(e2 @ e1) * e1             # orthogonalisieren
    n2 = np.linalg.norm(e2)
    if n2 < 1e-12:
        raise ValueError("Achse 2 ist parallel zur Faserrichtung.")
    e2 = e2 / n2
    e3 = np.cross(e1, e2)
    return np.stack([e1, e2, e3], axis=1)         # Spalten = Werkstoffachsen


#: Zuordnung Voigt-Index → Tensorindizes. Reihenfolge wie oben festgelegt:
#: xx, yy, zz, yz, xz, xy.
_VOIGT = [(0, 0), (1, 1), (2, 2), (1, 2), (0, 2), (0, 1)]


def voigt_zu_tensor(C: np.ndarray) -> np.ndarray:
    """6×6 → 3×3×3×3. Die Symmetrien werden dabei ausgeschrieben."""
    T = np.zeros((3, 3, 3, 3))
    for a, (i, j) in enumerate(_VOIGT):
        for b, (k, l) in enumerate(_VOIGT):
            wert = C[a, b]
            for ii, jj in ((i, j), (j, i)):
                for kk, ll in ((k, l), (l, k)):
                    T[ii, jj, kk, ll] = wert
    return T


def tensor_zu_voigt(T: np.ndarray) -> np.ndarray:
    """3×3×3×3 → 6×6. Umkehrung von `voigt_zu_tensor`."""
    C = np.zeros((6, 6))
    for a, (i, j) in enumerate(_VOIGT):
        for b, (k, l) in enumerate(_VOIGT):
            C[a, b] = T[i, j, k, l]
    return C


def drehen(C: np.ndarray, achse_1, achse_2=None) -> np.ndarray:
    """
    Die Steifigkeitsmatrix aus den Werkstoffachsen in die globalen drehen.

    Über den vollen Tensor vierter Stufe, nicht über die Bond-Matrix: der
    Umweg kostet ein paar Mikrosekunden je Werkstoff (nicht je Element) und
    macht aus einer Formelsammlung eine Zeile, die man lesen kann —

        C'_ijkl = R_ia R_jb R_kc R_ld C_abcd

    Die Bond-Transformation ist dasselbe in 36 Einträgen, von denen jeder
    einzeln falsch abgetippt sein kann.
    """
    R = _rotationsmatrix(achse_1, achse_2)
    T = voigt_zu_tensor(np.asarray(C, dtype=float))
    T = np.einsum("ia,jb,kc,ld,abcd->ijkl", R, R, R, R, T)
    return tensor_zu_voigt(T)


# ──────────────────────────────────────────────────────────────────────────
# Bibliothek
# ──────────────────────────────────────────────────────────────────────────


def _beton(name: str, f_ck: float) -> Werkstoff:
    """
    Betonfestigkeitsklasse nach EC2 Tab. 3.1.

        f_cm = f_ck + 8 ,  E_cm = 22 000 · (f_cm/10)^0,3  [N/mm²]
        f_ctm = 0,30 · f_ck^(2/3)                          (bis C50/60)

    ν = 0,2 für den ungerissenen Beton; γ_C = 1,5 und α_cc = 0,85 nach dem
    deutschen NA, dieselben Werte wie in `beton.py`.
    """
    f_cm = f_ck + 8.0
    E_cm = 22000.0 * (f_cm / 10.0) ** 0.3
    f_ctm = 0.30 * f_ck ** (2.0 / 3.0)
    return _isotrop(name, "beton", E_cm * MPA, 0.2, 25.0,
                    f_c_k=f_ck * MPA, f_t_k=f_ctm * MPA,
                    f_v_k=f_ctm * MPA,        # ohne Bewehrung ist Schub Zug
                    gamma_M=1.5, alpha=0.85,
                    hinweis=f"EC2 Tab. 3.1 · E_cm = {E_cm:.0f} N/mm², f_ctm = {f_ctm:.2f} N/mm²")


def _stahl(name: str, f_yk: float) -> Werkstoff:
    """
    Baustahl nach EC3 / DIN EN 10025, Erzeugnisdicke ≤ 40 mm.

    E = 210 000 N/mm², ν = 0,3, γ_M0 = 1,0. Die Schubfestigkeit folgt aus der
    Fließbedingung, nicht aus einer eigenen Prüfung: f_v = f_y/√3.
    """
    return _isotrop(name, "stahl", 210000.0 * MPA, 0.3, 78.5,
                    f_y_k=f_yk * MPA, f_c_k=f_yk * MPA, f_t_k=f_yk * MPA,
                    f_v_k=f_yk / np.sqrt(3.0) * MPA, gamma_M=1.0,
                    hinweis=f"EC3 · f_y = {f_yk:.0f} N/mm², t ≤ 40 mm")


def _holz(name: str, E_0: float, E_90: float, G: float,
          rho_k: float, rho_mean: float,
          f_m: float, f_t_0: float, f_c_0: float, f_v: float,
          f_t_90: float, f_c_90: float, gamma_M: float, norm: str) -> Werkstoff:
    """
    Nadelholz oder Brettschichtholz, orthotrop.

    Die Kennwerte kommen aus DIN EN 338 (Vollholz) bzw. DIN EN 14080 (BSH).
    Was dort **nicht** steht und hier ergänzt wird:

    * **Der Rollschubmodul** G_23 ≈ G/10. Quer zur Faser, in der Ebene der
      Jahrringe, ist Holz sehr weich; der Wert bestimmt die Schubverformung
      liegender Bretter und ist bei einem Balken nebensächlich, bei einer
      Brettsperrholzplatte entscheidend. 1/10 ist der übliche Ansatz.
    * **Die Querdehnzahlen** ν_12 = ν_13 = 0,4 und ν_23 = 0,3. Sie werden
      selten gemessen und noch seltener angegeben; die Werte liegen im Bereich
      der Literaturangaben für Fichte (ν_LR ≈ 0,37, ν_LT ≈ 0,42, ν_RT ≈ 0,47)
      und sind für die Biegetragwirkung ohnehin von untergeordnetem Einfluss.

    **Die Wichte kommt aus der Mittelrohdichte, nicht aus der
    charakteristischen.** ρ_k ist ein 5-%-Quantil und für Festigkeitsnachweise
    gedacht; das Eigengewicht eines Bauteils richtet sich nach dem, was es
    tatsächlich wiegt. Für C24 sind das 420 statt 350 kg/m³ — ein Fünftel
    Unterschied, der bei einem Dachstuhl unmittelbar in die Lasten geht. Ein
    fester Umrechnungsfaktor wäre hier falsch: zwischen ρ_k und ρ_mean liegen
    bei Vollholz rund 20 %, bei Brettschichtholz nur 8 %.

    `k_mod = 0,8` ist Nutzungsklasse 1 mit mittlerer Lasteinwirkungsdauer —
    der Regelfall im Hochbau. Wer eine andere KLED braucht, setzt ihn um
    (`mit_k_mod()`); der Wert ist bewusst sichtbar und nicht eingerechnet.
    """
    return Werkstoff(
        name=name, familie="holz", rho_kNm3=rho_mean * 9.81 / 1000.0,
        E_1=E_0 * MPA, E_2=E_90 * MPA, E_3=E_90 * MPA,
        G_12=G * MPA, G_13=G * MPA, G_23=G / 10.0 * MPA,
        nu_12=0.4, nu_13=0.4, nu_23=0.3,
        f_m_k=f_m * MPA, f_t_k=f_t_0 * MPA, f_c_k=f_c_0 * MPA, f_v_k=f_v * MPA,
        f_t_90_k=f_t_90 * MPA, f_c_90_k=f_c_90 * MPA,
        gamma_M=gamma_M, k_mod=0.8,
        hinweis=f"{norm} · E_0,mean = {E_0:.0f} N/mm², E_90 = {E_90:.0f} N/mm², "
                f"k_mod = 0,80 (NKL 1, mittlere KLED)")


#: Alles, was gewählt werden kann. Schlüssel ist der Name, wie ihn ein
#: Tragwerksplaner schreibt — er steht so in der Auswahl des Viewers, im
#: Bericht und in der Punktwolke.
WERKSTOFFE: dict[str, Werkstoff] = {}

for _name, _fck in [("C12/15", 12), ("C16/20", 16), ("C20/25", 20), ("C25/30", 25),
                    ("C30/37", 30), ("C35/45", 35), ("C40/50", 40), ("C45/55", 45),
                    ("C50/60", 50)]:
    WERKSTOFFE[_name] = _beton(_name, float(_fck))

for _name, _fy in [("S235", 235), ("S275", 275), ("S355", 355), ("S460", 460)]:
    WERKSTOFFE[_name] = _stahl(_name, float(_fy))

# Vollholz DIN EN 338 — E_0, E_90, G, ρ_k, ρ_mean, f_m, f_t0, f_c0, f_v, f_t90, f_c90
for _args in [
    ("C24", 11000, 370, 690, 350, 420, 24, 14.5, 21, 4.0, 0.4, 2.5),
    ("C30", 12000, 400, 750, 380, 460, 30, 18.0, 23, 4.0, 0.4, 2.7),
    ("D30", 11000, 730, 690, 530, 640, 30, 18.0, 23, 4.0, 0.6, 8.0),
]:
    WERKSTOFFE[_args[0]] = _holz(*_args, gamma_M=1.3, norm="DIN EN 338")

# Brettschichtholz DIN EN 14080, homogen
for _args in [
    ("GL24h", 11500, 300, 650, 385, 420, 24, 19.2, 24, 3.5, 0.5, 2.5),
    ("GL28h", 12600, 300, 650, 425, 460, 28, 22.3, 28, 3.5, 0.5, 2.5),
    ("GL32h", 13700, 300, 650, 440, 490, 32, 25.6, 32, 3.5, 0.5, 2.5),
]:
    WERKSTOFFE[_args[0]] = _holz(*_args, gamma_M=1.25, norm="DIN EN 14080")


def werkstoff(name: str | Werkstoff) -> Werkstoff:
    """
    Nachschlagen, tolerant gegen Schreibweisen.

    „c24", „C 24" und „GL24H" meinen dasselbe. Die Fehlermeldung nennt die
    Alternativen der passenden Familie zuerst — wer sich bei einer Holzklasse
    vertippt, will keine Liste von Betonklassen lesen.
    """
    if isinstance(name, Werkstoff):
        return name
    schluessel = str(name).replace(" ", "").upper()
    for k, w in WERKSTOFFE.items():
        if k.replace(" ", "").upper() == schluessel:
            return w
    raise KeyError(f"Werkstoff '{name}' ist nicht bekannt. "
                   f"Verfügbar: {', '.join(WERKSTOFFE)}")


def familie(name: str) -> list[Werkstoff]:
    """Alle Werkstoffe einer Familie, in der Reihenfolge der Bibliothek."""
    return [w for w in WERKSTOFFE.values() if w.familie == name]


def mit_k_mod(w: Werkstoff, k_mod: float) -> Werkstoff:
    """Denselben Holzwerkstoff mit anderem k_mod (KLED/NKL)."""
    from dataclasses import replace
    return replace(w, k_mod=float(k_mod))


# ──────────────────────────────────────────────────────────────────────────
# Spannungszustand auswerten
# ──────────────────────────────────────────────────────────────────────────


def als_tensor(sigma: np.ndarray) -> np.ndarray:
    """Voigt (n,6) → Tensoren (n,3,3)."""
    s = np.atleast_2d(np.asarray(sigma, dtype=float))
    T = np.empty((len(s), 3, 3))
    T[:, 0, 0], T[:, 1, 1], T[:, 2, 2] = s[:, 0], s[:, 1], s[:, 2]
    T[:, 1, 2] = T[:, 2, 1] = s[:, 3]
    T[:, 0, 2] = T[:, 2, 0] = s[:, 4]
    T[:, 0, 1] = T[:, 1, 0] = s[:, 5]
    return T


def hauptspannungen(sigma: np.ndarray) -> np.ndarray:
    """
    Die drei Hauptspannungen je Punkt, absteigend sortiert — (n,3).

    `eigvalsh` statt `eig`: der Spannungstensor ist symmetrisch, das
    symmetrische Verfahren ist schneller und liefert reelle Werte ohne
    Imaginärteil-Rest, den man sonst wegwerfen müsste.

    σ_1 ist damit die größte Zug-, σ_3 die größte Druckspannung — die beiden
    Größen, an denen sich ein Betonquerschnitt entscheidet.
    """
    eigen = np.linalg.eigvalsh(als_tensor(sigma))
    return eigen[:, ::-1]


def vergleichsspannung(sigma: np.ndarray) -> np.ndarray:
    """
    Von-Mises-Vergleichsspannung — (n,).

        σ_v = √( ½[(σx−σy)² + (σy−σz)² + (σz−σx)²] + 3(τxy² + τyz² + τxz²) )

    Sie ist die richtige Größe für Stahl (Gestaltänderungsenergie, isotropes
    Fließen) und für Beton und Holz **die falsche** — dort steht sie trotzdem
    zur Verfügung, weil sie als einzelnes Bild zeigt, wo das Bauteil
    überhaupt beansprucht ist. Bewertet wird sie nur beim Stahl.
    """
    s = np.atleast_2d(np.asarray(sigma, dtype=float))
    dev = ((s[:, 0] - s[:, 1]) ** 2 + (s[:, 1] - s[:, 2]) ** 2 + (s[:, 2] - s[:, 0]) ** 2)
    schub = s[:, 3] ** 2 + s[:, 4] ** 2 + s[:, 5] ** 2
    return np.sqrt(0.5 * dev + 3.0 * schub)


def in_achsen(sigma: np.ndarray, achse_1, achse_2=None) -> np.ndarray:
    """
    Spannungen aus dem globalen System in die Werkstoffachsen drehen — (n,6).

    Für Holz unentbehrlich: „Zug quer zur Faser" ist keine globale Richtung,
    sondern eine des Baustoffs. Liegt der Träger schräg im Grundriss, steht
    die maßgebende Komponente in keiner der Weltachsen.
    """
    R = _rotationsmatrix(achse_1, achse_2)
    T = als_tensor(sigma)
    lokal = np.einsum("ai,nab,bj->nij", R, T, R)
    return np.stack([lokal[:, 0, 0], lokal[:, 1, 1], lokal[:, 2, 2],
                     lokal[:, 1, 2], lokal[:, 0, 2], lokal[:, 0, 1]], axis=1)


def ausnutzung(w: Werkstoff, sigma: np.ndarray, achse_1=None, achse_2=None) -> dict:
    """
    Punktweise Ausnutzung η = Beanspruchung / Widerstand.

    @param sigma   Spannungen im **globalen** System, (n,6) in kN/m²
    @param achse_1 Faser-/Längsrichtung; bei Holz erforderlich, sonst ohne Wirkung
    @returns dict mit `eta` (n,) und den Teilnachweisen, die dazu geführt haben

    **Was diese Zahl ist und was nicht.** Sie vergleicht die Spannung an einem
    Punkt mit einer Bemessungsfestigkeit — nicht mehr. Ein η von 0,9 heißt:
    hier ist der Werkstoff zu 90 % ausgereizt, wenn man die lineare Rechnung
    beim Wort nimmt. Ein Traglastnachweis ist es nicht, weil das Modell weder
    reißt noch fließt noch umlagert. Für den Nachweis eines Balkens integriert
    `volumen.py` die Spannungen zu Schnittgrößen und rechnet damit nach EC2
    bzw. EC5 weiter; diese Zahl sagt, *wo* man hinschauen muss.

    **Die drei Familien fragen Verschiedenes:**

    | Familie | Nachweis |
    |---|---|
    | Stahl | σ_v ≤ f_yd — von Mises, isotropes Fließen |
    | Beton | −σ_3 ≤ f_cd (Druck) und σ_1 ≤ f_ctd (Riss, informativ) |
    | Holz  | getrennt längs, quer und auf Schub, in den Faserachsen |

    Beim Beton wird der Riss **nicht** als Versagen gezählt: eine
    Stahlbetonplatte reißt planmäßig, und die Zugkraft übernimmt die
    Bewehrung. `eta` ist deshalb der Druckanteil; die Zugausnutzung steht
    daneben und sagt, wo Bewehrung nötig wird.
    """
    s = np.atleast_2d(np.asarray(sigma, dtype=float))
    teil: dict[str, np.ndarray] = {}

    # Welche Teilnachweise η bestimmen — nicht alle tun das. Beim Beton ist
    # der Rissnachweis eine Auskunft und kein Versagen; stünde er in η, wäre
    # jede Stahlbetondecke rechnerisch überlastet. `bestimmend` sagt deshalb,
    # welcher Teil η erzeugt hat, damit die Anzeige nicht einen anderen
    # nennt, als die Zahl meint.
    bestimmend: list[str] = []

    if w.familie == "stahl":
        sv = vergleichsspannung(s)
        teil["vergleich"] = sv / w.f_yd
        eta = teil["vergleich"]
        bestimmend = ["vergleich"]

    elif w.familie == "beton":
        haupt = hauptspannungen(s)
        # σ_3 ist die kleinste, also die größte Druckspannung; positiver Wert
        # bedeutet dort Zug in allen Richtungen und damit keinen Druckanteil.
        druck = np.maximum(-haupt[:, 2], 0.0)
        zug = np.maximum(haupt[:, 0], 0.0)
        teil["druck"] = druck / w.f_cd
        # f_ctd mit α_ct = 1,0 (nicht α_cc = 0,85): der Dauerstandsbeiwert des
        # NA gilt für die Druckfestigkeit.
        f_ctd = w.f_t_k / w.gamma_M
        teil["zug"] = zug / f_ctd
        eta = teil["druck"]
        bestimmend = ["druck"]

    elif w.familie == "holz":
        if achse_1 is None:
            raise ValueError(
                "Für Holz muss die Faserrichtung angegeben werden — quer zur "
                "Faser ist die Festigkeit um den Faktor 30 kleiner, und ohne "
                "Richtung ist nicht entscheidbar, welche Komponente das ist.")
        lokal = in_achsen(s, achse_1, achse_2)
        laengs, quer_2, quer_3 = lokal[:, 0], lokal[:, 1], lokal[:, 2]
        tau_23, tau_13, tau_12 = lokal[:, 3], lokal[:, 4], lokal[:, 5]

        # Längs: Zug gegen die Biegefestigkeit. Dass hier f_m,d und nicht
        # f_t,0,d steht, ist eine bewusste Entscheidung — im Kontinuum ist
        # nicht unterscheidbar, ob eine Zugspannung aus Biegung oder aus einer
        # Normalkraft stammt, und der Regelfall eines Balkens ist Biegung.
        # Der zentrische Zugnachweis kommt aus den integrierten Schnittgrößen.
        f_zug = w.f_md if w.f_md else w.f_td
        teil["laengs_zug"] = np.maximum(laengs, 0.0) / f_zug
        teil["laengs_druck"] = np.maximum(-laengs, 0.0) / w.f_cd

        f_c90 = w.k_mod * w.f_c_90_k / w.gamma_M
        f_t90 = w.k_mod * w.f_t_90_k / w.gamma_M
        quer = np.stack([quer_2, quer_3], axis=1)
        teil["quer_zug"] = np.maximum(quer.max(axis=1), 0.0) / f_t90
        teil["quer_druck"] = np.maximum(-quer.min(axis=1), 0.0) / f_c90

        # Schub in den beiden Ebenen, die die Faser enthalten, gegen f_v,d;
        # der Rollschub (Ebene 2-3) gegen ein Zehntel davon — dieselbe
        # Größenordnung, in der auch der Schubmodul kleiner ist.
        teil["schub"] = np.sqrt(tau_12 ** 2 + tau_13 ** 2) / w.f_vd
        teil["rollschub"] = np.abs(tau_23) / (0.1 * w.f_vd)

        eta = np.max(np.stack(list(teil.values()), axis=1), axis=1)
        bestimmend = list(teil)

    else:
        raise ValueError(f"Unbekannte Werkstofffamilie '{w.familie}'.")

    return {"eta": eta, "teil": teil, "bestimmend": bestimmend,
            "werkstoff": w.name, "familie": w.familie}
