"""
Bilder für die Plattenstatik — die wiederkehrenden Darstellungen an einem Ort.

Ein Statikergebnis wird nicht gelesen, sondern angesehen. Die Karten hier sind
deshalb nicht Beiwerk, sondern das Hauptergebnis: eine Momentenkarte zeigt in
einer Sekunde, ob die Platte ein- oder zweiachsig spannt, ob ein Auflager
fehlt und wo die Bewehrung hin muss — Zahlenkolonnen brauchen dafür Minuten
und verbergen den Fehler, den man nicht gesucht hat.

Drei Regeln stecken in den Voreinstellungen:

1. **Schnittgrößen divergierend, Beträge sequenziell.** Momente wechseln das
   Vorzeichen, und die Farbskala muss die Null in der Mitte halten — sonst
   sieht ein Feldmoment aus wie ein Stützmoment. Bewehrungsmengen und
   Ausnutzungen haben kein Vorzeichen und bekommen eine einseitige Skala.
2. **Der Umriss wird immer mitgezeichnet.** Ohne ihn ist eine Karte mit
   Löchern nicht zu deuten.
3. **Ausreißer werden gekappt, nicht versteckt.** Einzellasten und
   Auflagerecken erzeugen örtliche Spitzen, die zwei Größenordnungen über dem
   Rest liegen; ungekappt macht das jede Karte einfarbig. Gekappt wird auf ein
   Perzentil, und der wirkliche Größtwert steht im Titel.
"""

from __future__ import annotations

import numpy as np
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
from matplotlib.patches import Circle as MplCircle, Polygon as MplPolygon

from . import plate

#: Der Regenbogen der Ergebniswolke, hier für matplotlib.
#:
#: Dieselben acht Stützstellen wie `_STUETZSTELLEN["regenbogen"]` in
#: `tiling/ergebniswolke.py`. Sie müssen gleich bleiben — sonst hat dieselbe
#: Durchbiegung im Bericht eine andere Farbe als in der Punktwolke, und wer
#: beides nebeneinander sieht, glaubt an zwei Ergebnisse.
#:
#: Eigenständig statt importiert, aus demselben Grund, aus dem
#: `ergebniswolke._pnts()` neben `formats/splat.py` steht: `ileen` greift
#: nirgends auf `tiling` zu — die Rechenschicht hinge sonst an der
#: Kachelschicht —, und umgekehrt käme `ergebniswolke.py` nicht mehr ohne
#: matplotlib aus.
REGENBOGEN = [
    (0.29, 0.00, 0.51), (0.15, 0.15, 0.85), (0.00, 0.55, 0.95),
    (0.00, 0.80, 0.75), (0.35, 0.85, 0.20), (0.95, 0.90, 0.10),
    (0.98, 0.55, 0.05), (0.80, 0.05, 0.05),
]


def regenbogen(stufen: int = 16, umgekehrt: bool = False) -> ListedColormap:
    """
    Der Regenbogen in abgesetzten Stufen.

    **Warum abgestuft und nicht stetig.** Ein stetiger Verlauf zeigt die Form
    der Biegefläche, aber man kann ihm keinen Wert ablesen: zwischen zwei
    ähnlichen Blautönen liegt womöglich ein Millimeter oder ein Zehntel.
    Sechzehn abgesetzte Farben machen aus der Fläche ein Höhenlinienbild — die
    Grenze zwischen zwei Stufen ist eine Isolinie, und der Farbstrich sagt,
    welcher Wert dort steht.

    Als *stetige* Skala ist der Regenbogen zu Recht verrufen, weil er
    Helligkeitssprünge erfindet, die in den Daten nicht stehen. In Stufen ist
    genau das sein Vorzug: benachbarte Stufen bleiben sicher unterscheidbar,
    und mehr verlangt eine Höhenlinienkarte nicht.
    """
    anteile = np.linspace(0, 1, len(REGENBOGEN))
    tafel = np.array(REGENBOGEN)
    mitten = (np.arange(stufen) + 0.5) / stufen
    if umgekehrt:
        mitten = 1.0 - mitten
    farben = np.stack([np.interp(mitten, anteile, tafel[:, k]) for k in range(3)], axis=1)
    return ListedColormap(farben)


# Unter festem Namen registriert, damit alles Übrige mit Zeichenketten
# weiterarbeitet — `Bilder.raster()` und `_farbstuetzstellen()` schlagen die
# Tafel über `matplotlib.colormaps[name]` nach.
#
# Beide Richtungen, weil die Durchbiegung je nach Bild ein anderes Vorzeichen
# trägt: die Karten rechnen `w = -u_z` in Millimetern (Senkung positiv), die
# Verformungsfigur und die `felder.npz` behalten `u_z` (Senkung negativ). Rot
# soll in allen dreien die stärkste Senkung sein — das geht nur, wenn die eine
# Skala umgekehrt läuft.
for _name, _tafel in (("ileen_regenbogen", regenbogen(16)),
                      ("ileen_regenbogen_r", regenbogen(16, umgekehrt=True))):
    try:
        matplotlib.colormaps.register(_tafel, name=_name)
    except ValueError:
        # Schon registriert — das Modul wurde ein zweites Mal geladen.
        pass

#: Hausfarben — iLEEN-Grün für das System, Rot für Einwirkungen, Schwarz für Lager.
GRUEN = "#97BF0D"
DUNKELGRUEN = "#5c7a12"
ROT = "#c0392b"
BLAU = "#2f6fa8"
#: Unterzüge — dieselbe Farbe wie im Zeichenmodus (`frontend/plan-loads.js`).
BRAUN = "#5c3a1e"
#: Zulagen — dasselbe Orange in Querschnitt, Staffelung und Bewehrungsskizze,
#: damit ein Stab in allen drei Bildern dieselbe Farbe hat.
ZULAGE = "#e59866"


def stil():
    """Einheitliche Grundeinstellung für alle Bilder des Notebooks."""
    plt.rcParams.update({
        "figure.dpi": 110,
        "savefig.dpi": 110,
        "font.size": 9,
        "axes.titlesize": 10,
        "axes.grid": False,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "figure.facecolor": "white",
        "image.cmap": "RdBu_r",
    })


def _rahmen(ax, netz, umriss=True, farbe="k", lw=1.2):
    if umriss and netz is not None:
        ring = np.vstack([netz.polygon, netz.polygon[:1]])
        ax.plot(ring[:, 0], ring[:, 1], color=farbe, lw=lw, zorder=5)
    ax.set_aspect("equal")
    # Etwas Luft, sonst liegt die Umrisslinie genau auf dem Achsenrand und ist
    # bei einer Karte, die bis zum Rand reicht, nicht mehr zu sehen.
    ax.margins(0.03)
    ax.set_xlabel("x [m]")
    ax.set_ylabel("y [m]")


def ausduennen(xy: np.ndarray, dichte: int = 26) -> np.ndarray:
    """
    Gleichmäßige Auswahl von Punkten für Pfeil- und Strichbilder.

    Jeder n-te Punkt der Elementliste zu nehmen wäre einfacher, ergibt aber
    Streifen: die Elemente sind zeilenweise sortiert, und ein Schritt, der kein
    Teiler der Zeilenlänge ist, wandert durch das Bild. Stattdessen wird über
    ein grobes Raster gegangen und je Rasterzelle ein Punkt behalten.

    @param dichte  ungefähre Zahl der Punkte über die längere Seite
    @returns Indexfeld
    """
    xy = np.asarray(xy, dtype=float)
    spanne = xy.max(axis=0) - xy.min(axis=0)
    schritt = max(float(spanne.max()) / max(dichte, 1), 1e-9)
    zellen = np.round((xy - xy.min(axis=0)) / schritt).astype(int)
    _, index = np.unique(zellen, axis=0, return_index=True)
    return np.sort(index)


