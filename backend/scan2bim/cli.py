#!/usr/bin/env python3
"""
Scan2BIM von der Kommandozeile — derselbe Weg wie über die HTTP-Route.

    python3 -m scan2bim.cli --las scan.las --out ./ergebnis
    python3 -m scan2bim.cli --las scan.las --out ./ergebnis \\
            --referenz-job 95a481dd-… --netz adaptiv --toleranz 0.10

`--referenz-job` verweist auf dieselbe Punktwolke im Backend; daraus fällt die
Georeferenz exakt an (siehe README, Abschnitt „Platzierung"). Ohne sie bleibt
das Ergebnis im lokalen System der Wolke.

Wer das Ergebnis auch gleich ablegen will, nimmt besser die Route:
`POST /assets/{job_id}/scan2bim` erledigt Rechnung, Tiling und Platzierung in
einem Schritt und braucht nur die job_id der Wolke.
"""

import argparse
import json
import logging
from pathlib import Path

from . import lauf


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--las", required=True, type=Path, help="Punktwolke (LAS/LAZ)")
    p.add_argument("--out", required=True, type=Path, help="Ausgabeordner")
    p.add_argument("--projekt", default="Scan2BIM-Rekonstruktion")
    p.add_argument("--backend", default="http://localhost:8100")
    p.add_argument("--referenz-job", help="job_id derselben Punktwolke im Backend")
    p.add_argument("--netz", choices=("adaptiv", "fest"), default="adaptiv",
                   help="adaptiv: Stützpunkte nach Bedarf; fest: regelmäßiges Gitter")
    p.add_argument("--toleranz", type=float, default=0.15, metavar="M",
                   help="adaptiv: größte zugelassene Höhenabweichung in Metern")
    p.add_argument("--maschenweite", type=float, default=1.0, metavar="M",
                   help="fest: Kantenlänge der Maschen in Metern")
    p.add_argument("--max-stuetzpunkte", type=int, default=60000)
    a = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    einstellungen = lauf.Einstellungen(
        projekt=a.projekt, netz_modus=a.netz, maschenweite_m=a.maschenweite,
        toleranz_m=a.toleranz, max_stuetzpunkte=a.max_stuetzpunkte,
        referenz_tileset=(f"{a.backend}/tiles/{a.referenz_job}/tileset.json"
                          if a.referenz_job else None))

    def melden(anteil, text):
        print(f"  [{anteil * 100:3.0f} %] {text}", flush=True)

    bericht = lauf.ausfuehren(a.las, a.out, einstellungen, melden=melden)
    print(json.dumps(bericht, indent=1, ensure_ascii=False))
    if a.referenz_job:
        for art in ("ifc", "glb"):
            stelle = lauf.platzierung(a.out, art)
            if stelle:
                print(f"Platzierung {art.upper()}: "
                      f"lon {stelle['lon']:.7f} lat {stelle['lat']:.7f} "
                      f"h {stelle['height']:.2f} heading {stelle['heading']:.3f}")
    print(f"Fertig. Ergebnisse in {a.out}")


if __name__ == "__main__":
    main()
