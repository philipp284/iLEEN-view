"""
Prüfstein für den Rundgang-Kern (panorama_tour.py) — ohne Server, ohne MinIO.

Geprüft wird das, was zwischen den Fotos und der tour.json liegt und leicht
still falsch wird: die Verortungs-Rangfolge (Manifest vor EXIF vor Reihe), die
Umrechnung der Blickrichtung von Grad in Radiant, die Meter-auf-Grad-Rechnung
der automatischen Reihe, die Verkettung der Nachbarn, die Namensbereinigung
gegen Pfadausbruch und die EXIF/GPano-Auslese.

    python3 tests/test_tour.py
"""

import io
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402

import panorama_tour as kern  # noqa: E402

geprueft = 0
fehler = 0


def ok(bed, name):
    global geprueft, fehler
    geprueft += 1
    if not bed:
        fehler += 1
        print("  ✗", name)


def nahe(a, b, eps, name):
    ok(a is not None and abs(a - b) <= eps, f"{name} ({a} ≈ {b})")


def jpg(farbe=(120, 130, 140), groesse=(64, 32), exif=None):
    im = Image.new("RGB", groesse, farbe)
    buf = io.BytesIO()
    if exif is not None:
        im.save(buf, "jpeg", exif=exif)
    else:
        im.save(buf, "jpeg")
    return buf.getvalue()


# ── 1. Automatische Reihe entlang einer Linie ────────────────────────────────
def t_auto():
    dateien = [("s3.jpg", jpg()), ("s1.jpg", jpg()), ("s2.jpg", jpg())]
    anchor = {"lon": 8.0, "lat": 50.0, "hoehe": 145.0, "spacing": 5.0, "richtung": 90.0}
    tour, bilder = kern.tour_zusammenstellen("Reihe", dateien, anchor=anchor)

    ok(tour["version"] == 1, "version 1")
    ok(len(tour["spots"]) == 3, "drei Spots")
    ids = [s["id"] for s in tour["spots"]]
    ok(ids == ["s1", "s2", "s3"], "nach Dateinamen sortiert (s1,s2,s3)")

    s1, s2, s3 = tour["spots"]
    nahe(s1["lon"], 8.0, 1e-9, "erster Spot liegt auf dem Anker (lon)")
    nahe(s1["lat"], 50.0, 1e-9, "erster Spot liegt auf dem Anker (lat)")
    # 5 m nach Osten je Schritt
    dlon = 5.0 / (111320.0 * math.cos(math.radians(50.0)))
    nahe(s2["lon"] - s1["lon"], dlon, 1e-9, "5 m Ostschritt in Längengrad")
    nahe(s2["lat"] - s1["lat"], 0.0, 1e-9, "Ostrichtung ändert die Breite nicht")
    nahe(s3["lon"] - s1["lon"], 2 * dlon, 1e-9, "dritter Spot bei 10 m")
    nahe(s1["heading"], math.radians(90.0), 1e-9, "heading = Reihenrichtung, in Radiant")

    ok(s1["panorama"] == "pano/s1.jpg", "Panorama-URL relativ (pano/…)")
    ok(s1.get("nachbarn") == ["s2"], "erster Spot: nur der nächste als Nachbar")
    ok(sorted(s2.get("nachbarn", [])) == ["s1", "s3"], "mittlerer Spot: beide Nachbarn")
    ok(s3.get("nachbarn") == ["s2"], "letzter Spot: nur der vorige")
    ok(all("quelle" not in s for s in tour["spots"]), "interne Bau-Notiz nicht in der Datei")
    panos = [o for o in bilder if o[0].startswith("pano/")]
    vorsch = [o for o in bilder if o[0].startswith("vorschau/")]
    ok(len(panos) == 3 and panos[0][2] == "image/jpeg", "drei Panoramen mit content_type")
    ok(len(vorsch) == 3 and s1.get("vorschau") == "vorschau/s1.jpg", "je Bild eine Vorschau, am Spot vermerkt")
    ok(s1.get("lage") == "auto" and s1.get("ausrichtung") == "keine", "Reihe: lage auto, nicht ausgerichtet")


