"""
Aufnahmepakete von Aufnahme-Apps — Fotos und Videos beider iPhone-Kameras gleichzeitig.

„Gaussian Splat King“ (und Verwandte) legt eine Aufnahme als Ordner ab, in dem neben den
Medien eine `splatpack.json` (Schema `splatpack.v2`) steht. Zwei Arten kommen vor:

    PhotoSeries_…/   `photo_dual`   je Auslösung ein Weitwinkel- und ein Ultraweitwinkel-Foto
                                    (`wide_<id>.jpg`, `ultra_<id>.jpg`) mit je einer Begleitdatei
                                    `<name>.json`: Position samt Genauigkeit, Bildschärfe,
                                    Beschleunigungsmesser, Bewegungsdaten.
    Video_…/         `video_dual`   `wide.mov` und `ultra.mov`, gleichzeitig aufgenommen, dazu
                                    `frame_timecodes.csv` (Zeit je Bild), `metadata.json`
                                    (Sichtfeld je Kamera) und die Positionsspur (eine Messung
                                    je Sekunde) in `splatpack.json`.

Was die Pipeline davon braucht und woanders nicht bekommt:

* **eine Kamera je Objektiv.** Wide und Ultra haben verschiedene Brennweiten und
  Verzeichnungen; in einer gemeinsamen Kamera (oder mit je einer Kamera pro Bild) wird die
  Rekonstruktion schlechter. Der Strom (`wide`/`ultra`) ist deshalb der Gruppenschlüssel.
* **der Ort, auch beim Video.** Die Videodatei trägt nur *eine* Position (Beginn). Die Spur
  dazu liefert für jedes Einzelbild eine Position samt Genauigkeit.
* **das Sichtfeld** der Videos, damit COLMAP nicht mit einer Brennweite aus der Luft startet,
  denn Videobilder tragen keine EXIF-Brennweite.
* **die Bildschärfe**, um verwackelte Fotos auszusortieren.

Alles hier ist **reines Lesen**: keine Rechnung, keine Abhängigkeit außer NumPy. Fehlt oder
bricht eine Datei, wird das Bild/Video behandelt wie ohne Paket.
"""

from __future__ import annotations

import csv
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

SCHEMA = "splatpack"
# Zeiten der App sind CFAbsoluteTime (Sekunden seit 2001-01-01), Unix zählt ab 1970.
_APPLE_NACH_UNIX = 978307200.0
BEGLEIT_ENDUNGEN = {".json", ".csv", ".ndjson"}


