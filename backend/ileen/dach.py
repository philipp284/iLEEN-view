"""
Steildächer im Lastabtrag: Sparren → Pfetten → Stiele und Wände.

Die Kette rechnet Decken als Platten. Ein Steildach ist keine Platte: seine
Last geht über geneigte Sparren an deren Lager — Fußpfette, Mittelpfette,
Firstpfette, Wand — und von den Pfetten über Stiele oder Giebelwände weiter.
Ohne dieses Modul fehlten Dachaufbau, Schnee und das Gewicht des Dachstuhls in
jedem Haus mit Satteldach ganz: das Dachgeschoss hat keine Deckenplatte, und
die Kette gab dort nur das Eigengewicht der Wände weiter.

**Jeder Stab ein Durchlaufträger.** Ein Sparren auf Fuß- und Firstpfette mit
Dachüberstand, eine Firstpfette über drei Stiele: die Lagerkräfte folgen aus
einem Balken auf beliebig vielen starren Lagern (`durchlauftraeger`, Stäbe nach
Euler–Bernoulli). Bei gleichem Querschnitt kürzt sich EI heraus — der mittlere
Stiel einer Zweifeldpfette bekommt 1,25 qL, nicht 1,0 qL wie nach der
Hebelregel.

**Die Lager werden gesucht, nicht angenommen.** Unter einem Stab liegt ein
Lager, wo eine Wand, eine Stütze oder ein liegender Träger seinen Grundriss
kreuzt und mit der Oberkante an seiner Unterkante liegt (`AUFLAGER_TOLERANZ_M`).
Liegt ein Stab auf einer Wand entlang (Fußpfette auf dem Kniestock), ist die
Wand ein durchgehendes Lager. Was ein Stab an einen Träger abgibt, rechnet
dieser Träger weiter; was an eine Wand oder Stütze geht, kommt als Last in die
Kette — im Geschoss, in dem sie steht.

**Lasten** je Sparren: Dachaufbau `g` je m² Dachfläche (Vorgabe
`AUFBAU_VORGABE_KNM2`, Lastfall AUS), Schnee μ₁(α)·s_k je m² Grundfläche
(DIN EN 1991-1-3, Lastfall S) über die Einzugsbreite, dazu das Eigengewicht
jedes Stabs (EG). Wind fehlt — er hebt den Dachstuhl an und gehört zu den
Horizontallasten.

**Einzugsbreite** aus den Nachbarsparren derselben Dachfläche (gleiche
Richtung, gleiche Neigung): die Hälfte zu jedem Nachbarn; der Randsparren
bekommt die halbe Teilung nach innen und seine eigene halbe Breite nach außen.
Ein Ortgang, der über den Randsparren hinausragt, fehlt damit.
"""

from __future__ import annotations

import math

import numpy as np

from . import lastabtrag as la

#: Ein Stab gilt ab dieser Neigung als Sparren (darunter ist es ein Balken
#: einer Decke), bis zu dieser als Sparren und nicht als Stiel.
NEIGUNG_MIN_GRAD = 10.0
NEIGUNG_MAX_GRAD = 75.0
#: Ein liegender Träger (Pfette, Wechsel) — höchstens so geneigt.
LIEGEND_MAX_GRAD = 5.0
#: Dachaufbau eines Steildachs je m² Dachfläche: Ziegel, Lattung, Konterlattung,
#: Unterdeckung, Dämmung zwischen den Sparren, Bekleidung innen.
AUFBAU_VORGABE_KNM2 = 1.0
SCHNEE_SK_VORGABE = 0.85
#: Höhenabstand zwischen Unterkante des getragenen Stabs und Oberkante des
#: Lagers, unter dem es als Lager gilt (Kerven, Klauen, Toleranzen im Modell).
AUFLAGER_TOLERANZ_M = 0.10
#: Abstand der Stützpunkte, wo ein Stab auf einer Wand entlang liegt.
STUETZPUNKTE_M = 0.50

LASTFAELLE = {"EG": "G", "AUS": "G", "S": "Q"}


def mu1(neigung_grad: float) -> float:
    """Formbeiwert der Schneelast, DIN EN 1991-1-3 Tab. 5.2 (Pult-/Satteldach)."""
    a = float(neigung_grad)
    if a <= 30.0:
        return 0.8
    if a < 60.0:
        return 0.8 * (60.0 - a) / 30.0
    return 0.0


