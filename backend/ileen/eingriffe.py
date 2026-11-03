"""
Das statische System nachträglich ändern — am Submodell, an dem es gilt.

`tragwerksmodell.py` leitet aus dem IFC ein System ab: Deckenumriss, Wände als
Linienlager auf ihrer Achse, Stützen als Punktlager. Diese Ableitung ist eine
Vermutung. Sie liest aus Geometrie, was eigentlich eine Entscheidung des
Tragwerksplaners ist — welche Wand trägt, wo sie gelenkig und wo eingespannt
gelagert ist, welche Wand nur aussteift.

Dieses Modul hält die **Eingriffe**: kleine, benannte Änderungen am
abgeleiteten System. Die Ableitung bleibt unverändert; sie wird bei jedem Lauf
neu gemacht, und die Eingriffe legen sich darüber.

## Warum die Weitergabe nach unten von selbst stimmt

Die Kette ist eine reine Funktion ihrer Eingaben. Wer ein Auflager entfernt,
entfernt damit

    kein Lager  →  keine Auflagerkraft  →  kein Konto  →  keine Fußkraft
                →  keine Linienlast auf die Decke darunter

und das setzt sich bis zur Gründung fort, ohne dass irgendjemand eine
Fortpflanzungsregel schreiben müsste. Die Decke darüber verteilt ihre Last
zugleich auf die verbliebenen Lager um — sie spannt jetzt weiter.

Genau deshalb ist ein Eingriff für sich noch kein Ergebnis: er ändert keine
einzige Zahl, bis neu gerechnet wurde. Sichtbar wird das nicht über ein
Merkmal, das jemand setzen muss, sondern über den Eingabe-Hash des Submodells
(`submodell.py`, `hash_der_eingabe()`): ein Eingriff geht in ihn ein, der Hash
stimmt nicht mehr mit dem des letzten Rechenstands überein, und das Submodell
samt allem darunter steht auf „veraltet".

## Warum ein Eingriff auf die GlobalId zeigt und nicht auf „A7"

Lagerkennungen (`A1`, `A2`, …) entstehen beim Ableiten und zählen die Reihen-
folge, in der der Schnitt die Wände zurückgibt. Eine geänderte Netzweite, eine
andere Schnitthöhe, eine Wand mehr — und `A7` ist eine andere Wand. Ein
Eingriff, der auf `A7` zeigt, wäre beim nächsten Lauf still auf das falsche
Bauteil gewandert; still, weil `A7` ja existiert.

Deshalb ist der Anker die **GlobalId** des Bauteils. Sie steht im IFC, sie
überlebt jede Neuableitung, und wenn das Bauteil verschwindet, findet der
Eingriff nichts und sagt das im Protokoll, statt daneben zu greifen.

## Warum ein Eingriff ohne Submodell überall gilt

Eine GlobalId gibt es nur einmal im Bauwerk — wer sagt „diese Wand trägt
nicht", meint sie überall. Das Feld `submodell` ist für den Sonderfall da, dass
dieselbe Wand unter zwei Deckenfeldern liegt und nur unter einem davon anders
gelagert sein soll.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

#: Was ein Eingriff sein kann. Der Wert beschreibt, was in `wert` erwartet
#: wird — die Prüfung in `pruefe()` hält sich daran.
EINGRIFFSARTEN = {
    "lager_entfernen": "Das Bauteil trägt nicht mehr; sein Lager entfällt.",
    "lager_art": "Lagerart: gelenkig | eingespannt | feder (+ federsteifigkeit_kNm2).",
    "lager_verschieben": "Neue Lage: wert.polylinie [[x,y],…] oder wert.p [x,y].",
    "lager_hinzufuegen": "Neues Lager: wert.polylinie oder wert.p, Art wie oben.",
    "bauteil_tragend": "wert.tragend true/false — wirkt schon beim Ableiten.",
    "annahme": "Örtliche Annahme: wert.dicke_m oder wert.flaechenlast {lastfall: kN/m2}.",
    "nutzlast_raum": "Nutzlastkategorie eines Raums (bauteil = GlobalId des IfcSpace): "
                     "wert.kategorie nach DIN EN 1991-1-1/NA — sticht die Deutung aus der Raumnutzung.",
}

#: Lagerarten, die `plate.py` kennt.
LAGERARTEN = ("gelenkig", "eingespannt", "feder")


def jetzt() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Ein einzelner Eingriff ────────────────────────────────────────────────


def pruefe(eingriff: dict) -> dict:
    """
    Einen Eingriff auf Vollständigkeit prüfen und in Normalform bringen.

    Wirft `ValueError` — der Aufrufer ist eine HTTP-Route, und ein unsinniger
    Eingriff soll dort mit 422 enden und nicht drei Geschosse später im
    Protokoll eines Laufs auftauchen.
    """
    art = str(eingriff.get("art") or "").strip()
    if art not in EINGRIFFSARTEN:
        raise ValueError(
            f"Unbekannte Eingriffsart '{art}'. Möglich: "
            f"{', '.join(sorted(EINGRIFFSARTEN))}.")

    wert = dict(eingriff.get("wert") or {})
    bauteil = (eingriff.get("bauteil") or "").strip() or None

    if art in ("lager_entfernen", "lager_art", "lager_verschieben",
               "bauteil_tragend", "nutzlast_raum") and not bauteil:
        raise ValueError(
            f"'{art}' braucht die GlobalId des Bauteils. Ein Eingriff zeigt "
            f"auf ein Bauteil, nicht auf eine Lagerkennung — Lagerkennungen "
            f"werden bei jedem Lauf neu vergeben.")

    if art in ("lager_art", "lager_hinzufuegen"):
        lagerart = wert.get("art") or "gelenkig"
        if lagerart not in LAGERARTEN:
            raise ValueError(
                f"Lagerart '{lagerart}' gibt es nicht. Möglich: "
                f"{', '.join(LAGERARTEN)}.")
        wert["art"] = lagerart
        if lagerart == "feder":
            steife = wert.get("federsteifigkeit_kNm2")
            if steife is None or float(steife) <= 0:
                raise ValueError(
                    "Ein Federlager braucht eine Steifigkeit in kN/m² — ohne "
                    "sie ist es kein Lager, sondern ein freier Rand.")
            wert["federsteifigkeit_kNm2"] = float(steife)

    if art in ("lager_verschieben", "lager_hinzufuegen"):
        if wert.get("polylinie"):
            punkte = [[float(p[0]), float(p[1])] for p in wert["polylinie"]]
            if len(punkte) < 2:
                raise ValueError("Eine Lagerlinie braucht mindestens zwei Punkte.")
            wert["polylinie"] = punkte
            wert.pop("p", None)
        elif wert.get("p"):
            wert["p"] = [float(wert["p"][0]), float(wert["p"][1])]
            wert.pop("polylinie", None)
        else:
            raise ValueError(
                f"'{art}' braucht eine Lage: wert.polylinie für ein Linienlager "
                f"oder wert.p für ein Punktlager.")

    if art == "bauteil_tragend":
        if wert.get("tragend") is None:
            raise ValueError("'bauteil_tragend' braucht wert.tragend (true/false).")
        wert["tragend"] = bool(wert["tragend"])

    if art == "nutzlast_raum":
        # Die Liste der Kategorien steht einmal, in `raumlasten.py` — dieselbe,
        # gegen die der Lastabtrag rechnet. Ein Tippfehler soll hier mit 422
        # enden und nicht im Lauf still auf die Vorgabe zurückfallen.
        from .raumlasten import NUTZLASTEN
        kategorie = str(wert.get("kategorie") or "").strip()
        if kategorie not in NUTZLASTEN:
            raise ValueError(
                f"Nutzlastkategorie '{kategorie}' gibt es nicht. Möglich: "
                f"{', '.join(NUTZLASTEN)}.")
        wert = {"kategorie": kategorie}

    if art == "annahme":
        if wert.get("dicke_m") is None and not wert.get("flaechenlast"):
            raise ValueError(
                "'annahme' braucht wert.dicke_m oder wert.flaechenlast "
                "{lastfall: kN/m²}.")
        if wert.get("dicke_m") is not None:
            wert["dicke_m"] = float(wert["dicke_m"])
        if wert.get("flaechenlast"):
            wert["flaechenlast"] = {str(k): float(v)
                                    for k, v in wert["flaechenlast"].items()}

    return {
        "art": art,
        "bauteil": bauteil,
        "submodell": (eingriff.get("submodell") or "").strip() or None,
        "wert": wert,
        "notiz": (eingriff.get("notiz") or "").strip() or None,
    }


def titel(eingriff: dict, bauteilname: str | None = None) -> str:
    """Ein Satz, der im Verlauf steht — der Zweck eines Subplans in Worten."""
    ziel = bauteilname or eingriff.get("bauteil") or "das System"
    ort = eingriff.get("submodell")
    zusatz = f" in {ort}" if ort else ""
    wert = eingriff.get("wert") or {}
    art = eingriff["art"]
    if art == "lager_entfernen":
        return f"Auflager von {ziel} entfernt{zusatz}"
    if art == "lager_art":
        steife = wert.get("federsteifigkeit_kNm2")
        anhang = f" ({steife:.0f} kN/m²)" if steife else ""
        return f"{ziel} jetzt {wert.get('art')} gelagert{anhang}{zusatz}"
    if art == "lager_verschieben":
        return f"Auflager von {ziel} verschoben{zusatz}"
    if art == "lager_hinzufuegen":
        form = "Linienlager" if wert.get("polylinie") else "Punktlager"
        return f"{form} ergänzt{zusatz}"
    if art == "bauteil_tragend":
        return (f"{ziel} gilt als {'tragend' if wert.get('tragend') else 'nichttragend'}"
                f"{zusatz}")
    if art == "nutzlast_raum":
        return f"Nutzlast {ziel}: {wert.get('kategorie')}{zusatz}"
    if art == "annahme":
        if wert.get("dicke_m") is not None:
            return f"Deckendicke {wert['dicke_m']:.3f} m{zusatz}"
        lasten = ", ".join(f"{k} {v:g} kN/m²" for k, v in wert["flaechenlast"].items())
        return f"Flächenlast {lasten}{zusatz}"
    return f"{art}{zusatz}"


def fuer_submodell(eingriffe, submodell: str | None = None) -> list[dict]:
    """
    Die Eingriffe, die in diesem Submodell greifen.

    Ein Eingriff **ohne** `submodell` gilt überall — das ist der Normalfall,
    denn eine GlobalId gibt es nur einmal im Bauwerk. Das Feld ist für den
    Sonderfall da, dass dieselbe Wand unter zwei Deckenfeldern liegt und nur
    unter einem davon anders gelagert sein soll.

    Ein Eingriff **mit** `submodell` bleibt draußen, solange kein Submodell
    genannt ist. Ihn dann mitzunehmen wäre die gefährlichere Auslegung: eine
    örtlich gemeinte Entscheidung schlüge auf das ganze Bauwerk durch.
    """
    treffer = []
    for e in eingriffe or []:
        ziel = e.get("submodell")
        if ziel and ziel != submodell:
            continue
        treffer.append(e)
    return treffer


def tragend_vorgabe(eingriffe, submodell: str | None = None) -> dict[str, bool]:
    """
    GlobalId → tragend, aus den `bauteil_tragend`-Eingriffen.

    Diese eine Art wirkt **vor** der Ableitung, nicht danach. Eine Wand, die
    `nur_tragende` verworfen hat, ist im fertigen Modell nicht mehr vorhanden —
    ihre Geometrie steht dort nirgends, und kein nachträglicher Eingriff könnte
    sie zurückholen. `tragwerksmodell.statikmodell()` fragt deshalb diese
    Vorgabe ab, während es die Wände durchgeht.
    """
    vorgabe: dict[str, bool] = {}
    for e in fuer_submodell(eingriffe, submodell):
        if e["art"] == "bauteil_tragend" and e.get("bauteil"):
            vorgabe[e["bauteil"]] = bool(e["wert"]["tragend"])
    return vorgabe


def nutzlast_vorgabe(eingriffe, submodell: str | None = None) -> dict[str, str]:
    """
    Raum-GlobalId → Nutzlastkategorie, aus den `nutzlast_raum`-Eingriffen.

    Wirkt wie `tragend_vorgabe()` **vor** der Ableitung: die Nutzlastflächen
    entstehen in `tragwerksmodell._nutzlastflaechen()` aus den Räumen, und dort
    muss die Kategorie schon feststehen. Ein späterer Eingriff am fertigen
    Modell müsste die Last im Polygon des Raums suchen und umschreiben — das
    wäre dieselbe Entscheidung an zwei Stellen.
    """
    vorgabe: dict[str, str] = {}
    for e in fuer_submodell(eingriffe, submodell):
        if e["art"] == "nutzlast_raum" and e.get("bauteil"):
            vorgabe[e["bauteil"]] = e["wert"]["kategorie"]
    return vorgabe


def anwenden(modell: dict, eingriffe, *, submodell: str | None = None) -> dict:
    """
    Die Eingriffe auf ein abgeleitetes Modell legen — an Ort und Stelle.

    @returns Protokoll: `{angewandt: [...], ohne_wirkung: [...], hinweise: [...]}`

    Das Protokoll ist kein Beiwerk. Ein Eingriff, der ins Leere greift — weil
    die GlobalId in diesem Geschoss nicht vorkommt oder das Bauteil als
    nichttragend ohnehin schon draußen war —, ist genau der Fall, in dem der
    Nutzer glaubt, etwas geändert zu haben, und nichts geschehen ist.
    """
    passend = fuer_submodell(eingriffe, submodell)
    protokoll = {"angewandt": [], "ohne_wirkung": [], "hinweise": []}
    if not passend:
        return protokoll

    auflager = modell.setdefault("auflager", [])

    def melden(e, text):
        protokoll["angewandt"].append({"nr": e.get("nr"), "art": e["art"],
                                       "bauteil": e.get("bauteil"), "wirkung": text})

    def leer(e, text):
        protokoll["ohne_wirkung"].append({"nr": e.get("nr"), "art": e["art"],
                                          "bauteil": e.get("bauteil"), "grund": text})

    for e in passend:
        art = e["art"]
        gid = e.get("bauteil")
        wert = e.get("wert") or {}
        treffer = [a for a in auflager if gid and gid in (a.get("bauteile") or [])]

        if art == "bauteil_tragend":
            # Schon beim Ableiten berücksichtigt; hier nur der Nachweis, dass
            # es gewirkt hat.
            if wert["tragend"] and not treffer:
                leer(e, "Als tragend gesetzt, aber im Schnitt dieses Geschosses "
                        "erscheint das Bauteil nicht.")
            else:
                melden(e, f"{'tragend' if wert['tragend'] else 'nichttragend'} "
                          f"({len(treffer)} Lager)")
            continue

        if art == "nutzlast_raum":
            # Schon beim Ableiten gesetzt (`nutzlast_vorgabe()`); hier nur der
            # Nachweis, wo der Raum liegt. Nur dort gilt der Eingriff als
            # gegriffen — und nur dort geht er in den Eingabe-Hash ein. Sonst
            # veraltete eine Nutzlast im Erdgeschoss jedes Geschoss des Hauses.
            flaechen = [l for l in modell.get("lasten", [])
                        if l.get("typ") == "flaeche" and l.get("bezug") == gid]
            if flaechen:
                werte = ", ".join(f"{float(l.get('wert') or 0):g}" for l in flaechen)
                melden(e, f"Nutzlast {wert['kategorie']} ({werte} kN/m²)")
            else:
                leer(e, "Der Raum liegt nicht unter dieser Decke.")
            continue

        if art == "annahme":
            gewirkt = []
            if wert.get("dicke_m") is not None and modell.get("system"):
                modell["system"][0]["dicke_m"] = wert["dicke_m"]
                modell["system"][0]["dicke_quelle"] = "Eingriff am System"
                gewirkt.append(f"Dicke {wert['dicke_m']:.3f} m")
            for lastfall, betrag in (wert.get("flaechenlast") or {}).items():
                getroffen = [l for l in modell.get("lasten", [])
                             if l.get("typ") == "flaeche" and l.get("lastfall") == lastfall]
                for last in getroffen:
                    last["wert"] = betrag
                if getroffen:
                    gewirkt.append(f"{lastfall} {betrag:g} kN/m²")
            if gewirkt:
                melden(e, ", ".join(gewirkt))
            else:
                leer(e, "Weder Dicke noch ein passender Lastfall im Modell.")
            continue

        if art == "lager_hinzufuegen":
            neu = {
                "id": _freie_kennung(auflager),
                "typ": "linie" if wert.get("polylinie") else "punkt",
                "art": wert.get("art", "gelenkig"),
                "federsteifigkeit_kNm2": wert.get("federsteifigkeit_kNm2"),
                "bauteile": [gid] if gid else [],
                "aus_eingriff": True,
            }
            if wert.get("polylinie"):
                neu["polylinie"] = wert["polylinie"]
                neu["_laenge"] = round(_laenge(wert["polylinie"]), 3)
            else:
                neu["p"] = wert["p"]
                neu["_laenge"] = 0.0
            auflager.append(neu)
            melden(e, f"Lager {neu['id']} ergänzt")
            continue

        if not treffer:
            leer(e, "Kein Lager dieses Bauteils in diesem Deckenfeld — die "
                    "GlobalId erscheint hier nicht, oder die Wand wurde als "
                    "nichttragend verworfen.")
            continue

        if art == "lager_entfernen":
            for a in treffer:
                auflager.remove(a)
            melden(e, f"{len(treffer)} Lager entfernt")
            protokoll["hinweise"].append(
                f"Das Auflager von {gid} ist entfernt — das Bauteil trägt die "
                f"Decke darüber nicht mehr. Es wiegt weiterhin: sein Eigengewicht "
                f"geht als Last nach unten.")
        elif art == "lager_art":
            for a in treffer:
                a["art"] = wert["art"]
                a["federsteifigkeit_kNm2"] = wert.get("federsteifigkeit_kNm2")
            melden(e, f"{len(treffer)} Lager auf '{wert['art']}' gesetzt")
        elif art == "lager_verschieben":
            for a in treffer:
                a.pop("polylinie", None)
                a.pop("p", None)
                if wert.get("polylinie"):
                    a["typ"] = "linie"
                    a["polylinie"] = wert["polylinie"]
                    a["_laenge"] = round(_laenge(wert["polylinie"]), 3)
                else:
                    a["typ"] = "punkt"
                    a["p"] = wert["p"]
                    a["_laenge"] = 0.0
            melden(e, f"{len(treffer)} Lager verschoben")

    if protokoll["angewandt"]:
        warnung = _kinematisch(auflager)
        if warnung:
            protokoll["hinweise"].append(warnung)
    return protokoll


def _kinematisch(auflager) -> str | None:
    """
    Ob nach den Eingriffen noch etwas hält — die grobe Vorabprüfung.

    **Nicht „weniger als zwei Lager".** Eine umlaufende Außenwand ist *ein*
    Lager, und eine Decke darauf ist vollständig gehalten; diese Regel hätte
    bei jedem einschaligen Baukörper Alarm geschlagen, und ein Alarm, der immer
    kommt, wird nicht gelesen. Kinematisch ist eine Platte erst, wenn gar
    nichts mehr da ist, wenn nur ein Punkt bleibt — oder wenn alles, was bleibt,
    auf **einer Geraden** liegt: dann ist diese Gerade eine Drehachse.

    Die feine Prüfung macht der Solver; das hier soll nur verhindern, dass
    jemand eine Viertelstunde auf eine Rechnung wartet, die nicht laufen kann.
    """
    if not auflager:
        return ("Nach den Eingriffen bleibt kein Auflager — das Deckenfeld ist "
                "nicht mehr gelagert und nicht rechenbar.")

    punkte: list[list[float]] = []
    for a in auflager:
        if "polylinie" in a:
            punkte.extend(a["polylinie"])
        elif "p" in a:
            punkte.append(a["p"])
    if len(punkte) < 3:
        return ("Nach den Eingriffen bleibt nur ein Punktlager — die Decke kann "
                "sich darum drehen und ist nicht rechenbar.")

    a, b = punkte[0], max(punkte, key=lambda q: math.dist(q, punkte[0]))
    spanne = math.dist(a, b)
    if spanne < 1e-6:
        return "Alle verbliebenen Auflager liegen auf einem Punkt."
    # Größter Abstand von der Verbindungsgeraden der beiden entferntesten Punkte.
    dx, dy = b[0] - a[0], b[1] - a[1]
    breite = max(abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / spanne for q in punkte)
    if breite < 0.05:
        return ("Alle verbliebenen Auflager liegen auf einer Geraden — die Decke "
                "kann sich um diese Achse drehen und ist nicht rechenbar.")
    return None


def _laenge(polylinie) -> float:
    return sum(math.hypot(polylinie[i + 1][0] - polylinie[i][0],
                          polylinie[i + 1][1] - polylinie[i][1])
               for i in range(len(polylinie) - 1))


def _freie_kennung(auflager) -> str:
    """`E1`, `E2`, … — abgesetzt von den abgeleiteten `A…`, damit im Plan zu
    sehen ist, welches Lager aus dem Modell stammt und welches aus der Hand."""
    genommen = {a.get("id") for a in auflager}
    i = 1
    while f"E{i}" in genommen:
        i += 1
    return f"E{i}"
