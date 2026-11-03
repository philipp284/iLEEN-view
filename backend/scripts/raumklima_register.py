"""
Schreibt `data/sensoren_raeume.csv` aus den Räumen eines IFC-Modells im Backend.

    python3 scripts/raumklima_register.py                       # Campus-IFC mit Räumen, Standard
    python3 scripts/raumklima_register.py --job <job_id>
    python3 scripts/raumklima_register.py --raeume rooms.json   # Datei statt Backend

Das Register ist deterministisch aus der Raumliste abgeleitet; es wandert mit in Git,
damit der Generator und die Zeitreihe ohne laufendes Backend dasselbe sehen.
"""

import argparse
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import raumklima

CAMPUS_JOB = "bf9da2a7-bf46-4add-ae3a-426cbe9153c4"   # HSMAINZ_CAMPUS_IFC_Raeume_TGA


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--job", default=CAMPUS_JOB)
    p.add_argument("--backend", default="http://localhost:8100")
    p.add_argument("--raeume", help="Raumliste als JSON-Datei statt aus dem Backend")
    a = p.parse_args()

    if a.raeume:
        raeume = json.load(open(a.raeume, encoding="utf-8"))
    else:
        url = f"{a.backend.rstrip('/')}/assets/{a.job}/rooms"
        with urllib.request.urlopen(url, timeout=300) as antwort:
            raeume = json.loads(antwort.read())
    zeilen = raumklima.register_aus_raeumen(raeume)
    pfad = raumklima.register_schreiben(zeilen)
    # Welches Modell die Räume liefert — die Anzeige holt dort die Grundrisse.
    meta = {"job_id": a.job, "raeume": len({z["raum_guid"] for z in zeilen}), "sensoren": len(zeilen)}
    (pfad.parent / "sensoren_raeume.meta.json").write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")

    je_profil = {}
    for z in zeilen:
        je_profil.setdefault(z["profil"], set()).add(z["raum_guid"])
    print(f"{len(zeilen)} Sensoren in {len({z['raum_guid'] for z in zeilen})} Räumen → {pfad}")
    for profil, guids in sorted(je_profil.items()):
        print(f"  {profil:13s} {len(guids):4d} Räume")


if __name__ == "__main__":
    main()
