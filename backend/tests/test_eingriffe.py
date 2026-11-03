"""
Prüfstein für die Wandachse und für die Eingriffe am statischen System.

Zwei Dinge, die zusammengehören, weil beide dieselbe Frage beantworten: was
genau ist eigentlich das statische System dieses Bauwerks?

**Teil A — die Achse.** Eine Wand ist ein Lager, nicht zwei. Geprüft wird an
Figuren, deren richtige Antwort man hinschreiben kann: die gerade Wand, die
umlaufende Außenwand mit Innenring, der mehrschalige Aufbau, die von einer Tür
geteilte Wand, die Stütze. Bei der Stütze liegt der eigentliche Fehler, den
dieser Test festhält: alle vier Kanten einer 30er Stütze sind kürzer als die
Mindestlänge von 0,80 m, und sie fiel deshalb aus dem Modell, ehe der Zweig für
Punktlager überhaupt erreicht war.

**Teil A2 — die Eingriffe.** Jede Eingriffsart wirkt an dem Modell, auf das sie
gelegt wird, und ein Eingriff, der ins Leere greift, sagt das, statt daneben zu
greifen.

**Teil C — die Fortpflanzung.** Der eigentliche Punkt: ein Eingriff im ersten
Obergeschoss ändert die Gründungslast. Niemand hat dafür eine
Fortpflanzungsregel geschrieben — die Kette ist eine reine Funktion ihrer
Eingaben, und das genügt.

Ausführen:  python3 tests/test_eingriffe.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ileen import eingriffe as eg  # noqa: E402
from ileen import tragwerksmodell as tm  # noqa: E402


def pruefe(bedingung, text, ist=None, soll=None):
    print(f"  {'ok  ' if bedingung else 'FEHL'}  {text}")
    if not bedingung:
        print(f"        ist:  {ist}")
        print(f"        soll: {soll}")
    return bool(bedingung)


def nah(a, b, tol=1e-3):
    return abs(float(a) - float(b)) <= tol


# ── Teil A: die Wandachse ─────────────────────────────────────────────────


def teil_a():
    gut = True
    print("\nA — ein Linienlager je Wand, in der Wandachse")

    # 1. Gerade Wand 6,00 × 0,24: eine Achse auf y = 0,12
    gerade = [[[0, 0], [6, 0], [6, 0.24], [0, 0.24]]]
    achsen = tm.wandachse(gerade)
    gut &= pruefe(len(achsen) == 1, "gerade Wand ergibt genau ein Lager",
                  len(achsen), 1)
    gut &= pruefe(all(nah(p[1], 0.12) for p in achsen[0]["punkte"]),
                  "die Achse liegt in Wandmitte (y = 0,12)",
                  achsen[0]["punkte"], "y = 0,12")
    gut &= pruefe(nah(achsen[0]["laenge"], 6.0),
                  "die Achse ist so lang wie die Wand", achsen[0]["laenge"], 6.0)

    # Zum Vergleich: die alte Ableitung über die Kanten gab zwei Linien —
    # beide Wandflächen. Genau das soll nicht mehr passieren.
    gut &= pruefe(len(tm.auflagerlinien(gerade)) == 2,
                  "die Kantenzüge sind weiterhin zwei (die beiden Wandflächen)",
                  len(tm.auflagerlinien(gerade)), 2)

    # 2. Umlaufende Außenwand 10 × 8, t = 0,30: ein geschlossener Achszug,
    #    Umfang 2·(9,70 + 7,70) = 34,80 m
    aussen = [[0, 0], [10, 0], [10, 8], [0, 8]]
    innen = [[0.3, 0.3], [9.7, 0.3], [9.7, 7.7], [0.3, 7.7]][::-1]
    ring = tm.wandachse([aussen, innen])
    gut &= pruefe(len(ring) == 1, "umlaufende Außenwand ergibt ein Lager",
                  len(ring), 1)
    gut &= pruefe(nah(ring[0]["laenge"], 34.8, 0.01),
                  "der Achszug hat den Mittelumfang 34,80 m",
                  round(ring[0]["laenge"], 3), 34.8)
    ecke = ring[0]["punkte"][0]
    gut &= pruefe(nah(ecke[0], 0.15) and nah(ecke[1], 0.15),
                  "auch die Ecken liegen in der Achse (0,15 / 0,15)", ecke, [0.15, 0.15])

    # 3. Mehrschalig 11,5 + 14 + 17,5: die Achse gehört der tragenden Schicht.
    #    Sie liegt von 0,255 bis 0,430, ihre Mitte also bei 0,3425.
    schichten, y = [], 0.0
    for t in (0.115, 0.14, 0.175):
        schichten.append([[0, y], [6, y], [6, y + t], [0, y + t]])
        y += t
    mehr = tm.wandachse(schichten)
    gut &= pruefe(len(mehr) == 1, "mehrschaliger Aufbau ergibt ein Lager",
                  len(mehr), 1)
    gut &= pruefe(all(nah(p[1], 0.3425) for p in mehr[0]["punkte"]),
                  "es liegt in der Achse der tragenden Schicht (y = 0,3425)",
                  mehr[0]["punkte"], "y = 0,3425")

    # 4. Eine Tür teilt die Wand: zwei Abschnitte sind zwei Wandstücke und
    #    brauchen beide ein Lager.
    mit_tuer = [[[0, 0], [3, 0], [3, 0.24], [0, 0.24]],
                [[4, 0], [6, 0], [6, 0.24], [4, 0.24]]]
    abschnitte = tm.wandachse(mit_tuer)
    gut &= pruefe(len(abschnitte) == 2,
                  "die von einer Tür geteilte Wand ergibt zwei Lager",
                  len(abschnitte), 2)
    gut &= pruefe(nah(sum(a["laenge"] for a in abschnitte), 5.0),
                  "zusammen 3,00 + 2,00 m", sum(a["laenge"] for a in abschnitte), 5.0)

    # 5. Die Stütze: kein Kantenzug, aber ein Schwerpunkt.
    stuetze = [[[2, 2], [2.3, 2], [2.3, 2.3], [2, 2.3]]]
    gut &= pruefe(tm.auflagerlinien(stuetze) == [],
                  "eine 30er Stütze hat keine Kante über 0,80 m — daran scheiterte sie",
                  tm.auflagerlinien(stuetze), "[]")
    ort = tm.schwerpunkt(stuetze)
    gut &= pruefe(nah(ort[0], 2.15) and nah(ort[1], 2.15),
                  "ihr Schwerpunkt ist der Ort des Punktlagers", ort, [2.15, 2.15])

    # Der Schwerpunkt über das Flächenintegral, nicht über die Eckpunkte:
    # dicht gesetzte Punkte an einer Seite dürfen ihn nicht ziehen.
    dicht = [[[0, 0], [1, 0], [1, 1], [0.75, 1], [0.5, 1], [0.25, 1], [0, 1]]]
    s = tm.schwerpunkt(dicht)
    gut &= pruefe(nah(s[0], 0.5) and nah(s[1], 0.5),
                  "dicht gesetzte Randpunkte verschieben ihn nicht", s, [0.5, 0.5])

    # 6. Die Wandkrone über Fenstern: ein Rechteck mit Zwischenpunkten auf den
    #    Kanten (wo unten Öffnungen beginnen und enden). Die Kanten dazwischen
    #    sind kürzer als 0,80 m; ohne Bereinigung brach der Zug an ihnen ab
    #    (SampleHouse: 11,79 statt 14,15 m, Ostwand an der Wandfläche).
    krone = [[[-6.93, 3.08], [-6.05, 3.08], [-5.53, 3.08], [3.63, 3.08], [5.71, 3.08],
              [5.81, 3.08], [7.21, 3.08], [7.21, 2.96], [7.21, 2.82], [7.04, 2.82],
              [6.81, 2.82], [6.53, 2.82], [6.01, 2.82], [5.73, 2.82], [5.39, 2.82],
              [5.11, 2.82], [-6.68, 2.82], [-6.89, 2.82], [-6.93, 2.82], [-6.93, 3.0]]]
    achse_k = tm.wandachse(krone)
    gut &= pruefe(len(achse_k) == 1 and nah(achse_k[0]["laenge"], 14.14)
                  and all(nah(p[1], 2.95) for p in achse_k[0]["punkte"]),
                  "die Krone mit Zwischenpunkten ergibt eine Achse über die ganze Wand",
                  [(round(a["laenge"], 2), a["punkte"]) for a in achse_k], "14,14 m bei y = 2,95")
    return gut


# ── Teil A2: die Eingriffe wirken auf das Modell ──────────────────────────


def teil_a2():
    gut = True
    print("\nA2 — Eingriffe am abgeleiteten Modell")

    def modell():
        return {
            "auflager": [
                {"id": "A1", "typ": "linie", "art": "gelenkig", "bauteile": ["W1"],
                 "polylinie": [[0, 0], [6, 0]], "_laenge": 6.0},
                {"id": "A2", "typ": "linie", "art": "gelenkig", "bauteile": ["W2"],
                 "polylinie": [[0, 5], [6, 5]], "_laenge": 6.0},
                {"id": "A3", "typ": "punkt", "art": "gelenkig", "bauteile": ["S1"],
                 "p": [3, 2.5], "_laenge": 0.0},
            ],
            "system": [{"dicke_m": 0.2, "flaeche_m2": 30.0}],
            "lasten": [{"id": "L1", "typ": "flaeche", "lastfall": "AUS", "wert": 1.5}],
        }

    m = modell()
    prot = eg.anwenden(m, [eg.pruefe({"art": "lager_entfernen", "bauteil": "W2"})])
    gut &= pruefe([a["id"] for a in m["auflager"]] == ["A1", "A3"],
                  "lager_entfernen nimmt genau das Lager dieses Bauteils",
                  [a["id"] for a in m["auflager"]], "['A1', 'A3']")
    gut &= pruefe(len(prot["angewandt"]) == 1 and prot["hinweise"],
                  "und meldet, dass damit auch das Eigengewicht aus der Kette fällt",
                  prot, "1 angewandt, 1 Hinweis")

    m = modell()
    eg.anwenden(m, [eg.pruefe({"art": "lager_art", "bauteil": "W1",
                               "wert": {"art": "feder",
                                        "federsteifigkeit_kNm2": 50000}})])
    a1 = next(a for a in m["auflager"] if a["id"] == "A1")
    gut &= pruefe(a1["art"] == "feder" and a1["federsteifigkeit_kNm2"] == 50000,
                  "lager_art setzt Art und Steifigkeit", a1, "feder / 50000")

    m = modell()
    eg.anwenden(m, [eg.pruefe({"art": "lager_verschieben", "bauteil": "S1",
                               "wert": {"p": [3.5, 2.0]}})])
    a3 = next(a for a in m["auflager"] if a["id"] == "A3")
    gut &= pruefe(a3["p"] == [3.5, 2.0], "lager_verschieben setzt die neue Lage",
                  a3["p"], [3.5, 2.0])

    m = modell()
    eg.anwenden(m, [eg.pruefe({"art": "lager_hinzufuegen",
                               "wert": {"polylinie": [[0, 2.5], [6, 2.5]]}})])
    neu = m["auflager"][-1]
    gut &= pruefe(neu["id"] == "E1" and nah(neu["_laenge"], 6.0),
                  "ein ergänztes Lager heißt E… und ist von den abgeleiteten zu "
                  "unterscheiden", neu["id"], "E1")

    m = modell()
    eg.anwenden(m, [eg.pruefe({"art": "annahme", "wert": {"dicke_m": 0.24,
                                                         "flaechenlast": {"AUS": 2.5}}})])
    gut &= pruefe(m["system"][0]["dicke_m"] == 0.24 and m["lasten"][0]["wert"] == 2.5,
                  "annahme ändert Dicke und Flächenlast",
                  (m["system"][0]["dicke_m"], m["lasten"][0]["wert"]), (0.24, 2.5))

    m = modell()
    prot = eg.anwenden(m, [eg.pruefe({"art": "lager_entfernen", "bauteil": "XX"})])
    gut &= pruefe(len(m["auflager"]) == 3 and len(prot["ohne_wirkung"]) == 1,
                  "ein Eingriff ins Leere ändert nichts und sagt es",
                  prot["ohne_wirkung"], "1 Eintrag")

    # Der Anker ist die GlobalId, nicht die Lagerkennung — ein Eingriff ohne
    # Bauteil soll gar nicht erst entstehen.
    try:
        eg.pruefe({"art": "lager_entfernen", "wert": {"lager": "A7"}})
        gut &= pruefe(False, "ein Eingriff ohne Bauteilbezug wird abgewiesen")
    except ValueError:
        gut &= pruefe(True, "ein Eingriff ohne Bauteilbezug wird abgewiesen")

    try:
        eg.pruefe({"art": "lager_art", "bauteil": "W1", "wert": {"art": "feder"}})
        gut &= pruefe(False, "ein Federlager ohne Steifigkeit wird abgewiesen")
    except ValueError:
        gut &= pruefe(True, "ein Federlager ohne Steifigkeit wird abgewiesen")

    return gut


# ── Teil B: Wandstücke zu einem Lager zusammenführen ──────────────────────


def teil_b():
    """
    Ob eine 12-m-Wand im IFC ein Bauteil ist oder fünf, entscheidet das
    Autorenwerkzeug — nicht die Statik. Aus fünf Bauteilen dürfen nicht fünf
    Lager werden: kurze, steife Lager ziehen Kraft an und benachbarte heben ab.

    Geprüft wird beides — was verschmelzen muss und was nicht.
    """
    gut = True
    print("\nB — Wandstücke werden ein Lager")

    def linie(kennung, punkte, bauteil, art="gelenkig"):
        laenge = sum(((punkte[i + 1][0] - punkte[i][0]) ** 2
                      + (punkte[i + 1][1] - punkte[i][1]) ** 2) ** 0.5
                     for i in range(len(punkte) - 1))
        return {"id": kennung, "typ": "linie", "art": art,
                "federsteifigkeit_kNm2": None, "bauteile": [bauteil],
                "polylinie": punkte, "_laenge": round(laenge, 3)}

    # Drei Stücke einer geraden Wand, wie Revit sie an Raumgrenzen anlegt.
    drei = [linie("A1", [[0, 0], [4, 0]], "W-1"),
            linie("A2", [[4, 0], [10, 0]], "W-2"),
            linie("A3", [[10, 0], [12, 0]], "W-3")]
    vereint = tm.lager_zusammenfuehren([dict(a) for a in drei])
    gut &= pruefe(len(vereint) == 1, "drei Wandstücke ergeben ein Lager",
                  len(vereint), 1)
    gut &= pruefe(nah(vereint[0]["_laenge"], 12.0),
                  "und es ist 12,00 m lang", vereint[0]["_laenge"], 12.0)
    gut &= pruefe(vereint[0]["bauteile"] == ["W-1", "W-2", "W-3"],
                  "alle drei Bauteile hängen daran", vereint[0]["bauteile"],
                  ["W-1", "W-2", "W-3"])
    anteile = vereint[0]["bauteil_anteile"]
    gut &= pruefe(nah(anteile["W-1"], 4.0) and nah(anteile["W-2"], 6.0)
                  and nah(anteile["W-3"], 2.0),
                  "und jedes mit seiner Achslänge — sonst bekäme das 2-m-Stück "
                  "so viel Kraft wie das 6-m-Stück", anteile,
                  {"W-1": 4.0, "W-2": 6.0, "W-3": 2.0})

    # Die Reihenfolge, in der der Schnitt sie liefert, darf nichts ändern.
    gedreht = tm.lager_zusammenfuehren([dict(drei[2]), dict(drei[0]), dict(drei[1])])
    gut &= pruefe(len(gedreht) == 1 and nah(gedreht[0]["_laenge"], 12.0),
                  "in umgekehrter Reihenfolge dasselbe Ergebnis",
                  len(gedreht), 1)

    # Ein Stück, das andersherum modelliert ist — der Endpunkt liegt vorn.
    umgedreht = tm.lager_zusammenfuehren([
        dict(drei[0]), linie("A2", [[10, 0], [4, 0]], "W-2")])
    gut &= pruefe(len(umgedreht) == 1 and nah(umgedreht[0]["_laenge"], 10.0),
                  "auch wenn ein Stück in Gegenrichtung modelliert ist",
                  len(umgedreht), 1)

    print("\nWas nicht verschmelzen darf")

    # Eine Ecke: zwei Wände im rechten Winkel. Sie stoßen aneinander, sind aber
    # zwei Lager — und eine Verschmelzung machte aus der Ecke eine Gerade.
    ecke = tm.lager_zusammenfuehren([
        linie("A1", [[0, 0], [10, 0]], "W-1"),
        linie("A2", [[10, 0], [10, 8]], "W-2")])
    gut &= pruefe(len(ecke) == 2, "eine Ecke bleibt zwei Lager", len(ecke), 2)

    # Eine Tür: 1 m Lücke. Über einer Öffnung trägt ein Sturz, und der trägt
    # anders als die Wand daneben — bewusst nicht verschmolzen.
    tuer = tm.lager_zusammenfuehren([
        linie("A1", [[0, 0], [4, 0]], "W-1"),
        linie("A2", [[5, 0], [10, 0]], "W-2")])
    gut &= pruefe(len(tuer) == 2, "eine Tür trennt weiterhin", len(tuer), 2)

    # Zwei parallele Wände im Abstand von 3 m — sie stoßen nirgends.
    parallel = tm.lager_zusammenfuehren([
        linie("A1", [[0, 0], [10, 0]], "W-1"),
        linie("A2", [[0, 3], [10, 3]], "W-2")])
    gut &= pruefe(len(parallel) == 2, "parallele Wände bleiben getrennt",
                  len(parallel), 2)

    # Verschiedene Lagerarten: welche gälte für das vereinte Lager? Die Frage
    # darf nicht stillschweigend entschieden werden.
    arten = tm.lager_zusammenfuehren([
        linie("A1", [[0, 0], [4, 0]], "W-1", art="gelenkig"),
        linie("A2", [[4, 0], [10, 0]], "W-2", art="eingespannt")])
    gut &= pruefe(len(arten) == 2,
                  "gelenkig und eingespannt werden nicht vermischt",
                  len(arten), 2)

    # Punktlager bleiben unberührt: eine Stütze ist eine Stütze.
    mit_stuetze = tm.lager_zusammenfuehren([
        linie("A1", [[0, 0], [4, 0]], "W-1"),
        linie("A2", [[4, 0], [10, 0]], "W-2"),
        {"id": "A3", "typ": "punkt", "art": "gelenkig",
         "federsteifigkeit_kNm2": None, "bauteile": ["S-1"], "p": [5, 4],
         "_laenge": 0.0}])
    punkte = [a for a in mit_stuetze if a["typ"] == "punkt"]
    gut &= pruefe(len(mit_stuetze) == 2 and len(punkte) == 1,
                  "die Stütze bleibt ihr eigenes Punktlager",
                  len(mit_stuetze), 2)

    # Die Kennungen werden neu vergeben — nach dem Verschmelzen sind es andere
    # Lager, und A1…An sollen das System zählen, nicht seine Vorgeschichte.
    gut &= pruefe(sorted(a["id"] for a in mit_stuetze) == ["A1", "A2"],
                  "die Kennungen zählen das fertige System",
                  sorted(a["id"] for a in mit_stuetze), ["A1", "A2"])
    return gut


# ── Teil C: die Änderung läuft durch die ganze Kette ──────────────────────


def teil_c():
    """
    Der eigentliche Punkt: ein Eingriff im ersten Obergeschoss ändert die
    Gründungslast.

    Geliehen wird der Prüfkörper aus `test_kette.py` — zwei Baukörper, drei
    Geschosse, je eine umlaufende Außenwand — samt seiner Schnitt- und
    Rechenattrappe. Damit ist die Kette ohne IFC und ohne JAX rechenbar, und
    jede Abweichung gehört der Fortpflanzung und nicht dem Solver.
    """
    gut = True
    print("\nC — ein Eingriff pflanzt sich bis zur Gründung fort")

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import test_kette as tk  # noqa: PLC0415 — bewusst spät, es baut den Prüfkörper
    from ileen import kette  # noqa: PLC0415

    def lauf(eingriffe=None):
        tk.GERECHNETE_MODELLE.clear()
        return kette.rechne_kette(tk.zugang(), {"nur_tragende": True},
                                  eingriffe=eingriffe)

    ohne = lauf()
    # Die Bodenplatten ausgenommen: sie sind gebettet und haben bewusst kein
    # Auflager — unter ihnen steht keine Wand, sondern Boden.
    decken = [m for m in tk.GERECHNETE_MODELLE
              if not str(m["plan"].get("submodell", "")).startswith("submodell.FUND")]
    gut &= pruefe(all(len(m["auflager"]) == 1 for m in decken),
                  "jede umlaufende Außenwand ergibt genau ein Lager je Feld",
                  [len(m["auflager"]) for m in decken], "alle 1")
    gut &= pruefe(ohne["bilanz"]["erhalten"],
                  "die Erhaltungsprobe stimmt auch mit Achslagern")

    gid = tk.WAND_GID[("B", "1.OG")]
    mit = lauf([eg.pruefe({"art": "lager_entfernen", "bauteil": gid})])

    # **Die Wand trägt nicht mehr, aber sie wiegt.** Bis Oktober 2026
    # verschwand mit dem Lager das ganze Konto — und mit ihm das Eigengewicht
    # einer Wand, die doch auf der Decke darunter steht. Jetzt führt sie ein
    # Konto mit nichts als ihrem Eigengewicht, und das geht nach unten.
    from ileen import lastabtrag as la  # noqa: PLC0415
    konto = [k for k in mit["konten"] if k["global_id"] == gid]
    gut &= pruefe(len(konto) == 1 and set(konto[0]["anteile_kN"]) == {la.EIGENGEWICHT},
                  "die entlagerte Wand trägt nur noch ihr Eigengewicht",
                  [k["anteile_kN"] for k in konto], "{'EG': …}")
    gut &= pruefe(bool(konto) and any("Eingriff" in h for h in konto[0]["hinweise"]),
                  "und ihr Konto sagt, warum",
                  konto[0]["hinweise"] if konto else None, "… Eingriff …")

    # **Das Feld darüber hat kein Lager mehr.** Die umlaufende Wand war sein
    # einziges; ohne sie ist es kinematisch. Die Kette rechnet es nicht, die
    # Lasten von oben gehen hindurch, und seine eigene Last steht als
    # Fehlbetrag in der Bilanz. Vorher lieferte die Rechenattrappe ohne Lager
    # schlicht null Reaktionen: die Last des Felds und alles, was darauf
    # stand, verschwand still — bei einer Bilanz, die „erhalten“ meldete.
    vorher = ohne["gruendung"]["summe_kN"]
    nachher = mit["gruendung"]["summe_kN"]
    feld = sum(n["kN"] for n in mit["nicht_gerechnet"])
    gut &= pruefe(len(mit["nicht_gerechnet"]) == 1 and abs(vorher - nachher - feld) < 0.5,
                  f"die Gründungslast sinkt um genau die Last des Felds "
                  f"({vorher:.0f} → {nachher:.0f} kN, Feld {feld:.0f} kN) — der Eingriff "
                  f"ist zwei Geschosse tiefer angekommen, die Lasten darüber auch",
                  round(vorher - nachher, 1), round(feld, 1))
    gut &= pruefe(not mit["bilanz"]["erhalten"]
                  and abs(mit["bilanz"]["fehlbetrag_kN"] - feld) < 0.5,
                  "und die Bilanz weist das Feld als Fehlbetrag aus, statt „erhalten“ "
                  "zu melden",
                  (mit["bilanz"]["erhalten"], mit["bilanz"]["fehlbetrag_kN"]),
                  (False, round(feld, 1)))
    gut &= pruefe(any("kein Auflager" in h or "kinematisch" in h for h in mit["hinweise"]),
                  "und die Kette sagt, dass das Feld kein Auflager mehr hat")

    # Ein Eingriff, der nirgends greift, wird genau einmal gemeldet — nicht
    # einmal je Deckenfeld, in dem sein Bauteil nicht vorkommt.
    daneben = lauf([eg.pruefe({"art": "lager_entfernen", "bauteil": "GIBT-ES-NICHT"})])
    treffer = [h for h in daneben["hinweise"] if "GIBT-ES-NICHT" in h]
    gut &= pruefe(len(treffer) == 1,
                  "ein Eingriff ins Leere wird genau einmal gemeldet",
                  len(treffer), 1)
    return gut


# ── Teil D: Nutzlast je Raum (seit 2026-10-18) ────────────────────────────


def teil_d():
    """
    `nutzlast_raum`: gesetzt in der Raumansicht, wirkt vor der Ableitung und
    greift nur unter der Decke, unter der der Raum liegt — sonst veraltete eine
    Nutzlast im Erdgeschoss jedes Geschoss des Hauses.
    """
    print("\nTeil D — Nutzlast je Raum")
    gut = True

    e = eg.pruefe({"art": "nutzlast_raum", "bauteil": "RAUM-1", "wert": {"kategorie": "E1.1"}})
    gut &= pruefe(e["wert"] == {"kategorie": "E1.1"}, "Kategorie in Normalform", e["wert"])
    gut &= pruefe(eg.titel(e) == "Nutzlast RAUM-1: E1.1", "Titel im Verlauf", eg.titel(e))
    for falsch, warum in [({"art": "nutzlast_raum", "wert": {"kategorie": "B1"}}, "ohne Raum"),
                          ({"art": "nutzlast_raum", "bauteil": "R", "wert": {"kategorie": "B7"}}, "unbekannte Kategorie")]:
        try:
            eg.pruefe(falsch)
            gut &= pruefe(False, f"{warum} wird abgelehnt")
        except ValueError:
            gut &= pruefe(True, f"{warum} wird abgelehnt")

    andere = eg.pruefe({"art": "bauteil_tragend", "bauteil": "W-1", "wert": {"tragend": False}})
    vorgabe = eg.nutzlast_vorgabe([e, andere])
    gut &= pruefe(vorgabe == {"RAUM-1": "E1.1"}, "Vorgabe nur aus nutzlast_raum", vorgabe)

    modell = {"auflager": [], "lasten": [
        {"typ": "flaeche", "lastfall": "NUTZ", "wert": 5.0, "bezug": "RAUM-1"},
        {"typ": "flaeche", "lastfall": "NUTZ", "wert": 2.0, "bezug": "RAUM-2"}]}
    proto = eg.anwenden(modell, [{**e, "nr": 7}])
    gut &= pruefe([x["nr"] for x in proto["angewandt"]] == [7], "greift, wo der Raum liegt", proto)
    anderes = {"auflager": [], "lasten": [{"typ": "flaeche", "lastfall": "NUTZ", "wert": 2.0, "bezug": "RAUM-9"}]}
    proto2 = eg.anwenden(anderes, [{**e, "nr": 7}])
    gut &= pruefe(not proto2["angewandt"] and proto2["ohne_wirkung"], "greift nicht unter einer anderen Decke", proto2)

    # Die Nutzlastfläche selbst: der Eingriff sticht die Deutung aus dem Namen.
    raeume = [{"global_id": "RAUM-1", "name": "1.01", "long_name": "Büro",
               "grundriss": [[[0, 0], [4, 0], [4, 5], [0, 5]]]}]
    flaechen, _ = tm._nutzlastflaechen(raeume, [[0, 0], [4, 0], [4, 5], [0, 5]], [], "A2", 1.5,
                                       eg.nutzlast_vorgabe([e]))
    raum = [f for f in flaechen if f.get("global_id") == "RAUM-1"][0]
    gut &= pruefe(raum["kategorie"] == "E1.1" and raum["q_k_kNm2"] == 5.0,
                  "Büro mit Eingriff E1.1 trägt 5,0 kN/m² statt B1", (raum["kategorie"], raum["q_k_kNm2"]))
    gut &= pruefe("Eingriff" in raum["herkunft"], "Herkunft nennt den Eingriff", raum["herkunft"])
    return gut


def main() -> int:
    alles = teil_a() and teil_a2() and teil_b() and teil_c() and teil_d()
    print("\n" + ("Alle Prüfungen bestanden." if alles else "FEHLGESCHLAGEN."))
    return 0 if alles else 1


if __name__ == "__main__":
    sys.exit(main())
