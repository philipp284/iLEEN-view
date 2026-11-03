"""
Lastabtrag: was eine Decke abgibt, was eine Wand trägt, was ins Fundament geht.

Dieses Modul führt Buch. Es rechnet nichts nach — das tun `plate`, `wand` und
`stuetze` —, sondern hält fest, **welche Kraft von welchem Bauteil auf welches
übergeht**, und zwar in einer Form, aus der sich am Fuß der Kette noch
nachvollziehen lässt, aus welchem Geschoss ein Anteil stammt.

## Warum charakteristische Anteile und nicht ein Bemessungswert

Die naheliegende Buchung wäre eine Zahl je Bauteil: „auf dieser Wand stehen
184 kN". Sie ist falsch, sobald mehr als ein Geschoss beteiligt ist.

Ein Bemessungswert trägt die Teilsicherheits- und Kombinationsbeiwerte der
Kombination in sich, aus der er stammt. Gibt man ihn nach unten weiter und
kombiniert dort erneut, steht γ zweimal darin; über drei Geschosse wächst der
Fehler auf γ³ ≈ 2,5 statt 1,35. Er fällt nicht auf, weil jede einzelne Rechnung
für sich stimmt und das Ergebnis nur „konservativ" aussieht.

Genauso falsch wäre die Rückrechnung „N_d / 1,4". Der Faktor ist nicht bekannt:
er hängt vom Mischungsverhältnis aus ständigem und veränderlichem Anteil ab,
und genau dieses Verhältnis ändert sich von Geschoss zu Geschoss — oben liegt
fast nur Nutzlast, unten überwiegt das Eigengewicht der Wände.

Gebucht wird deshalb **je Lastfall getrennt und charakteristisch**
(`Lastpaket.anteile_kN`). Kombiniert wird einmal, an der Stelle, an der ein
Nachweis geführt wird — mit der Kombinationsregel, die dort gilt. Das ist
zugleich der einzige Weg, an dem die quasi-ständige Kombination für Kriechen
und Setzung überhaupt noch herstellbar ist.

## Vorzeichen

Vertikalkräfte sind hier **Druck positiv**, weil das die Richtung ist, in der
Lastabtrag stattfindet.

Das passt ohne Umrechnung zu dem, was der Solver liefert: `auflagerbilanz()`
gibt R_z > 0 für ein drückendes Lager (so auch die Legende des Auflagerbilds,
„rot = drückend", und die Gleichgewichtsprobe, die `last + lager = 0` prüft).
Eine Decke, die mit 640 kN nach unten wirkt, erzeugt R_z = +640 kN, und genau
diese 640 kN stehen auf der Wand darunter. Ein Vorzeichenwechsel beim Buchen
wäre falsch — er machte aus jeder Last einen Zug und aus jedem Nachweis eine
Absurdität, die erst am negativen Ergebnis auffiele.

## Was dieses Modul nicht kann

Es verteilt nicht. Trägt eine Wand nur auf ihrer halben Länge, weil das
Auflager nur dort liegt, steht die volle Kraft trotzdem auf der ganzen Wand —
die Auflagerlinie ist die Wahrheit, nicht die Wandgeometrie. Es kennt auch
keine Steifigkeitsverteilung zwischen parallelen Wänden: die kommt aus der
FE-Rechnung der Decke darüber und ist bereits in den Auflagerkräften enthalten.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Iterable

from .tragend import TRAGENDE_KLASSEN, materialklasse, schichtwichte

# Kennung des Eigengewichts, gleichlautend mit `plate.EIGENGEWICHT`. Hier noch
# einmal, damit dieses Modul ohne JAX importierbar bleibt — `plate` zieht den
# Solver mit, und die Buchhaltung soll auch in einem Prozess laufen, der nur
# Ergebnisse anzeigt.
EIGENGEWICHT = "EG"

#: Teilsicherheitsbeiwerte nach DIN EN 1990/NA, Tabelle A.1.2(B), ungünstig.
GAMMA_G = 1.35
GAMMA_Q = 1.50
#: Beiwert für den günstig wirkenden ständigen Anteil — beim Kippnachweis und
#: bei der Bemessung schlanker Wände auf Ausmitte der maßgebende Fall.
GAMMA_G_GUENSTIG = 1.00


# ── Rollen ────────────────────────────────────────────────────────────────


#: IFC-Klasse → Rolle im Lastabtrag. Die Rolle entscheidet, welcher Nachweis
#: geführt wird und ob ein Bauteil Lasten weitergibt oder aufnimmt.
ROLLEN = {
    "IfcSlab": "decke",
    "IfcRoof": "decke",
    "IfcWall": "wand",
    "IfcWallStandardCase": "wand",
    "IfcColumn": "stuetze",
    "IfcFooting": "fundament",
    "IfcPile": "fundament",
    "IfcBeam": "unterzug",
}

#: Klassen, die **nicht** ins Tragwerk gehören, obwohl ihr Name danach klingt.
#:
#: `IfcMember` und `IfcPlate` sind die Glieder einer **Vorhangfassade**:
#: Pfosten, Riegel und Glasfüllungen. Bis September 2026 standen sie in
#: `ROLLEN` als `stuetze` und `decke` — an `Ifc4_SampleHouse.ifc` gemessen
#: waren das 20 Pfosten und 6 Gläser, und mit der Regel „jede Stütze trägt"
#: wurde daraus ein Tragwerk aus 3-cm-Pfosten: acht Konten mit zusammen
#: 0,5 kN Eigengewicht, während die drei Ziegelwände daneben standen.
#:
#: Die IFC-Definition ist eindeutig: `IfcMember` ist ein *Bauteilglied* ohne
#: Aussage über Tragfähigkeit — es umfasst Sprossen, Streben und Geländerstäbe
#: ebenso wie Fachwerkstäbe. `IfcPlate` ist ein *Plattenglied*, im Hochbau fast
#: immer eine Glasfüllung. Wer damit wirklich trägt, führt es als `IfcColumn`
#: respektive `IfcSlab` oder sagt es über einen Eingriff.
FASSADENGLIEDER = ("IfcMember", "IfcPlate", "IfcCurtainWall")


def rolle_von(ifc_type: str | None, psets: dict | None = None,
              name: str | None = None) -> str:
    """
    Die Rolle eines Bauteils im Lastabtrag.

    Der Typ allein reicht nicht: eine Bodenplatte ist im IFC eine `IfcSlab` wie
    jede Geschossdecke, und der Unterschied entscheidet darüber, ob ihre
    Auflagerkräfte weitergereicht oder als Sohldruck abgeschlossen werden.
    Erkannt wird sie an `PredefinedType = BASESLAB` — dem einzigen Ort, an dem
    das im Modell überhaupt steht — und ersatzweise am Namen.
    """
    typ = (ifc_type or "").strip()
    if typ in FASSADENGLIEDER:
        return "sonstiges"
    rolle = ROLLEN.get(typ)
    if rolle is None:
        # Unbekannte Klassen mit passendem Präfix trotzdem einordnen: Modelle
        # aus älteren Werkzeugen führen `IfcSlabStandardCase` und Ähnliches.
        for kennung, wert in ROLLEN.items():
            if typ.startswith(kennung):
                rolle = wert
                break
    if rolle is None:
        return "sonstiges"

    if rolle == "decke":
        vordefiniert = _pset_wert(psets, "PredefinedType") or ""
        if str(vordefiniert).upper() in ("BASESLAB", "FOOTING"):
            return "fundament"
        if name and any(w in name.lower() for w in ("bodenplatte", "sohlplatte", "fundament")):
            return "fundament"
    return rolle


def _pset_wert(psets: dict | None, schluessel: str):
    """Ein Property über alle Property-Sets hinweg suchen, Groß/klein egal."""
    if not psets:
        return None
    gesucht = schluessel.lower()
    for werte in psets.values():
        if not isinstance(werte, dict):
            continue
        for k, v in werte.items():
            if str(k).lower() == gesucht and v is not None:
                return v
    return None


def pset_zahl(psets: dict | None, *schluessel: str) -> float | None:
    """Erste als Zahl lesbare Eigenschaft aus einer Liste von Kandidaten."""
    for name in schluessel:
        wert = _pset_wert(psets, name)
        if wert is None:
            continue
        try:
            zahl = float(str(wert).replace(",", "."))
        except (TypeError, ValueError):
            continue
        if zahl > 0:
            return zahl
    return None


# ── Lastpakete ────────────────────────────────────────────────────────────


@dataclass
class Lastpaket:
    """
    Eine Kraft, die von einem Bauteil auf ein anderes übergeht.

    `anteile_kN` ist die eigentliche Nutzlast dieser Klasse: Lastfall →
    charakteristische Vertikalkraft in kN, Druck positiv. Alles Weitere ist
    Herkunftsangabe, damit ein Ergebnis am Fundament noch bis zur Decke
    zurückverfolgbar bleibt.
    """

    quelle_art: str                       # "decke" | "eigengewicht" | "wand" | "stuetze"
    quelle: str = ""                      # GlobalId der Quelle, oder result_id
    quelle_name: str = ""
    geschoss: str = ""
    lager: str | None = None              # Auflager-ID im FEM-Modell
    anteile_kN: dict[str, float] = field(default_factory=dict)
    laenge_m: float = 0.0                 # Länge der Einleitung; 0 = punktförmig
    polylinie: list[list[float]] | None = None
    H_x_kN: float = 0.0                   # Horizontalanteile, charakteristisch
    H_y_kN: float = 0.0

    @property
    def N_k_kN(self) -> float:
        """Summe aller charakteristischen Anteile — die Gebrauchslast."""
        return sum(self.anteile_kN.values())

    @property
    def je_m_kN(self) -> float:
        """Charakteristische Linienlast; `nan`-frei, 0 bei punktförmiger Einleitung."""
        return self.N_k_kN / self.laenge_m if self.laenge_m > 1e-9 else 0.0

    def als_dict(self) -> dict:
        d = asdict(self)
        d["N_k_kN"] = round(self.N_k_kN, 2)
        d["je_m_kN"] = round(self.je_m_kN, 2)
        return d


def abminderung_alpha_n(geschosse: int, psi0: float = 0.7) -> float:
    """
    Abminderungsbeiwert α_n für Nutzlasten aus mehreren Geschossen,
    DIN EN 1991-1-1/NA, 6.3.1.2(11).

        α_n = (2 + (n − 2) · ψ₀) / n        für n > 2

    Der Gedanke dahinter ist eine Wahrscheinlichkeitsaussage: dass alle
    Geschosse eines Hauses gleichzeitig voll belegt sind, ist unwahrscheinlich,
    und mit jedem weiteren Geschoss wird es unwahrscheinlicher. Bei sechs
    Geschossen und ψ₀ = 0,7 bleiben 80 % — eine Wand im Erdgeschoss wird also
    für spürbar weniger Nutzlast bemessen, als die Summe der Geschosse ergäbe.

    **Ohne diesen Beiwert ist ein mehrgeschossiger Lastabtrag durchweg zu
    schwer.** Er gilt nur für Kategorien A bis D und nur für die Nutzlast; das
    Eigengewicht wird nicht abgemindert, und mit der Abminderung nach Fläche
    (α_A) darf er nicht zugleich angesetzt werden.
    """
    n = max(int(geschosse), 1)
    if n <= 2:
        return 1.0
    return (2.0 + (n - 2) * psi0) / n


#: Die Lastfälle, die α_n abmindern darf: die Nutzlast der Geschosse.
#: **Dach und Schnee nicht** — DIN EN 1991-1-1, 6.3.1.2 (11) gilt für die
#: Kategorien A bis D, und n zählt die Geschosse *derselben* Kategorie über
#: dem Bauteil. Ein Dach ist kein solches Geschoss.
NUTZLASTFAELLE = ("NUTZ",)


def bemessungswert(anteile: dict[str, float], arten: dict[str, str],
                   psi0: dict[str, float] | None = None,
                   guenstig: bool = False,
                   geschosse_darueber: int = 0,
                   abminderbar: tuple[str, ...] = NUTZLASTFAELLE) -> dict:
    """
    Charakteristische Anteile → Bemessungswert nach DIN EN 1990, Gl. 6.10.

        N_Ed = γ_G · ΣG  +  γ_Q · Q_leit  +  γ_Q · Σ ψ₀ · Q_i

    **Jede veränderliche Einwirkung wird einmal Leiteinwirkung**, maßgebend
    ist der größte Wert. Die größte Einwirkung zur Leiteinwirkung zu machen
    genügt nur, solange alle dasselbe ψ₀ haben. Mit dem Dach ist das vorbei:
    Kategorie H hat ψ₀ = 0, die Nutzlast 0,7. Bei 240 kN Nutzlast und 80 kN
    Dachlast ergibt „Nutzlast führt" 1,5·240 = 360 kN, „Dach führt"
    1,5·80 + 1,5·0,7·240 = 372 kN — das Dach führt, obwohl es kleiner ist.

    **α_n wirkt nur auf die Nutzlast** (`abminderbar`) und nimmt deren ψ₀. Die
    erste Fassung minderte alle veränderlichen Anteile ab und nahm das
    kleinste ψ₀ unter ihnen — mit der Dachlast (ψ₀ = 0) wurde daraus
    α_n = 2/n statt (2 + (n − 2)·0,7)/n, bei drei Geschossen 0,67 statt 0,90:
    ein Drittel der Nutzlast weg, in jeder Wand unter einem Dach.

    Ein veränderlicher Anteil, der entlastet (negativ), geht mit γ_Q,inf = 0
    ein (DIN EN 1990, Tab. A.1.2(B)) — eine Last, die fehlen darf, darf nicht
    helfen.

    @param geschosse_darueber  n für α_n: Geschosse mit Nutzlast über dem
                               Bauteil, das Dach nicht mitgezählt
    @returns dict mit N_Ed_kN, N_k_kN, staendig_kN, veraenderlich_kN,
             quasi_staendig_kN, leiteinwirkung, alpha_n
    """
    psi0 = psi0 or {}
    staendig = sum(v for k, v in anteile.items() if arten.get(k, "G") == "G")
    veraenderlich = {k: v for k, v in anteile.items() if arten.get(k, "G") != "G"}

    # Nutzlasten aus mehreren Geschossen abmindern, bevor kombiniert wird.
    alpha_n = 1.0
    nutz = [k for k in veraenderlich if k in abminderbar]
    if geschosse_darueber > 2 and nutz:
        alpha_n = abminderung_alpha_n(
            geschosse_darueber, min(float(psi0.get(k, 0.7)) for k in nutz))
        veraenderlich = {k: (v * alpha_n if k in nutz else v)
                         for k, v in veraenderlich.items()}

    gamma_g = GAMMA_G_GUENSTIG if guenstig else GAMMA_G
    n_ed = gamma_g * staendig

    def mit_leitung(leit: str) -> float:
        return sum(GAMMA_Q * (1.0 if k == leit else float(psi0.get(k, 0.7))) * max(v, 0.0)
                   for k, v in veraenderlich.items())

    leit = None
    if veraenderlich:
        leit = max(sorted(veraenderlich), key=mit_leitung)
        n_ed += mit_leitung(leit)

    # Quasi-ständig (Gl. 6.16b) — für Kriechen, Setzung und Rissbreite.
    quasi = staendig + sum(float(psi0.get(f"{k}:psi2", 0.3)) * v
                           for k, v in veraenderlich.items())

    return {
        "N_Ed_kN": round(n_ed, 2),
        "N_k_kN": round(staendig + sum(veraenderlich.values()), 2),
        "staendig_kN": round(staendig, 2),
        "veraenderlich_kN": round(sum(veraenderlich.values()), 2),
        "quasi_staendig_kN": round(quasi, 2),
        "gamma_mittel": round(n_ed / max(staendig + sum(veraenderlich.values()), 1e-9), 3),
        "leiteinwirkung": leit,
        "alpha_n": round(alpha_n, 3),
        "geschosse_darueber": geschosse_darueber,
    }


# ── Konten ────────────────────────────────────────────────────────────────


@dataclass
class Konto:
    """
    Ein Bauteil im Lastabtrag: was ankommt, was es selbst wiegt, was es abgibt.

    Der Ausgang wird nicht gespeichert, sondern gerechnet (`ausgang()`) — er
    ist immer Eingang plus Eigengewicht, und eine zweite gespeicherte Zahl
    könnte davon abweichen, sobald ein Geschoss neu gerechnet wird.
    """

    global_id: str
    ifc_type: str = ""
    name: str = ""
    geschoss: str = ""
    rolle: str = "sonstiges"
    tragend: bool | None = None
    geometrie: dict = field(default_factory=dict)
    eingang: list[Lastpaket] = field(default_factory=list)
    eigengewicht_kN: float = 0.0
    #: Die Wichte, mit der das Eigengewicht gerechnet wurde, kN/m³. Sie steht
    #: hier, damit der Bericht sie zeigen kann: 25 an einer Holzwand ist der
    #: sichtbare Hinweis darauf, dass der Werkstoff nicht erkannt wurde.
    wichte_kNm3: float = 0.0
    nachweis: dict | None = None
    hinweise: list[str] = field(default_factory=list)
    #: Wie viele Geschosse über diesem Bauteil Nutzlast eintragen — die
    #: Bezugsgröße für die Abminderung α_n.
    geschosse_darueber: int = 1
    #: Ob das Eigengewicht schon nach unten weitergereicht wurde. Eine Wand,
    #: die zwei Deckenfelder trägt, wird zweimal gebucht — ihr Gewicht darf
    #: aber nur einmal weiterwandern, sonst steht es doppelt in der Bilanz.
    _eigengewicht_weitergegeben: bool = False

    # -- Bilanz --------------------------------------------------------

    def anteile(self) -> dict[str, float]:
        """Alle Eingänge je Lastfall zusammengezählt, samt eigenem Gewicht."""
        summe: dict[str, float] = {}
        for paket in self.eingang:
            for kennung, wert in paket.anteile_kN.items():
                summe[kennung] = summe.get(kennung, 0.0) + wert
        if self.eigengewicht_kN:
            summe[EIGENGEWICHT] = summe.get(EIGENGEWICHT, 0.0) + self.eigengewicht_kN
        return summe

    def ausgang(self) -> dict[str, float]:
        """Was dieses Bauteil nach unten weitergibt — dasselbe wie `anteile()`."""
        return self.anteile()

    @property
    def laenge_m(self) -> float:
        """
        Tragende Länge der Wand — ihre Achslänge, nicht die Summe der Lagerlinien.

        **Der Unterschied ist ein Faktor zwei.** Eine Wand wird im Schnitt zu
        einem Rechteck, und `auflagerlinien()` nimmt daraus *beide* Längsseiten
        als Lager — bei einer umlaufenden Wand entsprechend Außen- und
        Innenkante. Die Summe dieser Linien ist also rund die doppelte
        Wandlänge. Teilte man die Gesamtauflagerkraft dadurch, käme die Hälfte
        der tatsächlichen Linienlast heraus, und jeder Wandnachweis fiele um
        den Faktor zwei zu günstig aus.

        Maßgebend ist deshalb die Achslänge aus dem Querschnitt
        (`wandquerschnitt()['laenge_m']` = Fläche / Dicke). Die Lagerlängen
        bleiben nur als Notbehelf, wenn keine Geometrie vorliegt — dort dann
        halbiert, weil zwei Lagerlinien je Wandseite die Regel sind.
        """
        aus_geometrie = float(self.geometrie.get("laenge_m") or 0.0)
        if aus_geometrie > 1e-9:
            return aus_geometrie
        aus_lagern = sum(p.laenge_m for p in self.eingang if p.laenge_m > 1e-9)
        return aus_lagern / 2.0

    def als_dict(self, arten: dict[str, str], psi0: dict[str, float] | None = None) -> dict:
        anteile = self.anteile()
        bemessung = bemessungswert(anteile, arten, psi0,
                                   geschosse_darueber=self.geschosse_darueber)
        laenge = self.laenge_m
        return {
            "global_id": self.global_id,
            "ifc_type": self.ifc_type,
            "name": self.name,
            "geschoss": self.geschoss,
            "rolle": self.rolle,
            "tragend": self.tragend,
            "geometrie": self.geometrie,
            "eingang": [p.als_dict() for p in self.eingang],
            "eigengewicht_kN": round(self.eigengewicht_kN, 2),
            "wichte_kNm3": round(self.wichte_kNm3, 1) or None,
            "anteile_kN": {k: round(v, 2) for k, v in anteile.items()},
            "bemessung": bemessung,
            "laenge_m": round(laenge, 2),
            # Eine Linienlast gibt es nur bei linienförmiger Lagerung. Bei einer
            # Stütze wäre `laenge_m` ihre Querschnittskante — 0,30 m bei einer
            # 30er Stütze —, und N_Ed geteilt durch 0,30 ergäbe eine Zahl, die
            # wie eine Wandlast aussieht und das Dreifache der Stützenlast
            # beträgt. Der Stützennachweis rechnet ohnehin mit N_Ed selbst.
            "N_Ed_je_m_kNm": (round(bemessung["N_Ed_kN"] / laenge, 2)
                              if laenge > 1e-9 and self.rolle != "stuetze" else None),
            "nachweis": self.nachweis,
            "hinweise": self.hinweise,
        }


# ── Buchung ───────────────────────────────────────────────────────────────


def aus_auflagerbilanz(bericht: dict, geschoss: str, decke_gid: str = "",
                       decke_name: str = "") -> dict[str, list[Lastpaket]]:
    """
    Aus dem Bericht einer Deckenrechnung die Lastpakete für die Bauteile darunter.

    Erwartet `bericht["auflager_lastfallweise"]` — die charakteristische Bilanz
    je Lastfall, die `rechnung.rechne()` seit dem Lastabtrag mitschreibt. Fehlt
    sie (ältere Läufe), wird auf `bericht["auflager"]` zurückgefallen; dann
    steht ein Bemessungswert im Paket, und das wird als Hinweis vermerkt, denn
    weiterreichen darf man ihn nur einmal.

    Die Zuordnung zum Bauteil steht bereits im Modell: `auflager[].bauteile`
    trägt die GlobalIds der Wände, aus deren Querschnitt die Lagerlinie
    abgeleitet wurde, und `auflager[].bauteil_anteile` je Bauteil dessen
    Achslänge — danach wird die Kraft aufgeteilt. Ein Lager ohne Bauteilbezug — von Hand im Zeichenmodus
    gesetzt — landet unter dem Schlüssel `""` und geht damit nicht verloren,
    sondern taucht in der Bilanz als nicht zuordenbar auf.

    @returns GlobalId → Lastpakete (ein Paket je Auflagerlinie)
    """
    lastfallweise = bericht.get("auflager_lastfallweise") or {}
    pakete: dict[str, list[Lastpaket]] = {}

    if lastfallweise:
        # Über die Lager-IDs gehen, nicht über die Lastfälle: jedes Lager
        # bekommt ein Paket, in dem alle Lastfälle stehen.
        je_lager: dict[str, dict] = {}
        for kennung, bilanz in lastfallweise.items():
            for eintrag in bilanz:
                sammel = je_lager.setdefault(eintrag["id"], {"eintrag": eintrag, "anteile": {}})
                # R_z > 0 ist bereits die drückende Reaktion — siehe Kopf.
                sammel["anteile"][kennung] = float(eintrag.get("R_z_kN", 0.0))
                sammel["eintrag"] = eintrag
        quelle_bemessung = False
    else:
        je_lager = {
            e["id"]: {"eintrag": e, "anteile": {EIGENGEWICHT: float(e.get("R_z_kN", 0.0))}}
            for e in bericht.get("auflager", [])
        }
        quelle_bemessung = True

    for lager_id, sammel in je_lager.items():
        eintrag = sammel["eintrag"]
        ziele = eintrag.get("bauteile") or [""]
        # **Nach Achslänge, nicht gleichmäßig.** Ein Lager kann aus mehreren
        # Wandstücken zusammengeführt sein (`tragwerksmodell.
        # lager_zusammenfuehren()`); dann steht in `bauteil_anteile`, wieviel
        # Achslänge jedes Stück beisteuert. Gleichmäßig geteilt bekäme ein
        # 2-m-Stück so viel wie ein 12-m-Stück — und der Knicknachweis des
        # kurzen Stücks fiele um das Sechsfache zu ungünstig aus.
        anteile_laenge = {gid: float(w) for gid, w
                          in (eintrag.get("bauteil_anteile") or {}).items()
                          if gid in ziele and float(w) > 0.0}
        summe_laenge = sum(anteile_laenge.values())
        for ziel in ziele:
            if summe_laenge > 0.0:
                faktor = anteile_laenge.get(ziel, 0.0) / summe_laenge
            else:
                # Kein Lager wurde zusammengeführt, oder keine Längen bekannt:
                # gleichmäßig, wie bisher.
                faktor = 1.0 / max(len(ziele), 1)
            paket = Lastpaket(
                quelle_art="decke",
                quelle=decke_gid or bericht.get("plan", {}).get("job_id", ""),
                quelle_name=decke_name or f"Decke über {geschoss}",
                geschoss=geschoss,
                lager=lager_id,
                anteile_kN={k: v * faktor for k, v in sammel["anteile"].items()},
                laenge_m=(float(eintrag.get("laenge_m") or 0.0) * faktor
                          if summe_laenge > 0.0
                          else float(eintrag.get("laenge_m") or 0.0)),
                H_x_kN=float(eintrag.get("R_x_kN", 0.0)) * faktor,
                H_y_kN=float(eintrag.get("R_y_kN", 0.0)) * faktor,
            )
            if quelle_bemessung:
                paket.quelle_art = "decke (Bemessungswert)"
            pakete.setdefault(ziel, []).append(paket)

    return pakete


#: Wichten **tragender** Bauteile je Materialklasse, kN/m³, nach
#: DIN EN 1991-1-1 Anhang A (Tab. A.1 Baustoffe, Tab. A.3 Holz).
#:
#: **Warum Wand und Stütze getrennt stehen.** Gerechnet wird beide Male über
#: das Bruttovolumen, aber das meint Verschiedenes. Eine Stütze ist auf ihrer
#: ganzen Querschnittsfläche aus ihrem Werkstoff; eine Holzständerwand ist es
#: nicht — zwischen den Ständern liegt Dämmung, außen Beplankung. Über die
#: Gesamtdicke gemittelt wiegt sie rund 5 kN/m³, das Vollholz darin 4,2.
#: Bei Stahlbeton und Mauerwerk fällt der Unterschied weg, dort steht zweimal
#: derselbe Wert.
WICHTEN_TRAGEND: dict[str, tuple[float, float]] = {
    # Klasse:        (Wand [kN/m³], Stütze [kN/m³])
    "stahlbeton":    (25.0, 25.0),
    "mauerwerk":     (18.0, 18.0),
    "holz":          (5.0,   4.2),
    "stahl":         (78.5, 78.5),
    "leichtbau":     (9.0,   9.0),
}

#: Ohne erkannte Materialklasse bleibt es bei Stahlbeton. Das ist der schwerste
#: übliche Baustoff und damit für den Lastabtrag nach unten die sichere Seite —
#: aber es ist eine Annahme, und deshalb sagt es `wichte_tragend` mit an.
WICHTE_TRAGEND_UNBEKANNT = 25.0


def wichte_tragend(materialklasse: str | None,
                   rolle: str = "wand") -> tuple[float, bool]:
    """
    Materialklasse → Wichte in kN/m³ und ob sie aus dem Modell stammt.

    Das zweite Element ist `False`, wenn die Klasse fehlt oder unbekannt ist
    und deshalb `WICHTE_TRAGEND_UNBEKANNT` gilt. Wer es ignoriert, rechnet
    eine Holzwand als Beton — genau das war der Fehler, den diese Funktion
    behebt: bis dahin ließ `kette.py` den Vorgabewert 25 kN/m³ stehen, und
    ein Holzbau wog in der Kette das Fünffache.
    """
    eintrag = WICHTEN_TRAGEND.get(materialklasse or "")
    if eintrag is None:
        return WICHTE_TRAGEND_UNBEKANNT, False
    return (eintrag[1] if rolle == "stuetze" else eintrag[0]), True


#: Wie weit die Summe der Schichtdicken von der gemessenen Wanddicke abweichen
#: darf, damit die Schichten als Beschreibung *dieses* Körpers gelten.
AUFBAU_TOLERANZ = 0.15


def aufbau_wand(schichten: list[dict] | None, *, dicke_gesamt_m: float,
                dicke_tragend_m: float, ersatz_kNm3: float) -> dict:
    """
    Wichte und tragende Dicke einer Wand aus ihren Materialschichten.

    **Eine Wand ist kein Block aus ihrem tragenden Werkstoff.** Bis Oktober
    2026 wog die Kette die Gesamtdicke mit der Wichte der tragenden Schicht:
    eine 33-cm-Außenwand aus 1,5 cm Putz, 17,5 cm Kalksandstein und 14 cm
    Mineralwolle mit 0,33·18 = 5,94 kN/m². Aus den Schichten sind es
    0,015·18 + 0,175·18 + 0,14·1,0 = 3,56 kN/m² — zwei Drittel. Und geknickt
    wurde mit 33 cm statt 17,5: bei t³ das Siebenfache der Steifigkeit.

    Die Schichten gelten nur, wenn sie zum geschnittenen Körper passen (Summe
    innerhalb `AUFBAU_TOLERANZ` der gemessenen Dicke). Sonst beschreiben sie
    etwas anderes — einen Aufbau, dessen Schalen als eigene Bauteile modelliert
    sind —, und es bleibt bei `ersatz_kNm3`. Unbekannte Schichten gehen mit
    `ersatz_kNm3` ein.

    @returns {wichte_kNm3, aus_schichten, quelle, dicke_tragend_m, aufbau}
             `wichte_kNm3` gilt für die gemessene Gesamtdicke (Mittel über den
             Aufbau); `dicke_tragend_m` ist die dickste tragende Schicht, wenn
             der Schnitt den Aufbau als einen Körper liefert
    """
    gueltig = _schichten_lesen(schichten)
    summe_d = sum(d for _, d in gueltig)
    nichts = {"wichte_kNm3": ersatz_kNm3, "aus_schichten": False, "quelle": None,
              "dicke_tragend_m": dicke_tragend_m, "aufbau": []}
    if not gueltig or dicke_gesamt_m <= 1e-6:
        return nichts
    if abs(summe_d - dicke_gesamt_m) > AUFBAU_TOLERANZ * dicke_gesamt_m:
        return {**nichts, "quelle": (
            f"Schichten ({summe_d*100:.1f} cm) passen nicht zur gemessenen Dicke "
            f"({dicke_gesamt_m*100:.1f} cm) — Wichte des Werkstoffs angesetzt")}

    aufbau = []
    unbekannt = 0
    for name, d in gueltig:
        w = schichtwichte(name)
        if w is None:
            w = ersatz_kNm3
            unbekannt += 1
        aufbau.append({"name": name, "dicke_m": round(d, 4), "wichte_kNm3": w,
                       "tragend": materialklasse(name) in TRAGENDE_KLASSEN})
    wichte = sum(a["dicke_m"] * a["wichte_kNm3"] for a in aufbau) / summe_d

    dicke_t = dicke_tragend_m
    tragende = [a for a in aufbau if a["tragend"]]
    if tragende and len(aufbau) > 1:
        kern = max(a["dicke_m"] for a in tragende)
        if dicke_tragend_m <= 1e-6 or kern < dicke_tragend_m - 0.01:
            dicke_t = kern

    quelle = (f"aus {len(aufbau)} Schichten: "
              + " + ".join(f"{a['name']} {a['dicke_m']*100:.1f} cm × {a['wichte_kNm3']:g}"
                           for a in aufbau)
              + f" → {wichte:.2f} kN/m³ im Mittel")
    if unbekannt:
        quelle += (f"; {unbekannt} Schicht{'en' if unbekannt > 1 else ''} ohne "
                   f"erkannte Wichte mit {ersatz_kNm3:g} kN/m³")
    return {"wichte_kNm3": round(wichte, 3), "aus_schichten": True, "quelle": quelle,
            "dicke_tragend_m": round(dicke_t, 4), "aufbau": aufbau}


#: Werkstoffe, aus denen eine Platte trägt — Beton und Mauerwerk (Hohlkörper,
#: Betonsteine einer Balken-Stein-Decke). Holz und Stahl tragen auch, aber
#: nicht als Platte aus Beton: eine Holzbalkendecke ist ein Balkenrost, und als
#: Betonplatte gerechnet wäre sie um ein Vielfaches zu steif.
PLATTE_TRAGEND = frozenset({"stahlbeton", "mauerwerk"})


def mittlere_schichtwichte(schichten) -> float | None:
    """
    Mittlere Wichte eines Aufbaus, kN/m³ — über die Dicken gewichtet, nur aus
    Schichten mit bekannter Wichte. `None`, wenn keine bekannt ist.
    """
    from .tragend import schichtwichte
    summe_d = summe_w = 0.0
    for name, d in _schichten_lesen(schichten):
        w = schichtwichte(name)
        if w is None:
            continue
        summe_d += d
        summe_w += w * d
    return round(summe_w / summe_d, 3) if summe_d > 1e-6 else None


def _schichten_lesen(schichten) -> list[tuple[str, float]]:
    """
    Name und Dicke (m) je Schicht, ohne Schichten ohne Dicke.

    Elementverzeichnisse von vor dem 2026-10-26 führen die Dicken in der
    Längeneinheit der Datei, bei Revit in Millimetern. Eine Schicht über zwei
    Meter gibt es nicht — dann ist es mm.
    """
    gueltig = [(str(sch.get("name") or ""), float(sch.get("dicke_m") or 0.0))
               for sch in schichten or []]
    gueltig = [(n, d) for n, d in gueltig if d > 1e-4]
    if gueltig and max(d for _, d in gueltig) > 2.0:
        gueltig = [(n, d / 1000.0) for n, d in gueltig]
    return gueltig


def aufbau_platte(schichten: list[dict] | None, *, dicke_m: float,
                  wichte_tragwerk: float = 25.0) -> dict:
    """
    Tragende Dicke und Aufbaulast einer Decke aus ihren Materialschichten.

    **Eine Decke ist so dick wie ihr Tragwerk, nicht wie ihre Hüllbox.** Bis
    Oktober 2026 rechnete die Kette jede Platte mit der Dicke ihrer Hüllbox als
    Vollbeton: der Revit-Fußboden des SampleHouse — 6,5 cm Estrich, 8 cm
    Dämmung, 15 cm Luft, 10 cm Betonsteine, 7,5 cm Fertigteil — wog als 47 cm
    Beton 11,75 kN/m² und war in der FE entsprechend steif. Aus den Schichten
    sind es 5,2 kN/m², tragend 17,5 cm.

    Tragend ist der größte zusammenhängende Block aus Schichten in
    `PLATTE_TRAGEND` (Estrich über Dämmung trägt nicht mit). Die FE rechnet ihn
    mit `wichte_tragwerk`; was der übrige Aufbau wiegt — und was der Block
    leichter ist als Vollbeton —, wird `aufbau_kNm2`, die Ausbaulast **aus dem
    Modell**. Sie tritt an die Stelle der angenommenen.

    @returns {aus_schichten, dicke_tragend_m, aufbau_kNm2, quelle, aufbau};
             `aufbau_kNm2` ist None, wenn das Modell keinen Aufbau führt
             (dann bleibt es bei der Annahme)
    """
    nichts = {"aus_schichten": False, "dicke_tragend_m": dicke_m,
              "aufbau_kNm2": None, "quelle": None, "aufbau": []}
    gueltig = _schichten_lesen(schichten)
    if len(gueltig) < 1 or dicke_m <= 1e-6:
        return nichts
    summe_d = sum(d for _, d in gueltig)
    if abs(summe_d - dicke_m) > AUFBAU_TOLERANZ * dicke_m:
        return {**nichts, "quelle": (
            f"Schichten ({summe_d*100:.1f} cm) passen nicht zur gemessenen Dicke "
            f"({dicke_m*100:.1f} cm)")}

    aufbau = []
    for name, d in gueltig:
        w = schichtwichte(name)
        aufbau.append({"name": name, "dicke_m": round(d, 4),
                       "wichte_kNm3": wichte_tragwerk if w is None else w,
                       "erkannt": w is not None,
                       "tragend": materialklasse(name) in PLATTE_TRAGEND})

    bloecke, laufend = [], []
    for i, a in enumerate(aufbau):
        if a["tragend"]:
            laufend.append(i)
        elif laufend:
            bloecke.append(laufend)
            laufend = []
    if laufend:
        bloecke.append(laufend)
    if not bloecke:
        return {**nichts, "quelle": "keine Schicht aus Beton oder Mauerwerk im Aufbau"}
    block = max(bloecke, key=lambda b: sum(aufbau[i]["dicke_m"] for i in b))
    dicke_t = sum(aufbau[i]["dicke_m"] for i in block)
    for i in block:
        aufbau[i]["traegt"] = True

    gesamt = sum(a["dicke_m"] * a["wichte_kNm3"] for a in aufbau)
    rest = [a for i, a in enumerate(aufbau) if i not in block]
    aufbau_kNm2 = max(gesamt - dicke_t * wichte_tragwerk, 0.0) if rest else None
    quelle = (" + ".join(f"{a['name']} {a['dicke_m']*100:.1f} cm × {a['wichte_kNm3']:g}"
                         for a in aufbau)
              + f" = {gesamt:.2f} kN/m²; tragend {dicke_t*100:.1f} cm")
    if any(not a["erkannt"] for a in aufbau):
        quelle += f"; ohne erkannte Wichte mit {wichte_tragwerk:g} kN/m³"
    return {"aus_schichten": True, "dicke_tragend_m": round(dicke_t, 4),
            "aufbau_kNm2": None if aufbau_kNm2 is None else round(aufbau_kNm2, 3),
            "quelle": quelle, "aufbau": aufbau}


def eigengewicht_wand(laenge_m: float, hoehe_m: float, dicke_m: float,
                      wichte_kNm3: float = 25.0, oeffnungsanteil: float = 0.0) -> float:
    """
    Eigengewicht einer Wandscheibe in kN.

    `wichte_kNm3` kommt aus `wichte_tragend()`. Der Vorgabewert gilt nur für
    Aufrufe, die kein Material kennen — er ist Stahlbeton und damit für jeden
    anderen Baustoff zu schwer.

    `oeffnungsanteil` zieht Fenster und Türen pauschal ab. Ohne Angabe bleibt
    die Wand voll — das ist die sichere Seite für den Lastabtrag nach unten und
    die unsichere für einen Kippnachweis; letzterer wird hier nicht geführt.
    """
    volumen = max(laenge_m, 0.0) * max(hoehe_m, 0.0) * max(dicke_m, 0.0)
    return volumen * wichte_kNm3 * (1.0 - min(max(oeffnungsanteil, 0.0), 0.95))


def eigengewicht_stuetze(hoehe_m: float, flaeche_m2: float,
                         wichte_kNm3: float = 25.0) -> float:
    """Eigengewicht einer Stütze in kN. `wichte_kNm3` wie bei der Wand."""
    return max(hoehe_m, 0.0) * max(flaeche_m2, 0.0) * wichte_kNm3


# ── Bilanz über die ganze Kette ───────────────────────────────────────────


def gesamtbilanz(konten: Iterable[Konto], arten: dict[str, str],
                 psi0: dict[str, float] | None = None,
                 eingetragen_kN: float = 0.0,
                 gruendung_kN: float = 0.0,
                 nicht_abgesetzt_kN: float = 0.0,
                 nicht_gerechnet_kN: float = 0.0) -> dict:
    """
    Die Erhaltungsprobe der ganzen Kette.

    **Warum nicht einfach alle Auflagerkräfte summiert werden.** Eine Last aus
    dem obersten Geschoss taucht in jedem darunterliegenden Auflager erneut
    auf — bei drei Geschossen dreimal. Die Summe aller Lastpakete ist deshalb
    keine Kontrollgröße, sondern ein Vielfaches der Wahrheit; sie wächst mit
    der Zahl der Geschosse, ohne dass etwas falsch wäre.

    Verglichen wird stattdessen, was **neu** in die Kette eingetragen wurde —
    je Geschoss sein Plattengewicht und seine Flächenlasten (`eingetragen_kN`),
    dazu alle Eigengewichte der Wände und Stützen — mit dem, was am Fuß
    ankommt (`gruendung_kN`). Beide Zahlen müssen übereinstimmen. Tun sie es
    nicht, ist Last aus der Kette gefallen: ein Auflager ohne Bauteilbezug,
    eine Wand ohne Fortsetzung im Geschoss darunter, ein übersprungenes
    Geschoss.

    @param eingetragen_kN       Summe der neu eingetragenen Flächenlasten
    @param gruendung_kN         was am Fuß der Wandkette ankommt (Fußkräfte des
                                untersten Geschosses bzw. Last auf der Sohle)
    @param nicht_abgesetzt_kN   Last, die am Ende der Kette offen blieb, weil
                                sie über keinem rechenbaren Deckenfeld stand
    @param nicht_gerechnet_kN   eigene Last der Deckenfelder, die nicht
                                gerechnet werden konnten (geschätzt)

    **Verloren ist verloren.** Bis Oktober 2026 zählten nicht abgesetzte
    Lasten als „bekannter Abgang" und die Probe galt als erfüllt, und eine
    Decke, die nicht gerechnet werden konnte, fehlte auf *beiden* Seiten.
    Am SampleHouse meldete die Bilanz so „erhalten", obwohl das ganze Haus
    über der Sohle fehlte. Jetzt gehört beides zum Erwarteten, und was nicht
    ankommt, ist Fehlbetrag. `kette_rechnet` sagt daneben, ob wenigstens die
    Buchführung der gerechneten Teile stimmt.

    `fehlbetrag_kN` = erwartet − angekommen: positiv heißt, es fehlt Last.
    """
    konten = list(konten)
    je_rolle: dict[str, dict] = {}
    nicht_zuordenbar = 0.0
    for konto in konten:
        eintrag = je_rolle.setdefault(konto.rolle, {"anzahl": 0, "eigengewicht_kN": 0.0})
        eintrag["anzahl"] += 1
        eintrag["eigengewicht_kN"] += konto.eigengewicht_kN
        if not konto.global_id:
            nicht_zuordenbar += sum(konto.anteile().values())

    eigengewichte = sum(k.eigengewicht_kN for k in konten
                        if k.rolle in ("wand", "stuetze"))
    soll = eingetragen_kN + eigengewichte + nicht_gerechnet_kN
    fehlbetrag = soll - gruendung_kN
    # Die Buchführung der Teile, die gerechnet wurden: stimmt sie, wenn man
    # das Nichtabgesetzte und Nichtgerechnete als bekannt abzieht?
    buchung = (eingetragen_kN + eigengewichte) - (gruendung_kN + nicht_abgesetzt_kN)
    grenze = max(0.01 * soll, 0.5)

    return {
        "je_rolle": {r: {k: round(v, 1) if isinstance(v, float) else v
                         for k, v in e.items()} for r, e in je_rolle.items()},
        "eingetragen_kN": round(eingetragen_kN, 1),
        "eigengewichte_kN": round(eigengewichte, 1),
        "nicht_gerechnet_kN": round(nicht_gerechnet_kN, 1),
        "erwartet_am_fuss_kN": round(soll, 1),
        "gebucht_am_fuss_kN": round(gruendung_kN, 1),
        "nicht_abgesetzt_kN": round(nicht_abgesetzt_kN, 1),
        "fehlbetrag_kN": round(fehlbetrag, 1),
        "abweichung_rel": round(abs(fehlbetrag) / soll, 5) if soll > 1e-6 else None,
        "erhalten": abs(fehlbetrag) <= grenze,
        "kette_rechnet": abs(buchung) <= grenze,
        "nicht_zuordenbar_kN": round(nicht_zuordenbar, 1),
        "bemessung_am_fuss": bemessungswert(
            {k: sum(kk.anteile().get(k, 0.0) for kk in konten
                    if kk.rolle in ("wand", "stuetze") and kk.geschoss == _unterstes(konten))
             for k in {kk for c in konten for kk in c.anteile()}},
            arten, psi0) if konten else None,
    }


def _unterstes(konten: list[Konto]) -> str:
    """Das Geschoss, in dem die Kette endet — für die Bemessung am Fuß."""
    for konto in reversed(konten):
        if konto.rolle in ("wand", "stuetze"):
            return konto.geschoss
    return ""
