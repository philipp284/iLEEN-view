"""
Panorama-Rundgang bauen — reiner Kern (ohne FastAPI, ohne MinIO).

Aus einem Satz equirectangularer 360°-Fotos wird eine `tour.json`, die das
Frontend (pano-tour.js) unverändert lädt: je Bild ein Standpunkt mit Weltlage,
Blickrichtung und Panorama-URL. Woher die Lage kommt, entscheidet eine feste
Rangfolge — von der verlässlichsten zur unsichersten Quelle:

    1. Manifest      — je Dateiname ausdrücklich Koordinaten (und optional
                       Blickrichtung, Nachbarn). Der genaueste Weg.
    2. EXIF/GPano    — GPS und Blickrichtung aus dem Foto selbst (viele
                       360°-Kameras schreiben beides).
    3. Automatische  — entlang einer Linie ab einem Ankerpunkt, im gegebenen
       Reihe          Abstand und Azimut, in Dateinamen-Reihenfolge.

Warum kein E57-Weg hier: die verfügbaren E57 (Z+F-Rucksack) tragen **keine**
eingebetteten Panoramen (`images2D` leer) — ein Rundgang braucht die Bilder,
und die kommen bei dieser Datenlage als eigene Fotos. Ein Stativ-Scan mit
eingebetteten Panoramen wäre ein zusätzlicher Zubringer in dieselbe tour.json.

Die Blickrichtung (`heading`) steht in der tour.json in **Radiant** — so
erwartet es der Viewer (Cesium-Heading, 0 = Norden, im Uhrzeigersinn). Eingaben
aus Manifest und EXIF sind in Grad und werden hier umgerechnet.

Die Höhe (`hoehe`) ist eine **Ellipsoidhöhe** der Kamera (Linsenmitte), denn
der Viewer setzt den Standpunkt mit `Cartesian3.fromDegrees(lon, lat, hoehe)`.
Eine GPS-Höhe aus EXIF ist eine Höhe über dem Meer und bekommt die
Geoidundulation dazu (`undulation`, im Backend `GEOID_UNDULATION_M`).

**Der Import-Weg (Entwurf).** Eine Kamera wie die RICOH THETA schreibt keine
Position, nur einen Kompasswert der Bildmitte (`GPSImgDirection`, Bezug „M" —
magnetisch). Verortet wird deshalb im Viewer (pano-import.js): Bilder kommen
erst unverortet in eine Tour (`bilder_aufnehmen`), dort werden sie in der Szene
gesetzt und am Modell ausgerichtet, und `tour_bearbeiten` übernimmt das
Ergebnis. Ein unverorteter Spot hat `lon = lat = hoehe = null`; der Viewer
überspringt ihn (`tourNormalisieren` verlangt Zahlen).

Prüfstein: backend/tests/test_tour.py (ohne Server).
"""

import io
import math
import re
from datetime import datetime, timezone

from PIL import Image

VERSION = 1

# Breite der Vorschaubilder (Liste im Editor, Kachel im Import). 640 × 320 sind
# bei einem 5376er Theta-Bild 1/8 — genau die Stufe, die JPEG beim Dekodieren
# ohnehin billig liefert (`Image.draft`).
VORSCHAU_BREITE = 640

# Was die Tour über ihren eigenen Aufbau weiß (Editor); der Viewer liest es nicht.
EINSTELLUNGEN_VORGABE = {
    "aufnahmehoehe": 1.5,        # m über Fußboden: Stativ/Einbeinstativ
    "nachbarn": "kette+naehe",   # „kette+naehe" | „naehe"
    "radius": 12.0,              # m, Nähe-Nachbarn
    "missweisung": None,         # Grad Ost; None = aus der Lage geschätzt
}

AUSRICHTUNGEN = ("keine", "kompass", "hand")
LAGEN = (None, "hand", "gps", "manifest", "auto")

_ERLAUBT = (".jpg", ".jpeg", ".png")
_CONTENT_TYPE = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}

# Meter je Grad Breite (WGS84, hinreichend für die kurzen Wege eines Rundgangs).
_M_PRO_GRAD_LAT = 111_320.0


def content_type(name: str) -> str:
    ext = _endung(name)
    return _CONTENT_TYPE.get(ext, "application/octet-stream")