# ── Der Durchlaufträger ──────────────────────────────────────────────────


def durchlauftraeger(laenge: float, lager: list[float], *, q: float = 0.0,
                     punktlasten: list[tuple[float, float]] = ()) -> list[float] | None:
    """
    Lagerkräfte (nach oben positiv) eines Balkens über starren Lagern.

    Stäbe nach Euler–Bernoulli mit gleichem EI; Lager halten die Durchbiegung,
    nicht die Verdrehung. Kragarme an beiden Enden sind erlaubt.

    @param laenge      Stablänge (im Grundriss gemessen — für die Lagerkräfte
                       zählt nur das Gleichgewicht, und das ist in der
                       Projektion dasselbe)
    @param lager       Stellen der Lager, 0 … laenge
    @param q           gleichmäßige Last je m (nach unten positiv)
    @param punktlasten (Stelle, Kraft) nach unten positiv
    @returns je Lager in der Reihenfolge von `lager` (sortiert, ohne Doppelte),
             `None` ohne Lager
    """
    # **Knoten auf ganze Millimeter.** Die Sparren beider Dachseiten treffen
    # die Firstpfette an derselben Stelle — im gedrehten Gebäude 5 µm
    # auseinander (Rundung der Drehung). Ein Element von 5 µm hat die
    # Steifigkeit 1/l³ ≈ 10¹⁶, die Matrix wird unlösbar schlecht, und die
    # Lagerkräfte trugen ein Siebtel der Last (Prüfhaus H6 gedreht).
    stellen = sorted({round(min(max(float(x), 0.0), laenge), 3) for x in lager})
    if not stellen:
        return None
    gesamt = q * laenge + sum(p for _, p in punktlasten)
    if len(stellen) == 1:
        return [gesamt]
    knoten: list[float] = []
    for xk in sorted({0.0, float(laenge), *stellen,
                      *(round(min(max(float(x), 0.0), laenge), 3) for x, _ in punktlasten)}):
        if not knoten or xk - knoten[-1] >= 1e-3:
            knoten.append(xk)
        elif xk == float(laenge):
            knoten[-1] = xk                   # das Ende bleibt, wo der Stab endet
    if len(knoten) < 2:
        return [gesamt / len(stellen)] * len(stellen)
    fein = [knoten[0]]
    for a, b in zip(knoten, knoten[1:]):
        n = max(1, math.ceil((b - a) / 0.25))
        fein.extend(a + (b - a) * k / n for k in range(1, n + 1))
    x = np.array(fein)
    n = len(x)
    K = np.zeros((2 * n, 2 * n))
    F = np.zeros(2 * n)
    for i in range(n - 1):
        l = x[i + 1] - x[i]
        if l < 1e-9:
            continue
        k = np.array([[12, 6 * l, -12, 6 * l],
                      [6 * l, 4 * l * l, -6 * l, 2 * l * l],
                      [-12, -6 * l, 12, -6 * l],
                      [6 * l, 2 * l * l, -6 * l, 4 * l * l]]) / l ** 3
        idx = [2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3]
        K[np.ix_(idx, idx)] += k
        F[idx] += q * l * np.array([0.5, l / 12.0, 0.5, -l / 12.0])
    for stelle, kraft in punktlasten:
        j = int(np.argmin(np.abs(x - stelle)))
        F[2 * j] += kraft
    fest = [2 * int(np.argmin(np.abs(x - s))) for s in stellen]
    frei = [i for i in range(2 * n) if i not in set(fest)]
    u = np.zeros(2 * n)
    u[frei] = np.linalg.solve(K[np.ix_(frei, frei)], F[frei])
    reaktion = F - K @ u
    kraefte = [float(reaktion[i]) for i in fest]
    # Die Probe, die hier billig ist: die Lager tragen, was auf dem Stab liegt.
    if abs(sum(kraefte) - gesamt) > 1e-6 * max(1.0, abs(gesamt)):
        raise ArithmeticError(
            f"Durchlaufträger nicht im Gleichgewicht: Lager {sum(kraefte):.3f} kN, "
            f"Last {gesamt:.3f} kN")
    return kraefte


# ── Stäbe und ihre Lager ─────────────────────────────────────────────────


