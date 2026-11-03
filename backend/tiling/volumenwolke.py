"""
Ergebnisse eines Volumenmodells als Punktwolke — mit den Werten *am* Punkt.

`ergebniswolke.py` legt die Ergebnisse einer Deckenrechnung in die
Deckenebene: ein Wert je Ort, eingefärbt, mit Legende. Das ist eine Karte.
Dieses Modul macht etwas anderes — es legt eine **Wolke im Raum** an, einen
Punkt je Element des Volumenmodells, und jeder dieser Punkte trägt seine
sämtlichen Werte mit sich:

    Ort ─ Durchbiegung ─ σ_xx … τ_xy ─ σ_v ─ σ_1/σ_3 ─ η ─ Bauteil ─ Werkstoff

Damit wird aus dem Bild ein Datensatz. Man sieht nicht nur, wo es rot ist,
sondern kann jeden Punkt anklicken und bekommt den ganzen Spannungszustand —
ohne dass das Backend gefragt werden muss, ohne dass die Rechnung noch
existiert. Die Wolke ist selbsttragend.

## Wie die Werte an den Punkt kommen

Über die **Batch-Table** des PNTS-Formats. 3D Tiles kennt dafür zwei Wege,
und beide werden hier gebraucht:

* **Binär**, für alles Zahlenhafte. Ein `float32`-Block je Größe,
  hintereinander im Body, im Header nur `{byteOffset, componentType, type}`.
  Das ist der einzige Weg, der bei hunderttausend Punkten nicht am
  JSON-Parser scheitert.
* **Als Index**, für alles Textliche. Ein Bauteilname wiederholt sich über
  zehntausend Punkte; ihn zehntausendmal in den Header zu schreiben wäre
  absurd. Stattdessen steht je Punkt eine `uint16`-Nummer im Binärblock und
  die Tabelle dazu einmal in der `skala.json`.

CesiumJS macht daraus beim Anklicken ein `Cesium3DTileFeature`, dessen
`getProperty('sigma_v')` den Wert dieses einen Punktes liefert. Die
Verknüpfung „Punkt ↔ Information", um die es hier geht, ist damit keine
Zusatzschicht, sondern das Dateiformat selbst.

**Zusätzlich** liegt neben der Kachel eine `punkte.npz` mit denselben Werten.
Sie ist der Weg für alles, was nicht im Browser passiert: die Punktabfrage
über die API, eine Auswertung im Notebook, ein Vergleich zweier Läufe. Zwei
Ablagen derselben Zahlen sind eine Redundanz, die sich lohnt — die eine ist
schnell und offline, die andere vollständig und auswertbar.

## Warum die Farbe nur eine von vielen Größen ist

Gefärbt wird nach *einem* Feld, das beim Bauen gewählt wird. Alle anderen
fahren trotzdem mit. Wer die Wolke nach der Ausnutzung einfärbt und dann
einen Punkt anklickt, sieht dort auch die Durchbiegung und die einzelnen
Spannungskomponenten — und muss nicht sieben Wolken erzeugen, um sieben
Größen zu haben. Die Farbskala selbst kommt aus `ergebniswolke.py`; sie ist
dort für Plattenergebnisse entstanden und für Spannungen dieselbe.
"""

from __future__ import annotations

import json
import logging
import struct
from pathlib import Path

import numpy as np

from . import georef
from .ergebniswolke import STUFEN_STANDARD, _hex, _rampe

logger = logging.getLogger(__name__)

_HEADER_SIZE = 28


# ── Welche Größen eine Volumenwolke führt ────────────────────────────────

