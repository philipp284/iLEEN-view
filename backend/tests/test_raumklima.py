"""
Prüfstein für die Raumsensorik: Register, Raummodell, Zeitreihe.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Geprüft wird, woran eine Raumanzeige still falsch wird:

  · die Brücke — Anker der Sensoren ist die GlobalId des IfcSpace, und die IRI folgt derselben Regel wie
    bei jedem Bauteil (uuid5 DNS), damit Sensor, Raumkörper und gaeco-Instanz einen Schlüssel teilen
  · das Register — jedes Profil bekommt seine Messgrößen, Sensorkennungen sind eindeutig
  · das Modell — zustandslos (gleiche Zeit, gleicher Wert), Belegung folgt dem Wochentag, CO₂ steigt mit
    Belegung, die vier absichtlichen Störungen gibt es genau je einmal
  · die Zeitreihe — Raumsensoren stehen NICHT im Zonenregister (das Geschoss-Panel bleibt bei 24),
    `am_bauteil` findet sie trotzdem, `raeume_stand` gibt das Alter an, `raeume_matrix` rastert

Ausführen:  python3 tests/test_raumklima.py
"""

import os
import shutil
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

HIER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HIER))
sys.path.insert(0, str(HIER / "scripts"))

ARBEIT = Path(tempfile.mkdtemp(prefix="raumklima-test-"))
(ARBEIT / "register").mkdir()
for datei in ("zonen.csv", "sensoren.csv"):
    shutil.copy(HIER / "data" / datei, ARBEIT / "register" / datei)
os.environ["ILEEN_SENSOR_DB"] = str(ARBEIT / "zeitreihe.db")
os.environ["ILEEN_SENSOR_REGISTER"] = str(ARBEIT / "register")

import raumklima  # noqa: E402
from ileen import zeitreihe  # noqa: E402

fehler = 0


def pruefe(name, ok, zusatz=None):
    global fehler
    print(f"{'✓' if ok else '✗'} {name}" + ("" if ok or zusatz is None else f"  → {zusatz}"))
    if not ok:
        fehler += 1


def raum(guid, name, lang, flaeche=40.0, storey="EG"):
    return {"global_id": guid, "name": name, "long_name": lang, "storey": storey,
            "flaeche_m2": flaeche, "hoehe_m": 3.0, "volumen_m3": flaeche * 3.0}


# ── Register ────────────────────────────────────────────────────────────────
print("── Register ──")
raeume = [raum("L1", "s1", "Seminarraum 40 Personen", 60), raum("L2", "s2", "Seminar/Werkraum 20 Personen", 45),
          raum("B1", "b1", "Professor/in", 18), raum("B2", "b2", "FB-Mitarbeiter", 20), raum("B3", "b3", "Büro", 22),
          raum("T1", "t1", "Technik", 15), raum("T2", "t2", "Schacht 4", 3), raum("V1", "v1", "Flur", 80),
          raum("W1", "w1", "WC H", 8), raum("K1", "k1", "Teeküche", 10), raum("X1", "x1", "", 12),
          raum("Z0", "z0", "Büro", 0.0)]                      # Fläche 0 → kein Sensor
zeilen = raumklima.register_aus_raeumen(raeume)
je = {}
for z in zeilen:
    je.setdefault(z["raum_guid"], set()).add(z["messgroesse"])
pruefe("Profil aus dem Namen: Seminar, Büro, Technik, Flur, WC, Teeküche, leer",
       [raumklima.profil_von(n) for n in ("Seminarraum", "Professor/in", "Technik", "Flur", "WC H", "Teeküche", "", "Hörsaal")]
       == ["lehre", "buero", "technik", "verkehr", "sanitaer", "teekueche", "sonstig", "lehre"])
