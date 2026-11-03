"""
Prüfstein für die Verortung einer Foto-Rekonstruktion (`splatwerk/georef.py`).

COLMAP liefert Kameras in einem willkürlichen Rahmen, die GPS-Positionen der Bilder
liefern ein Rauschen von mehreren Metern. Aus beidem soll eine Transformation in
ein lokales Ost/Nord/Oben-System werden — und sie soll an den Stellen ehrlich
bleiben, wo die Daten nicht reichen.

Jeder Fall unten stellt eine Aufnahmesituation synthetisch nach, mit bekannter
Wahrheit, und prüft, was herauskommt:

  1. Handyrundgang ums Haus: GPS-Höhe streut um ±8 m. Die Hochachse muss aus den
     Kameras kommen, nicht aus den Höhen — sonst kippt das Modell um mehrere Grad.
  2. Drohnenraster, Kamera nach unten, alle in dieselbe Richtung: Aus den Bildern
     ist „oben“ nicht ablesbar, die GPS-Höhen (genau) müssen es liefern.
  3. Objektumrundung auf 3 m: Basislinie kleiner als das Rauschen. Ort ja,
     Maßstab nein — und das muss auch so gemeldet werden.
  4. Ohne jedes GPS: Annahmen, deutlich benannt.
  5. Ausreißer im GPS (60 m daneben) dürfen die Anpassung nicht ziehen.
  6. ECEF/ENU stimmen mit der Matrix überein, die das Backend für Cesium benutzt.

Ausführen:  python3 tests/test_splat_georef.py
"""

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from splatwerk import georef  # noqa: E402

_gut = True


def pruefe(bedingung: bool, text: str):
    global _gut
    print(f"  {'ok  ' if bedingung else 'FEHL'}  {text}")
    _gut = _gut and bedingung


LAT0, LON0, H0 = 50.2688, 7.6491, 170.0   # Marksburg
RNG = np.random.default_rng(3)


def zufallsdrehung():
    q = RNG.normal(size=4)
    q /= np.linalg.norm(q)
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def kameras(pos_enu, ziel_enu, nadir_richtung=None):
    """Rechts-/Oben-Vektoren aufrechter Kameras, die auf `ziel_enu` schauen (ENU-Rahmen)."""
    up = np.array([0.0, 0.0, 1.0])
    rechts, oben = [], []
    for p, z in zip(pos_enu, ziel_enu):
        f = (z - p) / np.linalg.norm(z - p)
        if nadir_richtung is not None:
            f = np.array([0.0, 0.0, -1.0])
            r = np.cross(nadir_richtung, f)           # Flugrichtung nach „oben im Bild“
            r /= np.linalg.norm(r)
        else:
            r = np.cross(f, up)
            r /= np.linalg.norm(r)
        o = np.cross(r, f)
        rechts.append(r)
        oben.append(o)
    return np.array(rechts), np.array(oben)


def in_colmap_rahmen(zentren, rechts, oben, s, rot, t):
    """Wahrheit → COLMAP-Rahmen: X' = s·R·X + t; Richtungen drehen nur."""
    return s * zentren @ rot.T + t, rechts @ rot.T, oben @ rot.T


def als_gps(enu, sigma_h, sigma_z, ausreisser=0):
    lat, lon, h = georef.von_enu(enu, LAT0, LON0, H0)
    n = len(enu)
    rauschen = RNG.normal(0, sigma_h, (n, 2))
    rauschen_z = RNG.normal(0, sigma_z, n)
    for i in RNG.choice(n, ausreisser, replace=False) if ausreisser else []:
        rauschen[i] += 60.0
    lat = lat + np.degrees(rauschen[:, 1] / 6371000.0)
    lon = lon + np.degrees(rauschen[:, 0] / (6371000.0 * math.cos(math.radians(LAT0))))
    return [{"lat": float(a), "lon": float(b), "hoehe": float(c), "genauigkeit_m": sigma_h * 1.5}
            for a, b, c in zip(lat, lon, h + rauschen_z)]


def winkel(a, b):
    return math.degrees(math.acos(float(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1))))


