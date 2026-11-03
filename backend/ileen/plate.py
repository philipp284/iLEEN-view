"""
Plattenberechnung aus einem iLEEN-Positionsplan.

Der Weg vom gezeichneten Grundriss zur Lösung in vier Schritten:

1. `lade()`      — JSON einlesen und auf Vollständigkeit prüfen
2. `vernetze()`  — Systemumriss in ein HEX8-Netz überführen
3. `kombinationen()` / `lastfeld()` — Einwirkungen zu Bemessungslasten kombinieren
4. `randbedingungen()` — Auflager in Dirichlet-Bedingungen übersetzen

**Warum ein 3D-Solid und keine Plattentheorie.** JAX-FEM bringt keine
Kirchhoff- oder Reissner-Mindlin-Elemente mit; die vorhandenen Notebooks
(`Flachdecke.ipynb`) rechnen Decken deshalb als dreidimensionalen Körper aus
HEX8-Elementen. Dieses Modul bleibt bei derselben Wahl: es ist ohne eigene
Elementformulierung auskömmlich, liefert Spannungen direkt und ist bei zwei bis
vier Lagen über die Dicke für eine Vorbemessung genau genug. Der Preis ist die
Größe des Gleichungssystems — bei feinen Netzen ist das spürbar.

**Einheiten.** Wie in der Exportdatei und in den bestehenden Notebooks:
Längen in m, Kräfte in kN, daraus E und Spannungen in kN/m². Eine Umrechnung
findet hier nicht statt; das Frontend liefert E bereits in kN/m².

**Unterzüge und Überzüge.** `vernetze()` bildet sie geometrisch ab: die
Rasterspalten im Balkenstreifen bekommen zusätzliche Elementlagen nach unten
(Unterzug) oder oben (Überzug), mit derselben Lagenhöhe wie die Grundplatte.
Damit stehen sie im Gleichungssystem und versteifen die Decke richtig —
Durchbiegung, Lastabtrag und Auflagerkräfte stimmen ohne weiteres Zutun.

Die **Auswertung** dieses Moduls hört an ihrer Grenze auf. `schnittgroessen()`
und `querkraefte()` liefern Größen „je Meter Plattenbreite", und die ist im
Steg keine sinnvolle Bezugsgröße: der Querschnitt ist dort ein Plattenbalken
mit eigenem Schwerpunkt und eigenem Trägheitsmoment. Beide setzen deshalb im
Balkenstreifen **NaN** und geben die Maske als `im_balken` mit heraus; die
richtige Auswertung — Integration über den ganzen Querschnitt und Bemessung
als Plattenbalken — steht in `unterzug.py`.

NaN ist ansteckend (`np.max`, `np.percentile` und `np.argmax` geben es weiter),
und ein einzelnes NaN machte aus der Bewehrung der ganzen Decke NaN. Alle
Auswertungen hier sind deshalb NaN-tolerant; `hoechstwert()` ist der Helfer
dafür, `balkenmaske()` die Grenze zwischen beiden Zuständigkeiten.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

SCHEMA = "ileen.plan.fem/1.0"


# ──────────────────────────────────────────────────────────────────────────
# Einlesen
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class Modell:
    """Der Inhalt der Exportdatei, mit bequemen Zugriffen."""

    daten: dict
    quelle: Path | None = None
    warnungen: list[str] = field(default_factory=list)

    # -- Kopfdaten ------------------------------------------------------

    @property
    def titel(self) -> str:
        return self.daten.get("plan", {}).get("titel", "Zeichnung")

    @property
    def job_id(self) -> str | None:
        return self.daten.get("plan", {}).get("job_id")

    @property
    def system(self) -> list[dict]:
        return self.daten.get("system", [])

    @property
    def lasten(self) -> list[dict]:
        return self.daten.get("lasten", [])

    @property
    def auflager(self) -> list[dict]:
        return self.daten.get("auflager", [])

    @property
    def balken(self) -> list[dict]:
        return self.daten.get("unterzuege", [])

    @property
    def lastfaelle(self) -> list[dict]:
        return self.daten.get("lastfaelle", [])

    @property
    def positionen(self) -> list[dict]:
        return self.daten.get("positionen", [])

    def lastfall(self, kennung: str) -> dict:
        for fall in self.lastfaelle:
            if fall["id"] == kennung:
                return fall
        # Ein Lastfall ohne Eintrag darf die Rechnung nicht kippen: er wird als
        # veränderliche Einwirkung mit den Regelbeiwerten behandelt und
        # vermerkt, damit es im Protokoll auffällt.
        self.warnungen.append(f"Lastfall '{kennung}' ist im Export nicht beschrieben — γ = 1,5 angenommen")
        return {"id": kennung, "name": kennung, "art": "Q", "gamma": 1.5, "psi0": 0.7, "psi2": 0.3}

    def platte(self, kennung: str | None = None) -> dict:
        """Die zu rechnende Systemfläche — ohne Angabe die größte."""
        if not self.system:
            raise ValueError(
                "Der Export enthält keine Systemfläche. Im Zeichenmodus mit dem "
                "Werkzeug „⬠\" den Umriss der Platte festlegen und neu exportieren."
            )
        if kennung is not None:
            for eintrag in self.system:
                if eintrag["id"] == kennung:
                    return eintrag
            raise KeyError(f"Systemfläche '{kennung}' gibt es nicht: {[s['id'] for s in self.system]}")
        return max(self.system, key=lambda s: s.get("flaeche_m2", 0.0))

    def bericht(self) -> str:
        """Kurzfassung für den Kopf eines Notebooks."""
        platte = self.platte()
        # Die Lastfallzeile wird außerhalb des f-Strings gebaut: Python 3.10
        # erlaubt in einem f-String keine Anführungszeichen derselben Sorte,
        # und das Zielenv (environment.yml) führt genau 3.10.
        faelle = ", ".join("{0} ({1})".format(f["id"], f["art"]) for f in self.lastfaelle)
        zeilen = [
            f"{self.titel}",
            f"  Systemflächen : {len(self.system)}  (gerechnet: {platte['id']}, "
            f"{platte['flaeche_m2']:.1f} m², d = {platte['dicke_m'] * 100:.0f} cm, "
            f"{platte['material']['name']})",
            f"  Lastfälle     : {faelle or '—'}",
            f"  Lasten        : {len(self.lasten)}",
            f"  Auflager      : {len(self.auflager)}",
            f"  Positionen    : {len(self.positionen)}",
        ]
        for hinweis in self.daten.get("hinweise", []) + self.warnungen:
            zeilen.append(f"  ! {hinweis}")
        return "\n".join(zeilen)


def lade(pfad: str | Path) -> Modell:
    """Liest eine Exportdatei und prüft ihr Schema."""
    pfad = Path(pfad)
    daten = json.loads(pfad.read_text(encoding="utf-8"))

    gefunden = daten.get("schema", "")
    if not gefunden.startswith("ileen.plan.fem/"):
        raise ValueError(f"'{pfad.name}' ist kein iLEEN-Statikexport (schema = {gefunden!r})")
    if gefunden != SCHEMA:
        # Nur eine Warnung: die Nebenversion darf Felder ergänzen, ohne dass
        # dieses Modul seine Arbeit einstellt.
        print(f"Hinweis: Datei trägt {gefunden}, dieses Modul kennt {SCHEMA}.")

    modell = Modell(daten=daten, quelle=pfad)
    if not daten.get("auflager"):
        modell.warnungen.append("Keine Auflager im Export — das System wäre kinematisch")
    return modell


# ──────────────────────────────────────────────────────────────────────────
# Geometrie
# ──────────────────────────────────────────────────────────────────────────


def _ring(umriss: list) -> np.ndarray:
    """Polygon als (n, 2)-Array ohne doppelten Schlusspunkt."""
    punkte = np.asarray(umriss, dtype=float)
    if len(punkte) > 2 and np.allclose(punkte[0], punkte[-1]):
        punkte = punkte[:-1]
    return punkte


def innen(punkte_xy: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    """
    Punkt-in-Polygon für viele Punkte auf einmal (Strahlverfahren).

    Vektorisiert über Punkte *und* Kanten, weil daraus sowohl die Netzmaske als
    auch die Lastverteilung entstehen — bei zehntausend Elementen und ein paar
    hundert Kanten wäre eine Python-Schleife der langsamste Teil des ganzen
    Ablaufs.
    """
    x = punkte_xy[:, 0][:, None]
    y = punkte_xy[:, 1][:, None]
    x1, y1 = polygon[:, 0][None, :], polygon[:, 1][None, :]
    x2, y2 = np.roll(polygon[:, 0], -1)[None, :], np.roll(polygon[:, 1], -1)[None, :]

    dy = y2 - y1
    # Waagerechte Kanten liefern keine Kreuzung; der Ersatznenner verhindert
    # nur die Division durch null, sein Wert geht nicht ins Ergebnis ein.
    sicher = np.where(np.abs(dy) < 1e-15, 1.0, dy)
    schneidet = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / sicher + x1)
    return (schneidet.sum(axis=1) % 2) == 1


def abstand_zu_polylinie(punkte_xy: np.ndarray, linie: np.ndarray) -> np.ndarray:
    """Kürzester Abstand jedes Punktes zu einem Streckenzug."""
    beste = np.full(len(punkte_xy), np.inf)
    # `errstate`, weil die BLAS-Implementierung von `matmul` auf manchen
    # Rechnern Fließkomma-Flags aus ihren SIMD-Registern meldet, die mit den
    # übergebenen Zahlen nichts zu tun haben. Die Warnungen sind falsch, aber
    # sie stehen sonst in jeder Notebook-Ausgabe und lassen eine saubere
    # Rechnung fehlerhaft aussehen.
    with np.errstate(all="ignore"):
        for i in range(len(linie) - 1):
            a, b = linie[i], linie[i + 1]
            richtung = b - a
            laenge2 = float(richtung @ richtung)
            if laenge2 < 1e-18:
                beste = np.minimum(beste, np.linalg.norm(punkte_xy - a, axis=1))
                continue
            t = np.clip(((punkte_xy - a) @ richtung) / laenge2, 0.0, 1.0)
            fuss = a + t[:, None] * richtung
            beste = np.minimum(beste, np.linalg.norm(punkte_xy - fuss, axis=1))
    return beste


def flaeche(polygon: np.ndarray) -> float:
    ring = _ring(polygon)
    x, y = ring[:, 0], ring[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2)


# ──────────────────────────────────────────────────────────────────────────
# Vernetzung
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class Netz:
    points: np.ndarray          # (n, 3) Knoten
    cells: np.ndarray           # (m, 8) HEX8, meshio-Reihenfolge
    dicke: float
    polygon: np.ndarray         # Systemumriss in der Ebene
    groesse: float              # tatsächliche Elementgröße in der Ebene
    verfahren: str
    n_lagen: int = 2            # Elementlagen über die *Grundplattendicke*
    balken_spalten: np.ndarray | None = None  # (m,) bool je Element: Teil eines Unterzugs/Überzugs
    #: (m,) Wichte je Element in kN/m³, `None` = überall die der Platte. Die
    #: Stegzellen eines Unterzugs bekommen das Gewicht des wahren Stegs über
    #: ihr Netzvolumen verteilt: das Netz bildet den Steg mit ganzen
    #: Zellbreiten und -lagen ab, sein Gewicht soll trotzdem das des Bauteils
    #: sein. Absolut und nicht als Beiwert auf die Plattenwichte — eine
    #: Ersatzplatte kann die Wichte null haben, ein Holzunterzug darunter
    #: wiegt trotzdem (Lucy: ein Beiwert auf null verlor ihn still).
    eg_wichte: np.ndarray | None = None
    #: (m,) Index des Unterzugs (in `modell.balken`) je Stegzelle, −1 für die
    #: Zellen der Platte selbst — für eine Rippe mit eigenem Werkstoff.
    balken_zelle: np.ndarray | None = None
    #: Unterzug-Index → Verhältnis wahre zu abgebildeter Grundfläche des Stegs
    #: (Stegbreite × Länge gegen die Zellen im Netz). Kleiner als 1, wo das Netz
    #: gröber ist als der Steg.
    balken_flaechenanteil: dict = field(default_factory=dict)
    #: Öffnungen: Treppenauge, Schächte, Aussparungen. Echte Löcher im Netz,
    #: keine abgeminderte Steifigkeit — eine Decke mit einem Treppenauge
    #: spannt dort nicht, und ein Ersatzmodell mit weichem Material spannt
    #: doch, nur schlechter.
    loecher: list[np.ndarray] = field(default_factory=list)
    #: Drehung des Rasters gegen die Weltachsen [rad] (`hauptrichtung()`). Die
    #: Knoten stehen in Weltkoordinaten; nur wer nach Rasterspalten fragt
    #: (`lagerknoten()`), rechnet über `lokal()` im gedrehten System.
    drehung: float = 0.0

    def lokal(self, xy: np.ndarray) -> np.ndarray:
        """Weltkoordinaten (n, 2) ins System des Rasters."""
        xy = np.asarray(xy, dtype=float)
        if not self.drehung:
            return xy
        c, s = np.cos(self.drehung), np.sin(self.drehung)
        return np.stack([c * xy[..., 0] + s * xy[..., 1],
                         -s * xy[..., 0] + c * xy[..., 1]], axis=-1)

    def auf_platte(self, punkte: np.ndarray) -> np.ndarray:
        """
        Liegen diese Punkte auf tragender Deckenfläche?

        Innerhalb des Umrisses **und** außerhalb jeder Öffnung. Die eine
        Stelle, an der das entschieden wird: es gibt ein halbes Dutzend
        Aufrufer — Linienlasten, Einzellasten, die Rasterdarstellung, die
        Maskierung der Karten —, und ein vergessener davon setzt eine Last ins
        Treppenauge, wo keine Fläche ist.
        """
        drin = innen(np.asarray(punkte, dtype=float), self.polygon)
        for loch in self.loecher:
            drin &= ~innen(np.asarray(punkte, dtype=float), loch)
        return drin

    @property
    def n_knoten(self) -> int:
        return len(self.points)

    @property
    def n_elemente(self) -> int:
        return len(self.cells)

    def __repr__(self) -> str:
        return (f"<Netz {self.verfahren}: {self.n_knoten} Knoten, {self.n_elemente} HEX8, "
                f"Δ ≈ {self.groesse:.3f} m, d = {self.dicke:.3f} m>")


#: Rang der Rasterlinien, wenn zwei näher als der Fangabstand beieinander
#: liegen: der Rand gewinnt (sonst fehlte ein Streifen Fläche, und die Bilanz
#: ginge nicht auf), dann das Lager, dann die Unterzugflanke.
_RANG_HUELLE, _RANG_RAND, _RANG_LAGER, _RANG_BALKEN = 4, 3, 2, 1


def _achsparallel(a, b, toleranz: float = 0.01):
    """0 für eine Strecke parallel zu x, 1 parallel zu y, sonst None."""
    d = np.asarray(b, dtype=float) - np.asarray(a, dtype=float)
    laenge = float(np.hypot(d[0], d[1]))
    if laenge < 1e-9:
        return None
    if abs(d[1]) <= toleranz * laenge:
        return 0
    if abs(d[0]) <= toleranz * laenge:
        return 1
    return None


def hauptrichtung(modell: Modell, polygon: np.ndarray) -> float:
    """
    Die Richtung, in der das Raster liegt [rad], zwischen −45° und +45°.

    **Reale Modelle liegen gedreht.** Das Projektsystem eines IFC folgt dem
    Lageplan, nicht dem Gebäude (EFH Weihgold: 33°). Ein Raster entlang der
    Weltachsen hätte dann keine einzige Lagerlinie: jede Wand würde eine
    Zickzackreihe von Knoten beiderseits ihrer Achse, die Decke hinge dort
    halb eingespannt, und der Rand wäre eine Treppe. Am Prüfhaus H1, um 33°
    gedreht, kam so die halbe Durchbiegung heraus.

    Gezählt werden die Kanten des Umrisses und die Lagerachsen, gewichtet mit
    ihrer Länge und gefaltet auf 90° (vierfacher Winkel): eine Wand in x und
    eine in y zeigen in dieselbe Rasterrichtung. Ohne deutliche Vorzugsrichtung
    (Kreis, Vieleck) bleibt es bei den Weltachsen.
    """
    strecken = []
    ring = np.asarray(polygon, dtype=float)
    strecken.extend(zip(ring, np.roll(ring, -1, axis=0)))
    for lager in modell.auflager:
        zug = np.asarray(lager.get("polylinie") or [], dtype=float)
        if len(zug) >= 2:
            strecken.extend(zip(zug[:-1, :2], zug[1:, :2]))
    c = s = gewicht = 0.0
    for a, b in strecken:
        d = np.asarray(b, dtype=float)[:2] - np.asarray(a, dtype=float)[:2]
        laenge = float(np.hypot(d[0], d[1]))
        if laenge < 1e-6:
            continue
        winkel = 4.0 * float(np.arctan2(d[1], d[0]))
        c += laenge * np.cos(winkel)
        s += laenge * np.sin(winkel)
        gewicht += laenge
    if gewicht <= 0.0 or np.hypot(c, s) < 0.3 * gewicht:
        return 0.0
    drehung = float(np.arctan2(s, c)) / 4.0
    # Unter einem Hundertstelgrad ist es Rundung: drehen hieße, ein gerades
    # Raster gegen ein fast gerades zu tauschen.
    return 0.0 if abs(np.degrees(drehung)) < 0.01 else drehung


def _gedreht(modell: Modell, drehung: float) -> Modell:
    """Eine Kopie mit Lagern und Unterzügen im System des Rasters — nur für
    `_rasterlinien()`, das nach achsparallelen Strecken fragt."""
    if not drehung:
        return modell
    c, s = np.cos(drehung), np.sin(drehung)

    def lokal(p):
        return [c * p[0] + s * p[1], -s * p[0] + c * p[1]]

    daten = dict(modell.daten)
    daten["auflager"] = [
        {**a, **({"p": lokal(a["p"])} if a.get("p") is not None else {}),
         **({"polylinie": [lokal(p) for p in a["polylinie"]]} if a.get("polylinie") else {})}
        for a in modell.auflager]
    daten["unterzuege"] = [
        {**b, "polylinie": [lokal(p) for p in b.get("polylinie") or []]}
        for b in modell.balken]
    return Modell(daten=daten, quelle=modell.quelle)


def _rasterlinien(modell: Modell, polygon: np.ndarray, loecher: list, ziel: float):
    """
    Die Koordinaten der Rasterlinien in x und in y.

    Zwangslinien liegen auf allem, was eine Knotenreihe braucht: achsparallele
    Kanten von Umriss und Öffnungen (die Fläche ist dann exakt), achsparallele
    Lagerachsen und Punktlager (das Lager hält genau eine Reihe, auf seiner
    Achse) und die Flanken achsparalleler Unterzüge (der Steg hat seine wahre
    Breite). Liegen zwei näher als der Fangabstand beieinander, bleibt die mit
    dem höheren Rang. Dazwischen wird gleichmäßig aufgefüllt, keine Zelle
    breiter als `ziel`.

    Schräge Lager und Ränder bekommen keine Linie: für sie sucht
    `lagerknoten()` je Rasterspalte den nächsten Knoten.
    """
    fang = max(0.02, 0.05 * ziel)
    kandidaten: tuple[list, list] = ([], [])
    lo = polygon.min(axis=0)
    hi = polygon.max(axis=0)
    for achse in (0, 1):
        kandidaten[achse].extend([(float(lo[achse]), _RANG_HUELLE),
                                  (float(hi[achse]), _RANG_HUELLE)])

    def kanten(ring, rang):
        ring = np.asarray(ring, dtype=float)
        for a, b in zip(ring, np.roll(ring, -1, axis=0)):
            richtung = _achsparallel(a, b)
            if richtung is not None:
                quer = 1 - richtung
                kandidaten[quer].append((0.5 * float(a[quer] + b[quer]), rang))

    def strecken(zug):
        zug = np.asarray(zug, dtype=float)
        return list(zip(zug[:-1], zug[1:]))

    kanten(polygon, _RANG_RAND)
    for loch in loecher:
        kanten(loch, _RANG_RAND)
    for lager in modell.auflager:
        if lager.get("typ") == "punkt":
            p = lager.get("p")
            if p is not None:
                kandidaten[0].append((float(p[0]), _RANG_LAGER))
                kandidaten[1].append((float(p[1]), _RANG_LAGER))
            continue
        for a, b in strecken(lager.get("polylinie") or []):
            richtung = _achsparallel(a, b)
            if richtung is not None:
                quer = 1 - richtung
                kandidaten[quer].append((0.5 * float(a[quer] + b[quer]), _RANG_LAGER))
    for balken in modell.balken:
        halb = 0.5 * float(balken.get("breite_m") or 0.0)
        for a, b in strecken(balken.get("polylinie") or []):
            richtung = _achsparallel(a, b)
            if richtung is not None and halb > 0:
                quer = 1 - richtung
                mitte = 0.5 * float(a[quer] + b[quer])
                kandidaten[quer].extend([(mitte - halb, _RANG_BALKEN),
                                         (mitte + halb, _RANG_BALKEN)])

    linien = []
    for achse in (0, 1):
        werte = sorted((w, r) for w, r in kandidaten[achse]
                       if lo[achse] - 1e-9 <= w <= hi[achse] + 1e-9)
        gruppen: list[list] = []
        for wert, rang in werte:
            if gruppen and wert - gruppen[-1][0][0] <= fang:
                gruppen[-1].append((wert, rang))
            else:
                gruppen.append([(wert, rang)])
        feste = []
        for gruppe in gruppen:
            bester = max(r for _, r in gruppe)
            feste.append(float(np.mean([w for w, r in gruppe if r == bester])))
        # Die Hülle bleibt exakt: ihr Rang ist der höchste, aber das Mittel
        # einer Gruppe könnte sie um Rundungen verschieben.
        feste[0], feste[-1] = float(lo[achse]), float(hi[achse])
        punkte = [feste[0]]
        for a, b in zip(feste[:-1], feste[1:]):
            # 5 % Übermaß je Zelle: ein gedrehter Umriss misst 10,0001 statt
            # 10 m, und eine ganze Reihe mehr wegen eines Zehntelmillimeters
            # wäre nur teurer.
            n = max(1, int(np.ceil((b - a) / ziel - 0.05)))
            punkte.extend(a + (b - a) * np.arange(1, n + 1) / n)
        linien.append(np.asarray(punkte, dtype=float))
    return linien[0], linien[1]


def lagerknoten(netz: "Netz", lager: dict, kappe: float | None = None) -> np.ndarray:
    """
    Die Knoten (alle Höhen), die ein Lager hält.

    **Je Rasterspalte genau eine Reihe.** Für eine Lagerlinie wird in jeder
    Spalte, die sie überstreicht (bei flachen Strecken je x, bei steilen je y),
    der Knoten mit dem kleinsten Abstand quer zur Linie genommen — nicht alles
    im Suchradius. Ein Suchradius fing je nach Lage der Wandachse eine Reihe
    oder zwei, und zwei Reihen halten die Decke wie eine Teileinspannung
    (siehe `vernetze()`). Mit den Rasterlinien aus `_rasterlinien()` liegt die
    gewählte Reihe auf der Achse; bei einer schrägen Wand ist es die
    nächstliegende Treppe aus Knoten.

    Punktlager halten den nächsten Knoten. `kappe` begrenzt den Abstand
    (Vorgabe 0,6 Δ): ein Lager neben der Platte hält nichts. **Mindestens die
    halbe tragende Breite** (`breite_m`, aus dem Bauteil): eine Decke, die an
    der Innenseite einer Wand endet, liegt auf ihr — auch wenn ihr Rand weiter
    als 0,6 Δ von der Wandachse entfernt ist. Ohne das hing die Ersatzplatte
    über dem KG der LPH 4 bei Δ = 0,25 m frei (140 mm), bei Δ = 0,5 m nicht.

    @returns Bool-Maske über `netz.points`
    """
    # Im System des Rasters: nur dort sind die Spalten Spalten.
    xy = netz.lokal(netz.points[:, :2])
    kappe = float(kappe if kappe is not None else max(netz.groesse * 0.6, 1e-3))
    kappe = max(kappe, 0.5 * float(lager.get("breite_m") or 0.0) + 0.02)
    maske = np.zeros(len(xy), dtype=bool)
    if lager.get("typ") == "punkt":
        ort = netz.lokal(np.asarray(lager["p"][:2], dtype=float)[None, :])[0]
        abstand = np.linalg.norm(xy - ort, axis=1)
        kleinster = float(abstand.min()) if len(abstand) else np.inf
        if kleinster <= kappe:
            # Gleich nahe Knoten (Lager genau in einer Zellmitte) zählen alle,
            # sonst hinge die Wahl an der Reihenfolge der Knoten.
            maske = abstand <= kleinster + 1e-6
        return maske

    zug = np.asarray(lager.get("polylinie") or [], dtype=float)
    if len(zug):
        zug = netz.lokal(zug[:, :2])
    for a, b in zip(zug[:-1], zug[1:]):
        a, b = a[:2], b[:2]
        d = b - a
        if float(np.hypot(*d)) < 1e-9:
            continue
        laengs = 0 if abs(d[0]) >= abs(d[1]) else 1
        quer = 1 - laengs
        von, bis = sorted((float(a[laengs]), float(b[laengs])))
        im_bereich = np.flatnonzero((xy[:, laengs] >= von - 1e-6) & (xy[:, laengs] <= bis + 1e-6))
        if not len(im_bereich):
            # Kürzer als eine Zelle: der Knoten, der der Mitte am nächsten liegt.
            mitte = 0.5 * (a + b)
            abstand = np.linalg.norm(xy - mitte, axis=1)
            if float(abstand.min()) <= kappe:
                maske |= abstand <= float(abstand.min()) + 1e-6
            continue
        t = (xy[im_bereich, laengs] - a[laengs]) / d[laengs]
        soll = a[quer] + t * d[quer]
        abweichung = np.abs(xy[im_bereich, quer] - soll)
        spalte = np.round(xy[im_bereich, laengs], 6)
        # Je Spalte die Querlage des nächsten Knotens; bei Gleichstand die
        # kleinere — deterministisch, und nie zwei Reihen.
        ordnung = np.lexsort((xy[im_bereich, quer], abweichung, spalte))
        _, erste = np.unique(spalte[ordnung], return_index=True)
        gewaehlt = ordnung[erste]
        beste_quer = dict(zip(spalte[gewaehlt].tolist(), xy[im_bereich[gewaehlt], quer].tolist()))
        beste_abw = dict(zip(spalte[gewaehlt].tolist(), abweichung[gewaehlt].tolist()))
        ziel_quer = np.array([beste_quer[s] for s in spalte.tolist()])
        ziel_abw = np.array([beste_abw[s] for s in spalte.tolist()])
        nimm = (np.abs(xy[im_bereich, quer] - ziel_quer) <= 1e-6) & (ziel_abw <= kappe)
        maske[im_bereich[nimm]] = True
    return maske


def vernetze(modell: Modell, system_id: str | None = None,
             groesse: float | None = None, lagen: int | None = None) -> Netz:
    """
    Baut das HEX8-Netz der Systemfläche.

    Das Verfahren ist bewusst das einfache: ein achsparalleles Raster über der
    Bounding Box, aus dem die Zellen bleiben, deren Mittelpunkt im Umriss
    liegt, anschließend über die Dicke extrudiert. Für die rechteckigen und
    L-förmigen Deckenfelder des Hochbaus ist das exakt; nur schräge und
    gekrümmte Ränder bekommen eine Treppe. Der Vorteil: das Netz ist
    reproduzierbar, hängt von keiner externen Bibliothek ab und die
    Elementkanten stehen parallel zu den Momentenrichtungen, die man später
    auswertet — bei einem unstrukturierten Dreiecksnetz muss man die
    Hauptrichtungen erst wieder herausrechnen.

    Wer einen sauberen Rand braucht, nimmt `vernetze_gmsh()`.
    """
    platte = modell.platte(system_id)
    polygon = _ring(platte["umriss"])
    # Treppenauge, Schächte, Aussparungen. Sie werden aus dem Netz
    # ausgestanzt, nicht weichgerechnet: eine Decke mit einem Treppenauge
    # spannt dort nicht, und ein Ersatzmodell mit abgeminderter Steifigkeit
    # spannt doch — nur schlechter, und die Momente daneben stimmen dann nicht.
    loecher = [_ring(o) for o in (platte.get("oeffnungen") or []) if len(o) >= 3]
    dicke = float(platte["dicke_m"])
    ziel = float(groesse or modell.daten.get("netz", {}).get("elementgroesse_m", 0.25))
    n_lagen = int(lagen or modell.daten.get("netz", {}).get("lagen_ueber_dicke", 2))
    if n_lagen < 2:
        # Nicht stillschweigend anheben, aber auch nicht zulassen: mit einer
        # Lage liegt jede Elementmitte in der Mittelebene, und
        # `schnittgroessen()` bekäme keinen Hebel, aus dem sich ein Moment
        # ablesen ließe. Das fällt sonst erst am Ergebnis auf — als exakte Null
        # in jeder Karte, in jeder Kombination.
        raise ValueError(
            f"lagen = {n_lagen}: eine Elementlage über die Dicke trägt kein Moment. "
            f"Die Spannungen werden in der Elementmitte ausgewertet, und die läge "
            f"genau in der Mittelebene. Mindestens 2 Lagen wählen."
        )

    # **Rasterlinien auf den Lagerachsen.** Ein gleichmäßiges Raster legt die
    # Knoten, wohin es will; ein Lager fing dann, was im Suchradius lag — eine
    # Knotenreihe oder zwei, je nachdem, wo die Wandachse zwischen zwei Reihen
    # fiel. Zwei Reihen halten die Decke wie eine Teileinspannung. Am Flachdach
    # des Prüfhauses H1 (9,76 × 7,76 m) kam bei Δ = 0,10 m 94 % der
    # Durchbiegung nach Navier heraus, bei Δ = 0,08 m 35 % und das halbe
    # Moment — dieselbe Decke, eine andere Netzweite. `_rasterlinien()` legt
    # deshalb Rasterlinien auf Lagerachsen, Ränder, Öffnungen und
    # Unterzugflanken; dazwischen wird gleichmäßig aufgefüllt.
    #
    # **Im System des Gebäudes.** `hauptrichtung()` dreht das Raster in die
    # Richtung der Wände; gerastert wird mit gedrehtem Umriss, Öffnungen,
    # Lagern und Unterzügen, die Knoten kommen danach in Weltkoordinaten
    # zurück.
    drehung = hauptrichtung(modell, polygon)
    c_w, s_w = np.cos(drehung), np.sin(drehung)

    def ins_raster(ring):
        ring = np.asarray(ring, dtype=float)
        return np.stack([c_w * ring[:, 0] + s_w * ring[:, 1],
                         -s_w * ring[:, 0] + c_w * ring[:, 1]], axis=1)

    polygon_r = ins_raster(polygon) if drehung else polygon
    loecher_r = [ins_raster(l) for l in loecher] if drehung else loecher
    xs, ys = _rasterlinien(_gedreht(modell, drehung), polygon_r, loecher_r, ziel)
    nx, ny = len(xs) - 1, len(ys) - 1
    breiten_x, breiten_y = np.diff(xs), np.diff(ys)
    dx, dy = float(breiten_x.max()), float(breiten_y.max())
    xmin, ymin = float(xs[0]), float(ys[0])
    dz = dicke / n_lagen

    # Zellmittelpunkte prüfen statt Ecken: eine Zelle gehört zur Platte, wenn
    # ihr Schwerpunkt drinliegt — das trifft die Fläche im Mittel richtig,
    # während „alle vier Ecken innen" den Rand systematisch abschneidet.
    ix, iy = np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij")
    mitten = np.stack([0.5 * (xs[ix.ravel()] + xs[ix.ravel() + 1]),
                       0.5 * (ys[iy.ravel()] + ys[iy.ravel() + 1])], axis=1)
    zellflaeche = breiten_x[ix.ravel()] * breiten_y[iy.ravel()]
    behalten = innen(mitten, polygon_r)
    for loch in loecher_r:
        behalten &= ~innen(mitten, loch)
    if drehung:
        # Ab hier zählen Weltkoordinaten: Unterzüge, Lasten und Lager stehen
        # dort, und die Zellmitten werden mit ihnen verglichen.
        mitten = np.stack([c_w * mitten[:, 0] - s_w * mitten[:, 1],
                           s_w * mitten[:, 0] + c_w * mitten[:, 1]], axis=1)
    if not behalten.any():
        raise ValueError(
            "Kein Element liegt im Systemumriss — ist die Elementgröße größer "
            "als die Platte, oder decken die Öffnungen sie vollständig ab?")
    # **Die Platte wiegt, was ihre Figur wiegt.** Die Zellen mit Mittelpunkt im
    # Umriss decken am runden oder schrägen Rand etwas mehr oder weniger als
    # die Figur (Lucy, runde Dachfelder: +0,2 %, UG-Decke −0,2 %). Die Wichte
    # der Plattenzellen wird darum auf die wahre Fläche umgelegt — dieselbe
    # Regel wie für den Steg eines Unterzugs. Nur bei kleinen Abweichungen:
    # weicht das Netz grob ab, soll man es sehen, nicht ausgleichen.
    def _flaeche(ring):
        ring = np.asarray(ring, dtype=float)
        return 0.5 * abs(float(np.dot(ring[:, 0], np.roll(ring[:, 1], -1))
                               - np.dot(ring[:, 1], np.roll(ring[:, 0], -1))))
    flaeche_figur = _flaeche(polygon_r) - sum(
        _flaeche(l) for n, l in enumerate(loecher_r)
        if not any(m != n and bool(innen(np.asarray(l[:1], dtype=float), loecher_r[m])[0])
                   for m in range(len(loecher_r))))
    flaeche_netz = float(zellflaeche[behalten].sum())
    flaechenausgleich = flaeche_figur / flaeche_netz if flaeche_netz > 1e-12 else 1.0
    if not 0.9 <= flaechenausgleich <= 1.1:
        flaechenausgleich = 1.0

    # Unterzüge/Überzüge: zusätzliche Lagen je betroffener Spalte, unter
    # (Unterzug) oder über (Überzug) der Grundplatte — dieselbe Lagenhöhe dz
    # wie die Grundplatte, damit die Elemente nicht schlagartig anders
    # proportioniert sind. `abstand_zu_polylinie()` ist dieselbe Funktion,
    # die `randbedingungen()` für Linienlager benutzt.
    zusatz_unten = np.zeros(len(mitten), dtype=int)
    zusatz_oben = np.zeros(len(mitten), dtype=int)
    #: Wichte der Stegzellen je Spalte, unten und oben, und der Unterzug, dem
    #: die Stegzellen der Spalte gehören.
    wichte_platte = float(platte["material"]["wichte_kNm3"])
    wichte_unten = np.full(len(mitten), wichte_platte, dtype=float)
    wichte_oben = np.full(len(mitten), wichte_platte, dtype=float)
    welcher_unten = -np.ones(len(mitten), dtype=int)
    welcher_oben = -np.ones(len(mitten), dtype=int)
    #: Unterzug-Index → (Stegeigengewicht kN, Spaltenmaske, Überzug?)
    stege: dict[int, tuple[float, np.ndarray, bool]] = {}
    flaechenanteil: dict[int, float] = {}
    for nummer, balken in enumerate(modell.balken):
        linie = np.asarray(balken["polylinie"], dtype=float)
        breite = float(balken["breite_m"])
        hoehe_balken = float(balken["hoehe_m"])
        extra = hoehe_balken - dicke
        kennung = balken.get("id", "?")
        if extra <= 1e-6:
            _merken(modell, f"Unterzug/Überzug {kennung}: Höhe "
                            f"({hoehe_balken:.2f} m) ist nicht größer als die Plattendicke "
                            f"({dicke:.2f} m) — bleibt ohne Wirkung.")
            continue
        zusatzlagen = max(1, int(np.ceil(extra / dz - 1e-9)))
        abstand = abstand_zu_polylinie(mitten, linie)
        nah = (abstand <= breite / 2.0) & behalten
        if not nah.any() and behalten.any():
            # **Schmaler als das Netz.** Kein Zellmittelpunkt liegt im Steg —
            # bei 0,5 m Netz und einem 30er Balken auf einer Rasterlinie der
            # Regelfall. Bis Oktober 2026 fiel der Unterzug dann still aus der
            # Rechnung, und die Decke spannte ungestützt über ihn hinweg. Jetzt
            # übernimmt die nächste Zellreihe (bzw. die beiden gleich nahen):
            # die Steifigkeit ist damit größer als die des Stegs, das Gewicht
            # wird unten auf den wahren Querschnitt gezogen.
            naechst = float(abstand[behalten].min())
            if naechst <= breite / 2.0 + max(dx, dy):
                nah = behalten & (abstand <= naechst + 1e-6)
                _merken(modell, f"Unterzug/Überzug {kennung}: Stegbreite {breite:.2f} m ist "
                                f"schmaler als das Netz ({max(dx, dy):.2f} m) — abgebildet über "
                                f"die nächste Zellreihe, steifer als der Steg. Gewicht aus dem "
                                f"wahren Querschnitt; für die Balkenbemessung feiner vernetzen.")
        if not nah.any():
            _merken(modell, f"Unterzug/Überzug {kennung} liegt nicht unter der Platte — "
                            f"bleibt ohne Wirkung.")
            continue
        # Das wahre Stegvolumen über die Länge, die unter der Platte liegt —
        # mit der Wichte des Balkens, wenn er eine eigene hat (ein Holzbalken
        # unter einer Ersatzplatte, ein Stahlträger).
        laenge = _laenge_innen(linie, polygon, loecher)
        if laenge < 1e-6:
            # Neben der Platte: der Rückfall auf die nächste Zellreihe fände
            # Zellen, aber der Balken trägt hier nichts — Steifigkeit und
            # Gewicht wären null (Lucy: Division durch null im Werkstoff).
            _merken(modell, f"Unterzug/Überzug {kennung} liegt nicht unter der Platte — "
                            f"bleibt ohne Wirkung.")
            continue
        grundflaeche = float(zellflaeche[nah].sum())
        netz_volumen = grundflaeche * zusatzlagen * dz
        wichte_balken = float(balken.get("wichte_kNm3") or wichte_platte)
        wichte_steg = ((breite * extra * laenge * wichte_balken) / netz_volumen
                       if netz_volumen > 1e-12 else wichte_balken)
        flaechenanteil[nummer] = (breite * laenge) / grundflaeche if grundflaeche > 1e-12 else 1.0
        oben_ = balken.get("richtung", "unten") == "oben"
        stege[nummer] = (breite * extra * laenge * wichte_balken, nah, oben_)
        if oben_:
            neu_tiefer = nah & (zusatzlagen >= zusatz_oben)
            zusatz_oben[nah] = np.maximum(zusatz_oben[nah], zusatzlagen)
            wichte_oben[neu_tiefer] = wichte_steg
            welcher_oben[neu_tiefer] = nummer
        else:
            neu_tiefer = nah & (zusatzlagen >= zusatz_unten)
            zusatz_unten[nah] = np.maximum(zusatz_unten[nah], zusatzlagen)
            wichte_unten[neu_tiefer] = wichte_steg
            welcher_unten[neu_tiefer] = nummer
    # **Jeder Steg wiegt, was sein Balken wiegt — auch an Kreuzungen.** Eine
    # Spalte gehört dem tieferen Balken; der flachere verlor dort bisher sein
    # Gewicht (Lucy, UG: 141 Holzbalken, an den Kreuzungen 2,4 kN). Das
    # Gewicht wird deshalb auf die Zellen gelegt, die dem Balken tatsächlich
    # gehören; gehört ihm keine, trägt es die Spalte, in der er liegt.
    for nummer, (gewicht, nah, oben_) in stege.items():
        welcher, zusatz, wichte_ = ((welcher_oben, zusatz_oben, wichte_oben) if oben_
                                    else (welcher_unten, zusatz_unten, wichte_unten))
        eigen = welcher == nummer
        volumen = float((zellflaeche[eigen] * zusatz[eigen]).sum()) * dz
        if volumen > 1e-12:
            wichte_[eigen] = gewicht / volumen
            continue
        volumen = float((zellflaeche[nah] * zusatz[nah]).sum()) * dz
        if volumen > 1e-12:
            wichte_[nah] += gewicht / volumen
    spalte_hat_balken = (zusatz_unten > 0) | (zusatz_oben > 0)

    kmin = -int(zusatz_unten.max(initial=0))
    kmax = n_lagen + int(zusatz_oben.max(initial=0))

    gitter_index = -np.ones((nx + 1) * (ny + 1) * (kmax - kmin + 1), dtype=int)

    def knoten_id(i, j, k):
        return ((k - kmin) * (ny + 1) + j) * (nx + 1) + i

    zellen = []
    balken_element = []
    zellwichte = []
    balken_zelle = []
    zell_index = np.stack([ix.ravel(), iy.ravel()], axis=1)
    for idx, (zelle, ok) in enumerate(zip(zell_index, behalten)):
        if not ok:
            continue
        i, j = int(zelle[0]), int(zelle[1])
        k_von = -int(zusatz_unten[idx])
        k_bis = n_lagen + int(zusatz_oben[idx])
        zug = bool(spalte_hat_balken[idx])
        for k in range(k_von, k_bis):
            # meshio-Reihenfolge für 'hexahedron': erst die untere Fläche gegen
            # den Uhrzeigersinn, dann die obere. Dieselbe Reihenfolge liefert
            # `jax_fem.generate_mesh.box_mesh`.
            ecken = [
                knoten_id(i, j, k), knoten_id(i + 1, j, k),
                knoten_id(i + 1, j + 1, k), knoten_id(i, j + 1, k),
                knoten_id(i, j, k + 1), knoten_id(i + 1, j, k + 1),
                knoten_id(i + 1, j + 1, k + 1), knoten_id(i, j + 1, k + 1),
            ]
            zellen.append(ecken)
            balken_element.append(zug)
            zellwichte.append(wichte_unten[idx] if k < 0 else
                              wichte_oben[idx] if k >= n_lagen
                              else wichte_platte * flaechenausgleich)
            balken_zelle.append(int(welcher_unten[idx]) if k < 0 else
                                int(welcher_oben[idx]) if k >= n_lagen else -1)
            for e in ecken:
                gitter_index[e] = 1

    benutzt = np.flatnonzero(gitter_index > 0)
    neu = -np.ones_like(gitter_index)
    neu[benutzt] = np.arange(len(benutzt))

    k_offset, rest = np.divmod(benutzt, (nx + 1) * (ny + 1))
    j_index, i_index = np.divmod(rest, nx + 1)
    k_index = k_offset + kmin
    u, v = xs[i_index], ys[j_index]
    points = np.stack([c_w * u - s_w * v, s_w * u + c_w * v, k_index * dz],
                      axis=1).astype(float)
    cells = neu[np.asarray(zellen, dtype=int)]
    balken_spalten = np.asarray(balken_element, dtype=bool)

    _netzguete(modell, polygon, max(dx, dy), dicke)
    wichten = np.asarray(zellwichte, dtype=float)
    return Netz(points=points, cells=cells, dicke=dicke, polygon=polygon,
                groesse=float(max(dx, dy)), verfahren="raster", n_lagen=n_lagen,
                balken_spalten=balken_spalten, loecher=loecher,
                eg_wichte=wichten if np.any(np.abs(wichten - wichte_platte) > 1e-12) else None,
                balken_zelle=np.asarray(balken_zelle, dtype=int) if modell.balken else None,
                balken_flaechenanteil=flaechenanteil, drehung=drehung)


def werkstofftabelle(modell: "Modell", netz: Netz):
    """
    Die Steifigkeitstabelle für den Löser, wenn die Platte nicht isotrop ist.

    **Eine Holzbalkendecke ist als Platte orthotrop.** Die Kette bildet sie als
    Ersatzplatte ab (`kette.balkenlagen()`): steif in Balkenrichtung, weich
    quer dazu. Isotrop gerechnet trüge sie über Kreuz und gäbe Last an Wände
    parallel zu den Balken ab, die in Wirklichkeit keine bekommen — bei einem
    quadratischen Raum die Hälfte.

    Rippen (Unterzüge, Rähme) unter einer solchen Platte bekommen je eine
    eigene Zeile: ein Rähm quer zu den Balken trägt längs seiner Achse, nicht
    in der Richtung der Balkenlage. Isotrop mit dem E-Modul seines Werkstoffs,
    abgemindert um den Anteil, um den das Netz den Steg breiter abbildet
    (`netz.balken_flaechenanteil`).

    @returns (C_tabelle (n, 6, 6), material (m,)) oder None — dann rechnet der
             Löser isotrop mit E und ν der Platte wie bisher
    """
    material = modell.platte()["material"]
    ortho = material.get("orthotrop")
    if not ortho:
        return None
    from .werkstoff import Werkstoff, drehen

    def isotrop(E, nu):
        G = E / (2.0 * (1.0 + nu))
        return Werkstoff(name="iso", familie="holz", rho_kNm3=0.0, E_1=E, E_2=E, E_3=E,
                         G_12=G, G_13=G, G_23=G, nu_12=nu, nu_13=nu, nu_23=nu).steifigkeit()

    w = Werkstoff(name=material.get("name") or "Ersatzplatte", familie="holz",
                  rho_kNm3=float(material.get("wichte_kNm3", 0.0)),
                  E_1=float(ortho["E_l"]), E_2=float(ortho["E_q"]),
                  E_3=float(ortho.get("E_z", ortho["E_l"])),
                  G_12=float(ortho["G_lq"]), G_13=float(ortho["G_lz"]),
                  G_23=float(ortho["G_qz"]),
                  nu_12=float(ortho.get("nu", 0.05)), nu_13=float(ortho.get("nu", 0.05)),
                  nu_23=float(ortho.get("nu", 0.05)))
    winkel = np.radians(float(ortho.get("richtung_grad", 0.0)))
    tabelle = [drehen(w.steifigkeit(), (np.cos(winkel), np.sin(winkel), 0.0),
                      (-np.sin(winkel), np.cos(winkel), 0.0))]
    zuordnung = np.zeros(len(netz.cells), dtype=np.int32)
    zellen = netz.balken_zelle
    # Zonen mit eigener Balkenrichtung (Stichbalken einer Auskragung, ein
    # Wechselfeld): derselbe Werkstoff, gedreht. Die Rippen kommen danach und
    # gehen vor.
    if ortho.get("zonen"):
        mitten = netz.points[netz.cells].mean(axis=1)[:, :2]
        platte_zelle = zellen < 0 if zellen is not None else np.ones(len(netz.cells), bool)
        for zone in ortho["zonen"]:
            drin = innen(mitten, _ring(zone["umriss"])) & platte_zelle
            if not drin.any():
                continue
            w_z = np.radians(float(zone["richtung_grad"]))
            tabelle.append(drehen(w.steifigkeit(), (np.cos(w_z), np.sin(w_z), 0.0),
                                  (-np.sin(w_z), np.cos(w_z), 0.0)))
            zuordnung[drin] = len(tabelle) - 1
    for nummer, balken in enumerate(modell.balken):
        werk = balken.get("material") or {}
        if zellen is None or not werk.get("E_kNm2"):
            continue
        anteil = min(1.0, float(netz.balken_flaechenanteil.get(nummer, 1.0)))
        if anteil <= 1e-9:
            continue
        tabelle.append(isotrop(float(werk["E_kNm2"]) * anteil, float(werk.get("nu", 0.2))))
        zuordnung[zellen == nummer] = len(tabelle) - 1
    return np.stack(tabelle), zuordnung


def _laenge_innen(linie: np.ndarray, polygon: np.ndarray, loecher=(),
                  schritt: float = 0.01) -> float:
    """Länge eines Polygonzugs innerhalb des Umrisses und außerhalb der Löcher."""
    gesamt = 0.0
    for a, b in zip(linie[:-1], linie[1:]):
        l = float(np.linalg.norm(b - a))
        if l < 1e-9:
            continue
        n = max(2, int(np.ceil(l / schritt)))
        t = (np.arange(n) + 0.5) / n
        proben = a[None, :] + t[:, None] * (b - a)[None, :]
        drin = innen(proben, polygon)
        for loch in loecher or []:
            drin &= ~innen(proben, loch)
        gesamt += l * float(drin.mean())
    return gesamt


def _netzguete(modell: Modell, polygon: np.ndarray, groesse: float, dicke: float):
    """
    Warnt bei zu grobem Netz.

    HEX8-Elemente mit voller Integration versteifen unter Biegung
    (Schublocking): den geradlinigen Verlauf der Längsdehnung über die Höhe
    können sie nur mit einem zusätzlichen, unphysikalischen Schubanteil
    abbilden. Durchbiegung *und* Momente fallen dadurch zu klein aus — der
    Fehler liegt also auf der unsicheren Seite und sieht dabei unauffällig aus.

    Entscheidend ist das Verhältnis von Elementgröße zu Plattendicke, nicht die
    Zahl der Elemente über die Spannweite, und schon gar nicht die Zahl der
    Lagen über die Dicke. An einer einachsig gespannten Kontrollplatte
    (4 m, d = 20 cm, gelenkig, Gleichlast) gemessen:

    | Elementgröße | Feldmoment gegenüber q·l²/8 |
    |---|---|
    | Δ = h       | 66 % |
    | Δ = h/2     | 89 % |
    | Δ = h/4     | 97 % |

    Zwei und vier Lagen über die Dicke lieferten dabei auf zwei
    Nachkommastellen dasselbe. Deshalb: in der Ebene verfeinern, nicht in der
    Höhe.
    """
    # Ein Prozent Luft: die Rastereinteilung trifft die gewünschte Größe nie
    # genau, und eine Warnung wegen 0,1004 statt 0,1000 m wäre nur Lärm.
    if groesse > dicke / 2 * 1.01:
        guete = "etwa zwei Drittel" if groesse >= dicke else "rund 90 %"
        _merken(modell,
                f"Netz grob: Elementgröße {groesse:.3f} m bei {dicke:.2f} m Plattendicke "
                f"(Δ/h = {groesse / dicke:.1f}). HEX8 versteift dann unter Biegung, Momente "
                f"und Durchbiegung erreichen nur {guete} des richtigen Werts. "
                f"Empfohlen: elementgroesse ≤ {dicke / 2:.3f} m.")


def vernetze_gmsh(modell: Modell, system_id: str | None = None,
                  groesse: float | None = None, lagen: int | None = None) -> Netz:
    """
    Netz mit randtreuen Elementen über gmsh.

    Nur sinnvoll, wenn der Umriss schräge oder viele kurze Kanten hat — sonst
    ist das Raster aus `vernetze()` dasselbe Ergebnis ohne Abhängigkeit. gmsh
    rekombiniert die Dreiecke zu Vierecken und extrudiert sie zu Hexaedern;
    bleiben Dreiecke übrig (das kann bei sehr spitzen Ecken passieren), wird
    die Rekombination als unvollständig gemeldet, statt ein gemischtes Netz
    zurückzugeben, mit dem `Problem(ele_type='HEX8')` nicht rechnen kann.
    """
    import gmsh

    if modell.balken:
        raise ValueError(
            "vernetze_gmsh() unterstützt keine Unterzüge/Überzüge — die "
            "Extrusion ist hier eine feste Dicke über die ganze Fläche. "
            "Mit Balken im Modell vernetze() (Raster) verwenden."
        )

    platte = modell.platte(system_id)
    polygon = _ring(platte["umriss"])
    dicke = float(platte["dicke_m"])
    ziel = float(groesse or modell.daten.get("netz", {}).get("elementgroesse_m", 0.25))
    n_lagen = int(lagen or modell.daten.get("netz", {}).get("lagen_ueber_dicke", 2))
    if n_lagen < 2:
        # Nicht stillschweigend anheben, aber auch nicht zulassen: mit einer
        # Lage liegt jede Elementmitte in der Mittelebene, und
        # `schnittgroessen()` bekäme keinen Hebel, aus dem sich ein Moment
        # ablesen ließe. Das fällt sonst erst am Ergebnis auf — als exakte Null
        # in jeder Karte, in jeder Kombination.
        raise ValueError(
            f"lagen = {n_lagen}: eine Elementlage über die Dicke trägt kein Moment. "
            f"Die Spannungen werden in der Elementmitte ausgewertet, und die läge "
            f"genau in der Mittelebene. Mindestens 2 Lagen wählen."
        )

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("ileen_platte")

        punkte = [gmsh.model.geo.addPoint(float(p[0]), float(p[1]), 0.0, ziel) for p in polygon]
        linien = [gmsh.model.geo.addLine(punkte[i], punkte[(i + 1) % len(punkte)])
                  for i in range(len(punkte))]
        schleife = gmsh.model.geo.addCurveLoop(linien)
        flaeche_tag = gmsh.model.geo.addPlaneSurface([schleife])

        gmsh.model.geo.mesh.setRecombine(2, flaeche_tag)
        gmsh.model.geo.extrude([(2, flaeche_tag)], 0, 0, dicke,
                               numElements=[n_lagen], recombine=True)
        gmsh.model.geo.synchronize()
        gmsh.option.setNumber("Mesh.RecombineAll", 1)
        gmsh.model.mesh.generate(3)

        knoten_tags, koordinaten, _ = gmsh.model.mesh.getNodes()
        points = np.asarray(koordinaten, dtype=float).reshape(-1, 3)
        umschlag = {int(t): i for i, t in enumerate(knoten_tags)}

        typen, _, knoten_je_element = gmsh.model.mesh.getElements(dim=3)
        cells = None
        for typ, tags in zip(typen, knoten_je_element):
            if typ == 5:  # 5 = 8-knotiger Hexaeder
                cells = np.asarray([umschlag[int(t)] for t in tags], dtype=int).reshape(-1, 8)
        if cells is None:
            raise RuntimeError("gmsh hat keine Hexaeder erzeugt — Umriss zu spitz? "
                               "Dann vernetze() mit dem Raster verwenden.")
    finally:
        gmsh.finalize()

    _netzguete(modell, polygon, ziel, dicke)
    return Netz(points=points, cells=cells, dicke=dicke, polygon=polygon,
                groesse=ziel, verfahren="gmsh", n_lagen=n_lagen)


# ──────────────────────────────────────────────────────────────────────────
# Lasten
# ──────────────────────────────────────────────────────────────────────────


def eigengewicht(modell: Modell, system_id: str | None = None) -> float:
    """Flächenlast der Platte selbst in kN/m² — Wichte mal Dicke."""
    platte = modell.platte(system_id)
    return float(platte["material"]["wichte_kNm3"]) * float(platte["dicke_m"])


def _wirksame_laenge(linie: np.ndarray, netz: "Netz", schritt: float,
                     mitten_xy: np.ndarray | None = None) -> float:
    """
    Der Anteil eines Streckenzugs, der auf tragender Deckenfläche liegt.

    Eine Linienlast wird oft entlang der ganzen Wand gezeichnet, auch über
    Bereiche, die nicht zur gerechneten Platte gehören. Ohne diese Begrenzung
    käme die Last dieser Abschnitte trotzdem auf die Platte — die Resultierende
    wäre zu groß, und zwar unauffällig.

    Öffnungen zählen dabei als „außerhalb": eine Wand, die am Treppenauge
    vorbeiläuft, gibt dort keine Last ab, weil dort keine Decke ist.

    **Der Rand zählt mit.** Eine Wand, deren Achse genau auf der Plattenkante
    liegt — eine Kellerwand unter dem Rand der Sohle, eine Außenwand bündig
    mit der Deckenkante —, steht auf der Platte. Der Strahltest von
    `auf_platte()` entscheidet für Punkte *auf* dem Rand aber zufällig, und
    am EFH Weihgold fiel so die Last ganzer Wände weg (Einzel- und
    Linienlasten „außerhalb des Systemumrisses", 45 % der Last von oben).
    Deshalb zählt ein Probenpunkt auch, wenn eine Elementmitte der Oberseite
    höchstens ¾ Elementweite entfernt ist — dieselbe Nachbarschaft, über die
    `_anteile()` die Last auf die Randelemente verteilt (Suchradius 0,6 Δ;
    ¾ Δ deckt zusätzlich die Elementecken, √½ Δ ≈ 0,71 Δ).
    """
    baum = None
    if mitten_xy is not None and len(mitten_xy):
        from scipy.spatial import cKDTree
        baum = cKDTree(np.asarray(mitten_xy, dtype=float))
    nah = 0.75 * float(netz.groesse)

    gesamt = 0.0
    for i in range(len(linie) - 1):
        a, b = linie[i], linie[i + 1]
        laenge = float(np.linalg.norm(b - a))
        if laenge < 1e-12:
            continue
        n = max(1, int(np.ceil(laenge / max(schritt, 1e-6))) * 4)
        t = (np.arange(n) + 0.5) / n
        proben = a + t[:, None] * (b - a)
        zaehlt = netz.auf_platte(proben)
        if baum is not None:
            abstand, _ = baum.query(proben)
            zaehlt |= abstand <= nah
        gesamt += laenge / n * int(zaehlt.sum())
    return gesamt


def _einzellasten_maske(xy: np.ndarray, ort: np.ndarray, radius: float) -> np.ndarray:
    """
    Die Elemente, auf die eine Einzellast verteilt wird.

    Fällt der Angriffspunkt genau auf eine Elementecke — bei achsparallelen
    Rastern der Regelfall, weil man Stützen auf Rasterschnittpunkte setzt —
    liegt keine Elementmitte innerhalb des Radius. Dann wird das nächste
    Element genommen: eine Einzellast darf nicht daran scheitern, dass sie zu
    genau gesetzt wurde.
    """
    abstand = np.linalg.norm(xy - ort, axis=1)
    maske = abstand <= radius
    if not maske.any():
        maske = abstand == abstand.min()
    return maske


def _anteile(modell: Modell, netz: Netz, faktoren: dict[str, float],
             mit_eigengewicht: bool, streifen: float | None):
    """
    Zerlegt die Kombination in Beiträge, jeder mit Maske und Intensität.

    Gemeinsame Grundlage für `lastfeld()` (Kontrollplots, Probe) und
    `q_funktion()` (Randbedingung im Solver) — sonst liefen beide Wege
    auseinander, und die Probe würde etwas anderes bestätigen, als gerechnet
    wird.

    **Verschmieren mit Erhaltung der Resultierenden.** Eine echte Linien- oder
    Einzellast wäre auf einem Volumenmodell eine Singularität: jede
    Netzverfeinerung triebe die Spannung dort weiter hoch, ohne das Ergebnis zu
    verbessern. Beide werden deshalb über die getroffenen Elemente verteilt —
    und zwar so, dass ihre Summe stimmt: die Intensität ergibt sich aus
    Gesamtkraft geteilt durch die *tatsächlich* getroffene Fläche. Eine
    Streifenrechnung „q = p / b" wäre naheliegender, verdoppelt die Last aber
    genau dann, wenn die Lastlinie auf einer Elementgrenze liegt und beide
    Nachbarreihen in den Suchradius fallen. Für Durchbiegung und Feldmomente
    ist das Verschmieren ohne Belang; unmittelbar unter der Last sind die
    Spannungen Rechenwerte und keine Bemessungswerte.
    """
    breite = float(streifen or netz.groesse)
    # Zuschlag von 20 %: die Mitte der äußersten Elementreihe liegt exakt eine
    # halbe Elementbreite vom Rand entfernt, und bei radius = Δ/2 entscheidet
    # die letzte Stelle der Fließkommazahl darüber, ob eine Linienlast auf der
    # Randachse angesetzt wird oder still verschwindet. Die Resultierende bleibt
    # unberührt — sie folgt aus der Zahl der getroffenen Elemente.
    radius = breite * 0.6

    mitten = netz.points[netz.cells].mean(axis=1)
    # `oberste_lage_z()` statt netz.dicke: die Elementmitten der obersten
    # Grundplatten-Lage liegen eine halbe Lagenhöhe darunter. Vom Bezug
    # netz.dicke aus (statt vom tatsächlichen Netzmaximum) gerechnet, damit
    # ein Überzug diese Referenz nicht mit anhebt — sonst träfe „oben" nur
    # noch den schmalen Rippenkopf statt der ganzen Deckenoberfläche, auf der
    # die Flächenlast tatsächlich aufliegt.
    oben = mitten[:, 2] >= oberste_lage_z(netz) - 1e-9
    xy = mitten[oben][:, :2]
    # Die tatsächliche Grundfläche je Element, nicht `netz.groesse²` — siehe
    # `zellflaechen()`. Sie ist der Nenner, mit dem Linien- und Einzellasten
    # in eine Flächenlast umgerechnet werden.
    flaechen = zellflaechen(netz)[oben]

    grund = 0.0
    if mit_eigengewicht:
        grund = eigengewicht_beiwert(modell, faktoren) * eigengewicht(modell)

    beitraege = []
    for last in modell.lasten:
        beiwert = faktoren.get(last["lastfall"], 0.0)
        if beiwert == 0.0:
            continue
        wert = float(last["wert"]) * beiwert

        if last["typ"] == "flaeche":
            polygon = _ring(last["polygon"])
            maske = innen(xy, polygon)
            # **Die Löcher einer Lastfläche sind keine Zierde.** Die
            # Restfläche einer Decke ist „Umriss minus alle Räume" — ihr
            # Außenring ist der ganze Deckenumriss, die Räume sind ihre Löcher.
            # Ohne sie lag die Vorgabe-Nutzlast zusätzlich auf jedem Raum, und
            # die Decke trug ihre Nutzlast doppelt (Prüfhaus H1: 240 statt
            # 120 kN). Die Gleichgewichtsprobe sah es nicht: sie bestätigt die
            # Last, die angesetzt wurde.
            loecher = [_ring(l) for l in (last.get("loecher") or []) if len(l) >= 3]
            for loch in loecher:
                maske &= ~innen(xy, loch)
            # **Die Gesamtlast gilt, nicht die Zellsumme.** Bringt die Last
            # ihre wahre Fläche auf der Platte mit (`flaeche_m2`, gesetzt vom
            # Tragwerksmodell), wird wie bei der Linienlast auf die getroffene
            # Zellfläche umgerechnet: am runden oder schrägen Rand trüge das
            # Netz sonst ein paar Promille mehr oder weniger, als die Figur
            # hergibt. Eine Last kleiner als eine Zelle landet in der nächsten.
            intensitaet = wert
            soll = last.get("flaeche_m2")
            if soll is not None and float(soll) > 1e-9:
                ist = float(flaechen[maske].sum())
                if ist <= 1e-12 and len(xy):
                    maske = np.zeros(len(xy), dtype=bool)
                    maske[int(np.argmin(np.linalg.norm(xy - polygon.mean(axis=0), axis=1)))] = True
                    ist = float(flaechen[maske].sum())
                if ist > 1e-12:
                    intensitaet = wert * float(soll) / ist
            beitraege.append({"art": "flaeche", "geometrie": polygon,
                              "loecher": loecher,
                              "maske": maske, "intensitaet": intensitaet})

        elif last["typ"] == "linie":
            linie = np.asarray(last["polylinie"], dtype=float)
            maske = abstand_zu_polylinie(xy, linie) <= radius
            treffer = int(maske.sum())
            laenge = _wirksame_laenge(linie, netz, netz.groesse, mitten_xy=xy)
            if treffer == 0 or laenge < 1e-9:
                _merken(modell, f"Linienlast {last['id']} liegt außerhalb des Systemumrisses "
                                "und bleibt unberücksichtigt")
                continue
            beitraege.append({"art": "linie", "geometrie": linie, "radius": radius,
                              "maske": maske,
                              "intensitaet": wert * laenge / float(flaechen[maske].sum())})

        elif last["typ"] == "punkt":
            ort = np.asarray(last["p"], dtype=float)
            # Auf dem Rand zählt wie bei der Linienlast: eine Stütze, deren
            # Mitte genau auf der Plattenkante steht, steht auf der Platte.
            am_rand = bool(len(xy)) and float(
                np.min(np.linalg.norm(xy - ort, axis=1))) <= 0.75 * float(netz.groesse)
            if not bool(netz.auf_platte(ort[None, :])[0]) and not am_rand:
                _merken(modell, f"Einzellast {last['id']} bei {ort.tolist()} liegt außerhalb "
                                "des Systemumrisses und bleibt unberücksichtigt")
                continue
            # Eingeleitet wird über die Lasteinleitungsfläche, nicht über ein
            # Element: eine Stützenlast kommt über den Stützenquerschnitt in die
            # Platte, und die Plattendicke ist dafür der brauchbarste Anhalt,
            # solange der Querschnitt nicht mitgegeben wird. Verteilte man
            # stattdessen auf genau ein Element, hinge die Pressung an der
            # Netzfeinheit — bei Δ = 10 cm wären es das Fünfundzwanzigfache
            # von Δ = 50 cm, und die Farbskala jedes Kontrollbilds wäre hin.
            einleitung = max(radius, netz.dicke / 2)
            maske = _einzellasten_maske(xy, ort, einleitung)
            beitraege.append({"art": "punkt", "geometrie": ort, "radius": einleitung,
                              "maske": maske,
                              "intensitaet": wert / float(flaechen[maske].sum())})

    return xy, grund, beitraege


def _merken(modell: Modell, text: str):
    if text not in modell.warnungen:
        modell.warnungen.append(text)


#: Kennung des Eigengewichts in Kombinationen und Lastfallzerlegungen. Es ist
#: kein gezeichneter Lastfall — im Plan steht nur die Dicke — und braucht
#: trotzdem einen Namen, sobald man lastfallweise rechnet.
EIGENGEWICHT = "EG"


def eigengewicht_beiwert(modell: Modell, faktoren: dict[str, float]) -> float:
    """
    Der Teilsicherheitsbeiwert, mit dem das Eigengewicht in dieser Kombination
    steht.

    Steht `EG` ausdrücklich in den Faktoren, gilt dieser Wert; sonst der des
    ersten ständigen Lastfalls (im Frontend „Eigenlast Tragwerk"), sonst 1,35.
    Die Reihenfolge ist wichtig, weil die lastfallweise Rechnung `EG` setzt,
    die ältere kombinierte Rechnung dagegen nicht.
    """
    if EIGENGEWICHT in faktoren:
        return float(faktoren[EIGENGEWICHT])
    staendig = [f for f in modell.lastfaelle if f.get("art") == "G"]
    return float(faktoren.get(staendig[0]["id"], 1.35) if staendig else 1.35)


def lastfeld(modell: Modell, netz: Netz, faktoren: dict[str, float],
             mit_eigengewicht: bool = True, streifen: float | None = None) -> np.ndarray:
    """
    Die resultierende Flächenlast über der Platte, elementweise in kN/m².

    `faktoren` ordnet jedem Lastfall seinen Faktor der Kombination zu, also
    z. B. `{'g2': 1.35, 'q1': 1.5}`. Zurück kommt ein Wert je Element der
    obersten Lage — genau die Größe, die als Neumann-Randbedingung auf die
    Oberseite gehört. Zum Verschmieren von Linien- und Einzellasten siehe
    `_anteile()`.
    """
    xy, grund, beitraege = _anteile(modell, netz, faktoren, mit_eigengewicht, streifen)
    q = np.full(len(xy), grund, dtype=float)
    for beitrag in beitraege:
        q += np.where(beitrag["maske"], beitrag["intensitaet"], 0.0)
    return q


def q_funktion(modell: Modell, netz: Netz, faktoren: dict[str, float],
               mit_eigengewicht: bool = True, streifen: float | None = None):
    """
    Dieselbe Last als ortsabhängige Funktion q(x) für `get_surface_maps`.

    JAX-FEM wertet die Neumann-Bedingung an Quadraturpunkten aus, nicht
    elementweise; die Zugehörigkeit eines Punktes zu einem Lastfeld wird
    deshalb hier noch einmal geometrisch entschieden — mit `jax.numpy`, damit
    die Funktion unter `jit` und `grad` läuft. Die Intensitäten kommen aus
    derselben Zerlegung wie bei `lastfeld()`, die Resultierende ist also in
    beiden Wegen dieselbe.
    """
    import jax.numpy as jnp

    _, grund, beitraege = _anteile(modell, netz, faktoren, mit_eigengewicht, streifen)

    flaechen, linien, punkte = [], [], []
    for beitrag in beitraege:
        if beitrag["art"] == "flaeche":
            flaechen.append((jnp.asarray(beitrag["geometrie"]),
                             [jnp.asarray(l) for l in beitrag.get("loecher") or []],
                             beitrag["intensitaet"]))
        elif beitrag["art"] == "linie":
            linien.append((jnp.asarray(beitrag["geometrie"]), beitrag["intensitaet"],
                           beitrag["radius"]))
        else:
            punkte.append((jnp.asarray(beitrag["geometrie"]), beitrag["intensitaet"],
                           beitrag["radius"]))

    def innen_jax(x, y, polygon):
        x1, y1 = polygon[:, 0], polygon[:, 1]
        x2, y2 = jnp.roll(polygon[:, 0], -1), jnp.roll(polygon[:, 1], -1)
        dy = y2 - y1
        sicher = jnp.where(jnp.abs(dy) < 1e-15, 1.0, dy)
        schneidet = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / sicher + x1)
        return jnp.mod(jnp.sum(schneidet), 2) == 1

    def abstand_jax(p, linie):
        a, b = linie[:-1], linie[1:]
        richtung = b - a
        laenge2 = jnp.sum(richtung ** 2, axis=1)
        laenge2 = jnp.where(laenge2 < 1e-18, 1.0, laenge2)
        t = jnp.clip(jnp.sum((p - a) * richtung, axis=1) / laenge2, 0.0, 1.0)
        fuss = a + t[:, None] * richtung
        return jnp.min(jnp.linalg.norm(p - fuss, axis=1))

    def q(punkt):
        wert = grund
        x, y = punkt[0], punkt[1]
        for polygon, loecher, betrag in flaechen:
            drin = innen_jax(x, y, polygon)
            for loch in loecher:
                drin = drin & ~innen_jax(x, y, loch)
            wert = wert + jnp.where(drin, betrag, 0.0)
        for linie, betrag, radius in linien:
            wert = wert + jnp.where(abstand_jax(punkt[:2], linie) <= radius, betrag, 0.0)
        for ort, betrag, radius in punkte:
            wert = wert + jnp.where(jnp.linalg.norm(punkt[:2] - ort) <= radius, betrag, 0.0)
        return wert

    return q


def neumann_oberseite(modell: Modell, netz: Netz, faktoren: dict[str, float],
                      mit_eigengewicht: bool = True):
    """
    Die fertige `surface_map` für die Oberseite — mit dem richtigen Vorzeichen.

    **Die Vorzeichenfalle.** JAX-FEM addiert den Rückgabewert von
    `get_surface_maps` zum Residuum: gelöst wird ∫σ:∇v + ∫t·v = 0, die
    angegebene Größe wirkt also *entgegen* der äußeren Last. Wer wie üblich
    `[0, 0, -q]` schreibt, um „Last nach unten" auszudrücken, bekommt eine
    Platte, die sich nach oben durchbiegt — und wenn er anschließend das
    Minimum von u_z als Durchbiegung liest, steht dort 0,000 mm. Der Fehler
    ist doppelt still: die Rechnung läuft, die Zahl ist plausibel klein.

    Deshalb diese Funktion. Sie nimmt die Flächenlast in kN/m² nach unten,
    wie sie im Plan steht, und gibt zurück, was JAX-FEM dafür braucht.

        problem = MeineKlasse(..., location_fns=[plate.oberseite(netz)])
        # in der Klasse:
        def get_surface_maps(self):
            return [plate.neumann_oberseite(modell, netz, faktoren)]
    """
    import jax.numpy as jnp

    q = q_funktion(modell, netz, faktoren, mit_eigengewicht)

    def last(_u, x):
        return jnp.array([0.0, 0.0, q(x)])

    return last


def oberseite(netz: Netz, toleranz: float = 1e-6):
    """Die Ortsfunktion der Lastfläche — Gegenstück zu `neumann_oberseite`."""
    import jax.numpy as jnp

    z_max = float(netz.dicke)   # Oberseite der Grundplatte, s. `_anteile()`

    def ort(punkt):
        return jnp.isclose(punkt[2], z_max, atol=toleranz)

    return ort


def gesamtlast(modell: Modell, netz: Netz, faktoren: dict[str, float],
               mit_eigengewicht: bool = True) -> float:
    """
    Summe aller Einwirkungen in kN — die Probe vor dem Rechnen.

    Weicht dieser Wert von der Handrechnung ab, stimmt etwas an der Eingabe
    nicht, und das findet man hier in einer Sekunde statt nach dem Solver in
    einer Viertelstunde.
    """
    q = lastfeld(modell, netz, faktoren, mit_eigengewicht)
    mitten = netz.points[netz.cells].mean(axis=1)
    oben = mitten[:, 2] >= oberste_lage_z(netz) - 1e-9
    return float((q * zellflaechen(netz)[oben]).sum())


# ──────────────────────────────────────────────────────────────────────────
# Lasten als Volumenkraftfeld — die Form, die der Löser braucht
# ──────────────────────────────────────────────────────────────────────────


def lagen(netz: Netz) -> int:
    """
    Zahl der Elementlagen über die Grundplattendicke.

    Kommt direkt aus `netz.n_lagen` (von `vernetze()`/`vernetze_gmsh()`
    gesetzt) statt geometrisch zurückgerechnet: `Gesamtzellen / Zellen der
    obersten Lage` war nur gültig, solange jede Spalte gleich viele Lagen
    hatte. Ein Unterzug/Überzug (siehe `vernetze()`) fügt zusätzliche Zellen
    nur in einem Streifen hinzu — die Gesamtzahl wüchse, die Zahl der
    Spalten nicht, und die Division läge daneben.
    """
    return int(netz.n_lagen)


def oberste_lage_z(netz: Netz) -> float:
    """
    Elementmitten-Höhe der obersten Lage der *Grundplatte*.

    Nicht `netz.dicke` selbst: Elementmitten liegen eine halbe Lagenhöhe
    darunter — bei n Lagen sitzt die oberste Mitte bei `dicke − dz/2`. Ein
    Vergleich `mitten[:,2] >= netz.dicke` fände nichts. Von `netz.dicke`
    (statt vom tatsächlichen Netzmaximum) aus gerechnet, damit ein Überzug
    (siehe `vernetze()`) diese Referenz nicht mit anhebt.
    """
    dz = netz.dicke / netz.n_lagen
    return netz.dicke - dz / 2.0


def lagenhoehe(netz: Netz) -> float:
    """Höhe einer Elementlage in m — auch die der Zusatzlagen eines Unterzugs."""
    return float(netz.dicke) / int(netz.n_lagen)


def zellflaechen(netz: Netz) -> np.ndarray:
    """
    Grundfläche jedes Elements in m², aus seiner Unterseite gerechnet.

    **`netz.groesse²` ist dafür der falsche Wert.** `vernetze()` teilt die
    Bounding Box in ganze Zellen — `nx = round(Δx/ziel)` —, und die dabei
    entstehenden dx und dy sind nur zufällig gleich; `netz.groesse` ist das
    Maximum der beiden. Bei der L-Decke des Beispiels (12,0 × 9,0 m,
    ziel = 0,11 m) sind es dx = 0,110092 und dy = 0,109756, also 0,31 %
    Unterschied in der Fläche.

    Jede Last, die über „Kraft geteilt durch getroffene Fläche" verschmiert
    wird — Linienlast, Einzellast, Windrand, Schiefstellung —, kommt mit
    `groesse²` um genau diesen Betrag zu klein heraus. Und zwar still: die
    Gleichgewichtsprobe vergleicht den *angesetzten* Lastvektor mit den
    Auflagerkräften und bestätigt den zu kleinen Wert mit einer Abweichung von
    10⁻¹². Sichtbar wird der Fehler erst im Vergleich mit `scheibe.gesamtkraft()`,
    also mit der Last, die man aufbringen wollte.

    Für `vernetze_gmsh()` gilt dasselbe Ergebnis ohne Sonderfall: die Fläche
    kommt aus der Shoelace-Formel über die vier Unterseitenknoten und ist dort
    von Element zu Element verschieden.
    """
    ecken = netz.points[netz.cells[:, :4]][:, :, :2]        # (m, 4, 2)
    x, y = ecken[:, :, 0], ecken[:, :, 1]
    x1, y1 = np.roll(x, -1, axis=1), np.roll(y, -1, axis=1)
    return 0.5 * np.abs(np.sum(x * y1 - x1 * y, axis=1))


def zellvolumen(netz: Netz) -> np.ndarray:
    """
    Volumen jedes Elements in m³ — Grundfläche mal Lagenhöhe.

    Auch die Zusatzlagen eines Unterzugs haben die Lagenhöhe der Grundplatte
    (siehe `vernetze()`), deshalb ist ein Faktor je Element ausreichend.
    """
    return zellflaechen(netz) * lagenhoehe(netz)


def volumenlast(modell: Modell, netz: Netz, faktoren: dict[str, float],
                mit_eigengewicht: bool = True, streifen: float | None = None) -> np.ndarray:
    """
    Die Einwirkungen als elementweise Volumenkraft in kN/m³, (n_elemente, 3).

    **Warum Volumenkraft und nicht Flächenlast.** Der Löser (`ileen.loeser`)
    hält die Steifigkeitsmatrix fest und tauscht nur die rechte Seite; die Last
    muss dafür über `internal_vars` in das Problem, und das ist eine
    Volumengröße. Eine Flächenlast q wird deshalb in die oberste Elementlage
    der Höhe t = d/n gelegt: f_z = −q/t. Die Resultierende ist dieselbe, der
    Unterschied in der Spannungsverteilung bleibt auf diese eine Lage
    beschränkt und ist für Momente und Durchbiegung ohne Belang.

    Das Eigengewicht dagegen *ist* eine Volumenkraft und wird auch als solche
    angesetzt — über die volle Dicke mit der Wichte des Materials, nicht als
    verschmierte Flächenlast auf der Oberseite.

    Vorzeichen: physikalisch. Schwerkraft ist negativ in z. Die Drehung, die
    JAX-FEM verlangt, passiert erst im Löser, an genau einer Stelle.
    """
    q = lastfeld(modell, netz, faktoren, mit_eigengewicht=False, streifen=streifen)

    mitten = netz.points[netz.cells].mean(axis=1)
    # `oberste_lage_z()` statt des Netzmaximums — dieselbe Referenz wie in
    # `_anteile()` (dort baut `lastfeld()` `q` bereits auf dieser Menge auf;
    # ohne den gleichen Bezug hier stimmten die Längen nicht überein).
    oben = np.flatnonzero(mitten[:, 2] >= oberste_lage_z(netz) - 1e-9)
    hoehe = netz.dicke / lagen(netz)

    f = np.zeros((len(netz.cells), 3), dtype=float)
    f[oben, 2] = -q / hoehe
    if mit_eigengewicht:
        wichte = (netz.eg_wichte if netz.eg_wichte is not None
                  else float(modell.platte()["material"]["wichte_kNm3"]))
        f[:, 2] -= eigengewicht_beiwert(modell, faktoren) * wichte
    return f


def einzelfelder(modell: Modell, netz: Netz, streifen: float | None = None) -> dict[str, np.ndarray]:
    """
    Ein Volumenkraftfeld je Lastfall, jeweils mit dem charakteristischen Wert.

    Das ist die Grundlage der lastfallweisen Rechnung: jedes Feld wird einmal
    gelöst, die Kombinationen entstehen danach durch Überlagerung. Lastfälle,
    zu denen nichts gezeichnet wurde, fallen heraus — sonst stünde in jeder
    Auswertung eine Spalte Nullen.

    Das Eigengewicht bekommt den eigenen Schlüssel `EG`; im Plan ist es nicht
    gezeichnet, in der Kombination muss es aber einzeln gewichtet werden.
    """
    felder: dict[str, np.ndarray] = {}

    wichte = (netz.eg_wichte if netz.eg_wichte is not None
              else float(modell.platte()["material"]["wichte_kNm3"]))
    eg = np.zeros((len(netz.cells), 3), dtype=float)
    eg[:, 2] = -wichte
    felder[EIGENGEWICHT] = eg

    for fall in modell.lastfaelle:
        kennung = fall["id"]
        if not any(last["lastfall"] == kennung for last in modell.lasten):
            continue
        feld = volumenlast(modell, netz, {kennung: 1.0},
                           mit_eigengewicht=False, streifen=streifen)
        # **Nicht überschreiben, wenn die Kennung `EG` ist.** `EIGENGEWICHT`
        # ist die feste Kennung des Plattengewichts, und ein Modell darf
        # denselben Namen für einen gezeichneten Lastfall verwenden — der
        # Zeichenmodus tut es sogar. Solange darauf keine Last liegt, fällt
        # das nicht auf; sobald eine daraufliegt, verschwände das gesamte
        # Plattengewicht spurlos aus der Rechnung.
        #
        # Aufgefallen ist das am geschossweisen Lastabtrag, der die Wandlasten
        # von oben im Lastfall `EG` weiterreichte: die Lastsumme einer
        # 718-m²-Decke sank von 4 667 kN auf null, das Ergebnis blieb
        # plausibel aussehend, und erst die Erhaltungsprobe über alle
        # Geschosse zeigte den Verlust.
        #
        # Addieren ist hier auch inhaltlich richtig: was im Lastfall
        # „Eigengewicht" steht, gehört zum Eigengewicht.
        if kennung == EIGENGEWICHT:
            felder[kennung] = felder[kennung] + feld
            _merken(modell, f"Lastfall '{kennung}' trägt eigene Lasten und heißt wie das "
                            f"Eigengewicht der Platte — beide werden addiert.")
        else:
            felder[kennung] = feld
    return felder


def felder_je_lastflaeche(modell: Modell, netz: Netz, lastfall: str,
                          streifen: float | None = None) -> dict[str, np.ndarray]:
    """
    Jede einzelne Lastfläche eines Lastfalls als eigenes Feld.

    Damit wird die **ungünstige Laststellung** rechenbar: bei einer
    durchlaufenden Platte erzeugt die Nutzlast in einem Feld im Nachbarfeld ein
    Moment mit umgekehrtem Vorzeichen. Wer alle Felder gleichzeitig belastet,
    findet weder das größte Feld- noch das größte Stützmoment.

    Da das System linear ist, braucht es dafür keine Feldeinteilung und keine
    Schachbrettmuster: man löst jede Lastfläche einzeln und nimmt an jeder
    Stelle die Beiträge mit dem ungünstigen Vorzeichen zusammen — das ist die
    Auswertung über Einflussflächen und liefert die wirkliche Einhüllende,
    nicht bloß zwei geratene Lastbilder.
    """
    felder = {}
    for i, last in enumerate(modell.lasten, start=1):
        if last["lastfall"] != lastfall or last["typ"] != "flaeche":
            continue
        einzeln = Modell(daten=dict(modell.daten), quelle=modell.quelle)
        einzeln.daten = {**modell.daten, "lasten": [last]}
        felder[f"{lastfall}·{last['id']}"] = volumenlast(
            einzeln, netz, {lastfall: 1.0}, mit_eigengewicht=False, streifen=streifen)
    return felder


# ──────────────────────────────────────────────────────────────────────────
# Kombinationen
# ──────────────────────────────────────────────────────────────────────────


def kombinationen(modell: Modell) -> dict[str, dict[str, float]]:
    """
    Bemessungskombinationen nach DIN EN 1990.

    * **GZT** (ständige und vorübergehende Bemessungssituation, Gl. 6.10):
      Σ γ_G·G + γ_Q·Q_leit + Σ γ_Q·ψ₀·Q_i — je veränderlichem Lastfall eine
      Kombination mit ihm als Leiteinwirkung.
    * **GZG quasi-ständig** (Gl. 6.16b): Σ G + Σ ψ₂·Q_i — die Kombination für
      den Durchbiegungsnachweis.

    Zurück kommt für jede Kombination die Zuordnung Lastfall → Faktor, wie sie
    `lastfeld()` erwartet. Die vereinfachte Regel 6.10a/b bleibt außen vor: sie
    ist günstiger, aber ihre Anwendbarkeit hängt am Nationalen Anhang, und das
    ist keine Entscheidung, die ein Werkzeug im Hintergrund treffen sollte.
    """
    # Lastfälle ohne Einwirkung fallen heraus. Das Frontend legt fünf
    # Standardlastfälle an, gezeichnet wird meist in zweien — bliebe der Rest
    # stehen, entstünden Kombinationen, die sich nur auf dem Papier
    # unterscheiden, und `massgebend()` fiele auf die Kombination mit dem
    # größten *leeren* Lastfall herein. Lastfälle, die nicht im Plan stehen,
    # sondern gerechnet werden (Wind, Schiefstellung), tragen dafür die Marke
    # `gerechnet` — siehe `scheibe.registriere_lastfall()`.
    def wirksam(fall: dict) -> bool:
        if fall.get("gerechnet"):
            return True
        return any(last["lastfall"] == fall["id"] for last in modell.lasten)

    aktiv = [f for f in modell.lastfaelle if wirksam(f)]
    staendig = [f for f in aktiv if f.get("art") == "G"]
    veraenderlich = [f for f in aktiv if f.get("art") != "G"]

    ergebnis: dict[str, dict[str, float]] = {}
    gamma_G = float(staendig[0].get("gamma", 1.35)) if staendig else 1.35

    for leit in (veraenderlich or [None]):
        faktoren = {EIGENGEWICHT: gamma_G}
        faktoren.update({f["id"]: float(f.get("gamma", 1.35)) for f in staendig})
        for fall in veraenderlich:
            gamma = float(fall.get("gamma", 1.5))
            if leit is not None and fall["id"] == leit["id"]:
                faktoren[fall["id"]] = gamma
            else:
                faktoren[fall["id"]] = gamma * float(fall.get("psi0", 0.7))
        name = f"GZT · Leit: {leit['name']}" if leit is not None else "GZT · nur ständig"
        ergebnis[name] = faktoren

    # Gebrauchstauglichkeit, EC0 Gl. 6.14b/6.15b/6.16b. Alle drei werden
    # gebraucht: die seltene für die Spannungsbegrenzung, die häufige für die
    # Rissbreite bei Stahlbeton unter Chlorideinwirkung, die quasi-ständige für
    # Durchbiegung und den Regelfall der Rissbreite.
    for kennung, beiwert, bezeichnung in (
            ("psi0", "selten", "GZG · selten"),
            ("psi1", "häufig", "GZG · häufig"),
            ("psi2", "quasi-ständig", "GZG · quasi-ständig")):
        faktoren = {EIGENGEWICHT: 1.0}
        faktoren.update({f["id"]: 1.0 for f in staendig})
        for i, fall in enumerate(veraenderlich):
            if bezeichnung == "GZG · selten":
                faktoren[fall["id"]] = 1.0 if i == 0 else float(fall.get("psi0", 0.7))
            elif bezeichnung == "GZG · häufig":
                faktoren[fall["id"]] = (float(fall.get("psi1", 0.5)) if i == 0
                                        else float(fall.get("psi2", 0.3)))
            else:
                faktoren[fall["id"]] = float(fall.get("psi2", 0.3))
        ergebnis[bezeichnung] = faktoren

    charakteristisch = {EIGENGEWICHT: 1.0}
    charakteristisch.update({f["id"]: 1.0 for f in aktiv})
    ergebnis["charakteristisch (γ = 1,0)"] = charakteristisch

    return ergebnis


def massgebend(kombis: dict[str, dict[str, float]]) -> str:
    """Name der GZT-Kombination mit der größten Faktorensumme — als Erstwahl."""
    gzt = {k: v for k, v in kombis.items() if k.startswith("GZT")}
    return max(gzt or kombis, key=lambda k: sum((gzt or kombis)[k].values()))


# ──────────────────────────────────────────────────────────────────────────
# Randbedingungen
# ──────────────────────────────────────────────────────────────────────────


def unterseiten_knoten(netz: Netz) -> np.ndarray:
    """
    Bool-Maske: der jeweils tiefste Knoten jeder (x,y)-Spalte.

    Bei einer ebenen Platte ist das dasselbe wie `z == z.min()`. Sobald ein
    Unterzug (siehe `vernetze()`) eine Spalte lokal vertieft, liegt ihr
    tiefster Knoten dort tiefer als der Rest der Platte — für eine Bettung
    (Baugrundkontakt) oder ein Auflager ist genau diese tatsächliche
    Unterseite gemeint, nicht eine global einheitliche Höhe.
    """
    xy = netz.points[:, :2]
    z = netz.points[:, 2]
    schluessel = np.round(xy, 6)
    _, spalte = np.unique(schluessel, axis=0, return_inverse=True)
    spalte = spalte.ravel()
    tiefste = np.full(int(spalte.max()) + 1, np.inf)
    np.minimum.at(tiefste, spalte, z)
    return z <= tiefste[spalte] + 1e-9


def bettungsfedern(netz: Netz, ks_kNm3: float) -> tuple[np.ndarray, np.ndarray]:
    """
    Federsteifigkeit je Knoten für eine flächige (Winkler-)Bettung.

    Nur die Unterseiten-Knoten (`unterseiten_knoten()`) bekommen eine von
    null verschiedene Steifigkeit. Ihre Einzugsfläche kommt aus den
    angrenzenden Unterseiten-Vierecken (Shoelace-Formel je Viereck, ein
    Viertel je Eckknoten) — robust auch dort, wo das Raster durch einen
    Unterzug lokal unterbrochen ist, ohne Annahme einer einheitlichen
    Rasterweite.

    @returns (federn_z, einzugsflaeche), beide (n_knoten,) in kN/m bzw. m² —
             die Einzugsfläche wird für den Bettungsdruck (Kraft/Fläche)
             noch gebraucht und deshalb mit zurückgegeben statt ein zweites
             Mal berechnet.
    """
    unten = unterseiten_knoten(netz)
    xy = netz.points[:, :2]

    unterseiten = netz.cells[:, :4]                 # lokale Unterseite jedes Elements
    an_der_sohle = unten[unterseiten].all(axis=1)    # nur wo diese Unterseite auch die Sohle ist
    ecken = unterseiten[an_der_sohle]                # (k, 4)
    p = xy[ecken]                                    # (k, 4, 2)

    x, y = p[:, :, 0], p[:, :, 1]
    x1, y1 = np.roll(x, -1, axis=1), np.roll(y, -1, axis=1)
    flaeche = 0.5 * np.abs(np.sum(x * y1 - x1 * y, axis=1))   # Shoelace je Viereck

    einzugsflaeche = np.zeros(len(netz.points))
    np.add.at(einzugsflaeche, ecken.ravel(), np.repeat(flaeche / 4.0, 4))

    federn_z = einzugsflaeche * float(ks_kNm3)
    return federn_z, einzugsflaeche


def randbedingungen(modell: Modell, netz: Netz, toleranz: float | None = None,
                    bettung_vorhanden: bool = False):
    """
    Übersetzt die gezeichneten Auflager in `dirichlet_bc_info` für JAX-FEM.

    Die Zuordnung zum Volumenmodell:

    | Auflager im Plan | im 3D-Modell |
    |---|---|
    | gelenkig      | Unterkante entlang der Lagerlinie, nur u_z = 0 |
    | verschieblich | dasselbe — im reinen Biegemodell ununterscheidbar |
    | eingespannt   | ganze Kante über die volle Dicke, u_x = u_y = u_z = 0 |
    | elastisch     | wie gelenkig — eine echte Bettung braucht Robin-Ränder |

    **Warum das gelenkige Lager nur u_z hält.** Es liegt nahe, an der
    Auflagerlinie auch u_x und u_y zu sperren — „unverschieblich" heißt das
    Lager schließlich. Am Volumenmodell wäre das aber etwas anderes als eine
    gelenkige Plattenlagerung: die Unterkante ist dann rundum festgehalten,
    die Platte kann sich unter Last nicht mehr strecken und trägt einen
    erheblichen Teil der Last als Druckgewölbe ab. Die Durchbiegung fällt
    dadurch um eine Größenordnung zu klein aus. Diese Membranwirkung setzt man
    bei Stahlbetonplatten nicht an — sie verschwindet mit der Rissbildung.
    Also: nur die Senkung wird gehalten, die Platte darf sich in ihrer Ebene
    frei verformen.

    Der Unterschied zwischen gelenkig und eingespannt sitzt dann in der
    Höhenlage: bei der Einspannung wird die Kante über die volle Dicke
    gehalten, der Querschnitt kann sich nicht mehr verdrehen — die
    dreidimensionale Entsprechung des Momentenanschlusses.

    **Starrkörperfestlegung.** Werden nur Senkungen gehalten, bleiben
    Verschiebung in x und y sowie die Drehung um die Hochachse frei, und die
    Steifigkeitsmatrix ist singulär. Deshalb werden zusätzlich drei
    Freiheitsgrade nach der 3-2-1-Regel gesperrt: an einem Auflagerknoten u_x
    und u_y, an einem möglichst weit entfernten zweiten nur die Komponente
    quer zur Verbindungslinie. Das hält das System, ohne es zu behindern —
    die Zwangskräfte dieser drei Bindungen sind null.

    Die elastische Bettung an einem *Auflager* wird als gelenkig gerechnet
    und vermerkt: Robin-Randbedingungen führt JAX-FEM zwar, aber ihre
    Formulierung gehört ins Problem und nicht in eine Randbedingungsliste —
    das wäre eine eigene Problemklasse. Für eine *flächige* Bettung
    (Bodenplatte) gilt das nicht: die läuft nicht über diese Funktion,
    sondern als Federdiagonale im Löser (`bettungsfedern()`,
    `Loeser(..., federn_z=...)`). `bettung_vorhanden=True` sagt dieser
    Funktion nur, dass sie die z-Richtung nicht selbst über ein Dirichlet-
    Lager sichern muss — die Bettung übernimmt das. Ohne jedes Dirichlet-
    Lager fehlen sonst weiterhin die zwei Punkthaltungen gegen die
    verbleibenden Starrkörperfreiheiten in x, y und der Drehung um z; die
    liefert dann `unterseiten_knoten()` statt der sonst aus `fest_z`
    gewählten Kandidaten.
    """
    tol = float(toleranz or max(netz.groesse * 0.6, 1e-3))
    xy = netz.points[:, :2]
    unten = unterseiten_knoten(netz)

    fest_xyz = np.zeros(len(netz.points), dtype=bool)
    fest_z = np.zeros(len(netz.points), dtype=bool)

    for lager in modell.auflager:
        # Eine Knotenreihe je Lager, nicht alles im Suchradius — siehe
        # `lagerknoten()`; `tol` begrenzt nur noch den Abstand.
        nahe = lagerknoten(netz, lager, tol)

        art = lager.get("art", "gelenkig")
        if art == "eingespannt":
            fest_xyz |= nahe
        else:
            fest_z |= nahe & unten
            if art == "feder":
                _merken(modell, f"Auflager {lager['id']} ist elastisch gebettet — "
                                "hier als starr gerechnet")

    if not fest_xyz.any() and not fest_z.any() and not bettung_vorhanden:
        raise ValueError(
            "Kein Knoten wurde von einem Auflager erfasst. Liegen die Lagerlinien "
            f"auf dem Systemumriss? (Suchradius {tol:.3f} m)")

    # Doppelt gehaltene Knoten nur einmal, sonst stünde derselbe Freiheitsgrad
    # zweimal im Gleichungssystem.
    fest_z &= ~fest_xyz

    fest_x_einzeln = np.zeros(len(netz.points), dtype=bool)
    fest_y_einzeln = np.zeros(len(netz.points), dtype=bool)
    if not fest_xyz.any():
        # Ohne jedes Dirichlet-Lager (reine Flächenbettung) übernimmt die
        # Unterseite der ganzen Platte die Rolle der sonst aus `fest_z`
        # gewählten Kandidaten — die Bettung hält z selbst, hier fehlen nur
        # noch die zwei Punkthaltungen gegen die restlichen Starrkörper-
        # freiheiten.
        kandidaten = fest_z if fest_z.any() else unten
        gehalten = np.flatnonzero(kandidaten)
        punkte = xy[gehalten]
        erster = gehalten[int(np.lexsort((punkte[:, 1], punkte[:, 0]))[0])]
        abstaende = np.linalg.norm(xy[gehalten] - xy[erster], axis=1)
        zweiter = gehalten[int(np.argmax(abstaende))]
        fest_x_einzeln[erster] = True
        fest_y_einzeln[erster] = True
        # Der zweite Knoten sperrt nur die Drehung: gehalten wird die Achse, in
        # der er weiter von A entfernt ist — quer zur Verbindungslinie wäre
        # richtiger, ist aber am achsparallelen Netz dasselbe und ohne
        # schiefwinklige Bindung zu haben.
        richtung = np.abs(xy[zweiter] - xy[erster])
        if richtung[0] >= richtung[1]:
            fest_y_einzeln[zweiter] = True
        else:
            fest_x_einzeln[zweiter] = True

    def macher(maske):
        treffer = netz.points[maske]

        def ort(punkt):
            import jax.numpy as jnp
            return jnp.any(jnp.all(jnp.abs(jnp.asarray(treffer) - punkt) < 1e-8, axis=1))
        return ort

    orte, richtungen, werte = [], [], []

    def null(_punkt):
        return 0.0

    if fest_xyz.any():
        ort_xyz = macher(fest_xyz)
        orte += [ort_xyz] * 3
        richtungen += [0, 1, 2]
        werte += [null] * 3
    if fest_z.any():
        orte.append(macher(fest_z))
        richtungen.append(2)
        werte.append(null)
    for maske, richtung in ((fest_x_einzeln, 0), (fest_y_einzeln, 1)):
        if maske.any():
            orte.append(macher(maske))
            richtungen.append(richtung)
            werte.append(null)

    info = [orte, richtungen, werte]
    return info, {
        "eingespannt": int(fest_xyz.sum()),
        "senkung_gehalten": int(fest_z.sum()),
        "starrkoerper": int(fest_x_einzeln.sum() + fest_y_einzeln.sum()),
        "toleranz": tol,
    }


# ──────────────────────────────────────────────────────────────────────────
# Auswertung
# ──────────────────────────────────────────────────────────────────────────


#: HEX8-Eckenvorzeichen in meshio-Reihenfolge — Grundlage der Formfunktionen.
_ECKEN = np.array([[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
                   [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], dtype=float)


def spannungen(loesung: np.ndarray, netz: Netz, E: float, nu: float,
               im_raster: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """
    Spannungstensor im Mittelpunkt jedes Elements.

    `im_raster`: der Tensor in den Achsen des Rasters (`hauptrichtung()`),
    die Mittelpunkte bleiben in Weltkoordinaten. Bei einem gedrehten Gebäude
    sind m_x, m_y dann Momente in Richtung der Gebäudeachsen — dort liegt die
    Bewehrung, dort liegen die Unterzüge.

    Vektorisiert über alle Elemente statt in einer Schleife: bei einem Netz mit
    einigen tausend Elementen ist der Unterschied zwischen Sekunden und
    Minuten. Ausgewertet wird im Elementmittelpunkt, weil die Verzerrungen dort
    für den trilinearen Ansatz am genauesten sind (Barlow-Punkt bei reduzierter
    Integration).

    @returns (Mittelpunkte (m, 3), Spannungen (m, 3, 3)) in kN/m²
    """
    loesung = np.asarray(loesung)
    x = netz.points[netz.cells]        # (m, 8, 3)
    u = loesung[netz.cells]            # (m, 8, 3)

    # Ableitungen der Formfunktionen im Elementmittelpunkt: ∂N_i/∂ξ_j = ξ_ij / 8.
    dN = _ECKEN / 8.0                                  # (8, 3)
    jacobi = np.einsum("ij,nid->njd", dN, x)           # (m, 3, 3)
    jacobi_inv = np.linalg.inv(jacobi)
    dNdx = np.einsum("ij,ndj->nid", dN, jacobi_inv)    # (m, 8, 3)

    u_grad = np.einsum("nia,nib->nab", u, dNdx)        # (m, 3, 3)
    eps = 0.5 * (u_grad + np.transpose(u_grad, (0, 2, 1)))

    mu = E / (2.0 * (1.0 + nu))
    lam = E * nu / ((1.0 + nu) * (1.0 - 2.0 * nu))
    spur = np.trace(eps, axis1=1, axis2=2)
    sigma = lam * spur[:, None, None] * np.eye(3)[None, :, :] + 2.0 * mu * eps

    drehung = float(getattr(netz, "drehung", 0.0) or 0.0)
    if im_raster and drehung:
        c, s = np.cos(drehung), np.sin(drehung)
        R = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])   # Spalten: Rasterachsen
        sigma = np.einsum("ji,njk,kl->nil", R, sigma, R)
    return x.mean(axis=1), sigma


def schnittgroessen(loesung: np.ndarray, netz: Netz, E: float, nu: float) -> dict:
    """
    Plattenmomente m_x, m_y, m_xy in kNm je Meter.

    **Nicht an einer Faser abgelesen und nicht stumpf aufsummiert.**
    Naheliegend wäre, die Biegespannung an der Unterseite zu nehmen und mit dem
    Widerstandsmoment h²/6 zu multiplizieren. Nur liegt die Elementmitte der
    untersten Lage nicht am Rand, sondern eine halbe Elementhöhe darüber — bei
    zwei Lagen fehlt damit die Hälfte des Hebels.

    Der zweite Weg, die Definition m = ∫σ·z dz als Summe über die Lagen, hat
    einen ähnlichen Haken: die Mittelpunktregel unterschätzt ∫z²dz um genau
    1/n² — bei zwei Lagen also um ein Viertel, bei vier um 6 %. Das sieht man
    dem Ergebnis nicht an.

    Deshalb wird hier der lineare Spannungsverlauf über die Dicke im Sinne
    kleinster Quadrate angepasst und anschließend exakt integriert:
    s = Σσ_k·z_k / Σz_k², m = s · h³/12. Für den geradlinigen Anteil — und der
    trägt das Moment — ist das unabhängig von der Lagenzahl exakt.

    Bei gedrehtem Raster in dessen Achsen (`spannungen(im_raster=True)`).

    @returns dict mit `xy` (n, 2), `m_x`, `m_y`, `m_xy` (je n) und `lagen`
    """
    mitten, sigma = spannungen(loesung, netz, E, nu, im_raster=True)
    # Bezug ist die Mitte der *Grundplatte* (dicke/2), nicht das Mittel aus
    # dem tatsächlichen Netzminimum/-maximum: mit einem Unterzug/Überzug
    # (siehe `vernetze()`) reicht das Netz über die Grundplatte hinaus, und
    # der Hebel jeder — auch jeder gewöhnlichen — Säule läge daneben.
    z_mitte = netz.dicke / 2.0
    hebel = mitten[:, 2] - z_mitte

    # Elemente derselben Säule zusammenfassen: gleiche (x, y), verschiedene z.
    schluessel = np.round(mitten[:, :2], 6)
    _, index, umkehr = np.unique(schluessel, axis=0, return_index=True, return_inverse=True)
    lagen = int(netz.n_lagen)

    traegheit = netz.dicke ** 3 / 12.0      # je Meter Plattenbreite
    nenner = np.zeros(len(index))
    np.add.at(nenner, umkehr, hebel ** 2)

    # **Eine Lage über die Dicke hat keinen Hebel.** Die Elementmitte liegt dann
    # genau in der Mittelebene, hebel = 0, und die Anpassung des
    # Spannungsverlaufs hat nichts anzupassen: Σσ·z = 0 und Σz² = 0. Ein
    # Auffangen der Division (`nenner = 1`) machte daraus stillschweigend
    # m = 0 — für *jedes* Element, in jeder Kombination. Das Ergebnis sieht
    # aus wie eine Rechnung und ist keine: die Bewehrung fällt danach überall
    # auf die Mindestbewehrung, die Ausnutzung der Biegung auf null, und im
    # Bild ist eine leere Fläche von einer schwach beanspruchten nicht zu
    # unterscheiden. Deshalb bricht es hier ab, statt Nullen zu liefern.
    if not np.any(nenner > 1e-15):
        raise ValueError(
            f"Die Platte ist mit {lagen} Elementlage über die Dicke vernetzt. Die "
            f"Elementmitte liegt damit in der Mittelebene, der Hebel ist null und "
            f"jedes Moment käme als exakte Null heraus. Mindestens zwei Lagen "
            f"vernetzen: plate.vernetze(modell, lagen=2)."
        )
    nenner = np.where(nenner < 1e-15, 1.0, nenner)

    def integriere(komponente):
        zaehler = np.zeros(len(index))
        np.add.at(zaehler, umkehr, komponente * hebel)
        return zaehler / nenner * traegheit

    m_x = -integriere(sigma[:, 0, 0])
    m_y = -integriere(sigma[:, 1, 1])
    m_xy = -integriere(sigma[:, 0, 1])

    # Innerhalb eines Unterzugs/Überzugs ist `traegheit = dicke³/12` die
    # falsche Größe — das Plattenmoment „je Meter Breite" ist dort keine
    # sinnvolle Auswertung mehr. Die richtige ist das über den ganzen
    # Balkenquerschnitt integrierte Biegemoment: die rechnet `unterzug.py`,
    # und die Bewehrung des Streifens kommt von dort. Hier steht deshalb NaN
    # statt einer stillen Falschzahl — `zeichnen.karte()` lässt die Stelle aus.
    #
    # **NaN ist ansteckend.** np.percentile, np.argmax und np.maximum geben es
    # weiter, und eine einzige NaN-Stelle macht aus der Bewehrungsfläche der
    # ganzen Decke NaN. Alle Auswertungen dieses Moduls sind deshalb
    # NaN-tolerant (`einhuellende()`, `hoechstwert()`), und die Maske kommt
    # als `im_balken` mit heraus, damit ein Aufrufer sie ausdrücklich
    # ausnehmen kann statt sich auf np.nan* zu verlassen.
    im_balken = balkenmaske(netz, umkehr, len(index))
    if im_balken.any():
        m_x = np.where(im_balken, np.nan, m_x)
        m_y = np.where(im_balken, np.nan, m_y)
        m_xy = np.where(im_balken, np.nan, m_xy)

    return {
        "xy": mitten[index][:, :2],
        # Vorzeichen so, dass ein positives Moment Zug an der Unterseite bedeutet
        # — die Konvention der Bewehrungswahl.
        "m_x": m_x, "m_y": m_y, "m_xy": m_xy,
        "im_balken": im_balken,
        "lagen": lagen,
    }


def spalten(netz: Netz):
    """
    Die (x,y)-Säulen des Netzes: ein Eintrag je Grundriss-Stelle.

    Alle Auswertungen über die Dicke — Momente, Querkräfte, Membrankräfte —
    fassen die Elemente derselben Säule zusammen. Diese Zuordnung einmal an
    einer Stelle, damit `schnittgroessen()`, `querkraefte()` und
    `scheibe.membrankraefte()` garantiert dieselbe Reihenfolge liefern; das
    Notebook verlässt sich darauf, wenn es Moment und Normalkraft am selben
    Querschnitt bemisst.

    @returns (index, umkehr, anzahl) — `index` zeigt je Säule auf ein
             Beispielelement, `umkehr` ordnet jedem Element seine Säule zu
    """
    mitten = netz.points[netz.cells].mean(axis=1)
    _, index, umkehr = np.unique(np.round(mitten[:, :2], 6), axis=0,
                                 return_index=True, return_inverse=True)
    umkehr = umkehr.ravel()
    anzahl = np.zeros(len(index))
    np.add.at(anzahl, umkehr, 1.0)
    return index, umkehr, anzahl


def balkenmaske(netz: Netz, umkehr: np.ndarray | None = None,
                n_spalten: int | None = None) -> np.ndarray:
    """
    Bool je Säule: liegt sie in einem Unterzug/Überzug?

    Die Maske ist auf `schnittgroessen()['xy']` bezogen, nicht auf die
    Elemente. Sie ist die Grenze zwischen den beiden Bemessungen: außerhalb
    bemisst `beton.biegebemessung()` die Platte je Meter, innerhalb bemisst
    `unterzug.bemessung()` den Balkenquerschnitt als Ganzes.
    """
    if umkehr is None or n_spalten is None:
        index, umkehr, _ = spalten(netz)
        n_spalten = len(index)
    balken_spalten = getattr(netz, "balken_spalten", None)
    maske = np.zeros(int(n_spalten), dtype=bool)
    if balken_spalten is not None and len(balken_spalten) and np.any(balken_spalten):
        np.logical_or.at(maske, umkehr, np.asarray(balken_spalten, dtype=bool))
    return maske


def hoechstwert(werte: np.ndarray, perzentil: float | None = None) -> float:
    """
    Größtwert eines Ergebnisfelds, das NaN enthalten darf.

    Ein Feld mit Unterzug hat NaN im Balkenstreifen (siehe
    `schnittgroessen()`), und `np.max`/`np.percentile` geben das ungefiltert
    weiter — die Bemessungstabelle stünde danach voller NaN, ohne dass die
    Rechnung selbst etwas falsch gemacht hätte. Mit `perzentil` wird statt des
    Größtwerts das entsprechende Perzentil genommen, also der Wert, mit dem
    man die Fläche bewehrt, statt der Singularitätsspitze.

    Ein Feld, das *nur* aus NaN besteht, liefert 0,0 statt einer Ausnahme:
    das ist der Fall „diese Lage kommt in dieser Platte nicht vor", und der
    darf keine Rechnung abbrechen.
    """
    w = np.asarray(werte, dtype=float)
    gueltig = w[np.isfinite(w)]
    if not len(gueltig):
        return 0.0
    return float(np.percentile(gueltig, perzentil) if perzentil is not None
                 else gueltig.max())


def spannweite(modell: Modell | None, netz: Netz) -> float:
    """
    Die maßgebende Stützweite für den Durchbiegungsnachweis.

    **Die Abmessung des Umrisses ist der falsche Wert**, sobald die Platte
    Innenwände oder Stützen hat: eine 12 m lange Decke mit Mittelwand hat zwei
    Felder von 6 m, und mit l = 12 m wäre der zulässige Wert doppelt so groß
    wie zulässig.

    Deshalb wird gemessen, was die Platte wirklich zu überbrücken hat: der
    größte Abstand eines Punktes zum nächstgelegenen Auflager, verdoppelt. Bei
    einem Einfeldträger ist das genau die Stützweite, bei zwei Feldern die
    Feldweite, bei einer Flachdecke die Diagonale zwischen den Stützen. Ohne
    Auflagerangaben bleibt es bei der kürzeren Seite des Umrisses.
    """
    if modell is None or not modell.auflager:
        return float(min(netz.polygon.max(axis=0) - netz.polygon.min(axis=0)))

    xy = netz.points[:, :2]
    abstand = np.full(len(xy), np.inf)
    for lager in modell.auflager:
        if lager["typ"] == "punkt":
            hier = np.linalg.norm(xy - np.asarray(lager["p"], dtype=float), axis=1)
        else:
            hier = abstand_zu_polylinie(xy, np.asarray(lager["polylinie"], dtype=float))
        abstand = np.minimum(abstand, hier)
    return float(2.0 * abstand.max())


def durchbiegung(loesung: np.ndarray, netz: Netz, modell: Modell | None = None,
                 grenze: float = 250.0) -> dict:
    """
    Größte Absenkung und ihr Ort, dazu der Grenzwert l/250.

    Die Stützweite kommt aus `spannweite()` — mit `modell` aus der Lage der
    Auflager, ohne es aus dem Umriss. Der Grenzwert l/250 gilt für die
    quasi-ständige Kombination; für Bauteile unter empfindlichen Trennwänden
    verlangt EC2 zusätzlich l/500 nach dem Einbau (`grenze=500`).
    """
    uz = np.asarray(loesung)[:, 2]
    i = int(np.argmin(uz))
    weite = spannweite(modell, netz)
    grenzwert = weite / grenze * 1000
    return {
        "w_max_mm": float(-uz[i] * 1000),
        "ort": netz.points[i].tolist(),
        "spannweite_m": weite,
        "grenzwert_mm": grenzwert,
        "ausnutzung": float(-uz[i] * 1000) / grenzwert,
    }


def querkraefte(loesung: np.ndarray, netz: Netz, E: float, nu: float) -> dict:
    """
    Plattenquerkräfte v_x, v_y in kN je Meter.

    Integriert werden die Schubspannungen über die Dicke: v_x = ∫τ_xz dz,
    näherungsweise als Summe über die Elementlagen. Das ist die grobe Größe im
    ganzen Modul — HEX8-Elemente liefern τ_xz elementweise konstant, während
    der wirkliche Verlauf parabolisch ist, und mit zwei Lagen über die Dicke
    bleibt davon wenig übrig.

    **Deshalb ist der maßgebende Wert für den Querkraftnachweis nicht dieser
    hier, sondern die Auflagerkraft.** Am Auflagerrand — genau dort, wo v_Ed
    nachzuweisen ist — steht sie exakt zur Verfügung: `auflagerbilanz()` gibt
    sie je Meter Lagerlinie. Das Feld hier zeigt, wo die Querkraft herkommt und
    wie sie sich verteilt; nachgewiesen wird mit der Bilanz.

    @returns dict mit `xy`, `v_x`, `v_y`, `v_res` (Betrag) — v_x, v_y in den
             Achsen des Rasters
    """
    mitten, sigma = spannungen(loesung, netz, E, nu, im_raster=True)
    schluessel = np.round(mitten[:, :2], 6)
    _, index, umkehr = np.unique(schluessel, axis=0, return_index=True, return_inverse=True)
    hoehe = netz.dicke / lagen(netz)

    def summiere(komponente):
        werte = np.zeros(len(index))
        np.add.at(werte, umkehr, komponente * hoehe)
        return werte

    v_x = summiere(sigma[:, 0, 2])
    v_y = summiere(sigma[:, 1, 2])

    # Wie in `schnittgroessen()`: „je Meter Breite" ist innerhalb eines
    # Unterzugs/Überzugs keine sinnvolle Auswertung — die Querkraft des Balkens
    # rechnet `unterzug.querkraft()` über den ganzen Steg.
    im_balken = balkenmaske(netz, umkehr, len(index))
    if im_balken.any():
        v_x = np.where(im_balken, np.nan, v_x)
        v_y = np.where(im_balken, np.nan, v_y)

    return {"xy": mitten[index][:, :2], "v_x": v_x, "v_y": v_y,
            "v_res": np.hypot(v_x, v_y), "im_balken": im_balken}


def querkraefte_aus_momenten(schnitt: dict, netz: Netz) -> dict:
    """
    Querkräfte aus dem Gleichgewicht der Plattenschnittgrößen.

        v_x = ∂m_x/∂x + ∂m_xy/∂y ,   v_y = ∂m_y/∂y + ∂m_xy/∂x

    Das ist der Weg, den Plattenprogramme gehen, und er ist dem Integrieren der
    Schubspannungen deutlich überlegen: die Momente sind die zuverlässigste
    Größe des Modells, ihre Ableitung auf einem achsparallelen Raster eine
    zentrale Differenz. Voraussetzung ist genau dieses Raster — bei
    `vernetze_gmsh()` liefert nur `querkraefte()` ein Ergebnis.

    Am Auflagerrand bleibt beides ungenau: dort hat die Lösung eine
    Singularität, weil das Lager nur die Unterkante hält. Der Bemessungswert
    kommt aus `auflagerbilanz()`.

    Bei gedrehtem Raster wird in seinen Achsen abgeleitet — dort stehen die
    Momente (`schnittgroessen()`) —, Raster und Pfeile kommen in
    Weltkoordinaten zurück.

    @returns dict mit `X`, `Y` (Raster) sowie `v_x`, `v_y`, `v_res` darauf
    """
    xy_r = netz.lokal(schnitt["xy"])
    polygon_r = netz.lokal(netz.polygon)
    loecher_r = [netz.lokal(l) for l in netz.loecher]
    X, Y, m_x = auf_raster(xy_r, schnitt["m_x"], polygon=polygon_r, loecher=loecher_r)
    _, _, m_y = auf_raster(xy_r, schnitt["m_y"], polygon=polygon_r, loecher=loecher_r)
    _, _, m_xy = auf_raster(xy_r, schnitt["m_xy"], polygon=polygon_r, loecher=loecher_r)

    dx = float(X[0, 1] - X[0, 0]) if X.shape[1] > 1 else 1.0
    dy = float(Y[1, 0] - Y[0, 0]) if Y.shape[0] > 1 else 1.0

    # Löcher (NaN) würden sich beim Ableiten über zwei Reihen ausbreiten;
    # deshalb wird auf null gesetzt und die Maske hinterher wieder aufgelegt.
    maske = np.isnan(m_x)
    füllen = lambda a: np.nan_to_num(a, nan=0.0)
    dmx_dx = np.gradient(füllen(m_x), dx, axis=1)
    dmy_dy = np.gradient(füllen(m_y), dy, axis=0)
    dmxy_dx = np.gradient(füllen(m_xy), dx, axis=1)
    dmxy_dy = np.gradient(füllen(m_xy), dy, axis=0)

    v_x = np.where(maske, np.nan, dmx_dx + dmxy_dy)
    v_y = np.where(maske, np.nan, dmy_dy + dmxy_dx)
    drehung = float(getattr(netz, "drehung", 0.0) or 0.0)
    if drehung:
        c, s = np.cos(drehung), np.sin(drehung)
        X, Y = c * X - s * Y, s * X + c * Y
        v_x, v_y = c * v_x - s * v_y, s * v_x + c * v_y
    return {"X": X, "Y": Y, "v_x": v_x, "v_y": v_y, "v_res": np.hypot(v_x, v_y)}


def hauptmomente(m_x: np.ndarray, m_y: np.ndarray, m_xy: np.ndarray) -> dict:
    """
    Hauptmomente und ihre Richtung — der Mohrsche Kreis der Platte.

        m_1,2 = (m_x + m_y)/2 ± √( ((m_x − m_y)/2)² + m_xy² )
        tan 2φ = 2·m_xy / (m_x − m_y)

    m_1 ist das größere (algebraisch), φ sein Winkel gegen die x-Achse im
    Bogenmaß. Die Richtungen sind die Momententrajektorien: legte man die
    Bewehrung entlang ihnen, käme man mit dem wenigsten Stahl aus. Man tut es
    nicht, weil orthogonale Netze billiger zu verlegen sind als gekrümmte
    Scharen — aber das Bild zeigt, wie die Platte trägt, und verrät auf einen
    Blick, ob sie ein- oder zweiachsig spannt.
    """
    mitte = (m_x + m_y) / 2.0
    spanne = np.sqrt(((m_x - m_y) / 2.0) ** 2 + m_xy ** 2)
    return {"m_1": mitte + spanne, "m_2": mitte - spanne,
            "phi": 0.5 * np.arctan2(2.0 * m_xy, m_x - m_y)}


def ins_raster(m_x, m_y, m_xy, drehung: float):
    """
    Momente (oder Membrankräfte) aus Weltachsen in die Achsen des Rasters.

    Bei einem gedrehten Gebäude (`hauptrichtung()`) liegt die Bewehrung in
    den Gebäudeachsen, nicht in x und y des Projektsystems. Wood–Armer gilt
    für jedes Paar orthogonaler Richtungen — in Weltachsen bemessen wäre es
    sicher, aber eine Bewehrung schräg zu allen Wänden.

    @returns (m_x', m_y', m_xy'); bei `drehung == 0` unverändert dieselben Felder
    """
    if not drehung:
        return m_x, m_y, m_xy
    c, s = float(np.cos(drehung)), float(np.sin(drehung))
    m_x, m_y, m_xy = (np.asarray(v, dtype=float) for v in (m_x, m_y, m_xy))
    return (m_x * c * c + m_y * s * s + 2.0 * s * c * m_xy,
            m_x * s * s + m_y * c * c - 2.0 * s * c * m_xy,
            (m_y - m_x) * s * c + m_xy * (c * c - s * s))


def huelle_ins_raster(huelle: dict, drehung: float, lage: str):
    """
    Die Einhüllende (je Komponente max/min aus verschiedenen Kombinationen) in
    den Achsen des Rasters — auf der sicheren Seite: der Drillanteil geht mit
    seinem größten Betrag und dem ungünstigen Vorzeichen ein.

    @param lage  "max" (untere Bewehrung) oder "min" (obere)
    """
    m_x, m_y, m_xy = huelle["m_x"][lage], huelle["m_y"][lage], huelle["m_xy"][lage]
    if not drehung:
        return m_x, m_y, m_xy
    c, s = float(np.cos(drehung)), float(np.sin(drehung))
    drill = np.maximum(np.abs(huelle["m_xy"]["max"]), np.abs(huelle["m_xy"]["min"]))
    vorzeichen = 1.0 if lage == "max" else -1.0
    _, _, m_xy_r = ins_raster(m_x, m_y, m_xy, drehung)
    return (m_x * c * c + m_y * s * s + vorzeichen * 2.0 * s * c * drill,
            m_x * s * s + m_y * c * c + vorzeichen * 2.0 * s * c * drill,
            m_xy_r)


def bemessungsmomente(m_x: np.ndarray, m_y: np.ndarray, m_xy: np.ndarray) -> dict:
    """
    Bemessungsmomente nach Wood und Armer, getrennt für beide Bewehrungslagen.

    **Warum m_xy nicht verschwinden darf.** Die Bewehrung liegt orthogonal, das
    Drillmoment m_xy aber wird von ihr nicht direkt aufgenommen. Es muss auf die
    beiden Richtungen umgelegt werden — sonst fehlt genau dort Bewehrung, wo
    zwei Ränder aufeinandertreffen: in den Ecken einer zweiachsig gespannten
    Platte ist m_x und m_y klein und m_xy groß, und eine Bemessung allein nach
    m_x und m_y ließe die Ecke unbewehrt.

    Der Regelfall ist einfach:

        untere Bewehrung: m_x* = m_x + |m_xy| ,  m_y* = m_y + |m_xy|
        obere Bewehrung:  m_x* = m_x − |m_xy| ,  m_y* = m_y − |m_xy|

    Wird eine der beiden Größen dabei negativ, wird sie zu null gesetzt und der
    Rest der anderen Richtung zugeschlagen (m* = m ± m_xy²/|m|) — sonst würde
    man in der einen Richtung Bewehrung sparen, die in der anderen fehlt.

    @returns dict mit `m_x_unten`, `m_y_unten` (Zug unten, positiv anzusetzen)
             und `m_x_oben`, `m_y_oben` (Zug oben, als Betrag)
    """
    betrag = np.abs(m_xy)

    # Untere Lage: positive Momente
    mx_u = m_x + betrag
    my_u = m_y + betrag
    sicher_x = np.where(np.abs(m_x) < 1e-12, 1e-12, np.abs(m_x))
    sicher_y = np.where(np.abs(m_y) < 1e-12, 1e-12, np.abs(m_y))
    x_frei = mx_u < 0
    my_u = np.where(x_frei, m_y + m_xy ** 2 / sicher_x, my_u)
    mx_u = np.where(x_frei, 0.0, mx_u)
    y_frei = (~x_frei) & (my_u < 0)
    mx_u = np.where(y_frei, m_x + m_xy ** 2 / sicher_y, mx_u)
    my_u = np.where(y_frei, 0.0, my_u)

    # Obere Lage: negative Momente, als Betrag geführt
    mx_o = -(m_x - betrag)
    my_o = -(m_y - betrag)
    x_frei_o = mx_o < 0
    my_o = np.where(x_frei_o, -(m_y - m_xy ** 2 / sicher_x), my_o)
    mx_o = np.where(x_frei_o, 0.0, mx_o)
    y_frei_o = (~x_frei_o) & (my_o < 0)
    mx_o = np.where(y_frei_o, -(m_x - m_xy ** 2 / sicher_y), mx_o)
    my_o = np.where(y_frei_o, 0.0, my_o)

    return {
        "m_x_unten": np.maximum(mx_u, 0.0), "m_y_unten": np.maximum(my_u, 0.0),
        "m_x_oben": np.maximum(mx_o, 0.0), "m_y_oben": np.maximum(my_o, 0.0),
    }


def einhuellende(werte_je_kombination: dict[str, np.ndarray]) -> dict:
    """
    Größt- und Kleinstwert an jeder Stelle über alle Kombinationen.

    Zurück kommen neben den Werten auch die Namen der Kombinationen, die sie
    erzeugt haben — ohne die weiß man am Ende, wie groß das Moment ist, aber
    nicht, woher es kommt, und kann die Zahl niemandem erklären.

    **NaN-Stellen bleiben NaN, verderben aber nichts.** Im Streifen eines
    Unterzugs liefert `schnittgroessen()` bewusst NaN (dort bemisst
    `unterzug.py`), und `np.max`/`np.argmax` würden das auf die ganze Spalte
    ausdehnen. `np.nanmax` löst es an den gemischten Stellen und warnt an den
    durchgehend leeren; deshalb wird die Warnung hier gezielt unterdrückt und
    die Stelle bleibt NaN — genau die Aussage, die gemeint ist.
    """
    namen = list(werte_je_kombination)
    stapel = np.stack([np.asarray(werte_je_kombination[n], dtype=float) for n in namen])
    leer = np.all(np.isnan(stapel), axis=0)
    gefuellt = np.where(leer, 0.0, stapel)          # nur damit nanmax nicht warnt
    hoch, tief = np.nanmax(gefuellt, axis=0), np.nanmin(gefuellt, axis=0)
    i_max = np.nanargmax(gefuellt, axis=0)
    i_min = np.nanargmin(gefuellt, axis=0)
    return {
        "max": np.where(leer, np.nan, hoch), "min": np.where(leer, np.nan, tief),
        "max_aus": [namen[i] for i in np.atleast_1d(i_max)],
        "min_aus": [namen[i] for i in np.atleast_1d(i_min)],
        "kombinationen": namen,
    }


def ungünstig(beitraege: dict[str, np.ndarray], staendig: set[str],
              faktor_veraenderlich: float = 1.5, faktor_staendig: float = 1.35,
              faktor_staendig_guenstig: float = 1.0) -> dict:
    """
    Ungünstigste Laststellung, punktweise aus Einflussbeiträgen.

    Bei linearem Verhalten gilt: der größte Wert an einer Stelle entsteht, wenn
    jede *veränderliche* Einwirkung genau dann angesetzt wird, wenn ihr Beitrag
    dort das gesuchte Vorzeichen hat. Für ständige Einwirkungen gibt es diese
    Wahl nicht — sie sind immer da, dürfen aber je nach Wirkung mit γ = 1,35
    oder 1,0 angesetzt werden.

        max = Σ_G γ_ungünstig·g_i  +  Σ_Q γ_Q·max(q_i, 0)
        min = Σ_G γ_günstig·g_i    +  Σ_Q γ_Q·min(q_i, 0)

    Das ist die Auswertung über Einflussflächen und ersetzt jedes geratene
    Schachbrettmuster — vorausgesetzt, die Lastflächen im Plan entsprechen den
    Feldern, was bei raumweise gezeichneten Nutzlasten von selbst der Fall ist.
    """
    beispiel = next(iter(beitraege.values()))
    hoch = np.zeros_like(np.asarray(beispiel, dtype=float))
    tief = np.zeros_like(hoch)

    for name, wert in beitraege.items():
        w = np.asarray(wert, dtype=float)
        if name in staendig:
            hoch += np.where(w >= 0, faktor_staendig * w, faktor_staendig_guenstig * w)
            tief += np.where(w <= 0, faktor_staendig * w, faktor_staendig_guenstig * w)
        else:
            hoch += faktor_veraenderlich * np.maximum(w, 0.0)
            tief += faktor_veraenderlich * np.minimum(w, 0.0)
    return {"max": hoch, "min": tief}


# ──────────────────────────────────────────────────────────────────────────
# Auflager, Raster, Schnitte
# ──────────────────────────────────────────────────────────────────────────


def auflagerbilanz(modell: Modell, netz: Netz, reaktionen: np.ndarray,
                   toleranz: float | None = None) -> list[dict]:
    """
    Auflagerkräfte je gezeichnetem Lager, samt Kraft je Meter Lagerlinie.

    Die Zuordnung läuft über denselben Suchradius wie `randbedingungen()`;
    Knoten, die zu zwei Lagern gehören (an Ecken), werden anteilig geteilt,
    damit die Summe stimmt. Die Linienlast R/l ist der Wert, mit dem die
    darunterliegende Wand bemessen wird — und zugleich der Bemessungswert der
    Querkraft am Auflagerrand.
    """
    tol = float(toleranz or max(netz.groesse * 0.6, 1e-3))
    xy = netz.points[:, :2]
    R = np.asarray(reaktionen)

    masken = []
    for lager in modell.auflager:
        # Dieselben Knoten wie in `randbedingungen()` — sonst fiele eine
        # gehaltene Reihe aus der Bilanz oder eine freie käme hinein.
        nahe = lagerknoten(netz, lager, tol)
        if lager["typ"] == "punkt":
            laenge = 0.0
        else:
            linie = np.asarray(lager["polylinie"], dtype=float)
            laenge = float(np.sum(np.linalg.norm(np.diff(linie, axis=0), axis=1)))
        masken.append((lager, nahe, laenge))

    mehrfach = np.zeros(len(xy))
    for _, nahe, _ in masken:
        mehrfach += nahe
    anteil = np.where(mehrfach > 0, 1.0 / np.maximum(mehrfach, 1), 0.0)

    bilanz = []
    for lager, nahe, laenge in masken:
        kraft = (R * (nahe * anteil)[:, None]).sum(axis=0)
        bilanz.append({
            "id": lager["id"], "typ": lager["typ"], "art": lager.get("art", "gelenkig"),
            "knoten": int(nahe.sum()), "laenge_m": laenge,
            "R_x_kN": float(kraft[0]), "R_y_kN": float(kraft[1]), "R_z_kN": float(kraft[2]),
            # `None` und nicht NaN: ein Punktlager hat keine Lagerlinie, also
            # auch keine Kraft je Meter. NaN wäre dasselbe gemeint, überlebt
            # aber die Ablage nicht — `json.dumps` schreibt dafür das Literal
            # `NaN`, das kein strenger Leser annimmt, und FastAPI bricht beim
            # Ausliefern mit „Out of range float values" ab. Im Browser kam
            # davon nur „Failed to fetch" an.
            "R_je_m_kNm": float(kraft[2] / laenge) if laenge > 1e-9 else None,
            "bauteile": lager.get("bauteile", []),
            # GlobalId → Achslänge, bei zusammengeführten Lagern. Ohne sie
            # teilte `lastabtrag.aus_auflagerbilanz()` die Kraft gleichmäßig,
            # und ein 2-m-Stück bekäme so viel wie ein 12-m-Stück.
            "bauteil_anteile": lager.get("bauteil_anteile") or {},
        })
    return bilanz


def rasterlinie(netz: Netz, punkt, achse: int) -> tuple[tuple, tuple]:
    """
    Anfang und Ende einer Schnittlinie durch `punkt`, parallel zur
    Rasterachse `achse` (0 = x', 1 = y'), über die ganze Platte — in
    Weltkoordinaten. Bei ungedrehtem Raster eine Linie parallel zu x bzw. y.
    """
    ort = netz.lokal(np.asarray(punkt, dtype=float)[None, :2])[0]
    umriss = netz.lokal(netz.polygon)
    a, b = ort.copy(), ort.copy()
    a[achse], b[achse] = float(umriss[:, achse].min()), float(umriss[:, achse].max())
    c, s = np.cos(netz.drehung), np.sin(netz.drehung)

    def welt(q):
        return (float(c * q[0] - s * q[1]), float(s * q[0] + c * q[1]))
    return welt(a), welt(b)


def auf_raster(xy: np.ndarray, werte: np.ndarray, schritt: float | None = None,
               polygon: np.ndarray | None = None,
               loecher: list[np.ndarray] | None = None):
    """
    Streuwerte auf ein regelmäßiges Raster — für Konturbilder und Schnitte.

    Die Elementwerte einer Rasternetzrechnung liegen bereits regelmäßig; das
    Umsortieren macht sie trotzdem erst brauchbar, weil außerhalb des Umrisses
    Löcher bleiben (NaN), die matplotlib dann sauber freilässt statt sie
    zuzuinterpolieren.

    @returns (X, Y, Z) wie von `np.meshgrid`, Z mit NaN außerhalb
    """
    xy = np.asarray(xy, dtype=float)
    werte = np.asarray(werte, dtype=float)
    abstaende = [np.diff(np.unique(np.round(xy[:, k], 6))) for k in (0, 1)]
    gleichmaessig = all(len(d) == 0 or float(d.max()) <= float(d.min()) * 1.01 + 1e-9
                        for d in abstaende)
    if schritt is None:
        d = abstaende[0]
        schritt = float(np.min(d)) if len(d) else 1.0
        if not gleichmaessig and len(d):
            # Rasterlinien auf Lagerachsen (`vernetze()`) machen einzelne
            # Zellen schmal; die kleinste als Bildraster vervielfachte die
            # Pixel, ohne etwas zu zeigen.
            schritt = float(np.median(d))

    x = np.arange(xy[:, 0].min(), xy[:, 0].max() + schritt / 2, schritt)
    y = np.arange(xy[:, 1].min(), xy[:, 1].max() + schritt / 2, schritt)
    X, Y = np.meshgrid(x, y)
    Z = np.full(X.shape, np.nan)

    if gleichmaessig:
        i = np.clip(np.round((xy[:, 0] - x[0]) / schritt).astype(int), 0, len(x) - 1)
        j = np.clip(np.round((xy[:, 1] - y[0]) / schritt).astype(int), 0, len(y) - 1)
        Z[j, i] = werte
    elif len(xy):
        # Ungleichmäßige Zellen: je Bildpunkt der Wert der nächsten
        # Elementmitte, höchstens eine größte Zellweite entfernt.
        from scipy.spatial import cKDTree
        weite = max(float(abstaende[0].max()) if len(abstaende[0]) else schritt,
                    float(abstaende[1].max()) if len(abstaende[1]) else schritt)
        abstand, nummer = cKDTree(xy).query(np.stack([X.ravel(), Y.ravel()], axis=1))
        flach = np.where(abstand <= weite, werte[nummer], np.nan)
        Z = flach.reshape(X.shape)

    if polygon is not None:
        punkte = np.stack([X.ravel(), Y.ravel()], axis=1)
        drin = innen(punkte, polygon)
        # Öffnungen bleiben leer, statt zugemalt zu werden. Ohne das legt
        # matplotlib eine Fläche über das Treppenauge, und die Karte zeigt
        # Momente, wo keine Decke ist.
        for loch in (loecher or []):
            drin &= ~innen(punkte, loch)
        Z = np.where(drin.reshape(X.shape), Z, np.nan)
    return X, Y, Z


def entlang(xy: np.ndarray, werte: np.ndarray, a, b, n: int = 200,
            netz: Netz | None = None, max_abstand: float | None = None):
    """
    Werte entlang einer Schnittlinie von a nach b.

    Interpoliert wird mit dem Mittel der vier nächsten Nachbarn, gewichtet mit
    dem Kehrwert des Abstands — das kommt ohne Triangulierung aus und ist für
    Momentenverläufe und Zugkraftdeckungslinien genau genug.

    **Außerhalb der Platte kommt NaN.** Ohne diese Grenze greift die
    Nachbarsuche über einen einspringenden Rand hinweg und malt eine
    Momentenlinie in einen Bereich, in dem gar keine Decke liegt — im Bild
    sieht das aus wie ein Ergebnis. Der Abbruch erfolgt, sobald der nächste
    Nachbar weiter als anderthalb Elementbreiten entfernt ist (oder außerhalb
    des Umrisses liegt, wenn `netz` mitgegeben wird).

    @returns (s, werte_auf_der_linie) mit s als Länge ab a in m
    """
    from scipy.spatial import cKDTree

    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    s = np.linspace(0.0, 1.0, n)
    punkte = a + s[:, None] * (b - a)
    laenge = float(np.linalg.norm(b - a))

    xy = np.asarray(xy, dtype=float)
    baum = cKDTree(xy)
    abstand, index = baum.query(punkte, k=4)
    gewicht = 1.0 / np.maximum(abstand, 1e-9)
    gewicht /= gewicht.sum(axis=1, keepdims=True)
    ergebnis = (np.asarray(werte, dtype=float)[index] * gewicht).sum(axis=1)

    grenze = max_abstand
    if grenze is None:
        grenze = 1.5 * (netz.groesse if netz is not None else float(np.median(abstand[:, 0])) * 2)
    draussen = abstand[:, 0] > grenze
    if netz is not None:
        draussen |= ~netz.auf_platte(punkte)
    return s * laenge, np.where(draussen, np.nan, ergebnis)


def positionsbezug(modell: Modell) -> dict[str, list[str]]:
    """GlobalId → Positionen, für die Rückgabe der Ergebnisse an das BIM-Modell."""
    zuordnung: dict[str, list[str]] = {}
    for position in modell.positionen:
        for global_id in position.get("bauteile", []):
            zuordnung.setdefault(global_id, []).append(position["id"])
    return zuordnung
