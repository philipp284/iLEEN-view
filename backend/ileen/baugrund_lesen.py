"""
Ein Bild eines Baugrundaufschlusses lesen: Bohrprofil, Schichtenverzeichnis,
Sondierdiagramm oder Foto eines Bohrkerns → Schichten mit Kurzzeichen und Text.

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Gelesen wird mit einem lokalen Bildsprachmodell über Ollama (Vorgabe: Gemma 4
auf dem Mac, aus dem Container über ``host.docker.internal``). Nichts verlässt
den Rechner.

## Was das Modell liest und was nicht

An zwei gezeichneten Profilen im Stil von DIN 4023 gemessen (Prüfbild aus
``projekte/2026_1018_baugrund/skripte/testprofil.py``): Kurzzeichen und
Beschreibungen waren in beiden Fällen Wort für Wort richtig. Die Tiefen dagegen
nicht immer — einmal alle vier richtig, einmal drei von fünf Grenzen verlesen
(1,6 statt 1,20; 3,8 statt 2,90), die Ansatzhöhe im Kopf gar nicht. Darum ist
die Lesung hier ein **Vorschlag für Text und Abfolge**; die Tiefen misst der
Browser am Bild (``baugrund-bild.js``) und vergleicht sie mit der Lesung. Eine
Grenze, die beide gleich sehen, ist bestätigt; eine, bei der sie auseinander
liegen, wird gekennzeichnet.

Die Lesung verlangt alle Zahlen als Text, so wie sie gedruckt sind (siehe
``PROMPT``) — als Zahl verlangt, rundete das Modell auf ganze Meter.

Rein bis auf den HTTP-Aufruf: ``aufbereiten()`` ist ohne Modell prüfbar.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

MODELL = os.environ.get("ILEEN_BILDMODELL", "gemma4:latest")

#: Wo Ollama gesucht wird — im Container zuerst der Gastgeber.
ADRESSEN = [a for a in (os.environ.get("OLLAMA_URL"), "http://host.docker.internal:11434", "http://127.0.0.1:11434") if a]

#: Lange Kante, auf die verkleinert wird. Mehr Pixel sieht das Modell ohnehin
#: nicht (es kachelt intern), und ein 12-MP-Foto als Base64 kostet Sekunden.
MAX_KANTE = 1600

SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "art": {"type": "string"},
        "ansatzhoehe": {"type": "string"},
        "datum": {"type": "string"},
        "endteufe": {"type": "string"},
        "grundwasser": {"type": "string"},
        "bildart": {"type": "string", "enum": ["profil", "schichtenverzeichnis", "sondierung", "foto", "sonstiges"]},
        "schichten": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "unterkante": {"type": "string"},
                    "kurzzeichen": {"type": "string"},
                    "beschreibung": {"type": "string"},
                },
                "required": ["unterkante", "kurzzeichen", "beschreibung"],
            },
        },
    },
    "required": ["name", "art", "ansatzhoehe", "datum", "endteufe", "grundwasser", "bildart", "schichten"],
}

#: Alle Zahlen als TEXT, so wie sie gedruckt sind. Als Zahl verlangt, rundete
#: Gemma 4 auf ganze Meter (1,0 / 2,0 / 3,0 statt 0,40 / 1,20 / 2,90) und erfand
#: eine Schicht „Unbekannt“; als Text abgeschrieben war dasselbe Profil
#: vollständig richtig, samt Ansatzhöhe. Abschreiben kann das Modell,
#: Zahlen erzeugen weniger.
PROMPT = """Das Bild zeigt einen Baugrundaufschluss: ein Bohrprofil (Säulendarstellung nach DIN 4023),
ein Schichtenverzeichnis (Tabelle), ein Sondierdiagramm oder ein Foto eines Bohrkerns bzw. einer
Rammkernsonde mit Zollstock. Schreibe ab, was dasteht — nicht schätzen, nicht runden.