def wahrheit_im_ursprung(erg, pos_enu):
    """Die wahren Positionen (ENU am Marksburg-Punkt) im ENU-Rahmen, den `ausrichtung` gewählt hat."""
    u = erg["ursprung"]
    lat, lon, h = georef.von_enu(pos_enu, LAT0, LON0, H0)
    return georef.nach_enu(lat, lon, h, u["lat"], u["lon"], u["hoehe"] or 0.0)


def anwenden(erg, pts):
    m = np.array(erg["matrix"])
    return pts @ m[:3, :3].T + m[:3, 3]


# ── Geodäsie ──────────────────────────────────────────────────────────────────
print("Geodäsie")
p = georef.geodaetisch_nach_ecef(LAT0, LON0, H0)
lat, lon, h = georef.ecef_nach_geodaetisch(p)
pruefe(abs(lat - LAT0) < 1e-9 and abs(lon - LON0) < 1e-9 and abs(h - H0) < 1e-4,
       "ECEF → WGS84 kehrt auf Millimeter zurück")
enu = np.array([120.0, -80.0, 15.0])
la, lo, hh = georef.von_enu(enu, LAT0, LON0, H0)
pruefe(np.allclose(georef.nach_enu(la, lo, hh, LAT0, LON0, H0), enu, atol=1e-6),
       "ENU → WGS84 → ENU ist die Identität")
try:
    from tiling.georef import enu_transform
    m = np.array(enu_transform(LON0, LAT0, H0), float).reshape(4, 4).T
    ecef_cesium = (m @ np.array([*enu, 1.0]))[:3]
    ecef_hier = georef.geodaetisch_nach_ecef(la, lo, hh)
    pruefe(np.linalg.norm(ecef_cesium - ecef_hier) < 1e-3,
           "dieselbe Matrix wie tiling.georef.enu_transform (Cesium eastNorthUp)")
except Exception as e:  # tiling.georef braucht Backend-Abhängigkeiten
    print(f"  ----  Gegenprobe zu tiling.georef übersprungen ({type(e).__name__})")

# ── 1. Handyrundgang ──────────────────────────────────────────────────────────
print("1. Handyrundgang: GPS-Höhe streut, Hochachse muss aus den Kameras kommen")
w = np.linspace(0, 2 * math.pi, 70, endpoint=False)
pos = np.stack([30 * np.cos(w), 30 * np.sin(w), np.full(70, 1.6)], axis=1)
ziel = np.tile([0.0, 0.0, 6.0], (70, 1))
r_e, o_e = kameras(pos, ziel)
s_c, rot_c, t_c = 0.37, zufallsdrehung(), np.array([5.0, -3.0, 11.0])
z_c, r_c, o_c = in_colmap_rahmen(pos, r_e, o_e, s_c, rot_c, t_c)
erg = georef.ausrichtung(z_c, r_c, o_c, als_gps(pos, sigma_h=4.0, sigma_z=8.0, ausreisser=4))
pruefe(erg["modus"] == "schwerkraft_gps", f"Weg: Schwerkraft + waagerechtes GPS (war: {erg['modus']})")
pruefe(abs(erg["massstab"] * s_c - 1.0) < 0.06, f"Maßstab auf 6 % (Faktor {erg['massstab'] * s_c:.3f})")
rück = anwenden(erg, z_c)
wahr = wahrheit_im_ursprung(erg, pos)
pruefe(np.linalg.norm((rück - wahr)[:, :2], axis=1).mean() < 6.0,
       f"Kamerapositionen im Mittel {np.linalg.norm((rück - wahr)[:, :2], axis=1).mean():.1f} m von der Wahrheit")
pruefe(winkel(np.array(erg["matrix"])[:3, :3] @ (rot_c @ [0, 0, 1]), [0, 0, 1]) < 1.0,
       "Hochachse auf 1° genau (trotz ±8 m GPS-Höhe)")
pruefe(erg["massstab_bekannt"] and erg["drehung_bekannt"], "Maßstab und Himmelsrichtung gelten als bekannt")

