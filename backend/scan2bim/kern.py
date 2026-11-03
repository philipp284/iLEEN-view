"""
Scan2BIM — Rechenkern: von der Punktwolke zu klassifizierten Objekten.

Die Stufen dieses Moduls sind einzeln aufrufbar und schreiben ihre
Zwischenstände als `.npz`/`.json` in einen Arbeitsordner. Das ist Absicht: ein
Lauf über hundert Millionen Punkte soll nach einem Fehler in Stufe 4 nicht bei
Stufe 1 wieder anfangen müssen, und die Zwischenstände sind das, was man
ansieht, wenn ein Ergebnis nicht stimmt.

    zellstatistik → gelaende → flaechen → objekte

Die Ausgabe (Geländenetz, GLB, IFC) liegt in `netz.py`, `ausgabe_glb.py` und
`ausgabe_ifc.py`; `lauf.py` fügt alles zusammen, `cli.py` ist der
Kommandozeilenweg, `api/routes/scan2bim.py` der über HTTP.
"""
import json
import logging
import math
from pathlib import Path

import numpy as np
import scipy.ndimage as ndi

log = logging.getLogger("scan2bim")

RASTER_M = 0.20          # Rasterweite der Zellstatistik
MASCHE_M = 1.00          # Maschenweite des Geländenetzes
FELDBREITE_M = 3.5       # Regelbreite eines mobilen Bauzaunfeldes


# ── 1. Punkte einlesen und je Rasterzelle die Höhenverteilung bilden ────────
#
# Eine 20-cm-Zelle mit ihren Perzentilen ist die Grundlage für alles Weitere:
# das 10. Perzentil trägt den Boden, das 98. die Oberfläche, die Differenz die
# Objekthöhe. Ein einzelnes Minimum wäre zu anfällig — Photogrammetrie streut
# vereinzelte Punkte weit unter das Gelände, und ein Minimum greift genau die.