pruefe("Seminar: Temperatur, CO₂, Feuchte, Präsenz", je["L1"] == {"raumtemperatur", "co2", "luftfeuchte", "praesenz"}, je["L1"])
pruefe("Büro: Temperatur, CO₂, Präsenz (keine Feuchte)", je["B1"] == {"raumtemperatur", "co2", "praesenz"}, je["B1"])
pruefe("Technik und Schacht: nur Temperatur", je["T1"] == {"raumtemperatur"} and je["T2"] == {"raumtemperatur"})
pruefe("Flur: Temperatur und Präsenz, kein CO₂", je["V1"] == {"raumtemperatur", "praesenz"})
pruefe("Raum ohne Fläche bekommt keinen Sensor", "Z0" not in je)
ids = [z["sensor_id"] for z in zeilen]
pruefe("Sensorkennungen eindeutig", len(ids) == len(set(ids)))
doppelt = register_dopp = raumklima.register_aus_raeumen([raum("A", "x", "Büro"), raum("B", "x", "Büro")])
pruefe("zwei Räume gleichen Namens: Kennung wird mit der GlobalId eindeutig",
       len({z["sensor_id"] for z in doppelt}) == len(doppelt))
pfad = raumklima.register_schreiben(zeilen, ARBEIT / "register" / "sensoren_raeume.csv")
pruefe("Register rundläuft", [z["sensor_id"] for z in raumklima.register_lesen(pfad)] == ids)

# ── Modell ──────────────────────────────────────────────────────────────────
print("── Modell ──")


class Wetter:
    def aussentemperatur(self, zeit): return 8.0
    def globalstrahlung(self, zeit): return 0.0


gesehen = raumklima.register_lesen(pfad)
# 40 Räume, damit es genug Kandidaten für die Störungen gibt
viele = []
for i in range(40):
    viele += [raum(f"L{i}", f"s{i}", "Seminarraum", 50), raum(f"B{i}", f"b{i}", "Büro", 18),
              raum(f"T{i}", f"t{i}", "Technik", 15)]
reg = raumklima.register_aus_raeumen(viele)
M = raumklima.RaumModell(7, Wetter(), reg)
M2 = raumklima.RaumModell(7, Wetter(), reg)
frei = {s["raum_guid"]: s for s in reg if s["messgroesse"] == "raumtemperatur"}
sensor = lambda guid, g: next(s for s in reg if s["raum_guid"] == guid and s["messgroesse"] == g)
mittwoch_mittag = datetime(2026, 10, 21, 10, 30, tzinfo=timezone.utc)      # 12:30 Ortszeit, Mittwoch
sonntag_mittag = datetime(2026, 10, 25, 10, 30, tzinfo=timezone.utc)
nacht = datetime(2026, 10, 21, 1, 0, tzinfo=timezone.utc)
st = {a: sum(1 for r in M.raeume.values() if r["stoerung"] == a) for a in ("lueftung", "ueberhitzt", "fenster", "ausreisser")}
pruefe("jede absichtliche Störung genau einmal", all(v == 1 for v in st.values()), st)
pruefe("zustandslos: gleiche Zeit, gleicher Wert, gleich welches Modell",
       M.messung(mittwoch_mittag, sensor("T3", "raumtemperatur"))[0] == M2.messung(mittwoch_mittag, sensor("T3", "raumtemperatur"))[0]
       == M.messung(mittwoch_mittag, sensor("T3", "raumtemperatur"))[0])
