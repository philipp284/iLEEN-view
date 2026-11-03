"""
Ersatz für `gmsh` auf Plattformen, für die es kein Wheel gibt.

**Warum das nötig ist.** `jax_fem.generate_mesh` importiert `gmsh` auf
Modulebene, `jax_fem.problem` importiert `generate_mesh` — ohne das Modul
lässt sich also nicht einmal der Löser laden. gmsh liefert auf PyPI aber nur
Wheels für Linux-x86_64 und macOS-arm64; auf einem Linux-arm64-Container
(Apple Silicon, Ampere, Graviton) gibt es keins, und aus den Quellen zu bauen
hieße OpenCASCADE mitzuübersetzen.

**Warum das vertretbar ist.** Der Rechenweg dieses Projekts braucht gmsh
nicht. `plate.vernetze()` legt ein Raster über den Systemumriss und verwirft
Zellen, deren Mittelpunkt außerhalb liegt — für rechteckige und L-förmige
Deckenfelder ist das exakt, nur schräge Ränder bekommen eine Treppe. gmsh
kommt allein in `plate.vernetze_gmsh()` vor, der randtreuen Alternative, und
in den Beispielnetzen von JAX-FEM (`box_mesh_gmsh`, `cylinder_mesh_gmsh`).
Alle drei liegen außerhalb von `ileen.rechnung`.

Der Ersatz überlebt deshalb den Import und bricht erst beim ersten
tatsächlichen Zugriff ab — mit einem Satz, der sagt, was zu tun ist, statt mit
einem AttributeError zwanzig Ebenen tiefer.

Eingesetzt wird er vom Dockerfile, und nur dann, wenn das echte Paket fehlt.
"""

_GRUND = (
    "gmsh ist in dieser Umgebung nicht verfügbar (kein Wheel für Linux-arm64). "
    "Die Plattenrechnung braucht es nicht — sie vernetzt über plate.vernetze() "
    "mit einem Raster. Wer plate.vernetze_gmsh() oder die gmsh-Beispielnetze "
    "von JAX-FEM benutzen will, muss den Container auf linux/amd64 bauen "
    "(platform: linux/amd64 in docker-compose.yml) oder gmsh aus den Quellen "
    "übersetzen."
)


def __getattr__(name: str):
    # Modulweites __getattr__ (PEP 562): greift bei *jedem* Zugriff, den es
    # sonst nicht gäbe — `gmsh.initialize`, `gmsh.model`, `gmsh.option`.
    raise ModuleNotFoundError(f"{_GRUND} (angefragt: gmsh.{name})")
