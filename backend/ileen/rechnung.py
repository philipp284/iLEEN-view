"""
Der Ablauf aus `notebooks/iLEEN_Plattenstatik.ipynb`, als Funktion.

Das Notebook ist die Werkstatt: dort wird ein Modell aufgeschlagen, an einer
Zahl gedreht und die Wirkung im nächsten Bild angesehen. Dieses Modul ist
dasselbe Rechenwerk ohne Werkstatt — angestoßen aus dem Zeichenmodus, die
Bilder als PNG neben dem Bericht abgelegt, sodass der Plan sie wieder anzeigen
kann.

**Was hier anders ist als im Notebook**, und warum:

* **Kein `plt.show()`, sondern Agg.** Es gibt keinen Bildschirm im Container.
  Jede Figur wird geschrieben und sofort geschlossen; matplotlib hält sonst
  jede offene Figur bis zum Prozessende im Speicher, und eine Decke bringt
  über zwanzig davon mit.
* **Jeder Abschnitt darf einzeln scheitern.** Im Notebook bricht eine Zelle ab
  und man rechnet die nächste trotzdem. Hier übernimmt das `_versuche()`: was
  nicht geht, steht als Hinweis im Bericht, der Rest wird fertig gerechnet.
  Eine Decke ohne aussteifende Wände hat keine Scheibenrechnung — sie hat
  deshalb trotzdem Momente und Bewehrung.
* **Karten gibt es zweimal.** Einmal als Bild mit Achsen und Farbskala zum
  Ansehen, und einmal nackt — nur die Fläche, transparent, ohne Rahmen, dafür
  mit den Modellkoordinaten ihrer Ecken im Bericht. Die zweite Fassung legt
  der Zeichenmodus deckungsgleich über den Grundriss.

Alles Rechnerische steht unverändert in `plate`, `scheibe`, `beton` und
`loeser`; dieses Modul ordnet nur an und zeichnet.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np

import matplotlib

# Muss vor dem ersten Pyplot-Import stehen: ohne Backend sucht matplotlib eine
# Anzeige und scheitert im Container an $DISPLAY.
matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402

from . import plate, scheibe, unterzug, zeichnen  # noqa: E402
from . import beton as bt  # noqa: E402

logger = logging.getLogger(__name__)


# ── Annahmen ───────────────────────────────────────────────────────────────


@dataclass
class Annahmen:
    """
    Was der Plan nicht enthält.

    Der Zeichenmodus kennt Umriss, Dicke, Material, Lasten und Auflager — alles
    andere ist Ingenieurwissen über das Gebäude, in dem die Decke liegt. Es
    steht hier zusammen, damit ein Auftraggeber diese Werte an einer Stelle
    setzt und sie im Bericht wiederfindet.
    """

    elementgroesse_m: float | None = None   # None = Plattendicke / 2
    lagen: int = 2
    windzone: int = 2                       # 1…4, Binnenland
    gebaeudehoehe_m: float = 12.0
    geschosshoehe_m: float = 3.2            # Einzugshöhe der Fassade
    geschosse_ueber: int = 3
    exposition: str = "XC1"
    durchmesser_mm: float = 10.0
    kriechzahl: float = 2.0
    # Unterzüge: die Längsbewehrung liegt hinter den Bügeln, die Nutzhöhe ist
    # deshalb kleiner als bei der Platte mit derselben Deckung.
    buegel_mm: float = 8.0
    laengsstab_mm: float = 16.0
    # Obergrenze, ab der abgebrochen wird statt den Container zu sprengen: die
    # Zerlegung wächst überproportional an Zeit *und* Speicher.
    #
    # Die Zahl ist keine Rechengrenze, sondern eine Speichergrenze, und sie
    # gehört deshalb an die Maschine und nicht in den Code: 600k
    # Freiheitsgrade sind auf einem Laptop mit 32 GB in wenigen Minuten
    # zerlegt und auf einem kleinen Server das Ende. Über `FEM_MAX_DOF`
    # einstellbar. Zum Vergleich: eine 600-m²-Geschossdecke mit 10 cm
    # Elementen und zwei Lagen kommt auf gut 540k.
    max_freiheitsgrade: int = int(os.getenv("FEM_MAX_DOF", "600000"))

    @classmethod
    def aus(cls, daten: dict | None) -> "Annahmen":
        """Nimmt nur bekannte Schlüssel — unbekannte fallen still weg."""
        if not daten:
            return cls()
        bekannt = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in daten.items() if k in bekannt and v is not None})


class Abbruch(Exception):
    """Die Eingabe lässt sich nicht rechnen — mit einer Begründung für den Plan."""


# ── Bildersammlung ─────────────────────────────────────────────────────────


@dataclass
class Bild:
    name: str
    titel: str
    gruppe: str
    datei: str
    # Nur bei Überlagerungen gesetzt: die Modellkoordinaten der Bildecken,
    # [x_min, y_min, x_max, y_max] in Metern der Zeichenebene.
    ausdehnung: list[float] | None = None
    spanne: list[float] | None = None       # [min, max] der dargestellten Größe
    einheit: str = ""
    # Stützstellen der Farbskala als #rrggbb — damit der Zeichenmodus dieselbe
    # Legende zeichnen kann, ohne matplotlibs Farbverläufe nachzubauen.
    farben: list[str] | None = None
    # Zahl der abgesetzten Farbstufen, 0 bei stetigem Verlauf. Der Zeichenmodus
    # braucht sie, um harte Farbkanten statt eines weichen Verlaufs zu zeichnen:
    # ein Balken mit sechzehn ineinanderlaufenden Farben behauptete eine
    # Feinheit, die die Karte nicht hat.
    stufen: int = 0


class Bilder:
    """
    Legt Figuren als PNG ab und führt Buch darüber.

    Buch führen ist der eigentliche Zweck: das Frontend bekommt eine Liste mit
    Name, Titel und Gruppe und kann daraus eine Galerie bauen, ohne die
    Dateinamen zu kennen.
    """

    def __init__(self, verzeichnis: Path, dpi: int = 110):
        self.verzeichnis = Path(verzeichnis)
        self.verzeichnis.mkdir(parents=True, exist_ok=True)
        self.dpi = dpi
        self.liste: list[Bild] = []

    @contextmanager
    def figur(self, name: str, titel: str, gruppe: str, **kwargs):
        """`with bilder.figur('momente', 'Momente', 'Platte', figsize=…) as fig:`"""
        fig = plt.figure(**kwargs)
        try:
            yield fig
            datei = f"{name}.png"
            fig.savefig(self.verzeichnis / datei, dpi=self.dpi,
                        bbox_inches="tight", facecolor="white")
            self.liste.append(Bild(name=name, titel=titel, gruppe=gruppe, datei=datei))
        finally:
            plt.close(fig)

    def ueberlagerung(self, name: str, titel: str, xy, werte, netz,
                      cmap: str = "RdBu_r", symmetrisch: bool = True,
                      einheit: str = "", perzentil: float = 99.5) -> None:
        """
        Dieselbe Karte ohne alles Drumherum — zum Überlagern über den Grundriss.

        Kein Rahmen, keine Achsen, transparent außerhalb der Platte, und die
        Bildkanten liegen exakt auf den Rasterkanten. Nur so deckt sich das
        Bild im Zeichenmodus mit der Zeichnung; ein `bbox_inches='tight'`
        würde die Ränder um einen unbekannten Betrag beschneiden und alles
        verschieben.
        """
        X, Y, Z = plate.auf_raster(np.asarray(xy), np.asarray(werte, dtype=float),
                                   polygon=netz.polygon)
        self.raster(name, titel, X, Y, Z, netz, cmap=cmap, symmetrisch=symmetrisch,
                    einheit=einheit, perzentil=perzentil)

    def raster(self, name: str, titel: str, X, Y, Z, netz,
               cmap: str = "RdBu_r", symmetrisch: bool = True,
               einheit: str = "", perzentil: float = 99.5) -> None:
        """
        Dieselbe Überlagerung aus einem fertigen Raster.

        Die Querkraft entsteht als Ableitung der Momente und liegt deshalb von
        vornherein auf einem Gitter (`plate.querkraefte_aus_momenten`), nicht
        als Streuwerte je Element. Sie durch `auf_raster()` zu schicken hieße,
        sie erst zu Streuwerten zu machen und dann wieder einzusortieren.
        """
        Z = np.asarray(Z, dtype=float)
        werte = Z

        endlich = werte[np.isfinite(werte)]
        if not len(endlich):
            return
        if symmetrisch:
            grenze = float(np.percentile(np.abs(endlich), perzentil)) or 1e-9
            vmin, vmax = -grenze, grenze
        else:
            # Anders als `zeichnen.karte` wird hier *nicht* bei null angefangen.
            # Der Grund ist die Bewehrung: sie liegt auf dem größten Teil der
            # Fläche auf a_s,min, und eine Skala ab null färbt die ganze Platte
            # gleich ein — genau die Stellen mit Zulage verschwinden dann.
            vmin = float(np.percentile(endlich, 100 - perzentil))
            vmax = float(np.percentile(endlich, perzentil))
            if vmax - vmin < 1e-9:
                vmin, vmax = vmin - 0.5, vmax + 0.5

        # Die Rasterkanten liegen eine halbe Zelle außerhalb der Zellmitten —
        # das ist die Fläche, die pcolormesh mit shading='nearest' tatsächlich
        # einfärbt, und damit die Ausdehnung des Bildes.
        halb = netz.groesse / 2.0
        x0, x1 = float(X.min()) - halb, float(X.max()) + halb
        y0, y1 = float(Y.min()) - halb, float(Y.max()) + halb

        seite = 1400  # Pixel der längeren Kante — genug für 1:50 auf A0
        breite = max(x1 - x0, 1e-6)
        hoehe = max(y1 - y0, 1e-6)
        faktor = seite / max(breite, hoehe)
        fig = plt.figure(figsize=(breite * faktor / 100.0, hoehe * faktor / 100.0), dpi=100)
        try:
            ax = fig.add_axes([0, 0, 1, 1])
            ax.pcolormesh(X, Y, Z, cmap=cmap, vmin=vmin, vmax=vmax, shading="nearest")
            ax.set_xlim(x0, x1)
            ax.set_ylim(y0, y1)
            ax.axis("off")
            datei = f"{name}.png"
            fig.savefig(self.verzeichnis / datei, dpi=100, transparent=True,
                        pad_inches=0)
        finally:
            plt.close(fig)

        self.liste.append(Bild(
            name=name, titel=titel, gruppe="Überlagerung", datei=datei,
            ausdehnung=[round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)],
            spanne=[round(vmin, 3), round(vmax, 3)], einheit=einheit,
            farben=_farbstuetzstellen(cmap), stufen=_farbstufen(cmap)))

    def trajektorien(self, name: str, titel: str, xy, wert_1, wert_2, phi, netz,
                     dichte: int = 34) -> None:
        """
        Die Hauptrichtungen als Überlagerung — Striche statt Fläche.

        Dieselbe Zeichnung wie in der Galerie (`zeichnen.trajektorien()`), aber
        ohne Rahmen, Achsen und Titel und exakt auf die Plattenausdehnung
        zugeschnitten — sonst deckt sich das Bild nicht mit dem Grundriss
        darunter (siehe `raster()`).

        Anders als bei `ueberlagerung()`/`raster()` gibt es hier keine
        Farbskala: Rot ist Zug, Blau ist Druck, wie überall sonst in diesem
        Bericht. `spanne` bleibt deshalb unbesetzt — der Zeichenmodus lässt den
        Legendenkasten dann bewusst weg, statt eine Skala vorzutäuschen, die es
        nicht gibt.
        """
        x0, y0 = (round(float(v), 4) for v in netz.polygon.min(axis=0))
        x1, y1 = (round(float(v), 4) for v in netz.polygon.max(axis=0))
        breite, hoehe = max(x1 - x0, 1e-6), max(y1 - y0, 1e-6)

        seite = 1400  # dieselbe Zielauflösung wie bei den Farbkarten
        faktor = seite / max(breite, hoehe)
        fig = plt.figure(figsize=(breite * faktor / 100.0, hoehe * faktor / 100.0), dpi=100)
        try:
            ax = fig.add_axes([0, 0, 1, 1])
            zeichnen._trajektorien_striche(ax, xy, wert_1, wert_2, phi, dichte=dichte, lw=1.6)
            ax.set_xlim(x0, x1)
            ax.set_ylim(y0, y1)
            ax.axis("off")
            datei = f"{name}.png"
            fig.savefig(self.verzeichnis / datei, dpi=100, transparent=True, pad_inches=0)
        finally:
            plt.close(fig)

        self.liste.append(Bild(
            name=name, titel=titel, gruppe="Überlagerung", datei=datei,
            ausdehnung=[x0, y0, x1, y1]))

    def als_liste(self) -> list[dict]:
        return [
            {k: v for k, v in b.__dict__.items() if v is not None and v != ""}
            for b in self.liste
        ]


def _farbstuetzstellen(cmap: str, n: int = 9) -> list[str]:
    """
    Die Farbskala als Hex-Werte — Vorlage für den Verlauf in der Legende.

    Eine **abgestufte** Tafel gibt ihre Stufen selbst her. Sie mit neun Punkten
    abzutasten machte aus sechzehn Stufen einen Verlauf mit Zwischenfarben, die
    im Bild gar nicht vorkommen — die Legende zeigte dann Farben, die in der
    Karte nirgends stehen.
    """
    farbtafel = matplotlib.colormaps[cmap]
    anzahl = farbtafel.N if getattr(farbtafel, "N", 256) <= 32 else n
    return [matplotlib.colors.to_hex(farbtafel(i / (anzahl - 1)))
            for i in range(anzahl)]


def _farbstufen(cmap: str) -> int:
    """Wie viele abgesetzte Stufen die Tafel hat; 0 bei stetigem Verlauf."""
    anzahl = getattr(matplotlib.colormaps[cmap], "N", 256)
    return int(anzahl) if anzahl <= 32 else 0


# ── Fortschritt ────────────────────────────────────────────────────────────


class Lauf:
    """
    Führt den Fortschritt und sammelt, was unterwegs schiefging.

    `melden` bekommt einen Anteil zwischen 0 und 1 und einen Satz, der in der
    Statuszeile des Zeichenmodus steht. Der Anteil ist geschätzt, nicht
    gemessen: die Zerlegung dominiert, und wie lange sie dauert, weiß man erst
    danach.
    """

    def __init__(self, melden=None):
        self._melden = melden or (lambda anteil, text: None)
        self.hinweise: list[str] = []
        self.start = time.time()

    def schritt(self, anteil: float, text: str) -> None:
        logger.info("FEM %3.0f %% — %s", anteil * 100, text)
        self._melden(anteil, text)

    def hinweis(self, text: str) -> None:
        logger.warning("FEM: %s", text)
        self.hinweise.append(text)

    @contextmanager
    def versuche(self, was: str):
        """
        Ein Abschnitt, der scheitern darf.

        Eine Decke ohne Punktauflager hat keinen Durchstanznachweis, eine ohne
        aussteifende Wände keine Scheibenrechnung. Beides ist kein Fehler der
        Eingabe, sondern eine Eigenschaft des Bauteils — und darf die übrigen
        Abschnitte nicht mitreißen.
        """
        try:
            yield
        except Abbruch:
            raise
        except Exception as fehler:  # noqa: BLE001 — genau das ist der Zweck
            logger.warning("FEM: %s übersprungen (%s)", was, fehler, exc_info=True)
            self.hinweis(f"{was} nicht gerechnet: {fehler}")

    @property
    def dauer(self) -> float:
        return time.time() - self.start


# ── Der Ablauf ─────────────────────────────────────────────────────────────


def rechne(modell_daten: dict, ausgabe: Path, annahmen: Annahmen | None = None,
           melden=None) -> dict:
    """
    Rechnet eine Decke und legt Bilder und Bericht ab.

    @param modell_daten  der Inhalt einer `…_FEM.json` (Schema ileen.plan.fem/1.0)
    @param ausgabe       Verzeichnis für die PNG-Dateien
    @param annahmen      was im Plan nicht steht
    @param melden        `f(anteil, text)` für die Fortschrittsanzeige
    @returns             der Bericht als serialisierbares dict
    """
    annahmen = annahmen or Annahmen()
    lauf = Lauf(melden)
    bilder = Bilder(Path(ausgabe))
    zeichnen.stil()

    # ── 1 Modell ───────────────────────────────────────────────────────────
    lauf.schritt(0.02, "Modell wird gelesen")
    schema = (modell_daten or {}).get("schema", "")
    if not str(schema).startswith("ileen.plan.fem/"):
        raise Abbruch(f"Das ist kein iLEEN-Statikexport (schema = {schema!r}).")

    modell = plate.Modell(daten=modell_daten, quelle=None)
    if not modell.system:
        raise Abbruch("Der Plan enthält keine Systemfläche (⬠). Ohne sie ist nicht "
                      "bestimmt, was gerechnet werden soll.")
    platte = modell.platte()
    bettung_kNm3 = platte.get("bettung_kNm3")
    if not modell.auflager and not bettung_kNm3:
        raise Abbruch("Der Plan enthält weder Auflager (△) noch eine Bettung an der "
                      "Systemfläche (Bodenplatte). Das System wäre kinematisch — es "
                      "gäbe keine Lösung.")

    E = platte["material"]["E_kNm2"]
    nu = platte["material"]["nu"]
    h = platte["dicke_m"]
    elementgroesse = annahmen.elementgroesse_m or h / 2
    # **Eine Holzbalkendecke als Ersatzplatte** (`kette.balkenlagen()`): der
    # Löser rechnet sie orthotrop, und alles, was eine Betonplatte ausmacht —
    # Schnittgrößen je Meter mit E und ν, Bewehrung, Scheibe, Durchstanzen —,
    # entfällt. Gerechnet werden Lastabtrag und Durchbiegung.
    holz = platte["material"].get("familie") == "holz"

    bericht: dict = {
        "titel": modell.titel,
        "plan": modell.daten.get("plan", {}),
        "annahmen": annahmen.__dict__.copy(),
        "material": platte["material"],
        "warnungen": list(modell.warnungen),
    }

    with lauf.versuche("Systemzeichnung"):
        with bilder.figur("system", "Statisches System", "Eingabe",
                          figsize=(10, 6.5)) as fig:
            ax = fig.add_subplot(111)
            zeichnen.plan(ax, modell)
            ax.set_title(f"{modell.titel} — statisches System")
            fig.tight_layout()

    with lauf.versuche("Lastfallbilder"):
        _lastfallbilder(bilder, modell)

    # ── 2 Netz ─────────────────────────────────────────────────────────────
    lauf.schritt(0.08, "Netz wird erzeugt")
    if annahmen.lagen < 2:
        # Vor dem Vernetzen, nicht danach: mit einer Lage liefe die ganze
        # Rechnung durch und gäbe exakte Nullen für jedes Moment aus — eine
        # halbe Minute für ein Ergebnis, das wie eine schwach beanspruchte
        # Decke aussieht und keines ist.
        raise Abbruch(
            f"{annahmen.lagen} Elementlage über die Dicke trägt kein Moment: die "
            f"Spannungen werden in der Elementmitte ausgewertet, und die läge genau "
            f"in der Mittelebene der Platte. Mindestens 2 Lagen wählen — "
            f"das kostet doppelt so viele Freiheitsgrade und ist die Voraussetzung "
            f"dafür, dass überhaupt ein Moment herauskommt."
        )

    netz = plate.vernetze(modell, groesse=elementgroesse, lagen=annahmen.lagen)
    freiheitsgrade = netz.n_knoten * 3
    if freiheitsgrade > annahmen.max_freiheitsgrade:
        raise Abbruch(
            f"{freiheitsgrade/1000:.0f}k Freiheitsgrade bei {elementgroesse*100:.0f} cm "
            f"Elementgröße — mehr, als hier gerechnet wird ({annahmen.max_freiheitsgrade/1000:.0f}k). "
            f"Eine gröbere Elementgröße wählen (die Momente fallen dann etwas zu klein aus) "
            f"oder die Fläche in Felder teilen.")

    for hinweis in modell.warnungen:
        lauf.hinweis(hinweis)

    balken = unterzug.finde(modell, netz)
    if modell.balken:
        lauf.hinweis(
            f"{len(modell.balken)} Unterzug/Überzug im Modell, {len(balken)} davon "
            "als Plattenbalken bemessen (Abschnitt „Unterzüge\"). Die Momenten- und "
            "Bewehrungskarten der Platte lassen den Balkenstreifen aus — dort gilt "
            "die Balkenbemessung, nicht die Bewehrung je Meter."
        )

    bericht["netz"] = {
        "elemente": netz.n_elemente, "knoten": netz.n_knoten,
        "elementgroesse_m": round(netz.groesse, 4), "lagen": plate.lagen(netz),
        "verfahren": netz.verfahren, "freiheitsgrade": freiheitsgrade,
    }

    with lauf.versuche("Netzbild"):
        with bilder.figur("netz", "Netz", "Eingabe", figsize=(9, 5.5)) as fig:
            zeichnen.netzbild(fig.add_subplot(111), netz)
            fig.tight_layout()

    # ── 3 Lastfelder ───────────────────────────────────────────────────────
    lauf.schritt(0.12, "Lastfelder werden aufgestellt")
    felder = plate.einzelfelder(modell, netz)
    # `plate.zellvolumen()` statt `groesse² · dz`: dx und dy des Rasters sind nur
    # zufällig gleich, und der Unterschied ginge als stiller Lastfehler durch —
    # siehe `plate.zellflaechen()`.
    zelle = plate.zellvolumen(netz)
    summen = {k: float((f[:, 2] * zelle).sum()) for k, f in felder.items()}
    bericht["lastsummen_kN"] = {k: round(v, 1) for k, v in summen.items()}

    with lauf.versuche("Lastfeldbilder"):
        _lastfeldbilder(bilder, netz, felder)

    # ── 4 System aufstellen und zerlegen ───────────────────────────────────
    lauf.schritt(0.18, f"Steifigkeitsmatrix wird zerlegt ({freiheitsgrade//1000}k Freiheitsgrade)")
    from .loeser import Loeser, kombiniere  # lokal: JAX lädt mehrere Sekunden

    federn_z = einzugsflaeche = None
    if bettung_kNm3:
        federn_z, einzugsflaeche = plate.bettungsfedern(netz, bettung_kNm3)

    bc_info, lagerung = plate.randbedingungen(modell, netz, bettung_vorhanden=bool(bettung_kNm3))
    bericht["lagerung"] = lagerung
    t0 = time.time()
    tabelle = plate.werkstofftabelle(modell, netz)
    if tabelle is not None:
        loeser = Loeser(netz, bc_info=bc_info, federn_z=federn_z,
                        C_tabelle=tabelle[0], material=tabelle[1])
    else:
        loeser = Loeser(netz, E, nu, bc_info, federn_z=federn_z)
    bericht["zerlegung_s"] = round(time.time() - t0, 2)

    lauf.schritt(0.38, f"{len(felder)} Lastfälle werden gelöst")
    loesungen, vektoren = loeser.loese_alle(felder)

    # Die Gleichgewichtsprobe ist die schärfste Prüfung, die eine FE-Rechnung
    # zulässt, und sie kostet eine Matrixmultiplikation. Sie gehört deshalb in
    # jeden Bericht, nicht nur ins Notebook.
    bericht["probe"] = {}
    for kennung in felder:
        p = loeser.probe(loesungen[kennung], vektoren[kennung])
        bericht["probe"][kennung] = {
            "last_kN": round(float(p["last_kN"][2]), 2),
            "auflager_kN": round(float(p["auflager_kN"][2]), 2),
            "abweichung_rel": float(f"{p['abweichung_rel']:.3e}"),
        }
        if p["abweichung_rel"] > 1e-6:
            lauf.hinweis(f"Gleichgewichtsprobe {kennung}: Abweichung "
                         f"{p['abweichung_rel']:.1e} — das Netz oder die Lagerung prüfen.")

    # `plate.unterseiten_knoten()` statt eines globalen Minimums: unter einem
    # Unterzug liegt die tatsächliche Unterseite lokal tiefer, ein globales
    # Minimum träfe dann nur dessen Fußpunkte statt der ganzen Fläche.
    unten = plate.unterseiten_knoten(netz)
    xy_knoten = netz.points[unten][:, :2]

    with lauf.versuche("Verformungsbilder je Lastfall"):
        _verformungsbilder(bilder, netz, loesungen, xy_knoten, unten)

    # ── 5 Kombinationen ────────────────────────────────────────────────────
    lauf.schritt(0.46, "Kombinationen werden überlagert")
    kombis = plate.kombinationen(modell)
    massgebend = plate.massgebend(kombis)
    bericht["kombinationen"] = {k: {kk: round(vv, 3) for kk, vv in v.items()}
                               for k, v in kombis.items()}
    bericht["massgebend"] = massgebend

    verschiebungen, lastvektoren, schnitte = {}, {}, {}
    for bezeichnung, faktoren in kombis.items():
        verschiebungen[bezeichnung] = kombiniere(loesungen, faktoren)
        lastvektoren[bezeichnung] = kombiniere(vektoren, faktoren)
        if not holz:
            schnitte[bezeichnung] = plate.schnittgroessen(verschiebungen[bezeichnung],
                                                          netz, E, nu)

    s = schnitte.get(massgebend)
    xy = s["xy"] if s is not None else None

    # ── 6 Durchbiegung ─────────────────────────────────────────────────────
    lauf.schritt(0.50, "Durchbiegung")
    quasi = _quasi_staendig(verschiebungen)
    durchbiegung = plate.durchbiegung(verschiebungen[quasi], netz, modell)
    bericht["durchbiegung"] = {
        "kombination": quasi,
        "w_elastisch_mm": round(float(durchbiegung["w_max_mm"]), 2),
        "ort": [round(float(x), 3) for x in durchbiegung["ort"][:2]],
        "spannweite_m": round(float(durchbiegung["spannweite_m"]), 2),
        "grenzwert_mm": round(float(durchbiegung["grenzwert_mm"]), 1),
    }

    with lauf.versuche("Durchbiegungsbild"):
        _durchbiegungsbild(bilder, netz, verschiebungen[quasi], durchbiegung,
                           xy_knoten, unten, quasi)

    huellen: dict = {}
    if not holz:
        # ── 7 Momente ──────────────────────────────────────────────────────
        lauf.schritt(0.55, "Momente und Einhüllende")
        with lauf.versuche("Momentenbilder"):
            _momentenbilder(bilder, netz, s, xy, massgebend)

        gzt = {k: v for k, v in schnitte.items() if k.startswith("GZT")}
        huellen = {komponente: plate.einhuellende({k: v[komponente] for k, v in gzt.items()})
                   for komponente in ("m_x", "m_y", "m_xy")}

        with lauf.versuche("Einhüllende"):
            _einhuellendenbilder(bilder, netz, huellen, xy)

        # ── 8 Ungünstige Laststellung ──────────────────────────────────────
        lauf.schritt(0.60, "Ungünstige Laststellung")
        with lauf.versuche("Laststellung"):
            _laststellung(bilder, lauf, modell, netz, loeser, felder, huellen, xy, E, nu)

    # ── 9 Querkraft und Auflager ───────────────────────────────────────────
    lauf.schritt(0.66, "Querkräfte und Auflagerbilanz")
    if not holz:
        with lauf.versuche("Querkraftbild"):
            _querkraftbild(bilder, netz, s)

    R = loeser.auflagerkraefte(verschiebungen[massgebend], lastvektoren[massgebend])
    bilanz = plate.auflagerbilanz(modell, netz, R)
    bericht["auflager"] = bilanz
    with lauf.versuche("Auflagerbild"):
        _auflagerbild(bilder, modell, netz, bilanz, massgebend)

    # Dieselbe Bilanz noch einmal je Lastfall, mit charakteristischen Werten.
    #
    # **Warum das nicht dieselbe Zahl ist wie oben, geteilt durch 1,4.** Der
    # Bemessungswert `bilanz` trägt die Teilsicherheitsbeiwerte der maßgebenden
    # Kombination bereits in sich. Wer ihn an die Wand darunter weitergibt und
    # dort mit dem nächsten Geschoss neu kombiniert, multipliziert γ ein
    # zweites Mal — bei drei Geschossen steht am Fundament γ³ ≈ 2,5 statt 1,35.
    # Der Fehler tarnt sich, weil jede einzelne Rechnung für sich stimmt.
    #
    # Der Lastabtrag braucht deshalb die ungewichteten Anteile: Eigengewicht,
    # Ausbaulast und Nutzlast getrennt, jeder mit seinem charakteristischen
    # Wert. Erst am Fuß der Kette wird einmal kombiniert. Die Lösungen je
    # Lastfall liegen ohnehin vor (`loesungen`, `vektoren` aus `loese_alle`) —
    # es kostet nur die Rückrechnung R = K·u − f je Fall, keine zweite
    # Zerlegung.
    with lauf.versuche("Auflagerbilanz je Lastfall"):
        bericht["auflager_lastfallweise"] = {
            kennung: plate.auflagerbilanz(
                modell, netz,
                loeser.auflagerkraefte(loesungen[kennung], vektoren[kennung]))
            for kennung in felder
        }
        bericht["lastfall_arten"] = {
            plate.EIGENGEWICHT: "G",
            **{f["id"]: f.get("art", "G") for f in modell.lastfaelle},
        }

    if federn_z is not None:
        R_feder = loeser.federkraefte(verschiebungen[massgebend])
        gebettet = einzugsflaeche > 1e-9
        druck = np.zeros(len(einzugsflaeche))
        druck[gebettet] = R_feder[gebettet, 2] / einzugsflaeche[gebettet]
        bericht["bettung"] = {
            "ks_kNm3": float(bettung_kNm3),
            "reaktion_kN": round(float(R_feder[:, 2].sum()), 2),
            "druck_min_kNm2": round(float(druck[gebettet].min()), 2) if gebettet.any() else 0.0,
            "druck_max_kNm2": round(float(druck[gebettet].max()), 2) if gebettet.any() else 0.0,
        }
        with lauf.versuche("Bettungsdruckbild"):
            _bettungsbild(bilder, netz, druck, gebettet, massgebend)

    if holz:
        lauf.hinweis(
            "Holzbalkendecke als orthotrope Ersatzplatte: gerechnet sind Lastabtrag und "
            "Durchbiegung. Keine Betonbemessung, keine Scheibe; die Balken selbst sind "
            "nicht nachgewiesen (Biegung, Schub, Auflagerpressung nach EC5).")
        bericht["scheibe"] = {"gerechnet": False, "grund": "Holzbalkendecke"}
        bericht["nachweise"] = {}
        bericht["nachweise_offen"] = []
        bericht["positionen"] = []
        bericht["bauteil_positionen"] = plate.positionsbezug(modell)
        bericht["geometrie"] = {
            "dicke_m": h,
            "flaeche_m2": round(float(plate.flaeche(netz.polygon)), 2),
            "spannweite_m": bericht["durchbiegung"]["spannweite_m"],
        }
        bericht["hinweise"] = lauf.hinweise
        bericht["bilder"] = bilder.als_liste()
        bericht["dauer_s"] = round(lauf.dauer, 1)
        lauf.schritt(1.0, f"fertig — Holzbalkendecke, {len(bericht['bilder'])} Bilder")
        return bericht

    # ── 10 Scheibe ─────────────────────────────────────────────────────────
    lauf.schritt(0.72, "Scheibe: Wind und Schiefstellung")
    scheibendaten = {"gerechnet": False}
    with lauf.versuche("Scheibenrechnung"):
        scheibendaten = _scheibe(bilder, lauf, modell, netz, Loeser, E, nu, h,
                                 lastvektoren[massgebend], annahmen)
    # `n_huelle`, `xy`, `membran` und `u_massgebend` sind Rechenfelder für die
    # Bemessung, keine Berichtsgrößen — ein Verschiebungsfeld im JSON wären
    # einige Megabyte, und `json.dumps` scheitert ohnehin daran.
    bericht["scheibe"] = {k: v for k, v in scheibendaten.items()
                          if k not in ("n_huelle", "xy", "membran", "u_massgebend")}

    # ── 11 Bemessung ───────────────────────────────────────────────────────
    lauf.schritt(0.82, "Biegebemessung")
    bemessung = _bemessung(bilder, lauf, modell, netz, huellen, gzt, xy, h,
                           platte, scheibendaten, annahmen)
    bericht.update(bemessung["bericht"])

    # ── 12 Unterzüge ───────────────────────────────────────────────────────
    unterzuege: dict = {}
    if balken:
        lauf.schritt(0.88, f"{len(balken)} Unterzug/Überzug als Plattenbalken")
        unterzuege = _unterzuege(bilder, lauf, modell, netz,
                                 {k: verschiebungen[k] for k in gzt},
                                 verschiebungen[quasi],
                                 E, nu, bemessung["beton"], balken,
                                 scheibendaten, annahmen)
        bericht["unterzuege"] = {k: v["bericht"] for k, v in unterzuege.items()}

    # ── 13 Nachweise ───────────────────────────────────────────────────────
    lauf.schritt(0.93, "Nachweise")
    nachweise = _nachweise(lauf, modell, bilanz, bemessung, schnitte, durchbiegung, h,
                           annahmen, bericht, unterzuege)
    bericht["nachweise"] = {n: round(float(w), 3) for n, w in nachweise}
    bericht["nachweise_offen"] = [n for n, w in nachweise if w > 1.0]

    with lauf.versuche("Nachweisampel"):
        with bilder.figur("nachweise", "Nachweise", "Nachweise",
                          figsize=(9, 0.5 * len(nachweise) + 1.6)) as fig:
            ax = fig.add_subplot(111)
            zeichnen.ampel(ax, nachweise)
            ax.set_title(f"Nachweise — {modell.titel}")
            fig.tight_layout()

    with lauf.versuche("Durchstanzplan"):
        if bericht["durchstanzen_details"]:
            _durchstanzbild(bilder, modell, netz, bericht["durchstanzen_details"])

    # ── 14 Rückbindung ans BIM-Modell ──────────────────────────────────────
    bericht["positionen"] = [
        {"id": p["id"], "querschnitt": p.get("querschnitt"),
         "material": p.get("material"), "beschreibung": p.get("beschreibung"),
         "bauteile": p.get("bauteile", [])}
        for p in modell.positionen
    ]
    bericht["bauteil_positionen"] = plate.positionsbezug(modell)

    # ── 15 Ergebnisfelder für die räumliche Darstellung ────────────────────
    #
    # Die Bilder dieses Laufs sind Draufsichten. Für die Darstellung im
    # 3D-Viewer braucht es die Werte selbst, an ihren Orten — daraus wird die
    # Ergebnispunktwolke (`tiling/ergebniswolke.py`).
    #
    # Als `.npz` neben den Bildern und nicht im Bericht: ein Verschiebungsfeld
    # mit 40 000 Knoten sind als JSON mehrere Megabyte, und der Bericht wird
    # bei jedem Statusabruf mitgeladen. Binär sind es 300 kB, und wer sie nicht
    # braucht, lädt sie nie.
    with lauf.versuche("Ergebnisfelder"):
        _felder_ablegen(ausgabe, netz, modell, xy, xy_knoten, unten,
                        verschiebungen, schnitte, huellen, bemessung,
                        massgebend, quasi, bericht)

    bericht["geometrie"] = {
        "dicke_m": h,
        "flaeche_m2": round(float(plate.flaeche(netz.polygon)), 2),
        "spannweite_m": bericht["durchbiegung"]["spannweite_m"],
    }
    bericht["hinweise"] = lauf.hinweise
    bericht["bilder"] = bilder.als_liste()
    bericht["dauer_s"] = round(lauf.dauer, 1)

    lauf.schritt(1.0, f"fertig — {len(bericht['bilder'])} Bilder in {lauf.dauer:.0f} s")
    return bericht


# ── Bildabschnitte ─────────────────────────────────────────────────────────


def _lastfallbilder(bilder: Bilder, modell) -> None:
    """Ein Bild je Lastfall — die zuverlässigste Kontrolle der Eingabe."""
    mit_lasten = [f for f in modell.lastfaelle
                  if any(l["lastfall"] == f["id"] for l in modell.lasten)]
    if not mit_lasten:
        return

    spalten = min(3, max(1, len(mit_lasten)))
    zeilen = int(np.ceil(len(mit_lasten) / spalten))
    with bilder.figur("lastfaelle", "Lasten je Lastfall", "Eingabe",
                      figsize=(4.6 * spalten, 3.6 * zeilen)) as fig:
        achsen = fig.subplots(zeilen, spalten, squeeze=False)
        for ax, fall in zip(achsen.ravel(), mit_lasten):
            nur = {**modell.daten,
                   "lasten": [l for l in modell.lasten if l["lastfall"] == fall["id"]]}
            teil = plate.Modell(daten=nur, quelle=modell.quelle)
            zeichnen.plan(ax, teil, positionen=False, beschriften=True)
            summe = sum(
                l["wert"] * (plate.flaeche(np.asarray(l["polygon"])) if l["typ"] == "flaeche"
                             else (np.linalg.norm(np.diff(np.asarray(l["polylinie"]), axis=0),
                                                  axis=1).sum() if l["typ"] == "linie" else 1.0))
                for l in nur["lasten"])
            ax.set_title(f"{fall['id']} · {fall['name']} ({fall['art']})\n"
                         f"γ = {fall.get('gamma', 1.5)}, ψ₀ = {fall.get('psi0', 0.7)} "
                         f"— Σ ≈ {summe:.0f} kN")
        for ax in achsen.ravel()[len(mit_lasten):]:
            ax.axis("off")
        fig.tight_layout()


def _lastfeldbilder(bilder: Bilder, netz, felder: dict) -> None:
    """Was im Modell tatsächlich ankommt, je Lastfall als Flächenlast."""
    mitten = netz.points[netz.cells].mean(axis=1)
    # `plate.oberste_lage_z()` statt netz.dicke: Elementmitten liegen eine
    # halbe Lagenhöhe darunter. Bei einem Überzug reicht das Netz zusätzlich
    # höher, und „oben" träfe sonst nur den Rippenkopf statt der ganzen
    # Deckenoberfläche, auf der die Flächenlast tatsächlich angesetzt ist.
    oben = mitten[:, 2] >= plate.oberste_lage_z(netz) - 1e-9
    hoehe = netz.dicke / plate.lagen(netz)

    spalten = min(3, len(felder))
    zeilen = int(np.ceil(len(felder) / spalten))
    with bilder.figur("lastfelder", "Angesetzte Flächenlasten", "Eingabe",
                      figsize=(4.8 * spalten, 3.6 * zeilen)) as fig:
        achsen = fig.subplots(zeilen, spalten, squeeze=False)
        for ax, (kennung, feld) in zip(achsen.ravel(), felder.items()):
            # Das Eigengewicht wirkt über die volle Dicke, alles andere in der
            # obersten Lage — sonst stünde die Wichte statt der Flächenlast da.
            q = -feld[oben, 2] * (netz.dicke if kennung == "EG" else hoehe)
            zeichnen.karte(ax, mitten[oben][:, :2], q, netz, titel=f"{kennung}",
                           einheit="kN/m²", symmetrisch=False, cmap="YlOrRd")
        for ax in achsen.ravel()[len(felder):]:
            ax.axis("off")
        fig.tight_layout()


def _verformungsbilder(bilder: Bilder, netz, loesungen: dict, xy_knoten, unten) -> None:
    spalten = min(3, len(loesungen))
    zeilen = int(np.ceil(len(loesungen) / spalten))
    with bilder.figur("verformung_lastfaelle", "Verformung je Lastfall", "Platte",
                      figsize=(4.8 * spalten, 3.6 * zeilen)) as fig:
        achsen = fig.subplots(zeilen, spalten, squeeze=False)
        for ax, (kennung, u) in zip(achsen.ravel(), loesungen.items()):
            w = -np.asarray(u)[unten, 2] * 1000
            zeichnen.karte(ax, xy_knoten, w, netz, titel=f"{kennung} — w",
                           einheit="mm", symmetrisch=True, cmap="RdYlBu")
        for ax in achsen.ravel()[len(loesungen):]:
            ax.axis("off")
        fig.tight_layout()


def _durchbiegungsbild(bilder: Bilder, netz, u_qs, ergebnis, xy_knoten, unten,
                       kombination: str) -> None:
    w = -np.asarray(u_qs)[unten, 2] * 1000
    with bilder.figur("durchbiegung", f"Durchbiegung ({kombination})", "Platte",
                      figsize=(13, 4.6)) as fig:
        ax1 = fig.add_subplot(1, 3, 1)
        # Sechzehn abgesetzte Regenbogenstufen statt eines stetigen Verlaufs:
        # aus der Biegefläche wird ein Höhenlinienbild, dessen Stufenkanten
        # Isolinien sind (siehe `zeichnen.regenbogen`). Dieselbe Tafel wie in
        # der Ergebniswolke — dieselbe Durchbiegung hat im Bericht und im
        # Viewer dieselbe Farbe.
        zeichnen.karte(ax1, xy_knoten, w, netz, titel="Durchbiegung, quasi-ständig",
                       einheit="mm", symmetrisch=False, cmap="ileen_regenbogen")

        ax2 = fig.add_subplot(1, 3, 2, projection="3d")
        zeichnen.verformungsflaeche(ax2, netz, u_qs, ueberhoehung=200)

        ax3 = fig.add_subplot(1, 3, 3)
        p = np.asarray(ergebnis["ort"][:2])
        schnitte = (
            (((netz.polygon[:, 0].min(), p[1]), (netz.polygon[:, 0].max(), p[1])), "-", "x"),
            (((p[0], netz.polygon[:, 1].min()), (p[0], netz.polygon[:, 1].max())), "--", "y"),
        )
        for (a, b), stil, achse in schnitte:
            laenge, werte = plate.entlang(xy_knoten, w, a, b, n=250, netz=netz)
            ax3.plot(laenge, werte, stil, label=f"Schnitt {achse} durch w$_{{max}}$")
        ax3.axhline(ergebnis["grenzwert_mm"], color="#c0392b", ls=":", lw=1.2,
                    label=f"l/250 = {ergebnis['grenzwert_mm']:.1f} mm")
        ax3.invert_yaxis()
        ax3.set_xlabel("Länge [m]")
        ax3.set_ylabel("w [mm]")
        ax3.legend(fontsize=8)
        ax3.grid(alpha=0.3)
        ax3.set_title("Durchbiegung im Schnitt")
        fig.tight_layout()

    bilder.ueberlagerung("ueber_durchbiegung", "Durchbiegung (quasi-ständig)",
                         xy_knoten, w, netz, cmap="ileen_regenbogen", symmetrisch=False,
                         einheit="mm")


def _momentenbilder(bilder: Bilder, netz, s: dict, xy, massgebend: str) -> None:
    with bilder.figur("momente", f"Momente — {massgebend}", "Platte",
                      figsize=(15, 4.3)) as fig:
        achsen = fig.subplots(1, 3)
        for ax, schluessel, titel in ((achsen[0], "m_x", "m$_x$"),
                                      (achsen[1], "m_y", "m$_y$"),
                                      (achsen[2], "m_xy", "m$_{xy}$ (Drillmoment)")):
            zeichnen.karte(ax, xy, s[schluessel], netz,
                           titel=f"{titel} — {massgebend}", einheit="kNm/m")
        fig.tight_layout()

    haupt = plate.hauptmomente(s["m_x"], s["m_y"], s["m_xy"])
    # Der Winkel zählt gegen x' des Rasters; gezeichnet wird in Weltachsen.
    haupt["phi"] = haupt["phi"] + float(getattr(netz, "drehung", 0.0) or 0.0)
    with bilder.figur("hauptmomente", "Hauptmomente und Trajektorien", "Platte",
                      figsize=(15, 4.3)) as fig:
        achsen = fig.subplots(1, 3)
        zeichnen.karte(achsen[0], xy, haupt["m_1"], netz,
                       titel="m$_1$ (größeres Hauptmoment)", einheit="kNm/m")
        zeichnen.karte(achsen[1], xy, haupt["m_2"], netz,
                       titel="m$_2$ (kleineres Hauptmoment)", einheit="kNm/m")
        zeichnen.trajektorien(achsen[2], xy, haupt["m_1"], haupt["m_2"], haupt["phi"],
                              netz, titel="Momententrajektorien")
        fig.tight_layout()

    bilder.ueberlagerung("ueber_m_x", "m_x — maßgebende Kombination", xy, s["m_x"],
                         netz, einheit="kNm/m")
    bilder.ueberlagerung("ueber_m_y", "m_y — maßgebende Kombination", xy, s["m_y"],
                         netz, einheit="kNm/m")
    # Das Drillmoment ist der Schub *in* der Platte. Es gehört auf den Plan,
    # weil es genau dort groß wird, wo m_x und m_y klein sind — in den Ecken
    # einer zweiachsig gespannten Platte. Wer nur m_x und m_y ansieht, hält
    # diese Ecken für unbeansprucht.
    bilder.ueberlagerung("ueber_m_xy", "m_xy — Drillmoment", xy, s["m_xy"],
                         netz, cmap="PRGn", einheit="kNm/m")
    bilder.trajektorien("ueber_trajektorien", f"Momententrajektorien — {massgebend}",
                        xy, haupt["m_1"], haupt["m_2"], haupt["phi"], netz)


def _einhuellendenbilder(bilder: Bilder, netz, huellen: dict, xy) -> None:
    with bilder.figur("einhuellende", "Einhüllende der GZT-Momente", "Platte",
                      figsize=(11, 8)) as fig:
        achsen = fig.subplots(2, 2)
        for i, komponente in enumerate(("m_x", "m_y")):
            zeichnen.karte(achsen[0, i], xy, huellen[komponente]["max"], netz,
                           titel=f"max {komponente} (Feldbewehrung)", einheit="kNm/m")
            zeichnen.karte(achsen[1, i], xy, huellen[komponente]["min"], netz,
                           titel=f"min {komponente} (Stützbewehrung)", einheit="kNm/m")
        fig.tight_layout()

    # Schnitte durch die Stelle des größten Feldmoments
    i_max = int(np.nanargmax(huellen["m_x"]["max"]))
    p_max = xy[i_max]
    # Entlang der Rasterachsen — bei einem gedrehten Gebäude in seinen Achsen.
    schnitt_x = plate.rasterlinie(netz, p_max, 0)
    schnitt_y = plate.rasterlinie(netz, p_max, 1)

    with bilder.figur("momentenschnitte", "Momente im Schnitt", "Platte",
                      figsize=(13, 4)) as fig:
        achsen = fig.subplots(1, 2)
        for ax, (a, b), richtung in ((achsen[0], schnitt_x, "x"),
                                     (achsen[1], schnitt_y, "y")):
            for komponente, farbe in (("m_x", "#c0392b"), ("m_y", "#2f6fa8")):
                laenge, oben = plate.entlang(xy, huellen[komponente]["max"], a, b,
                                             n=250, netz=netz)
                _, unten = plate.entlang(xy, huellen[komponente]["min"], a, b,
                                         n=250, netz=netz)
                ax.fill_between(laenge, unten, oben, color=farbe, alpha=0.18)
                ax.plot(laenge, oben, color=farbe, lw=1.4, label=f"max/min {komponente}")
                ax.plot(laenge, unten, color=farbe, lw=1.4)
            ax.axhline(0, color="k", lw=0.8)
            ax.invert_yaxis()
            ax.set_xlabel(f"Schnitt in {richtung} durch "
                          f"({p_max[0]:.2f} | {p_max[1]:.2f}) [m]")
            ax.set_ylabel("Moment [kNm/m]")
            ax.legend(fontsize=8)
            ax.grid(alpha=0.3)
            ax.set_title(f"Einhüllende im Schnitt {richtung}")
        fig.tight_layout()


def _laststellung(bilder: Bilder, lauf: Lauf, modell, netz, loeser, felder,
                  huellen: dict, xy, E, nu) -> None:
    """
    Die ungünstige Stellung der veränderlichen Lasten über die Einflussflächen.

    Verändert `huellen` in place: für die Bemessung gilt danach die ungünstigere
    der beiden Auswertungen. Das ist der Grund, warum dieser Abschnitt vor der
    Bemessung steht und nicht als Zugabe hinterher.
    """
    einzelflaechen = {}
    for fall in modell.lastfaelle:
        if fall.get("art") != "G":
            einzelflaechen.update(plate.felder_je_lastflaeche(modell, netz, fall["id"]))

    if len(einzelflaechen) < 2:
        lauf.hinweis("Weniger als zwei veränderliche Lastflächen — die Laststellung "
                     "ist eindeutig und wurde nicht gesondert untersucht.")
        return

    staendig = {k: felder[k] for k in felder
                if k == "EG" or modell.lastfall(k).get("art") == "G"}
    loes_e, _ = loeser.loese_alle({**staendig, **einzelflaechen})
    beitraege = {k: plate.schnittgroessen(u, netz, E, nu) for k, u in loes_e.items()}
    guenstig = {komponente: plate.ungünstig({k: v[komponente] for k, v in beitraege.items()},
                                            staendig=set(staendig))
                for komponente in ("m_x", "m_y", "m_xy")}

    with bilder.figur("laststellung", "Ungünstige Laststellung", "Platte",
                      figsize=(15, 4.3)) as fig:
        achsen = fig.subplots(1, 3)
        zeichnen.karte(achsen[0], xy, huellen["m_x"]["max"], netz,
                       titel="max m$_x$ — alle Felder belastet", einheit="kNm/m")
        zeichnen.karte(achsen[1], xy, guenstig["m_x"]["max"], netz,
                       titel="max m$_x$ — ungünstige Laststellung", einheit="kNm/m")
        zeichnen.karte(achsen[2], xy, guenstig["m_x"]["max"] - huellen["m_x"]["max"], netz,
                       titel="Zuwachs durch die Laststellung", einheit="kNm/m", cmap="PuOr_r")
        fig.tight_layout()

    for komponente in ("m_x", "m_y", "m_xy"):
        huellen[komponente]["max"] = np.maximum(huellen[komponente]["max"],
                                                guenstig[komponente]["max"])
        huellen[komponente]["min"] = np.minimum(huellen[komponente]["min"],
                                                guenstig[komponente]["min"])


def _querkraftbild(bilder: Bilder, netz, s: dict) -> None:
    v_feld = plate.querkraefte_aus_momenten(s, netz)
    umriss = np.vstack([netz.polygon, netz.polygon[:1]])

    # Der Betrag als Überlagerung: die Frage am Plan ist, *wo* die Querkraft
    # zusammenläuft — an Wandenden, einspringenden Ecken, um Stützen. Für den
    # Nachweis selbst gilt weiterhin die Auflagerkraft je Meter (siehe
    # `plate.querkraefte()`); die Karte zeigt den Weg dorthin.
    bilder.raster("ueber_querkraft", "Querkraft |v|", v_feld["X"], v_feld["Y"],
                  v_feld["v_res"], netz, cmap="magma_r", symmetrisch=False,
                  einheit="kN/m")
    with bilder.figur("querkraft", "Querkraft im Feld", "Platte",
                      figsize=(12, 4.6)) as fig:
        achsen = fig.subplots(1, 2)
        bild = achsen[0].pcolormesh(v_feld["X"], v_feld["Y"], v_feld["v_res"],
                                    cmap="magma_r", shading="nearest",
                                    vmax=float(np.nanpercentile(v_feld["v_res"], 98)))
        fig.colorbar(bild, ax=achsen[0], fraction=0.046, label="|v| [kN/m]")
        achsen[0].plot(*umriss.T, "k-", lw=1)
        achsen[0].set_aspect("equal")
        achsen[0].set_title("Querkraftbetrag im Feld")
        achsen[0].set_xlabel("x [m]")
        achsen[0].set_ylabel("y [m]")

        schritt = max(1, int(round(0.6 / netz.groesse)))
        achsen[1].quiver(v_feld["X"][::schritt, ::schritt], v_feld["Y"][::schritt, ::schritt],
                         v_feld["v_x"][::schritt, ::schritt], v_feld["v_y"][::schritt, ::schritt],
                         color="#444444", width=0.003)
        achsen[1].plot(*umriss.T, "k-", lw=1)
        achsen[1].set_aspect("equal")
        achsen[1].set_title("Querkraftfluss zu den Auflagern")
        achsen[1].set_xlabel("x [m]")
        achsen[1].set_ylabel("y [m]")
        fig.tight_layout()


def _auflagerbild(bilder: Bilder, modell, netz, bilanz: list[dict], massgebend: str) -> None:
    linien = [e for e in bilanz if e.get("R_je_m_kNm") is not None]
    with bilder.figur("auflager", f"Auflagerkräfte — {massgebend}", "Platte",
                      figsize=(13, 4.6)) as fig:
        achsen = fig.subplots(1, 2, gridspec_kw={"width_ratios": [1.25, 1]})
        zeichnen.plan(achsen[0], modell, lasten=False, positionen=False, beschriften=False)

        groesste_punktkraft = max((abs(b["R_z_kN"]) for b in bilanz), default=1.0) or 1.0
        grenze = max((abs(e["R_je_m_kNm"]) for e in linien), default=0.0) or 1.0
        skala = 0.12 * max(netz.polygon.max(axis=0) - netz.polygon.min(axis=0)) / grenze

        for lager, eintrag in zip(modell.auflager, bilanz):
            if lager["typ"] != "linie" or eintrag.get("R_je_m_kNm") is None:
                achsen[0].plot(*np.asarray(lager["p"], dtype=float), "o", color="#c0392b",
                               ms=6 + 10 * abs(eintrag["R_z_kN"]) / groesste_punktkraft)
                continue
            p = np.asarray(lager["polylinie"], dtype=float)
            richtung = p[-1] - p[0]
            n = np.array([-richtung[1], richtung[0]]) / max(np.linalg.norm(richtung), 1e-9)
            versatz = n * eintrag["R_je_m_kNm"] * skala
            achsen[0].fill(np.r_[p[:, 0], (p + versatz)[::-1, 0]],
                           np.r_[p[:, 1], (p + versatz)[::-1, 1]],
                           color="#c0392b" if eintrag["R_je_m_kNm"] > 0 else "#2f6fa8",
                           alpha=0.45)
        achsen[0].set_title("Auflagerkräfte je Meter (rot = drückend, blau = abhebend)")

        achsen[1].bar([e["id"] for e in bilanz], [e["R_z_kN"] for e in bilanz],
                      color=["#c0392b" if e["R_z_kN"] > 0 else "#2f6fa8" for e in bilanz])
        achsen[1].set_ylabel("R$_z$ [kN]")
        achsen[1].grid(axis="y", alpha=0.3)
        achsen[1].set_title(f"Auflagerkräfte — {massgebend}")
        fig.tight_layout()


def _durchstanzbild(bilder: Bilder, modell, netz, details: list[dict]) -> None:
    """
    Kritischer Rundschnitt an jeder geprüften Stütze, mit dem Rechenweg daneben
    als Tabelle — in derselben Reihenfolge (V_Ed → u_1 → v_Ed → v_Rd,c → η), in
    der `beton.durchstanzen()` die Ausnutzung ermittelt.
    """
    with bilder.figur("durchstanzen", "Durchstanznachweise — kritischer Rundschnitt", "Nachweise",
                      figsize=(13, 4.6)) as fig:
        achsen = fig.subplots(1, 2, gridspec_kw={"width_ratios": [1.25, 1]})
        zeichnen.durchstanzplan(achsen[0], modell, details, netz)

        achsen[1].axis("off")
        zeilen = [[e["id"], f"{e['V_Ed_kN']:.1f}", f"{e['u_1_m']:.2f}",
                  f"{e['v_Ed_kNm2']:.0f}", f"{e['v_Rd_c_kNm2']:.0f}",
                  f"{e['ausnutzung']:.2f}"] for e in details]
        tabelle = achsen[1].table(
            cellText=zeilen,
            colLabels=["Stütze", "V_Ed [kN]", "u₁ [m]", "v_Ed [kN/m²]", "v_Rd,c [kN/m²]", "η"],
            loc="center", cellLoc="center")
        tabelle.auto_set_font_size(False)
        tabelle.set_fontsize(8)
        tabelle.scale(1, 1.6)
        for i, eintrag in enumerate(details, start=1):
            tabelle[(i, 5)].set_facecolor(zeichnen._ampelfarbe(eintrag["ausnutzung"]))
        achsen[1].set_title("Nachweisführung (EC2 6.4)")
        fig.tight_layout()


def _bettungsbild(bilder: Bilder, netz, druck: np.ndarray, gebettet: np.ndarray,
                  massgebend: str) -> None:
    """
    Bettungsdruck (Federreaktion je Einzugsfläche) — dieselbe Karte einmal
    mit Achsen für die Galerie, einmal transparent zum Überlagern über den
    Grundriss (`bilder.ueberlagerung`, Gruppe „Überlagerung"; das Frontend
    baut seine Kartenauswahl bereits vollständig aus `bericht["bilder"]`,
    keine weitere Verdrahtung nötig).
    """
    xy = netz.points[gebettet][:, :2]
    werte = druck[gebettet]
    with bilder.figur("bettungsdruck", f"Bettungsdruck — {massgebend}", "Platte",
                      figsize=(6.5, 5)) as fig:
        ax = fig.add_subplot(111)
        zeichnen.karte(ax, xy, werte, netz, titel="Bettungsdruck (Druck positiv)",
                       einheit="kN/m²", symmetrisch=False, cmap="YlOrRd")
        fig.tight_layout()

    bilder.ueberlagerung("ueber_bettungsdruck", "Bettungsdruck", xy, werte, netz,
                         symmetrisch=False, einheit="kN/m²", cmap="YlOrRd")


# ── Scheibe ────────────────────────────────────────────────────────────────


def _scheibe(bilder: Bilder, lauf: Lauf, modell, netz, Loeser, E, nu, h,
             lastvektor_massgebend, annahmen: Annahmen) -> dict:
    """
    Wind und Schiefstellung in der Deckenebene.

    Eigenes System, eigene Zerlegung: die Randbedingungen sind andere (die
    aussteifenden Wände halten in der Ebene, nicht senkrecht dazu), und die
    Steifigkeitsmatrix damit ebenfalls.
    """
    q_p = scheibe.staudruck_kNm2(annahmen.windzone, annahmen.gebaeudehoehe_m)
    richtungen = {"w_x+": (1, 0), "w_x-": (-1, 0), "w_y+": (0, 1), "w_y-": (0, -1)}
    windlasten = {k: scheibe.windkanten(netz, r, q_p, annahmen.geschosshoehe_m)
                  for k, r in richtungen.items()}

    with lauf.versuche("Windbild"):
        with bilder.figur("wind", "Windansatz", "Scheibe", figsize=(13, 4.8)) as fig:
            achsen = fig.subplots(1, 2)
            zeichnen.windbild(achsen[0], modell, netz, windlasten["w_x+"], (1, 0))
            zeichnen.windbild(achsen[1], modell, netz, windlasten["w_y+"], (0, 1))
            fig.tight_layout()

    # Die Schiefstellung greift an der Vertikallast an, also am Bemessungswert
    # dieser Decke samt der Geschosse darüber.
    N_Ed = abs(float(np.asarray(lastvektor_massgebend).reshape(-1, 3)[:, 2].sum()))
    imp = scheibe.imperfektion(N_Ed * (1 + annahmen.geschosse_ueber), (1, 0),
                               annahmen.gebaeudehoehe_m, annahmen.geschosse_ueber + 1)

    bc_scheibe, aussteifung = scheibe.randbedingungen(modell, netz)
    loeser_s = Loeser(netz, E, nu, bc_scheibe)

    felder_s = {k: scheibe.randlastfeld(netz, lasten) for k, lasten in windlasten.items()}
    for kennung, richtung in (("imp_x+", (1, 0)), ("imp_x-", (-1, 0)),
                              ("imp_y+", (0, 1)), ("imp_y-", (0, -1))):
        felder_s[kennung] = scheibe.imperfektionsfeld(netz, imp["H_kN"], richtung)

    loes_s, vek_s = loeser_s.loese_alle(felder_s)

    gamma_w = _gamma_wind(modell)
    paare = {"x+": ("w_x+", "imp_x+"), "x-": ("w_x-", "imp_x-"),
             "y+": ("w_y+", "imp_y+"), "y-": ("w_y-", "imp_y-")}

    membran, wandbilanz = {}, {}
    for bezeichnung, (wind_id, imp_id) in paare.items():
        u = gamma_w * loes_s[wind_id] + loes_s[imp_id]
        f = gamma_w * vek_s[wind_id] + vek_s[imp_id]
        membran[bezeichnung] = scheibe.membrankraefte(u, netz, E, nu)
        wandbilanz[bezeichnung] = scheibe.wandkraefte(
            modell, netz, loeser_s.auflagerkraefte(u, f))

    n_huelle = {k: plate.einhuellende({b: m[k] for b, m in membran.items()})
                for k in ("n_x", "n_y", "n_xy")}

    massgebende_richtung = max(paare, key=lambda b: np.abs(membran[b]["n_xy"]).max())
    m_s = membran[massgebende_richtung]

    with lauf.versuche("Membrankraftbild"):
        with bilder.figur("membran", f"Membrankräfte — Wind {massgebende_richtung}",
                          "Scheibe", figsize=(11, 8)) as fig:
            achsen = fig.subplots(2, 2)
            zeichnen.karte(achsen[0, 0], m_s["xy"], m_s["n_x"], netz,
                           titel="n$_x$", einheit="kN/m")
            zeichnen.karte(achsen[0, 1], m_s["xy"], m_s["n_y"], netz,
                           titel="n$_y$", einheit="kN/m")
            zeichnen.karte(achsen[1, 0], m_s["xy"], m_s["n_xy"], netz,
                           titel="n$_{xy}$ — Schubfluss in der Scheibe",
                           einheit="kN/m", cmap="PRGn")
            zeichnen.trajektorien(achsen[1, 1], m_s["xy"], m_s["n_1"], m_s["n_2"],
                                  m_s["phi"], netz,
                                  titel="Hauptkräfte der Scheibe (rot = Zug)")
            fig.tight_layout()

    with lauf.versuche("Wandkraftbild"):
        _wandkraftbild(bilder, wandbilanz[massgebende_richtung], massgebende_richtung)

    with lauf.versuche("Scheibenschub als Überlagerung"):
        # Der Schubfluss der Decke als Scheibe — die Größe, mit der die
        # Windlast zu den aussteifenden Wänden wandert. Sie über den Grundriss
        # zu legen ist der einzige Weg zu sehen, welche Wand sie abholt und
        # über welche Öffnung sie dabei laufen muss.
        bilder.ueberlagerung("ueber_schubfluss",
                             f"n_xy — Schubfluss in der Scheibe (Wind {massgebende_richtung})",
                             m_s["xy"], m_s["n_xy"], netz, cmap="PRGn", einheit="kN/m")

    return {
        "gerechnet": True,
        "q_p_kNm2": round(q_p, 3),
        "einzugshoehe_m": annahmen.geschosshoehe_m,
        "gamma_wind": gamma_w,
        "aussteifende_waende": aussteifung.get("wände", []),
        "H_wind_kN": {k: [round(float(x), 2) for x in scheibe.gesamtkraft(v)]
                      for k, v in windlasten.items()},
        "H_imperfektion_kN": round(float(imp["H_kN"]), 2),
        "theta_i": round(float(imp["theta_i"]), 5),
        "N_Ed_kN": round(N_Ed, 1),
        "massgebende_richtung": massgebende_richtung,
        "n_kNm": {k: [round(float(n_huelle[k]["min"].min()), 2),
                      round(float(n_huelle[k]["max"].max()), 2)] for k in n_huelle},
        "wandkraefte": wandbilanz[massgebende_richtung],
        # Für die Bemessung gebraucht, nicht für den Bericht:
        "n_huelle": n_huelle,
        "xy": m_s["xy"],
        "membran": m_s,
        # Die Verschiebung der maßgebenden Richtung — daraus holt sich die
        # Unterzugbemessung die Gurtkraft des tiefen Trägers.
        "u_massgebend": (gamma_w * loes_s[paare[massgebende_richtung][0]]
                         + loes_s[paare[massgebende_richtung][1]]),
    }


def _wandkraftbild(bilder: Bilder, waende: list[dict], richtung: str) -> None:
    if not waende:
        return
    with bilder.figur("wandkraefte", f"Wandkräfte — Wind {richtung}", "Scheibe",
                      figsize=(9, 4)) as fig:
        ax = fig.add_subplot(111)
        ax.bar([f"{w['id']}\n({w['achse']})" for w in waende],
               [w["H_kN"] for w in waende],
               color=["#c0392b" if w["achse"] == "x" else "#2f6fa8" for w in waende])
        ax.set_ylabel("H [kN]")
        ax.grid(axis="y", alpha=0.3)
        ax.set_title(f"Horizontalkräfte der aussteifenden Wände — Wind {richtung}")
        fig.tight_layout()


def _gamma_wind(modell) -> float:
    """
    Der Teilsicherheitsbeiwert des Windes, wenn der Plan einen Windlastfall führt.

    Steht keiner darin — der Regelfall, weil Wind nicht gezeichnet wird —, gilt
    1,5 nach DIN EN 1990 Tab. A.1.2(B).
    """
    for fall in modell.lastfaelle:
        if fall.get("art") == "W":
            return float(fall.get("gamma", 1.5))
    return 1.5


# ── Bemessung ──────────────────────────────────────────────────────────────


def _bemessung(bilder: Bilder, lauf: Lauf, modell, netz, huellen: dict, gzt: dict,
               xy, h: float, platte: dict, scheibendaten: dict,
               annahmen: Annahmen) -> dict:
    """
    Biegung mit Normalkraft, Mindestbewehrung, Mattenwahl und Staffelung.

    Die Normalkraft aus der Scheibe wirkt mit — fehlt die Scheibenrechnung,
    wird ohne sie bemessen und das im Bericht vermerkt.
    """
    c = bt.beton(platte["material"]["name"])
    c_nom = bt.betondeckung_mm(annahmen.exposition, annahmen.durchmesser_mm)
    d_x, d_y = bt.nutzhoehen(h, c_nom, annahmen.durchmesser_mm)
    a_s_min = bt.mindestbewehrung_cm2(h, d_x, c)
    a_s_max = bt.hoechstbewehrung_cm2(h)

    # Wood und Armer je GZT-Kombination, dann einhüllen: max(m_x) und max(m_xy)
    # müssen nicht aus derselben Kombination stammen.
    #
    # **In den Achsen des Gebäudes.** Ist das Raster gedreht (`plate.
    # hauptrichtung()`), stehen die Momente schon in seinen Achsen
    # (`plate.schnittgroessen()`) — „a_sx" ist die Bewehrung parallel zu x'.
    drehung = float(getattr(netz, "drehung", 0.0) or 0.0)
    wood = {bezeichnung: plate.bemessungsmomente(v["m_x"], v["m_y"], v["m_xy"])
            for bezeichnung, v in gzt.items()}
    wood["Einhüllende"] = plate.bemessungsmomente(
        huellen["m_x"]["max"], huellen["m_y"]["max"], huellen["m_xy"]["max"])
    wood["Einhüllende oben"] = plate.bemessungsmomente(
        huellen["m_x"]["min"], huellen["m_y"]["min"], huellen["m_xy"]["min"])
    if drehung:
        lauf.hinweis(f"Bewehrung in den Achsen des Gebäudes: x' unter "
                     f"{np.degrees(drehung):.1f}° gegen die x-Achse des Modells, y' senkrecht dazu.")

    bemessungsmoment = {lage: plate.einhuellende({k: v[lage] for k, v in wood.items()})["max"]
                        for lage in ("m_x_unten", "m_y_unten", "m_x_oben", "m_y_oben")}

    # Scheibenzug je Lage — die Hälfte, weil zwei Lagen ihn teilen.
    null = np.zeros(len(xy))
    n_zug = {"x": null, "y": null}
    if scheibendaten.get("gerechnet") and np.allclose(scheibendaten["xy"], xy):
        n_huelle = scheibendaten["n_huelle"]
        n_x, n_y, _ = plate.huelle_ins_raster(
            {"m_x": n_huelle["n_x"], "m_y": n_huelle["n_y"], "m_xy": n_huelle["n_xy"]},
            drehung, "max")
        n_zug = {"x": np.maximum(n_x, 0.0) / 2.0,
                 "y": np.maximum(n_y, 0.0) / 2.0}
    elif scheibendaten.get("gerechnet"):
        lauf.hinweis("Element-Reihenfolge von Platte und Scheibe weicht ab — die "
                     "Scheibennormalkraft ging nicht in die Biegebemessung ein.")

    lagen_beschreibung = [
        ("a_sx unten", "m_x_unten", d_x, n_zug["x"]),
        ("a_sy unten", "m_y_unten", d_y, n_zug["y"]),
        ("a_sx oben", "m_x_oben", d_x, n_zug["x"]),
        ("a_sy oben", "m_y_oben", d_y, n_zug["y"]),
    ]

    bewehrung = {}
    for bezeichnung, schluessel, d_lage, n_lage in lagen_beschreibung:
        m = bemessungsmoment[schluessel]
        ergebnis_lage = bt.biegebemessung(m, d_lage, c, h=h, n_Ed=n_lage)
        a_s = np.maximum(ergebnis_lage["a_s_cm2"], a_s_min)
        # Der Größtwert steht an einer Singularität (Wandende, einspringende
        # Ecke) und wächst mit jeder Netzverfeinerung. Bewehrt wird die Fläche
        # nach dem 99,5-%-Perzentil, die Spitze örtlich zugelegt.
        bewehrung[bezeichnung] = {
            "a_s": a_s, "m": m, "d": d_lage,
            # nanpercentile: innerhalb eines Unterzugs/Überzugs ist `a_s`
            # absichtlich NaN (siehe `plate.schnittgroessen()`) — die
            # maßgebende Bewehrung der *Platte* soll sich daran nicht
            # verschlucken.
            "flaeche_cm2": float(np.nanpercentile(a_s, 99.5)),
            **ergebnis_lage,
        }
        if ergebnis_lage.get("hinweis"):
            lauf.hinweis(f"{bezeichnung}: {ergebnis_lage['hinweis']}")

    with lauf.versuche("Bewehrungsbilder"):
        with bilder.figur("bewehrung", "Erforderliche Bewehrung", "Bemessung",
                          figsize=(11, 8)) as fig:
            achsen = fig.subplots(2, 2)
            for ax, (bezeichnung, *_rest) in zip(achsen.ravel(), lagen_beschreibung):
                zeichnen.karte(ax, xy, bewehrung[bezeichnung]["a_s"], netz,
                               titel=f"{bezeichnung} (erforderlich, ≥ a$_{{s,min}}$)",
                               einheit="cm²/m", symmetrisch=False, cmap="Reds")
            fig.tight_layout()
        for bezeichnung in ("a_sx unten", "a_sy unten", "a_sx oben", "a_sy oben"):
            bilder.ueberlagerung(f"ueber_{bezeichnung.replace(' ', '_')}",
                                 f"{bezeichnung} — erforderlich",
                                 xy, bewehrung[bezeichnung]["a_s"], netz,
                                 cmap="Reds", symmetrisch=False, einheit="cm²/m")

    with lauf.versuche("Mattenwahl"):
        _mattenbild(bilder, netz, xy, bewehrung, lagen_beschreibung)

    # Scheibenbewehrung — nur mit gerechneter Scheibe sinnvoll
    scheibenwahl = None
    if scheibendaten.get("gerechnet"):
        with lauf.versuche("Scheibenbewehrung"):
            scheibenwahl = _scheibenbewehrung(bilder, netz, scheibendaten, c, h)

    # Staffelung im Schnitt durch das größte Feldmoment
    staffel, y_schnitt = None, None
    with lauf.versuche("Staffelung"):
        staffel, y_schnitt = _staffelung(bilder, netz, xy, bemessungsmoment, n_zug,
                                         bewehrung, d_x, c, h, a_s_min)

    gewaehlt = {}
    for bezeichnung in bewehrung:
        bedarf = bewehrung[bezeichnung]["flaeche_cm2"]
        matte, vorhanden = bt.waehle_matte(bedarf)
        stab = bt.waehle_stab(bedarf, hoechstabstand_mm=bt.hoechstabstand_mm(h))
        gewaehlt[bezeichnung] = {
            "erforderlich_cm2": round(bedarf, 2),
            "spitze_cm2": round(float(np.nanmax(bewehrung[bezeichnung]["a_s"])), 2),
            "matte": matte, "matte_cm2": round(vorhanden, 2),
            "stab": f"Ø{stab['durchmesser_mm']}/{stab['abstand_mm']}",
            "stab_cm2": round(stab["a_s_cm2"], 2),
        }

    bericht = {
        "beton": str(c),
        "bemessung": {
            "exposition": annahmen.exposition,
            "c_nom_mm": round(c_nom, 1),
            "d_x_m": round(d_x, 4), "d_y_m": round(d_y, 4),
            "mindestbewehrung_cm2": round(a_s_min, 2),
            "hoechstbewehrung_cm2": round(a_s_max, 1),
            "hoechstabstand_mm": round(bt.hoechstabstand_mm(h), 0),
        },
        "bewehrung": gewaehlt,
        "momente_kNm_je_m": {
            # nanmax/nanmin: siehe Hinweis bei `flaeche_cm2` oben.
            "m_x_max": round(float(np.nanmax(huellen["m_x"]["max"])), 2),
            "m_x_min": round(float(np.nanmin(huellen["m_x"]["min"])), 2),
            "m_y_max": round(float(np.nanmax(huellen["m_y"]["max"])), 2),
            "m_y_min": round(float(np.nanmin(huellen["m_y"]["min"])), 2),
            "m_xy_max": round(float(np.nanmax(np.abs(huellen["m_xy"]["max"]))), 2),
        },
    }
    if staffel is not None:
        bericht["staffelung"] = {
            "schnitt_y_m": round(float(y_schnitt), 3),
            "grund": staffel["grund_bezeichnung"],
            "grund_cm2": round(float(staffel["grund_cm2"]), 2),
            "versatzmass_m": round(float(staffel["versatzmass_m"]), 2),
            "zulagen": staffel["zulagen"],
        }
    if scheibenwahl is not None:
        bericht["scheibenbewehrung"] = {
            "a_sx_max_cm2": round(float(scheibenwahl["a_sx_cm2"].max()), 2),
            "a_sy_max_cm2": round(float(scheibenwahl["a_sy_cm2"].max()), 2),
            "druckstrebe": round(float(scheibenwahl["ausnutzung_druckstrebe"].max()), 3),
            "sigma_c_zul_MNm2": round(float(scheibenwahl["sigma_c_zul_MNm2"]), 2),
            "ringanker_kN": round(float(bt.ringanker_kN(
                float(max(netz.polygon.max(axis=0) - netz.polygon.min(axis=0))))), 0),
        }

    return {
        "bericht": bericht, "bewehrung": bewehrung, "gewaehlt": gewaehlt,
        "beton": c, "d_x": d_x, "d_y": d_y, "a_s_min": a_s_min, "a_s_max": a_s_max,
        "scheibenwahl": scheibenwahl, "staffel": staffel,
    }


def _mattenbild(bilder: Bilder, netz, xy, bewehrung: dict, lagen_beschreibung) -> None:
    """
    Der Bedarf ist stetig, die Ausführung nicht.

    Die Stufenkarte beantwortet die Frage, die auf der Baustelle gestellt wird:
    was liegt hier?
    """
    matten = list(bt.MATTEN.items())
    grenzen = [0.0] + [wert[0] for _, wert in matten[:5]] + [99.0]
    namen = [f"< {matten[0][1][0]:.2f}"] + [name for name, _ in matten[:5]] + ["größer"]

    with bilder.figur("mattenwahl", "Mattenwahl", "Bemessung", figsize=(11.5, 8)) as fig:
        achsen = fig.subplots(2, 2)
        for ax, (bezeichnung, *_rest) in zip(achsen.ravel(), lagen_beschreibung):
            zeichnen.stufenkarte(ax, xy, bewehrung[bezeichnung]["a_s"], grenzen, netz,
                                 titel=f"{bezeichnung} — Mattenwahl", beschriftung=namen)
        fig.tight_layout()


def _scheibenbewehrung(bilder: Bilder, netz, scheibendaten: dict, c, h: float) -> dict:
    n_huelle = scheibendaten["n_huelle"]
    xy_s = scheibendaten["xy"]
    # Die tatsächliche Querschnittshöhe je Säule statt der Plattendicke: im
    # Streifen eines Unterzugs ist sie größer, und mit `h` stünde dort eine zu
    # hohe Betonspannung — ausgerechnet dort, wo die Scheibe ihren Gurt hat.
    hoehe = scheibendaten["membran"].get("hoehe_m", h)
    wahl = bt.scheibenbewehrung(
        n_huelle["n_x"]["max"], n_huelle["n_y"]["max"],
        np.maximum(np.abs(n_huelle["n_xy"]["max"]), np.abs(n_huelle["n_xy"]["min"])),
        c, hoehe)

    with bilder.figur("scheibenbewehrung", "Bewehrung aus der Scheibe", "Scheibe",
                      figsize=(15, 4.3)) as fig:
        achsen = fig.subplots(1, 3)
        zeichnen.karte(achsen[0], xy_s, wahl["a_sx_cm2"], netz,
                       titel="a$_{sx}$ aus der Scheibe", einheit="cm²/m",
                       symmetrisch=False, cmap="Reds")
        zeichnen.karte(achsen[1], xy_s, wahl["a_sy_cm2"], netz,
                       titel="a$_{sy}$ aus der Scheibe", einheit="cm²/m",
                       symmetrisch=False, cmap="Reds")
        zeichnen.karte(achsen[2], xy_s, wahl["ausnutzung_druckstrebe"], netz,
                       titel="Druckstrebe σ$_c$ / (ν·f$_{cd}$)", einheit="–",
                       symmetrisch=False, cmap="YlOrBr")
        fig.tight_layout()
    return wahl


def _staffelung(bilder: Bilder, netz, xy, bemessungsmoment: dict, n_zug: dict,
                bewehrung: dict, d_x: float, c, h: float, a_s_min: float):
    """
    Zugkraftdeckung im Schnitt durch das größte Feldmoment.

    Die Länge einer Zulage folgt nicht aus dem Bereich, in dem der Bedarf die
    Grundbewehrung übersteigt, sondern aus diesem Bereich beidseitig verlängert
    um Versatzmaß und Verankerungslänge — der häufigste Fehler an dieser Stelle.
    """
    # nanargmax statt argmax: sonst könnte eine NaN-Spalte innerhalb eines
    # Unterzugs/Überzugs (siehe `plate.schnittgroessen()`) als „größtes
    # Feldmoment" gelten und der Schnitt liefe durch den Balken statt durchs
    # Feld.
    i_max = int(np.nanargmax(bemessungsmoment["m_x_unten"]))
    # Entlang x' des Rasters — bei einem gedrehten Gebäude in seiner Achse;
    # `y_schnitt` ist die Lage quer dazu, in seinem System.
    a, b = plate.rasterlinie(netz, xy[i_max], 0)
    y_schnitt = float(netz.lokal(xy[i_max:i_max + 1])[0, 1])

    laenge, m_schnitt = plate.entlang(xy, bemessungsmoment["m_x_unten"], a, b,
                                      n=240, netz=netz)
    _, n_schnitt = plate.entlang(xy, n_zug["x"], a, b, n=240, netz=netz)

    auf_der_platte = np.isfinite(m_schnitt)
    as_schnitt = np.where(
        auf_der_platte,
        np.maximum(bt.biegebemessung(np.nan_to_num(m_schnitt), d_x, c, h=h,
                                     n_Ed=np.nan_to_num(n_schnitt))["a_s_cm2"], a_s_min),
        np.nan)
    # durchmesser_mm=None: die Zulage darf einen anderen Durchmesser haben als
    # die Grundbewehrung — sonst wird die kleinste mögliche Zulage unnötig groß.
    staffel = bt.staffelung(laenge, as_schnitt, d_x, c, a_s_min_cm2=a_s_min,
                            durchmesser_mm=None, guter_verbund=True)

    with bilder.figur("staffelung", f"Zugkraftdeckung im Schnitt y = {y_schnitt:.2f} m",
                      "Bemessung", figsize=(12, 8)) as fig:
        achsen = fig.subplots(2, 1, height_ratios=[1, 1.25])
        achsen[0].fill_between(laenge, 0, as_schnitt, color="#c0392b", alpha=0.25,
                               label="a$_s$ erforderlich")
        achsen[0].plot(laenge, np.where(auf_der_platte, staffel["a_s_vorhanden_cm2"], np.nan),
                       color="#5c7a12", lw=2, drawstyle="steps-mid", label="a$_s$ gestaffelt")
        achsen[0].axhline(a_s_min, color="k", ls=":", lw=1, label="a$_{s,min}$")
        achsen[0].set_ylabel("a$_s$ [cm²/m]")
        achsen[0].legend(fontsize=8)
        achsen[0].grid(alpha=0.3)
        achsen[0].set_title(f"Bewehrung im Schnitt y = {y_schnitt:.2f} m")
        zeichnen.staffelung(achsen[1], laenge, m_schnitt, staffel, d_x)
        fig.tight_layout()

    # Dieselbe Staffelung flächig — die Karte, aus der die Positionsliste wird
    zuwachs = sorted({round(z["a_s_cm2"], 2) for z in staffel["zulagen"]})
    stufen = sorted({0.0, staffel["grund_cm2"], *[staffel["grund_cm2"] + z for z in zuwachs]})
    namen = ([staffel["grund_bezeichnung"]] + [f"+ {z:.2f} cm²/m" for z in zuwachs] + ["darüber"])
    stufen = stufen + [stufen[-1] + 99]

    with bilder.figur("bewehrungsplan", "Grundbewehrung und Zulagen", "Bemessung",
                      figsize=(13, 4.8)) as fig:
        achsen = fig.subplots(1, 2)
        zeichnen.stufenkarte(achsen[0], xy, bewehrung["a_sx unten"]["a_s"], stufen, netz,
                             titel="untere Bewehrung in x — Grundnetz und Zulagen",
                             beschriftung=namen)
        achsen[0].plot([a[0], b[0]], [a[1], b[1]], color="k", ls="--", lw=1)
        achsen[0].text(a[0], a[1], " Schnitt", va="bottom", fontsize=8)
        zeichnen.stufenkarte(achsen[1], xy, bewehrung["a_sx oben"]["a_s"], stufen, netz,
                             titel="obere Bewehrung in x — Stützbereiche",
                             beschriftung=namen)
        fig.tight_layout()

    return staffel, y_schnitt


# ── Unterzüge ──────────────────────────────────────────────────────────────


def _unterzuege(bilder: Bilder, lauf: Lauf, modell, netz, u_gzt: dict,
                u_qs: np.ndarray,
                E: float, nu: float, c, balken: list, scheibendaten: dict,
                annahmen: Annahmen) -> dict:
    """
    Jeder Unterzug als Plattenbalken: System, Durchbiegung, Biegung, Querkraft,
    Staffelung.

    Fünf Bilder je Balken, in derselben Reihenfolge wie im Notebook — der
    Zeichenmodus zeigt sie als eigene Gruppe neben den Plattenkarten. Ein
    Balken, dessen Streifen aus dem Umriss läuft, wird gemeldet und
    übersprungen; die übrigen werden fertig gerechnet. Danach eine
    Übersichtskarte, die alle Balken zusammen im Grundriss zeigt.

    Die Gurtkraft aus der Deckenscheibe geht mit ein, wenn die Scheibenrechnung
    durchgelaufen ist: unter Wind und Schiefstellung ist der Unterzug der Gurt
    des tiefen Trägers, den die Decke bildet. `u_qs` ist die quasi-ständige
    Verschiebung — dieselbe, mit der die Platte ihren Durchbiegungsnachweis
    führt (Abschnitt 6) —, damit auch der Balken einen bekommt.
    """
    c_nom = bt.betondeckung_mm(annahmen.exposition, annahmen.laengsstab_mm)
    u_scheibe = scheibendaten.get("u_massgebend") if scheibendaten.get("gerechnet") else None

    ergebnisse: dict = {}
    for b in balken:
        with lauf.versuche(f"Unterzug {b.id}"):
            erg = unterzug.rechne(modell, netz, u_gzt, E, nu, c, b,
                                  c_nom_mm=c_nom, buegel_mm=annahmen.buegel_mm,
                                  laengs_mm=annahmen.laengsstab_mm,
                                  andere=balken, scheibenloesung=u_scheibe,
                                  quasistaendig=u_qs)
            bem = erg["bemessung"]
            if bem.get("hinweis"):
                lauf.hinweis(f"Unterzug {b.id}: {bem['hinweis']}")
            for lage in ("unten", "oben"):
                staffel = erg.get(f"staffelung_{lage}")
                if staffel and staffel.get("hinweis"):
                    lauf.hinweis(f"Unterzug {b.id}, Lage {lage}: {staffel['hinweis']}")

            with lauf.versuche(f"Unterzug {b.id} — System"):
                _balkenbild_system(bilder, modell, netz, erg)
            with lauf.versuche(f"Unterzug {b.id} — Durchbiegung"):
                with bilder.figur(f"uz_{b.id}_durchbiegung", f"Unterzug {b.id} — Durchbiegung",
                                  "Unterzüge", figsize=(13, 3.6)) as fig:
                    zeichnen.balkendurchbiegung(fig.add_subplot(111), erg)
                    fig.tight_layout()
            with lauf.versuche(f"Unterzug {b.id} — Biegung"):
                with bilder.figur(f"uz_{b.id}_biegung", f"Unterzug {b.id} — Biegebemessung",
                                  "Unterzüge", figsize=(13, 4.6)) as fig:
                    zeichnen.balkenmomente(fig.add_subplot(111), erg)
                    fig.tight_layout()
            with lauf.versuche(f"Unterzug {b.id} — Querkraft"):
                with bilder.figur(f"uz_{b.id}_querkraft", f"Unterzug {b.id} — Querkraft",
                                  "Unterzüge", figsize=(13, 4.6)) as fig:
                    zeichnen.balkenquerkraft(fig.add_subplot(111), erg)
                    fig.tight_layout()
            with lauf.versuche(f"Unterzug {b.id} — Staffelung"):
                _balkenbild_staffelung(bilder, erg)

            erg["bericht"] = _balkenbericht(erg)
            ergebnisse[b.id] = erg

    if ergebnisse:
        with lauf.versuche("Unterzüge — Übersicht"):
            ausnutzung_uz = {
                kennung: _unterzug_ausnutzung(erg) for kennung, erg in ergebnisse.items()
            }
            with bilder.figur("uz_uebersicht", "Unterzüge — Übersicht im Grundriss",
                              "Unterzüge", figsize=(10, 6.5)) as fig:
                zeichnen.unterzugsuebersicht(fig.add_subplot(111), netz, ergebnisse,
                                             ausnutzung_uz)
                fig.tight_layout()
    return ergebnisse


def _unterzug_ausnutzung(erg: dict) -> float:
    """
    Eine Zahl je Unterzug für die Übersichtskarte: das Schlimmere aus Biegung
    und Druckstrebe — dieselben beiden Werte, die auch in der Nachweisampel
    (`_nachweise()`) je Unterzug erscheinen.
    """
    bem = erg["bemessung"]
    biegung = float(max(np.nanmax(bem["mu_unten"]), np.nanmax(bem["mu_oben"]))) / bt.MU_GRENZ
    druckstrebe = float(np.nanmax(np.atleast_1d(bem["querkraft"]["ausnutzung_druckstrebe"])))
    return max(biegung, druckstrebe)


def _balkenbild_system(bilder: Bilder, modell, netz, erg: dict) -> None:
    b = erg["balken"]
    with bilder.figur(f"uz_{b.id}_system", f"Unterzug {b.id} — statisches System",
                      "Unterzüge", figsize=(13, 6.2)) as fig:
        gitter = fig.add_gridspec(2, 3, height_ratios=[1.0, 0.95])
        zeichnen.balkensystem(fig.add_subplot(gitter[0, :]), erg)

        ax = fig.add_subplot(gitter[1, 0])
        zeichnen.plan(ax, modell, netz, lasten=False, positionen=False, beschriften=False)
        ax.set_title(f"Lage von {b.id} im Grundriss")

        zeichnen.balkenquerschnitt(fig.add_subplot(gitter[1, 1]), b,
                                   erg["staffelung_unten"],
                                   erg["buegel"][0] if erg["buegel"] else None,
                                   b_eff=erg["schnitt"]["breite_ist_m"],
                                   staffel_oben=erg["staffelung_oben"])

        ax = fig.add_subplot(gitter[1, 2])
        ax.axis("off")
        felder_txt = " · ".join("{:.2f}".format(f["l_0_m"]) for f in erg["felder"])
        bem = erg["bemessung"]
        zeilen = [
            f"{b.id} — {b.art}",
            f"b_w = {b.breite_m*100:.0f} cm, h = {b.hoehe_m*100:.0f} cm",
            f"Steg unter der Platte: {b.steg_m*100:.0f} cm",
            "",
            f"Felder (l_0): {felder_txt} m",
            f"maßgebend l_0 = {erg['l_0_m']:.2f} m",
            f"b_eff = {erg['breite']['b_eff_m']:.2f} m",
            f"integriert: {erg['schnitt']['breite_ist_m']:.2f} m",
            "",
        ]
        # Erforderlich *und* gelegt, je Lage: die Grenzwerte allein sagen nicht,
        # ob die Staffelung deckt — und die Summe unten allein verschweigt, dass
        # oben regelmäßig mehr liegt.
        for name in ("unten", "oben"):
            staffel = erg.get(f"staffelung_{name}")
            if not staffel:
                continue
            bild = staffel.get("bild") or {}
            lagen = len(bild.get("lagen", [])) or 1
            zeilen += [
                f"{name}: d = {bem['d'][f'd_{name}_m']*100:.1f} cm"
                + (f" ({lagen} Lagen)" if lagen > 1 else ""),
                f"  erf. {np.nanmax(bem[f'a_s_{name}_cm2']):.2f} cm²  "
                f"gelegt {bild.get('a_s_cm2', staffel['grund_cm2']):.2f} cm²",
                f"  {bild.get('n', 0)} Ø {bild.get('ds_mm', 0):.0f}"
                f" = {staffel['grund_bezeichnung']}"
                + "".join(f" + {z['bezeichnung']}" for z in staffel["zulagen"]),
            ]
        zeilen += ["",
                   f"A_s,min = {bem['a_s_min_cm2']:.2f} cm²",
                   f"A_s,max = {bem['a_s_max_cm2']:.1f} cm²"]
        ax.text(0.0, 0.98, "\n".join(zeilen),
                va="top", ha="left", fontsize=8.0, family="monospace",
                transform=ax.transAxes)
        fig.tight_layout()


def _balkenbild_staffelung(bilder: Bilder, erg: dict) -> None:
    """Zugkraftdeckung je Lage, darunter die Bewehrungsskizze im Aufriss."""
    b = erg["balken"]
    lagen = [("unten", erg["staffelung_unten"],
              np.maximum(erg["schnitt"]["M_max_kNm"], 0.0))]
    if erg["staffelung_oben"] is not None:
        lagen.append(("oben", erg["staffelung_oben"],
                      np.maximum(-erg["schnitt"]["M_min_kNm"], 0.0)))

    with bilder.figur(f"uz_{b.id}_staffelung",
                      f"Unterzug {b.id} — gestaffelte Bewehrung", "Unterzüge",
                      figsize=(13, 4.2 * len(lagen) + 4.0)) as fig:
        achsen = np.atleast_1d(fig.subplots(
            len(lagen) + 1, 1, height_ratios=[1.15] * len(lagen) + [1.0]))
        for ax, (seite, staffel, m) in zip(achsen, lagen):
            zeichnen.staffelung(ax, erg["schnitt"]["s"], m, staffel,
                                staffel["versatzmass_m"],
                                titel=f"Zugkraftdeckung {b.id}, Lage {seite}")
        zeichnen.bewehrungsskizze(achsen[-1], erg, "beide")
        fig.tight_layout()


def _endlich(wert) -> float | None:
    """Zahl für den Bericht — `inf`/`NaN` werden zu `None`, JSON kennt sie nicht."""
    wert = float(wert)
    return round(wert, 1) if np.isfinite(wert) else None


def _balkenbericht(erg: dict) -> dict:
    b, s, bem = erg["balken"], erg["schnitt"], erg["bemessung"]
    quer = bem["querkraft"]

    def lage(name, staffel):
        if staffel is None:
            return None
        bild = staffel.get("bild") or {}
        return {
            "grund": staffel["grund_bezeichnung"],
            "grund_cm2": round(float(staffel["grund_cm2"]), 2),
            "versatzmass_m": round(float(staffel["versatzmass_m"]), 2),
            "cot_theta": round(float(staffel["cot_theta"]), 2),
            "zulagen": staffel["zulagen"],
            # Was an der ungünstigsten Stelle zusammen im Bügel liegt — die
            # Summe, die auf der Baustelle gelegt wird, samt Lagenzahl und
            # Abstandsnachweis nach EC2 8.2.
            "staebe": bild.get("n"),
            "durchmesser_mm": bild.get("ds_mm"),
            "a_s_gelegt_cm2": (round(float(bild["a_s_cm2"]), 2)
                               if bild.get("a_s_cm2") is not None else None),
            "staebe_durchlaufend": staffel.get("staebe_grund"),
            "staebe_je_lage": staffel.get("staebe_je_lage"),
            "lagen": len(bild.get("lagen", [])) or None,
            "d_m": round(float(bild["d_m"]), 4) if bild.get("d_m") else None,
            # `inf` steht für eine Lage mit einem einzigen Stab — dort gibt es
            # keinen Nachbarn und damit keinen Abstand. Als `None` heraus, sonst
            # steht im JSON `Infinity` und kein Leser kommt damit zurecht.
            "s_licht_mm": _endlich(min((p["vorhanden_mm"] for p in bild["pruefungen"]),
                                       default=float("inf"))),
            "s_min_mm": bild.get("s_min_mm"),
            "passt": bild.get("passt"),
            "hinweis": staffel.get("hinweis", ""),
        }

    return {
        "art": b.art,
        "achse": "x" if b.achse == 0 else "y",
        "b_w_m": b.breite_m, "h_m": b.hoehe_m, "laenge_m": round(b.laenge_m, 3),
        "b_eff_m": round(float(erg["breite"]["b_eff_m"]), 3),
        "b_integriert_m": round(float(s["breite_ist_m"]), 3),
        "l_0_m": round(float(erg["l_0_m"]), 3),
        "felder_m": [round(float(f["l_0_m"]), 3) for f in erg["felder"]],
        "d_m": round(float(bem["d"]["d_unten_m"]), 4),
        "M_feld_kNm": round(float(np.max(s["M_max_kNm"])), 1),
        "M_stuetze_kNm": round(float(np.min(s["M_min_kNm"])), 1),
        "V_max_kN": round(float(np.max(s["V_kN"])), 1),
        "N_gurt_kN": round(float(np.max(erg["n_gurt_kN"])), 1),
        "a_s_unten_cm2": round(float(np.max(bem["a_s_unten_cm2"])), 2),
        "a_s_oben_cm2": round(float(np.max(bem["a_s_oben_cm2"])), 2),
        "a_s_min_cm2": round(float(bem["a_s_min_cm2"]), 2),
        "a_sw_max_cm2_je_m": round(float(np.max(np.atleast_1d(quer["a_sw_cm2_je_m"]))), 2),
        "cot_theta": [round(float(np.min(np.atleast_1d(quer["cot_theta"]))), 2),
                      round(float(np.max(np.atleast_1d(quer["cot_theta"]))), 2)],
        "druckstrebe": round(float(np.max(np.atleast_1d(quer["ausnutzung_druckstrebe"]))), 3),
        "buegel": erg["buegel"],
        "lager_m": [round(float(l["s_m"]), 3) for l in erg["lager"]],
        "staffelung_unten": lage("unten", erg["staffelung_unten"]),
        "staffelung_oben": lage("oben", erg["staffelung_oben"]),
        "hinweis": bem.get("hinweis", ""),
        "durchbiegung_mm": (round(float(erg["durchbiegung"]["w_max_mm"]), 2)
                            if erg.get("durchbiegung") else None),
        "durchbiegung_grenzwert_mm": (round(float(erg["durchbiegung"]["grenzwert_bei_max_mm"]), 1)
                                      if erg.get("durchbiegung") else None),
        "durchbiegung_ausnutzung": (round(float(erg["durchbiegung"]["ausnutzung_max"]), 3)
                                    if erg.get("durchbiegung") else None),
    }


# ── Nachweise ──────────────────────────────────────────────────────────────


def _felder_ablegen(ausgabe: Path, netz, modell, xy, xy_knoten, unten,
                    verschiebungen: dict, schnitte: dict, huellen: dict,
                    bemessung: dict, massgebend: str, quasi: str,
                    bericht: dict) -> None:
    """
    Die Ergebnisfelder als `felder.npz` — die Grundlage der Ergebnispunktwolke.

    Zwei Ortsraster, weil die Größen an verschiedenen Stellen entstehen:
    Verschiebungen an den **Knoten** der Plattenunterseite, Schnittgrößen und
    Bewehrung in den **Elementmitten**. Sie zu einem gemeinsamen Raster zu
    interpolieren wäre bequemer und würde genau die Kanten verschmieren, die
    man in einer Momentenkarte sehen will.

    Die z-Koordinate bleibt hier absichtlich weg: sie hängt an der Lage der
    Platte im Bauwerk, und die kennt erst der Aufrufer aus der Hüllbox der
    Slab. `ergebniswolke.aufbauen()` setzt sie.
    """
    import numpy as _np

    s = schnitte[massgebend]
    daten = {
        "xy_element": _np.asarray(xy, dtype="f4"),
        "xy_knoten": _np.asarray(xy_knoten, dtype="f4"),
        "m_x": _np.asarray(s["m_x"], dtype="f4"),
        "m_y": _np.asarray(s["m_y"], dtype="f4"),
        "m_xy": _np.asarray(s["m_xy"], dtype="f4"),
        "m_x_max": _np.asarray(huellen["m_x"]["max"], dtype="f4"),
        "m_x_min": _np.asarray(huellen["m_x"]["min"], dtype="f4"),
        "m_y_max": _np.asarray(huellen["m_y"]["max"], dtype="f4"),
        "m_y_min": _np.asarray(huellen["m_y"]["min"], dtype="f4"),
        "umriss": _np.asarray(netz.polygon, dtype="f4"),
        "dicke_m": _np.asarray([netz.dicke], dtype="f4"),
        "elementgroesse_m": _np.asarray([netz.groesse], dtype="f4"),
    }

    # Durchbiegung in mm, an den Knoten der Unterseite. Vorzeichen wie im
    # Bild: eine Senkung ist negativ.
    for kennung, bezeichnung in ((massgebend, "w_gzt"), (quasi, "w_qs")):
        u = _np.asarray(verschiebungen[kennung]).reshape(netz.n_knoten, 3)
        daten[bezeichnung] = _np.asarray(u[unten][:, 2] * 1000.0, dtype="f4")

    for name, feld in (bemessung.get("bewehrung") or {}).items():
        if isinstance(feld, dict) and "a_s" in feld:
            schluessel = "a_s_" + name.replace(" ", "_")
            daten[schluessel] = _np.asarray(feld["a_s"], dtype="f4")

    ziel = Path(ausgabe) / "felder.npz"
    _np.savez_compressed(ziel, **daten)
    bericht["felder"] = {
        "datei": ziel.name,
        "bytes": ziel.stat().st_size,
        "knoten": int(len(daten["xy_knoten"])),
        "elemente": int(len(daten["xy_element"])),
        "groessen": sorted(k for k in daten if k not in
                           ("xy_element", "xy_knoten", "umriss", "dicke_m",
                            "elementgroesse_m")),
        "kombination": massgebend,
        "kombination_qs": quasi,
    }


def _nachweise(lauf: Lauf, modell, bilanz: list[dict], bemessung: dict, schnitte: dict,
               durchbiegung: dict, h: float, annahmen: Annahmen,
               bericht: dict, unterzuege: dict | None = None) -> list[tuple[str, float]]:
    """
    Querkraft, Durchstanzen, Rissbreite, Verformung — und die Ausnutzungen daneben.

    Jeder Nachweis steht in seinem eigenen `versuche()`: fehlt ein Punktauflager,
    entfällt das Durchstanzen; hat die Decke nur Punktlager, entfällt der
    Querkraftnachweis am Linienlager. Beides darf die übrigen nicht mitnehmen.
    """
    c = bemessung["beton"]
    d_x = bemessung["d_x"]
    bewehrung = bemessung["bewehrung"]
    a_s_max = bemessung["a_s_max"]
    nachweise: list[tuple[str, float]] = []

    a_sl = float(np.nanpercentile(bewehrung["a_sx unten"]["a_s"], 50))

    # **Auflager, auf denen ein Unterzug aufliegt, zählen hier nicht mit.**
    # `auflagerbilanz()` teilt die Auflagerkraft durch die gezeichnete Länge des
    # Lagers — bei einer 1,2-m-Wand unter einem Unterzug kommt die ganze
    # Balkenauflagerkraft auf diese Länge und ergibt einen „Plattenschub" von
    # mehreren hundert kN/m. Der ist kein Plattenschub: die Kraft läuft durch
    # den Steg, nicht durch die Platte, und ihr Nachweis ist der des Balkens
    # (Bügel, Abschnitt „Unterzüge"). Ohne diese Ausnahme fällt ein
    # Deckensystem mit Unterzug immer durch, und zwar am falschen Nachweis.
    balkenlager = {l["id"] for erg in (unterzuege or {}).values() for l in erg["lager"]}

    # Querkraft am Auflagerrand — dort ist v_Ed am größten und exakt bekannt
    with lauf.versuche("Querkraftnachweis"):
        linien = [e for e in bilanz
                  if e.get("R_je_m_kNm") is not None and e["id"] not in balkenlager]
        if linien:
            lager = max(linien, key=lambda e: abs(e["R_je_m_kNm"]))
            v_Ed = abs(lager["R_je_m_kNm"])
            v_Rd = float(bt.querkraftwiderstand(d_x, a_sl, c)["v_Rd_c_kNm"])
            nachweise.append((f"Querkraft {lager['id']}", v_Ed / max(v_Rd, 1e-9)))
        else:
            lauf.hinweis("Keine Linienauflager ohne Unterzug — der Querkraftnachweis "
                         "der Platte am Auflagerrand entfällt.")
    if balkenlager:
        lauf.hinweis(
            f"Auflager {', '.join(sorted(balkenlager))} tragen einen Unterzug — dort ist "
            "R/l kein Plattenschub (die Kraft läuft durch den Steg). Der maßgebende "
            "Querkraftnachweis dieser Stellen steht bei den Unterzügen.")

    # Durchstanzen an den Punktauflagern
    #
    # Position und Stützenmaße kommen aus `modell.auflager`, nicht aus `bilanz`
    # selbst (die kennt nur Kräfte) — für den Ergebnisplan (`zeichnen.durchstanzplan`)
    # und die Rechenweg-Tabelle (`_durchstanzbild`) muss beides zusammen vorliegen.
    lager_by_id = {l["id"]: l for l in modell.auflager}
    durchstanz_details: list[dict] = []
    with lauf.versuche("Durchstanznachweis"):
        punkte = [e for e in bilanz if e["typ"] == "punkt" and e["id"] not in balkenlager]
        for eintrag in punkte:
            stuetze_m = (0.30, 0.30)
            ds = bt.durchstanzen(abs(eintrag["R_z_kN"]), d_x, c, stuetze_m,
                                 rho_l=a_sl * 1e-4 / d_x, beta=1.10)
            nachweise.append((f"Durchstanzen {eintrag['id']}", float(ds["ausnutzung"])))
            lager = lager_by_id.get(eintrag["id"])
            if lager is not None:
                durchstanz_details.append({
                    "id": eintrag["id"], "p": [float(v) for v in lager["p"]],
                    "stuetze_m": list(stuetze_m), "rund": False, "d": float(d_x),
                    "V_Ed_kN": round(float(abs(eintrag["R_z_kN"])), 2),
                    **{k: round(float(v), 4) if isinstance(v, (float, np.floating)) else v
                       for k, v in ds.items()},
                })
            if ds["bewehrung_noetig"]:
                lauf.hinweis(f"Durchstanzen {eintrag['id']}: Durchstanzbewehrung nötig.")
    bericht["durchstanzen_details"] = durchstanz_details

    # Rissbreite unter quasi-ständiger Last, je Lage mit ihrer eigenen Bewehrung
    gewaehlt_stab = {}
    with lauf.versuche("Rissnachweis"):
        quasi = _quasi_staendig(schnitte)
        s_qs = schnitte[quasi]
        m_feld = float(max(np.nanmax(s_qs["m_x"]), 0.0))
        for bezeichnung, moment in (("a_sx unten", m_feld),
                                    ("a_sx oben", float(max(-np.nanmin(s_qs["m_x"]), 0.0)))):
            # Bei Platten bestimmt regelmäßig nicht die Tragfähigkeit den
            # Stababstand, sondern die Rissbreite — deshalb wird die Wahl so
            # lange enger gezogen, bis der Nachweis aufgeht.
            grenze = bt.hoechstabstand_mm(h)
            riss = None
            for _ in range(5):
                wahl = bt.waehle_stab(bewehrung[bezeichnung]["flaeche_cm2"],
                                      hoechstabstand_mm=grenze)
                sigma_s = float(bt.stahlspannung_MNm2(moment, wahl["a_s_cm2"], d_x))
                riss = bt.rissnachweis(sigma_s, wahl["abstand_mm"])
                if riss["erfuellt"] or grenze <= 100:
                    break
                grenze = float(riss["abstand_zul_mm"])
            gewaehlt_stab[bezeichnung] = wahl
            nachweise.append((f"Rissbreite {bezeichnung}", float(riss["ausnutzung"])))

    # Verformung im Zustand II — der elastische Wert weist nichts nach
    with lauf.versuche("Verformungsnachweis"):
        quasi = _quasi_staendig(schnitte)
        m_qs = float(max(np.nanmax(schnitte[quasi]["m_x"]), 0.0))
        wahl = gewaehlt_stab.get("a_sx unten")
        a_s_vorh = wahl["a_s_cm2"] if wahl else bewehrung["a_sx unten"]["flaeche_cm2"]
        z2 = bt.zustand_II(durchbiegung["w_max_mm"], m_qs, a_s_vorh, h, d_x, c,
                           kriechzahl=annahmen.kriechzahl)
        nachweise.append(("Verformung Zustand II",
                          float(z2["w_mm"]) / max(float(durchbiegung["grenzwert_mm"]), 1e-9)))
        bericht.setdefault("durchbiegung", {}).update({
            "zustand": "gerissen" if z2["gerissen"] else "ungerissen",
            "m_cr_kNm": round(float(z2["m_cr_kNm"]), 2),
            "zeta": round(float(z2["zeta"]), 3),
            "faktor": round(float(z2["faktor"]), 2),
            "kriechzahl": annahmen.kriechzahl,
            "w_zustand_II_mm": round(float(z2["w_mm"]), 2),
        })

    # nanmax: `mu`/`a_s` sind innerhalb eines Unterzugs/Überzugs absichtlich
    # NaN (siehe `plate.schnittgroessen()`) — ein `max()`, der das mitnimmt,
    # machte aus jedem dieser beiden Nachweise ein NaN, und `NaN > 1.0` ist
    # False: der Nachweis stünde fälschlich als erfüllt da, statt als offen.
    nachweise.append(("Biegung Platte (μ/μ_lim)",
                      float(max(np.nanmax(b["mu"]) for b in bewehrung.values())) / bt.MU_GRENZ))
    if bemessung.get("scheibenwahl") is not None:
        nachweise.append(("Druckstrebe Scheibe",
                          float(np.nanmax(bemessung["scheibenwahl"]["ausnutzung_druckstrebe"]))))
    nachweise.append(("Bewehrungsgrad Platte (a_s/a_s,max)",
                      float(max(np.nanmax(b["a_s"]) for b in bewehrung.values())) / a_s_max))

    # Die Unterzüge stehen in derselben Ampel wie die Platte: ein Balken, dessen
    # Druckstrebe nicht reicht, macht die ganze Decke unbrauchbar, und das darf
    # nicht in einer eigenen Tabelle stehen, die niemand aufschlägt.
    for kennung, erg in (unterzuege or {}).items():
        bem_u = erg["bemessung"]
        nachweise.append((f"Unterzug {kennung} Biegung",
                          float(max(np.nanmax(bem_u["mu_unten"]),
                                    np.nanmax(bem_u["mu_oben"]))) / bt.MU_GRENZ))
        nachweise.append((f"Unterzug {kennung} Druckstrebe",
                          float(np.nanmax(np.atleast_1d(
                              bem_u["querkraft"]["ausnutzung_druckstrebe"])))))
    return nachweise


# ── Kleinkram ──────────────────────────────────────────────────────────────


def _quasi_staendig(nach_kombination: dict) -> str:
    """
    Der Schlüssel der quasi-ständigen Kombination.

    Er wird an drei Stellen gebraucht (Durchbiegung, Rissbreite, Verformung) und
    heißt in `plate.kombinationen()` „GZG · quasi-ständig". Gesucht wird
    trotzdem, statt den String zu wiederholen: eine Umbenennung dort soll hier
    nicht als KeyError ankommen.
    """
    for name in nach_kombination:
        if "quasi" in name.lower():
            return name
    for name in nach_kombination:
        if name.startswith("GZG"):
            return name
    return next(iter(nach_kombination))
