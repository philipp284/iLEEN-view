"""
Prüfstein für den künstlichen Sensorstream.

Vier Eigenschaften entscheiden darüber, ob die Demodaten als Prüfgrundlage für
die Zustandsanzeige taugen — und alle vier sind still, wenn sie brechen:

1. **Reproduzierbarkeit.** Ohne sie ist kein anderes Kriterium prüfbar: was
   gestern ein Fehler war, ist heute ein anderer Wert. Der Zufall hängt
   deshalb an Seed und Kennung, nicht an einem Generatorzustand — diese Prüfung
   hält das fest.
2. **Die IRI.** Sie ist der einzige Join-Key zwischen Messwert und Graphknoten.
   Eine geänderte Rechenregel fällt nicht auf: es kommt weiter eine gültige
   UUID heraus, sie trifft nur nichts mehr. Drei Festwerte fangen das ab.
3. **Die Monotonie des Zählers.** Am Wochenende liegt die PV-Leistung über der
   Grundlast. Wer die Differenz ungefiltert integriert, bekommt einen
   rückwärts laufenden Zähler — physikalisch falsch und in der Anzeige ein
   Sprung ins Negative.
4. **Die drei Störungen.** Sie sind der einzige Grund, warum es im Frontend
   etwas zu unterscheiden gibt. Fehlen sie, sieht die Anzeige gesund aus.

Ausführen:  python3 tests/test_sensor_demo.py
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import sensor_demo as sd  # noqa: E402

_gut = True


def pruefe(bedingung, was, ist=None, soll=None):
    global _gut
    if bedingung:
        print(f"  ok    {was}")
    else:
        _gut = False
        print(f"  FEHLT {was}")
        if ist is not None or soll is not None:
            print(f"        ist  {ist!r}")
            print(f"        soll {soll!r}")
    return bedingung


def gleich(ist, soll, was):
    return pruefe(ist == soll, was, ist, soll)


# Fester Endzeitpunkt: der Prüfstein soll am Dienstag dasselbe sagen wie am Freitag.
ENDE = datetime(2026, 9, 20, 0, 0, 0, tzinfo=timezone.utc)
START = ENDE - timedelta(days=7)


def lauf(seed=42, schritt=60, start=START, ende=ENDE):
    _, sensoren = sd.lies_register()
    zeilen = []
    sd.rueckblick(sensoren, start, ende, schritt, seed, zeilen.append)
    return zeilen


# ── 1. Das Register ─────────────────────────────────────────────────────────

print("\nDas Register beschreibt sieben Zonen und vierundzwanzig Sensoren")

zonen, sensoren = sd.lies_register()
gleich(len(zonen), 7, "sieben Zonen")
gleich(len(sensoren), 24, "vierundzwanzig Sensoren")
gleich(sorted({s["zone_id"] for s in sensoren}), sorted(zonen), "jede Zone ist belegt")
pruefe(all(s["anker_guid"] == zonen[s["zone_id"]]["anker_guid"] for s in sensoren),
       "jeder Sensor hängt am Anker seiner Zone")

# ── 2. Die IRI ──────────────────────────────────────────────────────────────

print("\nDie IRI ist rechenbar und trifft die Festwerte")

gleich(sd._iri_bauteil("20FpTZCqJy2vhVJYtjuIce"), "8025934e-6e36-5dee-8e49-6528c1c4f514",
       "IfcSite des Campus")
gleich(sd._iri_bauteil("3SUH1CDZmsK5eBrASO8UdL"), "d5085e20-8dc5-5f26-bb8d-2e3b18f90924",
       "Anker des Erdgeschosses")
gleich(sd._iri_sensor("TMP-EG-S"), "6a810c5d-6009-5191-b86e-3488917c422e",
       "Sensor TMP-EG-S")
pruefe(len({s["iri"] for s in sensoren}) == 24, "alle vierundzwanzig IRI sind verschieden")

# ── 3. Reproduzierbarkeit ───────────────────────────────────────────────────

print("\nZweimal derselbe Seed ergibt Zeile für Zeile dasselbe")

kurz_a = lauf(schritt=60, start=ENDE - timedelta(hours=6))
kurz_b = lauf(schritt=60, start=ENDE - timedelta(hours=6))
gleich(kurz_a, kurz_b, "gleicher Seed, gleiche Ausgabe")

kurz_c = lauf(seed=43, start=ENDE - timedelta(hours=6))
pruefe(kurz_a != kurz_c, "anderer Seed, andere Ausgabe — der Seed wirkt überhaupt")

# ── 4. Der volle Rückblick ──────────────────────────────────────────────────

print("\nSieben Tage im Raster von sechzig Sekunden")

import json  # noqa: E402

zeilen = [json.loads(z) for z in lauf()]
pruefe(len(zeilen) > 180_000, f"{len(zeilen)} Zeilen", len(zeilen), "> 180000")
gleich(sorted({r["status"] for r in zeilen}), ["ausreisser", "ok", "veraltet"],
       "es treten genau die erwarteten Zustände auf")
pruefe(all(set(r) == {"sensor", "iri", "zone", "anker", "zeit", "wert", "einheit", "status"}
           for r in zeilen[:1000]), "jede Zeile führt die acht vereinbarten Felder")
pruefe(all(r["zeit"].endswith("Z") and len(r["zeit"]) == 20 for r in zeilen[:1000]),
       "die Zeit ist ISO 8601 mit Z")

# ── 5. Der Zähler läuft nie rückwärts ───────────────────────────────────────

print("\nDer Bezugszähler ist monoton")

stand = [r["wert"] for r in zeilen if r["sensor"] == "ELT-GESAMT"]
rueckwaerts = [(a, b) for a, b in zip(stand, stand[1:]) if b < a]
pruefe(not rueckwaerts, f"kein Rückschritt über {len(stand)} Ablesungen",
       rueckwaerts[:3] or None, None)
pruefe(stand[-1] > stand[0], "und er steigt überhaupt", stand[-1] - stand[0], "> 0")

# ── 6. Die Sonne ────────────────────────────────────────────────────────────

print("\nDie Photovoltaik folgt der Sonne")

pv = [r for r in zeilen if r["sensor"] == "PV-P"]
nachts = [r["wert"] for r in pv if r["zeit"][11:13] < "04"]
pruefe(max(nachts) == 0.0, "zwischen 00:00 und 04:00 UTC durchgehend null", max(nachts), 0.0)

mittags = {}
for r in pv:
    if "10" <= r["zeit"][11:13] < "14":
        mittags.setdefault(r["zeit"][:10], []).append(r["wert"])
schwach = {t: round(max(v), 1) for t, v in mittags.items() if max(v) <= 10.0}
gleich(len(mittags), 7, "sieben Tage mit Mittagswerten")
pruefe(not schwach, "an jedem Tag mittags über 10 kW", schwach or None, "alle > 10 kW")

# ── 7. Die drei Störungen ───────────────────────────────────────────────────

print("\nDie eingebauten Störungen sind da")

eingefroren = [r for r in zeilen if r["sensor"] == sd.STOER_EINFRIEREN]
veraltet = [r for r in eingefroren if r["status"] == "veraltet"]
pruefe(len(veraltet) > 0, f"{sd.STOER_EINFRIEREN} friert ein ({len(veraltet)} Zeilen)")
pruefe(len({r["wert"] for r in veraltet}) == 1,
       "und wiederholt dabei immer denselben Wert",
       sorted({r["wert"] for r in veraltet})[:4], "genau einer")
pruefe(all(r["status"] == "veraltet" for r in eingefroren[-len(veraltet):]),
       "ab dem Einfrierpunkt kommt nichts Frisches mehr")

je_tag = {}
for r in zeilen:
    if r["sensor"] == sd.STOER_LUECKE:
        je_tag[r["zeit"][:10]] = je_tag.get(r["zeit"][:10], 0) + 1
vollstaendig = 86400 // 300
fehlend = {t: vollstaendig - n for t, n in je_tag.items()}
pruefe(set(fehlend.values()) == {sd.LUECKE_BIS_MIN * 60 // 300},
       f"{sd.STOER_LUECKE} fehlt je Tag {sd.LUECKE_BIS_MIN} Minuten", fehlend, "je 4 Messungen")

register = {s["sensor_id"]: s for s in sensoren}
gr = register[sd.STOER_AUSREISSER]
ausreisser = [r for r in zeilen if r["sensor"] == sd.STOER_AUSREISSER and r["status"] == "ausreisser"]
pruefe(len(ausreisser) >= 5, f"{sd.STOER_AUSREISSER} hat {len(ausreisser)} Ausreißer",
       len(ausreisser), ">= 5")
pruefe(all(r["wert"] < gr["bereich_min"] or r["wert"] > gr["bereich_max"] for r in ausreisser),
       "und jeder liegt außerhalb des Messbereichs")
gesund = [r["wert"] for r in zeilen
          if r["sensor"] == sd.STOER_AUSREISSER and r["status"] == "ok"]
pruefe(all(gr["bereich_min"] <= w <= gr["bereich_max"] for w in gesund),
       "während die gesunden Werte im Bereich bleiben",
       (min(gesund), max(gesund)), (gr["bereich_min"], gr["bereich_max"]))

# ── 8. Physik, die nicht auffällt, wenn sie fehlt ───────────────────────────

print("\nDie Tagesgänge sind plausibel")

pruefe(sd._tagesform(5.0) == -1.0, "die Außentemperatur hat ihr Minimum um 05:00")
pruefe(sd._tagesform(15.0) == 1.0, "und ihr Maximum um 15:00")
pruefe(abs(sd._tagesform(4.99) + 1.0) < 0.01, "der Übergang über Mitternacht ist stetig")

ta = [r["wert"] for r in zeilen if r["sensor"] == "MET-TA"]
pruefe(-10.0 < min(ta) and max(ta) < 40.0, "die Außentemperatur bleibt im Denkbaren",
       (round(min(ta), 1), round(max(ta), 1)), "zwischen -10 und 40 °C")

ghi = [r["wert"] for r in zeilen if r["sensor"] == "MET-GHI"]
pruefe(max(ghi) <= 1000.0, "die Globalstrahlung überschreitet die Solarkonstante nicht",
       max(ghi), "<= 1000 W/m²")

sued = [r["wert"] for r in zeilen if r["sensor"] == "TMP-EG-S" and "11" <= r["zeit"][11:13] < "13"]
nord = [r["wert"] for r in zeilen if r["sensor"] == "TMP-EG-N" and "11" <= r["zeit"][11:13] < "13"]
pruefe(sum(sued) / len(sued) > sum(nord) / len(nord),
       "die Südseite ist mittags wärmer als die Nordseite",
       (round(sum(sued) / len(sued), 2), round(sum(nord) / len(nord), 2)), "Süd > Nord")

ertrag = [r["wert"] for r in zeilen if r["sensor"] == "PV-E"]
pruefe(min(ertrag) == 0.0 and max(ertrag) > 100.0,
       "der PV-Tagesertrag springt um Mitternacht auf null und wächst über den Tag",
       (min(ertrag), round(max(ertrag), 1)), "0 … mehrere hundert kWh")


# ── 9. Echtzeit heißt Echtzeit ──────────────────────────────────────────────

print("\nDer Raffer bestimmt das Tempo — mit gestellter Uhr, ohne zu warten")


class _Uhrende(Exception):
    """Beendet den Echtzeitlauf, sobald die gestellte Uhr ihr Ende erreicht."""


def echtzeit_lauf(raffer, sekunden=5.0, schritt=60):
    """Lässt echtzeit() gegen eine gestellte Uhr laufen und liefert die
    ausgegebenen Modellzeitpunkte.

    `schlafen` stellt die Uhr vor, statt zu warten. Soll über das Ende hinaus
    geschlafen werden, bricht der Lauf ab — alles, was bis dahin ausgegeben
    wurde, ist das, was ein echter Lauf in `sekunden` Uhrzeit geschafft hätte.
    """
    stand = [0.0]

    def uhr():
        return stand[0]

    def schlafen(dauer):
        if stand[0] + dauer > sekunden + 1e-9:
            raise _Uhrende()
        stand[0] += dauer

    zeilen = []
    _, sensoren = sd.lies_register()
    try:
        sd.echtzeit(sensoren, START, schritt, raffer, 42, zeilen.append,
                    uhr=uhr, schlafen=schlafen)
    except _Uhrende:
        pass
    return sorted({json.loads(z)["zeit"] for z in zeilen})


def vorlauf_s(zeitpunkte):
    letzter = datetime.strptime(zeitpunkte[-1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (letzter - START).total_seconds()


langsam = echtzeit_lauf(raffer=1)
schnell = echtzeit_lauf(raffer=60)
pruefe(vorlauf_s(langsam) <= 60,
       f"--raffer 1: nach 5 s höchstens ein Schritt Vorlauf ({vorlauf_s(langsam):.0f} s)",
       vorlauf_s(langsam), "<= 60")
pruefe(240 <= vorlauf_s(schnell) <= 300,
       f"--raffer 60: nach 5 s rund 300 s Vorlauf ({vorlauf_s(schnell):.0f} s)",
       vorlauf_s(schnell), "240 … 300")
pruefe(vorlauf_s(schnell) > vorlauf_s(langsam),
       "und der Raffer macht überhaupt einen Unterschied",
       (vorlauf_s(langsam), vorlauf_s(schnell)), "langsam < schnell")

# Der Standard selbst, aus dem echten Parser gelesen: wer den Strom ohne
# --raffer startet, soll Echtzeit bekommen. Mit 60 als Standard lief jeder so
# gestartete Strom im Zeitraffer und schrieb in die Zukunft — auch nachdem die
# Schlafschleife stimmte.
standard = sd.parser().parse_args(["--live"]).raffer
ohne_angabe = echtzeit_lauf(raffer=standard)
pruefe(vorlauf_s(ohne_angabe) <= 60,
       f"--live ohne --raffer: nach 5 s höchstens ein Schritt Vorlauf "
       f"(Standard {standard:g}, Vorlauf {vorlauf_s(ohne_angabe):.0f} s)",
       vorlauf_s(ohne_angabe), "<= 60")

gleich(echtzeit_lauf(raffer=1, sekunden=65)[-1:],
       [(START + timedelta(seconds=60)).strftime("%Y-%m-%dT%H:%M:%SZ")],
       "--raffer 1: der zweite Zeitpunkt kommt nach 60 s Uhrzeit, nicht vorher")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
