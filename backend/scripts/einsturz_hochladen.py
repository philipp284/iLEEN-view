"""
Ein Einsturzpaket (Format „ileen-einsturz“) zu einem Modell hochladen und andocken.

    python3 scripts/einsturz_hochladen.py <paketordner> --modell "Lux Pavillon"
    python3 scripts/einsturz_hochladen.py ~/Projekte/Statik-LUX/kollaps/stb/ileen/ist --modell 43fe32ef

`--modell` nimmt einen Teil des Dateinamens oder den Anfang der job_id. Der
Paketname ist der Ordnername, sofern `--paket` nichts anderes sagt. Geht nur
über HTTP gegen das Backend — keine MinIO-Zugangsdaten nötig, und derselbe
Aufruf funktioniert gegen einen entfernten Server.

Nach dem Hochladen rechnet das Backend den Bezug aus den Ankern des Pakets
(`POST …/andocken`) und schreibt ihn in die einsturz.json. Passt das Paket
nicht zum Modell, bricht dieser Schritt mit der gemessenen Streuung ab.
"""

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def _anfrage(methode: str, url: str, daten: bytes | None = None, art: str = "application/octet-stream"):
    req = urllib.request.Request(url, data=daten, method=methode)
    if daten is not None:
        req.add_header("Content-Type", art)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as fehler:
        text = fehler.read().decode("utf-8", "replace")
        try:
            text = json.loads(text).get("detail", text)
        except ValueError:
            pass
        sys.exit(f"✗ {methode} {url}: {fehler.code} {text}")


def modell_finden(backend: str, suche: str) -> tuple[str, str]:
    assets = _anfrage("GET", f"{backend}/assets/")
    treffer = [a for a in assets
               if a["job_id"].startswith(suche) or suche.lower() in (a.get("name") or "").lower()]
    ifc = [a for a in treffer if a.get("content_type") == "ifc"] or treffer
    if not ifc:
        sys.exit(f"✗ Kein Modell zu „{suche}“ auf {backend}")
    if len(ifc) > 1:
        namen = "\n  ".join(f"{a['job_id'][:8]}  {a['name']}" for a in ifc)
        sys.exit(f"✗ „{suche}“ ist mehrdeutig:\n  {namen}")
    return ifc[0]["job_id"], ifc[0]["name"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ordner", type=Path)
    ap.add_argument("--modell", required=True, help="Teil des Modellnamens oder Anfang der job_id")
    ap.add_argument("--paket", help="Name der Ablage (Standard: Ordnername)")
    ap.add_argument("--backend", default="http://localhost:8100")
    a = ap.parse_args()

    kopf_pfad = a.ordner / "einsturz.json"
    if not kopf_pfad.is_file():
        sys.exit(f"✗ {kopf_pfad} fehlt — ist das ein Einsturzpaket?")
    kopf = json.loads(kopf_pfad.read_text())
    if kopf.get("format") != "ileen-einsturz":
        sys.exit("✗ einsturz.json ist nicht im Format ileen-einsturz")
    paket = a.paket or a.ordner.name
    job, name = modell_finden(a.backend, a.modell)
    basis = f"{a.backend}/einsturz/{job}/{paket}"
    print(f"Modell {name} ({job[:8]}), Paket {paket}")

    dateien = [kopf["geometrie"]["datei"]] + [s["datei"] for s in kopf["szenarien"]]
    for d in dateien:
        roh = (a.ordner / d).read_bytes()
        _anfrage("PUT", f"{basis}/{d}", roh)
        print(f"  {d}: {len(roh) / 1e6:.1f} MB")
    _anfrage("PUT", f"{basis}/einsturz.json", kopf_pfad.read_bytes(), "application/json")
    print("  einsturz.json")

    bezug = _anfrage("POST", f"{basis}/andocken")
    v = bezug["verschiebung"]
    print(f"Angedockt: Verschiebung ({v[0]:.4f}; {v[1]:.4f}; {v[2]:.4f}) m, "
          f"Streuung {bezug['streuung_m'] * 1000:.3f} mm über {bezug['zur_probe']} von "
          f"{bezug['gemeinsame_bauteile']} gemeinsamen Bauteilen")


if __name__ == "__main__":
    main()
