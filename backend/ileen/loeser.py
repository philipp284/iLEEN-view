"""
Linearer Löser für viele Lastfälle auf demselben System.

**Warum nicht einfach `solver()` je Kombination.** Eine Decke wird nicht einmal
gerechnet, sondern zehnmal: je veränderlicher Einwirkung eine
GZT-Kombination, dazu die quasi-ständige und die seltene für den
Gebrauchszustand, und wer die ungünstige Laststellung sucht, kommt schnell auf
zwanzig. Die Steifigkeitsmatrix ist dabei jedes Mal dieselbe — nur die rechte
Seite ändert sich. Wer `solver()` je Kombination aufruft, baut und zerlegt sie
jedes Mal neu; das ist der teuerste Teil der Rechnung und vollständig umsonst.

Hier wird sie deshalb **einmal aufgestellt und einmal zerlegt**, und jeder
Lastfall ist danach ein Rückwärtseinsetzen. Bei einem Netz mit 60 000
Freiheitsgraden kostet die Zerlegung Sekunden, jeder weitere Lastfall
Millisekunden.

**Und weil das System linear ist, überlagert man danach.** Nicht die Lasten
werden kombiniert und dann gerechnet, sondern gerechnet und dann kombiniert:

    u(GZT) = Σ γ_i · u_i

Das ist dasselbe Ergebnis — und es macht die Frage beantwortbar, die man an ein
Bemessungsergebnis stellt: *woher* kommt das Moment. Der Beitrag jedes
Lastfalls bleibt einzeln sichtbar, bis zur letzten Zeile der Bemessung.

**Wie die Last ins System kommt.** Über `internal_vars` als Volumenkraft an den
Quadraturpunkten, nicht über `get_surface_maps`. Zwei Gründe: erstens hängt die
Steifigkeitsmatrix so nicht an der Last, die Zerlegung bleibt für alle
Lastfälle gültig; zweitens braucht es keine Randflächensuche — und der
Treppenrand eines Rasternetzes ist genau die Stelle, an der eine solche Suche
unauffällig danebengreift. Eine Flächenlast von q kN/m² wird als Volumenkraft
q/t in der obersten Elementlage der Höhe t angesetzt; die Resultierende ist
dieselbe, die Spannungsverteilung unterscheidet sich nur innerhalb dieser einen
Lage.
"""

from __future__ import annotations

import numpy as onp
import scipy.sparse
import scipy.sparse.linalg

import jax
from jax import config

# Muss vor dem ersten JAX-Array stehen. JAX rechnet sonst in float32, und die
# Steifigkeitsmatrix einer dünnen Platte ist so schlecht konditioniert, dass
# davon drei bis vier Stellen übrig bleiben: die Gleichgewichtsprobe weicht dann
# um ein Promille ab, und man sucht den Fehler in der Last statt im Datentyp.
# `jax_fem.solver` tut dasselbe beim Import — hier wird er nicht gebraucht.
config.update("jax_enable_x64", True)

import jax.numpy as np  # noqa: E402

from jax_fem.generate_mesh import Mesh
from jax_fem.problem import Problem


class Elastisch(Problem):
    """Lineare Elastizität mit ortsabhängiger Volumenkraft aus `internal_vars`."""

    def custom_init(self, E: float, nu: float):
        self.mu = E / (2.0 * (1.0 + nu))
        self.lmbda = E * nu / ((1.0 + nu) * (1.0 - 2.0 * nu))

    def get_tensor_map(self):
        # Die internen Variablen werden von JAX-FEM an *beide* Kernel gereicht;
        # der Spannungskern braucht sie nicht und schluckt sie deshalb.
        def spannung(u_grad, *_):
            eps = 0.5 * (u_grad + u_grad.T)
            return self.lmbda * np.trace(eps) * np.eye(self.dim) + 2.0 * self.mu * eps
        return spannung

    def get_mass_map(self):
        def kraft(_u, _x, f):
            return f
        return kraft


