"""
Volumenmodell aus Bauteilen: vernetzen, rechnen, als Punktwolke ausgeben.

`plate.py` rechnet Decken — eine Systemfläche, ein Werkstoff, Lasten von oben.
Dieses Modul rechnet **Bauteile**: einen Holzbalken, eine Stahlstütze, einen
Betonunterzug, und ebenso mehrere davon zusammen, wie sie im Bauwerk
aneinanderstoßen. Der Unterschied ist nicht die Größe, sondern woher die
Geometrie kommt: nicht aus einem gezeichneten Umriss, sondern aus dem IFC-
Modell, das ohnehin im Viewer liegt.

    ausgewählte Bauteile ──▶ Voxelnetz ──▶ Löser ──▶ Spannungsfeld ──▶ Punktwolke
       (IFC-Geometrie)      (ein Raster)   (JAX-FEM)   (je Element)     (PNTS)

## Warum Voxel und nicht Tetraeder

Ein Tetraedernetz bildet schräge Ränder sauber ab; ein Voxelnetz macht daraus
eine Treppe. Trotzdem sind hier Voxel richtig, aus drei Gründen:

1. **Mehrere Bauteile werden ohne Kontaktalgorithmus zu einem System.** Alle
   liegen auf *demselben* Raster, also fallen ihre Knoten an den Berührflächen
   von selbst zusammen. Ein Balken auf einer Stütze ist damit verbunden, ohne
   dass irgendwo eine Kopplungsbedingung formuliert werden müsste. Bei zwei
   unabhängig vernetzten Tetraedernetzen ist genau das der schwierige Teil.
2. **Der Löser steht schon.** `loeser.py` rechnet HEX8, und ein Voxel *ist*
   ein HEX8 — dazu noch ein perfekt geformter, was die Kondition der Matrix
   besser macht als jedes verzerrte Netz.
3. **Die Ausgabe ist eine Punktwolke.** Ein Ergebnis je Elementmitte auf einem
   regelmäßigen Raster ist genau das: eine Wolke mit gleichmäßiger Dichte.

Der Preis ist der Treppenrand. Er kostet Genauigkeit dort, wo die Geometrie
schräg ist, und er erzeugt an einspringenden Ecken Spannungsspitzen, die es im
Bauteil nicht gibt — beides steht in der Ergebnisbewertung (`guete()`) und
wird nicht verschwiegen.

## Was ein Bauteil hier ist

Ein `Bauteil` ist Geometrie plus Werkstoff plus Faserrichtung. Die Geometrie
kommt als Dreiecksnetz — so liefert IfcOpenShell sie, so liegt sie schon in
`tiling/section.py` vor, und ein Quader ist nur der einfachste Fall davon.

**Die Faserrichtung ist bei Holz keine Nebensache.** Längs zur Faser ist Holz
dreißigmal steifer als quer; wer sie falsch annimmt, rechnet ein anderes
Bauteil. Sie wird deshalb entweder angegeben oder aus der Gestalt bestimmt:
die längste Achse der Hüllbox ist bei einem Balken, einer Stütze und einem
Sparren die Faserrichtung. Bei einer Platte ist sie es nicht — dort meldet
`Bauteil.faserrichtung()` ihre Unsicherheit, statt zu raten.

## Einheiten

m, kN, kN/m² — wie im ganzen Paket. Nach außen (Wolke, Bericht) gehen
Spannungen in N/mm² und Verschiebungen in mm.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np

from . import werkstoff as wk

logger = logging.getLogger(__name__)

#: Standard-Kantenlänge der Voxel. 5 cm trifft bei einem Balken mit 24 cm Höhe
#: knapp fünf Lagen über den Querschnitt — die untere Grenze, ab der ein
#: Biegespannungsverlauf noch als Verlauf erkennbar ist und nicht als Stufe.
GROESSE_STANDARD = 0.05

#: Ab so vielen Elementen wird gewarnt: die Zerlegung braucht dann Minuten und
#: mehrere Gigabyte. Kein harter Abbruch — wer es will, soll es können.
ELEMENTE_WARNUNG = 400_000


# ──────────────────────────────────────────────────────────────────────────
# Bauteil
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class Bauteil:
    """
    Ein Bauteil des Volumenmodells: Gestalt, Werkstoff, Faserrichtung.

    `verts` (n,3) und `faces` (m,3) sind das Dreiecksnetz der Oberfläche im
    **tile-lokalen** System des Modells — demselben, in dem später die
    Punktwolke liegt. Wer die Umrechnung aus dem IFC vergisst, bekommt ein
    Ergebnis am richtigen Ort im falschen Koordinatensystem, und das fällt
    erst auf, wenn die Wolke einen Kilometer neben dem Haus schwebt.

    `faser` ist die Werkstoffachse 1. Ohne Angabe wird sie aus der Gestalt
    bestimmt — siehe `faserrichtung()`.
    """

    global_id: str
    name: str
    ifc_typ: str
    werkstoff: wk.Werkstoff
    verts: np.ndarray
    faces: np.ndarray
    faser: np.ndarray | None = None
    #: Frei belegbar — wandert unverändert in die Punktabfrage. Hier landet,
    #: was das IFC über das Bauteil weiß: Geschoss, Typ, Bemerkungen.
    merkmale: dict = field(default_factory=dict)

    def __post_init__(self):
        self.verts = np.asarray(self.verts, dtype=float).reshape(-1, 3)
        self.faces = np.asarray(self.faces, dtype=np.int64).reshape(-1, 3)
        if self.faser is not None:
            self.faser = np.asarray(self.faser, dtype=float).reshape(3)
        self.werkstoff = wk.werkstoff(self.werkstoff)

    @property
    def lo(self) -> np.ndarray:
        return self.verts.min(axis=0)

    @property
    def hi(self) -> np.ndarray:
        return self.verts.max(axis=0)

    @property
    def masse(self) -> np.ndarray:
        """Kantenlängen der Hüllbox."""
        return self.hi - self.lo

    def faserrichtung(self) -> tuple[np.ndarray, str]:
        """
        Die Werkstoffachse 1 und woher sie kommt.

        @returns (Einheitsvektor, Begründung)

        **Die längste Achse der Hüllbox** — für einen Balken, eine Stütze,
        einen Sparren, eine Pfette ist das die Faserrichtung, und diese vier
        sind praktisch alles, was aus Holz gerechnet wird. Die Regel greift
        allerdings nur, wenn es eine deutlich längste Achse *gibt*: bei einem
        quadratischen Plattenausschnitt wäre die Wahl beliebig und damit
        falsch. Ab einem Verhältnis von 1,5 zur zweitlängsten gilt sie als
        eindeutig; darunter wird die x-Achse genommen und der Zweifel
        vermerkt, damit er in der Ergebnisbewertung auftaucht statt
        unbemerkt zu bleiben.

        Für isotrope Stoffe ist die Achse ohne Wirkung — sie wird trotzdem
        bestimmt, weil die Auswertung sie als Bezugsrichtung für die
        Schnittgrößen braucht (Längs- gegen Querrichtung).
        """
        if self.faser is not None:
            richtung = self.faser / np.linalg.norm(self.faser)
            return richtung, "vorgegeben"

        masse = self.masse
        reihe = np.argsort(masse)[::-1]
        laengste, zweite = masse[reihe[0]], masse[reihe[1]]
        richtung = np.zeros(3)
        richtung[reihe[0]] = 1.0

        if zweite > 1e-9 and laengste / zweite >= 1.5:
            return richtung, (f"längste Achse der Hüllbox "
                              f"({'xyz'[reihe[0]]}, {laengste:.2f} m)")
        # Kein Stabtragwerk: die Wahl wäre beliebig, also wird sie benannt.
        return np.array([1.0, 0.0, 0.0]), (
            f"unsicher — Hüllbox {masse[0]:.2f} × {masse[1]:.2f} × {masse[2]:.2f} m "
            f"hat keine ausgeprägte Längsachse; x angenommen")

    @classmethod
    def quader(cls, global_id: str, name: str, ifc_typ: str, werkstoff_,
               lo, hi, **rest) -> "Bauteil":
        """
        Ein achsparalleler Quader — für Versuche, Tests und einfache Balken.

        Die zwölf Dreiecke werden ausgeschrieben statt aus einer Bibliothek
        geholt: das Modul soll ohne trimesh benutzbar sein, und ein Quader ist
        die Gestalt, mit der man einen FE-Kern gegen die Balkentheorie prüft.
        """
        lo, hi = np.asarray(lo, dtype=float), np.asarray(hi, dtype=float)
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        v = np.array([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
        f = np.array([[0, 2, 1], [0, 3, 2],      # unten
                      [4, 5, 6], [4, 6, 7],      # oben
                      [0, 1, 5], [0, 5, 4],      # vorn
                      [1, 2, 6], [1, 6, 5],      # rechts
                      [2, 3, 7], [2, 7, 6],      # hinten
                      [3, 0, 4], [3, 4, 7]])     # links
        return cls(global_id, name, ifc_typ, werkstoff_, v, f, **rest)


# ──────────────────────────────────────────────────────────────────────────
# Voxelisierung
# ──────────────────────────────────────────────────────────────────────────


def _innen(verts: np.ndarray, faces: np.ndarray, punkte: np.ndarray) -> np.ndarray:
    """
    Welche Punkte liegen im Körper? — Strahlverfahren nach oben.

    Für jeden Punkt zählt, wie viele Dreiecke der Hülle senkrecht über ihm
    liegen: eine ungerade Zahl heißt innen. Das ist der klassische
    Paritätstest, hier vektorisiert über alle Punkte und Dreiecke gleichzeitig.

    **Warum nicht `trimesh.contains`.** Das ruft ohne installiertes embree
    einen Python-Strahlschnitt je Punkt auf und braucht für hunderttausend
    Zellmittelpunkte Minuten. Hier ist es eine Handvoll Matrixoperationen,
    weil die Strahlrichtung fest ist: die Frage „liegt der Punkt in der
    xy-Projektion des Dreiecks" ist ein zweidimensionaler baryzentrischer
    Test, und das zugehörige z folgt aus der Ebenengleichung.

    **Die Kantenfalle.** Ein Punkt genau auf der gemeinsamen Kante zweier
    Dreiecke wird von beiden gezählt oder von keinem, und die Parität kippt
    ins Falsche. Bei IFC-Geometrie ist das kein Randfall, sondern der
    Normalfall: Bauteile sind achsparallel, das Raster ist es auch, und die
    Diagonale eines Rechtecks trifft die Mitte jeder zweiten Rasterzelle
    genau. Deshalb werden die Prüfpunkte hier — **in dieser Funktion**, nicht
    beim Aufrufer — um einen winzigen irrationalen Betrag verschoben. Ein
    Millionstel der Körperdiagonale ändert an der Zuordnung einer Zelle
    nichts und beseitigt den Fall vollständig; als Pflicht des Aufrufers wäre
    dieselbe Verschiebung ein Fehler, der beim nächsten neuen Aufrufer
    wiederkommt.

    Dreiecke, die in der Projektion zur Strecke entarten (senkrechte Wände),
    tragen nichts bei und werden vorher aussortiert — ihr Flächeninhalt in der
    Projektion ist null, sie können also gar nicht getroffen werden.
    """
    p = np.array(punkte, dtype=float, copy=True).reshape(-1, 3)
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]

    # Die irrationalen Faktoren sind √2/2, √3/3 und √5/5: kein Vielfaches
    # voneinander, keines ein glatter Bruchteil der Rasterweite.
    diagonale = float(np.linalg.norm(verts.max(axis=0) - verts.min(axis=0)))
    p += 1e-6 * max(diagonale, 1e-9) * np.array([0.70710678, 0.57735027, 0.44721360])

    # Zweifache projizierte Dreiecksfläche; das Vorzeichen ist die Orientierung.
    flaeche2 = ((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1])
                - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0]))
    lebt = np.abs(flaeche2) > 1e-14
    a, b, c, flaeche2 = a[lebt], b[lebt], c[lebt], flaeche2[lebt]
    if not len(a):
        return np.zeros(len(p), dtype=bool)

    treffer = np.zeros(len(p), dtype=np.int64)

    # In Blöcken über die Dreiecke: die Matrix (Punkte × Dreiecke) darf nicht
    # in den Speicher passen müssen. 2 Mio. Einträge je Block sind ein
    # Kompromiss aus Aufrufkosten und Speicher.
    block = max(1, int(2_000_000 / max(len(p), 1)))
    for s in range(0, len(a), block):
        a_, b_, c_, fl = a[s:s+block], b[s:s+block], c[s:s+block], flaeche2[s:s+block]

        # Baryzentrische Koordinaten in der xy-Projektion, mit dem Vorzeichen
        # der Fläche multipliziert — dann ist „innen" für beide
        # Orientierungen dasselbe Kriterium.
        vz = np.sign(fl)
        px, py = p[:, 0][:, None], p[:, 1][:, None]
        w_a = ((b_[:, 0] - px) * (c_[:, 1] - py) - (b_[:, 1] - py) * (c_[:, 0] - px)) * vz
        w_b = ((c_[:, 0] - px) * (a_[:, 1] - py) - (c_[:, 1] - py) * (a_[:, 0] - px)) * vz
        w_c = ((a_[:, 0] - px) * (b_[:, 1] - py) - (a_[:, 1] - py) * (b_[:, 0] - px)) * vz
        drin = (w_a > 0.0) & (w_b > 0.0) & (w_c > 0.0)
        if not drin.any():
            continue

        # z der Dreiecksebene über dem Punkt, baryzentrisch interpoliert.
        summe = np.abs(fl)
        z_tri = (w_a * a_[:, 2] + w_b * b_[:, 2] + w_c * c_[:, 2]) / summe
        treffer += (drin & (z_tri > p[:, 2][:, None])).sum(axis=1)

    return (treffer % 2) == 1


@dataclass
class Volumennetz:
    """
    Das gemeinsame Netz aller Bauteile.

    `material` und `bauteil` sind beide je Element und beide nötig: mehrere
    Bauteile können denselben Werkstoff haben (zwei Sparren aus C24), und
    dann ist der Materialindex nicht mehr die Bauteilzugehörigkeit. Die
    Steifigkeit richtet sich nach `material`, die Punktabfrage und der
    Nachweis nach `bauteil`.
    """

    points: np.ndarray            # (n,3)
    cells: np.ndarray             # (m,8) HEX8
    groesse: float
    material: np.ndarray          # (m,) Index in werkstoffe
    bauteil: np.ndarray           # (m,) Index in bauteile
    werkstoffe: list              # Werkstoff-Objekte, Reihenfolge = Index
    bauteile: list                # Bauteil-Objekte
    C_tabelle: np.ndarray         # (n_werkstoffe, 6, 6) in globalen Achsen
    hinweise: list = field(default_factory=list)

    @property
    def n_knoten(self) -> int:
        return len(self.points)

    @property
    def n_elemente(self) -> int:
        return len(self.cells)

    def mitten(self) -> np.ndarray:
        """Elementmittelpunkte (m,3) — die Orte der Ergebnispunkte."""
        return self.points[self.cells].mean(axis=1)

    def volumen(self) -> np.ndarray:
        """Elementvolumen (m,) — beim Voxelnetz überall gleich, aber explizit."""
        return np.full(self.n_elemente, self.groesse ** 3)

    def wichte(self) -> np.ndarray:
        """Wichte je Element in kN/m³, aus dem Werkstoff des Elements."""
        rho = np.array([w.rho_kNm3 for w in self.werkstoffe])
        return rho[self.material]

    def __repr__(self) -> str:
        return (f"<Volumennetz {self.n_knoten} Knoten, {self.n_elemente} HEX8, "
                f"h = {self.groesse:.3f} m, {len(self.bauteile)} Bauteil(e), "
                f"{len(self.werkstoffe)} Werkstoff(e)>")


def _werkstofftabelle(bauteile: list[Bauteil]) -> tuple[list, np.ndarray, list[int], list]:
    """
    Die Materialtabelle für den Löser und die Zuordnung Bauteil → Index.

    **Ein Werkstoff ist hier nicht dasselbe wie ein Baustoff.** Zwei Sparren
    aus demselben C24, aber quer zueinander eingebaut, haben verschiedene
    Steifigkeitsmatrizen — die Faserrichtung steckt in der gedrehten Matrix.
    Der Schlüssel ist deshalb das Paar aus Baustoff und Faserachse, auf drei
    Nachkommastellen gerundet: Achsen, die sich erst in der vierten Stelle
    unterscheiden, sind dieselbe Einbaulage und sollen nicht zwei Einträge
    erzeugen.

    Isotrope Stoffe kommen trotzdem nur einmal vor: ihre gedrehte Matrix ist
    die ungedrehte, und der Rundungsschlüssel würde sie sonst je nach
    Bauteilgestalt vervielfachen — ohne jeden Unterschied im Ergebnis.
    """
    tabelle: dict[tuple, int] = {}
    C_liste: list[np.ndarray] = []
    werkstoffe: list = []
    je_bauteil: list[int] = []
    hinweise: list = []

    for b in bauteile:
        richtung, grund = b.faserrichtung()
        b.faser_gewaehlt, b.faser_grund = richtung, grund
        if grund.startswith("unsicher") and not b.werkstoff.isotrop:
            hinweise.append(
                f"{b.name or b.global_id}: Faserrichtung {grund}. Bei "
                f"{b.werkstoff.name} bestimmt sie das Ergebnis — bitte prüfen.")

        if b.werkstoff.isotrop:
            schluessel = (b.werkstoff.name,)
        else:
            schluessel = (b.werkstoff.name, *np.round(richtung, 3))

        if schluessel not in tabelle:
            C = b.werkstoff.steifigkeit()
            if not b.werkstoff.isotrop:
                C = wk.drehen(C, richtung)
            tabelle[schluessel] = len(C_liste)
            C_liste.append(C)
            werkstoffe.append(b.werkstoff)
        je_bauteil.append(tabelle[schluessel])

    return werkstoffe, np.array(C_liste), je_bauteil, hinweise


def vernetze(bauteile: list[Bauteil], groesse: float = GROESSE_STANDARD,
             ursprung: np.ndarray | None = None) -> Volumennetz:
    """
    Alle Bauteile auf ein gemeinsames Voxelraster legen.

    @param groesse   Kantenlänge der Würfel in m
    @param ursprung  Rasterursprung; ohne Angabe an der Zellgröße ausgerichtet

    **Das Raster ist global, nicht je Bauteil.** Genau daraus entsteht die
    Verbindung: zwei Bauteile, die sich berühren, teilen an der Berührfläche
    dieselben Rasterknoten und sind damit im Gleichungssystem gekoppelt — ohne
    Kontaktbedingung, ohne Kopplungselemente, ohne dass irgendwo eine
    Verträglichkeitsgleichung formuliert werden müsste. Der Preis: die
    Verbindung ist *starr und voll*. Ein aufgelegter Balken, der sich vom
    Auflager abheben könnte, wird hier festgehalten; ein Zapfen überträgt
    Moment. Wo das nicht gilt, gehört die Verbindung getrennt modelliert —
    im Zweifel rechnet man die Bauteile einzeln.

    **Der Rasterursprung wird ausgerichtet, nicht auf die Ecke gelegt.** Läge
    er auf `lo` des ersten Bauteils, verschöbe sich das ganze Netz, sobald man
    ein weiteres Bauteil dazunimmt — und mit ihm jedes Ergebnis, jede
    Elementnummer, jeder Punkt der Wolke. Auf ein Vielfaches der Zellgröße
    gerundet bleibt das Netz dagegen dasselbe, egal welche Auswahl gerade
    gerechnet wird. Zwei Läufe sind damit vergleichbar.

    **Überlappende Bauteile.** Im IFC überlappen sich Bauteile regelmäßig —
    die Decke reicht in die Wand, die Stütze in den Unterzug. Eine Zelle kann
    aber nur einen Werkstoff haben. Sie fällt deshalb an das **zuerst
    genannte** Bauteil; die Menge wird gezählt und als Hinweis ausgegeben,
    denn bei einem Stahlträger im Beton entscheidet sie über das Ergebnis.
    """
    if not bauteile:
        raise ValueError("Ohne Bauteile gibt es nichts zu vernetzen.")
    h = float(groesse)
    if h <= 0:
        raise ValueError("Die Zellgröße muss positiv sein.")

    werkstoffe, C_tabelle, material_je_bauteil, hinweise = _werkstofftabelle(bauteile)

    lo_alle = np.min([b.lo for b in bauteile], axis=0)
    hi_alle = np.max([b.hi for b in bauteile], axis=0)
    if ursprung is None:
        ursprung = np.floor(lo_alle / h) * h
    ursprung = np.asarray(ursprung, dtype=float)

    # Rastergröße über alles — nur als Bezugssystem für die linearen Indizes,
    # es wird nie ein Feld dieser Größe angelegt.
    n = np.maximum(np.ceil((hi_alle - ursprung) / h).astype(np.int64) + 1, 1)
    nx, ny, nz = (int(v) for v in n)

    belegt_lin: list[np.ndarray] = []
    belegt_bauteil: list[np.ndarray] = []

    for index, b in enumerate(bauteile):
        # Nur die eigene Hüllbox prüfen. Über das Gesamtraster zu laufen wäre
        # bei einem Balken in einem Gebäudemodell ein Vielfaches an Arbeit für
        # dasselbe Ergebnis.
        i0 = np.floor((b.lo - ursprung) / h).astype(np.int64)
        i1 = np.ceil((b.hi - ursprung) / h).astype(np.int64) + 1
        i0 = np.maximum(i0, 0)
        i1 = np.minimum(i1, [nx, ny, nz])
        if np.any(i1 <= i0):
            hinweise.append(f"{b.name or b.global_id}: keine Zelle im Raster — "
                            f"Bauteil kleiner als die Zellgröße {h:.3f} m?")
            continue

        gi, gj, gk = (np.arange(i0[d], i1[d]) for d in range(3))
        mitten = np.stack(np.meshgrid(
            ursprung[0] + (gi + 0.5) * h,
            ursprung[1] + (gj + 0.5) * h,
            ursprung[2] + (gk + 0.5) * h, indexing="ij"), axis=-1).reshape(-1, 3)

        drin = _innen(b.verts, b.faces, mitten)
        if not drin.any():
            hinweise.append(
                f"{b.name or b.global_id}: keine Zellmitte im Körper. Bei einer "
                f"Wandstärke unter {h:.2f} m ist das zu erwarten — kleinere "
                f"Zellgröße wählen.")
            continue

        II, JJ, KK = np.meshgrid(gi, gj, gk, indexing="ij")
        lin = ((II * ny + JJ) * nz + KK).reshape(-1)[drin]
        belegt_lin.append(lin)
        belegt_bauteil.append(np.full(len(lin), index, dtype=np.int32))

    if not belegt_lin:
        raise ValueError(
            f"Kein einziges Element entstanden. Die Zellgröße von {h:.3f} m ist "
            f"für diese Bauteile zu grob.")

    lin = np.concatenate(belegt_lin)
    zu_bauteil = np.concatenate(belegt_bauteil)

    # Überlappungen: `np.unique` behält den ersten Treffer je Zelle, und die
    # Reihenfolge ist die der Bauteilliste — damit gilt „das zuerst genannte
    # Bauteil gewinnt" ohne weitere Sortierung.
    einmalig, erste = np.unique(lin, return_index=True)
    doppelt = len(lin) - len(einmalig)
    if doppelt:
        hinweise.append(
            f"{doppelt} Zellen liegen in mehr als einem Bauteil "
            f"({doppelt * h**3:.3f} m³). Sie wurden dem jeweils zuerst "
            f"genannten zugeordnet.")
    lin, zu_bauteil = einmalig, zu_bauteil[erste]

    # Zellindex zurückrechnen und die acht Eckknoten je Zelle bilden.
    ci = lin // (ny * nz)
    cj = (lin // nz) % ny
    ck = lin % nz

    def knoten(di, dj, dk):
        return (((ci + di) * (ny + 1) + (cj + dj)) * (nz + 1) + (ck + dk))

    # HEX8 in meshio-Reihenfolge: unten gegen den Uhrzeigersinn, dann oben.
    ecken = np.stack([
        knoten(0, 0, 0), knoten(1, 0, 0), knoten(1, 1, 0), knoten(0, 1, 0),
        knoten(0, 0, 1), knoten(1, 0, 1), knoten(1, 1, 1), knoten(0, 1, 1),
    ], axis=1)

    verwendet = np.unique(ecken)
    cells = np.searchsorted(verwendet, ecken).astype(np.int32)

    ki = verwendet // ((ny + 1) * (nz + 1))
    kj = (verwendet // (nz + 1)) % (ny + 1)
    kk = verwendet % (nz + 1)
    points = ursprung + np.stack([ki, kj, kk], axis=1) * h

    material = np.array([material_je_bauteil[b] for b in zu_bauteil], dtype=np.int32)

    if len(cells) > ELEMENTE_WARNUNG:
        hinweise.append(
            f"{len(cells)} Elemente — die Zerlegung braucht dafür mehrere "
            f"Gigabyte und einige Minuten. Gröberes Raster erwägen.")

    netz = Volumennetz(points=points, cells=cells, groesse=h,
                       material=material, bauteil=zu_bauteil,
                       werkstoffe=werkstoffe, bauteile=bauteile,
                       C_tabelle=C_tabelle, hinweise=hinweise)
    logger.info("Volumennetz: %s", netz)
    return netz


def zusammenhang(netz: Volumennetz) -> tuple[int, np.ndarray]:
    """
    In wie viele voneinander unabhängige Teile zerfällt das Netz?

    @returns (Anzahl der Teile, Zugehörigkeit je Element)

    **Die Frage muss vor dem Lösen gestellt werden.** Wer im Viewer zwei
    Bauteile anklickt, die sich nicht berühren, bekommt zwei Systeme in einer
    Gleichung. Ist nur eines gelagert, ist die Matrix singulär — und der
    Löser meldet das nicht als „Ihre Auswahl hängt nicht zusammen", sondern
    als Zahlensalat oder gar nicht. Hier ist es eine Zeile aus scipy und eine
    verständliche Meldung.

    Verbunden heißt: ein gemeinsamer Knoten. Zwei Voxel, die sich nur an einer
    Kante oder Ecke berühren, gelten damit als verbunden — mechanisch ist das
    ein Gelenk und keine Verbindung, aber es hält das System zusammen, und
    genau darum geht es an dieser Stelle.
    """
    import scipy.sparse
    import scipy.sparse.csgraph

    m, k = netz.cells.shape
    zeilen = np.repeat(np.arange(m), k)
    graph = scipy.sparse.coo_array(
        (np.ones(m * k, dtype=np.int8), (zeilen, netz.cells.reshape(-1))),
        shape=(m, netz.n_knoten)).tocsr()
    # Elemente × Elemente über gemeinsame Knoten. Das Produkt ist bei einem
    # Voxelnetz dünn besetzt (höchstens 26 Nachbarn je Element).
    nachbarn = graph @ graph.T
    anzahl, teil = scipy.sparse.csgraph.connected_components(
        nachbarn, directed=False)
    return int(anzahl), teil


# ──────────────────────────────────────────────────────────────────────────
# Auflager
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class Auflager:
    """
    Ein gehaltener Bereich des Netzes.

    `typ` kennt zwei Stufen, und mehr braucht ein Volumenmodell auch nicht:

    | typ | gehalten | Bedeutung |
    |---|---|---|
    | `fest`     | u_x, u_y, u_z | Fußpunkt, Einspannung, angeschweißt |
    | `gelenkig` | u_z           | aufgelegt — waagerecht frei verschieblich |

    **Warum das gelenkige Lager nur die Senkung hält** — dieselbe Überlegung
    wie in `plate.randbedingungen()`: hielte man an der Auflagerlinie auch
    u_x und u_y, könnte sich der Balken unter Last nicht mehr längen und
    trüge einen Teil der Last als Druckbogen ab. Die Durchbiegung fiele
    deutlich zu klein aus. Ein aufgelegter Träger ist waagerecht frei.

    Der Bereich ist eine Box in Weltkoordinaten. Sie darf großzügig sein: was
    außerhalb des Netzes liegt, hält nichts.
    """

    lo: np.ndarray
    hi: np.ndarray
    typ: str = "gelenkig"
    name: str = ""

    def __post_init__(self):
        self.lo = np.asarray(self.lo, dtype=float).reshape(3)
        self.hi = np.asarray(self.hi, dtype=float).reshape(3)
        if self.typ not in ("fest", "gelenkig"):
            raise ValueError(f"Lagertyp '{self.typ}': nur 'fest' oder 'gelenkig'.")

    def knoten(self, points: np.ndarray, toleranz: float = 1e-9) -> np.ndarray:
        return np.all((points >= self.lo - toleranz) & (points <= self.hi + toleranz), axis=1)


def auflager_automatisch(netz: Volumennetz, hoehe: float | None = None) -> list[Auflager]:
    """
    Lager dort annehmen, wo das System auf dem Rest des Bauwerks steht.

    Zwei Fälle, in dieser Reihenfolge geprüft:

    1. **Es gibt Fußpunkte.** Die unterste Knotenlage des Netzes wird
       gehalten — das ist der Stützenfuß, die Wandunterkante, die
       Auflagerbank. Fest, nicht gelenkig: eine Stütze, die im Fundament
       steckt, verschiebt sich dort auch waagerecht nicht.

    2. **Das System ist ein liegendes Bauteil.** Dann liegt es an seinen
       Enden auf, und gelagert wird die unterste Knotenlage in einem Streifen
       von einer Zellbreite an jedem Ende der längsten Achse.

    **Die Unterscheidung fällt über den belegten Boden, nicht über die
    Schlankheit.** Der naheliegende Weg — „ist das Netz höher als breit, dann
    steht es" — greift bei beiden Fällen daneben, die man wirklich hat: ein
    Balken 20/50 ist höher als das Doppelte seiner Breite und liegt trotzdem,
    und ein Geschossausschnitt aus zwei Wänden und einer Decke ist viel
    breiter als hoch und steht trotzdem auf den Wandfüßen.

    Entschieden wird deshalb an der Frage: **wie viel der Grundfläche ist
    ganz unten überhaupt belegt?** Bei einem liegenden Balken jede Spalte —
    er hat unten so viel Fläche wie oben. Bei einem Geschossausschnitt nur
    die Spalten über den Wänden und Stützen, also ein Bruchteil; darüber ist
    Luft, und die Decke schwebt erst weiter oben. Liegt dieser Anteil unter
    der Hälfte, steht das System auf Fußpunkten. Dazu kommt der einfache
    Fall der einzelnen Stütze: ist die **längste** Achse die Hochachse, steht
    sie, auch wenn ihr Fuß die ganze Grundfläche einnimmt.

    **Das aufgelegte Lager ist genau eine Knotenreihe breit — und das ist
    keine Sparsamkeit, sondern der Kern der Sache.** Eine breitere
    Auflagerfläche wirkt am Volumenmodell nicht wie ein größeres Lager,
    sondern wie eine Teileinspannung: die gehaltene Unterkante muss über die
    ganze Lagerlänge gerade bleiben, und der Querschnitt kann sich dort nicht
    mehr verdrehen. Am Einfeldträger 5,0 m mit 20/40 cm gemessen:

    | Lagerbreite | Durchbiegung | Feldmoment |
    |---|---|---|
    | eine Knotenreihe | 100 % | 98 % |
    | 5 cm  | 79 % | 82 % |
    | 10 cm | 58 % | 65 % |
    | 20 cm | 32 % | 43 % |

    Zehn Zentimeter Auflagerbreite — bei 5 m Spannweite eine
    Selbstverständlichkeit auf dem Papier — kosten also ein Drittel des
    Feldmoments. Der Fehler liegt dabei auf der **unsicheren** Seite und
    sieht dabei völlig unauffällig aus: die Biegelinie ist glatt, das
    Gleichgewicht stimmt, die Auflagerkräfte stimmen. Nur das Ergebnis ist
    falsch. Wer eine echte Auflagerbank abbilden will, braucht ein zweites
    Bauteil darunter, nicht ein breiteres Dirichlet-Lager.

    **Das ist eine Annahme und ersetzt keine Lagerung.** Sie trifft den Fall,
    für den dieses Werkzeug gedacht ist — ein Bauteil aus dem Modell schnell
    nachrechnen —, und sie steht im Bericht, damit sie widersprochen werden
    kann. Wer es genauer braucht, gibt `Auflager` selbst an.
    """
    lo, hi = netz.points.min(axis=0), netz.points.max(axis=0)
    h = netz.groesse
    z_unten = float(lo[2])
    schicht = hoehe if hoehe is not None else h * 0.5

    mitten = netz.mitten()
    # Spaltenschlüssel wie in `flaechenlast()`: `floor` und nicht `round`,
    # sonst fallen die Spalten 1 und 2 zusammen.
    spalte = np.floor(mitten[:, :2] / h).astype(np.int64)
    spalte = spalte[:, 0] * 1_000_003 + spalte[:, 1]

    # Je Spalte die tiefste Zelle; belegt der Fuß sie, steht dort etwas.
    reihe = np.lexsort((mitten[:, 2], spalte))
    erste = np.concatenate(([True], np.diff(spalte[reihe]) != 0))
    unterste_z = mitten[reihe[erste], 2]
    anteil = float(np.mean(unterste_z <= z_unten + h))

    laengste_ist_hoch = int(np.argmax(hi - lo)) == 2
    steht = laengste_ist_hoch or anteil < 0.5

    if steht:
        grund = ("die längste Achse ist die Hochachse" if laengste_ist_hoch
                 else f"nur {anteil * 100:.0f} % der Grundfläche sind unten belegt")
        return [Auflager(lo=[lo[0] - 1.0, lo[1] - 1.0, z_unten - 1e-6],
                         hi=[hi[0] + 1.0, hi[1] + 1.0, z_unten + schicht],
                         typ="fest", name=f"Fußpunkte ({grund})")]

    achse = int(np.argmax(hi - lo))
    # Knapp unter der halben Zellgröße: das trifft die äußerste Knotenreihe
    # und die nächste sicher nicht mehr.
    saum = h * 0.4
    lager = []
    for seite, name in ((0, "Auflager A"), (1, "Auflager B")):
        a_lo = np.array([lo[0] - 1.0, lo[1] - 1.0, z_unten - 1e-6])
        a_hi = np.array([hi[0] + 1.0, hi[1] + 1.0, z_unten + schicht])
        if seite == 0:
            a_hi[achse] = lo[achse] + saum
        else:
            a_lo[achse] = hi[achse] - saum
        lager.append(Auflager(lo=a_lo, hi=a_hi, typ="gelenkig", name=name))
    return lager


def randbedingungen(netz: Volumennetz, auflager: list[Auflager]):
    """
    Die Auflager in `dirichlet_bc_info` für JAX-FEM übersetzen.

    @returns (bc_info, Protokoll)

    **Über den Knotenindex, nicht über den Ort.** JAX-FEM ruft die
    Ortsfunktion mit `(punkt, index)`, wenn sie zwei Argumente nimmt. Damit
    wird aus der Frage „liegt dieser Punkt im Lagerbereich" ein Nachschlagen
    in einer fertigen Maske — statt eines Abstandsvergleichs gegen alle
    Lagerknoten, der bei zehntausend gehaltenen Knoten quadratisch wird.

    **Die Starrkörpersicherung.** Halten alle Lager nur u_z, bleiben
    Verschiebung in x und y und die Drehung um die Hochachse frei; die Matrix
    ist singulär, und der Löser liefert Unsinn statt einer Fehlermeldung.
    Gesperrt werden deshalb drei zusätzliche Freiheitsgrade nach der
    3-2-1-Regel: an einem Lagerknoten u_x und u_y, an dem davon am weitesten
    entfernten Lagerknoten die Komponente quer zur Verbindungslinie. Diese
    drei Bindungen halten das System, ohne es zu behindern — ihre
    Zwangskräfte sind null, was die Auflagerprobe bestätigt.
    """
    import jax.numpy as jnp

    n = netz.n_knoten
    fest = np.zeros(n, dtype=bool)
    nur_z = np.zeros(n, dtype=bool)
    protokoll = {"lager": []}

    for a in auflager:
        treffer = a.knoten(netz.points)
        if a.typ == "fest":
            fest |= treffer
        else:
            nur_z |= treffer
        protokoll["lager"].append(
            {"name": a.name, "typ": a.typ, "knoten": int(treffer.sum()),
             "lo": [round(float(v), 3) for v in a.lo],
             "hi": [round(float(v), 3) for v in a.hi]})

    nur_z &= ~fest
    if not fest.any() and not nur_z.any():
        raise ValueError(
            "Kein einziger Knoten wird gehalten — die Auflagerbereiche liegen "
            "neben dem Netz. Ohne Lagerung ist das System nicht lösbar.")

    einzeln_x = np.zeros(n, dtype=bool)
    einzeln_y = np.zeros(n, dtype=bool)
    if not fest.any():
        kandidaten = np.flatnonzero(nur_z)
        xy = netz.points[kandidaten, :2]
        erster = int(kandidaten[np.lexsort((xy[:, 1], xy[:, 0]))[0]])
        abstand = np.linalg.norm(netz.points[kandidaten, :2] - netz.points[erster, :2], axis=1)
        zweiter = int(kandidaten[int(np.argmax(abstand))])
        einzeln_x[erster] = einzeln_y[erster] = True
        richtung = np.abs(netz.points[zweiter, :2] - netz.points[erster, :2])
        if richtung[0] >= richtung[1]:
            einzeln_y[zweiter] = True
        else:
            einzeln_x[zweiter] = True
        protokoll["starrkoerper"] = {"knoten_a": erster, "knoten_b": zweiter}

    def macher(maske):
        feld = jnp.asarray(maske)

        def ort(punkt, index):
            return feld[index]
        return ort

    def null(_punkt):
        return 0.0

    orte, richtungen, werte = [], [], []
    if fest.any():
        for k in range(3):
            orte.append(macher(fest)); richtungen.append(k); werte.append(null)
    if nur_z.any():
        orte.append(macher(nur_z)); richtungen.append(2); werte.append(null)
    for maske, k in ((einzeln_x, 0), (einzeln_y, 1)):
        if maske.any():
            orte.append(macher(maske)); richtungen.append(k); werte.append(null)

    protokoll["fest"] = int(fest.sum())
    protokoll["gelenkig"] = int(nur_z.sum())
    return [orte, richtungen, werte], protokoll


# ──────────────────────────────────────────────────────────────────────────
# Lasten
# ──────────────────────────────────────────────────────────────────────────


def eigengewicht(netz: Volumennetz) -> np.ndarray:
    """Volumenkraftfeld des Eigengewichts, (m,3) in kN/m³ — je Element sein Stoff."""
    f = np.zeros((netz.n_elemente, 3))
    f[:, 2] = -netz.wichte()
    return f


def flaechenlast(netz: Volumennetz, q_kNm2: float,
                 bauteile: list[int] | None = None) -> np.ndarray:
    """
    Eine Flächenlast von oben, verteilt auf die oberste Elementlage.

    @param q_kNm2   Last je m² Grundfläche (positiv = nach unten)
    @param bauteile Indizes der belasteten Bauteile; None = alle

    **Warum als Volumenkraft und nicht als Randlast.** Dieselbe Überlegung wie
    in `loeser.py`: eine Neumann-Randbedingung verlangt, die Oberfläche zu
    finden, und der Treppenrand eines Voxelnetzes ist genau die Stelle, an der
    eine Flächensuche unauffällig danebengreift. Die oberste Zelle jedes
    (x,y)-Stapels bekommt stattdessen q/h als Volumenkraft — die Resultierende
    ist dieselbe, die Spannungsverteilung unterscheidet sich nur innerhalb
    dieser einen Zelle.

    **Die Last folgt der Gestalt, nicht der Hüllbox.** Bei einem Satteldach
    liegt „oben" für jede Stapelspalte woanders. Deshalb wird je (x,y)-Spalte
    das oberste Element gesucht und nicht eine gemeinsame Höhe angenommen.
    """
    mitten = netz.mitten()
    h = netz.groesse
    f = np.zeros((netz.n_elemente, 3))

    auswahl = np.ones(netz.n_elemente, dtype=bool)
    if bauteile is not None:
        auswahl = np.isin(netz.bauteil, np.asarray(bauteile))
    if not auswahl.any():
        return f

    # Spaltenschlüssel aus dem xy-Rasterindex: alle Elemente einer senkrechten
    # Säule bekommen denselben. `floor` und nicht `round` — eine Zellmitte
    # liegt bei (i + ½)·h, und `np.round` rundet die halbe Zahl zur *geraden*
    # hin: die Spalten 1 und 2 bekämen denselben Schlüssel, und jede zweite
    # Säule verlöre ihre Last.
    schluessel = np.floor(mitten[:, :2] / h).astype(np.int64)
    schluessel = schluessel[:, 0] * 1_000_003 + schluessel[:, 1]

    index = np.flatnonzero(auswahl)
    # Nach Spalte, dann nach Höhe sortieren; das letzte Element je Spalte ist
    # das oberste.
    reihe = index[np.lexsort((mitten[index, 2], schluessel[index]))]
    letzte = np.flatnonzero(np.diff(schluessel[reihe], append=schluessel[reihe][-1] + 1))
    oben = reihe[letzte]

    f[oben, 2] = -float(q_kNm2) / h
    return f


def einzellast(netz: Volumennetz, F_kN, ort) -> np.ndarray:
    """
    Eine Einzellast, auf die Elemente im Umkreis einer Zellgröße verteilt.

    Eine echte Punktlast gibt es im Kontinuum nicht — sie erzeugt eine
    unendliche Spannung, und im diskreten Modell eine, die allein von der
    Netzweite abhängt. Verteilt wird deshalb über eine Kugel vom Radius einer
    Zellgröße; das entspricht der Lasteinleitungsfläche, die eine
    Auflagerplatte in Wirklichkeit hat.
    """
    F = np.asarray(F_kN, dtype=float).reshape(3)
    ort = np.asarray(ort, dtype=float).reshape(3)
    mitten = netz.mitten()
    nahe = np.linalg.norm(mitten - ort, axis=1) <= netz.groesse
    f = np.zeros((netz.n_elemente, 3))
    if not nahe.any():
        # Nichts getroffen: die nächste Zelle nehmen, statt die Last zu verlieren.
        nahe = np.zeros(netz.n_elemente, dtype=bool)
        nahe[int(np.argmin(np.linalg.norm(mitten - ort, axis=1)))] = True
    volumen_ = float(nahe.sum()) * netz.groesse ** 3
    f[nahe] = F / volumen_
    return f


# ──────────────────────────────────────────────────────────────────────────
# Lastfälle und Kombinationen
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class Lastfall:
    """
    Eine Einwirkung als Volumenkraftfeld, (m,3) in kN/m³.

    `art` entscheidet über die Beiwerte: `staendig` bekommt γ_G = 1,35 und
    geht voll in jede Kombination ein, `veraenderlich` bekommt γ_Q = 1,5 und
    im Gebrauchszustand seinen ψ-Anteil.
    """

    name: str
    art: str                       # staendig | veraenderlich
    feld: np.ndarray
    psi_0: float = 0.7
    psi_1: float = 0.5
    psi_2: float = 0.3

    def __post_init__(self):
        self.feld = np.asarray(self.feld, dtype=float).reshape(-1, 3)
        if self.art not in ("staendig", "veraenderlich"):
            raise ValueError(f"Lastart '{self.art}': staendig oder veraenderlich.")


def kombinationen(lastfaelle: list[Lastfall]) -> dict[str, dict[str, float]]:
    """
    Die drei Kombinationen, die ein Bauteilnachweis braucht.

        GZT       Σ 1,35·G + 1,5·Q            Tragfähigkeit
        selten    Σ G + Q                     charakteristisch
        quasi     Σ G + ψ₂·Q                  Durchbiegung, Langzeit

    Bewusst ohne die Feinheiten, die `plate.kombinationen()` führt — kein
    Wechsel der Leiteinwirkung, keine ungünstige Laststellung, kein
    γ_G,inf = 1,0 für den abhebenden Fall. Ein einzelnes Bauteil mit ein bis
    zwei Einwirkungen braucht das nicht, und eine Kombinatorik, die niemand
    liest, ist keine Sicherheit, sondern eine Fehlerquelle. Wer mehrere
    veränderliche Einwirkungen gegeneinander stellen will, rechnet die
    Lastfälle einzeln und überlagert selbst — dafür ist der Löser gebaut.
    """
    gzt, selten, quasi = {}, {}, {}
    for lf in lastfaelle:
        if lf.art == "staendig":
            gzt[lf.name], selten[lf.name], quasi[lf.name] = 1.35, 1.0, 1.0
        else:
            gzt[lf.name], selten[lf.name], quasi[lf.name] = 1.5, 1.0, lf.psi_2
    return {"GZT": gzt, "selten": selten, "quasi-ständig": quasi}


# ──────────────────────────────────────────────────────────────────────────
# Auswertung
# ──────────────────────────────────────────────────────────────────────────

#: Eckenvorzeichen des HEX8 in meshio-Reihenfolge. Dieselbe Konstante wie in
#: `plate._ECKEN`; sie steht hier noch einmal, weil `volumen.py` ohne das
#: Plattenmodell benutzbar bleiben soll — ein Import nur für acht Vorzeichen
#: würde `plate` samt Bemessungskette in jeden Bauteilnachweis ziehen.
_ECKEN = np.array([[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
                   [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], dtype=float)


def verzerrungen(netz: Volumennetz, u: np.ndarray) -> np.ndarray:
    """
    Verzerrungstensor im Mittelpunkt jedes Elements — (m,3,3).

    Der Mittelpunkt ist beim trilinearen Ansatz der genaueste Ort: dort liegt
    der Barlow-Punkt, an dem die Verzerrung des Ansatzes mit der wirklichen
    übereinstimmt, während sie an den Elementrändern zu steif ist.

    Materialfrei — deshalb steht sie getrennt von `spannungen()`. Bei einem
    Netz aus mehreren Werkstoffen ist die Verzerrung stetig über die Fuge, die
    Spannung springt; die Trennung macht das im Code sichtbar.
    """
    x = netz.points[netz.cells]                        # (m,8,3)
    uu = np.asarray(u).reshape(-1, 3)[netz.cells]      # (m,8,3)

    dN = _ECKEN / 8.0
    jacobi = np.einsum("ij,nid->njd", dN, x)
    dNdx = np.einsum("ij,ndj->nid", dN, np.linalg.inv(jacobi))

    grad = np.einsum("nia,nib->nab", uu, dNdx)
    return 0.5 * (grad + np.transpose(grad, (0, 2, 1)))


def spannungen(netz: Volumennetz, u: np.ndarray) -> np.ndarray:
    """
    Spannungen im Mittelpunkt jedes Elements, Voigt (m,6) in kN/m².

    σ = C_e · ε_e mit der Matrix des Elements — nicht mit einer mittleren.
    An der Fuge zwischen zwei Werkstoffen ist das der ganze Punkt: dieselbe
    Verzerrung ergibt im Stahl die siebenfache Spannung wie im Beton daneben,
    und genau diese Sprungstelle ist das, was man sehen will.
    """
    eps = verzerrungen(netz, u)
    voigt = np.stack([eps[:, 0, 0], eps[:, 1, 1], eps[:, 2, 2],
                      2.0 * eps[:, 1, 2], 2.0 * eps[:, 0, 2], 2.0 * eps[:, 0, 1]], axis=1)
    C = netz.C_tabelle[netz.material]                  # (m,6,6)
    return np.einsum("nij,nj->ni", C, voigt)


def ausnutzung(netz: Volumennetz, sigma: np.ndarray) -> dict:
    """
    Ausnutzung je Element — jedes Bauteil nach den Regeln seines Werkstoffs.

    @returns {"eta": (m,), "teil": {Name: (m,)}, "je_bauteil": [...]}

    Bauteilweise ausgewertet und nicht in einem Rutsch, weil der Nachweis vom
    Werkstoff abhängt und beim Holz zusätzlich von der Faserrichtung. Die
    Teilnachweise werden über alle Bauteile hinweg zusammengeführt; wo ein
    Nachweis für ein Bauteil nicht gilt (Rollschub im Stahlträger), steht
    dort null statt einer Zahl, die etwas anderes bedeutet.
    """
    eta = np.zeros(netz.n_elemente)
    teile: dict[str, np.ndarray] = {}
    je_bauteil = []

    for index, b in enumerate(netz.bauteile):
        maske = netz.bauteil == index
        if not maske.any():
            continue
        richtung = getattr(b, "faser_gewaehlt", None)
        if richtung is None:
            richtung, _ = b.faserrichtung()
        ergebnis = wk.ausnutzung(b.werkstoff, sigma[maske], achse_1=richtung)
        eta[maske] = ergebnis["eta"]
        for name, werte in ergebnis["teil"].items():
            if name not in teile:
                teile[name] = np.zeros(netz.n_elemente)
            teile[name][maske] = werte
        # Maßgebend ist der Teilnachweis, der η **erzeugt** hat — nicht der
        # größte überhaupt. Beim Beton ist der Rissnachweis regelmäßig der
        # größte Wert und trotzdem kein Versagen; ihn hier zu nennen hieße,
        # eine Zahl mit dem Namen einer anderen zu beschriften.
        bestimmend = ergebnis.get("bestimmend") or list(ergebnis["teil"])
        eintrag = {
            "bauteil": b.global_id, "name": b.name, "werkstoff": b.werkstoff.name,
            "familie": b.werkstoff.familie,
            "eta_max": float(ergebnis["eta"].max()),
            "eta_p98": float(np.percentile(ergebnis["eta"], 98)),
            "elemente": int(maske.sum()),
            "massgebend": max(bestimmend,
                              key=lambda k: float(ergebnis["teil"][k].max())),
        }
        # Was daneben steht und nicht in η eingeht, aber gesagt werden muss:
        # beim Beton, wo die Hauptzugspannung die Zugfestigkeit übersteigt,
        # reißt der Querschnitt und braucht Bewehrung.
        for name in ergebnis["teil"]:
            if name not in bestimmend:
                eintrag[f"eta_{name}"] = float(ergebnis["teil"][name].max())
        je_bauteil.append(eintrag)

    return {"eta": eta, "teil": teile, "je_bauteil": je_bauteil}


#: Die 2×2×2-Gauß-Punkte des Einheitswürfels. Dieselben, mit denen JAX-FEM
#: die Steifigkeitsmatrix integriert — die Auswertung fragt damit das Element
#: genau dort, wo es rechnet.
_GAUSS = 1.0 / np.sqrt(3.0)
_GAUSSPUNKTE = np.array([[i, j, k] for i in (-_GAUSS, _GAUSS)
                         for j in (-_GAUSS, _GAUSS)
                         for k in (-_GAUSS, _GAUSS)])


def spannungen_quad(netz: Volumennetz, u: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Spannungen und Orte an den acht Gauß-Punkten je Element.

    @returns (Orte (m,8,3), Spannungen Voigt (m,8,6))

    **Warum es diese zweite Auswertung neben `spannungen()` gibt.** Für ein
    Bild genügt ein Wert je Element — die Elementmitte ist dafür der beste
    Ort (Barlow-Punkt). Für ein *Integral* genügt sie nicht: die
    Mittelpunktsregel unterschlägt bei einem über die Höhe veränderlichen
    Spannungsverlauf den Anteil h²/12 je Zelle, und beim Biegemoment summiert
    sich das auf einen systematischen Fehler von (Δ/H)² — am Kragarm mit
    sechs Lagen über die Höhe gemessene 6,5 %, alle in dieselbe Richtung:
    **das Moment kommt zu klein heraus.** Für ein Bild ist das gleichgültig,
    für einen Nachweis nicht.

    Mit den beiden Gauß-Punkten je Richtung ist die Integration dagegen
    exakt: der Verschiebungsansatz ist trilinear, die Spannung damit linear,
    der Integrand von M quadratisch — und die 2-Punkt-Gauß-Formel integriert
    Polynome bis zum dritten Grad exakt. Der Fehler verschwindet nicht
    näherungsweise, sondern vollständig.
    """
    x = netz.points[netz.cells]                          # (m,8,3)
    uu = np.asarray(u).reshape(-1, 3)[netz.cells]        # (m,8,3)

    # Formfunktionen und ihre Ableitungen an den Gauß-Punkten:
    #   N_i(ξ) = ⅛ ∏_d (1 + ξ_d·e_id)
    xi = _GAUSSPUNKTE                                    # (8,3) Auswertepunkte
    e = _ECKEN                                           # (8,3) Eckenvorzeichen
    # (q, i): Wert der Formfunktion i am Punkt q
    N = np.prod(1.0 + xi[:, None, :] * e[None, :, :], axis=2) / 8.0
    # (q, i, d): ∂N_i/∂ξ_d am Punkt q
    dN = np.empty((len(xi), 8, 3))
    for d in range(3):
        andere = [k for k in range(3) if k != d]
        dN[:, :, d] = (e[None, :, d]
                       * np.prod(1.0 + xi[:, None, andere] * e[None, :, andere], axis=2)) / 8.0

    jacobi = np.einsum("qid,nie->nqde", dN, x)           # (m,q,3,3)
    dNdx = np.einsum("qid,nqde->nqie", dN, np.linalg.inv(jacobi))
    grad = np.einsum("nia,nqib->nqab", uu, dNdx)         # (m,q,3,3)
    eps = 0.5 * (grad + np.swapaxes(grad, -1, -2))

    voigt = np.stack([eps[..., 0, 0], eps[..., 1, 1], eps[..., 2, 2],
                      2.0 * eps[..., 1, 2], 2.0 * eps[..., 0, 2],
                      2.0 * eps[..., 0, 1]], axis=-1)    # (m,q,6)
    C = netz.C_tabelle[netz.material]                    # (m,6,6)
    sigma = np.einsum("nij,nqj->nqi", C, voigt)
    orte = np.einsum("qi,nid->nqd", N, x)                # (m,q,3)
    return orte, sigma


