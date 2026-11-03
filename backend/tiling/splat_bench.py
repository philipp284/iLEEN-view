"""
Splat-Varianten für den Leistungsvergleich erzeugen und in MinIO ablegen.

Jede Variante ist ein vollständiges Neu-Tiling aus der Original-PLY mit einem
eigenen Satz `SPLAT_*`-Einstellungen (siehe `splat_varianten.json`). Abgelegt
wird unter `tiles/bench/<datensatz>/<variante>/` — ein eigener Präfix, der die
Tilesets der Nutzer nie berührt und trotzdem über dieselbe API ausgeliefert
wird (`/tiles/bench/<datensatz>/<variante>/tileset.json`). Damit misst der
Benchmark genau den Weg, den der Viewer im Betrieb geht.

Aufruf (aus `backend/`):

    python -m tiling.splat_bench kacheln kirche baseline
    python -m tiling.splat_bench kacheln alle baseline
    python -m tiling.splat_bench liste

Die Quell-PLYs liegen in `data/bench/quellen/<datensatz>.ply` (ignoriert);
`holen` lädt sie aus dem `uploads`-Bucket.

Warum ein eigener Prozess je Variante: die Tiler-Module lesen ihre
Einstellungen beim Import aus der Umgebung. Ein frischer Prozess ist der
einzige Weg, der garantiert keine Einstellung aus der Vorgängervariante
mitschleppt.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HIER = Path(__file__).resolve().parent
BACKEND = HIER.parent
DATEN = BACKEND / "data" / "bench"
VARIANTEN = HIER / "splat_varianten.json"
BUCKET = "tiles"
PRAEFIX = "bench"

# Die drei Vergleichsdatensätze: außen ohne SH, Drohne mit SH3, Innenraum.
DATENSAETZE = {
    "kirche": ("d094f205-c384-4acb-ac77-66c68f391c3c", "Kirche_Laubenheim.ply"),
    "zitadelle": ("42790419-0751-4adb-9f1f-b471d322a405", "Zitadelle_drone.ply"),
    "h212": ("0fb0d129-6a90-4785-8be6-d64d1c28d564", "Holzstraße_2.OG_H212.ply"),
}

# Fester Bezugspunkt für alle Varianten: Campus Holzstraße, 100 m über dem
# Ellipsoid. Keine Geländeabfrage — die Varianten sollen sich nur im Tiling
# unterscheiden. Die 100 m sind nötig, weil Tilesets von vor #8 um die halbe
# Höhe ihres Wurzelkastens versinken (siehe `_modellversatz`): bei der Kirche
# 29 m, und auf Höhe 0 verschwand damit das halbe Modell unter dem Globus.
ORT = {
    "TILESET_ORIGIN_LON": "8.2599",
    "TILESET_ORIGIN_LAT": "49.9929",
    "TILESET_ORIGIN_HEIGHT": "100",
    "TILESET_ORIGIN_HEIGHT_REFERENCE": "ellipsoid",
}


def _minio():
    from minio import Minio

    return Minio(
        os.getenv("BENCH_MINIO", "localhost:9000"),
        access_key=os.getenv("MINIO_ACCESS_KEY", "minioadmin"),
        secret_key=os.getenv("MINIO_SECRET_KEY", "minioadmin_secret_change_me"),
        secure=False,
    )


def _env_datei() -> dict:
    """MinIO-Zugang aus `backend/.env`, ohne python-dotenv vorauszusetzen."""
    werte = {}
    pfad = BACKEND / ".env"
    if pfad.is_file():
        for zeile in pfad.read_text().splitlines():
            if "=" in zeile and not zeile.lstrip().startswith("#"):
                k, v = zeile.split("=", 1)
                werte[k.strip()] = v.strip()
    return werte


def holen(datensatz: str):
    job, name = DATENSAETZE[datensatz]
    ziel = DATEN / "quellen" / f"{datensatz}.ply"
    if ziel.is_file():
        return ziel
    ziel.parent.mkdir(parents=True, exist_ok=True)
    _minio().fget_object("uploads", f"{job}/{name}", str(ziel))
    return ziel


def varianten() -> dict:
    return json.loads(VARIANTEN.read_text())


def kacheln(datensatz: str, variante: str):
    """Startet das Tiling einer Variante in einem eigenen Prozess."""
    einstellungen = varianten()[variante]
    quelle = holen(datensatz)
    ausgabe = DATEN / "tiles" / datensatz / variante
    if ausgabe.exists():
        shutil.rmtree(ausgabe)
    ausgabe.mkdir(parents=True)

    env = {k: v for k, v in os.environ.items() if not k.startswith("SPLAT_")}
    env.update(ORT)
    env.update({k: str(v) for k, v in einstellungen.get("env", {}).items()})
    env["PYTHONPATH"] = str(BACKEND)

    beginn = time.time()
    subprocess.run(
        [sys.executable, "-c",
         "import logging,sys;from pathlib import Path;"
         "logging.basicConfig(level=logging.INFO,format='%(message)s');"
         "from tiling.formats.splat import tile_splat;"
         "tile_splat(Path(sys.argv[1]),Path(sys.argv[2]))",
         str(quelle), str(ausgabe)],
        env=env, check=True, cwd=BACKEND,
    )
    dauer = time.time() - beginn

    kennzahlen = statistik(ausgabe)
    kennzahlen.update(
        datensatz=datensatz, variante=variante, tiling_s=round(dauer, 1),
        env=einstellungen.get("env", {}),
    )
    (ausgabe / "bench.json").write_text(json.dumps(kennzahlen, indent=2))
    hochladen(ausgabe, f"{PRAEFIX}/{datensatz}/{variante}")
    print(json.dumps(kennzahlen, indent=2))


def statistik(ordner: Path) -> dict:
    """Tiles, Bytes und Splats je Ebene — aus den GLB-Accessoren gelesen."""
    tileset = json.loads((ordner / "tileset.json").read_text())
    ebenen: dict = {}

    def lauf(knoten, tiefe):
        e = ebenen.setdefault(tiefe, {"tiles": 0, "splats": 0, "bytes": 0,
                                       "geometricError": []})
        uri = knoten.get("content", {}).get("uri")
        if uri:
            pfad = ordner / uri
            e["tiles"] += 1
            e["bytes"] += pfad.stat().st_size
            e["splats"] += _splat_anzahl(pfad)
        e["geometricError"].append(knoten["geometricError"])
        for kind in knoten.get("children", []):
            lauf(kind, tiefe + 1)

    lauf(tileset["root"], 0)
    versatz = _modellversatz(tileset)
    for e in ebenen.values():
        ge = e.pop("geometricError")
        e["geometricError_min"] = round(min(ge), 4)
        e["geometricError_max"] = round(max(ge), 4)
    return {
        "tiles": sum(e["tiles"] for e in ebenen.values()),
        "splats": sum(e["splats"] for e in ebenen.values()),
        "bytes": sum(e["bytes"] for e in ebenen.values()),
        "tileset_json_bytes": (ordner / "tileset.json").stat().st_size,
        "modellversatz": versatz,
        "ebenen": ebenen,
    }


def _modellversatz(tileset: dict) -> list:
    """
    Wo der Modellursprung (nach `recenter`) im Tileset tatsächlich landet.

    Bis #8 überschrieb `build_tileset()` den `transform` des Wurzelknotens mit
    der ENU-Matrix — die Verschiebung auf die Mitte des Wurzelkastens ging
    dabei verloren. Der Inhalt aller Tiles ist aber relativ zu dieser Mitte
    geschrieben, das ganze Modell liegt dadurch um sie versetzt: waagerecht um
    null (recenter zentriert x/y), senkrecht um die halbe Kastenhöhe nach
    unten. Der Benchmark braucht den Versatz, damit dieselbe Kamera in jeder
    Variante auf dieselbe Stelle des Modells blickt. Tilesets ab #8 schreiben
    ihn selbst in `root.extras.ileen_splat.modellversatz`.
    """
    extras = tileset["root"].get("extras", {}).get("ileen_splat", {})
    if "modellversatz" in extras:
        return extras["modellversatz"]
    box = tileset["root"]["boundingVolume"]["box"]
    return [0.0, 0.0, -float(box[11])]


def _splat_anzahl(glb: Path) -> int:
    import struct

    daten = glb.read_bytes()
    laenge = struct.unpack_from("<I", daten, 12)[0]
    gltf = json.loads(daten[20:20 + laenge])
    return int(gltf["accessors"][0]["count"])


def hochladen(ordner: Path, praefix: str):
    client = _minio()
    # Altbestand der Variante entfernen, damit keine verwaisten Tiles bleiben
    alt = [o.object_name for o in client.list_objects(BUCKET, prefix=praefix + "/", recursive=True)]
    if alt:
        from minio.deleteobjects import DeleteObject

        for fehler in client.remove_objects(BUCKET, [DeleteObject(n) for n in alt]):
            print("Löschen fehlgeschlagen:", fehler)
    for datei in sorted(ordner.iterdir()):
        client.fput_object(BUCKET, f"{praefix}/{datei.name}", str(datei))


def main(argv):
    for k, v in _env_datei().items():
        if k.startswith("MINIO_"):
            os.environ.setdefault(k, v)
    if not argv or argv[0] == "liste":
        for name, v in varianten().items():
            print(f"{name:24s} {v.get('beschreibung', '')}")
        return
    befehl, *rest = argv
    if befehl == "holen":
        for d in (DATENSAETZE if rest[0] == "alle" else [rest[0]]):
            print(holen(d))
    elif befehl == "kacheln":
        ds, var = rest
        for d in (DATENSAETZE if ds == "alle" else [ds]):
            kacheln(d, var)
    else:
        raise SystemExit(f"Unbekannter Befehl: {befehl}")


if __name__ == "__main__":
    main(sys.argv[1:])
