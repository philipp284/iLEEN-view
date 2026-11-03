"""
Prüfstein für Aufnahmepakete (Gaussian Splat King, `splatpack.v2`), Schwerkraft aus dem iPhone
und die Video-Bildauswahl.

Läuft ohne Server und ohne GPU; COLMAP und ffmpeg werden benutzt, wo sie da sind, sonst wird
der Abschnitt übersprungen. Die Stellen, an denen es still falsch würde:

  1. Das Vorzeichen und die Achsen der Schwerkraft: ein Fehler legt jeden Splat aus Handyfotos
     schief, und nur die Gegenprobe mit allen vier EXIF-Orientierungen fängt ihn.
  2. Eine Kamera je Objektiv: Weitwinkel und Ultraweit in einer COLMAP-Kamera verzerren das Modell.
  3. Das Sichtfeld des Videos kommt als Startbrennweite bei COLMAP an.
  4. Die Bildauswahl aus Videos nimmt das schärfste Bild je Zeitfenster, nicht irgendeines.
  5. Die Begleitdateien (JSON/CSV) überleben ZIP, Ordner-Upload und Hotfolder.
  6. GPS-Rauschen darf keine Zufallspaare für den Abgleich erzeugen.

Ausführen:  python3 tests/test_splatpack.py
"""

import json
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_wurzel = Path(tempfile.mkdtemp(prefix="splatpack_test_"))
os.environ["ILEEN_TRAINING_DIR"] = str(_wurzel / "training")

from splatwerk import auftrag as A  # noqa: E402
from splatwerk import georef, iphone, splatpack, worker  # noqa: E402

_gut = True


def pruefe(bedingung: bool, text: str):
    global _gut
    print(f"  {'ok  ' if bedingung else 'FEHL'}  {text}")
    _gut = _gut and bool(bedingung)


def makernote(beschleunigung, ende=">") -> bytes:
    """Binäres Apple-MakerNote mit genau einem Eintrag: Tag 8, drei vorzeichenbehaftete Brüche."""
    kopf = b"Apple iOS\x00" + b"\x00\x01" + (b"MM" if ende == ">" else b"II")
    daten_offset = len(kopf) + 2 + 12 + 4
    eintrag = struct.pack(ende + "HHII", 8, 10, 3, daten_offset)
    brueche = b"".join(struct.pack(ende + "ii", int(round(v * 1_000_000)), 1_000_000) for v in beschleunigung)
    return kopf + struct.pack(ende + "H", 1) + eintrag + struct.pack(ende + "I", 0) + brueche


# ── 1. Schwerkraft aus dem iPhone ─────────────────────────────────────────────
print("1. Schwerkraft aus dem iPhone")
for ende in (">", "<"):
    v = iphone.aus_makernote(makernote((-0.0447, -0.8825, -0.4897), ende))
    pruefe(v is not None and np.allclose(v, (-0.0447, -0.8825, -0.4897), atol=1e-5), f"MakerNote ({'Big' if ende == '>' else 'Little'}-Endian) gelesen")
pruefe(iphone.aus_makernote(b"") is None and iphone.aus_makernote(b"Apple iOS\x00garbage") is None
       and iphone.aus_makernote(b"Nikon\x00" + b"x" * 40) is None, "kein Apple-MakerNote / Müll → None, kein Absturz")
pruefe(iphone.aus_makernote(makernote((0.0, 0.0, 0.0))[:-30]) is None, "abgeschnittenes MakerNote → None")

# Das Telefon blickt waagerecht und wird in den vier Haltungen gehalten: in jeder muss „oben“ im
# aufrechten Bild genau −y sein (Bild-y zeigt nach unten), ohne Blickkomponente.
haltungen = {6: (0, -1, 0), 1: (-1, 0, 0), 3: (1, 0, 0), 8: (0, 1, 0)}   # Orientierung → Schwerkraft im Gerät
for o, g in haltungen.items():
    h = iphone.hoch_im_bild(np.array(g, float), o)
    pruefe(h is not None and np.allclose(h, (0, -1, 0), atol=1e-9), f"Orientierung {o}: „oben“ ist Bild-oben")
# Blick nach unten: Rückseite zeigt zum Boden (Schwerkraft hat −z im Gerät), „oben“ liegt hinter der Kamera
h = iphone.hoch_im_bild(np.array([0.0, -0.8825, -0.4897]), 6)
pruefe(h[2] < -0.45 and h[1] < -0.85, "Kamera blickt 29° nach unten: oben·Blick < 0")
pruefe(iphone.hoch_im_bild(np.array([0, -1.0, 0]), 6, rueckkamera=False) is None, "Frontkamera: keine Aussage")
pruefe(iphone.hoch_im_bild(np.array([0, -1.0, 0]), 2) is None, "gespiegelte Orientierung: keine Aussage")
pruefe(iphone.hoch_im_bild(np.array([0, -3.0, 0]), 6) is None and iphone.hoch_im_bild(np.array([0, 0.0, 0.1]), 6) is None,
       "ein Vektor, der keine Schwerkraft sein kann (3 g, 0,1 g): verworfen")
