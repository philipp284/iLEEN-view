"""
Prüfstein für `splatwerk`: Laserscan → Splat, Warteschlange, Hochachse, SOG, Worker-Bausteine.

Alles läuft ohne Server, ohne COLMAP und ohne GPU. Der Teil, der COLMAP und Brush braucht,
wird nicht hier, sondern mit echten Fotos geprüft (siehe CLAUDE.md, „Splat-Training“).

Was hier steht, sind die Stellen, an denen es still falsch würde:

  1. Ein Surfel, dessen Normale nicht senkrecht auf der Fläche steht, sieht im Viewer
     wie ein aufgestellter Teller aus — aber nur von der Seite, nicht in der Draufsicht.
  2. Die automatische Voxelgröße muss die Obergrenze halten, sonst scheitert ein 300-Mio.-Scan
     erst an der Speichergrenze statt an einer Einstellung.
  3. Der Hochachsen-Kommentar entscheidet im Splat-Handler über eine Drehung der ganzen
     Szene; ein falscher legt ein ENU-ausgerichtetes Modell auf die Seite.
  4. Ein ZIP aus dem Internet ist fremder Eingabe-Text: `../` darf nicht aus dem Auftrag hinaus.
  5. Die Kennung eines Auftrags kommt aus einer URL.

Ausführen:  python3 tests/test_splatwerk.py
"""

import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_wurzel = Path(tempfile.mkdtemp(prefix="splatwerk_test_"))
os.environ["ILEEN_TRAINING_DIR"] = str(_wurzel / "training")   # vor dem Import: WURZEL wird beim Laden gelesen

from splatwerk import auftrag as A  # noqa: E402
from splatwerk import colmap_modell, plyhilfe, scan2gs, sog, uebernahme, worker  # noqa: E402

_gut = True


def pruefe(bedingung: bool, text: str):
    global _gut
    print(f"  {'ok  ' if bedingung else 'FEHL'}  {text}")
    _gut = _gut and bool(bedingung)


def ply_lesen(pfad):
    from plyfile import PlyData
    return PlyData.read(str(pfad))["vertex"]


# ── 1. Laserscan → Surfels ────────────────────────────────────────────────────
print("1. Laserscan → Surfels")
rng = np.random.default_rng(11)
# Zwei Flächen: der Boden (z = 0) und eine Wand (x = 5), 5 mm Messrauschen, in Landeskoordinaten.
n = 40000
boden = np.column_stack([rng.uniform(0, 5, n), rng.uniform(0, 5, n), rng.normal(0, 0.005, n)])
wand = np.column_stack([rng.normal(5, 0.005, n), rng.uniform(0, 5, n), rng.uniform(0, 3, n)])
wolke = np.vstack([boden, wand]) + np.array([32_450_000.0, 5_540_000.0, 150.0])
laz_nein = _wurzel / "flaechen.xyz"
farbe = np.vstack([np.tile([0.8, 0.2, 0.2], (n, 1)), np.tile([0.2, 0.2, 0.8], (n, 1))])
np.savetxt(laz_nein, np.column_stack([wolke, farbe * 255]), fmt="%.4f")

ply = _wurzel / "flaechen.ply"
b = scan2gs.konvertiere(laz_nein, ply, scan2gs.Optionen(voxel_m=0.05))
v = ply_lesen(ply)
pos = np.column_stack([v["x"], v["y"], v["z"]])
pruefe(len(v) == b["splats"] and 1000 < len(v) < 2 * n, f"{len(v)} Surfels aus {b['punkte_gelesen']} Punkten")
pruefe(abs(pos.mean()) < 5, "auf den Schwerpunkt zentriert (Landeskoordinaten würden float32 sprengen)")
pruefe(np.allclose(np.array(b["offset_xyz"]), [32_450_002.5 + 1.25, 5_540_002.5, 150.0 + 0.75], atol=2.0),
       f"Weltversatz als Bericht: {np.round(b['offset_xyz'], 1).tolist()}")

