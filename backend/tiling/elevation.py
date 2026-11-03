"""
Höhenbezug: Gelände und Geoid → ellipsoidische Höhe.

3D Tiles rechnen in ECEF, die Höhe im `root.transform` ist deshalb immer eine
Höhe über dem **WGS84-Ellipsoid**. Damit arbeitet aber niemand: Bauwerke sind
in Metern über NHN geplant, und CesiumJS zeigt sie auf Cesium World Terrain,
dessen Oberfläche ihrerseits ellipsoidisch referenziert ist.

Am Referenzpunkt in Mainz sind das zwei getrennte Beträge:

    Geländeoberkante   131 m ü. NHN      (Copernicus DEM)
  + Geoidundulation     47,6 m           (EGM2008, hier nahezu konstant)
  = ellipsoidische Höhe 178,6 m

Ein Modell, das mit `TILESET_ORIGIN_HEIGHT=90` als Ellipsoidhöhe verortet
wurde, lag deshalb knapp 90 m unter dem Gelände. Dieses Modul löst die beiden
Anteile auf, sodass die eingegebene Höhe wahlweise über Gelände, über NHN oder
über dem Ellipsoid gemeint sein darf.

**Die Undulation ist eine Konstante, kein Gitter.** Sie ändert sich in
Deutschland um weniger als einen Meter über 50 km; ein EGM-Gitter im Container
wäre ein Megabyte Datenhaltung für einen Effekt unterhalb der Genauigkeit, mit
der ein IFC-Nullpunkt ohnehin angegeben ist. Für andere Regionen wird
`GEOID_UNDULATION_M` gesetzt.
"""

import logging
import os

logger = logging.getLogger(__name__)

# Höhenbezug der eingegebenen Höhe
TERRAIN = "terrain"     # über Geländeoberkante
MSL = "msl"             # über NHN / Meeresspiegel (Geoid)
ELLIPSOID = "ellipsoid"  # roh, wie im Transform
REFERENCES = (TERRAIN, MSL, ELLIPSOID)

_DEFAULT_API = "https://api.open-meteo.com/v1/elevation"
_TIMEOUT = 6.0

# Geländeabfragen sind langsam und wiederholen sich beim Feinjustieren im UI
_cache: dict[tuple[float, float], float | None] = {}


def _local_ground_msl(lon: float, lat: float) -> float | None:
    """Höhe über NHN aus der lokalen Geländereferenz, `None` ohne Treffer."""
    from tiling import terrain  # spät importiert: terrain.py nutzt elevation.py selbst

    local = terrain.sample_ellipsoid(lon, lat)
    return None if local is None else local - geoid_undulation()


def geoid_undulation() -> float:
    """Höhe des Geoids über dem Ellipsoid am Standort, in Metern."""
    return float(os.getenv("GEOID_UNDULATION_M", "0"))


def default_reference() -> str:
    """Bezug, in dem `TILESET_ORIGIN_HEIGHT` gemeint ist."""
    reference = os.getenv("TILESET_ORIGIN_HEIGHT_REFERENCE", ELLIPSOID).strip().lower()
    if reference not in REFERENCES:
        logger.warning(f"Unbekannter Höhenbezug '{reference}' — nutze '{ELLIPSOID}'.")
        return ELLIPSOID
    return reference


def ground_msl(lon: float, lat: float) -> float | None:
    """
    Geländehöhe über NHN, `None` wenn nicht ermittelbar.

    Zuerst die lokale Geländereferenz (`tiling/terrain.py`), falls jemand ein
    eigenes Modell dafür markiert hat — deutlich genauer als das globale DEM
    und exakt das, was am Standort tatsächlich hochgeladen wurde. Nur außerhalb
    ihrer Abdeckung (oder ganz ohne Referenz) greift der externe DEM-Dienst.
    Der ist über `ELEVATION_API_URL` austauschbar und mit einem leeren Wert
    abschaltbar — der Rest des Stacks läuft ohne Internet, das soll so bleiben.
    Fehler sind nie fatal: ohne Antwort bleibt es beim Geoidbezug.
    """
    local = _local_ground_msl(lon, lat)
    if local is not None:
        return local

    url = os.getenv("ELEVATION_API_URL", _DEFAULT_API)
    if not url:
        return None

    key = (round(lon, 5), round(lat, 5))
    if key in _cache:
        return _cache[key]

    try:
        import httpx

        response = httpx.get(
            url, params={"latitude": lat, "longitude": lon}, timeout=_TIMEOUT
        )
        response.raise_for_status()
        elevations = response.json().get("elevation") or []
        value = float(elevations[0]) if elevations else None
    except Exception as e:
        logger.warning(f"Geländehöhe für {lat:.5f}/{lon:.5f} nicht abrufbar: {e}")
        value = None

    _cache[key] = value
    return value


def ground_ellipsoid(lon: float, lat: float) -> float | None:
    """Geländeoberkante über dem Ellipsoid — das, was Cesium World Terrain zeigt."""
    msl = ground_msl(lon, lat)
    return None if msl is None else msl + geoid_undulation()


def to_ellipsoid(height: float, reference: str, lon: float, lat: float) -> float:
    """
    Rechnet eine Höhe im angegebenen Bezug in eine Ellipsoidhöhe um — der
    einzige Wert, mit dem `root.transform` etwas anfangen kann.
    """
    if reference == ELLIPSOID:
        return height

    undulation = geoid_undulation()
    if reference == MSL:
        return height + undulation

    ground = ground_ellipsoid(lon, lat)
    if ground is None:
        # Ohne DEM bleibt der Geoid als beste verfügbare Näherung: das Modell
        # liegt dann auf Meeresniveau statt auf dem Gelände, aber nicht im
        # Erdinneren — und im UI ist der Wert eine Korrektur weit.
        logger.warning("Keine Geländehöhe verfügbar — Höhe wird auf NHN bezogen.")
        return height + undulation
    return height + ground
