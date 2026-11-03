"""
Nutzungsprotokoll und Ansichtsvorlagen des Viewers — die Ablage.

Philipp wollte am 2026-10-19 auswerten können, **welche Modelle er lädt und
was er in iLEEN tut**, um daraus zu lernen, wie mit dem Werkzeug gearbeitet
wird (und was Claude daran verbessern soll). Der Viewer schickt dafür ein
schmales Ereignisprotokoll (frontend/nutzung.js); hier wird es abgelegt und
ausgewertet.

Ablage
======
Eine Datei je Monat, eine Zeile je Ereignis (JSON Lines):

    nutzung-2026-10.jsonl
    {"t": "2026-10-19T09:12:03Z", "tc": "…", "s": "<Sitzung>", "f": "iLEEN",
     "art": "modell_geladen", "d": {"jobId": "…", "name": "…", "ms": 2310}}

`t` ist die Uhr des Servers, `tc` die des Browsers. JSON Lines, weil es nur
angehängt wird und die Auswertung zeilenweise liest — keine Datenbank, die
gesperrt, migriert oder repariert werden müsste, und `grep` genügt, um
hineinzusehen. Ein Monat Arbeit sind ein paar tausend Zeilen.

**Was nicht hineinkommt:** Inhalte. Keine Koordinaten, keine Texte aus
Eingabefeldern, keine Notizen — nur Namen von Modellen, Bereichen, Werkzeugen
und Tasten. Je Ereignis höchstens `_MAX_DATEN` Zeichen, je Paket höchstens
`_MAX_EREIGNISSE` Ereignisse.

Wo die Dateien liegen
=====================
`ILEEN_NUTZUNG_DIR`, sonst `/data/nutzung` (eigenes Volume, siehe
docker-compose.yml). Der laufende Container hatte dieses Volume noch nicht —
ihn neu zu erzeugen hätte die per `docker cp` eingespielten Stände anderer
Module verworfen. Bis zum nächsten `docker compose up --build api` liegt das
Protokoll deshalb im Volume der Themen (`/data/issues/nutzung`); sobald
`/data/nutzung` da ist, zieht `ablage()` die Dateien einmal dorthin um.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

_MAX_EREIGNISSE = 500
_MAX_DATEN = 2000          # Zeichen JSON je Ereignis
_MAX_VORLAGEN = 200
_MAX_VORLAGEN_BYTES = 4_000_000

_sperre = threading.Lock()
_umgezogen = False


# ── Ablage ───────────────────────────────────────────────────────────────────

def ablage() -> Path:
    """Das Verzeichnis des Protokolls — angelegt, falls es fehlt."""
    global _umgezogen
    gesetzt = os.getenv("ILEEN_NUTZUNG_DIR")
    eigen = Path("/data/nutzung")
    uebergang = Path("/data/issues/nutzung")
    if gesetzt:
        ziel = Path(gesetzt)
    elif eigen.is_dir():
        ziel = eigen
        if not _umgezogen and uebergang.is_dir():
            _umziehen(uebergang, eigen)
        _umgezogen = True
    elif Path("/data/issues").is_dir():
        ziel = uebergang
    else:
        # Ohne Docker, etwa beim Entwickeln: neben dem Code.
        ziel = Path(__file__).resolve().parents[1] / "data" / "nutzung"
    ziel.mkdir(parents=True, exist_ok=True)
    return ziel


def _umziehen(alt: Path, neu: Path) -> None:
    """Dateien aus der Übergangsablage anhängen bzw. verschieben."""
    for datei in sorted(alt.glob("*")):
        zieldatei = neu / datei.name
        if datei.suffix == ".jsonl" and zieldatei.exists():
            with open(zieldatei, "a", encoding="utf-8") as aus, open(datei, encoding="utf-8") as ein:
                shutil.copyfileobj(ein, aus)
            datei.unlink()
        elif not zieldatei.exists():
            shutil.move(str(datei), str(zieldatei))


def _monatsdatei(zeit: datetime, verzeichnis: Path) -> Path:
    return verzeichnis / f"nutzung-{zeit:%Y-%m}.jsonl"


def _iso(zeit: datetime) -> str:
    return zeit.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _kurz(text: Any, n: int) -> str:
    s = str(text if text is not None else "")
    return s if len(s) <= n else s[: n - 1] + "…"


# ── Schreiben ────────────────────────────────────────────────────────────────

def anhaengen(paket: dict, jetzt: datetime | None = None, verzeichnis: Path | None = None) -> int:
    """
    Ein Paket des Viewers ablegen: `{sitzung, fassung, ereignisse: [{art, zeit, daten}]}`.
    Gibt die Zahl der geschriebenen Ereignisse zurück.

    Kaputte Einträge werden übergangen, nicht abgelehnt — ein Protokoll, das
    wegen eines einzigen schiefen Felds ein ganzes Paket verwirft, verliert
    genau die Stellen, an denen etwas schiefging.
    """
    if not isinstance(paket, dict):
        raise ValueError("Paket muss ein Objekt sein")
    ereignisse = paket.get("ereignisse")
    if not isinstance(ereignisse, list):
        raise ValueError("ereignisse fehlt")
    if len(ereignisse) > _MAX_EREIGNISSE:
        raise ValueError(f"höchstens {_MAX_EREIGNISSE} Ereignisse je Paket")

    jetzt = jetzt or datetime.now(timezone.utc)
    verzeichnis = verzeichnis or ablage()
    sitzung = _kurz(paket.get("sitzung") or "?", 64)
    fassung = _kurz(paket.get("fassung") or "", 40)

    zeilen = []
    for e in ereignisse:
        if not isinstance(e, dict):
            continue
        art = _kurz(e.get("art") or "", 40)
        if not art:
            continue
        daten = e.get("daten") if isinstance(e.get("daten"), dict) else {}
        roh = json.dumps(daten, ensure_ascii=False, default=str)
        if len(roh) > _MAX_DATEN:
            daten = {"_gekuerzt": True, "auszug": roh[:_MAX_DATEN]}
        zeilen.append(json.dumps({
            "t": _iso(jetzt), "tc": _kurz(e.get("zeit") or "", 32), "s": sitzung, "f": fassung,
            "art": art, "d": daten,
        }, ensure_ascii=False, default=str))

    if not zeilen:
        return 0
    with _sperre:
        with open(_monatsdatei(jetzt, verzeichnis), "a", encoding="utf-8") as f:
            f.write("\n".join(zeilen) + "\n")
    return len(zeilen)


# ── Lesen ────────────────────────────────────────────────────────────────────

def _zeit(text: str) -> datetime | None:
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def lesen(tage: int = 30, jetzt: datetime | None = None, verzeichnis: Path | None = None) -> list[dict]:
    """Alle Ereignisse der letzten `tage` Tage, älteste zuerst."""
    jetzt = jetzt or datetime.now(timezone.utc)
    verzeichnis = verzeichnis or ablage()
    ab = jetzt - timedelta(days=max(1, tage))
    aus = []
    for datei in sorted(verzeichnis.glob("nutzung-*.jsonl")):
        # Monatsdateien, die vor dem Zeitraum enden, gar nicht erst öffnen.
        try:
            monat = datetime.strptime(datei.stem[len("nutzung-"):], "%Y-%m").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if (monat + timedelta(days=32)) < ab:
            continue
        with open(datei, encoding="utf-8") as f:
            for zeile in f:
                try:
                    e = json.loads(zeile)
                except json.JSONDecodeError:
                    continue
                t = _zeit(e.get("t"))
                if t and t >= ab:
                    e["_t"] = t
                    aus.append(e)
    aus.sort(key=lambda e: e["_t"])
    return aus


# ── Auswerten ────────────────────────────────────────────────────────────────

def zuletzt_geladen(ereignisse: Iterable[dict], n: int = 20) -> list[dict]:
    """Die zuletzt geladenen Modelle, neueste zuerst, je Modell einmal."""
    letzte: dict[str, dict] = {}
    for e in ereignisse:
        if e.get("art") != "modell_geladen":
            continue
        d = e.get("d") or {}
        if d.get("ok") is False:
            continue
        schluessel = d.get("jobId") or d.get("assetId") or d.get("url") or d.get("name")
        if not schluessel:
            continue
        alt = letzte.get(schluessel)
        letzte[schluessel] = {
            "schluessel": schluessel, "jobId": d.get("jobId"), "assetId": d.get("assetId"),
            "name": d.get("name"), "typ": d.get("typ"), "zuletzt": e.get("t"),
            "anzahl": (alt["anzahl"] if alt else 0) + 1,
        }
    return sorted(letzte.values(), key=lambda x: x["zuletzt"] or "", reverse=True)[:n]


def auswerten(ereignisse: list[dict], tage: int) -> dict:
    """
    Was in den letzten Tagen geschah — die Zahlen, aus denen man liest, wie
    iLEEN benutzt wird. Jede Liste absteigend nach Häufigkeit.
    """
    sitzungen: dict[str, dict] = {}
    modelle: dict[str, dict] = {}
    tasten: dict[str, dict] = {}
    bereiche, gruppen, werkzeuge, auswahl, fehler = Counter(), Counter(), Counter(), Counter(), Counter()
    vorlagen: dict[str, dict] = {}
    stunden, wochentage, tage_aktiv = Counter(), Counter(), set()
    arten = Counter()

    for e in ereignisse:
        t: datetime = e["_t"]
        art = e.get("art") or ""
        d = e.get("d") or {}
        s = sitzungen.setdefault(e.get("s") or "?", {"start": t, "ende": t, "ereignisse": 0, "fassung": e.get("f")})
        s["ende"] = max(s["ende"], t)
        s["ereignisse"] += 1
        arten[art] += 1
        lokal = t.astimezone()
        stunden[lokal.hour] += 1
        wochentage[lokal.strftime("%a")] += 1
        tage_aktiv.add(lokal.date().isoformat())

        if art == "modell_geladen":
            k = d.get("jobId") or d.get("assetId") or d.get("url") or d.get("name") or "?"
            m = modelle.setdefault(k, {"name": d.get("name"), "typ": d.get("typ"), "jobId": d.get("jobId"),
                                       "geladen": 0, "fehlgeschlagen": 0, "ms": [], "zuletzt": None})
            if d.get("ok") is False:
                m["fehlgeschlagen"] += 1
            else:
                m["geladen"] += 1
                if isinstance(d.get("ms"), (int, float)):
                    m["ms"].append(d["ms"])
            m["zuletzt"] = e.get("t")
            if d.get("name"):
                m["name"] = d["name"]
        elif art == "taste":
            k = str(d.get("taste") or "?").upper()
            ta = tasten.setdefault(k, {"titel": d.get("titel"), "anzahl": 0, "an": 0, "aus": 0})
            ta["anzahl"] += 1
            if d.get("an") is True:
                ta["an"] += 1
            elif d.get("an") is False:
                ta["aus"] += 1
        elif art == "bereich":
            bereiche[str(d.get("id") or "?")] += 1
        elif art == "gruppe":
            gruppen[str(d.get("key") or "?")] += 1
        elif art == "werkzeug":
            name = str(d.get("name") or "?")
            werkzeuge[f"{name} {'an' if d.get('an') else 'aus'}" if "an" in d else name] += 1
        elif art == "auswahl":
            auswahl[str(d.get("ifcType") or "?")] += 1
        elif art.startswith("vorlage_"):
            k = d.get("id") or d.get("name") or "?"
            v = vorlagen.setdefault(k, {"name": d.get("name"), "geladen": 0, "gespeichert": 0, "geloescht": 0})
            if d.get("name"):
                v["name"] = d["name"]
            schritt = art[len("vorlage_"):]
            if schritt in v:
                v[schritt] += 1
        elif art == "fehler":
            fehler[_kurz(d.get("meldung"), 160)] += 1

    dauern = [(s["ende"] - s["start"]).total_seconds() for s in sitzungen.values()]

    def liste(zaehler: Counter, n: int = 25):
        return [{"schluessel": k, "anzahl": v} for k, v in zaehler.most_common(n)]

    def mittel(werte):
        return round(sum(werte) / len(werte)) if werte else None

    return {
        "zeitraum_tage": tage,
        "ereignisse": len(ereignisse),
        "arten": dict(arten.most_common()),
        "sitzungen": len(sitzungen),
        "tage_aktiv": len(tage_aktiv),
        "sitzung_minuten_mittel": round(sum(dauern) / len(dauern) / 60, 1) if dauern else None,
        "modelle": sorted(
            ({"schluessel": k, "name": m["name"], "typ": m["typ"], "jobId": m["jobId"],
              "geladen": m["geladen"], "fehlgeschlagen": m["fehlgeschlagen"],
              "ladezeit_ms_mittel": mittel(m["ms"]), "zuletzt": m["zuletzt"]} for k, m in modelle.items()),
            key=lambda m: (m["geladen"], m["zuletzt"] or ""), reverse=True),
        "tasten": sorted(({"taste": k, **v} for k, v in tasten.items()), key=lambda x: x["anzahl"], reverse=True),
        "bereiche": liste(bereiche),
        "gruppen": liste(gruppen),
        "werkzeuge": liste(werkzeuge),
        "auswahl_ifc_typen": liste(auswahl),
        "vorlagen": sorted(({"id": k, **v} for k, v in vorlagen.items()),
                           key=lambda x: x["geladen"], reverse=True),
        "stunden": {str(h): stunden[h] for h in range(24) if stunden[h]},
        "wochentage": dict(wochentage),
        "fehler": liste(fehler, 15),
    }


# ── Vorlagen ─────────────────────────────────────────────────────────────────

def _vorlagen_datei(verzeichnis: Path | None = None) -> Path:
    return (verzeichnis or ablage()) / "vorlagen.json"


def vorlagen_lesen(verzeichnis: Path | None = None) -> dict:
    datei = _vorlagen_datei(verzeichnis)
    if not datei.exists():
        return {"stand": None, "vorlagen": []}
    try:
        inhalt = json.loads(datei.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"stand": None, "vorlagen": []}
    if not isinstance(inhalt, dict) or not isinstance(inhalt.get("vorlagen"), list):
        return {"stand": None, "vorlagen": []}
    return inhalt


def vorlagen_schreiben(vorlagen: list, verzeichnis: Path | None = None,
                       jetzt: datetime | None = None) -> dict:
    """
    Die ganze Liste ersetzen. Jede Vorlage braucht `id` und `name`; was sie
    sonst trägt (Szene, Kamera, Taste, Zeitstempel), bestimmt der Viewer.
    Die vorige Fassung bleibt als `vorlagen.vorher.json` liegen — ein
    versehentliches Löschen im Browser soll nicht endgültig sein.
    """
    if not isinstance(vorlagen, list):
        raise ValueError("vorlagen muss eine Liste sein")
    if len(vorlagen) > _MAX_VORLAGEN:
        raise ValueError(f"höchstens {_MAX_VORLAGEN} Vorlagen")
    for v in vorlagen:
        if not isinstance(v, dict) or not v.get("id") or not str(v.get("name") or "").strip():
            raise ValueError("jede Vorlage braucht id und name")
    roh = json.dumps({"stand": _iso(jetzt or datetime.now(timezone.utc)), "vorlagen": vorlagen},
                     ensure_ascii=False, indent=1)
    if len(roh.encode("utf-8")) > _MAX_VORLAGEN_BYTES:
        raise ValueError("Vorlagen zu groß")
    datei = _vorlagen_datei(verzeichnis)
    with _sperre:
        if datei.exists():
            shutil.copyfile(datei, datei.with_name("vorlagen.vorher.json"))
        teil = datei.with_suffix(".part")
        teil.write_text(roh, encoding="utf-8")
        teil.replace(datei)
    return json.loads(roh)


def nach_tagen(ereignisse: list[dict]) -> dict[str, int]:
    """Ereignisse je Kalendertag (Ortszeit) — für eine Verlaufskurve."""
    zaehler: dict[str, int] = defaultdict(int)
    for e in ereignisse:
        zaehler[e["_t"].astimezone().date().isoformat()] += 1
    return dict(sorted(zaehler.items()))