pruefe(iphone.aus_begleitdatei({"{MakerApple}": {"8": [-0.04, -0.88, -0.49]}}) is not None
       and iphone.aus_begleitdatei({"{MakerApple}": {}}) is None and iphone.aus_begleitdatei({}) is None, "Begleitdatei: Schlüssel „8“")

# ── 2. Hochachse aus Schwerkraft, Ausrichtung ─────────────────────────────────
print("2. Hochachse aus Schwerkraft")
rng = np.random.default_rng(5)


def zufallsdrehung():
    q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    return q if np.linalg.det(q) > 0 else -q


def rundgang(n=24, radius=2.0, hoehe=1.0):
    """Kameras auf einem Kreis um die Z-Achse, aufrecht, blickend zur Mitte — die wahre Welt, Z oben."""
    z, r_, o_ = [], [], []
    for k in range(n):
        w = 2 * np.pi * k / n
        c = np.array([radius * np.cos(w), radius * np.sin(w), hoehe])
        f = -c / np.linalg.norm(c)
        rechts = np.cross(f, [0, 0, 1.0])
        rechts /= np.linalg.norm(rechts)
        z.append(c), r_.append(rechts), o_.append(np.cross(rechts, f))
    return np.array(z), np.array(r_), np.array(o_)


Z, R, O = rundgang()
Q = zufallsdrehung()
hoch_welt = (Q @ np.array([0, 0, 1.0]))
rausch = np.array([Q @ np.array([0, 0, 1.0]) + rng.normal(0, 0.03, 3) for _ in Z])
h, g = georef.hochachse_aus_schwerkraft(rausch)
pruefe(h is not None and np.degrees(np.arccos(h @ hoch_welt)) < 1.5, f"Schwerkraft ±2° → Hochachse auf {np.degrees(np.arccos(h @ hoch_welt)):.2f}° genau")
rausch2 = rausch.copy()
rausch2[::2] = np.nan
h2, g2 = georef.hochachse_aus_schwerkraft(rausch2)
pruefe(h2 is not None and g2["n"] == 12, "Bilder ohne Messung (NaN) werden übergangen")
h3, g3 = georef.hochachse_aus_schwerkraft(rng.normal(size=(24, 3)))
pruefe(h3 is None and "grund" in g3, "widersprüchliche Messungen → keine Hochachse, mit Grund")
h4, g4 = georef.hochachse_aus_schwerkraft(rausch[:2])
pruefe(h4 is None, "zwei Messungen reichen nicht")

erg = georef.ausrichtung(Z @ Q.T, R @ Q.T, O @ Q.T, [None] * len(Z), schwerkraft=rausch)
m = np.array(erg["matrix"])
pruefe(erg["modus"] == "schwerkraft" and erg["hochachse_quelle"] == "geraet", "ohne GPS, mit Schwerkraft: Modus schwerkraft, Quelle Gerät")
pruefe(np.allclose((m[:3, :3] @ hoch_welt) / np.linalg.norm(m[:3, :3] @ hoch_welt), [0, 0, 1], atol=0.03), "die gemessene Hochrichtung wird +Z")
pruefe(erg.get("abweichung_schwerkraft_kameras_deg", 99) < 3.0, "Kameralage und Messung stimmen überein (Gegenprobe)")
# Messung dreht um 40° daneben: die Kameralage widerspricht — der Hinweis muss kommen, gemessen wird gewonnen
falsch = rausch @ np.array([[1, 0, 0], [0, np.cos(0.7), -np.sin(0.7)], [0, np.sin(0.7), np.cos(0.7)]]).T
erg2 = georef.ausrichtung(Z @ Q.T, R @ Q.T, O @ Q.T, [None] * len(Z), schwerkraft=falsch)
pruefe(erg2.get("abweichung_schwerkraft_kameras_deg", 0) > 10 and any("weichen" in x for x in erg2["hinweise"]),
       "Widerspruch zwischen Messung und Kameras wird gemeldet")
erg3 = georef.ausrichtung(Z @ Q.T, R @ Q.T, O @ Q.T, [None] * len(Z))
pruefe(erg3["hochachse_quelle"] == "kameras", "ohne Messung bleibt es bei den Kameras (Rückfall)")