def _endung(name: str) -> str:
    i = name.rfind(".")
    return name[i:].lower() if i >= 0 else ""


def sicherer_name(name: str, i: int) -> str:
    """Dateiname auf Basisnamen und ein sicheres Alphabet reduzieren.

    Kein Pfadanteil (kein `..`, kein `/`), damit ein Objektname im Speicher
    nicht aus seinem Präfix ausbrechen kann; unbekannte Zeichen werden zu `_`.
    Bleibt am Ende nichts Brauchbares, tritt ein laufender Name an seine Stelle.
    """
    roh = name.replace("\\", "/").split("/")[-1]
    ext = _endung(roh)
    if ext not in _ERLAUBT:
        ext = ".jpg"
    stamm = roh[: len(roh) - len(_endung(roh))] if _endung(roh) else roh
    stamm = re.sub(r"[^A-Za-z0-9._-]", "_", stamm).strip("._-")
    if not stamm:
        stamm = f"bild{i + 1}"
    return stamm + ext


# ── Lage aus dem Foto: EXIF-GPS und GPano-Blickrichtung ─────────────────────

def exif_lage(data: bytes):
    """{lon, lat, hoehe?, heading_deg?} aus EXIF/GPano — oder None.

    Nachsichtig: ein Foto ohne (oder mit kaputtem) EXIF liefert schlicht None,
    dann greift die nächste Quelle. Ein GPS ohne Länge/Breite ist wertlos und
    wird verworfen (Höhe allein verortet nichts).
    """
    lage = {}
    try:
        im = Image.open(io.BytesIO(data))
        exif = im.getexif()
        gps = exif.get_ifd(0x8825) if exif else {}
    except Exception:
        gps = {}
    if gps:
        lat = _dms(gps.get(2), gps.get(1))
        lon = _dms(gps.get(4), gps.get(3))
        if lat is not None and lon is not None:
            lage["lat"] = lat
            lage["lon"] = lon
            alt = gps.get(6)
            if alt is not None:
                a = float(alt)
                if gps.get(5) == 1:            # AltitudeRef 1 = unter dem Meer
                    a = -a
                lage["hoehe"] = a
            richtung = gps.get(17)             # GPSImgDirection
            if richtung is not None:
                lage["heading_deg"] = float(richtung) % 360.0
                lage["heading_bezug"] = _bezug(gps.get(16))
    if "heading_deg" not in lage:
        h = _gpano_heading(data)
        if h is not None:
            lage["heading_deg"] = h % 360.0
    # Eine Blickrichtung ohne Ort ist nutzlos — nur mit lon/lat ist es eine Lage.
    return lage if ("lat" in lage and "lon" in lage) else None


def _dms(werte, ref):
    """(Grad, Minute, Sekunde) + Himmelsrichtung → Dezimalgrad."""
    if not werte or len(werte) != 3:
        return None
    try:
        grad = float(werte[0]) + float(werte[1]) / 60.0 + float(werte[2]) / 3600.0
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if ref in ("S", "W", b"S", b"W"):
        grad = -grad
    return grad


def _bezug(ref):
    """GPSImgDirectionRef → 'M' (magnetisch) | 'T' (geografisch) | None."""
    if isinstance(ref, bytes):
        ref = ref.decode("ascii", "ignore")
    ref = str(ref or "").strip().upper()[:1]
    return ref if ref in ("M", "T") else None


def _gpano_heading(data: bytes):
    """GPano:PoseHeadingDegrees aus dem XMP-Block (0..360) — oder None.

    Nur der Kopf der Datei wird durchsucht; XMP steht bei JPEG im APP1-Segment
    kurz nach dem Anfang, und die ganze Datei zu durchkämmen wäre Verschwendung.
    """
    m = re.search(rb"PoseHeadingDegrees[>=\"'\s]+([0-9]+(?:\.[0-9]+)?)", data[:262144])
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


# ── Standpunkte bilden ──────────────────────────────────────────────────────