class ElastischHeterogen(Problem):
    """
    Lineare Elastizität mit **elementweiser** Steifigkeitsmatrix.

    `Elastisch` kennt ein E und ein ν für das ganze Netz. Das reicht, solange
    ein Bauteil aus einem Stoff besteht und dieser Stoff isotrop ist — für
    eine Stahlbetondecke also. Es reicht nicht mehr, sobald

    * mehrere Bauteile in **einem** Netz stehen (Betondecke auf Stahlträger),
    * oder der Werkstoff selbst richtungsabhängig ist (Holz: längs zur Faser
      dreißigmal steifer als quer).

    Beides zusammen ist der Regelfall, sobald man aufhört, Decken zu rechnen.
    Deshalb steht hier statt zweier Zahlen eine volle Steifigkeitsmatrix in
    Voigt-Notation, und jedes Element sagt über einen Index, welche es ist.

    **Warum ein Index und nicht die Matrix je Element.** Die Matrix hat 36
    Einträge; als interne Variable je Quadraturpunkt wären das bei 100 000
    Elementen 230 MB, die durch jeden JIT-Aufruf wandern. Ein Bauwerk hat aber
    keine 100 000 Werkstoffe, sondern drei. Also wandert nur die Nummer mit
    (3 MB), und die Tabelle liegt als Konstante im Kernel. Der Gather in der
    Materialtabelle kostet nichts gegen die Matrixmultiplikation daneben.

    Die Voigt-Reihenfolge ist die von `werkstoff.py`:

        σ = [σxx σyy σzz τyz τxz τxy] ,  ε = [εxx εyy εzz γyz γxz γxy]

    mit den Ingenieurschubverzerrungen γ = 2ε — der Faktor 2 steht deshalb im
    Kernel und darf nicht zusätzlich in der Matrix stecken.
    """

    def custom_init(self, C_tabelle):
        # Als JAX-Array festhalten: sonst wird die Tabelle bei jedem Aufruf
        # neu übertragen, und der Kernel bekäme sie als traced Argument statt
        # als Konstante.
        self.C_tabelle = np.asarray(C_tabelle)

    def get_tensor_map(self):
        C_tab = self.C_tabelle

        def spannung(u_grad, index, *_):
            eps = 0.5 * (u_grad + u_grad.T)
            verzerrung = np.array([
                eps[0, 0], eps[1, 1], eps[2, 2],
                2.0 * eps[1, 2], 2.0 * eps[0, 2], 2.0 * eps[0, 1]])
            s = C_tab[index] @ verzerrung
            return np.array([
                [s[0], s[5], s[4]],
                [s[5], s[1], s[3]],
                [s[4], s[3], s[2]]])
        return spannung

    def get_mass_map(self):
        def kraft(_u, _x, _index, f):
            return f
        return kraft


