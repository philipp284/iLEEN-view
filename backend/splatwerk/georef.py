"""
Georeferenzierung einer Foto-Rekonstruktion: aus den EXIF-Positionen der Bilder
und der Lage der Kameras wird eine Ähnlichkeitstransformation COLMAP → ENU.

COLMAP rekonstruiert in einem willkürlichen Rahmen: beliebiger Maßstab, beliebige
Drehung, Ursprung bei der ersten Kamera. Brush trainiert in genau diesem Rahmen
und schreibt ihn unverändert in die PLY (gemessen an `Buddah/`: Identität, Median-
abstand 4 cm). Dreht man die fertige PLY nachträglich, müssten die SH-Bänder
mitgedreht werden (Wigner-D). Deshalb wird das **COLMAP-Modell vor dem Training**
transformiert: Brush trainiert dann gleich in Metern, Z oben, Ost/Nord ausgerichtet,
und die PLY braucht keine Nachbearbeitung.

Drei Wege, in dieser Reihenfolge der Güte:

* `schwerkraft_gps` — Hochachse aus den Kameras, Maßstab und Drehung um die Hochachse
  aus den *waagerechten* GPS-Koordinaten. Der Weg für Handyfotos: die GPS-Höhe eines
  Telefons streut um ±10 m, über 50 m Ausdehnung wären das 10° Kippung, wenn sie in
  die Drehung einginge. Sie geht hier nur als Mittelwert in die Höhe ein.
* `gps_3d` — volle 7-Parameter-Anpassung der Kamerazentren an die GPS-Positionen
  samt Höhe. Der Weg für Drohnenflüge (Höhe auf Dezimeter genau, Kameras zeigen
  oft nach unten, die Bildoberkante sagt dann nichts über „oben“).
* `schwerkraft` / `annahme` — keine brauchbare GPS-Basislinie. Position aus dem
  Mittel der Bilder (falls vorhanden), Maßstab 1, Drehung um die Hochachse offen.
  `annahme` gilt, wenn nicht einmal die Hochachse aus den Kameras stimmt: dann
  ist oben die negative COLMAP-y-Richtung, was bei aufrecht gehaltener erster
  Kamera zutrifft.

Alles hier ist NumPy. Kein pyproj, kein SciPy: der Worker läuft auf dem Host und
soll nichts voraussetzen, was nicht ohnehin da ist.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

# ── WGS84 ────────────────────────────────────────────────────────────────────

_A = 6378137.0
_F = 1.0 / 298.257223563
_E2 = _F * (2.0 - _F)

# Ab dieser waagerechten Ausdehnung der Bildpositionen ist ein Maßstab aus GPS
# überhaupt auszumachen. Handy-GPS streut um 3–10 m; darunter ist die Basislinie
# kleiner als das Rauschen, und die Anpassung würde den Maßstab erfinden.
MIN_AUSDEHNUNG_M = 15.0

# Hochachsen-Schätzung aus „Bildrechts ist waagerecht“: Streuung der Rechts-
# vektoren um die Waagerechte, als Sinus des Rollwinkels (0,15 ≈ 9°).
_MAX_ROLL = 0.15
# Verhältnis der beiden größeren Eigenwerte: sind alle Bildrechts-Vektoren
# parallel (Flug in einer Richtung, Kamera nadir), ist die Hochachse nur bis auf
# eine Drehung um diese Richtung bestimmt.
_MIN_STREUUNG = 0.12


def geodaetisch_nach_ecef(lat, lon, h):
    """WGS84 (Grad, Grad, Meter) → ECEF (Meter). Arrays oder Skalare."""
    lat, lon = np.radians(lat), np.radians(lon)
    n = _A / np.sqrt(1.0 - _E2 * np.sin(lat) ** 2)
    return np.stack(
        [(n + h) * np.cos(lat) * np.cos(lon),
         (n + h) * np.cos(lat) * np.sin(lon),
         (n * (1.0 - _E2) + h) * np.sin(lat)],
        axis=-1,
    )


def ecef_nach_geodaetisch(xyz):
    """ECEF → (lat°, lon°, h). Bowring, vier Schritte genügen auf Millimeter."""
    xyz = np.asarray(xyz, dtype=np.float64)
    x, y, z = xyz[..., 0], xyz[..., 1], xyz[..., 2]
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1.0 - _E2))
    for _ in range(5):
        n = _A / np.sqrt(1.0 - _E2 * np.sin(lat) ** 2)
        h = p / np.cos(lat) - n
        lat = np.arctan2(z, p * (1.0 - _E2 * n / (n + h)))
    n = _A / np.sqrt(1.0 - _E2 * np.sin(lat) ** 2)
    h = p / np.cos(lat) - n
    return np.degrees(lat), np.degrees(lon), h


def enu_basis(lat: float, lon: float) -> np.ndarray:
    """Zeilen = Ost, Nord, Oben als ECEF-Vektoren am Punkt (lat, lon)."""
    la, lo = math.radians(lat), math.radians(lon)
    return np.array([
        [-math.sin(lo), math.cos(lo), 0.0],
        [-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)],
        [math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)],
    ])


def nach_enu(lat, lon, h, lat0: float, lon0: float, h0: float) -> np.ndarray:
    """WGS84-Punkte → lokales ENU (Ost, Nord, Oben) am Ursprung (lat0, lon0, h0)."""
    d = geodaetisch_nach_ecef(np.asarray(lat, float), np.asarray(lon, float),
                              np.asarray(h, float)) - geodaetisch_nach_ecef(lat0, lon0, h0)
    return d @ enu_basis(lat0, lon0).T


def von_enu(enu, lat0: float, lon0: float, h0: float):
    """Lokales ENU → (lat°, lon°, h). Gegenstück zu `nach_enu`."""
    enu = np.asarray(enu, dtype=np.float64)
    ecef = geodaetisch_nach_ecef(lat0, lon0, h0) + enu @ enu_basis(lat0, lon0)
    return ecef_nach_geodaetisch(ecef)


# ── EXIF ─────────────────────────────────────────────────────────────────────


def _grad(dms, ref) -> float | None:
    try:
        d, m, s = (float(v) for v in dms)
    except (TypeError, ValueError):
        return None
    wert = d + m / 60.0 + s / 3600.0
    if isinstance(ref, bytes):
        ref = ref.decode("ascii", "ignore")
    return -wert if str(ref).upper() in ("S", "W") else wert


def exif_gps(exif) -> dict | None:
    """
    Position aus einem Pillow-`Exif`: `{lat, lon, hoehe, genauigkeit_m, richtung}`.

    `hoehe` fehlt (None), wenn das Gerät keine liefert. `genauigkeit_m` ist die
    horizontale Positionsgenauigkeit (Tag 31), die iPhones mitschreiben — sie
    dient als Gewicht beim Aussortieren schlechter Positionen.
    """
    try:
        gps = exif.get_ifd(0x8825)
    except Exception:
        return None
    if not gps or 2 not in gps or 4 not in gps:
        return None
    lat = _grad(gps[2], gps.get(1, "N"))
    lon = _grad(gps[4], gps.get(3, "E"))
    if lat is None or lon is None or (lat == 0.0 and lon == 0.0):
        return None
    hoehe = None
    if 6 in gps:
        try:
            hoehe = float(gps[6])
            if gps.get(5) in (1, b"\x01"):
                hoehe = -hoehe  # unter dem Meeresspiegel
        except (TypeError, ValueError):
            hoehe = None
    def _zahl(tag):
        try:
            return float(gps[tag])
        except (KeyError, TypeError, ValueError):
            return None
    return {"lat": lat, "lon": lon, "hoehe": hoehe,
            "genauigkeit_m": _zahl(31), "richtung": _zahl(17)}


def iso6709(text: str) -> dict | None:
    """Ortsangabe aus Video-Metadaten, z. B. ``+50.2688+007.6491+170.123/``."""
    import re
    m = re.match(r"^\s*([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?", text or "")
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if lat == 0.0 and lon == 0.0:
        return None
    return {"lat": lat, "lon": lon,
            "hoehe": float(m.group(3)) if m.group(3) else None,
            "genauigkeit_m": 20.0, "richtung": None}


# ── Ähnlichkeitstransformation ───────────────────────────────────────────────


def umeyama(src: np.ndarray, dst: np.ndarray, skalieren: bool = True):
    """
    Kleinste-Quadrate-Ähnlichkeit `dst ≈ s·R·src + t` (Umeyama 1991), beliebige
    Dimension. `R` ist immer eine Drehung (det = +1), nie eine Spiegelung.
    """
    n, dim = src.shape
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    s0, d0 = src - mu_s, dst - mu_d
    kov = d0.T @ s0 / n
    u, sv, vt = np.linalg.svd(kov)
    vorz = np.ones(dim)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        vorz[-1] = -1.0
    rot = u @ np.diag(vorz) @ vt
    var_s = (s0 ** 2).sum() / n
    s = float((sv * vorz).sum() / var_s) if skalieren and var_s > 0 else 1.0
    t = mu_d - s * rot @ mu_s
    return s, rot, t


def ransac_aehnlichkeit(src, dst, schwelle: float, iterationen: int = 600,
                        seed: int = 7, skalieren: bool = True):
    """
    Robuste Anpassung: minimale Stichproben, größte Übereinstimmungsmenge, dann
    Neuberechnung auf allen Inliern. Gibt `(s, R, t, inlier_maske)` zurück oder
    `None`, wenn keine brauchbare Menge entsteht.

    GPS-Positionen enthalten Ausreißer (Mehrwegeffekte zwischen Häusern, erste
    Fixes nach dem Einschalten); ein einfacher Umeyama über alle Punkte würde
    sich von ihnen verziehen lassen.
    """
    n, dim = src.shape
    kleinste = dim + 1
    if n < kleinste:
        return None
    rng = np.random.default_rng(seed)
    beste = None
    for _ in range(iterationen):
        idx = rng.choice(n, size=kleinste, replace=False)
        # Entartet ist nur eine Gerade. Eine Ebene (Drohnenraster auf gleicher
        # Flughöhe) legt die Drehung eindeutig fest, auch mit vier Punkten.
        if np.linalg.matrix_rank(src[idx] - src[idx].mean(axis=0), tol=1e-9) < 2:
            continue
        try:
            s, rot, t = umeyama(src[idx], dst[idx], skalieren)
        except np.linalg.LinAlgError:
            continue
        if not np.isfinite(s) or s <= 0:
            continue
        fehler = np.linalg.norm(s * src @ rot.T + t - dst, axis=1)
        maske = fehler < schwelle
        zahl = int(maske.sum())
        if beste is None or zahl > beste[0]:
            beste = (zahl, maske)
    if beste is None or beste[0] < kleinste + 1:
        return None
    maske = beste[1]
    for _ in range(3):  # Neuberechnung auf den Inliern, Menge darf noch wachsen
        s, rot, t = umeyama(src[maske], dst[maske], skalieren)
        fehler = np.linalg.norm(s * src @ rot.T + t - dst, axis=1)
        neu = fehler < schwelle
        if neu.sum() < kleinste + 1:
            break
        maske = neu
    return s, rot, t, maske


def signalanteil(vorhersage: np.ndarray, gemessen: np.ndarray, maske: np.ndarray) -> float:
    """
    Welcher Anteil der Streuung der gemessenen Positionen wird von der Anpassung
    erklärt? 1 = alles, 0 = nichts.

    Unterscheidet eine Aufnahme, deren Ausdehnung das GPS auflöst, von einer
    kleineren, bei der die Positionen nur Rauschen um einen Punkt sind. Die
    Ausdehnung der gemessenen Positionen allein tut das nicht — das Rauschen
    bläht sie selbst auf: 60 Punkte mit σ = 4 m spannen leicht 20 m auf. Eine
    Anpassung kann jedoch nur dort mehr als einen kleinen Bruchteil erklären,
    wo hinter dem Rauschen eine Form steht.
    """
    g, v = gemessen[maske][:, :2], vorhersage[maske][:, :2]
    gesamt = float(((g - g.mean(axis=0)) ** 2).sum())
    if gesamt <= 0:
        return 0.0
    rest = float(((v - g) ** 2).sum())
    return max(0.0, 1.0 - rest / gesamt)


# Darunter gilt die Anpassung als Rauschen, nicht als Messung.
MIN_SIGNALANTEIL = 0.5


# ── Kameras ──────────────────────────────────────────────────────────────────


def hochachse_aus_kameras(rechts: np.ndarray, oben: np.ndarray):
    """
    Schätzt die Hochachse im COLMAP-Rahmen aus aufrecht gehaltenen Bildern.

    Der Ansatz nutzt, dass „Bildrechts“ bei einem aufrechten Foto waagerecht ist,
    **unabhängig davon, wie steil die Kamera nach unten oder oben schaut**. Die
    Hochachse ist deshalb die Richtung, in der alle Rechtsvektoren die geringste
    Streuung haben — der kleinste Eigenvektor von Σ r·rᵀ. Das funktioniert auch
    für Senkrechtaufnahmen, wo die Bildoberkante („oben“) nichts über die
    Schwerkraft sagt. Das Vorzeichen kommt aus der Bildoberkante, der Mittelwert
    der Oben-Vektoren zeigt zumindest grob nach oben.

    Gibt `(hoch, güte)` zurück; `hoch` ist `None`, wenn die Schätzung nicht trägt
    (die Rechtsvektoren sind alle parallel, oder der Rollwinkel streut zu stark).
    """
    n = len(rechts)
    if n < 3:
        return None, {"grund": "zu wenige Bilder"}
    m = rechts.T @ rechts / n
    werte, vekt = np.linalg.eigh(m)
    hoch = vekt[:, 0]
    roll = math.sqrt(max(werte[0], 0.0))
    streuung = werte[1] / max(werte[2], 1e-12)
    guete = {"roll_rms": roll, "streuung": float(streuung)}
    if roll > _MAX_ROLL:
        guete["grund"] = f"Bilder nicht aufrecht (Rollstreuung {math.degrees(math.asin(min(roll, 1))):.0f}°)"
        return None, guete
    if streuung < _MIN_STREUUNG:
        guete["grund"] = "alle Bilder mit gleicher Rechtsrichtung (Hochachse nicht eindeutig)"
        return None, guete
    vorz = float(oben.mean(axis=0) @ hoch)
    if abs(vorz) < 0.1:
        # Senkrechtaufnahmen mit wechselnder Flugrichtung: die Bildoberkanten
        # heben sich auf, „oben“ ist nur bis aufs Vorzeichen bekannt.
        guete["grund"] = "Vorzeichen der Hochachse nicht bestimmbar"
        return None, guete
    if vorz < 0:
        hoch = -hoch
    return hoch, guete


# Streuen die gemessenen Hochrichtungen stärker, passen sie nicht zu einer gemeinsamen Szene:
# entweder ist die Rekonstruktion verzerrt oder es stecken verschiedene Aufnahmehaltungen darin.
_MAX_SCHWERKRAFT_STREUUNG_GRAD = 12.0
_MIN_SCHWERKRAFT_BILDER = 3


def hochachse_aus_schwerkraft(hoch_welt: np.ndarray):
    """
    Hochachse im COLMAP-Weltrahmen aus gemessener Schwerkraft.

    `hoch_welt`: je Bild die Hochrichtung, die das Gerät beim Auslösen gemessen hat,
    bereits in den Weltrahmen gedreht (`r.T @ hoch_im_bild`); Zeilen ohne Messung sind NaN.
    Gibt `(hoch, güte)` zurück; `hoch` ist `None`, wenn zu wenig gemessen wurde oder die
    Messungen einander widersprechen. Anders als die Kameralage braucht diese Schätzung
    weder aufrecht gehaltene Bilder noch ein Vorzeichen aus dem Bildinhalt.
    """
    gut = np.all(np.isfinite(hoch_welt), axis=1) if len(hoch_welt) else np.zeros(0, bool)
    if gut.sum() < _MIN_SCHWERKRAFT_BILDER:
        return None, {"quelle": "geraet", "n": int(gut.sum()), "grund": "zu wenige Schwerkraftmessungen"}
    v = hoch_welt[gut]
    v = v / np.linalg.norm(v, axis=1, keepdims=True)
    mittel = v.mean(axis=0)
    laenge = float(np.linalg.norm(mittel))
    guete = {"quelle": "geraet", "n": int(gut.sum()), "mittel_laenge": round(laenge, 4)}
    if laenge < 1e-6:
        guete["grund"] = "Schwerkraftmessungen heben sich auf"
        return None, guete
    hoch = mittel / laenge
    winkel = np.degrees(np.arccos(np.clip(v @ hoch, -1.0, 1.0)))
    guete["streuung_grad"] = round(float(math.sqrt((winkel ** 2).mean())), 2)
    if guete["streuung_grad"] > _MAX_SCHWERKRAFT_STREUUNG_GRAD:
        guete["grund"] = (f"Schwerkraftmessungen streuen um {guete['streuung_grad']:.0f}° — "
                          "die Rekonstruktion ist wahrscheinlich verzerrt")
        return None, guete
    return hoch, guete


def _dreh_hoch_nach_z(hoch: np.ndarray) -> np.ndarray:
    """Kleinste Drehung, die `hoch` auf +Z legt (Rodrigues)."""
    hoch = hoch / np.linalg.norm(hoch)
    z = np.array([0.0, 0.0, 1.0])
    v = np.cross(hoch, z)
    c = float(hoch @ z)
    if np.linalg.norm(v) < 1e-12:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1.0 + c)


# COLMAP-y zeigt nach unten (Bild-unten), z nach vorn. Oben = −y: (x, y, z) → (x, z, −y).
_ANNAHME = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])


def _transform4(s: float, rot: np.ndarray, t: np.ndarray) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = s * rot
    m[:3, 3] = t
    return m


def ausrichtung(zentren: np.ndarray, rechts: np.ndarray, oben: np.ndarray,
                gps: Sequence[dict | None], drohne: bool = False,
                schwerkraft: np.ndarray | None = None, massstab_vorgabe: float = 1.0) -> dict:
    """
    Berechnet die Transformation COLMAP → lokales ENU und beschreibt ihre Güte.

    `zentren`, `rechts`, `oben`: je (N, 3), Kamerazentrum, Bild-rechts- und
    Bild-oben-Richtung im COLMAP-Weltrahmen. `gps`: je Bild ein Wörterbuch aus
    `exif_gps` oder None. `drohne`: Höhen aus GPS sind dann vertrauenswürdig.
    `schwerkraft`: optional (N, 3), die vom Gerät gemessene Hochrichtung je Bild im
    Weltrahmen (NaN-Zeilen ohne Messung). Sie ersetzt die Hochachse aus den Kameras; die
    Kameras bleiben Gegenprobe und Rückfall. `massstab_vorgabe`: der Maßstab, den die Rekonstruktion
    bekommt, wenn weder GPS noch sonst etwas einen liefert (COLMAP rechnet in beliebigen Einheiten;
    ein Wert ≠ 1 ist eine Schätzung und wird als solche gemeldet, `massstab_bekannt` bleibt False).

    Rückgabe: `matrix` (4×4, COLMAP → ENU), `ursprung` (lat, lon, höhe),
    `modus`, `massstab_bekannt`, `drehung_bekannt`, `rms_m`, `inlier`,
    `hinweise`. Der ENU-Ursprung liegt am Median der Bildpositionen.
    """
    n = len(zentren)
    hinweise: list[str] = []
    idx = [i for i, g in enumerate(gps) if g]
    ergebnis: dict = {"bilder": n, "mit_gps": len(idx), "hinweise": hinweise}

    hoch, guete = hochachse_aus_kameras(rechts, oben)
    ergebnis["hochachse_guete"] = guete
    ergebnis["hochachse_quelle"] = "kameras" if hoch is not None else None
    if schwerkraft is not None and len(schwerkraft):
        hoch_g, guete_g = hochachse_aus_schwerkraft(np.asarray(schwerkraft, dtype=float))
        ergebnis["schwerkraft_guete"] = guete_g
        if hoch_g is not None:
            if hoch is not None:
                abw = math.degrees(math.acos(float(np.clip(hoch @ hoch_g, -1.0, 1.0))))
                ergebnis["abweichung_schwerkraft_kameras_deg"] = round(abw, 1)
                if abw > 10.0:
                    hinweise.append(f"Hochachse aus Schwerkraftmessung und aus Kameralage weichen um {abw:.0f}° ab — "
                                    "genommen wurde die Schwerkraftmessung.")
            hoch, guete = hoch_g, guete_g
            ergebnis["hochachse_guete"] = guete
            ergebnis["hochachse_quelle"] = "geraet"
        elif guete_g.get("grund") and guete_g.get("n", 0) >= _MIN_SCHWERKRAFT_BILDER:
            hinweise.append(f"Schwerkraftmessung nicht verwendet: {guete_g['grund']}.")
    if hoch is None and guete.get("grund"):
        hinweise.append(f"Hochachse aus den Kameras nicht ableitbar: {guete['grund']}.")

    ursprung = None
    enu = None
    if idx:
        lat0 = float(np.median([gps[i]["lat"] for i in idx]))
        lon0 = float(np.median([gps[i]["lon"] for i in idx]))
        hoehen = [gps[i]["hoehe"] for i in idx if gps[i].get("hoehe") is not None]
        h0 = float(np.median(hoehen)) if hoehen else None
        ursprung = {"lat": lat0, "lon": lon0, "hoehe": h0}
        enu = nach_enu([gps[i]["lat"] for i in idx], [gps[i]["lon"] for i in idx],
                       [gps[i]["hoehe"] if gps[i].get("hoehe") is not None else (h0 or 0.0)
                        for i in idx], lat0, lon0, h0 or 0.0)
        ausdehnung = float(np.linalg.norm(enu[:, :2].max(axis=0) - enu[:, :2].min(axis=0)))
        ergebnis["gps_ausdehnung_m"] = round(ausdehnung, 1)
        genau = [gps[i]["genauigkeit_m"] for i in idx if gps[i].get("genauigkeit_m")]
        schwelle = max(4.0, 2.5 * float(np.median(genau))) if genau else 6.0
    else:
        ausdehnung, schwelle = 0.0, 6.0

    kandidat_lev = kandidat_3d = None

    # Weg 1: Schwerkraft + waagerechte GPS-Anpassung
    if hoch is not None and enu is not None and len(idx) >= 4 and ausdehnung >= MIN_AUSDEHNUNG_M:
        r_lev = _dreh_hoch_nach_z(hoch)
        lev = zentren[idx] @ r_lev.T
        erg = ransac_aehnlichkeit(lev[:, :2], enu[:, :2], schwelle)
        if erg is not None:
            s, r2, t2, maske = erg
            rot = np.eye(3)
            rot[:2, :2] = r2
            rot = rot @ r_lev
            tz = 0.0
            if ursprung["hoehe"] is not None and any(gps[i].get("hoehe") is not None for i in idx):
                tz = float(np.median(enu[:, 2] - s * lev[:, 2]))
            t = np.array([t2[0], t2[1], tz])
            vorher = s * lev[:, :2] @ r2.T + t2
            rest = np.linalg.norm(vorher - enu[:, :2], axis=1)[maske]
            if signalanteil(vorher, enu[:, :2], maske) >= MIN_SIGNALANTEIL:
                kandidat_lev = {"s": s, "rot": rot, "t": t, "maske": maske,
                                "rms": float(math.sqrt((rest ** 2).mean())), "modus": "schwerkraft_gps"}

    # Weg 2: volle 3D-Anpassung — nur mit Höhen und Streuung in zwei Richtungen
    hat_hoehe = ursprung is not None and ursprung["hoehe"] is not None
    if enu is not None and hat_hoehe and len(idx) >= 6 and ausdehnung >= MIN_AUSDEHNUNG_M:
        sv = np.linalg.svd(enu - enu.mean(axis=0), compute_uv=False)
        if sv[1] / max(sv[0], 1e-9) >= 0.05:
            erg = ransac_aehnlichkeit(zentren[idx], enu, schwelle)
            if erg is not None:
                s, rot, t, maske = erg
                vorher = s * zentren[idx] @ rot.T + t
                rest = np.linalg.norm(vorher - enu, axis=1)[maske]
                if signalanteil(vorher, enu, maske) >= MIN_SIGNALANTEIL:
                    kandidat_3d = {"s": s, "rot": rot, "t": t, "maske": maske,
                                   "rms": float(math.sqrt((rest ** 2).mean())), "modus": "gps_3d"}

    gewaehlt = None
    if kandidat_lev and kandidat_3d:
        if drohne:
            gewaehlt = kandidat_3d
        else:
            gewaehlt = kandidat_lev
        a = kandidat_lev["rot"].T[:, 2]
        b = kandidat_3d["rot"].T[:, 2]
        winkel = math.degrees(math.acos(float(np.clip(a @ b, -1, 1))))
        ergebnis["abweichung_hochachse_deg"] = round(winkel, 1)
        if winkel > 5.0:
            hinweise.append(
                f"Hochachse aus Kameras und aus GPS-Höhen weichen um {winkel:.0f}° ab — "
                f"genommen wurde {'GPS (Drohne)' if drohne else 'die Kameralage'}."
            )
    else:
        gewaehlt = kandidat_lev or kandidat_3d

    if gewaehlt is not None:
        m = _transform4(gewaehlt["s"], gewaehlt["rot"], gewaehlt["t"])
        ergebnis.update(matrix=m.tolist(), modus=gewaehlt["modus"], massstab_bekannt=True,
                        drehung_bekannt=True, rms_m=round(gewaehlt["rms"], 2),
                        inlier=int(gewaehlt["maske"].sum()), ursprung=ursprung,
                        massstab=float(gewaehlt["s"]))
        if gewaehlt["rms"] > 0.5 * max(schwelle, 1.0):
            hinweise.append(f"Lage der Bilder zum GPS streut mit {gewaehlt['rms']:.1f} m — "
                            "Verortung ist nur auf diese Größenordnung genau.")
        if gewaehlt["modus"] == "schwerkraft_gps" and not hat_hoehe:
            hinweise.append("Keine GPS-Höhe in den Bildern — Höhe wird am Gelände ausgerichtet.")
        ergebnis["hoehe_aus_gps"] = bool(hat_hoehe)
        return ergebnis

    # Kein Weg mit GPS-Maßstab: Hochachse (falls möglich), Maßstab 1
    if idx:
        hinweise.append(
            "Die Aufnahme ist kleiner als das GPS-Rauschen (oder die Positionen passen nicht zur "
            "Rekonstruktion). Der Ort ist bekannt, Maßstab und Himmelsrichtung nicht: "
            "Maßstab im Asset-Manager einstellen.")
    else:
        hinweise.append("Keine GPS-Daten in den Bildern — Standort und Maßstab müssen von Hand gesetzt werden.")

    if hoch is not None:
        rot = _dreh_hoch_nach_z(hoch)
        modus = "schwerkraft"
    else:
        rot = _ANNAHME.copy()
        modus = "annahme"
        hinweise.append("Hochachse angenommen (COLMAP-y nach unten) — liegt das Modell schief, "
                        "im Asset-Manager mit Pitch/Roll korrigieren.")
    # Mitte der Kameras in den Ursprung: dann liegt die Szene um den Ursprung
    # statt hunderte Einheiten daneben.
    s = float(massstab_vorgabe) if np.isfinite(massstab_vorgabe) and massstab_vorgabe > 0 else 1.0
    t = -s * (rot @ zentren.mean(axis=0))
    geschaetzt = abs(s - 1.0) > 1e-9
    if geschaetzt:
        hinweise.append("Maßstab geschätzt (die Kameras stehen im Mittel etwa 1 m vom Gesehenen entfernt angenommen) — "
                        "die Größe stimmt nur der Größenordnung nach; im Positionsformular mit einem bekannten Maß nachstellen.")
    ergebnis.update(matrix=_transform4(s, rot, t).tolist(), modus=modus,
                    massstab_bekannt=False, massstab_geschaetzt=geschaetzt, drehung_bekannt=False, rms_m=None,
                    inlier=0, ursprung=ursprung, massstab=s, hoehe_aus_gps=False)
    return ergebnis


# ── Platzierung ──────────────────────────────────────────────────────────────


def platzierung_aus_punkt(georef: dict, punkt_enu: Sequence[float], modell_unterkante_zu_mitte: float) -> dict:
    """
    Platzierungsfelder (`lon`, `lat`, `height`, `height_reference`) für einen
    Punkt im ENU-System der Rekonstruktion.

    `punkt_enu` ist die Stelle, an der der Splat-Handler den Platzierungspunkt
    verankert (Mitte der Hüllbox). Hat die Rekonstruktion keine GPS-Höhe, wird
    die Unterkante des Modells aufs Gelände gesetzt: `modell_unterkante_zu_mitte`
    ist der Abstand von der Unterkante zu jenem Punkt.
    """
    u = georef.get("ursprung")
    if not u:
        return {}
    h0 = u.get("hoehe")
    lat, lon, h = von_enu(np.asarray(punkt_enu, float), u["lat"], u["lon"],
                          h0 if h0 is not None else 0.0)
    if h0 is not None and georef.get("hoehe_aus_gps"):
        return {"lat": float(lat), "lon": float(lon), "height": float(h), "height_reference": "msl"}
    return {"lat": float(lat), "lon": float(lon),
            "height": float(modell_unterkante_zu_mitte), "height_reference": "terrain"}