# ── 2. Manifest hat Vorrang, Grad → Radiant ─────────────────────────────────
def t_manifest():
    dateien = [("a.jpg", jpg()), ("b.jpg", jpg())]
    manifest = {"spots": {
        "a.jpg": {"lon": 8.1, "lat": 49.9, "hoehe": 100, "heading": 180,
                  "name": "Eingang", "nachbarn": ["b"]},
        "b.jpg": {"lon": 8.2, "lat": 49.95, "heading": 0},
    }}
    # Anker zusätzlich gegeben — Manifest muss trotzdem gewinnen.
    tour, _ = kern.tour_zusammenstellen("M", dateien, manifest=manifest,
                                        anchor={"lon": 1, "lat": 1})
    a = next(s for s in tour["spots"] if s["id"] == "a")
    nahe(a["lon"], 8.1, 1e-9, "Manifest-Koordinate genutzt (nicht der Anker)")
    nahe(a["heading"], math.pi, 1e-9, "heading 180° → π")
    ok(a["name"] == "Eingang", "Name aus dem Manifest")
    ok(a.get("nachbarn") == ["b"], "Nachbarn aus dem Manifest übernommen")
    b = next(s for s in tour["spots"] if s["id"] == "b")
    nahe(b["hoehe"], 0.0, 1e-9, "fehlende Höhe → 0")


# ── 3. Ohne jede Lage → Fehler, der die Dateien nennt ────────────────────────
def t_ohne_lage():
    try:
        kern.tour_zusammenstellen("X", [("a.jpg", jpg())])  # kein Manifest, kein Anker, kein EXIF
        ok(False, "fehlende Lage muss einen Fehler werfen")
    except ValueError as e:
        ok("a.jpg" in str(e), "Fehlermeldung nennt die betroffene Datei")


# ── 4. Namensbereinigung gegen Pfadausbruch ──────────────────────────────────
def t_name():
    ok(kern.sicherer_name("../../etc/passwd.jpg", 0) == "passwd.jpg", "Pfadanteil entfernt")
    ok(kern.sicherer_name("Foto Nr 1!.JPG", 0) == "Foto_Nr_1.jpg", "Sonderzeichen → _, Endung klein")
    ok(kern.sicherer_name("bild.tiff", 2) == "bild.jpg", "unbekannte Endung → .jpg")
    ok(kern.sicherer_name("...", 4) == "bild5.jpg", "leerer Stamm → laufender Name")


# ── 5. DMS und GPano-Blickrichtung ───────────────────────────────────────────
def t_parser():
    nahe(kern._dms((49, 59, 44.4), "N"), 49 + 59 / 60 + 44.4 / 3600, 1e-9, "DMS Nord")
    nahe(kern._dms((8, 15, 0), "W"), -(8 + 15 / 60), 1e-9, "DMS West ist negativ")
    ok(kern._dms((1, 2), "N") is None, "unvollständiges DMS → None")
    xmp = b'<x:xmpmeta><rdf:Description GPano:PoseHeadingDegrees="123.5"/></x:xmpmeta>'
    nahe(kern._gpano_heading(xmp), 123.5, 1e-9, "GPano-Blickrichtung aus XMP")
    ok(kern._gpano_heading(b"kein xmp hier") is None, "ohne GPano → None")


# ── 6. EXIF-GPS aus dem Foto (best effort — nur, wenn Pillow es zurückschreibt)
def t_exif():
    exif = Image.Exif()
    exif[0x8825] = {1: "N", 2: (49.0, 59.0, 44.4), 3: "E", 4: (8.0, 15.0, 35.6),
                    5: 0, 6: 145.0, 16: "T", 17: 90.0}
    data = jpg(exif=exif)
    lage = kern.exif_lage(data)
    if lage is None:
        print("  ⓘ EXIF-GPS von Pillow nicht zurückgeschrieben — Ende-zu-Ende übersprungen "
              "(die Parser _dms/_gpano sind separat geprüft)")
        return
    nahe(lage.get("lat"), 49 + 59 / 60 + 44.4 / 3600, 1e-6, "EXIF: Breite")
    nahe(lage.get("lon"), 8 + 15 / 60 + 35.6 / 3600, 1e-6, "EXIF: Länge")
    nahe(lage.get("heading_deg"), 90.0, 1e-6, "EXIF: Blickrichtung")
    # Und über die ganze Kette: EXIF schlägt den Anker, aber nicht das Manifest.
    tour, _ = kern.tour_zusammenstellen("E", [("foto.jpg", data)],
                                        anchor={"lon": 1, "lat": 1})
    s = tour["spots"][0]
    nahe(s["lat"], 49 + 59 / 60 + 44.4 / 3600, 1e-6, "EXIF verortet den Spot (nicht der Anker)")
    nahe(s["heading"], math.radians(90.0), 1e-6, "EXIF-Blickrichtung → Radiant")