schichten: von oben nach unten, je Schicht
- unterkante: die Tiefe der Schichtunterkante in m GENAU so, wie sie im Bild gedruckt steht
  (z. B. "0,40", "2,90"). Zahlen am Grundwasser-Symbol (Dreieck) sind KEINE Schichtgrenzen.
- kurzzeichen: das Kurzzeichen nach DIN 4023 / DIN EN ISO 14688 so, wie es im Bild steht
  (z. B. "mS, gs, u'", "Mu", "A", "saGr"); steht keines da, aus der Beschreibung ableiten.
- beschreibung: der Text zur Schicht (Bodenart, Beimengungen, Konsistenz, Farbe), wörtlich.
name: Bezeichnung des Aufschlusses (z. B. "KRB 3", "BS 7"). art: KRB, RKS, BK, BS, SCH, DPH, DPL, CPT …
ansatzhoehe: wie gedruckt (z. B. "86,20 m NHN"). datum, endteufe, grundwasser (Tiefe am Dreieck) ebenso.
Was nicht im Bild steht: leerer Text."""


class LeseFehler(RuntimeError):
    pass


def bild_vorbereiten(daten: bytes) -> tuple[bytes, dict]:
    """Verkleinert auf ``MAX_KANTE``, entfernt Alpha, dreht nach EXIF. Gibt PNG/JPEG-Bytes und Maße zurück."""
    from PIL import Image, ImageOps

    bild = Image.open(io.BytesIO(daten))
    bild = ImageOps.exif_transpose(bild)
    w, h = bild.size
    if bild.mode in ("RGBA", "LA", "P"):
        grund = Image.new("RGB", bild.size, (255, 255, 255))
        rgba = bild.convert("RGBA")
        grund.paste(rgba, mask=rgba.split()[-1])
        bild = grund
    elif bild.mode != "RGB":
        bild = bild.convert("RGB")
    f = min(1.0, MAX_KANTE / max(w, h))
    if f < 1.0:
        bild = bild.resize((round(w * f), round(h * f)), Image.LANCZOS)
    puffer = io.BytesIO()
    bild.save(puffer, format="PNG", optimize=True)
    return puffer.getvalue(), {"breite": w, "hoehe": h, "skaliert": f}


def _zahl(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    m = re.search(r"-?\d+(?:[.,]\d+)?", str(x))
    return float(m.group(0).replace(",", ".")) if m else None


def aufbereiten(roh: dict) -> dict:
    """
    Macht aus der Modellantwort eine Schichtenfolge, auf die Verlass ist:
    Zahlen als Zahlen, aufsteigend sortiert, lückenlos (von = bis der vorigen),
    ohne Schichten der Dicke null. Was dabei geändert wurde, steht in ``hinweise``.
    """
    hinweise = []
    schichten = []
    for s in roh.get("schichten") or []:
        # „unterkante" als gedruckter Text; „von_m/bis_m" als Zahl (ältere Antwortform)
        von, bis = _zahl(s.get("von_m")), _zahl(s.get("unterkante", s.get("bis_m")))
        if bis is None:
            continue
        schichten.append({"von": von, "bis": bis, "kurz": (s.get("kurzzeichen") or "").strip(),
                          "text": (s.get("beschreibung") or "").strip()})
    vorher = [s["bis"] for s in schichten]
    schichten.sort(key=lambda s: s["bis"])
    if [s["bis"] for s in schichten] != vorher:
        hinweise.append("Die Schichten standen nicht in der Reihenfolge der Tiefe und wurden sortiert.")
    aus = []
    oben = 0.0
    for s in schichten:
        if s["bis"] - oben < 0.005:
            hinweise.append(f"Schicht „{s['kurz'] or s['text'][:20]}“ bis {s['bis']:.2f} m hat keine Dicke und entfällt.")
            continue
        if s["von"] is not None and abs(s["von"] - oben) > 0.011:
            hinweise.append(f"Lücke oder Überlappung bei {oben:.2f} m (gelesen „von {s['von']:.2f}“) — an die vorige Schicht angeschlossen.")
        aus.append({"von": round(oben, 3), "bis": round(s["bis"], 3), "kurz": s["kurz"], "text": s["text"]})
        oben = s["bis"]
    endteufe = _zahl(roh.get("endteufe", roh.get("endteufe_m")))
    if aus and endteufe is not None and abs(endteufe - aus[-1]["bis"]) > 0.011:
        hinweise.append(f"Endteufe {endteufe:.2f} m weicht von der Unterkante der letzten Schicht ({aus[-1]['bis']:.2f} m) ab.")
    gw = _zahl(roh.get("grundwasser", roh.get("grundwasser_m")))
    ansatz = _zahl(roh.get("ansatzhoehe", roh.get("ansatzhoehe_m_nhn")))
    if ansatz is not None and not (-500 < ansatz < 5000):
        hinweise.append(f"Ansatzhöhe {ansatz} ist keine plausible Höhe in m NHN und entfällt.")
        ansatz = None
    return {
        "name": (roh.get("name") or "").strip() or None,
        "art": (roh.get("art") or "").strip() or None,
        "ansatzhoehe": ansatz,
        "datum": (roh.get("datum") or "").strip() or None,
        "endteufe": endteufe if endteufe is not None else (aus[-1]["bis"] if aus else None),
        "grundwasser": gw,
        "bildart": roh.get("bildart") or None,
        "schichten": aus,
        "hinweise": hinweise,
    }


def _ollama(pfad: str, nutzlast: dict | None, timeout: float):
    letzter = None
    for adresse in ADRESSEN:
        try:
            anfrage = urllib.request.Request(adresse + pfad, data=json.dumps(nutzlast).encode() if nutzlast else None,
                                             headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(anfrage, timeout=timeout) as antwort:
                return json.load(antwort), adresse
        except (urllib.error.URLError, OSError) as e:
            letzter = e
            continue
    raise LeseFehler(f"Ollama ist nicht erreichbar ({', '.join(ADRESSEN)}): {letzter}")


def verfuegbar() -> dict:
    """Ob das Bildmodell bereitsteht — für die Anzeige im Panel, schnell."""
    try:
        tags, adresse = _ollama("/api/tags", None, timeout=3)
    except LeseFehler as e:
        return {"bereit": False, "modell": MODELL, "grund": str(e)}
    namen = [m.get("name") for m in tags.get("models", [])]
    return {"bereit": MODELL in namen, "modell": MODELL, "adresse": adresse,
            "grund": None if MODELL in namen else f"Modell {MODELL} ist in Ollama nicht geladen (vorhanden: {', '.join(namen) or 'keines'})"}


def lesen(daten: bytes, hinweis: str | None = None, timeout: float = 300) -> dict:
    """Liest ein Bild. Gibt die aufbereitete Lesung samt Rohantwort und Dauer zurück."""
    png, masse = bild_vorbereiten(daten)
    text = PROMPT + (f"\n\nZusatz vom Nutzer: {hinweis}" if hinweis else "")
    nutzlast = {
        "model": MODELL, "stream": False, "format": SCHEMA, "options": {"temperature": 0},
        "messages": [{"role": "user", "content": text, "images": [base64.b64encode(png).decode()]}],
    }
    t0 = time.time()
    antwort, adresse = _ollama("/api/chat", nutzlast, timeout=timeout)
    dauer = time.time() - t0
    inhalt = (antwort.get("message") or {}).get("content") or ""
    try:
        roh = json.loads(inhalt)
    except ValueError as e:
        raise LeseFehler(f"Das Modell hat kein JSON geliefert: {inhalt[:200]!r}") from e
    erg = aufbereiten(roh)
    erg.update({"modell": MODELL, "adresse": adresse, "dauer_s": round(dauer, 1), "bild": masse, "roh": roh})
    logger.info("Baugrundbild gelesen (%s, %.1f s): %s Schichten", MODELL, dauer, len(erg["schichten"]))
    return erg