def spots_bauen(dateien_info, manifest=None, anchor=None, undulation=0.0, jahr=None):
    """Aus Datei-Infos die Spotliste bilden.

    dateien_info: Liste von {name, safe, id, exif} in Reihenfolge.
    manifest:     optional {"spots": {dateiname: {lon,lat,hoehe,heading,name,nachbarn}}}
    anchor:       optional {lon, lat, hoehe?, spacing?, richtung?, heading0?}
    undulation:   Geoidundulation (m) — macht aus einer GPS-Meereshöhe eine
                  Ellipsoidhöhe. Manifest und Anker gelten als ellipsoidisch.
    jahr:         für die Missweisung eines magnetischen Kompasswerts.

    Rückgabe: (spots, ohne_lage). `ohne_lage` sind die Dateien, die auf keinem
    Weg zu verorten waren — der Aufrufer entscheidet, ob das ein Fehler ist.
    """
    manifest = manifest or {}
    m_spots = manifest.get("spots") or {}
    spots = []
    ohne_lage = []

    auto_i = 0
    for info in dateien_info:
        name, safe = info["name"], info["safe"]
        sid = info["id"]
        eintrag = m_spots.get(name) or m_spots.get(safe) or m_spots.get(sid)
        lage = None
        quelle = None

        if eintrag and _hat_ort(eintrag):
            lage = {
                "lon": float(eintrag["lon"]),
                "lat": float(eintrag["lat"]),
                "hoehe": float(eintrag.get("hoehe", eintrag.get("height", 0.0))),
                "heading": math.radians(float(eintrag.get("heading", 0.0))),
            }
            quelle = "manifest"
        elif info.get("exif"):
            e = info["exif"]
            lon, lat = float(e["lon"]), float(e["lat"])
            # Ein magnetischer Kompasswert (Bezug „M", so schreibt ihn die
            # THETA) zeigt um die Missweisung neben geografisch Nord.
            hdg = float(e.get("heading_deg", 0.0))
            if e.get("heading_bezug") == "M":
                d = missweisung(lon, lat, jahr)
                if d is not None:
                    hdg += d
            lage = {
                "lon": lon,
                "lat": lat,
                "hoehe": float(e["hoehe"]) + float(undulation or 0.0) if "hoehe" in e else 0.0,
                "heading": math.radians(hdg),
            }
            quelle = "exif"
        elif anchor and _hat_ort(anchor):
            lage = _auf_linie(anchor, auto_i)
            quelle = "auto"
            auto_i += 1

        if lage is None:
            ohne_lage.append(name)
            continue

        hat_richtung = (quelle == "manifest" and eintrag and "heading" in eintrag) or \
            (quelle == "exif" and "heading_deg" in info["exif"])
        spot = {
            "id": sid,
            "name": (eintrag.get("name") if eintrag else None) or info.get("titel") or sid,
            "lon": lage["lon"],
            "lat": lage["lat"],
            "hoehe": lage["hoehe"],
            "heading": lage["heading"],
            "panorama": "pano/" + info.get("datei", safe),
            "quelle": quelle,
            "lage": {"manifest": "manifest", "exif": "gps", "auto": "auto"}[quelle],
            "ausrichtung": ("hand" if quelle == "manifest" else "kompass") if hat_richtung else "keine",
        }
        if eintrag and isinstance(eintrag.get("nachbarn"), list):
            spot["nachbarn"] = [str(n) for n in eintrag["nachbarn"]]
        spots.append(spot)

    # Automatisch gesetzte Spots der Reihe nach verketten — sie liegen auf einer
    # Linie, also ist „der davor und der danach" die richtige Nachbarschaft.
    auto = [s for s in spots if s["quelle"] == "auto"]
    for k, s in enumerate(auto):
        if "nachbarn" in s:
            continue
        nb = []
        if k > 0:
            nb.append(auto[k - 1]["id"])
        if k < len(auto) - 1:
            nb.append(auto[k + 1]["id"])
        if nb:
            s["nachbarn"] = nb

    return spots, ohne_lage


def _hat_ort(d):
    return d is not None and "lon" in d and "lat" in d \
        and d["lon"] is not None and d["lat"] is not None


