"""
Prüfstein für das Nutzungsprotokoll und die Ansichtsvorlagen (`ileen/nutzung.py`).

Was still schiefgehen kann und hier deshalb geprüft wird: ein schiefes
Ereignis, das ein ganzes Paket verwirft; ein übergroßes Feld, das die Datei
aufbläht; ein fehlgeschlagenes Laden, das in „zuletzt geladen" oben steht;
eine Vorlage ohne Namen; ein versehentliches Löschen, das nicht
zurückzuholen ist; und der Umzug aus der Übergangsablage, der Zeilen doppelt
oder gar nicht mitnimmt.

Ausführen:  python3 tests/test_nutzung.py
"""

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Direkt laden statt über `ileen/__init__`: das zieht JAX herein, und dieser
# Prüfstein soll ohne die Rechenumgebung laufen.
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "nutzung", Path(__file__).resolve().parent.parent / "ileen" / "nutzung.py")
N = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(N)

fehler = 0


def pruefe(name, ok, zusatz=""):
    global fehler
    print(("✓ " if ok else "✗ ") + name + ("" if ok or not zusatz else f"  → {zusatz}"))
    if not ok:
        fehler += 1


T0 = datetime(2026, 10, 19, 9, 0, 0, tzinfo=timezone.utc)

with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp)

    # ── Schreiben ──────────────────────────────────────────────────────────
    n = N.anhaengen({"sitzung": "s1", "fassung": "iLEEN", "ereignisse": [
        {"art": "sitzung_start", "zeit": "2026-10-19T09:00:00Z", "daten": {"breite": 1728}},
        {"art": "modell_geladen", "daten": {"jobId": "bf9da2a7", "name": "Campus.ifc", "typ": "ifc", "ms": 2400}},
        "kein Objekt",
        {"art": "", "daten": {}},
        {"art": "taste", "daten": {"taste": "x", "titel": "Explosion", "an": True}},
        {"art": "taste", "daten": {"taste": "x", "titel": "Explosion", "an": False}},
        {"art": "riesig", "daten": {"text": "a" * 10_000}},
    ]}, jetzt=T0, verzeichnis=d)
    pruefe("schiefe Einträge übergangen, Rest geschrieben", n == 5, str(n))
    datei = d / "nutzung-2026-10.jsonl"
    zeilen = datei.read_text(encoding="utf-8").splitlines()
    pruefe("eine Zeile je Ereignis, Monatsdatei", len(zeilen) == 5, str(len(zeilen)))
    gross = json.loads(zeilen[-1])
    pruefe("übergroße Daten gekürzt", gross["d"].get("_gekuerzt") is True and len(zeilen[-1]) < 2600,
           str(len(zeilen[-1])))
    pruefe("Server- und Browserzeit getrennt", json.loads(zeilen[0])["t"] == "2026-10-19T09:00:00Z"
           and json.loads(zeilen[0])["tc"] == "2026-10-19T09:00:00Z")

    try:
        N.anhaengen({"sitzung": "s", "ereignisse": [{"art": "x"}] * 501}, jetzt=T0, verzeichnis=d)
        pruefe("mehr als 500 Ereignisse abgelehnt", False)
    except ValueError:
        pruefe("mehr als 500 Ereignisse abgelehnt", True)

    # Zweite Sitzung, eine Stunde später: anderes Modell, ein Fehlschlag.
    T1 = T0 + timedelta(hours=1)
    N.anhaengen({"sitzung": "s2", "fassung": "iLEEN", "ereignisse": [
        {"art": "modell_geladen", "daten": {"jobId": "59b0575f", "name": "Scan.las", "typ": "pointcloud", "ms": 900}},
        {"art": "modell_geladen", "daten": {"jobId": "kaputt", "name": "Fehlt.ifc", "ok": False}},
        {"art": "modell_geladen", "daten": {"jobId": "bf9da2a7", "name": "Campus.ifc", "typ": "ifc", "ms": 2600}},
        {"art": "bereich", "daten": {"id": "view"}},
        {"art": "gruppe", "daten": {"key": "explosion"}},
        {"art": "auswahl", "daten": {"ifcType": "IfcSpace"}},
        {"art": "vorlage_gespeichert", "daten": {"id": "v1", "name": "Campus Räume"}},
        {"art": "vorlage_geladen", "daten": {"id": "v1", "name": "Campus Räume"}},
        {"art": "werkzeug", "daten": {"name": "raeume", "an": True}},
    ]}, jetzt=T1, verzeichnis=d)

    # ── Lesen und Auswerten ────────────────────────────────────────────────
    liste = N.lesen(30, jetzt=T1 + timedelta(minutes=5), verzeichnis=d)
    pruefe("alle Ereignisse gelesen, älteste zuerst", len(liste) == 14 and liste[0]["s"] == "s1", str(len(liste)))
    pruefe("Zeitraum begrenzt", len(N.lesen(1, jetzt=T1 + timedelta(days=3), verzeichnis=d)) == 0)

    zl = N.zuletzt_geladen(liste)
    pruefe("zuletzt geladen: neueste zuerst, je Modell einmal",
           [m["jobId"] for m in zl] == ["bf9da2a7", "59b0575f"], json.dumps([m["jobId"] for m in zl]))
    pruefe("fehlgeschlagenes Laden zählt nicht als zuletzt geladen", all(m["jobId"] != "kaputt" for m in zl))
    pruefe("Campus zweimal geladen", zl[0]["anzahl"] == 2, str(zl[0]["anzahl"]))

    a = N.auswerten(liste, 30)
    pruefe("zwei Sitzungen", a["sitzungen"] == 2)
    campus = next(m for m in a["modelle"] if m["jobId"] == "bf9da2a7")
    pruefe("Modell: Anzahl und mittlere Ladezeit", campus["geladen"] == 2 and campus["ladezeit_ms_mittel"] == 2500,
           json.dumps(campus))
    kaputt = next(m for m in a["modelle"] if m["jobId"] == "kaputt")
    pruefe("Fehlschlag gezählt", kaputt["fehlgeschlagen"] == 1 and kaputt["geladen"] == 0)
    x = next(t for t in a["tasten"] if t["taste"] == "X")
    pruefe("Taste X: zweimal, einmal an, einmal aus", x["anzahl"] == 2 and x["an"] == 1 and x["aus"] == 1, json.dumps(x))
    pruefe("Bereich, Gruppe, Auswahl gezählt",
           a["bereiche"][0] == {"schluessel": "view", "anzahl": 1}
           and a["gruppen"][0]["schluessel"] == "explosion"
           and a["auswahl_ifc_typen"][0]["schluessel"] == "IfcSpace")
    v = a["vorlagen"][0]
    pruefe("Vorlage: gespeichert und geladen", v["geladen"] == 1 and v["gespeichert"] == 1 and v["name"] == "Campus Räume",
           json.dumps(v))
    pruefe("Werkzeug mit an/aus", a["werkzeuge"][0]["schluessel"] == "raeume an", json.dumps(a["werkzeuge"]))
    pruefe("je Tag", sum(N.nach_tagen(liste).values()) == 14)

    # ── Vorlagen ──────────────────────────────────────────────────────────
    pruefe("ohne Datei: leere Liste", N.vorlagen_lesen(d)["vorlagen"] == [])
    N.vorlagen_schreiben([{"id": "v1", "name": "Campus Räume", "taste": 1, "szene": {"explosion": {"an": True}}}],
                         verzeichnis=d, jetzt=T1)
    N.vorlagen_schreiben([], verzeichnis=d, jetzt=T1)
    pruefe("vorige Fassung bleibt liegen",
           json.loads((d / "vorlagen.vorher.json").read_text(encoding="utf-8"))["vorlagen"][0]["id"] == "v1")
    for schief, name in (([{"name": "ohne id"}], "ohne id"), ([{"id": "v2", "name": "  "}], "ohne Namen"),
                         ({"id": "v"}, "kein Array")):
        try:
            N.vorlagen_schreiben(schief, verzeichnis=d)
            pruefe(f"Vorlage {name} abgelehnt", False)
        except ValueError:
            pruefe(f"Vorlage {name} abgelehnt", True)

    # ── Umzug aus der Übergangsablage ─────────────────────────────────────
    alt, neu = d / "alt", d / "neu"
    alt.mkdir(); neu.mkdir()
    (alt / "nutzung-2026-10.jsonl").write_text('{"a":1}\n', encoding="utf-8")
    (neu / "nutzung-2026-10.jsonl").write_text('{"b":2}\n', encoding="utf-8")
    (alt / "vorlagen.json").write_text('{"vorlagen": []}', encoding="utf-8")
    N._umziehen(alt, neu)
    pruefe("Umzug hängt Monatsdateien an, statt sie zu überschreiben",
           (neu / "nutzung-2026-10.jsonl").read_text(encoding="utf-8") == '{"b":2}\n{"a":1}\n')
    pruefe("Umzug verschiebt Vorlagen", (neu / "vorlagen.json").exists() and not list(alt.glob("*")))

print(f"\n{fehler} Prüfung(en) fehlgeschlagen" if fehler else "\nAlle Prüfungen bestanden.")
sys.exit(1 if fehler else 0)
