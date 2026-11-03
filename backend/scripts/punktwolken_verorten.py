"""
Verortet bereits getilete Punktwolken neu — ohne sie neu zu konvertieren.

Vor dem CRS-Fix in `tiling/formats/pointcloud.py` wurde die
Schwerpunkt-Translation von py3dtiles als `base_transform` geführt und der
ENU-Transform davor gerechnet. Bei Wolken in Landeskoordinaten (UTM,
Gauß-Krüger) bedeutet das einen Versatz von Millionen Metern entlang der
Ost-Nord-Oben-Achsen: die Wolke schwebt im All und steht schief.

Die Kacheln selbst sind davon unberührt — sie enthalten Koordinaten relativ zum
Datenschwerpunkt und sind korrekt. Zu reparieren sind nur `placement.json` und
der `root.transform` der `tileset.json`, und genau das tut dieses Skript: es
liest das CRS aus dem LAS-Header im uploads-Bucket und leitet daraus dieselbe
Platzierung ab, die ein heutiges Tiling erzeugen würde.

    python scripts/punktwolken_verorten.py              # zeigt nur an
    python scripts/punktwolken_verorten.py --schreiben  # schreibt
    python scripts/punktwolken_verorten.py --schreiben <job_id> ...
"""

import argparse
import logging
import sys
import tempfile
from pathlib import Path

from minio.error import S3Error

from storage.minio_client import get_json, get_minio, put_json
from tiling.formats.pointcloud import _source_crs
from tiling.georef import PLACEMENT_FILE, apply_placement, placement_from_projected, to_matrix

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("verorten")

# So viel vom Anfang der Datei genügt für Header und VLRs — der Rest sind Punkte.
_KOPF_BYTES = 4 * 1024 * 1024

# Ab hier ist ein Versatz keine lokale Bauplatzkoordinate mehr, sondern eine
# Projektion, die als solche behandelt werden muss.
_VERDACHT_AB_M = 1000.0


def _quelldatei(job_id: str) -> str | None:
    client = get_minio()
    for obj in client.list_objects("uploads", prefix=f"{job_id}/", recursive=True):
        if obj.object_name.lower().endswith((".las", ".laz")):
            return obj.object_name
    return None


def _crs_der_quelle(job_id: str):
    """CRS aus dem Header der hochgeladenen Datei — es werden nur deren erste Megabyte gelesen."""
    key = _quelldatei(job_id)
    if key is None:
        logger.info(f"  keine LAS/LAZ-Quelle im uploads-Bucket")
        return None

    antwort = get_minio().get_object("uploads", key, offset=0, length=_KOPF_BYTES)
    try:
        kopf = antwort.read()
    finally:
        antwort.close()
        antwort.release_conn()

    with tempfile.TemporaryDirectory() as tmp:
        pfad = Path(tmp) / Path(key).name
        pfad.write_bytes(kopf)
        return _source_crs(pfad)


def _versatz(placement: dict) -> tuple[float, float, float] | None:
    """
    Der Datenschwerpunkt aus `base_transform`, sofern der eine reine
    Verschiebung ist. Alles andere stammt nicht von py3dtiles und bleibt
    unangetastet.
    """
    base = placement.get("base_transform")
    if not base:
        return None

    matrix = to_matrix(base)
    dreh = matrix[:3, :3]
    import numpy as np

    if not np.allclose(dreh, np.eye(3), atol=1e-12):
        logger.info("  base_transform enthält mehr als eine Verschiebung — übersprungen")
        return None
    return tuple(float(v) for v in matrix[:3, 3])


def verorten(job_id: str, schreiben: bool) -> bool:
    logger.info(f"\n{job_id}")
    try:
        placement = get_json("tiles", f"{job_id}/{PLACEMENT_FILE}")
    except S3Error:
        logger.info("  keine placement.json")
        return False

    versatz = _versatz(placement)
    if versatz is None:
        return False

    if max(abs(versatz[0]), abs(versatz[1])) < _VERDACHT_AB_M:
        logger.info(f"  Versatz {versatz[0]:.1f}/{versatz[1]:.1f} m — unauffällig")
        return False

    crs = _crs_der_quelle(job_id)
    if crs is None:
        logger.info(
            f"  Versatz {versatz[0]:.0f}/{versatz[1]:.0f} m, aber kein CRS in der Quelle — "
            "von Hand verorten (POINTCLOUD_CRS_IN und neu tilen)"
        )
        return False

    neu = placement_from_projected(crs, *versatz)
    logger.info(
        f"  alt: {placement['lon']:.6f}/{placement['lat']:.6f} + Versatz "
        f"{versatz[0]:.0f}/{versatz[1]:.0f}/{versatz[2]:.1f}"
    )
    logger.info(
        f"  neu: {neu['lon']:.6f}/{neu['lat']:.6f}, {neu['height']:.2f} m ü. NHN, "
        f"Drehung {neu['heading']:+.4f}°"
    )
    if not schreiben:
        logger.info("  (Probelauf — nichts geschrieben)")
        return True

    schluessel = f"{job_id}/tileset.json"
    tileset = get_json("tiles", schluessel)
    put_json("tiles", schluessel, apply_placement(tileset, neu))
    put_json("tiles", f"{job_id}/{PLACEMENT_FILE}", neu)
    logger.info("  geschrieben")
    return True


def _alle_punktwolken() -> list[str]:
    client = get_minio()
    return sorted(
        {
            obj.object_name.split("/", 1)[0]
            for obj in client.list_objects("tiles", recursive=True)
            if obj.object_name.endswith("/" + PLACEMENT_FILE)
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_ids", nargs="*", help="Nur diese Jobs (Standard: alle)")
    parser.add_argument("--schreiben", action="store_true", help="Änderungen wirklich speichern")
    args = parser.parse_args()

    jobs = args.job_ids or _alle_punktwolken()
    betroffen = sum(verorten(job_id, args.schreiben) for job_id in jobs)
    logger.info(f"\n{betroffen} von {len(jobs)} Tileset(s) betroffen.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