#: Schlüssel → (Beschriftung, Einheit, Farbverlauf, symmetrisch, Stufen, Gruppe)
#:
#: Die Reihenfolge ist die der Anzeige. Sie beginnt bei dem, was man zuerst
#: wissen will (Ausnutzung, Verformung), und endet bei den Einzelkomponenten
#: des Spannungstensors, die man nur braucht, wenn man einer Sache nachgeht.
FELDER: dict[str, tuple] = {
    "eta":        ("Ausnutzung η", "–", "warm", False, 10, "Nachweis"),
    "w":          ("Durchbiegung w", "mm", "regenbogen_r", False, STUFEN_STANDARD, "Verformung"),
    "u":          ("Verschiebung |u|", "mm", "regenbogen_r", False, STUFEN_STANDARD, "Verformung"),
    "sigma_v":    ("Vergleichsspannung σ_v", "N/mm²", "warm", False, 0, "Spannung"),
    "sigma_1":    ("Hauptspannung σ_1 (Zug)", "N/mm²", "divergent", True, 0, "Spannung"),
    "sigma_3":    ("Hauptspannung σ_3 (Druck)", "N/mm²", "divergent", True, 0, "Spannung"),
    "sigma_ll":   ("Längsspannung σ_∥ (Faser/Achse)", "N/mm²", "divergent", True, 0, "Spannung"),
    "tau_max":    ("Schubspannung τ_max", "N/mm²", "warm", False, 0, "Spannung"),
    "sigma_xx":   ("σ_xx", "N/mm²", "divergent", True, 0, "Komponenten"),
    "sigma_yy":   ("σ_yy", "N/mm²", "divergent", True, 0, "Komponenten"),
    "sigma_zz":   ("σ_zz", "N/mm²", "divergent", True, 0, "Komponenten"),
    "tau_yz":     ("τ_yz", "N/mm²", "divergent", True, 0, "Komponenten"),
    "tau_xz":     ("τ_xz", "N/mm²", "divergent", True, 0, "Komponenten"),
    "tau_xy":     ("τ_xy", "N/mm²", "divergent", True, 0, "Komponenten"),
}


def felder_aus_ergebnis(ergebnis, kombination: str = "GZT") -> dict:
    """
    Die Punktwerte aus einem `volumen.Ergebnis` zusammenstellen.

    @returns {"xyz": (n,3), "werte": {name: (n,)}, "bauteil": (n,) uint16,
              "tabelle": [...]}

    **Ein Punkt je Element, nicht je Knoten.** Die Spannung ist eine
    Elementgröße — sie springt an der Werkstofffuge, und ein Knotenwert
    müsste dort zwei Werte mitteln, die verschiedene Dinge bedeuten. Die
    Verschiebung ist dagegen eine Knotengröße; sie wird auf die Elementmitte
    gemittelt, was bei einem trilinearen Ansatz exakt der Wert im Mittelpunkt
    ist.

    Die Einheiten wechseln hier bewusst: Spannungen von kN/m² nach N/mm²,
    Verschiebungen von m nach mm. Innen wird konsequent in m und kN
    gerechnet, angezeigt wird, was ein Tragwerksplaner liest.
    """
    from ileen import werkstoff as wk

    netz = ergebnis.netz
    sigma = ergebnis.sigma[kombination]                      # (m,6) kN/m²
    u = ergebnis.u[kombination]

    # Knotenverschiebung auf die Elementmitte: der Mittelwert der acht Ecken
    # ist beim trilinearen Ansatz der Wert im Mittelpunkt.
    u_element = u[netz.cells].mean(axis=1)                   # (m,3)

    haupt = wk.hauptspannungen(sigma) / wk.MPA
    sig = sigma / wk.MPA

    werte = {
        "eta": ergebnis.eta["eta"],
        "w": -u_element[:, 2] * 1000.0,
        "u": np.linalg.norm(u_element, axis=1) * 1000.0,
        "sigma_v": wk.vergleichsspannung(sigma) / wk.MPA,
        "sigma_1": haupt[:, 0],
        "sigma_3": haupt[:, 2],
        # τ_max nach Mohr: der halbe Abstand der äußeren Hauptspannungen.
        "tau_max": (haupt[:, 0] - haupt[:, 2]) / 2.0,
        "sigma_xx": sig[:, 0], "sigma_yy": sig[:, 1], "sigma_zz": sig[:, 2],
        "tau_yz": sig[:, 3], "tau_xz": sig[:, 4], "tau_xy": sig[:, 5],
    }

    # σ längs der Bauteilachse — je Bauteil eine andere Richtung, deshalb
    # bauteilweise. Bei Holz ist das die Faserrichtung und damit die Größe,
    # an der der Nachweis hängt.
    s_ll = np.zeros(netz.n_elemente)
    for index, b in enumerate(netz.bauteile):
        maske = netz.bauteil == index
        if not maske.any():
            continue
        achse = getattr(b, "faser_gewaehlt", None)
        if achse is None:
            achse, _ = b.faserrichtung()
        T = wk.als_tensor(sigma[maske])
        s_ll[maske] = np.einsum("i,nij,j->n", achse, T, achse) / wk.MPA
    werte["sigma_ll"] = s_ll

    # Teilnachweise mitnehmen — sie beantworten die Frage „warum ist η hier
    # groß", und das ist die erste Rückfrage nach jedem roten Bereich.
    for name, feld in ergebnis.eta["teil"].items():
        werte[f"eta_{name}"] = feld

    tabelle = []
    for index, b in enumerate(netz.bauteile):
        achse = getattr(b, "faser_gewaehlt", None)
        tabelle.append({
            "index": index, "global_id": b.global_id, "name": b.name,
            "ifc_typ": b.ifc_typ, "werkstoff": b.werkstoff.name,
            "familie": b.werkstoff.familie,
            "faser": None if achse is None else [round(float(v), 3) for v in achse],
            "faser_grund": getattr(b, "faser_grund", ""),
            "elemente": int((netz.bauteil == index).sum()),
            **{k: v for k, v in b.merkmale.items() if isinstance(v, (str, int, float))},
        })

    return {"xyz": netz.mitten(), "werte": werte,
            "bauteil": netz.bauteil.astype(np.uint16), "tabelle": tabelle,
            "kombination": kombination, "elementgroesse_m": netz.groesse}