q = np.column_stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]])
w, x, y, z = q.T
normale = np.column_stack([2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)])   # 3. Spalte von R
ist_boden = np.abs(normale[:, 2]) > 0.9
ist_wand = np.abs(normale[:, 0]) > 0.9
pruefe(0.4 < ist_boden.mean() < 0.6 and 0.4 < ist_wand.mean() < 0.6,
       f"Normalen stehen senkrecht auf ihrer Fläche: {ist_boden.mean():.0%} zeigen nach oben/unten, {ist_wand.mean():.0%} zur Wand")
s = np.exp(np.column_stack([v["scale_0"], v["scale_1"], v["scale_2"]]))
pruefe(np.median(s[:, 2]) < 0.4 * np.median(s[:, 0]), "Surfels sind flach (σ entlang der Normale deutlich kleiner)")
op = 1 / (1 + np.exp(-v["opacity"]))
pruefe(np.allclose(op, 0.98, atol=1e-4), "Deckkraft 0,98 als Logit gespeichert")
rgb = np.column_stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]]) * scan2gs.C0 + 0.5
pruefe(abs(rgb[ist_boden, 0].mean() - 0.8) < 0.05 and abs(rgb[ist_wand, 2].mean() - 0.8) < 0.05,
       "Farbe der Quelle bleibt erhalten (SH-DC-Umrechnung)")
kopf = plyhilfe.lese_kopf(ply)
pruefe(plyhilfe.hochachse(kopf) == "z" and plyhilfe.ist_3dgs(kopf), "Kopf meldet Z-up und ist ein gültiger 3DGS-Kopf")

# Automatische Voxelgröße: die Obergrenze gilt
grosse = _wurzel / "gross.xyz"
np.savetxt(grosse, np.column_stack([rng.uniform(0, 20, 300000), rng.uniform(0, 20, 300000), rng.normal(0, 0.003, 300000)]), fmt="%.4f")
b2 = scan2gs.konvertiere(grosse, _wurzel / "gross.ply", scan2gs.Optionen(max_splats=20000))
pruefe(b2["splats"] <= 20000 and b2["voxel_m"] > 0.01, f"Obergrenze 20 000 gehalten: {b2['splats']} Splats, Voxel {b2['voxel_m'] * 100:.1f} cm")
try:
    scan2gs.konvertiere(_wurzel / "leer.xyz", _wurzel / "x.ply")
    pruefe(False, "fehlende Datei wird gemeldet")
except (OSError, ValueError):
    pruefe(True, "fehlende Datei wird gemeldet, nicht verschluckt")

# ── 2. Splat-Handler nimmt die PLY an ─────────────────────────────────────────
print("2. Die PLY geht durch den Splat-Handler")
try:
    from tiling.formats import splat as splat_handler
    ziel = _wurzel / "tiles"
    ziel.mkdir()
    splat_handler.tile_splat(ply, ziel)
    ts = json.loads((ziel / "tileset.json").read_text())
    ex = ts["root"]["extras"]["ileen_splat"]
    pruefe("quelloffset" in ex and "modellversatz" in ex, "Tileset trägt Quelloffset und Modellversatz")
    punkt, unterkante = uebernahme.ankerpunkt(ts)
    pruefe(np.linalg.norm(punkt - (pos.min(0) + pos.max(0)) / 2) < 0.3 + 0.0, f"Verortungspunkt = Hüllboxmitte der Quelle (Abstand {np.linalg.norm(punkt - (pos.min(0) + pos.max(0)) / 2):.3f} m)")
    pruefe(abs(unterkante - (pos[:, 2].max() - pos[:, 2].min()) / 2) < 0.3, f"Abstand Unterkante → Punkt {unterkante:.2f} m = halbe Höhe")
except ImportError as e:
    print(f"  ----  Splat-Handler übersprungen ({e})")