def schnittgroessen(netz: Volumennetz, u: np.ndarray, bauteil: int = 0,
                    achse: np.ndarray | None = None) -> dict:
    """
    Schnittgrößen entlang der Bauteilachse — aus dem Spannungsfeld integriert.

    @returns dict mit `s` (Stationen), `N`, `V`, `M`, `z_s`, `A` je Station

    **Warum das der wichtigste Teil der Auswertung ist.** Ein Spannungsbild
    ist anschaulich, aber es ist keine Größe, mit der man nachweist. Jede Norm
    des Hochbaus — EC2 für den Betonbalken, EC5 für den Holzbalken, EC3 für
    den Stahlträger — rechnet mit N, V und M. Dieselbe Integration, die
    `unterzug.schnittgroessen()` für einen Unterzug in der Decke leistet, ist
    hier die Brücke vom Kontinuum zurück zum Stabwerk:

        N   = ∫ σ_ll dA
        z_s = ∫ z dA / ∫ dA                  Schwerpunkt der Schnittfläche
        M   = −∫ σ_ll · (z − z_s) dA
        V   = ∫ τ_lz dA

    Das ist die Definition der Schnittgrößen, keine Näherung — und weil sie
    aus dem *gerechneten* Spannungsfeld kommt, enthält sie alles, was das
    Volumenmodell mehr weiß als ein Stabwerk: die Lasteinleitung, die
    Auflagerbreite, die Aussparung, die Kerbe.

    **Die Probe steckt im Verfahren.** Der Verlauf von M über die Länge muss
    die zweifache Stammfunktion der Last sein; wer M und V nebeneinander
    aufträgt, sieht sofort, ob die Rechnung stimmt — V ist die Ableitung von
    M. Diese Kontrolle ist mit einem Spannungsbild allein nicht zu haben.

    Ausgewertet wird in einem gedrehten System: `l` ist die Bauteilachse, `z`
    die Hochachse, `q` die dritte. Bei einem schräg im Grundriss liegenden
    Träger ist das nicht die x-Achse — und die Momentenlinie um die falsche
    Achse ist eine falsche Momentenlinie.

    **Bei flächigen Bauteilen ist das Ergebnis keine Stabgröße.** Eine Wand
    hat keine Achse, sondern zwei; ihre Tragrichtung ist die Vertikale, nicht
    die längste Kante. Was die Integration dort liefert, ist die Resultierende
    über den ganzen Querschnitt senkrecht zur *längsten* Kante — eine
    richtige Zahl zu einer Frage, die niemand gestellt hat. `gestalt`
    unterscheidet deshalb `stabartig` von `flaechig`, und wo `flaechig` steht,
    gehört die Bemessung zur Platte (`plate.py`) und nicht hierher. Die
    Spannungen und die Ausnutzung bleiben davon unberührt — die gelten
    punktweise und brauchen keine Achse.
    """
    b = netz.bauteile[bauteil]
    if achse is None:
        achse = getattr(b, "faser_gewaehlt", None)
        if achse is None:
            achse, _ = b.faserrichtung()
    achse = np.asarray(achse, dtype=float)
    achse = achse / np.linalg.norm(achse)

    # Das lokale System: l = Achse, z bleibt die Hochachse (soweit möglich),
    # q steht auf beiden senkrecht. Bei einer senkrechten Stütze fällt l mit z
    # zusammen; dann wird x als Querachse genommen.
    hoch = np.array([0.0, 0.0, 1.0])
    if abs(float(achse @ hoch)) > 0.95:
        hoch = np.array([1.0, 0.0, 0.0])
    q_achse = np.cross(hoch, achse)
    q_achse /= np.linalg.norm(q_achse)
    z_achse = np.cross(achse, q_achse)

    maske = netz.bauteil == bauteil
    h = netz.groesse
    orte, sigma = spannungen_quad(netz, u)
    orte, sigma = orte[maske], sigma[maske]
    n_zellen = len(orte)

    # Jeder Gauß-Punkt trägt h²/8 bei: die Zelle bringt die Querschnittsfläche
    # h² ein, und alle acht Punkte werden zu **einer** Station zusammengefasst
    # (siehe unten), also zwei Ebenen zu je vier Punkten.
    dA = h * h / 8.0

    T = wk.als_tensor(sigma.reshape(-1, 6))
    s_ll = np.einsum("i,nij,j->n", achse, T, achse).reshape(n_zellen, 8)
    t_lz = np.einsum("i,nij,j->n", achse, T, z_achse).reshape(n_zellen, 8)

    l = orte @ achse                                  # (m,8)
    z = orte @ z_achse

    # **Eine Station je Zellreihe, über beide Gauß-Ebenen gemittelt.** Die
    # Versuchung, jede der beiden Ebenen als eigene Station zu führen, ist
    # groß — doppelt so viele Stützstellen für dieselbe Rechnung. Sie ist
    # falsch, und zwar aus demselben Grund, aus dem HEX8 unter Biegung
    # versteift: die parasitäre Schubverzerrung wechselt zwischen den beiden
    # Ebenen das Vorzeichen. Einzeln ausgewertet ergibt das eine Querkraft,
    # die zwischen +4 und −25 kN springt, wo −10 stehen müsste; über beide
    # Ebenen gemittelt hebt sie sich auf und die Querkraft stimmt. Das ist
    # dieselbe Eigenschaft, die die Elementmitte zum Barlow-Punkt macht.
    #
    # Für M und N gilt das nicht — dort bringen die Gauß-Punkte den exakten
    # Hebelarm über den Querschnitt, den die Elementmitte nicht hat. Die
    # Zusammenfassung kostet dort nichts, weil der Mittelwert zweier
    # symmetrisch liegender Punkte der Wert in der Mitte ist.
    l_zelle = l.mean(axis=1)
    stufe = np.round((l_zelle - l_zelle.min()) / h).astype(np.int64)
    schluessel = np.repeat(stufe, 8)
    s_ll, t_lz = s_ll.reshape(-1), t_lz.reshape(-1)
    l, z = l.reshape(-1), z.reshape(-1)

    s_werte, N, M, V, z_s, A = [], [], [], [], [], []
    for st in np.unique(schluessel):
        hier = schluessel == st
        flaeche = float(hier.sum()) * dA
        # Der Schwerpunkt aus denselben Gauß-Gewichten wie das Integral —
        # sonst bezieht sich das Moment auf eine andere Achse, als die
        # Integration verwendet, und N ≠ 0 verfälscht M.
        schwer = float(z[hier].mean())
        s_werte.append(float(l[hier].mean()))
        A.append(flaeche); z_s.append(schwer)
        N.append(float(s_ll[hier].sum() * dA))
        M.append(float(-(s_ll[hier] * (z[hier] - schwer)).sum() * dA))
        V.append(float(t_lz[hier].sum() * dA))

    s_werte = np.array(s_werte)
    s_werte -= s_werte.min()

    # Stabartig oder flächig? Über das Verhältnis der beiden größten
    # Hüllboxkanten: bei einem Balken ist die zweitlängste ein Bruchteil der
    # längsten, bei einer Wand oder Platte liegen beide in derselben
    # Größenordnung.
    kanten = np.sort(b.masse)[::-1]
    schlank = float(kanten[1] / max(kanten[0], 1e-9))
    gestalt = "flaechig" if schlank > 0.35 else "stabartig"

    return {"s": s_werte, "N": np.array(N), "M": np.array(M),
            "V": np.array(V), "z_s": np.array(z_s), "A": np.array(A),
            "achse": achse, "z_achse": z_achse, "q_achse": q_achse,
            "gestalt": gestalt, "schlankheit": round(schlank, 3),
            "laenge": float(l.max() - l.min()) + h / np.sqrt(3.0)}