# ── PNTS mit Batch-Table ─────────────────────────────────────────────────


def _polster(daten: bytes, fuellung: bytes = b"\x00") -> bytes:
    """Auf ein Vielfaches von 8 Byte bringen — die Spec verlangt es."""
    return daten + fuellung * ((8 - len(daten) % 8) % 8)


def _pnts(xyz: np.ndarray, farben: np.ndarray,
          eigenschaften: dict[str, np.ndarray]) -> bytes:
    """
    PNTS-Kachel mit per-Punkt-Eigenschaften in der Batch-Table.

    Das Format ist dasselbe wie in `ergebniswolke._pnts()`, um zwei Blöcke
    erweitert: Batch-Table-JSON und -Binary. Die Zahlenfelder liegen als
    zusammenhängender Binärblock dahinter, der Header nennt nur die
    Byteversätze.

    **`BATCH_ID` je Punkt, `BATCH_LENGTH` = Punktzahl — und das ist keine
    Formsache.** Die Spezifikation kennt für PNTS auch „per-point properties"
    ohne Batch-Zuordnung, und die naheliegende Überlegung ist, genau die zu
    nehmen: jeder Punkt ist ohnehin sein eigenes Ding, wozu also Gruppen von
    je einem.

    Im Viewer ist das Ergebnis dann aber **stumm**. CesiumJS legt ohne
    `BATCH_LENGTH` gar keine Features an (`content.featuresLength === 0`);
    die Werte sind dort nur für Stilausdrücke da (`${eta}` in einem
    `Cesium3DTileStyle`), und `getFeature()` wie auch ein Klick liefern
    nichts, woran `getProperty()` ansetzen könnte. Am fertigen Tileset
    nachgemessen, nicht aus der Spezifikation geschlossen.

    Der Preis ist gering: die Feature-Objekte entstehen erst beim Zugriff,
    dauerhaft belegt wird nur die Nummer je Punkt — zwei Byte, oder vier
    jenseits von 65 536 Punkten.

    **Alles `float32`.** Die Werte kommen aus einer Rechnung mit fünf
    signifikanten Stellen; `float64` verdoppelte die Dateigröße für Stellen,
    die keine Aussage tragen. Einzige Ausnahme ist die Bauteilnummer als
    `uint16` — sie ist ein Schlüssel, kein Messwert.
    """
    anzahl = int(len(xyz))
    positionen = np.ascontiguousarray(xyz, dtype="<f4").tobytes()
    rgb = (farben * 255.0).clip(0, 255).astype(np.uint8).tobytes()

    # Jeder Punkt ist sein eigenes Feature. Der Typ richtet sich nach der
    # Punktzahl: `uint16` reicht bis 65 536, darüber muss es `uint32` sein —
    # ein stillschweigender Überlauf verteilte die Werte sonst auf die
    # falschen Punkte.
    if anzahl <= 0xFFFF:
        batch_typ, batch_ids = "UNSIGNED_SHORT", np.arange(anzahl, dtype="<u2")
    else:
        batch_typ, batch_ids = "UNSIGNED_INT", np.arange(anzahl, dtype="<u4")

    # Der BATCH_ID-Block muss an seiner Komponentengrenze beginnen; Position
    # und Farbe davor sind 12 bzw. 3 Byte je Punkt und treffen sie nicht von
    # selbst.
    kopf_bytes = positionen + rgb
    fuellung = (4 - len(kopf_bytes) % 4) % 4
    kopf_bytes += b"\x00" * fuellung

    feature_json = json.dumps({
        "POINTS_LENGTH": anzahl,
        "POSITION": {"byteOffset": 0},
        "RGB": {"byteOffset": len(positionen)},
        "BATCH_ID": {"byteOffset": len(kopf_bytes), "componentType": batch_typ},
        "BATCH_LENGTH": anzahl,
    }).encode("utf-8")
    feature_binaer = _polster(kopf_bytes + batch_ids.tobytes())

    kopf: dict[str, dict] = {}
    bloecke: list[bytes] = []
    versatz = 0
    for name, werte in eigenschaften.items():
        arr = np.asarray(werte)
        if arr.dtype == np.uint16:
            typ, roh = "UNSIGNED_SHORT", np.ascontiguousarray(arr, dtype="<u2")
        else:
            typ, roh = "FLOAT", np.ascontiguousarray(arr, dtype="<f4")
        block = roh.tobytes()
        # Jeder Block beginnt an seiner eigenen Komponentengrenze; 8 Byte
        # erfüllt jede davon und macht die Rechnung einfach.
        block = _polster(block)
        kopf[name] = {"byteOffset": versatz, "componentType": typ, "type": "SCALAR"}
        bloecke.append(block)
        versatz += len(block)

    batch_json = json.dumps(kopf).encode("utf-8") if kopf else b""
    batch_binaer = b"".join(bloecke)

    # Der Feature-Table-JSON muss so gepolstert werden, dass der *Binärteil*
    # auf einer 8-Byte-Grenze beginnt — der 28-Byte-Header zählt mit.
    feature_json = feature_json + b" " * ((8 - (_HEADER_SIZE + len(feature_json)) % 8) % 8)
    if batch_json:
        batch_json = _polster(batch_json, b" ")

    laenge = (_HEADER_SIZE + len(feature_json) + len(feature_binaer)
              + len(batch_json) + len(batch_binaer))
    return (b"pnts" + struct.pack("<I", 1) + struct.pack("<I", laenge)
            + struct.pack("<I", len(feature_json))
            + struct.pack("<I", len(feature_binaer))
            + struct.pack("<I", len(batch_json))
            + struct.pack("<I", len(batch_binaer))
            + feature_json + feature_binaer + batch_json + batch_binaer)