# ── 3. Hochachse ──────────────────────────────────────────────────────────────
print("3. Hochachsen-Kommentar")
brush = _wurzel / "brush.ply"
shutil.copy(ply, brush)
roh = brush.read_bytes().replace(b"comment Vertical axis: z", b"comment Vertical axis: y")
brush.write_bytes(roh)
vorher = brush.stat().st_size
pruefe(plyhilfe.hochachse(plyhilfe.lese_kopf(brush)) == "y", "Brush-Datei meldet Y")
pruefe(plyhilfe.setze_hochachse(brush, "z"), "Kommentar wird umgeschrieben")
pruefe(plyhilfe.hochachse(plyhilfe.lese_kopf(brush)) == "z" and brush.stat().st_size == vorher, "jetzt Z, Dateigröße unverändert (kein Umkopieren)")
v2 = ply_lesen(brush)
pruefe(np.array_equal(np.column_stack([v2["x"], v2["y"], v2["z"]]), pos), "Punktdaten bitgleich")
pruefe(plyhilfe.setze_hochachse(ply, "z"), "schon richtiger Kommentar: nichts zu tun, kein Fehler")

# Spirula Studio schreibt gar keinen Kommentar: er muss eingetragen werden, der Rumpf bleibt bitgleich.
spirula = _wurzel / "spirula.ply"
kopf_z = plyhilfe.lese_kopf(ply)
roh_z = ply.read_bytes()
spirula.write_bytes(roh_z[:kopf_z["kopf_bytes"]].replace(b"comment Vertical axis: z\n", b"")
                    + roh_z[kopf_z["kopf_bytes"]:])
pruefe(plyhilfe.hochachse(plyhilfe.lese_kopf(spirula)) is None, "Spirula-PLY meldet keine Hochachse")
pruefe(not plyhilfe.setze_hochachse(spirula, "z"), "setze_hochachse ändert nichts, wo kein Kommentar steht")
ohne_laenge = spirula.stat().st_size
pruefe(plyhilfe.trage_hochachse_ein(spirula, "z") and plyhilfe.hochachse(plyhilfe.lese_kopf(spirula)) == "z",
       "trage_hochachse_ein fügt den Kommentar ein")
v3 = ply_lesen(spirula)
pruefe(np.array_equal(np.column_stack([v3["x"], v3["y"], v3["z"]]), pos), "Punktdaten nach dem Einfügen bitgleich")
pruefe(spirula.stat().st_size == ohne_laenge + len(b"comment Vertical axis: z\n")
       and not list(_wurzel.glob("*.tmp")), "genau ein Kommentar mehr, keine Temporärdatei übrig")
pruefe(plyhilfe.trage_hochachse_ein(spirula, "z") and spirula.stat().st_size == ohne_laenge + 25, "zweiter Aufruf ändert nichts")

# ── 4. Warteschlange ──────────────────────────────────────────────────────────
print("4. Warteschlange")
a = A.neu("Testauftrag", "schnell")
pruefe(A.lese(a["id"])["status"] == "wartet" and A.lese(a["id"])["optionen"]["schritte"] == 6000, "neuer Auftrag wartet, Qualität übernommen")
A.schreibe(a["id"], status="laeuft", anteil=0.4, bericht={"x": 1})
pruefe(A.lese(a["id"])["anteil"] == 0.4 and A.lese(a["id"])["optionen"]["qualitaet"] == "schnell", "Status ergänzt, Auftrag bleibt")
pruefe(not list(A.verzeichnis(a["id"]).glob("*.tmp")), "kein Rest von der atomaren Schreibweise")
b_ = A.neu("Hochlader", status="laedt")
pruefe(A.lese(b_["id"])["status"] == "laedt", "Upload-Auftrag startet als „lädt“")
c_ = A.neu("Wartend")
pruefe(worker.naechster() == c_["id"], "der Worker greift den wartenden Auftrag — nicht den ladenden und nicht den laufenden")
for boese in ("../etc", "a/b", "", "nicht-uuid", "00000000-0000-0000-0000-00000000000/"):
    try:
        A.verzeichnis(boese)
        pruefe(False, f"Kennung {boese!r} abgelehnt")
    except ValueError:
        pruefe(True, f"Kennung {boese!r} abgelehnt")
pruefe(A.sauberer_name("../../etc/passwd") == "passwd" and A.sauberer_name("..\\x\\y.jpg") == "y.jpg" and A.sauberer_name(".bashrc") == "bashrc",
       "Dateinamen aus Uploads verlieren Pfadanteile")
