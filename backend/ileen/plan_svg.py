"""
Der Geschossplan eines Submodells — maßstäblich, druckbar, deterministisch.

Für jedes Submodell entsteht bei jeder Rechnung ein Plan. Nicht auf Knopfdruck,
sondern automatisch: wer ein Haus durchrechnet, will die Blätter, nicht die
Erinnerung daran, sie noch erzeugen zu müssen.

## Was darauf steht

    Deckenumriss mit Öffnungen        die Systemfläche, wie sie gerechnet wurde
    Linienlager auf der Wandachse     ein Lager je tragender Wand
    Punktlager                        eine Stütze
    Flächenlasten mit Wert            Ausbau, Trennwandzuschlag, Nutzlast je Raum
    Linienlasten mit Wert             die Wandfußkräfte von oben
    Legende, Maßstab, Nordpfeil
    Kopf mit Submodellname und Eingabe-Hash

**Der Hash steht im Kopf, und das ist kein Schmuck.** Ein ausgedruckter Plan
überlebt den Rechenstand, aus dem er stammt. Wer in einem halben Jahr ein Blatt
in der Hand hält, kann daran erkennen, ob es zu der Rechnung gehört, die gerade
gilt — oder zu einer, die längst überholt ist.

## Warum die Zeichnung aus dem Modell kommt und nicht aus dem Schnitt

Der Plan soll zeigen, **was gerechnet wurde**, nicht was im IFC steht. Das ist
ein Unterschied: das Modell enthält die tragenden Wände als Achsen, die Decke
als Systemfläche, die Lasten als Polygone mit Werten. Ein Plan aus dem
IFC-Schnitt zeigte die Wandquerschnitte und wäre schöner — er zeigte aber nicht,
worauf die Zahlen beruhen. Wo Rechnung und Bauwerk auseinanderlaufen, soll das
Blatt die Rechnung zeigen.

## Determinismus

Gleiche Rechnung, gleiches SVG — Byte für Byte. Das ist Bedingung dafür, dass
zwei Stände vergleichbar sind: ein `diff` zwischen zwei Plänen soll die
Änderung zeigen und nicht die Sortierung eines Wörterbuchs.

Drei Regeln halten das:

1. **Kein Zeitstempel im Blatt.** Er stünde in jeder Fassung anders. Wann
   gerechnet wurde, steht am Rechenstand, nicht im Bild.
2. **Jede Liste wird sortiert**, bevor sie gezeichnet wird — nach einem
   Schlüssel aus der Geometrie, nicht nach einer Kennung, die der Schnitt
   vergibt.
3. **Zahlen werden gerundet**, bevor sie ins Markup gehen. Ein Koordinatenwert
   mit sechzehn Stellen unterscheidet zwei Läufe, die dasselbe rechnen.
"""

from __future__ import annotations

import html
import math

#: Normmaßstäbe, aus denen gewählt wird. Ein krummer Maßstab (1:137) ist auf
#: einem Bauplan nicht brauchbar — man misst darauf nach.
MASSSTAEBE = (20, 25, 50, 100, 200, 250, 500, 1000)

#: Blattformate in mm (Breite, Höhe), quer.
FORMATE = {"A4": (297.0, 210.0), "A3": (420.0, 297.0), "A2": (594.0, 420.0),
           "A1": (841.0, 594.0), "A0": (1189.0, 841.0)}

#: Rand um die Zeichenfläche in mm, und die Breite der Legendenspalte.
RAND_MM = 12.0
LEGENDE_MM = 62.0
KOPF_MM = 14.0

#: Farben. Bewusst wenige und kräftig: ein Plan wird schwarzweiß gedruckt, und
#: was sich dann nicht mehr unterscheidet, muss es über die Strichstärke tun.
FARBEN = {
    "umriss": "#111111",
    "oeffnung": "#888888",
    "lager": "#0b5d9e",
    "last_flaeche": "#c8102e",
    "last_linie": "#8b1a1a",
    "text": "#111111",
    "hilfslinie": "#bbbbbb",
}

