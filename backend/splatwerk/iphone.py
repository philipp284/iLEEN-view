"""
Schwerkraft aus den Aufnahmedaten eines iPhones.

Jedes iPhone-Foto trägt im MakerNote den Beschleunigungsmesser (Tag 0x0008, drei Werte in g)
— im Ruhezustand also die Richtung der Schwerkraft im Gerät. Das ist die Hochachse der Szene,
gemessen statt aus der Rekonstruktion geraten: sie funktioniert auch, wenn das Telefon beim
Fotografieren gekippt wurde, und sie hat ein eindeutiges Vorzeichen.

Zwei Quellen führen zum selben Vektor: das MakerNote im EXIF der JPEG-/HEIC-Datei (`aus_exif`)
und die Begleitdatei von Aufnahme-Apps, die es schon aufgeschlüsselt ablegen (`{MakerApple}`,
Schlüssel „8“).

**Bezugssystem.** CoreMotion legt die Geräteachsen so: x nach rechts, y nach oben (zur
Hörmuschel), z aus dem Display heraus — bei hochgehaltenem Telefon. Die Hauptkamera sitzt auf
der Rückseite und blickt nach −z. Der Sensor liegt im Gerät quer; das Rohbild des Sensors hat
seine u-Achse (nach rechts) bei −y und seine v-Achse (nach unten) bei −x des Geräts. Aus dem
Rohbild wird das aufrechte Bild über die EXIF-Orientierung (`ORIENTIERUNG`), und das aufrechte
Bild ist das, was COLMAP sieht: x rechts, y unten, z nach vorn.
"""

from __future__ import annotations

import struct
from typing import Sequence

import numpy as np

_APPLE = b"Apple iOS\x00"
_TAG_BESCHLEUNIGUNG = 0x0008

# EXIF-Orientierung → (aufrecht-x, aufrecht-y) aus Rohbild (u, v), je als (Index, Vorzeichen).
# 1 = Rohbild ist aufrecht, 3 = 180°, 6 = 90° im Uhrzeigersinn drehen, 8 = 90° dagegen.
ORIENTIERUNG = {
    1: ((0, +1), (1, +1)),
    3: ((0, -1), (1, -1)),
    6: ((1, -1), (0, +1)),
    8: ((1, +1), (0, -1)),
}


def aus_makernote(roh: bytes) -> np.ndarray | None:
    """Beschleunigungsvektor (g) aus dem binären Apple-MakerNote, oder None."""
    if not roh or not roh.startswith(_APPLE) or len(roh) < 16:
        return None
    ende = ">" if roh[12:14] == b"MM" else "<" if roh[12:14] == b"II" else None
    if ende is None:
        return None
    try:
        (anzahl,) = struct.unpack_from(ende + "H", roh, 14)
        for k in range(min(anzahl, 200)):
            tag, typ, n, wert = struct.unpack_from(ende + "HHII", roh, 16 + 12 * k)
            if tag != _TAG_BESCHLEUNIGUNG:
                continue
            if typ != 10 or n != 3:        # drei vorzeichenbehaftete Brüche
                return None
            z = struct.unpack_from(ende + "6i", roh, wert)
            v = np.array([z[0] / z[1], z[2] / z[3], z[4] / z[5]], dtype=float)
            return v if np.all(np.isfinite(v)) else None
    except (struct.error, ZeroDivisionError):
        return None
    return None


def aus_exif(exif) -> np.ndarray | None:
    """Wie `aus_makernote`, gelesen aus einem `PIL.Image.Exif`."""
    try:
        return aus_makernote(bytes(exif.get_ifd(0x8769).get(0x927C) or b""))
    except Exception:
        return None


def aus_begleitdatei(metadaten: dict) -> np.ndarray | None:
    """Der Vektor aus der aufgeschlüsselten `{MakerApple}`-Sektion einer Begleitdatei."""
    werte = ((metadaten or {}).get("{MakerApple}") or {}).get("8")
    if isinstance(werte, Sequence) and len(werte) == 3:
        try:
            v = np.array([float(x) for x in werte])
            return v if np.all(np.isfinite(v)) else None
        except (TypeError, ValueError):
            return None
    return None


def hoch_im_bild(beschleunigung: np.ndarray, orientierung: int | None, rueckkamera: bool = True) -> list[float] | None:
    """
    „Oben“ im Kamerarahmen des aufrechten Bildes (x rechts, y unten, z nach vorn), Länge 1.

    `beschleunigung` ist die Schwerkraft im Gerät (zeigt nach unten); „oben“ ist ihr Gegenteil.
    Gibt None zurück, wenn die Orientierung gespiegelt ist, die Frontkamera aufgenommen hat
    (die blickt nach +z) oder der Vektor keine Schwerkraft sein kann (Länge weit von 1 g).
    """
    if not rueckkamera or beschleunigung is None:
        return None
    betrag = float(np.linalg.norm(beschleunigung))
    if not 0.7 <= betrag <= 1.4:
        return None
    zuordnung = ORIENTIERUNG.get(int(orientierung or 1))
    if zuordnung is None:
        return None
    hoch = -np.asarray(beschleunigung, dtype=float) / betrag      # Gerätrahmen
    roh = np.array([-hoch[1], -hoch[0], -hoch[2]])                # (u, v, nach vorn)
    (ix, sx), (iy, sy) = zuordnung
    bild = np.array([sx * roh[ix], sy * roh[iy], roh[2]])
    return [float(x) for x in bild]