def karte(ax, xy, werte, netz=None, titel="", einheit="", cmap=None,
          symmetrisch=True, perzentil=99.5, stufen=18, umriss=True,
          farbskala=True, extremwerte=True):
    """
    Ergebniskarte über der Plattenfläche.

    `symmetrisch` hält die Null in der Mitte der Farbskala — richtig für alles,
    was das Vorzeichen wechselt (Momente, Membrankräfte). Für Beträge
    (Bewehrung, Ausnutzung) auf False setzen.

    Gezeichnet wird als Raster mit `pcolormesh`, nicht als Kontur: die Werte
    sind elementweise konstant, und geglättete Isolinien täuschen eine
    Genauigkeit vor, die das Modell nicht hat — besonders am Treppenrand.
    """
    werte = np.asarray(werte, dtype=float)
    X, Y, Z = plate.auf_raster(np.asarray(xy), werte,
                               polygon=netz.polygon if netz is not None else None)

    endlich = werte[np.isfinite(werte)]
    if len(endlich) == 0:
        endlich = np.zeros(1)
    if symmetrisch:
        grenze = float(np.percentile(np.abs(endlich), perzentil)) or 1e-9
        vmin, vmax = -grenze, grenze
        cmap = cmap or "RdBu_r"
    else:
        vmin = 0.0 if endlich.min() >= 0 else float(np.percentile(endlich, 100 - perzentil))
        vmax = float(np.percentile(endlich, perzentil)) or 1e-9
        cmap = cmap or "viridis"

    bild = ax.pcolormesh(X, Y, Z, cmap=cmap, vmin=vmin, vmax=vmax, shading="nearest")
    _rahmen(ax, netz, umriss)

    beschriftung = titel
    if extremwerte and len(endlich):
        beschriftung = f"{titel}\n{endlich.min():+.1f} … {endlich.max():+.1f} {einheit}"
    ax.set_title(beschriftung)
    if farbskala:
        strich = plt.colorbar(bild, ax=ax, fraction=0.046, pad=0.03)
        strich.set_label(einheit)
    return bild