#: Füllung der Lastflächen — je Lastfall eine, damit sich Ausbau, Nutzlast und
#: Zuschlag im Bild unterscheiden. Als Schraffur und nicht als Farbfläche: der
#: Grundriss darunter muss lesbar bleiben.
SCHRAFFUREN = {"AUS": "schraffur-aus", "NUTZ": "schraffur-nutz",
               "ABG": "schraffur-abg"}


def _z(wert: float, stellen: int = 2) -> str:
    """
    Eine Zahl für das Markup — gerundet und ohne überflüssige Nullen.

    Sechzehn Nachkommastellen unterscheiden zwei Läufe, die dasselbe rechnen,
    und machen die Datei um ein Vielfaches größer. Zwei Stellen sind bei
    Millimetern auf dem Blatt genauer, als jeder Drucker auflöst.
    """
    gerundet = round(float(wert), stellen)
    if gerundet == 0.0:
        return "0"
    text = f"{gerundet:.{stellen}f}".rstrip("0").rstrip(".")
    return text or "0"


def _t(text) -> str:
    """Fremder Text ins Markup — Bauteilnamen kommen aus dem IFC."""
    return html.escape(str(text if text is not None else ""), quote=True)


def _bereich(punkte) -> tuple[float, float, float, float]:
    xs = [p[0] for p in punkte]
    ys = [p[1] for p in punkte]
    return min(xs), min(ys), max(xs), max(ys)


def massstab_waehlen(breite_m: float, hoehe_m: float,
                     flaeche_mm: tuple[float, float]) -> int:
    """
    Der größte Normmaßstab, in dem die Zeichnung noch auf das Blatt passt.

    Größter, nicht kleinster: ein Plan soll das Blatt füllen. Ein 1:500 auf A3
    für ein Einfamilienhaus ist zwar richtig, aber unbrauchbar.
    """
    if breite_m <= 0 or hoehe_m <= 0:
        return MASSSTAEBE[-1]
    for m in MASSSTAEBE:
        if (breite_m * 1000.0 / m <= flaeche_mm[0]
                and hoehe_m * 1000.0 / m <= flaeche_mm[1]):
            return m
    return MASSSTAEBE[-1]


def _ordnung_flaeche(last: dict) -> tuple:
    """
    Ein Sortierschlüssel aus der Geometrie, nicht aus der Kennung.

    `L7` zählt die Reihenfolge, in der `statikmodell()` die Lasten anlegt, und
    die hängt an der Reihenfolge der Räume. Zwei Läufe über dasselbe Modell
    ergäben verschieden sortierte Listen und damit verschiedene SVG — der
    Determinismus wäre dahin, obwohl sich nichts geändert hat.
    """
    ecken = last.get("polygon") or [[0, 0]]
    x0, y0, x1, y1 = _bereich(ecken)
    return (round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4),
            round(float(last.get("wert") or 0.0), 4), str(last.get("lastfall") or ""))


def _ordnung_linie(last: dict) -> tuple:
    punkte = last.get("polylinie") or [[0, 0]]
    x0, y0, x1, y1 = _bereich(punkte)
    return (round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4),
            round(float(last.get("wert") or 0.0), 4), str(last.get("lastfall") or ""))


def _ordnung_lager(lager: dict) -> tuple:
    if lager.get("typ") == "punkt":
        p = lager.get("p") or [0, 0]
        return (0, round(p[0], 4), round(p[1], 4), 0.0, 0.0)
    punkte = lager.get("polylinie") or [[0, 0]]
    x0, y0, x1, y1 = _bereich(punkte)
    return (1, round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4))


