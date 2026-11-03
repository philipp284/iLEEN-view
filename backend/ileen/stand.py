"""
Gilt die Zahl, die ich sehe, für das System, das ich sehe?

Die einzige wirklich gefährliche Frage dieses Werkzeugs. Ein Lastabtrag über
sechs Geschosse dauert Minuten bis eine halbe Stunde; in der Zwischenzeit
ändert jemand eine Deckendicke, hebt ein Auflager auf, setzt eine andere
Nutzlast. Die Zahlen auf dem Bildschirm gehören dann zu einem System, das es
nicht mehr gibt — und sie sehen genauso aus wie vorher.

## Warum ein Hash und kein Merkmal

Bis September 2026 trug ein Zweig ein Feld `gerechnet.veraltet`, das jemand
setzen musste. Jede neue Stelle, die etwas an der Eingabe ändert, muss daran
denken; eine, die es vergisst, macht aus einem veralteten Ergebnis ein
scheinbar gültiges. Das ist die Sorte Fehler, die man nicht bemerkt, weil
nichts passiert.

Der **Eingabe-Hash** kann nicht vergessen werden. Er wird aus dem gebildet, was
in die Rechnung eingeht; ändert sich davon etwas, ändert er sich mit. Eine neue
Eingabegröße, die niemand in `hash_der_eingabe()` einträgt, führt höchstens
dazu, dass eine Änderung *nicht* als Änderung gilt — und das fällt beim ersten
Vergleich zweier Rechenstände auf, während ein vergessenes Merkmal für immer
still bleibt.

## Was in den Hash eingeht — und was nicht

    geht ein                          geht nicht ein
    ─────────────────────────────────────────────────────────────
    Geometrie: Umriss, Öffnungen,     Zeitstempel, Lauf-Kennung
      Dicke, Auflager                 Bildergalerie, Netzweite*
    Lasten: Flächen, Linien, Punkte   Fortschrittsmeldungen
    Material, Bettung                 Reihenfolge der Listen
    Eingriffe an diesem Submodell

*Die Netzweite geht **doch** ein: eine gröbere Netzweite ist eine andere
Rechnung, auch wenn das System dasselbe ist. Wer sie ändert und dasselbe
Ergebnis behält, vergleicht zwei Dinge, die nicht vergleichbar sind.

**Die Reihenfolge darf nicht eingehen.** Zwei Läufe über dasselbe IFC liefern
die Auflager womöglich in anderer Reihenfolge — die hängt am Schnitt. Ein Hash,
der darauf reagiert, meldete bei jedem Lauf „geändert", und die Anzeige wäre
wertlos. Listen werden deshalb sortiert, bevor sie in den Hash gehen.

## Wie die Veraltung nach unten läuft

Ein Geschoss trägt, was über ihm steht. Ändert sich `submodell.OG2`, ändern
sich seine Auflagerkräfte, damit die Fußkräfte der Wände darunter, damit die
Linienlasten auf die Decke des OG1 — bis zur Gründung.

    OG3   gültig      ← darüber, unberührt
    OG2   GEÄNDERT
    OG1   veraltet    ← weil OG2 anders abgibt
    EG    veraltet
    FUND  veraltet
    ────────────────
    Gesamtsystem veraltet

**Nach oben läuft nichts.** Die Kette rechnet in einem Zug abwärts und kennt
keine Rückkopplung: die Steifigkeit der Wände unter einer Decke geht nur als
Lagerung ein, nicht als Federung. Das ist die Annahme des geschossweisen
Verfahrens, und sie macht die Propagierung einseitig.

**Eine Nebenrechnung veraltet nichts und veraltet nicht.** Ein Submodell, das
von Hand im Zeichenmodus angelegt wurde, steht neben der Kette: es bekommt
keine Last von oben und gibt keine nach unten ab. Ohne diese Unterscheidung
risse jede Nebenrechnung die ganze Gesamtstatik in den Zustand „veraltet",
obwohl sie mit ihr nichts zu tun hat.
"""

from __future__ import annotations

import hashlib
import json

from . import submodell as sm

#: Art eines Submodells. `geschoss` ist Teil der Kette und veraltet mit ihr;
#: `nebenrechnung` steht daneben.
GESCHOSS = "geschoss"
NEBENRECHNUNG = "nebenrechnung"