def _auf_linie(anchor, i):
    """Standpunkt i auf einer Linie ab dem Anker.

    Schrittweite `spacing` (m), Richtung `richtung` (Azimut in Grad, 0 = Nord,
    im Uhrzeigersinn). Der erste Standpunkt (i=0) liegt auf dem Anker selbst.
    """
    lat0 = float(anchor["lat"])
    lon0 = float(anchor["lon"])
    h0 = float(anchor.get("hoehe", anchor.get("height", 0.0)))
    spacing = float(anchor.get("spacing", 3.0))
    azimut = math.radians(float(anchor.get("richtung", 90.0)))  # Vorgabe: nach Osten
    heading0 = anchor.get("heading0", anchor.get("richtung", 90.0))

    strecke = i * spacing
    ost = strecke * math.sin(azimut)
    nord = strecke * math.cos(azimut)
    m_pro_grad_lon = _M_PRO_GRAD_LAT * math.cos(math.radians(lat0))
    return {
        "lon": lon0 + ost / m_pro_grad_lon,
        "lat": lat0 + nord / _M_PRO_GRAD_LAT,
        "hoehe": h0,
        "heading": math.radians(float(heading0)),
    }


# ── Alles zusammensetzen ────────────────────────────────────────────────────

def tour_zusammenstellen(name, dateien, manifest=None, anchor=None,
                         entwurf=False, undulation=0.0, jahr=None):
    """(tour_dict, objekte) aus (dateiname, bytes)-Paaren bauen.

    objekte: Liste von (pfad, bytes, content_type), `pfad` relativ zur Tour
    (`pano/x.jpg`, `vorschau/x.jpg`) — der Aufrufer legt sie unter
    `<tour>/<pfad>` ab.

    Ohne `entwurf` wirft es ValueError, wenn am Ende Bilder ohne Lage übrig
    sind — ein Standpunkt ohne Ort ist kein Standpunkt, und ihn stillschweigend
    wegzulassen verschwiege dem Nutzer, dass die Hälfte seiner Fotos fehlt.
    Mit `entwurf` werden alle Bilder unverortet aufgenommen (siehe
    `bilder_aufnehmen`): verortet wird dann im Viewer, nicht hier.
    """
    if entwurf:
        tour = tour_leer(name)
        spots, objekte = bilder_aufnehmen(dateien)
        tour["spots"] = spots
        return tour, objekte

    paare = [(n, b) for (n, b) in dateien if _endung(n) in _ERLAUBT]
    if not paare:
        raise ValueError("Keine equirectangularen Bilder (.jpg/.jpeg/.png) dabei.")
    paare.sort(key=lambda p: p[0].lower())

    infos, objekte, zusatz = [], [], {}
    ids = set()
    for i, (dn, roh) in enumerate(paare):
        safe = sicherer_name(dn, i)
        sid = _eindeutige_id(safe, ids)
        # Der Objektname folgt der eindeutigen Kennung, nicht dem Dateinamen:
        # zwei Fotos „a.jpg" aus zwei Ordnern überschrieben sich sonst im Speicher.
        datei = sid + _endung(safe)
        infos.append({"name": dn, "safe": safe, "datei": datei, "id": sid, "exif": exif_lage(roh)})
        objekte.append(("pano/" + datei, roh, content_type(datei)))
        zusatz[sid] = _vorschau_und_aufnahme(dn, sid, roh, objekte)

    spots, ohne = spots_bauen(infos, manifest=manifest, anchor=anchor,
                              undulation=undulation, jahr=jahr)

    if ohne:
        raise ValueError(
            "Für diese Bilder war keine Lage bestimmbar (kein Manifest-Eintrag, "
            "kein EXIF-GPS, kein Ankerpunkt): " + ", ".join(ohne)
            + ". Entweder ein Manifest mit Koordinaten mitschicken oder einen "
            "Ankerpunkt (lon/lat) für die automatische Reihe angeben."
        )

    for s in spots:
        s.update(zusatz.get(s["id"], {}))
    tour = tour_leer(name)
    tour["spots"] = [_ohne_intern(s) for s in spots]
    return tour, objekte


def tour_leer(name):
    """Eine Tour ohne Standpunkte — der Anfang jedes Imports."""
    return {
        "version": VERSION,
        "name": (name or "").strip() or "Rundgang",
        "erstellt": datetime.now(timezone.utc).isoformat(),
        "einstellungen": dict(EINSTELLUNGEN_VORGABE),
        "spots": [],
    }


