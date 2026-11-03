"""
Prüfstein für die Themenablage: Verlauf, Versionen, BCF hin und zurück.

Drei Eigenschaften entscheiden darüber, ob diese Ablage als Nachweis taugt:

1. **Jede Änderung hinterlässt einen Stand**, und keine Änderung, die keine
   ist. Ein Verlauf, der bei jedem Klick auf „Speichern" wächst, ist so
   wertlos wie einer, der eine echte Änderung verschluckt.
2. **Zurücksetzen löscht nichts.** Der alte Inhalt kommt als neuer Stand
   obendrauf; die Kette bleibt lückenlos.
3. **Ein Paket, das hier herauskommt, kommt hier auch wieder herein** — mit
   derselben GUID, demselben Titel, denselben Kommentaren und denselben
   Bauteilen. Ohne das ist der Austausch mit fremder Software Zufall.

Läuft gegen eine Wegwerf-Datenbank in /tmp, rührt also keinen Betrieb an.

Ausführen:  python3 tests/test_issues.py
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Muss vor dem Import stehen: das Modul liest den Pfad beim Laden.
_tmp = tempfile.mkdtemp(prefix="ileen-issues-")
os.environ["ILEEN_ISSUES_DB"] = str(Path(_tmp) / "issues.db")

from ileen import bcf, issues_db as db  # noqa: E402

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


def gleich(ist, soll, was):
    pruefe(ist == soll, was, ist, soll)


print("Anlegen")
db.init()
t = db.anlegen({
    "titel": "Riss in der Wand",
    "beschreibung": "- **0,4 mm** Rissbreite\n- EG, Achse C",
    "typ": "Issue", "prioritaet": "High",
    "daten": {"position": {"lon": 8.2597, "lat": 49.9928, "height": 177.3},
              "target": {"ifcGuid": "1IAKPqhf2putJ5hEV$ulh", "kind": "ifc"}},
}, autor="Philipp")
guid = t["guid"]
gleich(t["stand"], 1, "der erste Stand ist 1")
gleich(t["status"], "Open", "neu heißt offen")
gleich(len(db.holen(guid)["verlauf"]), 1, "das Anlegen ist selbst ein Stand")

print("\nÄndern schreibt Verlauf")
db.aendern(guid, {"status": "InProgress", "zugewiesen": "Tragwerk"},
           autor="Anna", grund="übernommen")
t = db.holen(guid)
gleich(t["stand"], 2, "der Stand zählt hoch")
gleich(t["status"], "InProgress", "der neue Wert steht")
gleich(len(t["verlauf"]), 2, "zwei Stände")
gleich(sorted(t["verlauf"][0]["aenderung"].keys()), ["status", "zugewiesen"],
       "die Differenz nennt genau die geänderten Felder")
gleich(t["verlauf"][0]["aenderung"]["status"], ["Open", "InProgress"],
       "und zwar mit vorher und nachher")

print("\nEine Änderung, die keine ist, erzeugt keinen Stand")
db.aendern(guid, {"status": "InProgress"}, autor="Anna")
gleich(db.holen(guid)["stand"], 2, "der Stand bleibt stehen")

print("\nZurücksetzen legt obendrauf, statt zu löschen")
db.zuruecksetzen(guid, 1, autor="Philipp")
t = db.holen(guid)
gleich(t["stand"], 3, "ein neuer Stand")
gleich(t["status"], "Open", "mit dem alten Inhalt")
gleich(len(t["verlauf"]), 3, "die Kette bleibt lückenlos")
pruefe("zurückgesetzt auf Stand 1" in (t["verlauf"][0]["grund"] or ""),
       "und sagt, woher der Inhalt kommt", t["verlauf"][0]["grund"])
gleich(db.version(guid, 2)["abbild"]["status"], "InProgress",
       "der überschriebene Stand ist weiterhin lesbar")

print("\nKommentare und Ansichten")
db.kommentieren(guid, "Vor Ort angesehen, Riss läuft weiter.", autor="Anna")
a = db.ansicht_anlegen(guid, {"art": "perspektiv",
                              "position": {"x": 1.0, "y": 2.0, "z": 3.0},
                              "richtung": {"x": 0.0, "y": 1.0, "z": 0.0},
                              "oben": {"x": 0.0, "y": 0.0, "z": 1.0},
                              "sichtfeld": 60.0},
                      [{"ifc_guid": "1IAKPqhf2putJ5hEV$ulh", "modell": "Weihgold"}],
                      b"\x89PNG\r\n\x1a\n-nicht-wirklich-ein-bild", "image/png")
t = db.holen(guid)
gleich(len(t["kommentare"]), 1, "ein Kommentar")
gleich(len(t["ansichten"]), 1, "eine Ansicht")
pruefe(t["ansichten"][0]["hat_bild"], "mit Bild")
pruefe(db.ansicht_bild(guid, a["guid"])[0].startswith(b"\x89PNG"),
       "und das Bild kommt unverändert zurück")

print("\nFiltern")
db.anlegen({"titel": "Zweites Thema", "typ": "Info"}, autor="Philipp")
gleich(len(db.liste(typ="Info")), 1, "nach Typ")
gleich(len(db.liste(ifc_guid="1IAKPqhf2putJ5hEV$ulh")), 1, "nach Bauteil")
gleich(len(db.liste(suche="Riss")), 1, "nach Text")
gleich(len(db.liste()), 2, "ohne Filter alles")

print("\nWeich löschen nimmt aus der Liste, nicht aus der Welt")
zweites = [x for x in db.liste() if x["titel"] == "Zweites Thema"][0]["guid"]
db.loeschen(zweites, autor="Philipp")
gleich(len(db.liste()), 1, "es ist aus der Liste")
gleich(len(db.liste(mit_geloeschten=True)), 2, "aber noch da")
pruefe(db.holen(zweites)["geloescht"], "und als gelöscht gekennzeichnet")

print("\nBCF hinaus")
paket = db.paket_bauen([guid])
pruefe(paket[:2] == b"PK", "es ist ein ZIP", paket[:2])
themen = bcf.paket_lesen(paket)
gleich(len(themen), 1, "ein Thema im Paket")
gelesen = themen[0]
gleich(gelesen["guid"], guid, "mit derselben GUID")
gleich(gelesen["titel"], "Riss in der Wand", "mit demselben Titel")
gleich(len(gelesen["kommentare"]), 1, "der Kommentar ist mit")
gleich(gelesen["ansichten"][0]["komponenten"][0]["ifc_guid"],
       "1IAKPqhf2putJ5hEV$ulh", "das Bauteil steht in der Ansicht")
pruefe(gelesen["ansichten"][0].get("bild", b"").startswith(b"\x89PNG"),
       "und der Schnappschuss liegt daneben")
pruefe("49.9928" in (gelesen["beschreibung"] or ""),
       "der Ort steht in der Beschreibung — sonst ist ein Thema in fremder "
       "Software nur Text")

print("\nBCF herein: derselbe Datenbestand, keine Verdopplung")
vorher = len(db.liste(mit_geloeschten=True))
bericht = db.paket_einlesen(paket, autor="Prüfer")
gleich(bericht["aktualisiert"], 1, "das bekannte Thema wird geändert")
gleich(bericht["neu"], 0, "und nicht ein zweites Mal angelegt")
gleich(len(db.liste(mit_geloeschten=True)), vorher, "die Anzahl bleibt")

print("\nBCF herein: ein fremdes Paket")
fremd = bcf.paket_schreiben([{
    "guid": bcf.neue_guid(), "titel": "Aus Solibri", "typ": "Clash",
    "status": "Open", "prioritaet": "High", "autor": "Solibri",
    "beschreibung": "Lüftung schneidet Unterzug",
    "kommentare": [{"guid": bcf.neue_guid(), "autor": "TGA", "text": "gesehen"}],
    "ansichten": [{"guid": bcf.neue_guid(),
                   "kamera": {"art": "perspektiv",
                              "position": {"x": 10.0, "y": 0.0, "z": 2.0},
                              "richtung": {"x": -1.0, "y": 0.0, "z": 0.0},
                              "oben": {"x": 0.0, "y": 0.0, "z": 1.0},
                              "sichtfeld": 45.0},
                   "komponenten": [{"ifc_guid": "2xYZabc", "ausgewaehlt": True}]}],
}])
bericht = db.paket_einlesen(fremd, autor="Prüfer")
gleich(bericht["neu"], 1, "es kommt als neues Thema herein")
neu = [x for x in db.liste() if x["titel"] == "Aus Solibri"][0]
gleich(neu["typ"], "Clash", "der Typ bleibt erhalten")
gleich(neu["quelle"], "bcf-import", "die Herkunft steht dabei")
voll = db.holen(neu["guid"])
gleich(len(voll["kommentare"]), 1, "der fremde Kommentar ist da")
gleich(voll["ansichten"][0]["kamera"]["position"]["x"], 10.0,
       "und die Kamera steht, wo sie stand")

print("\nEin Paket mit Namensraum (so schreibt es manche Fremdsoftware)")
mit_ns = fremd.replace(b"<Markup>", b'<Markup xmlns="http://example.org/bcf">')
pruefe(len(bcf.paket_lesen(mit_ns)) == 1,
       "wird trotzdem gelesen — sonst käme aus Revit-Exporten nichts an")

print("\nDer Bericht")
from ileen import issues_bericht  # noqa: E402
html = issues_bericht.html_bericht(
    [db.holen(t["guid"], mit_verlauf=True, mit_bild=True) for t in db.liste()], "Prüfbericht")
pruefe("<!doctype html>" in html.lower(), "ist eine vollständige Seite")
pruefe("Riss in der Wand" in html, "enthält die Themen")
pruefe("data:image/png;base64," in html, "mit eingebettetem Bild")
pruefe("<strong>0,4 mm</strong>" in html, "und ausgezeichnetem Text aus der Notiz")

print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