# ── 7. Gleichnamige Dateien überschreiben sich nicht ────────────────────────
def t_doppelt():
    dateien = [("ordner1/a.jpg", jpg((10, 10, 10))), ("ordner2/a.jpg", jpg((200, 200, 200)))]
    tour, objekte = kern.tour_zusammenstellen("D", dateien, anchor={"lon": 8, "lat": 50})
    ids = [s["id"] for s in tour["spots"]]
    ok(ids == ["a", "a-2"], f"eindeutige Kennungen ({ids})")
    pfade = sorted(o[0] for o in objekte if o[0].startswith("pano/"))
    ok(pfade == ["pano/a-2.jpg", "pano/a.jpg"], f"zwei Objekte statt eines überschriebenen ({pfade})")
    ok({s["panorama"] for s in tour["spots"]} == {"pano/a.jpg", "pano/a-2.jpg"},
       "jeder Spot zeigt auf sein eigenes Bild")


# ── 8. Import: unverortet aufnehmen, Kompass, Zeit, Reihenfolge ─────────────
def theta_exif(zeit, kompass, ref="M"):
    exif = Image.Exif()
    exif[0x010F] = "RICOH"
    exif[0x0110] = "RICOH THETA V   "
    exif[0x0132] = zeit
    exif[0x8825] = {0: b"\x02\x03\x00\x00", 16: ref, 17: kompass}
    return exif


def t_import():
    # Absichtlich nicht in Zeitfolge übergeben — der Import ordnet nach Aufnahme.
    dateien = [
        ("R0010268.JPG", jpg((40, 40, 40), (200, 100), theta_exif("2021:02:05 08:08:04", 182.12))),
        ("R0010266.JPG", jpg((90, 90, 90), (200, 100), theta_exif("2021:01:31 00:35:16", 249.46))),
    ]
    spots, objekte = kern.bilder_aufnehmen(dateien, vorhandene_ids=["R0010266"], nummer_ab=4)
    ok(len(spots) == 2, "zwei Spots")
    a, b = spots
    ok(all(s["lon"] is None and s["lat"] is None and s["hoehe"] is None for s in spots),
       "Import verortet nie selbst")
    ok(a["aufnahme"]["datei"] == "R0010266.JPG", "nach Aufnahmezeit geordnet (266 vor 268)")
    ok(a["id"] == "R0010266-2", f"vorhandene Kennung wird nicht doppelt vergeben ({a['id']})")
    ok(a["panorama"] == "pano/R0010266-2.jpg", "Objektname folgt der Kennung")
    ok(a["name"] == "Standpunkt 4" and b["name"] == "Standpunkt 5", "Namen zählen ab nummer_ab weiter")
    if a["aufnahme"]["zeit"] is None:
        print("  ⓘ DateTime von Pillow nicht zurückgeschrieben — Zeitprüfung übersprungen")
    else:
        ok(a["aufnahme"]["zeit"] == "2021-01-31T00:35:16", f"Aufnahmezeit ISO ({a['aufnahme']['zeit']})")
    if a["aufnahme"]["kompass_deg"] is None:
        print("  ⓘ GPS-IFD von Pillow nicht zurückgeschrieben — Kompassprüfung übersprungen")
    else:
        nahe(a["aufnahme"]["kompass_deg"], 249.46, 1e-6, "Kompasswert der Bildmitte")
        ok(a["aufnahme"]["kompass_bezug"] == "M", "Bezug magnetisch")
    ok(a["aufnahme"]["kamera"] == "RICOH THETA V", f"Kamera ohne Füllzeichen ({a['aufnahme']['kamera']})")
    ok(a["aufnahme"]["equirect"] is True, "2:1 gilt als equirectangular")
    ok(a["ausrichtung"] == "keine" and a["heading"] is None, "nicht ausgerichtet, keine Blickrichtung")
    vb = [o for o in objekte if o[0] == a["vorschau"]]
    ok(len(vb) == 1, "Vorschau abgelegt")
    if vb:
        im = Image.open(io.BytesIO(vb[0][1]))
        ok(im.size == (640, 320), f"Vorschau 640 × 320 ({im.size})")

    tour, obj = kern.tour_zusammenstellen("Entwurf", dateien, entwurf=True)
    ok(len(tour["spots"]) == 2 and all(s["lon"] is None for s in tour["spots"]),
       "Entwurf: ohne Lage kein Fehler, alles unverortet")
    ok(tour["einstellungen"]["aufnahmehoehe"] == 1.5, "Einstellungen mit Vorgabe")
    z = kern.zaehlen(tour)
    ok(z == {"anzahl": 2, "verortet": 0, "ausgerichtet": 0}, f"Zählung ({z})")
    ok(kern.bilder_aufnehmen([("x.txt", b"nix")]) == ([], []), "Nicht-Bilder fallen heraus")


