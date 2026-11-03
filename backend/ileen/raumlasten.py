"""
Nutzlasten aus den Räumen und der Zuschlag aus nichttragenden Wänden.

Bis September 2026 bekam jedes Geschoss **eine** Nutzlast: eine Kategorie aus
den Annahmen, gleichmäßig über die ganze Decke. Das ist für ein Wohnhaus mit
einem Grundriss aus Zimmern nicht falsch, aber es ist auch nicht die Rechnung,
die man führt. Ein Geschoss mit Büro (2,0 kN/m²), Archiv (5,0) und Treppenhaus
(3,0) hat drei verschiedene Flächenlasten, und die Stelle, an der das Archiv
liegt, ist genau die Stelle, an der die Decke bemessen wird.

    IfcSpace.LongName          →  Kategorie  →  q_k
    „Büro"                     →  B1         →  2,0 kN/m²
    „Archiv"                   →  E1.1       →  5,0 kN/m²
    „Treppenhaus"              →  T1         →  3,0 kN/m²
    „Wohnzimmer"               →  A2         →  1,5 kN/m²

## Warum der LongName und nicht der Name

`IfcSpace.Name` ist in der Praxis die **Raumnummer** („1.OG.04"), `LongName`
die Nutzung („Büro"). Beide sind Freitext, und beide werden hier gelesen — erst
`LongName`, dann `Name`, weil die Nummer manchmal die Nutzung mitträgt
(„04 Büro"). Was in keinem von beiden zu erkennen ist, bekommt die
Vorgabekategorie aus den Annahmen und steht mit dieser Herkunft im Bericht.

## Warum die Zuordnung überschreibbar ist

Eine Namensdeutung trifft die Absicht des Modellierers, nicht die des
Tragwerksplaners. „Lager" kann ein Abstellraum (A3, 1,5 kN/m²) oder ein
Lagerraum mit Regalen (E2.1, 7,5 kN/m²) sein — ein Faktor fünf. Die Zuordnung
je Raum lässt sich deshalb ändern: im Steckbrief der Raumansicht, als Eingriff
am System (`nutzlast_raum`). Sie kommt als `nutzlast_je_raum` in den Annahmen
an und sticht die Deutung.

## Der Trennwandzuschlag ist keine Linienlast

Nichttragende Wände könnte man dort ansetzen, wo sie stehen. DIN EN
1991-1-1/NA 6.3.1.2 (8) sagt etwas anderes: sie werden als **gleichmäßig
verteilte Flächenlast** angesetzt, weil eine Trennwand versetzt werden kann und
die Decke für den ungünstigsten Stellplatz tragen muss. Genau deshalb wird hier
verschmiert und nicht örtlich aufgebracht — es ist keine Vereinfachung, sondern
die Norm.

Gerechnet wird aus der **tatsächlichen Geometrie** der nichttragenden Wände
(Länge × Höhe × Dicke × Wichte), geteilt durch die Deckenfläche, und dann auf
die Stufen der Norm aufgerundet. Der Vergleich mit dem Regelwert steht im
Bericht: wo die gerechnete Last die Stufen übersteigt, sagt die Norm, dass ein
Ansatz als Einzellast nötig wäre — und dann muss ein Mensch entscheiden.
"""

from __future__ import annotations

import re
import unicodedata