# ── Import: Bilder unverortet aufnehmen ──────────────────────────────────────

def bilder_aufnehmen(dateien, vorhandene_ids=(), nummer_ab=1):
    """(dateiname, bytes)-Paare → (spots, objekte), alle Spots UNVERORTET.

    Eine 360°-Kamera kennt ihren Standort im Gebäude nicht — GPS fehlt drinnen
    oder streut um Geschosse. Deshalb setzt dieser Weg nie eine Lage, auch
    nicht aus EXIF-GPS: das GPS steht in `aufnahme.gps`, und der Editor bietet
    „nach GPS setzen" an (mit der Geländehöhe des Viewers statt der GPS-Höhe).
    Der Kompasswert steht in `aufnahme.kompass_deg` samt Bezug; die
    Missweisung hängt am Ort und wird erst beim Setzen eingerechnet.

    Reihenfolge: nach Aufnahmezeit, dann Dateiname — so steht ein Rundgang in
    der Reihenfolge da, in der er gelaufen wurde. Die Namen „Standpunkt n"
    zählen ab `nummer_ab` weiter.
    """
    paare = [(n, b) for (n, b) in dateien if _endung(n) in _ERLAUBT]
    angaben = [(n, b, bild_info(b)) for (n, b) in paare]
    angaben.sort(key=lambda t: (t[2].get("zeit") or "", t[0].lower()))

    benutzt = set(str(i) for i in vorhandene_ids)
    spots, objekte = [], []
    for k, (dn, roh, info) in enumerate(angaben):
        safe = sicherer_name(dn, k)
        sid = _eindeutige_id(safe, benutzt)
        datei = sid + _endung(safe)
        objekte.append(("pano/" + datei, roh, content_type(datei)))
        spot = {
            "id": sid,
            "name": f"Standpunkt {nummer_ab + k}",
            "lon": None, "lat": None, "hoehe": None, "heading": None,
            "panorama": "pano/" + datei,
            "lage": None,
            "ausrichtung": "keine",
        }
        spot.update(_vorschau_und_aufnahme(dn, sid, roh, objekte, info))
        spots.append(spot)
    return spots, objekte


def _vorschau_und_aufnahme(dateiname, sid, roh, objekte, info=None):
    """Vorschaubild ablegen und die Aufnahmeangaben bündeln (für den Spot)."""
    info = info or bild_info(roh)
    zusatz = {"aufnahme": {
        "datei": dateiname.replace("\\", "/").split("/")[-1],
        "zeit": info.get("zeit"),
        "kamera": info.get("kamera"),
        "breite": info.get("breite"),
        "hoehe": info.get("hoehe"),
        "equirect": info.get("equirect"),
        "kompass_deg": info.get("kompass_deg"),
        "kompass_bezug": info.get("kompass_bezug"),
        "gps": info.get("gps"),
    }}
    vb = vorschau(roh)
    if vb:
        pfad = "vorschau/" + sid + ".jpg"
        objekte.append((pfad, vb, "image/jpeg"))
        zusatz["vorschau"] = pfad
    return zusatz