# ── 9. Missweisung (WMM-2025-Näherung) ───────────────────────────────────────
def t_missweisung():
    for name, lon, lat, soll in (("Köln", 6.96, 50.94, 3.0), ("Mainz", 8.27, 50.0, 3.4),
                                 ("Hamburg", 9.99, 53.55, 4.0), ("Berlin", 13.40, 52.52, 5.1)):
        nahe(kern.missweisung(lon, lat, 2025.0), soll, 0.35, f"Missweisung {name} 2025")
    nahe(kern.missweisung(8.27, 50.0, 2027.0) - kern.missweisung(8.27, 50.0, 2025.0), 0.30, 1e-9,
         "säkulare Änderung 0,15°/Jahr")
    ok(kern.missweisung(-74.0, 40.7, 2025) is None, "außerhalb Mitteleuropas: keine Zahl")
    ok(kern.missweisung(None, None) is None, "ohne Lage: keine Zahl")


# ── 10. GPS-Weg: magnetischer Kompass und Meereshöhe ─────────────────────────
def t_gps_magnetisch():
    exif = Image.Exif()
    exif[0x8825] = {1: "N", 2: (50.0, 0.0, 0.0), 3: "E", 4: (8.0, 0.0, 0.0),
                    5: 0, 6: 100.0, 16: "M", 17: 10.0}
    data = jpg(exif=exif)
    if kern.exif_lage(data) is None:
        print("  ⓘ EXIF-GPS von Pillow nicht zurückgeschrieben — GPS-Weg übersprungen")
        return
    tour, _ = kern.tour_zusammenstellen("G", [("g.jpg", data)], undulation=47.6, jahr=2025.0)
    s = tour["spots"][0]
    d = kern.missweisung(8.0, 50.0, 2025.0)
    nahe(s["heading"], math.radians(10.0 + d), 1e-9, "magnetisch + Missweisung = rechtweisend")
    nahe(s["hoehe"], 147.6, 1e-9, "Meereshöhe + Undulation = Ellipsoidhöhe")
    ok(s["lage"] == "gps" and s["ausrichtung"] == "kompass", "lage gps, ausgerichtet nach Kompass")