# ──────────────────────────────────────────────────────────────────────────
# Die Rechnung
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class Ergebnis:
    """
    Was eine Volumenrechnung hinterlässt.

    `u` und `sigma` stehen je Kombination, nicht nur für die maßgebende: die
    Durchbiegung wird quasi-ständig beurteilt, die Spannung im GZT, und beide
    kommen aus derselben Zerlegung. Sie wegzuwerfen und später neu zu rechnen
    wäre der teuerste Teil noch einmal.
    """

    netz: Volumennetz
    lastfaelle: list[Lastfall]
    u_lastfall: dict[str, np.ndarray]
    u: dict[str, np.ndarray]                 # je Kombination
    sigma: dict[str, np.ndarray]             # je Kombination, (m,6)
    eta: dict                                # Ausnutzung im GZT
    proben: dict                             # Gleichgewicht je Lastfall
    lager: dict                              # Protokoll der Randbedingungen
    hinweise: list

    def durchbiegung_mm(self, kombination: str = "quasi-ständig") -> np.ndarray:
        """Senkung je Knoten in mm, positiv nach unten."""
        return -self.u[kombination][:, 2] * 1000.0

    def kennwerte(self) -> dict:
        """Die Zahlen, die in die Übersicht gehören."""
        w = self.durchbiegung_mm()
        sig = self.sigma["GZT"]
        return {
            "elemente": self.netz.n_elemente,
            "knoten": self.netz.n_knoten,
            "elementgroesse_m": self.netz.groesse,
            "w_max_mm": float(w.max()),
            "w_max_mm_gzt": float(self.durchbiegung_mm("GZT").max()),
            "eta_max": float(self.eta["eta"].max()),
            "eta_p98": float(np.percentile(self.eta["eta"], 98)),
            "sigma_v_max_MNm2": float(wk.vergleichsspannung(sig).max() / wk.MPA),
            "je_bauteil": self.eta["je_bauteil"],
            "gleichgewicht_rel": max(float(p["abweichung_rel"]) for p in self.proben.values()),
        }


