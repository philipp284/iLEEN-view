"""
Bestehende Splat-Assets mit dem aktuellen Tiler neu kacheln.

Der HLOD-Aufbau aus #8 (`tiling/splat_hlod.py`) gilt nur für neue Uploads. Ein
Asset, das davor hochgeladen wurde, liegt weiter als ADD-Octree mit
Zufallsauswahl im Bucket — und lädt aus der Nähe mehrfach so lange wie das
gemessene Gegenstück (Kirche: 5,5 s statt 1,7 s bis „fertig"). Dieses Modul
holt das nach, ohne dass jemand die PLY neu hochladen oder neu verorten muss.

Aufruf (im Container, aus `/app`):

    python -m tiling.splat_neu liste                 # Stand aller Splat-Assets
    python -m tiling.splat_neu neu <job_id> [...]    # gezielt
    python -m tiling.splat_neu neu alle              # alles, was noch ADD ist
    python -m tiling.splat_neu neu alle --trocken    # nur prüfen, nichts ändern

**Was erhalten bleibt.** Die Platzierung (`placement.json` und der
`root.transform` samt `extras.ileen`), die Namen im Asset-Manager (`meta.json`
liegt unter demselben Präfix und wird nicht angefasst) und die Quelldatei.

**Warum die Verortung stimmt.** Der Tiler legt den Modellursprung in die Mitte
des Kastens um *die Splats, die er behält* (siehe `tile_splat`, „wurzel").
Behält er dieselben wie damals, sitzt das Modell an derselben Stelle. Das wird
geprüft, bevor etwas getauscht wird: die Zahl der Splats im alten Tileset
(aus den GLB-Köpfen) gegen die des neuen. Weichen sie ab — etwa weil damals
`SPLAT_MAX_POINTS` eine Stichprobe gezogen hat —, bleibt das Asset unberührt
und wird gemeldet. `--erzwingen` tauscht trotzdem; dann kann das Modell um
einen Teil seiner Ausdehnung gegen die Verortung wandern.

**Tauschen statt Löschen.** Erst wird vollständig lokal gekachelt, dann
hochgeladen (Tiles zuerst, `tileset.json` zuletzt), dann werden alte Tiles
entfernt, die das neue Tileset nicht mehr nennt. Schlägt das Tiling fehl,
bleibt das alte Asset, wie es war.
"""

import argparse
import json
import logging
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path

from minio.deleteobjects import DeleteObject

from storage.minio_client import get_json, get_minio, put_json
from tiling.georef import PLACEMENT_FILE, apply_placement

logger = logging.getLogger("splat_neu")

BUCKET_TILES = "tiles"
BUCKET_UPLOADS = "uploads"
# Abweichung der Splatzahl, bis zu der „dieselbe Auswahl" gilt. Der Tiler
# verwirft Ausreißer deterministisch; Rundung gibt es keine.
TOLERANZ = 0.0005


def _tileset(job_id: str) -> dict | None:
    try:
        return get_json(BUCKET_TILES, f"{job_id}/tileset.json")
    except Exception:  # noqa: BLE001 — fehlt oder kein Splat: nicht unser Fall
        return None


def _kacheln(knoten: dict, ziel: list):
    uri = (knoten.get("content") or {}).get("uri")
    if uri:
        ziel.append(uri)
    for kind in knoten.get("children", []):
        _kacheln(kind, ziel)


def _ist_splat(tileset: dict) -> bool:
    # Die Erweiterung steht unter `extensions.3DTILES_content_gltf`, nicht
    # oben — und `tileset.json` kann Megabyte groß sein, deshalb nur dort suchen.
    return "KHR_gaussian_splatting" in json.dumps(tileset.get("extensions", {}))


def stand(tileset: dict) -> str:
    """'hlod', 'add' oder 'alt' (ADD aus der Zeit vor #8 — ohne Kennzeichnung)."""
    kennung = (tileset.get("root", {}).get("extras") or {}).get("ileen_splat")
    if kennung is None:
        return "alt"
    return kennung.get("lod", "hlod")


def _splats_im_glb(job_id: str, uri: str) -> int:
    """Splatzahl einer Kachel aus dem JSON-Kopf des GLB (ohne die Daten zu laden)."""
    r = get_minio().get_object(BUCKET_TILES, f"{job_id}/{uri}", offset=0, length=16384)
    try:
        kopf = r.read()
    finally:
        r.close()
        r.release_conn()
    laenge = struct.unpack("<I", kopf[12:16])[0]
    glb = json.loads(kopf[20:20 + laenge])
    return max(a.get("count", 0) for a in glb["accessors"])


def splats_gesamt(job_id: str, tileset: dict) -> int:
    """Summe über alle Kacheln — nur für ADD aussagekräftig (jeder Splat einmal)."""
    uris: list = []
    _kacheln(tileset["root"], uris)
    return sum(_splats_im_glb(job_id, u) for u in uris)


def _splat_assets() -> list[tuple[str, dict]]:
    client = get_minio()
    jobs = sorted({o.object_name.split("/")[0]
                   for o in client.list_objects(BUCKET_TILES, recursive=False)})
    ergebnis = []
    for job in jobs:
        if job == PRAEFIX_BENCH:
            continue
        ts = _tileset(job)
        if ts and _ist_splat(ts):
            ergebnis.append((job, ts))
    return ergebnis


PRAEFIX_BENCH = "bench"