class Loeser:
    """
    Ein System, viele Lastfälle.

        loeser = Loeser(netz, E, nu, bc_info)
        u_g = loeser.loese(f_eigengewicht)      # (n_knoten, 3)
        u_q = loeser.loese(f_nutzlast)
        u_d = 1.35 * u_g + 1.5 * u_q            # Superposition

    `f_…` sind Volumenkraftfelder in kN/m³, je Element ein Vektor (n_cells, 3),
    Richtung physikalisch (Schwerkraft also negativ in z). Die Umrechnung von
    Flächen-, Linien- und Einzellasten übernimmt `plate.volumenlast()`.

    `federn_z` (optional, (n_knoten,) in kN/m) legt eine flächige elastische
    Bettung an — eine Diagonale, die vor der Dirichlet-Elimination zur
    Steifigkeitsmatrix addiert wird (`plate.bettungsfedern()` baut sie). Anders
    als ein Dirichlet-Lager ist das keine Randbedingungsliste, sondern ein
    echter Steifigkeitsanteil: JAX-FEM führt zwar Robin-Randbedingungen, aber
    deren Formulierung gehört ins Problem — eine Diagonale auf der bereits
    zusammengebauten Matrix ist hier der kleinere, exakte Weg (lumped
    Federn an den Knoten, mit Einzugsfläche gewichtet).
    """

    def __init__(self, netz, E: float | None = None, nu: float | None = None,
                 bc_info=None, federn_z: onp.ndarray | None = None,
                 C_tabelle: onp.ndarray | None = None,
                 material: onp.ndarray | None = None):
        self.netz = netz
        self.federn_z = None if federn_z is None else onp.asarray(federn_z, dtype=float)

        # Zwei Betriebsarten, ein Löser. Alles, was danach kommt — Zerlegung,
        # Lastfälle, Überlagerung, Auflagerprobe —, ist für beide dasselbe;
        # verschieden ist nur, woher der Kernel seine Steifigkeit nimmt.
        self.heterogen = C_tabelle is not None
        if self.heterogen:
            if material is None:
                raise ValueError(
                    "Zu einer Werkstofftabelle gehört die Zuordnung `material` "
                    "(ein Index je Element) — sonst ist nicht gesagt, welches "
                    "Element aus welchem Stoff besteht.")
            self.C_tabelle = onp.asarray(C_tabelle, dtype=float)
            if self.C_tabelle.ndim != 3 or self.C_tabelle.shape[1:] != (6, 6):
                raise ValueError(
                    f"C_tabelle muss (n_werkstoffe, 6, 6) sein, ist "
                    f"{self.C_tabelle.shape}.")
            self.material = onp.asarray(material, dtype=onp.int32).ravel()
            if len(self.material) != len(netz.cells):
                raise ValueError(
                    f"{len(self.material)} Materialindizes für "
                    f"{len(netz.cells)} Elemente.")
            if self.material.max(initial=0) >= len(self.C_tabelle):
                raise ValueError(
                    f"Materialindex {int(self.material.max())} zeigt an der "
                    f"Tabelle mit {len(self.C_tabelle)} Werkstoffen vorbei.")
            self.E = self.nu = None
        else:
            if E is None or nu is None:
                raise ValueError("Ohne C_tabelle braucht der Löser E und ν.")
            self.C_tabelle, self.material = None, None
            self.E, self.nu = float(E), float(nu)

        gitter = Mesh(netz.points, netz.cells)
        if self.heterogen:
            self.problem = ElastischHeterogen(
                mesh=gitter, vec=3, dim=3, ele_type="HEX8",
                dirichlet_bc_info=bc_info,
                additional_info=(self.C_tabelle,),
            )
        else:
            self.problem = Elastisch(
                mesh=gitter, vec=3, dim=3, ele_type="HEX8",
                dirichlet_bc_info=bc_info,
                additional_info=(float(E), float(nu)),
            )
        fe = self.problem.fes[0]
        self.n_knoten = fe.num_total_nodes
        self.n_zellen = len(netz.cells)
        self.n_quad = self.problem.physical_quad_points.shape[1]
        self.n_dof = self.problem.num_total_dofs_all_vars

        # Der Materialindex je Quadraturpunkt. Er ändert sich nie und wird
        # deshalb einmal aufgespannt statt bei jedem Lastfall neu.
        self._material_quad = (
            np.asarray(onp.repeat(self.material[:, None], self.n_quad, axis=1))
            if self.heterogen else None)

        self._null = [np.zeros((self.n_knoten, 3))]
        self.problem.internal_vars = self._internal(
            np.zeros((self.n_zellen, self.n_quad, 3)))

        self._matrix()

    def _internal(self, f_quad):
        """
        Die internen Variablen in der Reihenfolge, die der Kernel erwartet.

        Im heterogenen Fall steht der Materialindex **vor** der Last: JAX-FEM
        reicht die Liste unverändert an beide Kernel, und `get_tensor_map`
        braucht den Index als erstes Argument. Die eine Stelle, an der diese
        Reihenfolge festgelegt wird — verteilt auf zwei Aufrufer wäre sie eine
        Fehlerquelle, die sich als falsche Steifigkeit tarnt.
        """
        return ([self._material_quad, f_quad] if self.heterogen else [f_quad])

    # -- Aufbau ---------------------------------------------------------

    def _matrix(self):
        """Steifigkeitsmatrix aufstellen, Bettung addieren, Dirichlet-Zeilen ersetzen, zerlegen."""
        self.problem.newton_update(self._null)          # füllt problem.V
        A = scipy.sparse.csr_array(
            (onp.asarray(self.problem.V), (self.problem.I, self.problem.J)),
            shape=(self.n_dof, self.n_dof))
        A.sum_duplicates()

        # DOF-Layout dieses einen vec=3-Felds: Knoten n, Komponente c -> n*3+c
        # (dieselbe Zuordnung, die unten für die Dirichlet-Zeilen benutzt wird).
        self.gefedert = onp.zeros(self.n_dof, dtype=bool)
        if self.federn_z is not None:
            diag = onp.zeros(self.n_dof)
            diag[onp.arange(self.n_knoten) * 3 + 2] = self.federn_z
            A = A + scipy.sparse.diags(diag)
            self.gefedert = diag > 0.0

        self.K = A                                       # ungestört — für Auflager-/Federkräfte

        gehalten = onp.zeros(self.n_dof, dtype=bool)
        for ind, fe in enumerate(self.problem.fes):
            for i in range(len(fe.node_inds_list)):
                zeilen = (onp.asarray(fe.node_inds_list[i]) * fe.vec
                          + onp.asarray(fe.vec_inds_list[i]) + self.problem.offset[ind])
                gehalten[zeilen] = True
        self.gehalten = gehalten
        self.frei = ~gehalten

        # Zeilenweise Elimination: freie Zeilen bleiben, gehaltene werden zur
        # Einheitszeile. Als Matrixprodukt statt in einer Schleife, weil das bei
        # hunderttausend Zeilen der Unterschied zwischen einer Sekunde und
        # einer Minute ist.
        D = scipy.sparse.diags(self.frei.astype(float))
        I = scipy.sparse.diags(gehalten.astype(float))
        A_bc = (D @ A + I).tocsc()

        self.zerlegung = scipy.sparse.linalg.factorized(A_bc)

    # -- Lasten ---------------------------------------------------------

    def lastvektor(self, f_zellen) -> onp.ndarray:
        """
        Knotenlastvektor aus einem elementweisen Volumenkraftfeld.

        @param f_zellen (n_cells, 3) in kN/m³, physikalische Richtung
        @returns (n_dof,) — die rechte Seite, Vorzeichen bereits gedreht
        """
        f = onp.asarray(f_zellen, dtype=float)
        if f.ndim == 2:
            f = onp.repeat(f[:, None, :], self.n_quad, axis=1)

        # Die Vorzeichenfalle von JAX-FEM: `mass_map` wird zum Residuum addiert,
        # die äußere Last ist also ihr Negatives. Hier einmal an einer Stelle.
        self.problem.internal_vars = self._internal(np.asarray(-f))
        res = self.problem.compute_residual(self._null)
        return -onp.asarray(jax.flatten_util.ravel_pytree(res)[0])

    def loese(self, f_zellen=None, lastvektor=None) -> onp.ndarray:
        """Verschiebungen zu einem Lastfall — (n_knoten, 3) in m."""
        b = self.lastvektor(f_zellen) if lastvektor is None else onp.asarray(lastvektor)
        u = self.zerlegung(b * self.frei)
        return u.reshape(self.n_knoten, 3)

    def loese_alle(self, felder: dict) -> tuple[dict, dict]:
        """
        Alle Lastfälle auf einmal.

        @returns (Verschiebungen je Lastfall, Lastvektoren je Lastfall) — die
                 Lastvektoren werden für die Auflagerkräfte noch gebraucht.
        """
        loesungen, vektoren = {}, {}
        for name, feld in felder.items():
            vektoren[name] = self.lastvektor(feld)
            loesungen[name] = self.loese(lastvektor=vektoren[name])
        return loesungen, vektoren

    # -- Auswertung -----------------------------------------------------

    def auflagerkraefte(self, u: onp.ndarray, lastvektor: onp.ndarray) -> onp.ndarray:
        """
        Knotenkräfte in den Auflagern, (n_knoten, 3) in kN.

        R = K·u − f. An freien Knoten ist das null (bis auf Rundung), an
        gehaltenen steht die Auflagerkraft. Ihre Summe muss die aufgebrachte
        Last sein — die schärfste Probe, die eine FE-Rechnung zulässt, und sie
        kostet eine Matrixmultiplikation.
        """
        r = self.K @ onp.asarray(u).reshape(-1) - onp.asarray(lastvektor)
        return (r * self.gehalten).reshape(self.n_knoten, 3)

    def federkraefte(self, u: onp.ndarray) -> onp.ndarray:
        """
        Reaktionskräfte der Bettungsfedern, (n_knoten, 3) in kN — nur die
        z-Komponente ist von null verschieden.

        **Nicht wie `auflagerkraefte()` als Restglied K·u − f.** Ein
        Bettungsknoten ist kein Dirichlet-Lager, sondern ein gewöhnlicher
        freier Freiheitsgrad mit zusätzlicher Steifigkeit — und an jedem
        freien Freiheitsgrad löst die Zerlegung K·u = f per Definition genau
        auf, das Restglied ist dort exakt null (das ist ja der Sinn von
        „lösen"). Die Federkraft steckt nicht im Restglied, sondern im
        Hookeschen Gesetz selbst: R = −k·u. Vorzeichen wie bei den übrigen
        Auflagerkräften dieses Moduls (`auflagerkraefte()`, `auflagerbilanz()`):
        drückend/stützend positiv — eine Senkung (u_z < 0) staucht die Feder
        und ergibt eine stützende, positive Reaktion.
        """
        R = onp.zeros((self.n_knoten, 3))
        if self.federn_z is not None:
            u_z = onp.asarray(u).reshape(self.n_knoten, 3)[:, 2]
            R[:, 2] = -self.federn_z * u_z
        return R

    def probe(self, u: onp.ndarray, lastvektor: onp.ndarray) -> dict:
        """Gleichgewicht von Last, Auflager- und Federkräften, komponentenweise."""
        R = self.auflagerkraefte(u, lastvektor)
        F = onp.asarray(lastvektor).reshape(self.n_knoten, 3)
        summe_last = F.sum(axis=0)
        summe_lager = R.sum(axis=0)
        if self.gefedert.any():
            summe_lager = summe_lager + self.federkraefte(u).sum(axis=0)
        bezug = max(float(onp.abs(summe_last).max()), 1e-9)
        return {
            "last_kN": summe_last, "auflager_kN": summe_lager,
            "abweichung_kN": summe_last + summe_lager,
            "abweichung_rel": float(onp.abs(summe_last + summe_lager).max() / bezug),
        }


def kombiniere(loesungen: dict, faktoren: dict) -> onp.ndarray:
    """
    Überlagerung: Σ γ_i · u_i.

    Lastfälle ohne Faktor fehlen in der Kombination und werden übergangen;
    Faktoren ohne Lastfall sind ein Eingabefehler und werden es auch bleiben,
    deshalb fällt das hier nicht auf — die Prüfung gehört in `kombinationen()`.
    """
    ergebnis = None
    for name, faktor in faktoren.items():
        if name not in loesungen or faktor == 0.0:
            continue
        beitrag = faktor * loesungen[name]
        ergebnis = beitrag if ergebnis is None else ergebnis + beitrag
    if ergebnis is None:
        beliebig = next(iter(loesungen.values()))
        return onp.zeros_like(beliebig)
    return ergebnis