# ── 2. Drohnenraster ──────────────────────────────────────────────────────────
print("2. Drohnenraster, Kamera nach unten, alle gleich ausgerichtet")
gx, gy = np.meshgrid(np.linspace(-80, 80, 9), np.linspace(-60, 60, 7))
pos = np.stack([gx.ravel(), gy.ravel(), np.full(gx.size, 60.0)], axis=1)
ziel = pos * [1, 1, 0]
r_e, o_e = kameras(pos, ziel, nadir_richtung=np.array([0.0, 1.0, 0.0]))
s_c, rot_c, t_c = 2.4, zufallsdrehung(), np.array([-7.0, 4.0, 2.0])
z_c, r_c, o_c = in_colmap_rahmen(pos, r_e, o_e, s_c, rot_c, t_c)
hoch, guete = georef.hochachse_aus_kameras(r_c, o_c)
pruefe(hoch is None, f"aus Nadirbildern ist keine Hochachse ablesbar ({guete.get('grund')})")
erg = georef.ausrichtung(z_c, r_c, o_c, als_gps(pos, 1.0, 0.3), drohne=True)
pruefe(erg["modus"] == "gps_3d", f"Weg: 3D-Anpassung an GPS (war: {erg['modus']})")
rück = anwenden(erg, z_c)
wahr = wahrheit_im_ursprung(erg, pos)
pruefe(np.linalg.norm(rück - wahr, axis=1).mean() < 2.0,
       f"Positionen im Mittel {np.linalg.norm(rück - wahr, axis=1).mean():.2f} m von der Wahrheit (auch in der Höhe)")
pruefe(abs(erg["massstab"] * s_c - 1.0) < 0.02, f"Maßstab auf 2 % (Faktor {erg['massstab'] * s_c:.4f})")

# ── 3. Objektumrundung ────────────────────────────────────────────────────────
print("3. Objekt auf 3 m Radius: Basislinie kleiner als das GPS-Rauschen")
w = np.linspace(0, 2 * math.pi, 60, endpoint=False)
pos = np.stack([1.5 * np.cos(w), 1.5 * np.sin(w), np.full(60, 1.3)], axis=1)
ziel = np.tile([0.0, 0.0, 0.8], (60, 1))
r_e, o_e = kameras(pos, ziel)
s_c, rot_c, t_c = 4.2, zufallsdrehung(), np.array([1.0, 2.0, 3.0])
z_c, r_c, o_c = in_colmap_rahmen(pos, r_e, o_e, s_c, rot_c, t_c)
erg = georef.ausrichtung(z_c, r_c, o_c, als_gps(pos, 4.0, 6.0))
pruefe(erg["modus"] == "schwerkraft", f"Weg: nur Schwerkraft (war: {erg['modus']})")
pruefe(not erg["massstab_bekannt"], "Maßstab als unbekannt gemeldet")
pruefe(erg["ursprung"] is not None and abs(erg["ursprung"]["lat"] - LAT0) < 1e-3, "Ort aus dem Mittel der Bilder")
pruefe(winkel(np.array(erg["matrix"])[:3, :3] @ (rot_c @ [0, 0, 1]), [0, 0, 1]) < 1.0,
       "Hochachse trotzdem aus den Kameras auf 1° genau")
pruefe(any("Maßstab" in h for h in erg["hinweise"]), "Hinweis erklärt, was fehlt")

# ── 4. Ohne GPS ───────────────────────────────────────────────────────────────
print("4. Ohne jedes GPS, Nadirbilder")
erg = georef.ausrichtung(z_c, np.tile(r_c[0], (60, 1)), np.tile(o_c[0], (60, 1)), [None] * 60)
pruefe(erg["modus"] == "annahme", f"Weg: Annahme (war: {erg['modus']})")
pruefe(erg["ursprung"] is None, "kein Ursprung erfunden")
m = np.array(erg["matrix"])
pruefe(np.allclose(m[:3, :3] @ m[:3, :3].T, np.eye(3)) and np.linalg.det(m[:3, :3]) > 0,
       "Annahme-Matrix ist eine echte Drehung (keine Spiegelung)")