def _stab(gid: str, b: dict) -> dict | None:
    if not b.get("achse"):
        return None
    a, e = np.array(b["achse"][0], float), np.array(b["achse"][1], float)
    if a[2] > e[2]:
        a, e = e, a
    d = e - a
    plan = float(math.hypot(d[0], d[1]))
    neigung = math.degrees(math.atan2(d[2], plan)) if plan > 1e-6 else 90.0
    quer = sorted(float(v) for v in (b.get("querschnitt_m") or [0.1, 0.2]))
    laenge3d = float(np.linalg.norm(d))
    from .tragend import schichtwichte
    wichte = schichtwichte(b.get("material")) or 5.0
    volumen = float(b.get("volumen_m3") or (quer[0] * quer[1] * laenge3d))
    return {"global_id": gid, "name": b.get("name") or gid, "a": a, "e": e,
            "plan": plan, "neigung": neigung, "breite": quer[0], "hoehe": quer[1],
            "gewicht_kN": volumen * wichte, "ifc_type": b.get("ifc_type") or ""}


def _unterkante(stab: dict, s: float) -> float:
    """Unterkante des Stabs an der Grundrissstelle s (ab dem unteren Ende)."""
    alpha = math.radians(stab["neigung"])
    z_achse = stab["a"][2] + s * math.tan(alpha) if stab["plan"] > 1e-6 else stab["a"][2]
    return z_achse - 0.5 * stab["hoehe"] / max(math.cos(alpha), 0.2)


def _figur(b: dict):
    from .kette import _grundrissfigur
    return _grundrissfigur(b)


def _lager_suchen(stab: dict, boxen: dict, kandidaten: list[str]) -> list[dict]:
    """
    Wo der Stab aufliegt: [{stelle, global_id, art (wand|stuetze|traeger)}].

    Geprüft wird jedes Bauteil, dessen Grundriss die Stabachse kreuzt, an den
    Stellen der Kreuzung: liegt seine Oberkante dort an der Unterkante des
    Stabs, ist es ein Lager. Ein langes Stück auf einer Wand wird zu Stützpunkten
    im Abstand `STUETZPUNKTE_M`.
    """
    from shapely.geometry import LineString, Point

    if stab["plan"] < 1e-6:
        return []
    linie = LineString([stab["a"][:2], stab["e"][:2]])
    richtung = (stab["e"][:2] - stab["a"][:2]) / stab["plan"]
    gefunden: list[dict] = []
    for gid in kandidaten:
        if gid == stab["global_id"]:
            continue
        b = boxen.get(gid) or {}
        if not b.get("hi"):
            continue
        oben = float(b["hi"][2])
        # Schnell aussortieren: oberhalb des Stabs oder weit darunter.
        if oben > max(stab["a"][2], stab["e"][2]) + 0.05:
            continue
        if oben < min(stab["a"][2], stab["e"][2]) - stab["hoehe"] - 0.5:
            continue
        try:
            schnitt = linie.intersection(_figur(b).buffer(0.02))
        except Exception:  # noqa: BLE001
            continue
        if schnitt.is_empty:
            continue
        teile = getattr(schnitt, "geoms", [schnitt])
        rolle = la.rolle_von(b.get("ifc_type") or "", name=b.get("name"))
        art = ("wand" if rolle == "wand" else "stuetze" if rolle == "stuetze" else "traeger")
        for t in teile:
            if t.geom_type == "Point":
                koord = [tuple(t.coords)[0]]
            else:
                koord = list(t.coords)
            stellen = sorted(float(np.dot(np.array(c) - stab["a"][:2], richtung)) for c in koord)
            s0, s1 = stellen[0], stellen[-1]
            if art == "wand" and s1 - s0 >= 2 * STUETZPUNKTE_M:
                n = max(2, int(round((s1 - s0) / STUETZPUNKTE_M)) + 1)
                proben = [s0 + (s1 - s0) * k / (n - 1) for k in range(n)]
            else:
                proben = [(s0 + s1) / 2.0]
            for s in proben:
                if abs(oben - _unterkante(stab, s)) <= AUFLAGER_TOLERANZ_M:
                    gefunden.append({"stelle": s, "global_id": gid, "art": art})
    return gefunden