# ── 11. Editor: Änderungen übernehmen ───────────────────────────────────────
def t_bearbeiten():
    tour = kern.tour_leer("T")
    tour["spots"], _ = kern.bilder_aufnehmen([("a.jpg", jpg()), ("b.jpg", jpg()), ("c.jpg", jpg())])
    neu, weg = kern.tour_bearbeiten(tour, {
        "name": "  Erdgeschoss  ",
        "einstellungen": {"aufnahmehoehe": 1.6, "nachbarn": "naehe"},
        "spots": [
            {"id": "b", "lon": 8.25, "lat": 49.99, "hoehe": 180.5, "boden": 179.0,
             "heading": 7.0, "ausrichtung": "hand", "lage": "hand", "nachbarn": ["a", "b", "zz", "a"],
             "panorama": "../../fremd.jpg"},
            {"id": "a", "name": "Eingang"},
        ],
    })
    ok(neu["name"] == "Erdgeschoss", "Name getrimmt")
    ok(neu["einstellungen"]["aufnahmehoehe"] == 1.6 and neu["einstellungen"]["nachbarn"] == "naehe",
       "Einstellungen übernommen")
    ok(neu["einstellungen"]["radius"] == 12.0, "nicht genannte Einstellung bleibt")
    ok([s["id"] for s in neu["spots"]] == ["b", "a"], "Reihenfolge der Änderung gilt")
    ok([s["id"] for s in weg] == ["c"], "nicht genannter Spot entfernt")
    b = neu["spots"][0]
    nahe(b["heading"], math.atan2(math.sin(7.0), math.cos(7.0)), 1e-12, "heading in (−π, π]")
    ok(b["nachbarn"] == ["a"], f"Nachbarn bereinigt: kein Selbstbezug, keine Unbekannten, keine Doppelten ({b['nachbarn']})")
    ok(b["panorama"] == "pano/b.jpg", "Panorama lässt sich nicht umbiegen")
    ok(b["boden"] == 179.0 and b["lage"] == "hand", "Boden und Lage übernommen")
    ok(neu["spots"][1]["name"] == "Eingang" and neu["spots"][1]["lon"] is None, "Umbenennen ohne Verorten")
    ok(len(tour["spots"]) == 3 and tour["spots"][1]["lon"] is None, "Eingabe-Tour unverändert")

    for falsch, warum in (
        ({"spots": [{"id": "x"}]}, "unbekannter Spot"),
        ({"spots": [{"id": "a"}, {"id": "a"}]}, "doppelt"),
        ({"spots": [{"id": "a", "lon": 8.0, "lat": 50.0}]}, "halb verortet"),
        ({"spots": [{"id": "a", "lon": 200, "lat": 50, "hoehe": 1}]}, "lon außerhalb"),
        ({"spots": [{"id": "a", "ausrichtung": "irgendwie"}]}, "unbekannte Ausrichtung"),
        ({"name": ""}, "leerer Name"),
        ({"einstellungen": {"aufnahmehoehe": 9}}, "Aufnahmehöhe außerhalb"),
        ({"spots": [{"id": "a", "heading": float("nan")}]}, "heading NaN"),
    ):
        try:
            kern.tour_bearbeiten(tour, falsch)
            ok(False, f"abgewiesen: {warum}")
        except ValueError:
            ok(True, warum)

    # Wieder unverortet: alle drei leeren
    zwei, _ = kern.tour_bearbeiten(neu, {"spots": [{"id": "b", "lon": None, "lat": None, "hoehe": None}, {"id": "a"}]})
    ok(zwei["spots"][0]["lon"] is None and zwei["spots"][0]["lage"] is None, "Verortung zurücknehmen")


def t_objekte_von():
    ok(kern.objekte_von({"panorama": "pano/a.jpg", "vorschau": "vorschau/a.jpg"}) ==
       ["pano/a.jpg", "vorschau/a.jpg"], "beide Objekte")
    ok(kern.objekte_von({"panorama": "../tiles/x.jpg", "vorschau": "pano/../../x"}) == [],
       "nichts außerhalb des Präfixes")


# ── 12. Echtes THETA-Bild (wenn vorhanden): THETA_BILD=/pfad/R0010266.JPG ────
def t_theta_echt():
    import os
    pfad = os.environ.get("THETA_BILD")
    if not pfad or not os.path.exists(pfad):
        return
    data = open(pfad, "rb").read()
    info = kern.bild_info(data)
    ok(info["kamera"] == "RICOH THETA V", f"THETA: Kamera ({info['kamera']})")
    ok(info["equirect"] and info["projektion"] == "equirectangular", "THETA: equirectangular aus GPano")
    ok(info["kompass_bezug"] == "M" and info["kompass_deg"] is not None, "THETA: magnetischer Kompass")
    ok(info["gps"] is None, "THETA: keine Position")
    ok(info["zeit"] and info["zeit"].startswith("20"), f"THETA: Zeit ({info['zeit']})")
    vb = kern.vorschau(data)
    ok(vb is not None and Image.open(io.BytesIO(vb)).size == (640, 320), "THETA: Vorschau 640 × 320")


for t in (t_auto, t_manifest, t_ohne_lage, t_name, t_parser, t_exif, t_doppelt, t_import,
          t_missweisung, t_gps_magnetisch, t_bearbeiten, t_objekte_von, t_theta_echt):
    t()

print(("✗" if fehler else "✓") + f" tour: {geprueft - fehler}/{geprueft} Prüfungen bestanden")
sys.exit(1 if fehler else 0)