def _json(pfad: Path) -> dict | None:
    try:
        d = json.loads(pfad.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def _zahl(wert) -> float | None:
    try:
        z = float(wert)
        return z if np.isfinite(z) else None
    except (TypeError, ValueError):
        return None


def ort_aus_messung(m: dict | None) -> dict | None:
    """Eine Positionsmessung der App → das Format von `georef.exif_gps`."""
    if not m:
        return None
    lat, lon = _zahl(m.get("latitude")), _zahl(m.get("longitude"))
    if lat is None or lon is None or (lat == 0.0 and lon == 0.0) or abs(lat) > 90 or abs(lon) > 180:
        return None
    return {"lat": lat, "lon": lon, "hoehe": _zahl(m.get("altitudeMeters")),
            "genauigkeit_m": _zahl(m.get("horizontalAccuracyMeters")), "richtung": None}


@dataclass
class VideoInfo:
    """Was die App über *ein* Video weiß."""
    strom: str                              # wide | ultra
    datei: Path
    fov_grad: float | None                  # horizontales Sichtfeld der aktiven Aufnahmeform
    zeiten: np.ndarray | None               # Unix-Zeit je Einzelbild, oder None
    spur: list[dict] = field(default_factory=list)   # Positionsmessungen, nach Zeit sortiert
    anzahl: int | None = None               # Zahl der Bilder laut App

    def ort_bei(self, unix: float) -> dict | None:
        """Position zu einem Zeitpunkt: linear zwischen den beiden Messungen drumherum."""
        if not self.spur:
            return None
        t = np.array([s["t"] for s in self.spur])
        if unix <= t[0] or unix >= t[-1]:
            naechste = self.spur[0 if unix <= t[0] else -1]
            if abs(unix - naechste["t"]) > 10.0:
                return None
            return dict(naechste["ort"])
        k = int(np.searchsorted(t, unix))
        a, b = self.spur[k - 1], self.spur[k]
        w = (unix - a["t"]) / max(b["t"] - a["t"], 1e-9)
        o = {}
        for schluessel in ("lat", "lon"):
            o[schluessel] = a["ort"][schluessel] * (1 - w) + b["ort"][schluessel] * w
        ha, hb = a["ort"].get("hoehe"), b["ort"].get("hoehe")
        o["hoehe"] = ha * (1 - w) + hb * w if ha is not None and hb is not None else (ha if hb is None else hb)
        ga, gb = a["ort"].get("genauigkeit_m"), b["ort"].get("genauigkeit_m")
        o["genauigkeit_m"] = max(g for g in (ga, gb) if g is not None) if (ga is not None or gb is not None) else None
        o["richtung"] = None
        return o


@dataclass
class Paket:
    ordner: Path
    typ: str                                # photo_dual | video_dual
    app: str
    daten: dict

    @property
    def beschreibung(self) -> str:
        return f"{self.app} · {'Foto-Serie' if self.typ == 'photo_dual' else 'Video'} (Weitwinkel + Ultraweit)"


def finde_pakete(wurzel: Path) -> list[Paket]:
    """Alle Ordner unter `wurzel` (einschließlich ihr selbst) mit einer `splatpack.json`."""
    pakete = []
    for pfad in sorted(Path(wurzel).rglob("splatpack.json")):
        d = _json(pfad)
        if not d or str(d.get("schemaName") or d.get("schema", "")).split(".")[0] != SCHEMA:
            continue
        typ = str(d.get("captureType") or "")
        if typ not in ("photo_dual", "video_dual"):
            logger.info(f"splatpack {pfad}: unbekannter Typ '{typ}' — wird wie lose Medien behandelt")
            continue
        app = d.get("app") or {}
        name = {"com.radiancefields.gaussiansplatking.app": "Gaussian Splat King"}.get(
            str(app.get("bundleIdentifier")), str(app.get("bundleIdentifier") or "Aufnahme-App"))
        if app.get("shortVersion"):
            name += f" {app['shortVersion']}"
        pakete.append(Paket(pfad.parent, typ, name, d))
    return pakete


class Index:
    """Zugriff auf die Zusatzdaten aller Pakete eines Auftrags — je Bild oder Video."""

    def __init__(self, pakete: list[Paket]):
        self.pakete = pakete
        self._zeiten: dict[Path, dict[str, float]] = {}
        self._videos: dict[Path, VideoInfo] = {}
        for p in pakete:
            if p.typ == "photo_dual":
                self._zeiten[p.ordner] = {
                    str(x.get("captureId")): float(x["timestamp"]) + _APPLE_NACH_UNIX
                    for x in p.daten.get("pairs", []) if _zahl(x.get("timestamp")) is not None}
            else:
                for v in self._lade_videos(p):
                    self._videos[v.datei.resolve()] = v

    def __bool__(self) -> bool:
        return bool(self.pakete)

    # ── Fotos ────────────────────────────────────────────────────────────────

    def _paket_von(self, pfad: Path) -> Paket | None:
        for p in self.pakete:
            if p.ordner == pfad.parent:
                return p
        return None

    def bild(self, pfad: Path) -> dict | None:
        """
        Zusatzdaten zu einem Foto der Serie, oder None.

        `strom`, `zeit_unix`, `gps` (wie `exif_gps`), `unscharf` (die App hat das Bild als
        `poor` eingestuft), `qualitaet` (0…1), `beschleunigung` (MakerApple, Gerätrahmen),
        `orientierung`, `rueckkamera`.
        """
        paket = self._paket_von(pfad)
        if paket is None or paket.typ != "photo_dual":
            return None
        j = _json(pfad.with_suffix(".json"))
        if j is None:
            return None
        em = j.get("extraMetadata") or {}
        meta = j.get("metadata") or {}
        analyse = j.get("imageAnalysis") or {}
        strom = str(em.get("stream") or pfad.name.split("_")[0])
        kennung = re.sub(r"^[a-z]+_", "", pfad.stem)
        modell = str(((meta.get("{Exif}") or {}).get("LensModel")) or "")
        return {
            "strom": strom,
            "zeit_unix": self._zeiten.get(paket.ordner, {}).get(kennung),
            "gps": ort_aus_messung(em.get("location")),
            "unscharf": str(analyse.get("blurBand") or "").lower() == "poor",
            "qualitaet": _zahl(em.get("qualityScore")),
            "meta": meta,
            "orientierung": int(meta["Orientation"]) if str(meta.get("Orientation", "")).isdigit() else None,
            "rueckkamera": "front" not in modell.lower(),
        }

    # ── Videos ───────────────────────────────────────────────────────────────

    def video(self, pfad: Path) -> VideoInfo | None:
        return self._videos.get(Path(pfad).resolve())

    @staticmethod
    def _lade_videos(paket: Paket) -> list[VideoInfo]:
        d = paket.daten
        meta = _json(paket.ordner / str(d.get("metadataFile") or "metadata.json")) or {}
        zeiten: dict[str, list[tuple[int, float]]] = {}
        try:
            with (paket.ordner / "frame_timecodes.csv").open(newline="", encoding="utf-8") as f:
                for zeile in csv.DictReader(f):
                    zeiten.setdefault(zeile["stream"], []).append((int(zeile["frame_index"]), float(zeile["unix_seconds"])))
        except (OSError, KeyError, ValueError):
            zeiten = {}
        spur = []
        for s in ((d.get("locationTrack") or {}).get("samples") or []):
            ort, t = ort_aus_messung(s), _zahl(s.get("timestampUnix"))
            if ort and t is not None:
                spur.append({"t": t, "ort": ort})
        spur.sort(key=lambda s: s["t"])
        if not spur:
            o = ort_aus_messung(d.get("location"))
            t = _zahl((d.get("location") or {}).get("timestampUnix"))
            if o and t is not None:
                spur = [{"t": t, "ort": o}]

        videos = []
        for s in d.get("streams", []):
            name = str(s.get("camera") or "")
            datei = paket.ordner / str(s.get("rawVideoFile") or "")
            if not name or not datei.is_file():
                continue
            fmt = (meta.get(name) or {}).get("activeFormat") or (s.get("deviceInfo") or {}).get("activeFormat") or {}
            fov = _zahl(fmt.get("fieldOfView"))
            roh = sorted(zeiten.get(name, []))
            z = np.array([t for _, t in roh]) if roh and [i for i, _ in roh] == list(range(len(roh))) else None
            videos.append(VideoInfo(name, datei, fov if fov and 10 < fov < 170 else None, z, spur,
                                    int(s["acceptedFrameCount"]) if str(s.get("acceptedFrameCount", "")).isdigit() else None))
        return videos


def brennweite_aus_sichtfeld(fov_grad: float, lange_seite_px: float) -> float:
    """Brennweite in Pixeln aus dem Sichtfeld über die lange Bildkante."""
    return float(lange_seite_px / 2.0 / np.tan(np.radians(fov_grad) / 2.0))
