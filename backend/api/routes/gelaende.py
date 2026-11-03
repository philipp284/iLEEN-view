"""
DGM1 Rheinland-Pfalz als Geländekacheln für den Viewer (frontend/gelaende.js).

Seit dem 2026-10-31 stand iLEEN beim Gelände allein auf basemap.de 3D (DGM5, BKG). Als dessen Server ausfiel, blieb
der Globus unter ~500 m stehen, und das DGM5 darf ohnehin nicht zwischengespeichert werden (Beta „zu Testzwecken").
Das DGM1 des Landes RLP steht unter dl-de/by-2-0: speichern und ausliefern ist erlaubt, und es ist fünfmal feiner.

Kacheln entstehen auf Anfrage, nicht vorab — bei 1 m wären es über eine Million Dateien. Je Kachel des geografischen
Kachelschemas von Cesium (2 × 1 Kacheln auf Ebene 0) werden 65 × 65 Stützstellen bilinear abgetastet:

  Stützstellenabstand ≤ 6 m   → die 1-m-Originale (GeoTIFF je km², Zwischenspeicher der zuletzt gelesenen)
                     ≤ 24 m   → Übersicht 8 m
                     ≤ 96 m   → Übersicht 32 m
                     sonst    → Übersicht 128 m

Die Übersichten baut projekte/2026_1031_mainz_zwilling/skripte/dgm1_uebersichten.py. Geliefert wird Float32
little-endian, Reihe 0 im Süden, Höhen über NHN (DHHN2016); NaN, wo das DGM1 nichts hat — dort füllt der Viewer aus
DGM5 bzw. Terrain Tiles. Den Aufschlag auf den Ellipsoid (EGM96) macht der Viewer, wie beim DGM5.
"""

import json
import logging
import math
import os
import re
import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Response
from PIL import Image
from pyproj import Transformer
from scipy.ndimage import map_coordinates

logger = logging.getLogger(__name__)
router = APIRouter()

UEBERSICHT = Path(os.environ.get('DGM1_UEBERSICHT', '/data/dgm1'))
ORIGINALE = Path(os.environ.get('DGM1_QUELLE', '/data/dgm1_rlp'))
KANTE = 65
NACH_UTM = Transformer.from_crs('EPSG:4326', 'EPSG:25832', always_xy=True)
NACH_WGS = Transformer.from_crs('EPSG:25832', 'EPSG:4326', always_xy=True)
MUSTER = re.compile(r'dgm1_32_(\d+)_(\d+)_1_rp_\d+\.tif$')
QUELLVERMERK = 'DGM1 RLP: © GeoBasis-DE / LVermGeoRP (2022–2025), dl-de/by-2-0'

_sperre = threading.Lock()
_stand = {}                         # meta, stufen (memmap), originale (km → Pfad), grenzen
_kacheln = OrderedDict()            # (E km, N km) → Float32 1000 × 1000, zuletzt benutzte zuletzt
_KACHELN_MAX = 48                   # 48 × 4 MB


def _laden():
    with _sperre:
        if _stand:
            return _stand
        meta_pfad = UEBERSICHT / 'meta.json'
        if not meta_pfad.exists():
            raise HTTPException(503, 'DGM1-Übersichten fehlen (dgm1_uebersichten.py)')
        meta = json.loads(meta_pfad.read_text())
        stufen = {int(k): np.load(UEBERSICHT / v['datei'], mmap_mode='r') for k, v in meta['stufen'].items()}
        originale = {}
        if ORIGINALE.is_dir():
            for f in os.listdir(ORIGINALE):
                t = MUSTER.match(f)
                if t:
                    originale[int(t.group(1)), int(t.group(2))] = ORIGINALE / f
        e0, e1, n0, n1 = (k * 1000 for k in meta['kacheln_km'])
        ecken = [NACH_WGS.transform(e, n) for e in (e0, e1) for n in (n0, n1)]
        grenzen = [min(p[0] for p in ecken), min(p[1] for p in ecken), max(p[0] for p in ecken), max(p[1] for p in ecken)]
        _stand.update(meta=meta, stufen=stufen, originale=originale, grenzen=grenzen, utm=(e0, e1, n0, n1))
        logger.info('DGM1: %d Originale, Stufen %s', len(originale), sorted(stufen))
        return _stand