def plan(ax, modell, netz=None, lasten=True, auflager=True, positionen=True,
         beschriften=True):
    """
    Das statische System, wie es im Plan gezeichnet wurde.

    Was hier falsch aussieht, ist im Ergebnis nicht mehr zu erkennen — deshalb
    steht dieses Bild vor jeder Rechnung.
    """
    for eintrag in modell.system:
        umriss = np.asarray(eintrag["umriss"], dtype=float)
        ax.add_patch(MplPolygon(umriss[:, :2], closed=True, facecolor=GRUEN, alpha=0.12,
                                edgecolor=DUNKELGRUEN, lw=2, ls=(0, (8, 2, 1, 2)), zorder=1))
        if beschriften:
            # In die Ecke, nicht in die Mitte: die Mitte gehört den Lastwerten,
            # und übereinandergedruckte Beschriftungen sind schlimmer als eine,
            # die man suchen muss.
            ecke = np.array([umriss[:, 0].min(), umriss[:, 1].max()])
            ax.text(ecke[0], ecke[1], f"{eintrag['id']} · d = {eintrag['dicke_m']*100:.0f} cm · "
                                      f"{eintrag['material']['name']}",
                    ha="left", va="bottom", fontsize=8, color=DUNKELGRUEN, zorder=6)

    farben = {f["id"]: f.get("farbe", ROT) for f in modell.lastfaelle}

    if lasten:
        for last in modell.lasten:
            farbe = farben.get(last["lastfall"], ROT)
            if last["typ"] == "flaeche":
                # Nur der Rand, keine Füllung: Lastflächen überdecken einander
                # und die Systemfläche, und drei übereinandergelegte Farbschleier
                # ergeben einen braunen Plan, auf dem nichts mehr zu erkennen ist.
                p = np.asarray(last["polygon"], dtype=float)
                ax.add_patch(MplPolygon(p[:, :2], closed=True, facecolor="none",
                                        edgecolor=farbe, lw=1.3, ls=(0, (6, 3)), zorder=2))
                if beschriften:
                    ax.text(*p[:, :2].mean(axis=0), f"{last['wert']} kN/m²",
                            color=farbe, ha="center", fontsize=7, zorder=6,
                            bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.7))
            elif last["typ"] == "linie":
                p = np.asarray(last["polylinie"], dtype=float)
                ax.plot(p[:, 0], p[:, 1], color=farbe, lw=2.5, zorder=3)
                if beschriften:
                    m = p[len(p) // 2]
                    ax.text(m[0], m[1] + 0.15, f"{last['wert']} kN/m", color=farbe,
                            ha="center", fontsize=7, zorder=6,
                            bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.7))
            else:
                p = np.asarray(last["p"], dtype=float)
                ax.plot(p[0], p[1], "v", color=farbe, ms=9, zorder=4)
                if beschriften:
                    ax.text(p[0] + 0.15, p[1], f"{last['wert']} kN", color=farbe,
                            fontsize=7, zorder=6)

    if auflager:
        spanne = max(float(np.ptp(np.asarray(modell.system[0]["umriss"], dtype=float)[:, 0])), 1.0)
        versatz = spanne * 0.02
        for lager in modell.auflager:
            if lager["typ"] == "linie":
                p = np.asarray(lager["polylinie"], dtype=float)
                ax.plot(p[:, 0], p[:, 1], color="k", lw=2, zorder=4)
                # Symbole in gleichmäßigem Abstand statt eines je Segment: eine
                # Wandachse besteht oft aus einer einzigen langen Strecke, und
                # ein einzelnes Dreieck darauf sieht aus wie ein Punktlager.
                for i in range(len(p) - 1):
                    laenge = float(np.linalg.norm(p[i + 1] - p[i]))
                    anzahl = max(1, int(laenge / (spanne / 14)))
                    t = (np.arange(anzahl) + 0.5) / anzahl
                    orte = p[i] + t[:, None] * (p[i + 1] - p[i])
                    ax.plot(orte[:, 0], orte[:, 1], "^", color="k", ms=5, zorder=4)
                richtung = p[-1] - p[0]
                n = np.array([-richtung[1], richtung[0]]) / max(np.linalg.norm(richtung), 1e-9)
                mitte = p[len(p) // 2]
                ax.annotate(lager["id"], mitte + n * versatz, ha="center", va="center",
                            fontsize=7, fontweight="bold", color="k", zorder=6)
            else:
                p = np.asarray(lager["p"], dtype=float)
                ax.plot(p[0], p[1], "^", color="k", ms=10, zorder=4)
                ax.annotate(lager["id"], p + versatz, ha="left", va="bottom",
                            fontsize=7, fontweight="bold", color="k", zorder=6)

    # Unterzüge als Band in Balkenbreite — dieselbe Darstellung wie im
    # Zeichenmodus (`frontend/plan-loads.js`), damit Plan und Rechnung
    # dasselbe Bild zeigen. Ohne sie fehlt im Systembild genau das Bauteil,
    # das die Lastabtragung bestimmt.
    for eintrag in modell.balken:
        p = np.asarray(eintrag["polylinie"], dtype=float)
        halbe = float(eintrag["breite_m"]) / 2.0
        ueberzug = eintrag.get("richtung", "unten") == "oben"
        for i in range(len(p) - 1):
            richtung = p[i + 1] - p[i]
            laenge = float(np.linalg.norm(richtung))
            if laenge < 1e-9:
                continue
            n = np.array([-richtung[1], richtung[0]]) / laenge * halbe
            band = np.array([p[i] + n, p[i + 1] + n, p[i + 1] - n, p[i] - n])
            ax.add_patch(MplPolygon(band, closed=True, facecolor=BRAUN, alpha=0.22,
                                    edgecolor=BRAUN, lw=1.2,
                                    ls="-" if not ueberzug else (0, (5, 2)), zorder=2))
        if beschriften:
            mitte = p[len(p) // 2] if len(p) > 2 else p.mean(axis=0)
            ax.text(mitte[0], mitte[1],
                    f"{eintrag.get('id', 'U')} {eintrag['breite_m']*100:.0f}/"
                    f"{eintrag['hoehe_m']*100:.0f}",
                    ha="center", va="center", fontsize=7, color=BRAUN, zorder=6,
                    bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.75))

    if positionen:
        for position in modell.positionen:
            ax.annotate(position["id"], np.asarray(position["anker"], dtype=float),
                        ha="center", va="center", fontsize=8, fontweight="bold", zorder=7,
                        bbox=dict(boxstyle="round,pad=0.3", fc="white", ec="k", lw=0.8))

    _rahmen(ax, netz, umriss=False)
    ax.autoscale_view()
    return ax


def _rundschnitt_kontur(c_x: float, c_y: float, r: float, boegen: int = 16) -> np.ndarray:
    """
    Kontur des kritischen Rundschnitts einer Rechteckstütze: die vier Kanten um
    `r` nach außen verschoben, an den Ecken durch Viertelkreise mit Radius `r`
    geschlossen — exakt die Geometrie, aus der `beton.durchstanzen()` den
    Umfang u_1 = 2(c_x+c_y) + 2π·r herleitet (die vier Viertelkreise ergeben
    zusammen einen vollen Kreisumfang).
    """
    halb_x, halb_y = c_x / 2.0, c_y / 2.0
    ecken = [(halb_x, halb_y, 0.0), (-halb_x, halb_y, 90.0),
             (-halb_x, -halb_y, 180.0), (halb_x, -halb_y, 270.0)]
    teile = []
    for ex, ey, start in ecken:
        winkel = np.radians(start + np.linspace(0, 90, boegen))
        teile.append(np.stack([ex + r * np.cos(winkel), ey + r * np.sin(winkel)], axis=1))
    return np.concatenate(teile, axis=0)


def durchstanzkontur(ax, p, stuetze_m, d: float, rund: bool = False,
                     ausnutzung: float | None = None, beschriftung: str | None = None):
    """
    Stütze und kritischer Rundschnitt (Abstand 2d, EC2 6.4) an einer Position.

    Die Farbe der Rundschnittlinie folgt derselben Ampelschwelle wie `ampel()`
    — ein roter Kreis sagt an der Stütze selbst, was sonst nur in der
    Nachweisliste stünde.
    """
    p = np.asarray(p, dtype=float)[:2]
    farbe = _ampelfarbe(ausnutzung) if ausnutzung is not None else "k"

    if rund:
        durchmesser = float(stuetze_m if np.isscalar(stuetze_m) else stuetze_m[0])
        radius = durchmesser / 2.0 + 2.0 * d
        ax.add_patch(MplCircle(p, durchmesser / 2.0, facecolor="#888888", edgecolor="k",
                               lw=1.0, zorder=5))
        ax.add_patch(MplCircle(p, radius, facecolor="none", edgecolor=farbe, lw=1.8, zorder=5))
    else:
        c_x, c_y = (stuetze_m, stuetze_m) if np.isscalar(stuetze_m) else stuetze_m
        stuetze = np.array([[c_x / 2, c_y / 2], [-c_x / 2, c_y / 2],
                            [-c_x / 2, -c_y / 2], [c_x / 2, -c_y / 2]]) + p
        ax.add_patch(MplPolygon(stuetze, closed=True, facecolor="#888888", edgecolor="k",
                                lw=1.0, zorder=5))
        kontur = _rundschnitt_kontur(c_x, c_y, 2.0 * d) + p
        ax.add_patch(MplPolygon(kontur, closed=True, facecolor="none", edgecolor=farbe,
                                lw=1.8, zorder=5))
        radius = c_y / 2.0 + 2.0 * d

    if beschriftung:
        ax.annotate(beschriftung, p + [0, radius], xytext=(0, 4),
                    textcoords="offset points", ha="center", va="bottom", fontsize=7,
                    fontweight="bold", color=farbe, zorder=7,
                    bbox=dict(boxstyle="round,pad=0.2", fc="white", ec=farbe, lw=0.8))


def durchstanzplan(ax, modell, details: list[dict], netz=None):
    """
    Ergebnisplan der Durchstanznachweise: System im Hintergrund, an jeder
    geprüften Stütze der kritische Rundschnitt mit Ausnutzung.

    `details` kommt aus `rechnung._nachweise()` — je Punktauflager mit
    Durchstanznachweis ein Eintrag mit Position (`p`), Stützenmaßen
    (`stuetze_m`, `rund`), Nutzhöhe (`d`) und den Werten aus
    `beton.durchstanzen()` (u. a. `ausnutzung`).
    """
    plan(ax, modell, netz=netz, lasten=False, positionen=False, beschriften=False)
    for eintrag in details:
        durchstanzkontur(ax, eintrag["p"], eintrag["stuetze_m"], eintrag["d"],
                         rund=eintrag.get("rund", False), ausnutzung=eintrag["ausnutzung"],
                         beschriftung=f"{eintrag['id']}\nη = {eintrag['ausnutzung']:.2f}")
    ax.set_title("Durchstanznachweise — kritischer Rundschnitt (2d, EC2 6.4)")
    return ax


def _trajektorien_striche(ax, xy, wert_1, wert_2, phi, dichte=26, skala=0.85, lw=0.8):
    """
    Nur die gekreuzten Striche, ohne Rahmen, Achsen oder Titel.

    Ausgelagert aus `trajektorien()`, damit dieselbe Zeichnung auch als
    Überlagerung entsteht (`rechnung.Bilder.trajektorien`) — dort darf außer
    den Strichen selbst nichts auf der Fläche stehen, sonst deckt sich das
    Bild nicht mehr mit dem Grundriss darunter.
    """
    xy = np.asarray(xy)
    auswahl = ausduennen(xy, dichte)
    x, y = xy[auswahl, 0], xy[auswahl, 1]
    w1, w2, winkel = np.asarray(wert_1)[auswahl], np.asarray(wert_2)[auswahl], np.asarray(phi)[auswahl]

    bezug = max(float(np.percentile(np.abs(np.r_[w1, w2]), 98)), 1e-9)
    spanne = float((xy.max(axis=0) - xy.min(axis=0)).max())
    laenge = skala * spanne / max(dichte, 1)

    for wert, versatz in ((w1, 0.0), (w2, np.pi / 2)):
        länge = laenge * np.clip(np.abs(wert) / bezug, 0.05, 1.0)
        dx = länge * np.cos(winkel + versatz)
        dy = länge * np.sin(winkel + versatz)
        for farbe, maske in ((ROT, wert >= 0), (BLAU, wert < 0)):
            if not np.any(maske):
                continue
            ax.plot(np.c_[x[maske] - dx[maske] / 2, x[maske] + dx[maske] / 2, np.full(maske.sum(), np.nan)].ravel(),
                    np.c_[y[maske] - dy[maske] / 2, y[maske] + dy[maske] / 2, np.full(maske.sum(), np.nan)].ravel(),
                    color=farbe, lw=lw, solid_capstyle="round")


def trajektorien(ax, xy, wert_1, wert_2, phi, netz=None, titel="", dichte=26,
                 skala=0.85):
    """
    Hauptrichtungen als gekreuzte Striche — Zug rot, Druck blau.

    Das Bild, das die Tragwirkung zeigt: die Striche folgen den Bahnen, auf
    denen die Platte ihre Last zu den Auflagern bringt. Wo sie parallel
    laufen, spannt sie einachsig; wo sie sich drehen, arbeitet sie zweiachsig,
    und in den Ecken sieht man die Drillwirkung, die in m_x und m_y nicht
    vorkommt.

    `dichte` ist die ungefähre Zahl der Kreuze über die längere Seite — bei
    jedem Element eines wäre das Bild eine schwarze Fläche.
    """
    _trajektorien_striche(ax, xy, wert_1, wert_2, phi, dichte=dichte, skala=skala)
    _rahmen(ax, netz)
    ax.set_title(titel or "Hauptrichtungen (rot = Zug, blau = Druck)")
    return ax


def stufenkarte(ax, xy, werte, grenzen, netz=None, titel="", einheit="cm²/m",
                farbfolge=None, beschriftung=None):
    """
    Karte mit diskreten Stufen — für Bewehrungswahl statt Bewehrungsbedarf.

    Der Bedarf ist stetig, die Ausführung nicht: gelegt wird eine Matte, dazu
    Zulagen. Die Stufenkarte ist deshalb näher am Bewehrungsplan als jede
    Farbverlaufskarte und beantwortet die Frage, die auf der Baustelle gestellt
    wird — was liegt hier?
    """
    from matplotlib.colors import BoundaryNorm, ListedColormap

    grenzen = list(grenzen)
    farben = farbfolge or ["#f7f7f7", "#d9ead3", "#b6d7a8", "#93c47d", "#6aa84f", "#38761d"]
    farben = farben[:max(len(grenzen) - 1, 1)]
    cmap = ListedColormap(farben)
    norm = BoundaryNorm(grenzen, cmap.N, clip=True)

    X, Y, Z = plate.auf_raster(np.asarray(xy), np.asarray(werte, dtype=float),
                               polygon=netz.polygon if netz is not None else None)
    bild = ax.pcolormesh(X, Y, Z, cmap=cmap, norm=norm, shading="nearest")
    _rahmen(ax, netz)
    ax.set_title(titel)

    if beschriftung:
        # Die Beschriftung gehört zwischen zwei Grenzen, nicht auf eine: sie
        # benennt das Intervall („Q335A"), nicht den Zahlenwert.
        mitten = [(grenzen[i] + grenzen[i + 1]) / 2 for i in range(len(grenzen) - 1)]
        strich = plt.colorbar(bild, ax=ax, fraction=0.046, pad=0.03, ticks=mitten)
        strich.ax.set_yticklabels(list(beschriftung)[:len(mitten)])
    else:
        strich = plt.colorbar(bild, ax=ax, fraction=0.046, pad=0.03, ticks=grenzen)
    strich.set_label(einheit)
    return bild


def _ampelfarbe(wert: float, grenze: float = 1.0) -> str:
    """Rot über der Grenze, Gelb ab 85 % davon, sonst Grün."""
    if wert > grenze:
        return ROT
    if wert > 0.85 * grenze:
        return "#e8a33d"
    return "#4c9a2a"


def ampel(ax, nachweise: list[tuple[str, float]], grenze: float = 1.0):
    """
    Ausnutzungen als liegende Balken — die Zusammenfassung, die man zuerst liest.

    Alles über 1,0 ist rot und steht oben; die Reihenfolge der Übergabe bleibt
    erhalten, damit die Nachweise in der Reihenfolge der Rechnung stehen und
    nicht nach Größe sortiert werden — man sucht einen bestimmten Nachweis,
    nicht den größten.
    """
    namen = [n for n, _ in nachweise]
    werte = np.array([w for _, w in nachweise], dtype=float)
    orte = np.arange(len(namen))[::-1]

    farben = [_ampelfarbe(w, grenze) for w in werte]
    ax.barh(orte, werte, color=farben, height=0.6)
    ax.axvline(grenze, color="k", lw=1, ls="--")
    ax.set_yticks(orte)
    ax.set_yticklabels(namen)
    ax.set_xlabel("Ausnutzung")
    ax.set_xlim(0, max(1.35, float(werte.max()) * 1.15) if len(werte) else 1.35)
    for ort, wert in zip(orte, werte):
        ax.text(wert + 0.02, ort, f"{wert:.2f}", va="center", fontsize=8)
    ax.grid(axis="x", alpha=0.25)
    return ax


def staffelung(ax, x, m_Ed, ergebnis: dict, d: float, titel="Zugkraftdeckung"):
    """
    Zugkraftdeckungslinie: was die Platte braucht und was die Bewehrung kann.

    Die graue Fläche ist das einwirkende Moment, die Treppe das aufnehmbare der
    gewählten Staffelung. Berührt die Treppe die Fläche, ist die Bewehrung
    ausgeschöpft; schneidet sie hinein, fehlt sie. Die waagerechten Balken
    darunter zeigen, wo eine Zulage liegt — jeweils um Versatzmaß und
    Verankerungslänge über den rechnerisch nötigen Bereich hinaus.
    """
    x = np.asarray(x, dtype=float)
    m_Ed = np.asarray(m_Ed, dtype=float)

    ax.fill_between(x, 0, m_Ed, color="#bbbbbb", alpha=0.55, label="m$_{Ed}$")
    # Wo der Schnitt die Platte verlässt (m_Ed ist dort NaN), endet auch die
    # Bewehrung — sonst liefe die Deckungslinie durch den leeren Raum weiter.
    m_Rd = np.where(np.isnan(m_Ed), np.nan, np.asarray(ergebnis["m_Rd_kNm"], dtype=float))
    ax.plot(x, m_Rd, color=DUNKELGRUEN, lw=1.8, drawstyle="steps-mid",
            label="m$_{Rd}$ der Staffelung")
    ax.axhline(0, color="k", lw=0.8)

    hoehe = max(float(np.nanmax(m_Rd)), float(np.nanmax(m_Ed)), 1.0)
    for i, zulage in enumerate(ergebnis["zulagen"]):
        y = -hoehe * (0.10 + 0.07 * i)
        ax.plot([zulage["von_m"], zulage["bis_m"]], [y, y], lw=5, solid_capstyle="butt",
                color=ROT, alpha=0.75)
        ax.plot([zulage["roh_von_m"], zulage["roh_bis_m"]], [y, y], lw=5,
                solid_capstyle="butt", color="#7b241c")
        ax.text((zulage["von_m"] + zulage["bis_m"]) / 2, y - hoehe * 0.035,
                f"Zulage {zulage['nr']}: {zulage['bezeichnung']}  "
                f"({zulage['laenge_m']:.2f} m)", ha="center", va="top", fontsize=7)

    # Platte oder Balken? Bei b = 1 m ist a_s eine Größe je Meter, sonst absolut —
    # die Einheit im Titel muss dem folgen, sonst steht am Unterzug „cm²/m".
    je_meter = abs(float(ergebnis.get("breite_m", 1.0)) - 1.0) < 1e-9
    ax.set_xlabel("Schnittlänge [m]")
    ax.set_ylabel("Moment [kNm/m]" if je_meter else "Moment [kNm]")
    ax.set_title(f"{titel} — Grundbewehrung {ergebnis['grund_bezeichnung']} "
                 f"({ergebnis['grund_cm2']:.2f} cm²{'/m' if je_meter else ''}), "
                 f"Versatzmaß a$_l$ = {d:.2f} m")
    ax.legend(loc="upper right", fontsize=8, framealpha=0.9)
    ax.grid(alpha=0.25)
    return ax


def verformungsflaeche(ax, netz, loesung, ueberhoehung: float = 200.0,
                       titel="Verformungsfigur"):
    """
    Die verformte Platte, dreidimensional und überhöht.

    Die Überhöhung ist nötig, weil eine Decke sich um Millimeter biegt und über
    Meter spannt — maßstäblich gezeichnet bliebe sie eine gerade Fläche. Der
    Faktor steht im Titel, damit niemand die Zeichnung für die Wirklichkeit
    hält.
    """
    punkte = netz.points
    # `plate.unterseiten_knoten()` statt eines globalen Minimums: unter einem
    # Unterzug liegt die tatsächliche Unterseite der Platte lokal tiefer, und
    # ein globales Minimum träfe dann nur dessen Fußpunkte statt der ganzen
    # Fläche.
    unten = plate.unterseiten_knoten(netz)
    w_mm = np.asarray(loesung)[unten, 2] * 1000.0

    # `_r`, weil `w_mm` hier die rohe Verschiebung ist und eine Senkung negativ
    # zählt — anders als in den Karten, wo `w = -u_z` gerechnet wird. Rot ist
    # in beiden die stärkste Senkung.
    flaeche = ax.plot_trisurf(punkte[unten, 0], punkte[unten, 1], w_mm,
                              cmap="ileen_regenbogen_r", linewidth=0, antialiased=True)
    # Der Höhenmaßstab steckt im Seitenverhältnis der Achsen, nicht in den
    # Zahlen: so bleibt die Achse in Millimetern ablesbar, während die Figur
    # überhöht erscheint.
    spanne = float((netz.polygon.max(axis=0) - netz.polygon.min(axis=0)).max())
    hoehe = max(float(np.abs(w_mm).max()), 1e-6)
    ax.set_box_aspect((1.0, 1.0, min(0.6, ueberhoehung * hoehe / 1000.0 / spanne)))
    ax.set_xlabel("x [m]")
    ax.set_ylabel("y [m]")
    ax.set_zlabel("w [mm]")
    ax.set_title(f"{titel} (überhöht ×{ueberhoehung:.0f})")
    return flaeche


def netzbild(ax, netz, titel="Netz"):
    """Elementkanten der obersten Lage — zeigt Treppenränder und Feinheit."""
    from matplotlib.collections import LineCollection

    mitten = netz.points[netz.cells].mean(axis=1)
    # `plate.oberste_lage_z()` statt des Netzmaximums: Elementmitten liegen
    # eine halbe Lagenhöhe unter netz.dicke, und bei einem Überzug reicht das
    # Netz zusätzlich höher — das Maximum träfe dann nur den schmalen
    # Rippenkopf statt der ganzen Deckenoberfläche.
    oben = mitten[:, 2] >= plate.oberste_lage_z(netz) - 1e-9
    zellen = netz.cells[oben][:, 4:8]          # obere Deckfläche jedes Hexaeders
    ecken = netz.points[zellen][:, :, :2]

    strecken = []
    for i in range(4):
        strecken.append(np.stack([ecken[:, i], ecken[:, (i + 1) % 4]], axis=1))
    ax.add_collection(LineCollection(np.concatenate(strecken), colors="#666666",
                                     linewidths=0.25))
    _rahmen(ax, netz)
    ax.autoscale_view()
    ax.set_title(f"{titel} — {netz.n_elemente} HEX8, Δ ≈ {netz.groesse:.3f} m, "
                 f"{plate.lagen(netz)} Lagen")
    return ax


def windbild(ax, modell, netz, lasten: list[dict], richtung, titel="Windansatz"):
    """
    Windlast am Deckenrand: Pfeile auf den Kanten, Zonen eingefärbt.

    Der lange Pfeil in der Mitte ist die Resultierende — die Zahl, mit der man
    die Rechnung von Hand nachprüft.
    """
    from . import scheibe as _scheibe

    ring = np.vstack([netz.polygon, netz.polygon[:1]])
    ax.plot(ring[:, 0], ring[:, 1], color="k", lw=1.5)

    groesse = max(netz.polygon.max(axis=0) - netz.polygon.min(axis=0))
    bezug = max((last["w_kNm"] for last in lasten), default=1.0)
    farben = {"Luv": ROT, "Lee": "#2980b9", "Seite": "#7f8c8d"}

    for last in lasten:
        a, b = np.asarray(last["von"], dtype=float), np.asarray(last["bis"], dtype=float)
        e = np.asarray(last["richtung"], dtype=float)
        ax.plot([a[0], b[0]], [a[1], b[1]], color=farben[last["zone"]], lw=3, alpha=0.8)
        for t in np.linspace(0.1, 0.9, 5):
            p = a + t * (b - a)
            länge = 0.10 * groesse * last["w_kNm"] / bezug
            ax.arrow(p[0] - e[0] * länge, p[1] - e[1] * länge, e[0] * länge, e[1] * länge,
                     head_width=0.035 * groesse, head_length=0.045 * groesse,
                     fc=farben[last["zone"]], ec=farben[last["zone"]], length_includes_head=True)
        mitte = (a + b) / 2
        ax.text(mitte[0] - e[0] * 0.16 * groesse, mitte[1] - e[1] * 0.16 * groesse,
                f"{last['zone']}\n{last['w_kNm']:.2f} kN/m", ha="center", va="center",
                fontsize=7, color=farben[last["zone"]])

    F = _scheibe.gesamtkraft(lasten)
    mitte = netz.polygon.mean(axis=0)
    betrag = float(np.linalg.norm(F)) or 1e-9
    ax.arrow(mitte[0], mitte[1], F[0] / betrag * 0.2 * groesse, F[1] / betrag * 0.2 * groesse,
             head_width=0.05 * groesse, fc="k", ec="k", length_includes_head=True, zorder=8)
    ax.text(mitte[0], mitte[1] - 0.07 * groesse,
            f"ΣF = {betrag:.1f} kN", ha="center", fontsize=8, fontweight="bold")

    _rahmen(ax, netz, umriss=False)
    ax.autoscale_view()
    ax.set_title(f"{titel} — Windrichtung {np.round(np.asarray(richtung, dtype=float)[:2], 2)}")
    return ax


# ──────────────────────────────────────────────────────────────────────────
# Unterzüge
# ──────────────────────────────────────────────────────────────────────────


def _lagersymbole(ax, lager, y, breite_x, hoehe_y, beschriften=True):
    """
    Auflagerdreiecke unter einer Trägerachse.

    x- und y-Maßstab werden **getrennt** übergeben: die Achsen einer
    Trägerzeichnung sind nicht gleich skaliert (12 m Länge gegen 0,65 m Höhe),
    und ein gemeinsames Maß führt zu Symbolen, die entweder unsichtbar klein
    oder meterhoch aus dem Bild ragen.
    """
    for eintrag in lager:
        s = eintrag["s_m"]
        ax.plot([s], [y], marker="^", ms=9, color="k", zorder=6, clip_on=False)
        # Schraffur unter dem Dreieck — das übliche Zeichen für „unverschieblich".
        for versatz in np.linspace(-0.5, 0.5, 5):
            ax.plot([s + versatz * breite_x * 0.020, s + (versatz - 0.4) * breite_x * 0.020],
                    [y - hoehe_y * 0.055, y - hoehe_y * 0.12],
                    color="k", lw=0.7, zorder=5, clip_on=False)
        if beschriften:
            ax.text(s, y - hoehe_y * 0.16, eintrag["id"], ha="center", va="top",
                    fontsize=7, fontweight="bold", clip_on=False)


def balkensystem(ax, ergebnis: dict, titel=None):
    """
    Das statische System eines Unterzugs: Träger, Auflager, Stützweiten, Last.

    **Die Streckenlast ist ein Ergebnis, keine Eingabe.** Wie viel ein Unterzug
    von der Decke abbekommt, hängt an seiner Steifigkeit im Verhältnis zur
    Platte — eine Einzugsfläche „halbe Feldweite links plus halbe rechts" ist
    die Handrechnung, nicht das Modell. Hier steht deshalb q = −dV/ds, also
    das, was der Träger nach der FE-Rechnung wirklich anzieht. Der Vergleich
    mit der Einzugsfläche ist die schnellste Plausibilitätsprüfung, die es für
    einen Unterzug gibt.
    """
    balken = ergebnis["balken"]
    schnitt = ergebnis["schnitt"]
    s = np.asarray(schnitt["s"], dtype=float)
    q = np.asarray(schnitt["q_kNm"], dtype=float)
    groesse = max(float(s[-1] - s[0]), 1e-6)

    q_bezug = max(float(np.percentile(np.abs(q), 95)), 1e-6)
    hoehe = groesse * 0.10
    skala = hoehe / q_bezug

    # Lastordinate über dem Träger, nach unten weisende Pfeile.
    ax.fill_between(s, 0.0, np.clip(q, 0, None) * skala, color=ROT, alpha=0.18, lw=0)
    ax.plot(s, np.clip(q, 0, None) * skala, color=ROT, lw=1.2)
    for t in np.linspace(s[0], s[-1], 13)[1:-1]:
        i = int(np.argmin(np.abs(s - t)))
        y = max(q[i], 0.0) * skala
        ax.annotate("", xy=(t, 0.0), xytext=(t, y),
                    arrowprops=dict(arrowstyle="->", color=ROT, lw=0.9))

    ax.plot([s[0], s[-1]], [0.0, 0.0], color="k", lw=3, solid_capstyle="butt", zorder=4)
    _lagersymbole(ax, ergebnis["lager"], 0.0, groesse, hoehe)

    # Stützweiten bemaßen
    stellen = [s[0]] + [l["s_m"] for l in ergebnis["lager"]] + [s[-1]]
    stellen = sorted(set(round(float(w), 4) for w in stellen))
    y_mass = -hoehe * 0.85
    for a, b in zip(stellen[:-1], stellen[1:]):
        if b - a < groesse * 0.02:
            continue
        ax.annotate("", xy=(a, y_mass), xytext=(b, y_mass),
                    arrowprops=dict(arrowstyle="<->", color="#555555", lw=0.9))
        ax.text((a + b) / 2, y_mass - hoehe * 0.06, f"{b - a:.2f} m",
                ha="center", va="top", fontsize=7, color="#555555")

    ax.set_ylim(y_mass - hoehe * 0.35, hoehe * 1.25)
    ax.set_xlim(s[0] - groesse * 0.04, s[-1] + groesse * 0.04)
    ax.set_yticks([])
    ax.spines["left"].set_visible(False)
    ax.spines["bottom"].set_visible(False)
    ax.set_xlabel(f"Station längs {'x' if balken.achse == 0 else 'y'} [m]")
    ax.set_title(titel or (
        f"{balken.art} {balken.id} — statisches System   "
        f"b/h = {balken.breite_m*100:.0f}/{balken.hoehe_m*100:.0f} cm, "
        f"l = {balken.laenge_m:.2f} m, q ≈ {np.median(q):.1f} kN/m"))
    return ax


def _stabbild_zeichnen(ax, staffel: dict) -> dict | None:
    """
    Die Längsstäbe einer Lage an ihrer wirklichen Stelle, mit ihrem wirklichen
    Durchmesser.

    Gezeichnet wird, was `beton.stablagen()` angeordnet hat — auch die zweite
    Lage. Voll gefüllt sind die durchlaufenden Stäbe, hell die Zulagen; die
    Reihenfolge dafür ist die Legordnung des Stabbildes, also von der Bügelecke
    nach innen und von der äußersten Lage nach oben. Das ist die Reihenfolge,
    in der auf der Baustelle gelegt wird: die durchlaufenden Stäbe zuerst, in
    die Ecken, wo der Bügel sie hält.

    Ein maßstäblicher Kreis statt eines Punktes ist hier keine Kosmetik — nur
    an ihm sieht man, ob die Bewehrung in den Steg geht.
    """
    bild = (staffel or {}).get("bild")
    if not bild or not bild.get("staebe"):
        return None
    r = bild["ds_mm"] / 2000.0
    grund = int(staffel.get("staebe_grund", 0))
    for stab in bild["staebe"]:
        durchlaufend = stab["rang"] < grund
        ax.add_patch(MplCircle((stab["y_m"], stab["z_m"]), r, zorder=6,
                               facecolor=ROT if durchlaufend else ZULAGE,
                               edgecolor=ROT, lw=0.8))
    return bild


def balkenquerschnitt(ax, balken, staffel=None, buegel=None, station=None,
                      b_eff=None, titel=None, staffel_oben=None):
    """
    Der Querschnitt mit Gurt, Steg, Bügel und Längsstäben — beide Lagen.

    Der mitwirkende Gurt wird gestrichelt angedeutet, der Steg voll — beide im
    selben Maßstab, damit das Verhältnis stimmt, das die Bemessung bestimmt.

    **Feld- und Stützbewehrung stehen zusammen im Bild.** Ein Unterzug über
    mehreren Feldern hat oben mehr Stahl als unten, weil dort der schmale Steg
    unter Druck steht; ein Querschnitt, der nur die Feldbewehrung zeigt,
    verschweigt die größere Hälfte und seine Stabsumme stimmt nicht. `staffel`
    ist die untere, `staffel_oben` die obere Lage.
    """
    b_w, h, h_f = balken.breite_m, balken.hoehe_m, balken.dicke_m
    b_gurt = float(b_eff if b_eff else b_w)
    unten_gurt = balken.richtung != "oben"

    # Gurt oben (Unterzug) oder unten (Überzug)
    y_gurt = h - h_f if unten_gurt else 0.0
    ax.add_patch(MplPolygon([(-b_gurt / 2, y_gurt), (b_gurt / 2, y_gurt),
                             (b_gurt / 2, y_gurt + h_f), (-b_gurt / 2, y_gurt + h_f)],
                            closed=True, facecolor="#dddddd", edgecolor="#999999",
                            lw=1.0, ls=(0, (4, 2))))
    y_steg = 0.0 if unten_gurt else h_f
    ax.add_patch(MplPolygon([(-b_w / 2, y_steg), (b_w / 2, y_steg),
                             (b_w / 2, y_steg + h - h_f), (-b_w / 2, y_steg + h - h_f)],
                            closed=True, facecolor="#eeeeee", edgecolor="k", lw=1.4))

    # Betondeckung + Bügeldicke aus dem Stabbild zurückrechnen: der Randabstand
    # ist c_nom + Ø_Bügel + Ø/2, die Bügelinnenkante liegt also um Ø/2 weiter
    # außen. Damit liegen die Stabkreise genau am Bügel an, statt frei zu schweben.
    bilder = [b for b in ((staffel or {}).get("bild"), (staffel_oben or {}).get("bild"))
              if b]
    rand = (min(b["randabstand_m"] - b["ds_mm"] / 2000.0 for b in bilder)
            if bilder else 0.033)
    if buegel:
        ax.add_patch(MplPolygon(
            [(-b_w / 2 + rand, rand), (b_w / 2 - rand, rand),
             (b_w / 2 - rand, h - rand), (-b_w / 2 + rand, h - rand)],
            closed=True, facecolor="none", edgecolor=BLAU, lw=1.6))
        ax.text(0, h + h * 0.06, f"Bügel {buegel['bezeichnung']}", ha="center",
                fontsize=7, color=BLAU)

    zeilen = []
    for name, lage in (("unten", staffel), ("oben", staffel_oben)):
        bild = _stabbild_zeichnen(ax, lage)
        if bild is None:
            continue
        n_grund = int(lage.get("staebe_grund", 0))
        lagen = len(bild["lagen"])
        zeile = (f"{name}: {bild['n']} Ø {bild['ds_mm']:.0f} = {bild['a_s_cm2']:.2f} cm²"
                 f"  ({n_grund} durchlaufend + {bild['n'] - n_grund} Zulage"
                 f"{', ' + str(lagen) + ' Lagen' if lagen > 1 else ''})")
        eng = min((p for p in bild["pruefungen"]), key=lambda p: p["vorhanden_mm"],
                  default=None)
        if eng is not None and np.isfinite(eng["vorhanden_mm"]):
            zeile += (f"\n        s = {eng['vorhanden_mm']:.0f} mm "
                      f"{'≥' if eng['erfuellt'] else '<'} "
                      f"s_min = {eng['erforderlich_mm']:.0f} mm")
        zeilen.append((zeile, bild["passt"]))

    y_text = -h * 0.08
    for zeile, passt in zeilen:
        ax.text(0, y_text, zeile, ha="center", va="top", fontsize=7,
                color=ROT if passt else "#7b241c",
                fontweight="normal" if passt else "bold")
        y_text -= h * 0.085 * (1 + zeile.count("\n")) + h * 0.03

    ax.set_aspect("equal")
    ax.set_xlim(-b_gurt / 2 * 1.1, b_gurt / 2 * 1.1)
    ax.set_ylim(min(y_text - h * 0.10, -h * 0.30), h * 1.25)
    ax.axis("off")
    ax.set_title(titel or (
        f"Querschnitt   b_w/h = {b_w*100:.0f}/{h*100:.0f} cm, "
        f"b_eff = {b_gurt*100:.0f} cm"))
    return ax


def balkenmomente(ax, ergebnis: dict, titel=None):
    """
    Momentenlinie und daraus die erforderliche Längsbewehrung.

    Gezeichnet wird die Einhüllende über alle GZT-Kombinationen, Feld- und
    Stützmoment getrennt. Die Momentenachse zeigt nach unten — die
    Bauzeichnungskonvention, bei der die Momentenlinie auf der Zugseite liegt.
    """
    schnitt, bem = ergebnis["schnitt"], ergebnis["bemessung"]
    s = np.asarray(schnitt["s"], dtype=float)
    M_max = np.asarray(schnitt["M_max_kNm"], dtype=float)
    M_min = np.asarray(schnitt["M_min_kNm"], dtype=float)

    ax.fill_between(s, 0, M_max, color=ROT, alpha=0.20)
    ax.fill_between(s, 0, M_min, color=BLAU, alpha=0.20)
    ax.plot(s, M_max, color=ROT, lw=1.6, label="max M (Zug unten)")
    ax.plot(s, M_min, color=BLAU, lw=1.6, label="min M (Zug oben)")
    ax.axhline(0, color="k", lw=0.9)
    for eintrag in ergebnis["lager"]:
        ax.axvline(eintrag["s_m"], color="#999999", lw=0.8, ls=":")
    ax.invert_yaxis()
    ax.set_ylabel("M [kNm]")
    ax.set_xlabel("Station [m]")
    ax.legend(fontsize=8, loc="lower left", framealpha=0.9)
    ax.grid(alpha=0.25)

    zweit = ax.twinx()
    zweit.plot(s, bem["a_s_unten_cm2"], color="#7b241c", lw=1.2, ls="--",
               label="a$_s$ unten erf.")
    zweit.plot(s, bem["a_s_oben_cm2"], color="#1b4f72", lw=1.2, ls="--",
               label="a$_s$ oben erf.")
    zweit.axhline(bem["a_s_min_cm2"], color="k", lw=0.8, ls=":")
    zweit.set_ylabel("A$_s$ erforderlich [cm²]")
    zweit.set_ylim(0, max(float(np.max(bem["a_s_unten_cm2"])),
                          float(np.max(bem["a_s_oben_cm2"]))) * 1.6)
    zweit.legend(fontsize=8, loc="upper right")
    zweit.grid(False)

    ax.set_title(titel or (
        f"Biegebemessung {ergebnis['balken'].id} — b_eff = {bem['b_ist_m']:.2f} m, "
        f"d = {bem['d']['d_unten_m']*100:.1f} cm,  "
        f"max M = {np.max(M_max):.0f} / {np.min(M_min):.0f} kNm"))
    return ax


def balkenquerkraft(ax, ergebnis: dict, titel=None):
    """
    Querkraftlinie, erforderliche Bügelbewehrung und die gewählten Bereiche.

    Die graue Treppe ist das, was gelegt wird; die gestrichelte Linie, was
    gebraucht wird. Wo die Treppe darunter liegt, fehlt Bügelbewehrung — das
    ist die Stelle, an der man den Bereich verkürzt statt den Bügel zu ändern.
    """
    schnitt, bem = ergebnis["schnitt"], ergebnis["bemessung"]
    s = np.asarray(schnitt["s"], dtype=float)
    V_max = np.asarray(schnitt["V_max_kN"], dtype=float)
    V_min = np.asarray(schnitt["V_min_kN"], dtype=float)
    quer = bem["querkraft"]

    ax.fill_between(s, V_min, V_max, color="#7f8c8d", alpha=0.25)
    ax.plot(s, V_max, color="#34495e", lw=1.5, label="max/min V")
    ax.plot(s, V_min, color="#34495e", lw=1.5)
    ax.axhline(0, color="k", lw=0.9)
    for eintrag in ergebnis["lager"]:
        ax.axvline(eintrag["s_m"], color="#999999", lw=0.8, ls=":")
    ax.set_ylabel("V [kN]")
    ax.set_xlabel("Station [m]")
    ax.grid(alpha=0.25)
    ax.legend(fontsize=8, loc="upper left", framealpha=0.9)

    zweit = ax.twinx()
    a_sw = np.atleast_1d(quer["a_sw_cm2_je_m"]) * np.ones_like(s)
    zweit.plot(s, a_sw, color=ROT, lw=1.2, ls="--", label="a$_{sw}$ erforderlich")
    zweit.axhline(quer["a_sw_min_cm2_je_m"], color="k", lw=0.8, ls=":")
    for bereich in ergebnis["buegel"]:
        zweit.plot([bereich["von_m"], bereich["bis_m"]],
                   [bereich["a_sw_cm2_je_m"]] * 2, color=DUNKELGRUEN, lw=3,
                   solid_capstyle="butt")
        zweit.text((bereich["von_m"] + bereich["bis_m"]) / 2,
                   bereich["a_sw_cm2_je_m"], bereich["bezeichnung"],
                   ha="center", va="bottom", fontsize=7, color=DUNKELGRUEN)
    zweit.set_ylabel("a$_{sw}$ [cm²/m]")
    zweit.set_ylim(0, max(float(np.max(a_sw)),
                          max((b["a_sw_cm2_je_m"] for b in ergebnis["buegel"]), default=1.0)) * 1.9)
    zweit.legend(fontsize=8, loc="lower right")
    zweit.grid(False)

    ausnutzung = float(np.max(np.atleast_1d(quer["ausnutzung_druckstrebe"])))
    cot = np.atleast_1d(quer["cot_theta"])
    ax.set_title(titel or (
        f"Querkraft {ergebnis['balken'].id} — max |V| = {np.max(np.abs(V_max)):.0f} kN, "
        f"cot θ = {cot.min():.2f}…{cot.max():.2f}, "
        f"Druckstrebe {ausnutzung:.2f}"))
    return ax


def balkendurchbiegung(ax, ergebnis: dict, titel=None):
    """
    Durchbiegungslinie des Balkens unter quasi-ständiger Last, gegen l/250.

    Anders als bei Momenten- und Querkraftlinie ist der Grenzwert hier keine
    waagerechte Linie: bei einem Durchlaufträger ist die maßgebende Feldweite
    an jedem Auflager null und in Feldmitte am größten, genau wie w selbst —
    die graue Fläche folgt deshalb der Feldweite (`unterzug.durchbiegung()`),
    nicht einem festen Maß. Wo die blaue Linie aus der Fläche herausragt, ist
    der Grenzwert überschritten.

    Ohne `quasistaendig` in `unterzug.rechne()` fehlt das Feld `durchbiegung`
    im Ergebnis — dann bleibt die Achse leer statt mit einer falschen Linie zu
    täuschen.
    """
    d = ergebnis.get("durchbiegung")
    if not d:
        ax.axis("off")
        ax.set_title(titel or (
            f"{ergebnis['balken'].art} {ergebnis['balken'].id} — Durchbiegung: "
            "keine quasi-ständige Kombination übergeben"))
        return ax

    s = np.asarray(d["s"], dtype=float)
    w = np.asarray(d["w_mm"], dtype=float)
    grenzwert = np.asarray(d["grenzwert_mm"], dtype=float)

    ax.fill_between(s, 0, grenzwert, color="#dddddd", alpha=0.6, label="l/250 (Feldweite)")
    ax.plot(s, w, color=BLAU, lw=1.8, label="w (quasi-ständig)")
    ax.axhline(0, color="k", lw=0.9)
    for eintrag in ergebnis["lager"]:
        ax.axvline(eintrag["s_m"], color="#999999", lw=0.8, ls=":")

    ax.plot(d["s_max_m"], d["w_max_mm"], "o", color=ROT, zorder=6)
    ax.annotate(f"{d['w_max_mm']:.1f} mm ({d['ausnutzung_max']*100:.0f} % von l/250)",
                (d["s_max_m"], d["w_max_mm"]), textcoords="offset points",
                xytext=(8, 8), fontsize=7, color=ROT)

    ax.invert_yaxis()
    ax.set_xlabel("Station [m]")
    ax.set_ylabel("w [mm]")
    ax.legend(fontsize=8, loc="upper right", framealpha=0.9)
    ax.grid(alpha=0.25)
    ax.set_title(titel or (
        f"Durchbiegung {ergebnis['balken'].id} — w$_{{max}}$ = {d['w_max_mm']:.1f} mm, "
        f"{d['ausnutzung_max']*100:.0f} % von l/250"))
    return ax


def unterzugsuebersicht(ax, netz, ergebnisse: dict, ausnutzungen: dict,
                        titel="Unterzüge — Ausnutzung im Grundriss"):
    """
    Alle Unterzüge auf einen Blick, im Grundriss eingefärbt nach Ausnutzung.

    Vor der Einzelbetrachtung jedes Balkens (System, Durchbiegung, Biegung,
    Querkraft, …) steht hier die räumliche Übersicht: wo im Grundriss die
    Ausnutzung am größten ist, sieht man auf einen Blick, ohne durch eine
    Tabelle zu gehen. Dieselbe Ampellogik wie bei `ampel()` — Grün über Gelb
    nach Rot bei 1,0 —, nur räumlich statt als Balken.

    `ausnutzungen` ist ein dict `{balken_id: wert}`, vom Aufrufer berechnet —
    üblicherweise das Maximum aus Biege- und Druckstrebenausnutzung, dieselben
    beiden Werte, die in der Nachweisampel je Unterzug erscheinen. Diese
    Funktion zeichnet nur, sie bewertet nicht.
    """
    from matplotlib.colors import Normalize

    ring = np.vstack([netz.polygon, netz.polygon[:1]])
    ax.plot(ring[:, 0], ring[:, 1], color="k", lw=1.2, zorder=1)
    ax.fill(ring[:, 0], ring[:, 1], color=GRUEN, alpha=0.06, zorder=0)

    gueltig = [w for w in ausnutzungen.values() if np.isfinite(w)]
    hoechst = max(gueltig) if gueltig else 1.0
    cmap = plt.get_cmap("RdYlGn_r")
    norm = Normalize(vmin=0.0, vmax=max(1.2, hoechst * 1.1))

    for kennung, erg in ergebnisse.items():
        balken = erg["balken"]
        wert = ausnutzungen.get(kennung)
        farbe = cmap(norm(wert)) if wert is not None and np.isfinite(wert) else "#999999"

        p = np.asarray(balken.polylinie, dtype=float)
        richtung = p[1] - p[0]
        laenge = float(np.linalg.norm(richtung))
        if laenge < 1e-9:
            continue
        n = np.array([-richtung[1], richtung[0]]) / laenge * (balken.breite_m / 2.0)
        band = np.array([p[0] + n, p[1] + n, p[1] - n, p[0] - n])
        ax.add_patch(MplPolygon(band, closed=True, facecolor=farbe, alpha=0.85,
                                edgecolor="k", lw=1.0, zorder=3))

        mitte = p.mean(axis=0)
        beschriftung = f"{kennung}\n{wert:.2f}" if wert is not None else f"{kennung}\n–"
        ax.text(mitte[0], mitte[1], beschriftung, ha="center", va="center", fontsize=7,
                fontweight="bold", color="k", zorder=6,
                bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.8))

    sm = plt.cm.ScalarMappable(cmap=cmap, norm=norm)
    sm.set_array([])
    strich = plt.colorbar(sm, ax=ax, fraction=0.046, pad=0.03)
    strich.set_label("Ausnutzung")
    strich.ax.axhline(1.0, color="k", lw=1.3)

    _rahmen(ax, netz, umriss=False)
    ax.autoscale_view()
    ax.set_title(titel)
    return ax