def zellstatistik(las: Path, ziel: Path) -> dict:
    import laspy

    log.info("Lese %s", las.name)
    daten = laspy.read(str(las))
    xyz = np.vstack((daten.x, daten.y, daten.z)).T.astype(np.float32)
    hat_farbe = hasattr(daten, "red")
    rgb = (np.vstack((daten.red, daten.green, daten.blue)).T >> 8).astype(np.uint8) \
        if hat_farbe else np.full((len(xyz), 3), 160, np.uint8)
    log.info("%d Punkte, Ausdehnung %.1f x %.1f x %.1f m", len(xyz),
             *(xyz.max(0) - xyz.min(0)))

    x0, y0 = float(xyz[:, 0].min()), float(xyz[:, 1].min())
    breite = int((xyz[:, 0].max() - x0) / RASTER_M) + 1
    hoehe = int((xyz[:, 1].max() - y0) / RASTER_M) + 1
    spalte = ((xyz[:, 0] - x0) / RASTER_M).astype(np.int32)
    zeile = ((xyz[:, 1] - y0) / RASTER_M).astype(np.int32)
    zelle = zeile.astype(np.int64) * breite + spalte

    # Einmal nach (Zelle, Höhe) sortieren — danach ist jedes Perzentil ein
    # Indexzugriff statt einer Gruppierung.
    ordnung = np.lexsort((xyz[:, 2], zelle))
    zs = zelle[ordnung]
    hs = xyz[ordnung, 2]
    cs = rgb[ordnung]
    start = np.flatnonzero(np.r_[True, zs[1:] != zs[:-1]])
    kennung = zs[start]
    anzahl = np.diff(np.r_[start, len(zs)])

    n = breite * hoehe
    ausgabe = {}
    for name, p in [("p10", 0.10), ("p50", 0.50), ("p98", 0.98)]:
        werte = hs[start + np.minimum((anzahl * p).astype(np.int64), anzahl - 1)]
        feld = np.full(n, np.nan, np.float32)
        feld[kennung] = werte
        ausgabe[name] = feld.reshape(hoehe, breite)
    zaehler = np.zeros(n, np.int32)
    zaehler[kennung] = anzahl
    ausgabe["n"] = zaehler.reshape(hoehe, breite)

    summe = np.add.reduceat(cs.astype(np.int64), start, axis=0)
    farbe = np.zeros((n, 3), np.uint8)
    farbe[kennung] = (summe // anzahl[:, None]).astype(np.uint8)
    ausgabe["col"] = farbe.reshape(hoehe, breite, 3)

    # Orthophoto: Farbe des jeweils höchsten Punktes je Zelle.
    ortho = np.zeros((n, 3), np.uint8)
    ortho[zelle[ordnung]] = rgb[ordnung]
    ausgabe["ortho"] = ortho.reshape(hoehe, breite, 3)

    meta = np.array([x0, y0, RASTER_M, breite, hoehe], np.float64)
    np.savez(ziel / "zellen.npz", **ausgabe, meta=meta)

    from PIL import Image
    Image.fromarray(ausgabe["ortho"][::-1]).save(ziel / "ortho.png")
    log.info("Raster %d x %d, %d Zellen belegt", breite, hoehe, int((zaehler > 0).sum()))

    # Die Bounding Box der Rohpunkte, nicht die des geglätteten Geländes: aus
    # genau dieser Box hat py3dtiles beim Ablegen der Wolke zentriert, und nur
    # mit ihr trifft die Rückrechnung der Georeferenz den Anker exakt.
    bbox = dict(lo=[float(v) for v in xyz.min(0)], hi=[float(v) for v in xyz.max(0)])
    (ziel / "bbox_punkte.json").write_text(json.dumps(bbox, indent=1))
    return dict(punkte=int(len(xyz)), breite=breite, hoehe=hoehe, bbox=bbox,
                ausdehnung=[float(v) for v in (xyz.max(0) - xyz.min(0))])


# ── 2. Gelände: progressiver morphologischer Filter ─────────────────────────
#
# Ein Öffnen mit wachsendem Fenster hebt nacheinander immer größere Aufbauten
# ab — erst Zäune und Autos, dann Container, zuletzt Hallen. Die Höhenschwelle
# wächst mit der Fenstergröße mit, sonst würde ein geneigtes Gelände selbst als
# Aufbau gelten. Wichtig: eine Baugrube liegt *unter* dem Gelände und wird von
# einem Öffnen nie angetastet — sie bleibt vollständig erhalten.

def gelaende(ziel: Path) -> dict:
    d = np.load(ziel / "zellen.npz")
    n, p10, p98 = d["n"], d["p10"], d["p98"]
    belegt = n >= 4

    kandidat = np.where(belegt, p10, np.nan)

    def glaetten(a, s):
        wert = np.nan_to_num(a)
        gewicht = (~np.isnan(a)).astype(np.float32)
        g = ndi.uniform_filter(gewicht, s)
        return np.where(g > 0.02, ndi.uniform_filter(wert, s) / np.maximum(g, 1e-6), np.nan)

    referenz = glaetten(kandidat, 25)
    z = np.where(np.isnan(kandidat) | (kandidat < referenz - 1.2), np.nan, kandidat)
    gueltig = ~np.isnan(z)
    z = z[tuple(ndi.distance_transform_edt(~gueltig, return_distances=False, return_indices=True))]
    z = ndi.median_filter(z, 5)

    boden = z.copy()
    for i, fenster_m in enumerate([1, 2, 4, 8, 16, 28]):
        w = int(fenster_m / RASTER_M) | 1
        geoeffnet = ndi.grey_opening(boden, size=(w, w))
        schwelle = 0.35 if i == 0 else min(0.30 * fenster_m + 0.35, 4.0)
        boden = np.where((boden - geoeffnet) > schwelle, geoeffnet, boden)
    boden = ndi.gaussian_filter(boden, 2.5)

    oberflaeche = np.where(belegt, p98, np.nan)
    oberflaeche = oberflaeche[tuple(ndi.distance_transform_edt(
        np.isnan(oberflaeche), return_distances=False, return_indices=True))]
    ueber_boden = np.where(belegt, oberflaeche - boden, np.nan)

    np.savez(ziel / "gelaende.npz", boden=boden, oberflaeche=oberflaeche,
             h=ueber_boden, maske=belegt, meta=d["meta"])
    log.info("Gelände %.2f..%.2f m, Objekthöhen bis %.2f m",
             boden[belegt].min(), boden[belegt].max(), np.nanmax(ueber_boden))
    return dict(gelaende_min=float(boden[belegt].min()), gelaende_max=float(boden[belegt].max()))


# ── 3. Baugrube und Verkehrsfläche ─────────────────────────────────────────
#
# Die Grube ergibt sich als Differenz zum „zugeschütteten" Gelände: ein
# Schließen mit großem Fenster überbrückt die Grube, die Differenz ist der
# Aushub. Das liefert nebenbei die Kubatur — die Zahl, wegen der man einen
# Baustellenscan überhaupt fliegt.

def flaechen(ziel: Path) -> dict:
    d = np.load(ziel / "zellen.npz")
    t = np.load(ziel / "gelaende.npz")
    x0, y0, res, breite, hoehe = d["meta"]
    boden, maske, col = t["boden"], t["maske"], d["col"]
    h = np.nan_to_num(t["h"])

    urgelaende = ndi.gaussian_filter(
        ndi.grey_closing(boden, size=(int(45 / res) | 1,) * 2), 12)
    tiefe = urgelaende - boden
    grube = ndi.binary_closing(
        ndi.binary_opening(maske & (tiefe > 0.9), np.ones((9, 9))), np.ones((25, 25)))
    lab, anz = ndi.label(grube)
    if anz:
        groessen = ndi.sum(grube, lab, range(1, anz + 1))
        grube = lab == (1 + int(np.argmax(groessen)))

    o = col.astype(np.float32) + 1
    helligkeit = o.sum(2) / 3
    saettigung = (o.max(2) - o.min(2)) / np.maximum(o.max(2), 1)
    strasse = maske & ~grube & (h < 0.35) & (saettigung < 0.14) \
        & (helligkeit > 55) & (helligkeit < 185)
    strasse = ndi.binary_closing(
        ndi.binary_opening(strasse, np.ones((5, 5))), np.ones((13, 13)))
    lab, anz = ndi.label(strasse)
    if anz:
        groessen = ndi.sum(strasse, lab, range(1, anz + 1))
        strasse = np.isin(lab, [i + 1 for i, s in enumerate(groessen) if s * res * res > 120])

    volumen = float(tiefe[grube].sum() * res * res) if grube.any() else 0.0
    np.savez(ziel / "flaechen.npz", grube=grube, strasse=strasse, tiefe=tiefe)
    kennzahl = dict(
        grube_m2=float(grube.sum() * res * res),
        aushub_m3=volumen,
        max_tiefe_m=float(tiefe[grube].max()) if grube.any() else 0.0,
        sohle_lokal_m=float(np.percentile(boden[grube], 25)) if grube.any() else 0.0,
        verkehr_m2=float(strasse.sum() * res * res),
    )
    (ziel / "kennzahlen.json").write_text(json.dumps(kennzahl, indent=1))
    log.info("Baugrube %.0f m², %.0f m³ Aushub, bis %.2f m tief",
             kennzahl["grube_m2"], kennzahl["aushub_m3"], kennzahl["max_tiefe_m"])
    return kennzahl


# ── 4. Objekte segmentieren und klassifizieren ─────────────────────────────
#
# Zusammenhängende Bereiche über 0,55 m sind Objekte. Klassifiziert wird an
# dem, was messbar ist: Grundfläche, Schlankheit der ausgerichteten Box, Höhe
# und Farbe. Ein Bauzaun ist rot und lang, ein Baum grün und hoch, ein
# Fahrzeug 4 x 2 m — diese Regeln sind bewusst lesbar gehalten, damit man sie
# an einem anderen Bauzustand nachziehen kann.

def objekte(ziel: Path) -> dict:
    from skimage import measure
    from skimage.morphology import skeletonize
    from shapely.geometry import Polygon, LineString, MultiPolygon

    d = np.load(ziel / "zellen.npz")
    t = np.load(ziel / "gelaende.npz")
    f = np.load(ziel / "flaechen.npz")
    x0, y0, res, breite, hoehe = d["meta"]
    breite, hoehe = int(breite), int(hoehe)
    h = np.nan_to_num(t["h"])
    maske, boden, col = t["maske"], t["boden"], d["col"]
    grube, strasse = f["grube"], f["strasse"]

    o = col.astype(np.float32) + 1
    gruen = (2 * o[:, :, 1] - o[:, :, 0] - o[:, :, 2]) / o.sum(2)
    rot = (2 * o[:, :, 0] - o[:, :, 1] - o[:, :, 2]) / o.sum(2)
    hell = o.sum(2) / 3

    aufbau = ndi.binary_closing(
        ndi.binary_opening(maske & (h > 0.55), np.ones((3, 3))), np.ones((5, 5)))
    lab, anzahl = ndi.label(aufbau, structure=np.ones((3, 3)))

    gefunden = []
    for i, fenster in enumerate(ndi.find_objects(lab), start=1):
        if fenster is None:
            continue
        teil = lab[fenster] == i
        flaeche = teil.sum() * res * res
        if flaeche < 1.2:
            continue
        zs, xs = np.nonzero(teil)
        zs, xs = zs + fenster[0].start, xs + fenster[1].start
        P = np.c_[xs * res, zs * res]
        P = P - P.mean(0)
        if len(P) > 3:
            _, _, Vt = np.linalg.svd(P, full_matrices=False)
            Q = P @ Vt.T
            laenge = Q[:, 0].max() - Q[:, 0].min()
            tiefe_ = Q[:, 1].max() - Q[:, 1].min()
        else:
            laenge = tiefe_ = math.sqrt(flaeche)
        gefunden.append(dict(
            id=int(i), flaeche=float(flaeche), laenge=float(laenge),
            breite=float(max(tiefe_, 0.01)), h_max=float(h[zs, xs].max()),
            gi=float(np.median(gruen[zs, xs])), ri=float(np.median(rot[zs, xs])),
            hell=float(np.median(hell[zs, xs])),
            in_grube=bool(grube[zs, xs].mean() > 0.4),
            rgb=[int(np.median(col[zs, xs, k])) for k in range(3)],
            z_fuss=float(np.percentile(boden[zs, xs], 20))))

    def klasse(e):
        schlank = e["laenge"] / max(e["breite"], 0.3)
        r, g, b = e["rgb"]
        if e["gi"] > 0.13 and e["h_max"] > 2.0:
            return "Vegetation"
        if r > 95 and g > 85 and b < min(r, g) * 0.72 and e["flaeche"] > 2.5:
            return "Baumaschine"
        if e["ri"] > 0.14 and 1.0 < e["h_max"] < 4.0 and (schlank > 2.5 or e["flaeche"] < 20):
            return "Bauzaun"
        if e["flaeche"] > 55 and e["h_max"] > 2.2 and e["gi"] < 0.12:
            return "Gebaeude"
        if 5.0 <= e["laenge"] <= 14 and 2.0 <= e["breite"] <= 4.2 and 2.0 <= e["h_max"] <= 3.6:
            return "Container"
        if 3.2 <= e["laenge"] <= 6.5 and 1.4 <= e["breite"] <= 2.6 and 1.1 <= e["h_max"] <= 2.6:
            return "Fahrzeug"
        if e["h_max"] > 4.0 and e["gi"] > 0.05:
            return "Vegetation"
        return "Ausstattung" if e["flaeche"] >= 4.0 else "Kleinteil"

    for e in gefunden:
        e["klasse"] = klasse(e)

    # ── Umrisse
    def kontur(m, toleranz=0.6):
        ecken = measure.find_contours(np.pad(m.astype(np.uint8), 1), 0.5)
        if not ecken:
            return None
        c = max(ecken, key=len) - 1
        p = Polygon([(x0 + q[1] * res, y0 + q[0] * res) for q in c]).buffer(0)
        if isinstance(p, MultiPolygon):
            p = max(p.geoms, key=lambda g: g.area)
        return None if p.is_empty else p.simplify(toleranz)

    elemente = {"Gebaeude": [], "Bauzaun": [], "Boxen": []}
    for e in gefunden:
        if e["klasse"] != "Gebaeude":
            continue
        p = kontur(lab == e["id"], 0.8)
        if p is None or p.area < 25:
            continue
        rechteck = p.minimum_rotated_rectangle
        # Ein Baukörper, der sein umschreibendes Rechteck gut ausfüllt, wird als
        # Rechteck geführt — das gibt gerade Kanten statt eines gezackten Umrisses.
        nutzen = rechteck if p.area / max(rechteck.area, 1e-9) > 0.82 else p
        zs, xs = np.nonzero(lab == e["id"])
        elemente["Gebaeude"].append(dict(
            ring=[list(c) for c in nutzen.exterior.coords],
            z_fuss=float(np.percentile(boden[zs, xs], 20)),
            hoehe=float(np.percentile(h[zs, xs], 90)), flaeche=float(nutzen.area)))

    # Fassaden jenseits der Hauptverkehrsfläche sind aus der Luft nur
    # streifenweise erfasst — sie zerfallen in Dutzende Fragmente, die einzeln
    # als Platten im Modell stünden. Ein Schließen über 4 m fügt sie zu
    # Baukörpern zusammen; was danach unter 35 m² bleibt, ist zu dünn belegt
    # und wird verworfen statt geraten.
    if strasse.any():
        lz, nz = ndi.label(strasse)
        groessen = ndi.sum(strasse, lz, range(1, nz + 1))
        haupt = lz == (1 + int(np.argmax(groessen)))
        hz, hx = np.nonzero(haupt)
        achse = np.polyfit(x0 + hx * res, y0 + hz * res, 1)
        yy = y0 + np.arange(hoehe)[:, None] * res
        xx = x0 + np.arange(breite)[None, :] * res
        jenseits = yy < (achse[0] * xx + achse[1]) - 6.0
        bebauung = ndi.binary_opening(ndi.binary_closing(
            maske & jenseits & (h > 2.0) & (gruen < 0.12), np.ones((21, 21))), np.ones((7, 7)))
        lb, nb = ndi.label(bebauung)
        for i in range(1, nb + 1):
            m = lb == i
            if m.sum() * res * res < 35:
                continue
            p = kontur(m, 1.0)
            if p is None:
                continue
            rechteck = p.minimum_rotated_rectangle
            nutzen = rechteck if p.area / max(rechteck.area, 1e-9) > 0.68 else p
            zs, xs = np.nonzero(m)
            elemente["Gebaeude"].append(dict(
                ring=[list(c) for c in nutzen.exterior.coords],
                z_fuss=float(np.percentile(boden[zs, xs], 15)),
                hoehe=float(np.percentile(h[zs, xs], 85)), flaeche=float(nutzen.area)))
            # Die Fragmente selbst dürfen nicht zusätzlich als Kleinteile stehen.
            for e in gefunden:
                if e["klasse"] in ("Ausstattung", "Kleinteil") and ((lab == e["id"]) & m).any():
                    e["klasse"] = "verworfen"

    zaun = np.zeros_like(lab, bool)
    for e in gefunden:
        if e["klasse"] == "Bauzaun":
            zaun |= lab == e["id"]
    zaun = ndi.binary_closing(ndi.binary_dilation(zaun, np.ones((7, 7))), np.ones((15, 15)))
    lz, nz = ndi.label(zaun, np.ones((3, 3)))
    for i in range(1, nz + 1):
        m = lz == i
        if m.sum() * res * res < 8:
            continue
        zs, xs = np.nonzero(skeletonize(m))
        if len(zs) < 12:
            continue
        punkte = np.c_[x0 + xs * res, y0 + zs * res].tolist()
        # Achse ordnen: vom ersten Punkt jeweils zum nächstgelegenen weiter.
        kette = [punkte.pop(0)]
        while punkte:
            letzter = np.array(kette[-1])
            rest = np.array(punkte)
            k = int(np.argmin(((rest - letzter) ** 2).sum(1)))
            if math.sqrt(((rest[k] - letzter) ** 2).sum()) > 4.0:
                break
            kette.append(punkte.pop(k))
        if len(kette) < 6:
            continue
        achse = LineString(kette).simplify(0.9)
        elemente["Bauzaun"].append(dict(
            pfad=[list(c) for c in achse.coords], laenge=float(achse.length),
            z_fuss=float(np.median(boden[zs, xs])),
            hoehe=float(np.clip(np.percentile(h[zs, xs], 75), 1.6, 2.4))))

    for e in gefunden:
        if e["klasse"] not in ("Fahrzeug", "Container", "Ausstattung",
                               "Kleinteil", "Baumaschine") or e["flaeche"] < 2.5:
            continue
        p = kontur(lab == e["id"], 0.5)
        if p is None:
            continue
        ecken = list(p.minimum_rotated_rectangle.exterior.coords)[:4]
        if len(ecken) < 4:
            continue
        zs, xs = np.nonzero(lab == e["id"])
        elemente["Boxen"].append(dict(
            klasse=e["klasse"], ecken=[list(c) for c in ecken],
            z_fuss=float(np.percentile(boden[zs, xs], 20)),
            hoehe=float(np.percentile(h[zs, xs], 92)), in_grube=e["in_grube"]))

    # ── Einzelbäume aus der Vegetationsmaske
    vegetation = ndi.binary_closing(ndi.binary_opening(
        maske & (gruen > 0.11) & (h > 1.8), np.ones((3, 3))), np.ones((5, 5)))
    krone = ndi.gaussian_filter(np.where(vegetation, h, 0), 3.5)
    wipfel = vegetation & (krone >= ndi.maximum_filter(krone, size=17) - 1e-6) & (h > 2.5)
    lw, nw = ndi.label(wipfel, np.ones((3, 3)))
    mitten = ndi.center_of_mass(wipfel, lw, range(1, nw + 1))
    saat = np.zeros_like(lw)
    for i, (cz, cx) in enumerate(mitten, start=1):
        saat[int(round(cz)), int(round(cx))] = i
    zuordnung = np.where(vegetation, saat[tuple(ndi.distance_transform_edt(
        saat == 0, return_distances=False, return_indices=True))], 0)
    baeume = []
    for i, (cz, cx) in enumerate(mitten, start=1):
        m = zuordnung == i
        a = m.sum() * res * res
        if a < 2.0:
            continue
        zs, xs = np.nonzero(m)
        hoch = h[zs, xs].max()
        radius = math.sqrt(a / math.pi)
        if hoch < 2.5 or radius < 0.8:
            continue
        baeume.append(dict(x=float(x0 + cx * res), y=float(y0 + cz * res),
                           z=float(boden[int(cz), int(cx)]), hoehe=float(hoch),
                           radius=float(min(radius, hoch * 0.6)), flaeche=float(a)))
    elemente["Baeume"] = sorted(baeume, key=lambda b: -b["hoehe"])

    (ziel / "elemente.json").write_text(json.dumps(elemente, indent=1))
    from collections import Counter
    verteilung = Counter(e["klasse"] for e in gefunden)
    log.info("Objekte: %s | %d Bäume, %d Zaunabschnitte, %d Baukörper",
             dict(verteilung), len(elemente["Baeume"]),
             len(elemente["Bauzaun"]), len(elemente["Gebaeude"]))
    return dict(verteilung=dict(verteilung), baeume=len(elemente["Baeume"]))
