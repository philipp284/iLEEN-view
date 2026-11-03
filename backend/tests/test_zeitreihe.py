"""
Prüfstein für die Zeitreihen-Ablage.

Vier Eigenschaften entscheiden darüber, ob diese Ablage trägt — und drei davon
brechen still:

1. **Die IRI muss dieselbe sein wie im Generator.** `zeitreihe.py` und
   `sensor_demo.py` rechnen sie unabhängig voneinander aus. Läuft eine der
   beiden Regeln weg, kommt weiter eine gültige UUID heraus — sie trifft nur
   nichts mehr, und die Oberfläche zeigt ein Bauteil ohne Sensoren statt eines
   Fehlers. Deshalb werden hier **beide Module gegeneinander** geprüft.
2. **Idempotenz.** Dieselbe Datei zweimal eingespeist muss dieselbe Ablage
   ergeben. Ohne das ist jeder abgebrochene Import ein Aufräumauftrag.
3. **Ein Bauteil ohne Sensoren ist kein Fehler.** Es ist der Normalfall — bei
   34.376 Bauteilen und 24 Sensoren trifft ein Klick fast immer ins Leere.
4. **Ausdünnen darf nicht mitteln** und muss die Grenzen des Fensters
   behalten, sonst verschwinden genau die Ausreißer, für die die Anzeige da
   ist.

Läuft gegen eine Wegwerf-Datenbank in /tmp, rührt also keinen Betrieb an.

Ausführen:  python3 tests/test_zeitreihe.py
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

# Muss vor dem Import stehen: das Modul liest den Pfad beim Laden.
_tmp = tempfile.mkdtemp(prefix="ileen-zeitreihe-")
os.environ["ILEEN_SENSOR_DB"] = str(Path(_tmp) / "zeitreihe.db")

import sensor_demo as gen  # noqa: E402
from ileen import zeitreihe as zr  # noqa: E402

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


ENDE = datetime(2026, 9, 20, 0, 0, 0, tzinfo=timezone.utc)
START = ENDE - timedelta(hours=6)


def demodaten(start=START, ende=ENDE, schritt=60, seed=42):
    import json
    _, sensoren = gen.lies_register()
    zeilen = []
    gen.rueckblick(sensoren, start, ende, schritt, seed, zeilen.append)
    return [json.loads(z) for z in zeilen]


# ── 1. Das Register ─────────────────────────────────────────────────────────

print("\nDas Register kommt aus der CSV und trägt beide IRI")

reg = zr.register()
gleich(len(reg), 24, "vierundzwanzig Sensoren")
pflicht = {"sensor_id", "iri", "zone", "anker_guid", "anker_iri", "einheit",
           "brick_klasse", "bereich_min", "bereich_max"}
pruefe(all(pflicht <= set(s) for s in reg), "jeder Eintrag trägt die geforderten Felder")
pruefe(len({s["iri"] for s in reg}) == 24, "alle IRI sind verschieden")
gleich(len({s["anker_iri"] for s in reg}), 7, "sieben verschiedene Anker")

# ── 2. Dieselbe IRI wie im Generator ────────────────────────────────────────

print("\nAblage und Generator rechnen dieselbe IRI")

gleich(zr.IRI_NAMENSRAUM_SENSOR, gen.IRI_NAMENSRAUM_SENSOR, "derselbe Namensraum")
_, gen_sensoren = gen.lies_register()
gen_iri = {s["sensor_id"]: s["iri"] for s in gen_sensoren}
gen_anker = {s["sensor_id"]: s["anker_iri"] for s in gen_sensoren}
abweichend = [s["sensor_id"] for s in reg if s["iri"] != gen_iri.get(s["sensor_id"])]
pruefe(not abweichend, "alle 24 Sensor-IRI stimmen überein", abweichend or None, "keine Abweichung")
abweichend = [s["sensor_id"] for s in reg if s["anker_iri"] != gen_anker.get(s["sensor_id"])]
pruefe(not abweichend, "alle Anker-IRI stimmen überein", abweichend or None, "keine Abweichung")

gleich(zr.iri_bauteil("20FpTZCqJy2vhVJYtjuIce"), "8025934e-6e36-5dee-8e49-6528c1c4f514",
       "Festwert IfcSite")
gleich(zr.iri_sensor("TMP-EG-S"), "6a810c5d-6009-5191-b86e-3488917c422e",
       "Festwert Sensor TMP-EG-S")

# ── 3. Aufnehmen und Idempotenz ─────────────────────────────────────────────

print("\nAufnehmen ist idempotent")

daten = demodaten()
erste = zr.aufnehmen(daten)
gleich(erste, len(daten), f"{len(daten)} Werte übernommen")
nach_erstem = zr.zahlen()["werte"]

zweite = zr.aufnehmen(daten)
nach_zweitem = zr.zahlen()["werte"]
gleich(nach_zweitem, nach_erstem, "zweiter Durchlauf ändert die Zeilenzahl nicht")
pruefe(zweite == len(daten), "und meldet trotzdem, wie viele Werte er gesehen hat")

gleich(zr.zahlen()["sensoren"], 24, "alle 24 Sensoren haben Werte")
gleich(zr.aufnehmen([]), 0, "eine leere Lieferung ist kein Fehler")

# ── 4. Der Stand ────────────────────────────────────────────────────────────

print("\nDer Stand ist je Sensor der jüngste Wert")

stand = zr.stand()
gleich(len(stand), 24, "vierundzwanzig Einträge")
pruefe(all(s["zeit"] is not None for s in stand), "jeder trägt eine Zeit")

# gegen die Quelldaten nachgerechnet, nicht gegen die Ablage selbst
jüngste = {}
for m in daten:
    if m["zeit"] > jüngste.get(m["sensor"], ("", None))[0]:
        jüngste[m["sensor"]] = (m["zeit"], m["wert"])
falsch = [s["sensor_id"] for s in stand
          if (s["zeit"], s["wert"]) != jüngste.get(s["sensor_id"])]
pruefe(not falsch, "jeder Stand ist der jüngste Wert der Quelldatei",
       falsch or None, "keine Abweichung")

# ── 5. Der Join über die IRI ────────────────────────────────────────────────

print("\nDer Join läuft über die IRI")

site = zr.am_bauteil("8025934e-6e36-5dee-8e49-6528c1c4f514")
gleich(sorted(s["sensor_id"] for s in site), ["ELT-GESAMT", "MET-GHI", "MET-TA"],
       "die IfcSite trägt genau drei Sensoren")

dach_iri = zr.iri_bauteil("0xGtk$Xo5FKhcFT3k0GTWG")
dach = zr.am_bauteil(dach_iri)
gleich(sorted(s["sensor_id"] for s in dach),
       ["PV-E", "PV-P", "PV-TMOD", "PWR-DACH", "TMP-DACH-N", "TMP-DACH-S"],
       "das Dach trägt sechs Sensoren")
pruefe(all(s["wert"] is not None for s in dach), "jeder davon mit letztem Wert")

leer = zr.am_bauteil("00000000-0000-0000-0000-000000000000")
gleich(leer, [], "eine unbekannte IRI ergibt eine leere Liste, keinen Fehler")
pruefe(zr.am_bauteil(zr.iri_sensor("PV-P")) == [],
       "auch eine Sensor-IRI an der Bauteil-Abfrage ergibt nichts — kein zweiter Schlüsselraum")

# ── 6. Verlauf ──────────────────────────────────────────────────────────────

print("\nDer Verlauf ist aufsteigend und achtet das Fenster")

pv = zr.iri_sensor("PV-P")
ganz = zr.verlauf(pv, von="2026-09-19T00:00:00Z", bis="2026-09-20T00:00:00Z")
pruefe(len(ganz) > 0, f"{len(ganz)} Werte im Fenster")
pruefe(all(a["zeit"] <= b["zeit"] for a, b in zip(ganz, ganz[1:])), "aufsteigend nach Zeit")

eng = zr.verlauf(pv, von="2026-09-19T20:00:00Z", bis="2026-09-19T21:00:00Z")
pruefe(all("2026-09-19T20:00:00Z" <= w["zeit"] <= "2026-09-19T21:00:00Z" for w in eng),
       "kein Wert außerhalb des Fensters")
pruefe(len(eng) < len(ganz), "ein engeres Fenster liefert weniger", (len(eng), len(ganz)), "weniger")

ohne = zr.verlauf(pv)
pruefe(len(ohne) > 0, "ohne Fenster kommt etwas zurück — die letzten 24 Stunden")
gleich(zr.verlauf("00000000-0000-0000-0000-000000000000"), [],
       "ein unbekannter Sensor liefert eine leere Liste")

# ── 7. Ausdünnen ────────────────────────────────────────────────────────────

print("\nAusdünnen hält die Grenzen und überschreitet nie die Höchstzahl")

for grenze in (1, 2, 3, 7, 10, 50, 99, 100, 359, 360, 361, 5000):
    d = zr.verlauf(pv, von="2026-09-19T00:00:00Z", bis="2026-09-20T00:00:00Z",
                   hoechstens=grenze)
    if not pruefe(len(d) <= grenze, f"max={grenze}: {len(d)} Werte", len(d), f"<= {grenze}"):
        continue
    if grenze >= 2 and len(ganz) >= 2:
        pruefe(d[0]["zeit"] == ganz[0]["zeit"] and d[-1]["zeit"] == ganz[-1]["zeit"],
               f"max={grenze}: erster und letzter Wert sind dabei",
               (d[0]["zeit"], d[-1]["zeit"]), (ganz[0]["zeit"], ganz[-1]["zeit"]))

viel = zr.verlauf(pv, von="2026-09-19T00:00:00Z", bis="2026-09-20T00:00:00Z",
                  hoechstens=len(ganz) + 100)
gleich(len(viel), len(ganz), "eine Höchstzahl über dem Bestand ändert nichts")

gedünnt = zr.verlauf(pv, von="2026-09-19T00:00:00Z", bis="2026-09-20T00:00:00Z", hoechstens=50)
echte = {(w["zeit"], w["wert"]) for w in ganz}
pruefe(all((w["zeit"], w["wert"]) in echte for w in gedünnt),
       "jeder ausgedünnte Wert ist ein echter Messwert — nicht gemittelt")

# ── 8. Die Ablage rührt keine Betriebsdaten an ──────────────────────────────

print("\nDer Prüfstein arbeitet auf einer Wegwerf-Datenbank")

pruefe(str(zr.DB_PFAD).startswith(_tmp), "die Datenbank liegt in /tmp", str(zr.DB_PFAD), _tmp)
pruefe(zr.DB_PFAD.exists(), "und ist angelegt")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