#: Zustände, die ein Submodell im FE-Browser haben kann.
AKTUELL = "aktuell"
VERALTET = "veraltet"
NIE_GERECHNET = "nie gerechnet"
FEHLERHAFT = "fehlerhaft"


def _rundung(wert, stellen: int = 6):
    """
    Zahlen auf sechs Stellen runden, bevor sie in den Hash gehen.

    Koordinaten kommen aus einer Gleitkommarechnung über trimesh und shapely.
    Dieselbe Geometrie zweimal geschnitten kann in der fünfzehnten Stelle
    abweichen — ein Hash darauf meldete bei jedem Lauf „geändert". Sechs
    Nachkommastellen sind ein Mikrometer und damit weit unter allem, was ein
    Bauwerk unterscheidet.
    """
    if isinstance(wert, bool):
        # Vor der Zahlenprüfung: `bool` ist in Python ein `int`, und `True`
        # würde sonst als `1.0` gehasht.
        return wert
    if isinstance(wert, (int, float)):
        # **Ganze und gebrochene Zahlen gleich behandeln.** Ein Umriss aus dem
        # IFC kommt als `[[0, 0], …]` mit Ganzzahlen, derselbe nach einer
        # Geometrieoperation als `[[0.0, 0.0], …]`. `json.dumps` schreibt „0"
        # und „0.0" — zwei verschiedene Hashes für dieselbe Geometrie, und die
        # Anzeige meldete eine Änderung, wo keine ist.
        #
        # `round(-1e-12, 6)` ergibt `-0.0`, und das hasht wieder anders als
        # `0.0`. Die Null wird deshalb ausdrücklich vereinheitlicht.
        gerundet = round(float(wert), stellen)
        return 0.0 if gerundet == 0.0 else gerundet
    if isinstance(wert, dict):
        return {k: _rundung(v, stellen) for k, v in sorted(wert.items())}
    if isinstance(wert, (list, tuple)):
        return [_rundung(v, stellen) for v in wert]
    return wert


def _sortiert(eintraege, schluessel) -> list:
    """
    Eine Liste in eine Ordnung bringen, die nicht am Zufall hängt.

    Sortiert wird über die Textfassung des Eintrags und nicht über eine
    Kennung: `A7` wird bei jedem Lauf neu vergeben (siehe `eingriffe.py`), und
    ein Hash über die Kennungen meldete eine Änderung, wo nur die Reihenfolge
    des Schnitts eine andere war.
    """
    return sorted(eintraege, key=lambda e: json.dumps(schluessel(e), sort_keys=True,
                                                      ensure_ascii=False))