#: Nutzlasten nach DIN EN 1991-1-1/NA, Tabelle 6.1DE — Kategorie → (q_k, Text).
#:
#: Dieselbe Tabelle wie `tragwerksmodell.NUTZLASTEN`, hier um die Kategorien
#: erweitert, die eine Raumdeutung braucht. Die Werte sind charakteristisch;
#: kombiniert wird in `lastabtrag.bemessungswert()`.
NUTZLASTEN: dict[str, tuple[float, str]] = {
    "A1": (1.5, "Wohn- und Aufenthaltsräume, Decken mit ausreichender Querverteilung"),
    "A2": (1.5, "Wohn- und Aufenthaltsräume"),
    "A3": (2.0, "Wohnungstrenndecken, Kellerräume"),
    "B1": (2.0, "Büroflächen, Arbeitsflächen, Flure"),
    "B2": (3.0, "Büroflächen mit schwerem Betrieb, Flure in Bürogebäuden"),
    "B3": (5.0, "Flure in Krankenhäusern, Hotels, Schulen"),
    "C1": (3.0, "Flächen mit Tischen — Schulräume, Cafés, Restaurants"),
    "C2": (4.0, "Flächen mit fester Bestuhlung — Hörsäle, Kirchen, Theater"),
    "C3": (5.0, "Freie Flächen — Museen, Ausstellungsräume, Zugangsflächen"),
    "C4": (5.0, "Sport- und Spielflächen"),
    "C5": (5.0, "Flächen für großen Menschenandrang — Tribünen, Konzertsäle"),
    "D1": (5.0, "Verkaufsflächen im Einzelhandel"),
    "D2": (5.0, "Flächen in Warenhäusern"),
    "E1.1": (5.0, "Lagerflächen, Bibliotheken, Archive"),
    "E2.1": (7.5, "Lagerflächen mit hoher Beanspruchung"),
    "F": (2.5, "Verkehrs- und Parkflächen für leichte Fahrzeuge"),
    "T1": (3.0, "Treppen und Treppenpodeste — Wohn- und Bürogebäude"),
    "T2": (5.0, "Treppen und Treppenpodeste — allgemein"),
    "Z": (4.0, "Zugänge, Balkone, Loggien"),
    "H": (1.0, "Nicht begehbare Dächer, nur zur Instandhaltung"),
}

#: Nutzungsbezeichnung → Kategorie. Von oben nach unten geprüft, erster
#: Treffer gewinnt.
#:
#: **Die Reihenfolge ist die Aussage.** „Treppenhaus" enthält „haus", „Technik"
#: steckt in „Technikzentrale", und ein „Aktenlager" ist ein Archiv und kein
#: Abstellraum. Spezifisches steht deshalb vor Allgemeinem, und was einander
#: enthält, steht in der Reihenfolge, in der es gemeint ist.
NUTZUNGEN: list[tuple[str, tuple[str, ...]]] = [
    # Erschließung zuerst: „Treppenhaus" und „Flur" tauchen in vielen
    # Zusammensetzungen auf und sind eindeutiger als das, was sie umgibt.
    ("T1", ("treppenhaus", "treppe", "treppenraum", "podest", "stiege")),
    ("Z", ("balkon", "loggia", "terrasse", "dachterrasse", "laubengang",
           "austritt")),
    # Lager vor Abstellraum: ein „Aktenlager" ist ein Archiv.
    ("E1.1", ("archiv", "aktenlager", "registratur", "bibliothek", "buecherei",
              "magazin")),
    ("E2.1", ("hochregal", "schwerlast", "lagerhalle", "warenlager")),
    ("D1", ("verkauf", "laden", "shop", "ladenflaeche", "einzelhandel")),
    ("D2", ("warenhaus", "kaufhaus", "supermarkt")),
    ("C5", ("tribuene", "konzertsaal", "versammlung", "foyer", "wartehalle")),
    ("C4", ("sporthalle", "turnhalle", "spielflaeche", "gymnastik", "fitness")),
    ("C3", ("museum", "ausstellung", "galerie", "empfang", "schalterhalle")),
    ("C2", ("hoersaal", "kirche", "theater", "kino", "aula", "saal")),
    ("C1", ("klassenraum", "klassenzimmer", "seminar", "unterricht", "schulraum",
            "cafe", "kantine", "mensa", "restaurant", "speiseraum",
            "aufenthaltsraum", "besprechung", "konferenz")),
    ("B3", ("krankenzimmer", "patientenzimmer", "station", "hotelflur",
            "schulflur")),
    ("B2", ("werkstatt", "labor", "serverraum", "technikzentrale", "heizraum",
            "lueftungszentrale", "maschinenraum")),
    ("B1", ("buero", "arbeitsraum", "sekretariat", "verwaltung", "praxis",
            "besprechungsraum", "kopierraum", "teekueche", "flur", "gang",
            "korridor", "diele", "vorraum", "windfang", "eingang", "halle")),
    ("F", ("garage", "tiefgarage", "stellplatz", "parkflaeche", "carport")),
    ("A3", ("keller", "kellerraum", "abstellraum", "abstell", "lager",
            "hauswirtschaft", "hwr", "vorratsraum", "speis", "technik")),
    ("A2", ("wohnzimmer", "wohnen", "schlafzimmer", "schlafen", "kinderzimmer",
            "kind", "zimmer", "bad", "badezimmer", "wc", "dusche", "sanitaer",
            "kueche", "essen", "esszimmer", "ankleide", "gaestezimmer",
            "arbeitszimmer", "wohnung", "appartement", "studio")),
    ("H", ("dachboden", "spitzboden", "nicht begehbar", "installationsschacht",
           "schacht")),
]