lehre = [g for g, r in M.raeume.items() if r["profil"] == "lehre" and not r["stoerung"]]
belegt_mi = sum(M.personen(M.raeume[g], mittwoch_mittag) > 0 for g in lehre)
belegt_so = sum(M.personen(M.raeume[g], sonntag_mittag) > 0 for g in lehre)
pruefe("werktags mittags sind Seminarräume belegt, sonntags keiner", belegt_mi > 0 and belegt_so == 0, (belegt_mi, belegt_so))
# CO₂ in einem belegten Raum liegt über der Außenluft, in einem leeren knapp darüber
g_belegt = max(lehre, key=lambda g: M.personen(M.raeume[g], mittwoch_mittag))
co2_voll = max(M.co2(M.raeume[g_belegt], mittwoch_mittag + timedelta(minutes=5 * k)) for k in range(0, 12))
co2_leer = M.co2(M.raeume[g_belegt], sonntag_mittag)
pruefe("CO₂: Belegung hebt ihn, ein leerer Raum bleibt bei Außenluft", co2_voll > 600 and co2_leer < 480, (co2_voll, co2_leer))
g_stoer = next(g for g, r in M.raeume.items() if r["stoerung"] == "lueftung")
stoer_max = max(M.co2(M.raeume[g_stoer], datetime(2026, 10, 21, h, 0, tzinfo=timezone.utc)) for h in range(7, 16))
pruefe("Lüftungsstörung treibt den CO₂-Wert über 1000", stoer_max > 1000 or M.personen(M.raeume[g_stoer], mittwoch_mittag) == 0, stoer_max)
t_tag = M.temperatur(M.raeume["B3"], mittwoch_mittag)
t_nacht = M.temperatur(M.raeume["B3"], nacht)
pruefe("Nachtabsenkung: nachts kälter als tagsüber", t_nacht < t_tag - 1.5, (t_nacht, t_tag))
g_heiss = next(g for g, r in M.raeume.items() if r["stoerung"] == "ueberhitzt")
pruefe("Technikraum mit Wärmestau: nachmittags deutlich wärmer als ein normaler",
       M.temperatur(M.raeume[g_heiss], datetime(2026, 10, 21, 13, 0, tzinfo=timezone.utc))
       > M.temperatur(M.raeume[next(g for g, r in M.raeume.items() if r["profil"] == "technik" and not r["stoerung"])],
                      datetime(2026, 10, 21, 13, 0, tzinfo=timezone.utc)) + 5)
pruefe("Messwerte liegen im Messbereich (ohne Ausreißer-Sensor)",
       all(s["bereich_min"] <= M.messung(mittwoch_mittag, s)[0] <= s["bereich_max"]
           for s in reg if M.raeume[s["raum_guid"]]["stoerung"] != "ausreisser"))

# ── Die Brücke ──────────────────────────────────────────────────────────────
print("── Brücke (IRI) ──")
pruefe("IRI des Raums = uuid5(DNS, GlobalId), wie bei jedem Bauteil",
       zeitreihe.iri_bauteil("0etRTjWm9PXfiNlKcdI$_R") == str(uuid.uuid5(uuid.NAMESPACE_DNS, "0etRTjWm9PXfiNlKcdI$_R")))

# ── Zeitreihe ───────────────────────────────────────────────────────────────
print("── Zeitreihe ──")
zeitreihe._raum_zwischenspeicher = None
zeitreihe._register_zwischenspeicher = None
zeitreihe.init()
vorher = zeitreihe.register()
pruefe("Zonenregister unberührt: 24 Sensoren", len(vorher) == 24)
rr = zeitreihe.raum_register()
pruefe("Raumregister gelesen", len(rr) == len(zeilen), len(rr))
pruefe("Anker ist der IfcSpace", all(s["anker_typ"] == "IfcSpace" for s in rr))

basis = datetime(2026, 10, 21, 8, 0, tzinfo=timezone.utc)
batch = []
for k in range(0, 24):                                       # zwei Stunden, 5-min-Raster
    t = basis + timedelta(minutes=5 * k)
    for s in rr:
        if s["messgroesse"] in ("raumtemperatur", "co2", "praesenz") and s["anker_guid"] in ("L1", "B1", "V1"):
            batch.append({"sensor": s["sensor_id"], "zeit": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                          "wert": 20.0 + k * 0.1 if s["messgroesse"] == "raumtemperatur" else (800.0 + k if s["messgroesse"] == "co2" else float(k % 2)),
                          "einheit": s["einheit"]})