A.anhaengen(a["id"], "eins\nzwei")
pruefe(A.log_ende(a["id"], 1) == "zwei", "Protokollende")
A.abbruch_anfordern(a["id"])
pruefe(A.abbruch_angefordert(a["id"]), "Abbruchmarke")
A.worker_melden(pid=1, zustand="bereit")
pruefe(A.worker_stand()["aktiv"], "frisches Lebenszeichen: Worker aktiv")
(A.WURZEL / "worker.json").write_text(json.dumps({"zeit": 1.0}))
pruefe(not A.worker_stand()["aktiv"] and "Minuten" in A.worker_stand()["grund"], "altes Lebenszeichen: Worker inaktiv, mit Grund")

# ── 5. ZIP und Bildpaare ──────────────────────────────────────────────────────
print("5. Worker-Bausteine")
z = _wurzel / "boese.zip"
with zipfile.ZipFile(z, "w") as zf:
    zf.writestr("gut/a.jpg", b"x")
    zf.writestr("../../ausserhalb.jpg", b"boese")
    zf.writestr("__MACOSX/._a.jpg", b"x")
    zf.writestr(".DS_Store", b"x")
    zf.writestr("/abs/pfad.jpg", b"x")
ziel = _wurzel / "entpackt"
ziel.mkdir()
n_ = worker._entpacke_zip(z, ziel)
pruefe(n_ == 1 and (ziel / "boese/gut/a.jpg").exists(), "nur das Harmlose wird entpackt")
pruefe(not (_wurzel / "ausserhalb.jpg").exists() and not (_wurzel.parent / "ausserhalb.jpg").exists(), "Zip-Slip (`../`) bleibt im Auftrag")

meta = [{"datei": f"{i:05d}.jpg", "gps": None} for i in range(30)]
paare = worker._paare(meta, nachbarn_reihe=3)
pruefe(("00000.jpg", "00001.jpg") in paare and ("00000.jpg", "00004.jpg") not in paare, "ohne GPS: Nachbarn nach Aufnahmereihenfolge")
pruefe(len(paare) == 29 + 28 + 27, f"{len(paare)} Paare statt der {30 * 29 // 2} aller Kombinationen")
# Schleife: Bild 0 und Bild 29 stehen am selben Ort, obwohl sie weit auseinander aufgenommen wurden
for i, m in enumerate(meta):
    ang = i / 30 * 2 * np.pi
    m["gps"] = {"lat": 50.0 + 0.0003 * np.sin(ang), "lon": 8.0 + 0.0003 * np.cos(ang), "hoehe": None}
paare = worker._paare(meta, nachbarn_reihe=2, nachbarn_gps=3)
pruefe(("00000.jpg", "00029.jpg") in paare, "mit GPS: räumliche Nachbarn schließen die Schleife")

# Der Trainer: Auflösungsteiler, Prüfpunkt, Rahmenprobe
from PIL import Image  # noqa: E402

bilder = _wurzel / "bilder_probe"
bilder.mkdir()
Image.new("RGB", (2400, 1350)).save(bilder / "a.jpg")
Image.new("RGB", (1350, 2400)).save(bilder / "b.jpg")                       # hochkant: es zählt die längere Seite
pruefe(abs(worker._aufloesungsteiler(bilder, 1920) - 1.25) < 1e-6, "2400 px auf 1920: Teiler 1,25 (auch hochkant)")
pruefe(worker._aufloesungsteiler(bilder, 2400) == 0.0, "Bilder, die schon passen: nicht verkleinern")
pruefe(worker._aufloesungsteiler(bilder, 2380) == 0.0, "weniger als 2 % darüber: nicht verkleinern (der Parser rundet ab)")
leer = _wurzel / "leer_bilder_probe"
leer.mkdir()
pruefe(worker._aufloesungsteiler(leer, 1920) == 0.0, "ein Ordner ohne Bilder gibt 0 zurück, keinen Fehler")

lauf_ordner = _wurzel / "spirula_lauf"
for nr in (2000, 30000):
    (lauf_ordner / f"step-{nr:09d}.ckpt").mkdir(parents=True)
    (lauf_ordner / f"step-{nr:09d}.ckpt" / "splat.ply").write_bytes(b"x")