def _quelle(job_id: str) -> str | None:
    objekte = list(get_minio().list_objects(BUCKET_UPLOADS, prefix=f"{job_id}/", recursive=True))
    return objekte[0].object_name if objekte else None


def neu_kacheln(job_id: str, trocken: bool = False, erzwingen: bool = False) -> str:
    """Kachelt ein Asset neu. Gibt eine Zeile für den Bericht zurück."""
    from tiling.formats.splat import tile_splat

    alt = _tileset(job_id)
    if alt is None or not _ist_splat(alt):
        return f"{job_id}: kein Splat-Tileset"
    if stand(alt) == "hlod":
        return f"{job_id}: schon HLOD"
    uris: list = []
    _kacheln(alt["root"], uris)
    if len(uris) < 2:
        return f"{job_id}: eine einzige Kachel — nichts zu gewinnen"
    quelle = _quelle(job_id)
    if quelle is None:
        return f"{job_id}: Quelldatei fehlt in uploads/ — übersprungen"

    alt_anzahl = splats_gesamt(job_id, alt)
    try:
        platzierung = get_json(BUCKET_TILES, f"{job_id}/{PLACEMENT_FILE}")
    except Exception:  # noqa: BLE001
        platzierung = None

    arbeit = Path(tempfile.mkdtemp(prefix=f"splat_neu_{job_id[:8]}_"))
    try:
        src = arbeit / Path(quelle).name
        get_minio().fget_object(BUCKET_UPLOADS, quelle, str(src))
        aus = arbeit / "tiles"
        aus.mkdir()
        t0 = time.time()
        tile_splat(src, aus)
        dauer = time.time() - t0
        src.unlink()  # die PLY ist groß, die Kacheln sind es nicht

        neu = json.loads((aus / "tileset.json").read_text())
        kennung = neu["root"]["extras"]["ileen_splat"]
        neu_anzahl = kennung["splats"]
        abweichung = abs(neu_anzahl - alt_anzahl) / max(alt_anzahl, 1)
        neue_uris: list = []
        _kacheln(neu["root"], neue_uris)
        kopf = (f"{job_id}: {len(uris)} → {len(neue_uris)} Kacheln, "
                f"{alt_anzahl:,} → {neu_anzahl:,} Splats, {dauer:.0f} s".replace(",", "."))

        if abweichung > TOLERANZ and not erzwingen:
            return (f"{kopf} — ABWEICHUNG {abweichung:.1%}: andere Auswahl als damals, "
                    "Modellursprung würde wandern; übersprungen (--erzwingen tauscht trotzdem)")
        if trocken:
            return f"{kopf} — Probelauf, nichts getauscht"

        # Platzierung des alten Assets wieder aufsetzen. Fehlt placement.json,
        # gilt der Wurzel-Transform des alten Tilesets.
        if platzierung:
            apply_placement(neu, platzierung)
            (aus / PLACEMENT_FILE).write_text(json.dumps(platzierung, indent=2))
        else:
            neu["root"]["transform"] = alt["root"]["transform"]
            if "ileen" in (alt["root"].get("extras") or {}):
                neu["root"].setdefault("extras", {})["ileen"] = alt["root"]["extras"]["ileen"]
        neu_json = json.dumps(neu, separators=(",", ":"))

        client = get_minio()
        for datei in sorted(aus.iterdir()):
            if datei.name in ("tileset.json", PLACEMENT_FILE):
                continue
            client.fput_object(BUCKET_TILES, f"{job_id}/{datei.name}", str(datei))
        if platzierung:
            put_json(BUCKET_TILES, f"{job_id}/{PLACEMENT_FILE}", platzierung)
        (aus / "tileset.json").write_text(neu_json)
        client.fput_object(BUCKET_TILES, f"{job_id}/tileset.json", str(aus / "tileset.json"),
                           content_type="application/json")

        # Alte Kacheln, die das neue Tileset nicht mehr kennt.
        behalten = set(neue_uris)
        weg = [DeleteObject(f"{job_id}/{u}") for u in uris if u not in behalten]
        for fehler in client.remove_objects(BUCKET_TILES, weg):
            logger.warning("Löschen fehlgeschlagen: %s", fehler)
        return f"{kopf} — getauscht, {len(weg)} alte Kacheln entfernt"
    finally:
        shutil.rmtree(arbeit, ignore_errors=True)


def liste() -> None:
    for job, ts in _splat_assets():
        uris: list = []
        _kacheln(ts["root"], uris)
        refine = ts["root"].get("refine")
        print(f"{job}  {stand(ts):5} {len(uris):5} Kacheln  refine={refine}")


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = ap.add_subparsers(dest="befehl", required=True)
    sub.add_parser("liste")
    n = sub.add_parser("neu")
    n.add_argument("jobs", nargs="+", help="job_id(s) oder 'alle'")
    n.add_argument("--trocken", action="store_true")
    n.add_argument("--erzwingen", action="store_true")
    args = ap.parse_args(argv)

    if args.befehl == "liste":
        liste()
        return 0
    jobs = args.jobs
    if jobs == ["alle"]:
        jobs = [j for j, ts in _splat_assets() if stand(ts) != "hlod"]
    for job in jobs:
        try:
            print(neu_kacheln(job, args.trocken, args.erzwingen), flush=True)
        except Exception as e:  # noqa: BLE001 — ein Asset darf die Reihe nicht stoppen
            logger.exception("%s: fehlgeschlagen: %s", job, e)
            print(f"{job}: FEHLER {e}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
