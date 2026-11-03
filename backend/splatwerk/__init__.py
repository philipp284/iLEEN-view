"""
Splatwerk — Fotos oder Laserscan hinein, verorteter Gaussian Splat heraus.

Das Paket hat drei Hälften, die an verschiedenen Orten laufen:

* **Im Container** (`cesium-api`): `scan2gs` (LAS → 3DGS-PLY, ohne Training),
  `sog` (PLY → SOG-Export), `auftrag` (die Warteschlange als Verzeichnis) und
  die Übernahme fertiger Splats in die Kachel-Pipeline.
* **Auf dem Mac-Host**: `worker` — COLMAP und Brush brauchen die Metal-GPU, die
  Docker Desktop nicht durchreicht.
* **Auf beiden**: `georef` und `colmap_modell` — reines NumPy, damit der Worker
  ohne das schwere Backend-Image auskommt und der Container dieselbe
  Rechnung für die Platzierung benutzt.

Der Container und der Worker reden nur über Dateien (`data/training/`), nie
über ein Netz: die Warteschlange überlebt damit jeden Neustart der einen oder
anderen Seite.
"""