pruefe(worker._spirula_splat(lauf_ordner).parent.name == "step-000030000.ckpt", "der letzte Prüfpunkt gilt (30000 vor 2000, nicht alphabetisch)")
pruefe(worker._spirula_splat(_wurzel / "nirgends") is None, "kein Lauf: None")


def _transform(skala=1.0, verschiebung=(0.0, 0.0, 0.0), drehung=((1, 0, 0), (0, 1, 0), (0, 0, 1))):
    (lauf_ordner / "scene_transform.json").write_text(json.dumps({"train_from_world": {
        "scale": skala, "translation": list(verschiebung), "rotation": {"matrix_3x3": [list(z) for z in drehung]}}}))


_transform()
worker._pruefe_rahmen(lauf_ordner)
pruefe(True, "Identität: der Splat liegt im Rahmen des Modells")
for text, kw in (("verschoben", {"verschiebung": (12.5, 0.0, 0.0)}), ("skaliert", {"skala": 1.822}),
                 ("gedreht", {"drehung": ((0, -1, 0), (1, 0, 0), (0, 0, 1))})):
    _transform(**kw)
    try:
        worker._pruefe_rahmen(lauf_ordner)
        pruefe(False, f"Szene {text}: abgelehnt")
    except worker.Fehler:
        pruefe(True, f"Szene {text}: abgelehnt")
(lauf_ordner / "scene_transform.json").unlink()
try:
    worker._pruefe_rahmen(lauf_ordner)
    pruefe(False, "fehlende scene_transform.json: abgelehnt")
except worker.Fehler:
    pruefe(True, "fehlende scene_transform.json: abgelehnt")

# Szenenradius für die Startansicht des Fensters
punkte_ordner = _wurzel / "radius_auftrag" / "colmap" / "txt_ausgerichtet"
punkte_ordner.mkdir(parents=True)
rng_r = np.random.default_rng(5)
kern = rng_r.normal(0, 3.0, (400, 3))
(punkte_ordner / "points3D.txt").write_text("# Kopf\n" + "".join(
    f"{i} {p[0]:.4f} {p[1]:.4f} {p[2]:.4f} 100 100 100 0.5 1 0\n" for i, p in enumerate(np.vstack([kern, [[500.0, 0, 0]] * 8]), start=1)))
radius = worker._szenenradius(_wurzel / "radius_auftrag")
pruefe(3.0 < radius < 8.0, f"Szenenradius ignoriert die wenigen weit entfernten Punkte ({radius:.1f} m statt Hunderte)")
pruefe(worker._szenenradius(_wurzel / "ohne_punkte") == 10.0, "ohne Punktdatei: Rückfall 10 m")
(punkte_ordner / "points3D.txt").write_text("# Kopf\n" + "".join(
    f"{i} {p[0]:.4f} {p[1]:.4f} {p[2]:.4f} 100 100 100 0\n" for i, p in enumerate(kern, start=1)))    # Atlas: acht Felder, keine Spur
pruefe(3.0 < worker._szenenradius(_wurzel / "radius_auftrag") < 8.0, "Punkte ohne Spur (Atlas-Format) zählen für den Radius")

# DevTools-Anbindung: ein Mini-Server spricht WebSocket wie Chrome — Handshake, maskierter Befehl, lange Antwort in Teilen
import base64, hashlib, socket as _socket, threading  # noqa: E402