def aufbauen(punkte: dict, ziel: Path, feld: str = "eta",
             placement: dict | None = None, stufen: int | None = None,
             verlauf: str | None = None, verformt: float = 0.0) -> dict:
    """
    Aus den Punktwerten ein PNTS-Tileset mit Legende und Datenablage bauen.

    @param punkte    Rückgabe von `felder_aus_ergebnis()`
    @param ziel      Verzeichnis für `tile.pnts`, `tileset.json`, `skala.json`,
                     `punkte.npz`
    @param feld      welches Feld die Farbe bestimmt
    @param placement Platzierung des Quellmodells — **zwingend dieselbe**
    @param verformt  Faktor, mit dem die Punkte in ihre verformte Lage
                     verschoben werden; 0 = unverformt

    **Das Placement ist der Punkt, an dem eine Ergebniswolke danebengeht.**
    Ein eigenes Standard-Placement setzt die Wolke an den konfigurierten
    Referenzpunkt statt an das Gebäude — sie liegt dann in der Nähe, und der
    Fehler fällt erst auf, wenn jemand hineinzoomt. Übergeben wird deshalb
    das Placement des Modells, aus dem die Bauteile stammen.

    **Die verformte Lage ist eine Anschauungshilfe, keine Geometrie.** Mit
    `verformt` werden die Punkte um ihre Verschiebung mal diesem Faktor
    versetzt — bei einer Durchbiegung von einem halben Millimeter auf sechs
    Metern sieht man sonst nichts. Der Faktor steht in der `skala.json`, damit
    niemand die überhöhte Darstellung für die wirkliche hält.
    """
    if feld not in punkte["werte"]:
        raise ValueError(
            f"Feld '{feld}' gibt es in dieser Wolke nicht. Vorhanden: "
            f"{', '.join(sorted(punkte['werte']))}")

    xyz = np.asarray(punkte["xyz"], dtype=float).copy()
    werte = punkte["werte"]

    if verformt:
        # Die Verschiebung steckt in den Feldern nur als Betrag; für die
        # Richtung braucht es die Komponenten, die `felder_aus_ergebnis`
        # deshalb mitgibt, wenn eine Verformungsfigur gewünscht ist.
        richtung = punkte.get("u_vektor")
        if richtung is None:
            raise ValueError("Für die verformte Lage fehlt `u_vektor` in den Punktdaten.")
        xyz = xyz + np.asarray(richtung, dtype=float) * float(verformt)

    beschriftung, einheit, standard_verlauf, symmetrisch, standard_stufen, gruppe = \
        FELDER.get(feld, (feld, "", "warm", False, 0, "Weitere"))
    gewaehlt_verlauf = verlauf or standard_verlauf
    gewaehlt_stufen = standard_stufen if stufen is None else max(int(stufen), 0)

    farben, bereich = _rampe(np.asarray(werte[feld], dtype=float),
                             gewaehlt_verlauf, symmetrisch, gewaehlt_stufen)

    # Was in die Kachel wandert: alle Zahlenfelder plus die Bauteilnummer.
    eigenschaften = {name: np.asarray(w, dtype=np.float32) for name, w in werte.items()}
    eigenschaften["bauteil"] = np.asarray(punkte["bauteil"], dtype=np.uint16)

    ziel = Path(ziel)
    ziel.mkdir(parents=True, exist_ok=True)
    (ziel / "tile.pnts").write_bytes(_pnts(xyz, farben, eigenschaften))
    np.savez_compressed(ziel / "punkte.npz", xyz=xyz,
                        bauteil=np.asarray(punkte["bauteil"]), **werte)

    lo, hi = xyz.min(axis=0), xyz.max(axis=0)
    tileset = georef.build_tileset(
        georef.make_tile(
            center=((lo + hi) / 2.0).tolist(),
            half=((hi - lo) / 2.0 + 0.05).tolist(),
            geometric_error=0.0,
            content_uri="tile.pnts"),
        geometric_error=max(float(np.linalg.norm(hi - lo)), 1.0))
    if placement:
        georef.apply_placement(tileset, placement)
    (ziel / "tileset.json").write_text(json.dumps(tileset, indent=2))
    if placement:
        (ziel / georef.PLACEMENT_FILE).write_text(json.dumps(placement, indent=2))
    else:
        georef.write_placement(ziel)

    stufenliste = bereich.pop("stufen", [])
    skala = {
        "feld": feld, "beschriftung": f"{beschriftung} [{einheit}]" if einheit else beschriftung,
        "kurz": beschriftung, "einheit": einheit, "gruppe": gruppe,
        "punkte": int(len(xyz)), "raster": "element",
        "farbverlauf": gewaehlt_verlauf, "farbstufen": gewaehlt_stufen,
        "symmetrisch": symmetrisch, "verformt": float(verformt),
        "kombination": punkte.get("kombination", ""),
        "elementgroesse_m": punkte.get("elementgroesse_m"),
        "bytes": (ziel / "tile.pnts").stat().st_size,
        **{k: round(v, 6) if isinstance(v, float) else v for k, v in bereich.items()},
        "stufen": [{**s, "von": round(s["von"], 6), "bis": round(s["bis"], 6)}
                   for s in stufenliste],
        "bauteile": punkte["tabelle"],
        # Alle mitgeführten Größen mit ihrer Beschriftung — das Frontend baut
        # daraus die Feldauswahl und die Kreuztabelle der Punktabfrage, ohne
        # die Namen kennen zu müssen.
        "felder": [
            {"schluessel": k,
             "beschriftung": FELDER.get(k, (k, "", "", False, 0, "Weitere"))[0],
             "einheit": FELDER.get(k, (k, "", "", False, 0, "Weitere"))[1],
             "gruppe": FELDER.get(k, (k, "", "", False, 0, "Nachweisanteile"))[5],
             "min": round(float(np.nanmin(w)), 6), "max": round(float(np.nanmax(w)), 6)}
            for k, w in werte.items()],
        "ausdehnung": {"lo": [round(float(v), 4) for v in lo],
                       "hi": [round(float(v), 4) for v in hi]},
    }
    (ziel / "skala.json").write_text(json.dumps(skala, indent=2, ensure_ascii=False))

    logger.info("Volumenwolke %s: %d Punkte, %.4g … %.4g, %d Bytes → %s",
                feld, len(xyz), skala.get("min"), skala.get("max"), skala["bytes"], ziel)
    return skala