# Ohne jeden Maßstab (kein GPS-Signal): die Vorgabe wird angewandt und als Schätzung gemeldet
erg4 = georef.ausrichtung(Z @ Q.T, R @ Q.T, O @ Q.T, [None] * len(Z), schwerkraft=rausch, massstab_vorgabe=0.25)
m4 = np.array(erg4["matrix"])
pruefe(abs(np.cbrt(np.linalg.det(m4[:3, :3])) - 0.25) < 1e-9 and erg4["massstab_geschaetzt"] and not erg4["massstab_bekannt"]
       and any("geschätzt" in x for x in erg4["hinweise"]), "geschätzter Maßstab: angewandt, als Schätzung gemeldet, nicht als bekannt")
pruefe(np.allclose(m4[:3, :3] @ (Z @ Q.T).mean(0) + m4[:3, 3], 0, atol=1e-9), "die Mitte der Kameras liegt im Ursprung, auch mit Maßstab")
pruefe(not erg["massstab_geschaetzt"] and abs(np.cbrt(np.linalg.det(m[:3, :3])) - 1.0) < 1e-9, "Vorgabe 1: keine Schätzung gemeldet")
pruefe(georef.ausrichtung(Z @ Q.T, R @ Q.T, O @ Q.T, [None] * len(Z), massstab_vorgabe=float("nan"))["massstab"] == 1.0, "unsinnige Vorgabe (NaN) → 1")

# ── 2b. COLMAP-Textmodell: Punkte, Abstand ───────────────────────────────────
print("2b. COLMAP-Textmodell")
from splatwerk import colmap_modell as CM
tm = _wurzel / "txtmodell"
tm.mkdir()
(tm / "images.txt").write_text("# Kopf\n" + "".join(
    f"{i} 1 0 0 0 {-2.0 * i} 0 0 1 b{i}.jpg\n0 0 -1\n" for i in (1, 2, 3)))        # Kameras bei x = 2, 4, 6 (C = −Rᵀt)
spur = " ".join(f"{i} 0" for i in (1, 2, 3))
(tm / "points3D.txt").write_text("# Kopf\n" + "".join(
    f"{k} 2.0 0.0 {5.0 + 0.01 * k} 10 10 10 0.5 {spur}\n" for k in range(60))
    + "99 0 0 -50 1 1 1 0.5 1 0\n"                  # Spur der Länge 1 → aussortiert
    + "98 0 0 -60 1 1 1 9.0 " + spur + "\n")         # Fehler 9 px → aussortiert
pk = CM.lese_punkte_txt(tm / "points3D.txt")
pruefe(len(pk) == 60 and all(len(p["bilder"]) == 3 for p in pk), "nur Punkte mit Spur ≥ 3 und Fehler < 2 px")
ab = CM.typischer_abstand(tm)
pruefe(ab is not None and 5.3 < ab < 5.8,
       f"typischer Abstand = Median der Sicht-Entfernungen ({ab:.2f}; Kameras bei x = 2/4/6, Punkte bei (2, 0, 5): 5,0 · 5,4 · 6,4)")
(tm / "points3D.txt").write_text("# leer\n")
pruefe(CM.typischer_abstand(tm) is None, "zu wenige Punkte → keine Aussage")

from splatwerk import uebernahme  # noqa: E402
pruefe(uebernahme.unterkante_fuer(np.array([0, 0, -9.0]), 20.0, {"boden_z_enu": -11.0}) == 2.0, "robuste Unterkante ersetzt die der Hüllbox")
pruefe(uebernahme.unterkante_fuer(np.array([0, 0, -9.0]), 20.0, {}) == 20.0, "ohne Angabe bleibt die Hüllbox")
pruefe(uebernahme.unterkante_fuer(np.array([0, 0, -9.0]), 20.0, {"boden_z_enu": -8.0}) == -1.0,
       "Hüllbox-Mitte unter dem Boden (Ausreißer): negative Höhe, der Splat steht trotzdem auf dem Boden")
pruefe(uebernahme.unterkante_fuer(np.array([0, 0, -9.0]), 20.0, {"boden_z_enu": float("nan")}) == 20.0, "unsinniger Boden (NaN) → Hüllbox")

