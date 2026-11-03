"""
Prüfstein für den Kafka-Eingang — **ohne Broker**.

Drei Dinge entscheiden, ob dieser Weg trägt, und alle drei brechen still:

1. **Ein fehlender Broker darf nichts aufhalten.** gaeco läuft nur, wenn man es
   braucht; iLEEN muss auch ohne starten. Das ist das Kriterium, an dem es am
   ehesten scheitert, und es lässt sich gerade dann nicht prüfen, wenn man es
   bräuchte — deshalb hier mit Attrappe statt mit Infrastruktur.
2. **Die IRI stammt aus dem Register.** Ab jetzt kommen Werte von außen. Eine
   mitgeschickte, abweichende IRI muss überschrieben werden, sonst stünde ein
   Wert im Stand (der über `sensor` geht) und fehlte im Verlauf (der über `iri`
   geht) — die Oberfläche zeigte eine Zahl, die der Verlauf nicht kennt.
3. **Unbekannte Sensoren werden abgewiesen und gezählt.** Stillschweigend
   abzulegen hieße, eine Halde anzulegen, die wächst und die niemand sieht.

Läuft gegen eine Wegwerf-Datenbank in /tmp und eine Kafka-Attrappe: kein Netz,
keine Infrastruktur, kein laufender Broker.

Ausführen:  python3 tests/test_sensor_kafka.py
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_tmp = tempfile.mkdtemp(prefix="ileen-kafka-")
os.environ["ILEEN_SENSOR_DB"] = str(Path(_tmp) / "zeitreihe.db")

from ileen import sensor_kafka as sk  # noqa: E402
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


ECHT = zr.register()[0]          # ein Sensor, den das Register kennt
ZEIT = "2026-09-21T12:00:00Z"


def wert(sensor, iri, zeit=ZEIT, w=21.5, status="ok"):
    return {"sensor": sensor, "iri": iri, "zone": "Z-EG", "anker": "egal",
            "zeit": zeit, "wert": w, "einheit": "°C", "status": status}


# ── 1. Die IRI stammt aus dem Register ────────────────────────────────────

print("\nDie IRI stammt aus dem Register, nicht aus der Nachricht")

falsch = wert(ECHT["sensor_id"], "11111111-1111-1111-1111-111111111111")
gleich(zr.aufnehmen([falsch]), 1, "der Wert wird übernommen")

stand = {s["sensor_id"]: s for s in zr.stand()}
gleich(stand[ECHT["sensor_id"]]["wert"], 21.5, "und steht im Stand")

verlauf = zr.verlauf(ECHT["iri"], von=ZEIT, bis=ZEIT)
pruefe(len(verlauf) == 1,
       "der Verlauf unter der ECHTEN IRI kennt ihn — die falsche wurde überschrieben",
       len(verlauf), 1)
gleich(zr.verlauf("11111111-1111-1111-1111-111111111111"), [],
       "unter der mitgeschickten IRI liegt nichts")

# ── 2. Unbekannte Sensoren ────────────────────────────────────────────────

print("\nEin Sensor, den das Register nicht kennt, wird abgewiesen")

vorher = zr.zahlen()
gleich(zr.aufnehmen([wert("GIBT-ES-NICHT", "egal-iri")]), 0, "nichts übernommen")
nachher = zr.zahlen()
gleich(nachher["werte"], vorher["werte"], "die Ablage ist nicht gewachsen")
gleich(nachher["abgewiesen"], vorher["abgewiesen"] + 1, "und es wurde gezählt")

gemischt = [wert(ECHT["sensor_id"], "x", zeit="2026-09-21T12:01:00Z"),
            wert("GIBT-ES-NICHT", "y", zeit="2026-09-21T12:01:00Z")]
gleich(zr.aufnehmen(gemischt), 1, "aus einem gemischten Stapel kommt der gute durch")

# ── 3. Der Zuhörer ohne Broker ────────────────────────────────────────────

print("\nOhne Broker wird gar nicht erst verbunden")

ohne = sk.Zuhoerer(broker="")
asyncio.run(ohne.start())
pruefe(ohne.aufgabe is None, "keine Aufgabe gestartet")
pruefe(ohne.laeuft is False, "und der Zuhörer läuft nicht")
asyncio.run(ohne.stop())
pruefe(True, "stop() ohne start() wirft nicht")


print("\nEin Broker, der nicht antwortet, hält nichts auf")


async def unerreichbar():
    # Port 1 nimmt niemand an — das ist der Fall „gaeco ist aus".
    z = sk.Zuhoerer(broker="127.0.0.1:1")
    sk.WARTE_MIN_S = sk.WARTE_MAX_S = 0.05
    await z.start()
    await asyncio.sleep(0.6)      # mehrere Fehlversuche
    laeuft_noch = z.aufgabe is not None and not z.aufgabe.done()
    gemeldet = z.gemeldet
    await z.stop()
    return laeuft_noch, gemeldet, z


laeuft_noch, gemeldet, z = asyncio.run(unerreichbar())
pruefe(laeuft_noch, "die Aufgabe lebt weiter, statt sich zu beenden")
pruefe(gemeldet, "und hat sich gemeldet")
pruefe(z.aufgabe is None, "nach stop() ist die Aufgabe abgeräumt")
pruefe(z.verbunden is False, "und nichts gilt als verbunden")

# Die Meldung darf nur einmal kommen — nachgestellt, weil sich das an der
# Konsole nicht prüfen lässt, ohne sie abzufangen.
z2 = sk.Zuhoerer(broker="127.0.0.1:1")
meldungen = []
z2._melden = lambda f, _z=z2: (meldungen.append(f), setattr(_z, "gemeldet", True))[0] \
    if not _z.gemeldet else None
for i in range(5):
    if not z2.gemeldet:
        z2._melden(Exception("Versuch %d" % i))
gleich(len(meldungen), 1, "fünf Fehlversuche ergeben eine Meldung")

# ── 4. Nachrichten einspeisen — mit Attrappe statt Broker ─────────────────

print("\nWas am Topic ankommt, landet in der Zeitreihe")

roh = [json.dumps(wert(ECHT["sensor_id"], "fremd", zeit="2026-09-21T13:0%d:00Z" % i,
                       w=20.0 + i), ensure_ascii=False).encode("utf-8")
       for i in range(5)]
gelesen = [sk.Zuhoerer._lesen_wert(r) for r in roh]
pruefe(all(g is not None for g in gelesen), "fünf Nachrichten gelesen")
gleich(zr.aufnehmen(gelesen), 5, "und abgelegt")

kaputt = sk.Zuhoerer._lesen_wert(b"kein JSON {{{")
pruefe(kaputt is None, "eine unlesbare Nachricht ergibt None statt eines Wurfs")
kaputt2 = sk.Zuhoerer._lesen_wert(b"\xff\xfe\x00ung\xfcltig")
pruefe(kaputt2 is None, "auch kaputte Zeichen halten den Strom nicht an")

verlauf = zr.verlauf(ECHT["iri"], von="2026-09-21T13:00:00Z", bis="2026-09-21T13:04:00Z")
gleich(len(verlauf), 5, "alle fünf stehen im Verlauf — unter der Register-IRI")

# ── 5. Die Zahlen ─────────────────────────────────────────────────────────

print("\nDer Zuhörer sagt, was er tut")

z3 = sk.Zuhoerer(broker="")
zahlen = z3.zahlen()
gleich(sorted(zahlen), ["abgelegt", "broker", "empfangen", "topic", "verbunden"],
       "die Auskunft ist vollständig")
gleich(zahlen["broker"], None, "ohne Broker steht dort None, nicht ein leerer Text")
gleich(zahlen["topic"], "ileen.sensor.messwerte", "das Topic ist das vereinbarte")

# ── 6. Kafka bleibt in dieser einen Datei ─────────────────────────────────

print("\nKafka kennt nur diese eine Datei")

def ohne_kommentar(pfad):
    roh = Path(pfad).read_text()
    aus = []
    im_docstring = False
    for zeile in roh.splitlines():
        if zeile.strip().startswith('"""'):
            im_docstring = not im_docstring
            continue
        if im_docstring or zeile.strip().startswith("#"):
            continue
        aus.append(zeile)
    return "\n".join(aus)


for datei in ("ileen/zeitreihe.py", "api/routes/sensoren.py"):
    pruefe("kafka" not in ohne_kommentar(datei).lower(),
           f"{datei} kennt kein Kafka")
pruefe("aiokafka" in Path("ileen/sensor_kafka.py").read_text(),
       "ileen/sensor_kafka.py kennt es")
pruefe("aiokafka==" in Path("requirements.txt").read_text(),
       "requirements.txt führt aiokafka mit fester Version")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
