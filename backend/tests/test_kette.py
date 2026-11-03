"""
Prüfstein für den geschossweisen Lastabtrag.

Ohne IFC-Datei und ohne JAX: Die Kette fragt ihre Umgebung nur über `Zugang`
ab, und beide Rückrufe — Schnitt und Rechnung — lassen sich nachstellen. Genau
darin liegt der Wert dieses Tests. Bei einer echten FE-Rechnung wäre nicht
unterscheidbar, ob eine Abweichung aus dem Solver kommt oder aus der Buchung;
hier verteilt die Attrappe die Last nach einer Regel, die sich von Hand
nachrechnen lässt, und jede Differenz gehört der Kette.

Geprüft werden die vier Aussagen, an denen ein Lastabtrag scheitert:

1. **Reihenfolge** — von oben nach unten, sonst steht in jeder Wand nur die
   Decke unmittelbar darüber.
2. **Erhaltung** — was oben eingetragen wird, kommt unten an. Kein Auflager
   ohne Bauteilbezug, keine Wand ohne Fortsetzung, kein stiller Verlust.
3. **Keine doppelten Sicherheitsbeiwerte** — die Anteile wandern
   charakteristisch, γ steht am Ende genau einmal darin.
4. **Anwachsen** — die Kraft im Erdgeschoss ist größer als die im Obergeschoss,
   und zwar um genau das, was dazwischen liegt.

Ausführen:  python3 tests/test_kette.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import kette, lastabtrag as la, tragwerksmodell as tm  # noqa: E402

# ── Der Prüfkörper ────────────────────────────────────────────────────────
#
# **Zwei** Baukörper zu drei Geschossen à 3,00 m, umlaufende Außenwand 24 cm.
# Bewusst ohne Innenwand: dann trägt jede Decke ihre Last vollständig auf vier
# Wandseiten ab, und die Summe ist ohne Zwischenrechnung bekannt.
#
# **Warum zwei Baukörper.** Ein Geschoss hat nicht eine Decke, sondern so viele
# Deckenfelder wie das Gebäude Abschnitte hat. Eine frühere Fassung rechnete je
# Geschoss nur die flächengrößte Platte — und verlor damit die gesamte Last des
# anderen Baukörpers, weil dessen Wandlasten außerhalb des Systemumrisses
# lagen und von `plate._anteile()` stillschweigend verworfen wurden. Am realen
# Modell (zwei Baukörper, 87 m Gesamtlänge) zeigte die Erhaltungsprobe 79 %
# Fehlbetrag. Mit nur einem Baukörper im Prüfkörper wäre der Fehler nie
# aufgefallen.

BREITE, TIEFE = 10.0, 8.0
#: Der zweite Baukörper: schmaler, um 20 m versetzt.
BREITE_B, VERSATZ_B = 6.0, 20.0
DICKE_WAND = 0.24
GESCHOSSHOEHE = 3.00
DECKENDICKE = 0.20
AUSBAU = 1.5
NUTZ = 1.5

GESCHOSSE = [
    {"name": "EG", "boden": 0.0, "decke": 3.0},
    {"name": "1.OG", "boden": 3.0, "decke": 6.0},
    {"name": "2.OG", "boden": 6.0, "decke": 9.0},
]

# **Der Fußbodenaufbau ist Teil des Prüfkörpers.** Die Elevation eines
# Geschosses ist die Oberkante des fertigen Fußbodens; die Rohdecke liegt um
# den Estrichaufbau tiefer. Hier 18 cm — dieselbe Größenordnung wie in dem
# realen Modell, an dem die erste Fassung der Kette restlos scheiterte, weil
# sie „Elevation minus 5 cm" schnitt und damit über jeder Platte lag.
AUFBAU = 0.18

#: Rohdecke über jedem Geschoss: Unterkante und Oberkante.
DECKENLAGE = {g["name"]: (g["decke"] - AUFBAU - DECKENDICKE, g["decke"] - AUFBAU)
              for g in GESCHOSSE}

# Je Geschoss eine eigene Wand — so führen es reale Modelle, und nur so
# lässt sich prüfen, dass die Kette zwischen den Geschossen richtig übergibt.
#: Je Geschoss und Baukörper eine Wand und eine Platte.
BAUKOERPER = {
    "A": {"x0": 0.0, "x1": BREITE},
    "B": {"x0": VERSATZ_B, "x1": VERSATZ_B + BREITE_B},
}
WAND_GID = {(t, g["name"]): f"WAND-{t}-{g['name']}"
            for t in BAUKOERPER for g in GESCHOSSE}
SLAB_GID = {(t, g["name"]): f"SLAB-{t}-{g['name']}"
            for t in BAUKOERPER for g in GESCHOSSE}

# **Eine Gipskartonwand quer durch Baukörper A.** Sie ist der Prüfstein für
# `ileen/tragend.py`: ohne Materialerkennung wird sie ein Linienlager mitten
# im Feld, halbiert die Spannweite und führt ein eigenes Konto. Mit ihr fällt
# sie heraus — und genau dieser Unterschied ist messbar.
TRENNWAND_GID = {g["name"]: f"TRENNWAND-{g['name']}" for g in GESCHOSSE}

# **Die Bodenplatte, je Baukörper eine.** Sie liegt unter dem untersten
# Geschossboden und ist das einzige Bauteil der Kette, das elastisch gebettet
# gerechnet wird: unter ihr steht keine Wand, sondern Boden.
BODENPLATTE_GID = {t: f"BODENPLATTE-{t}" for t in ("A", "B")}
BODENPLATTE_DICKE = 0.30
BODENPLATTE_OK = 0.0        # Oberkante = Fußboden des EG
BODENPLATTE_UK = BODENPLATTE_OK - BODENPLATTE_DICKE


def _rechteck(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def schnitt_attrappe(box, mode, cut_height):
    """
    Ein Schnitt, wie ihn `POST /section` liefern würde.

    Die Höhe entscheidet, was zurückkommt: liegt die Ebene in einer Platte, die
    Slabs; sonst die Wände. **Beide Baukörper zugleich** — ein waagerechter
    Schnitt trifft das ganze Gebäude, und dass daraus zwei getrennte
    Systemflächen werden müssen, ist genau die Aufgabe der Kette.
    """
    z = box["z_unten"] + cut_height

    # Die Bodenplatte liegt unter allen Geschossen; ein Schnitt in ihrer Höhe
    # trifft nur sie.
    if BODENPLATTE_UK - 1e-6 <= z <= BODENPLATTE_OK + 1e-6:
        return {
            "figures": [{
                "global_id": BODENPLATTE_GID[t], "ifc_type": "IfcSlab",
                "name": f"Bodenplatte {t}", "kind": "schnitt",
                "material": "C25/30",
                "rings": [_rechteck(b["x0"], 0, b["x1"], TIEFE)],
            } for t, b in BAUKOERPER.items()],
            "plane_origin": [BREITE / 2, TIEFE / 2, z],
            "bounds": [0, 0, VERSATZ_B + BREITE_B, TIEFE],
        }

    g = min(GESCHOSSE, key=lambda x: abs((x["boden"] + x["decke"]) / 2 - z))

    # Die Slab wird nur getroffen, wenn die Ebene wirklich in ihr liegt — nicht
    # irgendwo in ihrer Nähe. Genau daran scheiterte die erste Fassung.
    unten, oben = DECKENLAGE[g["name"]]
    if unten - 1e-6 <= z <= oben + 1e-6:
        figuren = [{
            "global_id": SLAB_GID[(t, g["name"])], "ifc_type": "IfcSlab",
            "name": f"Decke über {g['name']} ({t})", "kind": "schnitt",
            "material": "C25/30",
            "rings": [_rechteck(b["x0"], 0, b["x1"], TIEFE)],
        } for t, b in BAUKOERPER.items()]
    else:
        # Umlaufende Außenwand je Baukörper: Außenring plus Loch — wie eine
        # geschnittene Wand tatsächlich kommt.
        d = DICKE_WAND
        figuren = [{
            "global_id": WAND_GID[(t, g["name"])], "ifc_type": "IfcWall",
            "name": f"Außenwand {t}", "kind": "schnitt", "material": "C25/30",
            "rings": [_rechteck(b["x0"], 0, b["x1"], TIEFE),
                      _rechteck(b["x0"] + d, d, b["x1"] - d, TIEFE - d)],
        } for t, b in BAUKOERPER.items()]
        # Die Trennwand: quer durch Baukörper A, 12,5 cm, ein einfacher
        # Streifen ohne Loch — so kommt eine nichttragende Wand aus dem
        # Schnitt.
        figuren.append({
            "global_id": TRENNWAND_GID[g["name"]], "ifc_type": "IfcWall",
            "name": "Trennwand GK", "kind": "schnitt", "material": "Gipskarton",
            "rings": [_rechteck(BREITE / 2 - 0.0625, d, BREITE / 2 + 0.0625,
                                TIEFE - d)],
        })

    return {
        "figures": figuren,
        "plane_origin": [BREITE / 2, TIEFE / 2, z],
        "bounds": [0, 0, VERSATZ_B + BREITE_B, TIEFE],
    }


#: Die Modelle, die die Kette gebaut hat — für die Prüfung der Lastfälle.
GERECHNETE_MODELLE = []


def rechne_attrappe(modell, annahmen, melden):
    """
    Statt einer FE-Rechnung: die Last gleichmäßig auf die Auflagerlängen.

    Für die Buchhaltung ist das die richtige Attrappe — sie erhält die
    Resultierende exakt, und genau darauf kommt es an. Wie sich die Last
    tatsächlich auf die Lager verteilt, ist Sache des Solvers und nicht dieses
    Tests.
    """
    GERECHNETE_MODELLE.append(modell)
    platte = modell["system"][0]
    flaeche = platte["flaeche_m2"]
    dicke = platte["dicke_m"]
    wichte = platte["material"]["wichte_kNm3"]

    # Lastsummen je Lastfall, charakteristisch.
    summen = {la.EIGENGEWICHT: flaeche * dicke * wichte}
    for last in modell["lasten"]:
        kennung = last["lastfall"]
        if last["typ"] == "flaeche":
            wert = last["wert"] * flaeche
        elif last["typ"] == "linie":
            laenge = kette._laenge(last["polylinie"])
            wert = last["wert"] * laenge
        else:
            wert = last["wert"]
        summen[kennung] = summen.get(kennung, 0.0) + wert

    lager = modell["auflager"]
    laengen = []
    for a in lager:
        laengen.append(kette._laenge(a["polylinie"]) if "polylinie" in a else 1.0)
    gesamt = sum(laengen) or 1.0

    lastfallweise = {}
    for kennung, summe in summen.items():
        lastfallweise[kennung] = [
            {"id": a["id"], "typ": a["typ"], "laenge_m": l,
             # Reaktion nach oben, stützend — wie der Solver sie liefert.
             "R_z_kN": summe * l / gesamt,
             "R_x_kN": 0.0, "R_y_kN": 0.0,
             "bauteile": a.get("bauteile", [])}
            for a, l in zip(lager, laengen)
        ]

    return {
        "auflager": lastfallweise[la.EIGENGEWICHT],
        "auflager_lastfallweise": lastfallweise,
        "nachweise": {"Querkraft A1": 0.42},
        "nachweise_offen": [],
        "durchbiegung": {"w_elastisch_mm": 8.1, "grenzwert_mm": 40.0},
        "lastsummen_kN": {k: round(v, 1) for k, v in summen.items()},
        "_summen": summen,
    }


def zugang(ueber_material: bool = False):
    """
    Der Prüfkörper.

    @param ueber_material  Statt `Pset_WallCommon.LoadBearing` tragen die Wände
                           ihre Materialschichten — so, wie es in einem
                           Architekturmodell ohne gepflegtes Pset aussieht.
                           Das Ergebnis muss dasselbe sein; genau das ist der
                           Zweck der Materialerkennung.
    """
    return kette.Zugang(
        schnitt=schnitt_attrappe,
        geschosse=GESCHOSSE,
        psets={} if ueber_material else {
            gid: {"Pset_WallCommon": {"LoadBearing": True}}
            for gid in WAND_GID.values()},
        boxen={
            **{WAND_GID[(t, g["name"])]: {
                   "lo": [b["x0"], 0, g["boden"]],
                   "hi": [b["x1"], TIEFE, DECKENLAGE[g["name"]][0]],
                   "ifc_type": "IfcWall", "name": f"Außenwand {t}",
                   "storey": g["name"],
                   # Eine gedämmte Außenwand: die **dickste** Schicht ist die
                   # Dämmung. Wer nur sie ansieht, erklärt die Wand für
                   # nichttragend — der Fehler, gegen den `ileen/tragend.py`
                   # alle Schichten liest.
                   #
                   # Der Aufbau steht in **beiden** Fassungen, nicht nur in der
                   # materialerkannten. Sonst unterschieden sich die beiden
                   # Läufe in Prüfung 9 nicht bloß im Erkennungsweg, sondern im
                   # Haus: ohne Material kennt die Kette keine Wichte und setzt
                   # Stahlbeton an, mit Material das leichtere Mauerwerk. Die
                   # Gründungslasten wären verschieden, und der Vergleich
                   # bewiese nichts.
                   "material": "Mineralwolle 035",
                   "materialschichten": [
                       {"name": "Kalksandstein", "dicke_m": 0.175},
                       {"name": "Mineralwolle 035", "dicke_m": 0.200},
                       {"name": "Klinker", "dicke_m": 0.115}]}
               for t, b in BAUKOERPER.items() for g in GESCHOSSE},
            **{SLAB_GID[(t, g["name"])]: {
                   "lo": [b["x0"], 0, DECKENLAGE[g["name"]][0]],
                   "hi": [b["x1"], TIEFE, DECKENLAGE[g["name"]][1]],
                   "ifc_type": "IfcSlab",
                   "name": f"Decke über {g['name']} ({t})", "storey": g["name"]}
               for t, b in BAUKOERPER.items() for g in GESCHOSSE},
            **{TRENNWAND_GID[g["name"]]: {
                   "lo": [BREITE / 2 - 0.0625, 0, g["boden"]],
                   "hi": [BREITE / 2 + 0.0625, TIEFE, DECKENLAGE[g["name"]][0]],
                   "ifc_type": "IfcWall", "name": "Trennwand GK",
                   "storey": g["name"],
                   "material": "Gipskarton 12,5 mm",
                   "materialschichten": [
                       {"name": "Gipskarton 12,5 mm", "dicke_m": 0.0125},
                       {"name": "Mineralwolle", "dicke_m": 0.100},
                       {"name": "Gipskarton 12,5 mm", "dicke_m": 0.0125}]}
               for g in GESCHOSSE},
            **{BODENPLATTE_GID[t]: {
                   "lo": [b["x0"], 0, BODENPLATTE_UK],
                   "hi": [b["x1"], TIEFE, BODENPLATTE_OK],
                   "ifc_type": "IfcSlab", "name": f"Bodenplatte {t}",
                   "storey": "EG"}
               for t, b in BAUKOERPER.items()},
            # Ein Treppenpodest: gleiche Dicke wie die Decke, ein Zwanzigstel
            # der Fläche. Es darf kein eigenes Deckenfeld werden.
            "PODEST-1OG": {"lo": [0, 0, 4.4], "hi": [1.4, 1.2, 4.65],
                           "ifc_type": "IfcSlab", "name": "Treppen Podest",
                           "storey": "1.OG"},
            # Ein Bodenbelag: volle Fläche, 3 cm. Zu dünn, um zu tragen.
            "BELAG-EG": {"lo": [0, 0, 2.97], "hi": [BREITE, TIEFE, 3.0],
                         "ifc_type": "IfcSlab", "name": "Bodenbelag",
                         "storey": "EG"},
        },
        huelle={"lo": [-1, -1, -1],
                "hi": [VERSATZ_B + BREITE_B + 1, TIEFE + 1, 10]},
        rechne=rechne_attrappe,
        job_id="test", modellname="Prüfkörper",
    )


# ── Prüfungen ─────────────────────────────────────────────────────────────


def pruefe(bedingung, text, ist=None, soll=None):
    if bedingung:
        print(f"  ok    {text}")
        return True
    zusatz = f"   (ist {ist}, soll {soll})" if ist is not None else ""
    print(f"  FEHL  {text}{zusatz}")
    return False


def main() -> int:
    ergebnis = kette.rechne_kette(zugang(), {"dicke_m": DECKENDICKE,
                                             "ausbaulast_kNm2": AUSBAU,
                                             "nutzlast_kategorie": "A2"})
    alles_gut = True

    print("\n1 — Reihenfolge: von oben nach unten")
    # Die Gründung steht am Ende der Kette und ist kein Geschoss, sondern das,
    # worauf sie steht — ein eigenes Submodell mit Bettung statt Auflagern.
    namen = [g["name"] for g in ergebnis["geschosse"]]
    alles_gut &= pruefe(namen == ["2.OG", "1.OG", "EG", "Gründung"],
                        f"Reihenfolge {namen}", namen,
                        ["2.OG", "1.OG", "EG", "Gründung"])
    alles_gut &= pruefe(all(g["status"] == "gerechnet" for g in ergebnis["geschosse"]),
                        "alle drei Geschosse und die Gründung gerechnet",
                        [g["status"] for g in ergebnis["geschosse"]], "4 × gerechnet")

    #: Die Geschosse ohne die Gründung — für alles, was sich auf Decken bezieht.
    stockwerke = [g for g in ergebnis["geschosse"] if g["name"] != "Gründung"]

    print("\n1b — Jedes Deckenfeld ist ein benanntes Submodell")
    kuerzel = [g.get("kuerzel") for g in ergebnis["geschosse"]]
    alles_gut &= pruefe(kuerzel == ["OG2", "OG1", "EG", "FUND"],
                        f"Kürzel {kuerzel}", kuerzel, ["OG2", "OG1", "EG", "FUND"])
    # Zwei Baukörper je Geschoss → zwei Submodelle mit Nummer, und die Nummer
    # folgt der Lage: Baukörper A liegt bei x 0…10, B bei x 20…26.
    namen_sm = sorted(f["submodell"] for g in ergebnis["geschosse"]
                      for f in (g.get("felder") or []))
    erwartet_sm = sorted(f"submodell.{k}.{n}"
                         for k in ("OG2", "OG1", "EG", "FUND") for n in (1, 2))
    alles_gut &= pruefe(namen_sm == erwartet_sm,
                        "acht Submodelle: drei Geschosse und die Gründung, "
                        "je zwei Baukörper", namen_sm, erwartet_sm)
    # Die .1 ist immer der westliche Baukörper — das ist der Sinn der Ordnung
    # nach der Lage: dieselbe Nummer trifft bei jedem Lauf dieselbe Platte.
    eg_felder = {f["submodell"]: f["platte"]
                 for g in ergebnis["geschosse"] if g["name"] == "EG"
                 for f in (g.get("felder") or [])}
    alles_gut &= pruefe(
        eg_felder.get("submodell.EG.1") != eg_felder.get("submodell.EG.2")
        and len(eg_felder) == 2,
        "die beiden Felder des EG sind verschiedene Platten",
        eg_felder, "zwei verschiedene")

    print("\n2a — Beide Deckenfelder je Geschoss gefunden und gerechnet")
    for g in stockwerke:
        platten = g.get("platten") or []
        gefunden = {p.get("global_id") for p in platten}
        erwartet = {SLAB_GID[(t, g["name"])] for t in BAUKOERPER}
        soll_unten, soll_oben = DECKENLAGE[g["name"]]
        alles_gut &= pruefe(
            gefunden == erwartet
            and all(abs(p["z_mitte"] - (soll_unten + soll_oben) / 2) < 0.01
                    for p in platten),
            f"{g['name']}: {len(platten)} Felder bei z = "
            f"{platten[0]['z_mitte']:.2f} m, d = {platten[0]['dicke_m']} m"
            if platten else f"{g['name']}: keine Platte",
            sorted(gefunden), sorted(erwartet))
        gerechnet = [f for f in (g.get("felder") or []) if f["status"] == "gerechnet"]
        alles_gut &= pruefe(len(gerechnet) == len(BAUKOERPER),
                            f"{g['name']}: beide Felder gerechnet "
                            f"({', '.join(str(f.get('flaeche_m2')) for f in gerechnet)} m²)",
                            len(gerechnet), len(BAUKOERPER))

    print("\n2a2 — Ein Dachaufbau verdrängt die Rohdecke nicht")
    # Der Fall, an dem `Ifc4_SampleHouse.ifc` scheiterte: über der 16-cm-
    # Rohdecke liegt ein IfcRoof von 1,74 m (Attika, Gefälledämmung,
    # Abdichtung). Beide überdecken sich, die Mitten liegen 19 cm auseinander —
    # die Regel „von zwei überdeckenden Platten bleibt die dickste" hielt sie
    # für dieselbe Platte in zwei Lagen und behielt den Aufbau.
    #
    # Die Folge war nicht bloß eine falsche Dicke: der Aufbau liegt anders als
    # die Wände, die Lagerlinien fielen aus dem Umriss, und BEIDE Geschosse
    # waren nicht rechenbar — gemeldet als „keine Auflager gefunden", was auf
    # das Gegenteil des wahren Grundes zeigte.
    roh_unten, roh_oben = DECKENLAGE["EG"]
    mit_dach = dict(zugang().boxen)
    mit_dach["DACHAUFBAU"] = {
        "lo": [0, 0, roh_unten - 0.6], "hi": [BREITE, TIEFE, roh_oben + 1.14],
        "ifc_type": "IfcRoof", "name": "Roof_Flat-4Felt-150Ins-50Scr",
        "storey": "EG"}
    platten = kette.deckenplatten({"name": "EG", "boden": 0.0, "decke": 3.0},
                                  3.0, mit_dach)
    gefunden = {p["global_id"] for p in platten}
    alles_gut &= pruefe(
        "DACHAUFBAU" not in gefunden,
        f"ein 1,74-m-Aufbau ist keine Deckenplatte "
        f"({sorted(gefunden)})", sorted(gefunden), "ohne DACHAUFBAU")
    alles_gut &= pruefe(
        SLAB_GID[("A", "EG")] in gefunden and SLAB_GID[("B", "EG")] in gefunden,
        "und die Rohdecken beider Baukörper bleiben",
        sorted(gefunden), "beide Slabs")

    # Ein Aufbeton dagegen ist dünn und trägt mit — er darf die Regel weiterhin
    # auslösen, sonst würden zwei Modelle über derselben Fläche gerechnet.
    mit_aufbeton = dict(zugang().boxen)
    mit_aufbeton["AUFBETON"] = {
        "lo": [0, 0, roh_oben], "hi": [BREITE, TIEFE, roh_oben + 0.07],
        "ifc_type": "IfcSlab", "name": "Aufbeton", "storey": "EG"}
    platten = kette.deckenplatten({"name": "EG", "boden": 0.0, "decke": 3.0},
                                  3.0, mit_aufbeton)
    alles_gut &= pruefe(
        len(platten) == len(BAUKOERPER),
        f"ein 7-cm-Aufbeton bleibt eine Lage derselben Decke "
        f"({len(platten)} Felder statt {len(BAUKOERPER) + 1})",
        len(platten), len(BAUKOERPER))

    print("\n2b — Geometrie aus dem Schnitt")
    konten = {(k["global_id"], k["geschoss"]): k for k in ergebnis["konten"]}
    konto_wand = konten[(WAND_GID[("A", "EG")], "EG")]
    geo = konto_wand["geometrie"]
    alles_gut &= pruefe(abs(geo["dicke_tragend_m"] - DICKE_WAND) < 0.005,
                        f"Wanddicke aus der Bandformel = {geo['dicke_tragend_m']} m",
                        geo["dicke_tragend_m"], DICKE_WAND)

    print("\n3 — Erhaltung: eingetragen = angekommen")
    # Von Hand, über **beide** Baukörper: je Decke Eigengewicht, Ausbau- und
    # Nutzlast auf ihrer Fläche.
    flaeche = BREITE * TIEFE + BREITE_B * TIEFE
    je_decke = {"EG": flaeche * DECKENDICKE * 25, "AUS": flaeche * AUSBAU,
                "NUTZ": flaeche * NUTZ}
    # **Die oberste Decke ist ein Dach.** Auf ihr steht kein Raum und keine
    # Wand, und über ihr liegt keine Platte. Sie trägt den Dachaufbau und die
    # Dachlast max(Kat. H 1,0; μ₁·s_k = 0,8·0,85 = 0,68) = 1,0 kN/m² — nicht
    # die Nutzlast eines Wohngeschosses. Bis Oktober 2026 stand dort A2.
    je_dach = {"EG": flaeche * DECKENDICKE * 25,
               "AUS": flaeche * tm.DACHAUFBAU_VORGABE,
               "H": flaeche * tm.DACH_NUTZLAST_H}

    # **Der Trennwandzuschlag gehört dazu — auf der Decke, auf der die Wand
    # steht.** Die Gipskartonwand quer durch Baukörper A trägt nicht, aber sie
    # wiegt, und nach DIN EN 1991-1-1/NA 6.3.1.2 (8) wird sie als Flächenlast
    # angesetzt. Bis Oktober 2026 landete sie auf der Decke *über* ihr (der,
    # die sie im Schnitt umgab) — also die Wand des 2. OG auf dem Dach und die
    # des EG im Wandkettenteil statt auf der Bodenplatte. Abgelesen wird der
    # Zuschlag aus den Modellen, die die Kette gebaut hat — das ist ihre
    # *Eingabe*, nicht ihr Ergebnis, und damit keine Tautologie: die Frage der
    # Erhaltungsprobe lautet, ob unten ankommt, was oben eingetragen wurde.
    # Die Wand des EG steht auf der Bodenplatte; ihr Zuschlag geht dort direkt
    # in den Baugrund und gehört in 3c, nicht in die Wandkette.
    def ist_sohle(m):
        return str(m["plan"].get("submodell", "")).startswith("submodell.FUND")

    def zuschlag(modelle):
        return sum(last["wert"] * m["system"][0]["flaeche_m2"]
                   for m in modelle for last in m["lasten"]
                   if last.get("name") == "Trennwandzuschlag")

    zuschlag_kN = zuschlag(m for m in GERECHNETE_MODELLE if not ist_sohle(m))
    zuschlag_sohle_kN = zuschlag(m for m in GERECHNETE_MODELLE if ist_sohle(m))
    decken_gesamt = ((len(GESCHOSSE) - 1) * sum(je_decke.values())
                     + sum(je_dach.values()) + zuschlag_kN)

    # Wandeigengewicht aus den Werten, die die Kette ermittelt hat — Achslänge
    # und Dicke aus der Bandformel, Höhe bis zur Deckenunterkante. Sie hier
    # nachzurechnen hieße, die Bandformel ein zweites Mal zu implementieren und
    # den Test gegen diese zweite Implementierung zu prüfen statt gegen die
    # Physik. Die Aussage dieses Abschnitts ist die Erhaltung, nicht die
    # Geometrieermittlung — die steht in Abschnitt 2.
    waende = [k for k in ergebnis["konten"] if k["rolle"] == "wand"]
    wand_gesamt = sum(k["eigengewicht_kN"] for k in waende)
    geo_wand = konto_wand["geometrie"]
    hoehe_wand = geo_wand["hoehe_m"]

    # Die Wand reicht vom Fußboden bis zur Deckenunterkante, nicht bis zur
    # Elevation des nächsten Geschosses — sonst stünde die Decke zweimal in
    # der Rechnung, einmal als Platte und einmal als Stück Wand.
    alles_gut &= pruefe(
        abs(hoehe_wand - (GESCHOSSHOEHE - AUFBAU - DECKENDICKE)) < 0.02,
        f"Wandhöhe = lichte Höhe {hoehe_wand:.2f} m (nicht {GESCHOSSHOEHE:.2f} m)",
        round(hoehe_wand, 2), round(GESCHOSSHOEHE - AUFBAU - DECKENDICKE, 2))

    # Jede Wand genau einmal je Geschoss — nicht einmal je Deckenfeld, das sie
    # trägt. Ein doppelt gezähltes Eigengewicht wäre der naheliegende Fehler,
    # sobald ein Geschoss mehrere Felder hat.
    alles_gut &= pruefe(
        len(waende) == len(BAUKOERPER) * len(GESCHOSSE),
        f"{len(waende)} Wandkonten = {len(BAUKOERPER)} Baukörper × "
        f"{len(GESCHOSSE)} Geschosse", len(waende),
        len(BAUKOERPER) * len(GESCHOSSE))

    erwartet_fundament = decken_gesamt + wand_gesamt
    print(f"        Decken   {len(GESCHOSSE) - 1} × {sum(je_decke.values()):8.1f} kN "
          f"= {(len(GESCHOSSE) - 1) * sum(je_decke.values()):9.1f} kN   "
          f"(2 Baukörper, {flaeche:.0f} m²)")
    print(f"        Dach     1 × {sum(je_dach.values()):8.1f} kN "
          f"= {sum(je_dach.values()):9.1f} kN   (Aufbau + Kat. H)")
    print(f"        Trennwandzuschlag            = {zuschlag_kN:9.1f} kN")
    print(f"        Wände    {len(waende)} Konten             "
          f"= {wand_gesamt:9.1f} kN")
    print(f"        erwartet am Fundament        = {erwartet_fundament:9.1f} kN")

    ist_fundament = ergebnis["gruendung"]["summe_kN"]
    print(f"        gebucht  am Fundament        = {ist_fundament:9.1f} kN")
    abweichung = abs(ist_fundament - erwartet_fundament) / erwartet_fundament
    alles_gut &= pruefe(abweichung < 0.01,
                        f"Erhaltung, Abweichung {abweichung*100:.3f} %",
                        round(ist_fundament, 1), round(erwartet_fundament, 1))

    print("\n3b — Der Trennwandzuschlag wirkt")
    # Ohne ihn fiele die Gipskartonwand restlos aus der Rechnung: sie ist kein
    # Auflager (E3a) und wäre damit auch kein Gewicht. Eine Wand, die weder
    # trägt noch wiegt, gibt es nicht.
    zuschlaege = [last["wert"] for m in GERECHNETE_MODELLE for last in m["lasten"]
                  if last.get("name") == "Trennwandzuschlag"]
    alles_gut &= pruefe(
        len(zuschlaege) == 3,
        f"in den drei Feldern mit Trennwand ein Zuschlag "
        f"({[round(z, 3) for z in zuschlaege]} kN/m²)",
        len(zuschlaege), 3)
    # Und zwar unter den Wänden: die des 2. OG auf der Decke über dem 1. OG,
    # die des 1. OG auf der über dem EG, die des EG auf der Bodenplatte — das
    # Dach trägt keine.
    mit_zuschlag = sorted(
        m["plan"].get("submodell") for m in GERECHNETE_MODELLE
        if any(last.get("name") == "Trennwandzuschlag" for last in m["lasten"]))
    alles_gut &= pruefe(
        mit_zuschlag == ["submodell.EG.1", "submodell.FUND.1", "submodell.OG1.1"],
        f"der Zuschlag liegt auf der Decke unter der Wand, nicht auf der darüber "
        f"({mit_zuschlag})",
        mit_zuschlag, ["submodell.EG.1", "submodell.FUND.1", "submodell.OG1.1"])
    # Die Norm nennt 0,5 / 0,8 / 1,2 kN/m² als Stufen. Eine 12,5er GK-Wand über
    # 2,62 m Höhe liegt am unteren Ende.
    alles_gut &= pruefe(
        all(0.4 <= z <= 1.3 for z in zuschlaege),
        "und er liegt in den Stufen der Norm (0,5…1,2 kN/m²)",
        [round(z, 3) for z in zuschlaege], "0,5…1,2")

    print("\n3c — Die Bodenplatte schließt die Kette")
    gr = ergebnis["gruendung"]
    bp = gr.get("bodenplatte") or {}
    alles_gut &= pruefe(
        bp.get("bettung_kNm3") == 20000.0,
        f"gebettet mit dem Vorschlagswert ({bp.get('bettung_kNm3')} kN/m³)",
        bp.get("bettung_kNm3"), 20000.0)
    alles_gut &= pruefe(
        "Vorschlagswert" in (bp.get("bettung_quelle") or ""),
        "und sagt, dass das eine Annahme ist und keine Messung",
        bp.get("bettung_quelle"), "… Vorschlagswert …")
    alles_gut &= pruefe(
        sorted(bp.get("submodelle") or []) ==
        ["submodell.FUND.1", "submodell.FUND.2"],
        "zwei Bodenplatten, je Baukörper eine",
        sorted(bp.get("submodelle") or []),
        ["submodell.FUND.1", "submodell.FUND.2"])

    # **Die Summenkontrolle der Gründung.** Was der Baugrund aufnimmt, ist die
    # Summe aus den Wandfußkräften und der Eigenlast der Bodenplatte selbst.
    # Von Hand: 30 cm Platte über beide Baukörper plus Ausbau plus Nutzlast —
    # und der Trennwandzuschlag der Gipskartonwand des EG, die auf ihr steht.
    bp_soll = flaeche * (0.30 * 25 + AUSBAU + NUTZ) + zuschlag_sohle_kN
    alles_gut &= pruefe(
        abs(bp.get("eingetragen_kN", 0.0) - bp_soll) / bp_soll < 0.01,
        f"die Bodenplatte trägt {bp.get('eingetragen_kN')} kN eigene Last "
        f"(erwartet {bp_soll:.1f})",
        bp.get("eingetragen_kN"), round(bp_soll, 1))

    sohle = gr["summe_kN"] + bp.get("eingetragen_kN", 0.0)
    print(f"        Wandfußkräfte  {gr['summe_kN']:9.1f} kN")
    print(f"        Bodenplatte    {bp.get('eingetragen_kN', 0.0):9.1f} kN")
    print(f"        Sohle gesamt   {sohle:9.1f} kN")
    alles_gut &= pruefe(
        sohle > gr["summe_kN"],
        "die Sohle trägt mehr als die Wände allein — ihre eigene Last dazu",
        round(sohle, 1), f"> {gr['summe_kN']:.1f}")

    print("\n4 — Anwachsen nach unten")
    # Die Wandkraft eines Baukörpers muss von Geschoss zu Geschoss steigen,
    # und zwar um eine Decke plus eine Wandhöhe.
    reihe = [konten[(WAND_GID[("A", g["name"])], g["name"])]
             for g in reversed(GESCHOSSE)]
    kraefte = [sum(k["anteile_kN"].values()) for k in reihe]
    print(f"        Baukörper A, Wandkraft je Geschoss: "
          f"{[round(x, 1) for x in kraefte]} kN")
    alles_gut &= pruefe(kraefte[0] < kraefte[1] < kraefte[2],
                        "Wandkraft wächst nach unten",
                        [round(x, 1) for x in kraefte], "streng steigend")

    # Der Zuwachs ist die Last einer Decke des Baukörpers A plus sein
    # Wandeigengewicht — und plus den Trennwandzuschlag, denn auf jeder Decke
    # außer dem Dach steht die Gipskartonwand des Geschosses darüber.
    flaeche_a = BREITE * TIEFE
    zuschlag_a = next(
        (last["wert"] for m in GERECHNETE_MODELLE for last in m["lasten"]
         if last.get("name") == "Trennwandzuschlag"), 0.0)
    zuwachs_soll = (flaeche_a * (DECKENDICKE * 25 + AUSBAU + NUTZ + zuschlag_a)
                    + konto_wand["eigengewicht_kN"])
    for i in range(len(kraefte) - 1):
        zuwachs = kraefte[i + 1] - kraefte[i]
        alles_gut &= pruefe(
            abs(zuwachs - zuwachs_soll) / zuwachs_soll < 0.02,
            f"Zuwachs {reihe[i]['geschoss']}→{reihe[i+1]['geschoss']} "
            f"= Decke + Wand ({zuwachs:.1f} kN)",
            round(zuwachs, 1), round(zuwachs_soll, 1))

    print("\n5 — Keine doppelten Sicherheitsbeiwerte")
    # Zwei veränderliche Einwirkungen kommen in der EG-Wand an: die Nutzlast
    # der beiden Geschossdecken (ψ₀ = 0,7) und die Dachlast (Kat. H, ψ₀ = 0).
    # Jede wird einmal Leiteinwirkung (DIN EN 1990, Gl. 6.10):
    #
    #     Nutzlast führt:  1,35·G + 1,5·Q_N + 1,5·0,0·Q_H
    #     Dach führt:      1,35·G + 1,5·Q_H + 1,5·0,7·Q_N
    #
    # Mit Q_N = 2·80·1,5 = 240 und Q_H = 80·1,0 = 80 führt das Dach
    # (120 + 252 > 360) — obwohl es die kleinere Last ist. Die erste Fassung
    # nahm den größten Anteil als Leiteinwirkung und lag damit zu tief.
    bem = konto_wand["bemessung"]
    anteile = konto_wand["anteile_kN"]
    staendig = bem["staendig_kN"]
    q_n, q_h = anteile.get("NUTZ", 0.0), anteile.get("H", 0.0)
    von_hand = 1.35 * staendig + max(1.5 * q_n, 1.5 * q_h + 1.5 * 0.7 * q_n)
    alles_gut &= pruefe(abs(bem["N_Ed_kN"] - von_hand) < 0.5,
                        f"N_Ed = 1,35·{staendig:.0f} + max(1,5·{q_n:.0f}; "
                        f"1,5·{q_h:.0f} + 1,05·{q_n:.0f}) = {von_hand:.1f} kN",
                        bem["N_Ed_kN"], round(von_hand, 1))
    alles_gut &= pruefe(bem.get("leiteinwirkung") == "H",
                        "die Dachlast ist Leiteinwirkung, nicht die größere Nutzlast",
                        bem.get("leiteinwirkung"), "H")
    # n zählt die Geschosse **mit Nutzlast** über der Wand: zwei. Das Dach
    # zählt nicht — mit ihm wären es drei und α_n = 0,9; und mit seinem
    # ψ₀ = 0 im Abminderungsbeiwert wurde daraus in der ersten Fassung 0,67.
    alles_gut &= pruefe(bem["geschosse_darueber"] == 2 and bem["alpha_n"] == 1.0,
                        f"n = {bem['geschosse_darueber']} Geschosse mit Nutzlast, "
                        f"α_n = {bem['alpha_n']} — das Dach zählt nicht mit",
                        (bem["geschosse_darueber"], bem["alpha_n"]), (2, 1.0))

    # **α_n trifft nur die Nutzlast, und mit ihrem ψ₀.** Sechs Geschosse,
    # Nutzlast 600 kN, Schnee 100 kN: α_n = (2 + 4·0,7)/6 = 0,80, Q_N = 480.
    # Nutzlast führt 1,5·480 + 1,5·0,5·100 = 795, Schnee führt
    # 1,5·100 + 1,5·0,7·480 = 654 → N_Ed = 1,35·1000 + 795 = 2145 kN.
    probe = la.bemessungswert({"EG": 1000.0, "NUTZ": 600.0, "S": 100.0},
                              {"EG": "G", "NUTZ": "Q", "S": "Q"},
                              {"NUTZ": 0.7, "S": 0.5}, geschosse_darueber=6)
    alles_gut &= pruefe(abs(probe["N_Ed_kN"] - 2145.0) < 0.01 and probe["alpha_n"] == 0.8,
                        f"α_n = {probe['alpha_n']} nur auf die Nutzlast, Schnee voll: "
                        f"N_Ed = {probe['N_Ed_kN']} kN",
                        (probe["N_Ed_kN"], probe["alpha_n"]), (2145.0, 0.8))
    alles_gut &= pruefe(1.30 <= bem["gamma_mittel"] <= 1.45,
                        f"mittleres γ = {bem['gamma_mittel']} liegt zwischen 1,35 und 1,50",
                        bem["gamma_mittel"], "1,35 … 1,50")

    print("\n6 — Nachweis geführt")
    nw = konto_wand.get("nachweis")
    alles_gut &= pruefe(nw is not None, "Knicknachweis vorhanden")
    if nw:
        print(f"        λ = {nw.get('lambda')}, Φ = {nw.get('phi')}, "
              f"N_Rd = {nw.get('N_Rd_je_m_kN')} kN/m, "
              f"Ausnutzung {nw.get('ausnutzung')}")
        alles_gut &= pruefe(nw.get("erfuellt") is True,
                            "Wand trägt", nw.get("ausnutzung"), "≤ 1,0")

    print("\n7 — Bilanz")
    bilanz = ergebnis["bilanz"]
    print(f"        neu eingetragen  {bilanz['eingetragen_kN']:9.1f} kN")
    print(f"        Eigengewichte    {bilanz['eigengewichte_kN']:9.1f} kN")
    print(f"        erwartet am Fuß  {bilanz['erwartet_am_fuss_kN']:9.1f} kN")
    print(f"        gebucht  am Fuß  {bilanz['gebucht_am_fuss_kN']:9.1f} kN")
    print(f"        Fehlbetrag       {bilanz['fehlbetrag_kN']:9.1f} kN")
    alles_gut &= pruefe(bilanz["erhalten"], "Erhaltungsprobe der Bilanz",
                        bilanz["fehlbetrag_kN"], 0.0)
    alles_gut &= pruefe(abs(bilanz["nicht_zuordenbar_kN"]) < 0.1,
                        "keine Kraft ohne Bauteilbezug",
                        bilanz["nicht_zuordenbar_kN"], 0.0)

    print("\n8 — Lastfälle der weitergereichten Lasten")
    # **Der Fehler, den dieser Abschnitt fängt.** `plate.EIGENGEWICHT` ist die
    # feste Kennung `EG` für das Plattengewicht. Eine weitergereichte Wandlast
    # auf diesem Lastfall überschreibt es in `plate.einzelfelder()` — das
    # Plattengewicht verschwindet vollständig, und zwar lautlos: die Rechnung
    # läuft durch, die Bilder sehen aus wie immer, nur die Lastsumme ist um
    # das Eigengewicht kleiner. An einem realen Modell fielen so 4 667 kN je
    # Geschoss weg und die Erhaltungsprobe zeigte 88 % Fehlbetrag.
    #
    # Die Rechenattrappe durchläuft `einzelfelder()` nicht, kann den Verlust
    # also nicht nachstellen. Geprüft wird deshalb das erzeugte Modell selbst:
    # kein Lastabtrag auf `EG`.
    auf_eg = [(m["plan"]["geschoss"], l["id"]) for m in GERECHNETE_MODELLE
              for l in m["lasten"]
              if l["lastfall"] == "EG" and l["typ"] in ("linie", "punkt")]
    alles_gut &= pruefe(not auf_eg,
                        "keine weitergereichte Last auf dem Lastfall 'EG'",
                        auf_eg, "[]")

    # Und der veränderliche Anteil darf keinen zweiten Nutzlastfall aufmachen:
    # sonst mindern ψ₀ (Gl. 6.10) und α_n dieselbe Nutzlast doppelt ab. Der
    # Dachlastfall ist etwas anderes — Kat. H bzw. Schnee ist eine eigene
    # Einwirkung mit eigenem ψ₀ und bleibt deshalb bis in die Gründung ein
    # eigener Lastfall (`tm.LASTFAELLE_DACH`).
    erlaubt = {"NUTZ"} | set(tm.LASTFAELLE_DACH)
    veraenderliche = [{f["id"] for f in m["lastfaelle"] if f.get("art") != "G"}
                      for m in GERECHNETE_MODELLE]
    alles_gut &= pruefe(all(v <= erlaubt for v in veraenderliche),
                        "kein veränderlicher Lastfall außer der Nutzlast und dem Dach",
                        [sorted(v) for v in veraenderliche], f"⊆ {sorted(erlaubt)}")
    daecher = [sorted(v) for m, v in zip(GERECHNETE_MODELLE, veraenderliche)
               if m["plan"].get("dach")]
    alles_gut &= pruefe(daecher == [["H"], ["H"]],
                        "die beiden Dächer tragen Kat. H und keine Nutzlast",
                        daecher, [["H"], ["H"]])

    # Ein Modell je Deckenfeld: alle außer denen des obersten Geschosses
    # tragen Lasten von oben — die Bodenplatten eingeschlossen. Sie bekommen
    # die Wandfußkräfte des Erdgeschosses als Linienlasten; ohne sie trügen
    # sie nur ihr Eigengewicht, und das fiele nicht auf, weil eine gebettete
    # Platte auch ohne Auflast ein plausibles Ergebnis liefert.
    # Was auf einem Lager steht, geht seit `kette.durchleiten()` direkt hinein
    # und steht unter `durchleitung` statt unter den Lasten — es kommt
    # trotzdem von oben.
    mit_abtrag = [m for m in GERECHNETE_MODELLE
                  if any(l["typ"] in ("linie", "punkt") for l in m["lasten"])
                  or m.get("durchleitung")]
    soll = len(GESCHOSSE) * len(BAUKOERPER)   # 2 OG + EG + Gründung, je 2
    alles_gut &= pruefe(
        len(mit_abtrag) == soll,
        f"{len(mit_abtrag)} Felder tragen Lasten von oben "
        f"({len(GESCHOSSE) - 1} Geschosse × {len(BAUKOERPER)} Baukörper)",
        len(mit_abtrag), soll)

    # **Jedes Feld nur seine eigenen Lasten.** Bekäme ein Feld auch die
    # Wandlasten des anderen Baukörpers, läge deren Angriffslinie außerhalb
    # seines Umrisses — `plate._anteile()` verwürfe sie stillschweigend, und
    # genau so gingen am realen Modell 79 % der Last verloren.
    for m in mit_abtrag:
        faelle = {l["lastfall"] for l in m["lasten"] if l["typ"] == "linie"}
        umriss = m["system"][0]["umriss"]
        x0 = min(p[0] for p in umriss) - 1.0
        x1 = max(p[0] for p in umriss) + 1.0
        fremd = [l["id"] for l in m["lasten"] if l["typ"] == "linie"
                 and not all(x0 <= p[0] <= x1 for p in l["polylinie"])]
        print(f"        {m['plan']['geschoss']:6} x {x0+1:5.1f}…{x1-1:5.1f}  "
              f"{len([l for l in m['lasten'] if l['typ'] == 'linie']):3} Linienlasten  "
              f"{sorted(faelle)}")
        alles_gut &= pruefe(
            not fremd,
            f"{m['plan']['geschoss']} ({x0+1:.0f}…{x1-1:.0f} m): keine ortsfremde Last",
            fremd, "[]")

    # ── 8b — Durchleitung: was auf einem Lager steht, geht direkt hinein ──
    #
    # Ohne Netz und ohne Löser: die Aufteilung ist reine Geometrie, die
    # Buchung reine Buchführung. Eine Wand 24 cm (Achse y = 0, x 0…6) mit
    # Tür bei x 2…3 (zwei Lager), eine Stütze 30/30 bei (8, 0).
    print("\nDurchleitung von oben")
    modell_d = {
        "auflager": [
            {"id": "A1", "typ": "linie", "polylinie": [[0, 0], [2, 0]], "bauteile": ["W1"]},
            {"id": "A2", "typ": "linie", "polylinie": [[3, 0], [6, 0]], "bauteile": ["W2"]},
            {"id": "A3", "typ": "punkt", "p": [8, 0], "bauteile": ["S1"]},
        ],
        "lastfaelle": [{"id": "ABG", "art": "G"}, {"id": "NUTZ", "art": "Q"}],
        "lasten": [
            # Wand darüber, 5 cm aus der Achse: steht auf beiden Lagern, die
            # Tür dazwischen bleibt Linienlast auf der Platte.
            {"id": "L1", "typ": "linie", "lastfall": "ABG", "wert": 10.0,
             "polylinie": [[0, 0.05], [6, 0.05]], "bezug": "WO"},
            # Versetzte Wand, 40 cm daneben: Abfangung, bleibt ganz.
            {"id": "L2", "typ": "linie", "lastfall": "ABG", "wert": 4.0,
             "polylinie": [[0, 0.40], [6, 0.40]]},
            # Stütze darüber, 5 cm versetzt: in die Stütze.
            {"id": "L3", "typ": "punkt", "lastfall": "NUTZ", "wert": 50.0, "p": [8.05, 0]},
            # Einzellast im Feld: bleibt.
            {"id": "L4", "typ": "punkt", "lastfall": "NUTZ", "wert": 7.0, "p": [4, 2]},
            # Flächenlast: wird nicht angefasst.
            {"id": "L5", "typ": "flaeche", "lastfall": "NUTZ", "wert": 2.0,
             "polygon": [[0, -1], [9, -1], [9, 3], [0, 3]]},
        ],
    }
    breiten = kette.halbbreiten([
        {"global_id": "W1", "rolle": "wand", "dicke_tragend_m": 0.24},
        {"global_id": "W2", "rolle": "wand", "dicke_tragend_m": 0.24},
        {"global_id": "S1", "rolle": "stuetze", "flaeche_m2": 0.09}])
    alles_gut &= pruefe(abs(breiten["S1"] - 0.15) < 1e-9 and abs(breiten["W1"] - 0.12) < 1e-9,
                        "halbe Breiten: Wand ½·t, Stütze ½·√A", breiten)
    durch_d = kette.durchleiten(modell_d, breiten)
    je = {}
    for e in durch_d:
        je[e["lager"]] = je.get(e["lager"], 0.0) + e["kN"]
    alles_gut &= pruefe(abs(je.get("A1", 0) - 20.0) < 1e-6 and abs(je.get("A2", 0) - 30.0) < 1e-6,
                        "die Wand darüber geht zu 2 m in A1 und zu 3 m in A2", je)
    alles_gut &= pruefe(abs(je.get("A3", 0) - 50.0) < 1e-6,
                        "die Stütze darüber geht ganz in die Stütze darunter", je.get("A3"))
    rest_l1 = [l for l in modell_d["lasten"] if (l.get("id") or "").startswith("L1")]
    alles_gut &= pruefe(len(rest_l1) == 1 and abs(kette._laenge(rest_l1[0]["polylinie"]) - 1.0) < 1e-6,
                        "über der Tür bleibt 1 m Linienlast auf der Platte",
                        [kette._laenge(l["polylinie"]) for l in rest_l1])
    ids = sorted(l["id"] for l in modell_d["lasten"])
    alles_gut &= pruefe(ids == ["L1", "L2", "L4", "L5"],
                        "versetzte Wand, Feldlast und Flächenlast bleiben", ids)
    vorher = 10.0 * 6 + 4.0 * 6 + 50.0 + 7.0
    nachher = (sum(e["kN"] for e in durch_d)
               + sum(float(l["wert"]) * kette._laenge(l["polylinie"])
                     for l in modell_d["lasten"] if l["typ"] == "linie")
               + sum(float(l["wert"]) for l in modell_d["lasten"] if l["typ"] == "punkt"))
    alles_gut &= pruefe(abs(vorher - nachher) < 1e-6,
                        "die Resultierende bleibt (Platte + Durchleitung)", nachher, vorher)

    # Buchung: NUTZ hat die Platte nie gesehen (kein Feld) — die Liste
    # entsteht aus den Lagern.
    bericht_d = {"auflager_lastfallweise": {
        "ABG": [{"id": "A1", "R_z_kN": 1.0, "laenge_m": 2.0},
                {"id": "A2", "R_z_kN": 2.0, "laenge_m": 3.0},
                {"id": "A3", "R_z_kN": 0.0, "laenge_m": 0.0}]}}
    gebucht = kette.durchleitung_buchen(bericht_d, modell_d)
    lf = bericht_d["auflager_lastfallweise"]
    a1 = next(e for e in lf["ABG"] if e["id"] == "A1")
    a3 = next(e for e in lf.get("NUTZ", []) if e["id"] == "A3")
    alles_gut &= pruefe(abs(gebucht - 100.0) < 1e-6 and abs(a1["R_z_kN"] - 21.0) < 1e-6
                        and abs(a3["R_z_kN"] - 50.0) < 1e-6,
                        "gebucht je Lastfall und Lager, NUTZ neu angelegt",
                        (gebucht, a1["R_z_kN"], a3["R_z_kN"]))
    pakete_d = la.aus_auflagerbilanz(bericht_d, "EG")
    alles_gut &= pruefe(abs(sum(p.anteile_kN.get("NUTZ", 0) for p in pakete_d["S1"]) - 50.0) < 1e-6,
                        "die Stütze darunter bekommt ihr Paket", pakete_d.get("S1"))

    # Ecke: eine Last entlang A1 bis über das Ende hinaus, Stummel 3 cm.
    modell_e = {"auflager": [{"id": "A1", "typ": "linie", "polylinie": [[0, 0], [2, 0]],
                              "bauteile": ["W1"]}],
                "lasten": [{"id": "L1", "typ": "linie", "lastfall": "ABG", "wert": 10.0,
                            "polylinie": [[0, 0], [2.03, 0]]}]}
    durch_e = kette.durchleiten(modell_e, breiten)
    alles_gut &= pruefe(not modell_e["lasten"] and abs(durch_e[0]["kN"] - 20.3) < 1e-6,
                        "ein Stummel von 3 cm über das Wandende geht mit ins Lager",
                        (modell_e["lasten"], durch_e[0]["kN"] if durch_e else None))

    # ── 8c — Teile, Stahlprofile, Lasten ohne Decke, Füße auf dem Gelände ──
    print("\nTeile eines Bauteils, Stahlprofile als Proxy")
    boxen_t = {
        # Eine Wand aus zwei Schichtteilen (ArchiCAD), ohne eigenen Körper.
        "T1": {"lo": [0, 0, 0], "hi": [4, 0.175, 2.6], "ifc_type": "IfcBuildingElementPart",
               "material": "Kalksandstein", "volumen_m3": 1.82,
               "grundriss": {"winkel_grad": 0.0, "laenge_m": 4.0, "breite_m": 0.175, "mitte": [2, 0.0875]}},
        "T2": {"lo": [0, 0.175, 0], "hi": [4, 0.335, 2.6], "ifc_type": "IfcBuildingElementPart",
               "material": "Mineralwolle", "volumen_m3": 1.664,
               "grundriss": {"winkel_grad": 0.0, "laenge_m": 4.0, "breite_m": 0.16, "mitte": [2, 0.255]}},
        # Eine Decke aus fünf Balkenteilen.
        **{f"B{i}": {"lo": [i * 0.6, 3, 2.6], "hi": [i * 0.6 + 0.12, 7.5, 2.84],
                     "ifc_type": "IfcBuildingElementPart", "material": "Bauholz",
                     "grundriss": {"winkel_grad": 90.0, "laenge_m": 4.5, "breite_m": 0.12,
                                   "mitte": [i * 0.6 + 0.06, 5.25]}} for i in range(5)},
        # Ein HEA liegend und eines stehend, als Proxy.
        "P1": {"lo": [0, 8, 2.3], "hi": [6.4, 8.24, 2.53], "ifc_type": "IfcBuildingElementProxy",
               "name": "HEA 240"},
        "P2": {"lo": [9, 9, 0], "hi": [9.24, 9.23, 3.0], "ifc_type": "IfcBuildingElementProxy",
               "name": "HEA 240"},
        "X": {"lo": [9, 0, 0], "hi": [9.5, 0.5, 1.0], "ifc_type": "IfcBuildingElementProxy",
              "name": "Badewanne"},
    }
    eltern_t = {"T1": {"global_id": "W", "ifc_type": "IfcWall", "name": "Wand-013"},
                "T2": {"global_id": "W", "ifc_type": "IfcWall", "name": "Wand-013"},
                **{f"B{i}": {"global_id": "D", "ifc_type": "IfcSlab", "name": "Unterzug-028"}
                   for i in range(5)}}
    zugang_t = kette.Zugang(schnitt=lambda box, mode, h: {"figures": [
        {"global_id": "T1", "ifc_type": "IfcBuildingElementPart", "kind": "schnitt",
         "material": "Kalksandstein", "rings": [[[0, 0], [4, 0], [4, 0.175], [0, 0.175]]]},
        {"global_id": "T2", "ifc_type": "IfcBuildingElementPart", "kind": "schnitt",
         "material": "Mineralwolle", "rings": [[[0, 0.175], [4, 0.175], [4, 0.335], [0, 0.335]]]},
        {"global_id": "P2", "ifc_type": "IfcBuildingElementProxy", "kind": "schnitt",
         "rings": [[[9, 9], [9.24, 9], [9.24, 9.23], [9, 9.23]]]}]},
        geschosse=[], psets={}, boxen={k: dict(v) for k, v in boxen_t.items()},
        huelle={}, rechne=None, eltern=eltern_t)
    w = zugang_t.boxen.get("W") or {}
    alles_gut &= pruefe(
        "T1" not in zugang_t.boxen and w.get("ifc_type") == "IfcWall"
        and abs(w.get("volumen_m3", 0) - 3.484) < 1e-9 and w.get("material") == "Kalksandstein"
        and sorted(round(sch["dicke_m"], 3) for sch in w["materialschichten"]) == [0.16, 0.175],
        "zwei Schichtteile werden eine Wand: Volumen summiert, Schichten mit Dicke",
        w)
    alles_gut &= pruefe(
        all(zugang_t.boxen.get(f"B{i}", {}).get("ifc_type") == "IfcBeam" for i in range(5))
        and "D" not in zugang_t.boxen,
        "eine Decke aus fünf Balkenteilen bleibt fünf Balken",
        [zugang_t.boxen.get(f"B{i}", {}).get("ifc_type") for i in range(5)])
    alles_gut &= pruefe(
        zugang_t.boxen["P1"]["ifc_type"] == "IfcBeam" and zugang_t.boxen["P2"]["ifc_type"] == "IfcColumn"
        and zugang_t.boxen["X"]["ifc_type"] == "IfcBuildingElementProxy",
        "HEA 240 liegend ein Träger, stehend eine Stütze; die Badewanne bleibt Proxy",
        [zugang_t.boxen[k]["ifc_type"] for k in ("P1", "P2", "X")])
    figuren_t = zugang_t.schnitt({}, "grundriss", 1.0)["figures"]
    wand_f = [f for f in figuren_t if f["global_id"] == "W"]
    alles_gut &= pruefe(
        len(wand_f) == 1 and len(wand_f[0]["rings"]) == 2
        and wand_f[0]["material"] == "Kalksandstein"
        and any(f["global_id"] == "P2" and f["ifc_type"] == "IfcColumn" for f in figuren_t),
        "im Schnitt eine Wandfigur mit beiden Schichtringen, das HEA als Stütze",
        [(f["global_id"], f["ifc_type"], len(f["rings"])) for f in figuren_t])

    print("\nLasten ohne Decke auf Wänden und Stützen, Füße auf dem Gelände")
    konten_d = {("S1", "UG"): la.Konto(global_id="S1", geschoss="UG", rolle="stuetze", name="S1"),
                ("W1", "UG"): la.Konto(global_id="W1", geschoss="UG", rolle="wand", name="W1")}
    waende_d = [{"global_id": "S1", "rolle": "stuetze", "tragend": True, "punkt": [2.0, 2.0],
                 "flaeche_m2": 0.0144},
                {"global_id": "W1", "rolle": "wand", "tragend": True, "achsen": [[[0, 0], [4, 0]]],
                 "dicke_tragend_m": 0.24}]
    lasten_d = [{"typ": "punkt", "p": [2.05, 2.0], "wert": 30.0, "lastfall": "ABG", "bezug": "O1"},
                {"polylinie": [[2, 0.05], [6, 0.05]], "wert": 10.0, "lastfall": "NUTZ", "bezug": "O2"},
                {"typ": "punkt", "p": [8, 8], "wert": 5.0, "lastfall": "ABG", "bezug": "O3"}]
    rest_d, unten_d = kette._direkt_auf_lager(lasten_d, waende_d, konten_d, {"name": "UG"},
                                              False, {"ABG": "G", "NUTZ": "Q"})
    gebucht_s = sum(p.anteile_kN.get("ABG", 0) for p in konten_d[("S1", "UG")].eingang)
    gebucht_w = sum(p.anteile_kN.get("NUTZ", 0) for p in konten_d[("W1", "UG")].eingang)
    alles_gut &= pruefe(abs(gebucht_s - 30.0) < 1e-9 and abs(gebucht_w - 20.0) < 1e-6,
                        "die Stütze nimmt 30 kN, die Wand 2 m der Linienlast (20 kN)",
                        (gebucht_s, gebucht_w))
    rest_kN = sum(l["wert"] * kette._laenge(l["polylinie"]) if "polylinie" in l else l["wert"]
                  for l in rest_d)
    unten_kN = sum(l["wert"] * kette._laenge(l["polylinie"]) if "polylinie" in l else l["wert"]
                   for l in unten_d)
    alles_gut &= pruefe(abs(rest_kN - 25.0) < 1e-6 and abs(unten_kN - 50.0) < 1e-6,
                        "Rest bleibt offen (2 m Linie + Einzellast daneben), Gebuchtes geht am Fuß weiter",
                        (rest_kN, unten_kN))
    boxen_g = {"C": {"lo": [0, 0, 4.85], "hi": [0.1, 0.1, 7.3], "name": "Carportstütze"},
               "H": {"lo": [5, 5, 6.0], "hi": [5.2, 5.2, 9.0], "name": "Wand hängt"}}
    gelaende, offen_g = kette._auf_dem_gelaende(
        [{"typ": "punkt", "p": [0.05, 0.05], "wert": 40.0, "lastfall": "EG", "bezug": "C"},
         {"typ": "punkt", "p": [5.1, 5.1], "wert": 7.0, "lastfall": "EG", "bezug": "H"},
         {"typ": "punkt", "p": [0.05, 0.05], "wert": 3.0, "lastfall": "EG", "bezug": "C",
          "ueber_nicht_gerechnet": True}],
        boxen_g, {"boden": 2.35, "decke": 5.35}, {})
    alles_gut &= pruefe(len(gelaende) == 1 and gelaende[0]["N_k_kN"] == 40.0 and len(offen_g) == 2,
                        "die Carportstütze steht auf dem Gelände; hängende Wand und Last über "
                        "nicht gerechnetem Feld bleiben offen", (gelaende, offen_g))

    # ── 8d — Geschosse aus Decken und Balkenlagen (Modelle ohne IfcBuildingStorey) ──
    print("\nGeschosse aus Decken und Holzbalkenlagen")

    def balken(x, y0, y1, z0, z1, b=0.14):
        return {"lo": [x, y0, z0], "hi": [x + b, y1, z1], "ifc_type": "IfcBeam",
                "material": "Nadelholz C24",
                "grundriss": {"winkel_grad": 90.0, "laenge_m": y1 - y0, "breite_m": b,
                              "mitte": [x + b / 2, (y0 + y1) / 2]}}

    boxen_h = {
        # Bodenplatte 10 × 8 m, Oberkante +0,30
        "BPL": {"lo": [0, 0, 0.0], "hi": [10, 8, 0.30], "ifc_type": "IfcSlab", "name": "BPL 300"},
        # Eine Stützmauer am Hang, unter der Platte: kein Geschoss
        "HANG": {"lo": [-3, -1, -2.9], "hi": [-2.8, 9, 0.0], "ifc_type": "IfcWall"},
        # EG-Wände
        **{f"WE{i}": {"lo": [x, 0, 0.30], "hi": [x + 0.2, 8, 2.90], "ifc_type": "IfcWall"}
           for i, x in enumerate((0.0, 4.9, 9.8))},
        # Balkenlage über dem EG, e = 0,6 m, Oberkante +3,10
        **{f"BL{i}": balken(0.3 + 0.6 * i, 0.0, 8.0, 2.90, 3.10) for i in range(15)},
        # Schwellen der OG-Wände, flach und gleich hoch, aber Raumbreiten auseinander
        **{f"SW{i}": balken(x, 0.0, 8.0, 3.10, 3.20, b=0.16) for i, x in enumerate((0.0, 4.9, 9.8, 14.0))},
        # OG-Wände bis +5,60, darauf Pfosten bis +6,20, Dachlage +6,20…+6,40
        **{f"WO{i}": {"lo": [x, 0, 3.20], "hi": [x + 0.2, 8, 5.60], "ifc_type": "IfcWall"}
           for i, x in enumerate((0.0, 4.9, 9.8))},
        **{f"PF{i}": {"lo": [x, 4, 5.60], "hi": [x + 0.12, 4.12, 6.20], "ifc_type": "IfcColumn"}
           for i, x in enumerate((0.0, 4.9, 9.8))},
        **{f"DL{i}": balken(0.3 + 0.6 * i, 0.0, 8.0, 6.20, 6.40) for i in range(15)},
        # Ein Einzelfundament neben der Platte
        "FT": {"lo": [12, 2, -0.5], "hi": [13, 3, 0.3], "ifc_type": "IfcFooting"},
    }
    ebenen_h = kette._balkenebenen(boxen_h)
    alles_gut &= pruefe(
        sorted(round(z, 2) for z, _ in ebenen_h) == [3.10, 6.40]
        and all(f > 50 for _, f in ebenen_h),
        "zwei Balkenlagen als Ebenen, die Schwellen nicht",
        ebenen_h)
    geschosse_h = kette.geschosse_aus_decken(boxen_h)
    alles_gut &= pruefe(
        [(g["name"], g["boden"], g["decke"]) for g in geschosse_h]
        == [("EG", 0.3, 3.1), ("OG1", 3.1, 5.6), ("OG2", 5.6, 6.4)]
        or [(g["name"], g["boden"], g["decke"]) for g in geschosse_h]
        == [("EG", 0.3, 3.1), ("OG1", 3.1, 6.4)],
        "Geschosse von der Bodenplatte aus, die Stützmauer macht kein Untergeschoss",
        [(g["name"], g["boden"], g["decke"]) for g in geschosse_h])
    alles_gut &= pruefe(
        abs(kette._wandschnitt_ueber_boden(0.48) - 0.24) < 1e-9
        and abs(kette._wandschnitt_ueber_boden(2.6) - 1.17) < 1e-9
        and abs(kette._wandschnitt_ueber_boden(5.0) - 1.2) < 1e-9,
        "Wandschnitt: im 0,48 m hohen Geschoss auf halber Höhe, sonst 45 % bis 1,20 m",
        [kette._wandschnitt_ueber_boden(h) for h in (0.48, 2.6, 5.0)])
    og2 = {"name": "OG2", "boden": 5.6, "decke": 6.4, "abgeleitet": True}
    lagen_og2 = kette.balkenlagen(og2, 6.4, boxen_h)
    alles_gut &= pruefe(
        len(lagen_og2) == 1 and abs(lagen_og2[0]["z_oben"] - 6.40) < 1e-6,
        "die Dachlage über dem niedrigen Pfostengeschoss wird gefunden",
        [(l.get("name"), l.get("z_oben")) for l in lagen_og2])
    alles_gut &= pruefe(
        not kette.balkenlagen({**og2, "abgeleitet": False}, 6.4, boxen_h),
        "… aber nur bei abgeleiteten Geschossen (sonst gilt die lichte Mindesthöhe)")
    sohle = kette.bodenplatte(geschosse_h, boxen_h)
    alles_gut &= pruefe(
        {p["global_id"] for p in sohle} == {"BPL", "FT"},
        "Bodenplatte und das kleine Einzelfundament daneben",
        [p["global_id"] for p in sohle])

    # ── 8e — Lager aus der Wandkrone, freie Ränder ──
    print("\nLager aus der Wandkrone (Sturz), freie Plattenränder")
    unten = {"figures": [{"global_id": "WN", "ifc_type": "IfcWall", "kind": "schnitt",
                          "material": "Kalksandstein",
                          "rings": [[[0, 0], [3, 0], [3, 0.24], [0, 0.24]],
                                    [[4.5, 0], [10, 0], [10, 0.24], [4.5, 0.24]]]}]}
    oben = {"figures": [{"global_id": "WN", "ifc_type": "IfcWall", "kind": "schnitt",
                         "material": "Kalksandstein",
                         "rings": [[[0, 0], [3, 0], [4.5, 0], [10, 0], [10, 0.24],
                                    [4.5, 0.24], [3, 0.24], [0, 0.24]]]}]}
    decke_s = {"figures": [{"global_id": "D", "ifc_type": "IfcSlab", "kind": "schnitt",
                            "material": "Stahlbeton",
                            "rings": [[[0, 0], [10, 0], [10, 6], [0, 6]]]}]}
    boxen_s = {"D": {"lo": [0, 0, 2.8], "hi": [10, 6, 3.0], "ifc_type": "IfcSlab"},
               "WN": {"lo": [0, 0, 0], "hi": [10, 0.24, 2.8], "ifc_type": "IfcWall",
                      "material": "Kalksandstein"}}
    def modell_mit(kronen):
        return tm.statikmodell(decke_s, unten, job_id="t", modellname="t",
                               geschoss={"name": "EG", "boden": 0.0, "decke": 2.8},
                               boxen=boxen_s, psets={}, platte_gid="D",
                               annahmen={"nur_tragende": True}, kronen=kronen)
    ohne_krone = modell_mit(None)["modell"]["auflager"]
    mit_krone = modell_mit(oben)
    lager_k = mit_krone["modell"]["auflager"]
    alles_gut &= pruefe(
        len(ohne_krone) == 2 and len(lager_k) == 1
        and abs(kette._laenge(lager_k[0]["polylinie"]) - 10.0) < 1e-6
        and mit_krone["protokoll"]["lager_ueber_sturz"],
        "über dem Fenster trägt der Sturz: ein Lager von 10 m statt zwei Stücken",
        ([kette._laenge(a["polylinie"]) for a in ohne_krone],
         [kette._laenge(a["polylinie"]) for a in lager_k]))
    wn = next(w for w in mit_krone["protokoll"]["waende"] if w["global_id"] == "WN")
    alles_gut &= pruefe(
        sorted(round(kette._laenge(a), 2) for a in wn.get("fuss_achsen") or []) == [3.0, 5.5],
        "die Fußkraft geht weiter durch die beiden Pfeiler (3,0 + 5,5 m), nicht durch die Öffnung",
        wn.get("fuss_achsen"))
    staender_f = {"figures": [
        {"global_id": "HW", "ifc_type": "IfcWall", "kind": "schnitt", "material": "Holz - OSB",
         "rings": [[[0, 0], [10, 0], [10, 0.2], [0, 0.2]]]},
        *[{"global_id": f"ST{i}", "ifc_type": "IfcColumn", "kind": "schnitt",
           "material": "Holz - C 24",
           "rings": [[[x, 0.06], [x + 0.08, 0.06], [x + 0.08, 0.14], [x, 0.14]]]}
          for i, x in enumerate((0.5, 1.1, 1.7, 2.3))],
        {"global_id": "SS", "ifc_type": "IfcColumn", "kind": "schnitt", "material": "Stahl S235",
         "rings": [[[5, 3], [5.2, 3], [5.2, 3.2], [5, 3.2]]]}]}
    boxen_st = {"D": boxen_s["D"],
                "HW": {"lo": [0, 0, 0], "hi": [10, 0.2, 2.8], "ifc_type": "IfcWall",
                       "material": "Holz - OSB"},
                **{f"ST{i}": {"lo": [0, 0, 0], "hi": [0.08, 0.08, 2.8], "ifc_type": "IfcColumn",
                              "volumen_m3": 0.08 * 0.08 * 2.8, "material": "Holz - C 24"}
                   for i in range(4)},
                "SS": {"lo": [5, 3, 0], "hi": [5.2, 3.2, 2.8], "ifc_type": "IfcColumn"}}
    mit_staendern = tm.statikmodell(decke_s, staender_f, job_id="t", modellname="t",
                                    geschoss={"name": "EG", "boden": 0.0, "decke": 2.8},
                                    boxen=boxen_st,
                                    psets={"HW": {"Pset_WallCommon": {"LoadBearing": True}}},
                                    platte_gid="D",
                                    annahmen={"nur_tragende": True})
    hw = next(w for w in mit_staendern["protokoll"]["waende"] if w["global_id"] == "HW")
    arten_st = sorted(a.get("typ") for a in mit_staendern["modell"]["auflager"])
    alles_gut &= pruefe(
        arten_st == ["linie", "punkt"] and len(hw.get("staender") or []) == 4
        and abs(hw["staender_kN"] - 4 * 0.08 * 0.08 * 2.8 * 4.2) < 1e-3,
        "vier Ständer in der Holzwand: ein Lager für die Wand, ihr Gewicht an der Wand; "
        "die freie Stahlstütze bleibt ein Punktlager",
        (arten_st, hw.get("staender"), hw.get("staender_kN")))
    raender_s = kette.freie_raender(mit_krone["modell"])
    alles_gut &= pruefe(
        abs(raender_s["rand_m"] - 32.0) < 1e-6 and raender_s["stuecke"]
        and abs(raender_s["laengstes_m"] - (32.0 - 10.0 - 2 * 0.84)) < 0.05
        and not raender_s["stuecke"][0]["zwischen_stuetzen"],
        "nur die Südwand trägt: der Rest des Rands ist frei und wird gemeldet",
        raender_s)

    # ── 9 — Dasselbe Haus, erkannt über das Material statt über das Pset ──
    #
    # Der Fall, für den `ileen/tragend.py` gebaut wurde: ein
    # Architekturmodell ohne gepflegtes `Pset_WallCommon.LoadBearing`. Bis
    # dahin war jede Wand ein Auflager — und in einem Modell mit
    # Gipskartonwänden lag die Decke auf einem Wald aus Lagern.
    #
    # Geprüft wird die schärfste Form: **dasselbe Ergebnis**. Kommt hier eine
    # andere Gründungslast heraus, ist die Erkennung nicht gleichwertig,
    # sondern nur ähnlich.
    print("\n9 — Materialerkennung ersetzt das Pset gleichwertig")
    GERECHNETE_MODELLE.clear()
    ueber_material = kette.rechne_kette(
        zugang(ueber_material=True),
        {"nur_tragende": True, "beton": "C25/30", "ausbaulast_kNm2": AUSBAU,
         "nutzlast_kategorie": "A2"})

    alles_gut &= pruefe(
        abs(ueber_material["gruendung"]["summe_kN"]
            - ergebnis["gruendung"]["summe_kN"]) < 0.1,
        f"gleiche Gründungslast ({ueber_material['gruendung']['summe_kN']:.1f} kN) — "
        f"die gedämmte Außenwand wurde an ihrer Kalksandsteinschicht erkannt, "
        f"nicht an der dickeren Dämmung",
        round(ueber_material["gruendung"]["summe_kN"], 1),
        round(ergebnis["gruendung"]["summe_kN"], 1))
    alles_gut &= pruefe(ueber_material["bilanz"]["erhalten"],
                        "und die Erhaltungsprobe stimmt auch dort")

    # Der eigentliche Beweis: die Gipskartonwand quer durch Baukörper A führt
    # kein Konto. Ohne Materialerkennung wäre sie ein Linienlager mitten im
    # Feld — sie trägt kein Pset, und `tragend = None` hätte sie drin gelassen.
    gk_konten = [k for k in ueber_material["konten"]
                 if str(k.get("global_id", "")).startswith("TRENNWAND")]
    alles_gut &= pruefe(
        not gk_konten,
        "die Gipskartonwand führt kein Konto — sie ist kein Auflager",
        [k["global_id"] for k in gk_konten], "[]")

    # Und sie steht in keinem gerechneten Modell als Lager. Je Baukörper genau
    # ein Auflager: die umlaufende Außenwand auf ihrer Achse.
    # Die Bodenplatten ausgenommen: sie sind gebettet und haben bewusst kein
    # Auflager — der Boden hält sie flächig.
    lager_je_modell = [len(m.get("auflager", [])) for m in GERECHNETE_MODELLE
                       if not str(m["plan"].get("submodell", "")).startswith(
                           "submodell.FUND")]
    alles_gut &= pruefe(
        set(lager_je_modell) == {1},
        f"je Deckenfeld genau ein Lager (die Außenwand), nicht zwei",
        lager_je_modell, "alle 1")

    gebettet = [m for m in GERECHNETE_MODELLE
                if str(m["plan"].get("submodell", "")).startswith("submodell.FUND")]
    alles_gut &= pruefe(
        len(gebettet) == 2 and all(not m.get("auflager") for m in gebettet)
        and all(m["system"][0].get("bettung_kNm3") for m in gebettet),
        f"die beiden Bodenplatten sind gebettet und haben kein Auflager",
        [(len(m.get("auflager", [])), m["system"][0].get("bettung_kNm3"))
         for m in gebettet], "je (0, 20000.0)")

    # ── 9b — Jedes Bauteil wiegt nach seinem Werkstoff ───────────────────
    #
    # Der Fehler, gegen den das hier steht: `kette.py` rief
    # `eigengewicht_wand()` und `eigengewicht_stuetze()` ohne `wichte_kNm3`
    # auf. Damit blieb der Vorgabewert 25 kN/m³ stehen — Stahlbeton, für
    # jedes Bauteil. Ein Holzbau wog in der Kette das Fünffache, quer durch
    # alle Geschosse bis in die Gründungslast, und die Erhaltungsprobe merkte
    # nichts davon: sie summiert dieselben falschen Zahlen zweimal.
    #
    # Aufgefallen ist er an einem Einfamilienhaus in Holzständerbauweise,
    # dessen Gründungslast mit 3508 kN ausgewiesen war statt mit 2288 kN.
    print("\n9b — die Wichte richtet sich nach dem Werkstoff")

    alles_gut &= pruefe(
        la.wichte_tragend("holz", "wand") == (5.0, True)
        and la.wichte_tragend("holz", "stuetze") == (4.2, True),
        "Holz wiegt 5,0 kN/m³ als Ständerwand und 4,2 als Vollholzstütze",
        (la.wichte_tragend("holz", "wand"), la.wichte_tragend("holz", "stuetze")),
        "((5.0, True), (4.2, True))")

    alles_gut &= pruefe(
        la.wichte_tragend(None, "wand") == (25.0, False),
        "ohne erkannten Werkstoff bleibt es bei Stahlbeton — aber als Annahme "
        "gekennzeichnet",
        la.wichte_tragend(None, "wand"), "(25.0, False)")

    # Die Kalksandsteinwand des Attrappenhauses: Mauerwerk, nicht Stahlbeton.
    # Geprüft wird an den Konten selbst, nicht an der Tabelle — dazwischen
    # liegt der Aufruf, der der eigentliche Fehler war.
    aussenwaende = [k for k in ueber_material["konten"]
                    if k["rolle"] == "wand" and k.get("wichte_kNm3")]
    alles_gut &= pruefe(
        aussenwaende and all(k["wichte_kNm3"] == 18.0 for k in aussenwaende),
        f"die {len(aussenwaende)} Außenwände sind mit 18,0 kN/m³ gerechnet "
        f"(Mauerwerk), nicht mit 25,0",
        sorted({k["wichte_kNm3"] for k in aussenwaende}), "[18.0]")

    # Und dasselbe über den Pset-Weg. Das ist die Stelle, an der die
    # Werkstofffrage von der Tragfrage getrennt werden musste: das Pset sagt
    # nur, *ob* die Wand trägt. Wer daraus auch ableitet, *woraus* sie ist,
    # nimmt den Materialnamen des Bauteils — und der ist bei diesem Aufbau
    # die 20 cm Dämmung, nicht der 17,5 cm Kalksandstein dahinter.
    ueber_pset = [k for k in ergebnis["konten"]
                  if k["rolle"] == "wand" and k.get("wichte_kNm3")]
    alles_gut &= pruefe(
        ueber_pset and all(k["wichte_kNm3"] == 18.0 for k in ueber_pset),
        "über das Pset erkannt ergibt dieselbe Wichte — die Dämmung färbt "
        "nicht auf den Werkstoff ab",
        sorted({k["wichte_kNm3"] for k in ueber_pset}), "[18.0]")

    # ── 10 — Veraltung: eine Änderung in OG2 trifft alles darunter ────────
    #
    # Das Akzeptanzkriterium in seiner schärfsten Form: nicht am Attrappenhaus
    # von `test_stand.py`, sondern an den Hashes, die die Kette tatsächlich
    # gebildet hat. Ein Hash, der hier nicht anspringt, springt nirgends an.
    print("\n10 — Veraltung pflanzt sich nach unten fort")
    from ileen import stand as sd  # noqa: PLC0415

    GERECHNETE_MODELLE.clear()
    erst = kette.rechne_kette(zugang(), {"dicke_m": DECKENDICKE,
                                         "ausbaulast_kNm2": AUSBAU,
                                         "nutzlast_kategorie": "A2"})
    hashes_erst = {m["plan"]["submodell"]: m["plan"]["eingabe_hash"]
                   for m in GERECHNETE_MODELLE}

    # Derselbe Lauf noch einmal: die Hashes müssen bitgleich sein, sonst meldet
    # die Anzeige bei jedem Lauf „geändert" und wird ignoriert.
    GERECHNETE_MODELLE.clear()
    kette.rechne_kette(zugang(), {"dicke_m": DECKENDICKE,
                                  "ausbaulast_kNm2": AUSBAU,
                                  "nutzlast_kategorie": "A2"})
    hashes_wieder = {m["plan"]["submodell"]: m["plan"]["eingabe_hash"]
                     for m in GERECHNETE_MODELLE}
    alles_gut &= pruefe(hashes_erst == hashes_wieder,
                        f"derselbe Lauf ergibt dieselben Hashes "
                        f"({len(hashes_erst)} Submodelle)",
                        len(hashes_erst), len(hashes_wieder))

    # Jetzt eine echte Änderung: ein Auflager im 1. OG entfernt.
    from ileen import eingriffe as eg  # noqa: PLC0415
    GERECHNETE_MODELLE.clear()
    kette.rechne_kette(
        zugang(), {"dicke_m": DECKENDICKE, "ausbaulast_kNm2": AUSBAU,
                   "nutzlast_kategorie": "A2"},
        eingriffe=[eg.pruefe({"art": "lager_entfernen",
                              "bauteil": WAND_GID[("A", "1.OG")]})])
    hashes_neu = {m["plan"]["submodell"]: m["plan"]["eingabe_hash"]
                  for m in GERECHNETE_MODELLE}

    geaendert = {n for n in hashes_erst
                 if hashes_erst.get(n) != hashes_neu.get(n)}
    print(f"        geändert: {sorted(geaendert)}")

    # Das 2. OG liegt darüber und bleibt unberührt.
    alles_gut &= pruefe(
        not any(n.startswith("submodell.OG2") for n in geaendert),
        "das 2. OG darüber behält seinen Hash",
        sorted(n for n in geaendert if n.startswith("submodell.OG2")), "[]")
    # Das 1. OG selbst und alles darunter ändert sich — der Eingriff nimmt
    # ein Lager weg, und die Lasten wandern anders.
    alles_gut &= pruefe(
        any(n.startswith("submodell.OG1") for n in geaendert),
        "das 1. OG selbst ändert sich",
        sorted(geaendert), "enthält submodell.OG1…")
    alles_gut &= pruefe(
        any(n.startswith("submodell.EG") for n in geaendert),
        "und das Erdgeschoss darunter auch — die Last kommt anders an",
        sorted(geaendert), "enthält submodell.EG…")

    # Und die Propagierung macht daraus die Anzeige.
    bestand = {n: {"art": sd.GESCHOSS, "hash": hashes_neu.get(n, h),
                   "rechnung": {"id": "r1", "hash": h, "status": "fertig"}}
               for n, h in hashes_erst.items()}
    zustaende = sd.propagiere(bestand)
    gesamt = sd.gesamtzustand(zustaende)
    alles_gut &= pruefe(gesamt["zustand"] == sd.VERALTET,
                        f"das Gesamtsystem steht auf veraltet: {gesamt['grund']}",
                        gesamt["zustand"], sd.VERALTET)
    alles_gut &= pruefe(
        all(zustaende[n]["zustand"] == sd.AKTUELL
            for n in zustaende if n.startswith("submodell.OG2")),
        "die Geschosse darüber bleiben gültig",
        [zustaende[n]["zustand"] for n in zustaende
         if n.startswith("submodell.OG2")], "alle aktuell")
    alles_gut &= pruefe(
        all(zustaende[n]["zustand"] == sd.VERALTET
            for n in zustaende if n.startswith(("submodell.EG", "submodell.FUND"))),
        "Erdgeschoss und Gründung sind veraltet",
        [zustaende[n]["zustand"] for n in zustaende
         if n.startswith(("submodell.EG", "submodell.FUND"))], "alle veraltet")

    if ergebnis["hinweise"]:
        print("\nHinweise der Kette:")
        for h in ergebnis["hinweise"]:
            print(f"  · {h}")

    print("\n" + ("Alle Prüfungen bestanden." if alles_gut else "FEHLGESCHLAGEN."))
    return 0 if alles_gut else 1


if __name__ == "__main__":
    sys.exit(main())