def bewehrungsskizze(ax, ergebnis: dict, seite: str = "beide", titel=None):
    """
    Längsschnitt mit der gestaffelten Bewehrung — die Skizze, aus der die
    Positionsliste wird.

    Gezeichnet ist der Träger im Aufriss: Steg und Gurt maßstäblich in der
    Höhe, die Länge im Maßstab des Trägers. Darin liegen die durchlaufende
    Grundbewehrung, die Zulagen mit ihrer wirklichen Länge (also einschließlich
    Versatzmaß und Verankerung) und die Bügelbereiche.

    Der helle Teil jedes Zulagenbalkens ist die Verlängerung um a_l + l_bd —
    also genau der Teil, den man beim Zeichnen von Hand vergisst und der im
    fertigen Bauteil nicht mehr nachzuprüfen ist.

    **Beide Lagen gehören auf dasselbe Blatt.** `seite="beide"` zeichnet die
    Feldbewehrung unten und die Stützbewehrung oben in einen Träger, fortlaufend
    nummeriert. Eine Skizze mit nur der unteren Lage sieht vollständig aus und
    ist es nicht: über der Stütze liegt der Stahl oben, und dort ist er beim
    Plattenbalken regelmäßig der stärkere.
    """
    balken = ergebnis["balken"]
    s = np.asarray(ergebnis["schnitt"]["s"], dtype=float)
    h, h_f, laenge = balken.hoehe_m, balken.dicke_m, float(s[-1] - s[0])
    unten_gurt = balken.richtung != "oben"

    gewuenscht = ["unten", "oben"] if seite == "beide" else [seite]
    lagen = [(name, ergebnis.get(f"staffelung_{name}")) for name in gewuenscht]
    lagen = [(name, staffel) for name, staffel in lagen if staffel]
    if not lagen:
        raise ValueError("keine Staffelung zum Zeichnen")

    # Schalung im Aufriss
    y_gurt = h - h_f if unten_gurt else 0.0
    ax.add_patch(MplPolygon([(s[0], y_gurt), (s[-1], y_gurt),
                             (s[-1], y_gurt + h_f), (s[0], y_gurt + h_f)],
                            closed=True, facecolor="#e8e8e8", edgecolor="#aaaaaa", lw=0.8))
    y_steg = 0.0 if unten_gurt else h_f
    ax.add_patch(MplPolygon([(s[0], y_steg), (s[-1], y_steg),
                             (s[-1], y_steg + h - h_f), (s[0], y_steg + h - h_f)],
                            closed=True, facecolor="#f4f4f4", edgecolor="k", lw=1.2))

    # Bügel als senkrechte Striche im tatsächlichen Abstand — aber höchstens
    # so viele, wie man noch unterscheiden kann; sonst ist der Steg schwarz.
    rand = 0.035
    for bereich in ergebnis["buegel"]:
        abstand = max(bereich["abstand_mm"] / 1000.0, laenge / 160.0)
        orte = np.arange(bereich["von_m"], bereich["bis_m"] + 1e-9, abstand)
        for ort in orte:
            ax.plot([ort, ort], [rand, h - rand], color=BLAU, lw=0.7, alpha=0.75)
        ax.text((bereich["von_m"] + bereich["bis_m"]) / 2, h + h * 0.12,
                bereich["bezeichnung"], ha="center", fontsize=7, color=BLAU)

    # Längsbewehrung als Balken an ihrer wirklichen Lage, die Beschriftung
    # daneben: übereinandergesetzte Balken *im* Steg wären nach zwei Zulagen
    # nicht mehr auseinanderzuhalten, und der Steg ist nur 45 cm hoch.
    schritt = h * 0.075
    nummer = 0
    spalten = []
    for name, staffel in lagen:
        y_lage = rand if name == "unten" else h - rand
        vorzeichen = 1.0 if name == "unten" else -1.0
        beschriftung = []

        # Die zweite Stablage ist keine Zulage, sondern liegt hinter der ersten;
        # im Aufriss steht sie als zweiter Strich unmittelbar daneben.
        stab_lagen = len((staffel.get("bild") or {}).get("lagen", [])) or 1
        for k in range(stab_lagen):
            ax.plot([s[0], s[-1]], [y_lage + vorzeichen * k * schritt * 0.35] * 2,
                    color=ROT, lw=3.5 if k == 0 else 2.0,
                    solid_capstyle="butt", zorder=7)

        nummer += 1
        beschriftung.append(
            f"{chr(0x245F + nummer)} {name}: {staffel['grund_bezeichnung']} durchlaufend "
            f"({staffel['grund_cm2']:.2f} cm²)")
        for i, zulage in enumerate(staffel["zulagen"], start=1):
            nummer += 1
            y = y_lage + vorzeichen * i * schritt
            ax.plot([zulage["von_m"], zulage["bis_m"]], [y, y], color=ZULAGE, lw=3.5,
                    solid_capstyle="butt", zorder=6)
            ax.plot([zulage["roh_von_m"], zulage["roh_bis_m"]], [y, y], color=ROT, lw=3.5,
                    solid_capstyle="butt", zorder=7)
            ax.text((zulage["von_m"] + zulage["bis_m"]) / 2, y + vorzeichen * schritt * 0.5,
                    chr(0x245F + nummer), ha="center",
                    va="bottom" if name == "unten" else "top",
                    fontsize=8, color=ROT, zorder=8)
            beschriftung.append(
                f"{chr(0x245F + nummer)} {zulage['bezeichnung']} ({zulage['a_s_cm2']:.2f} cm²), "
                f"{zulage['von_m']:.2f}…{zulage['bis_m']:.2f} m = {zulage['laenge_m']:.2f} m")
        if staffel.get("hinweis"):
            # Kein Warndreieck: DejaVu Sans, die Schrift aller Bilder hier, hat
            # kein U+26A0 und zeichnete an seiner Stelle ein leeres Kästchen.
            beschriftung.append(f"   (!) {staffel['hinweis']}")
        spalten.append(beschriftung)

    zeilen_max = max(len(spalte) for spalte in spalten)
    for i, spalte in enumerate(spalten):
        ax.text(s[0] + i * laenge * 0.50, -h * 0.24, "\n".join(spalte), fontsize=7,
                color=ROT, va="top", ha="left", zorder=8)

    _lagersymbole(ax, ergebnis["lager"], 0.0 if unten_gurt else h_f, laenge, h,
                  beschriften=False)

    ax.set_xlim(s[0] - laenge * 0.03, s[-1] + laenge * 0.03)
    ax.set_ylim(-h * (0.35 + 0.16 * zeilen_max), h * 1.45)
    ax.set_yticks([])
    ax.spines["left"].set_visible(False)
    ax.set_xlabel("Station [m]")
    lagen_txt = " und ".join(name for name, _ in lagen)
    ax.set_title(titel or (
        f"Bewehrungsskizze {balken.id}, Lage {lagen_txt} — a$_l$ = "
        f"{lagen[0][1]['versatzmass_m']:.2f} m (z·cot θ/2), "
        f"heller Teil = a$_l$ + l$_{{bd}}$"))
    return ax