def _einzugsbreiten(sparren: list[dict]) -> dict[str, float]:
    """Einzugsbreite je Sparren aus den Nachbarn derselben Dachfläche."""
    flaechen: dict[tuple, list] = {}
    for s in sparren:
        r = (s["e"][:2] - s["a"][:2]) / max(s["plan"], 1e-9)
        winkel = int(round(math.degrees(math.atan2(r[1], r[0])) / 3.0))
        flaechen.setdefault((winkel, int(round(s["neigung"] / 3.0))), []).append(s)
    breiten: dict[str, float] = {}
    for gruppe in flaechen.values():
        r = (gruppe[0]["e"][:2] - gruppe[0]["a"][:2]) / max(gruppe[0]["plan"], 1e-9)
        normale = np.array([-r[1], r[0]])
        reihe = sorted(gruppe, key=lambda s: float(np.dot(s["a"][:2], normale)))
        lagen = [float(np.dot(s["a"][:2], normale)) for s in reihe]
        for i, s in enumerate(reihe):
            links = (lagen[i] - lagen[i - 1]) / 2.0 if i > 0 else None
            rechts = (lagen[i + 1] - lagen[i]) / 2.0 if i + 1 < len(reihe) else None
            innen = [v for v in (links, rechts) if v is not None]
            if not innen:
                breiten[s["global_id"]] = s["breite"]
                continue
            aussen = [v if v is not None else s["breite"] / 2.0 for v in (links, rechts)]
            breiten[s["global_id"]] = sum(aussen)
    return breiten


# ── Das Dach eines Geschosses ────────────────────────────────────────────