# ── 5. Ausreißer ──────────────────────────────────────────────────────────────
print("5. Zehn Prozent der GPS-Positionen 60 m daneben")
w = np.linspace(0, 2 * math.pi, 80, endpoint=False)
pos = np.stack([40 * np.cos(w), 40 * np.sin(w), np.full(80, 1.6)], axis=1)
r_e, o_e = kameras(pos, np.tile([0.0, 0.0, 5.0], (80, 1)))
s_c, rot_c, t_c = 0.8, zufallsdrehung(), np.array([0.0, 0.0, 0.0])
z_c, r_c, o_c = in_colmap_rahmen(pos, r_e, o_e, s_c, rot_c, t_c)
erg = georef.ausrichtung(z_c, r_c, o_c, als_gps(pos, 2.0, 5.0, ausreisser=8))
pruefe(abs(erg["massstab"] * s_c - 1.0) < 0.04, f"Maßstab trotz Ausreißern auf 4 % (Faktor {erg['massstab'] * s_c:.3f})")
pruefe(erg["inlier"] <= 72, f"Ausreißer aussortiert ({erg['inlier']} von 80 Inliern)")

# ── 6. Platzierung ────────────────────────────────────────────────────────────
print("6. Platzierung aus einem ENU-Punkt")
g = {"ursprung": {"lat": LAT0, "lon": LON0, "hoehe": H0}, "hoehe_aus_gps": True}
pl = georef.platzierung_aus_punkt(g, [100.0, 0.0, 5.0], 3.0)
pruefe(pl["height_reference"] == "msl" and abs(pl["height"] - (H0 + 5.0)) < 0.05
       and 0.0012 < pl["lon"] - LON0 < 0.0016,
       f"100 m ostwärts = +{pl['lon'] - LON0:.5f}° Länge, Höhe {pl['height']:.2f} m ü. NHN")
g["hoehe_aus_gps"] = False
pl = georef.platzierung_aus_punkt(g, [0.0, 0.0, 0.0], 3.0)
pruefe(pl["height_reference"] == "terrain" and pl["height"] == 3.0,
       "ohne GPS-Höhe: Unterkante aufs Gelände (Höhe = halbe Modellhöhe)")

# ── EXIF ──────────────────────────────────────────────────────────────────────
print("EXIF")


class _Exif:
    def __init__(self, ifd):
        self._ifd = ifd

    def get_ifd(self, tag):
        return self._ifd


gps = georef.exif_gps(_Exif({1: "N", 2: (50.0, 16.0, 20.5967), 3: "E", 4: (7.0, 38.0, 56.379),
                              5: b"\x00", 6: 231.524, 31: 4.7}))
pruefe(abs(gps["lat"] - 50.272388) < 1e-5 and abs(gps["lon"] - 7.648994) < 1e-5 and gps["hoehe"] == 231.524,
       "DJI-Werte aus dem Projekt (Marksburg) werden richtig gelesen")
pruefe(gps["genauigkeit_m"] == 4.7, "horizontale Positionsgenauigkeit (iPhone) wird übernommen")
sued = georef.exif_gps(_Exif({1: "S", 2: (33.0, 51.0, 0.0), 3: "W", 4: (151.0, 12.0, 0.0), 5: b"\x01", 6: 20.0}))
pruefe(sued["lat"] < 0 and sued["lon"] < 0 and sued["hoehe"] == -20.0, "Süd/West und „unter Meeresspiegel“ kippen das Vorzeichen")
pruefe(georef.exif_gps(_Exif({})) is None and georef.exif_gps(_Exif({1: "N", 2: (0, 0, 0), 3: "E", 4: (0, 0, 0)})) is None,
       "leeres GPS und Null-Insel gelten als „kein GPS“")
v = georef.iso6709("+50.2688+007.6491+170.123/")
pruefe(v and abs(v["lon"] - 7.6491) < 1e-9 and abs(v["hoehe"] - 170.123) < 1e-9, "iPhone-Video: ISO-6709-Ortsangabe")

print("\n" + ("ALLES GUT" if _gut else "FEHLER"))
sys.exit(0 if _gut else 1)
