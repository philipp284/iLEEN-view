"""
Bauzeichnung aus dem IFC: Schnittfiguren und Ansichtskanten.

Ein Grundriss nach DIN 1356-1 besteht aus zwei Sorten Geometrie. Was die
Schnittebene trifft, wird als geschlossene Fläche gezeichnet und nach Baustoff
schraffiert; was darunter liegt, erscheint nur als projizierte Umrisslinie in
dünnerem Strich. Beides entsteht hier aus derselben Elementgeometrie, getrennt
durch das Feld `kind`.

**Warum serverseitig und nicht im Viewer.** Die Tiles sind gebatchte B3DM-Meshes
in float32, deren Vertices zusätzlich um den Tile-Ursprung verschoben wurden.
Eine Schnittkontur ließe sich daraus nur näherungsweise rekonstruieren, und
Wandanschlüsse fielen millimeterweise auseinander — sichtbar als Haarrisse in
jeder Ecke des Plans. IfcOpenShell liefert dieselbe Geometrie in float64 und
mit Elementbezug, also mit Typ, Geschoss und Material für die Signatur.

**Koordinaten.** Alles rechnet im tile-lokalen System: X=Ost, Y=Nord, Z=oben,
Ursprung in der XY-Mitte und auf der Z-Unterkante des Modells. Das ist der
Frame, in dem auch die Tiles liegen, und `root.transform` bildet ihn nach ECEF
ab — der Viewer kann die Figuren also ohne weitere Umrechnung anzeigen, und die
Box aus dem Clipping-Werkzeug kommt bereits in diesem System herein.

Der dafür nötige Offset (IFC-Weltkoordinate minus tile-lokal) wird beim Tiling
nicht gespeichert: `tile_ifc()` ruft `write_placement()` ohne `base_transform`
auf. Er wird deshalb hier nach derselben Konvention wie `georef.recenter()`
nachgerechnet und mitsamt der Element-Bounding-Boxen zwischengespeichert —
sonst müsste jeder einzelne Schnitt die gesamte Modellgeometrie erneut
auswerten.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Die Ausschlussliste und die Geometrie-Settings stammen bewusst aus dem
# Tiling-Handler und werden nicht kopiert: beide hängen an Umgebungsvariablen
# (IFC_EXCLUDE_TYPES, IFC_WELD), und ein zweiter Satz Konstanten würde
# bedeuten, dass Plan und Modell irgendwann verschiedene Bauteile zeigen.
from tiling.formats.ifc import _EXCLUDE_TYPES, _JOBS, _make_settings

logger = logging.getLogger(__name__)

_CACHE_DIR = Path(os.getenv("SECTION_CACHE", "/tmp/section"))

# Ein Verzeichnisaufbau kostet bei großen Modellen Minuten und mehrere Gigabyte,
# und er wird für dasselbe Modell regelmäßig mehrfach gleichzeitig angestoßen:
# das Planpanel fragt /storeys, das Raumkonzept /rooms, beides beim Öffnen
# desselben Assets, dazu jeder ungeduldige zweite Klick. Ohne Sperre sieht jeder
# dieser Aufrufe den noch leeren Cache und parst die Datei ein weiteres Mal —
# am Campusmodell drei gleichzeitige `ifcopenshell.open()` mit zusammen rund
# 20 GB, die sich obendrein gegenseitig um die CPU bringen. Die Sperre lässt den
# ersten rechnen; die Nachzügler warten und lesen danach das fertige Verzeichnis.
_BUILD_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def build_lock(cached: Path) -> threading.Lock:
    """Die Sperre zu einer Verzeichnisdatei; je Pfad genau eine."""
    with _LOCKS_GUARD:
        return _BUILD_LOCKS.setdefault(str(cached), threading.Lock())

# Zusätzlich zu IFC_EXCLUDE_TYPES ausgeschlossen, unabhängig davon, was dort
# konfiguriert ist. IfcSpace ist der Grund: das Raumvolumen ist ein massiver
# Quader, der die Schnittebene voll trifft und jede Wand darunter zudeckt.
# Die docker-compose.yml schließt ihn bereits aus, aber die Liste ist über die
# Umgebung überschreibbar, und für ein 3D-Modell kann es gute Gründe geben,
# Räume mitzutilen — für eine Zeichnung gibt es keine. Räume gehören dort in
# die Beschriftung (Nutzung, Fläche), nicht in die Schraffur.
_NEVER_DRAWN = ["IfcSpace", "IfcOpeningElement", "IfcAnnotation", "IfcGrid"]

# Schnitthöhe über Geschossfußboden. DIN 1356-1 verlangt die Ebene dort, wo sie
# die charakteristischen Öffnungen trifft; 1,00 m ist der übliche Wert, weil er
# unter jeder Fensterbrüstung durchgeht und über jeder Türzarge bleibt.
DEFAULT_CUT_HEIGHT = 1.0

# Unterhalb dieser Fläche ist eine Schnittfigur kein Bauteil mehr, sondern ein
# Artefakt: eine Ebene, die eine Dachschräge streift, erzeugt Splitter von
# wenigen Quadratzentimetern, die im Plan als Schmutz erscheinen.
_MIN_AREA = 1e-4


@dataclass
class Box:
    """
    Der Planausschnitt als Quader im tile-lokalen System, um die Hochachse
    gedreht — dieselbe Beschreibung, die das Clipping-Werkzeug im Viewer führt.

    `yaw` in Grad, im Kompasssinn wie `georef.orientation_matrix()`: bei 90°
    zeigt die vormalige Nordkante der Box nach Osten. Damit lässt sich ein
    Schnitt entlang einer schrägen Gebäudeachse führen, ohne das Modell zu
    drehen.
    """

    center: tuple[float, float, float]
    size: tuple[float, float, float]
    yaw: float = 0.0

    def axes(self) -> tuple[np.ndarray, np.ndarray]:
        """
        Die gedrehten horizontalen Box-Achsen als Einheitsvektoren.

        `along` gehört zu `size[0]`, `across` zu `size[1]` — bei `yaw=0` also
        Ost und Nord. Diese Zuordnung muss stimmen, sonst widerspricht sich die
        Box mit sich selbst: `contains()` liest `size` bei unrotierter Box
        direkt als (X, Y, Z), und eine andere Achsenwahl hier würde beim
        kleinsten Drehwinkel sprunghaft Länge und Breite vertauschen.

        Vorzeichen wie in `georef.orientation_matrix()`: positiver Winkel dreht
        im Kompasssinn, bei 90° zeigt die vormalige Ostkante nach Süden.
        """
        a = np.radians(self.yaw)
        along = np.array([np.cos(a), -np.sin(a), 0.0])
        across = np.array([np.sin(a), np.cos(a), 0.0])
        return along, across

    def contains(self, lo: np.ndarray, hi: np.ndarray) -> bool:
        """
        Grober Überlappungstest gegen eine achsparallele Element-Bounding-Box.

        Bei gedrehter Box wird gegen deren Hüllquader geprüft, nicht gegen die
        Box selbst. Das lässt an den Ecken zu viele Elemente durch — der exakte
        Zuschnitt passiert ohnehin in 2D über `clip()`, und ein Kandidat zu
        viel kostet nur eine Schnittberechnung, ein Kandidat zu wenig dagegen
        ein fehlendes Bauteil im Plan.
        """
        center = np.asarray(self.center, dtype=float)
        half = np.asarray(self.size, dtype=float) / 2.0
        if self.yaw:
            along, across = self.axes()
            reach = np.abs(along[:2]) * half[0] + np.abs(across[:2]) * half[1]
            half = np.array([reach[0], reach[1], half[2]])
        return bool(np.all(lo <= center + half) and np.all(hi >= center - half))

    def polygon(self):
        """Die Box als 2D-Polygon in der Zeichenebene — der Zuschnitt des Plans."""
        from shapely.geometry import Polygon

        center = np.asarray(self.center, dtype=float)
        half = np.asarray(self.size, dtype=float) / 2.0
        along, across = self.axes()
        corners = [
            center[:2] + along[:2] * sx * half[0] + across[:2] * sy * half[1]
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))
        ]
        return Polygon([tuple(c) for c in corners])


@dataclass
class Figure:
    """
    Eine gezeichnete Bauteilfigur. `rings[0]` ist die Außenkontur, alle
    weiteren sind Löcher — dieselbe Ordnung wie in GeoJSON-Polygonen.
    """

    global_id: str
    ifc_type: str
    name: str | None
    storey: str | None
    material: str | None
    signature: str | None
    kind: str  # "schnitt" (von der Ebene getroffen) oder "ansicht" (darunter)
    rings: list[list[tuple[float, float]]] = field(default_factory=list)
    #: Rauminhalt des ganzen Bauteils aus seinem Netz, m³ — Öffnungen sind
    #: abgezogen, Brüstungen und Stürze gezählt. Für das Eigengewicht im
    #: Lastabtrag: der Schnitt allein sieht nur, was in seiner Höhe liegt, und
    #: eine Wand im Schnitt durch ein Fensterband wöge ohne Brüstung und Sturz.
    volumen_m3: float | None = None


@dataclass
class Room:
    """
    Ein Raum als Beschriftungsgrundlage — nicht als gezeichnete Figur.

    `rings` ist der Umriss in der Zeichenebene, gebraucht für die Lage des
    Stempels und als Auswahlfläche im Viewer; gezeichnet wird er allenfalls als
    dünne Hilfslinie. `anchor` ist ein Punkt, der garantiert im Raum liegt, auch
    bei L- und U-förmigen Grundrissen, wo der Schwerpunkt im Nachbarraum landet.
    """

    global_id: str
    name: str | None       # IfcSpace.Name — in der Praxis die Raumnummer
    long_name: str | None  # IfcSpace.LongName — die Nutzung ("Büro", "Flur")
    storey: str | None
    area: float            # m², siehe `_room_area()`
    height: float | None   # lichte Höhe in m, soweit ermittelbar
    anchor: tuple[float, float]
    rings: list[list[tuple[float, float]]] = field(default_factory=list)


@dataclass
class Drawing:
    """Das Ergebnis eines Schnitts, im metrischen Planbezugssystem."""

    mode: str
    figures: list[Figure]
    offset: tuple[float, float, float]
    plane_origin: tuple[float, float, float]
    plane_normal: tuple[float, float, float]
    bounds: tuple[float, float, float, float]
    rooms: list[Room] = field(default_factory=list)


# ── Elementverzeichnis ───────────────────────────────────────────────────────


def _index_path(job_id: str) -> Path:
    return _CACHE_DIR / f"{job_id}.npz"


def build_index(src: Path, job_id: str) -> tuple[np.ndarray, list[dict]]:
    """
    Bounding Box je Bauteil plus der Zentrierungs-Offset des Modells.

    Der erste Durchlauf muss die Geometrie aller Bauteile berechnen — anders
    kommt man an die Ausdehnung des Modells nicht heran, und ohne die ist der
    Offset unbekannt. Er wird deshalb einmal je Job gemacht und das Ergebnis
    behalten: ein Tiling ist unveränderlich, also bleibt auch sein Verzeichnis
    gültig, und jeder weitere Schnitt am selben Modell lädt nur noch ein paar
    hundert Kilobyte statt minutenlang zu rechnen.
    """
    cached = _index_path(job_id)
    treffer = _read_index(cached, job_id)
    if treffer is not None:
        return treffer

    with build_lock(cached):
        # Zweiter Blick unter der Sperre: Wer hier gewartet hat, während ein
        # anderer Aufruf gerechnet hat, findet das Verzeichnis jetzt fertig vor.
        treffer = _read_index(cached, job_id)
        if treffer is not None:
            return treffer
        return _build_index_locked(src, job_id, cached)


def _read_index(cached: Path, job_id: str):
    """Das Elementverzeichnis aus dem Cache, oder None wenn es noch fehlt."""
    if not cached.exists():
        return None
    with np.load(cached, allow_pickle=False) as data:
        offset = data["offset"]
        bounds = data["bounds"]
        meta = json.loads(data["meta"].tobytes().decode("utf-8"))
    logger.info(f"[{job_id}] Elementverzeichnis aus Cache: {len(meta)} Bauteile")
    return offset, [dict(m, lo=bounds[i, :3], hi=bounds[i, 3:]) for i, m in enumerate(meta)]


def _build_index_locked(src: Path, job_id: str, cached: Path) -> tuple[np.ndarray, list[dict]]:
    """Der eigentliche Durchlauf. Nur unter `build_lock()` aufrufen."""
    import ifcopenshell
    import ifcopenshell.geom
    import ifcopenshell.util.element

    logger.info(f"[{job_id}] Elementverzeichnis wird aufgebaut: {src.name}")
    import ifcopenshell.util.unit

    ifc_file = ifcopenshell.open(str(src))
    settings = _make_settings(ifcopenshell)
    # Schichtdicken stehen in der Längeneinheit der Datei — bei Revit in mm.
    laengenfaktor = ifcopenshell.util.unit.calculate_unit_scale(ifc_file)
    # `_JOBS` wie im Tiling-Handler: ohne die Threadzahl läuft der Iterator
    # einkernig, und der Aufbau dauert auf großen Modellen ein Vielfaches.
    iterator = ifcopenshell.geom.iterator(
        settings, ifc_file, _JOBS, exclude=_excluded(ifc_file) or None
    )

    meta: list[dict] = []
    bounds: list[np.ndarray] = []
    if iterator.initialize():
        while True:
            shape = iterator.get()
            verts = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
            if len(verts):
                # `shape.product` kennt seine Datei nicht — siehe Hinweis 12 in
                # der CLAUDE.md: get_psets()/get_material() scheitern daran stumm.
                element = ifc_file.by_id(shape.id)
                meta.append(
                    {
                        "global_id": getattr(element, "GlobalId", "") or "",
                        "ifc_type": element.is_a(),
                        "name": getattr(element, "Name", None),
                        "storey": _storey_of(ifcopenshell.util.element, element),
                        "material": _material_of(ifcopenshell.util.element, element),
                        # Alle Schichten, nicht nur die dickste: die
                        # Tragwerkserkennung braucht sie, siehe
                        # `materialschichten_of()`.
                        "materialschichten": materialschichten_of(
                            ifcopenshell.util.element, element, laengenfaktor),
                        "id": int(shape.id),
                    }
                )
                bounds.append(np.concatenate([verts.min(axis=0), verts.max(axis=0)]))
            if not iterator.next():
                break

    if not meta:
        raise ValueError("Keine Geometrie in der IFC-Datei gefunden.")

    box = np.asarray(bounds)
    lo, hi = box[:, :3].min(axis=0), box[:, 3:].max(axis=0)
    # Gleiche Konvention wie georef.recenter(): XY auf die Mitte, Z auf die
    # Unterkante. Weicht sie ab, liegt der Plan gegenüber dem Modell versetzt.
    offset = np.array([(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, lo[2]])
    box[:, :3] -= offset
    box[:, 3:] -= offset

    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    partial = cached.with_suffix(".part.npz")
    np.savez_compressed(
        partial,
        offset=offset,
        bounds=box,
        meta=np.frombuffer(json.dumps(meta).encode("utf-8"), dtype=np.uint8),
    )
    partial.replace(cached)
    logger.info(f"[{job_id}] Elementverzeichnis: {len(meta)} Bauteile, Offset {offset.round(3).tolist()}")

    return offset, [dict(m, lo=box[i, :3], hi=box[i, 3:]) for i, m in enumerate(meta)]


def _volumen_pfad(job_id: str) -> Path:
    # 2 — `bauteilform()`: neben dem Volumen das Grundrissrechteck je Bauteil.
    # 3 — dazu die 3D-Achse schlanker Bauteile (Sparren, Pfetten, Stiele).
    return _CACHE_DIR / f"{job_id}.form3.json"


def _stabachse(punkte: np.ndarray) -> dict | None:
    """
    Die Achse eines schlanken Körpers in 3D — Endpunkte und Querschnitt.

    Für geneigte Bauteile, deren Hüllbox und Grundrissrechteck nicht sagen,
    welches Ende oben liegt: ein Sparren unter 40° hat im Grundriss nur eine
    Länge, und die Hüllbox ist an beiden Enden gleich hoch (`ileen/dach.py`).
    Hauptachse aus den Eckpunkten, die Achse läuft durch die Mitte des
    umschließenden Quaders in diesem Achsensystem — so trifft sie auch bei
    Lotschnitt und Klaue die Mitte des Querschnitts.
    """
    if len(punkte) < 6:
        return None
    mitte = punkte.mean(axis=0)
    _, _, vt = np.linalg.svd(punkte - mitte, full_matrices=False)
    lokal = (punkte - mitte) @ vt.T
    lo, hi = lokal.min(axis=0), lokal.max(axis=0)
    ausdehnung = hi - lo
    laenge = float(ausdehnung[0])
    quer = sorted(float(v) for v in ausdehnung[1:])
    if laenge < 0.5 or laenge < 4.0 * quer[1]:
        return None
    zentrum = (lo + hi) / 2.0
    a = mitte + vt.T @ np.array([lo[0], zentrum[1], zentrum[2]])
    b = mitte + vt.T @ np.array([hi[0], zentrum[1], zentrum[2]])
    return {"achse": [[round(float(v), 4) for v in a], [round(float(v), 4) for v in b]],
            "querschnitt_m": [round(quer[0], 4), round(quer[1], 4)]}


def _grundrissrechteck(punkte: np.ndarray) -> dict | None:
    """Das kleinste umschließende Rechteck im Grundriss: Richtung der langen
    Seite (0…180°), Länge, Breite, Mitte."""
    from shapely.geometry import MultiPoint

    if len(punkte) < 3:
        return None
    huelle = MultiPoint([tuple(p) for p in punkte]).convex_hull
    if huelle.geom_type != "Polygon" or huelle.area < 1e-8:
        return None
    rechteck = huelle.minimum_rotated_rectangle
    ecken = np.asarray(rechteck.exterior.coords)[:4]
    a, b = ecken[1] - ecken[0], ecken[2] - ecken[1]
    lang, kurz = (a, b) if np.hypot(*a) >= np.hypot(*b) else (b, a)
    winkel = float(np.degrees(np.arctan2(lang[1], lang[0]))) % 180.0
    mitte = rechteck.centroid
    return {"winkel_grad": round(winkel, 3), "laenge_m": round(float(np.hypot(*lang)), 4),
            "breite_m": round(float(np.hypot(*kurz)), 4),
            "mitte": [round(float(mitte.x), 4), round(float(mitte.y), 4)]}


def bauteilform(src: Path, job_id: str) -> dict[str, dict]:
    """
    Rauminhalt und Grundrissrechteck jedes Bauteils aus seinem Netz.

    GlobalId → `{volumen_m3, grundriss: {winkel_grad, laenge_m, breite_m,
    mitte}}`, in den Koordinaten des Elementverzeichnisses (zentriert wie
    `build_index()`).

    **Das Volumen** ist für das Eigengewicht im Lastabtrag: eine Wand mit
    Fenstern, ein Balken, eine Dielung, ein Dachaufbau wiegen ihr Volumen,
    nicht ihre Hüllbox. Ein Netz, dessen Volumen größer ist als seine Hüllbox,
    ist offen (der Satz von Gauß liefert dann beliebige Zahlen) — das Volumen
    fehlt dann.

    **Das Grundrissrechteck**, weil die Hüllbox achsparallel ist und ein
    gedrehtes Gebäude darin nicht schlank aussieht: ein Balken 10/22 unter 33°
    hat eine Hüllbox von 3,8 × 2,5 m. Erkennung von Balkenlagen und die Hülle
    eines Geschosses brauchen Richtung, Länge und Breite (`kette.balkenlagen()`).

    Ein eigener Durchlauf neben dem Elementverzeichnis, damit Pläne und Schnitte
    davon nichts merken; einmal je Modell, danach aus dem Zwischenspeicher.
    """
    cached = _volumen_pfad(job_id)
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    with build_lock(cached):
        if cached.exists():
            return json.loads(cached.read_text(encoding="utf-8"))
        import ifcopenshell
        import ifcopenshell.geom
        from scipy.spatial import ConvexHull

        offset, _ = build_index(src, job_id)
        ifc_file = ifcopenshell.open(str(src))
        settings = _make_settings(ifcopenshell)
        iterator = ifcopenshell.geom.iterator(
            settings, ifc_file, _JOBS, exclude=_excluded(ifc_file) or None)
        volumen: dict[str, float] = {}
        punkte: dict[str, list] = {}
        achsen: dict[str, dict] = {}
        if iterator.initialize():
            while True:
                shape = iterator.get()
                verts = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
                faces = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
                if len(verts) and len(faces):
                    element = ifc_file.by_id(shape.id)
                    gid = getattr(element, "GlobalId", "") or ""
                    v = _mesh_volumen(verts, faces)
                    quader = float(np.prod(verts.max(axis=0) - verts.min(axis=0)))
                    if gid and 0.0 < v <= 1.02 * quader + 1e-9:
                        volumen[gid] = volumen.get(gid, 0.0) + round(v, 6)
                    if gid:
                        xy = verts[:, :2] - np.asarray(offset[:2], dtype=float)
                        try:
                            xy = xy[ConvexHull(xy).vertices]
                        except Exception:  # noqa: BLE001 — flach oder entartet
                            pass
                        punkte.setdefault(gid, []).append(xy)
                        if gid not in achsen:
                            achse = _stabachse(verts - np.asarray(offset, dtype=float))
                            if achse:
                                achsen[gid] = achse
                if not iterator.next():
                    break
        ergebnis: dict[str, dict] = {}
        for gid in set(volumen) | set(punkte):
            eintrag: dict = {"volumen_m3": volumen.get(gid)}
            if gid in punkte:
                eintrag["grundriss"] = _grundrissrechteck(np.concatenate(punkte[gid]))
            if gid in achsen:
                eintrag.update(achsen[gid])
            ergebnis[gid] = eintrag
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        teil = cached.with_suffix(".part.json")
        teil.write_text(json.dumps(ergebnis), encoding="utf-8")
        teil.replace(cached)
        logger.info(f"[{job_id}] Bauteilform: {len(ergebnis)} Bauteile")
        return ergebnis


def _eltern_pfad(job_id: str) -> Path:
    return _CACHE_DIR / f"{job_id}.eltern1.json"


def bauteil_eltern(src: Path, job_id: str) -> dict[str, dict]:
    """
    Teil → Bauteil: `IfcBuildingElementPart` und ihr Elternbauteil.

    ArchiCAD schreibt mehrschichtige Wände, Decken und zusammengesetzte
    Stützen als Bauteil **ohne eigenen Körper**, dessen Geometrie in Teilen
    steckt (`IfcRelAggregates`). Im Elementverzeichnis und im Schnitt stehen
    dann nur die Teile, und für den Lastabtrag sind sie „sonstiges": an Lucy
    (Holzhaus auf Schraubfundamenten) fanden die Decken kein einziges Lager,
    weil jedes Schraubfundament eine `IfcColumn` aus vier Teilen ist.

    Ohne Geometrie, eigener Zwischenspeicher. Verschachtelte Teile gehören dem
    obersten Bauteil, das kein Teil ist.

    @returns Teil-GlobalId → {global_id, ifc_type, name} des Elternbauteils
    """
    cached = _eltern_pfad(job_id)
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))
    with build_lock(cached):
        if cached.exists():
            return json.loads(cached.read_text(encoding="utf-8"))
        import ifcopenshell

        ifc_file = ifcopenshell.open(str(src))
        ergebnis: dict[str, dict] = {}
        for teil in ifc_file.by_type("IfcBuildingElementPart"):
            eltern, schritte = teil, 0
            while eltern.is_a("IfcBuildingElementPart") and schritte < 10:
                oben = [r.RelatingObject for r in (getattr(eltern, "Decomposes", None) or [])
                        if r.is_a("IfcRelAggregates")]
                if not oben:
                    break
                eltern, schritte = oben[0], schritte + 1
            if eltern is teil or not eltern.is_a("IfcElement"):
                continue
            ergebnis[teil.GlobalId] = {"global_id": eltern.GlobalId, "ifc_type": eltern.is_a(),
                                       "name": getattr(eltern, "Name", None)}
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        zwischen = cached.with_suffix(".part.json")
        zwischen.write_text(json.dumps(ergebnis), encoding="utf-8")
        zwischen.replace(cached)
        logger.info(f"[{job_id}] Bauteilteile: {len(ergebnis)} Teile zu "
                    f"{len({e['global_id'] for e in ergebnis.values()})} Bauteilen")
        return ergebnis


def bauteilvolumen(src: Path, job_id: str) -> dict[str, float]:
    """Der Rauminhalt jedes Bauteils, m³ — GlobalId → Volumen (`bauteilform()`)."""
    return {gid: e["volumen_m3"] for gid, e in bauteilform(src, job_id).items()
            if e.get("volumen_m3")}


def purge_cache(job_id: str):
    """Entfernt das Elementverzeichnis — beim Löschen eines Assets."""
    _index_path(job_id).unlink(missing_ok=True)
    _room_index_path(job_id).unlink(missing_ok=True)
    _storeys_path(job_id).unlink(missing_ok=True)
    _volumen_pfad(job_id).unlink(missing_ok=True)
    for alt in ("volumen1.json", "form2.json"):
        (_CACHE_DIR / f"{job_id}.{alt}").unlink(missing_ok=True)
    _eltern_pfad(job_id).unlink(missing_ok=True)
    # Die Vorgänger des Raumverzeichnisses. Sie werden nicht mehr gelesen,
    # lägen aber sonst bis in alle Ewigkeit im Cache-Verzeichnis.
    for alt in ("rooms", "rooms2"):
        (_CACHE_DIR / f"{job_id}.{alt}.npz").unlink(missing_ok=True)


# ── Raumverzeichnis ──────────────────────────────────────────────────────────


def _room_index_path(job_id: str) -> Path:
    # Die Zahl im Namen ist eine Formatversion, keine Zierde. Ein neuer Name
    # baut das Verzeichnis einmal neu auf, statt einen veralteten Datensatz aus
    # dem Cache zu lesen.
    #
    #   2 — Raumvolumen für die GEG-Bilanz: neue Felder je Eintrag.
    #   3 — `_storey_of` folgt jetzt auch `Decomposes`. Die Felder sind
    #       dieselben, aber `storey` stand bei jedem Raum auf None; ein Cache
    #       aus der Zeit davor sähe unversehrt aus und bliebe stumm falsch.
    #   4 — `grundriss`: die Schnittfigur je Raum, Grundlage der raumweisen
    #       Nutzlasten. Ein Cache aus der Zeit davor hat das Feld nicht, und
    #       ein Lastabtrag daraus verteilte die Nutzlast wieder pauschal übers
    #       Geschoss — sichtbar an nichts.
    return _CACHE_DIR / f"{job_id}.rooms4.npz"


def _mesh_volumen(verts: np.ndarray, faces: np.ndarray) -> float:
    """
    Rauminhalt eines geschlossenen Dreiecksnetzes über den Satz von Gauß.

    V = |Σ (a · (b × c)) / 6| über alle Dreiecke. Das ist der einzige Weg zum
    *tatsächlichen* Raumvolumen: die Bounding Box überschätzt einen L-förmigen
    Raum um die ganze Kerbe, und `Fläche × Höhe` versagt bei Dachschrägen —
    also genau dort, wo das beheizte Volumen ohnehin schwer zu greifen ist.

    Ist das Netz nicht geschlossen (offene Raumbegrenzung), liefert die Formel
    Unsinn statt eines Fehlers. Der Aufrufer prüft deshalb gegen die Bounding
    Box; siehe `_raum_volumen()`.
    """
    if faces.size == 0 or verts.size == 0:
        return 0.0
    dreiecke = verts[faces.reshape(-1, 3)]
    a, b, c = dreiecke[:, 0], dreiecke[:, 1], dreiecke[:, 2]
    return float(abs(np.einsum("ij,ij->i", a, np.cross(b, c)).sum()) / 6.0)


def _room_index(src: Path, job_id: str, offset: np.ndarray) -> list[dict]:
    """
    Bounding Box und Stammdaten je `IfcSpace` — ein eigenes Verzeichnis.

    Räume stehen nicht im Elementverzeichnis: `_excluded()` hält sie aus dem
    Iterator heraus, weil ihr Volumen sonst als massiver Quader jede Wand
    darunter zudecken würde. Für die Beschriftung braucht man sie trotzdem, und
    zwar mit Geometrie — die Lage eines Raumstempels steht nirgends im IFC.

    Die Flächenangabe kommt aus `Qto_SpaceBaseQuantities`, wenn die Datei sie
    führt. Das ist der Wert, den der Entwurfsverfasser als Nutzfläche meint;
    das Schnittpolygon in 1,20 m Höhe ist dagegen der Umriss *auf dieser Höhe*
    und weicht bei Nischen, Schrägen und Vorwandinstallationen davon ab. Wo das
    Qto fehlt, tritt die geometrische Fläche an seine Stelle — siehe
    `_room_area()`.

    Zusätzlich wird das **Rauminhaltsvolumen aus dem Netz** mitgeschrieben. Es
    ist die Grundlage des beheizten Volumens in der GEG-Bilanz und die einzige
    Angabe, die auch dann stimmt, wenn die Datei keine Mengensätze führt —
    siehe `raumkennwerte()`.
    """
    cached = _room_index_path(job_id)
    treffer = _read_room_index(cached)
    if treffer is not None:
        return treffer

    with build_lock(cached):
        treffer = _read_room_index(cached)
        if treffer is not None:
            return treffer
        return _room_index_locked(src, job_id, offset, cached)


def _read_room_index(cached: Path):
    """Das Raumverzeichnis aus dem Cache, oder None wenn es noch fehlt."""
    if not cached.exists():
        return None
    with np.load(cached, allow_pickle=False) as data:
        bounds = data["bounds"]
        meta = json.loads(data["meta"].tobytes().decode("utf-8"))
    return [dict(m, lo=bounds[i, :3], hi=bounds[i, 3:]) for i, m in enumerate(meta)]


def _raum_grundriss(verts: np.ndarray, faces: np.ndarray,
                    offset: np.ndarray) -> list[list[list[float]]]:
    """
    Die Grundrissfigur eines Raums: ein waagerechter Schnitt durch sein Volumen.

    **Warum nicht die Bounding Box.** Sie ist die Angabe, die dieses
    Verzeichnis bis September 2026 als einzige führte, und für einen
    rechteckigen Raum genügt sie. Für alles andere nicht: bei einem L-förmigen
    Wohnzimmer liegt die Kerbe innerhalb der Box, bei einem Flur um die Ecke
    fast der halbe Grundriss. Sobald daraus **Lastflächen** werden — jede
    Raumnutzung bringt ihre eigene Nutzlast nach DIN EN 1991-1-1/NA —,
    überlappen sich die Boxen benachbarter Räume, die Nutzlast wird doppelt
    aufgebracht, und die Summenkontrolle des Lastabtrags zeigt einen Fehlbetrag,
    den niemand erklären kann. Eine Fläche, die als Last dient, muss die
    tatsächliche sein.

    **Warum auf einem Meter über dem Boden.** Ein Raumvolumen ist unten und
    oben von waagerechten Flächen begrenzt; eine Schnittebene, die eine davon
    streift, trifft das Netz tangential und liefert Splitter oder nichts. Ein
    Meter darüber ist sicher im Volumen und zugleich unter jeder Brüstung — es
    ist dieselbe Höhe, in der auch der Grundriss geschnitten wird
    (`DEFAULT_CUT_HEIGHT`). Bei einem niedrigeren Raum wird auf die halbe Höhe
    ausgewichen.

    **Warum dieselbe Maschinerie wie beim Bauteilschnitt.** `_section_rings()`
    bildet die Ringe, `_nest()` ordnet Löcher zu — ein Raum mit einer Stütze
    darin hat eines. Eine eigene Umrissbildung wäre eine zweite Stelle, an der
    dieselbe Geometriefrage beantwortet wird, und die beiden liefen mit der
    Zeit auseinander.

    Das Ergebnis liegt **tile-lokal** wie die Bounding Boxen daneben: dasselbe
    System, in dem `cut()` seine Bauteilfiguren ausgibt, und damit ohne
    Umrechnung über die Wandpolygone legbar.

    @returns Ringe als `[[x, y], …]`; erst die Außenkontur, dann ihre Löcher —
             dieselbe Even-Odd-Konvention wie bei den Bauteilfiguren.
    """
    import trimesh

    if faces.size == 0 or verts.size == 0:
        return []
    lo, hi = verts.min(axis=0), verts.max(axis=0)
    hoehe = float(hi[2] - lo[2])
    if hoehe < 0.05:
        return []
    z = float(lo[2]) + (DEFAULT_CUT_HEIGHT if hoehe > 2 * DEFAULT_CUT_HEIGHT
                        else hoehe / 2.0)

    try:
        mesh = trimesh.Trimesh(vertices=verts, faces=faces.reshape(-1, 3),
                               process=False)
    except Exception:
        return []

    # Dieselbe Abbildung wie `_plane(..., "grundriss")`: die Identität in x
    # und y. Nur so liegen Raumfigur und Wandfigur im selben Koordinatensystem,
    # und der Lastabtrag kann die eine über die andere legen.
    to_2d = np.eye(4)
    to_2d[2, 3] = -z
    ringe = _section_rings(mesh, np.array([0.0, 0.0, z]),
                           np.array([0.0, 0.0, 1.0]), to_2d, None)
    # Tile-lokal, wie die Bounding Boxen: `_room_index_locked()` zieht den
    # Offset dort von `bounds` ab, und beide müssen im selben System liegen.
    return [[[round(x - float(offset[0]), 4), round(y - float(offset[1]), 4)]
             for x, y in ring] for ring in ringe]


def _room_index_locked(src: Path, job_id: str, offset: np.ndarray, cached: Path) -> list[dict]:
    """Der eigentliche Durchlauf. Nur unter `build_lock()` aufrufen."""
    import ifcopenshell
    import ifcopenshell.geom
    import ifcopenshell.util.element
    import ifcopenshell.util.unit

    ifc_file = ifcopenshell.open(str(src))
    try:
        spaces = ifc_file.by_type("IfcSpace")
    except Exception:
        spaces = []

    meta: list[dict] = []
    bounds: list[np.ndarray] = []

    if spaces:
        settings = _make_settings(ifcopenshell)
        # Mengenangaben stehen in den Einheiten der Datei, die Geometrie aus dem
        # Iterator dagegen immer in Metern. Ohne diesen Faktor liefert ein in
        # Millimetern gezeichnetes Modell Räume von einer Million Quadratmetern.
        faktor = ifcopenshell.util.unit.calculate_unit_scale(ifc_file)
        iterator = ifcopenshell.geom.iterator(settings, ifc_file, _JOBS, include=spaces)
        if iterator.initialize():
            while True:
                shape = iterator.get()
                verts = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3)
                if len(verts):
                    element = ifc_file.by_id(shape.id)
                    faces = np.asarray(shape.geometry.faces, dtype=np.int64)
                    lo, hi = verts.min(axis=0), verts.max(axis=0)
                    quantities = _masse_pruefen(
                        _space_quantities(ifcopenshell.util.element, element),
                        faktor, lo, hi)
                    meta.append(
                        {
                            "global_id": getattr(element, "GlobalId", "") or "",
                            "name": getattr(element, "Name", None),
                            "long_name": getattr(element, "LongName", None),
                            "storey": _storey_of(ifcopenshell.util.element, element),
                            "id": int(shape.id),
                            "mesh_volume": round(_mesh_volumen(verts, faces), 4),
                            "grundriss": _raum_grundriss(verts, faces, offset),
                            **quantities,
                        }
                    )
                    bounds.append(np.concatenate([lo, hi]))
                if not iterator.next():
                    break

    box = np.asarray(bounds, dtype=np.float64).reshape(-1, 6)
    if len(box):
        box[:, :3] -= offset
        box[:, 3:] -= offset

    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    partial = cached.with_suffix(".part.npz")
    np.savez_compressed(
        partial,
        bounds=box,
        meta=np.frombuffer(json.dumps(meta).encode("utf-8"), dtype=np.uint8),
    )
    partial.replace(cached)
    logger.info(f"[{job_id}] Raumverzeichnis: {len(meta)} Räume")

    return [dict(m, lo=box[i, :3], hi=box[i, 3:]) for i, m in enumerate(meta)]


def _space_quantities(util, element) -> dict:
    """
    Nutzfläche, lichte Höhe und Rauminhalt aus den Mengenangaben — **roh**.

    Gesucht wird zuerst in den Mengensets (`Qto_SpaceBaseQuantities`); ArchiCAD
    und Revit schreiben ihre Flächen aber auch in eigene Sets ("BaseQuantities",
    "Abmessungen"), deshalb wird über alle Sets nach den bekannten
    Schlüsselnamen gesucht, statt sich auf den Normnamen zu verlassen.

    Die Werte kommen unskaliert heraus. Sie mit dem Längenmaßstab der Datei zu
    multiplizieren — Flächen im Quadrat, Volumen in der dritten Potenz — wäre
    die naheliegende Stelle, ist aber genau die Stelle, an der es schiefgeht:
    siehe `_masse_pruefen()`.
    """
    flaeche_keys = ("NetFloorArea", "GrossFloorArea", "Fläche", "Area")
    hoehe_keys = ("Height", "FinishCeilingHeight", "Höhe", "ClearHeight")
    # `GrossVolume` zuerst: das GEG rechnet mit Außenmaßen, und von den beiden
    # Mengensätzen ist er derjenige, der der Bruttobetrachtung näher liegt.
    volumen_keys = ("GrossVolume", "NetVolume", "Volumen", "Volume")

    try:
        sets = util.get_psets(element, qtos_only=True) or {}
    except Exception:
        sets = {}
    if not sets:
        try:
            sets = util.get_psets(element) or {}
        except Exception:
            return {}

    gefunden: dict = {}
    for feld, schluessel in (("roh_area", flaeche_keys), ("roh_height", hoehe_keys),
                             ("roh_volume", volumen_keys)):
        for werte in sets.values():
            if not isinstance(werte, dict):
                continue
            for key in schluessel:
                wert = werte.get(key)
                if feld not in gefunden and isinstance(wert, (int, float)):
                    gefunden[feld] = float(wert)
    return gefunden


def _masse_pruefen(roh: dict, faktor: float, lo: np.ndarray, hi: np.ndarray) -> dict:
    """
    Bringt die Mengenangaben auf Meter — und prüft dabei, ob sie es schon sind.

    **Die Einheiten eines Mengensatzes sind nicht verlässlich gemischt.** Im
    `Ifc4_SampleHouse.ifc` (Revit-Export, Längeneinheit mm) steht im Raum
    „1 - Living room“: `NetFloorArea = 51,99`, `Height = 2500,0`,
    `GrossVolume = 129,99`. Fläche und Volumen sind also bereits in m² und m³,
    die Höhe dagegen in Millimetern. Wer alles mit dem Längenmaßstab
    multipliziert — Flächen im Quadrat —, bekommt aus 51,99 m² genau
    0,000052 m². Das ist kein Rundungsfehler, das ist die Fläche, mit der
    danach gerechnet wird, und in einer Bilanz fällt eine Null nicht auf.

    Deshalb entscheidet nicht die Einheitenangabe der Datei, sondern die
    **Geometrie des Raums**: skaliert und unskaliert werden beide gegen den
    Hüllquader gehalten, und es gilt der Wert, der hineinpasst. Passt keiner,
    steht die Angabe nicht drin — dann tritt die gemessene Geometrie an ihre
    Stelle, und das ist allemal besser als eine Zahl um drei Zehnerpotenzen
    daneben.
    """
    dx, dy, dz = (hi - lo).tolist()
    quader = max(dx * dy * dz, 1e-9)

    def waehlen(feld: str, potenz: int, untere: float, obere: float) -> float | None:
        wert = roh.get(feld)
        if wert is None or wert <= 0:
            return None
        for kandidat in (wert * faktor ** potenz, wert):
            if untere <= kandidat <= obere:
                return kandidat
        return None

    ergebnis: dict = {}
    # Ein Raum ist höchstens so hoch wie sein Hüllquader und selten unter 1,5 m.
    hoehe = waehlen("roh_height", 1, min(1.5, dz), dz * 1.05)
    if hoehe is not None:
        ergebnis["qto_height"] = hoehe
    # Die Grundfläche liegt zwischen einem Zwanzigstel des umschriebenen
    # Rechtecks (schmaler L-Schenkel) und ihm selbst.
    flaeche = waehlen("roh_area", 2, dx * dy * 0.05, dx * dy * 1.05)
    if flaeche is not None:
        ergebnis["qto_area"] = flaeche
    volumen = waehlen("roh_volume", 3, quader * 0.02, quader * 1.05)
    if volumen is not None:
        ergebnis["qto_volume"] = volumen
    return ergebnis


def storeys(src: Path, job_id: str) -> list[dict]:
    """
    Die Geschosse des Modells mit ihrer Höhe im tile-lokalen System.

    Ohne diese Liste ist ein Grundriss Glückssache. Die Schnitthöhe ist nur
    relativ zum Geschossfußboden definiert, und wo der liegt, weiß nur das
    Modell: Gebäude beginnen selten bei z=0 — Fundamente, Sockelgeschosse und
    Bezug auf NHN verschieben den Nullpunkt. Wer die Ebene stattdessen rät,
    trifft die Fensterbrüstung oder gar nichts.

    `IfcBuildingStorey.Elevation` steht in den Längeneinheiten der Datei und
    wird deshalb über den Einheitenfaktor auf Meter gebracht. Geschosse ohne
    Höhenangabe fallen heraus — sie wären im Plan nicht adressierbar.

    Die fertige Liste wird zwischengespeichert, obwohl sie nur aus einer
    Handvoll Attribute besteht. Der Grund ist `ifcopenshell.open()`: für die
    Elevation und den Einheitenfaktor muss die Datei geöffnet werden, und das
    kostet bei einem halben Gigabyte IFC eine knappe halbe Minute — bei jedem
    Geschosswechsel im Plan aufs Neue, auch wenn das Elementverzeichnis längst
    im Cache liegt. Ein Tiling ist unveränderlich, seine Geschosse also auch.
    """
    cached = _storeys_path(job_id)
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))

    with build_lock(cached):
        # Zweiter Blick unter der Sperre, wie beim Elementverzeichnis.
        if cached.exists():
            return json.loads(cached.read_text(encoding="utf-8"))
        return _storeys_locked(src, job_id, cached)


def _storeys_path(job_id: str) -> Path:
    # Formatversion im Namen wie beim Raumverzeichnis: ändert sich der Inhalt
    # der Einträge, baut ein neuer Name die Liste einmal neu auf, statt einen
    # veralteten Datensatz aus dem Cache zu lesen.
    return _CACHE_DIR / f"{job_id}.storeys1.json"


def _storeys_locked(src: Path, job_id: str, cached: Path) -> list[dict]:
    """Der eigentliche Durchlauf. Nur unter `build_lock()` aufrufen."""
    import ifcopenshell
    import ifcopenshell.util.unit

    offset, index = build_index(src, job_id)

    ifc_file = ifcopenshell.open(str(src))
    faktor = ifcopenshell.util.unit.calculate_unit_scale(ifc_file)

    belegt: dict[str, int] = {}
    for entry in index:
        if entry["storey"]:
            belegt[entry["storey"]] = belegt.get(entry["storey"], 0) + 1

    found = []
    for storey in ifc_file.by_type("IfcBuildingStorey"):
        if storey.Elevation is None:
            continue
        found.append(
            {
                "name": storey.Name or f"Geschoss {storey.id()}",
                # Elevation ist eine Modellkoordinate und braucht denselben
                # Offset wie die Geometrie, sonst zeigt die Auswahl im Viewer
                # auf eine Höhe, an der nichts steht.
                "hoehe": round(float(storey.Elevation) * faktor - float(offset[2]), 3),
                "bauteile": belegt.get(storey.Name, 0),
            }
        )

    found.sort(key=lambda s: s["hoehe"])

    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    partial = cached.with_suffix(".part.json")
    partial.write_text(json.dumps(found), encoding="utf-8")
    partial.replace(cached)
    logger.info(f"[{job_id}] Geschossliste: {len(found)} Geschosse")

    return found


# ── Raum- und Geschosskennwerte für die Energiebilanz ────────────────────────
#
# Beides beantwortet dieselbe Frage aus zwei Richtungen: *wie groß ist das
# beheizte Volumen*. Der Weg über die Räume ist der genauere, wo es Räume gibt;
# der über die Geschossflächen ist der einzige, wo es keine gibt — und zugleich
# der, der ein **Brutto**volumen liefert, das die GEG-Bilanz eigentlich meint.
# Zusammengeführt werden beide in `ileen.energie.volumen_aus_geometrie()`; hier
# steht nur, was sich aus dem IFC ablesen lässt.

# Ein Bauteil gilt als waagerecht liegende Platte, wenn seine Bounding Box
# flacher ist als ein Fünftel ihrer kürzeren Grundkante. Eine 25-cm-Decke über
# 5 m Spannweite trifft das mit großem Abstand, eine hochkant stehende
# Fassadenplatte nicht.
_PLATTE_FLACHHEIT = 0.2


def raumkennwerte(src: Path, job_id: str, mit_box: bool = False,
                  mit_grundriss: bool = False) -> list[dict]:
    """
    Alle Räume des Modells mit Fläche, Höhe und Volumen — ohne Schnittebene.

    `cut(with_rooms=True)` liefert Räume nur für einen Ausschnitt und nur im
    Grundriss, weil es sie dort als Beschriftung braucht. Die Energiebilanz
    braucht sie vollständig und ohne Zeichenbezug; sie liest deshalb dasselbe
    Raumverzeichnis, aber ohne Schnitt.

    Das Volumen kommt in dieser Reihenfolge zustande — jede Stufe steht in
    `volumen_quelle`, weil sie unterschiedlich viel wert sind:

    1. `netz` — der Rauminhalt des Raumkörpers selbst. Genau, auch bei
       Dachschrägen und L-Grundrissen, und braucht keine Mengensätze.
    2. `qto` — `GrossVolume`/`NetVolume` aus dem Mengensatz. Tritt ein, wenn
       das Netz nicht geschlossen ist und deshalb kein brauchbares Volumen
       hergibt.
    3. `flaeche_hoehe` — Fläche mal lichte Höhe aus den Mengensätzen.
    4. `huellquader` — die Bounding Box. Bei allem außer einem rechteckigen
       Raum zu groß, deshalb die letzte Wahl und als solche gekennzeichnet.

    `mit_grundriss=True` stellt die **Schnittfigur** je Raum dazu — die
    tatsächliche Grundrissfläche als Ringliste, nicht der Hüllquader. Sie ist
    die Grundlage der raumweisen Nutzlasten im Lastabtrag: eine Fläche, die als
    Last dient, muss die tatsächliche sein, sonst überlappen sich die Lasten
    benachbarter Räume. Siehe `_raum_grundriss()`.

    `mit_box=True` stellt zusätzlich `lo` und `hi` dazu — den Hüllquader im
    tile-lokalen System, derselben Zentrierung wie `element_box`. Der Viewer
    braucht ihn, um die Räume an ihrer Stelle zu zeichnen; er kann sie nicht
    aus den Tiles nehmen, weil `_EXCLUDE_TYPES` `IfcSpace` gar nicht erst
    hineinlässt. Voreinstellung ist aus: Die Energiebilanz reicht ihre
    Raumliste unverändert in die Antwort durch, und sechs zusätzliche Zahlen je
    Raum wären dort nur Ballast.
    """
    offset, _ = build_index(src, job_id)
    raeume = _room_index(src, job_id, offset)

    ergebnis: list[dict] = []
    for raum in raeume:
        lo, hi = np.asarray(raum["lo"], dtype=float), np.asarray(raum["hi"], dtype=float)
        ausdehnung = hi - lo
        quader = float(ausdehnung[0] * ausdehnung[1] * ausdehnung[2])
        volumen, quelle = _raum_volumen(raum, quader)

        flaeche = raum.get("qto_area")
        flaeche_quelle = "qto"
        if not flaeche or flaeche <= 0:
            # Die Grundfläche aus Volumen und Höhe statt aus der Bounding Box:
            # bei einem L-förmigen Raum ist der Hüllquader in der Kerbe zu
            # groß, das Volumen aber nicht — die Division erbt also die
            # Genauigkeit des Netzes.
            hoehe = float(ausdehnung[2])
            flaeche = volumen / hoehe if hoehe > 0.1 else float(ausdehnung[0] * ausdehnung[1])
            flaeche_quelle = "netz"

        ergebnis.append(
            {
                "global_id": raum.get("global_id") or "",
                "name": raum.get("name"),
                "long_name": raum.get("long_name"),
                "storey": raum.get("storey"),
                "flaeche_m2": round(float(flaeche), 2),
                "flaeche_quelle": flaeche_quelle,
                "hoehe_m": round(float(raum.get("qto_height") or ausdehnung[2]), 2),
                "volumen_m3": round(volumen, 2),
                "volumen_quelle": quelle,
                "z_unten": round(float(lo[2]), 2),
                "z_oben": round(float(hi[2]), 2),
                **(
                    {
                        "lo": [round(float(v), 3) for v in lo],
                        "hi": [round(float(v), 3) for v in hi],
                    }
                    if mit_box
                    else {}
                ),
                # Die Schnittfigur je Raum. Voreinstellung aus, weil sie
                # hundert Punkte je Raum hat und die Energiebilanz ihre
                # Raumliste unverändert in die Antwort durchreicht — dort wäre
                # das Ballast. Der Lastabtrag braucht sie.
                **({"grundriss": raum.get("grundriss") or []}
                   if mit_grundriss else {}),
            }
        )

    ergebnis.sort(key=lambda r: (r["storey"] or "", -r["volumen_m3"]))
    logger.info(f"[{job_id}] Raumkennwerte: {len(ergebnis)} Räume")
    return ergebnis


def _raum_volumen(raum: dict, quader_m3: float) -> tuple[float, str]:
    """
    Das belastbarste verfügbare Raumvolumen und woher es stammt.

    Der Hüllquader ist dabei nicht nur letzte Wahl, sondern auch **Prüfmaß**:
    ein Netzvolumen größer als sein eigener Hüllquader kann nicht stimmen — die
    Gaußformel gibt bei einer offenen Raumbegrenzung eine beliebige Zahl zurück
    statt eines Fehlers, und die fiele in einer Volumensumme nicht auf.
    """
    netz = float(raum.get("mesh_volume") or 0.0)
    if 0.0 < netz <= quader_m3 * 1.02:
        return netz, "netz"

    qto = raum.get("qto_volume")
    if qto and qto > 0:
        return float(qto), "qto"

    flaeche, hoehe = raum.get("qto_area"), raum.get("qto_height")
    if flaeche and hoehe and flaeche > 0 and hoehe > 0:
        return float(flaeche) * float(hoehe), "flaeche_hoehe"

    return quader_m3, "huellquader"


def geschosskennwerte(src: Path, job_id: str,
                      flaechen: dict[str, float] | None = None) -> list[dict]:
    """
    Je Geschoss die Bruttogrundfläche und die Geschosshöhe.

    Das ist der Weg zum beheizten Volumen für Modelle **ohne** Räume — und der
    einzige, der ein Bruttovolumen liefert: V_e nach GEG ist das von der
    Hüllfläche umschlossene Volumen, also einschließlich Wandquerschnitten. Die
    Summe der Raumvolumina ist demgegenüber ein Nettomaß und liegt regelmäßig
    ein Fünftel darunter.

    `flaechen` bildet, wenn angegeben, `global_id` auf die Fläche einer Platte
    in m² ab — aus den Mengensätzen der Bauteilablage. Wozu, steht in `_bgf()`.

    **Die Geschosshöhe ist der Abstand zum nächsten Geschoss.** Über dem
    obersten steht keins mehr; dort tritt der Abstand zur Oberkante der
    diesem Geschoss zugeordneten Bauteile ein.

    **Ein Geschoss ist, was `IfcBuildingStorey` heißt — sonst nichts.** Das
    Feld `storey` im Elementverzeichnis kommt aus
    `ifcopenshell.util.element.get_container()`, und das liefert den
    *unmittelbaren* räumlichen Container. Für eine Wand ist das das Geschoss,
    für einen Stuhl im Wohnzimmer aber der Raum. Wer die Werte dieses Feldes
    für Geschossnamen hält, bekommt im `Ifc4_SampleHouse.ifc` vier „Geschosse“:
    Ground Floor, Roof, „1 - Living room“ und „2 - Bedroom“ — und weil die
    beiden Phantome auf derselben Kote sitzen wie das Erdgeschoss, schrumpft
    dessen Höhe auf null. Alles, dessen Container kein Geschoss ist, wird
    deshalb über seine **Höhenlage** eingeordnet: es gehört zum obersten
    Geschoss, dessen Kote nicht über seiner Unterkante liegt.

    **Geschosse ohne `Elevation` fallen trotzdem nicht heraus.** `storeys()`
    lässt sie aus, und für einen Plan ist das richtig: eine Schnitthöhe über
    einem Geschoss ohne Kote ist nicht adressierbar. Für ein Volumen ist es zu
    streng — ein Geschoss, dessen Bauteile von 0,00 bis 3,00 m reichen, hat
    eine Höhe, ob die Kote im Modell steht oder nicht. Dann tritt die Unterkante
    der ihm unmittelbar zugeordneten Bauteile an ihre Stelle; `kote_quelle`
    sagt, welche galt.
    """
    from shapely.geometry import box as rechteck
    from shapely.ops import unary_union

    offset, index = build_index(src, job_id)
    geschosse = _geschossliste(src, offset, index)
    if not geschosse:
        return []

    sortiert = sorted(geschosse.items(), key=lambda paar: paar[1]["kote"])

    def zuordnen(name: str | None, unterkante: float) -> str:
        """Der Geschossname eines Bauteils — notfalls über seine Höhenlage."""
        if name and name in geschosse:
            return name
        passend = sortiert[0][0]
        for kandidat, daten in sortiert:
            if daten["kote"] <= unterkante + 0.01:
                passend = kandidat
            else:
                break
        return passend

    platten: dict[str, list] = {}
    plattenflaeche: dict[str, float] = {}
    spanne: dict[str, list[float]] = {}
    belegt: dict[str, int] = {}
    for eintrag in index:
        lo, hi = np.asarray(eintrag["lo"], dtype=float), np.asarray(eintrag["hi"], dtype=float)
        name = zuordnen(eintrag.get("storey"), float(lo[2]))
        belegt[name] = belegt.get(name, 0) + 1

        grenzen = spanne.setdefault(name, [float(lo[2]), float(hi[2])])
        grenzen[0] = min(grenzen[0], float(lo[2]))
        grenzen[1] = max(grenzen[1], float(hi[2]))

        if eintrag.get("ifc_type") not in ("IfcSlab", "IfcSlabStandardCase", "IfcRoof"):
            continue
        breite, tiefe, dicke = (hi - lo).tolist()
        if breite <= 0 or tiefe <= 0:
            continue
        if dicke > min(breite, tiefe) * _PLATTE_FLACHHEIT:
            continue  # steht hochkant — keine Geschossfläche
        platten.setdefault(name, []).append(rechteck(lo[0], lo[1], hi[0], hi[1]))
        aus_pset = (flaechen or {}).get(eintrag.get("global_id"))
        if aus_pset and aus_pset > 0:
            plattenflaeche[name] = plattenflaeche.get(name, 0.0) + float(aus_pset)

    ergebnis: list[dict] = []
    for i, (name, daten) in enumerate(sortiert):
        kote = daten["kote"]
        umrisse = platten.get(name, [])
        umschrieben = float(unary_union(umrisse).area) if umrisse else 0.0
        flaeche, flaechen_quelle = _bgf(umschrieben, plattenflaeche.get(name))

        if i + 1 < len(sortiert):
            hoehe = sortiert[i + 1][1]["kote"] - kote
        else:
            hoehe = (spanne[name][1] - kote) if name in spanne else 0.0

        ergebnis.append(
            {
                "name": name,
                "kote_m": round(kote, 3),
                "hoehe_m": round(max(hoehe, 0.0), 2),
                "flaeche_m2": round(flaeche, 2),
                "flaeche_umschrieben_m2": round(umschrieben, 2),
                "flaeche_quelle": flaechen_quelle,
                "platten": len(umrisse),
                "bauteile": belegt.get(name, 0),
                "kote_quelle": daten["quelle"],
            }
        )

    logger.info(f"[{job_id}] Geschosskennwerte: {len(ergebnis)} Geschosse")
    return ergebnis


def _geschossliste(src: Path, offset: np.ndarray,
                   index: list[dict]) -> dict[str, dict]:
    """
    Name → `{kote, quelle}` aller `IfcBuildingStorey` im tile-lokalen System.

    Anders als `storeys()` fallen Geschosse ohne `Elevation` nicht heraus: ihre
    Kote kommt aus der Unterkante der Bauteile, die das Modell ihnen
    unmittelbar zuordnet. Das ist bewusst die *direkte* Zuordnung über das Feld
    `storey` und nicht die Höhenlage — die Höhenzuordnung in
    `geschosskennwerte()` braucht die Koten ja bereits.
    """
    import ifcopenshell
    import ifcopenshell.util.unit

    ifc_file = ifcopenshell.open(str(src))
    faktor = ifcopenshell.util.unit.calculate_unit_scale(ifc_file)

    unterkanten: dict[str, float] = {}
    for eintrag in index:
        name = eintrag.get("storey")
        if name:
            unterkanten[name] = min(unterkanten.get(name, np.inf),
                                    float(np.asarray(eintrag["lo"])[2]))

    geschosse: dict[str, dict] = {}
    for storey in ifc_file.by_type("IfcBuildingStorey"):
        name = storey.Name or f"Geschoss {storey.id()}"
        if storey.Elevation is not None:
            geschosse[name] = {
                "kote": float(storey.Elevation) * faktor - float(offset[2]),
                "quelle": "modell",
            }
        elif name in unterkanten:
            geschosse[name] = {"kote": unterkanten[name], "quelle": "bauteile"}
        else:
            # Ein Geschoss ohne Kote und ohne eigene Bauteile ist für ein
            # Volumen nichts wert; mit 0,0 angesetzt verschöbe es zudem die
            # Höhenzuordnung aller anderen.
            continue

    return geschosse


def _bgf(umschrieben_m2: float, aus_psets: float | None) -> tuple[float, str]:
    """
    Die Bruttogrundfläche eines Geschosses aus zwei Schätzungen, die sich
    gegenseitig begrenzen.

    Beide sind zu groß, aber aus entgegengesetzten Gründen:

    * Die **Vereinigung der Plattenumrisse** rechnet mit Bounding Boxes, also
      mit umschriebenen Rechtecken. Bei einem L-förmigen oder gedrehten
      Grundriss zählt sie die Kerbe mit — am `Ifc4_SampleHouse` sind das 146 m²
      gegenüber rund 90 m² tatsächlicher Bruttofläche.
    * Die **Summe der Mengensätze** trifft die Form genau, zählt aber jede
      Schicht: Rohdecke, Estrich und Dämmung liegen übereinander und ergeben
      das Zwei- bis Dreifache.

    Der kleinere Wert ist damit in beiden Fehlerfällen der bessere, und wo sie
    nah beieinanderliegen, ist das Modell in beiden Hinsichten unauffällig.
    """
    if aus_psets and aus_psets > 0 and umschrieben_m2 > 0:
        return (min(umschrieben_m2, aus_psets),
                "psets" if aus_psets < umschrieben_m2 else "umschrieben")
    if aus_psets and aus_psets > 0:
        return aus_psets, "psets"
    return umschrieben_m2, "umschrieben"


def _bgf(umschrieben_m2: float, aus_psets: float | None) -> tuple[float, str]:
    """
    Die Bruttogrundfläche eines Geschosses aus zwei Schätzungen, die sich
    gegenseitig begrenzen.

    Beide sind zu groß, aber aus entgegengesetzten Gründen:

    * Die **Vereinigung der Plattenumrisse** rechnet mit Bounding Boxes, also
      mit umschriebenen Rechtecken. Bei einem L-förmigen oder gedrehten
      Grundriss zählt sie die Kerbe mit — am `Ifc4_SampleHouse` sind das 146 m²
      gegenüber rund 90 m² tatsächlicher Bruttofläche.
    * Die **Summe der Mengensätze** trifft die Form genau, zählt aber jede
      Schicht: Rohdecke, Estrich und Dämmung liegen übereinander und ergeben
      das Zwei- bis Dreifache.

    Der kleinere Wert ist damit in beiden Fehlerfällen der bessere, und wo sie
    nah beieinanderliegen, ist das Modell in beiden Hinsichten unauffällig.
    """
    if aus_psets and aus_psets > 0 and umschrieben_m2 > 0:
        return (min(umschrieben_m2, aus_psets),
                "psets" if aus_psets < umschrieben_m2 else "umschrieben")
    if aus_psets and aus_psets > 0:
        return aus_psets, "psets"
    return umschrieben_m2, "umschrieben"


def _excluded(ifc_file) -> list:
    """Die Ausschlusstypen des Tilings plus `_NEVER_DRAWN`, soweit die Datei sie kennt."""
    found = []
    for name in set(_EXCLUDE_TYPES) | set(_NEVER_DRAWN):
        try:
            found.extend(ifc_file.by_type(name))
        except Exception:
            continue  # Typ existiert im Schema dieser Datei nicht
    return found


def _storey_of(util, element) -> str | None:
    """
    Name des Geschosses, in dem das Element liegt.

    Zwei Wege, weil das IFC zwei kennt. Bauteile hängen über
    `IfcRelContainedInSpatialStructure` am Geschoss — das findet
    `get_container`. **Räume hängen anders:** `IfcSpace` ist selbst Teil der
    räumlichen Struktur und wird dem Geschoss über `IfcRelAggregates`
    untergeordnet, also über `Decomposes`. Ohne den zweiten Weg bleibt bei
    jedem Raum `None` stehen und im Viewer landen alle in einem Sammelgeschoss
    „ohne Geschoss" — der Geschossfilter wäre wirkungslos.
    """
    try:
        container = util.get_container(element)
        if container is not None:
            return getattr(container, "Name", None)
    except Exception:
        pass

    # Die Zerlegungskette nach oben, bis ein Geschoss kommt. Es sind nie mehr
    # als ein paar Stufen; die Grenze fängt nur eine zyklisch fehlerhafte Datei
    # ab, die sonst endlos liefe.
    knoten = element
    for _ in range(8):
        try:
            zerlegung = getattr(knoten, "Decomposes", None) or []
            if not zerlegung:
                return None
            eltern = getattr(zerlegung[0], "RelatingObject", None)
            if eltern is None:
                return None
            if eltern.is_a("IfcBuildingStorey"):
                return getattr(eltern, "Name", None)
            knoten = eltern
        except Exception:
            return None
    return None


def _material_of(util, element) -> str | None:
    """
    Materialname eines Bauteils, so weit ihn die IFC-Struktur hergibt.

    Geschichtete Bauteile (IfcMaterialLayerSet) liefern die dickste Schicht:
    im Grundriss schraffiert man den tragenden Kern, nicht den Putz. Bei
    gleichen Dicken gewinnt die erste Schicht.
    """
    try:
        material = util.get_material(element)
    except Exception:
        return None
    if material is None:
        return None

    if material.is_a("IfcMaterial"):
        return material.Name
    if material.is_a("IfcMaterialLayerSetUsage"):
        material = material.ForLayerSet
    if material.is_a("IfcMaterialLayerSet"):
        layers = material.MaterialLayers or []
        thickest = max(
            layers, key=lambda layer: layer.LayerThickness or 0.0, default=None
        )
        if thickest is not None and thickest.Material is not None:
            return thickest.Material.Name
    if material.is_a("IfcMaterialList"):
        materials = material.Materials or []
        return materials[0].Name if materials else None
    if material.is_a("IfcMaterialConstituentSet"):
        parts = material.MaterialConstituents or []
        return parts[0].Material.Name if parts and parts[0].Material else None
    return getattr(material, "Name", None)


def materialschichten_of(util, element, laengenfaktor: float = 1.0) -> list[dict]:
    """
    Alle Materialschichten eines Bauteils mit ihrer Dicke.

    Das Gegenstück zu `_material_of()`, das nur die dickste Schicht nennt. Für
    die Schraffur im Grundriss genügt die; für die **Tragwerkserkennung** genügt
    sie nicht, und der Grund ist eine moderne Außenwand: 17,5 cm Kalksandstein
    plus 20 cm Dämmung. Die dickste Schicht ist dort die Dämmung, und eine
    Erkennung, die nur sie ansieht, erklärt eine tragende Außenwand für
    nichttragend — still, denn eine Wand weniger fällt in einem Grundriss mit
    achtzig Wänden niemandem auf.

    Die Reihenfolge, in der gesucht wird, folgt der IFC-Struktur von der
    genauesten zur gröbsten Angabe:

    1. `IfcMaterialLayerSet` (auch über `IfcMaterialLayerSetUsage`) — Schichten
       mit Dicke, die vollständige Auskunft
    2. `IfcMaterialConstituentSet` — benannte Bestandteile ohne Dicke
    3. `IfcMaterialList` — eine Aufzählung ohne Struktur
    4. `IfcMaterial` — ein einziges Material für das ganze Bauteil

    @param laengenfaktor  Längeneinheit der Datei → Meter
                          (`ifcopenshell.util.unit.calculate_unit_scale`).
                          Bis Oktober 2026 fehlte er, und ein Revit-Estrich
                          stand mit „65.0" unter `dicke_m` — in Millimetern.
    @returns [{name, dicke_m, tragend_gesetzt}, …] in Schichtreihenfolge;
             `dicke_m` ist 0.0, wo die Struktur keine Dicke kennt.
             `tragend_gesetzt` kommt aus `IfcMaterialLayer.IsVentilated`
             respektive `LayerSetName`-freien Angaben — siehe unten.
    """
    try:
        material = util.get_material(element)
    except Exception:
        return []
    if material is None:
        return []

    if material.is_a("IfcMaterialLayerSetUsage"):
        material = material.ForLayerSet

    if material.is_a("IfcMaterialLayerSet"):
        schichten = []
        for lage in material.MaterialLayers or []:
            name = getattr(getattr(lage, "Material", None), "Name", None)
            # `IsLoadBearing` steht seit IFC4 an der Schicht selbst. Wo es
            # gepflegt ist, ist es die genaueste Auskunft überhaupt — genauer
            # als jede Materialnamensdeutung, denn es ist eine Aussage des
            # Modellierers über genau diese Schicht.
            schichten.append({
                "name": name,
                "dicke_m": float(getattr(lage, "LayerThickness", 0.0) or 0.0) * laengenfaktor,
                "tragend_gesetzt": getattr(lage, "IsLoadBearing", None),
            })
        return schichten

    if material.is_a("IfcMaterialConstituentSet"):
        return [{"name": getattr(getattr(t, "Material", None), "Name", None),
                 "dicke_m": 0.0, "tragend_gesetzt": None}
                for t in (material.MaterialConstituents or [])]

    if material.is_a("IfcMaterialList"):
        return [{"name": getattr(m, "Name", None), "dicke_m": 0.0,
                 "tragend_gesetzt": None}
                for m in (material.Materials or [])]

    name = getattr(material, "Name", None)
    return [{"name": name, "dicke_m": 0.0, "tragend_gesetzt": None}] if name else []


# ── Schnitt ──────────────────────────────────────────────────────────────────


def cut(
    src: Path,
    job_id: str,
    box: Box,
    mode: str = "grundriss",
    cut_height: float = DEFAULT_CUT_HEIGHT,
    with_views: bool = True,
    with_rooms: bool = False,
    cut_offset: float | None = None,
) -> Drawing:
    """
    Erzeugt die Zeichnung für einen Planausschnitt.

    `mode="grundriss"` schneidet waagerecht `cut_height` über der Unterkante
    der Box — nicht über der Modellunterkante, damit die Angabe im Obergeschoss
    dasselbe bedeutet wie im Erdgeschoss.

    `mode="schnitt"` legt die Ebene senkrecht durch die Box-Mitte, quer zu
    `size[1]`. Die Box beschreibt damit die Schnittscheibe so, wie man sie
    zeichnet: `size[0]` ist die Länge des Schnitts, `size[1]` seine Dicke
    (schmal wählen — sie bestimmt nur, welche Bauteile als getroffen gelten),
    `size[2]` die Höhe. Bei `yaw=0` läuft der Schnitt also von West nach Ost.

    `cut_offset` verschiebt diese Ebene innerhalb der Box, gemessen von der
    Kante `−size[1]/2` aus — dasselbe, was `cut_height` im Grundriss tut. Ohne
    Angabe bleibt es bei der Box-Mitte; Aufrufer von vorher merken davon
    nichts. Gebraucht wird es, wenn die Box stehenbleibt und nur die Ebene
    wandert: eine Schnittbox, die man um ein Bauteil aufgezogen hat, soll man
    durchfahren können, ohne sie jedes Mal neu zu setzen.

    `with_views` steuert die Ansichtskanten: die projizierten Umrisse der
    Bauteile, die unter der Schnittebene liegen. Sie sind der teure Teil (eine
    Projektion je Bauteil) und für eine reine Schraffurvorschau entbehrlich.

    `with_rooms` liefert zusätzlich die Räume des Ausschnitts — nicht als
    Figuren, sondern als Beschriftungsdaten neben der Zeichnung. Nur im
    Grundriss: ein senkrechter Schnitt trifft Räume an beliebiger Stelle, und
    eine Grundfläche lässt sich daraus nicht ablesen.
    """
    import ifcopenshell
    import ifcopenshell.geom
    import trimesh

    offset, index = build_index(src, job_id)
    candidates = [entry for entry in index if box.contains(entry["lo"], entry["hi"])]
    logger.info(
        f"[{job_id}] {mode}: {len(candidates)} von {len(index)} Bauteilen im Ausschnitt"
    )
    if not candidates:
        return Drawing(mode, [], tuple(offset), (0, 0, 0), (0, 0, 1), (0, 0, 0, 0))

    origin, normal, to_2d = _plane(box, mode, cut_height, cut_offset)
    clip = _clip(box, mode)

    ifc_file = ifcopenshell.open(str(src))
    settings = _make_settings(ifcopenshell)

    figures: list[Figure] = []
    for entry in candidates:
        try:
            shape = ifcopenshell.geom.create_shape(settings, ifc_file.by_id(entry["id"]))
        except Exception as e:
            logger.debug(f"[{job_id}] Bauteil {entry['global_id']} ohne Geometrie: {e}")
            continue

        verts = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3) - offset
        faces = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
        if not len(verts) or not len(faces):
            continue
        mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)

        rings = _section_rings(mesh, origin, normal, to_2d, clip)
        kind = "schnitt"
        if not rings and with_views and mode == "grundriss" and entry["hi"][2] < origin[2]:
            rings = _outline_rings(mesh, to_2d, clip)
            kind = "ansicht"
        if not rings:
            continue

        figures.append(
            Figure(
                global_id=entry["global_id"],
                ifc_type=entry["ifc_type"],
                name=entry["name"],
                storey=entry["storey"],
                material=entry["material"],
                signature=signature_for(entry["ifc_type"], entry["material"]),
                kind=kind,
                rings=rings,
                volumen_m3=(round(_mesh_volumen(verts, faces), 5)
                            if kind == "schnitt" else None),
            )
        )

    rooms: list[Room] = []
    if with_rooms and mode == "grundriss":
        rooms = _rooms(ifc_file, settings, src, job_id, offset, box, origin, normal, to_2d, clip)
        logger.info(f"[{job_id}] {len(rooms)} Räume im Ausschnitt")

    # Durchgehend nach float: numpy-Skalare überleben json.dumps() nicht, und
    # der Fehler fiele erst beim Serialisieren der Antwort auf.
    return Drawing(
        mode=mode,
        figures=figures,
        offset=tuple(float(v) for v in offset),
        plane_origin=tuple(float(v) for v in origin),
        plane_normal=tuple(float(v) for v in normal),
        bounds=_bounds(figures),
        rooms=rooms,
    )


def _rooms(ifc_file, settings, src, job_id, offset, box, origin, normal, to_2d, clip) -> list[Room]:
    """
    Die Räume des Ausschnitts als Beschriftungsdaten.

    Der Umriss entsteht wie jede Schnittfigur, damit er zu den Wänden im Plan
    passt. Trifft die Schnittebene den Raum nicht — ein Kriechkeller, eine
    abgehängte Nische —, tritt die Silhouette an ihre Stelle, aber nur für
    Räume, die unterhalb der Ebene beginnen. Sonst würde ein Raum des darüber
    liegenden Geschosses im Grundriss auftauchen, sobald der Ausschnitt aus
    einer hohen Clipping-Box kommt statt aus der Geschossauswahl.
    """
    import ifcopenshell.geom
    import trimesh

    index = _room_index(src, job_id, offset)
    kandidaten = [entry for entry in index if box.contains(entry["lo"], entry["hi"])]

    rooms: list[Room] = []
    for entry in kandidaten:
        try:
            shape = ifcopenshell.geom.create_shape(settings, ifc_file.by_id(entry["id"]))
        except Exception:
            continue

        verts = np.asarray(shape.geometry.verts, dtype=np.float64).reshape(-1, 3) - offset
        faces = np.asarray(shape.geometry.faces, dtype=np.int64).reshape(-1, 3)
        if not len(verts) or not len(faces):
            continue
        mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)

        rings = _section_rings(mesh, origin, normal, to_2d, clip)
        if not rings and entry["lo"][2] <= origin[2]:
            rings = _outline_rings(mesh, to_2d, clip)
        if not rings:
            continue

        flaeche, anker = _room_area(rings, entry.get("qto_area"))
        if flaeche <= 0:
            continue

        hoehe = entry.get("qto_height")
        if not hoehe:
            hoehe = float(entry["hi"][2] - entry["lo"][2])

        rooms.append(
            Room(
                global_id=entry["global_id"],
                name=entry["name"],
                long_name=entry["long_name"],
                storey=entry["storey"],
                area=round(flaeche, 2),
                height=round(float(hoehe), 3) if hoehe else None,
                anchor=anker,
                rings=rings,
            )
        )

    # Nach Fläche absteigend: bei überlappenden Stempeln liegt der große Raum
    # unten und der kleine darüber, statt umgekehrt.
    rooms.sort(key=lambda r: -r.area)
    return rooms


def _repariert(polygon) -> list:
    """
    Ein gültiges Polygon aus einem möglicherweise selbstberührenden Ring.

    `make_valid()` zerlegt eine Acht in zwei Schleifen, statt sie wie
    `buffer(0)` stillschweigend auf eine davon zu reduzieren. Herausfallen kann
    dabei alles Mögliche — Linien, Punkte, Sammlungen —, deshalb werden nur die
    Polygonanteile zurückgegeben.
    """
    from shapely.geometry import Polygon

    if polygon.is_valid:
        return [polygon]
    try:
        from shapely import make_valid

        repariert = make_valid(polygon)
    except Exception:
        repariert = polygon.buffer(0)

    teile = getattr(repariert, "geoms", [repariert])
    return [t for t in teile if isinstance(t, Polygon) and not t.is_empty]


def _room_area(rings, qto: float | None) -> tuple[float, tuple[float, float]]:
    """
    Fläche und Stempelort eines Raums.

    Der Anker ist der Punkt mit dem größten Abstand zum Rand (`polylabel`), nicht
    der Schwerpunkt: bei einem L-förmigen Raum liegt der Schwerpunkt in der
    Kerbe, also im Nachbarraum, und der Stempel stünde über fremder Wand.

    Für die Fläche gilt der Wert aus dem Mengenset, sofern er zur Geometrie
    passt. Er ist die Nutzfläche, wie der Entwurfsverfasser sie meint; das
    Schnittpolygon misst dagegen den Umriss in Schnitthöhe. Weicht das Qto um
    mehr als die Hälfte ab, stimmt an ihm etwas nicht — eine falsch
    interpretierte Einheit etwa —, und die gemessene Fläche ist die ehrlichere
    Angabe.
    """
    from shapely.geometry import Polygon

    # `_rings_from()` rundet die Konturen auf 0,1 mm. Bei einem Raumumriss mit
    # Nischen rücken dabei Punkte aufeinander, und der zurückgebaute Ring
    # berührt sich selbst — `_nest()` sortiert ihn dann als ungültig aus. Beim
    # Büro 0.07 des ArchiCAD-Modells blieb so von 26 m² nur die 0,05 m² große
    # Stütze darin übrig, die eigentlich ein Loch ist. Deshalb wird jeder Ring
    # vor dem Verschachteln repariert.
    polygone = _nest([teil for ring in rings if len(ring) >= 4 for teil in _repariert(Polygon(ring))])
    if not polygone:
        return 0.0, (0.0, 0.0)

    gemessen = sum(p.area for p in polygone)
    groesstes = max(polygone, key=lambda p: p.area)

    try:
        from shapely.ops import polylabel

        punkt = polylabel(groesstes, tolerance=0.05)
    except Exception:
        punkt = groesstes.centroid
        if not groesstes.contains(punkt):
            punkt = groesstes.representative_point()

    flaeche = gemessen
    if qto and gemessen > 0 and 0.5 <= qto / gemessen <= 2.0:
        flaeche = qto

    return float(flaeche), (round(float(punkt.x), 4), round(float(punkt.y), 4))


def _plane(box: Box, mode: str, cut_height: float, cut_offset: float | None = None):
    """
    Schnittebene und die Abbildung von 3D in die Zeichenebene.

    Die 2D-Matrix wird von Hand gebaut statt über `trimesh.geometry.
    plane_transform()`: dessen Wahl der Achsen ist beliebig, solange sie nur
    orthonormal ist. Für einen Plan muss die Ausrichtung aber vorhersagbar
    sein — im Grundriss zeigt X nach Osten und Y nach Norden, im Schnitt läuft
    X entlang der Box und Y ist die Höhe. Sonst steht die Zeichnung je nach
    Modell auf dem Kopf.
    """
    center = np.asarray(box.center, dtype=float)
    half = np.asarray(box.size, dtype=float) / 2.0

    if mode == "grundriss":
        z = center[2] - half[2] + cut_height
        origin = np.array([center[0], center[1], z])
        normal = np.array([0.0, 0.0, 1.0])
        to_2d = np.eye(4)
        to_2d[2, 3] = -z
        return origin, normal, to_2d

    if mode != "schnitt":
        raise ValueError(f"Unbekannter Modus '{mode}' — erwartet 'grundriss' oder 'schnitt'.")

    along, across = box.axes()
    # Ohne Angabe liegt die Ebene in der Box-Mitte — so war es immer, und für
    # eine Schnittscheibe, die man um die gewünschte Lage herum aufzieht, ist
    # es das Richtige. `cut_offset` misst wie `cut_height` von der Boxkante
    # aus, nur eben quer statt nach oben: damit lässt sich die Ebene in einer
    # stehengebliebenen Box verschieben, ohne den Ausschnitt zu verändern.
    origin = center.copy()
    if cut_offset is not None:
        origin = center + across * (cut_offset - half[1])
    normal = across
    up = np.array([0.0, 0.0, 1.0])
    to_2d = np.eye(4)
    to_2d[:3, :3] = np.vstack([along, up, normal])

    # Die Länge wird auf die Box-Mitte bezogen, die Höhe bewusst nicht: Y bleibt
    # das tile-lokale Z. In einem Schnitt liest man Höhen ab — Brüstung, Sturz,
    # Geschossfußboden —, und die müssen zu den Werten aus `storeys()` passen.
    # Auf die Box-Mitte bezogen wären es Zahlen ohne Bedeutung außerhalb dieses
    # einen Ausschnitts.
    shift = -to_2d[:3, :3] @ origin
    to_2d[0, 3] = shift[0]
    to_2d[1, 3] = 0.0
    to_2d[2, 3] = shift[2]
    return origin, normal, to_2d


def _section_rings(mesh, origin, normal, to_2d, clip) -> list[list[tuple[float, float]]]:
    """Die Schnittfigur: geschlossene Konturen dort, wo die Ebene das Bauteil trifft."""
    try:
        path = mesh.section(plane_origin=origin, plane_normal=normal)
    except Exception:
        return []
    if path is None:
        return []
    try:
        planar, _ = path.to_planar(to_2D=to_2d, check=False)
        closed = planar.polygons_closed
    except Exception:
        return []
    return _rings_from(_nest(closed), clip)


def _outline_rings(mesh, to_2d, clip) -> list[list[tuple[float, float]]]:
    """
    Die Ansichtskante: die Silhouette des Bauteils, senkrecht auf die Ebene
    projiziert.

    Gebildet als Vereinigung der projizierten Dreiecke, die zur Ebene hin
    zeigen — bei einem geschlossenen Körper deckt diese Hälfte die Silhouette
    vollständig ab, halbiert aber die Menge der zu vereinigenden Polygone.

    Das ist bewusst nur eine Silhouette. Ein Grundriss nach DIN 1356-1 zeigt
    unter der Schnittebene die *sichtbaren Kanten* — Brüstungen, Stufen,
    Anschlüsse —, nicht den gefüllten Umriss. Für die Verortung im Plan reicht
    die Silhouette; wer Kantenzeichnung braucht, muss die Dreiecksnachbarschaft
    auswerten statt zu vereinigen.
    """
    import shapely
    from shapely.geometry import Polygon

    try:
        verts = np.column_stack([mesh.vertices, np.ones(len(mesh.vertices))])
        flat = (to_2d @ verts.T).T[:, :2]
        toward = mesh.face_normals @ (to_2d[2, :3])
        faces = mesh.faces[toward > 0]
        if not len(faces):
            faces = mesh.faces

        triangles = [Polygon(flat[face]) for face in faces]
        union = shapely.union_all([t for t in triangles if t.is_valid and t.area > _MIN_AREA])
    except Exception:
        return []
    if union.is_empty:
        return []
    return _rings_from(getattr(union, "geoms", [union]), clip)


def _nest(polygons) -> list:
    """
    Ordnet geschlossene Konturen zu Flächen mit Löchern.

    Ohne `rtree` liefert trimesh nur die Ringe ohne Verschachtelung — welcher
    Ring ein Loch im anderen ist, bleibt offen. Die Zuordnung passiert deshalb
    hier über die Verschachtelungstiefe nach der Even-Odd-Regel: Ringe gerader
    Tiefe sind Fläche, ungerader Tiefe sind Loch. Damit stimmt auch der Fall,
    in dem in einem Loch wieder Material sitzt — eine Stütze im Schacht.

    Der Test ist quadratisch, was hier nichts kostet: eine Bauteilfigur hat
    selten mehr als eine Handvoll Ringe. Der Verzicht auf `rtree` spart dem
    Image dafür eine C-Bibliothek.
    """
    from shapely.geometry import Polygon

    ordered = sorted(
        (p for p in polygons if p is not None and p.is_valid and p.area > _MIN_AREA),
        key=lambda p: -p.area,
    )
    if not ordered:
        return []

    points = [p.representative_point() for p in ordered]
    depth = [
        sum(1 for j in range(i) if ordered[j].contains(points[i])) for i in range(len(ordered))
    ]

    nested = []
    for i, polygon in enumerate(ordered):
        if depth[i] % 2:
            continue  # ungerade Tiefe: das ist ein Loch, kein eigener Körper
        holes = [
            ordered[j].exterior.coords
            for j in range(len(ordered))
            if depth[j] == depth[i] + 1 and polygon.contains(points[j])
        ]
        nested.append(Polygon(polygon.exterior.coords, holes))
    return nested


def _clip(box: Box, mode: str):
    """
    Der Zuschnitt in Koordinaten der **Zeichenebene** — nicht des Modells.

    Im Grundriss fallen beide zusammen: die Zeichenebene liegt waagerecht, ihre
    2D-Punkte sind die tile-lokalen X/Y, und `box.polygon()` passt unverändert.

    Im Schnitt nicht. Dort läuft X entlang der Box und Y ist die Höhe, also ist
    der Zuschnitt das Rechteck [−size[0]/2, +size[0]/2] × [Unterkante,
    Oberkante] — die Höhen absolut, weil `_plane()` Y bewusst als tile-lokales
    Z stehenlässt (siehe dort).

    **Früher wurde im Schnitt gar nicht zugeschnitten** (`clip = … else None`).
    Das fiel nicht auf, solange ein Schnitt das ganze Geschoss zeigen sollte —
    die Box war ohnehin so groß wie das Gebäude. Sobald sie ein Ausschnitt von
    ein paar Metern ist, zeichnete ein Detail die getroffenen Bauteile in voller
    Länge: eine 3-m-Box um einen Wandanschluss lieferte die 14 m lange Wand.
    """
    if mode == "grundriss":
        return box.polygon()

    from shapely.geometry import box as rechteck

    half = np.asarray(box.size, dtype=float) / 2.0
    return rechteck(-half[0], box.center[2] - half[2], half[0], box.center[2] + half[2])


def _rings_from(polygons, clip) -> list[list[tuple[float, float]]]:
    """
    Shapely-Polygone auf den Ausschnitt zuschneiden und als Ringlisten ausgeben.

    Reihenfolge wie in GeoJSON: erst die Außenkontur, dann ihre Löcher. Wer die
    Liste zeichnet, muss sie deshalb mit der Even-Odd-Füllregel behandeln.
    """
    from shapely.geometry import MultiPolygon, Polygon

    rings: list[list[tuple[float, float]]] = []
    for polygon in polygons or []:
        if clip is not None:
            try:
                polygon = polygon.intersection(clip)
            except Exception:
                continue
        if polygon.is_empty:
            continue
        parts = polygon.geoms if isinstance(polygon, MultiPolygon) else [polygon]
        for part in parts:
            if not isinstance(part, Polygon) or part.area < _MIN_AREA:
                continue
            rings.append([(round(x, 4), round(y, 4)) for x, y in part.exterior.coords])
            for hole in part.interiors:
                rings.append([(round(x, 4), round(y, 4)) for x, y in hole.coords])
    return rings


def _bounds(figures: list[Figure]) -> tuple[float, float, float, float]:
    """Ausdehnung der Zeichnung — für Blattformat und Maßstabswahl."""
    points = [point for figure in figures for ring in figure.rings for point in ring]
    if not points:
        return (0.0, 0.0, 0.0, 0.0)
    array = np.asarray(points)
    lo, hi = array.min(axis=0), array.max(axis=0)
    return (float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1]))


# ── Signaturen ───────────────────────────────────────────────────────────────

_CATALOG: dict | None = None


def catalog() -> dict:
    """
    Der Signaturkatalog, einmal geladen.

    Liegt als JSON neben diesem Modul und lässt sich über `SIGNATUR_KATALOG`
    durch eine eigene Datei ersetzen. Bewusst datengetrieben: welche Schraffur
    zu welchem Baustoff gehört, ist eine Frage der Zeichenvorschrift und nicht
    des Programms — DIN 1356-1 für Bauzeichnungen, in einem anderen Kontext
    vielleicht ein Auszug aus der PlanZV. Beides muss ohne Codeänderung gehen.
    """
    global _CATALOG
    if _CATALOG is None:
        path = Path(os.getenv("SIGNATUR_KATALOG", Path(__file__).parent / "signaturen.json"))
        _CATALOG = json.loads(path.read_text(encoding="utf-8"))
        logger.info(f"Signaturkatalog geladen: {path} ({len(_CATALOG.get('muster', {}))} Muster)")
    return _CATALOG


def signature_for(ifc_type: str, material: str | None) -> str | None:
    """
    Ordnet einem Bauteil sein Schraffurmuster zu.

    Das Material entscheidet, nicht der Bauteiltyp: eine Wand ist je nach
    Aufbau Mauerwerk oder Stahlbeton, und im Grundriss unterscheiden sich beide
    genau in der Schraffur. Erkannt wird es über `materials.suggest_category()`
    — dieselbe Keyword-Logik, die schon die Texturen zuordnet, samt der Regel,
    dass das längste Keyword gewinnt. Erst wenn das Material nichts hergibt,
    greift die Zuordnung über den IFC-Typ.
    """
    data = catalog()

    if material:
        from tiling.materials import suggest_category

        category = suggest_category(material)[0]
        if category and category in data.get("nach_kategorie", {}):
            return data["nach_kategorie"][category]

    return data.get("nach_typ", {}).get(ifc_type) or data.get("standard")


# ── Handprobe ────────────────────────────────────────────────────────────────


if __name__ == "__main__":  # pragma: no cover
    # Prüft die beiden Auswertungen, die ohne IFC-Datei auskommen und still
    # falsch werden können: die Einheitenwahl der Mengensätze und die
    # Bruttogrundfläche aus zwei sich begrenzenden Schätzungen.
    #
    # Aufruf: `python3 -m tiling.section`

    fehlend = 0

    def _pruefe(name, ist, soll):
        global fehlend
        ok = ist == soll
        if not ok:
            fehlend += 1
        print(f"{'✓' if ok else '✗'} {name}" + ("" if ok else f"   ist {ist!r}, soll {soll!r}"))

    print("── Einheiten der Mengensätze " + "─" * 32)

    # Der reale Fall aus `Ifc4_SampleHouse.ifc`: Längeneinheit Millimeter,
    # Fläche und Volumen aber bereits metrisch, die Höhe nicht.
    lo, hi = np.array([0.0, 0.0, 0.0]), np.array([8.6, 7.0, 2.5])
    gemischt = _masse_pruefen(
        {"roh_area": 51.99, "roh_height": 2500.0, "roh_volume": 129.99}, 0.001, lo, hi)
    _pruefe("Die metrische Fläche bleibt metrisch", round(gemischt["qto_area"], 2), 51.99)
    _pruefe("Die Höhe in Millimetern wird umgerechnet", gemischt["qto_height"], 2.5)
    _pruefe("Das metrische Volumen bleibt metrisch",
            round(gemischt["qto_volume"], 2), 129.99)

    # Und der Regelfall, in dem wirklich alles in der Längeneinheit steht.
    einheitlich = _masse_pruefen(
        {"roh_area": 51_990_000.0, "roh_height": 2500.0, "roh_volume": 129_990_000_000.0},
        0.001, lo, hi)
    _pruefe("Durchgehend millimetrisch wird durchgehend skaliert",
            (round(einheitlich["qto_area"], 2), einheitlich["qto_height"],
             round(einheitlich["qto_volume"], 2)), (51.99, 2.5, 129.99))

    # Was in keiner Einheit passt, ist keine Angabe.
    unsinn = _masse_pruefen({"roh_area": 4_000.0, "roh_height": 900.0}, 1.0, lo, hi)
    _pruefe("Eine unpassende Fläche entfällt", "qto_area" in unsinn, False)
    _pruefe("Eine unpassende Höhe entfällt", "qto_height" in unsinn, False)

    print("\n── Bruttogrundfläche " + "─" * 40)
    _pruefe("Der kleinere von beiden gewinnt", _bgf(146.2, 92.0), (92.0, "psets"))
    _pruefe("Auch andersherum", _bgf(88.0, 210.0), (88.0, "umschrieben"))
    _pruefe("Ohne Mengensatz bleibt der Umriss", _bgf(146.2, None), (146.2, "umschrieben"))
    _pruefe("Ohne Umriss bleibt der Mengensatz", _bgf(0.0, 92.0), (92.0, "psets"))

    print("\n── Rauminhalt aus dem Netz " + "─" * 34)
    # Ein Einheitswürfel als Dreiecksnetz: acht Ecken, zwölf Dreiecke.
    ecken = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
                      [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], dtype=float)
    dreiecke = np.array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
                         1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
    _pruefe("Der Einheitswürfel hat Rauminhalt 1",
            round(_mesh_volumen(ecken, dreiecke), 9), 1.0)
    _pruefe("Ein leeres Netz hat keinen", _mesh_volumen(np.zeros((0, 3)), np.array([])), 0.0)
    _pruefe("Ein Netzvolumen über dem Hüllquader wird verworfen",
            _raum_volumen({"mesh_volume": 500.0, "qto_volume": 120.0}, 150.0), (120.0, "qto"))
    _pruefe("Sonst gilt das Netz",
            _raum_volumen({"mesh_volume": 130.0, "qto_volume": 120.0}, 150.0), (130.0, "netz"))

    print("\n" + ("Alle Prüfungen bestanden." if not fehlend
                  else f"{fehlend} Prüfung(en) fehlgeschlagen."))
    raise SystemExit(1 if fehlend else 0)