#: Trennwandzuschlag nach DIN EN 1991-1-1/NA 6.3.1.2 (8): Wandlast je Meter
#: Wandlänge → anzusetzende Flächenlast. Die Norm nennt drei Stufen; darüber
#: ist die Trennwand als Einzellast anzusetzen, nicht mehr als Zuschlag.
TRENNWAND_STUFEN: tuple[tuple[float, float], ...] = (
    (1.0, 0.5),   # bis 1,0 kN/m Wandlast → 0,5 kN/m²
    (2.0, 0.8),   # bis 2,0 kN/m          → 0,8 kN/m²
    (3.0, 1.2),   # bis 3,0 kN/m          → 1,2 kN/m²
)

#: Über dieser Wandlast je Meter verlangt die Norm den Ansatz als Einzellast.
TRENNWAND_GRENZE_KNM = 3.0

#: Wichten nichttragender Wände je Materialklasse, kN/m³. Grobe Regelwerte —
#: sie gehen nur in einen Zuschlag ein, der ohnehin auf Stufen gerundet wird.
WICHTEN: dict[str, float] = {
    "leichtbau": 9.0,    # Gipskarton-Ständerwand mit Dämmung, auf das Volumen
    "mauerwerk": 14.0,   # Porenbeton und Leichthochlochziegel
    "stahlbeton": 25.0,
    "holz": 5.0,
    "glas": 25.0,
}
WICHTE_UNBEKANNT = 12.0

_UMLAUTE = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
                          "Ä": "ae", "Ö": "oe", "Ü": "ue"})


def _entfalten(text: str) -> str:
    ersetzt = str(text or "").translate(_UMLAUTE).lower()
    roh = unicodedata.normalize("NFKD", ersetzt)
    return "".join(z for z in roh if not unicodedata.combining(z))


def kategorie_von(long_name: str | None, name: str | None = None) -> str | None:
    """
    Raumnutzung → Nutzlastkategorie nach DIN EN 1991-1-1/NA Tab. 6.1DE.

    Gelesen wird erst `LongName` (die Nutzung), dann `Name` — die Raumnummer
    trägt die Nutzung manchmal mit („04 Büro"). Was in keinem von beiden zu
    erkennen ist, ergibt `None`; der Aufrufer setzt dann seine Vorgabe ein und
    vermerkt das.

    Zahlen werden vor der Suche entfernt: „Büro 2.14" soll nicht an einer
    Kategorie scheitern, die eine Ziffer im Namen trägt.
    """
    for quelle in (long_name, name):
        if not quelle:
            continue
        t = re.sub(r"\d+([.,]\d+)*", " ", _entfalten(quelle))
        for kategorie, worte in NUTZUNGEN:
            for wort in worte:
                if wort in t:
                    return kategorie
    return None


def nutzlast(kategorie: str | None, vorgabe: str = "A2") -> tuple[float, str, str]:
    """
    Kategorie → (q_k in kN/m², Beschreibung, tatsächlich verwendete Kategorie).

    Eine unbekannte Kategorie fällt auf die Vorgabe zurück, statt zu scheitern:
    sie kann aus einer überschriebenen Zuordnung im FE-Browser stammen, und ein
    Tippfehler dort soll keinen ganzen Lastabtrag verhindern.
    """
    schluessel = kategorie if kategorie in NUTZLASTEN else vorgabe
    if schluessel not in NUTZLASTEN:
        schluessel = "A2"
    wert, text = NUTZLASTEN[schluessel]
    return wert, text, schluessel