# ── 3. Aufnahmepaket lesen ────────────────────────────────────────────────────
print("3. Aufnahmepaket lesen")
foto = _wurzel / "roh" / "PhotoSeries_T"
foto.mkdir(parents=True)
APPLE0 = 813_333_780.0
paare = []
for k in range(14):
    kennung = f"20261010_1603{k:02d}_000"
    paare.append({"captureId": kennung, "timestamp": APPLE0 + k, "location": {}, "quality": {}, "streams": []})
    for strom, f35 in (("wide", 25), ("ultra", 14)):
        stem = f"{strom}_{kennung}"
        from PIL import Image
        bild = Image.fromarray(rng.integers(0, 255, (300, 200, 3), dtype=np.uint8))   # Hochformat 200×300
        exif = Image.Exif()
        exif[0x0112] = 6
        exif[0x010F] = "Apple"
        exif[0x0110] = "iPhone 17 Pro"
        bild.save(foto / f"{stem}.jpg", exif=exif)
        schlecht = k in (3, 9) and strom == "ultra"
        (foto / f"{stem}.json").write_text(json.dumps({
            "extraMetadata": {"stream": strom, "qualityScore": 0.7, "qualityBand": "ok",
                              "location": {"latitude": 49.7357 + 1e-6 * k, "longitude": 8.0658, "altitudeMeters": 200.0,
                                           "horizontalAccuracyMeters": 7.5}},
            "imageAnalysis": {"blurBand": "poor" if schlecht else "good"},
            "metadata": {"Orientation": 6, "{Exif}": {"LensModel": "iPhone 17 Pro back camera", "FocalLenIn35mmFilm": f35},
                         "{MakerApple}": {"8": [-0.0447, -0.8825, -0.4897]}}}))
(foto / "splatpack.json").write_text(json.dumps({
    "schema": "splatpack.v2", "schemaName": "splatpack", "captureType": "photo_dual", "pairCount": len(paare), "pairs": paare,
    "app": {"bundleIdentifier": "com.radiancefields.gaussiansplatking.app", "shortVersion": "1.4.1"}}))
pakete = splatpack.finde_pakete(_wurzel / "roh")
pruefe(len(pakete) == 1 and pakete[0].typ == "photo_dual" and "Gaussian Splat King 1.4.1" in pakete[0].beschreibung, "Foto-Serie erkannt")
ix = splatpack.Index(pakete)
b = ix.bild(foto / "wide_20261010_160300_000.jpg")
pruefe(b["strom"] == "wide" and abs(b["zeit_unix"] - (APPLE0 + 978307200.0)) < 1e-6, "Strom und Zeit (Apple-Zeit → Unix)")
pruefe(b["gps"]["genauigkeit_m"] == 7.5 and b["gps"]["hoehe"] == 200.0 and not b["unscharf"], "Ort samt Genauigkeit, nicht unscharf")
pruefe(ix.bild(foto / "ultra_20261010_160303_000.jpg")["unscharf"], "„poor“ der App → unscharf")
pruefe(ix.bild(_wurzel / "irgendwo.jpg") is None, "Bild ohne Paket: None")
(foto / "splatpack.json").write_text(json.dumps({"schema": "splatpack.v2", "captureType": "etwas_neues"}))
pruefe(splatpack.finde_pakete(_wurzel / "roh") == [], "unbekannter Pakettyp wird nicht geraten")
(foto / "splatpack.json").write_text("{kaputt")
pruefe(splatpack.finde_pakete(_wurzel / "roh") == [], "kaputte JSON → kein Paket, kein Absturz")
(foto / "splatpack.json").write_text(json.dumps({
    "schema": "splatpack.v2", "schemaName": "splatpack", "captureType": "photo_dual", "pairs": paare,
    "app": {"bundleIdentifier": "com.radiancefields.gaussiansplatking.app", "shortVersion": "1.4.1"}}))

# Video-Paket
video = _wurzel / "roh" / "Video_T"
video.mkdir()
spur = [{"timestampUnix": 1000.0 + s, "latitude": 50.0 + 1e-5 * s, "longitude": 8.0, "altitudeMeters": 100.0 + s,
         "horizontalAccuracyMeters": 5.0 + s} for s in range(0, 11, 2)]
(video / "splatpack.json").write_text(json.dumps({
    "schema": "splatpack.v2", "schemaName": "splatpack", "captureType": "video_dual", "metadataFile": "metadata.json",
    "locationTrack": {"samples": spur}, "app": {"bundleIdentifier": "x.y", "shortVersion": "9"},
    "streams": [{"camera": "wide", "rawVideoFile": "wide.mov", "acceptedFrameCount": 90},
                {"camera": "ultra", "rawVideoFile": "ultra.mov", "acceptedFrameCount": 90}]}))
(video / "metadata.json").write_text(json.dumps({"wide": {"activeFormat": {"fieldOfView": 74.6}},
                                                  "ultra": {"activeFormat": {"fieldOfView": 106.2}}}))
(video / "frame_timecodes.csv").write_text("stream,frame_index,pts_seconds,relative_seconds,relative_ms,unix_seconds,tc,tms\n"
                                          + "".join(f"{s},{i},0,0,0,{1000.0 + i / 30},x,y\n" for s in ("wide", "ultra") for i in range(90)))