def _original(e_km, n_km):
    schluessel = (e_km, n_km)
    with _sperre:
        if schluessel in _kacheln:
            _kacheln.move_to_end(schluessel)
            return _kacheln[schluessel]
    pfad = _stand['originale'].get(schluessel)
    if pfad is None:
        return None
    h = np.array(Image.open(pfad), dtype=np.float32)
    h[(h < -500) | (h > 5000)] = np.nan
    with _sperre:
        _kacheln[schluessel] = h
        while len(_kacheln) > _KACHELN_MAX:
            _kacheln.popitem(last=False)
    return h


def _abtasten(feld, zeilen, spalten):
    """Bilinear, Lücken (NaN) bleiben Lücken; außerhalb des Feldes NaN."""
    return map_coordinates(feld, [zeilen, spalten], order=1, mode='constant', cval=np.nan, prefilter=False)


def _aus_originalen(e, n):
    e_min, e_max = math.floor(e.min()) // 1000, math.floor(e.max()) // 1000
    n_min, n_max = math.floor(n.min()) // 1000, math.floor(n.max()) // 1000
    breite, hoehe = (e_max - e_min + 1) * 1000, (n_max - n_min + 1) * 1000
    feld = np.full((hoehe, breite), np.nan, dtype=np.float32)
    for ek in range(e_min, e_max + 1):
        for nk in range(n_min, n_max + 1):
            h = _original(ek, nk)
            if h is not None:
                z = (n_max - nk) * 1000
                s = (ek - e_min) * 1000
                feld[z:z + 1000, s:s + 1000] = h
    # Pixelmitte: die Weltdatei zeigt auf die Mitte der Zelle oben links
    spalten = e - e_min * 1000 - 0.5
    zeilen = (n_max + 1) * 1000 - n - 0.5
    return _abtasten(feld, zeilen, spalten)


def _aus_uebersicht(stufe, e, n):
    st = _stand
    m = st['stufen'][stufe]
    skala, versatz = st['meta']['skala'], st['meta']['versatz']
    e0, _, _, n1 = st['utm']
    spalten = (e - e0) / stufe - 0.5
    zeilen = (n1 - n) / stufe - 0.5
    z0 = max(int(math.floor(zeilen.min())) - 1, 0); z1 = min(int(math.ceil(zeilen.max())) + 2, m.shape[0])
    s0 = max(int(math.floor(spalten.min())) - 1, 0); s1 = min(int(math.ceil(spalten.max())) + 2, m.shape[1])
    if z0 >= z1 or s0 >= s1:
        return np.full(e.shape, np.nan, dtype=np.float32)
    roh = np.asarray(m[z0:z1, s0:s1]).astype(np.float32)
    feld = np.where(roh == 0, np.nan, roh / skala - versatz).astype(np.float32)
    return _abtasten(feld, zeilen - z0, spalten - s0)


@router.get('/dgm1/info')
def dgm1_info():
    st = _laden()
    return {'quelle': QUELLVERMERK, 'grenzen': st['grenzen'], 'originale': len(st['originale']),
            'stufen_m': sorted(st['stufen']), 'max_ebene': 18, 'hoehenbezug': 'nhn', 'kante': KANTE}


@router.get('/dgm1/{z}/{x}/{y}')
def dgm1_kachel(z: int, x: int, y: int):
    if not (0 <= z <= 20):
        raise HTTPException(400, 'Ebene außerhalb 0–20')
    st = _laden()
    breite = 180.0 / (1 << z)
    west, nord = -180.0 + x * breite, 90.0 - y * breite
    sued, ost = nord - breite, west + breite
    g = st['grenzen']
    if ost < g[0] or west > g[2] or nord < g[1] or sued > g[3]:
        return Response(status_code=204)

    schritt = breite / (KANTE - 1)
    lon = west + np.arange(KANTE) * schritt
    lat = sued + np.arange(KANTE) * schritt                  # Reihe 0 im Süden
    lon2, lat2 = np.meshgrid(lon, lat)
    e, n = NACH_UTM.transform(lon2, lat2)
    abstand = schritt * 111_320 * math.cos(math.radians((nord + sued) / 2))
    if abstand <= 6:
        h, quelle = _aus_originalen(e, n), '1m'
    else:
        stufe = 8 if abstand <= 24 else 32 if abstand <= 96 else 128
        h, quelle = _aus_uebersicht(stufe, e, n), f'{stufe}m'
    if not np.isfinite(h).any():
        return Response(status_code=204)
    return Response(content=h.astype('<f4').tobytes(), media_type='application/octet-stream',
                    headers={'Cache-Control': 'public, max-age=86400', 'X-Dgm1-Quelle': quelle,
                             'Access-Control-Expose-Headers': 'X-Dgm1-Quelle'})