def raumlasten(raeume: list[dict], *, vorgabe: str = "A2",
               ueberschrieben: dict[str, str] | None = None) -> list[dict]:
    """
    Aus den Räumen eines Geschosses die Nutzlastflächen.

    @param raeume        Räume mit `grundriss` (Ringliste), `long_name`, `name`
    @param vorgabe       Kategorie für Räume ohne erkennbare Nutzung
    @param ueberschrieben GlobalId → Kategorie, von Hand gesetzt; sticht die
                         Namensdeutung
    @returns eine Liste je Raum mit Polygon, Kategorie, q_k und der Herkunft
             der Zuordnung — die Herkunft gehört in den Bericht, sonst ist
             später nicht zu sehen, ob eine Last gedeutet oder gesetzt wurde

    Räume ohne Grundriss werden übersprungen und gemeldet. Sie sind kein
    Fehler — ein Raum, dessen Netz nicht geschlossen ist, liefert keinen
    Schnitt —, aber ihre Fläche fehlt dann in der Nutzlast, und das muss man
    sehen.
    """
    ueberschrieben = ueberschrieben or {}
    ergebnis: list[dict] = []

    for raum in raeume:
        ringe = raum.get("grundriss") or []
        gid = raum.get("global_id") or ""
        aussen = ringe[0] if ringe and len(ringe[0]) >= 3 else None

        if gid in ueberschrieben:
            kategorie, herkunft = ueberschrieben[gid], "von Hand gesetzt (Eingriff am System)"
        else:
            erkannt = kategorie_von(raum.get("long_name"), raum.get("name"))
            if erkannt:
                kategorie, herkunft = erkannt, "aus der Raumnutzung erkannt"
            else:
                kategorie = vorgabe
                herkunft = "Vorgabe — keine Nutzung im Modell erkennbar"

        wert, text, benutzt = nutzlast(kategorie, vorgabe)
        ergebnis.append({
            "global_id": gid,
            "name": raum.get("name"),
            "nutzung": raum.get("long_name"),
            "kategorie": benutzt,
            "beschreibung": text,
            "q_k_kNm2": wert,
            "herkunft": herkunft,
            "polygon": aussen,
            # Die Löcher des Raumumrisses — eine Stütze mitten im Raum. Ohne
            # sie läge Nutzlast auf der Stütze, was rechnerisch nichts
            # verdirbt, aber die Flächenbilanz um ihren Querschnitt verfälscht.
            "loecher": [r for r in ringe[1:] if len(r) >= 3],
            "ohne_geometrie": aussen is None,
        })

    return ergebnis