(video / "wide.mov").write_bytes(b"x")
(video / "ultra.mov").write_bytes(b"x")
ix = splatpack.Index(splatpack.finde_pakete(video))
vw, vu = ix.video(video / "wide.mov"), ix.video(video / "ultra.mov")
pruefe(vw and vu and vw.fov_grad == 74.6 and vu.fov_grad == 106.2 and len(vw.zeiten) == 90, "Video: Sichtfeld je Kamera, Zeit je Bild")
o = vw.ort_bei(1001.0)
pruefe(abs(o["lat"] - 50.00001) < 1e-9 and abs(o["hoehe"] - 101.0) < 1e-9 and o["genauigkeit_m"] == 7.0, "Position zwischen zwei Messungen: linear, schlechtere Genauigkeit")
pruefe(vw.ort_bei(1000.0 - 5) is not None and vw.ort_bei(1000.0 - 30) is None and vw.ort_bei(1010.0 + 30) is None,
       "vor/nach der Spur: nur kurz davor/danach noch die nächste Messung")
f = splatpack.brennweite_aus_sichtfeld(90.0, 1000.0)
pruefe(abs(f - 500.0) < 1e-9, "Sichtfeld 90° über 1000 px → Brennweite 500 px")

# ── 4. Bildauswahl aus Videos ─────────────────────────────────────────────────
print("4. Bildauswahl aus Videos")
if worker.FFMPEG and worker.FFPROBE:
    mp4 = _wurzel / "test.mp4"
    r = subprocess.run([worker.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=3",
                        "-vf", "boxblur=6:enable='mod(n,3)'", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", str(mp4)],
                       capture_output=True, text=True)
    pruefe(r.returncode == 0, "Testvideo (90 Bilder, jedes dritte scharf) erzeugt " + r.stderr[:100])
    job = A.neu("Videotest")["id"]
    idx, n = worker._video_auswahl(job, mp4, 30, 90, lambda b: None)
    pruefe(n == 90 and len(idx) == 30 and idx == sorted(idx), f"30 aus 90 Bildern gewählt, aufsteigend ({n} gezählt)")
    pruefe(all(i % 3 == 0 for i in idx), "in jedem Zeitfenster das scharfe Bild")
    idx2, _ = worker._video_auswahl(job, mp4, 500, 90, lambda b: None)
    pruefe(len(idx2) == 90, "mehr gewünscht als vorhanden: alle")

    quellen = worker._video_bilder(job, mp4, _wurzel / "frames", 60, 200, lambda b: None, None)
    pruefe(len(quellen) == 15, f"höchstens {worker.MAX_VIDEOBILDER_JE_SEKUNDE:g} Bilder je Sekunde (3 s → 15), bekommen {len(quellen)}")
    pruefe(all(q["pfad"].exists() and q["kamera"] == "video:test" for q in quellen), "Dateien da, eine Kamera je Video")
    mit = _wurzel / "frames2"
    info = splatpack.VideoInfo("wide", mp4, 74.6, np.array([1000.0 + i / 30 for i in range(90)]), [
        {"t": 1000.0, "ort": {"lat": 50.0, "lon": 8.0, "hoehe": 100.0, "genauigkeit_m": 9.0, "richtung": None}},
        {"t": 1003.0, "ort": {"lat": 50.0003, "lon": 8.0, "hoehe": 103.0, "genauigkeit_m": 9.0, "richtung": None}}], 90)
    quellen2 = worker._video_bilder(job, mp4, mit, 60, 200, lambda b: None, info)
    ts = [q["zeit_unix"] for q in quellen2]
    pruefe(ts == sorted(ts) and all(q["gps"] for q in quellen2) and quellen2[0]["kamera"] == "video:wide"
           and quellen2[0]["fov"] == 74.6, "mit Paket: Zeit und Ort je Bild, Kamera = Strom, Sichtfeld mitgegeben")
    pruefe(quellen2[-1]["gps"]["lat"] > quellen2[0]["gps"]["lat"], "die Position wandert mit der Zeit")
    # 120 Bilder: so viele, dass ein links-verschachtelter select-Ausdruck an ffmpegs Parser scheitert
    lang = _wurzel / "lang.mp4"
    subprocess.run([worker.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=24",
                    "-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p", str(lang)], check=True)
    ql = worker._video_bilder(job, lang, _wurzel / "frames_lang", 120, 160, lambda b: None, None)
    pruefe(len(ql) == 120 and all(q["pfad"].exists() for q in ql), f"120 Bilder aus 720 herausgezogen ({len(ql)})")
    def tiefe(a):
        d = m = 0
        for c in a:
            d += c == "("
            d -= c == ")"
            m = max(m, d)
        return m
    pruefe(worker._bildnummern_ausdruck([4]) == "eq(n,4)" and tiefe(worker._bildnummern_ausdruck(list(range(600)))) <= 14,
           "Ausdruck ist ein ausgeglichener Baum (600 Bilder: Tiefe ≤ 14, ffmpeg erlaubt ~100), keine Kette")
    from PIL import Image as _I
    with _I.open(quellen[0]["pfad"]) as im:
        pruefe(max(im.size) <= 200, f"ffmpeg skaliert auf die gewünschte Größe ({im.size})")
else:
    print("  ----  ffmpeg nicht gefunden — übersprungen")

# ── 5. Bildpaare ──────────────────────────────────────────────────────────────
print("5. Bildpaare")
# Zwei Objektive, abwechselnd; GPS nur Rauschen (±20 m, Ausdehnung 8 m)
meta = []
for i in range(40):
    k = "wide" if i % 2 == 0 else "ultra"
    meta.append({"datei": f"{i:05d}.jpg", "kamera": k,
                 "gps": {"lat": 50.0 + rng.normal(0, 2e-5), "lon": 8.0 + rng.normal(0, 2e-5), "hoehe": None, "genauigkeit_m": 20.0}})
ps = set(worker._paare(meta, nachbarn_reihe=3, nachbarn_gps=5))
pruefe(("00000.jpg", "00002.jpg") in ps and ("00000.jpg", "00006.jpg") in ps and ("00000.jpg", "00008.jpg") not in ps,
       "Nachbarn je Kamera: drei in der eigenen Reihe")
pruefe(("00000.jpg", "00001.jpg") in ps and ("00001.jpg", "00002.jpg") in ps, "dieselbe Auslösung in der anderen Kamera ist ein Paar")
pruefe(("00000.jpg", "00039.jpg") not in ps and len(ps) < 40 * 8, f"GPS-Rauschen erzeugt keine Zufallspaare ({len(ps)} Paare)")
for i, m in enumerate(meta):                  # jetzt trägt das GPS: 400 m Ausdehnung bei 5 m Genauigkeit
    w = i / 40 * 2 * np.pi
    m["gps"] = {"lat": 50.0 + 0.002 * np.sin(w), "lon": 8.0 + 0.003 * np.cos(w), "hoehe": None, "genauigkeit_m": 5.0}
ps2 = set(worker._paare(meta, nachbarn_reihe=2, nachbarn_gps=3, radius_m=500.0))
pruefe(("00000.jpg", "00038.jpg") in ps2 or ("00000.jpg", "00039.jpg") in ps2 or ("00000.jpg", "00037.jpg") in ps2,
       "mit tragendem GPS schließen räumliche Nachbarn die Schleife")

# Schleifenschluss über Miniaturen: Bild 0 und Bild 79 zeigen dasselbe, die dazwischen anderes
bilder = _wurzel / "schleife" / "bilder"
bilder.mkdir(parents=True)
ansichten = [rng.integers(0, 255, (60, 80, 3), dtype=np.uint8) for _ in range(6)]
meta_s = []
for i in range(80):
    a = ansichten[0] if i == 79 else ansichten[min(i // 14, 5)]
    rauschen = np.clip(a.astype(int) + rng.integers(-6, 6, a.shape), 0, 255).astype(np.uint8)
    Image.fromarray(rauschen).save(bilder / f"{i:05d}.jpg")
    meta_s.append({"datei": f"{i:05d}.jpg", "kamera": "v", "gps": None})
ps3 = set(worker._paare(meta_s, nachbarn_reihe=2, ordner=_wurzel / "schleife"))
pruefe(("00000.jpg", "00079.jpg") in ps3, "Schleifenschluss: das erste und das letzte Bild, die dasselbe zeigen, werden gepaart")
ps4 = set(worker._paare(meta_s[:50], nachbarn_reihe=2, ordner=_wurzel / "schleife"))
pruefe(all(abs(int(a[:5]) - int(b[:5])) <= 2 for a, b in ps4), "zu kurze Reihe (≤ 60 Bilder): kein Schleifenschluss, nur Nachbarn")

sortiert = worker._sortiere([{"pfad": Path("b"), "zeit_unix": 5.0, "strom": "ultra"}, {"pfad": Path("a"), "zeit_unix": 5.0, "strom": "wide"},
                             {"pfad": Path("c"), "zeit_unix": 1.0, "strom": "wide"}], [None] * 3)
pruefe([q["pfad"].name for q in sortiert] == ["c", "b", "a"], "Reihenfolge: Zeit, bei Gleichstand der Stromname (reproduzierbar)")
pruefe([q["pfad"].name for q in worker._sortiere([{"pfad": Path("b")}, {"pfad": Path("a")}], ["2", "1"])] == ["a", "b"], "ohne App-Zeit: EXIF-Zeit")
pruefe(A.sauberer_pfad("PhotoSeries_X/wide_1.jpg") == "PhotoSeries_X/wide_1.jpg" and A.sauberer_pfad("../../etc/passwd") == "etc/passwd"
       and A.sauberer_pfad("a\\b\\c.jpg") == "a/b/c.jpg" and A.sauberer_pfad("") == "datei", "Upload-Pfade behalten Ordner, verlieren `..`")

# ── 6. Auftrag: ZIP, vorbereiten, Kameras ─────────────────────────────────────
print("6. Auftrag mit Aufnahmepaket")
# 4 gute Bilder reichen nicht (mind. 8): die Serie aus Abschnitt 3 hat 28 Bilder, 2 als verwackelt eingestuft
(foto / "splatpack.json").write_text(json.dumps({
    "schema": "splatpack.v2", "schemaName": "splatpack", "captureType": "photo_dual", "pairs": paare,
    "app": {"bundleIdentifier": "com.radiancefields.gaussiansplatking.app", "shortVersion": "1.4.1"}}))
job = A.neu("Serie", "schnell")["id"]
ordner = A.verzeichnis(job)
zpfad = ordner / "eingang" / "PhotoSeries_T.zip"
with zipfile.ZipFile(zpfad, "w") as zf:
    for p in sorted(foto.rglob("*")):
        zf.write(p, f"PhotoSeries_T/{p.name}")
shutil.rmtree(_wurzel / "roh", ignore_errors=True)
bericht = worker.entpacken(job, ordner)
pruefe(bericht["bilder"] == 28 and len(bericht["pakete"]) == 1, f"ZIP: 28 Bilder, Paket erkannt ({bericht['pakete']})")
pruefe((ordner / "roh/PhotoSeries_T/PhotoSeries_T/splatpack.json").exists() or any((ordner / "roh").rglob("splatpack.json")),
       "die Begleitdateien kommen aus dem ZIP mit heraus")
opt = A.lese(job)["optionen"]
stand = worker.Stand(job)
vb = worker.vorbereiten(job, ordner, opt, stand)
bj = json.loads((ordner / "bilder.json").read_text())
pruefe(vb["aussortiert"] == 2 and vb["anzahl"] == 26, f"2 verwackelte aussortiert, 26 bleiben ({vb['aussortiert']}/{vb['anzahl']})")
pruefe(vb["kameras"] == 2 and {m["kamera"].split("|")[-1] for m in bj} == {"wide", "ultra"}, "zwei Kameras: Weitwinkel und Ultraweit")
pruefe(all(m["schwerkraft"] for m in bj) and abs(np.linalg.norm(bj[0]["schwerkraft"]) - 1) < 1e-6, "Schwerkraft je Bild, auf Länge 1")
pruefe(all(m["gps"] and m["gps"]["genauigkeit_m"] == 7.5 for m in bj), "Position samt Genauigkeit aus der Begleitdatei")
pruefe(bj[0]["breite"] == 300 and bj[0]["hoehe"] == 200, "Bilder sind aufrecht (Hochformat 200×300 mit Orientierung 6 → quer 300×200)")
zeiten = [m["zeit_unix"] for m in bj]
pruefe(zeiten == sorted(zeiten), "Reihenfolge nach Aufnahmezeit")
pruefe(not (ordner / "roh").exists(), "entpackte Originale sind nach dem Aufbereiten weg (Platz)")

# Brennweite aus dem Sichtfeld erreicht COLMAP als Startwert, und jede Gruppe wird eine eigene Kamera
if worker.COLMAP:
    zw = _wurzel / "colmap_test"
    (zw / "bilder").mkdir(parents=True)
    meta_c = []
    for i in range(6):
        g = "a" if i < 3 else "b"
        gl = __import__("PIL.ImageFilter", fromlist=["x"])
        Image.fromarray(rng.integers(0, 255, (160, 240, 3), dtype=np.uint8)).filter(gl.GaussianBlur(2)).save(zw / "bilder" / f"{i:05d}.jpg")
        meta_c.append({"datei": f"{i:05d}.jpg", "kamera": g, "f_px": 321.5 if g == "b" else None, "breite": 240, "hoehe": 160, "gps": None})
    (zw / "bilder.json").write_text(json.dumps(meta_c))
    cj = A.neu("COLMAP-Kameras")["id"]
    erg = worker.merkmale(cj, zw, {"bild_max": 240}, worker.Stand(cj))
    db = sqlite3.connect(zw / "colmap" / "database.db")
    kam = db.execute("select camera_id, model, width, height, params from cameras order by camera_id").fetchall()
    db.close()
    pruefe(erg["kameras"] == 2 and len(kam) == 2, f"zwei Gruppen → zwei COLMAP-Kameras (Datenbank: {len(kam)})")
    f_b = struct.unpack("<4d", kam[1][4])[0] if len(kam) == 2 and len(kam[1][4]) == 32 else None
    f_a = struct.unpack("<4d", kam[0][4])[0] if len(kam) == 2 and len(kam[0][4]) == 32 else None
    pruefe(f_b is not None and abs(f_b - 321.5) < 1e-6, f"Startbrennweite der Gruppe b = 321,5 px (Datenbank: {f_b})")
    pruefe(f_a is not None and abs(f_a - 321.5) > 1.0, f"Gruppe a bekommt sie nicht (Datenbank: {f_a})")
else:
    print("  ----  COLMAP nicht gefunden — übersprungen")

# Hotfolder: lose Bilder samt Begleitdateien → ein Auftrag, Begleitdateien kommen mit
eingang = A.WURZEL / "eingang"
eingang.mkdir(exist_ok=True)
for i in range(3):
    (eingang / f"IMG_{i}.jpg").write_bytes(b"x" * 50)
    (eingang / f"IMG_{i}.json").write_text("{}")
(eingang / "splatpack.json").write_text("{}")
(eingang / "nur_json.json").write_text("{}")
vorher = len(A.alle())
worker.hotfolder_pruefen()
for k, (g_, _) in list(worker._beobachtet.items()):
    worker._beobachtet[k] = (g_, 0.0)
worker.hotfolder_pruefen()
neue = [x for x in A.alle() if x["name"].startswith("Fotos")]
pruefe(len(neue) == 1 and len(list((A.verzeichnis(neue[0]["id"]) / "eingang").iterdir())) == 8,
       "Hotfolder: drei Bilder + fünf Begleitdateien → ein Auftrag")

# ── 7. Echte Exporte (nur, wenn sie da sind) ──────────────────────────────────
print("7. Echte Exporte aus Gaussian Splat King")
dl = Path.home() / "Downloads"
echt = sorted(dl.glob("PhotoSeries_*/splatpack.json"))
if echt:
    pk = splatpack.finde_pakete(echt[0].parent)
    ixe = splatpack.Index(pk)
    jpgs = sorted(echt[0].parent.glob("*.jpg"))
    infos = [ixe.bild(j) for j in jpgs]
    pruefe(len(jpgs) > 0 and all(i and i["gps"] and i["zeit_unix"] for i in infos), f"{len(jpgs)} Bilder: Ort und Zeit je Bild")
    abw = []
    for j, i in zip(jpgs, infos):
        a = iphone.aus_exif(Image.open(j).getexif())
        b_ = iphone.aus_begleitdatei(i["meta"])
        if a is not None and b_ is not None:
            abw.append(float(np.abs(a - b_).max()))
    pruefe(len(abw) == len(jpgs) and max(abw) < 1e-6, f"eigener MakerNote-Leser = Begleitdatei bei allen {len(abw)} Bildern")
else:
    print("  ----  kein PhotoSeries_* in ~/Downloads — übersprungen")

# ── 8. Programme laufen lassen ────────────────────────────────────────────────
print("8. Programme laufen lassen")
lj = A.neu("lauf")["id"]
worker.lauf(lj, ["echo", "hallo vom Programm"], was="echo")
pruefe("hallo vom Programm" in (A.verzeichnis(lj) / "log.txt").read_text(), f"Ausgabe im Protokoll (Ruhezustandssperre: {'ja' if worker.CAFFEINATE else 'nein, kein caffeinate'})")
try:
    worker.lauf(lj, ["sh", "-c", "echo kaputt >&2; exit 3"], was="Testprogramm")
    pruefe(False, "Fehlercode wird gemeldet")
except worker.Fehler as e:
    pruefe("Code 3" in str(e) and "kaputt" in str(e), "Fehlercode und letzte Zeilen kommen durch caffeinate hindurch an")
A.abbruch_anfordern(lj)
import time as _t
t0 = _t.time()
try:
    worker.lauf(lj, ["sleep", "30"], was="sleep")
    pruefe(False, "Abbruch")
except worker.Abgebrochen:
    pruefe(_t.time() - t0 < 6, f"Abbruchmarke beendet auch ein Programm hinter caffeinate ({_t.time() - t0:.1f} s)")

shutil.rmtree(_wurzel, ignore_errors=True)
print("\n" + ("ALLES GUT" if _gut else "FEHLER"))
sys.exit(0 if _gut else 1)