def dachlasten(boxen: dict, *, z_von: float, z_bis: float | None,
               annahmen: dict | None = None,
               ausgeschlossen: set | None = None) -> dict:
    """
    Die Lasten eines Steildachs auf die Wände und Stützen darunter.

    @param z_von, z_bis  Sparren, deren unteres Ende in diesem Bereich liegt
    @param ausgeschlossen GlobalIds, die schon anderswo zählen (Balkenlagen)
    @returns {lasten: [punktlast …], kN_je_fall, sparren, traeger, hinweise,
              protokoll}
    """
    annahmen = annahmen or {}
    ausgeschlossen = ausgeschlossen or set()
    aufbau = float(annahmen.get("steildach_aufbau_kNm2") or AUFBAU_VORGABE_KNM2)
    sk = float(annahmen.get("schnee_sk_kNm2") or SCHNEE_SK_VORGABE)

    staebe: dict[str, dict] = {}
    for gid, b in boxen.items():
        if gid in ausgeschlossen:
            continue
        typ = b.get("ifc_type") or ""
        if la.rolle_von(typ) != "unterzug" and not typ.startswith("IfcMember"):
            continue
        stab = _stab(gid, b)
        if stab:
            staebe[gid] = stab
    sparren = [s for s in staebe.values()
               if NEIGUNG_MIN_GRAD <= s["neigung"] <= NEIGUNG_MAX_GRAD
               and s["a"][2] >= z_von - 0.05 and (z_bis is None or s["a"][2] < z_bis)]
    leer = {"lasten": [], "kN_je_fall": {}, "sparren": 0, "traeger": 0, "hinweise": [],
            "protokoll": []}
    if not sparren:
        return leer

    kandidaten = [gid for gid, b in boxen.items()
                  if gid not in ausgeschlossen and b.get("hi")
                  and (la.rolle_von(b.get("ifc_type") or "", name=b.get("name"))
                       in ("wand", "stuetze")
                       or (gid in staebe and staebe[gid]["neigung"] <= LIEGEND_MAX_GRAD))]
    breiten = _einzugsbreiten(sparren)

    # Was auf einem Träger liegt, bis er an der Reihe ist: Stelle, Lastfall, Kraft.
    auf_traeger: dict[str, list[tuple[float, str, float]]] = {}
    lasten: list[dict] = []
    kN: dict[str, float] = {}
    protokoll: list[dict] = []
    hinweise: list[str] = []

    def abgeben(stab, stelle, fall, kraft, ziel, art, herkunft):
        if abs(kraft) < 1e-9:
            return
        if art == "traeger" and ziel in staebe:
            t = staebe[ziel]
            richtung = (t["e"][:2] - t["a"][:2]) / max(t["plan"], 1e-9)
            ort = stab["a"][:2] + (stab["e"][:2] - stab["a"][:2]) / max(stab["plan"], 1e-9) * stelle
            s_t = float(np.dot(ort - t["a"][:2], richtung))
            auf_traeger.setdefault(ziel, []).append((s_t, fall, kraft))
            return
        r = (stab["e"][:2] - stab["a"][:2]) / max(stab["plan"], 1e-9)
        ort = stab["a"][:2] + r * stelle
        # `z`: wo die Kraft ankommt — die Kette entscheidet daran, ob sie über
        # oder unter einer Decke des Geschosses steht.
        lasten.append({"typ": "punkt", "p": [round(float(ort[0]), 4), round(float(ort[1]), 4)],
                       "z": round(_unterkante(stab, stelle), 4),
                       "wert": float(kraft), "lastfall": fall, "art": LASTFAELLE[fall],
                       "bezug": ziel or stab["global_id"], "herkunft": herkunft})

    def rechnen(stab, streckenlasten: dict[str, float], punkte: list[tuple[float, str, float]],
                herkunft: str):
        lager = _lager_suchen(stab, boxen, kandidaten)
        faelle = set(streckenlasten) | {f for _, f, _ in punkte}
        gesamt = {f: streckenlasten.get(f, 0.0) * stab["plan"]
                  + sum(p for _, ff, p in punkte if ff == f) for f in faelle}
        eintrag = {"global_id": stab["global_id"], "name": stab["name"],
                   "neigung_grad": round(stab["neigung"], 1),
                   "lager": [(round(l["stelle"], 3), l["art"], l["global_id"]) for l in lager],
                   "kN": {f: round(v, 3) for f, v in gesamt.items()}}
        protokoll.append(eintrag)
        if not lager:
            hinweise.append(f"Dach: {stab['name']} liegt auf nichts auf — seine Last "
                            f"({sum(gesamt.values()):.1f} kN) geht an seiner Mitte nach unten.")
            for f, v in gesamt.items():
                abgeben(stab, stab["plan"] / 2.0, f, v, None, "frei",
                        f"{herkunft} {stab['name']} (ohne Auflager)")
            return
        # Je Lagerstelle das Bauteil, das dort trägt: Träger vor Stütze vor Wand
        # ist egal — ein Stützpunkt, ein Bauteil (das erste gefundene).
        stellen: dict[float, dict] = {}
        for l in sorted(lager, key=lambda l: (l["art"] != "traeger", l["art"] != "stuetze")):
            stellen.setdefault(round(l["stelle"], 3), l)
        orte = sorted(stellen)
        for f in faelle:
            kraefte = durchlauftraeger(
                stab["plan"], orte, q=streckenlasten.get(f, 0.0),
                punktlasten=[(s, p) for s, ff, p in punkte if ff == f])
            for ort, kraft in zip(orte, kraefte or []):
                l = stellen[ort]
                abgeben(stab, ort, f, kraft, l["global_id"], l["art"],
                        f"{herkunft} {stab['name']}")

    for s in sparren:
        e = breiten.get(s["global_id"], 0.8)
        alpha = math.radians(s["neigung"])
        streckenlasten = {
            "EG": s["gewicht_kN"] / max(s["plan"], 1e-6),
            "AUS": aufbau * e / max(math.cos(alpha), 0.2),
            "S": mu1(s["neigung"]) * sk * e,
        }
        for f, v in streckenlasten.items():
            kN[f] = kN.get(f, 0.0) + v * s["plan"]
        rechnen(s, streckenlasten, [], "Dach: Sparren")

    # Die Träger (Pfetten, Wechsel) von oben nach unten.
    getragen = 0
    erledigt: set[str] = set()
    while True:
        offen = [gid for gid in auf_traeger if gid not in erledigt]
        if not offen:
            break
        gid = max(offen, key=lambda g_: float(boxen[g_]["hi"][2]))
        erledigt.add(gid)
        t = staebe[gid]
        getragen += 1
        kN["EG"] = kN.get("EG", 0.0) + t["gewicht_kN"]
        rechnen(t, {"EG": t["gewicht_kN"] / max(t["plan"], 1e-6)}, auf_traeger[gid],
                "Dach: Pfette")
        if len(erledigt) > 10 * len(staebe) + 10:
            break

    return {"lasten": lasten, "kN_je_fall": {f: round(v, 3) for f, v in kN.items()},
            "sparren": len(sparren), "traeger": getragen, "hinweise": hinweise,
            "protokoll": protokoll,
            "sparren_ids": [s["global_id"] for s in sparren],
            "traeger_ids": sorted(erledigt),
            "z_unten": round(min(float(s["a"][2]) for s in sparren), 4),
            "annahmen": {"aufbau_kNm2_dachflaeche": aufbau, "schnee_sk_kNm2": sk}}