def rechne(bauteile: list[Bauteil] | Volumennetz,
           lastfaelle: list[Lastfall] | None = None,
           auflager: list[Auflager] | None = None,
           groesse: float = GROESSE_STANDARD,
           nutzlast_kNm2: float | None = None,
           psi_2: float = 0.3) -> Ergebnis:
    """
    Bauteile vernetzen, lagern, belasten, lösen und auswerten.

    @param bauteile      Liste von `Bauteil` oder ein fertiges `Volumennetz`
    @param lastfaelle    ohne Angabe: Eigengewicht, dazu `nutzlast_kNm2` von oben
    @param auflager      ohne Angabe: `auflager_automatisch()`
    @param groesse       Voxelkantenlänge in m
    @param nutzlast_kNm2 bequemer Weg zu einer veränderlichen Flächenlast

    Der Ablauf ist der von `rechnung.py`, nur ohne Bemessungskette: **einmal
    zerlegen, alle Lastfälle lösen, danach überlagern**. Bei drei
    Kombinationen ist das der Unterschied zwischen einer Zerlegung und dreien
    — und die Zerlegung ist bei einem Volumennetz alles, was Zeit kostet.

    Die Gleichgewichtsprobe läuft für **jeden** Lastfall und nicht nur für die
    maßgebende Kombination. Sie kostet eine Matrixmultiplikation und ist die
    schärfste Kontrolle, die eine FE-Rechnung zulässt: die Summe der
    Auflagerkräfte muss die aufgebrachte Last sein. Ein Voxelnetz, dem beim
    Vernetzen Zellen verlorengingen, fällt hier auf und sonst nirgends.
    """
    from .loeser import Loeser, kombiniere

    netz = bauteile if isinstance(bauteile, Volumennetz) else vernetze(bauteile, groesse)
    hinweise = list(netz.hinweise)

    teile, _ = zusammenhang(netz)
    if teile > 1:
        hinweise.append(
            f"Die Auswahl zerfällt in {teile} Teile, die sich nicht berühren. "
            f"Jeder Teil braucht eine eigene Lagerung, sonst ist das System "
            f"nicht lösbar.")

    if lastfaelle is None:
        lastfaelle = [Lastfall("Eigengewicht", "staendig", eigengewicht(netz))]
        if nutzlast_kNm2:
            lastfaelle.append(Lastfall("Nutzlast", "veraenderlich",
                                       flaechenlast(netz, nutzlast_kNm2), psi_2=psi_2))

    if auflager is None:
        auflager = auflager_automatisch(netz)
    bc_info, lager = randbedingungen(netz, auflager)

    loeser = Loeser(netz, bc_info=bc_info,
                    C_tabelle=netz.C_tabelle, material=netz.material)

    u_lastfall, vektoren, proben = {}, {}, {}
    for lf in lastfaelle:
        vektoren[lf.name] = loeser.lastvektor(lf.feld)
        u_lastfall[lf.name] = loeser.loese(lastvektor=vektoren[lf.name])
        probe = loeser.probe(u_lastfall[lf.name], vektoren[lf.name])
        proben[lf.name] = {k: (v.tolist() if hasattr(v, "tolist") else v)
                           for k, v in probe.items()}
        if probe["abweichung_rel"] > 1e-6:
            hinweise.append(
                f"Lastfall {lf.name}: Auflagerkräfte weichen um "
                f"{probe['abweichung_rel']:.2e} von der Last ab.")

    kombis = kombinationen(lastfaelle)
    u = {name: kombiniere(u_lastfall, faktoren) for name, faktoren in kombis.items()}
    sigma = {name: spannungen(netz, feld) for name, feld in u.items()}
    eta = ausnutzung(netz, sigma["GZT"])

    ergebnis = Ergebnis(netz=netz, lastfaelle=lastfaelle, u_lastfall=u_lastfall,
                        u=u, sigma=sigma, eta=eta, proben=proben,
                        lager=lager, hinweise=hinweise)
    logger.info("Volumenrechnung fertig: %s Elemente, η_max = %.2f, w_max = %.2f mm",
                netz.n_elemente, eta["eta"].max(), ergebnis.durchbiegung_mm().max())
    return ergebnis