def hash_der_eingabe(modell: dict, *, eingriffe=None,
                     netzweite: float | None = None) -> str:
    """
    Der Fingerabdruck dessen, was in die Rechnung eingeht.

    @param modell     ein `ileen.plan.fem`-Modell, wie `statikmodell()` es baut
    @param eingriffe  die Eingriffe, die an diesem Submodell greifen
    @param netzweite  die tatsächlich benutzte Elementgröße

    @returns 16 Hexziffern — kurz genug für eine Anzeige, lang genug, dass eine
             Kollision praktisch ausgeschlossen ist

    Bewusst **nicht** im Hash: Zeitstempel, Lauf-Kennungen, Bildlisten,
    Fortschrittstexte und die Reihenfolge der Listen. Sie ändern sich, ohne
    dass sich die Rechnung ändert; ein Hash darauf meldete ständig „geändert"
    und würde damit ignoriert — die schlimmste Eigenschaft einer Warnung.
    """
    system = (modell.get("system") or [{}])[0]
    kern = {
        "geometrie": {
            "umriss": _rundung(system.get("umriss")),
            "oeffnungen": _rundung(sorted(
                system.get("oeffnungen") or [],
                key=lambda r: json.dumps(_rundung(r), sort_keys=True))),
            "dicke_m": _rundung(system.get("dicke_m")),
            "bettung_kNm3": _rundung(system.get("bettung_kNm3")),
        },
        "material": _rundung(system.get("material")),
        # Ohne die Kennungen: `A7` zählt die Reihenfolge des Schnitts.
        "auflager": _sortiert(
            [{k: _rundung(v) for k, v in a.items()
              if k not in ("id", "_laenge", "bauteil_anteile")}
             for a in (modell.get("auflager") or [])],
            lambda a: a),
        # `flaeche_m2` folgt aus Polygon und Umriss, die beide drinstehen; es
        # wird erst beim Buchen geschrieben (`tm.lastflaechen_festhalten`) und
        # darf den Hash davor und danach nicht unterscheiden.
        "lasten": _sortiert(
            [{k: _rundung(v) for k, v in l.items()
              if k not in ("id", "herkunft", "flaeche_m2")}
             for l in (modell.get("lasten") or [])],
            lambda l: l),
        "lastfaelle": _sortiert(
            [_rundung(f) for f in (modell.get("lastfaelle") or [])],
            lambda f: f),
        "unterzuege": _sortiert(
            [{k: _rundung(v) for k, v in u.items() if k != "id"}
             for u in (modell.get("unterzuege") or [])],
            lambda u: u),
        # Was von oben direkt in die Lager geht (`kette.durchleiten()`), steht
        # nicht mehr unter den Lasten — ohne diesen Eintrag änderte eine Wand
        # darüber, die auf einer Wand darunter steht, den Hash nicht.
        **({"durchleitung": _sortiert(
            [{k: _rundung(v) for k, v in d.items()
              if k not in ("lager", "herkunft")}
             for d in modell["durchleitung"]],
            lambda d: d)} if modell.get("durchleitung") else {}),
        # Die Netzweite ist Teil der Rechnung, nicht des Systems — aber eine
        # andere Netzweite ist eine andere Rechnung, und zwei Stände mit
        # verschiedener Feinheit sind nicht vergleichbar.
        "netzweite": _rundung(netzweite),
        "eingriffe": _sortiert(
            [{k: _rundung(v) for k, v in e.items()
              if k in ("art", "bauteil", "submodell", "wert")}
             for e in (eingriffe or [])],
            lambda e: e),
    }
    text = json.dumps(kern, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.blake2b(text.encode("utf-8"), digest_size=8).hexdigest()


def zustand(eintrag: dict | None) -> str:
    """
    Der Zustand eines Submodells: aktuell · veraltet · nie gerechnet · fehlerhaft.

    @param eintrag  `{hash, rechnung: {hash, status}}` aus der Ablage

    Ein Submodell ist **aktuell**, wenn der Hash seiner jetzigen Eingabe mit
    dem übereinstimmt, unter dem die jüngste Rechnung entstand. Alles andere
    ist eine Aussage über etwas, das es so nicht mehr gibt.
    """
    if not eintrag:
        return NIE_GERECHNET
    rechnung = eintrag.get("rechnung") or {}
    if not rechnung or not rechnung.get("id"):
        return NIE_GERECHNET
    if rechnung.get("status") == "fehlgeschlagen":
        return FEHLERHAFT
    jetzt = eintrag.get("hash")
    damals = rechnung.get("hash")
    if not jetzt or not damals:
        # Ein Stand ohne Hash stammt aus der Zeit vor dieser Rechnung. Ihn als
        # aktuell zu führen wäre die gefährlichere Auslegung.
        return VERALTET
    return AKTUELL if jetzt == damals else VERALTET


def propagiere(submodelle: dict[str, dict]) -> dict[str, dict]:
    """
    Veraltung nach unten weitergeben — und aufs Gesamtsystem.

    @param submodelle  Submodellname → `{hash, rechnung, art}`
    @returns dasselbe Wörterbuch, ergänzt um `zustand` und `grund`

    Ein Submodell, dessen eigener Hash stimmt, ist trotzdem veraltet, wenn ein
    Geschoss **über** ihm geändert wurde: es bekommt von dort seine Last. Die
    Reihenfolge dafür steht in `submodell.rang()` — je kleiner, desto weiter
    oben.

    Nach oben läuft nichts. Die Kette rechnet abwärts und kennt keine
    Rückkopplung; ein geändertes Erdgeschoss ändert nichts an der Decke über
    dem zweiten Obergeschoss.

    Nebenrechnungen bleiben außen vor — in beide Richtungen.
    """
    ergebnis: dict[str, dict] = {}

    kettenglieder = [(n, e) for n, e in submodelle.items()
                     if (e.get("art") or GESCHOSS) == GESCHOSS]
    kettenglieder.sort(key=lambda paar: sm.rang(sm.zerlegen(paar[0])[0]))

    #: Das oberste Geschoss, ab dem alles darunter veraltet ist.
    ab_hier: str | None = None

    for name, eintrag in kettenglieder:
        eigener = zustand(eintrag)
        neu = dict(eintrag)
        if eigener != AKTUELL:
            neu["zustand"] = eigener
            neu["grund"] = {
                VERALTET: "Die Eingabe hat sich seit der letzten Rechnung geändert.",
                NIE_GERECHNET: "Noch nicht gerechnet.",
                FEHLERHAFT: "Die letzte Rechnung ist gescheitert.",
            }[eigener]
            if ab_hier is None:
                ab_hier = name
        elif ab_hier is not None:
            neu["zustand"] = VERALTET
            neu["grund"] = (
                f"Nicht selbst geändert, aber {ab_hier} liegt darüber und ist "
                f"nicht aktuell — von dort kommt die Last.")
        else:
            neu["zustand"] = AKTUELL
            neu["grund"] = ""
        ergebnis[name] = neu

    for name, eintrag in submodelle.items():
        if name in ergebnis:
            continue
        neu = dict(eintrag)
        neu["zustand"] = zustand(eintrag)
        neu["grund"] = ("Nebenrechnung — steht neben der Kette."
                        if neu["zustand"] == AKTUELL else
                        "Nebenrechnung, nicht aktuell.")
        ergebnis[name] = neu

    return ergebnis


def gesamtzustand(propagiert: dict[str, dict]) -> dict:
    """
    Der Zustand des Gesamtmodells — die Zeile ganz oben im FE-Browser.

    Das Gesamtsystem ist genau dann aktuell, wenn **jedes** Submodell der Kette
    es ist. Ein einziges veraltetes Geschoss macht die Gründungslasten
    unbrauchbar, denn alles darunter hängt daran.

    Nebenrechnungen zählen nicht mit: sie sind nicht Teil der Gesamtstatik.
    """
    kette = {n: e for n, e in propagiert.items()
             if (e.get("art") or GESCHOSS) == GESCHOSS}
    if not kette:
        return {"zustand": NIE_GERECHNET, "grund": "Noch kein Submodell erzeugt.",
                "aktuell": 0, "gesamt": 0, "betroffen": []}

    betroffen = sorted((n for n, e in kette.items() if e["zustand"] != AKTUELL),
                       key=lambda n: sm.rang(sm.zerlegen(n)[0]))
    aktuell = len(kette) - len(betroffen)
    if not betroffen:
        return {"zustand": AKTUELL, "grund": "", "aktuell": aktuell,
                "gesamt": len(kette), "betroffen": []}

    fehler = [n for n in betroffen if kette[n]["zustand"] == FEHLERHAFT]
    return {
        "zustand": FEHLERHAFT if fehler else VERALTET,
        "grund": (
            f"Gesamtrechnung nicht mehr aktuell — {len(betroffen)} von "
            f"{len(kette)} Submodellen betroffen, ab {betroffen[0]}."),
        "aktuell": aktuell,
        "gesamt": len(kette),
        "betroffen": betroffen,
    }


def zu_rechnen(propagiert: dict[str, dict]) -> list[str]:
    """
    Welche Submodelle neu gerechnet werden müssen — in der Reihenfolge der Kette.

    Inkrementell heißt: was aktuell ist, bleibt liegen. Das ist der Grund,
    warum die Veraltung überhaupt nach unten propagiert wird — ohne sie müsste
    man entweder alles rechnen oder riskieren, dass ein Geschoss mit den
    Lasten eines Systems weiterrechnet, das es nicht mehr gibt.

    Nebenrechnungen stehen am Ende: sie hängen an nichts, und wer die
    Gesamtstatik neu rechnet, wartet nicht auf sie.
    """
    kette = [(n, e) for n, e in propagiert.items()
             if (e.get("art") or GESCHOSS) == GESCHOSS and e["zustand"] != AKTUELL]
    kette.sort(key=lambda paar: sm.rang(sm.zerlegen(paar[0])[0]))
    neben = sorted(n for n, e in propagiert.items()
                   if (e.get("art") or GESCHOSS) == NEBENRECHNUNG
                   and e["zustand"] != AKTUELL)
    return [n for n, _ in kette] + neben
