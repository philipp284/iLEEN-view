#!/usr/bin/env python3
"""
Den Guideline-Index für den gaeco-Export erzeugen.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

    python3 backend/scripts/gaeco_guideline_index.py \\
        ~/Projekte/gaeco/demodata/IFC/ifc4_3.guideline \\
        backend/data/gaeco/ifc_guideline_index.json

Die Guideline ist 311 MB JSON (Git LFS — ohne `git lfs pull` ist sie ein
131-Byte-Zeiger). Gebraucht werden davon zwei Dinge: welche IFC-Klassen sie
kennt und unter welchem Klarnamen sie jede Property führt. Das sind ein paar
hundert Kilobyte, die der Backend-Container beim Export liest, statt jedes Mal
1,6 GB Speicher für das Original aufzumachen.

Der Index liegt unter `backend/data/` und damit außerhalb von Git: er ist aus
gaecos Datei abgeleitet, und die steht unter gaecos Lizenz.
"""

import json
import sys
import time
from pathlib import Path

HIER = Path(__file__).resolve().parent
sys.path.insert(0, str(HIER.parent))

from ileen.gaeco_export import GuidelineIndex  # noqa: E402

VORGABE_QUELLE = Path.home() / "Projekte/gaeco/demodata/IFC/ifc4_3.guideline"
VORGABE_ZIEL = HIER.parent / "data/gaeco/ifc_guideline_index.json"


def main(argv: list[str]) -> int:
    quelle = Path(argv[1]) if len(argv) > 1 else VORGABE_QUELLE
    ziel = Path(argv[2]) if len(argv) > 2 else VORGABE_ZIEL
    if not quelle.exists():
        print(f"✗ {quelle} fehlt", file=sys.stderr)
        return 1
    if quelle.stat().st_size < 10_000:
        print(f"✗ {quelle} ist {quelle.stat().st_size} Byte groß — ein Git-LFS-Zeiger? "
              f"`git lfs pull` in ~/Projekte/gaeco", file=sys.stderr)
        return 1
    beginn = time.time()
    index = GuidelineIndex.aus_guideline(quelle)
    index["erzeugt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    ziel.parent.mkdir(parents=True, exist_ok=True)
    ziel.write_text(json.dumps(index, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"✓ {len(index['klassen'])} Klassen, {len(index['eigenschaften'])} Properties "
          f"→ {ziel} ({ziel.stat().st_size // 1024} kB, {time.time() - beginn:.1f} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
