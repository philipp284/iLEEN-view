"""
Prüfstein für die Verortung projizierter Daten.

Eine Punktwolke in Landeskoordinaten wird nicht punktweise nach ECEF gerechnet,
sondern als starre Scheibe an einen Ort gehängt: `placement_from_projected()`
macht aus dem Schwerpunkt der Wolke einen Referenzpunkt und aus den beiden
Eigenheiten des Gitters — Meridiankonvergenz und Punktmaßstab — eine Drehung
und einen Maßstab. Das ist der Weg, der das Tileset im UI verschiebbar lässt.

Er steht und fällt mit zwei Vorzeichen. Ein falsches Vorzeichen bei der
Konvergenz dreht die Wolke um zwei Grad statt um null, ein falsches beim
Maßstab verdoppelt die Verzerrung statt sie aufzuheben — beides sieht auf dem
Bildschirm zunächst plausibel aus und fällt erst beim Vergleich mit dem
Luftbild auf. Der Test vergleicht deshalb gegen die exakte punktweise
Umrechnung durch pyproj: die Referenz, die der starre Weg annähert.

Was übrig bleibt, ist die Erdkrümmung — eine Ebene kann eine Kugelkappe nicht
treffen. Über die Ausdehnung einer Burg sind das Zentimeter.

Ausführen:  python3 tests/test_georef.py
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tiling import georef  # noqa: E402

_gut = True


def pruefe(bedingung: bool, text: str):
    global _gut
    print(f"  {'ok  ' if bedingung else 'FEHL'}  {text}")
    _gut = _gut and bedingung


# Schwerpunkt des Marksburg-Scans, UTM 32N. Die Zone reicht von 6° bis 12°,
# der Ort liegt mit 7,65° weit westlich des Mittelmeridians — dort ist die
# Konvergenz groß genug, um ein Vorzeichen zu entlarven.
_CRS = "EPSG:32632"
_X, _Y, _Z = 403627.13, 5569737.57, 153.55

# Ecken und Kanten einer Wolke von rund 380 × 465 × 180 m um den Schwerpunkt
_ECKEN = [
    (0, 0, 0),
    (200, 0, 0),
    (0, 200, 0),
    (-190, -232, -88),
    (190, 232, 90),
]


def _abweichungen() -> list[float]:
    """Abstand zwischen starrer Platzierung und exakter Umrechnung, in Metern."""
    from pyproj import CRS, Transformer

    platzierung = georef.placement_from_projected(_CRS, _X, _Y, _Z)
    # Für den Vergleich ohne Höhenbezug rechnen: pyproj liest Z als
    # Ellipsoidhöhe, die Geoidundulation ist hier nicht der Prüfgegenstand.
    matrix = georef.placement_matrix(
        platzierung["lon"],
        platzierung["lat"],
        _Z,
        platzierung["heading"],
        0.0,
        0.0,
        platzierung["scale"],
    )

    exakt = Transformer.from_crs(CRS.from_user_input(_CRS), CRS.from_epsg(4978), always_xy=True)
    abstaende = []
    for dx, dy, dz in _ECKEN:
        soll = np.array(exakt.transform(_X + dx, _Y + dy, _Z + dz))
        ist = (matrix @ np.array([dx, dy, dz, 1.0]))[:3]
        abstaende.append(float(np.linalg.norm(soll - ist)))
    return abstaende


print("Platzierung gegen punktweise Umrechnung")

abweichungen = _abweichungen()
for (dx, dy, dz), d in zip(_ECKEN, abweichungen):
    print(f"        {dx:+5} {dy:+5} {dz:+4} m  →  {d * 1000:6.1f} mm")

pruefe(abweichungen[0] < 1e-6, "der Schwerpunkt trifft exakt")
pruefe(max(abweichungen) < 0.05, "kein Punkt weicht um mehr als 5 cm ab")


print("\nDie beiden Gitterkorrekturen sind wirksam")

platzierung = georef.placement_from_projected(_CRS, _X, _Y, _Z)
pruefe(
    -1.1 < platzierung["heading"] < -0.9,
    f"Konvergenz {platzierung['heading']:+.4f}° — Gitternord liegt westlich von wahrem Nord",
)
pruefe(
    1.0002 < platzierung["scale"] < 1.0004,
    f"Maßstab {platzierung['scale']:.6f} — die UTM-Stauchung wird zurückgerechnet",
)
pruefe(
    platzierung["height_reference"] == "msl" and platzierung["height"] == _Z,
    "die Höhe gilt über NHN, unverändert aus der Quelle",
)
pruefe(
    abs(platzierung["lon"] - 7.6476) < 1e-3 and abs(platzierung["lat"] - 50.2719) < 1e-3,
    f"Ort {platzierung['lon']:.4f}/{platzierung['lat']:.4f} — Braubach am Mittelrhein",
)


print("\nOhne Korrekturen wäre der Fehler sichtbar")

roh = georef.placement_matrix(platzierung["lon"], platzierung["lat"], _Z)
from pyproj import CRS, Transformer  # noqa: E402

exakt = Transformer.from_crs(CRS.from_user_input(_CRS), CRS.from_epsg(4978), always_xy=True)
ecke = _ECKEN[-1]
soll = np.array(exakt.transform(_X + ecke[0], _Y + ecke[1], _Z + ecke[2]))
ohne = float(np.linalg.norm(soll - (roh @ np.array([*ecke, 1.0]))[:3]))
print(f"        an der Ecke {ecke}: {ohne:.2f} m statt {abweichungen[-1] * 1000:.0f} mm")
pruefe(ohne > 4.0, "ungedreht läge die Ecke meterweit daneben")


print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
