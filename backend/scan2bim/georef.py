"""
Georeferenz aus dem Tileset einer bereits abgelegten Punktwolke.

Der genaueste verfügbare Bezug — und der Grund, warum ein rekonstruiertes
Modell hier ohne Nacharbeit deckungsgleich auf seiner Quellwolke liegt. Details
zur Herleitung stehen in der README, Abschnitt „Platzierung".
"""

import json
import math
import urllib.request

import numpy as np

#
# Der genaueste verfügbare Bezug. Der `transform` der Tileset-Wurzel bildet das
# lokale System der Wolke nach ECEF ab — daraus fallen Lage, Höhe und Drehung
# exakt an, statt über eine Handeinpassung geschätzt zu werden. Wer das Modell
# später neben die Wolke legt, sieht keinen Versatz, weil beide aus derselben
# Matrix kommen.

def georeferenz_aus_tileset(tileset, las_bbox: dict) -> dict:
    from pyproj import Transformer

    # `tileset` darf das geladene Dokument sein oder eine URL darauf. Im
    # Backend liegt es ohnehin schon vor; über die Kommandozeile ist die URL
    # der bequemere Weg.
    if isinstance(tileset, str):
        with urllib.request.urlopen(tileset) as antwort:
            tileset = json.load(antwort)
    T = np.array(tileset["root"]["transform"]).reshape(4, 4).T
    R, ursprung = T[:3, :3], T[:3, 3]

    # Die Tileset-Wurzel sitzt in der Mitte der Bounding Box (XY) auf halber Höhe.
    lo = np.array(las_bbox["lo"])
    hi = np.array(las_bbox["hi"])
    anker = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2])

    nach_grad = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True)

    def welt(lokal):
        lon, lat, h = nach_grad.transform(*(R @ (np.asarray(lokal) - anker) + ursprung))
        return dict(lon=lon, lat=lat, hoehe=h)

    nullpunkt = welt([0, 0, 0])
    nach_utm = Transformer.from_crs("EPSG:4326", "EPSG:25832", always_xy=True)
    ost, nord = nach_utm.transform(nullpunkt["lon"], nullpunkt["lat"])
    konvergenz = math.degrees(math.atan(
        math.tan(math.radians(nullpunkt["lon"] - 9.0)) * math.sin(math.radians(nullpunkt["lat"]))))

    # Azimut der lokalen X-Achse, einmal geografisch, einmal im UTM-Gitter.
    la, lo_ = math.radians(nullpunkt["lat"]), math.radians(nullpunkt["lon"])
    ost_r = np.array([-math.sin(lo_), math.cos(lo_), 0])
    nord_r = np.array([-math.sin(la) * math.cos(lo_), -math.sin(la) * math.sin(lo_), math.cos(la)])
    x_achse = R[:, 0]
    azimut = math.degrees(math.atan2(x_achse @ ost_r, x_achse @ nord_r)) % 360
    y_achse = R[:, 1]
    heading = math.degrees(math.atan2(y_achse @ ost_r, y_achse @ nord_r)) % 360
    gitter = (azimut - konvergenz) % 360

    return dict(anker=anker.tolist(), R=R.tolist(), ursprung=ursprung.tolist(),
                nullpunkt=nullpunkt, utm_ost=ost, utm_nord=nord, heading=heading,
                gitter_azimut=gitter,
                x_abszisse=math.sin(math.radians(gitter)),
                x_ordinate=math.cos(math.radians(gitter)))


def weltpunkt(geo: dict, lokal) -> dict:
    """Weltlage eines lokalen Punktes — für die Platzierung im Backend."""
    from pyproj import Transformer
    R = np.array(geo["R"])
    lon, lat, h = Transformer.from_crs("EPSG:4978", "EPSG:4979", always_xy=True).transform(
        *(R @ (np.asarray(lokal) - np.array(geo["anker"])) + np.array(geo["ursprung"])))
    return dict(lon=lon, lat=lat, height=h)