batch.append({"sensor": "gibt-es-nicht", "zeit": "2026-10-21T08:00:00Z", "wert": 1.0})
pruefe("aufnehmen: Raumsensoren werden angenommen, Unbekanntes abgewiesen",
       zeitreihe.aufnehmen(batch) == len(batch) - 1 and zeitreihe.zahlen()["abgewiesen"] == 1)
pruefe("stand() (Geschossansicht) bleibt bei 24", len(zeitreihe.stand()) == 24)
iri_l1 = zeitreihe.iri_bauteil("L1")
am = zeitreihe.am_bauteil(iri_l1)
pruefe("am_bauteil findet die Raumsensoren (SPIDER-Weg)", {s["messgroesse"] for s in am} >= {"raumtemperatur", "co2"}, [s["messgroesse"] for s in am])

stand = zeitreihe.raeume_stand()
pruefe("raeume_stand: alle Räume mit Sensoren", len(stand["raeume"]) == len({s["anker_guid"] for s in rr}), len(stand["raeume"]))
l1 = next(r for r in stand["raeume"] if r["global_id"] == "L1")
pruefe("jüngster Wert und Zeit", l1["werte"]["raumtemperatur"]["wert"] == round(20.0 + 23 * 0.1, 10) or abs(l1["werte"]["raumtemperatur"]["wert"] - 22.3) < 1e-9,
       l1["werte"]["raumtemperatur"])
pruefe("ein Raum ohne Messung: Status ohne, alt", next(r for r in stand["raeume"] if r["global_id"] == "T1")["werte"]["raumtemperatur"]["status"] == "ohne")
pruefe("Bezugszeit ist die jüngste Messung", stand["zeit"] == "2026-10-21T09:55:00Z", stand["zeit"])
frueher = zeitreihe.raeume_stand("2026-10-21T08:30:00Z")
l1f = next(r for r in frueher["raeume"] if r["global_id"] == "L1")
pruefe("Stand zu einer früheren Zeit", abs(l1f["werte"]["raumtemperatur"]["wert"] - 20.6) < 1e-9, l1f["werte"]["raumtemperatur"])
spaeter = zeitreihe.raeume_stand("2026-10-21T14:00:00Z")
l1s = next(r for r in spaeter["raeume"] if r["global_id"] == "L1")
pruefe("Wert älter als drei Intervalle gilt als alt", l1s["werte"]["raumtemperatur"]["alt"] is True or l1s["werte"]["raumtemperatur"]["wert"] is None)
komp = zeitreihe.raeume_stand(kompakt=True)
pruefe("kompakt: nur GlobalId und Werte", set(komp["raeume"][0]) == {"global_id", "werte"} and "iri" not in str(komp["raeume"][0]))

m = zeitreihe.raeume_matrix("raumtemperatur", schritt_min=30, stunden=3)
pruefe("Matrix: Zeitraster in 30 min", m["zeiten"][1] > m["zeiten"][0] and m["schritt_min"] == 30 and len(m["zeiten"]) == 7, len(m["zeiten"]))
pruefe("Matrix: eine Reihe je Raum mit Sensor", set(m["raeume"]) == {"L1", "B1", "V1"}, set(m["raeume"]))
pruefe("Matrix: Länge je Reihe = Zeitraster", all(len(r) == len(m["zeiten"]) for r in m["raeume"].values()))
pp = zeitreihe.raeume_matrix("praesenz", schritt_min=30, stunden=3)
pruefe("Präsenz: je Schritt der größte Wert (kurze Anwesenheit geht nicht verloren)", max(v for v in pp["raeume"]["L1"] if v is not None) == 1.0)
pruefe("unbekannte Messgröße: leer, kein Fehler", zeitreihe.raeume_matrix("gibtsnicht")["raeume"] == {})

shutil.rmtree(ARBEIT, ignore_errors=True)
print(f"\n{fehler} Prüfung(en) fehlgeschlagen" if fehler else "\nAlle Prüfungen bestanden.")
sys.exit(1 if fehler else 0)