def bild_info(data: bytes) -> dict:
    """Was ein 360°-Foto über sich sagt — nachsichtig, jedes Feld darf fehlen.

    {breite, hoehe, equirect, projektion, zeit, kamera, kompass_deg,
     kompass_bezug, gps: {lon, lat, hoehe_msl?} | None}

    `zeit` ist die Aufnahmezeit wie im EXIF (Ortszeit der Kamera, ISO-Form,
    mit Versatz, wenn die Kamera ihn schreibt). Sie ordnet die Bilder — ob die
    Uhr der Kamera stimmte, weiß sie nicht (die THETA im Labor stand auf 2021).
    """
    info = {"breite": None, "hoehe": None, "equirect": False, "projektion": None,
            "zeit": None, "kamera": None, "kompass_deg": None, "kompass_bezug": None,
            "gps": None}
    try:
        im = Image.open(io.BytesIO(data))
        info["breite"], info["hoehe"] = im.size
        exif = im.getexif()
    except Exception:
        return info

    try:
        make = str(exif.get(0x010F) or "").replace("\x00", "").strip()
        model = str(exif.get(0x0110) or "").replace("\x00", "").strip()
        if model and make and not model.upper().startswith(make.upper().split()[0]):
            model = make + " " + model
        info["kamera"] = model or make or None
    except Exception:
        pass

    try:
        sub = exif.get_ifd(0x8769)
        info["zeit"] = _exif_zeit(sub.get(0x9003) or exif.get(0x0132), sub.get(0x9011))
    except Exception:
        pass

    try:
        gps = exif.get_ifd(0x8825)
    except Exception:
        gps = {}
    if gps and gps.get(17) is not None:
        try:
            info["kompass_deg"] = float(gps.get(17)) % 360.0
            info["kompass_bezug"] = _bezug(gps.get(16))
        except (TypeError, ValueError):
            pass
    if info["kompass_deg"] is None:
        h = _gpano_heading(data)
        if h is not None:
            info["kompass_deg"] = h % 360.0

    lage = exif_lage(data)
    if lage:
        info["gps"] = {"lon": lage["lon"], "lat": lage["lat"]}
        if "hoehe" in lage:
            info["gps"]["hoehe_msl"] = lage["hoehe"]

    m = re.search(rb"ProjectionType[>=\"'\s]+([A-Za-z]+)", data[:262144])
    if m:
        info["projektion"] = m.group(1).decode("ascii", "ignore").lower()
    b, h = info["breite"], info["hoehe"]
    info["equirect"] = bool(info["projektion"] == "equirectangular"
                            or (b and h and abs(b - 2 * h) <= max(2, b // 100)))
    return info


def _exif_zeit(roh, versatz=None):
    """'2021:01:31 00:35:16' (+ '+01:00') → '2021-01-31T00:35:16+01:00'."""
    if isinstance(roh, bytes):
        roh = roh.decode("ascii", "ignore")
    m = re.match(r"\s*(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})", str(roh or ""))
    if not m:
        return None
    t = "{}-{}-{}T{}:{}:{}".format(*m.groups())
    if isinstance(versatz, bytes):
        versatz = versatz.decode("ascii", "ignore")
    if versatz and re.fullmatch(r"[+-]\d{2}:\d{2}", str(versatz).strip()):
        t += str(versatz).strip()
    return t


def vorschau(data: bytes, breite=VORSCHAU_BREITE):
    """Kleines JPEG desselben Bildes (Seitenverhältnis bleibt) — oder None.

    `draft` lässt den JPEG-Dekoder gleich in 1/2, 1/4 oder 1/8 der Größe
    dekodieren: ein 5376er Panorama braucht so ein Achtel der Zeit und des
    Speichers, und das zählt bei fünfzig Bildern in einem Import.
    """
    try:
        im = Image.open(io.BytesIO(data))
        w, h = im.size
        if not w or not h:
            return None
        hz = max(1, round(breite * h / w))
        try:
            im.draft("RGB", (breite, hz))
        except Exception:
            pass
        im = im.convert("RGB").resize((breite, hz), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=80, optimize=True)
        return buf.getvalue()
    except Exception:
        return None


def missweisung(lon, lat, jahr=None):
    """Magnetische Missweisung in Grad (Ost positiv) — Näherung für Mitteleuropa.

    Ein Kompasswert mit Bezug „M" zeigt nach magnetisch Nord; geografisch Nord
    liegt um die Missweisung D daneben: rechtweisend = magnetisch + D.
    Gerechnet wird eine Ebene durch Stützwerte des WMM 2025 (NOAA) für 2025.0 —
    Köln 3,0°, Mainz 3,4°, Hamburg 4,0°, München 4,4°, Berlin 5,1° — und die
    jährliche Änderung von rund +0,15°. Abweichung im Gebiet unter 0,5°; im
    Gebäude stört das Eisen den Kompass ohnehin stärker. Deshalb ist diese Zahl
    ein Startwert und das Ausrichten am Modell der eigentliche Weg.

    Außerhalb von 44–57° N / 3–18° O: None (keine erfundene Zahl).
    Dieselbe Formel steht in frontend/pano-import.js (`missweisung`).
    """
    if lon is None or lat is None or not (44.0 <= lat <= 57.0 and 3.0 <= lon <= 18.0):
        return None
    if jahr is None:
        jahr = datetime.now(timezone.utc).year + 0.5
    return 3.0 + 0.33 * (float(lon) - 7.0) + 0.15 * (float(jahr) - 2025.0)


# ── Editor: Änderungen an einer Tour übernehmen ──────────────────────────────

def tour_bearbeiten(tour, aenderung):
    """(tour_neu, entfernte_spots) — übernimmt, was der Editor schickt.

    `aenderung`: {name?, einstellungen?, spots?: [{id, name?, lon?, lat?,
    hoehe?, boden?, heading?, nachbarn?, ausrichtung?, lage?}]}

    Nur bekannte Felder werden übernommen; Panorama, Vorschau und Aufnahme
    bleiben, wie das Backend sie geschrieben hat — sonst könnte ein Editor
    einen Spot auf eine fremde Datei zeigen lassen. Steht `spots` in der
    Änderung, gilt ihre Reihenfolge, und nicht genannte Spots fallen weg (der
    Aufrufer räumt ihre Bilder ab). Ein unverorteter Spot hat lon, lat und
    hoehe alle null — halb verortet gibt es nicht, der Viewer stünde sonst im
    Erdmittelpunkt.
    """
    if not isinstance(aenderung, dict):
        raise ValueError("Änderung muss ein JSON-Objekt sein.")
    neu = dict(tour)

    if "name" in aenderung:
        name = str(aenderung["name"] or "").strip()
        if not name or len(name) > 120:
            raise ValueError("Der Name muss 1 bis 120 Zeichen lang sein.")
        neu["name"] = name

    if "einstellungen" in aenderung:
        e = aenderung["einstellungen"] or {}
        if not isinstance(e, dict):
            raise ValueError("einstellungen muss ein Objekt sein.")
        st = dict(EINSTELLUNGEN_VORGABE)
        st.update(tour.get("einstellungen") or {})
        if "aufnahmehoehe" in e:
            st["aufnahmehoehe"] = _zahl_in(e["aufnahmehoehe"], 0.0, 5.0, "Aufnahmehöhe")
        if "radius" in e:
            st["radius"] = _zahl_in(e["radius"], 1.0, 200.0, "Radius")
        if "missweisung" in e:
            st["missweisung"] = None if e["missweisung"] is None else \
                _zahl_in(e["missweisung"], -30.0, 30.0, "Missweisung")
        if "nachbarn" in e:
            if e["nachbarn"] not in ("kette+naehe", "naehe"):
                raise ValueError("nachbarn: „kette+naehe“ oder „naehe“.")
            st["nachbarn"] = e["nachbarn"]
        neu["einstellungen"] = st

    entfernt = []
    if "spots" in aenderung:
        liste = aenderung["spots"]
        if not isinstance(liste, list):
            raise ValueError("spots muss eine Liste sein.")
        alt = {str(s.get("id")): s for s in tour.get("spots", [])}
        gesehen, spots = set(), []
        for e in liste:
            if not isinstance(e, dict):
                raise ValueError("Jeder Spot muss ein Objekt sein.")
            sid = str(e.get("id"))
            if sid not in alt:
                raise ValueError(f"Unbekannter Standpunkt „{sid}“.")
            if sid in gesehen:
                raise ValueError(f"Standpunkt „{sid}“ doppelt genannt.")
            gesehen.add(sid)
            spots.append(_spot_bearbeiten(alt[sid], e))
        ids = {s["id"] for s in spots}
        for s in spots:
            if "nachbarn" in s and s["nachbarn"] is not None:
                s["nachbarn"] = [n for i, n in enumerate(s["nachbarn"])
                                 if n in ids and n != s["id"] and n not in s["nachbarn"][:i]]
        entfernt = [s for sid, s in alt.items() if sid not in gesehen]
        neu["spots"] = spots

    neu["geaendert"] = datetime.now(timezone.utc).isoformat()
    return neu, entfernt


def _spot_bearbeiten(alt, e):
    s = dict(alt)
    sid = s["id"]
    if "name" in e:
        name = str(e["name"] or "").strip()
        if not name or len(name) > 120:
            raise ValueError(f"{sid}: Name muss 1 bis 120 Zeichen lang sein.")
        s["name"] = name
    if any(k in e for k in ("lon", "lat", "hoehe")):
        lon, lat, hoehe = e.get("lon", s.get("lon")), e.get("lat", s.get("lat")), e.get("hoehe", s.get("hoehe"))
        if lon is None and lat is None and hoehe is None:
            s["lon"] = s["lat"] = s["hoehe"] = None
        elif lon is None or lat is None or hoehe is None:
            raise ValueError(f"{sid}: lon, lat und hoehe nur zusammen setzen oder zusammen leeren.")
        else:
            s["lon"] = _zahl_in(lon, -180.0, 180.0, f"{sid}: lon")
            s["lat"] = _zahl_in(lat, -90.0, 90.0, f"{sid}: lat")
            s["hoehe"] = _zahl_in(hoehe, -1000.0, 10000.0, f"{sid}: hoehe")
    if "boden" in e:
        s["boden"] = None if e["boden"] is None else _zahl_in(e["boden"], -1000.0, 10000.0, f"{sid}: boden")
    if "heading" in e:
        if e["heading"] is None:
            s["heading"] = None
        else:
            h = _zahl_in(e["heading"], -100.0, 100.0, f"{sid}: heading")
            # In (−π, π] — eine Zahl je Richtung, damit zwei Stände vergleichbar sind.
            h = math.atan2(math.sin(h), math.cos(h))
            s["heading"] = h
    if "nachbarn" in e:
        nb = e["nachbarn"]
        if nb is None:
            s.pop("nachbarn", None)
        elif not isinstance(nb, list):
            raise ValueError(f"{sid}: nachbarn muss eine Liste sein.")
        else:
            s["nachbarn"] = [str(n) for n in nb]
    if "ausrichtung" in e:
        if e["ausrichtung"] not in AUSRICHTUNGEN:
            raise ValueError(f"{sid}: ausrichtung ist eins von {', '.join(AUSRICHTUNGEN)}.")
        s["ausrichtung"] = e["ausrichtung"]
    if "lage" in e:
        if e["lage"] not in LAGEN:
            raise ValueError(f"{sid}: unbekannte Lage-Quelle „{e['lage']}“.")
        s["lage"] = e["lage"]
    if s.get("lon") is None:
        s["lage"] = None
    return s


def _zahl_in(wert, lo, hi, name):
    try:
        z = float(wert)
    except (TypeError, ValueError):
        raise ValueError(f"{name}: keine Zahl.")
    if not math.isfinite(z) or z < lo or z > hi:
        raise ValueError(f"{name}: {z} liegt nicht zwischen {lo} und {hi}.")
    return z


def objekte_von(spot):
    """Die Objekte eines Spots im Speicher (relativ zur Tour) — zum Abräumen.
    Nur Pfade unter pano/ und vorschau/: nichts, was aus dem Präfix führt."""
    aus = []
    for feld in ("panorama", "vorschau"):
        p = spot.get(feld)
        if isinstance(p, str) and re.fullmatch(r"(pano|vorschau)/[A-Za-z0-9._-]+", p) and ".." not in p:
            aus.append(p)
    return aus


def zaehlen(tour):
    """Kopfzahlen einer Tour für Listen: anzahl, verortet, ausgerichtet."""
    spots = tour.get("spots", [])
    verortet = [s for s in spots if isinstance(s.get("lon"), (int, float))
                and isinstance(s.get("lat"), (int, float))]
    return {
        "anzahl": len(spots),
        "verortet": len(verortet),
        "ausgerichtet": sum(1 for s in verortet if s.get("ausrichtung") == "hand"),
    }


def _eindeutige_id(safe, benutzt):
    stamm = safe[: len(safe) - len(_endung(safe))] or safe
    sid, k = stamm, 2
    while sid in benutzt:
        sid = f"{stamm}-{k}"
        k += 1
    benutzt.add(sid)
    return sid


def _ohne_intern(spot):
    """`quelle` ist eine Bau-Notiz und gehört nicht in die ausgelieferte Datei
    — der Viewer kennt das Feld nicht. Nachbarn nur mitschreiben, wenn gesetzt."""
    d = {k: v for k, v in spot.items() if k != "quelle"}
    return d
