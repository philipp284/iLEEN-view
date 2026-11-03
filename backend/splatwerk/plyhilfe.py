"""
Der Kopf einer PLY-Datei — lesen und, wo nötig, an Ort und Stelle berichtigen.

Hier steht nur, was ohne die Punkte auskommt: die Datei kann Gigabytes groß sein,
und für die Frage „wie viele Splats, welche Hochachse“ wäre ein vollständiges
Einlesen Verschwendung.
"""

from __future__ import annotations

from pathlib import Path

_KOPF_MAX = 65536


def lese_kopf(pfad: Path) -> dict:
    """
    `{anzahl, kommentare, eigenschaften, kopf_bytes}` einer PLY.

    Ein 3DGS-Kopf mit 45 SH-Resten ist rund 2–3 KB groß; 64 KB sind reichlich.
    """
    with Path(pfad).open("rb") as f:
        roh = f.read(_KOPF_MAX)
    return kopf_aus_bytes(roh, Path(pfad).name)


def kopf_aus_bytes(roh: bytes, name: str = "PLY") -> dict:
    """Wie `lese_kopf`, aus den ersten Bytes — etwa einem Range-Abruf aus MinIO."""
    ende = roh.find(b"end_header")
    if ende < 0:
        raise ValueError(f"{name}: kein PLY-Kopf gefunden.")
    zeilen = roh[:ende].decode("ascii", "replace").splitlines()
    kommentare, eigenschaften, anzahl = [], [], 0
    im_vertex = False
    for z in zeilen:
        if z.startswith("comment"):
            kommentare.append(z[len("comment"):].strip())
        elif z.startswith("element"):
            teile = z.split()
            im_vertex = teile[1] == "vertex"
            if im_vertex:
                anzahl = int(teile[2])
        elif z.startswith("property") and im_vertex:
            eigenschaften.append(z.split()[-1])
    # „end_header" plus Zeilenende (\n oder \r\n)
    kopf_bytes = ende + len(b"end_header") + (2 if roh[ende + 10:ende + 12] == b"\r\n" else 1)
    return {"anzahl": anzahl, "kommentare": kommentare,
            "eigenschaften": eigenschaften, "kopf_bytes": kopf_bytes}


def ist_3dgs(kopf: dict) -> bool:
    """Trägt die Datei die Eigenschaften eines Gaussian Splats (Skala, Rotation, SH-DC)?"""
    namen = set(kopf["eigenschaften"])
    return {"scale_0", "rot_0"} <= namen and ("f_dc_0" in namen or "sh_0_r" in namen)


def hochachse(kopf: dict) -> str | None:
    """`"x"`, `"y"` oder `"z"` aus dem Kommentar `Vertical axis: …`, sonst None."""
    for k in kopf["kommentare"]:
        if k.lower().startswith("vertical axis"):
            achse = k.split(":")[-1].strip().lower()[:1]
            if achse in ("x", "y", "z"):
                return achse
    return None


def setze_hochachse(pfad: Path, achse: str = "z") -> bool:
    """
    Schreibt den Kommentar `Vertical axis: <achse>` im Kopf um — ohne die Datei zu kopieren.

    Möglich, weil `y` und `z` gleich lang sind: die Byteverschiebung der Punktdaten
    bleibt aus, nur ein Zeichen im Kopf ändert sich. Gibt False zurück, wenn kein
    solcher Kommentar steht (dann ist nichts zu berichtigen).

    Anlass: Brush schreibt immer `Vertical axis: y`, auch wenn die Szene — wie nach der
    Georeferenzierung — Z-up trainiert wurde. Der Splat-Handler dreht bei `y` die
    Szene um 90°, und ein ENU-ausgerichtetes Modell läge danach auf der Seite.
    """
    kopf = lese_kopf(pfad)
    alt = next((k for k in kopf["kommentare"] if k.lower().startswith("vertical axis")), None)
    if alt is None:
        return False
    neu = f"Vertical axis: {achse}"
    if len(alt) != len(neu):
        raise ValueError(f"Kommentar '{alt}' hat eine andere Länge als '{neu}'.")
    if alt == neu:
        return True
    with Path(pfad).open("r+b") as f:
        roh = f.read(kopf["kopf_bytes"])
        pos = roh.find(f"comment {alt}".encode("ascii"))
        if pos < 0:
            return False
        f.seek(pos)
        f.write(f"comment {neu}".encode("ascii"))
    return True


def trage_hochachse_ein(pfad: Path, achse: str = "z") -> bool:
    """
    Sorgt dafür, dass der Kopf `Vertical axis: <achse>` meldet — auch wenn er keinen Kommentar trägt.

    Steht der Kommentar schon da, ändert `setze_hochachse` ihn an Ort und Stelle. Fehlt er, muss ein
    Kommentar eingefügt werden, und das verschiebt die Punktdaten um dessen Länge: die Datei wird dann
    einmal neu geschrieben (Kopf neu, Rumpf in Blöcken kopiert, danach ersetzt). Gibt True zurück, wenn
    sie etwas geändert hat oder schon stimmte.

    Anlass: Spirula Studio schreibt gar keinen Hochachsen-Kommentar. Der Kachel-Handler nimmt dann Z-up
    an, was für ein ENU-ausgerichtetes Modell stimmt — der SOG-Export dreht aber nur PLYs, die
    `Vertical axis: z` melden, und ließe die Szene auf der Seite liegen.
    """
    import os

    pfad = Path(pfad)
    kopf = lese_kopf(pfad)
    if any(k.lower().startswith("vertical axis") for k in kopf["kommentare"]):
        return setze_hochachse(pfad, achse)
    with pfad.open("rb") as f:
        roh = f.read(kopf["kopf_bytes"])
    # Kommentare stehen nach der Zeile `format …` und vor den Elementen.
    ende = roh.find(b"\n", roh.find(b"format")) + 1
    zeilenende = b"\r\n" if roh[ende - 2:ende] == b"\r\n" else b"\n"
    neu = roh[:ende] + f"comment Vertical axis: {achse}".encode("ascii") + zeilenende + roh[ende:]
    tmp = pfad.with_name(pfad.name + ".tmp")
    try:
        with pfad.open("rb") as quelle, tmp.open("wb") as ziel:
            quelle.seek(kopf["kopf_bytes"])
            ziel.write(neu)
            while True:
                block = quelle.read(16 << 20)
                if not block:
                    break
                ziel.write(block)
        os.replace(tmp, pfad)
    finally:
        tmp.unlink(missing_ok=True)
    return True