def plan(modell: dict, *, format: str = "A3",
         protokoll: dict | None = None) -> str:
    """
    Der Geschossplan eines Submodells als SVG.

    @param modell     das gerechnete `ileen.plan.fem`-Modell
    @param format     Blattformat, quer (A4…A0)
    @param protokoll  das Protokoll von `statikmodell()` — liefert die
                      Herkunft der Deckendicke und den Trennwandzuschlag für
                      die Legende. Ohne es fehlen diese Zeilen, der Plan
                      entsteht trotzdem.

    @returns vollständiges SVG-Dokument als Text
    """
    system = (modell.get("system") or [{}])[0]
    umriss = system.get("umriss") or []
    if len(umriss) < 3:
        raise ValueError(
            "Ohne Systemumriss lässt sich kein Plan zeichnen — das Modell hat "
            "keine Systemfläche.")

    blatt_b, blatt_h = FORMATE.get(format, FORMATE["A3"])
    zeichen_b = blatt_b - 2 * RAND_MM - LEGENDE_MM
    zeichen_h = blatt_h - 2 * RAND_MM - KOPF_MM

    x0, y0, x1, y1 = _bereich(umriss)
    breite_m, hoehe_m = x1 - x0, y1 - y0
    m = massstab_waehlen(breite_m, hoehe_m, (zeichen_b, zeichen_h))

    # Von Modellmetern in Blattmillimeter. Y wird gespiegelt: im Bauwerk zeigt
    # y nach Norden, im SVG nach unten. Ohne die Spiegelung stünde der Plan
    # auf dem Kopf, und ein Nordpfeil machte es nur schlimmer.
    faktor = 1000.0 / m
    versatz_x = RAND_MM + (zeichen_b - breite_m * faktor) / 2.0
    versatz_y = RAND_MM + KOPF_MM + (zeichen_h - hoehe_m * faktor) / 2.0

    def bx(x: float) -> float:
        return versatz_x + (x - x0) * faktor

    def by(y: float) -> float:
        return versatz_y + (y1 - y) * faktor

    def pfad(punkte, schliessen: bool = True) -> str:
        if not punkte:
            return ""
        teile = [f"M {_z(bx(punkte[0][0]))} {_z(by(punkte[0][1]))}"]
        teile += [f"L {_z(bx(p[0]))} {_z(by(p[1]))}" for p in punkte[1:]]
        if schliessen:
            teile.append("Z")
        return " ".join(teile)

    teile: list[str] = []
    legende: list[tuple[str, str]] = []

    # ── Die Systemfläche mit ihren Öffnungen ─────────────────────────────
    #
    # Als **ein** Pfad mit Even-Odd-Füllregel: der Umriss und seine Löcher
    # gehören zusammen. Zwei getrennte Pfade — einer gefüllt, einer weiß —
    # sähen gleich aus, bis jemand den Plan über einen anderen legt; dann
    # deckte das weiße Loch zu, was darunter liegt.
    oeffnungen = sorted(system.get("oeffnungen") or [],
                        key=lambda r: _bereich(r))
    flaechenpfad = pfad(umriss) + "".join(" " + pfad(o) for o in oeffnungen)
    teile.append(
        f'<path d="{flaechenpfad}" fill="#f4f4f2" fill-rule="evenodd" '
        f'stroke="{FARBEN["umriss"]}" stroke-width="0.6"/>')
    if oeffnungen:
        # Ein Kreuz in jeder Öffnung — sonst ist ein Treppenauge im Ausdruck
        # von einer nicht gezeichneten Fläche nicht zu unterscheiden.
        for o in oeffnungen:
            ox0, oy0, ox1, oy1 = _bereich(o)
            teile.append(
                f'<path d="M {_z(bx(ox0))} {_z(by(oy0))} L {_z(bx(ox1))} '
                f'{_z(by(oy1))} M {_z(bx(ox0))} {_z(by(oy1))} L {_z(bx(ox1))} '
                f'{_z(by(oy0))}" stroke="{FARBEN["oeffnung"]}" '
                f'stroke-width="0.25" fill="none"/>')
        legende.append(("oeffnung", f"{len(oeffnungen)} Öffnung(en) — "
                                    f"Treppenauge, Schacht, Aussparung"))

    # ── Lastflächen ──────────────────────────────────────────────────────
    #
    # **Nur die örtlichen werden gezeichnet.** Ausbaulast und
    # Trennwandzuschlag liegen über der ganzen Systemfläche; eine Schraffur
    # dafür deckt den Grundriss zu und sagt nichts, was die Legende nicht
    # besser sagt — sie haben keinen Ort. Gezeichnet wird, was einen hat: die
    # Nutzlast je Raum, die Restfläche, jede Last auf einem Teilbereich.
    #
    # Die Unterscheidung läuft über die Fläche und nicht über den Lastfall:
    # eine Ausbaulast, die nur in einem Bereich liegt (ein Gründach über einem
    # Teil der Decke), gehört ins Bild.
    alle_flaechenlasten = sorted(
        [l for l in (modell.get("lasten") or []) if l.get("typ") == "flaeche"],
        key=_ordnung_flaeche)
    gesamt = abs(_polygonflaeche(umriss))
    oertlich, ueberall = [], []
    for last in alle_flaechenlasten:
        ecken = last.get("polygon") or []
        eigen = abs(_polygonflaeche(ecken)) if len(ecken) >= 3 else 0.0
        (ueberall if gesamt > 0 and eigen >= 0.98 * gesamt
         else oertlich).append(last)

    for last in oertlich:
        ecken = last.get("polygon")
        if not ecken or len(ecken) < 3:
            continue
        loecher = last.get("loecher") or []
        d = pfad(ecken) + "".join(" " + pfad(h) for h in loecher)
        muster = SCHRAFFUREN.get(last.get("lastfall"), "schraffur-aus")
        teile.append(
            f'<path d="{d}" fill="url(#{muster})" fill-rule="evenodd" '
            f'stroke="{FARBEN["last_flaeche"]}" stroke-width="0.18" '
            f'stroke-dasharray="1.4 1"/>')
        # Die Beschriftung in die Mitte der Hüllbox: der Flächenschwerpunkt
        # läge bei einem L-förmigen Raum außerhalb.
        fx0, fy0, fx1, fy1 = _bereich(ecken)
        if (fx1 - fx0) * faktor > 14 and (fy1 - fy0) * faktor > 7:
            name = last.get("name") or last.get("nutzung")
            mx, my = bx((fx0 + fx1) / 2), by((fy0 + fy1) / 2)
            if name:
                teile.append(
                    f'<text x="{_z(mx)}" y="{_z(my - 1.6)}" '
                    f'text-anchor="middle" font-size="2.2" '
                    f'fill="{FARBEN["text"]}">{_t(name)}</text>')
            teile.append(
                f'<text x="{_z(mx)}" y="{_z(my + 2.2)}" text-anchor="middle" '
                f'font-size="2.8" font-weight="600" '
                f'fill="{FARBEN["last_flaeche"]}">'
                f'{_t(_z(last.get("wert", 0.0), 2))} kN/m²</text>')

    # ── Auflager ─────────────────────────────────────────────────────────
    lager = sorted(modell.get("auflager") or [], key=_ordnung_lager)
    linien = punkte = 0
    for eintrag in lager:
        if eintrag.get("typ") == "punkt":
            p = eintrag.get("p")
            if not p:
                continue
            punkte += 1
            # Ein Dreieck auf der Spitze — das Zeichen für ein Punktlager.
            px, py = bx(p[0]), by(p[1])
            teile.append(
                f'<path d="M {_z(px)} {_z(py)} L {_z(px - 1.6)} {_z(py + 2.8)} '
                f'L {_z(px + 1.6)} {_z(py + 2.8)} Z" '
                f'fill="{FARBEN["lager"]}" stroke="none"/>')
        else:
            zug = eintrag.get("polylinie")
            if not zug or len(zug) < 2:
                continue
            linien += 1
            teile.append(
                f'<path d="{pfad(zug, schliessen=False)}" fill="none" '
                f'stroke="{FARBEN["lager"]}" stroke-width="1.1" '
                f'stroke-linecap="round" stroke-linejoin="round"/>')
    if linien:
        legende.append(("lager", f"{linien} Linienlager auf der Wandachse"))
    if punkte:
        legende.append(("lager-punkt", f"{punkte} Punktlager (Stütze)"))

    # ── Linienlasten aus dem Geschoss darüber ────────────────────────────
    #
    # Zusammengefasst je Polylinie: die Kette reicht je Lastfall eine eigene
    # Last weiter, und drei Pfeilreihen auf derselben Wandachse sind im Bild
    # nicht zu unterscheiden. Auf dem Blatt steht die Summe, in der Legende
    # ihre Aufteilung.
    linienlasten = [l for l in (modell.get("lasten") or [])
                    if l.get("typ") == "linie" and l.get("polylinie")]
    gebuendelt: dict[str, dict] = {}
    for last in sorted(linienlasten, key=_ordnung_linie):
        schluessel = str([[round(p[0], 4), round(p[1], 4)]
                          for p in last["polylinie"]])
        eintrag = gebuendelt.setdefault(
            schluessel, {"polylinie": last["polylinie"], "summe": 0.0,
                         "anteile": {}})
        wert = float(last.get("wert") or 0.0)
        eintrag["summe"] += wert
        fall = str(last.get("lastfall") or "?")
        eintrag["anteile"][fall] = eintrag["anteile"].get(fall, 0.0) + wert

    for eintrag in gebuendelt.values():
        zug = eintrag["polylinie"]
        teile.append(
            f'<path d="{pfad(zug, schliessen=False)}" fill="none" '
            f'stroke="{FARBEN["last_linie"]}" stroke-width="0.5" '
            f'stroke-dasharray="2 1.2"/>')
        mx = sum(p[0] for p in zug) / len(zug)
        my = sum(p[1] for p in zug) / len(zug)
        teile.append(
            f'<text x="{_z(bx(mx))}" y="{_z(by(my) - 1.4)}" '
            f'text-anchor="middle" font-size="2.3" '
            f'fill="{FARBEN["last_linie"]}">'
            f'{_t(_z(eintrag["summe"], 1))} kN/m</text>')
    if gebuendelt:
        summe = sum(e["summe"] for e in gebuendelt.values())
        faelle = sorted({f for e in gebuendelt.values() for f in e["anteile"]})
        # **Achsen und Lastfälle getrennt zählen.** Im Bild steht je Achse eine
        # Zahl — die Summe. Wer wissen will, woraus sie besteht, findet es
        # hier: „4 Wandachsen, Lastfälle ABG · NUTZ". Ohne diese Zeile sähe
        # der Plan aus, als käme von oben eine einzige Last.
        legende.append((
            "last-linie",
            f"{len(gebuendelt)} Wandachse(n) mit Last von oben, zusammen "
            f"{_z(summe, 1)} kN/m · Lastfälle {' · '.join(faelle)}"))

    # ── Was auf einem Lager steht und direkt hineingeht ─────────────────
    #
    # `kette.durchleiten()` nimmt es aus den Lasten heraus; im Plan muss es
    # trotzdem stehen, sonst sähe ein Lager unter einer Wand aus, als trage es
    # nur die Decke. Gezeichnet wie eine Linienlast, beschriftet mit „direkt".
    direkt: dict[str, dict] = {}
    punkte_direkt = 0.0
    for e in sorted(modell.get("durchleitung") or [],
                    key=lambda d: (str(d.get("polylinien") or d.get("p")), str(d.get("lastfall")))):
        if e.get("typ") == "punkt":
            punkte_direkt += float(e.get("kN") or 0.0)
            continue
        for zug in e.get("polylinien") or []:
            if len(zug) < 2:
                continue
            schluessel = str([[round(p[0], 4), round(p[1], 4)] for p in zug])
            eintrag = direkt.setdefault(schluessel, {"polylinie": zug, "summe": 0.0})
            eintrag["summe"] += float(e.get("wert") or 0.0)
    for eintrag in direkt.values():
        zug = eintrag["polylinie"]
        teile.append(
            f'<path d="{pfad(zug, schliessen=False)}" fill="none" '
            f'stroke="{FARBEN["last_linie"]}" stroke-width="0.35" '
            f'stroke-dasharray="0.6 0.9"/>')
        mx = sum(p[0] for p in zug) / len(zug)
        my = sum(p[1] for p in zug) / len(zug)
        teile.append(
            f'<text x="{_z(bx(mx))}" y="{_z(by(my) + 3.2)}" '
            f'text-anchor="middle" font-size="2.0" '
            f'fill="{FARBEN["last_linie"]}">'
            f'{_t(_z(eintrag["summe"], 1))} kN/m direkt</text>')
    if direkt or punkte_direkt:
        gesamt = sum(float(e.get("kN") or 0.0) for e in modell.get("durchleitung") or [])
        legende.append((
            "last-linie",
            f"{len(direkt)} Wandachse(n) stehen auf dem Lager darunter — "
            f"{_z(gesamt, 1)} kN gehen direkt hinein, ohne die Platte zu biegen"))

    return _blatt(modell, system, teile, legende, m, format,
                  (blatt_b, blatt_h), protokoll, ueberall, oertlich)