def punkt_abfragen(npz: Path | dict, ort, radius: float | None = None) -> dict | None:
    """
    Alle Werte am nächstgelegenen Punkt — der Weg ohne Batch-Table.

    Die Kachel trägt ihre Werte selbst, und der Browser liest sie beim Klick
    direkt. Trotzdem gibt es diesen zweiten Weg, und zwar aus einem
    praktischen Grund: `scene.pick()` trifft bei kleinen Punkten,
    eingeschaltetem Eye-Dome-Lighting oder einem halbtransparenten Bauteil
    davor gern daneben, während `scene.pickPosition()` sehr wohl einen Ort
    liefert. Dann fragt das Frontend mit dem Ort hier nach — dieselbe
    Überlegung wie in `tragwerk-ergebnisse.js` für die Deckenwolken.
    """
    daten = np.load(npz) if isinstance(npz, (str, Path)) else npz
    xyz = np.asarray(daten["xyz"], dtype=float)
    ort = np.asarray(ort, dtype=float).reshape(3)
    abstand = np.linalg.norm(xyz - ort, axis=1)
    index = int(np.argmin(abstand))
    if radius is not None and abstand[index] > radius:
        return None

    schluessel = daten.files if hasattr(daten, "files") else list(daten.keys())
    werte = {k: float(np.asarray(daten[k]).ravel()[index])
             for k in schluessel if k not in ("xyz", "bauteil")}
    return {
        "index": index,
        "abstand_m": round(float(abstand[index]), 4),
        "ort": [round(float(v), 4) for v in xyz[index]],
        "bauteil": int(np.asarray(daten["bauteil"]).ravel()[index]),
        "werte": {k: round(v, 6) for k, v in werte.items()},
    }