def _ws_server(antwort_nutz: bytes, ergebnis: dict):
    srv = _socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)

    def lauf():
        c, _ = srv.accept()
        roh = b""
        while b"\r\n\r\n" not in roh:
            roh += c.recv(4096)
        schluessel = [z.split(b": ")[1] for z in roh.split(b"\r\n") if z.lower().startswith(b"sec-websocket-key")][0]
        akzept = base64.b64encode(hashlib.sha1(schluessel + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + akzept + b"\r\n\r\n")
        rest = roh.split(b"\r\n\r\n", 1)[1]
        while len(rest) < 2:
            rest += c.recv(4096)
        n = rest[1] & 0x7F
        kopf = 2 + (2 if n == 126 else 8 if n == 127 else 0)
        while len(rest) < kopf:
            rest += c.recv(4096)
        n = int.from_bytes(rest[2:kopf], "big") if n >= 126 else n
        while len(rest) < kopf + 4 + n:
            rest += c.recv(65536)
        maske, daten = rest[kopf:kopf + 4], rest[kopf + 4:kopf + 4 + n]
        ergebnis["befehl"] = json.loads(bytes(b ^ maske[i % 4] for i, b in enumerate(daten)))
        hälfte = len(antwort_nutz) // 2
        for teil, op in ((antwort_nutz[:hälfte], 0x01), (antwort_nutz[hälfte:], 0x80)):   # Text ohne FIN, dann Fortsetzung mit FIN
            laenge = len(teil)
            c.sendall(bytes([op]) + (bytes([laenge]) if laenge < 126 else bytes([126]) + laenge.to_bytes(2, "big") if laenge < 65536
                                      else bytes([127]) + laenge.to_bytes(8, "big")) + teil)
        c.close()
        srv.close()

    threading.Thread(target=lauf, daemon=True).start()
    return srv.getsockname()[1]


gross = "x" * 70000
mitschnitt = {}
port_ws = _ws_server(json.dumps({"id": 1, "result": {"data": gross}}).encode(), mitschnitt)
erg = worker._cdp(f"ws://127.0.0.1:{port_ws}/devtools/page/abc", "Runtime.evaluate", {"expression": "1+1" + " " * 300})
pruefe(erg.get("data") == gross, "DevTools: 70 000 Zeichen in zwei Teilen zusammengesetzt (64-Bit-Länge)")
pruefe(mitschnitt["befehl"]["method"] == "Runtime.evaluate" and mitschnitt["befehl"]["params"]["expression"].startswith("1+1"),
       "DevTools: der Befehl kam maskiert und heil an (auch über 125 Byte)")
mitschnitt2 = {}
port_ws2 = _ws_server(json.dumps({"id": 1, "error": {"message": "kaputt"}}).encode(), mitschnitt2)
try:
    worker._cdp(f"ws://127.0.0.1:{port_ws2}/x", "Foo.bar")
    pruefe(False, "DevTools: Fehlerantwort wird gemeldet")
except OSError as e:
    pruefe("kaputt" in str(e), "DevTools: Fehlerantwort wird gemeldet")

# Hotfolder: zwölf lose Fotos werden **ein** Auftrag, und zwar nach einer Ruhezeit, nicht nach zwölf.
eingang = A.WURZEL / "eingang"
eingang.mkdir(exist_ok=True)
for i in range(12):
    (eingang / f"IMG_{i:04d}.jpg").write_bytes(b"x" * (100 + i))
vorher = len(A.alle())
worker.hotfolder_pruefen()                                   # erste Beobachtung: noch nichts
pruefe(len(A.alle()) == vorher, "frisch kopierte Dateien werden noch nicht aufgegriffen")
for k, (g, _) in list(worker._beobachtet.items()):
    worker._beobachtet[k] = (g, 0.0)                         # „seit Ewigkeiten unverändert“
pruefe(len(worker._beobachtet) == 12, "alle zwölf Dateien werden beobachtet, nicht nur die erste")
worker.hotfolder_pruefen()
neue = [x for x in A.alle() if x["name"].startswith("Fotos")]
pruefe(len(neue) == 1 and len(list((A.verzeichnis(neue[0]["id"]) / "eingang").iterdir())) == 12,
       "ein Auftrag mit allen zwölf Dateien")
pruefe(not list(eingang.glob("IMG_*")), "der Eingangsordner ist danach leer")
(eingang / "halb.zip").write_bytes(b"PK\x03\x04 nicht fertig")
worker.hotfolder_pruefen()
for k, (g, _) in list(worker._beobachtet.items()):
    worker._beobachtet[k] = (g, 0.0)
worker.hotfolder_pruefen()
pruefe((eingang / "halb.zip").exists(), "eine ZIP, die keine ist (noch im Kopieren), bleibt liegen")

# ── 6. COLMAP-Transformationsdatei ────────────────────────────────────────────
print("6. COLMAP-Transformationsdatei")
qq = rng.normal(size=4)
qq /= np.linalg.norm(qq)
r = colmap_modell.quaternion_nach_matrix(qq)
pruefe(np.allclose(r @ r.T, np.eye(3)) and np.isclose(np.linalg.det(r), 1), "Quaternion → Drehmatrix ist eine echte Drehung")
rueck = colmap_modell.matrix_nach_quaternion(r)
pruefe(np.allclose(rueck, qq) or np.allclose(rueck, -qq), "Matrix → Quaternion kehrt zurück")
m4 = np.eye(4)
m4[:3, :3] = 2.5 * r
m4[:3, 3] = [1, 2, 3]
colmap_modell.schreibe_sim3(_wurzel / "sim.txt", m4)
zahlen = (_wurzel / "sim.txt").read_text().split()
pruefe(len(zahlen) == 8 and abs(float(zahlen[0]) - 2.5) < 1e-9, "eine Zeile: Maßstab, Quaternion, Verschiebung (acht Zahlen)")
try:
    colmap_modell.schreibe_sim3(_wurzel / "x.txt", -m4)
    pruefe(False, "negativer Maßstab (Spiegelung) abgelehnt")
except ValueError:
    pruefe(True, "negativer Maßstab (Spiegelung) abgelehnt")

# ── 7. SOG ────────────────────────────────────────────────────────────────────
print("7. SOG-Export")
if sog.finde_werkzeug():
    kopf = plyhilfe.lese_kopf(ply)
    out = _wurzel / "z.sog"
    info = sog.exportiere(ply, out, "auto")
    pruefe(out.exists() and info["gedreht"] and info["hochachse"] == "z", f"Z-up-PLY wird für die Splat-Welt gedreht ({info['bytes'] / 1e3:.0f} kB)")
    info2 = sog.exportiere(brush.with_name("brush.ply"), _wurzel / "z2.sog", "unveraendert")
    pruefe(not info2["gedreht"], "„unverändert“ dreht nie")
    info_s = sog.exportiere(spirula, _wurzel / "spirula.sog", "auto")
    pruefe(info_s["gedreht"] and info_s["hochachse"] == "z", "Spirula-PLY mit eingetragener Hochachse wird für die Splat-Welt gedreht")
    # Rückweg: das SOG in eine PLY lesen und die Lage prüfen — Z-up (x, y, z) → y unten (x, −z, y)
    back = _wurzel / "back.ply"
    import subprocess
    subprocess.run([sog.finde_werkzeug(), str(out), str(back), "-w", "-q"], check=True, capture_output=True)
    vb = ply_lesen(back)
    pb = np.column_stack([vb["x"], vb["y"], vb["z"]])
    erwartet = np.column_stack([pos[:, 0], -pos[:, 2], pos[:, 1]])
    pruefe(np.allclose(pb.max(0) - pb.min(0), erwartet.max(0) - erwartet.min(0), atol=0.1)
           and abs(pb[:, 1].min() - erwartet[:, 1].min()) < 0.1,
           "Lage im SOG: y = −z (nach unten), z = y (nach vorn)")
    fremd = _wurzel / "fremd.ply"
    shutil.copy(ply, fremd)
    fremd.write_bytes(fremd.read_bytes().replace(b"comment Vertical axis: z\n", b"comment Origin: irgendwer\n    "[:len(b"comment Vertical axis: z\n")]))
    try:
        info3 = sog.exportiere(fremd, _wurzel / "z3.sog", "auto")
        pruefe(not info3["gedreht"], "PLY ohne Hochachsen-Angabe (fremder Trainer) bleibt unberührt")
    except sog.SogFehler as e:
        pruefe(False, f"fremde PLY: {e}")
    try:
        sog.exportiere(grosse, _wurzel / "k.sog")
        pruefe(False, "Nicht-Splat abgelehnt")
    except (sog.SogFehler, ValueError):
        pruefe(True, "Datei ohne Splat-Eigenschaften wird abgelehnt")
else:
    print("  ----  splat-transform nicht gefunden — übersprungen")

shutil.rmtree(_wurzel, ignore_errors=True)
print("\n" + ("ALLES GUT" if _gut else "FEHLER"))
sys.exit(0 if _gut else 1)