def trennwandzuschlag(waende: list[dict], deckenflaeche_m2: float) -> dict:
    """
    Der Zuschlag aus nichttragenden Wänden, nach DIN EN 1991-1-1/NA 6.3.1.2 (8).

    @param waende            Wandprotokoll: nichttragende Einträge mit
                             `laenge_m`, `hoehe_m`, `dicke_gesamt_m` und
                             `wichte_kNm3` oder `materialklasse`
    @param deckenflaeche_m2  Nettofläche der Decke, über die verschmiert wird

    @returns `{q_kNm2, wandlast_kN_je_m, stufe, waende, gewicht_kN, hinweis}`

    **Verschmiert, nicht örtlich.** Eine Trennwand kann versetzt werden; die
    Decke muss für den ungünstigsten Stellplatz tragen. Das ist keine
    Vereinfachung, sondern der Grund, warum die Norm es so verlangt.

    **Gerechnet aus der Geometrie, dann auf die Stufen der Norm gehoben.**
    Der Regelweg ist umgekehrt: man schätzt die Wandlast je Meter und liest die
    Stufe ab. Hier steht die Geometrie zur Verfügung, also wird sie benutzt —
    und das Ergebnis auf die nächste Stufe gehoben, damit der Ansatz normkonform
    bleibt und nicht auf zwei Stellen genau eine Last ausweist, die eine
    Abschätzung ist.

    Über 3,0 kN/m Wandlast verlangt die Norm den Ansatz als **Einzellast**.
    Dann steht ein Hinweis im Ergebnis: das ist eine Entscheidung, die ein
    Mensch treffen muss, und sie stillschweigend auf 1,2 kN/m² zu kappen wäre
    die gefährlichste Auslegung.
    """
    gewicht_kN = 0.0
    laenge_m = 0.0
    gezaehlt = 0

    for w in waende:
        laenge = float(w.get("laenge_m") or 0.0)
        hoehe = float(w.get("hoehe_m") or 0.0)
        dicke = float(w.get("dicke_gesamt_m") or 0.0)
        if laenge <= 0.0 or hoehe <= 0.0 or dicke <= 0.0:
            continue
        # Die Wichte aus dem Schichtaufbau, wo die Kette sie kennt
        # (`tragwerksmodell.wandaufbau`), sonst der Regelwert der Klasse.
        wichte = w.get("wichte_kNm3")
        if wichte is None:
            wichte = WICHTEN.get(w.get("materialklasse") or w.get("klasse") or "",
                                 WICHTE_UNBEKANNT)
        gewicht_kN += laenge * hoehe * dicke * float(wichte)
        laenge_m += laenge
        gezaehlt += 1

    if gezaehlt == 0 or deckenflaeche_m2 <= 0.0:
        return {"q_kNm2": 0.0, "wandlast_kN_je_m": 0.0, "stufe": None,
                "waende": 0, "gewicht_kN": 0.0,
                "hinweis": "Keine nichttragenden Wände erkannt — "
                           "kein Trennwandzuschlag angesetzt."}

    # Wandlast je Meter Wandlänge: die Größe, nach der die Norm ihre Stufen
    # ordnet. Nicht je Meter Decke — das wäre eine andere Zahl.
    je_meter = gewicht_kN / laenge_m if laenge_m > 0 else 0.0
    gerechnet = gewicht_kN / deckenflaeche_m2

    stufe = None
    for grenze, wert in TRENNWAND_STUFEN:
        if je_meter <= grenze:
            stufe = wert
            break

    if stufe is None:
        return {
            "q_kNm2": round(max(gerechnet, TRENNWAND_STUFEN[-1][1]), 3),
            "wandlast_kN_je_m": round(je_meter, 2),
            "stufe": None, "waende": gezaehlt,
            "gewicht_kN": round(gewicht_kN, 1),
            "hinweis": (
                f"Die Wandlast von {je_meter:.2f} kN/m überschreitet die "
                f"{TRENNWAND_GRENZE_KNM:.1f} kN/m der Stufentabelle (DIN EN "
                f"1991-1-1/NA 6.3.1.2 (8)). Angesetzt ist der gerechnete Wert "
                f"{gerechnet:.2f} kN/m²; normgemäß wäre die Wand als Einzellast "
                f"an ihrer Stelle anzusetzen. Das ist eine Entscheidung des "
                f"Tragwerksplaners."),
        }

    # Die Stufe ist der Mindestansatz. Ergibt die Geometrie mehr — viele Wände
    # auf wenig Fläche —, gilt der gerechnete Wert: die Stufe ersetzt die
    # Abschätzung der Wandlast, nicht die Bilanz.
    angesetzt = max(stufe, gerechnet)
    return {
        "q_kNm2": round(angesetzt, 3),
        "wandlast_kN_je_m": round(je_meter, 2),
        "stufe": stufe,
        "waende": gezaehlt,
        "gewicht_kN": round(gewicht_kN, 1),
        "hinweis": (
            f"{gezaehlt} nichttragende Wände, {gewicht_kN:.0f} kN auf "
            f"{deckenflaeche_m2:.0f} m². Wandlast {je_meter:.2f} kN/m → Stufe "
            f"{stufe:.1f} kN/m²"
            + (f"; gerechnet {gerechnet:.2f} kN/m², der größere Wert gilt."
               if angesetzt > stufe else ".")),
    }
