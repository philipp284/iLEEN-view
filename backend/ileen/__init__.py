"""
Brücke von iLEEN zu JAX-FEM.

Der Zeichenmodus in `~/Projekte/iLEEN/frontend` exportiert das statische
System eines Grundrisses als JSON (`…_FEM.json`, Schema `ileen.plan.fem/1.0`).
Dieses Paket liest die Datei, baut daraus ein Netz und rechnet die Decke
lastfallweise durch — als Platte, als Scheibe und bis zur Bewehrung.

    from ileen import plate, scheibe, beton
    from ileen.loeser import Loeser, kombiniere

    modell = plate.lade("Grundriss_EG_FEM.json")
    netz   = plate.vernetze(modell)
    bc, _  = plate.randbedingungen(modell, netz)

    loeser = Loeser(netz, E, nu, bc)                  # einmal zerlegen
    u, f   = loeser.loese_alle(plate.einzelfelder(modell, netz))
    u_d    = kombiniere(u, plate.kombinationen(modell)["GZT · Leit: Nutzlast"])

| Modul | Aufgabe |
|---|---|
| `plate`    | Einlesen, Netz, Lasten, Kombinationen, Momente, Querkräfte |
| `loeser`   | eine Zerlegung, viele Lastfälle, Auflagerkräfte, Superposition |
| `scheibe`  | Wind und Schiefstellung, Aussteifung, Membrankräfte |
| `unterzug` | Balkenschnittgrößen aus dem Volumenmodell, Plattenbalkenbemessung |
| `beton`    | Bemessung nach EC2: Biegung, Querkraft, Staffelung, Rissbreite |
| `werkstoff`| Beton, Holz, Stahl als Steifigkeitsmatrix und Spannungsnachweis |
| `volumen`  | einzelne Bauteile räumlich: Voxelnetz, mehrere Werkstoffe, Spannungsfeld |

`plate` und `volumen` beantworten verschiedene Fragen. `plate` rechnet eine
Decke als Fläche und bemisst sie; `volumen` rechnet ein oder mehrere
**Bauteile** als Kontinuum — mit richtungsabhängigem Werkstoff (Holz), mit
mehreren Stoffen in einem Netz und mit einem Spannungsfeld als Ergebnis. Der
Löser ist derselbe.

`plate` und `unterzug` teilen sich die Decke: `plate` wertet die Fläche je
Meter aus und setzt im Streifen eines Unterzugs NaN, `unterzug` integriert
dort über den ganzen Querschnitt und bemisst ihn als Plattenbalken.

Siehe `Notebooks/iLEEN_Plattenstatik.ipynb` für den vollständigen Ablauf.
"""

from . import plate  # noqa: F401
from . import beton  # noqa: F401
from . import scheibe  # noqa: F401
from . import unterzug  # noqa: F401
from . import werkstoff  # noqa: F401
from . import volumen  # noqa: F401

# `volumen_ifc` steht bewusst nicht dabei: es zieht IfcOpenShell herein, und
# das Paket soll ohne eine IFC-Datei benutzbar bleiben — etwa im Notebook.
__all__ = ["plate", "beton", "scheibe", "unterzug", "loeser",
           "werkstoff", "volumen"]
