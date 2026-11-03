"""
Der Lastabtrag über alle Geschosse: von der obersten Decke bis zur Gründung.

Das Stück, um dessentwillen die anderen Module gebaut wurden. Es rechnet nicht
selbst — es ordnet an, in welcher Reihenfolge gerechnet wird, und trägt dafür
Sorge, dass zwischen zwei Geschossen nichts verlorengeht und nichts doppelt
gezählt wird.

## Der Ablauf

    Geschoss  Decke rechnen        Auflagerkräfte      Wände darunter
    ────────────────────────────────────────────────────────────────
    2. OG     ██ FE-Rechnung  →   je Lastfall     →   N, Knicknachweis
                                                       ↓ + Eigengewicht
    1. OG     ██ FE-Rechnung  →   je Lastfall     →   N, Knicknachweis
              ↑ Linienlasten aus dem OG darüber     ↓ + Eigengewicht
    EG        ██ FE-Rechnung  →   je Lastfall     →   N, Knicknachweis
              ↑ Linienlasten aus dem 1. OG           ↓ + Eigengewicht
    Gründung                      Sohllasten je Wandachse

Die Rückkopplung nach oben gibt es nicht: eine Decke wird von dem belastet, was
über ihr steht, und die Steifigkeit der Wände darunter geht nur als Lagerung
ein, nicht als Federung. Das ist die Annahme des geschossweisen Verfahrens, und
sie ist im üblichen Hochbau die richtige. Wo sie es nicht ist — bei
Wandscheiben unterschiedlicher Steifigkeit über mehrere Geschosse, bei
abgefangenen Wänden —, sagt es diese Rechnung nicht von selbst.

## Die zwei Stellen, an denen ein Lastabtrag üblicherweise falsch wird

**Doppelte Sicherheitsbeiwerte.** Siehe `lastabtrag` — deshalb wandern
charakteristische Anteile je Lastfall durch die Kette, nie Bemessungswerte.

**Verlorene Kräfte.** Ein Auflager ohne Bezug zu einem Bauteil, eine Wand, die
im Geschoss darunter keine Fortsetzung hat, eine Decke, die nicht gerechnet
werden konnte — jeder dieser Fälle nimmt Last aus der Kette heraus, ohne dass
es auffällt. `lastabtrag.gesamtbilanz()` stellt deshalb am Ende die Summe der
eingetragenen Lasten der Summe an den Fundamenten gegenüber; klaffen sie
auseinander, steht die Differenz im Bericht statt in niemandes Kenntnis.

## Wie eine Wand ihre Last weitergibt

Am Wandfuß steht, was oben ankam, plus das eigene Gewicht. Diese Kraft wird der
Decke darunter als **Linienlast auf derselben Polylinie** übergeben, auf der
die Wand im Grundriss steht. Dass die Koordinaten passen, ist kein Zufall: im
Grundriss ist die Abbildung von 3D in die Zeichenebene die Identität in x und y
(`section._plane`), die Planebenen aller Geschosse teilen sich also dasselbe
Koordinatensystem.

Steht die Wand im untersten Geschoss, endet die Kette: ihre Fußkraft wird als
Gründungslast gebucht, nicht als Last auf eine weitere Decke.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field

import numpy as np

from . import eingriffe as eg
from . import lastabtrag as la
from . import stuetze as st
from . import stand as sd
from . import submodell as sm
from . import tragwerksmodell as tm
from . import wand as wd

logger = logging.getLogger(__name__)


@dataclass
class Zugang:
    """
    Was die Kette von ihrer Umgebung braucht.

    Als Objekt mit Rückrufen statt fester Importe, damit dieses Modul ohne
    FastAPI, MinIO und IfcOpenShell prüfbar bleibt — die Kettenlogik ist
    dieselbe, ob die Schnitte aus einer IFC-Datei oder aus einem Testdatensatz
    kommen.
    """

    schnitt: callable          # (box, mode, cut_height) -> dict wie POST /section
    geschosse: list            # [{name, boden, decke}], beliebige Reihenfolge
    psets: dict                # GlobalId -> Property-Sets
    boxen: dict                # GlobalId -> {lo, hi}
    huelle: dict               # {lo: [x,y,z], hi: [...]} des ganzen Modells
    rechne: callable           # (modell, annahmen, melden) -> bericht
    job_id: str = ""
    modellname: str = ""
    #: Räume mit Grundrissfigur, aus `section.raumkennwerte(mit_grundriss=True)`.
    #: Sie tragen die Nutzung, aus der die raumweisen Nutzlasten entstehen.
    #: Ohne sie fällt die Nutzlast auf die Vorgabekategorie zurück — die
    #: Kette rechnet weiter, sagt es aber im Bericht.
    raeume: list = field(default_factory=list)
    #: Teil → Elternbauteil (`section.bauteil_eltern()`). ArchiCAD schreibt
    #: mehrschichtige Wände und zusammengesetzte Stützen als Bauteil ohne
    #: eigenen Körper; die Geometrie steckt in `IfcBuildingElementPart`. Mit
    #: dieser Zuordnung sieht die Kette das Bauteil statt seiner Teile —
    #: im Verzeichnis (`boxen`) wie im Schnitt.
    eltern: dict = field(default_factory=dict)

    def __post_init__(self):
        # Stahlprofile als Proxy (HEA 240, IPE 200 …) nach ihrer Lage deuten.
        profile = _profile_deuten(self.boxen)
        eltern = self.eltern
        if eltern:
            self.boxen, als_balken = _teile_in_boxen(self.boxen, eltern)
            # Decken aus Balkenteilen bleiben Balken — im Schnitt wie im Verzeichnis.
            profile.update(als_balken)
            eltern = {k: v for k, v in eltern.items() if k not in als_balken}
        if eltern or profile:
            roh = self.schnitt

            def schnitt(box, mode, cut_height):
                return _teile_in_schnitt(roh(box, mode, cut_height), eltern, profile)
            self.schnitt = schnitt

    def raeume_von(self, geschoss: str) -> list:
        """
        Die Räume eines Geschosses.

        Über den Geschossnamen und nicht über die Höhe: `_storey_of()` ordnet
        Räume über `Decomposes` zu, und das ist die Angabe des Modells. Eine
        Zuordnung über z-Bereiche träfe bei einem Luftraum über zwei Geschosse
        beide, und die Nutzlast käme doppelt an.
        """
        return [r for r in self.raeume if (r.get("storey") or "") == geschoss]

    def raeume_auf(self, platte: dict, geschosse: list | None = None,
                   unten: float = 0.30, oben: float = 0.80) -> list:
        """
        Die Räume, die **auf** dieser Platte stehen — ihre Nutzlast trägt sie.

        **Der Fehler, den das behebt.** Bis Oktober 2026 bekam die Decke über
        dem Erdgeschoss die Räume des Erdgeschosses. Die Menschen im Büro des
        Erdgeschosses stehen aber auf der Bodenplatte; auf der Decke über dem
        Erdgeschoss stehen die des Obergeschosses. Die Nutzlast lag damit
        durchweg eine Decke zu hoch — auf dem Dach die Wohnnutzung des
        obersten Geschosses, auf der Bodenplatte gar keine —, und im
        Regelgeschoss fiel es nicht auf, weil dort zufällig dieselbe Nutzung
        darüber wie darunter liegt.

        Entschieden wird über die Lage, nicht über den Geschossnamen: der Raum
        beginnt auf der Oberkante der Platte oder darüber im Fußbodenaufbau
        (`unten` … `oben`), und sein Grundriss liegt über ihr. Ein Raum ohne
        Höhenangabe fällt auf den Namen des Geschosses zurück, dessen Boden
        der Plattenoberkante am nächsten liegt.
        """
        z = float(platte["z_oben"])
        lo, hi = platte["lo"], platte["hi"]
        rueckfall = None
        if geschosse:
            naechstes = min(geschosse, key=lambda g: abs(float(g["boden"]) - z))
            if abs(float(naechstes["boden"]) - z) <= 1.0:
                rueckfall = naechstes["name"]
        treffer = []
        for r in self.raeume:
            zu = r.get("z_unten")
            if zu is None:
                if rueckfall and (r.get("storey") or "") == rueckfall:
                    treffer.append(r)
                continue
            if not (z - unten <= float(zu) <= z + oben):
                continue
            mitte = _ringmitte(r.get("grundriss"))
            if mitte is not None and not _in_box(mitte, lo, hi, zugabe=0.5):
                continue
            treffer.append(r)
        return treffer


#: Namen von Stahlprofilen, die als `IfcBuildingElementProxy` exportiert werden.
_PROFILNAME = re.compile(r"^\s*(HE[ABM]?|HD|HL|IPE[AO]?|IPN|UPE|UPN|U|I|RHS|SHS|CHS|QRO|RRO|ROR)"
                         r"\s*[-_ ]?\s*\d", re.IGNORECASE)


def _profile_deuten(boxen: dict) -> dict[str, str]:
    """
    Stahlprofile als Proxy: liegend ein Träger, stehend eine Stütze.

    Exporte setzen Walzprofile, die als Bibliotheksobjekt gezeichnet wurden,
    oft als `IfcBuildingElementProxy` ab — mit dem Profil im Namen („HEA 240").
    Für den Lastabtrag sind sie sonst „sonstiges". Schreibt den gedeuteten Typ
    in `boxen` (der ursprüngliche steht unter `ifc_type_quelle`).

    @returns GlobalId → gedeuteter Typ, für den Schnitt
    """
    gedeutet: dict[str, str] = {}
    for gid, b in boxen.items():
        if (b.get("ifc_type") or "") != "IfcBuildingElementProxy" or not b.get("hi"):
            continue
        if not _PROFILNAME.match(str(b.get("name") or "")):
            continue
        dz = float(b["hi"][2]) - float(b["lo"][2])
        _, laenge, _, _ = _grundrissmass(b)
        typ = "IfcColumn" if dz > laenge else "IfcBeam"
        b["ifc_type_quelle"] = b["ifc_type"]
        b["ifc_type"] = typ
        gedeutet[gid] = typ
    return gedeutet


def _teile_in_boxen(boxen: dict, eltern: dict) -> tuple[dict, dict[str, str]]:
    """
    Die Teile eines Bauteils zu einem Eintrag: Hüllbox vereinigt, Volumen
    summiert, Werkstoff des größten Teils, je Teil eine Materialschicht (bei
    Wänden mit der Breite des Teils als Dicke), Grundrissrechteck aus allen.

    **Eine Decke aus Balken ist eine Balkenlage.** Besteht eine Decke aus
    mindestens `BALKENLAGE_MIN_BALKEN` Teilen, von denen vier Fünftel liegende,
    schlanke Stäbe sind (Lucy: das Dach „Unterzug-028", 256 Balken 12/24 als
    Teile einer IfcSlab), bleiben die Teile einzeln und gelten als `IfcBeam` —
    zusammengefasst zerfiele die Decke in Streifen ohne Lager, einzeln findet
    `balkenlagen()` sie.

    @returns (neues Verzeichnis, Teil-GlobalId → „IfcBeam" für Balkenteile)
    """
    from shapely.ops import unary_union

    neu = {gid: b for gid, b in boxen.items() if gid not in eltern}
    als_balken: dict[str, str] = {}
    gruppen: dict[str, list] = {}
    for teil, e in eltern.items():
        if teil in boxen and boxen[teil].get("hi"):
            gruppen.setdefault(e["global_id"], []).append((e, boxen[teil], teil))
    for gid in list(gruppen):
        teile = gruppen[gid]
        if la.rolle_von(teile[0][0]["ifc_type"]) != "decke" or len(teile) < BALKENLAGE_MIN_BALKEN:
            continue
        schlank = 0
        for _, b, _ in teile:
            _, laenge, quer, _ = _grundrissmass(b)
            dz = float(b["hi"][2]) - float(b["lo"][2])
            if (laenge >= max(4.0 * max(quer, 0.05), BALKEN_MIN_LAENGE_M)
                    and quer <= BALKEN_HOECHSTBREITE_M and dz <= BALKEN_HOECHSTHOEHE_M):
                schlank += 1
        if schlank < 0.8 * len(teile):
            continue
        for e, b, teil in gruppen.pop(gid):
            neu[teil] = {**b, "ifc_type": "IfcBeam", "ifc_type_quelle": b.get("ifc_type"),
                         "name": f"{e.get('name') or gid} · {b.get('name') or 'Balken'}"}
            als_balken[teil] = "IfcBeam"
    for gid, teile in ((g, [(e, b) for e, b, _ in t]) for g, t in gruppen.items()):
        e = teile[0][0]
        eigene = neu.get(gid)
        alle = [b for _, b in teile] + ([eigene] if eigene and eigene.get("hi") else [])
        groesstes = max(alle, key=lambda b: float(b.get("volumen_m3") or 0.0)
                        or float(np.prod(np.asarray(b["hi"]) - np.asarray(b["lo"]))))
        wand = la.rolle_von(e["ifc_type"]) == "wand"
        schichten = []
        for b in alle:
            g = b.get("grundriss") or {}
            schichten.append({"name": b.get("material"),
                              "dicke_m": float(g["breite_m"]) if wand and g.get("breite_m") else None,
                              "tragend_gesetzt": None})
        volumen = sum(float(b.get("volumen_m3") or 0.0) for b in alle)
        eintrag = {
            "lo": [min(float(b["lo"][i]) for b in alle) for i in range(3)],
            "hi": [max(float(b["hi"][i]) for b in alle) for i in range(3)],
            "ifc_type": e["ifc_type"], "name": e.get("name") or groesstes.get("name"),
            "storey": groesstes.get("storey"), "material": groesstes.get("material"),
            "materialschichten": schichten, "teile": len(teile),
        }
        if volumen > 0:
            eintrag["volumen_m3"] = volumen
        figuren = [_grundrissfigur(b) for b in alle if b.get("grundriss")]
        if figuren:
            rechteck = unary_union(figuren).minimum_rotated_rectangle
            ecken = np.asarray(rechteck.exterior.coords)[:4]
            a, b2 = ecken[1] - ecken[0], ecken[2] - ecken[1]
            lang, kurz = (a, b2) if np.hypot(*a) >= np.hypot(*b2) else (b2, a)
            eintrag["grundriss"] = {
                "winkel_grad": float(np.degrees(np.arctan2(lang[1], lang[0]))) % 180.0,
                "laenge_m": float(np.hypot(*lang)), "breite_m": float(np.hypot(*kurz)),
                "mitte": [float(rechteck.centroid.x), float(rechteck.centroid.y)]}
        neu[gid] = eintrag
    return neu, als_balken


def _teile_in_schnitt(antwort: dict, eltern: dict, profile: dict | None = None) -> dict:
    """
    Im Schnitt die Figuren der Teile eines Bauteils zu einer Figur: alle Ringe
    zusammen (eine Wand aus Schichtteilen wird so eine Mehrschichtwand, wie sie
    `wandquerschnitt()` kennt), Werkstoff des flächengrößten Teils.
    """
    figuren = []
    gruppen: dict[tuple, dict] = {}

    def flaeche(f):
        ring = (f.get("rings") or [[]])[0]
        if len(ring) < 3:
            return 0.0
        x = np.asarray([p[0] for p in ring]); y = np.asarray([p[1] for p in ring])
        return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)

    for f in antwort.get("figures") or []:
        gid = f.get("global_id")
        if profile and gid in profile:
            f = {**f, "ifc_type": profile[gid]}
        e = eltern.get(gid)
        if not e:
            figuren.append(f)
            continue
        schluessel = (e["global_id"], f.get("kind"))
        g = gruppen.get(schluessel)
        if g is None:
            g = {**f, "global_id": e["global_id"], "ifc_type": e["ifc_type"],
                 "name": e.get("name") or f.get("name"), "rings": list(f.get("rings") or []),
                 "_flaeche": flaeche(f)}
            gruppen[schluessel] = g
            figuren.append(g)
            continue
        g["rings"].extend(f.get("rings") or [])
        if flaeche(f) > g["_flaeche"]:
            g["material"], g["_flaeche"] = f.get("material"), flaeche(f)
        if f.get("volumen_m3") is not None:
            g["volumen_m3"] = float(g.get("volumen_m3") or 0.0) + float(f["volumen_m3"])
    for g in gruppen.values():
        g.pop("_flaeche", None)
    return {**antwort, "figures": figuren}


@dataclass
class Geschossergebnis:
    name: str
    #: Das normalisierte Kürzel (`OG2`, `EG`, …). Der IFC-Name bleibt in
    #: `name` stehen: er ist das, was der Planer im Modell sieht, und gehört
    #: neben das Kürzel in jede Anzeige.
    kuerzel: str = ""
    status: str = "offen"          # offen | gerechnet | uebersprungen | fehlgeschlagen
    meldung: str = ""
    result_id: str | None = None
    konten: list[la.Konto] = field(default_factory=list)
    weiter_nach_unten: list[dict] = field(default_factory=list)
    eingetragen_kN: float = 0.0
    #: Alle Deckenfelder dieses Geschosses — bei einem Gebäude aus zwei
    #: Baukörpern sind es zwei, und beide müssen gerechnet werden.
    platten: list[dict] = field(default_factory=list)
    berichte: list[dict] = field(default_factory=list)
    #: Nur bei der Gründung: was die Bodenplatten von oben bekamen — das Ende
    #: der Wandkette, die Größe, gegen die die Erhaltungsprobe prüft.
    lasten_von_oben_kN: float = 0.0


#: Über dieser Dicke ist eine Figur keine Deckenplatte mehr, sondern ein
#: Aufbau. Der Fall, der das nötig macht, steht in `deckenplatten()`.
HOECHSTDICKE_DECKE_M = 0.80

#: Wie hoch ein Geschoss unter einer Platte mindestens ist, damit die Platte
#: seine **Decke** ist und nicht sein Fußboden.
#:
#: Die erste Fassung verlangte nur, dass die Mitte der Platte 10 cm über dem
#: Geschossboden liegt. Ein Geschoss „Fundament" auf der Unterkante der
#: Bodenplatte — in Architekturmodellen häufig, eine Ebene für Gründung und
#: Sohle — machte daraus die Decke über dem Fundament: die Bodenplatte wurde
#: als Geschossdecke gerechnet, gelagert auf den Wänden, die *auf* ihr stehen,
#: und danach noch einmal als Bodenplatte (Prüfhaus H1: 2 348 statt 1 608 kN
#: am Fuß, jede Wand doppelt gewogen). Eine Decke liegt über einem Raum;
#: 1,20 m ist niedriger als jeder Kriechkeller und höher als jeder Aufbau.
MIN_LICHTE_HOEHE_M = 1.20


def _wandschnitt_ueber_boden(hoehe: float) -> float:
    """
    Wie hoch über dem Geschossboden die Wände geschnitten werden.

    45 % der Wandhöhe, mindestens 0,40 m, höchstens 1,20 m (Brüstungen,
    Öffnungen). **In niedrigen Geschossen nicht über die halbe Höhe:** zwischen
    Deckenbalkenlage und Dachlage stehen Pfosten von 0,40–0,60 m, und die
    Stiele unter Rähm und Pfette enden 10–20 cm unter der Dachlage (VA3:
    0,48 m Wandhöhe, Stiele bis 10,46/10,56 m, Schnitt bei 10,58 m — die Lage
    hing auf einer Seite frei, 53 mm Durchbiegung).
    """
    return min(1.2, max(min(0.4, 0.5 * hoehe), 0.45 * hoehe))


def _lichte_mindesthoehe(geschoss: dict, obergrenze: float) -> float:
    """
    Wie hoch über dem Geschossboden eine Decke frühestens beginnt.

    Sonst `MIN_LICHTE_HOEHE_M`. **Abgeleitete Geschosse** (`geschosse_aus_decken`)
    liegen aber von Deckenebene zu Deckenebene, und dort gibt es niedrige: die
    Pfosten zwischen Deckenbalkenlage und Dachbalkenlage (VA3, 0,68 m). Mit
    1,20 m fände die Dachlage keine Decke über sich. Bei ihnen genügt die
    halbe Geschosshöhe — der eigene Fußboden liegt am Boden, nicht darüber.
    """
    hoehe = float(obergrenze) - float(geschoss["boden"])
    if geschoss.get("abgeleitet") and hoehe < 2.0 * MIN_LICHTE_HOEHE_M:
        return max(0.5 * hoehe, 0.10)
    return MIN_LICHTE_HOEHE_M


def _tragrang(b: dict) -> int:
    """
    Wie wahrscheinlich eine Platte das Tragwerk ist: 0 tragend, 1 unbekannt, 2 Aufbau.

    Für die Wahl zwischen zwei Platten über derselben Fläche. Die erste
    Fassung nahm die dickste — an der OPL gewann so eine EPS-Dämmplatte gegen
    die Stahlbetondecke darunter. Der Werkstoff entscheidet zuerst, die Dicke
    nur noch unter Gleichrangigen.
    """
    from .tragend import werkstoffklasse
    klasse = werkstoffklasse(b.get("material"), b.get("materialschichten"))
    if klasse in ("stahlbeton", "mauerwerk", "holz", "stahl"):
        return 0
    if klasse in ("daemmung", "leichtbau"):
        return 2
    return 1


def deckenplatten(geschoss: dict, obergrenze: float, boxen: dict,
                  mindestdicke: float = 0.08,
                  hoechstdicke: float = HOECHSTDICKE_DECKE_M,
                  mindestflaeche_anteil: float = 0.15) -> list[dict]:
    """
    Die Deckenplatten über einem Geschoss — **alle**, nicht nur die größte.

    **Warum Plural.** Ein Gebäude von 87 m Länge besteht selten aus einem
    Deckenfeld. Das geprüfte Modell hat zwei Baukörper (x −0,1…40,4 und
    x 46,8…86,8), jedes Geschoss also zwei Platten. Eine erste Fassung rechnete
    je Geschoss nur die flächengrößte — und verlor damit nicht bloß deren
    Ergebnisse, sondern die gesamte Last des anderen Baukörpers: die Wandlasten
    von oben landeten außerhalb des Systemumrisses und wurden von
    `plate._anteile()` stillschweigend verworfen. Die Erhaltungsprobe zeigte
    79 % Fehlbetrag.

    **Warum das trotzdem keinen zweiten Schnitt kostet.** Die Platten eines
    Geschosses liegen auf derselben Höhe — sie sind ja dieselbe Decke, nur in
    getrennten Feldern. Ein waagerechter Schnitt trifft sie alle zugleich;
    aus denselben Figuren entstehen mehrere Systemflächen. Nur die
    FE-Rechnungen vervielfachen sich, und die sind der schnelle Teil.

    **Was ausgefiltert wird.** Zu dünne Elemente (Beläge, Estrich), zu kleine
    relativ zur größten (Treppenpodeste, Aufzugsüberfahrten) — und zu **dicke**.
    Der Anteil ist bewusst großzügig: lieber ein Podest zuviel gerechnet als ein
    Deckenfeld verloren.

    **Warum es eine Höchstdicke gibt.** An `Ifc4_SampleHouse.ifc` gemessen: die
    Rohdecke ist eine 16 cm dicke `IfcSlab` bei z 2,81…2,97, darüber liegt ein
    `IfcRoof` von z 2,21…3,95 — der Dachaufbau aus Attika, Gefälledämmung und
    Abdichtung, 1,74 m hoch. Beide überdecken sich, ihre Mitten liegen 19 cm
    auseinander, und die Regel darunter („von zwei überdeckenden Platten bleibt
    die dickste") hielt sie für dieselbe Platte in zwei Lagen. Gewonnen hat der
    Aufbau.

    Die Folge war nicht bloß eine falsche Dicke: der Dachaufbau liegt
    geometrisch anders als die Wände darunter, die Lagerlinien fielen aus dem
    Systemumriss, und **beide Geschosse waren nicht rechenbar** — mit der
    Meldung „keine Auflager gefunden", die auf das Gegenteil des wahren Grundes
    zeigte.

    Die Regel selbst ist richtig, sie hatte nur einen zu weiten Anwendungsraum:
    gemeint war Rohdecke plus Aufbeton (beide tragen), nicht Rohdecke plus
    Dachaufbau (nur eine trägt). Eine Decke über 80 cm gibt es im Hochbau
    nicht; was dicker ist, ist ein Aufbau oder ein Modellierungsfehler. Für
    Bodenplatten gilt die Grenze nicht — die sucht `bodenplatte()`.

    @returns Liste, nach Fläche absteigend; leer, wenn keine Platte passt
    """
    boden = float(geschoss["boden"])
    kandidaten = []
    for gid, b in boxen.items():
        if la.rolle_von(b.get("ifc_type"), None, b.get("name")) not in ("decke", "fundament"):
            continue
        z_unten, z_oben = float(b["lo"][2]), float(b["hi"][2])
        mitte = (z_unten + z_oben) / 2.0
        # Über dem Raum des Geschosses, nicht in seinem Fußboden — siehe
        # `MIN_LICHTE_HOEHE_M`.
        if not (z_unten >= boden + _lichte_mindesthoehe(geschoss, obergrenze) - 1e-6
                and mitte <= float(obergrenze) + 0.50):
            continue
        dicke = z_oben - z_unten
        if dicke < mindestdicke or dicke > hoechstdicke:
            continue
        flaeche = ((float(b["hi"][0]) - float(b["lo"][0]))
                   * (float(b["hi"][1]) - float(b["lo"][1])))
        kandidaten.append({
            "global_id": gid, "z_unten": z_unten, "z_oben": z_oben,
            "z_mitte": mitte, "dicke_m": round(dicke, 3),
            "flaeche_m2": flaeche, "name": b.get("name"),
            "lo": [float(v) for v in b["lo"]], "hi": [float(v) for v in b["hi"]],
            "_rang": _tragrang(b),
        })
    if not kandidaten:
        return []

    groesste = max(k["flaeche_m2"] for k in kandidaten)
    behalten = [k for k in kandidaten
                if k["flaeche_m2"] >= mindestflaeche_anteil * groesste]

    # Platten, die einander in xy überdecken und auf gleicher Höhe liegen, sind
    # dasselbe Feld in zwei Lagen (Rohdecke plus Aufbeton, Rohdecke plus
    # Estrich). Von denen bleibt die tragende, unter Gleichrangigen die
    # dickste; zwei Modelle über derselben Fläche zu rechnen hieße, ihre Last
    # zweimal abzutragen.
    behalten.sort(key=lambda k: (k["_rang"], -k["flaeche_m2"], -k["dicke_m"]))
    eigenstaendig: list[dict] = []
    for k in behalten:
        if any(_ueberdeckt(k, v) and abs(k["z_mitte"] - v["z_mitte"]) < 0.35
               for v in eigenstaendig):
            continue
        eigenstaendig.append(k)
    eigenstaendig.sort(key=lambda k: -k["flaeche_m2"])
    for k in eigenstaendig:
        k.pop("_rang", None)
    return eigenstaendig


#: Was als Deckenbalken gilt: liegend, schlank, länger als 1,5 m.
BALKEN_MIN_LAENGE_M = 1.5
BALKEN_HOECHSTHOEHE_M = 0.60
BALKEN_HOECHSTBREITE_M = 0.40
#: Ab so vielen gleichgerichteten Balken auf einer Höhe ist es eine Balkenlage.
BALKENLAGE_MIN_BALKEN = 4


def _wichte_bauteil(b: dict) -> float:
    """Wichte eines Bauteils aus seinem Material, kN/m³ (Holz, wo nichts erkannt)."""
    from .tragend import schichtwichte
    for kandidat in (b.get("material"), *(sch.get("name") for sch in b.get("materialschichten") or [])):
        w = schichtwichte(kandidat)
        if w is not None:
            return w
    return 5.0


def _grundrissmass(b: dict) -> tuple[float, float, float, list[float]]:
    """(Winkel der langen Seite in Grad, Länge, Breite, Mitte) eines Bauteils —
    aus dem Grundrissrechteck, sonst aus der Hüllbox."""
    g = b.get("grundriss")
    if g:
        return (float(g["winkel_grad"]) % 180.0, float(g["laenge_m"]),
                float(g["breite_m"]), [float(g["mitte"][0]), float(g["mitte"][1])])
    lo, hi = b["lo"], b["hi"]
    dx, dy = float(hi[0] - lo[0]), float(hi[1] - lo[1])
    return (0.0 if dx >= dy else 90.0, max(dx, dy), min(dx, dy),
            [(float(lo[0]) + float(hi[0])) / 2.0, (float(lo[1]) + float(hi[1])) / 2.0])


def _grundrissfigur(b: dict):
    """Das Grundrissrechteck eines Bauteils als shapely-Polygon, gedreht, wo
    `section.bauteilform()` es kennt, sonst die Hüllbox."""
    from shapely.affinity import rotate
    from shapely.geometry import box as rechteck

    g = b.get("grundriss")
    if g:
        mx, my = float(g["mitte"][0]), float(g["mitte"][1])
        halb_l, halb_b = float(g["laenge_m"]) / 2.0, float(g["breite_m"]) / 2.0
        return rotate(rechteck(mx - halb_l, my - halb_b, mx + halb_l, my + halb_b),
                      float(g["winkel_grad"]), origin=(mx, my))
    lo, hi = b["lo"], b["hi"]
    return rechteck(float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1]))


def balkenlagen(geschoss: dict, obergrenze: float, boxen: dict,
                ausgeschlossen: set | None = None) -> list[dict]:
    """
    Die Holzbalkendecken über einem Geschoss — als Ersatzplatten.

    **Eine Holzbalkendecke ist keine IfcSlab.** Sie besteht aus Balken (meist
    `IfcBeam`, manchmal `IfcMember`), darauf Dielen oder eine Schalung, oft nur
    die Balken. Bis Oktober 2026 fand die Kette darüber keine Platte, das
    Geschoss wurde übersprungen, und die Last der Decke — Eigengewicht,
    Ausbau, Nutzlast — fehlte ganz (Weihgold LPH 4: drei Decken, 0 kN
    eingetragen, Bilanz „erhalten").

    Erkannt wird eine **Lage**: mindestens `BALKENLAGE_MIN_BALKEN` liegende,
    schlanke, gleichgerichtete Balken mit derselben Oberkante (±5 cm) unter dem
    Boden des Geschosses darüber. Ihr Grundriss ist die Vereinigung der Balken,
    um den halben Balkenabstand geschlossen; jede zusammenhängende Fläche wird
    eine Ersatzplatte. Gerechnet wird sie orthotrop (`plate.werkstofftabelle`):
    steif in Balkenrichtung mit E₀·b/e, weich quer dazu — so geht die Last wie in
    der Decke zu den Auflagern an den Balkenenden, nicht über Kreuz.

    Das Eigengewicht ist das **gemessene**: Volumen × Wichte aller Bauteile in
    der Deckenzone (Balken, Dielen, Füllhölzer, Dämmung), über die Fläche
    verteilt.

    **Auch gedreht.** Richtung, Länge und Breite kommen aus dem
    Grundrissrechteck des Bauteils (`section.bauteilform()`), nicht aus der
    achsparallelen Hüllbox — in der sieht ein Balken unter 33° aus wie ein
    Klotz von 3,8 × 2,5 m. Fehlt das Rechteck, gilt die Hüllbox, und eine
    schräg liegende Lage wird nicht erkannt.
    """
    from shapely.geometry import Point as Punkt
    from shapely.ops import unary_union

    from .tragend import werkstoffklasse

    ausgeschlossen = ausgeschlossen or set()
    boden = float(geschoss["boden"])
    kandidaten = []
    for gid, b in boxen.items():
        if gid in ausgeschlossen or not b.get("hi"):
            continue
        typ = b.get("ifc_type") or ""
        if la.rolle_von(typ) != "unterzug" and not typ.startswith("IfcMember"):
            continue
        lo, hi = b["lo"], b["hi"]
        dz = float(hi[2] - lo[2])
        winkel, laenge, quer, mitte = _grundrissmass(b)
        if (dz > BALKEN_HOECHSTHOEHE_M or dz < 0.06 or laenge < BALKEN_MIN_LAENGE_M
                or quer > BALKEN_HOECHSTBREITE_M or laenge < 4.0 * max(quer, 0.05)):
            continue
        # Bis knapp über die Geschosslinie: eine Lage, die über sie hinausragt
        # (Unterkante höchstens 30 cm darüber), ist trotzdem die Decke dieses
        # Geschosses — darüber ist kein Raum. Bei Lucy liegt die Dachbalkenlage
        # 26 cm über der Linie „Dachaufsicht" und fehlte sonst ganz.
        if not (obergrenze - 0.80 <= float(hi[2]) <= obergrenze + 0.05
                or (float(lo[2]) <= obergrenze + 0.30
                    and float(hi[2]) <= obergrenze + 0.80)):
            continue
        if float(lo[2]) < boden + _lichte_mindesthoehe(geschoss, obergrenze):
            continue
        kandidaten.append({"gid": gid, "lo": lo, "hi": hi, "winkel": winkel,
                           "klasse": int(round(winkel / 2.0)) % 90, "mitte": mitte,
                           "breite": quer, "hoehe": dz, "figur": _grundrissfigur(b)})
    if len(kandidaten) < BALKENLAGE_MIN_BALKEN:
        return []

    # Die Lage: die häufigste Oberkante je Richtung (5-cm-Raster, 2°-Klassen,
    # Nachbarn mit).
    def stufe_von(k):
        return int(round(float(k["hi"][2]) / 0.05))

    def nah(a, b):
        return min((a - b) % 90, (b - a) % 90) <= 1

    zaehler: dict[tuple[int, int], int] = {}
    for k in kandidaten:
        zaehler[(k["klasse"], stufe_von(k))] = zaehler.get((k["klasse"], stufe_von(k)), 0) + 1
    (klasse, stufe), _ = max(
        ((sk, sum(n for (kl, st), n in zaehler.items()
                  if nah(kl, sk[0]) and abs(st - sk[1]) <= 1)) for sk in zaehler),
        key=lambda x: (x[1], -abs(x[0][1] * 0.05 - obergrenze)))
    lage = [k for k in kandidaten if nah(k["klasse"], klasse)
            and abs(stufe_von(k) - stufe) <= 1]
    if len(lage) < BALKENLAGE_MIN_BALKEN:
        return []
    oben = float(np.median([float(k["hi"][2]) for k in lage]))
    unten = float(np.median([float(k["lo"][2]) for k in lage]))
    breite = float(np.median([k["breite"] for k in lage]))
    # Die Richtung der Lage: Mittel der doppelten Winkel (180° periodisch).
    doppelt = np.radians([2.0 * k["winkel"] for k in lage])
    richtung_grad = float(np.degrees(np.arctan2(np.sin(doppelt).sum(),
                                                np.cos(doppelt).sum())) / 2.0) % 180.0
    w = np.radians(richtung_grad)
    normale = np.array([-np.sin(w), np.cos(w)])
    lagen = sorted(float(np.dot(k["mitte"], normale)) for k in lage)
    abstaende = [b - a for a, b in zip(lagen, lagen[1:]) if b - a > 0.05]
    abstand = float(np.median(abstaende)) if abstaende else 0.625
    abstand = min(max(abstand, breite + 0.02), 1.50)

    # **Randbalken und Wechsel gehören dazu.** Quer zur Lage auf derselben
    # Höhe liegen die Balken, an denen die Lage hängt: der Randbalken auf der
    # Wand, ein Wechsel am Treppenloch. In der LPH 4 enden die Deckenbalken
    # 3,4 cm vor der Betonwand an einem solchen Randbalken; ohne ihn endete die
    # Ersatzplatte vor der Wand, und das Lager auf der Wandachse fand sie nicht.
    # Nur, was an die Lage anschließt: ein Vordach auf derselben Höhe drei
    # Meter daneben ist keine Decke (LPH 4: wurde sonst ein eigenes, nur
    # einseitig gelagertes Feld).
    #
    # **Ein Teil der Lage braucht eigene Balken.** Zuerst wird nur aus den
    # Balken der Lage geschlossen; Teile mit weniger als
    # `BALKENLAGE_MIN_BALKEN` Balken fallen weg. Erst an die übrigen schließen
    # Randbalken an. Sonst wird ein einzelner Querträger, der zufällig in
    # Richtung und Höhe passt (der Vordachträger der LPH 4), mit den Sparren
    # daran zu einem eigenen, nur einseitig gelagerten Feld.
    schliessen = abstand / 2.0 + 0.02

    def geschlossen(figuren):
        return (unary_union(figuren).buffer(schliessen, join_style=2)
                .buffer(-schliessen, join_style=2))

    def balken_in(flaeche):
        return sum(1 for k in lage if flaeche.intersects(k["figur"]))

    kern = [t for t in getattr(geschlossen([k["figur"] for k in lage]), "geoms",
                               [geschlossen([k["figur"] for k in lage])])
            if not t.is_empty and balken_in(t) >= BALKENLAGE_MIN_BALKEN]
    if not kern:
        return []
    kern_nah = unary_union(kern).buffer(schliessen)
    gids_lage_k = {k["gid"] for k in lage}
    # Randbalken und Wechsel sind oft kurz — ein Wechsel am Treppenloch misst
    # so viel wie das Loch breit ist (LPH 4: 1,07 m). Für sie gilt deshalb
    # nicht die Mindestlänge der Lage, nur: liegend, schlank, auf ihrer Höhe.
    randbalken = []
    for gid, b in boxen.items():
        if gid in gids_lage_k or gid in ausgeschlossen or not b.get("hi"):
            continue
        typ = b.get("ifc_type") or ""
        if la.rolle_von(typ) != "unterzug" and not typ.startswith("IfcMember"):
            continue
        if abs(float(b["hi"][2]) - oben) > 0.05 or float(b["lo"][2]) < unten - 0.10:
            continue
        _, laenge_r, quer_r, _ = _grundrissmass(b)
        if laenge_r < 0.30 or quer_r > BALKEN_HOECHSTBREITE_M or laenge_r < 2.0 * max(quer_r, 0.05):
            continue
        figur = _grundrissfigur(b)
        if figur.intersects(kern_nah):
            randbalken.append({"gid": gid, "figur": figur})
    fuss = geschlossen(kern + [k["figur"] for k in randbalken])

    # **Die Decke reicht bis an die Wand, nicht bis zum letzten Balken.**
    # Zwischen Randbalken und paralleler Wand liegt Dielung, und die Wand
    # darunter trägt diesen Streifen — samt einer Wand darüber, die auf ihr
    # steht (Prüfhaus H5: Giebelwände 0,4 m neben dem letzten Balken).
    #
    # **Aber nur bis an ein Lager.** Für jede Wand und Stütze darunter, die
    # höchstens e/2 + 0,6 m neben der Lage steht, kommt der Streifen zwischen
    # Lage und Lager dazu — nicht mehr. Die erste Fassung weitete pauschal um
    # dieses Maß und beschnitt auf die Hülle aller Wände und Stützen des
    # Geschosses; in der LPH 4 gehörten dazu die Pfosten der
    # Terrassenüberdachung, und die Decke kragte 0,85 m frei über den
    # Randbalken hinaus (11 mm Durchbiegung am freien Rand). Ohne Lager in
    # Reichweite endet die Platte am äußeren Balken.
    from shapely.affinity import translate
    from shapely.ops import nearest_points
    weite = abstand / 2.0 + 0.60
    # Der Bereich quer neben der Lage — gewischt, nicht kopiert: fünf Kopien
    # vervielfältigten jeden Zahn des Umrisses zu einem Kamm. Ein Streifen zum
    # Lager darf nicht darüber hinaus, sonst zöge eine lange Mauer neben dem
    # Haus die Decke bis an ihr Ende (LPH 4: Stützmauer, 8 m Streifen).
    schritte = max(2, int(np.ceil(weite / 0.05)))
    neben = unary_union([translate(fuss, float(normale[0] * t), float(normale[1] * t))
                         for t in np.linspace(-weite, weite, 2 * schritte + 1)])
    traeger = [_grundrissfigur(b)
               for b in boxen.values()
               if b.get("hi") and la.rolle_von(b.get("ifc_type") or "") in ("wand", "stuetze")
               and float(b["lo"][2]) < unten and float(b["hi"][2]) > boden + 0.5]
    streifen = []
    for figur in traeger:
        abstand_f = float(figur.distance(fuss))
        if abstand_f <= 1e-6 or abstand_f > weite:
            continue
        # Richtung zur Lage, quer zu den Balken: der Streifen wird nur dort
        # gezogen, wo das Lager seitlich neben der Lage steht, nicht vor
        # ihren Enden.
        an_der_lage, am_lager = nearest_points(fuss, figur)
        vom_lager = np.array([an_der_lage.x - am_lager.x, an_der_lage.y - am_lager.y])
        if abs(float(np.dot(vom_lager, normale))) < 0.7 * float(np.hypot(*vom_lager)):
            continue
        richtung = np.sign(float(np.dot(vom_lager, normale))) * normale
        d = abstand_f + 0.05
        streifen.append(unary_union([figur, translate(figur, float(richtung[0] * d),
                                                      float(richtung[1] * d))])
                        .convex_hull.intersection(neben))
    if streifen:
        fuss = geschlossen([fuss, *streifen])
    # **Keine Streifen von Balkenbreite.** Ein Randbalken, der über eine Lücke
    # hinausläuft (Lucy: Dachmodule im Schachbrett), wäre als Ersatzplatte ein
    # Band von 12 cm, das längs weich ist — es hing frei und gab 1,6 m nach.
    # Schmaler als 0,3 m ist keine Decke.
    fuss = fuss.buffer(-0.15, join_style=2).buffer(0.15, join_style=2)
    teile = [t for t in getattr(fuss, "geoms", [fuss])
             if not t.is_empty and t.area >= 4.0 and balken_in(t) >= BALKENLAGE_MIN_BALKEN]

    # **Zonen mit eigener Balkenrichtung.** Stichbalken einer Auskragung,
    # die Balken eines Wechselfelds: mindestens drei gleichgerichtete Balken
    # quer zur Lage tragen in *ihrer* Richtung. Die Ersatzplatte hat nur eine;
    # dort trug die Auskragung der LPH 4 (13 Stichbalken, 0,7 m) über die weiche
    # Querrichtung und gab am Rand 11 mm nach. `plate.werkstofftabelle()`
    # dreht den Werkstoff in diesen Zonen.
    zonen = []
    gruppen: dict[int, list] = {}
    for k in randbalken:
        winkel_k, *_ = _grundrissmass(boxen[k["gid"]])
        gruppen.setdefault(int(round(winkel_k / 2.0)) % 90, []).append((winkel_k, k))
    for klasse_z, glieder in sorted(gruppen.items()):
        nachbarn = [g for kl, gl in gruppen.items() if min((kl - klasse_z) % 90,
                                                           (klasse_z - kl) % 90) <= 1
                    for g in gl]
        if len(nachbarn) < 3 or klasse_z != min(kl for kl in gruppen
                                                  if min((kl - klasse_z) % 90,
                                                         (klasse_z - kl) % 90) <= 1):
            continue
        doppelt_z = np.radians([2.0 * w for w, _ in nachbarn])
        richtung_z = float(np.degrees(np.arctan2(np.sin(doppelt_z).sum(),
                                                 np.cos(doppelt_z).sum())) / 2.0) % 180.0
        wz = np.radians(richtung_z)
        normale_z = np.array([-np.sin(wz), np.cos(wz)])
        lagen_z = sorted(float(np.dot(_grundrissmass(boxen[k["gid"]])[3], normale_z))
                         for _, k in nachbarn)
        luecken = [b - a for a, b in zip(lagen_z, lagen_z[1:]) if b - a > 0.05]
        if not luecken or float(np.median(luecken)) > 1.5:
            continue
        halb_z = float(np.median(luecken)) / 2.0 + 0.02
        # Nur außerhalb des Kerns: wo die Lage eigene Balken hat, trägt sie.
        # Ein Randbalken quer zur Lage über dem Lager ist keine Zone — als
        # Streifen mit gedrehtem Werkstoff schnitte er die Hauptbalken von
        # ihrem Lager ab (LPH 4: 43 mm).
        flaeche_z = (unary_union([k["figur"] for _, k in nachbarn])
                     .buffer(halb_z, join_style=2).buffer(-halb_z, join_style=2)
                     .difference(unary_union(kern))
                     # Schmaler als 0,3 m ist kein Feld, sondern ein einzelner
                     # Randbalken neben dem Kern.
                     .buffer(-0.15, join_style=2).buffer(0.15, join_style=2))
        for stueck in getattr(flaeche_z, "geoms", [flaeche_z]):
            if stueck.is_empty or stueck.area < 0.5:
                continue
            if sum(1 for _, k in nachbarn if stueck.intersects(k["figur"])) < 3:
                continue
            zonen.append((stueck, richtung_z))
    gids_lage = {k["gid"] for k in lage + randbalken}

    platten = []
    for n, teil in enumerate(sorted(teile, key=lambda t: -t.area)):
        teil = teil.simplify(0.02)
        if teil.is_empty or teil.geom_type != "Polygon":
            continue
        rand = teil.buffer(0.05)
        # Was in der Deckenzone liegt: die Balken selbst, Dielen und Schalung
        # bis unter den Boden darüber, Füllhölzer, Dämmung zwischen den Balken.
        # Die Zone endet über der Lage, nicht an der Geschosslinie: eine Lage,
        # die über die Linie hinausragt (Lucy, 26 cm), wog sonst nichts — ihre
        # eigenen Balken fielen aus der Wägung, und kein Konto fing sie auf.
        zone_oben = max(float(obergrenze), oben) + 0.05
        z_oben, gewicht, aufbau, elemente = oben, 0.0, 0.0, []
        for gid, b in boxen.items():
            if not b.get("hi"):
                continue
            lo, hi = b["lo"], b["hi"]
            if gid not in gids_lage and (float(lo[2]) < unten - 0.02
                                         or float(hi[2]) > zone_oben):
                continue
            mitte = ((float(lo[0]) + float(hi[0])) / 2.0, (float(lo[1]) + float(hi[1])) / 2.0)
            if not rand.contains(Punkt(mitte)):
                continue
            typ = b.get("ifc_type") or ""
            if gid not in gids_lage and la.rolle_von(typ) in ("wand", "stuetze"):
                continue
            volumen = float(b.get("volumen_m3") or 0.0) or float(np.prod(np.asarray(hi) - np.asarray(lo)))
            # Holz ist die Decke selbst, alles andere ihr Aufbau (Estrich,
            # Trittschall, Dämmung) — der tritt an die Stelle der Annahme.
            klasse = werkstoffklasse(b.get("material"), b.get("materialschichten"))
            if gid in gids_lage or klasse in (None, "holz"):
                gewicht += volumen * _wichte_bauteil(b)
            else:
                aufbau += volumen * _wichte_bauteil(b)
            elemente.append(gid)
            z_oben = max(z_oben, float(hi[2]))
        x0, y0, x1, y1 = teil.bounds
        platten.append({
            "global_id": f"balkenlage:{geschoss['name']}:{n + 1}",
            "name": (f"Balkenlage über {geschoss['name']}"
                     + (f" ({n + 1})" if len(teile) > 1 else "")),
            "z_unten": unten, "z_oben": z_oben, "z_mitte": (unten + oben) / 2.0,
            "dicke_m": round(oben - unten, 4),
            "lo": [x0, y0, unten], "hi": [x1, y1, z_oben],
            "flaeche_m2": round(teil.area, 3),
            "virtuell": True,
            "umriss": [list(map(float, q)) for q in teil.exterior.coords[:-1]],
            "loecher": [[list(map(float, q)) for q in r.coords[:-1]] for r in teil.interiors],
            "balkenlage": {
                "richtung_grad": round(richtung_grad, 3),
                "abstand_m": round(abstand, 3), "breite_m": round(breite, 3),
                "hoehe_m": round(oben - unten, 3),
                "balken": sum(1 for k in lage if teil.buffer(0.05).intersects(k["figur"])),
                "werkstoff": next((boxen[k["gid"]].get("material") for k in lage
                                   if boxen[k["gid"]].get("material")), None),
                "eigengewicht_kNm2": round(gewicht / teil.area, 3) if teil.area > 0 else 0.0,
                "aufbau_kNm2": round(aufbau / teil.area, 3) if teil.area > 0 and aufbau else None,
                "elemente": elemente,
                "zonen": [{"umriss": [[round(float(x), 4), round(float(y), 4)]
                                      for x, y in z.exterior.coords[:-1]],
                           "richtung_grad": round(r, 3)}
                          for zone, r in zonen
                          for z in getattr(zone.intersection(teil), "geoms",
                                           [zone.intersection(teil)])
                          if z.geom_type == "Polygon" and z.area >= 0.5],
            },
        })
    return platten


def ersatzplatte_werkstoff(balkenlage: dict, dicke: float) -> dict:
    """
    Der orthotrope Werkstoff einer Balkenlage als Ersatzplatte der Dicke h.

    Längs E₀·b/e und G·b/e (die Biegesteifigkeit je Meter einer Lage aus Balken
    b/h im Abstand e ist E₀·b·h³/12/e — genau die einer Platte h mit E₀·b/e);
    quer ein Fünfzigstel davon, Rollschub und Drillung ein Zehntel. Die Wichte
    ist das gemessene Eigengewicht geteilt durch h.

    **Senkrecht steif.** Die Lasten von oben greifen an der Oberseite an, die
    Lager an der Unterseite. Mit der Quersteifigkeit auch durch die Dicke gab
    die Platte über dem Auflager unter einer Wand von oben 18 mm nach — eine
    Querpressung, die es in der Balkenlage so nicht gibt (Prüfhaus H5).
    """
    from .werkstoff import WERKSTOFFE
    name = str(balkenlage.get("werkstoff") or "")
    holz = next((w for k, w in WERKSTOFFE.items()
                 if w.familie == "holz" and k.lower() in name.lower()), WERKSTOFFE["C24"])
    anteil = min(1.0, max(0.02, balkenlage["breite_m"] / max(balkenlage["abstand_m"], 1e-6)))
    E_l = holz.E_1 * anteil
    G_l = holz.G_13 * anteil
    return {"name": f"Holzbalkendecke {holz.name}, b/e = {anteil:.2f} (Ersatzplatte)",
            "familie": "holz", "E_kNm2": E_l, "nu": 0.05,
            "wichte_kNm3": float(balkenlage["eigengewicht_kNm2"]) / max(dicke, 1e-6),
            "orthotrop": {"E_l": E_l, "E_q": E_l / 50.0, "E_z": E_l,
                          "G_lz": G_l, "G_qz": G_l / 10.0,
                          "G_lq": G_l / 10.0, "nu": 0.05,
                          "richtung_grad": float(balkenlage["richtung_grad"]),
                          **({"zonen": balkenlage["zonen"]} if balkenlage.get("zonen") else {})}}


def ersatzplatte_figur(platte: dict) -> dict:
    """Eine virtuelle Platte als Schnittfigur — dieselbe Form wie aus `section.cut()`."""
    return {"global_id": platte["global_id"], "ifc_type": "IfcSlab",
            "name": platte.get("name"), "kind": "schnitt",
            "material": (platte.get("balkenlage") or {}).get("werkstoff"),
            "rings": [platte["umriss"], *platte.get("loecher", [])]}


def decken_zuordnen(geschosse: list, boxen: dict) -> dict[str, list[dict]]:
    """
    Jede Deckenplatte genau einem Geschoss — dem, über dem sie liegt.

    Je Geschoss für sich gesucht, kann dieselbe Platte zweimal gefunden werden:
    bei zwei Geschossen auf fast derselben Höhe (ein Zwischengeschoss, eine
    doppelt geführte Ebene), deren Fenster sich überlappen. Sie würde dann
    zweimal gerechnet und ihre Last zweimal abgetragen. Gesucht wird deshalb
    von oben nach unten, und was ein höheres Geschoss schon hat, ist vergeben.
    """
    zuordnung: dict[str, list[dict]] = {}
    vergeben: set[str] = set()
    for g in sorted(geschosse, key=lambda x: float(x["boden"]), reverse=True):
        platten = [p for p in deckenplatten(g, g["decke"], boxen)
                   if p["global_id"] not in vergeben]
        # Holzbalkendecken — auch neben Plattendecken: ein Haus mit Balkendach
        # und ein Carport mit Betondach im selben Geschoss (Lucy). Was eine
        # Platte schon überdeckt, ist keine eigene Decke.
        for lage in balkenlagen(g, float(g["decke"]), boxen, ausgeschlossen=vergeben):
            if any(_ueberdeckt_anteil(lage, p) >= 0.25 for p in platten):
                continue
            platten.append(lage)
            vergeben.update(lage["balkenlage"]["elemente"])
        vergeben.update(p["global_id"] for p in platten)
        zuordnung[g["name"]] = platten
    return zuordnung


#: Vorschlagswert für den Bettungsmodul, kN/m³. 20 MN/m³ entspricht einem
#: mitteldicht gelagerten Sand oder Kies — dem Regelfall im Hochbau. Die
#: Spanne reicht von 5 MN/m³ (weicher Ton) bis über 100 MN/m³ (Fels); wer den
#: Baugrund kennt, setzt seinen Wert ein.
#:
#: **Der Wert ist eine Annahme, keine Messung.** Er steht als solche im
#: Bericht. Eine Bodenplatte reagiert auf ihn deutlich: die Sohlspannung folgt
#: der Bettung fast linear, die Biegemomente dagegen kaum — was hier vor allem
#: falsch werden kann, ist die Verteilung, nicht die Summe.
BETTUNG_VORSCHLAG_KNM3 = 20000.0


def bodenplatte(geschosse: list, boxen: dict,
                mindestdicke: float = 0.10,
                ausgeschlossen: set | None = None) -> list[dict]:
    """
    Die Bodenplatten unter dem untersten Geschoss.

    **Warum sie nicht über `deckenplatten()` läuft.** Die sucht *über* einem
    Geschoss und braucht ein Geschoss darüber, an dessen Boden sie sich
    orientiert. Unter dem untersten gibt es keines; die Bodenplatte liegt am
    oder unter dem Fußboden des Kellers, und ihre Obergrenze ist genau die
    Höhe, ab der die Suche der Decken beginnt.

    **Erkannt wird sie an drei Dingen**, in dieser Reihenfolge:

    1. `rolle_von()` liefert `fundament` — das ist der Fall, wenn im Modell
       `PredefinedType = BASESLAB` steht oder der Name es sagt. Die
       verlässlichste Angabe.
    2. Sonst: eine Slab, deren Mitte unterhalb des untersten Geschossbodens
       liegt. Eine Bodenplatte ist die einzige Platte dort unten.
    3. Dicke und Fläche wie bei den Decken — ein 5-cm-Element ist eine
       Sauberkeitsschicht, kein Fundament.

    @returns Liste wie `deckenplatten()`; leer, wenn keine gefunden wurde
    """
    if not geschosse:
        return []
    ausgeschlossen = ausgeschlossen or set()
    # **Das unterste Geschoss mit Raum**, nicht das unterste überhaupt. Ein
    # Geschoss „Fundament" auf der Unterkante der Sohle hat keine Höhe; vom
    # Boden des nächsten aus gemessen liegt die Bodenplatte mit ihrer Mitte
    # einen halben Plattendicke darunter, wie es sein soll. Gemessen vom
    # „Fundament" aus läge sie darüber und fiele heraus.
    boeden = sorted(float(g["boden"]) for g in geschosse)
    unterstes = boeden[0]
    for unten, oben in zip(boeden, boeden[1:]):
        if oben - unten >= MIN_LICHTE_HOEHE_M:
            break
        unterstes = oben
    kandidaten = []
    for gid, b in boxen.items():
        if gid in ausgeschlossen:
            continue
        rolle = la.rolle_von(b.get("ifc_type"), None, b.get("name"))
        if rolle not in ("decke", "fundament"):
            continue
        z_unten, z_oben = float(b["lo"][2]), float(b["hi"][2])
        mitte = (z_unten + z_oben) / 2.0
        # Ausdrücklich als Fundament geführt, oder unterhalb des untersten
        # Geschossbodens. Die halbe Toleranz nach oben deckt den Fall ab, dass
        # die Bodenplatte bündig mit dem Fußboden liegt.
        if rolle != "fundament" and mitte > unterstes + 0.05:
            continue
        dicke = z_oben - z_unten
        if dicke < mindestdicke:
            continue
        kandidaten.append({
            "global_id": gid, "z_unten": z_unten, "z_oben": z_oben,
            "z_mitte": mitte, "dicke_m": round(dicke, 3),
            "flaeche_m2": ((float(b["hi"][0]) - float(b["lo"][0]))
                           * (float(b["hi"][1]) - float(b["lo"][1]))),
            "name": b.get("name"),
            "lo": [float(v) for v in b["lo"]], "hi": [float(v) for v in b["hi"]],
            "_fundament": (b.get("ifc_type") or "").startswith("IfcFooting"),
        })
    if not kandidaten:
        return []

    # Klein heißt hier nicht unwichtig: ein Einzel- oder Streifenfundament
    # (`IfcFooting`) ist so groß, wie es sein muss, und trägt die Wand darüber.
    # Die Flächenschwelle gilt nur für Platten (VA3: drei Wandfundamente von
    # 1,4–4 m² neben einer Bodenplatte von 330 m² fielen heraus, ihre Wände
    # standen danach „auf dem Gelände ohne Fundament").
    groesste = max(k["flaeche_m2"] for k in kandidaten)
    behalten = [k for k in kandidaten
                if k.pop("_fundament") or k["flaeche_m2"] >= 0.15 * groesste]
    behalten.sort(key=lambda k: (-k["flaeche_m2"], -k["dicke_m"]))
    eigenstaendig: list[dict] = []
    for k in behalten:
        if any(_ueberdeckt(k, v) and abs(k["z_mitte"] - v["z_mitte"]) < 0.35
               for v in eigenstaendig):
            continue
        eigenstaendig.append(k)
    return eigenstaendig


def _ueberdeckt(a: dict, b: dict, anteil: float = 0.6) -> bool:
    """Überlappen sich zwei Hüllboxen in xy zu mehr als `anteil` der kleineren?"""
    breite = max(0.0, min(a["hi"][0], b["hi"][0]) - max(a["lo"][0], b["lo"][0]))
    tiefe = max(0.0, min(a["hi"][1], b["hi"][1]) - max(a["lo"][1], b["lo"][1]))
    schnitt = breite * tiefe
    kleiner = min((a["hi"][0] - a["lo"][0]) * (a["hi"][1] - a["lo"][1]),
                  (b["hi"][0] - b["lo"][0]) * (b["hi"][1] - b["lo"][1]))
    return kleiner > 1e-9 and schnitt / kleiner >= anteil


def hoehengruppen(platten: list[dict], toleranz: float = 0.15) -> list[list[dict]]:
    """
    Platten nach Schnitthöhe gruppieren — je Gruppe genügt ein Schnitt.

    Die Platten eines Geschosses liegen fast immer auf derselben Höhe; dann ist
    es eine Gruppe und ein Schnitt. Ein Split-Level oder eine abgesenkte
    Terrasse ergibt eine zweite.
    """
    gruppen: list[list[dict]] = []
    for platte in sorted(platten, key=lambda p: p["z_mitte"]):
        passend = next((g for g in gruppen
                        if abs(g[0]["z_mitte"] - platte["z_mitte"]) <= toleranz), None)
        if passend is not None:
            passend.append(platte)
        else:
            gruppen.append([platte])
    return gruppen


def _kronenschnitt(zugang, box: dict, gruppe: list[dict]) -> dict | None:
    """
    Ein Schnitt knapp unter den Platten einer Höhengruppe — die Wandkronen.

    **Die Decke liegt auf der Wandkrone, nicht in Brüstungshöhe.** Die Wände
    werden für Querschnitt und Nachweis bei 0,4–1,2 m über dem Boden
    geschnitten; dort hat jede Wand an jedem Fenster eine Lücke. Als Lager
    genommen, lag die Decke über jedem Fenster frei (SampleHouse: drei Fenster
    von 1,9 m in der Nordwand, drei Lücken im Lager), obwohl dort der Sturz
    trägt. 4 cm unter der Platte ist die Wand über einem Fenster geschlossen,
    über einer raumhohen Öffnung nicht — wie im Bauwerk.
    """
    z_u = min(float(p["z_unten"]) for p in gruppe)
    try:
        return zugang.schnitt(box, "grundriss", (z_u - 0.04) - box["z_unten"])
    except Exception:  # noqa: BLE001
        return None


def _unterzug_schnitt(zugang, box: dict, gruppe: list[dict],
                      krone: dict | None = None) -> dict | None:
    """
    Ein Schnitt knapp unter den Platten einer Höhengruppe — die Stege der Unterzüge.

    Nur, wenn dort überhaupt ein Balken hängt (Hüllbox mit Oberkante an der
    Platte und Unterkante darunter, im Grundriss der Gruppe). Es ist derselbe
    Schnitt wie `_kronenschnitt()`; liegt der schon vor, wird er genommen.
    """
    z_u = min(float(p["z_unten"]) for p in gruppe)
    z_o = max(float(p["z_oben"]) for p in gruppe)
    lo_g = [min(float(p["lo"][0]) for p in gruppe if p.get("lo")) - 1.0,
            min(float(p["lo"][1]) for p in gruppe if p.get("lo")) - 1.0] \
        if all(p.get("lo") for p in gruppe) else None
    hi_g = [max(float(p["hi"][0]) for p in gruppe) + 1.0,
            max(float(p["hi"][1]) for p in gruppe) + 1.0] if lo_g else None
    gefunden = False
    for b in zugang.boxen.values():
        if la.rolle_von(b.get("ifc_type") or "") != "unterzug" or not b.get("hi"):
            continue
        oben, unten = float(b["hi"][2]), float(b["lo"][2])
        if not (z_u - 0.25 <= oben <= z_o + 0.05 and unten < z_u - 0.05):
            continue
        if lo_g and (float(b["hi"][0]) < lo_g[0] or float(b["lo"][0]) > hi_g[0]
                     or float(b["hi"][1]) < lo_g[1] or float(b["lo"][1]) > hi_g[1]):
            continue
        gefunden = True
        break
    if not gefunden:
        return None
    if krone is not None:
        return krone
    return zugang.schnitt(box, "grundriss", (z_u - 0.04) - box["z_unten"])


def _in_box(punkt, lo, hi, zugabe: float = 1.0) -> bool:
    """Liegt ein xy-Punkt in der aufgeweiteten Grundfläche einer Platte?"""
    return (lo[0] - zugabe <= punkt[0] <= hi[0] + zugabe
            and lo[1] - zugabe <= punkt[1] <= hi[1] + zugabe)


def _ringmitte(ringe) -> list[float] | None:
    """Mittel der Punkte des ersten Rings — genügt für „liegt über welcher Platte"."""
    ring = next((r for r in (ringe or []) if r and len(r) >= 3), None)
    if ring is None:
        return None
    return [sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)]


#: Wie weit eine Last neben einer Platte liegen darf und trotzdem auf ihr
#: steht. Eine Außenwand, deren Achse eine halbe Wanddicke vor der
#: Deckenkante liegt (Decke bis Innenkante Wand modelliert), steht auf der
#: Deckenkante; eine Wand zwei Meter daneben steht woanders.
LASTFANG_M = 0.50


def _polylinie_aufteilen(punkte, ziel, schritt: float = 0.10) -> list:
    """
    Einen Streckenzug in Stücke teilen, je nachdem, über welcher Platte er liegt.

    In Schritten von `schritt` entlang der Linie; aufeinanderfolgende Stücke
    mit demselben Ziel werden wieder ein Zug. Eckpunkte bleiben erhalten.

    @param ziel  (x, y) → GlobalId der Platte oder None
    @returns [(GlobalId|None, [[x, y], …]), …]
    """
    stuecke: list = []
    for i in range(len(punkte) - 1):
        a, b = punkte[i], punkte[i + 1]
        laenge = math.hypot(b[0] - a[0], b[1] - a[1])
        if laenge < 1e-9:
            continue
        n = max(1, math.ceil(laenge / schritt))
        for k in range(n):
            t0, t1 = k / n, (k + 1) / n
            p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]
            p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]
            gid = ziel((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
            if stuecke and stuecke[-1][0] == gid:
                zug = stuecke[-1][1]
                if k > 0:
                    zug[-1] = p1          # auf derselben Strecke weiter
                else:
                    zug.append(p1)        # neue Strecke: die Ecke bleibt
            else:
                stuecke.append([gid, [p0, p1]])
    return [(g, [[round(x, 4), round(y, 4)] for x, y in zug]) for g, zug in stuecke]


def plattenpolygon(decke: dict, gid: str, platte: dict | None = None):
    """Die Systemfläche einer Platte aus dem Schnitt, mit Löchern — als shapely-Polygon."""
    from shapely.geometry import Polygon, box
    fig = next((f for f in decke.get("figures", [])
                if f.get("global_id") == gid and f.get("kind") == "schnitt"
                and f.get("rings")), None)
    if fig is not None:
        gruppen = tm.ringgruppen(fig["rings"])
        if gruppen:
            g = max(gruppen, key=lambda x: x["flaeche_m2"])
            try:
                p = Polygon(g["ringe"][0], [r for r in g["ringe"][1:] if len(r) >= 3])
                return p if p.is_valid else p.buffer(0)
            except Exception:  # noqa: BLE001
                pass
    if platte is not None:
        return box(platte["lo"][0], platte["lo"][1], platte["hi"][0], platte["hi"][1])
    return None


def lasten_verteilen(lasten: list[dict], platten: list[dict],
                     polygone: dict | None = None,
                     toleranz: float = LASTFANG_M) -> tuple[dict, list]:
    """
    Die Lasten aus dem Geschoss darüber auf die Platten dieses Geschosses.

    Zugeordnet wird über die Lage: eine Wandfußkraft gehört auf die Platte, über
    der die Wand steht. Ohne diese Zuordnung bekäme jede Platte alle Lasten, und
    `plate._anteile()` verwürfe die ortsfremden stillschweigend — genau der
    Weg, auf dem der Lastabtrag zuvor 79 % verlor.

    **Mit Plattenumrissen** (`polygone`, GlobalId → shapely-Polygon) wird
    stückweise entschieden: eine Linienlast über zwei Deckenfeldern wird an
    der Fuge geteilt, ein Stück knapp neben einer Platte (bis `toleranz`) an
    ihren Rand gezogen. Die erste Fassung nahm für die ganze Last „die
    kleinste Platte, deren Hüllbox plus 1 m die Lastmitte enthält" — am EFH
    Weihgold landeten so die Stützen der Westhälfte auf der Ostplatte, fielen
    dort aus dem Netz, und ein Drittel der Last von oben war fort.

    Was auf keine Platte fällt, geht **nicht** verloren, sondern kommt als
    zweiter Rückgabewert zurück. Solche Lasten stehen auf Wänden, die im
    Geschoss darunter ohne Decke weiterlaufen — sie werden durchgereicht und in
    der Bilanz ausgewiesen.

    @returns (global_id → Lastliste, nicht zuordenbare Lasten)
    """
    if polygone:
        return _lasten_nach_umriss(lasten, platten, polygone, toleranz)
    zuordnung: dict[str, list[dict]] = {p["global_id"]: [] for p in platten}
    uebrig: list[dict] = []
    for last in lasten:
        if "polylinie" in last:
            punkte = last["polylinie"]
            mitte = [sum(p[0] for p in punkte) / len(punkte),
                     sum(p[1] for p in punkte) / len(punkte)]
        else:
            mitte = last["p"]
        treffer = [p for p in platten if _in_box(mitte, p["lo"], p["hi"])]
        if not treffer:
            uebrig.append(last)
            continue
        # Bei Überschneidung die kleinere Platte: sie ist die spezifischere.
        ziel = min(treffer, key=lambda p: p["flaeche_m2"])
        zuordnung[ziel["global_id"]].append(last)
    return zuordnung, uebrig


def _lasten_nach_umriss(lasten, platten, polygone, toleranz):
    """Der Weg von `lasten_verteilen()` mit Plattenumrissen."""
    from shapely.geometry import Point
    from shapely.ops import nearest_points
    from shapely.prepared import prep

    zuordnung: dict[str, list[dict]] = {p["global_id"]: [] for p in platten}
    uebrig: list[dict] = []
    flaechen = [(p["global_id"], polygone.get(p["global_id"])) for p in platten]
    flaechen = [(gid, poly) for gid, poly in flaechen
                if poly is not None and not poly.is_empty]
    vorbereitet = {gid: prep(poly) for gid, poly in flaechen}
    # Zwei Zentimeter nach innen: eine Last genau auf dem Rand liegt sonst je
    # nach Rundung drinnen oder draußen.
    innen = {}
    for gid, poly in flaechen:
        kern = poly.buffer(-0.02)
        innen[gid] = kern if not kern.is_empty else poly

    def ziel(x, y):
        pt = Point(x, y)
        bester, abstand = None, None
        for gid, poly in flaechen:
            if vorbereitet[gid].covers(pt):
                return gid
            d = poly.distance(pt)
            if d <= toleranz and (abstand is None or d < abstand):
                bester, abstand = gid, d
        return bester

    def einruecken(gid, p):
        pt = Point(p[0], p[1])
        if innen[gid].covers(pt):
            return [p[0], p[1]]
        q = nearest_points(innen[gid], pt)[0]
        return [round(q.x, 4), round(q.y, 4)]

    for last in lasten:
        if "polylinie" in last:
            for gid, zug in _polylinie_aufteilen(last["polylinie"], ziel):
                if len(zug) < 2:
                    continue
                if gid is None:
                    uebrig.append({**last, "polylinie": zug})
                    continue
                vorher = _laenge(zug)
                zug = [einruecken(gid, p) for p in zug]
                nachher = _laenge(zug)
                if nachher < 1e-6:
                    # Ganz auf einen Punkt gezogen: als Einzellast weiter,
                    # mit der Kraft des ganzen Stücks.
                    zuordnung[gid].append({k: v for k, v in last.items() if k != "polylinie"}
                                          | {"typ": "punkt", "p": zug[0],
                                             "wert": float(last["wert"]) * vorher})
                    continue
                # **Die Resultierende bleibt.** Schräg über den Rand ragende
                # Stücke werden beim Einrücken kürzer; je Meter muss dann
                # entsprechend mehr stehen.
                wert = float(last["wert"]) * (vorher / nachher)
                zuordnung[gid].append({**last, "polylinie": zug, "wert": wert})
        else:
            gid = ziel(*last["p"][:2])
            if gid is None:
                uebrig.append(last)
            else:
                zuordnung[gid].append({**last, "p": einruecken(gid, last["p"])})
    return zuordnung, uebrig


#: Relative Abweichung der Gleichgewichtsprobe, ab der ein Feld als nicht
#: gerechnet gilt. Ein gesundes System liegt bei 10⁻¹², ein kinematisches bei
#: 10⁻¹ und darüber.
PROBE_GRENZE = 1e-3

#: Zugabe zur halben tragenden Breite, innerhalb der eine Last von oben als
#: „steht auf dem Lager" gilt — für die Rundung der Achsen, nicht mehr.
DURCHLEITUNG_ZUGABE_M = 0.02
#: Reststücke einer Linienlast unter dieser Länge gehen mit in das Lager, an
#: dessen Rand sie hängen: drei Zentimeter neben der Lagerfläche sind das
#: Wandende, kein Stück Decke.
DURCHLEITUNG_STUMMEL_M = 0.05


def halbbreiten(wandprotokoll: list[dict]) -> dict[str, float]:
    """
    GlobalId → halbe tragende Breite: Wand ½·t der tragenden Schicht, Stütze
    ½·√A. Grundlage von `durchleiten()`.
    """
    breiten: dict[str, float] = {}
    for w in wandprotokoll or []:
        gid = w.get("global_id")
        if not gid:
            continue
        if w.get("rolle") == "stuetze":
            flaeche = float(w.get("flaeche_m2") or 0.0)
            breiten[gid] = 0.5 * math.sqrt(flaeche) if flaeche > 0 else 0.0
        else:
            breiten[gid] = 0.5 * float(w.get("dicke_tragend_m") or w.get("dicke_gesamt_m") or 0.0)
    return breiten


def _linienstuecke(geometrie) -> list:
    """Die LineStrings einer shapely-Geometrie, in fester Reihenfolge."""
    if geometrie is None or geometrie.is_empty:
        return []
    if geometrie.geom_type == "LineString":
        return [geometrie]
    teile = []
    for g in getattr(geometrie, "geoms", []):
        teile.extend(_linienstuecke(g))
    return teile


def _zug(linie) -> list[list[float]]:
    return [[round(float(x), 4), round(float(y), 4)] for x, y, *_ in linie.coords]


def durchleiten(modell: dict, breiten: dict[str, float]) -> list[dict]:
    """
    Lasten von oben, die auf einem Lager stehen, gehen direkt hinein.

    Eine Wand des Obergeschosses, die auf der Wand darunter steht, gibt ihre
    Last durch die Deckendicke in diese Wand — die Decke biegt sich dabei
    nicht. Im Netz kam sie bis Oktober 2026 trotzdem als Flächenlast auf einen
    Elementstreifen (`plate._anteile()`, Suchradius 0,6 Δ), dessen Knoten bis
    zu einer Netzweite neben den Lagerknoten liegen; was dort ankam, musste die
    Platte zum Lager tragen. Bei Stahlbeton gibt das kleine Fehler nahe am
    Lager. Bei einer Holzbalkendecke gibt es große: parallel zu den Balken hat
    die Ersatzplatte quer fast keine Steifigkeit (E_q = E_l/50), und die
    Giebelwand des OG bog die Decke über dem Giebel des EG um 18 mm durch
    (Prüfhaus H5, Lastfall ABG). Die Flächenlasten trafen die Balkentheorie
    dagegen auf 0,2 %.

    **Entschieden wird geometrisch.** Was von einer Linienlast innerhalb der
    tragenden Breite eines Lagers liegt (halbe Dicke der tragenden Schicht plus
    `DURCHLEITUNG_ZUGABE_M`, ohne Überstand über die Wandenden), geht als Kraft
    in dieses Lager. Der Rest bleibt Linienlast auf der Platte: der Teil über
    einer Tür, eine versetzte Wand, eine Abfangung. Einzellasten genauso, über
    dem Querschnitt einer Stütze oder auf einer Wand.

    **Nach den Eingriffen.** Die Kette ruft das auf, nachdem die Eingriffe am
    System gewirkt haben. Ein entferntes Lager nimmt also nichts auf, und seine
    Last liegt wieder auf der Platte; ein verschobenes nimmt auf, was jetzt
    darüber steht.

    Ändert `modell["lasten"]` an Ort und Stelle und legt die Durchleitung unter
    `modell["durchleitung"]` ab. Dort holt `durchleitung_buchen()` sie nach der
    Rechnung ab, und der Geschossplan zeichnet sie.

    @param breiten  GlobalId → halbe tragende Breite [m] (`halbbreiten()`)
    @returns die Durchleitung, ein Eintrag je Last und Lager
    """
    from shapely.geometry import LineString, Point
    from shapely.ops import unary_union

    flaechen = []          # (Lager, Lagerfläche, Achse)
    for lager in modell.get("auflager") or []:
        halb = (0.5 * float(lager.get("breite_m") or 0.0)
                or max((float(breiten.get(g) or 0.0) for g in lager.get("bauteile") or []),
                       default=0.0)) + DURCHLEITUNG_ZUGABE_M
        if lager.get("typ") == "punkt":
            if lager.get("p") is None:
                continue
            achse = Point(lager["p"][:2])
            flaeche = achse.buffer(halb)
        else:
            zug = lager.get("polylinie") or []
            if len(zug) < 2:
                continue
            achse = LineString([p[:2] for p in zug])
            if achse.length < 1e-9:
                continue
            flaeche = achse.buffer(halb, cap_style="flat", join_style="mitre")
        if not flaeche.is_empty:
            flaechen.append((lager, flaeche, achse))
    if not flaechen:
        return []

    def eintrag(last, lager, **geometrie):
        return {"lager": lager["id"], "bauteile": list(lager.get("bauteile") or []),
                "lastfall": last["lastfall"], "art": last.get("art"),
                "bezug": last.get("bezug"), "herkunft": last.get("herkunft"),
                **geometrie}

    durch: list[dict] = []
    bleiben: list[dict] = []
    for last in modell.get("lasten") or []:
        if last.get("typ") == "punkt" and last.get("p") is not None:
            ort = Point(last["p"][:2])
            treffer = [(lager, achse) for lager, flaeche, achse in flaechen
                       if flaeche.covers(ort)]
            if not treffer:
                bleiben.append(last)
                continue
            lager, _ = min(treffer, key=lambda t: t[1].distance(ort))
            durch.append(eintrag(last, lager, typ="punkt", p=list(last["p"][:2]),
                                 kN=float(last["wert"])))
            continue
        if last.get("typ") != "linie" or len(last.get("polylinie") or []) < 2:
            bleiben.append(last)
            continue

        linie = LineString([p[:2] for p in last["polylinie"]])
        wert = float(last["wert"])
        # Größte Überdeckung zuerst: an einer Ecke liegt eine Last in zwei
        # Lagerflächen, und sie gehört dem Lager, auf dem sie entlangläuft.
        rangfolge = sorted(
            ((lager, flaeche, linie.intersection(flaeche).length)
             for lager, flaeche, _ in flaechen),
            key=lambda t: -t[2])
        rest = linie
        stuecke: list[list] = []
        for lager, flaeche, ueberdeckt in rangfolge:
            if ueberdeckt < 1e-6 or rest.is_empty:
                break
            teil = rest.intersection(flaeche)
            if teil.length < 1e-6:
                continue
            stuecke.append([lager, flaeche, teil])
            rest = rest.difference(flaeche)
        if not stuecke:
            bleiben.append(last)
            continue

        reste = []
        for stueck in _linienstuecke(rest):
            if stueck.length < 1e-6:
                continue
            if stueck.length < DURCHLEITUNG_STUMMEL_M:
                naechstes = min(stuecke, key=lambda s: s[1].distance(stueck))
                if naechstes[1].distance(stueck) <= DURCHLEITUNG_STUMMEL_M:
                    naechstes[2] = unary_union([naechstes[2], stueck])
                    continue
            reste.append(stueck)

        for lager, _, teil in stuecke:
            zuege = [_zug(s) for s in _linienstuecke(teil) if s.length >= 1e-6]
            durch.append(eintrag(last, lager, typ="linie", polylinien=zuege,
                                 wert=wert, laenge_m=round(teil.length, 4),
                                 kN=wert * teil.length))
        for k, stueck in enumerate(reste, start=1):
            bleiben.append({**last, "polylinie": _zug(stueck),
                            "id": f"{last.get('id', 'L')}.{k}" if len(reste) > 1
                            else last.get("id")})

    modell["lasten"] = bleiben
    if durch:
        modell["durchleitung"] = durch
    return durch


#: Ein freier Rand wird gemeldet ab dieser Länge; zwischen zwei Stützen erst
#: ab `FREIER_RAND_STUETZEN_M` (der Rand einer Flachdecke ist frei).
FREIER_RAND_M = 2.0
FREIER_RAND_STUETZEN_M = 8.0


def freie_raender(modell: dict, zugabe: float = 0.60) -> dict:
    """
    Die Teile des Plattenrands, die auf keinem Lager liegen.

    Eine Decke kragt aus (Balkon, Vordach), oder unter ihrem Rand steht etwas,
    das nicht trägt: eine Glasfassade, eine Wand ohne tragendes Material, ein
    Unterzug, der im Modell fehlt. Das sieht man der Rechnung nicht an — sie
    rechnet die Ecke dann als Kragplatte, und die Durchbiegung ist groß, aber
    plausibel (SampleHouse: 56 mm an der Ecke über der Pfosten-Riegel-Fassade).
    Gezählt wird der Außenrand des Systemumrisses ohne Lager oder Unterzug in
    halber Bauteilbreite plus `zugabe`. Die Zugabe ist 0,60 m, weil eine Decke
    bis an die Außenfläche des Wandaufbaus reicht — bei einer Holzrahmenwand
    mit innenliegender tragender Schicht 0,4–0,5 m über deren Achse hinaus
    (EFH Weihgold: mit 0,30 m meldete jede Decke ihren ganzen Rand).

    @returns {rand_m, frei_m, laengstes_m, stuecke: [{laenge_m, von, bis,
              zwischen_stuetzen}]} — `stuecke` nur ab `FREIER_RAND_M`
    """
    from shapely.geometry import LineString, Point, Polygon
    from shapely.ops import linemerge, unary_union

    leer = {"rand_m": 0.0, "frei_m": 0.0, "laengstes_m": 0.0, "stuecke": []}
    system = (modell.get("system") or [{}])[0]
    if system.get("bodengebettet") or system.get("bettung_kNm3"):
        return leer          # eine gebettete Platte hat keine Ränder auf Lagern
    try:
        rand = Polygon([q[:2] for q in system["umriss"]]).exterior
    except Exception:  # noqa: BLE001
        return leer
    abdeckung, stuetzen = [], []
    for a in modell.get("auflager") or []:
        halb = 0.5 * float(a.get("breite_m") or 0.20) + zugabe
        if a.get("typ") == "punkt" and a.get("p") is not None:
            ort = Point(a["p"][:2])
            stuetzen.append(ort)
            abdeckung.append(ort.buffer(max(halb, 0.50)))
        elif len(a.get("polylinie") or []) >= 2:
            abdeckung.append(LineString([q[:2] for q in a["polylinie"]]).buffer(halb))
    for u in modell.get("unterzuege") or []:
        if len(u.get("polylinie") or []) >= 2:
            abdeckung.append(LineString([q[:2] for q in u["polylinie"]])
                             .buffer(0.5 * float(u.get("breite_m") or 0.3) + zugabe))
    frei = rand.difference(unary_union(abdeckung)) if abdeckung else rand
    if frei.is_empty:
        return {"rand_m": round(rand.length, 2), "frei_m": 0.0, "laengstes_m": 0.0, "stuecke": []}
    if frei.geom_type == "MultiLineString":
        frei = linemerge(frei)
    teile = [g for g in getattr(frei, "geoms", [frei]) if not g.is_empty]

    def an_stuetze(punkt) -> bool:
        return any(Point(punkt).distance(s) <= 0.80 for s in stuetzen)

    stuecke = []
    for t in sorted(teile, key=lambda g: -g.length):
        if t.length < FREIER_RAND_M:
            continue
        von, bis = list(t.coords[0]), list(t.coords[-1])
        stuecke.append({"laenge_m": round(t.length, 2),
                        "von": [round(v, 2) for v in von], "bis": [round(v, 2) for v in bis],
                        "zwischen_stuetzen": an_stuetze(von) and an_stuetze(bis)})
    return {"rand_m": round(rand.length, 2),
            "frei_m": round(sum(t.length for t in teile), 2),
            "laengstes_m": round(max((t.length for t in teile), default=0.0), 2),
            "stuecke": stuecke}


def durchleitung_buchen(bericht: dict, modell: dict) -> float:
    """
    Die Durchleitung nach der Rechnung zu den Auflagerkräften legen.

    Je Lastfall und Lager kommt die durchgeleitete Kraft auf `R_z_kN` in
    `bericht["auflager_lastfallweise"]` — dieselbe Liste, aus der
    `lastabtrag.aus_auflagerbilanz()` die Pakete für die Wände darunter bildet.
    Trägt die Platte in einem Lastfall gar nichts mehr (alle Lasten dieses
    Falls stehen auf Lagern), legt `einzelfelder()` für ihn kein Feld an; die
    Liste entsteht dann hier aus den Lagern des Modells.

    @returns die gebuchte Kraft [kN]; 0, wenn es nichts zu buchen gab oder der
             Bericht keine lastfallweise Bilanz hat (dann sagt es ein Hinweis)
    """
    durch = modell.get("durchleitung") or []
    if not durch:
        return 0.0
    lastfallweise = bericht.get("auflager_lastfallweise")
    if not lastfallweise:
        bericht.setdefault("hinweise", []).append(
            "Keine lastfallweise Auflagerbilanz — die Durchleitung von oben ist "
            "nicht gebucht.")
        return 0.0

    def vorlage(lager):
        laenge = _laenge(lager["polylinie"]) if lager.get("polylinie") else 0.0
        return {"id": lager["id"], "typ": lager.get("typ"), "art": lager.get("art", "gelenkig"),
                "knoten": 0, "laenge_m": laenge,
                "R_x_kN": 0.0, "R_y_kN": 0.0, "R_z_kN": 0.0,
                "R_je_m_kNm": 0.0 if laenge else None,
                "bauteile": list(lager.get("bauteile") or []),
                "bauteil_anteile": lager.get("bauteil_anteile") or {}}

    arten = bericht.setdefault("lastfall_arten", {})
    art_im_modell = {f["id"]: f.get("art", "G") for f in modell.get("lastfaelle") or []}
    gesamt = 0.0
    je_lager: dict[str, float] = {}
    for e in durch:
        fall = e["lastfall"]
        liste = lastfallweise.get(fall)
        if liste is None:
            liste = lastfallweise[fall] = [vorlage(a) for a in modell.get("auflager") or []]
            arten.setdefault(fall, art_im_modell.get(fall, e.get("art") or "G"))
        ziel = next((x for x in liste if x["id"] == e["lager"]), None)
        if ziel is None:
            lager = next((a for a in modell.get("auflager") or [] if a["id"] == e["lager"]), None)
            if lager is None:
                continue
            ziel = vorlage(lager)
            liste.append(ziel)
        ziel["R_z_kN"] = float(ziel.get("R_z_kN") or 0.0) + float(e["kN"])
        ziel["durchgeleitet_kN"] = float(ziel.get("durchgeleitet_kN") or 0.0) + float(e["kN"])
        if (ziel.get("laenge_m") or 0.0) > 1e-9:
            ziel["R_je_m_kNm"] = ziel["R_z_kN"] / float(ziel["laenge_m"])
        gesamt += float(e["kN"])
        je_lager[e["lager"]] = je_lager.get(e["lager"], 0.0) + float(e["kN"])
    bericht["durchleitung"] = {
        "kN": round(gesamt, 3), "lasten": len(durch),
        "je_lager_kN": {k: round(v, 3) for k, v in sorted(je_lager.items())}}
    return gesamt


def _box_fuer(huelle: dict, geschoss: dict, mindesthoehe: float = 3.0) -> dict:
    """
    Schnittbox um genau ein Geschoss, in x und y das ganze Gebäude.

    Die Unterkante der Box ist der Bezugspunkt jeder Schnitthöhe — deshalb wird
    sie hier festgelegt und mitgegeben, statt sie an drei Stellen neu zu raten.
    Ein Geschoss, dessen „Decke" unter seinem Boden liegt (das oberste eines
    Modells, dessen Ebene über der Modelloberkante steht), bekommt drei Meter.
    """
    lo, hi = huelle["lo"], huelle["hi"]
    z_unten = float(geschoss["boden"]) - 0.5
    z_oben = max(float(geschoss["decke"]), float(geschoss["boden"]) + mindesthoehe) + 0.5
    return {
        "center": [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (z_unten + z_oben) / 2],
        "size": [hi[0] - lo[0], hi[1] - lo[1], z_oben - z_unten],
        "z_unten": z_unten,
    }


def _ueber(wand: dict, poly, zugabe: float = 0.30) -> bool:
    """Steht diese Wand (Figur aus dem Schnitt) über dieser Platte?"""
    if poly is None:
        return False
    from shapely.geometry import Point
    mitte = wand.get("punkt") or _ringmitte(wand.get("ringe"))
    if mitte is None:
        return False
    return poly.distance(Point(mitte[0], mitte[1])) <= zugabe


def _ueberdeckt_anteil(a: dict, b: dict) -> float:
    """Welcher Anteil der Hüllbox von `a` liegt unter der von `b`?"""
    breite = max(0.0, min(a["hi"][0], b["hi"][0]) - max(a["lo"][0], b["lo"][0]))
    tiefe = max(0.0, min(a["hi"][1], b["hi"][1]) - max(a["lo"][1], b["lo"][1]))
    eigen = (a["hi"][0] - a["lo"][0]) * (a["hi"][1] - a["lo"][1])
    return breite * tiefe / eigen if eigen > 1e-9 else 0.0


def _plattenaufbau(annahmen: dict, platte: dict, name: str, boxen: dict,
                   feld: str = "dicke_m") -> dict:
    """
    Dicke und Aufbau einer Platte aus ihren Materialschichten in die Annahmen.

    Die Dicke nur, wenn keine vorgegeben ist; den Aufbau immer, wenn das Modell
    einen führt — er ersetzt dann die angenommene Ausbau- bzw. Dachaufbaulast
    (`tragwerksmodell.statikmodell()`, `_aufbau_modell`). Ohne Schichten bleibt
    es bei Hüllbox und Annahme.
    """
    schichten = (boxen.get(platte["global_id"]) or {}).get("materialschichten")
    aufbau = la.aufbau_platte(schichten, dicke_m=float(platte["dicke_m"]))
    if annahmen.get(feld) is None:
        if aufbau["aus_schichten"]:
            annahmen[feld] = aufbau["dicke_tragend_m"]
            annahmen["dicke_quelle"] = (
                f"tragende Schichten von \"{name}\" ({aufbau['quelle']})")
        else:
            annahmen[feld] = platte["dicke_m"]
            annahmen["dicke_quelle"] = (
                f"gemessen an der Hüllbox von \"{name}\" "
                f"(z {platte['z_unten']:.2f} … {platte['z_oben']:.2f} m)")
    if aufbau["aufbau_kNm2"] is not None:
        annahmen["_aufbau_modell"] = {"wert": aufbau["aufbau_kNm2"],
                                      "quelle": aufbau["quelle"]}
    else:
        annahmen.pop("_aufbau_modell", None)
    return aufbau


def _eigenlast_schaetzen(platte: dict, poly, annahmen: dict, dach: bool,
                        boxen: dict | None = None) -> float:
    """
    Was eine Platte, die nicht gerechnet werden konnte, eingetragen hätte.

    Für die Bilanz, nicht für einen Nachweis: Fläche × (Dicke · 25 + Ausbau
    + Nutzlast). Ohne diese Zahl verschwände eine nicht rechenbare Decke auf
    beiden Seiten der Erhaltungsprobe — und die stimmte, obwohl die Last des
    halben Hauses fehlt (SampleHouse: Dach ohne Auflager, Bilanz „erhalten").
    Mit Schichtaufbau wie die Rechnung selbst (`_plattenaufbau`).
    """
    flaeche = (poly.area if poly is not None and not poly.is_empty else platte["flaeche_m2"])
    probe: dict = {}
    _plattenaufbau(probe, platte, "", boxen or {})
    ausbau = (probe["_aufbau_modell"]["wert"] if "_aufbau_modell" in probe else
              float(annahmen.get("dachaufbau_kNm2" if dach else "ausbaulast_kNm2")
                    or (tm.DACHAUFBAU_VORGABE if dach else 1.5)))
    nutz = tm.DACH_NUTZLAST_H if dach else tm.NUTZLASTEN.get(
        annahmen.get("nutzlast_kategorie") or "A2", tm.NUTZLASTEN["A2"])[0]
    return flaeche * (float(probe["dicke_m"]) * 25.0 + ausbau + nutz)


def _hoehe_im_geschoss(box: dict | None, boden: float, decke: float,
                       ersatz: float) -> float:
    """
    Die Höhe eines Bauteils **in diesem Geschoss**, nicht seine ganze Höhe.

    Eine Wand, die im IFC über drei Geschosse durchläuft, ist ein Bauteil mit
    einer Hüllbox von zehn Metern. Die Kette führt sie in jedem Geschoss mit
    einem eigenen Konto — und wog sie bis Oktober 2026 in jedem davon mit der
    vollen Höhe, also dreimal ganz. Gezählt wird jetzt der Teil zwischen dem
    Fußboden (bis 30 cm Aufbau darunter) und der Deckenunterkante.
    """
    if not box or not box.get("hi"):
        return ersatz
    unten = max(float(box["lo"][2]), boden - 0.30)
    oben = min(float(box["hi"][2]), decke)
    hoehe = oben - unten
    return hoehe if 0.3 <= hoehe <= 12.0 else ersatz


def _volumen_im_geschoss(info: dict, box: dict | None, hoehe: float) -> float | None:
    """
    Der Rauminhalt eines Bauteils in diesem Geschoss, aus seinem Netz.

    **Warum nicht Schnittlänge × Höhe × Dicke.** Der Schnitt liegt in einer
    Höhe; trifft er ein Fensterband, fehlen der Wand Brüstung und Sturz, und
    trifft er zwischen zwei Fenstern, ist sie voll. Am Prüfhaus H2 wog eine
    10-m-Außenwand mit drei Fenstern so 6,3 m statt 9,7 m Achslänge — ein
    Fünftel zu leicht, und zwar immer zur unsicheren Seite. Das Netz kennt die
    Öffnungen genau.

    Eine Wand über mehrere Geschosse bekommt den Anteil ihrer Höhe in diesem
    Geschoss. Geprüft wird gegen den Schnitt (Querschnitt × Höhe, zwischen
    0,4- und 3fach) und die Hüllbox: ein offenes Netz liefert über den Satz von
    Gauß beliebige Zahlen statt eines Fehlers — dann `None`, und es bleibt beim
    Schnitt.
    """
    volumen = float((box or {}).get("volumen_m3") or info.get("volumen_m3") or 0.0)
    if volumen <= 0.0 or not box or not box.get("hi"):
        return None
    lo, hi = box["lo"], box["hi"]
    hoehe_box = float(hi[2]) - float(lo[2])
    if hoehe_box < 0.3 or hoehe <= 0.0:
        return None
    quader = (float(hi[0]) - float(lo[0])) * (float(hi[1]) - float(lo[1])) * hoehe_box
    if volumen > 1.02 * quader:
        return None
    teil = volumen * min(1.0, hoehe / hoehe_box)
    querschnitt = float(info.get("flaeche_m2") or 0.0)
    if querschnitt > 0.0 and not (0.4 <= teil / (querschnitt * hoehe) <= 3.0):
        return None
    return teil


def _nutzgeschosse(geometrien, nutzdecken, toleranz: float = LASTFANG_M) -> int:
    """
    n für α_n: wie viele Geschosse **mit Nutzlast** über einem Bauteil liegen.

    DIN EN 1991-1-1, 6.3.1.2 (11) zählt die Geschosse derselben Kategorie
    oberhalb des Bauteils. Bis Oktober 2026 stand hier der Geschossindex — das
    zählte das Dach mit (seit dem Dachlastfall trägt es keine Nutzlast mehr),
    und bei einem Gebäude aus zwei Baukörpern verschiedener Höhe auch die
    Geschosse des höheren über einer Wand des niedrigeren. Ein zu großes n
    mindert die Nutzlast zu stark ab, also auf der unsicheren Seite.

    Gezählt wird deshalb geometrisch: ein Geschoss zählt, wenn eine seiner
    Decken mit Nutzlast das Bauteil überdeckt (bis auf `toleranz` — eine
    Außenwand liegt am Plattenrand, nicht darunter).

    @param geometrien  Lagerlinien bzw. -punkte des Bauteils (shapely)
    @param nutzdecken  [(Geschossindex, Plattenpolygon)] der Decken mit Nutzlast
    """
    if not geometrien:
        return 0
    gezaehlt: set[int] = set()
    for index, polygon in nutzdecken or []:
        if index in gezaehlt or polygon is None:
            continue
        if any(polygon.distance(geo) <= toleranz for geo in geometrien):
            gezaehlt.add(index)
    return len(gezaehlt)


def _lagergeometrien(modell: dict, gid: str, info: dict | None = None) -> list:
    """Die Lager eines Bauteils als shapely-Linien und -Punkte, für `_nutzgeschosse`."""
    from shapely.geometry import LineString, Point  # noqa: PLC0415
    geos = []
    for a in modell.get("auflager") or []:
        if gid not in (a.get("bauteile") or []):
            continue
        if len(a.get("polylinie") or []) >= 2:
            geos.append(LineString(a["polylinie"]))
        elif a.get("p"):
            geos.append(Point(a["p"]))
    if not geos and info:
        geos = [LineString(p) for p in (info.get("achsen") or []) if len(p) >= 2]
        if not geos and info.get("punkt"):
            geos = [Point(info["punkt"])]
    return geos


def _last_kN(last: dict) -> float:
    """Die Kraft einer Last aus dem Lastabtrag, kN (Linienlast × Länge)."""
    if last.get("typ") != "punkt" and len(last.get("polylinie") or []) >= 2:
        return float(last["wert"]) * _laenge(last["polylinie"])
    return float(last.get("wert") or 0.0)


def _je_art(lasten, arten: dict) -> dict[str, float]:
    """Lasten nach Art summiert: ständig (G) und veränderlich (Q), kN."""
    summe = {"G": 0.0, "Q": 0.0}
    for last in lasten or []:
        art = last.get("art") or arten.get(last.get("lastfall"), "G")
        summe["Q" if art == "Q" else "G"] += _last_kN(last)
    return summe


def _anteile_je_art(anteile: dict, arten: dict) -> dict[str, float]:
    summe = {"G": 0.0, "Q": 0.0}
    for kennung, wert in (anteile or {}).items():
        summe["Q" if arten.get(kennung, "G") == "Q" else "G"] += float(wert)
    return summe


def _lager_je_bauteil(pakete: dict, konten: dict, geschoss: str) -> list[dict]:
    """Was die Lager eines Deckenfelds an die Bauteile darunter abgeben, kN."""
    eintraege = []
    for gid, liste in pakete.items():
        kN = sum(w for paket in liste for w in paket.anteile_kN.values())
        konto = konten.get((gid, geschoss)) if gid else None
        eintraege.append({"global_id": gid or None,
                          "name": (konto.name if konto else None) or "ohne Bauteil",
                          "rolle": konto.rolle if konto else None,
                          "kN": round(kN, 3)})
    return sorted(eintraege, key=lambda e: -e["kN"])


def _waende_weitergeben(waende: list[dict], g: dict, konten: dict,
                        geschossindex: int, letztes: bool, grund: str,
                        gruende: dict | None = None,
                        boxen: dict | None = None) -> list[dict]:
    """
    Tragende Wände und Stützen ohne gerechnete Decke darüber: ihr Eigengewicht.

    Zwei Fälle, beide bis Oktober 2026 still verloren: ein Geschoss ohne
    Deckenplatte (ein Dachgeschoss unter einem Holzdach — die Wände stehen auf
    der Decke darunter, ihr Gewicht fehlte dort), und Wände außerhalb jeder
    Platte eines Geschosses (ein eingeschossiger Anbau neben dem Haupthaus).
    Sie bekommen ein Konto mit ihrem Eigengewicht, und das geht als
    Linienlast entlang ihrer Achse nach unten.

    @returns die Lasten für das Geschoss darunter
    """
    nach_unten: list[dict] = []
    for w in waende:
        gid = w.get("global_id")
        if not gid or (gid, g["name"]) in konten:
            continue
        rolle = w["rolle"]
        wichte, aus_modell = la.wichte_tragend(w.get("klasse"), rolle)
        if w.get("wichte_kNm3") is not None:
            wichte = float(w["wichte_kNm3"])
            aus_modell = bool(w.get("wichte_aus_modell", aus_modell))
        volumen = _volumen_im_geschoss(w, boxen.get(gid) if boxen else None, w["hoehe_m"])
        if volumen is not None:
            gewicht = volumen * wichte
        elif rolle == "stuetze":
            gewicht = la.eigengewicht_stuetze(w["hoehe_m"], w["flaeche_m2"], wichte)
        else:
            gewicht = la.eigengewicht_wand(w["laenge_m"], w["hoehe_m"],
                                           w["dicke_gesamt_m"], wichte)
        if gewicht <= 1e-6:
            continue
        konto = la.Konto(
            global_id=gid, ifc_type=w.get("ifc_type") or "", name=w.get("name") or gid,
            geschoss=g["name"], rolle=rolle, tragend=w.get("tragend"),
            geometrie={"dicke_tragend_m": w.get("dicke_tragend_m"),
                       "dicke_gesamt_m": w.get("dicke_gesamt_m"),
                       "laenge_m": w.get("laenge_m"), "hoehe_m": w.get("hoehe_m"),
                       "flaeche_m2": w.get("flaeche_m2")},
            geschosse_darueber=0)
        konto.eigengewicht_kN = gewicht
        konto.wichte_kNm3 = wichte
        konto._eigengewicht_weitergegeben = True
        konto.hinweise.append((gruende or {}).get(gid, grund))
        if not aus_modell:
            konto.hinweise.append(
                f"Werkstoff nicht erkannt — Eigengewicht mit {wichte:.0f} kN/m³ angesetzt.")
        konten[(gid, g["name"])] = konto
        if letztes:
            konto.hinweise.append("Unterstes Geschoss — die Fußkraft geht in die Gründung.")
            continue
        herkunft = f"Eigengewicht {konto.name} ({g['name']}, ohne Decke darüber)"
        achsen = [a for a in (w.get("achsen") or []) if len(a) >= 2]
        gesamt = sum(_laenge(a) for a in achsen)
        if rolle == "stuetze" or gesamt < 1e-6:
            ort = w.get("punkt") or _ringmitte(w.get("ringe"))
            if ort is None:
                continue
            nach_unten.append({"typ": "punkt", "p": ort, "wert": gewicht,
                               "lastfall": la.EIGENGEWICHT, "art": "G",
                               "bezug": gid, "herkunft": herkunft})
            continue
        for achse in achsen:
            nach_unten.append({"polylinie": achse, "wert": gewicht / gesamt,
                               "lastfall": la.EIGENGEWICHT, "art": "G",
                               "bezug": gid, "herkunft": herkunft})
    return nach_unten


def _ueber_nicht_gerechnet(lasten: list[dict]) -> list[dict]:
    """Lasten, die über einem nicht gerechneten Deckenfeld standen: markiert.
    Erreichen sie am Ende kein Bauteil, sind sie verloren — anders als der Fuß
    einer Stütze, die auf dem Gelände steht (`_auf_dem_gelaende()`)."""
    return [{**l, "ueber_nicht_gerechnet": True} for l in lasten]


def _auf_dem_gelaende(lasten: list[dict], boxen: dict, unterstes: dict,
                      konten: dict) -> tuple[list[dict], list[dict]]:
    """
    Am Ende der Kette: welche offenen Lasten stehen auf dem Gelände?

    Der Fuß einer Wand oder Stütze, unter der nichts modelliert ist und die bis
    ins unterste Geschoss hinabreicht, gibt seine Last in den Baugrund — ein
    Fundament fehlt im Modell, die Last ist nicht verloren (Lucy: die Stützen
    des Carports neben dem Haus, 780 kN, standen als „nicht abgesetzt" in der
    Bilanz). Nicht dazu zählen Lasten über einem nicht gerechneten Deckenfeld
    (markiert) und Füße von Bauteilen, die höher enden — sie hängen in der Luft,
    und das ist ein Befund.

    @returns (je Bauteil ein Eintrag für `gruendung["ohne_fundament"]`,
              Lasten, die weiter als nicht abgesetzt gelten)
    """
    oberkante = float(unterstes.get("decke") or unterstes["boden"]) + 0.10
    je_bauteil: dict[str, dict] = {}
    offen: list[dict] = []
    for last in lasten:
        gid = last.get("bezug")
        box = boxen.get(gid) if gid else None
        if (last.get("ueber_nicht_gerechnet") or box is None or not box.get("lo")
                or float(box["lo"][2]) > oberkante):
            offen.append(last)
            continue
        kN = (float(last["wert"]) * _laenge(last["polylinie"]) if "polylinie" in last
              else float(last["wert"]))
        eintrag = je_bauteil.setdefault(gid, {
            "global_id": gid, "name": box.get("name") or gid,
            "rolle": next((k.rolle for k in konten.values() if k.global_id == gid), None),
            "anteile_kN": {}, "orte": []})
        fall = last.get("lastfall") or la.EIGENGEWICHT
        eintrag["anteile_kN"][fall] = eintrag["anteile_kN"].get(fall, 0.0) + kN
        ort = last.get("p") or (last.get("polylinie") or [None])[0]
        if ort is not None and list(ort[:2]) not in eintrag["orte"]:
            eintrag["orte"].append([round(float(ort[0]), 3), round(float(ort[1]), 3)])
    for e in je_bauteil.values():
        e["anteile_kN"] = {k: round(v, 2) for k, v in e["anteile_kN"].items()}
        e["N_k_kN"] = round(sum(e["anteile_kN"].values()), 2)
    return list(je_bauteil.values()), offen


def _steildaecher(zugang, geschosse: list[dict], zuordnung: dict, annahmen: dict,
                  hinweise: list[str]) -> dict[str, dict]:
    """
    Je Geschoss das Steildach, dessen Sparren darin aufstehen (`ileen/dach.py`).

    Ein Sparren gehört zu dem Geschoss, in dem sein unteres Ende liegt — beim
    Pfettendach mit Kniestock dem Dachgeschoss: seine Last geht auf Kniestock,
    Stiele und Traufwände, oder, wo kein Bauteil sie fängt, auf die Decke
    darunter. Bis Oktober 2026 kannte die Kette Dächer nur als Platten: ein
    Steildach stand als „was darauf liegt, steht nicht im Modell der Kette" im
    Bericht, und sein Gewicht fehlte bis in die Gründung.

    Balken einer Balkenlage zählen nicht mit — sie sind schon Platte.
    """
    from . import dach as steildach
    in_lagen = {gid for ps in zuordnung.values() for p in ps
                for gid in ((p.get("balkenlage") or {}).get("elemente") or [])}
    ergebnis: dict[str, dict] = {}
    for j, g in enumerate(geschosse):
        try:
            d = steildach.dachlasten(
                zugang.boxen, z_von=float(g["boden"]),
                z_bis=float(geschosse[j - 1]["boden"]) if j > 0 else None,
                annahmen=annahmen, ausgeschlossen=in_lagen)
        except Exception as fehler:  # noqa: BLE001
            hinweise.append(f"{g['name']}: Steildach nicht gerechnet ({fehler})")
            continue
        if not d["sparren"]:
            continue
        from shapely.ops import unary_union
        figuren = [_grundrissfigur(zugang.boxen[gid]) for gid in d["sparren_ids"]
                   if gid in zugang.boxen]
        d["_figur"] = unary_union([f for f in figuren if f is not None]).buffer(0.30)
        ergebnis[g["name"]] = d
        hinweise.extend(f"{g['name']}: {h}" for h in d["hinweise"])
    return ergebnis


def _unter_steildach(platte: dict, poly, steildaecher: dict) -> bool:
    """Liegt über der Platte ein Steildach? Dann ist sie Dachboden, nicht Dach."""
    if poly is None or poly.is_empty:
        return False
    for d in steildaecher.values():
        if float(d["z_unten"]) < float(platte["z_unten"]) - 0.05:
            continue
        if d["_figur"].intersection(poly).area >= 0.25 * poly.area:
            return True
    return False


def _im_geschoss_stapeln(lasten: list[dict], waende: list[dict], konten: dict, g: dict,
                         letztes: bool, arten: dict, boxen: dict) -> list[dict]:
    """
    Füße, die im Geschoss auf einem anderen Bauteil stehen, gehen in dieses.

    Im Dachgeschoss stehen die Stiele unter der Firstpfette zum Teil auf dem
    Kniestock, nicht auf der Decke. Beide gehören zum selben Geschoss; ohne
    diesen Schritt ging die Stielkraft an der Kniestockkrone vorbei unmittelbar
    auf die Decke darunter, und der Kniestock trug nur sein Gewicht. Eine Last
    geht weiter in das Bauteil, dessen Oberkante dort liegt, wo ihr Bauteil
    endet (±10 cm), und das sie geometrisch fängt (`_direkt_auf_lager`).

    Im untersten Geschoss nicht: dort geht jedes Konto selbst in die Gründung,
    und die Stielkraft stünde zweimal darin.
    """
    if letztes or not lasten:
        return list(lasten)
    boden = float(g["boden"])
    ergebnis: list[dict] = []
    offen = list(lasten)
    for _ in range(4):
        weiter: list[dict] = []
        for last in offen:
            gid = last.get("bezug")
            b = boxen.get(gid) if gid else None
            fuss = float(b["lo"][2]) if b and b.get("lo") else None
            if fuss is None or fuss <= boden + 0.10:
                ergebnis.append(last)
                continue
            unter = [w for w in waende
                     if w.get("global_id") and w["global_id"] != gid
                     and (boxen.get(w["global_id"]) or {}).get("hi") is not None
                     and abs(float(boxen[w["global_id"]]["hi"][2]) - fuss) <= 0.10]
            if not unter:
                ergebnis.append(last)
                continue
            rest, nach = _direkt_auf_lager([last], unter, konten, g, letztes, arten)
            ergebnis.extend(rest)
            weiter.extend(nach)
        if not weiter:
            break
        offen = weiter
    else:
        ergebnis.extend(offen)
    return ergebnis


def _direkt_auf_lager(lasten: list[dict], waende: list[dict], konten: dict, g: dict,
                      letztes: bool, arten: dict) -> tuple[list[dict], list[dict]]:
    """
    Lasten ohne Decke, die auf einer Wand oder Stütze dieses Geschosses stehen.

    Eine Last von oben, die auf keine Platte fällt, steht entweder auf nichts
    (sie wird durchgereicht und erscheint am Ende als „nicht abgesetzt") oder
    auf einem tragenden Bauteil, das hier ohne Decke weiterläuft: die Stütze
    eines Carports auf ihrem Schraubfundament (Lucy: 784 kN „ohne Fundament",
    obwohl unter jeder Stütze eines stand), eine Wand, die durch ein Geschoss
    ohne Decke weiterläuft. Dann gehört sie diesem Bauteil — gebucht in sein
    Konto (`quelle_art = "direkt"`) und an seinem Fuß weitergegeben; im
    untersten Geschoss geht sie mit seinem Konto in die Gründung.

    Geometrisch wie `durchleiten()`: innerhalb der halben tragenden Breite
    (+ 2 cm) einer Wandachse, innerhalb des halben Stützenquerschnitts
    (+ 5 cm, mindestens 10 cm) eines Stützenpunkts. Linienlasten werden
    stückweise zugeordnet, der Rest bleibt, was er war.

    @returns (Lasten, die auf nichts stehen, Lasten für das Geschoss darunter)
    """
    from shapely.geometry import LineString, Point
    from shapely.ops import unary_union

    flaechen = []
    for w in waende:
        gid = w.get("global_id")
        if not gid or w.get("tragend") is False or (gid, g["name"]) not in konten:
            continue
        if w.get("rolle") == "stuetze" and w.get("punkt") is not None:
            halb = max(0.5 * math.sqrt(max(float(w.get("flaeche_m2") or 0.0), 0.0)), 0.10) + 0.05
            flaechen.append((w, Point(w["punkt"][:2]).buffer(halb)))
            continue
        achsen = [a for a in (w.get("achsen") or []) if len(a) >= 2]
        if not achsen:
            continue
        halb = 0.5 * float(w.get("dicke_tragend_m") or w.get("dicke_gesamt_m") or 0.0) + 0.02
        flaechen.append((w, unary_union([LineString([p[:2] for p in a])
                                         .buffer(halb, cap_style="flat", join_style="mitre")
                                         for a in achsen])))
    if not flaechen or not lasten:
        return list(lasten), []

    rest: list[dict] = []
    nach_unten: list[dict] = []

    def buchen(w, last, kN, laenge, zug=None):
        konto = konten[(w["global_id"], g["name"])]
        fall = last.get("lastfall") or la.EIGENGEWICHT
        konto.eingang.append(la.Lastpaket(
            quelle_art="direkt", quelle=last.get("bezug") or "",
            quelle_name=last.get("herkunft") or "", geschoss=g["name"],
            anteile_kN={fall: kN}, laenge_m=laenge, polylinie=zug))
        if letztes:
            return
        herkunft = f"Fuß {konto.name} ({g['name']}) — direkt von oben"
        achsen = [a for a in (w.get("achsen") or []) if len(a) >= 2]
        gesamt = sum(_laenge(a) for a in achsen)
        if w.get("rolle") == "stuetze" or gesamt < 1e-6:
            ort = w.get("punkt") or _ringmitte(w.get("ringe"))
            if ort is not None:
                nach_unten.append({"typ": "punkt", "p": ort, "wert": kN, "lastfall": fall,
                                   "art": arten.get(fall, last.get("art") or "G"),
                                   "bezug": w["global_id"], "herkunft": herkunft})
            return
        for achse in achsen:
            nach_unten.append({"polylinie": achse, "wert": kN / gesamt, "lastfall": fall,
                               "art": arten.get(fall, last.get("art") or "G"),
                               "bezug": w["global_id"], "herkunft": herkunft})

    for last in lasten:
        if last.get("typ") == "punkt" or "p" in last and "polylinie" not in last:
            ort = Point(last["p"][:2])
            treffer = [(w, f) for w, f in flaechen if f.covers(ort)]
            if not treffer:
                rest.append(last)
                continue
            # Das Bauteil, auf das die Last zeigt, vor der Stütze, vor der
            # Wand; erst dann der Abstand. Nach dem Flächenschwerpunkt allein
            # gewann der Giebel-Kniestock gegen den Stiel, der auf seiner
            # Mitte steht (Prüfhaus H6: Schwerpunkt der Wand = Ort des Stiels).
            w, _ = min(treffer, key=lambda t: (
                t[0].get("global_id") != last.get("bezug"),
                t[0].get("rolle") != "stuetze",
                t[1].centroid.distance(ort)))
            buchen(w, last, float(last["wert"]), 0.0)
            continue
        zug = last.get("polylinie") or []
        if len(zug) < 2:
            rest.append(last)
            continue
        linie = LineString([p[:2] for p in zug])
        uebrig_linie = linie
        for w, f in sorted(flaechen, key=lambda t: -linie.intersection(t[1]).length):
            if uebrig_linie.is_empty:
                break
            teil = uebrig_linie.intersection(f)
            if teil.length < 1e-3:
                continue
            buchen(w, last, float(last["wert"]) * teil.length, teil.length,
                   [_zug(s) for s in _linienstuecke(teil)][0] if _linienstuecke(teil) else None)
            uebrig_linie = uebrig_linie.difference(f)
        for stueck in _linienstuecke(uebrig_linie):
            if stueck.length >= 1e-3:
                rest.append({**last, "polylinie": _zug(stueck)})
    return rest, nach_unten


#: So viele Wände oder Stützen unter der untersten (über der obersten)
#: Deckenebene machen dort ein Geschoss — ein einzelnes Bauteil nicht.
MIN_TRAEGER_GESCHOSS = 3


def _balkenebenen(boxen: dict, abstand_max: float = 1.50) -> list[tuple[float, float]]:
    """
    Oberkanten der Holzbalkenlagen als (z, Fläche) — für `geschosse_aus_decken`.

    Eine Lage sind mindestens `BALKENLAGE_MIN_BALKEN` liegende, schlanke,
    gleichgerichtete Balken mit derselben Oberkante (±5 cm), **nebeneinander**
    (Abstand höchstens `abstand_max`) und **längs überlappend**. Daran
    scheitern Schwellen und Rähme: sie liegen auch flach und gleich hoch, aber
    auf den Wänden, also Raumbreiten auseinander und in Wandrichtung versetzt
    (VA3: elf Schwellen auf dem Betonsockel bei +4,35 m). Die Fläche ist die
    Breite der Lage mal der mittleren Balkenlänge.
    """
    stufen: dict[tuple[int, int], list] = {}
    for b in boxen.values():
        if not b.get("hi"):
            continue
        typ = b.get("ifc_type") or ""
        if la.rolle_von(typ) != "unterzug" and not typ.startswith("IfcMember"):
            continue
        dz = float(b["hi"][2]) - float(b["lo"][2])
        winkel, laenge, quer, mitte = _grundrissmass(b)
        if (dz > BALKEN_HOECHSTHOEHE_M or dz < 0.06 or laenge < BALKEN_MIN_LAENGE_M
                or quer > BALKEN_HOECHSTBREITE_M or laenge < 4.0 * max(quer, 0.05)):
            continue
        schluessel = (int(round(winkel / 5.0)) % 36, int(round(float(b["hi"][2]) / 0.05)))
        stufen.setdefault(schluessel, []).append((winkel, laenge, mitte, float(b["hi"][2])))

    ebenen = []
    gesehen: set = set()
    for (klasse, stufe), _ in sorted(stufen.items(), key=lambda kv: -len(kv[1])):
        if (klasse, stufe) in gesehen:
            continue
        balken = []
        for dk in (-1, 0, 1):
            for ds in (-1, 0, 1):
                nachbar = ((klasse + dk) % 36, stufe + ds)
                if nachbar in stufen and nachbar not in gesehen:
                    balken.extend(stufen[nachbar])
                    gesehen.add(nachbar)
        if len(balken) < BALKENLAGE_MIN_BALKEN:
            continue
        doppelt = np.radians([2.0 * w for w, *_ in balken])
        richtung = np.arctan2(np.sin(doppelt).sum(), np.cos(doppelt).sum()) / 2.0
        laengs = np.array([np.cos(richtung), np.sin(richtung)])
        normale = np.array([-laengs[1], laengs[0]])
        reihe = sorted(((float(np.dot(m, normale)), float(np.dot(m, laengs)) - l / 2.0,
                         float(np.dot(m, laengs)) + l / 2.0, l, z)
                        for _, l, m, z in balken))
        gruppe = [reihe[0]]

        def abschliessen(gruppe):
            if len(gruppe) < BALKENLAGE_MIN_BALKEN:
                return
            breite = gruppe[-1][0] - gruppe[0][0]
            laenge = float(np.median([g[3] for g in gruppe]))
            flaeche = (breite + abstand_max / 2.0) * laenge
            if flaeche >= 4.0:
                ebenen.append((float(np.median([g[4] for g in gruppe])), flaeche))

        for vorher, jetzt in zip(reihe, reihe[1:]):
            ueberlapp = min(vorher[2], jetzt[2]) - max(vorher[1], jetzt[1])
            if jetzt[0] - vorher[0] <= abstand_max and ueberlapp >= 0.3 * min(vorher[3], jetzt[3]):
                gruppe.append(jetzt)
            else:
                abschliessen(gruppe)
                gruppe = [jetzt]
        abschliessen(gruppe)
    return ebenen


def geschosse_aus_decken(boxen: dict, toleranz: float = 0.30,
                         mindestanteil: float = 0.15) -> list[dict]:
    """
    Geschosse aus den Deckenhöhen, wenn das Modell keine führt.

    Tragwerksmodelle aus Tekla, Allplan oder Revit Structure kommen oft ohne
    `IfcBuildingStorey` (Weihgold VA3: 197 Stützen, 160 Träger, 63 Wände,
    12 Decken, alles im Gebäude). Die Kette brach dann mit „Keine Geschosse"
    ab. Gebündelt werden die Oberkanten der Decken (≥ 8 cm, ≥ 4 m², innerhalb
    von `toleranz`); Ebenen mit weniger als `mindestanteil` der größten
    Deckenfläche (Podeste, Vordächer) zählen nicht. Zwischen zwei Ebenen liegt
    ein Geschoss.

    **Holzbalkenlagen sind Decken.** Ein Holzbau führt über dem EG keine
    IfcSlab, sondern Balken (`_balkenebenen`). Ohne sie bestand VA3 aus einem
    Geschoss von 3,50 bis 10,66 m, und die Decke über dem EG fehlte.

    **Ein Bauteil macht noch kein Geschoss.** Unter der untersten Ebene beginnt
    ein Geschoss nur, wenn mindestens `MIN_TRAEGER_GESCHOSS` Wände oder Stützen
    dort stehen und bis an die Ebene reichen (ein Keller ohne Bodenplatte im
    Modell); über der obersten ebenso. Eine Stützmauer am Hang allein (VA3,
    0,00 … 3,20 m) machte sonst die Bodenplatte zur Decke über einem
    „Erdgeschoss", das es nicht gibt.

    @returns [{name, boden, decke}] von unten, Namen EG, OG1, OG2 …
    """
    decken, traeger = [], []
    for b in boxen.values():
        if not b.get("hi"):
            continue
        rolle = la.rolle_von(b.get("ifc_type"), name=b.get("name"))
        lo_z, hi_z = float(b["lo"][2]), float(b["hi"][2])
        if rolle in ("wand", "stuetze"):
            traeger.append((lo_z, hi_z))
            continue
        if rolle not in ("decke", "fundament") or not (0.08 <= hi_z - lo_z <= HOECHSTDICKE_DECKE_M):
            continue
        g = b.get("grundriss")
        flaeche = (float(g["laenge_m"]) * float(g["breite_m"]) if g else
                   (float(b["hi"][0]) - float(b["lo"][0])) * (float(b["hi"][1]) - float(b["lo"][1])))
        if flaeche >= 4.0:
            decken.append((hi_z, flaeche))
    decken.extend(_balkenebenen(boxen))
    if not decken:
        return []
    gruppen: list[list] = []
    for z, flaeche in sorted(decken):
        if gruppen and z - gruppen[-1][0] <= toleranz:
            gruppen[-1][1] += flaeche
            gruppen[-1][2] = max(gruppen[-1][2], z)
        else:
            gruppen.append([z, flaeche, z])
    groesste = max(f for _, f, _ in gruppen)
    ebenen = [oben for _, f, oben in gruppen if f >= mindestanteil * groesste]
    unten = [lo for lo, hi in traeger
             if lo < ebenen[0] - MIN_LICHTE_HOEHE_M and hi >= ebenen[0] - 0.60]
    if len(unten) >= MIN_TRAEGER_GESCHOSS:
        ebenen.insert(0, float(np.median(unten)))
    oben = [hi for lo, hi in traeger
            if hi > ebenen[-1] + MIN_LICHTE_HOEHE_M and lo <= ebenen[-1] + 0.60]
    if len(oben) >= MIN_TRAEGER_GESCHOSS:
        ebenen.append(max(oben))
    geschosse = []
    for i, (boden, decke) in enumerate(zip(ebenen[:-1], ebenen[1:])):
        geschosse.append({"name": "EG" if i == 0 else f"OG{i}", "boden": round(boden, 3),
                          "decke": round(decke, 3), "abgeleitet": True})
    return geschosse


def rechne_kette(zugang: Zugang, annahmen: dict | None = None,
                 melden=None, eingriffe: list[dict] | None = None) -> dict:
    """
    Die ganze Kette, von oben nach unten.

    @param annahmen  Betongüte, Nutzlast, Ausbaulast, Elementgröße, …; dazu
                     `geschosse` als Liste von Namen, wenn nur ein Teil
                     gerechnet werden soll
    @param eingriffe Änderungen am abgeleiteten statischen System (`system.py`).
                     Sie greifen je Deckenfeld, unmittelbar nachdem das Modell
                     aus dem Schnitt entstanden ist — und ihre Folgen laufen
                     von selbst durch die ganze Kette: ein entferntes Lager
                     nimmt keine Auflagerkraft mehr auf, führt kein Konto,
                     gibt keine Fußkraft weiter, und im Geschoss darunter
                     fehlt die Linienlast, die es sonst eingetragen hätte.
    @returns dict mit `geschosse`, `konten`, `bilanz`, `hinweise`
    """
    annahmen = dict(annahmen or {})
    melden = melden or (lambda anteil, text: None)
    # Jeder Eingriff bekommt eine laufende Nummer. Sie ist der Faden, an dem
    # sich am Ende feststellen lässt, welcher Eingriff in **keinem** Geschoss
    # ein Ziel gefunden hat — je Deckenfeld ist „nicht gefunden" der Normalfall
    # und kein Befund, denn eine Wand steht nun einmal nur unter einem Feld.
    annahmen["_eingriffe"] = [{**e, "nr": i} for i, e in enumerate(eingriffe or [])]
    hinweise: list[str] = []

    if not zugang.geschosse:
        zugang.geschosse = geschosse_aus_decken(zugang.boxen)
        if zugang.geschosse:
            hinweise.append(
                "Das Modell führt keine Geschosse (IfcBuildingStorey) — abgeleitet aus den "
                "Deckenhöhen: " + ", ".join(f"{g['name']} {g['boden']:+.2f}…{g['decke']:+.2f} m"
                                             for g in zugang.geschosse) + ".")

    # Von oben nach unten. Die Reihenfolge ist die eine Sache, die dieses
    # Verfahren ausmacht — falsch herum gerechnet stünde in jeder Wand nur die
    # Decke unmittelbar darüber.
    alle_geschosse = sorted(zugang.geschosse, key=lambda g: float(g["boden"]), reverse=True)
    geschosse = list(alle_geschosse)
    auswahl = annahmen.get("geschosse")
    if auswahl:
        gewuenscht = {str(n).lower() for n in auswahl}
        geschosse = [g for g in geschosse if g["name"].lower() in gewuenscht]

    if not geschosse:
        raise ValueError("Keine Geschosse zum Rechnen — trägt das Modell IfcBuildingStorey?")

    # **Die Kürzel werden für alle Geschosse zusammen vergeben, nicht je
    # Geschoss.** Nur so lässt sich auflösen, dass zwei Etagen auf dasselbe
    # Kürzel fallen ("OG" und "1.OG" ergeben beide OG1) — und ein geteilter
    # Schlüssel wäre der schlimmste Ausgang: zwei Geschosse schrieben in
    # denselben Rechenstand.
    kuerzel = sm.kuerzel_alle([g["name"] for g in geschosse])

    # **Ist `LoadBearing` gepflegt?** Steht es an allen Wänden auf False, ist
    # es ein Vorgabewert und sagt nichts — dann entscheidet das Material.
    from .tragend import _pset_wert, _text, pset_gepflegt
    lb_werte = [_text(_pset_wert(zugang.psets.get(gid), "LoadBearing"))
                for gid, b in zugang.boxen.items()
                if la.rolle_von(b.get("ifc_type")) == "wand"]
    annahmen["_pset_vertrauen"], satz = pset_gepflegt(lb_werte)
    if satz:
        hinweise.append(satz)

    # **Jede Platte genau einem Geschoss**, und was keinem gehört und unten
    # liegt, ist Bodenplatte. Die Bodenplatte wird vor der Schleife gesucht,
    # nicht danach: sie entscheidet, ob das unterste Geschoss die Kette
    # schließt. Gibt es eine, gehen die Wandfußkräfte als Linienlasten auf
    # sie weiter, statt nur als Gründungslasten gebucht zu werden. Ohne diese
    # Reihenfolge bekam die Bodenplatte gar keine Last von oben — sie wurde
    # gerechnet, trug aber nur ihr Eigengewicht, und das fiel nicht auf, weil
    # eine gebettete Platte auch ohne Auflast ein plausibles Ergebnis liefert.
    zuordnung = decken_zuordnen(alle_geschosse, zugang.boxen)
    vergeben = {p["global_id"] for ps in zuordnung.values() for p in ps}
    fundamente = bodenplatte(alle_geschosse, zugang.boxen, ausgeschlossen=vergeben)

    ergebnisse: list[Geschossergebnis] = []
    # **Schlüssel ist (GlobalId, Geschoss), nicht die GlobalId allein.** Eine
    # Wand, die über drei Geschosse durchläuft, ist im IFC oft *ein* Bauteil
    # mit einer GlobalId. Sie bekommt in jedem Geschoss eine andere Last und
    # wiegt in jedem Geschoss erneut — mit dem Teil ihrer Höhe, der in diesem
    # Geschoss steht (`_hoehe_im_geschoss`). Bei der Ausgabe stehen die Konten
    # deshalb als Liste, und `nach_bauteil` sammelt sie je GlobalId.
    konten: dict[tuple[str, str], la.Konto] = {}
    # Was das zuletzt gerechnete Geschoss nach unten weitergibt.
    offene_lasten: list[dict] = []
    arten: dict[str, str] = {la.EIGENGEWICHT: "G"}
    psi0: dict[str, float] = {}
    #: Die Wände des zuletzt gerechneten Geschosses, beurteilt — sie stehen
    #: auf den Platten des nächsten: nichttragende als Trennwandzuschlag, und
    #: jede zeigt, dass die Platte darunter kein Dach ist.
    waende_darueber: list[dict] = []
    #: Die Platten aller Geschosse darüber — liegt eine davon über einer
    #: Platte, ist die kein Dach.
    platten_darueber: list[dict] = []
    #: Was auf Platten lag, die nicht gerechnet werden konnten. Es hat nie ein
    #: Fundament erreicht und gehört in die Bilanz.
    nicht_gerechnet: list[dict] = []
    #: Die gerechneten Decken mit Nutzlast, je Geschossindex — daraus zählt
    #: `_nutzgeschosse()` das n für α_n einer Wand.
    nutzdecken: list[tuple[int, object]] = []
    #: Bauteile, deren Lager ein Eingriff entfernt hat. Sie tragen nicht mehr,
    #: aber sie wiegen — ihr Gewicht geht als Last nach unten, nicht verloren.
    entlagert = {e.get("bauteil") for e in annahmen.get("_eingriffe") or []
                 if e.get("art") == "lager_entfernen" and e.get("bauteil")}
    #: Das Kassenbuch des Lastflusses, je Geschoss (`_geschossbuch`).
    buch: list[dict] = []
    steildaecher = _steildaecher(zugang, geschosse, zuordnung, annahmen, hinweise)

    for i, g in enumerate(geschosse):
        anteil_basis = 0.05 + 0.9 * i / len(geschosse)
        melden(anteil_basis, f"Geschoss {g['name']}: Schnitte")
        erg = Geschossergebnis(name=g["name"])
        ergebnisse.append(erg)
        von_oben = list(offene_lasten)
        erg.kuerzel = kuerzel[g["name"]]
        unterstes = (i == len(geschosse) - 1)
        # „Letztes" heißt: von hier geht nichts mehr weiter. Mit einer
        # Bodenplatte darunter geht sehr wohl etwas weiter — genau dorthin.
        letztes = unterstes and not fundamente
        platten = zuordnung.get(g["name"], [])
        hoehe_g = float(g["decke"]) - float(g["boden"])

        if not platten:
            erg.status = "uebersprungen"
            naechste: list[dict] = []
            waende_g: list[dict] = []
            # Ein Geschoss ohne Höhe ist eine Ebene, kein Raum: ein
            # „Fundament" auf der Sohlenunterkante. Ein Schnitt darin träfe
            # die Wände des Geschosses darüber und zählte sie doppelt.
            if hoehe_g >= MIN_LICHTE_HOEHE_M:
                try:
                    box = _box_fuer(zugang.huelle, g)
                    hoehe = (float(g["boden"]) + _wandschnitt_ueber_boden(hoehe_g)
                             - box["z_unten"])
                    schnitt = zugang.schnitt(box, "grundriss", hoehe)
                    waende_g = tm.waende_im_schnitt(
                        schnitt, boxen=zugang.boxen, psets=zugang.psets,
                        geschosshoehe=hoehe_g, annahmen=annahmen)
                    # **Niedrige Bauteile liegen unter dem Brüstungsschnitt** —
                    # der Kniestock unter dem Dach (0,5 m), eine Attika. Ohne
                    # Decke darüber trägt sie niemand sonst: ein zweiter Schnitt
                    # dicht über dem Boden holt sie dazu (Prüfhaus H6).
                    #
                    # Gemessen ab der Oberkante der Decke darunter, nicht ab der
                    # Geschosslinie, und nur, was auf ihr **steht**: Lucys
                    # Dachlage liegt über der Linie „Dachaufsicht", ein Schnitt
                    # 0,30 m über der Linie traf die Stützen, die durch die Lage
                    # nach oben laufen — und die Dachmodule galten danach als
                    # Decken mit Nutzlast (+135 kN).
                    unten_g = geschosse[i + 1]["name"] if i + 1 < len(geschosse) else None
                    auf = max([float(g["boden"])] + [float(p["z_oben"])
                                                     for p in zuordnung.get(unten_g, [])])
                    tief = auf + min(0.30, 0.5 * hoehe_g) - box["z_unten"]
                    if tief < hoehe - 0.05:
                        gesehen = {w["global_id"] for w in waende_g if w.get("global_id")}
                        waende_g += [
                            w for w in tm.waende_im_schnitt(
                                zugang.schnitt(box, "grundriss", tief), boxen=zugang.boxen,
                                psets=zugang.psets, geschosshoehe=hoehe_g, annahmen=annahmen)
                            if w.get("global_id") and w["global_id"] not in gesehen
                            and float((zugang.boxen.get(w["global_id"]) or {})
                                      .get("lo", [0, 0, auf])[2]) >= auf - 0.10]
                    for w in waende_g:
                        w["hoehe_m"] = round(_hoehe_im_geschoss(
                            zugang.boxen.get(w["global_id"]), float(g["boden"]),
                            float(g["decke"]), w["hoehe_m"]), 3)
                except Exception as fehler:  # noqa: BLE001
                    hinweise.append(f"{g['name']}: Wandschnitt misslungen ({fehler})")
            tragende = [w for w in waende_g if w["tragend"] is not False]
            dach_g = steildaecher.get(g["name"])
            dachlasten = list(dach_g["lasten"]) if dach_g else []
            if dach_g:
                erg.eingetragen_kN += sum(dach_g["kN_je_fall"].values())
            weiter = _waende_weitergeben(
                tragende, g, konten, i, letztes,
                "Keine Deckenplatte über diesem Geschoss — weitergegeben wird das "
                "Eigengewicht und was von oben oder vom Steildach direkt daraufsteht.",
                boxen=zugang.boxen)
            naechste.extend(_im_geschoss_stapeln(weiter, tragende, konten, g, letztes,
                                                 arten, zugang.boxen))
            durch, direkt = _direkt_auf_lager(offene_lasten + dachlasten, tragende, konten, g,
                                              letztes, arten)
            naechste.extend(durch)
            naechste.extend(_im_geschoss_stapeln(direkt, tragende, konten, g, letztes,
                                                 arten, zugang.boxen))
            if len(durch) != len(offene_lasten) + len(dachlasten) or direkt:
                hinweise.append(
                    f"{g['name']}: Lasten von oben stehen auf tragenden Bauteilen dieses "
                    f"Geschosses und gehen direkt in sie.")
            erg.konten = [konten[(w["global_id"], g["name"])] for w in tragende
                          if (w["global_id"], g["name"]) in konten]
            if erg.konten:
                erg.meldung = (
                    f"Keine Deckenplatte über \"{g['name']}\" — {len(erg.konten)} tragende "
                    f"Bauteile geben ihr Eigengewicht weiter"
                    + (f", {sum(1 for w in waende_g if w['tragend'] is False)} "
                       f"nichttragende stehen als Trennwandzuschlag auf der Decke darunter"
                       if any(w["tragend"] is False for w in waende_g) else "") + ".")
            elif hoehe_g < MIN_LICHTE_HOEHE_M:
                # Eine Ebene ohne Raum — die Gründungsebene unter der Sohle,
                # die Dachebene über dem Dach. Kein Befund.
                erg.meldung = (f"Ebene ohne Raum ({hoehe_g:.2f} m bis zum nächsten "
                               f"Geschoss) — nichts zu rechnen.")
            else:
                erg.meldung = (
                    f"Über \"{g['name']}\" liegt keine Deckenplatte: zwischen "
                    f"{float(g['boden']):.2f} m und {float(g['decke']):.2f} m steht keine "
                    f"IfcSlab von mindestens 8 cm Dicke im Elementverzeichnis.")
                hinweise.append(f"{g['name']}: {erg.meldung}")
            if offene_lasten and hoehe_g >= MIN_LICHTE_HOEHE_M:
                hinweise.append(
                    f"{g['name']}: {len(offene_lasten)} Lasten werden unverändert an das "
                    f"Geschoss darunter durchgereicht.")
            erg.weiter_nach_unten = naechste
            buch.append(_geschossbuch(g, erg, von_oben, naechste, konten, arten, letztes,
                                      durchgereicht=durch, dach=dach_g))
            offene_lasten = naechste
            if waende_g:
                waende_darueber = waende_g
            continue

        erg.platten = platten
        # Je Deckenfeld ein Submodell. Die Nummer folgt der Lage im Bauwerk,
        # nicht der Reihenfolge des Schnitts — sonst träfe dieselbe Nummer bei
        # einer anderen Netzweite die andere Platte, und der Rechenstand von
        # gestern hinge am falschen Feld.
        submodelle = {p["global_id"]: n
                      for n, p in sm.namen_fuer(kuerzel[g["name"]], platten)}

        # Ein Schnitt je Höhengruppe, nicht je Platte: die Felder eines
        # Geschosses liegen auf derselben Höhe, ein waagerechter Schnitt trifft
        # sie alle. **Erst alle Schnitte, dann die Lasten:** verteilt wird nach
        # den Umrissen der Platten, und die stehen erst im Schnitt.
        schnitte = []
        for gruppe in hoehengruppen(platten):
            try:
                box = _box_fuer(zugang.huelle, g)
                bezug = gruppe[0]
                hoehe_decke = bezug["z_mitte"] - box["z_unten"]
                if all(p.get("virtuell") for p in gruppe):
                    decke = {"figures": [ersatzplatte_figur(p) for p in gruppe],
                             "plane_origin": [0.0, 0.0, float(bezug["z_mitte"])],
                             "bounds": [min(p["lo"][0] for p in gruppe),
                                        min(p["lo"][1] for p in gruppe),
                                        max(p["hi"][0] for p in gruppe),
                                        max(p["hi"][1] for p in gruppe)]}
                else:
                    decke = zugang.schnitt(box, "grundriss", hoehe_decke)
                wandhoehe = bezug["z_unten"] - float(g["boden"])
                hoehe_waende = (float(g["boden"]) + _wandschnitt_ueber_boden(wandhoehe)
                                - box["z_unten"])
                waende = zugang.schnitt(box, "grundriss", hoehe_waende)
                # Womit geschnitten wurde, nicht was dabei herauskam: der
                # Planbau im Frontend soll dieselbe Zeichnung bekommen, aus der
                # gerechnet wurde. Die Figuren selbst mitzuschleppen wären
                # Megabyte je Geschoss — diese Zahlen sind ein paar Bytes,
                # und `section.cut()` liefert daraus beim zweiten Mal aus dem
                # Cache.
                schnittlage = {
                    "center": list(box["center"]), "size": list(box["size"]),
                    "z_unten": box["z_unten"],
                    "hoehe_decke": round(float(hoehe_decke), 4),
                    "hoehe_waende": round(float(hoehe_waende), 4),
                }
                krone = _kronenschnitt(zugang, box, gruppe)
                unterzuege = _unterzug_schnitt(zugang, box, gruppe, krone)
            except Exception as fehler:  # noqa: BLE001
                hinweise.append(f"{g['name']}: Schnitt misslungen ({fehler})")
                continue
            schnitte.append((gruppe, decke, waende, schnittlage, wandhoehe, unterzuege, krone))

        polygone = {p["global_id"]: plattenpolygon(decke, p["global_id"], p)
                    for gruppe, decke, *_ in schnitte for p in gruppe}
        # Die Lasten von oben auf die Platten verteilen. Was auf keine fällt,
        # steht auf einer Wand, die hier ohne Decke weiterläuft — es wird
        # durchgereicht statt verworfen.
        # Ein Steildach, dessen Sparren in diesem Geschoss aufstehen: was über
        # der Decke ankommt (das oberste Geschoss ohne eigenes Dachgeschoss im
        # Modell), liegt auf den Platten; was darunter ankommt (ein Pultdach
        # auf den Wänden eines Anbaus), steht auf Wänden und Stützen.
        dach_g = steildaecher.get(g["name"])
        dach_ueber: list[dict] = []
        dach_unter: list[dict] = []
        if dach_g:
            z_decke = min(float(p["z_unten"]) for p in platten)
            for last in dach_g["lasten"]:
                (dach_ueber if float(last.get("z") or 0.0) >= z_decke - 0.05
                 else dach_unter).append(last)
            erg.eingetragen_kN += sum(dach_g["kN_je_fall"].values())
        je_platte, uebrig = lasten_verteilen(offene_lasten + dach_ueber, platten,
                                             polygone or None)
        uebrig = uebrig + dach_unter
        if uebrig:
            hinweise.append(
                f"{g['name']}: {len(uebrig)} Lasten liegen über keiner Deckenplatte "
                f"dieses Geschosses und werden nach unten durchgereicht.")

        naechste_lasten: list[dict] = []
        gerechnet_hier = 0
        waende_g: dict[str, dict] = {}

        for gruppe, decke, waende, schnittlage, wandhoehe, unterzuege, krone in schnitte:
            for w in tm.waende_im_schnitt(waende, boxen=zugang.boxen, psets=zugang.psets,
                                          geschosshoehe=wandhoehe, annahmen=annahmen):
                w["hoehe_m"] = round(_hoehe_im_geschoss(
                    zugang.boxen.get(w["global_id"]), float(g["boden"]),
                    gruppe[0]["z_unten"], w["hoehe_m"]), 3)
                waende_g.setdefault(w["global_id"] or f"_{len(waende_g)}", w)
            for platte in gruppe:
                gid_p = platte["global_id"]
                poly = polygone.get(gid_p)
                # **Was auf der Platte steht**, nicht was unter ihr steht:
                # die Räume über ihr (ihre Nutzlast), die nichttragenden Wände
                # des Geschosses darüber (Trennwandzuschlag). Steht nichts
                # darauf und liegt keine Platte darüber, ist sie ein Dach.
                raeume = zugang.raeume_auf(platte, zugang.geschosse)
                darauf = [w for w in waende_darueber if _ueber(w, poly)]
                trenn = [w for w in darauf if w["tragend"] is False]
                # Eine Attika, ein Kniestock, die Aufständerung einer
                # PV-Anlage stehen auf einem Dach, ohne es zur Decke zu machen:
                # zum Raum darüber zählt nur, was Raumhöhe hat.
                raumhoch = [w for w in darauf
                            if float(w.get("hoehe_m") or 0.0) >= MIN_LICHTE_HOEHE_M]
                # Unter einem Steildach ist die Platte Dachboden, kein Dach:
                # Aufbau und Schnee trägt das Dach selbst (`_steildaecher`).
                dach = (not raeume and not raumhoch
                        and not any(_ueberdeckt_anteil(platte, q) >= 0.25
                                    for q in platten_darueber)
                        and not _unter_steildach(platte, poly, steildaecher))
                diese = [] if dach or poly is None else [(i, poly)]
                ergebnis_platte = _platte_rechnen(
                    zugang, g, platte, decke, waende, annahmen, arten, psi0,
                    je_platte.get(gid_p, []), konten, hinweise,
                    melden, anteil_basis, i, letztes, schnittlage,
                    submodelle[gid_p], raeume=raeume, trennwaende=trenn, dach=dach,
                    nutzdecken=nutzdecken + diese,
                    entlagert=entlagert, unterzuege=unterzuege, krone=krone)
                if (ergebnis_platte is not None
                        and ergebnis_platte["bericht_kurz"].get("status") == "gerechnet"):
                    nutzdecken.extend(diese)
                if ergebnis_platte is None or ergebnis_platte.get("verloren_kN"):
                    nicht_gerechnet.append({
                        "geschoss": g["name"], "platte": platte.get("name") or gid_p,
                        "kN": round(_eigenlast_schaetzen(platte, poly, annahmen, dach,
                                                     zugang.boxen), 1)})
                if ergebnis_platte is None:
                    continue
                if ergebnis_platte["bericht_kurz"].get("status") == "gerechnet":
                    gerechnet_hier += 1
                kurz = ergebnis_platte["bericht_kurz"]
                if kurz.get("lagerguete") in ("fraglich", "unbrauchbar"):
                    hinweise.append(
                        f"{g['name']} / {kurz['platte']}: Lagerung {kurz['lagerguete']} — "
                        f"{kurz.get('lager_abhebend', 0)} von {kurz.get('lager_gesamt', 0)} "
                        f"Lagern heben ab, Spitze {kurz.get('spitze_kN_je_m')} kN/m "
                        f"(Zwanganteil {kurz.get('zwanganteil')}). Die Auflager stammen aus "
                        f"Wandquerschnitten; einzelne Wandkräfte sind hier Artefakte, die "
                        f"Gesamtbilanz bleibt brauchbar.")
                erg.eingetragen_kN += ergebnis_platte["eingetragen_kN"]
                naechste_lasten.extend(ergebnis_platte["nach_unten"])
                erg.berichte.append(ergebnis_platte["bericht_kurz"])
                erg.konten.extend(ergebnis_platte["konten"])

        # Tragende Wände dieses Geschosses, die keine Platte getragen haben —
        # sie stehen außerhalb jedes Deckenfelds. Ihr Gewicht geht trotzdem
        # nach unten.
        ohne = [w for w in waende_g.values() if w["tragend"] is not False]
        weiter = _waende_weitergeben(
            ohne, g, konten, i, letztes,
            "Unter keiner gerechneten Decke — weitergegeben wird nur das Eigengewicht.",
            gruende={gid: ("Lager durch Eingriff entfernt — trägt die Decke darüber "
                           "nicht mehr; weitergegeben wird nur das Eigengewicht.")
                     for gid in entlagert},
            boxen=zugang.boxen)
        if weiter:
            naechste_lasten.extend(weiter)
        # Was auf keine Platte fiel, aber auf einer Wand oder Stütze steht.
        durch, direkt = _direkt_auf_lager(uebrig, list(waende_g.values()), konten, g,
                                          letztes, arten)
        naechste_lasten.extend(durch)
        naechste_lasten.extend(direkt)
        if uebrig and len(durch) < len(uebrig):
            hinweise.append(
                f"{g['name']}: {len(uebrig) - len(durch)} davon stehen auf tragenden "
                f"Bauteilen dieses Geschosses und gehen direkt in sie.")
        schon = {id(k) for k in erg.konten}
        erg.konten.extend(konten[(w["global_id"], g["name"])] for w in ohne
                          if (w["global_id"], g["name"]) in konten
                          and id(konten[(w["global_id"], g["name"])]) not in schon)

        if not gerechnet_hier:
            erg.status = "uebersprungen"
            erg.meldung = erg.meldung or (
                f"Keine der {len(platten)} Platten über \"{g['name']}\" war rechenbar.")
            hinweise.append(f"{g['name']}: {erg.meldung}")
        else:
            erg.status = "gerechnet"
            erg.meldung = (f"{gerechnet_hier} von {len(platten)} Platten gerechnet"
                           if gerechnet_hier != len(platten) else "")

        erg.weiter_nach_unten = naechste_lasten
        buch.append(_geschossbuch(g, erg, von_oben, naechste_lasten, konten, arten, letztes,
                                  durchgereicht=durch, neben_platten=uebrig, dach=dach_g))
        offene_lasten = naechste_lasten
        waende_darueber = list(waende_g.values())
        platten_darueber.extend(platten)

    # ── Die Bodenplatte ──────────────────────────────────────────────────
    #
    # **Ein eigenes Submodell, und das einzige mit Bettung.** Alles darüber
    # steht auf Wänden; die Bodenplatte steht auf Boden, und ohne Federn wäre
    # sie ein Bauteil ohne jedes Auflager — kinematisch, und die Rechnung
    # bricht ab. Die Bettung ist deshalb keine Option, sondern die Bedingung,
    # unter der es diese Rechnung überhaupt gibt.
    melden(0.93, "Bodenplatte")
    fund_ergebnis = None
    vor_sohle = list(offene_lasten)
    if fundamente:
        fund_ergebnis = _bodenplatte_rechnen(
            zugang, alle_geschosse, fundamente, offene_lasten, annahmen, arten, psi0,
            konten, hinweise, melden, waende_darueber)
        if fund_ergebnis:
            ergebnisse.append(fund_ergebnis)
            # Die Sohlreaktionen schließen die Kette: was hier ankommt, geht
            # nicht weiter, sondern in den Baugrund. Was auf keiner Sohle
            # stand, bleibt offen.
            offene_lasten = fund_ergebnis.weiter_nach_unten
            von = _je_art(vor_sohle, arten)
            weiter = _je_art(fund_ergebnis.weiter_nach_unten, arten)
            neu = {"G": 0.0, "Q": 0.0}
            for b in fund_ergebnis.berichte:
                for art, wert in _anteile_je_art(b.get("eingetragen_je_fall_kN") or {},
                                                 arten).items():
                    neu[art] += wert
            buch.append({
                "geschoss": fund_ergebnis.name, "kuerzel": fund_ergebnis.kuerzel,
                "bodenplatte": True,
                "von_oben_kN": {k: round(v, 3) for k, v in von.items()},
                "neu_kN": {k: round(v, 3) for k, v in neu.items()},
                "eigengewicht_kN": 0.0,
                "nach_unten_kN": {k: round(v, 3) for k, v in weiter.items()},
                "in_gruendung_kN": {k: round(von[k] - weiter[k] + neu[k], 3) for k in von},
                "platten": fund_ergebnis.berichte,
                "rest_kN": 0.0,
            })
    else:
        hinweise.append(
            "Keine Bodenplatte gefunden — unter dem untersten Geschoss steht "
            "keine IfcSlab von mindestens 10 cm. Die Gründungslasten stehen als "
            "Wandfußkräfte, aber die Sohlplatte selbst wurde nicht gerechnet.")

    # ── Gründung ─────────────────────────────────────────────────────────
    melden(0.96, "Gründungslasten")
    gruendung = _gruendung(konten, geschosse, hinweise)
    if fund_ergebnis is not None:
        gruendung["bodenplatte"] = {
            "submodelle": [b["submodell"] for b in fund_ergebnis.berichte],
            "bettung_kNm3": float(annahmen.get("bettung_kNm3")
                                  or BETTUNG_VORSCHLAG_KNM3),
            "bettung_quelle": ("Eingabe" if annahmen.get("bettung_kNm3")
                               else f"Vorschlagswert {BETTUNG_VORSCHLAG_KNM3:.0f} "
                                    f"kN/m³ — mitteldicht gelagerter Sand/Kies"),
            "eingetragen_kN": round(fund_ergebnis.eingetragen_kN, 1),
        }

    # Füße auf dem Gelände: unter ihnen steht nichts, ein Fundament fehlt im
    # Modell, die Last geht trotzdem in den Baugrund.
    gelaende, offene_lasten = _auf_dem_gelaende(offene_lasten, zugang.boxen,
                                                geschosse[-1] if geschosse else {"boden": 0.0},
                                                konten)
    gelaende_kN = sum(e["N_k_kN"] for e in gelaende)
    if gelaende:
        gruendung["ohne_fundament"] = gelaende
        gruendung["summe_kN"] = round(float(gruendung.get("summe_kN") or 0.0) + gelaende_kN, 2)
        hinweise.append(
            f"{len(gelaende)} Bauteile stehen auf dem Gelände ohne Fundament im Modell "
            f"({', '.join(e['name'] for e in gelaende[:4])}"
            f"{' …' if len(gelaende) > 4 else ''}): {gelaende_kN:.0f} kN gehen dort in den "
            f"Baugrund und stehen unter `gruendung.ohne_fundament`.")

    # Was am Ende der Kette noch offen ist, hat nie ein Fundament erreicht:
    # Lasten über einem Deckenfeld, das nicht rechenbar war, oder über gar
    # keinem. Sie gehören in die Bilanz, sonst bleibt deren Fehlbetrag
    # unerklärt — und ein unerklärter Fehlbetrag ist wertlos.
    offen_kN = sum(
        (last["wert"] * _laenge(last["polylinie"])) if "polylinie" in last
        else last["wert"]
        for last in offene_lasten)
    if offene_lasten:
        hinweise.append(
            f"{len(offene_lasten)} Lasten mit zusammen {offen_kN:.0f} kN haben kein "
            f"Fundament erreicht — sie standen über Deckenfeldern, die nicht "
            f"gerechnet werden konnten, oder über keinem.")
    verloren_kN = sum(n["kN"] for n in nicht_gerechnet)
    if nicht_gerechnet:
        hinweise.append(
            f"{len(nicht_gerechnet)} Deckenfelder nicht gerechnet — ihre eigene Last "
            f"(geschätzt {verloren_kN:.0f} kN) fehlt in der Kette: "
            + ", ".join(f"{n['geschoss']} / {n['platte']}" for n in nicht_gerechnet[:6])
            + (" …" if len(nicht_gerechnet) > 6 else "") + ".")

    # **Die Bodenplatte zählt hier nicht mit.** Die Erhaltungsprobe fragt, ob am
    # *Wandfuß* ankommt, was auf den Decken darüber eingetragen wurde. Die
    # Bodenplatte steht unter diesem Fuß: ihre eigene Last — Eigengewicht,
    # Ausbau, Nutzlast im Keller — geht direkt in den Baugrund und taucht in
    # keinem Wandkonto auf. Sie mitzuzählen ergäbe einen Fehlbetrag in genau
    # ihrer Höhe, und der sähe aus wie verlorene Last.
    #
    # Ausgewiesen wird sie trotzdem, als eigener Posten unter `gruendung`.
    # Mit Bodenplatte endet die Wandkette auf ihr: am Fuß zählt, was sie von
    # oben bekam (`lasten_von_oben_kN`), nicht nur die Konten des untersten
    # Geschosses — dort stehen auch Lasten, die durch ein Geschoss ohne Decke
    # durchgereicht wurden.
    am_fuss = (fund_ergebnis.lasten_von_oben_kN + gelaende_kN if fund_ergebnis is not None
               else gruendung["summe_kN"])
    bilanz = la.gesamtbilanz(
        konten.values(), arten, psi0,
        eingetragen_kN=sum(e.eingetragen_kN for e in ergebnisse
                           if e.kuerzel != sm.FUNDAMENT),
        gruendung_kN=am_fuss,
        nicht_abgesetzt_kN=offen_kN,
        nicht_gerechnet_kN=verloren_kN)
    melden(1.0, f"{len([e for e in ergebnisse if e.status == 'gerechnet'])} Geschosse gerechnet")

    eingriffsprotokoll = annahmen.get("_eingriffsprotokoll") or []
    gegriffen = {eintrag.get("nr") for p in eingriffsprotokoll
                 for eintrag in p["angewandt"]}
    for e in annahmen["_eingriffe"]:
        if e["nr"] in gegriffen:
            continue
        gruende = {eintrag["grund"] for p in eingriffsprotokoll
                   for eintrag in p["ohne_wirkung"] if eintrag.get("nr") == e["nr"]}
        hinweise.append(
            f"Der Eingriff '{e['art']}' an {e.get('bauteil') or 'ohne Bauteil'} hat "
            f"in keinem Submodell gegriffen"
            + (f" — {sorted(gruende)[0]}" if gruende else
               " — kein gerechnetes Submodell passte zu seiner Angabe."))

    lastfluss = {"geschosse": buch,
                 "gelaende_kN": round(gelaende_kN, 3),
                 "nicht_abgesetzt_kN": round(offen_kN, 3),
                 "nicht_gerechnet_kN": round(verloren_kN, 3)}
    lastfluss["text"] = lastfluss_text(lastfluss)
    for zeile in buch:
        if abs(zeile["rest_kN"]) > max(0.5, 1e-3 * sum(zeile["von_oben_kN"].values())
                                       + 1e-3 * sum(zeile["neu_kN"].values())):
            hinweise.append(
                f"Lastfluss {zeile['geschoss']}: das Geschoss geht nicht auf — "
                f"{zeile['rest_kN']:+.1f} kN zwischen dem, was hineingeht, und dem, was "
                f"es weitergibt.")

    liste = [k.als_dict(arten, psi0) for k in konten.values()]
    nach_bauteil: dict[str, list[int]] = {}
    for i, eintrag in enumerate(liste):
        if eintrag["global_id"]:
            nach_bauteil.setdefault(eintrag["global_id"], []).append(i)

    return {
        "geschosse": [
            {"name": e.name, "kuerzel": e.kuerzel,
             "status": e.status, "meldung": e.meldung,
             "bauteile": len(e.konten),
             "lasten_nach_unten": len(e.weiter_nach_unten),
             "eingetragen_kN": round(e.eingetragen_kN, 1),
             "platten": [{k: v for k, v in p.items() if k not in ("lo", "hi")}
                         for p in e.platten],
             "felder": e.berichte}
            for e in ergebnisse
        ],
        "konten": liste,
        "nach_bauteil": nach_bauteil,
        "gruendung": gruendung,
        "bilanz": bilanz,
        "lastfall_arten": arten,
        "psi0": psi0,
        "hinweise": hinweise,
        "nicht_gerechnet": nicht_gerechnet,
        "eingriffe": annahmen["_eingriffe"],
        "eingriffsprotokoll": eingriffsprotokoll,
        "lastfluss": lastfluss,
    }


def _geschossbuch(g: dict, erg, von_oben: list, nach_unten: list, konten: dict,
                  arten: dict, letztes: bool, durchgereicht: list | None = None,
                  neben_platten: list | None = None, dach: dict | None = None) -> dict:
    """
    Das Kassenbuch eines Geschosses: was hineingeht, was hinausgeht — je Art.

    **Hinein:** die Lasten von oben, was die Platten neu eintragen (Eigengewicht,
    Ausbau, Nutzlast, Dach), das Eigengewicht der Wände und Stützen dieses
    Geschosses. **Hinaus:** was nach unten weitergeht und — im untersten
    Geschoss ohne Bodenplatte — was die Bauteile in die Gründung geben. Der Rest
    muss null sein; sonst geht im Geschoss Last verloren oder entsteht.

    Gerechnet nach Art (G/Q), nicht nach Lastfall: ein Lastfall bleibt nicht,
    was er ist — die Wandlasten von oben (EG, AUS) heißen auf der Platte
    darunter „Lastabtrag ständig" (ABG).
    """
    von = _je_art(von_oben, arten)
    weiter = _je_art(nach_unten, arten)
    neu = {"G": 0.0, "Q": 0.0}
    for b in erg.berichte:
        for art, wert in _anteile_je_art(b.get("eingetragen_je_fall_kN") or {}, arten).items():
            neu[art] += wert
    steildach = None
    if dach:
        # Das Steildach trägt neu ein, was seine Sparren und Pfetten abgeben —
        # Art nach `dach.LASTFAELLE` (Schnee veränderlich, der Rest ständig).
        for last in dach["lasten"]:
            neu["Q" if last.get("art") == "Q" else "G"] += float(last["wert"])
        an: dict[str, float] = {}
        for last in dach["lasten"]:
            an[last.get("bezug") or ""] = an.get(last.get("bezug") or "", 0.0) + float(last["wert"])
        steildach = {
            "sparren": dach["sparren"], "traeger": dach["traeger"],
            "kN_je_fall": dach["kN_je_fall"],
            "an": sorted(({"global_id": gid or None,
                           "name": (konten[(gid, g["name"])].name
                                    if (gid, g["name"]) in konten else None)
                                   or next((p["name"] for p in dach["protokoll"]
                                            if p["global_id"] == gid), None) or gid,
                           "auf_bauteil": (gid, g["name"]) in konten,
                           "kN": round(v, 3)} for gid, v in an.items()),
                         key=lambda e: -e["kN"]),
        }
    eigen = sum(k.eigengewicht_kN for (gid, gn), k in konten.items() if gn == g["name"])
    in_gruendung = {"G": 0.0, "Q": 0.0}
    if letztes:
        for (gid, gn), k in konten.items():
            if gn == g["name"] and gid and k.rolle in ("wand", "stuetze"):
                for art, wert in _anteile_je_art(k.anteile(), arten).items():
                    in_gruendung[art] += wert
    hinein = von["G"] + von["Q"] + neu["G"] + neu["Q"] + eigen
    hinaus = weiter["G"] + weiter["Q"] + in_gruendung["G"] + in_gruendung["Q"]
    durch_kN = sum(_last_kN(l) for l in durchgereicht or [])
    neben_kN = sum(_last_kN(l) for l in neben_platten or []) if neben_platten is not None else None
    return {
        "geschoss": g["name"], "kuerzel": getattr(erg, "kuerzel", None),
        "status": erg.status,
        "von_oben_kN": {k: round(v, 3) for k, v in von.items()},
        "neu_kN": {k: round(v, 3) for k, v in neu.items()},
        "eigengewicht_kN": round(eigen, 3),
        "nach_unten_kN": {k: round(v, 3) for k, v in weiter.items()},
        "in_gruendung_kN": {k: round(v, 3) for k, v in in_gruendung.items()},
        # Was von oben auf keine Platte fiel: davon ging ein Teil direkt in
        # Wände/Stützen dieses Geschosses, der Rest unverändert weiter.
        "neben_platten_kN": round(neben_kN, 3) if neben_kN is not None else round(
            sum(von.values()), 3),
        "durchgereicht_kN": round(durch_kN, 3),
        "bauteile": len({gid for (gid, gn), k in konten.items()
                         if gn == g["name"] and gid and k.rolle in ("wand", "stuetze")}),
        "platten": list(erg.berichte),
        "steildach": steildach,
        "rest_kN": round(hinein - hinaus, 3),
    }


def lastfluss_text(lastfluss: dict) -> list[str]:
    """
    Wie die Last durch das Gebäude fließt — von oben nach unten, in Sätzen.

    Aus dem Kassenbuch (`_geschossbuch`), nicht neu gerechnet: was hier steht,
    ist dieselbe Buchung, die die Erhaltungsprobe prüft.
    """
    def z(v: float) -> str:
        return f"{v:,.1f}".replace(",", " ").replace(".", ",")

    def g_q(d: dict) -> str:
        return f"{z(d['G'] + d['Q'])} kN (ständig {z(d['G'])}, veränderlich {z(d['Q'])})"

    zeilen: list[str] = []
    for e in lastfluss.get("geschosse") or []:
        summe_von = sum(e["von_oben_kN"].values())
        kopf = f"{e['geschoss']}" + (" — Bodenplatte" if e.get("bodenplatte") else "")
        leer = (not e.get("platten") and not e["eigengewicht_kN"]
                and not sum(e["neu_kN"].values()) and not sum(e["in_gruendung_kN"].values()))
        if leer:
            # Eine Ebene ohne Decke und ohne Bauteile: nichts geschieht hier.
            if summe_von > 0.05 and abs(e["rest_kN"]) <= 0.5:
                zeilen.append(f"{kopf}: {z(summe_von)} kN gehen unverändert weiter "
                              f"(keine Decke, keine tragenden Bauteile).")
            elif abs(e["rest_kN"]) > 0.5:
                zeilen.append(f"{kopf}: Bilanz geht nicht auf, Rest {z(e['rest_kN'])} kN.")
            continue
        zeilen.append(f"{kopf}: von oben {g_q(e['von_oben_kN'])}.")
        sd_ = e.get("steildach")
        if sd_:
            je_fall = ", ".join(f"{k} {z(v)}" for k, v in sd_["kN_je_fall"].items() if v)
            an = sd_["an"]
            staerkste = ", ".join(f"{x['name']} {z(x['kN'])}" for x in an[:4])
            zeilen.append(
                f"  Steildach: {sd_['sparren']} Sparren und {sd_['traeger']} Pfetten/Wechsel "
                f"tragen {z(sum(sd_['kN_je_fall'].values()))} kN neu ein ({je_fall}) und geben "
                f"sie an {len(an)} Stellen ab ({staerkste}{' …' if len(an) > 4 else ''}).")
        for b in e.get("platten") or []:
            if b.get("status") != "gerechnet":
                zeilen.append(f"  {b.get('platte')}: nicht gerechnet — "
                              f"{b.get('grund') or 'siehe Hinweise'}.")
                continue
            je_fall = ", ".join(f"{k} {z(v)}" for k, v in (b.get("eingetragen_je_fall_kN")
                                                         or {}).items() if v)
            lager = b.get("lager_je_bauteil") or []
            summe_lager = sum(x["kN"] for x in lager)
            satz = (f"  {b.get('platte')} ({z(float(b.get('flaeche_m2') or 0))} m²): "
                    f"von oben {z(float(b.get('von_oben_kN') or 0))} kN")
            if b.get("durchleitung_kN"):
                satz += f", davon {z(b['durchleitung_kN'])} kN direkt durch die Decke in die Lager"
            satz += f"; neu {z(float(b.get('eingetragen_kN') or 0))} kN ({je_fall})"
            if lager:
                staerkste = ", ".join(f"{x['name']} {z(x['kN'])}" for x in lager[:3])
                satz += (f"; die Lager geben {z(summe_lager)} kN an {len(lager)} Bauteile"
                         f" ab ({staerkste}{' …' if len(lager) > 3 else ''})")
            zeilen.append(satz + ".")
        if not e.get("bodenplatte"):
            if e.get("neben_platten_kN") and summe_von:
                rest = e["neben_platten_kN"] - e.get("durchgereicht_kN", 0.0)
                teile = []
                if rest > 0.05:
                    teile.append(f"{z(rest)} kN stehen auf Wänden/Stützen dieses Geschosses")
                if e.get("durchgereicht_kN", 0.0) > 0.05:
                    teile.append(f"{z(e['durchgereicht_kN'])} kN gehen unverändert weiter")
                if teile:
                    zeilen.append(f"  Neben den Decken: {z(e['neben_platten_kN'])} kN — "
                                  + ", ".join(teile) + ".")
            if e["eigengewicht_kN"]:
                zeilen.append(f"  {e['bauteile']} Wände und Stützen wiegen "
                              f"{z(e['eigengewicht_kN'])} kN.")
        gr = e["in_gruendung_kN"]
        if gr["G"] + gr["Q"] > 0.05:
            zeilen.append(f"  In die Gründung: {g_q(gr)}.")
        if sum(e["nach_unten_kN"].values()) > 0.05:
            zeilen.append(f"  Nach unten: {g_q(e['nach_unten_kN'])}.")
        zeilen.append(f"  Bilanz des Geschosses: "
                      + ("geht auf" if abs(e["rest_kN"]) <= 0.5 else
                         f"Rest {z(e['rest_kN'])} kN") + ".")
    if lastfluss.get("gelaende_kN"):
        zeilen.append(f"Auf dem Gelände ohne Fundament: {z(lastfluss['gelaende_kN'])} kN.")
    if lastfluss.get("nicht_abgesetzt_kN"):
        zeilen.append(f"Nicht abgesetzt: {z(lastfluss['nicht_abgesetzt_kN'])} kN.")
    if lastfluss.get("nicht_gerechnet_kN"):
        zeilen.append(f"In nicht gerechneten Deckenfeldern: {z(lastfluss['nicht_gerechnet_kN'])} kN.")
    return zeilen


def _platte_rechnen(zugang, g, platte, decke, waende, annahmen, arten, psi0,
                    lasten_von_oben, konten, hinweise, melden, anteil_basis,
                    geschossindex, letztes, schnittlage=None,
                    submodellname="", raeume=None, trennwaende=None,
                    dach=False, nutzdecken=None, entlagert=None,
                    unterzuege=None, krone=None) -> dict | None:
    """
    Ein Submodell: Modell bauen, rechnen, Auflagerkräfte auf die Bauteile
    darunter buchen und ihre Fußkräfte für das Geschoss darunter vorbereiten.

    Herausgelöst aus `rechne_kette()`, seit ein Geschoss mehrere Deckenfelder
    haben kann. Jedes Feld ist ein Submodell mit eigenem Namen, eigener
    Rechnung und eigener Zeichnung; die Konten werden je (GlobalId, Geschoss)
    geführt, sodass eine Wand unter zwei Feldern beide Anteile sammelt.

    @param submodellname `submodell.OG2` bzw. `submodell.OG2.1` — der Anker,
                         an dem Rechenstand, Zeichnung und Eingriffe hängen
    @param raeume        die Räume, die auf der Platte stehen
    @param trennwaende   die nichttragenden Wände, die auf ihr stehen
    @param dach          nichts steht auf ihr — Dachlasten statt Nutzlast
    @param nutzdecken    [(Geschossindex, Polygon)] der Decken mit Nutzlast bis
                         einschließlich dieser — für n in α_n
    @param entlagert     GlobalIds, deren Lager ein Eingriff entfernt hat
    @returns None, wenn die Platte nicht rechenbar war und nichts weiterzugeben
             ist; sonst das Ergebnis (bei einer nicht rechenbaren Platte mit
             `verloren_kN`)
    """
    name = platte.get("name") or platte["global_id"]
    try:
        annahmen_g = dict(annahmen)
        # **Bettung gehört der Bodenplatte.** Wer sie in den Annahmen setzt,
        # meint den Baugrund; bis Oktober 2026 landete sie in jeder Decke, und
        # die Geschossdecken lagen auf Federn statt auf ihren Wänden (OPL:
        # 20–30 % Lastverlust je Geschoss, Durchbiegung um den Faktor 5–12 zu
        # klein).
        annahmen_g.pop("bettung_kNm3", None)
        annahmen_g.pop("bodengebettet", None)
        if platte.get("virtuell"):
            bl = platte["balkenlage"]
            annahmen_g["dicke_m"] = platte["dicke_m"]
            annahmen_g["dicke_quelle"] = (
                f"Balkenlage aus {bl['balken']} Balken b/h = {bl['breite_m']*100:.0f}/"
                f"{bl['hoehe_m']*100:.0f} cm, e = {bl['abstand_m']:.2f} m, als orthotrope "
                f"Ersatzplatte; Eigengewicht gemessen {bl['eigengewicht_kNm2']:.2f} kN/m²")
            annahmen_g["_ersatzplatte"] = ersatzplatte_werkstoff(bl, platte["dicke_m"])
            if bl.get("aufbau_kNm2"):
                annahmen_g["_aufbau_modell"] = {
                    "wert": bl["aufbau_kNm2"],
                    "quelle": "Bauteile der Deckenzone, die nicht aus Holz sind"}
        else:
            _plattenaufbau(annahmen_g, platte, name, zugang.boxen, "dicke_m")
        annahmen_g["_arten"] = dict(arten)
        annahmen_g["_psi0"] = dict(psi0)

        # Eingriffe wirken an zwei Stellen. `bauteil_tragend` muss **vor** der
        # Ableitung stehen: eine als nichttragend verworfene Wand ist im
        # fertigen Modell nicht mehr vorhanden, und was nicht da ist, lässt
        # sich nachträglich nicht mehr lagern. Alles Übrige legt sich danach
        # über das Modell.
        eingriffe = annahmen.get("_eingriffe") or []
        annahmen_g["_tragend_vorgabe"] = eg.tragend_vorgabe(eingriffe, submodellname)
        # Nutzlast je Raum: die Eingriffe (gesetzt in der Raumansicht) und
        # darüber, was die Anfrage ausdrücklich mitbringt — die genauere
        # Angabe gewinnt. Beides wirkt vor der Ableitung, wie `tragend`.
        annahmen_g["nutzlast_je_raum"] = {
            **eg.nutzlast_vorgabe(eingriffe, submodellname),
            **(annahmen.get("nutzlast_je_raum") or {}),
        }

        gebaut = tm.statikmodell(
            decke, waende, job_id=zugang.job_id, modellname=zugang.modellname,
            geschoss={**g, "decke": platte["z_unten"]},
            boxen=zugang.boxen, psets=zugang.psets,
            annahmen=annahmen_g, linienlasten=lasten_von_oben,
            platte_gid=platte["global_id"],
            raeume=raeume or [], trennwaende=trennwaende or [], dach=dach,
            unterzuege=unterzuege, kronen=krone)

        eingriffsprotokoll = eg.anwenden(gebaut["modell"], eingriffe,
                                         submodell=submodellname)
        if eingriffe:
            eingriffsprotokoll["submodell"] = submodellname
            gebaut["protokoll"]["eingriffe"] = eingriffsprotokoll
            annahmen.setdefault("_eingriffsprotokoll", []).append(eingriffsprotokoll)
            for text in eingriffsprotokoll["hinweise"]:
                hinweise.append(f"{submodellname}: {text}")

        # **Was auf einem Lager steht, geht direkt hinein** — nach den
        # Eingriffen, damit ein entferntes Lager nichts mehr aufnimmt.
        durch = durchleiten(gebaut["modell"], halbbreiten(gebaut["protokoll"]["waende"]))
        if durch:
            summe = sum(e["kN"] for e in durch)
            lager_ids = sorted({e["lager"] for e in durch})
            gebaut["protokoll"]["durchleitung"] = {
                "kN": round(summe, 3), "lasten": len(durch), "lager": lager_ids}
            gebaut["modell"].setdefault("hinweise", []).append(
                f"Von oben stehen {summe:.1f} kN auf den Lagern {', '.join(lager_ids)} "
                f"und gehen direkt hinein, ohne die Platte zu biegen.")

        # **Ränder ohne Lager** — Auskragung oder fehlendes Lager. Gemeldet,
        # nicht geändert: ob dort etwas trägt, weiß das Modell nicht.
        raender = freie_raender(gebaut["modell"])
        gebaut["protokoll"]["freie_raender"] = raender
        auffaellig = [st for st in raender["stuecke"]
                      if not st["zwischen_stuetzen"] or st["laenge_m"] > FREIER_RAND_STUETZEN_M]
        if auffaellig:
            laengster = auffaellig[0]
            hinweise.append(
                f"{submodellname}: {len(auffaellig)} Plattenrand/-ränder ohne Lager, "
                f"längster {laengster['laenge_m']:.1f} m (von {laengster['von']} bis "
                f"{laengster['bis']}) — Auskragung, oder fehlt dort ein Lager "
                f"(Glasfassade, nichttragende Wand, Unterzug nicht im Modell)?")

        # **Womit geschnitten wurde, wandert ins Modell.** Der Planbau im
        # Frontend (`tragwerk-plaene.js`) soll dieselbe Zeichnung bekommen, aus
        # der gerechnet wurde — nicht eine ähnliche, die er sich selbst
        # zusammenstellt.
        # **Der Submodellname wandert ins Modell.** Er ist der Anker, unter dem
        # Rechenstand, Zeichnung und Ergebniswolke abgelegt und wiedergefunden
        # werden.
        gebaut["modell"]["plan"]["submodell"] = submodellname
        # **Der Hash entsteht hier, nicht in der Ablage.** Er beschreibt die
        # Eingabe der Rechnung, und die steht genau an dieser Stelle
        # vollständig fest: Geometrie, Lager, Lasten, Eingriffe.
        #
        # **Nur die Eingriffe, die hier greifen.** `fuer_submodell()` gibt auch
        # die zurück, die ohne Ortsangabe überall gelten — ihre GlobalId kommt
        # aber nur in einem Geschoss vor, und wo sie ins Leere greifen, ändern
        # sie nichts an der Rechnung.
        gegriffen = {e.get("nr") for e in eingriffsprotokoll["angewandt"]}
        wirksam = [e for e in eingriffe if e.get("nr") in gegriffen]
        gebaut["modell"]["plan"]["eingabe_hash"] = sd.hash_der_eingabe(
            gebaut["modell"], eingriffe=wirksam,
            netzweite=annahmen.get("elementgroesse_m"))
        gebaut["modell"]["plan"]["art"] = sd.GESCHOSS
        if schnittlage:
            gebaut["modell"]["plan"]["schnittlage"] = schnittlage
    except ValueError as fehler:
        hinweise.append(f"{g['name']} / {name}: {fehler}")
        if lasten_von_oben:
            hinweise.append(
                f"{g['name']} / {name}: {len(lasten_von_oben)} Lasten werden "
                f"an das Geschoss darunter durchgereicht.")
        return {"eingetragen_kN": 0.0, "nach_unten": _ueber_nicht_gerechnet(lasten_von_oben),
                "verloren_kN": True,
                "bericht_kurz": {"submodell": submodellname, "platte": name,
                                 "status": "uebersprungen",
                                 "meldung": str(fehler)},
                "konten": []}

    for fall in gebaut["modell"]["lastfaelle"]:
        arten[fall["id"]] = fall.get("art", "G")
        psi0[fall["id"]] = float(fall.get("psi0", 0.7))
        psi0[f"{fall['id']}:psi2"] = float(fall.get("psi2", 0.3))
    annahmen["_arten"] = dict(arten)
    annahmen["_psi0"] = dict(psi0)

    # **Geometrisch, je Lastfläche** — nicht Fläche × Σ Lastwerte, siehe
    # `tm.eingetragene_lasten()`.
    eingetragen_je = tm.eingetragene_lasten(gebaut["modell"])
    eingetragen = sum(eingetragen_je.values())

    # **Ohne Lager keine Rechnung.** Nach den Eingriffen kann ein Feld ohne
    # jedes Auflager dastehen (das einzige Lager entfernt). Der Löser bräche an
    # der singulären Matrix ab — eine Attrappe oder ein nachsichtiger Löser
    # liefert dagegen null Reaktionen, und die ganze Last des Felds wäre still
    # fort. Hier wird es ausgesprochen: nicht gerechnet, die Lasten von oben
    # gehen durch, und die eigene Last steht als Fehlbetrag in der Bilanz.
    if not gebaut["modell"].get("auflager") and not any(
            f.get("bettung_kNm3") for f in gebaut["modell"].get("system") or []):
        text = ("nach den Eingriffen ohne Auflager — das Feld ist kinematisch und "
                "wird nicht gerechnet; seine eigene Last fehlt in der Kette")
        # `eingriffe.anwenden()` sagt es meist schon; zweimal muss es nicht stehen.
        if not any("kein Auflager" in h for h in eingriffsprotokoll["hinweise"]):
            hinweise.append(f"{g['name']} / {name}: {text}.")
        return {"eingetragen_kN": 0.0, "nach_unten": _ueber_nicht_gerechnet(lasten_von_oben),
                "verloren_kN": True,
                "bericht_kurz": {"submodell": submodellname, "platte": name,
                                 "status": "uebersprungen", "meldung": text},
                "konten": []}

    melden(anteil_basis + 0.02, f"{g['name']} / {name}: FE-Rechnung")
    try:
        bericht = zugang.rechne(gebaut["modell"], annahmen,
                                lambda a, t: melden(anteil_basis + 0.02, t))
    except Exception as fehler:  # noqa: BLE001
        hinweise.append(f"{g['name']} / {name}: Rechnung fehlgeschlagen ({fehler})")
        if lasten_von_oben:
            return {"eingetragen_kN": 0.0, "nach_unten": _ueber_nicht_gerechnet(lasten_von_oben),
                    "verloren_kN": True,
                    "bericht_kurz": {"submodell": submodellname, "platte": name,
                                     "status": "fehlgeschlagen", "meldung": str(fehler)},
                    "konten": []}
        return None

    # **Kinematisch, ohne dass der Löser es merkt.** Eine Platte auf einer
    # einzigen Lagerreihe, oder deren Lager neben ihr stehen, hat eine
    # singuläre Steifigkeitsmatrix. Der direkte Löser bricht daran nicht ab,
    # sondern liefert Verschiebungen von 10¹² mm und Reaktionen, die ein
    # Achtel der Last tragen (Vordach der LPH 4). Die Gleichgewichtsprobe
    # sieht das — hier wird sie gefragt: ein solches Feld gilt als nicht
    # gerechnet, die Lasten von oben gehen durch, und seine eigene Last steht
    # als Fehlbetrag in der Bilanz.
    probe = bericht.get("probe") or {}
    schlechteste = max((float(p.get("abweichung_rel") or 0.0) for p in probe.values()
                        if isinstance(p, dict)), default=0.0)
    if schlechteste > PROBE_GRENZE:
        text = (f"Gleichgewichtsprobe um {schlechteste:.0%} verfehlt — die Lager halten die "
                f"Platte nicht (kinematisch: eine einzige Lagerreihe, oder Lager neben der "
                f"Platte). Nicht gerechnet; ihre eigene Last fehlt in der Kette")
        hinweise.append(f"{g['name']} / {name}: {text}.")
        return {"eingetragen_kN": 0.0, "nach_unten": _ueber_nicht_gerechnet(lasten_von_oben),
                "verloren_kN": True,
                "bericht_kurz": {"submodell": submodellname, "platte": name,
                                 "status": "uebersprungen", "meldung": text},
                "konten": []}

    durchleitung_buchen(bericht, gebaut["modell"])
    protokoll = gebaut["protokoll"]
    kopf = protokoll["platte"]
    pakete = la.aus_auflagerbilanz(
        bericht, g["name"], kopf.get("global_id", ""),
        kopf.get("name") or f"Decke über {g['name']}")

    if not bericht.get("auflager_lastfallweise"):
        hinweise.append(
            f"{g['name']} / {name}: keine lastfallweise Auflagerbilanz im Bericht — "
            f"weitergereicht wird ein Bemessungswert, die Lasten darunter sind zu groß.")

    decke_konto = konten.setdefault(
        (kopf.get("global_id", ""), g["name"]), la.Konto(
            global_id=kopf.get("global_id", ""), ifc_type="IfcSlab",
            name=kopf.get("name") or f"Decke über {g['name']}",
            geschoss=g["name"], rolle="decke", tragend=True))
    decke_konto.geometrie = {
        "flaeche_m2": kopf.get("flaeche_m2"),
        "dicke_m": protokoll["dicke_m"],
        "dicke_quelle": protokoll["dicke_quelle"],
        "dach": bool(dach),
    }
    decke_konto.nachweis = _deckennachweis(bericht)

    wandinfo = {w["global_id"]: w for w in protokoll["waende"]}
    verschoben = {e.get("bauteil") for e in (protokoll.get("eingriffe") or {}).get("angewandt", [])
                  if e.get("art") == "lager_verschieben"}
    nach_unten: list[dict] = []
    eigene_konten: list[la.Konto] = []

    for gid, liste in pakete.items():
        info = wandinfo.get(gid, {})
        schluessel = (gid, g["name"])
        konto = konten.get(schluessel)
        if konto is None:
            hoehe = _hoehe_im_geschoss(
                zugang.boxen.get(gid), float(g["boden"]), platte["z_unten"],
                float(info.get("hoehe_m") or 0.0))
            konto = la.Konto(
                global_id=gid,
                ifc_type=info.get("ifc_type", ""),
                name=info.get("name") or ("nicht zugeordnet" if not gid else gid),
                geschoss=g["name"],
                rolle=info.get("rolle", "wand" if gid else "unbekannt"),
                tragend=info.get("tragend"),
                geometrie={**{k: info.get(k) for k in
                              ("dicke_tragend_m", "dicke_gesamt_m", "laenge_m",
                               "flaeche_m2", "schichten", "mehrschichtig")},
                           "hoehe_m": round(hoehe, 3)},
                geschosse_darueber=0,
            )
            konten[schluessel] = konto
            # Das Eigengewicht zählt einmal je Bauteil und Geschoss, auch wenn
            # die Wand zwei Deckenfelder trägt — sonst stünde es doppelt in der
            # Bilanz und die Erhaltungsprobe schlüge an.
            laenge = float(info.get("laenge_m") or 0.0)
            # **Die Wichte muss mit.** Ohne sie greift der Vorgabewert 25 kN/m³,
            # und jede Holzständerwand wiegt so viel wie eine Betonwand — bei
            # einem Holzbau das Fünffache, quer durch die ganze Kette bis in
            # die Gründungslast.
            wichte, aus_modell = la.wichte_tragend(
                info.get("materialklasse"), konto.rolle)
            if info.get("wichte_kNm3") is not None:
                wichte = float(info["wichte_kNm3"])
                aus_modell = bool(info.get("wichte_aus_modell", aus_modell))
                if info.get("wichte_quelle"):
                    konto.hinweise.append(f"Eigengewicht {info['wichte_quelle']}.")
            volumen = _volumen_im_geschoss(info, zugang.boxen.get(gid), hoehe)
            if volumen is not None:
                konto.eigengewicht_kN = volumen * wichte
                konto.geometrie["volumen_m3"] = round(volumen, 4)
            elif konto.rolle == "stuetze":
                konto.eigengewicht_kN = la.eigengewicht_stuetze(
                    hoehe, float(info.get("flaeche_m2") or 0.0), wichte)
            else:
                konto.eigengewicht_kN = la.eigengewicht_wand(
                    laenge, hoehe, float(info.get("dicke_gesamt_m") or 0.0),
                    wichte,
                    oeffnungsanteil=float(annahmen.get("oeffnungsanteil", 0.0)))
            konto.wichte_kNm3 = wichte
            if info.get("staender_kN"):
                konto.eigengewicht_kN += float(info["staender_kN"])
                konto.hinweise.append(
                    f"Eigengewicht mit {len(info.get('staender') or [])} Ständern "
                    f"({float(info['staender_kN']):.1f} kN), die als eigene Stützen im "
                    f"Modell stehen.")
            if not aus_modell:
                konto.hinweise.append(
                    f"Werkstoff nicht erkannt — Eigengewicht mit "
                    f"{wichte:.0f} kN/m³ (Stahlbeton) angesetzt. Das ist die "
                    f"sichere Seite; bei Holz oder Mauerwerk wiegt das Bauteil "
                    f"deutlich weniger.")
        konto.eingang.extend(liste)
        konto.geschosse_darueber = max(
            konto.geschosse_darueber,
            _nutzgeschosse(_lagergeometrien(gebaut["modell"], gid, info), nutzdecken))
        eigene_konten.append(konto)

        if not gid:
            konto.hinweise.append(
                "Auflager ohne Bauteilbezug — die Kraft ist gebucht, aber keiner "
                "Wand zugeordnet und wird nicht weitergereicht.")
            continue
        konto.nachweis = _bauteilnachweis(konto, {**info, "hoehe_m": konto.geometrie.get("hoehe_m")},
                                          annahmen)

    bericht_kurz = {"submodell": submodellname, "platte": name,
                    "status": "gerechnet",
                    "eingabe_hash": gebaut["modell"]["plan"]["eingabe_hash"],
                    "flaeche_m2": kopf.get("flaeche_m2"),
                    "eingetragen_kN": round(eingetragen, 1),
                    "auflager": len(gebaut["modell"]["auflager"]),
                    "eingriffe": len(eingriffsprotokoll["angewandt"]),
                    "lasten_von_oben": len(lasten_von_oben),
                    "dach": bool(dach), "raeume": len(raeume or []),
                    "trennwaende": len(trennwaende or []),
                    "freier_rand_m": raender["frei_m"],
                    "freier_rand_laengstes_m": raender["laengstes_m"],
                    # Der Lastfluss durch dieses Feld (`lastfluss()`): was von
                    # oben kam, was davon direkt in die Lager ging, was neu
                    # dazukam und welches Bauteil wie viel bekam.
                    "von_oben_kN": round(sum(_last_kN(l) for l in lasten_von_oben), 3),
                    "durchleitung_kN": round(float((bericht.get("durchleitung") or {})
                                                   .get("kN") or 0.0), 3),
                    "eingetragen_je_fall_kN": {k: round(v, 3)
                                               for k, v in sorted(eingetragen_je.items())},
                    "lager_je_bauteil": _lager_je_bauteil(pakete, konten, g["name"]),
                    **_lagerguete(bericht)}

    # ── Weitergabe nach unten ────────────────────────────────────────────
    #
    # Erst nachdem alle Pakete dieser Platte gebucht sind: eine Wand kann von
    # zwei Feldern Last bekommen, und weitergereicht wird die Summe.
    if letztes:
        for konto in eigene_konten:
            if konto.global_id and konto.rolle in ("wand", "stuetze"):
                konto.hinweise.append(
                    "Unterstes Geschoss — die Fußkraft geht in die Gründung.")
        return {"eingetragen_kN": eingetragen, "nach_unten": [],
                "bericht_kurz": bericht_kurz,
                "konten": eigene_konten, "bericht": bericht,
                "modell": gebaut["modell"]}

    for gid, liste in pakete.items():
        if not gid:
            continue
        konto = konten[(gid, g["name"])]
        # Was diese Platte beisteuert, nicht der ganze Kontostand: die Wand
        # gibt ihre Summe genau einmal weiter, und das geschieht beim letzten
        # Feld, das sie berührt. Hier wandert deshalb nur der Anteil dieser
        # Platte plus — beim ersten Mal — das Eigengewicht.
        anteil: dict[str, float] = {}
        for paket in liste:
            for kennung, wert in paket.anteile_kN.items():
                anteil[kennung] = anteil.get(kennung, 0.0) + wert
        if not konto._eigengewicht_weitergegeben:
            anteil[la.EIGENGEWICHT] = (anteil.get(la.EIGENGEWICHT, 0.0)
                                       + konto.eigengewicht_kN)
            konto._eigengewicht_weitergegeben = True

        # **Entlang der eigenen Achse.** Bis Oktober 2026 wurden die Lager mit
        # `bauteile == [gid]` gesucht. Ein Lager aus mehreren Wandstücken
        # (`lager_zusammenfuehren()`, ein Wandzug, den das Autorenwerkzeug in
        # fünf Bauteile zerlegt hat) trägt aber alle fünf — die Suche fand
        # keines, und die Last dieser Wände ging **gar nicht** nach unten.
        # Jede Wand gibt jetzt auf ihren eigenen Achsen weiter, wie sie vor dem
        # Zusammenführen lagen.
        # Ein Lager, das nur diese Wand trägt, geht vor: auf ihm wirkt ein
        # Eingriff `lager_verschieben`, und die Fußkraft gehört dorthin, wo die
        # Wand jetzt trägt.
        info = wandinfo.get(gid, {})
        polylinien = [a["polylinie"] for a in gebaut["modell"]["auflager"]
                      if (a.get("bauteile") or []) == [gid] and "polylinie" in a]
        # Lager auf der Wandkrone (über Stürzen), Fußkraft durch die Pfeiler —
        # außer ein Eingriff hat das Lager verschoben: dann trägt die Wand dort.
        if info.get("fuss_achsen") and gid not in verschoben:
            polylinien = [p for p in info["fuss_achsen"] if len(p) >= 2]
        if not polylinien:
            polylinien = [p for p in (info.get("achsen") or []) if len(p) >= 2]
        if not polylinien:
            polylinien = [a["polylinie"] for a in gebaut["modell"]["auflager"]
                          if gid in (a.get("bauteile") or []) and "polylinie" in a]
        gesamt = sum(_laenge(p) for p in polylinien)
        if gesamt < 1e-6:
            punkte = ([info["punkt"]] if info.get("punkt") else
                      [a["p"] for a in gebaut["modell"]["auflager"]
                       if gid in (a.get("bauteile") or []) and "p" in a])
            for pkt in punkte:
                for kennung, wert in anteil.items():
                    nach_unten.append({
                        "typ": "punkt", "p": pkt, "wert": wert / len(punkte),
                        "lastfall": kennung, "art": arten.get(kennung, "G"),
                        "bezug": gid,
                        "herkunft": f"Stützenfuß {konto.name} ({g['name']})",
                    })
            continue

        for polylinie in polylinien:
            teil = _laenge(polylinie) / gesamt
            for kennung, wert in anteil.items():
                if abs(wert) < 1e-9:
                    continue
                nach_unten.append({
                    "polylinie": polylinie,
                    "wert": wert * teil / _laenge(polylinie),
                    "lastfall": kennung,
                    "art": arten.get(kennung, "G"),
                    "bezug": gid,
                    "herkunft": f"Wandfuß {konto.name} ({g['name']})",
                })

    return {"eingetragen_kN": eingetragen, "nach_unten": nach_unten,
            "bericht_kurz": bericht_kurz,
            "konten": eigene_konten, "bericht": bericht,
            "modell": gebaut["modell"]}


def _bodenplatte_rechnen(zugang, geschosse, fundamente, lasten_von_oben,
                         annahmen, arten, psi0, konten, hinweise,
                         melden, waende_darauf=None) -> "Geschossergebnis | None":
    """
    Die Bodenplatte: elastisch gebettet, ohne Auflager.

    **Warum sie nicht wie ein Geschoss läuft.** Eine Geschossdecke bekommt ihre
    Lager aus den Wänden darunter. Unter der Bodenplatte steht keine Wand,
    sondern Boden — die Lagerung ist flächig und nachgiebig, nicht punkt- oder
    linienförmig und starr. Die Wände *über* ihr sind keine Auflager, sondern
    die Last: ihre Fußkräfte drücken auf die Platte, und der Boden hält
    dagegen.

    Genau darum wird hier kein Wandschnitt gemacht. `statikmodell()` bekommt
    für die Wandfiguren eine leere Antwort und für die Lasten die Fußkräfte;
    die Bettung ersetzt die Auflager. **Auf ihr stehen** die Räume des
    untersten Geschosses (seine Nutzlast) und seine nichttragenden Wände
    (Trennwandzuschlag) — bis Oktober 2026 bekam sie beides nicht.

    **Ohne Bettung gibt es diese Rechnung nicht.** `plate.randbedingungen()`
    ließe ein System ohne jedes Lager nicht zu, und das ist richtig: es wäre
    kinematisch. Deshalb ist der Bettungsmodul hier keine Option — fehlt er,
    tritt der Vorschlagswert ein und steht als Annahme im Bericht.

    @returns Geschossergebnis der Gründung, oder None wenn nichts rechenbar war
    """
    erg = Geschossergebnis(name="Gründung", kuerzel=sm.FUNDAMENT)
    erg.platten = fundamente
    unterstes = min(geschosse, key=lambda x: float(x["boden"]))
    waende_darauf = waende_darauf or []

    bettung = float(annahmen.get("bettung_kNm3") or BETTUNG_VORSCHLAG_KNM3)
    if not annahmen.get("bettung_kNm3"):
        hinweise.append(
            f"Bodenplatte: Bettungsmodul nicht angegeben — angesetzt sind "
            f"{bettung:.0f} kN/m³ (mitteldicht gelagerter Sand/Kies). Die "
            f"Sohlspannung folgt diesem Wert fast linear; wer den Baugrund "
            f"kennt, sollte ihn setzen.")

    submodelle = {p["global_id"]: n
                  for n, p in sm.namen_fuer(sm.FUNDAMENT, fundamente)}

    # Erst schneiden, dann verteilen: die Fußkräfte gehören auf die Sohle,
    # über der sie stehen, und das entscheidet ihr Umriss.
    schnitte = {}
    for platte in fundamente:
        try:
            box = _box_fuer(zugang.huelle,
                            {**unterstes, "boden": platte["z_unten"],
                             "decke": platte["z_oben"]}, mindesthoehe=0.0)
            schnitte[platte["global_id"]] = (box, zugang.schnitt(
                box, "grundriss", platte["z_mitte"] - box["z_unten"]))
        except Exception as fehler:  # noqa: BLE001
            hinweise.append(f"Gründung / {platte.get('name')}: Schnitt misslungen ({fehler})")
    polygone = {gid: plattenpolygon(s[1], gid, next(p for p in fundamente
                                                     if p["global_id"] == gid))
                for gid, s in schnitte.items()}
    je_platte, uebrig = lasten_verteilen(lasten_von_oben, fundamente, polygone or None)
    if uebrig:
        hinweise.append(
            f"Gründung: {len(uebrig)} Wandfußkräfte liegen über keiner "
            f"Bodenplatte und erreichen den Baugrund nicht.")
    erg.weiter_nach_unten = list(uebrig)
    erg.lasten_von_oben_kN = 0.0

    gerechnet = 0
    for platte in fundamente:
        name = platte.get("name") or platte["global_id"]
        submodellname = submodelle[platte["global_id"]]
        if platte["global_id"] not in schnitte:
            erg.weiter_nach_unten.extend(je_platte.get(platte["global_id"], []))
            continue
        box, decke = schnitte[platte["global_id"]]
        poly = polygone.get(platte["global_id"])
        try:
            annahmen_p = dict(annahmen)
            # **Die Deckendicke gilt hier nicht.** Wer „22 cm" vorgibt, meint
            # die Geschossdecken; eine Bodenplatte ist regelmäßig dicker, und
            # ihre Dicke geht mit der dritten Potenz in die Steifigkeit ein.
            eigene = annahmen.get("bodenplatte_dicke_m")
            annahmen_p["dicke_m"] = float(eigene) if eigene else None
            annahmen_p["dicke_quelle"] = f"vorgegeben ({eigene} m)" if eigene else None
            _plattenaufbau(annahmen_p, platte, name, zugang.boxen, "dicke_m")
            annahmen_p["bettung_kNm3"] = bettung
            annahmen_p["bodengebettet"] = True
            annahmen_p["_arten"] = dict(arten)
            annahmen_p["_psi0"] = dict(psi0)
            # Keine Wände: was über der Bodenplatte steht, ist ihre Last und
            # nicht ihr Lager. Ein Schnitt auf Wandhöhe lieferte hier die Wände
            # des Kellers, und die als Auflager anzusetzen hieße, die Platte
            # auf sich selbst zu lagern.
            leer = {"figures": [], "plane_origin": [0, 0, platte["z_mitte"]],
                    "bounds": [0, 0, 0, 0]}
            lasten = je_platte.get(platte["global_id"], [])
            gebaut = tm.statikmodell(
                decke, leer, job_id=zugang.job_id, modellname=zugang.modellname,
                geschoss={**unterstes, "name": "Gründung",
                          "decke": platte["z_unten"]},
                boxen=zugang.boxen, psets=zugang.psets,
                annahmen=annahmen_p, linienlasten=lasten,
                platte_gid=platte["global_id"],
                raeume=zugang.raeume_auf(platte, zugang.geschosse),
                trennwaende=[w for w in waende_darauf
                             if w["tragend"] is False and _ueber(w, poly)])
            gebaut["modell"]["plan"]["submodell"] = submodellname
            # Auf der Bodenplatte greift kein Eingriff am System — sie hat
            # keine Auflager, die sich entfernen ließen. Was sie ändert, sind
            # ihre Lasten von oben, und die stecken bereits im Modell.
            gebaut["modell"]["plan"]["eingabe_hash"] = sd.hash_der_eingabe(
                gebaut["modell"],
                netzweite=annahmen.get("elementgroesse_m"))
            gebaut["modell"]["plan"]["art"] = sd.GESCHOSS
        except ValueError as fehler:
            hinweise.append(f"Gründung / {name}: {fehler}")
            erg.weiter_nach_unten.extend(je_platte.get(platte["global_id"], []))
            continue

        for fall in gebaut["modell"]["lastfaelle"]:
            arten[fall["id"]] = fall.get("art", "G")
            psi0[fall["id"]] = float(fall.get("psi0", 0.7))

        eingetragen_je = tm.eingetragene_lasten(gebaut["modell"])
        eingetragen = sum(eingetragen_je.values())

        melden(0.94, f"{submodellname}: FE-Rechnung (gebettet)")
        try:
            bericht = zugang.rechne(gebaut["modell"], annahmen_p, melden)
        except Exception as fehler:  # noqa: BLE001
            hinweise.append(f"Gründung / {name}: Rechnung misslungen ({fehler})")
            erg.weiter_nach_unten.extend(lasten)
            continue

        gerechnet += 1
        erg.eingetragen_kN += eingetragen
        # Was die Sohle von oben bekam — das Ende der Wandkette.
        erg.lasten_von_oben_kN += sum(
            (l["wert"] * _laenge(l["polylinie"])) if "polylinie" in l else l["wert"]
            for l in lasten)
        erg.berichte.append({
            "submodell": submodellname, "platte": name, "status": "gerechnet",
            "eingabe_hash": gebaut["modell"]["plan"]["eingabe_hash"],
            "flaeche_m2": gebaut["modell"]["system"][0].get("flaeche_m2"),
            "eingetragen_kN": round(eingetragen, 1),
            "gebettet": True, "bettung_kNm3": bettung,
            "lasten_von_oben": len(lasten),
            "von_oben_kN": round(sum(_last_kN(l) for l in lasten), 3),
            "eingetragen_je_fall_kN": {k: round(v, 3) for k, v in sorted(eingetragen_je.items())},
            **_lagerguete(bericht),
        })

    if not gerechnet:
        erg.status = "uebersprungen"
        erg.meldung = (f"Keine der {len(fundamente)} Bodenplatten war "
                       f"rechenbar.")
        hinweise.append(f"Gründung: {erg.meldung}")
        return erg

    erg.status = "gerechnet"
    return erg


def _laenge(polylinie) -> float:
    import math
    return sum(math.hypot(polylinie[i + 1][0] - polylinie[i][0],
                          polylinie[i + 1][1] - polylinie[i][1])
               for i in range(len(polylinie) - 1))


#: Ab dieser Linienlast ist ein Wandauflager kein Rechenergebnis mehr, sondern
#: ein Artefakt. Eine 24-cm-Wand aus C25/30 trägt unbewehrt rund 1 800 kN/m;
#: das Doppelte davon kann keine Wand des Hochbaus abnehmen.
LINIENLAST_GRENZE_KNM = 3000.0


def _lagerguete(bericht: dict) -> dict:
    """
    Wie brauchbar die Auflagerkräfte dieser Platte sind.

    **Warum das gemessen werden muss.** Die Auflager entstehen aus
    Wandquerschnitten, nicht aus einem Tragwerksmodell. Bei einem realen
    Grundriss mit vielen kurzen Wandstücken ist die Lagerung damit
    hochgradig statisch unbestimmt: einzelne kurze Lager ziehen Kräfte an,
    benachbarte heben ab, und die Summe stimmt trotzdem — die
    Gleichgewichtsprobe schlägt nicht an, weil sie nur prüft, ob die Reaktionen
    zur Last passen.

    An einem geprüften Modell kam so eine 1,60 m lange Wand auf 7 568 kN,
    also 4 730 kN/m, während die Nachbarwand mit −4 134 kN abhob. Beide Zahlen
    sind Zwängungsartefakte. Für die Gesamtbilanz sind sie harmlos, für den
    Nachweis der einzelnen Wand wertlos — und ohne Kennzeichnung sähen sie aus
    wie Ergebnisse.

    @returns Kennzahlen für den Bericht: abhebende Lager, Spitzenlast, Urteil
    """
    bilanz = bericht.get("auflager") or []
    if not bilanz:
        return {}

    linien = [e for e in bilanz if (e.get("laenge_m") or 0) > 1e-6]
    abhebend = [e for e in bilanz if float(e.get("R_z_kN") or 0.0) < -1.0]
    spitzen = [abs(float(e.get("R_je_m_kNm") or 0.0)) for e in linien]
    spitze = max(spitzen, default=0.0)
    ueberzogen = [e["id"] for e in linien
                  if abs(float(e.get("R_je_m_kNm") or 0.0)) > LINIENLAST_GRENZE_KNM]

    # Der Anteil abhebender Kraft an der gesamten drückenden — das schärfste
    # Maß dafür, wie sehr sich die Lager gegeneinander verspannen.
    hoch = sum(max(float(e.get("R_z_kN") or 0.0), 0.0) for e in bilanz)
    tief = sum(-min(float(e.get("R_z_kN") or 0.0), 0.0) for e in bilanz)
    zwang = tief / hoch if hoch > 1e-6 else 0.0

    if zwang > 0.25 or ueberzogen:
        urteil = "unbrauchbar"
    elif zwang > 0.08 or spitze > LINIENLAST_GRENZE_KNM / 2:
        urteil = "fraglich"
    else:
        urteil = "brauchbar"

    return {
        "lager_abhebend": len(abhebend),
        "lager_gesamt": len(bilanz),
        "zwanganteil": round(zwang, 3),
        "spitze_kN_je_m": round(spitze, 1),
        "lager_ueberzogen": ueberzogen[:8],
        "lagerguete": urteil,
    }


def _deckennachweis(bericht: dict) -> dict:
    """Die Kennzahlen der Deckenrechnung, verdichtet für das Bauteilkonto."""
    nachweise = bericht.get("nachweise", {}) or {}
    d = bericht.get("durchbiegung", {}) or {}
    return {
        "art": "Platte, FE-Rechnung",
        "ausnutzung": round(max(nachweise.values()), 3) if nachweise else None,
        "erfuellt": not bericht.get("nachweise_offen"),
        "offen": bericht.get("nachweise_offen", []),
        "durchbiegung_mm": d.get("w_elastisch_mm"),
        "durchbiegung_grenzwert_mm": d.get("grenzwert_mm"),
        "einzelnachweise": {k: round(float(v), 3) for k, v in nachweise.items()},
    }


def _bauteilnachweis(konto: la.Konto, info: dict, annahmen: dict) -> dict | None:
    """
    Knicknachweis für eine Wand oder Stütze aus dem, was im Konto steht.

    Der Bemessungswert entsteht hier und nur hier — aus den charakteristischen
    Anteilen des Kontos, mit einer einzigen Kombination. Weiter nach unten
    wandern die Anteile, nicht dieses Ergebnis.
    """
    hoehe = float(info.get("hoehe_m") or 0.0)
    if hoehe < 0.3:
        konto.hinweise.append("Bauteilhöhe unbekannt — kein Knicknachweis geführt.")
        return None

    arten = {la.EIGENGEWICHT: "G"}
    arten.update(annahmen.get("_arten", {}))
    bem = la.bemessungswert(konto.anteile(), arten, annahmen.get("_psi0"),
                            geschosse_darueber=konto.geschosse_darueber)
    N_Ed = bem["N_Ed_kN"]
    guete = annahmen.get("beton") or "C25/30"

    try:
        if konto.rolle == "stuetze":
            flaeche = float(info.get("flaeche_m2") or 0.0)
            # 0,01 m² = 10 × 10 cm: darunter ist es keine Stütze, sondern ein
            # Rest aus dem Schnitt — eine Kante, ein Anker, ein Fragment.
            if flaeche < 0.01:
                konto.hinweise.append(
                    f"Stützenquerschnitt {flaeche*10000:.0f} cm² — zu klein für einen "
                    f"Nachweis. Aus dem Schnitt nicht als Querschnitt erkennbar.")
                return None
            # Aus der Querschnittsfläche einen quadratischen Ersatzquerschnitt:
            # die tatsächlichen Kantenlängen stehen im Schnitt, aber welche
            # davon die schwache Achse ist, hängt an der Lagerung. Quadratisch
            # ist dabei die ungünstigste Annahme nicht — sie ist die mittlere.
            seite = flaeche ** 0.5
            return st.nachweis(N_Ed, 0.0, seite, seite,
                               l_0_m=hoehe, beton_=guete)

        dicke = float(info.get("dicke_tragend_m") or 0.0)
        if dicke < 0.05:
            konto.hinweise.append("Wanddicke unbekannt — kein Knicknachweis geführt.")
            return None
        laenge = konto.laenge_m or float(info.get("laenge_m") or 1.0)
        N_je_m = N_Ed / laenge if laenge > 1e-6 else N_Ed
        if info.get("aufbau") and len(info["aufbau"]) > 1:
            konto.hinweise.append(
                f"Mehrschichtiger Aufbau ({len(info['aufbau'])} Schichten) — der "
                f"Knicknachweis läuft über die tragende Schicht ({dicke*100:.1f} cm), "
                f"das Eigengewicht über alle Schichten.")
        elif info.get("mehrschichtig"):
            konto.hinweise.append(
                f"Mehrschichtiger Aufbau {info.get('schichten')} — der Knicknachweis "
                f"läuft über die dickste Schicht ({dicke*100:.1f} cm), das Eigengewicht "
                f"über die Gesamtdicke ({info.get('dicke_gesamt_m', 0)*100:.1f} cm).")
        return wd.nachweis_mit_bewehrung(
            N_je_m, dicke, hoehe, guete,
            halterung=annahmen.get("halterung", "zweiseitig"), laenge_m=laenge)
    except Exception as fehler:  # noqa: BLE001 — ein Nachweis darf die Kette nicht kippen
        konto.hinweise.append(f"Nachweis nicht führbar: {fehler}")
        logger.warning(
            "Nachweis misslungen — %s %s (%s, %s): %s. Geometrie: %s",
            konto.rolle, konto.name or konto.global_id, konto.geschoss,
            konto.ifc_type, fehler,
            {k: info.get(k) for k in ("dicke_tragend_m", "laenge_m", "hoehe_m",
                                      "flaeche_m2")})
        return None


def _gruendung(konten: dict, geschosse: list, hinweise: list) -> dict:
    """
    Was am Fuß der Kette ankommt, je Bauteil des untersten gerechneten Geschosses.

    Kein Nachweis der Gründung selbst — dafür fehlen Baugrund, Sohlfläche und
    Einbindetiefe. Was hier steht, ist die Eingangsgröße dafür.
    """
    if not geschosse:
        return {"bauteile": [], "summe_kN": 0.0}
    # Das unterste Geschoss **mit tragenden Bauteilen**: eine Gründungsebene
    # („Fundament", „UK Bodenplatte") hat keine, und ihre leere Liste sagte
    # „keine lastabtragenden Bauteile gefunden", während die Wände des
    # Erdgeschosses darüber ihre Last längst abgegeben hatten.
    mit_waenden = {k.geschoss for k in konten.values() if k.rolle in ("wand", "stuetze")}
    unterstes = next((g["name"] for g in reversed(geschosse) if g["name"] in mit_waenden),
                     geschosse[-1]["name"])
    lasten = []
    for konto in konten.values():
        if konto.geschoss != unterstes or konto.rolle not in ("wand", "stuetze"):
            continue
        anteile = konto.ausgang()
        lasten.append({
            "global_id": konto.global_id,
            "name": konto.name,
            "rolle": konto.rolle,
            "anteile_kN": {k: round(v, 2) for k, v in anteile.items()},
            "N_k_kN": round(sum(anteile.values()), 2),
            "laenge_m": round(konto.laenge_m, 2),
            "N_k_je_m_kN": (round(sum(anteile.values()) / konto.laenge_m, 2)
                            if konto.laenge_m > 1e-6 else None),
        })
    lasten.sort(key=lambda x: x["N_k_kN"], reverse=True)
    if not lasten:
        hinweise.append(
            f"Im untersten Geschoss \"{unterstes}\" wurden keine lastabtragenden "
            f"Bauteile gefunden — die Gründungslasten bleiben leer.")
    return {
        "geschoss": unterstes,
        "bauteile": lasten,
        "summe_kN": round(sum(x["N_k_kN"] for x in lasten), 1),
    }