def _polygonflaeche(punkte) -> float:
    """Gaußsche Trapezformel — für die Frage, ob eine Last die ganze Fläche
    bedeckt oder nur einen Teil davon."""
    n = len(punkte or [])
    if n < 3:
        return 0.0
    return sum(punkte[i][0] * punkte[(i + 1) % n][1]
               - punkte[(i + 1) % n][0] * punkte[i][1]
               for i in range(n)) / 2.0


def _blatt(modell, system, teile, legende, massstab, format, groesse,
           protokoll, ueberall, oertlich) -> str:
    """Rahmen, Kopf, Legende und Maßstabsleiste um die Zeichnung."""
    blatt_b, blatt_h = groesse
    plan_daten = modell.get("plan") or {}
    submodellname = plan_daten.get("submodell") or plan_daten.get("geschoss") or "—"
    eingabe_hash = plan_daten.get("eingabe_hash") or ""

    kopf = [
        f'<rect x="0" y="0" width="{_z(blatt_b)}" height="{_z(blatt_h)}" '
        f'fill="#ffffff"/>',
        f'<rect x="{_z(RAND_MM / 2)}" y="{_z(RAND_MM / 2)}" '
        f'width="{_z(blatt_b - RAND_MM)}" height="{_z(blatt_h - RAND_MM)}" '
        f'fill="none" stroke="{FARBEN["umriss"]}" stroke-width="0.4"/>',
        f'<text x="{_z(RAND_MM)}" y="{_z(RAND_MM + 5)}" font-size="5" '
        f'font-weight="600" fill="{FARBEN["text"]}">{_t(submodellname)}</text>',
        f'<text x="{_z(RAND_MM)}" y="{_z(RAND_MM + 10)}" font-size="2.6" '
        f'fill="#555555">{_t(plan_daten.get("modell") or "")} · '
        f'{_t(plan_daten.get("titel") or "")} · M 1:{massstab}</text>',
    ]
    if eingabe_hash:
        # Der Hash macht ein ausgedrucktes Blatt einer Rechnung zuordenbar.
        kopf.append(
            f'<text x="{_z(blatt_b - RAND_MM)}" y="{_z(RAND_MM + 5)}" '
            f'text-anchor="end" font-size="2.6" fill="#555555">'
            f'Eingabe {_t(eingabe_hash)}</text>')

    # ── Legende ──────────────────────────────────────────────────────────
    lx = blatt_b - RAND_MM - LEGENDE_MM + 2
    ly = RAND_MM + KOPF_MM + 4
    kopf.append(
        f'<text x="{_z(lx)}" y="{_z(ly)}" font-size="3.2" font-weight="600" '
        f'fill="{FARBEN["text"]}">Legende</text>')
    ly += 5

    material = system.get("material") or {}
    grunddaten = [
        f'Systemfläche {_z(system.get("flaeche_m2", 0.0), 1)} m²',
        f'Dicke {_z(float(system.get("dicke_m") or 0.0) * 100, 1)} cm',
        f'Beton {material.get("name", "—")}',
    ]
    if system.get("bettung_kNm3"):
        grunddaten.append(
            f'Bettung {_z(system["bettung_kNm3"], 0)} kN/m³ (Winkler)')
    if protokoll and protokoll.get("dicke_quelle"):
        grunddaten.append(f'Dicke: {protokoll["dicke_quelle"]}')

    for zeile in grunddaten:
        kopf.append(f'<text x="{_z(lx)}" y="{_z(ly)}" font-size="2.4" '
                    f'fill="{FARBEN["text"]}">{_t(zeile)}</text>')
        ly += 3.4

    ly += 2
    for art, text in legende:
        farbe = (FARBEN["lager"] if art.startswith("lager")
                 else FARBEN["last_linie"] if art.startswith("last")
                 else FARBEN["oeffnung"])
        kopf.append(f'<rect x="{_z(lx)}" y="{_z(ly - 2)}" width="4" height="1.2" '
                    f'fill="{farbe}"/>')
        kopf.append(f'<text x="{_z(lx + 6)}" y="{_z(ly)}" font-size="2.4" '
                    f'fill="{FARBEN["text"]}">{_t(text)}</text>')
        ly += 3.6

    # ── Die Lasten in Worten ─────────────────────────────────────────────
    #
    # Die Beschriftung im Bild fehlt dort, wo eine Fläche zu klein ist. Die
    # Legende führt sie deshalb alle auf — ein Plan, auf dem eine Last nur
    # in der Zeichnung steht, verliert sie beim Verkleinern.
    def lastzeile(y: float, last: dict) -> float:
        name = last.get("name") or last.get("nutzung") or last.get("lastfall")
        zusatz = f' ({last["kategorie"]})' if last.get("kategorie") else ""
        kopf.append(
            f'<text x="{_z(lx)}" y="{_z(y)}" font-size="2.3" '
            f'fill="{FARBEN["text"]}">{_t(name)}{_t(zusatz)}</text>')
        kopf.append(
            f'<text x="{_z(blatt_b - RAND_MM - 2)}" y="{_z(y)}" '
            f'text-anchor="end" font-size="2.3" '
            f'fill="{FARBEN["last_flaeche"]}">'
            f'{_t(_z(last.get("wert", 0.0), 2))} kN/m²</text>')
        return y + 3.2

    if ueberall:
        ly += 2
        kopf.append(f'<text x="{_z(lx)}" y="{_z(ly)}" font-size="2.8" '
                    f'font-weight="600" fill="{FARBEN["text"]}">'
                    f'Über die ganze Fläche</text>')
        ly += 4
        for last in ueberall:
            ly = lastzeile(ly, last)
        summe = sum(float(l.get("wert") or 0.0) for l in ueberall)
        kopf.append(
            f'<path d="M {_z(lx)} {_z(ly - 2)} H {_z(blatt_b - RAND_MM - 2)}" '
            f'stroke="{FARBEN["hilfslinie"]}" stroke-width="0.2"/>')
        kopf.append(
            f'<text x="{_z(lx)}" y="{_z(ly + 1.4)}" font-size="2.3" '
            f'font-weight="600" fill="{FARBEN["text"]}">zusammen</text>')
        kopf.append(
            f'<text x="{_z(blatt_b - RAND_MM - 2)}" y="{_z(ly + 1.4)}" '
            f'text-anchor="end" font-size="2.3" font-weight="600" '
            f'fill="{FARBEN["last_flaeche"]}">{_t(_z(summe, 2))} kN/m²</text>')
        ly += 5

    if oertlich:
        ly += 1
        kopf.append(f'<text x="{_z(lx)}" y="{_z(ly)}" font-size="2.8" '
                    f'font-weight="600" fill="{FARBEN["text"]}">'
                    f'Nutzlast je Raum</text>')
        ly += 4
        for last in oertlich:
            ly = lastzeile(ly, last)

    # ── Maßstabsleiste ───────────────────────────────────────────────────
    #
    # Sie ist der einzige Weg, auf einem verkleinerten Ausdruck noch zu messen.
    # Die Länge ist eine runde Zahl in Metern, nicht eine runde in Millimetern.
    leiste_m = _runde_laenge(massstab)
    leiste_mm = leiste_m * 1000.0 / massstab
    sy = blatt_h - RAND_MM - 4
    kopf.append(
        f'<path d="M {_z(RAND_MM)} {_z(sy)} h {_z(leiste_mm)}" '
        f'stroke="{FARBEN["text"]}" stroke-width="0.8"/>')
    for i in range(3):
        x = RAND_MM + i * leiste_mm / 2.0
        kopf.append(f'<path d="M {_z(x)} {_z(sy - 1.2)} v 2.4" '
                    f'stroke="{FARBEN["text"]}" stroke-width="0.4"/>')
    kopf.append(
        f'<text x="{_z(RAND_MM + leiste_mm + 2)}" y="{_z(sy + 1)}" '
        f'font-size="2.4" fill="{FARBEN["text"]}">{leiste_m} m · '
        f'M 1:{massstab}</text>')

    # ── Nordpfeil ────────────────────────────────────────────────────────
    nx = blatt_b - RAND_MM - LEGENDE_MM - 10
    ny = blatt_h - RAND_MM - 6
    kopf.append(
        f'<path d="M {_z(nx)} {_z(ny)} L {_z(nx)} {_z(ny - 8)} '
        f'M {_z(nx - 2)} {_z(ny - 5)} L {_z(nx)} {_z(ny - 8)} '
        f'L {_z(nx + 2)} {_z(ny - 5)}" stroke="{FARBEN["text"]}" '
        f'stroke-width="0.5" fill="none"/>')
    kopf.append(f'<text x="{_z(nx)}" y="{_z(ny + 3)}" text-anchor="middle" '
                f'font-size="2.6" fill="{FARBEN["text"]}">N</text>')

    muster = (
        '<defs>'
        '<pattern id="schraffur-aus" width="3" height="3" '
        'patternTransform="rotate(45)" patternUnits="userSpaceOnUse">'
        '<line x1="0" y1="0" x2="0" y2="3" stroke="#c8102e" '
        'stroke-width="0.15" opacity="0.5"/></pattern>'
        '<pattern id="schraffur-nutz" width="2.2" height="2.2" '
        'patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">'
        '<line x1="0" y1="0" x2="0" y2="2.2" stroke="#c8102e" '
        'stroke-width="0.2" opacity="0.65"/></pattern>'
        '<pattern id="schraffur-abg" width="4" height="4" '
        'patternUnits="userSpaceOnUse">'
        '<circle cx="1" cy="1" r="0.25" fill="#8b1a1a" opacity="0.5"/>'
        '</pattern>'
        '</defs>')

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{_z(blatt_b)}mm" height="{_z(blatt_h)}mm" '
        f'viewBox="0 0 {_z(blatt_b)} {_z(blatt_h)}" '
        f'font-family="Helvetica, Arial, sans-serif">'
        + muster
        + "".join(kopf)
        + '<g id="zeichnung">' + "".join(teile) + '</g>'
        + '</svg>')


def _runde_laenge(massstab: int) -> int:
    """Eine runde Länge in Metern für die Maßstabsleiste."""
    for kandidat in (1, 2, 5, 10, 20, 50, 100):
        if kandidat * 1000.0 / massstab >= 30.0:
            return kandidat
    return 100
